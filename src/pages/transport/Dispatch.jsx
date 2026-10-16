import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { usePlans } from '../../lib/shipPlans';
import { useMovesRange } from '../../lib/slips';
import { KIND_LABEL, SRC_LABEL, isSelfPickup, kindText, pendingDispatch, pickupFrom, usesVehicleList } from '../../lib/dispatch';
import PickupSelect from '../../components/PickupSelect';
import { createPlannedTrips } from '../../lib/transport';
import { fmtDate, fmtNum, norm, today } from '../../lib/utils';
import { Empty, ErrorBox } from '../../components/ui';
import Select from '../../components/Select';
import { WithAdd } from '../../components/FormTools';

const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
const t3 = (kg) => fmtNum(n(kg) / 1000, 3);
const daysAgo = (k) => { const d = new Date(); d.setDate(d.getDate() - k); return d.toISOString().slice(0, 10); };

// ---------------------------------------------------------------------------
// Chờ giao vận tải (quản trị): hàng đã chỉ định đơn vị vận tải ở Dự kiến xuất / Kế hoạch phân bổ / SO, STO / phiếu xuất
// nhưng chưa giao. Admin kiểm tra (đổi đơn vị nếu chỉ định sai) rồi bấm Giao vận tải từng chuyến hoặc toàn bộ.
// Đơn vị vận tải chỉ thấy chuyến sau khi admin giao, nên chỉ định sai thì sửa được trước khi họ nhận.
export default function Dispatch({ orders, trips, onSplit }) {
  const { email, name } = useApp();
  const carriers = useCollection('carriers').rows;
  const warehouses = useCollection('warehouses').rows;
  const shipto = useCollection('shipto').rows;
  const vehicles = useCollection('vehicles').rows;
  const points = useCollection('pickupPoints').rows;
  const plans = usePlans().rows;
  const moves = useMovesRange(daysAgo(30), '9999').rows;
  const [allocs, setAllocs] = useState([]);
  useEffect(() => onSnapshot(query(collection(db, 'allocations'), where('status', '==', 'ordered')),
    (s) => setAllocs(s.docs.map((d) => ({ ...d.data(), _id: d.id }))), () => setAllocs([])), []);
  const all = useMemo(() => pendingDispatch({ orders, plans, allocs, moves, trips, shipto }), [orders, plans, allocs, moves, trips, shipto]);
  const [f, setF] = useState({ q: '', src: '', carrier: '' });
  const [over, setOver] = useState({}); // đổi đơn vị vận tải / ngày / số xe trước khi giao
  const [sel, setSel] = useState({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const car = (code) => carriers.find((c) => c.code === code);
  const val = (r) => ({ carrier: r.carrier, date: r.date && r.date > today() ? r.date : today(), plate: '', driverName: '', ...(over[r.key] || {}) });
  const setO = (k, p) => setOver((m) => ({ ...m, [k]: { ...(m[k] || {}), ...p } }));
  const rows = all.filter((r) => (!f.src || r.src === f.src) && (!f.carrier || val(r).carrier === f.carrier)
    && (!f.q || norm([r.srcLabel, r.orderId, r.partyCode, r.partyName, r.shipCode, r.warehouse, r.carrier, ...r.items.map((i) => `${i.item} ${i.itemName}`)].join(' ')).includes(norm(f.q))));
  const chosen = rows.filter((r) => sel[r.key]);

  const release = async (list) => {
    setErr(''); setMsg('');
    const bad = list.find((r) => !car(val(r).carrier));
    if (bad) return setErr(`${bad.srcLabel}: chưa chọn đơn vị vận tải.`);
    setBusy(true);
    let done = 0;
    try {
      for (const r of list) {
        const v = val(r);
        const wh = warehouses.find((w) => w.code === r.warehouse) || { code: r.warehouse };
        await createPlannedTrips({ wh, carrier: car(v.carrier), trips: [{ date: v.date, plate: v.plate, driverName: v.driverName, company: r.company, pickup: pickupFrom(v.pickup, points, shipto), lines: r.items, }] }, { email, name }, 'Giao vận tải');
        done += 1;
      }
      setMsg(`Đã giao ${done} chuyến cho đơn vị vận tải.`);
      setSel({});
    } catch (e) { setErr(`${done ? `Đã giao ${done} chuyến. ` : ''}${e.code === 'permission-denied' ? 'Không có quyền tạo chuyến.' : e.message}`); }
    setBusy(false);
  };
  // Chia 1 dòng (hoặc nhiều dòng cùng kho, cùng đơn vị) thành nhiều xe
  const split = () => {
    const c = car(val(chosen[0]).carrier);
    if (!c) return setErr('Chọn đơn vị vận tải trước khi chia xe.');
    if (chosen.some((r) => r.warehouse !== chosen[0].warehouse || val(r).carrier !== c.code)) return setErr('Chia nhiều xe: chọn các dòng cùng kho xuất và cùng đơn vị vận tải.');
    onSplit({ carrier: c, action: 'Giao vận tải', rows: chosen.flatMap((r) => r.items.map((i, k) => ({ ...i, key: `${r.key}#${k}`, rest: i.kg, due: val(r).date, warehouse: r.warehouse, company: r.company }))), done: () => setSel({}) });
  };

  return (
    <div>
      <p className="hint">Hàng đã chỉ định đơn vị vận tải ở <b>Dự kiến xuất kho</b>, <b>Kế hoạch phân bổ</b>, <b>SO / STO</b> hoặc <b>phiếu xuất</b> nằm ở đây chờ bạn kiểm tra. Đơn vị vận tải <b>chưa thấy</b> các dòng này: chỉ định sai thì đổi ngay trên dòng, đúng rồi bấm <b>Giao vận tải</b> (mỗi dòng 1 chuyến) hoặc <b>Chia nhiều xe</b>.</p>
      <div className="filters">
        <input type="search" placeholder="Tìm đơn, khách, mã giao, mã hàng, kho…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ flex: 1 }} />
        <Select value={f.src} onChange={(e) => setF({ ...f, src: e.target.value })}><option value="">Mọi nguồn</option>{Object.entries(SRC_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Select value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })}><option value="">Mọi đơn vị vận tải</option>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</Select>
        <button className="btn primary" disabled={busy || !chosen.length} onClick={() => release(chosen)}>🚚 Giao vận tải{chosen.length ? ` (${chosen.length} chuyến)` : ''}</button>
        <button className="btn" disabled={busy || !chosen.length} onClick={split} title="Hàng nhiều hơn 1 xe: chia thành nhiều chuyến">✂ Chia nhiều xe</button>
        <button className="btn" disabled={busy || !rows.length} onClick={() => window.confirm(`Giao toàn bộ ${rows.length} chuyến đang hiển thị cho đơn vị vận tải?`) && release(rows)}>Giao toàn bộ ({rows.length})</button>
      </div>
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <ErrorBox error={err} />
      <div className="table-wrap">
        {!rows.length ? <Empty text="Không có hàng nào chờ giao vận tải." /> : (
          <table>
            <thead><tr><th><input type="checkbox" checked={chosen.length === rows.length} onChange={(e) => setSel(e.target.checked ? Object.fromEntries(rows.map((r) => [r.key, true])) : {})} /></th>
              <th>Nguồn</th><th>Ngày đi</th><th>Điểm nhận hàng</th><th>Giao đến</th><th>Hàng</th><th className="num">Tấn</th><th>Đơn vị vận tải</th><th>Số xe (nếu biết)</th><th></th></tr></thead>
            <tbody>{rows.map((r) => {
              const v = val(r); const c = car(v.carrier);
              return (
                <tr key={r.key} className={sel[r.key] ? 'picked' : ''}>
                  <td><input type="checkbox" checked={!!sel[r.key]} onChange={() => setSel((s) => ({ ...s, [r.key]: !s[r.key] }))} /></td>
                  <td className="small">{r.srcLabel}{r.src !== 'order' ? <div className="mono">{r.orderId}</div> : null}</td>
                  <td><input type="date" value={v.date} onChange={(e) => setO(r.key, { date: e.target.value })} />{r.date && r.date !== v.date ? <div className="small">kế hoạch {fmtDate(r.date)}</div> : null}</td>
                  <td>{r.warehouse ? <span className="small">Kho {r.warehouse}</span> : <span className="small">chưa có kho</span>}
                    <PickupSelect value={v.pickup} onChange={(x) => setO(r.key, { pickup: x })} whLabel={warehouses.find((w) => w.code === r.warehouse)?.name || r.warehouse || 'Kho xuất'} points={points} shipto={shipto} style={{ marginTop: 2, maxWidth: 230 }} /></td>
                  <td>{r.partyName || r.partyCode}{r.shipCode ? <div className="small">{r.shipCode}{r.address ? ` · ${r.address}` : ''}</div> : null}</td>
                  <td className="small">{r.items.map((i) => <div key={`${i.no}${i.item}`}>{i.item} {t3(i.kg)} t</div>)}</td>
                  <td className="num"><b>{t3(r.kg)}</b></td>
                  <td><WithAdd cat="carriers" onAdded={(id) => setO(r.key, { carrier: id })}><Select value={v.carrier} onChange={(e) => setO(r.key, { carrier: e.target.value })} style={v.carrier !== r.carrier ? { borderColor: 'var(--amber)' } : undefined}>
                    <option value="">-- Chọn --</option>{carriers.filter((x) => x.active !== false || x.code === v.carrier).map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}</option>)}</Select></WithAdd>
                    {c ? <div className="small" title={KIND_LABEL[c.kind] || ''}>{kindText(c)}{v.carrier !== r.carrier ? ` · đã đổi từ ${r.carrier}` : ''}</div> : null}</td>
                  <td><input list={`dl-dp-${v.carrier}`} value={v.plate} placeholder={isSelfPickup(c) ? 'xe khách' : ''} onChange={(e) => setO(r.key, { plate: e.target.value.toUpperCase() })} style={{ width: 110 }} /></td>
                  <td><button className="btn primary sm" disabled={busy} onClick={() => release([r])}>Giao</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {carriers.filter(usesVehicleList).map((c) => <datalist key={c.code} id={`dl-dp-${c.code}`}>{vehicles.filter((x) => x.carrier === c.code).map((x) => <option key={x.plate} value={x.plate}>{x.vehicleType}</option>)}</datalist>)}
    </div>
  );
}
