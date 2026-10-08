import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpCompany, useOpWarehouse, useOrders, useStock, useTrips } from '../../lib/hooks';
import { CompanyPicker } from '../../components/TripBits';
import { OPEN_STATUSES, ORDER_FOR_MOVE, ORDER_TYPES, lineShip, lineWh, matchOrderLine, openKg, orderInWarehouse, orderWarehouse } from '../../lib/orders';
import { MOVE_TYPES, ageDays, kgOf, postMovement, suggestPallets } from '../../lib/stock';
import { ST, vnDate } from '../../lib/trips';
import { fmtDate, fmtNum } from '../../lib/utils';
import { ErrorBox, Field, Modal } from '../../components/ui';
import { QuickAdd } from '../../components/FormTools';

// Thông tin vận tải gắn trên phiếu xuất (SO và STO). Phiếu nhập không cần.
const EMPTY_TRANSPORT = { plate: '', carrier: '', carrierName: '', idCard: '', driverName: '', driverPhone: '' };

const num = (v) => (v === '' || v == null ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
const newLine = () => ({ item: '', lot: '', mfgDate: '', expDate: '', location: '', goodsStatus: 'KTC', pledgee: '', bags: '', pallets: '', kg: '' });
const stockLine = () => ({ stockId: '', bags: '', pallets: '', kg: '', toLocation: '', toStatus: '', toPledgee: '', sign: '+' });

// Ai được lập loại phiếu nào
export function canMove(hasRole, type) {
  return type === 'status' ? hasRole('ke_toan') : hasRole('thu_kho');
}

export default function MovementForm() {
  const { type } = useParams();
  const { hasRole } = useApp();
  if (!MOVE_TYPES[type] || !canMove(hasRole, type)) return <Navigate to="/kho/ton" />;
  return <Form key={type} type={type} />;
}

function Form({ type }) {
  const meta = MOVE_TYPES[type];
  const { email, name } = useApp();
  const [params] = useSearchParams();
  const warehouses = useMyWarehouses();
  const [opWh, setOpWh] = useOpWarehouse();
  const wh = warehouses.find((w) => w.code === opWh) || (warehouses.length === 1 ? warehouses[0] : null);
  const whCode = wh?.code || '';
  const items = useCollection('items').rows;
  const locations = useCollection('locations').rows.filter((l) => l.warehouse === whCode);
  const statuses = useCollection('goodsStatus').rows;
  const pledgees = useCollection('pledgees').rows;
  const suppliers = useCollection('suppliers').rows;
  const soldto = useCollection('soldto').rows;
  const shipto = useCollection('shipto').rows;
  const reasons = useCollection('reasons').rows;
  const { rows: stock, loading: stockLoading } = useStock(whCode || '__none__');
  const { rows: trips } = useTrips([ST.PROCESSING], whCode);
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const statusMap = useMemo(() => new Map(statuses.map((s) => [s.code, s])), [statuses]);

  // Phiếu xuất theo SO hoặc STO (kho đi), phiếu nhập theo PO hoặc STO (kho đến, hàng đang đi đường)
  const orderTypes = ORDER_FOR_MOVE[type] || [];
  const { rows: allOrders, loading: ordersLoading } = useOrders(orderTypes.length ? '' : '__none__');
  const orders = useMemo(() => allOrders.filter((o) => orderTypes.includes(o.type)
    && o.lines.some((l) => openKg(o, l, type) > 0)
    && (OPEN_STATUSES.includes(o.status) || (o.type === 'STO' && type === 'in' && o.status === 'closed'))), [allOrders, type]); // eslint-disable-line react-hooks/exhaustive-deps
  const [opCo, setOpCo] = useOpCompany();
  const [head, setHead] = useState({ company: opCo, date: vnDate(), tripId: params.get('trip') || '', orderId: params.get('order') || '', partyCode: '', partyName: '', shipCode: '', reason: '', note: '', ...EMPTY_TRANSPORT });
  const vehicles = useCollection('vehicles').rows;
  const carriers = useCollection('carriers').rows;
  const drivers = useCollection('drivers').rows;
  const [lines, setLines] = useState(() => [type === 'in' ? newLine() : stockLine()]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [filter, setFilter] = useState('');
  const [picking, setPicking] = useState(false);

  const tripOpts = trips.filter((t) => (type === 'in' ? t.purpose === 'import' : t.purpose === 'export'));
  // Chọn chuyến xe → tự điền kho, khách / nhà cung cấp
  useEffect(() => {
    const t = trips.find((x) => x.id === head.tripId);
    if (!t) return;
    if (t.warehouse !== opWh) setOpWh(t.warehouse);
    // Xe xuất hàng: lấy luôn đơn vị vận tải, số xe, tài xế từ chuyến xe đã đăng ký ở cổng
    if (type === 'out') setHead((h) => ({ ...h, plate: t.plate || '', carrier: t.carrier || '', carrierName: t.carrierName || '', idCard: t.idCard || '', driverName: t.driverName || '', driverPhone: t.driverPhone || '' }));
    const l = t.lines?.find((x) => x.orderId) || t.lines?.[0];
    if (l && l.orderId && !head.orderId) pickOrder(l.orderId);
    else if (l && !head.partyCode) setHead((h) => ({ ...h, partyCode: l.partyCode, partyName: l.partyName, shipCode: l.shipCode || '' }));
  }, [head.tripId, trips, orders.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Đơn đang mở phù hợp kho và khách / nhà cung cấp
  const order = orders.find((o) => o.id === head.orderId);
  const orderOpts = orders.filter((o) => {
    return orderInWarehouse(o, type, whCode) && (o.type === 'STO' || !head.partyCode || o.partyCode === head.partyCode || o.id === head.orderId);
  }).sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  const [autoFill, setAutoFill] = useState('');
  const [fillNote, setFillNote] = useState('');
  const pickOrder = (id) => {
    const o = orders.find((x) => x.id === id);
    setFillNote('');
    if (!o) return setHead((h) => ({ ...h, orderId: id }));
    const ow = orderWarehouse(o, type);
    // SO/PO nhiều kho: chưa chọn kho thì lấy kho đầu tiên của đơn mà mình được thao tác
    const tw = ow || whCode || (o.warehouses || []).find((c) => warehouses.some((x) => x.code === c)) || '';
    if (tw && tw !== opWh) setOpWh(tw);
    // SO nhiều điểm giao: lấy mã giao của dòng đầu tiên làm ở kho này
    const myLine = o.lines.find((l) => openKg(o, l, type) > 0 && (!tw || !lineWh(o, l) || lineWh(o, l) === tw)) || null;
    const party = o.type !== 'STO' ? { partyCode: o.partyCode, partyName: o.partyName, shipCode: o.shipCode || (myLine ? lineShip(o, myLine) : '') }
      : type === 'out' ? { partyCode: o.toWarehouse, partyName: `Chuyển đến kho ${o.toWarehouse}`, shipCode: '' }
        : { partyCode: o.fromWarehouse, partyName: `Chuyển từ kho ${o.fromWarehouse}`, shipCode: '' };
    setHead((h) => ({ ...h, orderId: id, ...party, ...(o.company ? { company: o.company } : {}) }));
    // Nhập theo STO: luôn lấy hàng từ phiếu xuất ở kho đi (mã, lot, NSX, HSD, TTHH, số lượng), không phải nhập lại
    if (type === 'in' && o.type === 'STO') { fillFromTransfer(o); return; }
    const empty = lines.every((l) => (type === 'in' ? !l.item : !l.stockId));
    if (!empty) return;
    if (type === 'out') { setAutoFill(id); return; }
    // Phiếu nhập theo PO: điền sẵn các mặt hàng còn chưa về (thủ kho chọn vị trí, sửa số thực nhận)
    const next = o.lines.filter((l) => openKg(o, l, 'in') > 0 && (!tw || !lineWh(o, l) || lineWh(o, l) === tw)).map((l) => {
      const it = itemMap.get(l.item);
      const kg = openKg(o, l, 'in');
      const bags = num(it?.bagWeight) ? Math.round(kg / num(it.bagWeight)) : '';
      return { ...newLine(), item: l.item, orderLine: l.no, bags, pallets: suggestPallets(it, bags), kg, ...(l.goodsStatus ? { goodsStatus: l.goodsStatus } : {}) };
    });
    if (next.length) setLines(next);
  };

  // Nhập kho theo STO: lấy đúng lot, NSX, HSD, tình trạng thế chấp từ các phiếu xuất ở kho đi, trừ phần đã nhận
  const fillFromTransfer = async (o) => {
    let snap;
    try {
      snap = await getDocs(query(collection(db, 'movements'), where('orderId', '==', o.id)));
    } catch (e) {
      setFillNote(`Không đọc được phiếu xuất của ${o.id}: ${e.message}`);
      return;
    }
    const m = new Map();
    for (const d of snap.docs) {
      const mv = d.data();
      if (mv.status === 'cancelled') continue;
      const sign = mv.type === 'out' ? 1 : mv.type === 'in' ? -1 : 0;
      for (const l of mv.lines) {
        const key = [l.company || '', l.item, l.lot, l.goodsStatus, l.pledgee || '', l.mfgDate || '', l.expDate || ''].join('|');
        const cur = m.get(key) || { ...newLine(), item: l.item, lot: l.lot || '', mfgDate: l.mfgDate || '', expDate: l.expDate || '',
          goodsStatus: l.goodsStatus, pledgee: l.pledgee || '', company: l.company || '', orderLine: l.orderLine, bags: 0, pallets: 0, kg: 0 };
        cur.bags = r3(cur.bags + sign * Math.abs(num(l.bags)));
        cur.pallets = r3(cur.pallets + sign * Math.abs(num(l.pallets)));
        cur.kg = r3(cur.kg + sign * Math.abs(num(l.kg)));
        m.set(key, cur);
      }
    }
    const next = [...m.values()].filter((l) => l.kg > 0.001 || l.bags > 0.001);
    if (next.length) setLines(next);
    setFillNote(next.length
      ? `Đã điền sẵn ${next.length} dòng hàng đang đi đường theo ${o.id} từ phiếu xuất ở kho ${o.fromWarehouse} (mã hàng, lot, NSX, HSD, TTHH, số lượng). Chỉ cần chọn vị trí nhận và sửa số thực nhận nếu thiếu.`
      : `Không còn hàng đang đi đường theo ${o.id} (chưa có phiếu xuất ở kho ${o.fromWarehouse} hoặc đã nhận đủ).`);
  };

  // Xuất kho theo SO/STO: chọn sẵn tồn theo FIFO cho đủ phần còn lại của từng mặt hàng
  useEffect(() => {
    if (!autoFill || !order || order.id !== autoFill) return;
    if (!whCode) { setFillNote(`Chọn kho xuất để chọn sẵn tồn theo FIFO cho ${order.id}.`); return; }
    if (stockLoading) return;
    const ow = orderWarehouse(order, 'out');
    if (ow && ow !== whCode) return;
    const fifo = [...stock].filter((r) => (order.type === 'STO' || statusMap.get(r.goodsStatus)?.allowOutbound !== false) && (!order.company || (r.company || '') === order.company))
      .sort((a, b) => String(a.inDate).localeCompare(String(b.inDate)) || String(a.location).localeCompare(String(b.location)));
    const next = [];
    const short = [];
    let anyNeed = false;
    for (const ol of order.lines) {
      // Dòng SO của kho khác thì để phiếu ở kho đó làm
      if (order.type !== 'STO' && lineWh(order, ol) && lineWh(order, ol) !== whCode) continue;
      let need = openKg(order, ol, 'out');
      if (need > 0.001) anyNeed = true;
      for (const r of fifo.filter((x) => x.item === ol.item && (!ol.goodsStatus || x.goodsStatus === ol.goodsStatus))) {
        if (need <= 0.001) break;
        const kgPerBag = num(r.bags) ? num(r.kg) / num(r.bags) : 0;
        if (!kgPerBag) continue;
        const bags = Math.min(num(r.bags), Math.ceil(need / kgPerBag - 1e-9));
        const k = bags / num(r.bags);
        next.push({ ...stockLine(), stockId: r._id, orderLine: ol.no, bags, pallets: r3(num(r.pallets) * k), kg: r3(num(r.kg) * k) });
        need -= num(r.kg) * k;
      }
      if (need > 0.001) short.push(`${ol.item} thiếu ${fmtNum(need / 1000, 3)} tấn`);
    }
    if (next.length) setLines(next);
    if (!anyNeed) { setFillNote(`${order.id} không còn dòng nào cần xuất từ kho ${whCode} (dòng còn lại thuộc kho khác hoặc đã giao đủ).`); setAutoFill(''); return; }
    setFillNote(`${next.length ? `Đã chọn sẵn ${next.length} dòng tồn theo FIFO cho ${order.id}. Sửa số bao nếu xe chở ít hơn.` : `Kho ${whCode} không còn tồn được xuất cho ${order.id}.`}${short.length ? ` Không đủ tồn: ${short.join(', ')}.` : ''}`);
    setAutoFill('');
  }, [autoFill, order, stock, stockLoading, whCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mở từ nút "Lập phiếu" trên đơn hàng: /kho/out?order=SO000001
  const fromParam = useRef(params.get('order') || '');
  useEffect(() => {
    if (!fromParam.current || ordersLoading || !items.length) return;
    const id = fromParam.current;
    fromParam.current = '';
    if (orders.some((o) => o.id === id)) pickOrder(id);
    else setErr(`Đơn ${id} không còn phần nào để ${type === 'in' ? 'nhập' : 'xuất'}.`);
  }, [ordersLoading, orders, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const setH = (k, v) => setHead((h) => ({ ...h, [k]: v }));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Dòng tồn sắp xếp FIFO (nhập trước xuất trước)
  const stockRows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return stock
      .filter((r) => !head.company || (r.company || '') === head.company)
      .filter((r) => !f || [r.item, r.itemName, r.lot, r.location, r.company].join(' ').toLowerCase().includes(f))
      .sort((a, b) => String(a.item).localeCompare(String(b.item)) || String(a.inDate).localeCompare(String(b.inDate)) || String(a.location).localeCompare(String(b.location)));
  }, [stock, filter, head.company]);
  const stockById = useMemo(() => new Map(stock.map((r) => [r._id, r])), [stock]);
  // Xuất theo SO / xuất lẻ: chỉ KTC, DGC (tình trạng cho phép xuất). Xuất theo STO (chuyển kho): mọi tình trạng, kể cả HTC
  const isSTO = order?.type === 'STO';
  const blocked = (r) => type === 'out' && !isSTO && statusMap.get(r.goodsStatus)?.allowOutbound === false;
  const pickPlate = (v) => {
    const veh = vehicles.find((x) => x.plate === v.trim().toUpperCase());
    const car = veh && carriers.find((c) => c.code === veh.carrier);
    setHead((h) => ({ ...h, plate: v.toUpperCase(), ...(veh ? { carrier: veh.carrier || h.carrier, carrierName: car?.name || h.carrierName } : {}) }));
  };
  const pickCarrier = (v) => { const c = carriers.find((x) => x.code === v); setHead((h) => ({ ...h, carrier: v, carrierName: c ? c.name : h.carrierName })); };
  const pickDriver = (v) => { const d = drivers.find((x) => x.idCard === v); setHead((h) => ({ ...h, idCard: v, ...(d ? { driverName: d.name || '', driverPhone: d.phone || '' } : {}) })); };

  const parties = type === 'in' ? suppliers : soldto;

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!wh) return setErr('Chọn kho.');
    if (type === 'in' && !head.company) return setErr('Chọn công ty chủ hàng.');
    if (type === 'adjust' && !head.reason) return setErr('Chọn lý do điều chỉnh.');
    if (type === 'out') {
      const miss = [!head.carrier.trim() && !head.carrierName.trim() && 'đơn vị vận tải', !head.plate.trim() && 'số xe', !head.driverName.trim() && 'tên tài xế'].filter(Boolean);
      if (miss.length) return setErr(`Phiếu xuất cần thông tin vận tải: nhập ${miss.join(', ')}.`);
    }
    const out = [];
    for (const [i, l] of lines.entries()) {
      const no = `Dòng ${i + 1}: `;
      if (type === 'in') {
        if (!l.item || !itemMap.has(l.item)) return setErr(no + 'chọn mã hàng có trong danh mục.');
        if (!l.location) return setErr(no + 'chọn vị trí.');
        if (!num(l.kg) && !num(l.bags) && !num(l.pallets)) return setErr(no + 'nhập số tấn, pallet hoặc số bao.');
        if (l.goodsStatus === 'HTC' && !l.pledgee) return setErr(no + 'hàng HTC cần chọn bên nhận thế chấp.');
        out.push({ ...(l.orderLine != null ? { orderLine: l.orderLine } : {}), item: l.item, itemName: itemMap.get(l.item).name, lot: l.lot.trim(), mfgDate: l.mfgDate, expDate: l.expDate,
          location: l.location, goodsStatus: l.goodsStatus, pledgee: l.goodsStatus === 'HTC' ? l.pledgee : '', company: l.company || head.company,
          bags: num(l.bags), pallets: num(l.pallets), kg: num(l.kg) });
        continue;
      }
      const r = stockById.get(l.stockId);
      if (!r) return setErr(no + 'chọn dòng tồn.');
      if (blocked(r)) return setErr(no + `hàng ${r.goodsStatus} bị khóa xuất kho.`);
      const sign = type === 'adjust' && l.sign === '-' ? -1 : 1;
      if (!num(l.kg) && !num(l.bags) && !num(l.pallets)) return setErr(no + 'nhập số lượng.');
      if (type === 'move' && (!l.toLocation || l.toLocation === r.location)) return setErr(no + 'chọn vị trí mới khác vị trí cũ.');
      if (type === 'status' && (!l.toStatus || l.toStatus === r.goodsStatus)) return setErr(no + 'chọn tình trạng mới.');
      if (type === 'status' && l.toStatus === 'HTC' && !l.toPledgee) return setErr(no + 'chọn bên nhận thế chấp.');
      out.push({
        ...(l.orderLine != null ? { orderLine: l.orderLine } : {}),
        item: r.item, itemName: r.itemName, lot: r.lot, mfgDate: r.mfgDate, expDate: r.expDate, inDate: r.inDate,
        location: r.location, goodsStatus: r.goodsStatus, pledgee: r.pledgee || '', company: r.company || '',
        bags: sign * num(l.bags), pallets: sign * num(l.pallets), kg: sign * num(l.kg),
        ...(type === 'move' ? { toLocation: l.toLocation } : {}),
        ...(type === 'status' ? { toStatus: l.toStatus, toPledgee: l.toStatus === 'HTC' ? l.toPledgee : '' } : {}),
      });
    }
    // Gắn từng dòng phiếu vào dòng đơn SO/PO cùng mã hàng
    if (head.orderId) {
      if (!order) return setErr(`Đơn ${head.orderId} không còn mở.`);
      const used = {};
      for (const [i, l] of out.entries()) {
        const keep = order.lines.find((x) => x.no === l.orderLine && x.item === l.item);
        l.orderLine = keep ? keep.no : matchOrderLine(order, l.item, used, type, { warehouse: whCode, status: type === 'out' ? l.goodsStatus : '' });
        if (l.orderLine == null) return setErr(`Dòng ${i + 1}: mã hàng ${l.item}${type === 'out' ? ` (${l.goodsStatus})` : ''} không có trong đơn ${order.id} cho kho ${whCode} (kiểm tra kho xuất, TTHH của dòng đơn).`);
        used[l.orderLine] = (used[l.orderLine] || 0) + Math.abs(num(l.kg));
      }
    }
    setBusy(true);
    try {
      const id = await postMovement({
        type, warehouse: wh.code, company: head.company || '', date: head.date, tripId: head.tripId || '', orderId: head.orderId || '', orderRef: order?.refNo || '',
        partyCode: head.partyCode.trim(), partyName: head.partyName.trim(), shipCode: head.shipCode,
        reason: head.reason, note: head.note.trim(), lines: out,
        ...(type === 'out' ? Object.fromEntries(Object.keys(EMPTY_TRANSPORT).map((k) => [k, String(head[k] || '').trim()])) : {}),
      }, { email, name });
      setDone(id);
      setLines([type === 'in' ? newLine() : stockLine()]);
      setHead((h) => ({ ...h, tripId: '', orderId: '', partyCode: '', partyName: '', shipCode: '', note: '', ...EMPTY_TRANSPORT }));
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền lập phiếu cho kho này.' : e2.message);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <h1>{meta.icon} {meta.label}</h1>
        <Link className="btn" to="/kho/phieu">Danh sách phiếu</Link>
      </div>
      {done && <div className="ok-box" style={{ marginBottom: 10 }}>Đã lập phiếu <b className="mono">{done}</b>. Tồn kho đã cập nhật. <Link to={`/kho/phieu/${done}/in`} target="_blank">🖨 In phiếu</Link>
        {type === 'in' && <> · <Link className="btn primary" to={`/kho/phieu/${done}/nhan`} target="_blank">🏷️ In nhãn pallet cho phiếu này</Link></>}
        {type === 'out' && <> · <Link className="btn primary" to={`/kho/phieu/${done}/soan`} target="_blank">📋 In phiếu soạn hàng</Link></>}</div>}
      {type === 'in' && !done && <p className="hint">Lưu phiếu nhập xong sẽ hiện nút <b>🏷️ In nhãn pallet</b> (mỗi pallet 1 nhãn). In lại sau: <i>Phiếu kho</i> → nút 🏷️ In nhãn ở dòng phiếu.</p>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="form-grid">
          <Field label="Kho" required>
            <select value={whCode} onChange={(e) => { setOpWh(e.target.value); setLines([type === 'in' ? newLine() : stockLine()]); }}>
              <option value="">-- Chọn kho --</option>
              {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
            </select>
          </Field>
          <Field label="Công ty chủ hàng" required={type === 'in'} help={type === 'in' ? 'Hàng nhập thuộc công ty nào' : 'Chỉ hiện tồn của công ty này'}>
            <CompanyPicker value={head.company} allowAll={false} required={type === 'in'}
              onChange={(v) => { setOpCo(v); setHead((h) => ({ ...h, company: v })); if (type !== 'in') setLines([stockLine()]); }} />
          </Field>
          <Field label="Ngày chứng từ" required><input type="date" value={head.date} onChange={(e) => setH('date', e.target.value)} /></Field>
          {(type === 'in' || type === 'out') && (
            <>
              <Field label={type === 'in' ? 'Nhà cung cấp' : 'Khách hàng'}>
                <input list="dl-mv-party" value={head.partyCode} placeholder="Mã"
                  onChange={(e) => { const p = parties.find((x) => x.code === e.target.value); setHead((h) => ({ ...h, partyCode: e.target.value, partyName: p ? p.name : h.partyName, shipCode: '', orderId: '' })); }} />
                <input value={head.partyName} placeholder="Tên" style={{ marginTop: 4 }} onChange={(e) => setH('partyName', e.target.value)} />
              </Field>
              <Field label={type === 'out' ? 'Theo đơn bán (SO) / lệnh chuyển kho (STO)' : 'Theo đơn mua (PO) / lệnh chuyển kho (STO)'}
                help={orderOpts.length ? 'Phiếu sẽ tự trừ phần còn lại của đơn' : 'Không có đơn đang mở phù hợp'}>
                <select value={head.orderId} onChange={(e) => pickOrder(e.target.value)}>
                  <option value="">-- Không theo đơn --</option>
                  {orderOpts.map((o) => {
                    const left = o.lines.reduce((s2, l) => s2 + openKg(o, l, type), 0);
                    const who = o.type === 'STO' ? `${o.fromWarehouse} → ${o.toWarehouse}` : o.partyName || o.partyCode;
                    return <option key={o.id} value={o.id}>{o.id}{o.refNo ? ` (${o.refNo})` : ''} · {who} · {o.type === 'STO' && type === 'in' ? 'đang đi đường' : 'còn'} {fmtNum(left / 1000, 3)} tấn</option>;
                  })}
                </select>
              </Field>
              {type === 'out' && (
                <Field label="Giao đến (Shipto)">
                  <select value={head.shipCode} onChange={(e) => setH('shipCode', e.target.value)}>
                    <option value="">-- Chọn --</option>
                    {shipto.filter((s) => s.customerCode === head.partyCode).map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
                  </select>
                </Field>
              )}
            </>
          )}
          {type === 'out' && (
            <div className="full transport-box">
              <div className="section-head">🚚 Thông tin vận tải (bắt buộc với phiếu xuất bán và STO chuyển kho)</div>
              <div className="form-grid">
                <Field label="Chuyến xe đang ở cửa" help="Chọn để tự điền xe, tài xế đã đăng ký ở cổng">
                  <select value={head.tripId} onChange={(e) => setH('tripId', e.target.value)}>
                    <option value="">-- Không gắn chuyến --</option>
                    {tripOpts.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.plate} · cửa {t.dock}</option>)}
                  </select>
                </Field>
                <Field label="Số xe" required><input list="dl-mv-plate" value={head.plate} onChange={(e) => pickPlate(e.target.value)} placeholder="VD: 51C-12345" /></Field>
                <Field label="Đơn vị vận tải" required>
                  <input list="dl-mv-carrier" value={head.carrier} placeholder="Mã" onChange={(e) => pickCarrier(e.target.value)} />
                  <input value={head.carrierName} placeholder="Tên đơn vị" style={{ marginTop: 4 }} onChange={(e) => setH('carrierName', e.target.value)} />
                </Field>
                <Field label="Tài xế" required>
                  <input list="dl-mv-driver" value={head.idCard} placeholder="Số CCCD" onChange={(e) => pickDriver(e.target.value)} />
                  <input value={head.driverName} placeholder="Họ tên" style={{ marginTop: 4 }} onChange={(e) => setH('driverName', e.target.value)} />
                  <input value={head.driverPhone} placeholder="Điện thoại" style={{ marginTop: 4 }} onChange={(e) => setH('driverPhone', e.target.value)} />
                </Field>
              </div>
              <datalist id="dl-mv-plate">{vehicles.map((v) => <option key={v.plate} value={v.plate}>{v.carrier}</option>)}</datalist>
              <datalist id="dl-mv-carrier">{carriers.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>
              <datalist id="dl-mv-driver">{drivers.map((d) => <option key={d.idCard} value={d.idCard}>{d.name}</option>)}</datalist>
            </div>
          )}
          {(type === 'adjust' || type === 'in' || type === 'out') && (
            <Field label="Lý do" required={type === 'adjust'}>
              <div className="cell-add">
                <select value={head.reason} onChange={(e) => setH('reason', e.target.value)}>
                  <option value="">-- Chọn --</option>
                  {reasons.filter((r) => type !== 'adjust' || ['Điều chỉnh tồn', 'Hàng lỗi'].includes(r.appliesTo)).map((r) => <option key={r.code} value={`${r.code} – ${r.name}`}>{r.name}</option>)}
                </select>
                <QuickAdd catKey="reasons" preset={{ appliesTo: { in: 'Nhập kho', out: 'Xuất kho', adjust: 'Điều chỉnh tồn' }[type] }}
                  onAdded={(id, r) => setH('reason', `${id} – ${r?.name || ''}`)} />
              </div>
            </Field>
          )}
          <Field label="Ghi chú" full><textarea rows={2} value={head.note} onChange={(e) => setH('note', e.target.value)} /></Field>
        </div>
      </div>

      {order && <OrderBox order={order} lines={lines} type={type} stockById={stockById} wh={whCode}
        onRefill={type === 'in' && order.type === 'STO' ? () => fillFromTransfer(order) : null} />}
      {fillNote && <div className="hint" style={{ marginBottom: 10 }}>{fillNote}</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-head">Hàng hóa ({lines.length})</div>
        {type !== 'in' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" disabled={!whCode} onClick={() => setPicking(true)}>📋 Xem tồn kho & chọn hàng</button>
            <input type="search" placeholder="Lọc tồn theo mã hàng, lot, vị trí…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          </div>
        )}
        {picking && (
          <StockPicker rows={stockRows} blocked={blocked} whName={wh ? `${wh.code} – ${wh.name}` : whCode} filter={filter} setFilter={setFilter}
            chosen={new Set(lines.map((l) => l.stockId).filter(Boolean))}
            onClose={() => setPicking(false)}
            onPick={(picked) => {
              const all = type === 'move' || type === 'status' || type === 'out';
              const add = picked.map((x) => ({ ...stockLine(), stockId: x._id, bags: all ? x.bags : '', pallets: all ? x.pallets : '', kg: all ? x.kg : '' }));
              setLines((ls) => [...ls.filter((l) => l.stockId), ...add].slice(0, 30));
              setPicking(false);
            }} />
        )}
        {lines.map((l, i) => (
          <div key={i} className="mv-line">
            {type === 'in' ? (
              <InLine l={l} set={(p) => setLine(i, p)} itemMap={itemMap} items={items} locations={locations} statuses={statuses} pledgees={pledgees} />
            ) : (
              <StockLine type={type} l={l} set={(p) => setLine(i, p)} rows={stockRows} byId={stockById} blocked={blocked}
                locations={locations} statuses={statuses} pledgees={pledgees} />
            )}
            <button type="button" className="btn ghost" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        {lines.length < 30 && <button type="button" className="btn sm" onClick={() => setLines((ls) => [...ls, type === 'in' ? newLine() : stockLine()])}>+ Thêm dòng</button>}
      </div>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang ghi…' : `Lập phiếu ${meta.label.toLowerCase()}`}</button></div>
      <datalist id="dl-mv-party">{parties.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
      <datalist id="dl-mv-item">{items.filter((x) => x.active !== false).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</datalist>
    </form>
  );
}

// Đơn đang chọn: đặt / đã giao-nhận / còn lại, và còn lại sau phiếu này
function OrderBox({ order, lines, type, stockById, onRefill, wh }) {
  const meta = ORDER_TYPES[order.type];
  const receiving = order.type === 'STO' && type === 'in';
  const doneOf = (l) => num(receiving ? l.receivedKg : l.doneKg);
  const thisKg = {};
  for (const l of lines) {
    const item = type === 'in' ? l.item : stockById.get(l.stockId)?.item;
    if (item) thisKg[item] = (thisKg[item] || 0) + Math.abs(num(l.kg));
  }
  const t = (kg) => fmtNum(kg / 1000, 3);
  const perLine = order.type !== 'STO' && order.lines.some((l) => l.warehouse || l.shipCode || l.goodsStatus || l.dueDate);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="section-head">{meta.label} {order.id}{order.refNo ? ` · Ecount ${order.refNo}` : ''}{order.dueDate ? ` · ${meta.due} ${fmtDate(order.dueDate)}` : ''}
        {onRefill && <button type="button" className="btn sm" style={{ marginLeft: 10 }} onClick={onRefill}>↻ Điền lại hàng từ phiếu xuất</button>}</div>
      <table>
        <thead><tr><th>Mã hàng</th><th>Tên hàng</th>{perLine && <><th>Kho</th>{order.type === 'SO' && <th>Giao</th>}<th>TTHH</th><th>{order.type === 'SO' ? 'Ngày giao' : 'ETA'}</th></>}<th className="num">Đặt (tấn)</th>{receiving && <th className="num">Đã xuất ở kho {order.fromWarehouse}</th>}
          <th className="num">{receiving ? meta.received : meta.done}</th><th className="num">{receiving ? meta.transit : meta.left}</th><th className="num">Phiếu này</th><th className="num">Còn lại sau phiếu</th></tr></thead>
        <tbody>
          {order.lines.map((l) => {
            const here = (x) => !perLine || !wh || !lineWh(order, x) || lineWh(order, x) === wh;
            const same = order.lines.filter((x) => x.item === l.item && here(x));
            const share = same[0] === l ? thisKg[l.item] || 0 : 0;
            const open = openKg(order, l, type);
            const after = open - share;
            return (
              <tr key={l.no} style={here(l) ? undefined : { opacity: 0.45 }} title={here(l) ? '' : `Dòng này xuất từ kho ${lineWh(order, l)}`}><td>{l.item}</td><td>{l.itemName}</td>
                {perLine && <><td>{lineWh(order, l)}</td>{order.type === 'SO' && <td>{lineShip(order, l)}</td>}<td>{l.goodsStatus || (order.type === 'SO' ? 'KTC/DGC' : '')}</td><td>{fmtDate(l.dueDate)}</td></>}<td className="num">{t(l.qtyKg)}</td>{receiving && <td className="num">{t(num(l.doneKg))}</td>}
                <td className="num">{t(doneOf(l))}</td><td className="num">{t(open)}</td><td className="num">{share ? t(share) : ''}</td>
                <td className="num" style={after < 0 ? { color: 'var(--red)', fontWeight: 600 } : { fontWeight: 600 }}>{t(after)}{after < 0 ? ' (vượt đơn)' : ''}</td></tr>
            );
          })}
        </tbody>
      </table>
      {lines.some((l) => { const it = type === 'in' ? l.item : stockById.get(l.stockId)?.item; return it && !order.lines.some((x) => x.item === it); }) &&
        <div className="error-box">Có mặt hàng không nằm trong đơn {order.id}.</div>}
    </div>
  );
}

function LocationSelect({ value, onChange, locations, exclude }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">-- Vị trí --</option>
      {locations.filter((x) => x.code !== exclude).sort((a, b) => a.code.localeCompare(b.code)).map((x) => {
        const free = num(x.capacity) - num(x.currentPallets);
        return <option key={x.code} value={x.code} disabled={x.locked}>{x.code} · trống {fmtNum(free, 1)}/{fmtNum(x.capacity)} pallet{x.locked ? ' (khóa)' : ''}</option>;
      })}
    </select>
  );
}

const tonsOf = (kg) => (kg === '' || kg == null ? '' : parseFloat((num(kg) / 1000).toFixed(6)));
// Thứ tự nhập: Số tấn → Pallet → Số bao; sửa ô nào thì hai ô kia tự tính lại. Hệ thống vẫn lưu kg.
function QtyFields({ l, onTons, onPallets, onBags }) {
  return (
    <>
      <Field label="Số tấn">
        <input type="number" step="any" value={l.tonsTxt ?? tonsOf(l.kg)} onChange={(e) => onTons(e.target.value)} />
        {num(l.kg) > 0 && <small className="small">= {fmtNum(num(l.kg))} kg</small>}
      </Field>
      <Field label="Pallet"><input type="number" step="any" value={l.pallets} onChange={(e) => onPallets(e.target.value)} /></Field>
      <Field label="Số bao"><input type="number" step="any" value={l.bags} onChange={(e) => onBags(e.target.value)} /></Field>
    </>
  );
}

function InLine({ l, set, itemMap, locations, statuses, pledgees }) {
  const it = itemMap.get(l.item);
  const setBags = (v) => set({ bags: v, pallets: suggestPallets(it, v), kg: kgOf(it, v), tonsTxt: undefined });
  const setTons = (v) => {
    const kg = v === '' ? '' : r3(num(v) * 1000);
    const bags = kg !== '' && num(it?.bagWeight) ? r3(kg / num(it.bagWeight)) : '';
    set({ tonsTxt: v, kg, bags: bags === '' ? l.bags : bags, pallets: bags === '' ? l.pallets : suggestPallets(it, bags) });
  };
  const setPallets = (v) => {
    const per = num(it?.bagsPerLayer) * num(it?.layersPerPallet);
    const bags = per && v !== '' ? r3(num(v) * per) : '';
    set({ pallets: v, ...(bags === '' ? {} : { bags, kg: kgOf(it, bags) === '' ? l.kg : kgOf(it, bags), tonsTxt: undefined }) });
  };
  return (
    <div className="mv-grid">
      <Field label="Mã hàng" required>
        <input list="dl-mv-item" value={l.item} onChange={(e) => { const x = itemMap.get(e.target.value); set({ item: e.target.value, ...(x && l.bags ? { pallets: suggestPallets(x, l.bags), kg: kgOf(x, l.bags), tonsTxt: undefined } : {}) }); }} />
        {it && <small className="small">{it.name}</small>}
      </Field>
      <Field label="Lot"><input value={l.lot} onChange={(e) => set({ lot: e.target.value })} /></Field>
      <Field label="NSX"><input type="date" value={l.mfgDate} onChange={(e) => set({ mfgDate: e.target.value })} /></Field>
      <Field label="HSD"><input type="date" value={l.expDate} onChange={(e) => set({ expDate: e.target.value })} /></Field>
      <Field label="Vị trí" required><LocationSelect value={l.location} onChange={(v) => set({ location: v })} locations={locations} /></Field>
      <Field label="Tình trạng">
        <select value={l.goodsStatus} onChange={(e) => set({ goodsStatus: e.target.value })}>
          {statuses.map((s) => <option key={s.code} value={s.code}>{s.code} – {s.name}</option>)}
          {!statuses.length && <option value="KTC">KTC</option>}
        </select>
      </Field>
      {l.goodsStatus === 'HTC' && (
        <Field label="Bên nhận thế chấp" required>
          <select value={l.pledgee} onChange={(e) => set({ pledgee: e.target.value })}>
            <option value="">-- Chọn --</option>
            {pledgees.map((p) => <option key={p.code} value={p.code}>{p.code} – {p.name}</option>)}
          </select>
        </Field>
      )}
      <QtyFields l={l} onTons={setTons} onPallets={setPallets} onBags={setBags} />
    </div>
  );
}

const STATUS_COLS = ['HTC', 'KTC', 'DGC'];
// Bảng tồn kho dạng cột để tick chọn nhiều dòng; dòng bị khóa xuất (HTC khi xuất bán) không chọn được
function StockPicker({ rows, blocked, whName, filter, setFilter, chosen, onClose, onPick }) {
  const [sel, setSel] = useState(() => new Set());
  const others = [...new Set(rows.map((r) => r.goodsStatus))].filter((c) => !STATUS_COLS.includes(c));
  const cols = [...STATUS_COLS, ...others];
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const sumBy = (c) => rows.filter((r) => r.goodsStatus === c).reduce((a, r) => a + num(r.kg), 0);
  return (
    <Modal title={`Tồn kho ${whName} – tick chọn hàng`} onClose={onClose} wide>
      <input type="search" placeholder="Lọc theo mã hàng, tên, lot, vị trí…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', marginBottom: 8 }} autoFocus />
      <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
        <table className="picker">
          <thead><tr><th></th><th>Công ty</th><th>Kho</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Vị trí</th><th>Ngày nhập</th>
            {cols.map((c) => <th key={c} className="num">{c} (tấn)</th>)}<th className="num">Pallet</th><th className="num">Số bao</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const lock = blocked(r); const had = chosen.has(r._id);
              return (
                <tr key={r._id} className={lock ? 'locked' : sel.has(r._id) ? 'picked' : ''} onClick={() => !lock && !had && toggle(r._id)} style={{ cursor: lock || had ? 'not-allowed' : 'pointer' }}>
                  <td>{lock ? '🔒' : <input type="checkbox" checked={had || sel.has(r._id)} disabled={had} onChange={() => toggle(r._id)} onClick={(e) => e.stopPropagation()} />}</td>
                  <td>{r.company || ''}</td><td>{r.warehouse}</td><td>{r.item}</td><td>{r.itemName}</td><td>{r.lot || '-'}</td><td>{r.location}</td>
                  <td>{fmtDate(r.inDate)} <small className="small">({ageDays(r.inDate)} ngày)</small></td>
                  {cols.map((c) => <td key={c} className="num">{r.goodsStatus === c ? <b>{fmtNum(num(r.kg) / 1000, 3, 3)}</b> : ''}{r.goodsStatus === c && r.pledgee ? <small className="small"> {r.pledgee}</small> : ''}</td>)}
                  <td className="num">{fmtNum(r.pallets, 2)}</td><td className="num">{fmtNum(r.bags)}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={10 + cols.length} className="small">Không có hàng tồn phù hợp.</td></tr>}
          </tbody>
          <tfoot><tr><td colSpan={8}>Cộng</td>{cols.map((c) => <td key={c} className="num">{fmtNum(sumBy(c) / 1000, 3, 3)}</td>)}<td colSpan={2}></td></tr></tfoot>
        </table>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
        <small className="small">🔒 = hàng bị khóa xuất (HTC khi xuất bán). Có thể chọn nhiều dòng, kể cả KTC và DGC trong cùng một phiếu.</small>
        <button type="button" className="btn primary" disabled={!sel.size} onClick={() => onPick(rows.filter((r) => sel.has(r._id)))}>Thêm {sel.size} dòng vào phiếu</button>
      </div>
    </Modal>
  );
}

function StockLine({ type, l, set, rows, byId, blocked, locations, statuses, pledgees }) {
  const r = byId.get(l.stockId);
  // Số lượng xuất/chuyển → pallet, kg chia theo tỷ lệ tồn
  const setBags = (v) => {
    if (!r || !num(r.bags)) return set({ bags: v, tonsTxt: undefined });
    const k = num(v) / num(r.bags);
    set({ bags: v, pallets: r3(num(r.pallets) * k), kg: r3(num(r.kg) * k), tonsTxt: undefined });
  };
  const setTons = (v) => {
    const kg = v === '' ? '' : r3(num(v) * 1000);
    if (!r || !num(r.kg) || kg === '') return set({ tonsTxt: v, kg });
    const k = kg / num(r.kg);
    set({ tonsTxt: v, kg, bags: r3(num(r.bags) * k), pallets: r3(num(r.pallets) * k) });
  };
  const setPallets = (v) => {
    if (!r || !num(r.pallets) || v === '') return set({ pallets: v });
    const k = num(v) / num(r.pallets);
    set({ pallets: v, bags: r3(num(r.bags) * k), kg: r3(num(r.kg) * k), tonsTxt: undefined });
  };
  const pick = (id) => {
    const x = byId.get(id);
    if (!x) return set({ stockId: id });
    const all = type === 'move' || type === 'status';
    set({ stockId: id, bags: all ? x.bags : '', pallets: all ? x.pallets : '', kg: all ? x.kg : '', tonsTxt: undefined });
  };
  return (
    <div className="mv-grid">
      {r ? (
        <div className="field full">
          <span>Hàng chọn từ tồn kho</span>
          <div className="stock-pick">
            <span><small>Công ty</small>{r.company || '-'}</span><span><small>Kho</small>{r.warehouse}</span><span><small>Mã hàng</small>{r.item}</span>
            <span className="grow"><small>Tên hàng</small>{r.itemName}</span><span><small>Lot</small>{r.lot || '-'}</span><span><small>Vị trí</small>{r.location}</span>
            <span><small>Tình trạng</small>{r.goodsStatus}{r.pledgee ? ` (${r.pledgee})` : ''}{blocked(r) ? ' 🔒' : ''}</span>
            <span><small>Còn</small>{fmtNum(num(r.kg) / 1000, 3, 3)} tấn · {fmtNum(r.pallets, 2)} pl · {fmtNum(r.bags)} bao</span>
            <button type="button" className="btn sm ghost" onClick={() => set({ stockId: '', bags: '', pallets: '', kg: '', tonsTxt: undefined })}>Đổi</button>
          </div>
        </div>
      ) : (
      <Field label="Dòng tồn (FIFO)" required full>
        <select value={l.stockId} onChange={(e) => pick(e.target.value)}>
          <option value="">-- Chọn hàng trong kho --</option>
          {rows.map((x) => (
            <option key={x._id} value={x._id} disabled={blocked(x)}>
              {x.company ? `[${x.company}] ` : ''}{x.item} · lot {x.lot || '-'} · {x.location} · {x.goodsStatus}{x.pledgee ? `(${x.pledgee})` : ''} · {fmtNum(x.bags)} bao / {fmtNum(x.pallets, 2)} pl · nhập {fmtDate(x.inDate)} ({ageDays(x.inDate)} ngày){blocked(x) ? ' · KHÓA XUẤT' : ''}
            </option>
          ))}
        </select>
        <small className="small">Hoặc bấm 📋 Xem tồn kho & chọn hàng để xem dạng bảng.</small>
      </Field>
      )}
      {type === 'adjust' && (
        <Field label="Tăng / giảm">
          <select value={l.sign} onChange={(e) => set({ sign: e.target.value })}><option value="+">Tăng (+)</option><option value="-">Giảm (−)</option></select>
        </Field>
      )}
      {type === 'move' && <Field label="Đến vị trí" required><LocationSelect value={l.toLocation} onChange={(v) => set({ toLocation: v })} locations={locations} exclude={r?.location} /></Field>}
      {type === 'status' && (
        <>
          <Field label="Tình trạng mới" required>
            <select value={l.toStatus} onChange={(e) => set({ toStatus: e.target.value })}>
              <option value="">-- Chọn --</option>
              {statuses.filter((s) => s.code !== r?.goodsStatus).map((s) => <option key={s.code} value={s.code}>{s.code} – {s.name}</option>)}
            </select>
          </Field>
          {l.toStatus === 'HTC' && (
            <Field label="Bên nhận thế chấp" required>
              <select value={l.toPledgee} onChange={(e) => set({ toPledgee: e.target.value })}>
                <option value="">-- Chọn --</option>
                {pledgees.map((p) => <option key={p.code} value={p.code}>{p.code} – {p.name}</option>)}
              </select>
            </Field>
          )}
        </>
      )}
      <QtyFields l={l} onTons={setTons} onPallets={setPallets} onBags={setBags} />
    </div>
  );
}
