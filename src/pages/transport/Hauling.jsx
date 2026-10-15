import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, doc, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { usePref } from '../../lib/prefs';
import { OPEN_STATUSES } from '../../lib/orders';
import { enrichLine, navUrl, placeOf, whOf, whText, isGHA, isInternal, kindText, usesVehicleList } from '../../lib/dispatch';
import Dispatch from './Dispatch';
import Statements from './Statements';
import TripReport from './Report';
import { STATUS_META, fmtTime, nowISO } from '../../lib/trips';
import { STEPS, costTotal, createPlannedTrips, nextStep, splitLoads, stepBlocked, suggestFreight, tripKg } from '../../lib/transport';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, today } from '../../lib/utils';
import { Empty, ErrorBox, Modal } from '../../components/ui';
import { DriverLinkBox, PhotoModal, StepModal } from '../../components/TripSteps';
import { WithAdd } from '../../components/FormTools';
import { BASE_COST_FIELDS, COST_GROUPS, calcCosts, freightTotalOf, useCostFields } from '../../lib/tripCosts';
import Select from '../../components/Select';

// Vận chuyển theo chuyến: đơn cần chia xe → chuyến xe (tài xế xác nhận từng bước) → chi phí & cước
const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
const t3 = (kg) => fmtNum(n(kg) / 1000, 3);
const vnd = (v) => (v == null || v === '' ? '' : fmtNum(n(v)));
const COST = { '': ['Chưa nhập chi phí', ''], entered: ['Đã nhập · chờ kế toán chốt', 'amber'], approved: ['Kế toán đã chốt', 'green'] };
const COST3 = { '': ['Chưa nhập cước', ''], entered: ['3PL đã nhập · chờ GHA chốt', 'amber'], approved: ['GHA đã chốt', 'green'] };
const monthStart = () => today().slice(0, 8) + '01';

export default function Hauling() {
  const { role, isAdmin, hasRole, myCarrier, myThreepl, can3PL, isSuper } = useApp();
  const isCarrier = role === 'van_tai';
  const isTpl = role === 'tpl';
  const tabs = [...(isAdmin ? [['cho-giao', 'Chờ giao vận tải']] : []), ['chuyen', isTpl ? 'Chuyến 3PL của tôi' : 'Chuyến xe'], ...(isTpl ? [] : [['chi-phi', 'Chi phí & cước']]),
    ['tinh-trang', 'Tình trạng xe'], ['bang-ke', 'Bảng kê'], ...(isAdmin || isCarrier ? [['tai-xe', can3PL ? 'Link tài xế / tài khoản 3PL' : 'Link tài xế']] : [])];
  const [sp, setSp] = useSearchParams();
  const tab = tabs.some(([k]) => k === sp.get('tab')) ? sp.get('tab') : tabs[0][0];
  const [orders, setOrders] = useState([]);
  const [allTrips, setTrips] = useState([]);
  const [priv, setPriv] = useState({});
  const [error, setError] = useState('');
  const [split, setSplit] = useState(null);
  // Đơn đang mở: chỉ quản trị cần (Chờ giao vận tải). Đơn vị vận tải chỉ thấy chuyến đã được giao
  useEffect(() => (isAdmin ? onSnapshot(query(collection(db, 'orders'), where('status', 'in', OPEN_STATUSES)),
    (s) => setOrders(s.docs.map((d) => d.data())), (e) => setError(e.message)) : undefined), [isAdmin]);
  useEffect(() => onSnapshot(isCarrier || isTpl ? query(collection(db, 'trips'), where('carrier', '==', myCarrier || '-')) : query(collection(db, 'trips'), where('source', '==', 'plan')),
    (s) => setTrips(s.docs.map((d) => ({ ...d.data(), id: d.id })).filter((x) => x.source === 'plan').sort((a, b) => String(b.plannedDate + b.id).localeCompare(String(a.plannedDate + a.id)))),
    (e) => setError(e.message)), [isCarrier, isTpl, myCarrier]);
  // 3PL lưu riêng: GHA và quản trị gốc đọc tất cả của GHA, 3PL chỉ đọc chuyến của mình
  useEffect(() => {
    if (!can3PL && !isTpl) { setPriv({}); return undefined; }
    const q = isSuper ? collection(db, 'tripPrivate') : isTpl ? query(collection(db, 'tripPrivate'), where('threepl', '==', myThreepl || '-')) : query(collection(db, 'tripPrivate'), where('carrier', '==', myCarrier));
    return onSnapshot(q, (s) => setPriv(Object.fromEntries(s.docs.map((d) => [d.id, d.data()]))), () => setPriv({}));
  }, [can3PL, isTpl, isSuper, myCarrier, myThreepl]);
  const trips = isTpl ? allTrips.filter((t) => priv[t.id]?.threepl === myThreepl) : allTrips;

  return (
    <div>
      <div className="page-head"><h1>🚛 Vận chuyển</h1>
        <div className="actions">{(isAdmin || hasRole('ke_toan')) && <Link className="btn" to="/dm/freightRates">💰 Bảng giá cước</Link>}</div></div>
      {(isCarrier || isTpl) && !myCarrier && <div className="error-box">Tài khoản chưa gắn đơn vị vận tải. Báo quản trị vào Phân quyền chọn "Thuộc đơn vị vận tải".</div>}
      {isTpl && !myThreepl && <div className="error-box">Tài khoản 3PL chưa gắn mã 3PL. Báo GHA vào Tài khoản tài xế / 3PL để chọn.</div>}
      <div className="seg" style={{ marginBottom: 12 }}>
        {tabs.map(([k, l]) => <button key={k} type="button" className={'btn sm' + (tab === k ? ' primary' : '')} onClick={() => setSp({ tab: k })}>{l}</button>)}
      </div>
      <ErrorBox error={error} />
      {tab === 'cho-giao' && <Dispatch orders={orders} trips={allTrips} onSplit={setSplit} />}
      {tab === 'chuyen' && <TripList trips={trips} priv={priv} />}
      {tab === 'chi-phi' && <Costs trips={trips} priv={priv} />}
      {tab === 'tinh-trang' && <TripReport trips={trips} priv={priv} />}
      {tab === 'bang-ke' && <Statements trips={trips} priv={priv} />}
      {tab === 'tai-xe' && <DriverAccounts />}
      {split && <SplitModal {...split} onClose={(ok) => { setSplit(null); if (ok) split.done?.(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chia xe dạng bảng: mỗi chuyến (dòng) × mỗi mã hàng / dòng đơn (cột) nhập số tấn; tổng chuyến không vượt tải trọng xe
function SplitModal({ rows, carrier, onClose, action = 'Chia xe' }) {
  const { email, name, can3PL } = useApp();
  // Danh mục xe chỉ dùng cho xe nội bộ / xe nhà GHA; xe thuê ngoài gõ tự do
  const vehicles = useCollection(usesVehicleList(carrier) ? 'vehicles' : '').rows.filter((v) => v.carrier === carrier.code);
  // Họ tên, CCCD tài xế chỉ cho xe nội bộ nhóm và xe nhà GHA
  const drvCols = usesVehicleList(carrier);
  const drivers = useCollection(drvCols ? 'drivers' : '').rows.filter((d) => d.carrier === carrier.code);
  const warehouses = useCollection('warehouses').rows;
  // Admin giao vận tải không chọn 3PL: GHA chọn ở màn hình đăng ký xe
  const threepl = useCollection(can3PL && isGHA(carrier) && action !== 'Giao vận tải' ? 'threepl' : '').rows;
  const [need, setNeed] = useState(() => Object.fromEntries(rows.map((r) => [r.key, r.rest])));
  const total = rows.reduce((s, r) => s + n(need[r.key]), 0);
  const [cap, setCap] = useState(30);
  const [date, setDate] = useState(() => (rows[0].due && rows[0].due > today() ? rows[0].due : today()));
  const blank = (c) => ({ cap: n(c), plate: '', vehicleType: '', idCard: '', driverName: '', driverPhone: '', threepl: '', q: {} });
  // Xếp lần lượt: lấp đầy từng xe theo thứ tự các mã (ít ghép mã trên 1 xe)
  const seq = (ls) => { const al = splitLoads(rows.map((r) => ({ ...r, kg: n(need[r.key]) })), ls.map((l) => n(l.cap) * 1000)); return ls.map((l, i) => ({ ...l, q: Object.fromEntries((al[i] || []).map((a) => [a.key, a.kg])) })); };
  // Chia đều theo tỷ lệ: xe nào cũng chở mọi mã theo tỷ lệ tải trọng
  const prop = (ls) => {
    const caps = ls.map((l) => n(l.cap) * 1000); const sumCap = caps.reduce((a, b) => a + b, 0) || 1;
    const out = ls.map((l) => ({ ...l, q: {} }));
    for (const r of rows) {
      let left = n(need[r.key]);
      out.forEach((l, i) => { const k = i === out.length - 1 ? left : Math.min(left, Math.round(n(need[r.key]) * Math.min(1, caps[i] / Math.max(sumCap, total)))); if (k > 0) l.q[r.key] = k; left -= k; });
    }
    return out;
  };
  const make = (c, how = 'seq') => { const k = Math.max(1, Math.ceil(total / (n(c) * 1000 || 1) - 1e-9)); const ls = Array.from({ length: k }, () => blank(c)); return how === 'prop' ? prop(ls) : seq(ls); };
  const [loads, setLoads] = useState(() => make(30));
  useEffect(() => { const p = n(vehicles[0]?.payload); if (p && cap === 30) { setCap(p); setLoads(make(p)); } }, [vehicles.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setLoad = (i, p) => setLoads((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const setQ = (i, key, tons) => setLoads((ls) => ls.map((l, j) => (j === i ? { ...l, q: { ...l.q, [key]: Math.round(n(tons) * 1000) } } : l)));
  const pickPlate = (i, v) => { const veh = vehicles.find((x) => x.plate === v.trim().toUpperCase()); setLoad(i, { plate: v.toUpperCase(), ...(veh ? { vehicleType: veh.vehicleType || '', cap: n(veh.payload) || loads[i].cap } : {}) }); };
  const pickDriver = (i, v) => { const d = drivers.find((x) => x.idCard === v); setLoad(i, { idCard: v, ...(d ? { driverName: d.name || '', driverPhone: d.phone || '' } : {}) }); };
  const rowKg = (l) => rows.reduce((s, r) => s + n(l.q[r.key]), 0);
  const colKg = (r) => loads.reduce((s, l) => s + n(l.q[r.key]), 0);
  const sumLoads = loads.reduce((s, l) => s + rowKg(l), 0);
  const save = async () => {
    setErr('');
    const bad = rows.find((r) => n(need[r.key]) > r.rest + 1);
    if (bad) return setErr(`${bad.orderId} ${bad.item}: chia nhiều hơn số còn phải chia (${t3(bad.rest)} tấn).`);
    const off = rows.find((r) => Math.abs(colKg(r) - n(need[r.key])) > 1);
    if (off) return setErr(`${off.orderId} ${off.item}: các chuyến đang xếp ${t3(colKg(off))} tấn, cần ${t3(need[off.key])} tấn.`);
    const over = loads.findIndex((l) => n(l.cap) && rowKg(l) > n(l.cap) * 1000 + 1);
    if (over >= 0) return setErr(`Chuyến ${over + 1}: ${t3(rowKg(loads[over]))} tấn vượt tải trọng ${loads[over].cap} tấn.`);
    const used = loads.filter((l) => rowKg(l) > 0);
    if (!used.length) return setErr('Chưa xếp hàng cho chuyến nào.');
    setBusy(true);
    try {
      const wh = warehouses.find((w) => w.code === rows[0].warehouse) || { code: rows[0].warehouse };
      await createPlannedTrips({ wh, carrier, trips: used.map((l) => ({ ...l, date, company: rows[0].company || '', lines: rows.filter((r) => n(l.q[r.key]) > 0).map((r) => ({ ...r, kg: n(l.q[r.key]) })),
        threeplName: threepl.find((x) => x.code === l.threepl)?.name || '' })) }, { email, name }, action);
      onClose(true);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền tạo chuyến (kiểm tra phân quyền / firestore.rules).' : e.message); }
    setBusy(false);
  };
  const nTrips = Math.max(1, Math.ceil(total / (n(cap) * 1000 || 1) - 1e-9));
  return (
    <Modal title={`Chia xe · ${carrier.name || carrier.code} · kho ${rows[0].warehouse}`} onClose={() => onClose(false)} wide>
      <div className="filters">
        <label>Ngày đi <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Tải trọng xe (tấn) <input type="number" step="0.5" style={{ width: 80 }} value={cap} onChange={(e) => setCap(e.target.value)} /></label>
        <button type="button" className="btn" onClick={() => setLoads(make(cap, 'seq'))} title="Lấp đầy từng xe theo thứ tự các mã, ít ghép mã">⟳ Xếp lần lượt từng mã ({nTrips} chuyến)</button>
        <button type="button" className="btn" onClick={() => setLoads(make(cap, 'prop'))} title="Xe nào cũng chở đủ các mã theo tỷ lệ">⟳ Chia đều các mã cho mọi xe</button>
        <button type="button" className="btn ghost" onClick={() => setLoads((ls) => [...ls, blank(cap)])}>+ Thêm chuyến</button>
        <span className={Math.abs(sumLoads - total) > 1 ? 'badge red' : 'badge green'}>Đã xếp {t3(sumLoads)} / {t3(total)} tấn</span>
      </div>
      <p className="small">Mỗi cột là một mã hàng / dòng đơn, mỗi dòng là một chuyến xe. Sửa trực tiếp số tấn từng ô; tổng chuyến phải ≤ tải trọng, tổng cột phải bằng số cần chia.</p>
      <div className="table-wrap" style={{ maxHeight: '55vh', overflow: 'auto' }}><table className="so-lines split">
        <thead>
          <tr><th>#</th><th title="Xe nhà: chọn trong danh sách. Xe thuê ngoài: gõ thẳng số xe, không cần thêm vào danh mục">Số xe (xe ngoài gõ tự do, bổ sung sau được)</th><th>Tải trọng</th>
            {rows.map((r) => <th key={r.key} className="num" title={`${r.orderId} dòng ${r.no}`}>{r.item}<div className="small" style={{ fontWeight: 400 }}>{r.orderId}{r.shipCode ? ` · ${r.shipCode}` : ''}</div></th>)}
            <th className="num">Tổng chuyến</th>{drvCols && <><th>CCCD (không bắt buộc)</th><th>Họ tên tài xế</th></>}<th>ĐT tài xế</th>{threepl.length > 0 && <th>3PL</th>}<th></th></tr>
          <tr className="need"><td colSpan={3} className="small"><b>Cần chia (tấn)</b> · còn lại tối đa</td>
            {rows.map((r) => <td key={r.key}><input type="number" step="0.001" value={n(need[r.key]) / 1000} onChange={(e) => setNeed((m) => ({ ...m, [r.key]: Math.round(n(e.target.value) * 1000) }))} /><div className="small num">/ {t3(r.rest)}</div></td>)}
            <td className="num"><b>{t3(total)}</b></td><td colSpan={(drvCols ? 2 : 0) + 2 + (threepl.length > 0 ? 1 : 0)} /></tr>
        </thead>
        <tbody>{loads.map((l, i) => {
          const tot = rowKg(l); const overCap = n(l.cap) && tot > n(l.cap) * 1000 + 1;
          return (
            <tr key={i}><td>{i + 1}</td>
              <td><WithAdd cat="vehicles" preset={{ plate: l.plate }} onAdded={(id, r) => pickPlate(i, r?.plate || id)}><input list="dl-sp-plate" value={l.plate} onChange={(e) => pickPlate(i, e.target.value)} /></WithAdd>{l.vehicleType ? <div className="small">{l.vehicleType}</div> : null}</td>
              <td><input type="number" step="0.5" value={l.cap} onChange={(e) => setLoad(i, { cap: e.target.value })} style={{ width: 70 }} /></td>
              {rows.map((r) => <td key={r.key}><input type="number" step="0.001" value={n(l.q[r.key]) ? n(l.q[r.key]) / 1000 : ''} placeholder="0" onChange={(e) => setQ(i, r.key, e.target.value)} /></td>)}
              <td className="num"><b style={{ color: overCap ? 'var(--red)' : undefined }}>{t3(tot)}</b>{overCap ? <div className="small" style={{ color: 'var(--red)' }}>vượt tải</div> : null}</td>
              {drvCols && <><td><WithAdd cat="drivers" preset={{ idCard: l.idCard, name: l.driverName }} onAdded={(id, r) => { pickDriver(i, r?.idCard || id); if (r?.name) setLoad(i, { driverName: r.name }); }}><input list="dl-sp-driver" value={l.idCard} onChange={(e) => pickDriver(i, e.target.value)} /></WithAdd></td>
              <td><input value={l.driverName} onChange={(e) => setLoad(i, { driverName: e.target.value })} /></td></>}
              <td><input value={l.driverPhone} onChange={(e) => setLoad(i, { driverPhone: e.target.value })} style={{ width: 110 }} /></td>
              {threepl.length > 0 && <td><Select value={l.threepl} onChange={(e) => setLoad(i, { threepl: e.target.value })}><option value="">-- Xe GHA --</option>{threepl.map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}</option>)}</Select></td>}
              <td><button type="button" className="btn ghost sm" disabled={loads.length === 1} onClick={() => setLoads((ls) => ls.filter((_, j) => j !== i))}>✕</button></td></tr>
          );
        })}</tbody>
        <tfoot><tr><td colSpan={3} className="small"><b>Đã xếp</b></td>
          {rows.map((r) => { const d = colKg(r) - n(need[r.key]); return <td key={r.key} className="num"><b>{t3(colKg(r))}</b>{Math.abs(d) > 1 ? <div className="small" style={{ color: 'var(--red)' }}>{d > 0 ? 'thừa' : 'thiếu'} {t3(Math.abs(d))}</div> : <div className="small" style={{ color: 'var(--green)' }}>✓</div>}</td>; })}
          <td className="num"><b>{t3(sumLoads)}</b></td><td colSpan={(drvCols ? 2 : 0) + 2 + (threepl.length > 0 ? 1 : 0)} /></tr></tfoot>
      </table></div>
      <datalist id="dl-sp-plate">{vehicles.map((v) => <option key={v.plate} value={v.plate}>{v.vehicleType} {v.payload ? `${v.payload} tấn` : ''}</option>)}</datalist>
      <datalist id="dl-sp-driver">{drivers.map((d) => <option key={d.idCard} value={d.idCard}>{d.name}</option>)}</datalist>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={() => onClose(false)}>Thôi</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang tạo…' : `Tạo ${loads.filter((l) => rowKg(l) > 0).length} chuyến`}</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Danh sách chuyến: tiến độ tài xế, làm thay bước, ảnh phiếu, chi phí
function TripList({ trips, priv }) {
  const { isAdmin, role, hasRole, can3PL, email, name } = useApp();
  const isCarrier = role === 'van_tai';
  const isTpl = role === 'tpl';
  const carriers = useCollection('carriers').rows;
  const [f, setF] = useState({ from: monthStart(), to: '', status: 'active', carrier: '', q: '' });
  const [step, setStep] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [cost, setCost] = useState(null);
  const [cost3, setCost3] = useState(null);
  const [cut, setCut] = useState(null);
  const [err, setErr] = useState('');
  const carOf = (t) => carriers.find((c) => c.code === t.carrier) || { code: t.carrier, kind: t.carrierKind };
  const list = trips.filter((t) => (!f.from || (t.plannedDate || '') >= f.from || ['planned'].includes(t.status)) && (!f.to || (t.plannedDate || '') <= f.to)
    && (f.status === '' || (f.status === 'active' ? !['completed', 'cancelled'].includes(t.status) : t.status === f.status))
    && (!f.carrier || t.carrier === f.carrier)
    && (!f.q || [t.id, t.plate, t.driverName, t.idCard, t.warehouse, priv[t.id]?.threeplName, ...(t.lines || []).flatMap((l) => [l.orderId, l.partyName, l.item, l.shipCode])].join(' ').toLowerCase().includes(f.q.toLowerCase())));
  const setFF = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const cancel = async (t) => {
    const reason = window.prompt(`Hủy chuyến ${t.id}? Lý do:`, ''); if (!reason) return;
    try { await updateDoc(doc(db, 'trips', t.id), { status: 'cancelled', cancelReason: reason, cancelTime: nowISO(), updatedAt: nowISO(), updatedBy: email,
      history: [...(t.history || []), { at: nowISO(), by: email, byName: name, action: `Hủy chuyến: ${reason}`, status: 'cancelled' }] }); } catch (e) { setErr(e.message); }
  };

  const statusText = (t) => (t.selfPickup && t.status === 'completed' ? 'Khách đã lấy xong' : STATUS_META[t.status]?.label);
  // Đơn vị vận tải / 3PL làm trên điện thoại: mặc định xem dạng thẻ; quản trị mặc định dạng bảng
  const [view, setView] = usePref('trips-view', isCarrier || isTpl ? 'card' : 'table');
  const companies = useCollection('companies').rows;
  const warehouses = useCollection('warehouses').rows;
  const shiptoRows = useCollection(isAdmin || isCarrier ? 'shipto' : '').rows;
  // Chuyến cũ chưa có địa chỉ / người nhận / định vị điểm giao: bổ sung từ danh mục để tài xế mở link thấy được
  const filled = useRef(new Set());
  useEffect(() => {
    if (!(isAdmin || isCarrier) || !shiptoRows.length || !warehouses.length) return;
    trips.filter((t) => !['completed', 'cancelled'].includes(t.status) && !filled.current.has(t.id)).forEach((t) => {
      filled.current.add(t.id);
      const lines = t.lines.map((l) => enrichLine(l, shiptoRows, warehouses));
      const w = warehouses.find((x) => x.code === t.warehouse) || {};
      const upd = {
        ...(JSON.stringify(lines) !== JSON.stringify(t.lines) ? { lines } : {}),
        ...(isAdmin && !t.warehouseAddress && (w.address || w.mapLink) ? { warehouseAddress: w.address || '', warehouseMap: w.mapLink || '' } : {}),
      };
      if (Object.keys(upd).length) updateDoc(doc(db, 'trips', t.id), upd).catch(() => {});
    });
  }, [trips, shiptoRows, warehouses, isAdmin, isCarrier]);
  const companyName = (code) => { const x = companies.find((c) => c.code === code); return x ? `${code} – ${x.name}` : code; };
  // Nút thao tác của 1 chuyến (dùng chung cho bảng và thẻ)
  const info = (t) => {
    const st = nextStep(t); const blocked = st && stepBlocked(t, st);
    const c = carOf(t); const p3 = priv[t.id];
    const canStep = isAdmin || (isCarrier && t.carrier) || isTpl;
    const open = !['completed', 'cancelled'].includes(t.status);
    return { st, blocked, c, p3, canStep, open };
  };
  const actions = (t, big) => {
    const { st, blocked, c, p3, canStep } = info(t);
    const sz = big ? '' : ' sm';
    return <>
      {canStep && st && !blocked && <button className={'btn primary' + sz} style={big ? { width: '100%', padding: 10, fontSize: 15 } : undefined} onClick={() => setStep({ t, st })}>{st === 'reg' && can3PL && isGHA(c) && !p3?.threepl ? 'Đăng ký xe / chọn 3PL' : STEPS[st]}</button>}{big ? null : ' '}
      <span className={big ? 'trip-card-more' : ''}>
        {canStep && st && st !== 'reg' && t.status === 'planned' && <button className="btn sm" onClick={() => setStep({ t, st: 'reg' })}>Sửa xe</button>}{' '}
        {(isAdmin || isCarrier) && t.status === 'planned' && t.lines.length > 0 && <button className="btn sm" title="Hàng nhiều hơn 1 xe: tách bớt sang chuyến mới" onClick={() => setCut(t)}>✂ Tách</button>}{' '}
        {(t.photoCount > 0 || t.status === 'completed') && <button className="btn sm" onClick={() => setPhoto(t)}>📷 Ảnh</button>}{' '}
        {!isTpl && (isAdmin || isCarrier || hasRole('ke_toan')) && t.status === 'completed' && <button className="btn sm" onClick={() => setCost(t)}>💰 Chi phí</button>}{' '}
        {(isTpl || can3PL) && p3?.threepl && t.status === 'completed' && <button className="btn sm" onClick={() => setCost3(t)}>💰 Cước 3PL</button>}{' '}
        {(isAdmin || isCarrier) && t.status === 'planned' && <button className="btn ghost sm" onClick={() => cancel(t)}>Hủy</button>}
      </span>
    </>;
  };
  const mapUrl = (a) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
  // Thẻ chuyến (đơn vị vận tải, 3PL làm trên điện thoại)
  const card = (t) => {
    const { st, blocked, c, p3, open } = info(t);
    const dests = [...new Map(t.lines.map((l) => [`${l.partyCode}|${l.shipCode}`, l])).values()];
    return (
      <div key={t.id} className="card trip-card" style={{ opacity: t.status === 'cancelled' ? 0.5 : 1 }}>
        <div className="trip-card-head"><b className="mono">{t.id}</b><span>{fmtDate(t.plannedDate)}</span></div>
        <div><span className={'badge ' + (STATUS_META[t.status]?.tone || '')}>{statusText(t)}</span>{t.selfPickup ? <span className="badge" style={{ marginLeft: 4 }}>khách tự lấy</span> : null}</div>
        <div>Đơn hàng: <b>{(t.orderIds || []).join(', ')}</b></div>
        {t.company && <div>Công ty xuất hàng: <b>{companyName(t.company)}</b></div>}
        {t.pickup && <div>Điểm nhận hàng: <b>{t.pickupName || t.pickup}</b>{t.pickupAddress ? <div className="small">{t.pickupAddress}</div> : null}</div>}
        <div>{t.pickup ? 'Kho' : 'Nơi nhận hàng'}: <b>{whText(t.warehouse, warehouses) || t.warehouseName}</b>
          {whOf(t.warehouse, warehouses)?.address && <div className="small">{whOf(t.warehouse, warehouses).address} · <a href={mapUrl(whOf(t.warehouse, warehouses).address)} target="_blank" rel="noreferrer">📍 Bản đồ</a></div>}</div>
        {dests.map((l) => { const pl = placeOf(l, warehouses); return <div key={`${l.partyCode}${l.shipCode}`}>
          <div>{pl.sto ? 'Chuyển kho, giao đến' : 'Khách hàng (nơi giao)'}: <b>{pl.name}</b></div>
          {l.shipCode && <div className="small">Mã giao hàng: <b>{l.shipCode}</b></div>}
          {pl.address && <div>Địa chỉ giao hàng: {pl.address}</div>}
          {(l.contact || l.contactPhone) && <div className="small">Người nhận: {l.contact}{l.contactPhone ? <> · <a href={`tel:${l.contactPhone}`}>📞 {l.contactPhone}</a></> : null}</div>}
          {navUrl({ mapLink: l.mapLink, address: pl.address }) && <div><a href={navUrl({ mapLink: l.mapLink, address: pl.address })} target="_blank" rel="noreferrer">📍 Chỉ đường đến điểm giao{l.mapLink ? ' (đã ghim)' : ''}</a></div>}
        </div>; })}
        <ul className="trip-card-items">{t.lines.map((l) => <li key={l.id}>{l.item}{l.itemName ? ` ${l.itemName}` : ''} — <b>{fmtNum(n(l.plannedKg))} kg</b></li>)}</ul>
        <div>Xe: {t.plate ? <b>{t.plate}</b> : <span className="small">{isInternal(c) ? 'chờ tài xế nhóm nhận' : 'chưa có xe'}</span>}{t.driverName ? ` · ${t.driverName}` : ''}{t.driverPhone ? <> · <a href={`tel:${t.driverPhone}`}>{t.driverPhone}</a></> : null}</div>
        {can3PL && isGHA(c) && <div>Xe: <b>{p3?.threepl ? `3PL ${p3.threeplName || p3.threepl}` : 'Xe nhà GHA'}</b></div>}
        {[['driverArrivedAt', 'Đến điểm nhận'], ['driverLoadedAt', 'Lấy hàng xong'], ['driverAtDestAt', 'Đến điểm giao'], ['driverDeliveredAt', 'Hoàn thành']].some(([k]) => t[k]) &&
          <div className="small">{[['driverArrivedAt', 'Đến điểm nhận'], ['driverLoadedAt', 'Lấy hàng xong'], ['driverAtDestAt', 'Đến điểm giao'], ['driverDeliveredAt', 'Hoàn thành']].filter(([k]) => t[k]).map(([k, l]) => `${l} ${fmtTime(t[k])}`).join(' · ')}</div>}
        {st && blocked && <div className="small">⏳ {blocked}</div>}
        <div className="trip-card-acts">{actions(t, true)}</div>
      </div>
    );
  };
  return (
    <div>
      <div className="filters">
        <label>Từ <input type="date" value={f.from} onChange={(e) => setFF('from', e.target.value)} /></label>
        <label>Đến <input type="date" value={f.to} onChange={(e) => setFF('to', e.target.value)} /></label>
        <Select value={f.status} onChange={(e) => setFF('status', e.target.value)}><option value="active">Đang chạy</option><option value="">Tất cả</option>
          {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</Select>
        {!isCarrier && !isTpl && <Select value={f.carrier} onChange={(e) => setFF('carrier', e.target.value)}><option value="">Mọi đơn vị vận tải</option>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</Select>}
        <input type="search" placeholder="Tìm chuyến, xe, tài xế, đơn, khách…" value={f.q} onChange={(e) => setFF('q', e.target.value)} />
        <span className="seg"><button type="button" className={'btn sm' + (view === 'card' ? ' primary' : '')} onClick={() => setView('card')}>▦ Thẻ</button><button type="button" className={'btn sm' + (view === 'table' ? ' primary' : '')} onClick={() => setView('table')}>☰ Bảng</button></span>
        {(isAdmin || isCarrier || isTpl) && <DriverLinkBox compact />}
      </div>
      {isTpl && <p className="hint">Chuyến GHA đã chỉ định cho bạn: bấm <b>Nhập số xe</b> để ghi xe, tài xế; tài xế (hoặc bạn) bấm lần lượt Đến điểm nhận hàng → Nhận / lấy hàng xong → Đến điểm giao hàng → Hoàn thành; xong thì <b>💰 Cước 3PL</b> nhập cước với GHA.</p>}
      <ErrorBox error={err} />
      {!list.length ? <Empty text="Không có chuyến nào." /> : view === 'card' ? <div className="trip-cards">{list.map(card)}</div> : (
      <div className="table-wrap">
          <table>
            <thead><tr><th>Chuyến</th><th>Ngày đi</th><th>Kho</th><th>Xe · tài xế</th>{!isCarrier && !isTpl && <th>Vận tải</th>}{can3PL && <th>3PL</th>}<th>Giao đến · hàng</th><th className="num">Tấn</th><th>Tiến độ</th>{!isTpl && <th>Chi phí</th>}{(can3PL || isTpl) && <th>Cước 3PL</th>}<th></th></tr></thead>
            <tbody>{list.map((t) => {
              const { st, blocked, c, p3, open } = info(t);
              return (
                <tr key={t.id} style={{ opacity: t.status === 'cancelled' ? 0.5 : 1 }}>
                  <td className="mono">{t.id}{t.selfPickup ? <div className="small">khách tự lấy</div> : null}</td><td className="nowrap">{fmtDate(t.plannedDate)}</td><td>{t.warehouse}{t.pickup ? <div className="small">⚓ {t.pickupName || t.pickup}</div> : null}</td>
                  <td>{t.plate ? <b>{t.plate}</b> : <span className="small">{isInternal(c) ? 'chờ tài xế nhóm nhận' : 'chưa có xe'}</span>}{t.driverName ? <div className="small">{t.driverName}{t.driverPhone ? ` · ${t.driverPhone}` : ''}</div> : null}</td>
                  {!isCarrier && !isTpl && <td>{t.carrierName || t.carrier}<div className="small">{kindText(c)}</div></td>}
                  {can3PL && <td>{isGHA(c) ? (p3?.threeplName || p3?.threepl || 'Xe nhà GHA') : ''}</td>}
                  <td className="small">{[...new Set(t.lines.map((l) => { const pl = placeOf(l, warehouses); return pl.sto ? pl.name : pl.short; }))].join(', ')}<div>{t.lines.map((l) => `${l.orderId} ${l.item}`).join('; ')}</div></td>
                  <td className="num">{t3(tripKg(t))}</td>
                  <td><span className={'badge ' + (STATUS_META[t.status]?.tone || '')}>{statusText(t)}</span>
                    <div className="small">{[['driverArrivedAt', 'đến kho'], ['driverLoadedAt', 'lấy xong'], ['driverAtDestAt', 'đến điểm giao'], ['driverDeliveredAt', 'giao xong']].filter(([k]) => t[k]).map(([k, l]) => `${l} ${fmtTime(t[k])}`).join(' · ')}</div>
                    {st && <div className="small">Tiếp: <b>{STEPS[st]}</b>{blocked ? ` (${blocked})` : ''}</div>}</td>
                  {!isTpl && <td>{t.costs ? <><b>{vnd(costTotal(t.costs))}</b><div className="small">{COST[t.costStatus || '']?.[0]}</div></> : <span className="small">{t.status === 'completed' ? 'chưa nhập' : ''}</span>}</td>}
                  {(can3PL || isTpl) && <td>{p3?.threepl ? (p3.cost3pl ? <><b>{vnd(costTotal(p3.cost3pl))}</b><div className="small">{COST3[p3.cost3plStatus || '']?.[0]}</div></> : <span className="small">{t.status === 'completed' ? 'chưa nhập' : ''}</span>) : ''}</td>}
                  <td className="nowrap">{actions(t, false)}</td>
                </tr>
              );
            })}</tbody>
          </table>
      </div>
      )}
      {step && <StepModal t={step.t} step={step.st} threepl={priv[step.t.id]?.threepl || ''} onClose={() => setStep(null)} />}
      {photo && <PhotoModal t={photo} onClose={() => setPhoto(null)} />}
      {cost && <CostModal t={trips.find((x) => x.id === cost.id) || cost} onClose={() => setCost(null)} />}
      {cost3 && <Cost3plModal t={cost3} p={priv[cost3.id] || {}} onClose={() => setCost3(null)} />}
      {cut && <CutModal t={cut} p3={priv[cut.id]} onClose={() => setCut(null)} />}
    </div>
  );
}

// Tách bớt hàng của 1 chuyến sang chuyến mới (hàng nhiều hơn 1 xe)
function CutModal({ t, p3, onClose }) {
  const { email, name, can3PL } = useApp();
  const [q, setQ] = useState(() => Object.fromEntries(t.lines.map((l) => [l.id, ''])));
  const [plate, setPlate] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr('');
    const moved = t.lines.map((l) => ({ l, kg: Math.round(n(q[l.id]) * 1000) })).filter((x) => x.kg > 0);
    if (!moved.length) return setErr('Nhập số tấn chuyển sang chuyến mới.');
    const over = moved.find((x) => x.kg > n(x.l.plannedKg) + 1);
    if (over) return setErr(`${over.l.item}: chuyến chỉ có ${t3(over.l.plannedKg)} tấn.`);
    setBusy(true);
    try {
      const [id] = await createPlannedTrips({ wh: { code: t.warehouse, name: t.warehouseName, hasGuard: t.hasGuard }, carrier: { code: t.carrier, name: t.carrierName, kind: t.carrierKind || '' },
        trips: [{ date: t.plannedDate, plate, company: t.company || '', note: t.note || '', lines: moved.map(({ l, kg }) => ({ ...l, no: l.orderLine, kg })) }] }, { email, name }, `Tách từ chuyến ${t.id}`);
      const left = t.lines.map((l) => { const m = moved.find((x) => x.l.id === l.id); const kg = n(l.plannedKg) - (m?.kg || 0); return { ...l, plannedKg: kg, payload: Math.round(kg) / 1000 }; }).filter((l) => l.plannedKg > 0.5);
      await updateDoc(doc(db, 'trips', t.id), { lines: left, updatedAt: nowISO(), updatedBy: email,
        history: [...(t.history || []), { at: nowISO(), by: email, byName: name, action: `Tách ${t3(moved.reduce((s, x) => s + x.kg, 0))} tấn sang chuyến ${id}` }] });
      if (can3PL && p3?.threepl) await setDoc(doc(db, 'tripPrivate', id), { tripId: id, carrier: t.carrier, threepl: p3.threepl, threeplName: p3.threeplName || '', by: email, at: nowISO() });
      onClose();
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền tách chuyến.' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`✂ Tách chuyến ${t.id}`} onClose={onClose}>
      <p className="small">Nhập số tấn chuyển sang 1 chuyến mới (cùng kho, cùng ngày). Chuyến {t.id} giữ phần còn lại.</p>
      <table><thead><tr><th>Hàng</th><th className="num">Trên chuyến (tấn)</th><th className="num">Chuyển sang chuyến mới (tấn)</th></tr></thead>
        <tbody>{t.lines.map((l) => <tr key={l.id}><td>{l.orderId} · {l.item}<div className="small">{l.partyName}</div></td><td className="num">{t3(l.plannedKg)}</td>
          <td className="num"><input type="number" step="0.001" value={q[l.id]} onChange={(e) => setQ((m) => ({ ...m, [l.id]: e.target.value }))} style={{ width: 100 }} /></td></tr>)}</tbody></table>
      <label className="field" style={{ marginTop: 8 }}><span>Số xe chuyến mới (nếu biết)</span><input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></label>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={onClose}>Thôi</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang tách…' : 'Tách chuyến'}</button></div>
    </Modal>
  );
}

// Cước 3PL ↔ GHA (lưu riêng trong tripPrivate): 3PL nhập, GHA sửa / chốt
function Cost3plModal({ t, p, onClose }) {
  const { email, name, can3PL, role } = useApp();
  const c = p.cost3pl || {};
  const [f, setF] = useState({ freight: c.freight ?? '', chiHo: c.chiHo ?? '', bocXep: c.bocXep ?? '', other: c.other ?? '', note: c.note || '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const approved = p.cost3plStatus === 'approved';
  const canEdit = !approved && (can3PL || role === 'tpl');
  const costs = { freight: n(f.freight), chiHo: n(f.chiHo), bocXep: n(f.bocXep), other: n(f.other), note: f.note.trim() };
  const write = async (upd) => {
    setErr(''); setBusy(true);
    try { await updateDoc(doc(db, 'tripPrivate', t.id), { ...upd, updatedAt: nowISO(), updatedBy: email, updatedByName: name }); onClose(); }
    catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền.' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`Cước 3PL · chuyến ${t.id}`} onClose={onClose}>
      <p className="small">{p.threeplName || p.threepl} · {t.plate} · {t3(tripKg(t))} tấn · {COST3[p.cost3plStatus || '']?.[0]}. Cước này chỉ GHA và 3PL thấy.</p>
      <div className="form-grid">
        {[['freight', 'Cước vận chuyển (đ)'], ['chiHo', 'Phí chi hộ (đ)'], ['bocXep', 'Phí bốc xếp (đ)'], ['other', 'Phí khác (đ)']].map(([k, l]) => (
          <label key={k} className="field"><span>{l}</span><input type="number" value={f[k]} disabled={!canEdit} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} /></label>))}
        <label className="field full"><span>Ghi chú</span><input value={f.note} disabled={!canEdit} onChange={(e) => setF((x) => ({ ...x, note: e.target.value }))} /></label>
      </div>
      <p>Tổng: <b>{vnd(costTotal(costs))} đ</b></p>
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={onClose}>Đóng</button>
        {canEdit && <button className="btn primary" disabled={busy} onClick={() => write({ cost3pl: costs, cost3plStatus: 'entered', cost3plBy: email, cost3plAt: nowISO() })}>Lưu cước 3PL</button>}
        {can3PL && p.cost3pl && !approved && <button className="btn primary" disabled={busy} onClick={() => write({ cost3plStatus: 'approved', cost3plApprovedBy: email, cost3plApprovedAt: nowISO() })}>✓ GHA chốt</button>}
      </div>
    </Modal>
  );
}

// Điều phối nhập cước, % hỗ trợ dầu, phụ thu, các phí, số HĐ; kế toán chốt. Chọn đúng điểm nhận (cảng…) để ra đúng giá
const pickupOf = (t) => t.pickupName || t.warehouseName || t.warehouse || '';
const destOf = (t, whs) => [...new Set((t.lines || []).map((l) => { const pl = placeOf(l, whs); return pl.sto ? pl.name : `${l.shipCode ? `${l.shipCode} · ` : ''}${l.partyName || l.partyCode}`; }))].join('; ');
function CostModal({ t, onClose }) {
  const { email, name, role, hasRole, isAdmin } = useApp();
  const rates = useCollection('freightRates').rows;
  const points = useCollection('pickupPoints').rows;
  const fields = useCostFields();
  const c = t.costs || {};
  const [pickup, setPickup] = useState(t.pickup || '');
  const sug = suggestFreight({ ...t, pickup }, rates);
  const [f, setF] = useState(() => ({ ...Object.fromEntries(fields.map((x) => [x.key, c[x.key] ?? ''])), freight: c.freight ?? sug?.amount ?? '', invoiceNo: c.invoiceNo || '', invoiceDate: c.invoiceDate || '', note: c.note || '' }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const approved = t.costStatus === 'approved';
  // Điều phối vận tải hoặc kế toán nhập cước (xe nội bộ: người tính cước cập nhật sau)
  const canEdit = !approved && (isAdmin || role === 'van_tai' || hasRole('ke_toan'));
  const canApprove = hasRole('ke_toan') && t.costs && !approved;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  // Bảng giá tải xong sau khi mở / đổi điểm nhận: điền cước gợi ý nếu chưa nhập
  useEffect(() => { if (sug && c.freight == null) setF((x) => ({ ...x, freight: sug.amount })); }, [sug?.amount]); // eslint-disable-line react-hooks/exhaustive-deps
  const write = async (upd, action) => {
    setErr(''); setBusy(true);
    try { await updateDoc(doc(db, 'trips', t.id), { ...upd, updatedAt: nowISO(), updatedBy: email, history: [...(t.history || []), { at: nowISO(), by: email, byName: name, action }] }); onClose(); }
    catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền (dán lại firestore.rules mới).' : e.message); }
    setBusy(false);
  };
  const vals = Object.fromEntries(fields.map((x) => [x.key, n(f[x.key])]));
  const sumc = calcCosts(vals, fields);
  const costs = { ...vals, ...sumc, invoiceNo: f.invoiceNo.trim(), invoiceDate: f.invoiceDate, note: f.note.trim(), rate: sug?.rate || '' };
  const pt = points.find((x) => x.code === pickup);
  const pickUpd = pickup !== (t.pickup || '') ? { pickup, pickupName: pt?.name || '', pickupAddress: pt?.address || '', pickupMap: pt?.mapLink || '' } : {};
  const input = (x) => (
    <label key={x.key} className="field"><span>{x.label}{x.group === 'pct' ? ' (%)' : ' (đ)'}</span>
      <input type="number" value={f[x.key]} disabled={!canEdit} onChange={(e) => set(x.key, e.target.value)} placeholder={x.group === 'pct' ? 'VD 5 = cộng 5% cước' : ''} /></label>);
  return (
    <Modal title={`Chi phí chuyến ${t.id}`} onClose={onClose} wide>
      <p className="small">{t.company ? `${t.company} · ` : ''}{fmtDate(t.plannedDate)} · {t.carrierName} · {t.plate} · {t3(tripKg(t))} tấn · {COST[t.costStatus || '']?.[0]}</p>
      <div className="form-grid">
        <label className="field"><span>Điểm nhận hàng</span><WithAdd cat="pickupPoints" onAdded={(id) => setPickup(id)}>
          <Select value={pickup} disabled={!canEdit} onChange={(e) => setPickup(e.target.value)}><option value="">{t.warehouseName || t.warehouse} (kho xuất)</option>
            {points.filter((x) => x.active !== false || x.code === pickup).map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}</option>)}</Select></WithAdd></label>
        <div className="field full"><span>Điểm giao</span><b>{destOf(t, [])}</b></div>
      </div>
      <p className="small" style={{ margin: '6px 0' }}>{sug ? <>Bảng giá <b>{sug.rate}</b>: {sug.basis === 'Theo chuyến' ? 'theo chuyến' : `${vnd(sug.price)} đ/tấn`} = <b>{vnd(sug.amount)} đ</b></> : 'Chưa có giá khớp trong bảng giá cước (thêm giá theo điểm nhận → điểm giao ở Bảng giá cước).'}</p>
      <div className="section-head">Cước vận chuyển</div>
      <div className="form-grid">{fields.filter((x) => ['base', 'pct', 'surcharge'].includes(x.group)).map(input)}</div>
      <p style={{ margin: '4px 0 10px' }}>Tổng cước vận chuyển = {vnd(vals.freight)} + hỗ trợ dầu {vnd(sumc.fuel)} + phụ thu {vnd(sumc.surcharge)} = <b>{vnd(sumc.freightTotal)} đ</b></p>
      <div className="section-head">Phí khác</div>
      <div className="form-grid">{fields.filter((x) => x.group === 'fee').map(input)}
        <label className="field"><span>Số hóa đơn</span><input value={f.invoiceNo} disabled={!canEdit} onChange={(e) => set('invoiceNo', e.target.value)} /></label>
        <label className="field"><span>Ngày hóa đơn</span><input type="date" value={f.invoiceDate} disabled={!canEdit} onChange={(e) => set('invoiceDate', e.target.value)} /></label>
        <label className="field full"><span>Ghi chú</span><input value={f.note} disabled={!canEdit} onChange={(e) => set('note', e.target.value)} /></label>
      </div>
      <p>Tổng chi phí = tổng cước {vnd(sumc.freightTotal)} + phí khác {vnd(sumc.fees)} = <b>{vnd(sumc.total)} đ</b></p>
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={onClose}>Đóng</button>
        {canEdit && <button className="btn primary" disabled={busy} onClick={() => write({ costs, costStatus: 'entered', costBy: email, costAt: nowISO(), ...pickUpd }, `Nhập chi phí ${vnd(sumc.total)} đ`)}>Lưu chi phí</button>}
        {canApprove && <button className="btn primary" disabled={busy} onClick={() => write({ costStatus: 'approved', costApprovedBy: email, costApprovedAt: nowISO() }, `Kế toán chốt chi phí ${vnd(costTotal(t.costs))} đ`)}>✓ Chốt chi phí</button>}
      </div>
    </Modal>
  );
}

// Quản trị thêm trường chi phí (VD Phí vệ sinh cont, Phí lưu bãi): nhóm Phụ thu cộng vào tổng cước, nhóm Phí cộng ngoài
function CostFieldsModal({ onClose }) {
  const { email } = useApp();
  const [extra, setExtra] = useState(null);
  const [f, setF] = useState({ label: '', group: 'fee' });
  const [err, setErr] = useState('');
  useEffect(() => onSnapshot(doc(db, 'settings', 'tripCostFields'), (s) => setExtra(s.exists() ? s.data().extra || [] : [])), []);
  const save = async (list) => {
    setErr('');
    try { await setDoc(doc(db, 'settings', 'tripCostFields'), { extra: list, updatedAt: nowISO(), updatedBy: email }); } catch (e) { setErr(e.message); }
  };
  const add = () => { if (!f.label.trim()) return; save([...(extra || []), { key: `x${Date.now().toString(36)}`, label: f.label.trim(), group: f.group }]); setF({ label: '', group: f.group }); };
  return (
    <Modal title="Trường chi phí chuyến xe" onClose={onClose}>
      <p className="small">Trường gốc: {BASE_COST_FIELDS.map((x) => x.label).join(', ')}. Thêm trường mới bên dưới; trường thêm hiện ở màn hình nhập chi phí, báo cáo và Excel.</p>
      <div className="filters"><input placeholder="Tên trường, VD Phí lưu bãi" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} style={{ flex: 1 }} />
        <Select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>{Object.entries(COST_GROUPS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <button type="button" className="btn primary" onClick={add}>+ Thêm</button></div>
      <ErrorBox error={err} />
      {(extra || []).map((x, i) => <div key={x.key} className="filters"><input value={x.label} onChange={(e) => setExtra((l) => l.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} onBlur={() => save(extra)} style={{ flex: 1 }} />
        <span className="small">{COST_GROUPS[x.group]}</span>
        <button type="button" className="btn ghost sm" onClick={() => window.confirm(`Bỏ trường "${x.label}"? Số đã nhập vẫn giữ trong chuyến.`) && save(extra.filter((_, j) => j !== i))}>✕</button></div>)}
      <div className="form-actions"><button className="btn" onClick={onClose}>Đóng</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Chi phí & cước: tổng theo đơn vị vận tải + bảng chi tiết từng chuyến (đủ cột cước, phụ thu, phí; Excel)
function Costs({ trips, priv }) {
  const { role, can3PL, isAdmin } = useApp();
  const isCarrier = role === 'van_tai';
  const rates = useCollection('freightRates').rows;
  const warehouses = useCollection('warehouses').rows;
  const companies = useCollection('companies').rows;
  const fields = useCostFields();
  const [f, setF] = useState({ from: monthStart(), to: '', company: '', carrier: '', status: '' });
  const [cost, setCost] = useState(null);
  const [cfg, setCfg] = useState(false);
  const done = trips.filter((t) => t.status === 'completed' && (!f.from || (t.plannedDate || '') >= f.from) && (!f.to || (t.plannedDate || '') <= f.to)
    && (!f.company || t.company === f.company) && (!f.carrier || t.carrier === f.carrier)
    && (!f.status || (f.status === 'missing' ? !t.costs : (t.costStatus || '') === f.status)));
  const g = new Map();
  for (const t of done) {
    const k = t.carrier || '';
    const x = g.get(k) || { carrier: k, name: t.carrierName || '', trips: 0, kg: 0, freightTotal: 0, fees: 0, total: 0, missing: 0, approved: 0 };
    const c = t.costs || {};
    x.trips += 1; x.kg += tripKg(t); x.freightTotal += freightTotalOf(c); x.total += costTotal(c); x.fees += costTotal(c) - freightTotalOf(c);
    if (!t.costs) x.missing += 1; if (t.costStatus === 'approved') x.approved += 1;
    g.set(k, x);
  }
  const sum = [...g.values()];
  const pre = fields.filter((x) => ['pct', 'base', 'surcharge'].includes(x.group)).sort((a, b) => (a.group === 'pct' ? -1 : b.group === 'pct' ? 1 : 0));
  const fees = fields.filter((x) => x.group === 'fee');
  const row = (t) => {
    const c = t.costs || {};
    return {
      'Công ty': t.company || '', 'Ngày vận chuyển': t.plannedDate || '', 'Chuyến': t.id, 'Điểm nhận': pickupOf(t), 'Điểm giao': destOf(t, warehouses),
      'Đơn vị vận tải': t.carrierName || t.carrier, ...(can3PL ? { '3PL': priv[t.id]?.threeplName || '' } : {}), 'Số xe': t.plate || '', 'Số lượng (tấn)': +(tripKg(t) / 1000).toFixed(3),
      ...Object.fromEntries(pre.map((x) => [x.label, n(c[x.key])])), 'Tổng cước vận chuyển': freightTotalOf(c),
      ...Object.fromEntries(fees.map((x) => [x.label, n(c[x.key])])), 'Tổng chi phí': costTotal(c),
      'Cước theo bảng giá': suggestFreight(t, rates)?.amount ?? '', 'Số HĐ': c.invoiceNo || '', 'Ngày HĐ': c.invoiceDate || '', 'Ghi chú': c.note || '', 'Trạng thái': t.costs ? COST[t.costStatus || '']?.[0] : 'Chưa nhập',
    };
  };
  const rows = done.map(row);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const numCol = (k) => typeof rows[0]?.[k] === 'number';
  const excel = () => exportSheets(`Chi_phi_van_chuyen_${f.from}_${f.to}`, {
    'Chi tiết chuyến': rows,
    'Tổng theo đơn vị': sum.map((x) => ({ 'Đơn vị vận tải': x.carrier, 'Tên': x.name, 'Số chuyến': x.trips, 'Số tấn': +(x.kg / 1000).toFixed(3), 'Tổng cước vận chuyển': x.freightTotal, 'Phí khác': x.fees, 'Tổng chi phí': x.total, 'Chuyến chưa nhập chi phí': x.missing, 'Chuyến kế toán đã chốt': x.approved })),
  });
  const carriers = [...new Map(trips.map((t) => [t.carrier, t.carrierName])).entries()];
  return (
    <div>
      <div className="filters">
        <label>Từ <input type="date" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} /></label>
        <label>Đến <input type="date" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} /></label>
        <Select value={f.company} onChange={(e) => setF((x) => ({ ...x, company: e.target.value }))}><option value="">Mọi công ty</option>{companies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select>
        {!isCarrier && <Select value={f.carrier} onChange={(e) => setF((x) => ({ ...x, carrier: e.target.value }))}><option value="">Mọi đơn vị vận tải</option>{carriers.map(([k, v]) => <option key={k} value={k}>{k} – {v}</option>)}</Select>}
        <Select value={f.status} onChange={(e) => setF((x) => ({ ...x, status: e.target.value }))}><option value="">Mọi trạng thái</option><option value="missing">Chưa nhập</option><option value="entered">Đã nhập, chờ chốt</option><option value="approved">Kế toán đã chốt</option></Select>
        <button className="btn" onClick={excel} disabled={!rows.length}>⬇ Excel</button>
        {isAdmin && <button className="btn ghost" onClick={() => setCfg(true)}>⚙ Trường chi phí</button>}
      </div>
      <p className="small">Chỉ tính chuyến đã giao xong. Tổng cước vận chuyển = Cước × (1 + % hỗ trợ dầu) + phụ thu vé + phụ thu hạ rỗng trái tuyến (+ phụ thu tự thêm). Tổng chi phí = Tổng cước + các phí khác. Bấm 💰 để nhập.</p>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        {!sum.length ? <Empty text="Chưa có chuyến giao xong trong khoảng này." /> : (
          <table>
            <thead><tr>{!isCarrier && <th>Đơn vị vận tải</th>}<th className="num">Chuyến</th><th className="num">Tấn</th><th className="num">Tổng cước vận chuyển</th><th className="num">Phí khác</th><th className="num">Tổng chi phí (đ)</th><th className="num">Chưa nhập</th><th className="num">Đã chốt</th></tr></thead>
            <tbody>{sum.map((x) => (
              <tr key={x.carrier}>{!isCarrier && <td><b>{x.carrier}</b> {x.name}</td>}<td className="num">{x.trips}</td><td className="num">{t3(x.kg)}</td><td className="num">{vnd(x.freightTotal)}</td><td className="num">{vnd(x.fees)}</td>
                <td className="num"><b>{vnd(x.total)}</b></td><td className="num">{x.missing || ''}</td><td className="num">{x.approved}</td></tr>))}</tbody>
          </table>
        )}
      </div>
      {rows.length > 0 && <div className="table-wrap"><table className="cost-detail">
        <thead><tr><th></th>{cols.map((k) => <th key={k} className={numCol(k) ? 'num' : ''}>{k}</th>)}</tr></thead>
        <tbody>{done.map((t, i) => <tr key={t.id}><td><button className="btn sm" onClick={() => setCost(t)}>💰</button></td>
          {cols.map((k) => <td key={k} className={numCol(k) ? 'num' : k === 'Điểm giao' ? 'small' : ''}>{numCol(k) ? (k === 'Số lượng (tấn)' ? t3(rows[i][k] * 1000) : (rows[i][k] ? (/%/.test(k) ? rows[i][k] : vnd(rows[i][k])) : '')) : rows[i][k]}</td>)}</tr>)}</tbody>
      </table></div>}
      {cost && <CostModal t={trips.find((x) => x.id === cost.id) || cost} onClose={() => setCost(null)} />}
      {cfg && <CostFieldsModal onClose={() => setCfg(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Điều phối tạo tài khoản cho tài xế của đơn vị mình (tài xế đăng nhập bằng email này)
function DriverAccounts() {
  const { isAdmin, myCarrier, email, can3PL } = useApp();
  const carriers = useCollection('carriers').rows;
  const threepl = useCollection(can3PL ? 'threepl' : '').rows;
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ email: '', name: '', idCard: '', phone: '', carrier: myCarrier, role: 'tai_xe', threepl: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => onSnapshot(query(collection(db, 'users'), where('role', 'in', can3PL ? ['tai_xe', 'tpl'] : ['tai_xe'])),
    (s) => setRows(s.docs.map((d) => d.data()).filter((u) => isAdmin || u.carrier === myCarrier)), (e) => setErr(e.message)), [isAdmin, myCarrier, can3PL]);
  const tpl = f.role === 'tpl';
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async (e) => {
    e.preventDefault(); setErr(''); setMsg('');
    const em = f.email.trim().toLowerCase();
    if (!em.includes('@') || !f.name.trim() || !f.carrier) return setErr('Nhập email, họ tên và đơn vị vận tải.');
    if (tpl && !f.threepl) return setErr('Chọn 3PL cho tài khoản 3PL.');
    const at = nowISO();
    try {
      await setDoc(doc(db, 'users', em), { email: em, name: f.name.trim(), role: tpl ? 'tpl' : 'tai_xe', ...(tpl ? { threepl: f.threepl } : {}), carrier: f.carrier, idCard: f.idCard.trim(), phone: f.phone.trim(), warehouses: [], active: true, updatedAt: at, updatedBy: email }, { merge: true });
      if (!tpl && f.idCard.trim()) await setDoc(doc(db, 'drivers', f.idCard.trim()), { idCard: f.idCard.trim(), name: f.name.trim(), phone: f.phone.trim(), carrier: f.carrier, loginEmail: em, updatedAt: at, updatedBy: email }, { merge: true });
      setMsg(`Đã tạo tài khoản ${em}. ${tpl ? '3PL' : 'Người này'} mở app, đăng nhập bằng Google hoặc tạo mật khẩu với email này.`);
      setF({ email: '', name: '', idCard: '', phone: '', carrier: myCarrier, role: f.role, threepl: '' });
    } catch (e2) { setErr(e2.code === 'permission-denied' ? 'Không có quyền tạo tài khoản (email này có thể đang là tài khoản vai trò khác).' : e2.message); }
  };
  const toggle = async (u) => {
    try { await updateDoc(doc(db, 'users', u.email), { active: u.active === false, updatedAt: nowISO(), updatedBy: email }); } catch (e) { setErr(e.message); }
  };
  return (
    <div>
      <DriverLinkBox />
      <form className="card" onSubmit={save} style={{ marginBottom: 12 }}>
        <div className="section-head">Thêm tài khoản {can3PL ? '3PL / ' : ''}điều phối có đăng nhập (không bắt buộc với tài xế: tài xế dùng link ở trên)</div>
        <div className="form-grid">
          {can3PL && <label className="field"><span>Loại tài khoản</span><Select value={f.role} onChange={(e) => set('role', e.target.value)}><option value="tai_xe">Tài xế</option><option value="tpl">3PL (thầu phụ GHA)</option></Select></label>}
          {tpl && <label className="field"><span>3PL *</span><Select value={f.threepl} onChange={(e) => set('threepl', e.target.value)}><option value="">--</option>{threepl.map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}</option>)}</Select></label>}
          <label className="field"><span>Email đăng nhập *</span><input value={f.email} onChange={(e) => set('email', e.target.value)} /></label>
          <label className="field"><span>Họ tên *</span><input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="field"><span>CCCD (không bắt buộc)</span><input value={f.idCard} onChange={(e) => set('idCard', e.target.value)} /></label>
          <label className="field"><span>Điện thoại</span><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
          {isAdmin && <label className="field"><span>Đơn vị vận tải *</span><WithAdd cat="carriers" onAdded={(id) => set('carrier', id)}><Select value={f.carrier} onChange={(e) => set('carrier', e.target.value)}><option value="">--</option>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</Select></WithAdd></label>}
        </div>
        {msg && <div className="ok-box">{msg}</div>}
        <ErrorBox error={err} />
        <div className="form-actions"><button className="btn primary">Lưu tài khoản</button></div>
      </form>
      <div className="table-wrap">
        {!rows.length ? <Empty text="Chưa có tài khoản tài xế." /> : (
          <table><thead><tr><th>Email</th><th>Họ tên</th><th>CCCD</th><th>Điện thoại</th>{isAdmin && <th>Đơn vị</th>}<th>Trạng thái</th><th></th></tr></thead>
            <tbody>{rows.map((u) => <tr key={u.email}><td>{u.email}{u.role === 'tpl' ? <div className="small">3PL {u.threepl}</div> : null}</td><td>{u.name}</td><td>{u.idCard}</td><td>{u.phone}</td>{isAdmin && <td>{u.carrier}</td>}
              <td>{u.active === false ? <span className="badge red">Đã khóa</span> : <span className="badge green">Hoạt động</span>}</td>
              <td><button className="btn sm" onClick={() => toggle(u)}>{u.active === false ? 'Mở khóa' : 'Khóa'}</button></td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}
