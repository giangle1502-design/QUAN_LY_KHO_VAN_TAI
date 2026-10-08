import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, doc, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { OPEN_STATUSES, leftKg, lineDue, lineShip, lineTo, lineWh } from '../../lib/orders';
import { STATUS_META, fmtTime, nowISO } from '../../lib/trips';
import { STEPS, costTotal, createPlannedTrips, nextStep, splitLoads, stepBlocked, suggestFreight, tripKg } from '../../lib/transport';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, today } from '../../lib/utils';
import { Empty, ErrorBox, Modal } from '../../components/ui';
import { PhotoModal, StepModal } from '../../components/TripSteps';

// Vận chuyển theo chuyến: đơn cần chia xe → chuyến xe (tài xế xác nhận từng bước) → chi phí & cước
const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
const t3 = (kg) => fmtNum(n(kg) / 1000, 3);
const vnd = (v) => (v == null || v === '' ? '' : fmtNum(n(v)));
const COST = { '': ['Chưa nhập chi phí', ''], entered: ['Đã nhập · chờ kế toán', 'amber'], auto: ['Nội bộ · tự tính', 'teal'], approved: ['Kế toán đã chốt', 'green'] };
const monthStart = () => today().slice(0, 8) + '01';

export default function Hauling() {
  const { role, isAdmin, hasRole, myCarrier, can3PL, isSuper } = useApp();
  const isCarrier = role === 'van_tai';
  const canPlan = isAdmin || isCarrier;
  const tabs = [...(canPlan ? [['don', 'Đơn cần chia xe']] : []), ['chuyen', 'Chuyến xe'], ['chi-phi', 'Chi phí & cước'], ...(canPlan ? [['tai-xe', 'Tài khoản tài xế']] : [])];
  const [sp, setSp] = useSearchParams();
  const tab = tabs.some(([k]) => k === sp.get('tab')) ? sp.get('tab') : tabs[0][0];
  const [orders, setOrders] = useState([]);
  const [trips, setTrips] = useState([]);
  const [priv, setPriv] = useState({});
  const [error, setError] = useState('');
  useEffect(() => onSnapshot(isCarrier ? query(collection(db, 'orders'), where('carriers', 'array-contains', myCarrier || '-')) : query(collection(db, 'orders'), where('status', 'in', OPEN_STATUSES)),
    (s) => setOrders(s.docs.map((d) => d.data())), (e) => setError(e.message)), [isCarrier, myCarrier]);
  useEffect(() => onSnapshot(isCarrier ? query(collection(db, 'trips'), where('carrier', '==', myCarrier || '-')) : query(collection(db, 'trips'), where('source', '==', 'plan')),
    (s) => setTrips(s.docs.map((d) => ({ ...d.data(), id: d.id })).filter((x) => x.source === 'plan').sort((a, b) => String(b.plannedDate + b.id).localeCompare(String(a.plannedDate + a.id)))),
    (e) => setError(e.message)), [isCarrier, myCarrier]);
  // 3PL lưu riêng, chỉ GHA và quản trị gốc đọc được
  useEffect(() => {
    if (!can3PL) { setPriv({}); return undefined; }
    return onSnapshot(isSuper ? collection(db, 'tripPrivate') : query(collection(db, 'tripPrivate'), where('carrier', '==', myCarrier)),
      (s) => setPriv(Object.fromEntries(s.docs.map((d) => [d.id, d.data()]))), () => setPriv({}));
  }, [can3PL, isSuper, myCarrier]);

  return (
    <div>
      <div className="page-head"><h1>🚛 Vận chuyển</h1>
        <div className="actions">{(isAdmin || hasRole('ke_toan')) && <Link className="btn" to="/dm/freightRates">💰 Bảng giá cước</Link>}</div></div>
      {isCarrier && !myCarrier && <div className="error-box">Tài khoản chưa gắn đơn vị vận tải. Báo quản trị vào Phân quyền chọn "Thuộc đơn vị vận tải".</div>}
      <div className="seg" style={{ marginBottom: 12 }}>
        {tabs.map(([k, l]) => <button key={k} type="button" className={'btn sm' + (tab === k ? ' primary' : '')} onClick={() => setSp({ tab: k })}>{l}</button>)}
      </div>
      <ErrorBox error={error} />
      {tab === 'don' && <ToPlan orders={orders} trips={trips} />}
      {tab === 'chuyen' && <TripList trips={trips} priv={priv} />}
      {tab === 'chi-phi' && <Costs trips={trips} priv={priv} />}
      {tab === 'tai-xe' && <DriverAccounts />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Đơn cần chia xe: dòng SO / STO đã giao cho đơn vị vận tải, còn số tấn chưa chia
function ToPlan({ orders, trips }) {
  const { isAdmin, myCarrier } = useApp();
  const carriers = useCollection('carriers').rows;
  const shipto = useCollection('shipto').rows;
  const [q, setQ] = useState('');
  const [sel, setSel] = useState({});
  const [split, setSplit] = useState(null);
  const planned = useMemo(() => {
    const m = new Map();
    for (const tr of trips) if (tr.status !== 'cancelled') for (const l of tr.lines || []) if (l.orderId) m.set(`${l.orderId}#${l.orderLine}`, (m.get(`${l.orderId}#${l.orderLine}`) || 0) + n(l.plannedKg));
    return m;
  }, [trips]);
  const rows = useMemo(() => orders.filter((o) => ['SO', 'STO'].includes(o.type) && OPEN_STATUSES.includes(o.status)).flatMap((o) => (o.lines || [])
    .filter((l) => l.carrier && (isAdmin || l.carrier === myCarrier))
    .map((l) => {
      const ship = o.type === 'SO' ? lineShip(o, l) : '';
      const st = shipto.find((s) => s.shipCode === ship);
      const done = n(planned.get(`${o.id}#${l.no}`));
      return { key: `${o.id}#${l.no}`, orderId: o.id, no: l.no, type: o.type, item: l.item, itemName: l.itemName, carrier: l.carrier, warehouse: lineWh(o, l, 'out'), due: lineDue(o, l),
        partyCode: o.type === 'STO' ? lineTo(o, l) : o.partyCode, partyName: o.type === 'STO' ? `Kho ${lineTo(o, l)}` : o.partyName, shipCode: ship, address: st?.address || '',
        planned: done, rest: Math.max(0, Math.min(n(l.qtyKg) - done, leftKg(l))) };
    }))
    .filter((r) => r.rest > 0.5)
    .filter((r) => !q || [r.orderId, r.item, r.itemName, r.partyCode, r.partyName, r.shipCode, r.warehouse, r.carrier].join(' ').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => String(a.due).localeCompare(String(b.due))), [orders, isAdmin, myCarrier, planned, shipto, q]);
  const chosen = rows.filter((r) => sel[r.key]);
  const lock = chosen[0];
  const total = chosen.reduce((s, r) => s + r.rest, 0);
  return (
    <div>
      <p className="hint">Tích các dòng cùng kho xuất{isAdmin ? ' và cùng đơn vị vận tải' : ''} rồi bấm <b>Chia xe</b>: app gợi ý số chuyến theo tải trọng xe, mỗi chuyến nhập số xe (tài xế bổ sung sau cũng được).</p>
      <div className="filters">
        <input type="search" placeholder="Tìm số đơn, mã hàng, khách, kho, mã giao…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <button className="btn primary" disabled={!chosen.length} onClick={() => setSplit({ rows: chosen, carrier: carriers.find((c) => c.code === lock.carrier) || { code: lock.carrier } })}>
          🚚 Chia xe{chosen.length ? ` (${chosen.length} dòng · ${t3(total)} tấn)` : ''}</button>
      </div>
      <div className="table-wrap">
        {!rows.length ? <Empty text="Không còn dòng đơn nào cần chia xe." /> : (
          <table className="picker">
            <thead><tr><th></th><th>Đơn</th><th>Ngày giao</th><th>Kho xuất</th><th>Giao đến</th><th>Mã giao</th><th>Mã hàng</th>{isAdmin && <th>Vận tải</th>}<th className="num">Đã chia (tấn)</th><th className="num">Còn phải chia (tấn)</th></tr></thead>
            <tbody>{rows.map((r) => {
              const locked = lock && !sel[r.key] && (r.warehouse !== lock.warehouse || r.carrier !== lock.carrier);
              return (
                <tr key={r.key} className={locked ? 'locked' : sel[r.key] ? 'picked' : ''} onClick={() => !locked && setSel((s) => ({ ...s, [r.key]: !s[r.key] }))} style={{ cursor: locked ? 'not-allowed' : 'pointer' }}>
                  <td><input type="checkbox" checked={!!sel[r.key]} disabled={locked} readOnly /></td>
                  <td className="mono">{r.orderId}</td><td className="nowrap">{fmtDate(r.due)}</td><td>{r.warehouse}</td><td>{r.partyName || r.partyCode}</td><td>{r.shipCode}</td><td>{r.item} {r.itemName}</td>
                  {isAdmin && <td>{r.carrier}</td>}<td className="num">{t3(r.planned)}</td><td className="num"><b>{t3(r.rest)}</b></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {split && <SplitModal {...split} onClose={(ok) => { setSplit(null); if (ok) setSel({}); }} />}
    </div>
  );
}

function SplitModal({ rows, carrier, onClose }) {
  const { email, name, can3PL } = useApp();
  const vehicles = useCollection('vehicles').rows.filter((v) => v.carrier === carrier.code);
  const drivers = useCollection('drivers').rows.filter((d) => d.carrier === carrier.code);
  const warehouses = useCollection('warehouses').rows;
  const threepl = useCollection(can3PL && carrier.uses3PL ? 'threepl' : '').rows;
  const [kg, setKg] = useState(() => Object.fromEntries(rows.map((r) => [r.key, r.rest])));
  const total = rows.reduce((s, r) => s + n(kg[r.key]), 0);
  const [cap, setCap] = useState(() => n(vehicles[0]?.payload) || 30);
  const [date, setDate] = useState(() => (rows[0].due && rows[0].due > today() ? rows[0].due : today()));
  const make = (c) => { const k = Math.max(1, Math.ceil(total / (n(c) * 1000) - 1e-9)); return Array.from({ length: k }, (_, i) => ({ tons: i < k - 1 ? n(c) : +((total - n(c) * 1000 * (k - 1)) / 1000).toFixed(3), plate: '', vehicleType: '', idCard: '', driverName: '', driverPhone: '', threepl: '' })); };
  const [loads, setLoads] = useState(() => make(cap));
  useEffect(() => { if (vehicles.length && cap === 30 && n(vehicles[0].payload)) { setCap(n(vehicles[0].payload)); setLoads(make(n(vehicles[0].payload))); } }, [vehicles.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setLoad = (i, p) => setLoads((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const pickPlate = (i, v) => { const veh = vehicles.find((x) => x.plate === v.trim().toUpperCase()); setLoad(i, { plate: v.toUpperCase(), ...(veh ? { vehicleType: veh.vehicleType || '', cap: n(veh.payload) } : { cap: 0 }) }); };
  const pickDriver = (i, v) => { const d = drivers.find((x) => x.idCard === v); setLoad(i, { idCard: v, ...(d ? { driverName: d.name || '', driverPhone: d.phone || '' } : {}) }); };
  const loadsKg = loads.map((l) => Math.round(n(l.tons) * 1000));
  const sumLoads = loadsKg.reduce((s, x) => s + x, 0);
  const lines = rows.map((r) => ({ ...r, kg: n(kg[r.key]) }));
  const alloc = splitLoads(lines, loadsKg);
  const save = async () => {
    setErr('');
    if (lines.some((l) => l.kg > l.rest + 1)) return setErr('Số tấn chia lớn hơn số còn phải chia.');
    if (Math.abs(sumLoads - total) > 1) return setErr(`Tổng các chuyến (${t3(sumLoads)} tấn) phải bằng tổng cần chia (${t3(total)} tấn).`);
    const over = loads.findIndex((l) => l.cap && n(l.tons) > l.cap);
    if (over >= 0) return setErr(`Chuyến ${over + 1}: ${loads[over].tons} tấn vượt tải trọng xe ${loads[over].plate} (${loads[over].cap} tấn).`);
    setBusy(true);
    try {
      const wh = warehouses.find((w) => w.code === rows[0].warehouse) || { code: rows[0].warehouse };
      await createPlannedTrips({ wh, carrier, trips: loads.map((l, i) => ({ ...l, date, lines: alloc[i], threeplName: threepl.find((x) => x.code === l.threepl)?.name || '' })) }, { email, name });
      onClose(true);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền tạo chuyến (kiểm tra phân quyền / firestore.rules).' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`Chia xe · ${carrier.name || carrier.code} · kho ${rows[0].warehouse}`} onClose={() => onClose(false)} wide>
      <div className="table-wrap" style={{ marginBottom: 10 }}><table>
        <thead><tr><th>Đơn</th><th>Giao đến</th><th>Mã hàng</th><th className="num">Còn phải chia</th><th className="num">Chia lần này (tấn)</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key}><td className="mono">{r.orderId}</td><td>{r.partyName}{r.shipCode ? ` · ${r.shipCode}` : ''}</td><td>{r.item}</td><td className="num">{t3(r.rest)}</td>
          <td className="num"><input type="number" step="0.001" style={{ width: 110, textAlign: 'right' }} value={n(kg[r.key]) / 1000} onChange={(e) => setKg((m) => ({ ...m, [r.key]: Math.round(n(e.target.value) * 1000) }))} /></td></tr>)}</tbody>
      </table></div>
      <div className="filters">
        <label>Ngày đi <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Tải trọng mỗi xe (tấn) <input type="number" step="0.5" style={{ width: 90 }} value={cap} onChange={(e) => setCap(e.target.value)} /></label>
        <button type="button" className="btn" onClick={() => setLoads(make(cap))}>⟳ Chia tự động ({Math.max(1, Math.ceil(total / (n(cap) * 1000 || 1) - 1e-9))} chuyến)</button>
        <button type="button" className="btn ghost" onClick={() => setLoads((ls) => [...ls, { tons: 0, plate: '', vehicleType: '', idCard: '', driverName: '', driverPhone: '', threepl: '' }])}>+ Thêm chuyến</button>
        <span className={Math.abs(sumLoads - total) > 1 ? 'badge red' : 'badge green'}>Đã chia {t3(sumLoads)} / {t3(total)} tấn</span>
      </div>
      <div className="table-wrap"><table className="so-lines">
        <thead><tr><th>#</th><th>Tấn</th><th>Số xe (bổ sung sau được)</th><th>Tài xế (CCCD)</th><th>Họ tên</th>{threepl.length > 0 && <th>3PL</th>}<th>Hàng trên chuyến</th><th></th></tr></thead>
        <tbody>{loads.map((l, i) => (
          <tr key={i}><td>{i + 1}</td>
            <td><input type="number" step="0.001" value={l.tons} onChange={(e) => setLoad(i, { tons: e.target.value })} style={{ width: 90 }} /></td>
            <td><input list="dl-sp-plate" value={l.plate} onChange={(e) => pickPlate(i, e.target.value)} />{l.cap ? <div className="small">{l.vehicleType} · {l.cap} tấn</div> : null}</td>
            <td><input list="dl-sp-driver" value={l.idCard} onChange={(e) => pickDriver(i, e.target.value)} /></td>
            <td><input value={l.driverName} onChange={(e) => setLoad(i, { driverName: e.target.value })} /></td>
            {threepl.length > 0 && <td><select value={l.threepl} onChange={(e) => setLoad(i, { threepl: e.target.value })}><option value="">-- Xe GHA --</option>{threepl.map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}</option>)}</select></td>}
            <td className="small">{(alloc[i] || []).map((a) => `${a.orderId} ${a.item} ${t3(a.kg)}t`).join('; ')}</td>
            <td><button type="button" className="btn ghost sm" disabled={loads.length === 1} onClick={() => setLoads((ls) => ls.filter((_, j) => j !== i))}>✕</button></td></tr>
        ))}</tbody>
      </table></div>
      <datalist id="dl-sp-plate">{vehicles.map((v) => <option key={v.plate} value={v.plate}>{v.vehicleType} {v.payload ? `${v.payload} tấn` : ''}</option>)}</datalist>
      <datalist id="dl-sp-driver">{drivers.map((d) => <option key={d.idCard} value={d.idCard}>{d.name}</option>)}</datalist>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={() => onClose(false)}>Thôi</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang tạo…' : `Tạo ${loads.length} chuyến`}</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Danh sách chuyến: tiến độ tài xế, làm thay bước, ảnh phiếu, chi phí
function TripList({ trips, priv }) {
  const { isAdmin, role, hasRole, can3PL, email, name } = useApp();
  const isCarrier = role === 'van_tai';
  const carriers = useCollection('carriers').rows;
  const [f, setF] = useState({ from: monthStart(), to: '', status: 'active', carrier: '', q: '' });
  const [step, setStep] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [cost, setCost] = useState(null);
  const [err, setErr] = useState('');
  const list = trips.filter((t) => (!f.from || (t.plannedDate || '') >= f.from || ['planned'].includes(t.status)) && (!f.to || (t.plannedDate || '') <= f.to)
    && (f.status === '' || (f.status === 'active' ? !['completed', 'cancelled'].includes(t.status) : t.status === f.status))
    && (!f.carrier || t.carrier === f.carrier)
    && (!f.q || [t.id, t.plate, t.driverName, t.idCard, t.warehouse, ...(t.lines || []).flatMap((l) => [l.orderId, l.partyName, l.item, l.shipCode])].join(' ').toLowerCase().includes(f.q.toLowerCase())));
  const setFF = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const cancel = async (t) => {
    const reason = window.prompt(`Hủy chuyến ${t.id}? Lý do:`, ''); if (!reason) return;
    try { await updateDoc(doc(db, 'trips', t.id), { status: 'cancelled', cancelReason: reason, cancelTime: nowISO(), updatedAt: nowISO(), updatedBy: email,
      history: [...(t.history || []), { at: nowISO(), by: email, byName: name, action: `Hủy chuyến: ${reason}`, status: 'cancelled' }] }); } catch (e) { setErr(e.message); }
  };
  return (
    <div>
      <div className="filters">
        <label>Từ <input type="date" value={f.from} onChange={(e) => setFF('from', e.target.value)} /></label>
        <label>Đến <input type="date" value={f.to} onChange={(e) => setFF('to', e.target.value)} /></label>
        <select value={f.status} onChange={(e) => setFF('status', e.target.value)}><option value="active">Đang chạy</option><option value="">Tất cả</option>
          {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</select>
        {!isCarrier && <select value={f.carrier} onChange={(e) => setFF('carrier', e.target.value)}><option value="">Mọi đơn vị vận tải</option>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</select>}
        <input type="search" placeholder="Tìm chuyến, xe, tài xế, đơn, khách…" value={f.q} onChange={(e) => setFF('q', e.target.value)} />
      </div>
      <ErrorBox error={err} />
      <div className="table-wrap">
        {!list.length ? <Empty text="Không có chuyến nào." /> : (
          <table>
            <thead><tr><th>Chuyến</th><th>Ngày đi</th><th>Kho</th><th>Xe · tài xế</th>{!isCarrier && <th>Vận tải</th>}{can3PL && <th>3PL</th>}<th>Giao đến · hàng</th><th className="num">Tấn</th><th>Tiến độ</th><th>Chi phí</th><th></th></tr></thead>
            <tbody>{list.map((t) => {
              const st = nextStep(t); const blocked = st && stepBlocked(t, st);
              const canStep = isAdmin || (isCarrier && t.carrier);
              return (
                <tr key={t.id} style={{ opacity: t.status === 'cancelled' ? 0.5 : 1 }}>
                  <td className="mono">{t.id}</td><td className="nowrap">{fmtDate(t.plannedDate)}</td><td>{t.warehouse}</td>
                  <td>{t.plate ? <b>{t.plate}</b> : <span className="small">chưa có xe</span>}{t.driverName ? <div className="small">{t.driverName}{t.idCard ? ` · ${t.idCard}` : ''}</div> : null}</td>
                  {!isCarrier && <td>{t.carrierName || t.carrier}</td>}
                  {can3PL && <td>{priv[t.id]?.threeplName || priv[t.id]?.threepl || ''}</td>}
                  <td className="small">{[...new Set(t.lines.map((l) => l.partyName || l.partyCode))].join(', ')}<div>{t.lines.map((l) => `${l.orderId} ${l.item}`).join('; ')}</div></td>
                  <td className="num">{t3(tripKg(t))}</td>
                  <td><span className={'badge ' + (STATUS_META[t.status]?.tone || '')}>{STATUS_META[t.status]?.label}</span>
                    <div className="small">{[['driverArrivedAt', 'đến kho'], ['driverLoadedAt', 'lấy xong'], ['driverAtDestAt', 'đến điểm giao'], ['driverDeliveredAt', 'giao xong']].filter(([k]) => t[k]).map(([k, l]) => `${l} ${fmtTime(t[k])}`).join(' · ')}</div>
                    {st && <div className="small">Tiếp: <b>{STEPS[st]}</b>{blocked ? ` (${blocked})` : ''}</div>}</td>
                  <td>{t.costs ? <><b>{vnd(costTotal(t.costs))}</b><div className="small">{COST[t.costStatus || '']?.[0]}</div></> : <span className="small">{t.status === 'completed' ? 'chưa nhập' : ''}</span>}</td>
                  <td className="nowrap">
                    {canStep && st && !blocked && <button className="btn primary sm" onClick={() => setStep({ t, st })}>{STEPS[st]}</button>}{' '}
                    {canStep && st && st !== 'reg' && t.status === 'planned' && <button className="btn sm" onClick={() => setStep({ t, st: 'reg' })}>Sửa xe</button>}{' '}
                    {t.photoCount > 0 && <button className="btn sm" onClick={() => setPhoto(t)}>📷 {t.photoCount}</button>}{' '}
                    {(canStep || hasRole('ke_toan')) && t.status === 'completed' && <button className="btn sm" onClick={() => setCost(t)}>💰 Chi phí</button>}{' '}
                    {canStep && t.status === 'planned' && <button className="btn ghost sm" onClick={() => cancel(t)}>Hủy</button>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {step && <StepModal t={step.t} step={step.st} onClose={() => setStep(null)} />}
      {photo && <PhotoModal t={photo} onClose={() => setPhoto(null)} />}
      {cost && <CostModal t={trips.find((x) => x.id === cost.id) || cost} onClose={() => setCost(null)} />}
    </div>
  );
}

// Điều phối nhập cước, phí chi hộ, bốc xếp, số HĐ; kế toán chốt
function CostModal({ t, onClose }) {
  const { email, name, role, hasRole, isAdmin } = useApp();
  const rates = useCollection('freightRates').rows;
  const sug = suggestFreight(t, rates);
  const c = t.costs || {};
  const [f, setF] = useState({ freight: c.freight ?? sug?.amount ?? '', chiHo: c.chiHo ?? '', bocXep: c.bocXep ?? '', other: c.other ?? '', invoiceNo: c.invoiceNo || '', invoiceDate: c.invoiceDate || '', note: c.note || '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const approved = t.costStatus === 'approved';
  const canEdit = !approved && (isAdmin || role === 'van_tai');
  const canApprove = hasRole('ke_toan') && t.costs && !approved;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  // Bảng giá tải xong sau khi mở: điền sẵn cước gợi ý nếu chưa nhập
  useEffect(() => { if (sug && c.freight == null) setF((x) => (x.freight === '' ? { ...x, freight: sug.amount } : x)); }, [sug?.amount]); // eslint-disable-line react-hooks/exhaustive-deps
  const write = async (upd, action) => {
    setErr(''); setBusy(true);
    try { await updateDoc(doc(db, 'trips', t.id), { ...upd, updatedAt: nowISO(), updatedBy: email, history: [...(t.history || []), { at: nowISO(), by: email, byName: name, action }] }); onClose(); }
    catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền.' : e.message); }
    setBusy(false);
  };
  const costs = { freight: n(f.freight), chiHo: n(f.chiHo), bocXep: n(f.bocXep), other: n(f.other), invoiceNo: f.invoiceNo.trim(), invoiceDate: f.invoiceDate, note: f.note.trim(), rate: sug?.rate || '' };
  return (
    <Modal title={`Chi phí chuyến ${t.id}`} onClose={onClose}>
      <p className="small">{t.carrierName} · {t.plate} · {t3(tripKg(t))} tấn · {COST[t.costStatus || '']?.[0]}
        {sug ? <> · Bảng giá <b>{sug.rate}</b>: {sug.basis === 'Theo chuyến' ? 'theo chuyến' : `${vnd(sug.price)} đ/tấn`} = <b>{vnd(sug.amount)} đ</b></> : ' · Chưa có giá khớp trong bảng giá cước'}</p>
      <div className="form-grid">
        {[['freight', 'Cước vận chuyển (đ)'], ['chiHo', 'Phí chi hộ (đ)'], ['bocXep', 'Phí bốc xếp (đ)'], ['other', 'Phí khác (đ)']].map(([k, l]) => (
          <label key={k} className="field"><span>{l}</span><input type="number" value={f[k]} disabled={!canEdit} onChange={(e) => set(k, e.target.value)} /></label>))}
        <label className="field"><span>Số hóa đơn</span><input value={f.invoiceNo} disabled={!canEdit} onChange={(e) => set('invoiceNo', e.target.value)} /></label>
        <label className="field"><span>Ngày hóa đơn</span><input type="date" value={f.invoiceDate} disabled={!canEdit} onChange={(e) => set('invoiceDate', e.target.value)} /></label>
        <label className="field full"><span>Ghi chú</span><input value={f.note} disabled={!canEdit} onChange={(e) => set('note', e.target.value)} /></label>
      </div>
      <p>Tổng: <b>{vnd(costTotal(costs))} đ</b></p>
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={onClose}>Đóng</button>
        {canEdit && <button className="btn primary" disabled={busy} onClick={() => write({ costs, costStatus: 'entered', costBy: email, costAt: nowISO() }, `Nhập chi phí ${vnd(costTotal(costs))} đ`)}>Lưu chi phí</button>}
        {canApprove && <button className="btn primary" disabled={busy} onClick={() => write({ costStatus: 'approved', costApprovedBy: email, costApprovedAt: nowISO() }, `Kế toán chốt chi phí ${vnd(costTotal(t.costs))} đ`)}>✓ Chốt chi phí</button>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Chi phí & cước theo đơn vị vận tải
function Costs({ trips, priv }) {
  const { role, can3PL } = useApp();
  const isCarrier = role === 'van_tai';
  const rates = useCollection('freightRates').rows;
  const [f, setF] = useState({ from: monthStart(), to: '' });
  const done = trips.filter((t) => t.status === 'completed' && (!f.from || (t.plannedDate || '') >= f.from) && (!f.to || (t.plannedDate || '') <= f.to));
  const g = new Map();
  for (const t of done) {
    const k = t.carrier || '';
    const x = g.get(k) || { carrier: k, name: t.carrierName || '', trips: 0, kg: 0, freight: 0, chiHo: 0, bocXep: 0, other: 0, total: 0, missing: 0, approved: 0 };
    const c = t.costs || {};
    x.trips += 1; x.kg += tripKg(t); x.freight += n(c.freight); x.chiHo += n(c.chiHo); x.bocXep += n(c.bocXep); x.other += n(c.other); x.total += costTotal(c);
    if (!t.costs) x.missing += 1; if (t.costStatus === 'approved') x.approved += 1;
    g.set(k, x);
  }
  const sum = [...g.values()];
  const excel = () => exportSheets(`Chi_phi_van_chuyen_${f.from}_${f.to}`, {
    'Tổng theo đơn vị': sum.map((x) => ({ 'Đơn vị vận tải': x.carrier, 'Tên': x.name, 'Số chuyến': x.trips, 'Số tấn': +(x.kg / 1000).toFixed(3), 'Cước': x.freight, 'Chi hộ': x.chiHo, 'Bốc xếp': x.bocXep, 'Phí khác': x.other, 'Tổng': x.total, 'Chuyến chưa nhập chi phí': x.missing, 'Chuyến kế toán đã chốt': x.approved })),
    'Chi tiết chuyến': done.map((t) => { const c = t.costs || {}; const s = suggestFreight(t, rates); return {
      'Chuyến': t.id, 'Ngày đi': t.plannedDate, 'Kho': t.warehouse, 'Đơn vị vận tải': t.carrier, ...(can3PL ? { '3PL': priv[t.id]?.threeplName || priv[t.id]?.threepl || '' } : {}),
      'Số xe': t.plate, 'Tài xế': t.driverName, 'CCCD': t.idCard, 'Đơn': (t.orderIds || []).join(', '), 'Giao đến': [...new Set(t.lines.map((l) => l.partyName || l.partyCode))].join(', '),
      'Số tấn': +(tripKg(t) / 1000).toFixed(3), 'Giao xong lúc': t.driverDeliveredAt || t.deliveryCompleteTime || '', 'Cước theo bảng giá': s?.amount ?? '',
      'Cước': n(c.freight), 'Chi hộ': n(c.chiHo), 'Bốc xếp': n(c.bocXep), 'Phí khác': n(c.other), 'Tổng': costTotal(c), 'Số HĐ': c.invoiceNo || '', 'Ngày HĐ': c.invoiceDate || '', 'Ghi chú': c.note || '', 'Trạng thái': COST[t.costStatus || '']?.[0] }; }),
  });
  return (
    <div>
      <div className="filters">
        <label>Từ <input type="date" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} /></label>
        <label>Đến <input type="date" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} /></label>
        <button className="btn" onClick={excel}>⬇ Excel</button>
        <span className="small">Chỉ tính chuyến đã giao xong. Nhập chi phí ở tab Chuyến xe → 💰 Chi phí.</span>
      </div>
      <div className="table-wrap">
        {!sum.length ? <Empty text="Chưa có chuyến giao xong trong khoảng này." /> : (
          <table>
            <thead><tr>{!isCarrier && <th>Đơn vị vận tải</th>}<th className="num">Chuyến</th><th className="num">Tấn</th><th className="num">Cước</th><th className="num">Chi hộ</th><th className="num">Bốc xếp</th><th className="num">Phí khác</th><th className="num">Tổng (đ)</th><th className="num">Chưa nhập</th><th className="num">Đã chốt</th></tr></thead>
            <tbody>{sum.map((x) => (
              <tr key={x.carrier}>{!isCarrier && <td><b>{x.carrier}</b> {x.name}</td>}<td className="num">{x.trips}</td><td className="num">{t3(x.kg)}</td><td className="num">{vnd(x.freight)}</td><td className="num">{vnd(x.chiHo)}</td>
                <td className="num">{vnd(x.bocXep)}</td><td className="num">{vnd(x.other)}</td><td className="num"><b>{vnd(x.total)}</b></td><td className="num">{x.missing || ''}</td><td className="num">{x.approved}</td></tr>))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Điều phối tạo tài khoản cho tài xế của đơn vị mình (tài xế đăng nhập bằng email này)
function DriverAccounts() {
  const { isAdmin, myCarrier, email } = useApp();
  const carriers = useCollection('carriers').rows;
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ email: '', name: '', idCard: '', phone: '', carrier: myCarrier });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => onSnapshot(query(collection(db, 'users'), where('role', '==', 'tai_xe')),
    (s) => setRows(s.docs.map((d) => d.data()).filter((u) => isAdmin || u.carrier === myCarrier)), (e) => setErr(e.message)), [isAdmin, myCarrier]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async (e) => {
    e.preventDefault(); setErr(''); setMsg('');
    const em = f.email.trim().toLowerCase();
    if (!em.includes('@') || !f.name.trim() || !f.idCard.trim() || !f.carrier) return setErr('Nhập email, họ tên, CCCD và đơn vị vận tải.');
    const at = nowISO();
    try {
      await setDoc(doc(db, 'users', em), { email: em, name: f.name.trim(), role: 'tai_xe', carrier: f.carrier, idCard: f.idCard.trim(), phone: f.phone.trim(), warehouses: [], active: true, updatedAt: at, updatedBy: email }, { merge: true });
      await setDoc(doc(db, 'drivers', f.idCard.trim()), { idCard: f.idCard.trim(), name: f.name.trim(), phone: f.phone.trim(), carrier: f.carrier, loginEmail: em, updatedAt: at, updatedBy: email }, { merge: true });
      setMsg(`Đã tạo tài khoản ${em}. Tài xế mở app, đăng nhập bằng Google hoặc tạo mật khẩu với email này.`);
      setF({ email: '', name: '', idCard: '', phone: '', carrier: myCarrier });
    } catch (e2) { setErr(e2.code === 'permission-denied' ? 'Không có quyền tạo tài khoản (email này có thể đang là tài khoản vai trò khác).' : e2.message); }
  };
  const toggle = async (u) => {
    try { await updateDoc(doc(db, 'users', u.email), { active: u.active === false, updatedAt: nowISO(), updatedBy: email }); } catch (e) { setErr(e.message); }
  };
  return (
    <div>
      <form className="card" onSubmit={save} style={{ marginBottom: 12 }}>
        <div className="section-head">Thêm tài khoản tài xế</div>
        <div className="form-grid">
          <label className="field"><span>Email đăng nhập *</span><input value={f.email} onChange={(e) => set('email', e.target.value)} /></label>
          <label className="field"><span>Họ tên *</span><input value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="field"><span>CCCD *</span><input value={f.idCard} onChange={(e) => set('idCard', e.target.value)} /></label>
          <label className="field"><span>Điện thoại</span><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
          {isAdmin && <label className="field"><span>Đơn vị vận tải *</span><select value={f.carrier} onChange={(e) => set('carrier', e.target.value)}><option value="">--</option>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</select></label>}
        </div>
        {msg && <div className="ok-box">{msg}</div>}
        <ErrorBox error={err} />
        <div className="form-actions"><button className="btn primary">Lưu tài khoản</button></div>
      </form>
      <div className="table-wrap">
        {!rows.length ? <Empty text="Chưa có tài khoản tài xế." /> : (
          <table><thead><tr><th>Email</th><th>Họ tên</th><th>CCCD</th><th>Điện thoại</th>{isAdmin && <th>Đơn vị</th>}<th>Trạng thái</th><th></th></tr></thead>
            <tbody>{rows.map((u) => <tr key={u.email}><td>{u.email}</td><td>{u.name}</td><td>{u.idCard}</td><td>{u.phone}</td>{isAdmin && <td>{u.carrier}</td>}
              <td>{u.active === false ? <span className="badge red">Đã khóa</span> : <span className="badge green">Hoạt động</span>}</td>
              <td><button className="btn sm" onClick={() => toggle(u)}>{u.active === false ? 'Mở khóa' : 'Khóa'}</button></td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}
