import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, runTransaction, updateDoc, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { createPlan, updatePlan, usePlans } from '../../lib/shipPlans';
import { PlanForm } from '../orders/ShipPlans';
import { useMovesRange } from '../../lib/slips';
import { setCarrier as setAllocCarrier } from '../../lib/allocations';
import { KIND_LABEL, SRC_LABEL, kindText, pendingDispatch, pickupFrom, pointOf, pointText } from '../../lib/dispatch';
import PickupSelect from '../../components/PickupSelect';
import PlateDriver from '../../components/PlateDriver';
import { createPlannedTrips, splitLoads } from '../../lib/transport';
import { fmtDate, fmtNum, norm, today } from '../../lib/utils';
import { Empty, ErrorBox, Modal } from '../../components/ui';
import Select from '../../components/Select';
import { WithAdd } from '../../components/FormTools';

const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
const t3 = (kg) => fmtNum(n(kg) / 1000, 3);
const daysAgo = (k) => { const d = new Date(); d.setDate(d.getDate() - k); return d.toISOString().slice(0, 10); };
const nowISO = () => new Date().toISOString();

// ============================================================================
// DO chờ vận tải (quản trị): SO → DO → Shipment
//  • SO chưa có DO hiện thành 1 dòng (cả phần còn lại của SO); chọn vận tải / tách / gửi là tự sinh DO.
//  • Chọn đơn vị vận tải ngay trên dòng (hoặc tick nhiều dòng chọn 1 lần).
//  • ✂ Tách DO theo số tấn mỗi xe vận tải đề xuất: DO đầu giữ phần xe 1, sinh thêm DO mới cho các xe còn lại.
//  • Tick DO → Gửi vận tải (mỗi DO 1 Shipment) hoặc Gộp nhiều DO cùng điểm giao vào 1 Shipment (kiểm tải trọng xe).
// Đơn vị vận tải chỉ thấy Shipment sau khi gửi, nên chỉ định sai thì sửa được trước khi họ nhận.
// ============================================================================
export default function Dispatch({ orders, trips, onSplit }) {
  const { email, name } = useApp();
  const user = { email, name };
  const carriers = useCollection('carriers').rows;
  const warehouses = useCollection('warehouses').rows;
  const shipto = useCollection('shipto').rows;
  const points = useCollection('pickupPoints').rows;
  const plans = usePlans().rows;
  const moves = useMovesRange(daysAgo(30), '9999').rows;
  const [allocs, setAllocs] = useState([]);
  useEffect(() => onSnapshot(query(collection(db, 'allocations'), where('status', '==', 'ordered')),
    (s) => setAllocs(s.docs.map((d) => ({ ...d.data(), _id: d.id }))), () => setAllocs([])), []);
  const all = useMemo(() => pendingDispatch({ orders, plans, allocs, moves, trips, shipto }), [orders, plans, allocs, moves, trips, shipto]);
  const [f, setF] = useState({ q: '', src: '', carrier: '', st: 'need' });
  const [sel, setSel] = useState({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [bulkCar, setBulkCar] = useState('');
  const [ship, setShip] = useState(null); // rows → modal Shipment
  const [cut, setCut] = useState(null); // row → modal Tách DO
  const [doFor, setDoFor] = useState(null); // SO chưa có DO → form Lập DO (sửa SL thực xuất, bỏ dòng không xuất)
  const car = (code) => carriers.find((c) => c.code === code);
  const soNoDO = (r) => r.src === 'order' && r.orderType === 'SO';
  const need = all.filter((r) => !r.carrier).length;
  const ready = all.length - need;
  const rows = all.filter((r) => (f.st === 'all' || (f.st === 'need' ? !r.carrier : !!r.carrier)) && (!f.src || r.src === f.src) && (!f.carrier || r.carrier === f.carrier)
    && (!f.q || norm([r.srcLabel, r.orderId, r.partyCode, r.partyName, r.shipCode, r.warehouse, r.carrier, ...r.items.map((i) => `${i.item} ${i.itemName}`)].join(' ')).includes(norm(f.q))));
  const chosen = rows.filter((r) => sel[r.key]);
  const run = async (fn, ok) => {
    setErr(''); setMsg(''); setBusy(true);
    try { const m = await fn(); setMsg(m || ok || ''); } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền thực hiện (kiểm tra phân quyền / firestore.rules).' : e.message); }
    setBusy(false);
  };

  // Chọn / đổi đơn vị vận tải: ghi thẳng vào DO / dòng đơn / kế hoạch phân bổ / phiếu xuất
  const setCarrierFor = async (r, code) => {
    if (r.src === 'plan') return updatePlan(r.srcId, { carrier: code }, user).then(() => '');
    if (r.src === 'order' && r.orderType === 'SO') return materialize(r, code).then((id) => `Đã sinh DO ${id} cho ${r.orderId} (${code || 'chưa có vận tải'}).`);
    if (r.src === 'order') return setLineCarrier(r.orderId, r.items.map((i) => i.no), code, user);
    if (r.src === 'alloc') return setAllocCarrier([{ _id: r.srcId, orderId: r.orderId, orderLine: r.items[0].no }], code, user);
    if (r.src === 'px') return updateDoc(doc(db, 'movements', r.srcId), { carrier: code, carrierName: car(code)?.name || '', updatedAt: nowISO(), updatedBy: email });
    return null;
  };
  // SO chưa có DO: sinh DO cho phần còn lại (cùng điểm giao, cùng kho)
  const materialize = async (r, code = r.carrier, items = r.items, note = 'Tự sinh từ SO ở DO chờ vận tải') => {
    const id = await createPlan({ orderId: r.orderId, orderRef: r.orderRef || '', company: r.company || '', partyCode: r.partyCode || '', partyName: r.partyName || '',
      sales: r.sales || '', salesName: r.salesName || '', date: r.date && r.date > today() ? r.date : today(), note, carrier: code || '',
      lines: items.map((i) => ({ orderLine: i.no, item: i.item, itemName: i.itemName || '', qtyKg: Math.round(i.kg), shipCode: i.shipCode || '', shipAddress: i.address || '', packing: i.packing || '', warehouse: r.warehouse || '' })) }, user);
    return id;
  };
  // Dòng gửi vận tải: SO chưa có DO thì sinh DO trước để Shipment ghi đúng DO
  const asDO = async (r) => {
    if (!(r.src === 'order' && r.orderType === 'SO')) return r;
    const id = await materialize(r);
    return { ...r, src: 'plan', srcId: id, items: r.items.map((i) => ({ ...i, planId: id })) };
  };
  const applyBulk = () => run(async () => {
    if (!bulkCar) throw new Error('Chọn đơn vị vận tải.');
    for (const r of chosen) await setCarrierFor(r, bulkCar);
    setSel({});
    return `Đã chọn ${bulkCar} cho ${chosen.length} dòng.`;
  });
  const release = (list) => run(async () => {
    const bad = list.find((r) => !car(r.carrier));
    if (bad) throw new Error(`${bad.srcLabel}: chưa chọn đơn vị vận tải.`);
    let done = 0;
    for (const r0 of list) {
      const r = await asDO(r0);
      const wh = warehouses.find((w) => w.code === r.warehouse) || { code: r.warehouse };
      await createPlannedTrips({ wh, carrier: car(r.carrier), trips: [{ date: r.date && r.date > today() ? r.date : today(), company: r.company, lines: r.items,
        extra: { doIds: r.src === 'plan' ? [r.srcId] : [] } }] }, user, 'Gửi vận tải');
      done += 1;
    }
    setSel({});
    return `Đã gửi ${done} Shipment cho đơn vị vận tải.`;
  });
  // Gộp nhiều dòng vào 1 Shipment: cùng vận tải, cùng kho xuất, cùng công ty, cùng 1 điểm giao
  const shipErr = (list) => {
    if (!list.length) return 'Tick ít nhất 1 dòng.';
    const a = list[0];
    if (list.some((r) => !r.carrier)) return 'Có dòng chưa chọn đơn vị vận tải.';
    if (list.some((r) => r.carrier !== a.carrier)) return '1 Shipment chỉ của 1 đơn vị vận tải: các dòng đang khác đơn vị.';
    if (list.some((r) => (r.warehouse || '') !== (a.warehouse || ''))) return '1 Shipment lấy hàng ở 1 kho: các dòng đang khác kho xuất.';
    if (list.some((r) => (r.company || '') !== (a.company || ''))) return 'Các dòng khác công ty (pháp nhân): tạo Shipment riêng.';
    if (list.some((r) => pointOf(r) !== pointOf(a))) return '1 Shipment chỉ đi 1 điểm giao. Khác điểm giao: tạo Shipment riêng (ghép Job nhiều điểm giao ở bước sau).';
    return '';
  };
  const openShip = (list) => { const e = shipErr(list); if (e) { setErr(e); return; } setErr(''); setShip(list); };
  const openCut = () => {
    if (chosen.length !== 1) return setErr('Tick đúng 1 DO để tách.');
    const r = chosen[0];
    if (r.src === 'plan' || (r.src === 'order' && r.orderType === 'SO')) return setCut(r);
    // Lệnh chuyển kho, kế hoạch phân bổ, phiếu xuất: chia thẳng thành nhiều Shipment
    const c = car(r.carrier);
    if (!c) return setErr('Chọn đơn vị vận tải trước khi chia xe.');
    return onSplit({ carrier: c, action: 'Gửi vận tải', rows: r.items.map((i, k) => ({ ...i, key: `${r.key}#${k}`, rest: i.kg, due: r.date, warehouse: r.warehouse, company: r.company })), done: () => setSel({}) });
  };
  const carOpts = (cur) => carriers.filter((x) => x.active !== false || x.code === cur).map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}</option>);

  return (
    <div>
      <p className="hint"><b>SO → DO → Shipment.</b> Chọn đơn vị vận tải cho DO ngay trên dòng. Vận tải báo mỗi xe chở bao nhiêu tấn thì <b>✂ Tách DO</b>. Tick DO rồi <b>Gửi vận tải</b> (mỗi DO 1 Shipment) hoặc <b>Gộp 1 Shipment</b> (nhiều DO cùng điểm giao đi chung 1 xe). Đơn vị vận tải chỉ thấy Shipment sau khi gửi.</p>
      <div className="seg" style={{ marginBottom: 8 }}>
        {[['need', `Chờ chỉ định vận tải (${need})`], ['ready', `Đã có vận tải, chờ gửi (${ready})`], ['all', `Tất cả (${all.length})`]].map(([k, l]) => (
          <button key={k} type="button" className={'btn sm' + (f.st === k ? ' primary' : '')} onClick={() => { setF({ ...f, st: k }); setSel({}); }}>{l}</button>))}
      </div>
      <div className="filters">
        <input type="search" placeholder="Tìm DO, SO, khách, mã giao, mã hàng, kho…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
        <Select value={f.src} onChange={(e) => setF({ ...f, src: e.target.value })}><option value="">Mọi nguồn</option>{Object.entries(SRC_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Select value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })}><option value="">Mọi đơn vị vận tải</option>{carOpts(f.carrier)}</Select>
      </div>
      <div className="filters">
        <span className="small"><b>{chosen.length}</b> dòng đã tick · {t3(chosen.reduce((s, r) => s + r.kg, 0))} tấn</span>
        <WithAdd cat="carriers" onAdded={(id) => setBulkCar(id)}><Select value={bulkCar} onChange={(e) => setBulkCar(e.target.value)}><option value="">-- Vận tải cho dòng đã tick --</option>{carOpts(bulkCar)}</Select></WithAdd>
        <button className="btn" disabled={busy || !chosen.length || !bulkCar} onClick={applyBulk}>✓ Chọn vận tải</button>
        <button className="btn" disabled={busy || chosen.length !== 1} onClick={openCut} title="Vận tải báo mỗi xe chở bao nhiêu tấn: tách DO thành nhiều DO, mỗi DO 1 xe">✂ Tách DO</button>
        <button className="btn" disabled={busy || !chosen.length} onClick={() => openShip(chosen)} title="Nhiều DO cùng điểm giao đi chung 1 xe">📦 Gộp 1 Shipment</button>
        <button className="btn primary" disabled={busy || !chosen.length} onClick={() => release(chosen)}>🚚 Gửi vận tải{chosen.length ? ` (${chosen.length} Shipment)` : ''}</button>
      </div>
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <ErrorBox error={err} />
      <div className="table-wrap">
        {!rows.length ? <Empty text={f.st === 'need' ? 'Không còn DO / SO nào chờ chỉ định vận tải.' : 'Không có DO nào chờ gửi vận tải.'} /> : (
          <table>
            <thead><tr><th><input type="checkbox" checked={chosen.length === rows.length} onChange={(e) => setSel(e.target.checked ? Object.fromEntries(rows.map((r) => [r.key, true])) : {})} /></th>
              <th>DO / nguồn</th><th>Ngày giao</th><th>Kho xuất</th><th>Điểm giao</th><th>Hàng</th><th className="num">Tấn</th><th>Đơn vị vận tải</th><th></th></tr></thead>
            <tbody>{rows.map((r) => {
              const c = car(r.carrier);
              return (
                <tr key={r.key} className={sel[r.key] ? 'picked' : ''}>
                  <td><input type="checkbox" checked={!!sel[r.key]} onChange={() => setSel((s) => ({ ...s, [r.key]: !s[r.key] }))} /></td>
                  <td className="small"><b>{r.srcLabel}</b>{r.src !== 'order' ? <div className="mono">{r.orderId}</div> : null}{r.plan?.parentDo ? <div className="small">tách từ {r.plan.parentDo}</div> : null}</td>
                  <td>{r.date ? fmtDate(r.date) : <span className="small">–</span>}</td>
                  <td>{r.warehouse ? warehouses.find((w) => w.code === r.warehouse)?.name || r.warehouse : <span className="small">chưa có kho</span>}</td>
                  <td>{pointText(r)}{r.address ? <div className="small">{r.address}</div> : null}</td>
                  <td className="small">{r.items.map((i) => <div key={`${i.orderId}${i.no}${i.item}`}>{i.item} {t3(i.kg)} t</div>)}</td>
                  <td className="num"><b>{t3(r.kg)}</b></td>
                  <td><WithAdd cat="carriers" onAdded={(id) => (soNoDO(r) ? setDoFor({ orderId: r.orderId, carrier: id }) : run(() => setCarrierFor(r, id)))}><Select value={r.carrier || ''} disabled={busy}
                    onChange={(e) => (soNoDO(r) ? setDoFor({ orderId: r.orderId, carrier: e.target.value }) : run(() => setCarrierFor(r, e.target.value)))}>
                    <option value="">-- Chọn vận tải --</option>{carOpts(r.carrier)}</Select></WithAdd>
                    {c ? <div className="small" title={KIND_LABEL[c.kind] || ''}>{kindText(c)}</div> : null}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {soNoDO(r) && <button className="btn sm" disabled={busy} onClick={() => setDoFor({ orderId: r.orderId, carrier: r.carrier || '' })} title="Mở form DO theo SO: sửa SL thực xuất, bỏ tick dòng không xuất">📝 Lập DO</button>}
                    {(r.src === 'plan' || (r.src === 'order' && r.orderType === 'SO')) && <button className="btn sm" disabled={busy} onClick={() => setCut(r)} title="Tách DO theo số tấn mỗi xe">✂</button>}
                    <button className="btn primary sm" disabled={busy || !c} onClick={() => openShip([r])} title={c ? 'Tạo Shipment, nhập xe nếu biết, gửi vận tải' : 'Chọn vận tải trước'}>Gửi</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {ship && <ShipmentModal rows={ship} carrier={car(ship[0].carrier)} warehouses={warehouses} points={points} shipto={shipto} asDO={asDO}
        onClose={(m) => { setShip(null); if (m) { setMsg(m); setSel({}); } }} />}
      {doFor && <PlanForm orderId={doFor.orderId} initCarrier={doFor.carrier} plans={plans}
        onClose={(saved) => { if (saved) setMsg(`Đã lập DO cho ${doFor.orderId}.`); setDoFor(null); }} />}
      {cut && <SplitDO row={cut} carrier={car(cut.carrier)} materialize={materialize} onClose={(m) => { setCut(null); if (m) { setMsg(m); setSel({}); } }} />}
    </div>
  );
}

// Chỉ định vận tải cho dòng lệnh chuyển kho (STO)
async function setLineCarrier(orderId, nos, carrier, user) {
  const set = new Set(nos);
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'orders', orderId);
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error(`Không tìm thấy ${orderId}.`);
    const o = s.data(); const at = nowISO();
    const lines = o.lines.map((l) => (set.has(l.no) ? { ...l, carrier } : l));
    tx.update(ref, { lines, carriers: [...new Set(lines.map((l) => l.carrier).filter(Boolean))], updatedAt: at, updatedBy: user.email,
      history: [...(o.history || []), { at, by: user.email, byName: user.name, action: `Chỉ định vận tải ${carrier || 'bỏ'} cho dòng ${nos.join(', ')}` }] });
  });
}

// ---------------------------------------------------------------------------
// Tạo Shipment (1 xe, 1 điểm giao) từ 1 hoặc nhiều DO: kiểm tải trọng, nhập xe / tài xế nếu biết, gửi vận tải
function ShipmentModal({ rows, carrier, warehouses, points, shipto, asDO, onClose }) {
  const { email, name } = useApp();
  const total = rows.reduce((s, r) => s + r.kg, 0);
  const first = rows[0];
  const [date, setDate] = useState(() => { const d = rows.map((r) => r.date).filter(Boolean).sort()[0]; return d && d > today() ? d : today(); });
  const [pickup, setPickup] = useState('');
  const [v, setV] = useState({ plate: '', vehicleType: '', payload: '', driverName: '', idCard: '', driverPhone: '' });
  const [cap, setCap] = useState('');
  const [note, setNote] = useState('');
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Tải trọng: theo xe đã khai / đã chạy (đổi được)
  useEffect(() => { if (v.payload) setCap(String(v.payload)); }, [v.payload]);
  const capKg = n(cap) * 1000;
  const isOver = capKg > 0 && total > capKg + 1;
  const save = async () => {
    setErr('');
    if (!capKg && v.plate) return setErr('Nhập tải trọng xe (tấn) để kiểm tra.');
    if (isOver && !over) return setErr(`Tổng ${t3(total)} tấn vượt tải trọng ${cap} tấn. Tách DO hoặc tick "Vẫn tạo".`);
    setBusy(true);
    try {
      const list = [];
      for (const r of rows) list.push(await asDO(r));
      const wh = warehouses.find((w) => w.code === first.warehouse) || { code: first.warehouse };
      const doIds = list.filter((r) => r.src === 'plan').map((r) => r.srcId);
      const [id] = await createPlannedTrips({ wh, carrier, trips: [{ date, company: first.company, pickup: pickupFrom(pickup, points, shipto), note: note.trim(),
        plate: v.plate, vehicleType: v.vehicleType, driverName: v.driverName, idCard: v.idCard, driverPhone: v.driverPhone, cap: n(cap) || '',
        lines: list.flatMap((r) => r.items), extra: { doIds, ...(n(cap) ? { capacityTons: n(cap) } : {}) } }] }, { email, name }, rows.length > 1 ? `Gộp ${rows.length} DO vào 1 Shipment` : 'Gửi vận tải');
      onClose(`Đã tạo Shipment ${id} (${t3(total)} tấn) và gửi ${carrier.name || carrier.code}.`);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền tạo Shipment.' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`Tạo Shipment · ${carrier.name || carrier.code}`} onClose={() => onClose()} wide>
      <p className="small">1 Shipment = 1 xe, 1 điểm giao: <b>{pointText(first)}</b>{first.address ? ` · ${first.address}` : ''} · lấy hàng ở kho <b>{warehouses.find((w) => w.code === first.warehouse)?.name || first.warehouse || '–'}</b></p>
      <div className="table-wrap"><table>
        <thead><tr><th>DO / nguồn</th><th>Hàng</th><th className="num">Tấn</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key}><td>{r.srcLabel}</td><td className="small">{r.items.map((i) => `${i.item} ${t3(i.kg)} t`).join(' · ')}</td><td className="num">{t3(r.kg)}</td></tr>)}</tbody>
        <tfoot><tr><td colSpan={2}><b>Tổng Shipment</b></td><td className="num"><b>{t3(total)}</b></td></tr></tfoot>
      </table></div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <label className="field"><span>Ngày đi</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field"><span>Điểm nhận hàng</span><PickupSelect value={pickup} onChange={setPickup} whLabel={warehouses.find((w) => w.code === first.warehouse)?.name || first.warehouse || 'Kho xuất'} points={points} shipto={shipto} /></label>
        <label className="field"><span>Tải trọng xe (tấn)</span><input type="number" step="0.5" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="theo xe" />
          {capKg > 0 && <span className={'small'} style={{ color: isOver ? 'var(--red)' : 'var(--green)' }}>{isOver ? `⚠ vượt ${t3(total - capKg)} tấn` : `✓ còn trống ${t3(capKg - total)} tấn`}</span>}</label>
        <label className="field"><span>Ghi chú cho vận tải</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <p className="small" style={{ margin: '8px 0 4px' }}>Xe, tài xế (nếu biết; để trống thì vận tải / tài xế tự nhập):</p>
      <PlateDriver carrier={carrier.code} value={v} onChange={(p) => setV((x) => ({ ...x, ...p }))} />
      {isOver && <label className="small" style={{ display: 'block', marginTop: 6 }}><input type="checkbox" checked={over} onChange={(e) => setOver(e.target.checked)} /> Vẫn tạo dù vượt tải trọng</label>}
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={() => onClose()}>Thôi</button>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang tạo…' : '🚚 Tạo Shipment & gửi vận tải'}</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// ✂ Tách DO theo số tấn mỗi xe vận tải đề xuất: DO đầu giữ phần xe 1, sinh DO mới cho các xe sau (cùng SO, cùng điểm giao)
function SplitDO({ row, carrier, materialize, onClose }) {
  const { email, name } = useApp();
  const total = row.kg;
  const [each, setEach] = useState('');
  const [loads, setLoads] = useState(['', '']);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const kgs = loads.map((x) => Math.round(n(x) * 1000));
  const sum = kgs.reduce((a, b) => a + b, 0);
  const plan = useMemo(() => splitLoads(row.items.map((i, k) => ({ ...i, key: k })), kgs.filter((k) => k > 0)), [row, loads]); // eslint-disable-line react-hooks/exhaustive-deps
  const fill = () => {
    const c = n(each) * 1000;
    if (!c) return;
    const out = []; let left = total;
    while (left > 0.5 && out.length < 50) { const k = Math.min(c, left); out.push(String(Math.round(k) / 1000)); left -= k; }
    setLoads(out.length ? out : ['']);
  };
  const isPlan = row.src === 'plan';
  const save = async () => {
    setErr('');
    const used = kgs.filter((k) => k > 0);
    if (used.length < (isPlan ? 2 : 1)) return setErr(isPlan ? 'Nhập số tấn cho ít nhất 2 xe.' : 'Nhập số tấn cho ít nhất 1 xe.');
    if (sum > total + 1) return setErr(`Tổng ${t3(sum)} tấn nhiều hơn DO (${t3(total)} tấn).`);
    if (isPlan && (row.plan.lines || []).some((l) => n(l.doneKg) > 0)) return setErr('DO đã lập phiếu xuất một phần: không tách được. Gửi phần còn lại bằng Shipment hoặc lập DO mới.');
    setBusy(true);
    try {
      const user = { email, name };
      const made = [];
      if (isPlan) {
        const p = row.plan;
        const head = { orderId: p.orderId, orderRef: p.orderRef || '', company: p.company || '', partyCode: p.partyCode || '', partyName: p.partyName || '',
          sales: p.sales || '', salesName: p.salesName || '', date: p.date || today(), note: p.note || '', carrier: p.carrier || row.carrier || '', parentDo: p.id };
        const moved = {}; // orderLine#shipCode → kg chuyển sang DO mới
        for (const part of plan.slice(1)) {
          if (!part.length) continue;
          const lines = part.map((it) => {
            const pl = (p.lines || []).find((l) => l.orderLine === it.no && (l.shipCode || '') === (it.shipCode || '')) || {};
            moved[`${it.no}#${it.shipCode || ''}`] = (moved[`${it.no}#${it.shipCode || ''}`] || 0) + it.kg;
            return { orderLine: it.no, item: it.item, itemName: it.itemName || '', qtyKg: it.kg, shipCode: it.shipCode || '', shipAddress: pl.shipAddress || it.address || '', packing: pl.packing || '', warehouse: pl.warehouse || row.warehouse || '' };
          });
          made.push(await createPlan({ ...head, lines }, user));
        }
        const lines = (p.lines || []).map((l) => { const k = moved[`${l.orderLine}#${l.shipCode || ''}`]; return k ? { ...l, qtyKg: Math.max(0, Math.round(n(l.qtyKg) - k)) } : l; }).filter((l) => n(l.qtyKg) > 0 || n(l.doneKg) > 0);
        await updatePlan(p.id, { lines, splitInto: [...(p.splitInto || []), ...made],
          history: [...(p.history || []), { at: nowISO(), by: email, byName: name, action: `Tách DO: giữ ${t3(kgs[0])} tấn, sinh ${made.join(', ')}` }] }, user);
        onClose(`Đã tách ${p.id}: giữ ${t3(kgs[0])} tấn, thêm ${made.length} DO mới (${made.join(', ')}).`);
      } else {
        for (const part of plan) if (part.length) made.push(await materialize(row, row.carrier, part, `Tách theo tải trọng xe từ ${row.orderId}`));
        onClose(`Đã tạo ${made.length} DO từ ${row.orderId}: ${made.join(', ')}${sum < total - 1 ? ` · còn ${t3(total - sum)} tấn chưa có DO` : ''}.`);
      }
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền tạo / sửa DO.' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`✂ Tách DO · ${row.srcLabel}`} onClose={() => onClose()} wide>
      <p className="small">{pointText(row)} · {row.items.map((i) => `${i.item} ${t3(i.kg)} t`).join(' · ')} · <b>Tổng {t3(total)} tấn</b>{carrier ? ` · ${carrier.name || carrier.code}` : ''}</p>
      <div className="filters">
        <label>Mỗi xe chở (tấn) <input type="number" step="0.5" value={each} onChange={(e) => setEach(e.target.value)} style={{ width: 90 }} /></label>
        <button type="button" className="btn" onClick={fill}>⟳ Chia đều theo tải trọng</button>
        <button type="button" className="btn ghost" onClick={() => setLoads((l) => [...l, ''])}>+ Thêm xe</button>
        <span className={Math.abs(sum - total) > 1 ? 'badge amber' : 'badge green'}>Đã chia {t3(sum)} / {t3(total)} tấn</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Xe</th><th className="num">Tấn (vận tải đề xuất)</th><th>Hàng trên xe</th><th>Kết quả</th><th></th></tr></thead>
        <tbody>{loads.map((x, i) => {
          const part = plan[kgs.slice(0, i).filter((k) => k > 0).length] || [];
          return (
            <tr key={i}><td>{i + 1}</td>
              <td><input type="number" step="0.001" value={x} onChange={(e) => setLoads((l) => l.map((y, j) => (j === i ? e.target.value : y)))} style={{ width: 100 }} /></td>
              <td className="small">{kgs[i] > 0 ? part.map((it) => `${it.item} ${t3(it.kg)} t`).join(' · ') : ''}</td>
              <td className="small">{kgs[i] > 0 ? (isPlan && i === kgs.findIndex((k) => k > 0) ? `giữ trong ${row.srcId}` : 'DO mới') : ''}</td>
              <td><button type="button" className="btn ghost sm" disabled={loads.length === 1} onClick={() => setLoads((l) => l.filter((_, j) => j !== i))}>✕</button></td></tr>
          );
        })}</tbody>
      </table></div>
      {sum < total - 1 && <p className="small">Còn {t3(total - sum)} tấn chưa chia: {isPlan ? `giữ trong ${row.srcId}` : 'để lại trên SO (chưa có DO)'}.</p>}
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={() => onClose()}>Thôi</button>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang tách…' : '✂ Tách DO'}</button></div>
    </Modal>
  );
}
