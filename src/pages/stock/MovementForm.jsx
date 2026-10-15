import { notifySlip } from '../../lib/chat';
import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { applyMovementToOrderPlans, applyMovementToPlan, planLeft, OPEN_PLAN } from '../../lib/shipPlans';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useCompanies, useMyWarehouses, useOpCompany, useOpWarehouse, useOrders, usePendingIn, useStock, useTrips, useWaitingOut } from '../../lib/hooks';
import { CompanyPicker } from '../../components/TripBits';
import { IN_SOURCES, OPEN_STATUSES, ORDER_FOR_MOVE, ORDER_TYPES, isReturn, lineFrom, lineShip, lineTo, lineWh, matchOrderLine, openKg, orderInWarehouse, orderWarehouse, stoRoute } from '../../lib/orders';
import { MOVE_TYPES, ageDays, createPendingIn, createWaitingOut, kgOf, postMovement, suggestPallets } from '../../lib/stock';
import { releaseStatusOfWh } from '../../lib/release';
import { ST, vnDate } from '../../lib/trips';
import { fmtDate, fmtNum } from '../../lib/utils';
import { ErrorBox, Field, Modal } from '../../components/ui';
import { QuickAdd, WithAdd } from '../../components/FormTools';
import { ItemCode, ItemStockModal } from '../../components/ItemStock';
import PalletChoice from '../../components/PalletChoice';
import { cleanPallets, packingMode, palletError, palletManaged } from '../../lib/pallets';
import { OVER_CAP_CONFIRM, OVER_CAP_MSG, capacityCheck, splitByCapacity } from '../../lib/capacity';
import Select from '../../components/Select';
import { CO_SHORT_MSG, groupCodes, notifyLegalTransfer } from '../../lib/legalTransfer';

// Thông tin vận tải gắn trên phiếu xuất (SO và STO). Phiếu nhập không cần.
const EMPTY_TRANSPORT = { plate: '', carrier: '', carrierName: '', idCard: '', driverName: '', driverPhone: '' };

const num = (v) => (v === '' || v == null ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
export const newLine = () => ({ item: '', lot: '', mfgDate: '', expDate: '', location: '', goodsStatus: 'KTC', pledgee: '', bags: '', pallets: '', kg: '' });
const stockLine = () => ({ stockId: '', bags: '', pallets: '', kg: '', toLocation: '', toStatus: '', toPledgee: '', sign: '+' });

// Ai được lập loại phiếu nào
// Phiếu nhập: quản trị lập và in phiếu, thủ kho nhận hàng ngoài hiện trường rồi xác nhận (trang Nhận hàng)
export function canMove(hasRole, type, isAdmin) {
  if (type === 'in') return !!isAdmin;
  return type === 'status' ? hasRole('ke_toan') : hasRole('thu_kho');
}

export default function MovementForm() {
  const { type } = useParams();
  const { hasRole, isAdmin } = useApp();
  const [sp] = useSearchParams();
  if (type === 'in' && !isAdmin && hasRole('thu_kho')) return <Navigate to="/kho/nhan-hang" />;
  if (!MOVE_TYPES[type] || !canMove(hasRole, type, isAdmin)) return <Navigate to="/kho/ton" />;
  return <Form key={[type, sp.get('src'), sp.get('plan'), sp.get('plans'), sp.get('ship')].join('|')} type={type} />;
}

function Form({ type }) {
  const meta = MOVE_TYPES[type];
  const { email, name } = useApp();
  const [params] = useSearchParams();
  const warehouses = useMyWarehouses();
  const [opWh, setOpWh] = useOpWarehouse();
  const wh = warehouses.find((w) => w.code === opWh) || (warehouses.length === 1 ? warehouses[0] : null);
  const whCode = wh?.code || '';
  // Tình trạng hàng HTC sau khi giải chấp ở kho này (DGC; cảng: KTC)
  const relTo = releaseStatusOfWh(wh);
  const items = useCollection('items').rows;
  const locations = useCollection('locations').rows.filter((l) => l.warehouse === whCode);
  const statuses = useCollection('goodsStatus').rows;
  const pledgees = useCollection('pledgees').rows;
  const suppliers = useCollection('suppliers').rows;
  const soldto = useCollection('soldto').rows;
  const shipto = useCollection('shipto').rows;
  const reasons = useCollection('reasons').rows;
  const { rows: stockAll, loading: stockLoading } = useStock(whCode || '__none__');
  // Phiếu xuất chờ giải chấp đã giữ chỗ hàng (chưa trừ tồn): phiếu xuất / chuyển khác chỉ thấy phần còn lại
  const waitOut = useWaitingOut();
  const stock = useMemo(() => (type === 'in' || !waitOut.byStock?.size ? stockAll : stockAll.map((r) => {
    const h = waitOut.byStock.get(r._id);
    return h ? { ...r, kg: r3(num(r.kg) - h.kg), bags: r3(num(r.bags) - h.bags), pallets: r3(num(r.pallets) - h.pallets), heldKg: h.kg } : r;
  }).filter((r) => num(r.kg) > 0.001)), [stockAll, waitOut, type]);
  const { rows: trips } = useTrips([ST.PROCESSING], whCode);
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const statusMap = useMemo(() => new Map(statuses.map((s) => [s.code, s])), [statuses]);

  // Phiếu xuất theo SO hoặc STO (kho đi), phiếu nhập theo PO hoặc STO (kho đến, hàng đang đi đường)
  const orderTypes = ORDER_FOR_MOVE[type] || [];
  const { rows: allOrders, loading: ordersLoading } = useOrders(orderTypes.length ? '' : '__none__');
  // Phiếu nhập đã lập theo đơn, chờ thủ kho nhận: trừ vào phần còn phải nhập (không lập trùng)
  const pendIn = usePendingIn();
  // Phiếu xuất chờ giải chấp chưa cập nhật đơn: trừ vào phần còn phải xuất (không lập trùng)
  const openK = (o, l, t) => (t === 'in' && !isReturn(o, t) ? Math.max(0, openKg(o, l, t) - (pendIn.get(o.id)?.byLine?.[l.no] || 0))
    : t === 'out' ? Math.max(0, openKg(o, l, t) - (waitOut.get(o.id)?.byLine?.[l.no] || 0)) : openKg(o, l, t));
  const orders = useMemo(() => allOrders.filter((o) => orderTypes.includes(o.type)
    && o.lines.some((l) => openK(o, l, type) > 0)
    && (OPEN_STATUSES.includes(o.status) || (type === 'in' && o.status === 'closed' && o.type === 'STO') || (isReturn(o, type) && ['done', 'closed'].includes(o.status)))), [allOrders, type, pendIn]); // eslint-disable-line react-hooks/exhaustive-deps
  const [opCo, setOpCo] = useOpCompany();
  // Chuyển pháp nhân: phiếu xuất của công ty X được lấy tồn của công ty khác cùng chủ (VAP / PLA / DAM)
  const companies = useCompanies();
  const grp = useMemo(() => groupCodes(companies), [companies]);
  const [crossCo, setCrossCo] = useState(false);
  // Phiếu nhập: nguồn nhập (trực tiếp / theo PO / theo STO / hàng trả về theo SO)
  const [source, setSource] = useState(type === 'in' ? (params.get('src') === 'sto' ? 'STO' : 'direct') : '');
  const [head, setHead] = useState({ refNo: '', company: opCo, date: vnDate(), tripId: params.get('trip') || '', orderId: params.get('order') || '', partyCode: '', partyName: '', shipCode: '', reason: '', note: '', ...EMPTY_TRANSPORT });
  const vehicles = useCollection('vehicles').rows;
  const carriers = useCollection('carriers').rows;
  const drivers = useCollection('drivers').rows;
  const [lines, setLines] = useState(() => [type === 'in' ? newLine() : stockLine()]);
  // Dòng tồn dùng được cho phiếu: đúng công ty xuất, hoặc công ty cùng chủ khi đã bật chuyển pháp nhân
  const canCross = type === 'out' && !!head.company && grp.has(head.company);
  const coOk = (r, co = head.company) => !co || (r.company || '') === co || (canCross && crossCo && grp.has(r.company || ''));
  // Công ty xuất trước, rồi mới tới công ty cùng chủ
  const ownFirst = (co) => (a, b) => ((a.company || '') === co ? 0 : 1) - ((b.company || '') === co ? 0 : 1);
  // Kiện (có pallet: gỗ / nhựa, số pallet) / Xá. Đơn chỉ ghi Kiện / Xá; thủ kho chọn loại pallet thực tế
  const [pal, setPal] = useState({ palletMode: '', pallets: [] });
  // Điền sẵn Kiện / Xá theo dòng đơn (chưa chọn loại pallet); không đè lựa chọn đã có
  const palFromOrder = (o, keep) => {
    const mode = packingMode(o, keep);
    if (!mode) return;
    setPal((p) => (p.palletMode && (p.palletMode !== mode || p.pallets.some((x) => x.material)) ? p : { palletMode: mode, pallets: [] }));
  };
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [donePO, setDonePO] = useState('');
  const [doneRel, setDoneRel] = useState(null);
  const [doneCross, setDoneCross] = useState('');
  const [doneGroup, setDoneGroup] = useState(null);
  const [filter, setFilter] = useState('');
  const [picking, setPicking] = useState(false);
  // Chưa biết hàng nằm kho nào: bấm mã hàng → Xem tồn kho → chọn kho (và dòng tồn) từ bảng
  const [stockItem, setStockItem] = useState('');
  const [findItem, setFindItem] = useState('');

  const tripOpts = trips.filter((t) => (type === 'in' ? t.purpose === 'import' : t.purpose === 'export'));
  // Chọn chuyến xe → tự điền kho, khách / nhà cung cấp
  useEffect(() => {
    const t = trips.find((x) => x.id === head.tripId);
    if (!t) return;
    if (t.warehouse !== opWh) setOpWh(t.warehouse);
    // Xe xuất hàng: lấy luôn đơn vị vận tải, số xe, tài xế từ chuyến xe đã đăng ký ở cổng
    if (type === 'out') setHead((h) => ({ ...h, plate: t.plate || '', carrier: t.carrier || h.carrier, carrierName: t.carrier ? t.carrierName || '' : h.carrierName, idCard: t.idCard || '', driverName: t.driverName || '', driverPhone: t.driverPhone || '' }));
    const l = t.lines?.find((x) => x.orderId) || t.lines?.[0];
    if (l && l.orderId && !head.orderId) pickOrder(l.orderId);
    else if (l && !head.partyCode) setHead((h) => ({ ...h, partyCode: l.partyCode, partyName: l.partyName, shipCode: l.shipCode || '' }));
  }, [head.tripId, trips, orders.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Đơn đang mở phù hợp kho và khách / nhà cung cấp
  const order = orders.find((o) => o.id === head.orderId);
  const orderOpts = orders.filter((o) => {
    if (type === 'in' && o.type !== source) return false;
    return (isReturn(o, type) || orderInWarehouse(o, type, whCode)) && (o.type === 'STO' || !head.partyCode || o.partyCode === head.partyCode || o.id === head.orderId);
  }).sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  const [autoFill, setAutoFill] = useState('');
  const [fillNote, setFillNote] = useState('');
  // Chọn từ bảng đơn: { dòng đơn: kg cần xuất } và kho xuất
  const [plan, setPlan] = useState(null);
  // SO gộp thêm cùng xe: [{ orderId, plan: { dòng: kg } | null, planId }]
  const [extra, setExtra] = useState([]);
  const [ordPicking, setOrdPicking] = useState(false);
  const pickOrder = (id, opts = {}) => {
    const o = orders.find((x) => x.id === id);
    setFillNote('');
    setCrossCo(false);
    setExtra(opts.extra || []);
    if (!opts.extra && extra.length) setLines((ls) => { const k = ls.filter((l) => !l.orderId); return k.length ? k : [type === 'in' ? newLine() : stockLine()]; });
    if (!o) return setHead((h) => ({ ...h, orderId: id }));
    if (type === 'in') setSource(o.type);
    // Hàng trả về theo SO: nhận ở kho đang chọn, điền sẵn lot / TTHH / số lượng đã giao từ các phiếu xuất của SO
    if (isReturn(o, type)) {
      setHead((h) => ({ ...h, orderId: id, partyCode: o.partyCode, partyName: o.partyName, shipCode: '', ...(o.company ? { company: o.company } : {}) }));
      fillFromTransfer(o, '');
      return;
    }
    const ow = orderWarehouse(o, type);
    // Đơn nhiều kho: chưa chọn kho thì lấy kho đầu tiên (còn phải làm) của đơn mà mình được thao tác
    // (kho đang chọn không còn phần nào của đơn thì chuyển sang kho có phần còn phải làm)
    const openWhs = o.lines.filter((l) => openK(o, l, type) > 0).map((l) => lineWh(o, l, type));
    const tw = opts.wh || ow || (whCode && openWhs.some((c) => !c || c === whCode) ? whCode : '') || openWhs.find((c) => c && warehouses.some((x) => x.code === c)) || whCode || '';
    if (tw && tw !== opWh) setOpWh(tw);
    // SO nhiều điểm giao: lấy mã giao của dòng đầu tiên làm ở kho này
    const inPlan = (l) => !opts.plan || opts.plan[l.no] > 0;
    const myLine = o.lines.find((l) => inPlan(l) && openK(o, l, type) > 0 && (!tw || !lineWh(o, l, type) || lineWh(o, l, type) === tw)) || null;
    // STO: các kho đầu kia của những dòng làm ở kho này
    const others = [...new Set(o.lines.filter((l) => inPlan(l) && openK(o, l, type) > 0 && (!tw || lineWh(o, l, type) === tw))
      .map((l) => (type === 'out' ? lineTo(o, l) : lineFrom(o, l))).filter(Boolean))].join(', ');
    const party = o.type !== 'STO' ? { partyCode: o.partyCode, partyName: o.partyName, shipCode: o.shipCode || (myLine ? lineShip(o, myLine) : '') }
      : { partyCode: others, partyName: `Chuyển ${type === 'out' ? 'đến' : 'từ'} kho ${others}`, shipCode: '' };
    // Xuất kho: lấy đơn vị vận tải đã giao cho các dòng đơn làm ở kho này (kế hoạch phân bổ / Giao đơn vị vận tải), nếu phiếu chưa ghi
    const cars = type === 'out' ? [...new Set(o.lines.filter((l) => inPlan(l) && openK(o, l, type) > 0 && (!tw || !lineWh(o, l, type) || lineWh(o, l, type) === tw))
      .map((l) => l.carrier).filter(Boolean))] : [];
    const car = cars.length === 1 ? { carrier: cars[0], carrierName: carriers.find((c) => c.code === cars[0])?.name || '', carrierAuto: true } : { carrier: '', carrierName: '', carrierAuto: false };
    setHead((h) => ({ ...h, orderId: id, ...party, ...(o.company ? { company: o.company } : {}), ...(!h.carrier || h.carrierAuto ? car : {}) }));
    palFromOrder(o, (l) => inPlan(l) && (!tw || !lineWh(o, l, type) || lineWh(o, l, type) === tw));
    // Nhập theo STO: luôn lấy hàng từ phiếu xuất ở kho đi (mã, lot, NSX, HSD, TTHH, số lượng), không phải nhập lại
    if (type === 'in' && o.type === 'STO') { fillFromTransfer(o, tw); return; }
    setPlan(opts.plan || null);
    if (opts.force) setLines([type === 'in' ? newLine() : stockLine()]);
    const empty = opts.force || lines.every((l) => (type === 'in' ? !l.item : !l.stockId));
    if (!empty) return;
    if (type === 'out') { setAutoFill(id); return; }
    // Phiếu nhập theo PO: điền sẵn các mặt hàng còn chưa về (thủ kho chọn vị trí, sửa số thực nhận)
    const next = o.lines.filter((l) => openK(o, l, 'in') > 0 && (!tw || !lineWh(o, l) || lineWh(o, l) === tw)).map((l) => {
      const it = itemMap.get(l.item);
      const kg = openK(o, l, 'in');
      const bags = num(it?.bagWeight) ? Math.round(kg / num(it.bagWeight)) : '';
      return { ...newLine(), item: l.item, orderLine: l.no, bags, pallets: suggestPallets(it, bags), kg, ...(l.goodsStatus ? { goodsStatus: l.goodsStatus } : {}) };
    });
    if (next.length) setLines(next);
    // Kế hoạch phân bổ đã ghi vị trí nhận (kho cảng, kho mua nội địa): chia dòng theo vị trí, điền sẵn vị trí
    if (next.length && o.type === 'PO') getDocs(query(collection(db, 'allocations'), where('poId', '==', o.id))).then((snap) => {
      const plans = snap.docs.map((d) => d.data()).filter((a) => a.status !== 'cancelled' && a.fromLocation && (!tw || !a.fromWarehouse || a.fromWarehouse === tw));
      if (!plans.length) return;
      const mk = (l, kg, location) => {
        const it = itemMap.get(l.item);
        const bags = num(it?.bagWeight) ? Math.round(kg / num(it.bagWeight)) : '';
        return { ...l, kg: r3(kg), bags, pallets: suggestPallets(it, bags), location };
      };
      const out = [];
      for (const l of next) {
        const byLoc = {};
        plans.filter((a) => a.poLine === l.orderLine).forEach((a) => { byLoc[a.fromLocation] = (byLoc[a.fromLocation] || 0) + num(a.qtyKg); });
        let rest = num(l.kg);
        for (const [loc, kg0] of Object.entries(byLoc)) {
          if (rest <= 0.001) break;
          const kg = Math.min(rest, kg0);
          rest -= kg;
          out.push(mk(l, kg, loc));
        }
        if (rest > 0.001) out.push(Object.keys(byLoc).length ? mk(l, rest, '') : l);
      }
      setLines(out);
      setFillNote(`Vị trí nhận điền sẵn theo kế hoạch phân bổ của ${o.id}.`);
    }).catch(() => {});
  };

  // Nhập kho theo STO: lấy đúng lot, NSX, HSD, tình trạng thế chấp từ các phiếu xuất ở kho đi, trừ phần đã nhận
  // Lệnh nhiều tuyến: chỉ lấy các dòng lệnh nhập về kho này (tw)
  const fillFromTransfer = async (o, tw = whCode) => {
    const ret = o.type === 'SO';
    const mine = new Set(o.lines.filter((l) => ret || !tw || !lineTo(o, l) || lineTo(o, l) === tw).map((l) => l.no));
    const froms = [...new Set(o.lines.filter((l) => mine.has(l.no)).map((l) => lineFrom(o, l)).filter(Boolean))].join(', ');
    let snap;
    try {
      snap = await getDocs(query(collection(db, 'movements'), where('orderId', '==', o.id)));
    } catch (e) {
      setFillNote(`Không đọc được phiếu xuất của ${o.id}: ${e.message}`);
      return;
    }
    const m = new Map();
    // Pallet đi theo hàng (phiếu xuất STO, "chuyển theo hàng sang kho nhận") trừ phần các phiếu nhập đã nhận
    const pm = new Map();
    for (const d of snap.docs) {
      const mv = d.data();
      if (ret || mv.status !== 'posted' || mv.palletMode !== 'pallet') continue;
      if (mv.type === 'out' && tw && mv.lines.every((l) => !mine.has(l.orderLine))) continue;
      if (mv.type === 'in' && tw && mv.warehouse !== tw) continue;
      for (const p of mv.pallets || []) {
        if (mv.type === 'out' && p.to !== 'transfer') continue;
        const cur = pm.get(p.code) || { code: p.code, name: p.name || '', material: p.material || '', qty: 0, to: 'in', carrier: '', carrierName: '' };
        cur.qty += (mv.type === 'out' ? 1 : -1) * num(p.qty);
        pm.set(p.code, cur);
      }
    }
    const palIn = [...pm.values()].filter((p) => p.qty > 0);
    if (palIn.length) setPal({ palletMode: 'pallet', pallets: palIn });
    else if (!ret) palFromOrder(o, (l) => mine.has(l.no));
    for (const d of snap.docs) {
      const mv = d.data();
      if (mv.status !== 'posted') continue;
      const sign = mv.type === 'out' ? 1 : mv.type === 'in' ? -1 : 0;
      for (const l of mv.lines) {
        if (!mine.has(l.orderLine)) continue;
        const key = [l.orderLine, l.company || '', l.item, l.lot, l.goodsStatus, l.pledgee || '', l.mfgDate || '', l.expDate || ''].join('|');
        const cur = m.get(key) || { ...newLine(), item: l.item, lot: l.lot || '', mfgDate: l.mfgDate || '', expDate: l.expDate || '',
          goodsStatus: l.goodsStatus, pledgee: l.pledgee || '', company: l.company || '', orderLine: l.orderLine, bags: 0, pallets: 0, kg: 0 };
        cur.bags = r3(cur.bags + sign * Math.abs(num(l.bags)));
        cur.pallets = r3(cur.pallets + sign * Math.abs(num(l.pallets)));
        cur.kg = r3(cur.kg + sign * Math.abs(num(l.kg)));
        m.set(key, cur);
      }
    }
    const next = [...m.values()].filter((l) => l.kg > 0.001 || l.bags > 0.001);
    // Kế hoạch phân bổ đã ghi vị trí ở kho đến: điền sẵn vị trí cho dòng lệnh chuyển kho tương ứng
    if (!ret && next.length) {
      try {
        const ps = await getDocs(query(collection(db, 'allocations'), where('orderId', '==', o.id)));
        const locOf = new Map(ps.docs.map((d) => d.data()).filter((a) => a.toLocation && a.status !== 'cancelled').map((a) => [a.orderLine, a.toLocation]));
        const lineLoc = new Map(o.lines.filter((l) => l.toLocation).map((l) => [l.no, l.toLocation]));
        next.forEach((l) => { if (!l.location) l.location = locOf.get(l.orderLine) || lineLoc.get(l.orderLine) || ''; });
      } catch { /* không đọc được kế hoạch: thủ kho tự chọn vị trí */ }
    }
    if (next.length) setLines(next);
    if (ret) {
      setFillNote(next.length
        ? `Đã điền sẵn ${next.length} dòng hàng đã giao theo ${o.id} (mã hàng, lot, NSX, HSD, TTHH, số lượng tối đa được trả). Sửa số lượng thực trả về, TTHH nếu khác và chọn vị trí nhận.`
        : `${o.id} không còn hàng đã giao nào để nhận trả về.`);
      return;
    }
    setFillNote(next.length
      ? `Đã điền sẵn ${next.length} dòng hàng đang đi đường theo ${o.id} từ phiếu xuất ở kho ${froms} (mã hàng, lot, NSX, HSD, TTHH, số lượng). Chỉ cần chọn vị trí nhận và sửa số thực nhận nếu thiếu.`
      : `Không còn hàng đang đi đường theo ${o.id} về kho ${tw} (chưa có phiếu xuất ở kho ${froms} hoặc đã nhận đủ).`);
  };

  // Chọn tồn theo FIFO cho các dòng của 1 đơn (pl: { dòng đơn: kg } khi chọn từ bảng / dự kiến); used: số bao đã lấy của từng dòng tồn
  // tag: số đơn gộp thêm (1 xe nhiều SO) ghi vào dòng phiếu để khi lưu tách đúng đơn
  const fifoFor = (o, pl, used, tag) => {
    const fifoSort = (a, b) => ownFirst(o.company || '')(a, b) || String(a.inDate).localeCompare(String(b.inDate)) || String(a.location).localeCompare(String(b.location));
    const mine = [...stock].filter((r) => r.warehouse === whCode && coOk(r, o.company));
    const fifo = mine.filter((r) => o.type === 'STO' || statusMap.get(r.goodsStatus)?.allowOutbound !== false).sort(fifoSort);
    // Xuất bán thiếu KTC/DGC: lấy tiếp hàng HTC (nhập trước trước), khi lưu phiếu tự đưa vào đề nghị giải chấp và đổi tình trạng
    const htcRows = o.type === 'STO' ? [] : mine.filter((r) => r.goodsStatus === 'HTC').sort(fifoSort);
    const next = [];
    const short = [];
    let htcKg = 0;
    let anyNeed = false;
    for (const ol of o.lines) {
      // Dòng SO của kho khác thì để phiếu ở kho đó làm
      if (lineWh(o, ol, 'out') && lineWh(o, ol, 'out') !== whCode) continue;
      // Chọn từ bảng: chỉ các dòng đã tích, đúng số lượng muốn xuất
      if (pl && !(pl[ol.no] > 0)) continue;
      let need = pl ? Math.min(pl[ol.no], openK(o, ol, 'out') * (1 + num(o.tolerancePct) / 100)) : openK(o, ol, 'out');
      if (need > 0.001) anyNeed = true;
      const htcOk = !ol.goodsStatus || ol.goodsStatus === 'HTC' || ol.goodsStatus === relTo;
      const own = (x) => !o.company || (x.company || '') === o.company;
      const okSt = (x) => !ol.goodsStatus || x.goodsStatus === ol.goodsStatus;
      const cands = [...fifo.filter((x) => x.item === ol.item && okSt(x) && own(x)),
        ...(htcOk ? htcRows.filter((x) => x.item === ol.item && own(x)) : []),
        ...fifo.filter((x) => x.item === ol.item && okSt(x) && !own(x)),
        ...(htcOk ? htcRows.filter((x) => x.item === ol.item && !own(x)) : [])];
      for (const r of cands) {
        if (need <= 0.001) break;
        const leftBags = num(r.bags) - (used.get(r._id) || 0);
        const kgPerBag = num(r.bags) ? num(r.kg) / num(r.bags) : 0;
        if (!kgPerBag || leftBags <= 0) continue;
        const bags = Math.min(leftBags, Math.ceil(need / kgPerBag - 1e-9));
        const k = bags / num(r.bags);
        used.set(r._id, (used.get(r._id) || 0) + bags);
        next.push({ ...stockLine(), stockId: r._id, orderLine: ol.no, ...(tag ? { orderId: tag } : {}), bags, pallets: r3(num(r.pallets) * k), kg: r3(num(r.kg) * k) });
        if (r.goodsStatus === 'HTC') htcKg += num(r.kg) * k;
        need -= num(r.kg) * k;
      }
      if (need > 0.001) short.push(`${tag ? `${o.id}: ` : ''}${ol.item} thiếu ${fmtNum(need, 2)} kg`);
    }
    return { next, short, htcKg, anyNeed };
  };

  // Xuất kho theo SO/STO: chọn sẵn tồn theo FIFO cho đủ phần còn lại của từng mặt hàng (kể cả các SO gộp thêm cùng xe)
  useEffect(() => {
    if (!autoFill || !order || order.id !== autoFill) return;
    if (!whCode) { setFillNote(`Chọn kho xuất để chọn sẵn tồn theo FIFO cho ${order.id}.`); return; }
    if (stockLoading) return;
    const ow = orderWarehouse(order, 'out');
    if (ow && ow !== whCode) return;
    const used = new Map();
    const res = [fifoFor(order, plan, used, ''), ...extra.map((e) => orders.find((o) => o.id === e.orderId)).filter(Boolean)
      .map((o) => fifoFor(o, extra.find((e) => e.orderId === o.id).plan, used, o.id))];
    const next = res.flatMap((r) => r.next);
    const short = res.flatMap((r) => r.short);
    const htcKg = res.reduce((a, r) => a + r.htcKg, 0);
    const ids = [order.id, ...extra.map((e) => e.orderId)].join(', ');
    if (next.length) setLines(next);
    if (!res.some((r) => r.anyNeed)) { setFillNote(`${ids} không còn dòng nào cần xuất từ kho ${whCode} (dòng còn lại thuộc kho khác hoặc đã giao đủ).`); setAutoFill(''); return; }
    setFillNote(`${next.length ? `Đã chọn sẵn ${next.length} dòng tồn theo FIFO cho ${ids}. Sửa số bao nếu xe chở ít hơn.` : `Kho ${whCode} không còn tồn được xuất cho ${ids}.`}${htcKg > 0.001 ? ` Trong đó ${fmtNum(htcKg, 2)} kg là hàng HTC: phiếu sẽ ở trạng thái Chờ giải chấp cho đến khi lập lệnh giải chấp (đổi sang ${relTo}).` : ''}${short.length ? ` Không đủ tồn: ${short.join(', ')}.` : ''}`);
    setAutoFill(''); setPlan(null);
  }, [autoFill, order, stock, stockLoading, whCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1 xe giao nhiều SO cùng khách, cùng công ty xuất, cùng kho: gộp thêm SO → chọn tồn FIFO cho SO đó, khi lưu mỗi SO 1 phiếu con cùng mã gộp,
  // in ra 1 phiếu soạn hàng (cùng mã hàng gộp 1 dòng) và 1 phiếu giao hàng ghi đủ các SO
  const extraOpts = type === 'out' && order && order.type === 'SO' ? orders.filter((o) => o.type === 'SO' && o.id !== order.id && !extra.some((e) => e.orderId === o.id)
    && o.partyCode === order.partyCode && (o.company || '') === (order.company || '') && orderInWarehouse(o, 'out', whCode)) : [];
  const addExtra = (id, pl = null, planId = '') => {
    const o = orders.find((x) => x.id === id);
    if (!o) return;
    const used = new Map();
    for (const l of lines) if (l.stockId) used.set(l.stockId, (used.get(l.stockId) || 0) + num(l.bags));
    const r = fifoFor(o, pl, used, o.id);
    setExtra((x) => [...x, { orderId: id, plan: pl, planId }]);
    setLines((ls) => [...ls.filter((l) => l.stockId), ...r.next]);
    setFillNote(`Gộp thêm ${o.id}: ${r.next.length ? `chọn sẵn ${r.next.length} dòng tồn theo FIFO` : `kho ${whCode} không còn tồn được xuất`}${r.short.length ? `; không đủ tồn: ${r.short.join(', ')}` : ''}.`);
  };
  const removeExtra = (id) => {
    setExtra((x) => x.filter((e) => e.orderId !== id));
    setLines((ls) => { const k = ls.filter((l) => l.orderId !== id); return k.length ? k : [stockLine()]; });
  };

  // Mở từ nút "Lập phiếu" trên đơn hàng: /kho/out?order=SO000001
  const fromParam = useRef(params.get('order') || '');
  useEffect(() => {
    if (!fromParam.current || ordersLoading || !items.length || (type === 'in' && !pendIn.loaded)) return;
    const id = fromParam.current;
    fromParam.current = '';
    const pend = pendIn.get(id);
    if (orders.some((o) => o.id === id)) pickOrder(id);
    else if (type === 'in' && pend) setErr(`Đơn ${id} đã lập đủ phiếu nhập kho: ${pend.ids.join(', ')} (đang chờ thủ kho nhận hàng). Không cần lập thêm; xem ở Phiếu kho hoặc Nhận hàng (chờ nhập).`);
    else setErr(`Đơn ${id} không còn phần nào để ${type === 'in' ? 'nhập' : 'xuất'}.`);
  }, [ordersLoading, orders, items.length, pendIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const setH = (k, v) => setHead((h) => ({ ...h, [k]: v }));
  // Đổi kho: phiếu nhập giữ nguyên mã hàng, số lượng đã có (theo PO / nhập tay), chỉ bỏ vị trí của kho cũ để chọn vị trí kho mới;
  // phiếu theo đơn chưa có dòng nào thì điền lại theo đơn cho kho mới. Phiếu xuất / chuyển: dòng tồn thuộc kho cũ nên chọn lại (theo đơn: FIFO lại)
  const changeWh = (code) => {
    setOpWh(code);
    setFillNote('');
    if (type === 'in') {
      if (order && order.type === 'STO') { setLines([newLine()]); if (code) fillFromTransfer(order, code); return; }
      if (lines.some((l) => l.item)) { setLines((ls) => ls.map((l) => ({ ...l, location: '' }))); return; }
      if (order && code) { pickOrder(order.id, { wh: code, force: true }); return; }
      setLines([newLine()]);
      return;
    }
    setLines([stockLine()]);
    if (type === 'out' && order && code) setAutoFill(order.id);
  };
  // Chọn kho từ bảng tồn của một mã hàng; đổi kho thì bỏ các dòng của kho cũ
  const pickFromItemStock = (code, picked) => {
    setStockItem('');
    const all = type !== 'adjust';
    // Xuất theo đơn: chỉ lấy đủ phần đơn còn phải xuất của mã này (theo thứ tự dòng đã tick)
    const item = picked[0]?.item;
    const kept = code === whCode ? lines.filter((l) => l.stockId) : [];
    let need = order && item ? order.lines.filter((l) => l.item === item && (!lineWh(order, l, type) || lineWh(order, l, type) === code)).reduce((a, l) => a + openK(order, l, type), 0)
      - kept.filter((l) => stockById.get(l.stockId)?.item === item).reduce((a, l) => a + Math.abs(num(l.kg)), 0) : Infinity;
    const add = [];
    for (const x of picked) {
      if (!all) { add.push({ ...stockLine(), stockId: x._id }); continue; }
      if (need <= 0.001) break;
      const kgPerBag = num(x.bags) ? num(x.kg) / num(x.bags) : 0;
      const bags = need === Infinity || !kgPerBag ? num(x.bags) : Math.min(num(x.bags), Math.ceil(need / kgPerBag - 1e-9));
      const k = num(x.bags) ? bags / num(x.bags) : 1;
      add.push({ ...stockLine(), stockId: x._id, bags, pallets: r3(num(x.pallets) * k), kg: r3(num(x.kg) * k) });
      need -= num(x.kg) * k;
    }
    if (add.length) { setAutoFill(''); setFillNote(''); }
    // Đổi kho mà chưa tick dòng nào: đang xuất theo đơn thì chọn lại tồn FIFO ở kho mới
    else if (code !== whCode && order && type === 'out') setAutoFill(order.id);
    if (code !== whCode) {
      setOpWh(code);
      setLines(add.length ? add.slice(0, 30) : [stockLine()]);
    } else if (add.length) setTopped([...kept, ...add]);
  };
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // Xuất theo đơn: phần đơn còn phải xuất của 1 mã hàng ở kho này, trừ các dòng phiếu đã có
  const needFor = (item, ls) => (!order || type !== 'out' ? Infinity
    : order.lines.filter((l) => l.item === item && (!lineWh(order, l, 'out') || lineWh(order, l, 'out') === whCode)).reduce((a, l) => a + openK(order, l, 'out'), 0)
      - ls.filter((l) => stockById.get(l.stockId)?.item === item).reduce((a, l) => a + Math.abs(num(l.kg)), 0));
  // Lấy tối đa `need` kg từ 1 dòng tồn (làm tròn lên theo bao)
  const takeFrom = (x, need) => {
    const kgPerBag = num(x.bags) ? num(x.kg) / num(x.bags) : 0;
    const bags = !kgPerBag ? num(x.bags) : Math.min(num(x.bags), Math.ceil(need / kgPerBag - 1e-9));
    const k = num(x.bags) ? bags / num(x.bags) : 1;
    return { ...stockLine(), stockId: x._id, bags, pallets: r3(num(x.pallets) * k), kg: r3(num(x.kg) * k) };
  };
  // Vị trí chọn không đủ số lượng đơn: lấy hết vị trí đó và gợi ý thêm vị trí kế tiếp theo ngày nhập (FIFO), người dùng đổi được
  const setTopped = (ls0) => {
    let ls = ls0.slice(0, 30);
    const added = [];
    if (type === 'out' && order) {
      const used = new Set(ls.map((l) => l.stockId).filter(Boolean));
      const items = [...new Set(ls.map((l) => stockById.get(l.stockId)?.item).filter(Boolean))];
      const htcLast = (r) => (r.goodsStatus === 'HTC' ? 1 : 0);
      for (const item of items) {
        let need = needFor(item, ls);
        if (need <= 0.001) continue;
        const want = order.lines.find((l) => l.item === item)?.goodsStatus;
        const cands = stock.filter((r) => r.item === item && r.warehouse === whCode && !used.has(r._id) && num(r.bags) > 0 && !blocked(r)
          && coOk(r, order.company) && (!want || r.goodsStatus === want || r.goodsStatus === 'HTC'))
          .sort((a, b) => ownFirst(order.company || '')(a, b) || htcLast(a) - htcLast(b) || String(a.inDate).localeCompare(String(b.inDate)) || String(a.location).localeCompare(String(b.location)));
        for (const r of cands) {
          if (need <= 0.001 || ls.length >= 30) break;
          const nl = takeFrom(r, need);
          // Chèn ngay sau dòng cuối cùng của mã hàng này
          const at = ls.map((l) => stockById.get(l.stockId)?.item).lastIndexOf(item) + 1;
          ls = [...ls.slice(0, at), nl, ...ls.slice(at)];
          used.add(r._id);
          need -= num(nl.kg);
          added.push(`${item} ở ${r.location} (nhập ${fmtDate(r.inDate)}, ${fmtNum(nl.kg, 2)} kg)`);
        }
      }
    }
    setLines(ls);
    if (added.length) setFillNote(`Vị trí đã chọn không đủ số lượng đơn: đã lấy hết vị trí đó và gợi ý thêm theo ngày nhập: ${added.join('; ')}. Bấm "Đổi" ở dòng gợi ý nếu muốn lấy vị trí khác.`);
  };
  // Chọn dòng tồn ở ô chọn của 1 dòng phiếu xuất theo đơn
  const pickOutStock = (i, x) => {
    const others = lines.filter((_, j) => j !== i);
    const need = needFor(x.item, others);
    if (need === Infinity) return setLine(i, { stockId: x._id, bags: '', pallets: '', kg: '', kgTxt: undefined });
    setTopped(lines.map((l, j) => (j === i ? (need > 0.001 ? takeFrom(x, need) : { ...stockLine(), stockId: x._id }) : l)));
  };
  // Sức chứa vị trí (phiếu nhập): dòng vượt chỗ trống phải chia dòng hoặc tích xác nhận
  const caps = type === 'in' ? capacityCheck(lines, locations) : [];
  const [overOk, setOverOk] = useState(false);

  // Dòng tồn sắp xếp FIFO (nhập trước xuất trước)
  const stockRows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return stock
      .filter((r) => coOk(r))
      .filter((r) => !f || [r.item, r.itemName, r.lot, r.location, r.company].join(' ').toLowerCase().includes(f))
      .sort((a, b) => String(a.item).localeCompare(String(b.item)) || ownFirst(head.company)(a, b) || String(a.inDate).localeCompare(String(b.inDate)) || String(a.location).localeCompare(String(b.location)));
  }, [stock, filter, head.company, crossCo, canCross]); // eslint-disable-line react-hooks/exhaustive-deps
  const stockById = useMemo(() => new Map(stock.map((r) => [r._id, r])), [stock]);
  // Xuất theo SO / xuất lẻ: chỉ KTC, DGC (tình trạng cho phép xuất). Xuất theo STO (chuyển kho): mọi tình trạng, kể cả HTC
  const isSTO = order?.type === 'STO';
  // Hàng HTC xuất bán không bị khóa: khi lưu phiếu, phần HTC tự vào đề nghị giải chấp và đổi tình trạng ngay
  const releasable = (r) => type === 'out' && !isSTO && r?.goodsStatus === 'HTC';
  const blocked = (r) => type === 'out' && !isSTO && !releasable(r) && statusMap.get(r.goodsStatus)?.allowOutbound === false;
  // Lập phiếu xuất từ Dự kiến xuất kho của Sale (xem bên dưới)
  const [shipPlan, setShipPlan] = useState(null);
  // Tồn của công ty xuất ở kho này không đủ cho phần cần xuất: cảnh báo, gợi ý lấy tồn công ty cùng chủ (chuyển pháp nhân)
  const coShort = useMemo(() => {
    if (type !== 'out' || !order || isSTO || !head.company || !whCode || stockLoading) return [];
    const byPlan = shipPlan && shipPlan.orderId === order.id;
    const need = new Map();
    for (const ol of order.lines) {
      if (lineWh(order, ol, 'out') && lineWh(order, ol, 'out') !== whCode) continue;
      const k = byPlan ? (shipPlan.lines || []).filter((x) => x.orderLine === ol.no && (!shipPlan.ship || (x.shipCode || '') === shipPlan.ship)).reduce((a, x) => a + planLeft(x), 0)
        : openK(order, ol, 'out');
      if (k > 0.001) need.set(ol.item, (need.get(ol.item) || 0) + k);
    }
    // Đã chọn nhiều hơn (sửa tay): lấy theo số trên phiếu
    for (const l of lines) {
      const r = stockById.get(l.stockId);
      if (r && need.has(r.item)) need.set(r.item, Math.max(need.get(r.item), lines.filter((x) => stockById.get(x.stockId)?.item === r.item).reduce((a, x) => a + Math.abs(num(x.kg)), 0)));
    }
    const res = [];
    for (const [item, kg] of need) {
      const rs = stock.filter((r) => r.item === item && r.warehouse === whCode && !blocked(r));
      const own = rs.filter((r) => (r.company || '') === head.company).reduce((a, r) => a + num(r.kg), 0);
      if (own + 0.001 >= kg) continue;
      const others = {};
      rs.filter((r) => (r.company || '') !== head.company && grp.has(r.company || '')).forEach((r) => { others[r.company] = (others[r.company] || 0) + num(r.kg); });
      res.push({ item, need: kg, own, others });
    }
    return res;
  }, [type, order, isSTO, head.company, whCode, stockLoading, stock, lines, shipPlan, grp]); // eslint-disable-line react-hooks/exhaustive-deps
  // Dòng phiếu đang lấy tồn của công ty khác công ty xuất
  const crossPicked = type === 'out' && head.company ? lines.map((l) => stockById.get(l.stockId)).filter((r) => r && (r.company || '') && r.company !== head.company) : [];
  const pickPlate = (v) => {
    const veh = vehicles.find((x) => x.plate === v.trim().toUpperCase());
    const car = veh && carriers.find((c) => c.code === veh.carrier);
    // Xe thuê ngoài có thể trùng số với xe của đơn vị khác: chỉ điền đơn vị vận tải khi còn trống
    setHead((h) => ({ ...h, plate: v.toUpperCase(), ...(veh && !h.carrier ? { carrier: veh.carrier || '', carrierName: car?.name || h.carrierName } : {}) }));
  };
  const pickCarrier = (v) => { const c = carriers.find((x) => x.code === v); setHead((h) => ({ ...h, carrier: v, carrierName: c ? c.name : h.carrierName, carrierAuto: false })); };
  // Đơn vị vận tải tự lấy từ đơn khi danh mục chưa tải xong: điền tên khi có
  useEffect(() => {
    if (!head.carrier || head.carrierName) return;
    const c = carriers.find((x) => x.code === head.carrier);
    if (c) setHead((h) => ({ ...h, carrierName: c.name }));
  }, [head.carrier, head.carrierName, carriers]);
  const pickDriver = (v) => { const d = drivers.find((x) => x.idCard === v); setHead((h) => ({ ...h, idCard: v, ...(d ? { driverName: d.name || '', driverPhone: d.phone || '' } : {}) })); };

  const parties = type === 'in' && source !== 'SO' ? suppliers : soldto;
  // Lập phiếu xuất từ Dự kiến xuất kho của Sale: ?plan=DK…&ship=mã giao → chọn sẵn đơn, số lượng từng dòng, mã giao
  // ?plans=DK1,DK2: 1 xe đi nhiều dự kiến (nhiều SO cùng khách, cùng công ty xuất): đơn đầu là đơn chính, các đơn sau gộp thêm
  const planParam = type === 'out' ? params.get('plans') || params.get('plan') || '' : '';
  const shipParam = params.get('ship');
  const [groupPlans, setGroupPlans] = useState([]);
  useEffect(() => {
    if (!planParam || ordersLoading || shipPlan?.key === planParam) return;
    const ids = [...new Set(planParam.split(',').map((x) => x.trim()).filter(Boolean))];
    Promise.all(ids.map((pid) => getDoc(doc(db, 'shipPlans', pid)))).then((snaps) => {
      const miss = snaps.find((s) => !s.exists());
      if (miss) return setErr(`Không tìm thấy dự kiến xuất ${miss.id}.`);
      const ps = snaps.map((s) => ({ ...s.data(), id: s.id }));
      const closed = ps.find((p) => !OPEN_PLAN.includes(p.status));
      if (closed) return setErr(`Dự kiến xuất ${closed.id} đã ${closed.status === 'cancelled' ? 'hủy' : 'lập phiếu xuất xong'}.`);
      const p0 = ps[0];
      const other = ps.find((p) => p.partyCode !== p0.partyCode || (p.company || '') !== (p0.company || ''));
      if (other) return setErr(`Chỉ gộp 1 xe các dự kiến cùng khách hàng và cùng công ty xuất: ${p0.id} (${p0.partyCode}, ${p0.company || 'chưa có công ty'}) khác ${other.id} (${other.partyCode}, ${other.company || 'chưa có công ty'}).`);
      // Số cần xuất theo từng SO (nhiều dự kiến cùng 1 SO thì cộng dồn)
      const byOrder = new Map();
      for (const p of ps) {
        const ls = (p.lines || []).filter((l) => planLeft(l) > 0.001 && (shipParam == null || (l.shipCode || '') === shipParam));
        if (!ls.length) continue;
        const cur = byOrder.get(p.orderId) || { orderId: p.orderId, plan: {}, planIds: [], ship: ls[0].shipCode || '' };
        ls.forEach((l) => { cur.plan[l.orderLine] = (cur.plan[l.orderLine] || 0) + planLeft(l); });
        cur.planIds.push(p.id);
        byOrder.set(p.orderId, cur);
      }
      const list = [...byOrder.values()];
      if (!list.length) return setErr(`Dự kiến xuất ${ids.join(', ')} không còn dòng nào cần xuất.`);
      const [first, ...rest] = list;
      const main = ps.find((p) => p.id === first.planIds[0]);
      setShipPlan({ ...main, key: planParam, ship: first.ship, planIds: first.planIds });
      setGroupPlans(ps);
      pickOrder(first.orderId, { plan: first.plan, force: true, extra: rest.map((e) => ({ orderId: e.orderId, plan: e.plan, planIds: e.planIds })) });
      setHead((h) => ({ ...h, shipCode: first.ship || h.shipCode, note: h.note || [...new Set(ps.map((p) => p.note).filter(Boolean))].join('; ') }));
      setFillNote(`Lập theo dự kiến xuất ${ps.map((p) => p.id).join(', ')} của Sale${list.length > 1 ? ` (1 xe gộp ${list.length} đơn: ${list.map((e) => e.orderId).join(', ')})` : ''}.`);
    }).catch((e) => setErr(e.message));
  }, [planParam, shipParam, ordersLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mã giao của khách: chỉ có 1 mã thì luôn mặc định mã đó; nhiều mã thì bắt buộc chọn
  const shipOpts = useMemo(() => (type === 'out' && head.partyCode ? shipto.filter((s) => s.customerCode === head.partyCode) : []), [type, head.partyCode, shipto]);
  const shipRequired = shipOpts.length > 1 && order?.type !== 'STO';
  useEffect(() => {
    if (shipOpts.length === 1 && head.shipCode !== shipOpts[0].shipCode && !shipto.some((s) => s.shipCode === head.shipCode && s.customerCode === head.partyCode)) setHead((h) => ({ ...h, shipCode: shipOpts[0].shipCode }));
  }, [shipOpts]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeSource = (v) => {
    setSource(v); setFillNote(''); setErr('');
    setHead((h) => ({ ...h, orderId: '', partyCode: '', partyName: '', refNo: '' }));
    setLines([newLine()]);
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!wh) return setErr('Chọn kho.');
    if (type === 'in' && !head.company) return setErr('Chọn công ty chủ hàng.');
    if (type === 'in' && source === 'direct' && !head.partyCode.trim()) return setErr('Chọn nhà cung cấp (bấm + để thêm nhà cung cấp mới).');
    if (type === 'in' && source !== 'direct' && !head.orderId) return setErr(`Chọn ${{ PO: 'đơn mua (PO)', STO: 'lệnh chuyển kho (STO)', SO: 'đơn bán (SO) của hàng trả về' }[source]}.`);
    if (type === 'adjust' && !head.reason) return setErr('Chọn lý do điều chỉnh.');
    if (type === 'out' && shipRequired && !head.shipCode) return setErr(`Khách hàng ${head.partyCode} có ${shipOpts.length} mã giao hàng: chọn mã giao (Giao đến).`);
    if (type === 'out' && head.shipCode && shipOpts.length && !shipOpts.some((s) => s.shipCode === head.shipCode)) return setErr(`Mã giao ${head.shipCode} không thuộc khách hàng ${head.partyCode}.`);
    if (type === 'out') { const pe = palletError(pal, head, 'out', { managed: palletManaged(wh) }); if (pe) return setErr(pe); }
    // Phiếu nhập: quản trị lập có thể chưa biết loại pallet; thủ kho kiểm tra, chọn khi nhận hàng
    if (type === 'in' && pal.palletMode === 'pallet') { const pe = palletError(pal, head, 'in', { managed: palletManaged(wh) }); if (pe) return setErr(pe + ' (hoặc để thủ kho chọn khi nhận hàng: bỏ chọn Kiện)'); }
    // Thông tin vận tải không bắt buộc: bổ sung sau ở Phiếu kho → mở phiếu → Sửa thông tin vận tải
    const out = [];
    for (const [i, l] of lines.entries()) {
      const no = `Dòng ${i + 1}: `;
      if (type === 'in') {
        if (!l.item || !itemMap.has(l.item)) return setErr(no + 'chọn mã hàng có trong danh mục.');
        // Vị trí: thủ kho chọn khi nhận hàng (quản trị lập phiếu có thể để trống)
        if (!num(l.kg) && !num(l.bags) && !num(l.pallets)) return setErr(no + 'nhập số kg, pallet hoặc số bao.');
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
        ...(releasable(r) ? { _rel: r } : {}),
        ...(l.orderId ? { _oid: l.orderId } : {}),
        item: r.item, itemName: r.itemName || '', lot: r.lot || '', mfgDate: r.mfgDate || '', expDate: r.expDate || '', inDate: r.inDate || '',
        location: r.location, goodsStatus: r.goodsStatus, pledgee: r.pledgee || '', company: r.company || '',
        bags: sign * num(l.bags), pallets: sign * num(l.pallets), kg: sign * num(l.kg),
        ...(type === 'move' ? { toLocation: l.toLocation } : {}),
        ...(type === 'status' ? { toStatus: l.toStatus, toPledgee: l.toStatus === 'HTC' ? l.toPledgee : '' } : {}),
      });
    }
    if (type === 'in' && caps.some((c) => c?.over) && !overOk) return setErr(`${OVER_CAP_MSG}. Chia thành nhiều dòng hoặc tích "${OVER_CAP_CONFIRM}".`);
    // Gắn từng dòng phiếu vào dòng đơn SO/PO cùng mã hàng
    // 1 xe nhiều SO: dòng của SO gộp thêm (đã ghi số đơn) gắn vào SO đó; dòng chưa ghi đơn thì gắn đơn chính, mã hàng không có trong đơn chính thì tìm ở SO gộp thêm
    const parts = new Map(); // số đơn → { order, lines }
    if (head.orderId) {
      if (!order) return setErr(`Đơn ${head.orderId} không còn mở.`);
      const exOrders = extra.map((e) => orders.find((o) => o.id === e.orderId));
      const gone = extra.find((e, i) => !exOrders[i]);
      if (gone) return setErr(`Đơn gộp thêm ${gone.orderId} không còn mở (đã giao đủ / đóng): bỏ đơn đó ra.`);
      const all = [order, ...exOrders];
      const used = {};
      const st = (l) => (type === 'out' ? (l._rel ? [relTo, 'HTC'] : l.goodsStatus) : '');
      for (const [i, l] of out.entries()) {
        let o = l._oid ? all.find((x) => x.id === l._oid) : order;
        if (!o) return setErr(`Dòng ${i + 1}: đơn ${l._oid} không còn trong phiếu.`);
        const u = (used[o.id] ||= {});
        const keep = o.lines.find((x) => x.no === l.orderLine && x.item === l.item);
        l.orderLine = keep ? keep.no : matchOrderLine(o, l.item, u, type, { warehouse: whCode, status: st(l) });
        if (l.orderLine == null && !l._oid && exOrders.length) {
          for (const eo of exOrders) {
            const no2 = matchOrderLine(eo, l.item, (used[eo.id] ||= {}), type, { warehouse: whCode, status: st(l) });
            if (no2 != null) { o = eo; l.orderLine = no2; break; }
          }
        }
        if (l.orderLine == null) return setErr(`Dòng ${i + 1}: mã hàng ${l.item}${type === 'out' ? ` (${l.goodsStatus})` : ''} không có trong đơn ${all.map((x) => x.id).join(', ')} cho kho ${whCode} (kiểm tra kho xuất, TTHH của dòng đơn).`);
        (used[o.id] ||= {})[l.orderLine] = (used[o.id][l.orderLine] || 0) + Math.abs(num(l.kg));
        delete l._oid;
        if (!parts.has(o.id)) parts.set(o.id, { order: o, lines: [] });
        parts.get(o.id).lines.push(l);
      }
      // Phiếu nhập: không vượt phần còn phải nhập sau khi trừ các phiếu đã lập đang chờ thủ kho nhận
      const pend = type === 'in' && !isReturn(order, type) ? pendIn.get(order.id) : null;
      if (pend) {
        for (const [no, kg] of Object.entries(used[order.id] || {})) {
          const ol = order.lines.find((x) => String(x.no) === String(no));
          const max = openK(order, ol, 'in') * (1 + num(order.tolerancePct) / 100);
          if (kg > max + 0.5) return setErr(`${ol.item}: đơn ${order.id} chỉ còn ${fmtNum(max, 2)} kg chưa lập phiếu (đã có phiếu chờ thủ kho nhận: ${pend.ids.join(', ')}).`);
        }
      }
    }
    out.forEach((l) => delete l._oid);
    // Hàng HTC trong phiếu xuất bán: phiếu lưu "Chờ giải chấp" (in, soạn hàng được; tồn chưa trừ),
    // nhân viên lập lệnh giải chấp gộp nhiều đơn ở Kho → Đề nghị giải chấp → Chờ giải chấp, lúc đó phiếu mới ghi xuất kho
    // Chuyển pháp nhân: dòng lấy tồn của công ty khác công ty xuất. Phiếu giao vẫn mang tên công ty xuất;
    // hệ thống báo cho kế toán (chuông 🔔) để làm chuyển đổi trên phần mềm kế toán
    const cross = type === 'out' && head.company ? out.filter((l) => l.company && l.company !== head.company) : [];
    if (cross.length) {
      const by = {};
      cross.forEach((l) => { by[l.company] = (by[l.company] || 0) + Math.abs(num(l.kg)); });
      const txt = Object.entries(by).map(([c, k]) => `${c} ${fmtNum(k, 2)} kg`).join(', ');
      if (!window.confirm(`${coShort.length ? `${CO_SHORT_MSG}.\n\n` : ''}Phiếu xuất của công ty ${head.company} có ${cross.length} dòng lấy tồn của công ty khác: ${txt}.\n`
        + `Đây là CHUYỂN PHÁP NHÂN: phiếu giao hàng vẫn mang tên ${head.company}, tồn trừ đúng công ty đã chọn. `
        + `Hệ thống sẽ gửi thông báo cho kế toán (chuông 🔔) để thực hiện chuyển đổi trên phần mềm kế toán. Tiếp tục?`)) return;
    }
    const rel = out.filter((l) => l._rel);
    if (rel.length && !window.confirm(`Phiếu có ${rel.length} dòng hàng HTC (${fmtNum(rel.reduce((a, l) => a + num(l.kg), 0), 2)} kg).\n`
      + `Phiếu sẽ lưu ở trạng thái CHỜ GIẢI CHẤP: in phiếu, soạn hàng được nhưng chưa trừ tồn. Vào Đề nghị giải chấp → Chờ giải chấp để tạo lệnh giải chấp (gộp nhiều đơn). Tiếp tục?`)) return;
    setBusy(true);
    const ids = [];
    try {
      const direct = type === 'in' && source === 'direct';
      const mk = type === 'in' ? (m) => createPendingIn({ ...m, ...(direct ? { directPO: {
        company: head.company, date: head.date, partyCode: head.partyCode.trim(), partyName: head.partyName.trim(), refNo: head.refNo.trim(),
        tolerancePct: 0, note: head.note.trim() } } : {}) }, { email, name }) : (m) => (m.lines.some((l) => l._rel) ? createWaitingOut : postMovement)(
        { ...m, lines: m.lines.map(({ _rel, ...l }) => l) }, { email, name });
      const base = {
        type, warehouse: wh.code, company: head.company || '', date: head.date, tripId: head.tripId || '',
        ...(type === 'in' ? { source } : {}),
        partyCode: head.partyCode.trim(), partyName: head.partyName.trim(), shipCode: head.shipCode,
        reason: head.reason, note: head.note.trim(),
        ...(type === 'out' ? Object.fromEntries(Object.keys(EMPTY_TRANSPORT).map((k) => [k, String(head[k] || '').trim()])) : {}),
        ...(type === 'out' ? cleanPallets(pal, head, 'out', { managed: palletManaged(wh) }) : {}),
        ...(type === 'in' ? cleanPallets(pal, head, 'in', { managed: palletManaged(wh) }) : {}),
      };
      // Dự kiến xuất đang lập theo của từng SO
      const planIdsOf = (oid) => (shipPlan && shipPlan.orderId === oid ? shipPlan.planIds || [shipPlan.id] : extra.find((e) => e.orderId === oid)?.planIds || []);
      const pieces = parts.size > 1 ? [...parts.values()] : [{ order: head.orderId ? order : null, lines: out }];
      // 1 xe nhiều SO: mỗi SO 1 phiếu xuất (trừ đúng đơn, công nợ), cùng mã gộp; pallet xuất kèm ghi ở phiếu đầu
      const groupId = pieces.length > 1 ? `GX${Date.now().toString(36).toUpperCase()}` : '';
      for (const [k, pc] of pieces.entries()) {
        const oid = direct ? '' : pc.order?.id || '';
        const pids = planIdsOf(oid);
        const res = await mk({
          ...base, ...(k > 0 && type === 'out' ? { pallets: [] } : {}), orderId: oid, orderRef: pc.order?.refNo || '', lines: pc.lines,
          ...(pids.length === 1 ? { planId: pids[0] } : {}),
          ...(groupId ? { groupId, groupOrders: pieces.map((x) => x.order.id), groupIndex: k } : {}),
        });
        const mvId = typeof res === 'string' ? res : res.id;
        ids.push(mvId);
        if (k === 0) setDonePO(typeof res === 'string' ? '' : res.orderId);
        const mvLines = pc.lines.map(({ _rel, ...l }) => l);
        // Tin nhắn hệ thống: lập phiếu xuất / nhập (theo cấu hình, không chờ)
        notifySlip({ id: mvId, type, orderId: oid, partyName: head.partyName.trim(), sales: pc.order?.sales || '', company: head.company || '', date: head.date, warehouse: wh.code, lines: mvLines }, { email, name });
        // Chuyển pháp nhân: dòng lấy tồn công ty khác công ty xuất → báo kế toán
        const crossHere = type === 'out' && head.company ? mvLines.filter((l) => l.company && l.company !== head.company) : [];
        if (crossHere.length) {
          try { await notifyLegalTransfer({ id: mvId, type, company: head.company, date: head.date, warehouse: wh.code, orderId: oid, partyCode: head.partyCode.trim(), partyName: head.partyName.trim(), lines: mvLines }, { email, name }, { shortWarned: coShort.length > 0 }); }
          catch (e4) { setErr(`Đã lập phiếu ${mvId} nhưng chưa gửi được thông báo chuyển pháp nhân cho kế toán: ${e4.message}. Báo kế toán xem Báo cáo → Chuyển pháp nhân.`); }
        }
        // Phiếu lập từ dự kiến xuất: cộng số đã xuất vào dự kiến, đủ thì dự kiến chuyển "Đã lập phiếu xuất"
        if (pids.length === 1) {
          try { await applyMovementToPlan(pids[0], { id: mvId, lines: mvLines }, { email, name }); }
          catch (e3) { setErr(`Đã lập phiếu ${mvId} nhưng chưa cập nhật được dự kiến xuất ${pids[0]}: ${e3.message}`); }
        } else if (type === 'out' && oid) {
          // Lập thẳng từ SO (không qua dự kiến) hoặc nhiều dự kiến cùng SO: trừ dần vào các dự kiến còn mở của SO để dự kiến không treo
          try { await applyMovementToOrderPlans(oid, { id: mvId, lines: mvLines, shipCode: head.shipCode }, { email, name }); }
          catch (e3) { console.warn('Chưa cập nhật được dự kiến xuất của', oid, e3); }
        }
      }
      const mvId = ids[0];
      setDoneCross(cross.length ? [...new Set(cross.map((l) => l.company))].join(', ') : '');
      setShipPlan(null); setExtra([]); setGroupPlans([]);
      setDoneGroup(groupId ? { id: groupId, ids, orders: pieces.map((x) => x.order.id) } : null);
      setDone(mvId);
      setDoneRel(rel.length ? { wait: true } : null);
      setLines([type === 'in' ? newLine() : stockLine()]);
      setPal({ palletMode: '', pallets: [] });
      setHead((h) => ({ ...h, tripId: '', orderId: '', partyCode: '', partyName: '', shipCode: '', refNo: '', note: '', ...EMPTY_TRANSPORT }));
    } catch (e2) {
      const msg = e2.code === 'permission-denied' ? 'Bạn không có quyền lập phiếu cho kho này.' : e2.message;
      setErr(ids.length ? `Đã lập phiếu ${ids.join(', ')}; phiếu cho đơn tiếp theo bị lỗi: ${msg}. Kiểm tra Phiếu kho trước khi lập lại phần còn thiếu.` : msg);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <h1>{meta.icon} {meta.label}</h1>
        <div className="actions">
          {type === 'adjust' && <Link className="btn" to="/kho/dieu-chinh-excel">⬆ Nhập từ Excel</Link>}
          <Link className="btn" to="/kho/phieu">Danh sách phiếu</Link>
        </div>
      </div>
      {done && doneGroup && <div className="ok-box" style={{ marginBottom: 10 }}>🚚 1 xe gộp {doneGroup.orders.length} đơn ({doneGroup.orders.join(', ')}): đã lập phiếu <b className="mono">{doneGroup.ids.join(', ')}</b>{doneRel ? '' : ', tồn kho đã cập nhật'}.
        In chung 1 bộ: <Link className="btn primary" to={`/kho/phieu/${done}/soan`} target="_blank">📋 Phiếu soạn hàng gộp</Link> <Link className="btn" to={`/kho/phieu/${done}/in`} target="_blank">🖨 Phiếu giao hàng gộp</Link>
        {doneRel && <div style={{ marginTop: 6 }}>⏳ Có hàng HTC nên phiếu có hàng HTC đang <b>chờ giải chấp</b>; vào <Link to="/kho/giai-chap">Đề nghị giải chấp → Chờ giải chấp</Link>.</div>}</div>}
      {done && !doneGroup && <div className="ok-box" style={{ marginBottom: 10 }}>Đã lập phiếu <b className="mono">{done}</b>{donePO && <> và đơn mua <Link className="mono" to="/don-hang?tab=PO">{donePO}</Link> (nhập trực tiếp)</>}.{type === 'in' ? <> <b>Chờ thủ kho nhận hàng</b> và xác nhận số thực nhận, vị trí (tồn kho cập nhật khi thủ kho xác nhận{source === 'direct' ? ', đơn mua PO lập theo số thực nhận' : ''}).</> : doneRel ? '' : ' Tồn kho đã cập nhật.'} <Link to={`/kho/phieu/${done}/in`} target="_blank">🖨 In phiếu</Link>

        {type === 'out' && <> · <Link className="btn primary" to={`/kho/phieu/${done}/soan`} target="_blank">📋 In phiếu soạn hàng</Link></>}
        {doneCross && <div style={{ marginTop: 6 }}>🏛️ Phiếu có hàng lấy từ tồn công ty <b>{doneCross}</b> (chuyển pháp nhân): đã gửi thông báo cho kế toán. Xem <Link to="/bao-cao/chuyen-phap-nhan">Báo cáo chuyển pháp nhân</Link>.</div>}
        {doneRel && <div style={{ marginTop: 6 }}>⏳ Phiếu có hàng HTC nên đang <b>chờ giải chấp</b> (tồn chưa trừ). In phiếu, soạn hàng được; vào <Link to="/kho/giai-chap">Đề nghị giải chấp → Chờ giải chấp</Link> để tạo lệnh giải chấp, khi đó phiếu mới ghi xuất kho.</div>}</div>}
      {type === 'in' && !done && <p className="hint">Quản trị lập và in phiếu nhập. Thủ kho nhận hàng ngoài hiện trường, vào <b>Nhận hàng</b> nhập số thực nhận, lot, vị trí rồi xác nhận: lúc đó tồn kho mới cập nhật và in được nhãn pallet.</p>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="form-grid">
          <Field label="Kho" required>
            <WithAdd cat="warehouses" onAdded={(id) => changeWh(id)}>
              <Select value={whCode} onChange={(e) => changeWh(e.target.value)}>
                <option value="">-- Chọn kho --</option>
                {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
              </Select>
            </WithAdd>
          </Field>
          <Field label={type === 'out' ? 'Công ty xuất' : 'Công ty chủ hàng'} required={type === 'in'} help={type === 'in' ? 'Hàng nhập thuộc công ty nào'
            : type === 'out' ? 'Phiếu giao hàng mang tên công ty này. Chỉ hiện tồn của công ty này (bật "Lấy tồn công ty cùng chủ" bên dưới để chuyển pháp nhân); bỏ trống = mọi công ty'
            : 'Chỉ hiện tồn của công ty này; bỏ trống = mọi công ty'}>
            <CompanyPicker value={head.company} allowAll={false} required={type === 'in'}
              onChange={(v) => { setOpCo(v); setCrossCo(false); setHead((h) => ({ ...h, company: v })); if (type !== 'in') setLines([stockLine()]); }} />
          </Field>
          <Field label="Ngày chứng từ" required><input type="date" value={head.date} onChange={(e) => setH('date', e.target.value)} /></Field>
          {(type === 'in' || type === 'out') && (
            <>
              {type === 'in' && (
                <Field label="Nguồn nhập" required full help={{
                  direct: 'Hàng về không có PO trước: lập phiếu nhập này sẽ tự lập luôn đơn mua (PO) đã nhận đủ.',
                  PO: 'Nhập theo đơn mua đã lập trước: phiếu tự trừ phần còn chưa về của PO.',
                  STO: 'Nhận hàng chuyển kho: tự điền lot, TTHH, số lượng từ phiếu xuất ở kho đi.',
                  SO: 'Khách trả hàng: tự điền lot, TTHH, số lượng đã giao từ phiếu xuất của đơn bán.' }[source]}>
                  <div className="seg wrap">
                    {Object.entries(IN_SOURCES).map(([k, x]) => (
                      <button type="button" key={k} className={source === k ? 'on' : ''} onClick={() => source !== k && changeSource(k)}>{x.short}</button>
                    ))}
                  </div>
                </Field>
              )}
              {!(type === 'in' && source === 'STO') && (
                <Field label={type === 'out' ? 'Khách hàng' : source === 'SO' ? 'Khách hàng trả hàng' : 'Nhà cung cấp'} required={type === 'in' && source === 'direct'}>
                  <div className="cell-add">
                    <input list="dl-mv-party" value={head.partyCode} placeholder="Mã"
                      onChange={(e) => { const p = parties.find((x) => x.code === e.target.value); setHead((h) => ({ ...h, partyCode: e.target.value, partyName: p ? p.name : h.partyName, shipCode: '', orderId: '' })); }} />
                    <QuickAdd catKey={type === 'in' && source !== 'SO' ? 'suppliers' : 'soldto'} onAdded={(id, r) => setHead((h) => ({ ...h, partyCode: r?.code || id, partyName: r?.name || h.partyName, shipCode: '', orderId: '' }))} />
                  </div>
                  <input value={head.partyName} placeholder="Tên" style={{ marginTop: 4 }} onChange={(e) => setH('partyName', e.target.value)} />
                </Field>
              )}
              {type === 'in' && source === 'direct' && (
                <Field label="Số chứng từ NCC" help="Số hóa đơn / phiếu giao hàng của nhà cung cấp (ghi vào PO)">
                  <input value={head.refNo} onChange={(e) => setH('refNo', e.target.value)} />
                </Field>
              )}
              {!(type === 'in' && source === 'direct') && <Field label={type === 'out' ? 'Theo đơn bán (SO) / lệnh chuyển kho (STO)' : IN_SOURCES[source].label} required={type === 'in'}
                help={orderOpts.length ? (source === 'SO' ? 'Phiếu sẽ ghi nhận phần khách trả về của đơn' : 'Phiếu sẽ tự trừ phần còn lại của đơn') : source === 'SO' ? 'Không có đơn bán nào đã giao hàng' : 'Không có đơn đang mở phù hợp'}>
                <Select searchable value={head.orderId} onChange={(e) => pickOrder(e.target.value)}>
                  <option value="">{type === 'in' ? '-- Chọn --' : '-- Không theo đơn --'}</option>
                  {orderOpts.map((o) => {
                    const left = o.lines.reduce((s2, l) => s2 + openK(o, l, type), 0);
                    const who = o.type === 'STO' ? stoRoute(o) : o.partyName || o.partyCode;
                    return <option key={o.id} value={o.id} data-search={[o.partyCode, o.partyName, o.salesName, o.note, ...(o.lines || []).flatMap((l) => [l.item, l.itemName, l.shipCode, l.warehouse, l.fromWarehouse, l.toWarehouse])].join(' ')}>{o.id}{o.refNo ? ` (${o.refNo})` : ''} · {who} · {o.type === 'STO' && type === 'in' ? 'đang đi đường' : isReturn(o, type) ? 'được trả tối đa' : 'còn'} {fmtNum(left, 2)} kg</option>;
                  })}
                </Select>
                {type === 'out' && <button type="button" className="btn primary sm" style={{ marginTop: 6 }} onClick={() => setOrdPicking(true)}>🔎 Tìm & chọn đơn (bảng)</button>}
              </Field>}
              {ordPicking && <OrderPicker orders={orders} myWh={warehouses} whCode={whCode} onClose={() => setOrdPicking(false)}
                onPick={(id, pl, w) => { setOrdPicking(false); pickOrder(id, { plan: pl, wh: w, force: true }); }} />}
              {type === 'out' && (
                <Field label="Giao đến (Shipto)" required={shipRequired}
                  help={shipOpts.length === 1 ? 'Khách chỉ có 1 mã giao: tự chọn sẵn' : shipRequired ? `Khách có ${shipOpts.length} mã giao: bắt buộc chọn` : ''}>
                  <WithAdd cat="shipto" preset={{ customerCode: head.partyCode, customerName: head.partyName }} onAdded={(id, r) => setH('shipCode', r?.shipCode || id)}>
                    <Select value={head.shipCode} onChange={(e) => setH('shipCode', e.target.value)}>
                      <option value="">-- Chọn --</option>
                      {shipOpts.map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
                    </Select>
                  </WithAdd>
                </Field>
              )}
            </>
          )}
          {type === 'out' && (
            <div className="full transport-box">
              <div className="section-head">🚚 Thông tin vận tải (chưa có thì để trống, bổ sung sau ở Phiếu kho)</div>
              <div className="form-grid">
                <Field label="Chuyến xe đang ở cửa" help="Chọn để tự điền xe, tài xế đã đăng ký ở cổng">
                  <Select value={head.tripId} onChange={(e) => setH('tripId', e.target.value)}>
                    <option value="">-- Không gắn chuyến --</option>
                    {tripOpts.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.plate} · cửa {t.dock}</option>)}
                  </Select>
                </Field>
                <Field label="Số xe"><WithAdd cat="vehicles" preset={{ plate: head.plate, carrier: head.carrier }} onAdded={(id, r) => pickPlate(r?.plate || id)}><input list="dl-mv-plate" value={head.plate} onChange={(e) => pickPlate(e.target.value)} placeholder="VD: 51C-12345" /></WithAdd></Field>
                <Field label="Đơn vị vận tải">
                  <WithAdd cat="carriers" onAdded={(id, r) => setHead((h) => ({ ...h, carrier: id, carrierName: r?.name || h.carrierName, carrierAuto: false }))}><input list="dl-mv-carrier" value={head.carrier} placeholder="Mã" onChange={(e) => pickCarrier(e.target.value)} /></WithAdd>
                  <input value={head.carrierName} placeholder="Tên đơn vị" style={{ marginTop: 4 }} onChange={(e) => setH('carrierName', e.target.value)} />
                </Field>
                <Field label="Tài xế">
                  <WithAdd cat="drivers" preset={{ idCard: head.idCard, name: head.driverName, phone: head.driverPhone, carrier: head.carrier }} onAdded={(id, r) => setHead((h) => ({ ...h, idCard: r?.idCard || id, driverName: r?.name || h.driverName, driverPhone: r?.phone || h.driverPhone }))}><input list="dl-mv-driver" value={head.idCard} placeholder="Số CCCD" onChange={(e) => pickDriver(e.target.value)} /></WithAdd>
                  <input value={head.driverName} placeholder="Họ tên" style={{ marginTop: 4 }} onChange={(e) => setH('driverName', e.target.value)} />
                  <input value={head.driverPhone} placeholder="Điện thoại" style={{ marginTop: 4 }} onChange={(e) => setH('driverPhone', e.target.value)} />
                </Field>
              </div>
              <datalist id="dl-mv-plate">{vehicles.map((v) => <option key={v.plate} value={v.plate}>{v.carrier}</option>)}</datalist>
              <datalist id="dl-mv-carrier">{carriers.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>
              <datalist id="dl-mv-driver">{drivers.map((d) => <option key={d.idCard} value={d.idCard}>{d.name}</option>)}</datalist>
            </div>
          )}
          {type === 'out' && (
            <div className="full transport-box">
              <div className="section-head">🪵 Hàng Kiện / Xá <span className="req">*</span></div>
              <PalletChoice value={pal} onChange={setPal} carrier={head.carrier} carrierName={head.carrierName} sto={order?.type === 'STO'} managed={palletManaged(wh)}
                suggestQty={Math.ceil(lines.reduce((a, l) => a + (Number(l.pallets) || 0), 0)) || ''} />
            </div>
          )}
          {type === 'in' && (
            <div className="full transport-box">
              <div className="section-head">🪵 Hàng về Kiện / Xá <span className="small">(chưa biết thì để thủ kho kiểm tra, chọn khi nhận hàng)</span></div>
              <PalletChoice value={pal} onChange={setPal} kind="in" managed={palletManaged(wh)}
                suggestQty={Math.ceil(lines.reduce((a, l) => a + (Number(l.pallets) || 0), 0)) || ''} />
              {pal.palletMode && <button type="button" className="btn sm ghost" onClick={() => setPal({ palletMode: '', pallets: [] })}>Bỏ chọn</button>}
            </div>
          )}
          {(type === 'adjust' || type === 'in' || type === 'out') && (
            <Field label="Lý do" required={type === 'adjust'}>
              <div className="cell-add">
                <Select value={head.reason} onChange={(e) => setH('reason', e.target.value)}>
                  <option value="">-- Chọn --</option>
                  {reasons.filter((r) => type !== 'adjust' || ['Điều chỉnh tồn', 'Hàng lỗi'].includes(r.appliesTo)).map((r) => <option key={r.code} value={`${r.code} – ${r.name}`}>{r.name}</option>)}
                </Select>
                <QuickAdd catKey="reasons" preset={{ appliesTo: { in: 'Nhập kho', out: 'Xuất kho', adjust: 'Điều chỉnh tồn' }[type] }}
                  onAdded={(id, r) => setH('reason', `${id} – ${r?.name || ''}`)} />
              </div>
            </Field>
          )}
          <Field label="Ghi chú" full><textarea rows={2} value={head.note} onChange={(e) => setH('note', e.target.value)} /></Field>
        </div>
      </div>

      {order && <OrderBox order={order} lines={extra.length ? lines.filter((l) => !l.orderId) : lines} type={type} stockById={stockById} wh={whCode} onStock={type === 'in' ? null : setStockItem} pend={type === 'in' && !isReturn(order, type) ? pendIn.get(order.id) : null}
        onRefill={type === 'in' && ['STO', 'SO'].includes(order.type) ? () => fillFromTransfer(order, order.type === 'SO' ? '' : whCode) : null} />}
      {type === 'out' && order && order.type === 'SO' && (extra.length > 0 || extraOpts.length > 0) && (
        <div className="card group-box" style={{ marginBottom: 10 }}>
          <div className="section-head">🚚 1 xe giao nhiều đơn <span className="small">(cùng khách {order.partyCode}, cùng công ty xuất{order.company ? ` ${order.company}` : ''}, cùng kho)</span></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge blue">{order.id} (đơn chính)</span>
            {extra.map((e) => {
              const o = orders.find((x) => x.id === e.orderId);
              const kgx = lines.filter((l) => l.orderId === e.orderId).reduce((a, l) => a + Math.abs(num(l.kg)), 0);
              return <span key={e.orderId} className="badge green">{e.orderId}{o?.refNo ? ` (${o.refNo})` : ''} · {fmtNum(kgx, 2)} kg
                <button type="button" className="btn ghost sm" title="Bỏ đơn này khỏi xe" onClick={() => removeExtra(e.orderId)}>✕</button></span>;
            })}
            {extraOpts.length > 0 && <Select searchable value="" onChange={(e) => e.target.value && addExtra(e.target.value)} style={{ minWidth: 260 }}>
              <option value="">＋ Gộp thêm đơn bán (SO) cùng xe…</option>
              {extraOpts.map((o) => <option key={o.id} value={o.id} data-search={[o.partyCode, o.partyName, ...o.lines.flatMap((l) => [l.item, l.itemName, l.shipCode])].join(' ')}>
                {o.id}{o.refNo ? ` (${o.refNo})` : ''} · {[...new Set(o.lines.filter((l) => openK(o, l, 'out') > 0 && (!lineWh(o, l, 'out') || lineWh(o, l, 'out') === whCode)).map((l) => l.item))].join(', ')} · còn {fmtNum(o.lines.reduce((a, l) => a + openK(o, l, 'out'), 0), 2)} kg</option>)}
            </Select>}
          </div>
          {extra.length > 0 && <p className="small" style={{ margin: '6px 0 0' }}>Lưu xong: mỗi đơn 1 phiếu xuất (trừ đúng đơn), in chung <b>1 phiếu soạn hàng</b> (cùng mã hàng, lot, vị trí gộp 1 dòng) và <b>1 phiếu giao hàng</b> ghi đủ các SO. Pallet xuất kèm ghi chung cho cả xe.</p>}
        </div>
      )}
      {shipPlan && shipPlan.orderId === head.orderId && <div className="ok-box" style={{ marginBottom: 10 }}>📅 Lập theo <Link to="/du-kien-xuat">dự kiến xuất {groupPlans.length > 1 ? groupPlans.map((p) => p.id).join(', ') : shipPlan.id}</Link> · ngày {shipPlan.date}{shipPlan.ship ? ` · mã giao ${shipPlan.ship}` : ''}: {(shipPlan.lines || []).filter((l) => planLeft(l) > 0.001 && (!shipPlan.ship || (l.shipCode || '') === shipPlan.ship)).map((l) => `${l.item} ${fmtNum(planLeft(l), 2)} kg${l.packing ? ` (${l.packing})` : ''}`).join(', ')}</div>}
      {fillNote && <div className="hint" style={{ marginBottom: 10 }}>{fillNote}</div>}
      {coShort.length > 0 && (
        <div className={crossCo ? 'warn-box' : 'error-box'} style={{ marginBottom: 10 }}>
          <b>⚠ {CO_SHORT_MSG}.</b>
          <ul style={{ margin: '4px 0 6px 18px', padding: 0 }}>
            {coShort.map((x) => (
              <li key={x.item}><b>{x.item}</b>: cần {fmtNum(x.need, 2)} kg, tồn {head.company} ở kho {whCode} còn {fmtNum(x.own, 2)} kg
                {Object.keys(x.others).length ? <> · công ty cùng chủ: {Object.entries(x.others).map(([c, k]) => `${c} ${fmtNum(k, 2)} kg`).join(', ')}</> : ' · công ty cùng chủ cũng không còn tồn ở kho này'}</li>
            ))}
          </ul>
          {!crossCo && canCross && <button type="button" className="btn sm primary" onClick={() => { setCrossCo(true); if (order) setAutoFill(order.id); }}>🏛️ Lấy thêm tồn công ty cùng chủ (chuyển pháp nhân)</button>}
          {crossCo && <span className="small">Đang lấy thêm tồn của công ty cùng chủ. Khi lưu phiếu, hệ thống gửi thông báo cho kế toán để chuyển pháp nhân trên phần mềm kế toán.</span>}
        </div>
      )}
      {crossPicked.length > 0 && !coShort.length && (
        <div className="warn-box" style={{ marginBottom: 10 }}>🏛️ {crossPicked.length} dòng lấy tồn của công ty {[...new Set(crossPicked.map((r) => r.company))].join(', ')} cho phiếu xuất của {head.company}: chuyển pháp nhân, khi lưu sẽ báo kế toán.</div>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-head">Hàng hóa ({lines.length})</div>
        {type !== 'in' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="cell-add" style={{ minWidth: 260 }}>
              <input list="dl-mv-item" placeholder="Mã hàng cần xuất…" value={findItem} onChange={(e) => setFindItem(e.target.value.trim())}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (itemMap.has(findItem)) setStockItem(findItem); } }} />
              <button type="button" className="btn" disabled={!itemMap.has(findItem)} onClick={() => setStockItem(findItem)} title="Xem mã hàng này đang tồn ở kho nào">📦 Xem tồn kho</button>
            </span>
            <button type="button" className="btn primary" disabled={!whCode} onClick={() => setPicking(true)}>📋 Xem tồn kho & chọn hàng</button>
            {canCross && (
              <label className="small" style={{ display: 'flex', gap: 4, alignItems: 'center' }} title="Phiếu giao vẫn mang tên công ty xuất; tồn trừ đúng công ty của dòng đã chọn; kế toán được báo để chuyển pháp nhân">
                <input type="checkbox" checked={crossCo} onChange={(e) => { setCrossCo(e.target.checked); if (!e.target.checked) setLines((ls) => { const k = ls.filter((l) => { const r = stockById.get(l.stockId); return !r || !r.company || r.company === head.company; }); return k.length ? k : [stockLine()]; }); }} />
                Lấy tồn công ty cùng chủ ({[...grp].filter((c) => c !== head.company).join(', ')}) – chuyển pháp nhân
              </label>
            )}
            <input type="search" placeholder="Lọc tồn theo mã hàng, lot, vị trí…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          </div>
        )}
        {type !== 'in' && !whCode && <div className="hint" style={{ marginBottom: 8 }}>Chưa biết hàng nằm ở kho nào? Gõ mã hàng rồi bấm <b>📦 Xem tồn kho</b> (hoặc bấm vào mã hàng trong đơn ở trên) để xem tồn theo từng kho và chọn kho xuất.</div>}
        {stockItem && (
          <ItemStockModal item={stockItem} itemName={itemMap.get(stockItem)?.name || ''} whCode={whCode} warehouses={warehouses} company={head.company}
            blocked={blocked} chosen={new Set(lines.map((l) => l.stockId).filter(Boolean))} need={order ? order.lines.filter((l) => l.item === stockItem).reduce((a, l) => a + openK(order, l, type), 0) : 0}
            onClose={() => setStockItem('')} onPick={pickFromItemStock} />
        )}
        {picking && (
          <StockPicker rows={stockRows} blocked={blocked} loading={stockLoading} total={stock.length} company={head.company} filtered={!!filter.trim()}
            otherCo={head.company ? stock.filter((r) => !coOk(r)).length : 0}
            onAllCo={canCross ? (crossCo ? null : () => setCrossCo(true)) : () => { setHead((h) => ({ ...h, company: '' })); setOpCo(''); }} crossLabel={canCross} whName={wh ? `${wh.code} – ${wh.name}` : whCode} filter={filter} setFilter={setFilter}
            chosen={new Set(lines.map((l) => l.stockId).filter(Boolean))}
            onClose={() => setPicking(false)}
            onPick={(picked) => {
              const all = type === 'move' || type === 'status' || type === 'out';
              const add = picked.map((x) => ({ ...stockLine(), stockId: x._id, bags: all ? x.bags : '', pallets: all ? x.pallets : '', kg: all ? x.kg : '' }));
              if (type === 'out' && order) setTopped([...lines.filter((l) => l.stockId), ...add]);
              else setLines((ls) => [...ls.filter((l) => l.stockId), ...add].slice(0, 30));
              setPicking(false);
            }} />
        )}
        {lines.map((l, i) => (
          <div key={i} className="mv-line">
            {type === 'in' ? (
              <InLine l={l} set={(p) => setLine(i, p)} itemMap={itemMap} items={items} locations={locations} statuses={statuses} pledgees={pledgees} locRequired={false}
                cap={caps[i]} onSplit={() => setLines((ls) => splitLineAt(ls, i, caps[i]))} />
            ) : (
              <>{extra.length > 0 && <span className="badge" title="Dòng này xuất cho đơn" style={{ alignSelf: 'center' }}>{l.orderId || order?.id}</span>}<StockLine type={type} slipCo={type === 'out' ? head.company : ''} l={l} set={(p) => setLine(i, p)} onPickOut={type === 'out' && order ? (x) => pickOutStock(i, x) : null} rows={stockRows} byId={stockById} blocked={blocked} releasable={releasable} onStock={setStockItem}
                locations={locations} statuses={statuses} pledgees={pledgees} /></>
            )}
            <button type="button" className="btn ghost" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        {lines.length < 30 && <button type="button" className="btn sm" onClick={() => setLines((ls) => [...ls, type === 'in' ? newLine() : stockLine()])}>+ Thêm dòng</button>}
      </div>
      {type === 'in' && <OverCapConfirm caps={caps} checked={overOk} onChange={setOverOk} />}
      <ErrorBox error={err} />
      {/* Ghim ở đáy màn hình: phiếu nhiều dòng không phải kéo xuống cuối mới thấy nút */}
      <div className="form-actions sticky-actions">
        <span className="small" style={{ marginRight: 'auto' }}>{lines.length} dòng · {fmtNum(lines.reduce((s2, l) => s2 + Math.abs(num(l.kg)), 0), 2)} kg</span>
        <button className="btn primary" disabled={busy}>{busy ? 'Đang ghi…' : `Lập phiếu ${meta.label.toLowerCase()}`}</button>
      </div>
      <datalist id="dl-mv-party">{parties.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
      <datalist id="dl-mv-item">{items.filter((x) => x.active !== false).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</datalist>
    </form>
  );
}

// Đơn đang chọn: đặt / đã giao-nhận / còn lại, và còn lại sau phiếu này
function OrderBox({ order, lines, type, stockById, onRefill, wh, pend, onStock }) {
  const meta = ORDER_TYPES[order.type];
  const receiving = order.type === 'STO' && type === 'in';
  const returning = isReturn(order, type);
  if (returning) wh = '';
  const doneOf = (l) => num(receiving ? l.receivedKg : returning ? l.returnedKg : l.doneKg);
  // Phiếu này: dòng đã gắn dòng đơn (orderLine) thì tính đúng dòng đó, còn lại tính vào dòng đầu cùng mã hàng
  const thisKg = {};
  const lineKg = {};
  for (const l of lines) {
    const item = type === 'in' ? l.item : stockById.get(l.stockId)?.item;
    if (!item) continue;
    if (order.lines.some((x) => x.no === l.orderLine && x.item === item)) lineKg[l.orderLine] = (lineKg[l.orderLine] || 0) + Math.abs(num(l.kg));
    else thisKg[item] = (thisKg[item] || 0) + Math.abs(num(l.kg));
  }
  const t = (kg) => fmtNum(kg, 2);
  const sto = order.type === 'STO';
  const perLine = sto || order.lines.some((l) => l.warehouse || l.shipCode || l.goodsStatus || l.dueDate);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="section-head">{meta.label} {order.id}{order.refNo ? ` · Ecount ${order.refNo}` : ''}{order.dueDate ? ` · ${meta.due} ${fmtDate(order.dueDate)}` : ''}
        {onRefill && <button type="button" className="btn sm" style={{ marginLeft: 10 }} onClick={onRefill}>↻ Điền lại hàng từ phiếu xuất</button>}</div>
      {pend?.ids?.length ? <div className="hint" style={{ color: 'var(--amber)' }}>Đơn đã có phiếu nhập chờ thủ kho nhận: {pend.ids.map((id, i) => <span key={id}>{i ? ', ' : ''}<Link className="mono" to={`/kho/phieu/${id}/in`} target="_blank">{id}</Link></span>)}. Cột còn lại đã trừ phần này.</div> : null}
      <table>
        <thead><tr><th>Mã hàng</th><th>Tên hàng</th>{perLine && <>{sto ? <><th>Kho xuất</th><th>Kho nhập</th></> : <th>Kho</th>}{order.type === 'SO' && <th>Giao</th>}<th>TTHH</th><th>{meta.due}</th></>}<th className="num">Đặt (kg)</th>{(receiving || returning) && <th className="num">{meta.done}</th>}
          <th className="num">{receiving ? meta.received : returning ? 'Đã trả về' : meta.done}</th><th className="num">{receiving ? meta.transit : returning ? 'Còn được trả' : meta.left}</th><th className="num">Phiếu này</th><th className="num">Còn lại sau phiếu</th></tr></thead>
        <tbody>
          {order.lines.map((l) => {
            const here = (x) => !perLine || !wh || !lineWh(order, x, type) || lineWh(order, x, type) === wh;
            const same = order.lines.filter((x) => x.item === l.item && here(x));
            const share = (lineKg[l.no] || 0) + (same[0] === l ? thisKg[l.item] || 0 : 0);
            const pk = pend?.byLine?.[l.no] || 0;
            const open = Math.max(0, openKg(order, l, type) - pk);
            const after = open - share;
            return (
              <tr key={l.no} style={here(l) ? undefined : { opacity: 0.45 }} title={here(l) ? '' : `Dòng này ${type === 'in' ? 'nhập về' : 'xuất từ'} kho ${lineWh(order, l, type)}`}><td>{onStock ? <ItemCode code={l.item} onStock={onStock} /> : l.item}</td><td>{l.itemName}</td>
                {perLine && <>{sto ? <><td>{lineFrom(order, l)}</td><td>{lineTo(order, l)}</td></> : <td>{lineWh(order, l)}</td>}{order.type === 'SO' && <td>{lineShip(order, l)}</td>}<td>{l.goodsStatus || (order.type === 'SO' ? 'KTC/DGC' : '')}</td><td>{fmtDate(l.dueDate)}</td></>}<td className="num">{t(l.qtyKg)}</td>{(receiving || returning) && <td className="num">{t(num(l.doneKg))}</td>}
                <td className="num">{t(doneOf(l))}</td><td className="num">{t(open)}{pk ? <div className="small" style={{ color: 'var(--amber)' }}>đã trừ {t(pk)} phiếu chờ nhận</div> : null}</td><td className="num">{share ? t(share) : ''}</td>
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

function LocationSelect({ value, onChange, locations, exclude, wh }) {
  const whCode = wh || locations[0]?.warehouse || '';
  return (
    <WithAdd cat="locations" preset={whCode ? { warehouse: whCode } : undefined} onAdded={(id, r) => onChange(r?.code || String(id).split('__').pop())}>
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">-- Vị trí --</option>
      {locations.filter((x) => x.code !== exclude).sort((a, b) => a.code.localeCompare(b.code)).map((x) => {
        const free = num(x.capacity) - num(x.currentPallets);
        return <option key={x.code} value={x.code} disabled={x.locked}>{x.code} · trống {fmtNum(free, 1)}/{fmtNum(x.capacity)} pallet{x.locked ? ' (khóa)' : ''}</option>;
      })}
    </Select>
    </WithAdd>
  );
}

// Thứ tự nhập: Số kg → Pallet → Số bao (kg là đơn vị chính; tấn, pallet là quy đổi); sửa ô nào thì hai ô kia tự tính lại
function QtyFields({ l, onKg, onPallets, onBags }) {
  return (
    <>
      <Field label="Số kg">
        <input type="number" step="any" value={l.kgTxt ?? (l.kg === '' || l.kg == null ? '' : parseFloat(num(l.kg).toFixed(3)))} onChange={(e) => onKg(e.target.value)} />
        {num(l.kg) > 0 && <small className="small">= {fmtNum(num(l.kg) / 1000, 3)} tấn</small>}
      </Field>
      <Field label="Pallet"><input type="number" step="any" value={l.pallets} onChange={(e) => onPallets(e.target.value)} /></Field>
      <Field label="Số bao"><input type="number" step="any" value={l.bags} onChange={(e) => onBags(e.target.value)} /></Field>
    </>
  );
}

export function InLine({ l, set, itemMap, locations, statuses, pledgees, locRequired = true, cap, onSplit }) {
  const it = itemMap.get(l.item);
  const setBags = (v) => set({ bags: v, pallets: suggestPallets(it, v), kg: kgOf(it, v), kgTxt: undefined });
  const setKg = (v) => {
    const kg = v === '' ? '' : r3(num(v));
    const bags = kg !== '' && num(it?.bagWeight) ? r3(kg / num(it.bagWeight)) : '';
    set({ kgTxt: v, kg, bags: bags === '' ? l.bags : bags, pallets: bags === '' ? l.pallets : suggestPallets(it, bags) });
  };
  const setPallets = (v) => {
    const per = num(it?.bagsPerLayer) * num(it?.layersPerPallet);
    const bags = per && v !== '' ? r3(num(v) * per) : '';
    set({ pallets: v, ...(bags === '' ? {} : { bags, kg: kgOf(it, bags) === '' ? l.kg : kgOf(it, bags), kgTxt: undefined }) });
  };
  return (
    <div className="mv-grid">
      <Field label="Mã hàng" required>
        <WithAdd cat="items" onAdded={(id) => set({ item: id })}><input list="dl-mv-item" value={l.item} onChange={(e) => { const x = itemMap.get(e.target.value); set({ item: e.target.value, ...(x && l.bags ? { pallets: suggestPallets(x, l.bags), kg: kgOf(x, l.bags), kgTxt: undefined } : {}) }); }} /></WithAdd>
        {it && <small className="small">{it.name}</small>}
      </Field>
      <Field label="Lot"><input value={l.lot} onChange={(e) => set({ lot: e.target.value })} /></Field>
      {/* NSX, HSD chỉ hiện với mã hàng có tích "Quản lý NSX / HSD" (hạt nhựa không cần) */}
      {(it?.trackDates || l.mfgDate || l.expDate) && <>
        <Field label="NSX"><input type="date" value={l.mfgDate} onChange={(e) => set({ mfgDate: e.target.value })} /></Field>
        <Field label="HSD"><input type="date" value={l.expDate} onChange={(e) => set({ expDate: e.target.value })} /></Field>
      </>}
      <Field label="Vị trí" required={locRequired} help={locRequired ? '' : 'Thủ kho chọn khi nhận hàng'}><LocationSelect value={l.location} onChange={(v) => set({ location: v })} locations={locations} /></Field>
      <Field label="Tình trạng">
        <WithAdd cat="goodsStatus" onAdded={(id) => set({ goodsStatus: id })}>
          <Select value={l.goodsStatus} onChange={(e) => set({ goodsStatus: e.target.value })}>
            {statuses.map((s) => <option key={s.code} value={s.code}>{s.code} – {s.name}</option>)}
            {!statuses.length && <option value="KTC">KTC</option>}
          </Select>
        </WithAdd>
      </Field>
      {l.goodsStatus === 'HTC' && (
        <Field label="Bên nhận thế chấp" required>
          <WithAdd cat="pledgees" onAdded={(id) => set({ pledgee: id })}>
            <Select value={l.pledgee} onChange={(e) => set({ pledgee: e.target.value })}>
              <option value="">-- Chọn --</option>
              {pledgees.map((p) => <option key={p.code} value={p.code}>{p.code} – {p.name}</option>)}
            </Select>
          </WithAdd>
        </Field>
      )}
      <QtyFields l={l} onKg={setKg} onPallets={setPallets} onBags={setBags} />
      {cap?.over && <CapWarn cap={cap} onSplit={onSplit} />}
    </div>
  );
}

// Cảnh báo dòng nhập vượt số pallet còn trống của vị trí + nút chia thành nhiều dòng
function CapWarn({ cap, onSplit }) {
  return (
    <div className="error-box" style={{ gridColumn: '1 / -1', margin: 0 }}>
      ⚠ <b>{OVER_CAP_MSG}</b>: {cap.location} còn trống {fmtNum(cap.free, 2)}/{fmtNum(cap.capacity)} pallet, dòng này {fmtNum(cap.need, 2)} pallet.{' '}
      {onSplit && <button type="button" className="btn sm" onClick={onSplit}>✂ Chia thành nhiều dòng (mỗi dòng ≤ {fmtNum(cap.capacity)} pallet)</button>}
    </div>
  );
}

// Ô tích bắt buộc khi vẫn nhập vượt giới hạn vị trí
export function OverCapConfirm({ caps, checked, onChange }) {
  const over = caps.filter((c) => c?.over);
  if (!over.length) return null;
  return (
    <div className="error-box">
      ⚠ {OVER_CAP_MSG} ở {over.length} dòng ({[...new Set(over.map((c) => c.location))].join(', ')}). Chia thành nhiều dòng để chọn vị trí khác, hoặc{' '}
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {OVER_CAP_CONFIRM}
      </label>
    </div>
  );
}

// Thay dòng i bằng các dòng đã chia theo sức chứa vị trí
export const splitLineAt = (lines, i, cap) => [...lines.slice(0, i), ...splitByCapacity(lines[i], cap), ...lines.slice(i + 1)];

const STATUS_COLS = ['HTC', 'KTC', 'DGC'];
// Bảng tồn kho dạng cột để tick chọn nhiều dòng; dòng bị khóa xuất (HTC khi xuất bán) không chọn được
function StockPicker({ rows, blocked, whName, filter, setFilter, chosen, onClose, onPick, loading, total, company, otherCo, onAllCo, filtered, crossLabel }) {
  const allLabel = crossLabel ? '🏛️ Lấy tồn công ty cùng chủ (chuyển pháp nhân)' : 'Xem tồn của mọi công ty';
  const [sel, setSel] = useState(() => new Set());
  const others = [...new Set(rows.map((r) => r.goodsStatus))].filter((c) => !STATUS_COLS.includes(c));
  const cols = [...STATUS_COLS, ...others];
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const sumBy = (c) => rows.filter((r) => r.goodsStatus === c).reduce((a, r) => a + num(r.kg), 0);
  return (
    <Modal title={`Tồn kho ${whName} – tick chọn hàng`} onClose={onClose} wide>
      <input type="search" placeholder="Lọc theo mã hàng, tên, lot, vị trí…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', marginBottom: 8 }} autoFocus />
      {crossLabel && company && (onAllCo && otherCo ? <div className="hint" style={{ marginBottom: 8 }}>Đang hiện tồn của công ty xuất <b>{company}</b>. Thiếu hàng? <button type="button" className="btn sm" onClick={onAllCo}>{allLabel}</button></div>
        : !onAllCo ? <div className="hint" style={{ marginBottom: 8 }}>Hiện cả tồn công ty cùng chủ: dòng tô vàng là <b>chuyển pháp nhân</b> (phiếu giao vẫn mang tên {company}, kế toán được báo khi lưu).</div> : null)}
      <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
        <table className="picker">
          <thead><tr><th></th><th>Công ty</th><th>Kho</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Vị trí</th><th>Ngày nhập</th>
            {cols.map((c) => <th key={c} className="num">{c} (kg)</th>)}<th className="num">Pallet</th><th className="num">Số bao</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const lock = blocked(r); const had = chosen.has(r._id);
              return (
                <tr key={r._id} className={lock ? 'locked' : sel.has(r._id) ? 'picked' : ''} onClick={() => !lock && !had && toggle(r._id)} style={{ cursor: lock || had ? 'not-allowed' : 'pointer' }}>
                  <td>{lock ? '🔒' : <input type="checkbox" checked={had || sel.has(r._id)} disabled={had} onChange={() => toggle(r._id)} onClick={(e) => e.stopPropagation()} />}</td>
                  <td style={crossLabel && company && r.company && r.company !== company ? { background: 'var(--amber-soft)', fontWeight: 600 } : undefined}>{r.company || ''}</td><td>{r.warehouse}</td><td>{r.item}</td><td>{r.itemName}</td><td>{r.lot || '-'}</td><td>{r.location}</td>
                  <td>{fmtDate(r.inDate)} <small className="small">({ageDays(r.inDate)} ngày)</small></td>
                  {cols.map((c) => <td key={c} className="num">{r.goodsStatus === c ? <b>{fmtNum(num(r.kg), 2)}</b> : ''}{r.goodsStatus === c && r.pledgee ? <small className="small"> {r.pledgee}</small> : ''}</td>)}
                  <td className="num">{fmtNum(r.pallets, 2)}</td><td className="num">{fmtNum(r.bags)}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={10 + cols.length} className="small">
              {loading ? 'Đang tải tồn kho…'
                : !total ? `Kho ${whName} chưa có tồn kho nào (chưa có phiếu nhập được thủ kho xác nhận, hoặc chưa nhập tồn đầu kỳ).`
                : otherCo && rows.length === 0 && !filtered ? <>Kho có {otherCo} dòng tồn nhưng không thuộc công ty <b>{company}</b> đang chọn. {onAllCo && <button type="button" className="btn sm" onClick={onAllCo}>{allLabel}</button>}</>
                : <>Không có hàng tồn khớp bộ lọc{company ? ` (công ty ${company})` : ''}.{company && otherCo && onAllCo ? <> <button type="button" className="btn sm" onClick={onAllCo}>{allLabel}</button></> : null}</>}
            </td></tr>}
          </tbody>
          <tfoot><tr><td colSpan={8}>Cộng</td>{cols.map((c) => <td key={c} className="num">{fmtNum(sumBy(c), 2)}</td>)}<td colSpan={2}></td></tr></tfoot>
        </table>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
        <small className="small">🔒 = hàng bị khóa xuất. Xuất bán chọn được cả hàng HTC: phiếu lưu Chờ giải chấp, ghi xuất kho khi lập lệnh giải chấp. Có thể chọn nhiều dòng, kể cả KTC, DGC, HTC trong cùng một phiếu.</small>
        <button type="button" className="btn primary" disabled={!sel.size} onClick={() => onPick(rows.filter((r) => sel.has(r._id)))}>Thêm {sel.size} dòng vào phiếu</button>
      </div>
    </Modal>
  );
}

function StockLine({ type, slipCo, l, set, onPickOut, rows, byId, blocked, releasable, locations, statuses, pledgees, onStock }) {
  const r = byId.get(l.stockId);
  // Số lượng xuất/chuyển → pallet, kg chia theo tỷ lệ tồn
  const setBags = (v) => {
    if (!r || !num(r.bags)) return set({ bags: v, kgTxt: undefined });
    const k = num(v) / num(r.bags);
    set({ bags: v, pallets: r3(num(r.pallets) * k), kg: r3(num(r.kg) * k), kgTxt: undefined });
  };
  const setKg = (v) => {
    const kg = v === '' ? '' : r3(num(v));
    if (!r || !num(r.kg) || kg === '') return set({ kgTxt: v, kg });
    const k = kg / num(r.kg);
    set({ kgTxt: v, kg, bags: r3(num(r.bags) * k), pallets: r3(num(r.pallets) * k) });
  };
  const setPallets = (v) => {
    if (!r || !num(r.pallets) || v === '') return set({ pallets: v });
    const k = num(v) / num(r.pallets);
    set({ pallets: v, bags: r3(num(r.bags) * k), kg: r3(num(r.kg) * k), kgTxt: undefined });
  };
  const pick = (id) => {
    const x = byId.get(id);
    if (!x) return set({ stockId: id });
    if (onPickOut) return onPickOut(x);
    const all = type === 'move' || type === 'status';
    set({ stockId: id, bags: all ? x.bags : '', pallets: all ? x.pallets : '', kg: all ? x.kg : '', kgTxt: undefined });
  };
  return (
    <div className="mv-grid">
      {r ? (
        <div className="field full">
          <span>Hàng chọn từ tồn kho</span>
          <div className="stock-pick">
            <span><small>Công ty</small>{r.company || '-'}{slipCo && r.company && r.company !== slipCo ? <b style={{ color: 'var(--amber)' }}> 🏛️ chuyển pháp nhân → {slipCo}</b> : ''}</span><span><small>Kho</small>{r.warehouse}</span><span><small>Mã hàng</small><ItemCode code={r.item} onStock={onStock} /></span>
            <span className="grow"><small>Tên hàng</small>{r.itemName}</span><span><small>Lot</small>{r.lot || '-'}</span><span><small>Vị trí</small>{r.location}</span>
            <span><small>Tình trạng</small>{r.goodsStatus}{r.pledgee ? ` (${r.pledgee})` : ''}{blocked(r) ? ' 🔒' : ''}{releasable?.(r) ? <b style={{ color: 'var(--amber)' }}> ⏳ phiếu chờ giải chấp</b> : ''}</span>
            <span><small>Còn</small>{fmtNum(num(r.kg), 2)} kg · {fmtNum(r.pallets, 2)} pl · {fmtNum(r.bags)} bao</span>
            <button type="button" className="btn sm ghost" onClick={() => set({ stockId: '', bags: '', pallets: '', kg: '', kgTxt: undefined })}>Đổi</button>
          </div>
        </div>
      ) : (
      <Field label="Dòng tồn (FIFO)" required full>
        <Select value={l.stockId} onChange={(e) => pick(e.target.value)}>
          <option value="">-- Chọn hàng trong kho --</option>
          {rows.map((x) => (
            <option key={x._id} value={x._id} disabled={blocked(x)}>
              {x.company ? `[${x.company}] ` : ''}{x.item} · lot {x.lot || '-'} · {x.location} · {x.goodsStatus}{x.pledgee ? `(${x.pledgee})` : ''} · {fmtNum(x.bags)} bao / {fmtNum(x.pallets, 2)} pl · nhập {fmtDate(x.inDate)} ({ageDays(x.inDate)} ngày){blocked(x) ? ' · KHÓA XUẤT' : releasable?.(x) ? ' · chờ giải chấp' : ''}
            </option>
          ))}
        </Select>
        <small className="small">Hoặc bấm 📋 Xem tồn kho & chọn hàng để xem dạng bảng.</small>
      </Field>
      )}
      {type === 'adjust' && (
        <Field label="Tăng / giảm">
          <Select value={l.sign} onChange={(e) => set({ sign: e.target.value })}><option value="+">Tăng (+)</option><option value="-">Giảm (−)</option></Select>
        </Field>
      )}
      {type === 'move' && <Field label="Đến vị trí" required><LocationSelect value={l.toLocation} onChange={(v) => set({ toLocation: v })} locations={locations} exclude={r?.location} /></Field>}
      {type === 'status' && (
        <>
          <Field label="Tình trạng mới" required>
            <WithAdd cat="goodsStatus" onAdded={(id) => set({ toStatus: id })}>
              <Select value={l.toStatus} onChange={(e) => set({ toStatus: e.target.value })}>
                <option value="">-- Chọn --</option>
                {statuses.filter((s) => s.code !== r?.goodsStatus).map((s) => <option key={s.code} value={s.code}>{s.code} – {s.name}</option>)}
              </Select>
            </WithAdd>
          </Field>
          {l.toStatus === 'HTC' && (
            <Field label="Bên nhận thế chấp" required>
              <WithAdd cat="pledgees" onAdded={(id) => set({ toPledgee: id })}>
                <Select value={l.toPledgee} onChange={(e) => set({ toPledgee: e.target.value })}>
                  <option value="">-- Chọn --</option>
                  {pledgees.map((p) => <option key={p.code} value={p.code}>{p.code} – {p.name}</option>)}
                </Select>
              </WithAdd>
            </Field>
          )}
        </>
      )}
      <QtyFields l={l} onKg={setKg} onPallets={setPallets} onBags={setBags} />
    </div>
  );
}

// Bảng chọn đơn xuất kho: tìm theo số đơn, mã hàng, khách hàng, kho… → tích dòng đơn (cùng 1 đơn, cùng kho xuất) → nhập số lượng xuất
function OrderPicker({ orders, myWh, whCode, onClose, onPick }) {
  const [q, setQ] = useState('');
  const [fWh, setFWh] = useState('');
  const [fType, setFType] = useState('');
  const [sel, setSel] = useState({}); // key → số kg xuất (chuỗi)
  const [err, setErr] = useState('');
  const mine = new Set(myWh.map((w) => w.code));
  const rows = useMemo(() => {
    const out = [];
    for (const o of orders) {
      if (!['SO', 'STO'].includes(o.type)) continue;
      for (const l of o.lines) {
        const left = openKg(o, l, 'out');
        if (left <= 0.001) continue;
        const wh = lineWh(o, l, 'out');
        if (wh && !mine.has(wh)) continue;
        out.push({ key: `${o.id}#${l.no}`, o, l, wh, left, due: l.dueDate || o.dueDate || '',
          who: o.type === 'STO' ? `→ kho ${lineTo(o, l)}` : `${o.partyCode} ${o.partyName || ''}`, ship: o.type === 'SO' ? lineShip(o, l) : '' });
      }
    }
    return out.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.o.id.localeCompare(b.o.id) || a.l.no - b.l.no);
  }, [orders]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!fWh || r.wh === fWh || !r.wh) && (!fType || r.o.type === fType)
    && (!f || [r.o.id, r.o.refNo, r.l.item, r.l.itemName, r.who, r.wh, r.ship].join(' ').toLowerCase().includes(f)));
  const chosen = rows.filter((r) => sel[r.key] != null);
  const first = chosen[0];
  const selWh = chosen.find((r) => r.wh)?.wh || '';
  // Một phiếu xuất = 1 đơn, 1 kho xuất
  const lockOf = (r) => (first && r.o.id !== first.o.id ? `Phiếu này đang xuất theo ${first.o.id}` : selWh && r.wh && r.wh !== selWh ? `Dòng này xuất từ kho ${r.wh}` : '');
  const toggle = (r) => setSel((x) => {
    const n = { ...x };
    if (n[r.key] != null) delete n[r.key]; else n[r.key] = String(r3(r.left));
    return n;
  });
  const ok = () => {
    setErr('');
    if (!chosen.length) return setErr('Tích ít nhất 1 dòng đơn cần xuất.');
    const wh = selWh || fWh || whCode;
    if (!wh) return setErr('Các dòng đã chọn không ghi kho xuất: chọn kho ở ô lọc Kho xuất.');
    const plan = {};
    for (const r of chosen) {
      const kg = r3(num(sel[r.key]));
      if (!(kg > 0)) return setErr(`${r.o.id} · ${r.l.item}: nhập số kg muốn xuất.`);
      plan[r.l.no] = kg;
    }
    onPick(first.o.id, plan, wh);
  };
  const total = chosen.reduce((s, r) => s + num(sel[r.key]), 0);
  return (
    <Modal title="Chọn đơn xuất kho" onClose={onClose} wide>
      <div className="filters" style={{ marginBottom: 8 }}>
        <input type="search" autoFocus placeholder="Tìm số đơn, mã hàng, tên hàng, khách hàng, kho, mã giao…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 260 }} />
        <Select value={fWh} onChange={(e) => setFWh(e.target.value)}>
          <option value="">Kho xuất: tất cả</option>
          {myWh.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
        </Select>
        <Select value={fType} onChange={(e) => setFType(e.target.value)}>
          <option value="">SO và STO</option><option value="SO">Đơn bán (SO)</option><option value="STO">Chuyển kho (STO)</option>
        </Select>
      </div>
      <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
        <table className="picker">
          <thead><tr><th></th><th>Số đơn</th><th>Ngày giao</th><th>Khách hàng / kho nhận</th><th>Mã giao</th><th>Kho xuất</th><th>Mã hàng</th><th>Tên hàng</th><th>TTHH</th><th className="num">Còn phải xuất (kg)</th><th className="num">SL xuất (kg)</th></tr></thead>
          <tbody>
            {!shown.length && <tr><td colSpan={11} className="small">Không có dòng đơn nào còn phải xuất phù hợp.</td></tr>}
            {shown.map((r) => {
              const on = sel[r.key] != null;
              const lock = !on && lockOf(r);
              return (
                <tr key={r.key} className={on ? 'picked' : lock ? 'locked' : ''} title={lock || ''} style={{ cursor: lock ? 'not-allowed' : 'pointer' }} onClick={() => !lock && toggle(r)}>
                  <td><input type="checkbox" checked={on} disabled={!!lock} readOnly /></td>
                  <td className="mono">{r.o.id} <span className="badge">{r.o.type}</span></td><td>{fmtDate(r.due)}</td><td>{r.who}</td><td>{r.ship}</td><td>{r.wh || 'Kho nào cũng được'}</td>
                  <td>{r.l.item}</td><td>{r.l.itemName}</td><td>{r.l.goodsStatus || (r.o.type === 'SO' ? 'KTC/DGC' : 'Tất cả')}</td><td className="num">{fmtNum(r.left, 2)}</td>
                  <td className="num" onClick={(e) => e.stopPropagation()}>
                    {on && <input type="number" step="any" min="0" value={sel[r.key]} style={{ width: 100 }} onChange={(e) => setSel((x) => ({ ...x, [r.key]: e.target.value }))} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorBox error={err} />
      <div className="form-actions">
        <span className="small" style={{ marginRight: 'auto' }}>{chosen.length ? `Đã chọn ${chosen.length} dòng của ${first.o.id} · ${fmtNum(total, 2)} kg (${fmtNum(total / 1000, 3)} tấn)` : 'Bấm vào dòng để chọn. Mỗi phiếu xuất theo 1 đơn và 1 kho xuất.'}</span>
        <button type="button" className="btn primary" onClick={ok}>Chọn hàng theo FIFO →</button>
      </div>
    </Modal>
  );
}
