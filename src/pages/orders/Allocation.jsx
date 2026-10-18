import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useCollections, useOpCompany, useOrders } from '../../lib/hooks';
import { CompanyPicker } from '../../components/TripBits';
import { Empty, ErrorBox, Modal } from '../../components/ui';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, norm, today } from '../../lib/utils';
import { OPEN_STATUSES, leftKg, lineShip, lineWh } from '../../lib/orders';
import { deleteOrRequest } from '../../lib/deletes';
import { usePref } from '../../lib/prefs';
import {
  ALLOC_STATUS, CONT_KEYS, DEST_TYPES, planNeedsLocation, addAllocations, addRows, updateRows, allocStatus, allocatedByPoLine, attachToOrder, cancelAllocation, createOrderFromGroup,
  detachFromOrder, groupForOrders, setCarrier, missingForOrder, poKey, updateAllocation,
} from '../../lib/allocations';
import { WithAdd } from '../../components/FormTools';
import Select from '../../components/Select';
import { salesFor } from '../../lib/plasticSales';

const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const kg = (v) => fmtNum(n(v), 2);
const tn = (v) => `= ${fmtNum(n(v) / 1000, 3)} tấn`;

// Trang Kế hoạch phân bổ hàng mua: tab Kế hoạch (các dòng phân bổ) và Hàng mua chưa phân bổ (dòng PO còn phần chưa chia)
export default function Allocation() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'chua' ? 'chua' : 'ke-hoach';
  const { hasRole, email, name } = useApp();
  const canManage = hasRole('kinh_doanh', 'ke_toan');
  const allocState = useCollection('allocations');
  const { rows: orders, error: oErr } = useOrders('');
  const cats = useCollections(['soldto', 'shipto', 'warehouses', 'carriers', 'locations', 'items']);
  const [co, setCo] = useOpCompany();
  const user = { email, name };
  const orderMap = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const allocs = allocState.rows;
  const allocated = useMemo(() => allocatedByPoLine(allocs), [allocs]);
  const pos = useMemo(() => orders.filter((o) => o.type === 'PO' && o.status !== 'cancelled' && !o.direct), [orders]);
  const received = usePoReceipts(pos);
  useFillReceived(allocs, received, canManage, user);
  const ctx = { canManage, user, cats, orderMap, orders, allocs, allocated, co, received };
  const nOpenPo = useMemo(() => pos.filter((o) => !co || o.company === co).flatMap((o) => o.lines.filter((l) => n(l.qtyKg) - (allocated.get(poKey(o.id, l.no)) || 0) > 0.001)).length, [pos, allocated, co]);

  return (
    <div>
      <div className="page-head">
        <h1>📋 Kế hoạch phân bổ hàng mua</h1>
        <div className="seg">
          <button type="button" className={tab === 'ke-hoach' ? 'on' : ''} onClick={() => setParams({ tab: 'ke-hoach' })}>Kế hoạch phân bổ</button>
          <button type="button" className={tab === 'chua' ? 'on' : ''} onClick={() => setParams({ tab: 'chua' })}>Hàng mua chưa phân bổ{nOpenPo ? ` (${nOpenPo})` : ''}</button>
        </div>
      </div>
      <p className="hint">Mỗi dòng PO được chia thành các dòng kế hoạch theo cont. 1 cont có thể gồm nhiều mã hàng (nhiều dòng PO): các mã cùng số cont được gom thành 1 cont, sửa điểm giao một lần ở dòng cont. Dòng <b>giao khách</b> sẽ thành đơn bán (SO) xuất từ nơi nhận hàng, dòng <b>về kho mình</b> thành lệnh chuyển kho (STO) từ nơi nhận hàng tới kho đó. Nơi nhận = kho nhập trên dòng PO (kho cảng / KNQ); hàng đã nhập kho thì tự lấy kho và vị trí đã nhập, không phải chọn lại.</p>
      <ErrorBox error={allocState.error || oErr} />
      {tab === 'chua' ? <OpenPoLines {...ctx} pos={pos} setCo={setCo} /> : <Plan {...ctx} pos={pos} setCo={setCo} />}
    </div>
  );
}


// Hàng của dòng PO đã nhập kho (phiếu nhập theo PO): kho / vị trí thực nhận, key poKey(PO, dòng)
function usePoReceipts(pos) {
  const ids = useMemo(() => pos.filter((o) => o.lines.some((l) => n(l.doneKg) > 0)).map((o) => o.id).sort().join(','), [pos]);
  const [map, setMap] = useState(() => new Map());
  useEffect(() => {
    let live = true;
    const list = ids ? ids.split(',') : [];
    const chunks = [];
    for (let i = 0; i < list.length; i += 30) chunks.push(list.slice(i, i + 30));
    Promise.all(chunks.map((c) => getDocs(query(collection(db, 'movements'), where('orderId', 'in', c))))).then((snaps) => {
      const m = new Map();
      for (const s of snaps) for (const d of s.docs) {
        const mv = d.data();
        if (mv.type !== 'in' || mv.orderType !== 'PO' || mv.status === 'cancelled') continue;
        for (const l of mv.lines || []) {
          const k = poKey(mv.orderId, l.orderLine);
          const r = m.get(k) || { whs: new Set(), locs: new Set(), kg: 0 };
          r.whs.add(mv.warehouse);
          if (l.location) r.locs.add(l.location);
          r.kg += Math.abs(n(l.kg));
          m.set(k, r);
        }
      }
      if (live) setMap(m);
    }).catch(() => {});
    return () => { live = false; };
  }, [ids]);
  return map;
}

// Kho / vị trí nhận thực tế của dòng PO (chỉ khi nhập về đúng 1 kho, 1 vị trí)
export function receivedAt(received, a) {
  const r = received?.get(poKey(a.poId, a.poLine));
  if (!r || r.whs.size !== 1) return null;
  return { warehouse: [...r.whs][0], location: r.locs.size === 1 ? [...r.locs][0] : '', kg: r.kg };
}

// Dòng kế hoạch chưa tạo đơn: hàng đã nhập kho thì lấy luôn kho / vị trí đã nhập, không bắt chọn lại
function useFillReceived(allocs, received, canManage, user) {
  const done = useRef(new Set());
  useEffect(() => {
    if (!canManage || !received.size) return;
    const fix = [];
    for (const a of allocs) {
      if (a.status !== 'draft' || a.orderId) continue;
      const r = receivedAt(received, a);
      if (!r) continue;
      const patch = {};
      if (a.fromWarehouse !== r.warehouse) Object.assign(patch, { fromWarehouse: r.warehouse, fromLocation: r.location });
      else if (!a.fromLocation && r.location) patch.fromLocation = r.location;
      const key = `${a._id}|${patch.fromWarehouse || ''}|${patch.fromLocation || ''}`;
      if (Object.keys(patch).length && !done.current.has(key)) { done.current.add(key); fix.push([a, patch]); }
    }
    fix.forEach(([a, patch]) => updateRows([a], patch, user).catch(() => {}));
  }, [allocs, received, canManage]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------------------------------------------------------------------------
// Dòng PO còn phần chưa phân bổ
function OpenPoLines({ pos, allocated, co, setCo, canManage, user, received, orders, allocs }) {
  const rcv = (o, l) => receivedAt(received, { poId: o.id, poLine: l.no });
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [split, setSplit] = useState(null);
  const [pick, setPick] = useState({}); // dòng PO tick chọn để gom vào 1 cont nhiều mã
  const [cont, setCont] = useState(null);
  const rows = useMemo(() => {
    const f = norm(q);
    return pos.filter((o) => !co || o.company === co).flatMap((o) => o.lines.map((l) => {
      const done = allocated.get(poKey(o.id, l.no)) || 0;
      return { o, l, done, left: Math.max(0, n(l.qtyKg) - done) };
    }))
      .filter((r) => all || r.left > 0.001)
      .filter((r) => !f || norm([r.o.id, r.o.refNo, r.o.partyCode, r.o.partyName, r.l.item, r.l.itemName, lineWh(r.o, r.l, 'in')].join(' ')).includes(f))
      .sort((a, b) => String(a.l.dueDate || a.o.dueDate || '9999').localeCompare(String(b.l.dueDate || b.o.dueDate || '9999')));
  }, [pos, allocated, co, q, all]);
  const sum = rows.reduce((s, r) => s + r.left, 0);
  const picked = rows.filter((r) => pick[poKey(r.o.id, r.l.no)] && r.left > 0.001);
  const togglePick = (k) => setPick((m) => ({ ...m, [k]: !m[k] }));
  return (
    <div>
      {canManage && (
        <div className="cont-callout">
          <b>📦 1 cont có nhiều mã hàng?</b> Tick các dòng PO đi chung cont ở cột đầu bảng rồi bấm <b>Gom vào 1 cont</b> (sửa số kg từng mã nếu chỉ lấy một phần).
          Cont chỉ 1 mã hàng thì bấm <b>Phân bổ</b> ở cuối dòng.
          <button className="btn primary" disabled={!picked.length} onClick={() => setCont(Object.fromEntries(picked.map((r) => [poKey(r.o.id, r.l.no), String(r.left)])))}>
            📦 Gom {picked.length || ''} dòng đã chọn vào 1 cont</button>
        </div>
      )}
      <div className="filters">
        <CompanyPicker value={co} onChange={setCo} />
        <input type="search" placeholder="Tìm số PO, BCT, nhà cung cấp, mã hàng, kho…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Hiện cả dòng đã phân bổ hết</label>
        <span className="small" style={{ marginLeft: 'auto' }}>Còn chưa phân bổ: <b>{kg(sum)} kg</b> ({tn(sum)})</span>
      </div>
      <div className="table-wrap">
        {!rows.length ? <Empty text="Không có dòng PO nào còn chưa phân bổ." /> : (
          <table>
            <thead><tr><th title="Chọn để gom vào 1 cont nhiều mã">📦</th><th>Số PO</th><th>Số Ecount / BCT</th><th>Công ty</th><th>Nhà cung cấp</th><th>ETA</th><th>Nơi nhận (kho nhập)</th><th>Mã hàng</th><th>Tên hàng</th>
              <th className="num">Đặt (kg)</th><th className="num">Đã nhận (kg)</th><th className="num">Đã phân bổ (kg)</th><th className="num">Chưa phân bổ (kg)</th><th></th></tr></thead>
            <tbody>{rows.map(({ o, l, done, left }) => (
              <tr key={poKey(o.id, l.no)} className={pick[poKey(o.id, l.no)] ? 'picked' : ''}>
                <td>{canManage && left > 0.001 && <input type="checkbox" checked={!!pick[poKey(o.id, l.no)]} onChange={() => togglePick(poKey(o.id, l.no))} />}</td>
                <td className="mono nowrap">{o.id}</td><td className="mono">{o.refNo}</td><td><b>{o.company}</b></td><td>{o.partyName || o.partyCode}</td>
                <td className="nowrap">{fmtDate(l.dueDate || o.dueDate)}</td><td>{rcv(o, l) ? <>{rcv(o, l).warehouse}{rcv(o, l).location ? ` · ${rcv(o, l).location}` : ''} <span className="small" style={{ color: 'var(--green)' }}>đã nhập</span></> : lineWh(o, l, 'in') || <span className="req">chưa ghi kho nhập</span>}</td>
                <td>{l.item}</td><td>{l.itemName}</td><td className="num">{kg(l.qtyKg)}</td><td className="num">{kg(l.doneKg)}</td>
                <td className="num">{kg(done)}</td><td className="num"><b>{kg(left)}</b><div className="small">{tn(left)}</div></td>
                <td>{canManage && left > 0.001 && <button className="btn sm primary" onClick={() => setSplit({ o, l, left })}>Phân bổ</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {split && <SplitModal {...split} user={user} orders={orders} allocs={allocs} rcv={rcv(split.o, split.l)} onClose={() => setSplit(null)} />}
      {cont && <ContModal preset={cont} pos={pos} allocated={allocated} user={user} onClose={(ok) => { setCont(null); if (ok) setPick({}); }} />}
    </div>
  );
}

// Chia 1 dòng PO: theo cont (hàng nhập khẩu) hoặc theo số lượng cho từng đơn bán, phần còn lại về kho (hàng mua nội địa)
function SplitModal(props) {
  const [mode, setMode] = usePref('alloc-split-mode', 'cont');
  const { o, l, onClose } = props;
  const head = (
    <div className="seg wrap" style={{ marginBottom: 8 }}>
      <button type="button" className={mode === 'cont' ? 'on' : ''} onClick={() => setMode('cont')}>📦 Theo cont (hàng nhập khẩu)</button>
      <button type="button" className={mode === 'qty' ? 'on' : ''} onClick={() => setMode('qty')}>⚖️ Theo số lượng / đơn bán (mua nội địa)</button>
    </div>
  );
  return (
    <Modal title={`Phân bổ ${o.id} – ${l.item}`} onClose={onClose} wide={mode === 'qty'}>
      {head}
      {mode === 'qty' ? <QtySplit {...props} /> : <ContSplit {...props} />}
    </Modal>
  );
}

// Hàng mua nội địa: không chia cont. Chia kg cho các đơn bán đang mở (gắn luôn SO), khách chưa có SO, phần còn lại về kho
function QtySplit({ o, l, left, user, orders, allocs, rcv, onClose }) {
  const soldto = useCollection('soldto').rows;
  const whs = useCollection('warehouses').rows.filter((w) => w.active !== false);
  const fromWh = rcv?.warehouse || lineWh(o, l, 'in') || '';
  const planned = useMemo(() => {
    const m = new Map();
    for (const x of allocs) if (x.orderId && x.status !== 'cancelled') m.set(`${x.orderId}__${x.orderLine}`, (m.get(`${x.orderId}__${x.orderLine}`) || 0) + n(x.qtyKg));
    return m;
  }, [allocs]);
  const sos = useMemo(() => orders.filter((x) => x.type === 'SO' && OPEN_STATUSES.includes(x.status) && x.company === o.company)
    .flatMap((x) => x.lines.filter((y) => y.item === l.item).map((y) => ({ o: x, l: y, need: Math.max(0, leftKg(y) - (planned.get(`${x.id}__${y.no}`) || 0)) })))
    .filter((r) => r.need > 0.001)
    .sort((a, b) => String(a.l.dueDate || a.o.dueDate || '9999').localeCompare(String(b.l.dueDate || b.o.dueDate || '9999'))), [orders, o, l, planned]);
  const [soKg, setSoKg] = useState({}); // `SO__dòng` → kg ('' = không lấy)
  const [q, setQ] = useState('');
  const [free, setFree] = useState([]); // giao khách chưa có SO: { partyCode, kg }
  const [restWh, setRestWh] = useState(fromWh);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const usedSo = Object.values(soKg).reduce((s, v) => s + n(v), 0);
  const usedFree = free.reduce((s, r) => s + n(r.kg), 0);
  const rest = Math.round((left - usedSo - usedFree) * 1000) / 1000;
  const toggle = (r) => {
    const k = `${r.o.id}__${r.l.no}`;
    setSoKg((m) => {
      if (m[k] !== undefined) { const { [k]: _, ...x } = m; return x; }
      const avail = Math.max(0, left - Object.values(m).reduce((s, v) => s + n(v), 0) - usedFree);
      return { ...m, [k]: String(Math.round(Math.min(r.need, avail) * 1000) / 1000) };
    });
  };
  const go = async () => {
    setErr('');
    if (rest < -0.001) return setErr(`Tổng chia ${kg(usedSo + usedFree)} kg vượt phần chưa phân bổ ${kg(left)} kg.`);
    for (const r of free) if (!r.partyCode || !(n(r.kg) > 0)) return setErr('Dòng giao khách chưa có SO: chọn khách và nhập số kg.');
    if (rest > 0.001 && !restWh) return setErr('Chọn kho nhận phần còn lại.');
    const parts = [];
    for (const r of sos) {
      const v = soKg[`${r.o.id}__${r.l.no}`];
      if (!(n(v) > 0)) continue;
      parts.push({ qtyKg: n(v), fromWarehouse: fromWh, date: r.l.dueDate || r.o.dueDate || '', destType: 'customer', partyCode: r.o.partyCode || '', partyName: r.o.partyName || '', shipCode: lineShip(r.o, r.l) || '',
        extra: { orderId: r.o.id, orderType: 'SO', orderLine: r.l.no, status: 'ordered', attached: true } });
    }
    for (const r of free) parts.push({ qtyKg: n(r.kg), fromWarehouse: fromWh, destType: 'customer', partyCode: r.partyCode, partyName: soldto.find((c) => c.code === r.partyCode)?.name || '' });
    if (rest > 0.001) parts.push(restWh === fromWh ? { qtyKg: rest, fromWarehouse: fromWh, destType: 'keep' } : { qtyKg: rest, fromWarehouse: fromWh, destType: 'warehouse', toWarehouse: restWh });
    if (!parts.length) return setErr('Chưa chia số lượng nào.');
    setBusy(true);
    try { await addAllocations(o, l, parts, user); onClose(); }
    catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập kế hoạch phân bổ.' : e.message); setBusy(false); }
  };
  return (
    <>
      <p>{o.company} · {o.partyName || o.partyCode} · Nơi nhận <b>{fromWh || '–'}</b>{rcv ? ' (đã nhập)' : ''} · Chưa phân bổ <b>{kg(left)} kg</b> ({tn(left)})</p>
      <h3 style={{ margin: '8px 0 4px' }}>1. Giao cho đơn bán đang mở ({l.item}, công ty {o.company})</h3>
      {sos.length > 0 && <div className="filters"><input type="search" style={{ flex: 1 }} placeholder="Tìm số SO, khách hàng, mã giao, sale, ngày giao…" value={q} onChange={(e) => setQ(e.target.value)} /><span className="small">Đã chọn {Object.keys(soKg).length} SO</span></div>}
      {!sos.length ? <p className="small">Không có đơn bán đang mở nào còn thiếu {l.item}.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th></th><th>Số SO</th><th>Khách hàng</th><th>Ngày giao</th><th>Mã giao</th><th className="num">Còn cần (kg)</th><th className="num">Lấy từ PO này (kg)</th></tr></thead>
          <tbody>{sos.filter((r) => !q || soKg[`${r.o.id}__${r.l.no}`] !== undefined || soText(r.o, r.l).includes(norm(q))).map((r) => { const k = `${r.o.id}__${r.l.no}`; const on = soKg[k] !== undefined; return (
            <tr key={k} className={on ? 'picked' : ''}><td><input type="checkbox" checked={on} onChange={() => toggle(r)} /></td>
              <td className="mono">{r.o.id}</td><td>{r.o.partyName || r.o.partyCode}</td><td>{fmtDate(r.l.dueDate || r.o.dueDate)}</td><td>{lineShip(r.o, r.l)}</td>
              <td className="num">{kg(r.need)}</td>
              <td className="num">{on && <input type="number" step="any" min="0" style={{ width: 110 }} value={soKg[k]} onChange={(e) => setSoKg((m) => ({ ...m, [k]: e.target.value }))} />}</td></tr>); })}</tbody>
        </table></div>
      )}
      <h3 style={{ margin: '12px 0 4px' }}>2. Giao khách chưa có đơn bán (tạo SO sau ở bảng kế hoạch)</h3>
      {free.map((r, i) => (
        <div key={i} className="filters" style={{ marginBottom: 4 }}>
          <WithAdd cat="soldto" onAdded={(id, rec) => setFree((f) => f.map((x, j) => (j === i ? { ...x, partyCode: rec?.code || id } : x)))}>
            <Select value={r.partyCode} onChange={(e) => setFree((f) => f.map((x, j) => (j === i ? { ...x, partyCode: e.target.value } : x)))}>
              <option value="">-- Khách hàng --</option>{soldto.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}
            </Select></WithAdd>
          <input type="number" step="any" min="0" placeholder="kg" style={{ width: 120 }} value={r.kg} onChange={(e) => setFree((f) => f.map((x, j) => (j === i ? { ...x, kg: e.target.value } : x)))} />
          <button type="button" className="btn sm ghost" onClick={() => setFree((f) => f.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="btn sm" onClick={() => setFree((f) => [...f, { partyCode: '', kg: '' }])}>＋ Thêm khách</button>
      <h3 style={{ margin: '12px 0 4px' }}>3. Phần còn lại: <span style={{ color: rest < -0.001 ? 'var(--red)' : undefined }}>{kg(rest)} kg</span> <span className="small">{tn(rest)}</span></h3>
      {rest > 0.001 && (
        <label className="field"><span>Về kho</span>
          <WithAdd cat="warehouses" onAdded={(id) => setRestWh(id)}><Select value={restWh} onChange={(e) => setRestWh(e.target.value)}>
            <option value="">-- Chọn kho --</option>{whs.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}{w.code === fromWh ? ' (kho nhận, để tồn)' : ''}</option>)}
          </Select></WithAdd>
          <small className="small">{restWh && restWh === fromWh ? 'Hàng để tồn tại kho nhận, không cần lệnh chuyển kho.' : restWh ? `Tạo lệnh chuyển kho (STO) từ ${fromWh || 'nơi nhận'} về ${restWh}.` : ''}</small></label>
      )}
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={onClose}>Đóng</button><button className="btn primary" disabled={busy} onClick={go}>Tạo dòng kế hoạch</button></div>
    </>
  );
}

// Chia 1 dòng PO thành N dòng kế hoạch (chia đều theo số cont)
function ContSplit({ o, l, left, user, onClose }) {
  const [count, setCount] = useState(1);
  const [per, setPer] = useState(String(Math.round(left * 1000) / 1000));
  const [conts, setConts] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setN = (v) => { const c = Math.max(1, Math.min(200, Math.floor(n(v)) || 1)); setCount(c); setPer(String(Math.round((left / c) * 1000) / 1000)); };
  const contList = conts.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const total = count * n(per);
  const go = async () => {
    setErr('');
    if (!(n(per) > 0)) return setErr('Nhập số kg mỗi dòng.');
    if (total > left + 0.001) return setErr(`Tổng ${kg(total)} kg vượt phần chưa phân bổ ${kg(left)} kg.`);
    if (contList.length && contList.length !== count) return setErr(`Đã nhập ${contList.length} số cont, cần ${count} số (hoặc để trống).`);
    setBusy(true);
    try {
      await addAllocations(o, l, Array.from({ length: count }, (_, i) => ({ qtyKg: n(per), contNo: contList[i] || '' })), user);
      onClose();
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập kế hoạch phân bổ.' : e.message); setBusy(false); }
  };
  return (
    <>
      <p>{o.company} · {o.partyName || o.partyCode}{o.refNo ? <> · BCT <b>{o.refNo}</b></> : null} · Nơi nhận <b>{lineWh(o, l, 'in') || '–'}</b> · ETA {fmtDate(l.dueDate || o.dueDate)}</p>
      <p>Chưa phân bổ: <b>{kg(left)} kg</b> ({tn(left)})</p>
      <div className="form-grid">
        <label className="field"><span>Số dòng (số cont)</span><input type="number" min="1" value={count} onChange={(e) => setN(e.target.value)} /></label>
        <label className="field"><span>Số kg mỗi dòng</span><input type="number" step="any" value={per} onChange={(e) => setPer(e.target.value)} /><small className="small">{tn(per)}</small></label>
        <label className="field full"><span>Số cont (không bắt buộc, mỗi số cách nhau dấu phẩy hoặc xuống dòng)</span><textarea rows={2} value={conts} onChange={(e) => setConts(e.target.value)} /></label>
      </div>
      <p className="small">Tạo {count} dòng × {kg(per)} kg = <b>{kg(total)} kg</b>. Điểm giao để "Chưa chốt", chọn khách hoặc kho đến ở bảng kế hoạch.</p>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={onClose}>Đóng</button><button className="btn primary" disabled={busy} onClick={go}>Tạo dòng kế hoạch</button></div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Bảng kế hoạch phân bổ: sửa trực tiếp dòng nháp, chọn dòng → tạo SO / STO
const FILTERS = {
  draft: 'Chưa tạo đơn',
  tracking: 'Đã tạo đơn, chưa giao xong',
  done: 'Đã giao / để tồn kho nhận',
  '': 'Tất cả (trừ dòng đã hủy)',
  cancelled: 'Dòng đã hủy',
};
// Bảng tổng hợp phía trên kế hoạch: theo mã hàng + nơi nhận (theo đúng các dòng đang lọc)
function PlanSummary({ rows, whName, open, setOpen, onPick }) {
  const data = useMemo(() => {
    const m = new Map();
    for (const a of rows) {
      if (a.st === 'cancelled') continue;
      const k = `${a.item}|${a.fromWarehouse || ''}`;
      const r = m.get(k) || { item: a.item, itemName: a.itemName, wh: a.fromWarehouse || '', total: 0, customer: 0, warehouse: 0, keep: 0, pending: 0, draft: 0, ordered: 0, done: 0, customers: new Set() };
      const q = n(a.qtyKg);
      r.total += q;
      r[a.destType in r ? a.destType : 'pending'] += q;
      if (a.destType === 'customer' && (a.partyName || a.partyCode)) r.customers.add(a.partyName || a.partyCode);
      if (a.st === 'draft') r.draft += q; else if (['done', 'kept'].includes(a.st)) r.done += q; else r.ordered += q;
      m.set(k, r);
    }
    return [...m.values()].sort((x, y) => x.item.localeCompare(y.item) || x.wh.localeCompare(y.wh));
  }, [rows]);
  if (!rows.length) return null;
  const tot = data.reduce((s, r) => { for (const k of ['total', 'customer', 'warehouse', 'keep', 'pending', 'draft', 'ordered', 'done']) s[k] += r[k]; return s; },
    { total: 0, customer: 0, warehouse: 0, keep: 0, pending: 0, draft: 0, ordered: 0, done: 0 });
  const c = (v) => (v > 0.001 ? kg(v) : <span className="small">–</span>);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b>📊 Tổng hợp theo mã hàng và nơi nhận ({data.length} nhóm, theo các dòng đang lọc)</b>
        <button type="button" className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => setOpen(!open)}>{open ? 'Thu gọn' : 'Mở bảng tổng hợp'}</button>
      </div>
      {open && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>Mã hàng</th><th>Tên hàng</th><th>Nơi nhận</th><th className="num">Tổng (kg)</th><th className="num">Giao khách</th><th className="num">Về kho mình</th><th className="num">Để tồn kho nhận</th>
              <th className="num">Chưa chốt</th><th className="num">Nháp</th><th className="num">Đã tạo đơn</th><th className="num">Đã giao / để tồn</th><th>Khách hàng</th></tr></thead>
            <tbody>{data.map((r) => (
              <tr key={`${r.item}|${r.wh}`} style={{ cursor: 'pointer' }} title="Bấm để lọc bảng kế hoạch theo mã hàng + kho này" onClick={() => onPick(r.item, r.wh)}>
                <td><b>{r.item}</b></td><td className="small">{r.itemName}</td><td>{whName.get(r.wh) || r.wh || '–'}{whName.get(r.wh) ? <div className="small">{r.wh}</div> : null}</td>
                <td className="num"><b>{kg(r.total)}</b><div className="small">{tn(r.total)}</div></td><td className="num">{c(r.customer)}</td><td className="num">{c(r.warehouse)}</td><td className="num">{c(r.keep)}</td>
                <td className="num" style={r.pending > 0.001 ? { color: 'var(--amber)', fontWeight: 600 } : undefined}>{c(r.pending)}</td>
                <td className="num">{c(r.draft)}</td><td className="num">{c(r.ordered)}</td><td className="num">{c(r.done)}</td>
                <td className="small">{[...r.customers].join(', ')}</td></tr>
            ))}</tbody>
            {data.length > 1 && <tfoot><tr><th colSpan={3}>Cộng</th><th className="num">{kg(tot.total)}</th><th className="num">{kg(tot.customer)}</th><th className="num">{kg(tot.warehouse)}</th><th className="num">{kg(tot.keep)}</th>
              <th className="num">{kg(tot.pending)}</th><th className="num">{kg(tot.draft)}</th><th className="num">{kg(tot.ordered)}</th><th className="num">{kg(tot.done)}</th><th></th></tr></tfoot>}
          </table>
        </div>
      )}
    </div>
  );
}

function Plan({ allocs, orderMap, orders, allocated, pos, cats, co, setCo, canManage, user }) {
  const { isSuper } = useApp();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('draft');
  const [dest, setDest] = useState('');
  const [itemF, setItemF] = useState('');
  const [whF, setWhF] = useState('');
  const [showSum, setShowSum] = usePref('alloc-show-summary', true);
  const whName = useMemo(() => new Map((cats.warehouses || []).map((w) => [w.code, w.name || ''])), [cats.warehouses]);
  const [sel, setSel] = useState(() => new Set());
  const [creating, setCreating] = useState(false);
  const [attach, setAttach] = useState(null);
  const [contAdd, setContAdd] = useState(null); // 'new' | nhóm cont
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const rows = useMemo(() => {
    const f = norm(q);
    return allocs.map((a) => ({ ...a, st: allocStatus(a, orderMap) }))
      .filter((a) => !co || a.company === co)
      .filter((a) => !dest || a.destType === dest)
      .filter((a) => !itemF || a.item === itemF)
      .filter((a) => !whF || a.fromWarehouse === whF || a.toWarehouse === whF)
      .filter((a) => (filter === 'draft' ? a.st === 'draft' : filter === 'tracking' ? ['ordered', 'partial', 'orderGone'].includes(a.st)
        : filter === 'done' ? ['done', 'kept'].includes(a.st) : filter === 'cancelled' ? a.st === 'cancelled' : a.st !== 'cancelled'))
      .filter((a) => !f || norm([a.poId, a.bct, a.item, a.itemName, a.contNo, a.fromWarehouse, whName.get(a.fromWarehouse), a.fromLocation, a.partyCode, a.partyName, a.shipCode, a.toWarehouse, whName.get(a.toWarehouse), a.orderId, a.carrier, a.note].join(' ')).includes(f))
      .sort((x, y) => String(x.date || '9999').localeCompare(String(y.date || '9999')) || String(x.poId).localeCompare(String(y.poId)) || String(x.createdAt).localeCompare(String(y.createdAt)));
  }, [allocs, orderMap, co, dest, filter, q, itemF, whF, whName]);
  // Mã hàng / kho có trong kế hoạch (cho ô lọc)
  const itemOpts = useMemo(() => [...new Map(allocs.filter((a) => !co || a.company === co).map((a) => [a.item, a.itemName])).entries()].sort((x, y) => x[0].localeCompare(y[0])), [allocs, co]);
  const whOpts = useMemo(() => [...new Set(allocs.filter((a) => !co || a.company === co).flatMap((a) => [a.fromWarehouse, a.toWarehouse]).filter(Boolean))].sort(), [allocs, co]);
  // Gom các mã hàng cùng số cont (cùng công ty) thành 1 cont; dòng chưa có số cont đứng riêng
  const groups = useMemo(() => {
    const m = new Map();
    for (const a of rows) {
      const k = a.contNo ? `${a.company}|${a.contNo}` : `_${a._id}`;
      if (!m.has(k)) m.set(k, { key: k, rows: [] });
      m.get(k).rows.push(a);
    }
    return [...m.values()];
  }, [rows]);
  const saveGroup = async (g, patch) => {
    setErr('');
    try {
      const linked = g.rows.filter((a) => a.orderId && a.st !== 'cancelled');
      if ('carrier' in patch && linked.length) await setCarrier(linked, patch.carrier, user);
      const drafts = g.rows.filter((a) => ['draft', 'kept'].includes(a.st));
      if (drafts.length) await updateRows(drafts, patch, user);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền sửa kế hoạch phân bổ.' : e.message); }
  };
  const picked = rows.filter((a) => sel.has(a._id) && !missingForOrder(a));
  const toggle = (id) => setSel((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const ready = rows.filter((a) => !missingForOrder(a));
  const allOn = ready.length > 0 && ready.every((a) => sel.has(a._id));
  const sum = rows.reduce((s, a) => s + n(a.qtyKg), 0);
  const save = async (a, patch) => {
    setErr('');
    try { await (a.orderId && 'carrier' in patch ? setCarrier([a], patch.carrier, user) : updateAllocation(a._id, patch, user)); } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền sửa kế hoạch phân bổ.' : e.message); }
  };
  const setQty = (a, v) => {
    const po = orderMap.get(a.poId);
    const pl = po?.lines.find((l) => l.no === a.poLine);
    const others = allocatedByPoLine(allocs, a._id).get(poKey(a.poId, a.poLine)) || 0;
    const max = pl ? n(pl.qtyKg) * (1 + n(po.tolerancePct) / 100) - others : Infinity;
    if (!(n(v) > 0)) { setErr('Số lượng phải lớn hơn 0.'); return false; }
    if (n(v) > max + 0.001) { setErr(`Dòng ${a.item} của ${a.poId}: tối đa ${kg(max)} kg (PO đặt ${kg(pl.qtyKg)} kg, các dòng kế hoạch khác đã chia ${kg(others)} kg).`); return false; }
    save(a, { qtyKg: Math.round(n(v) * 1000) / 1000 });
    return true;
  };
  const cancel = async (a) => {
    setErr('');
    if (!window.confirm(`Hủy dòng kế hoạch ${a.item} ${kg(a.qtyKg)} kg${a.contNo ? ` (cont ${a.contNo})` : ''}? Phần này quay lại "Hàng mua chưa phân bổ".`)) return;
    try { await cancelAllocation(a, user); } catch (e) { setErr(e.message); }
  };
  const remove = async (a) => {
    if (!window.confirm('Xóa hẳn dòng kế hoạch đã hủy?')) return;
    try { await deleteOrRequest({ coll: 'allocations', id: a._id, label: `Phân bổ ${a.poId} ${a.item} ${kg(a.qtyKg)} kg`, data: a }, user, isSuper); } catch (e) { setErr(e.message); }
  };
  const exportExcel = () => exportSheets(`Ke_hoach_phan_bo_${today()}`, {
    'Kế hoạch phân bổ': (rows.length ? rows : [{}]).map((a) => ({
      'Ngày giao dự kiến': a.date || '', 'Số PO': a.poId || '', 'BCT / Số Ecount': a.bct || '', 'Công ty': a.company || '', 'Nhà cung cấp': a.supplierName || a.supplier || '',
      'Mã hàng': a.item || '', 'Tên hàng': a.itemName || '', 'Số lượng (kg)': n(a.qtyKg), 'Số cont': a.contNo || '', 'Nơi nhận': a.fromWarehouse || '', 'Tên nơi nhận': whName.get(a.fromWarehouse) || '', 'Vị trí nhận': a.fromLocation || '',
      'Điểm giao': DEST_TYPES[a.destType] || '', 'Khách hàng': a.partyName || a.partyCode || '', 'Mã giao': a.shipCode || '', 'Kho đến': a.toWarehouse || '', 'Tên kho đến': whName.get(a.toWarehouse) || '', 'Vị trí kho đến': a.toLocation || '',
      'Nhà vận chuyển': a.carrier || '', 'Số đơn': a.orderId || '', 'Trạng thái': ALLOC_STATUS[a.st]?.label || '', 'Ghi chú': a.note || '',
    })),
  });
  const whs = (cats.warehouses || []).filter((w) => w.active !== false);
  return (
    <div>
      <div className="stats">
        <div className="stat"><div className="stat-label">Số dòng đang hiển thị</div><div className="stat-value">{rows.length}</div></div>
        <div className="stat"><div className="stat-label">Tổng số lượng</div><div className="stat-value">{kg(sum)} kg</div><div className="stat-sub">{tn(sum)}</div></div>
        <div className="stat amber"><div className="stat-label">Dòng nháp chưa chốt điểm giao</div><div className="stat-value">{allocs.filter((a) => a.status === 'draft' && !a.orderId && a.destType === 'pending' && (!co || a.company === co)).length}</div></div>
      </div>
      <div className="filters">
        <CompanyPicker value={co} onChange={setCo} />
        <Select value={filter} onChange={(e) => { setFilter(e.target.value); setSel(new Set()); }}>
          {Object.entries(FILTERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <Select value={dest} onChange={(e) => setDest(e.target.value)}>
          <option value="">Mọi điểm giao</option>
          {Object.entries(DEST_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <Select value={itemF} searchable onChange={(e) => setItemF(e.target.value)} placeholder="Mọi mã hàng">
          <option value="">Mọi mã hàng</option>{itemOpts.map(([c, nm]) => <option key={c} value={c}>{c}{nm ? ` – ${nm}` : ''}</option>)}
        </Select>
        <Select value={whF} searchable onChange={(e) => setWhF(e.target.value)} placeholder="Mọi kho">
          <option value="">Mọi kho (nơi nhận / kho đến)</option>{whOpts.map((c) => <option key={c} value={c}>{whName.get(c) ? `${whName.get(c)} (${c})` : c}</option>)}
        </Select>
        <input type="search" style={{ flex: 1, minWidth: 260 }} placeholder="Tìm PO, BCT, mã / tên hàng, số cont, khách, tên kho, số đơn…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="actions" style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={exportExcel}>⬇ Excel</button>
          {canManage && <button className="btn cont-btn" onClick={() => setContAdd('new')} title="1 cont gồm nhiều mã hàng / nhiều dòng PO">📦 Lập cont nhiều mã hàng</button>}
          {canManage && <button className="btn primary" disabled={!picked.length} onClick={() => setCreating(true)}>Tạo đơn từ {picked.length} dòng đã chọn</button>}
        </div>
      </div>
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <ErrorBox error={err} />
      <PlanSummary rows={rows} whName={whName} open={showSum} setOpen={setShowSum} onPick={(item, wh) => { setItemF(item); setWhF(wh); }} />
      <datalist id="dl-alloc-soldto">{(cats.soldto || []).filter((c) => c.active !== false).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>
      <div className="table-wrap">
        {!rows.length ? <Empty text={filter === 'draft' ? 'Chưa có dòng kế hoạch nháp. Vào tab "Hàng mua chưa phân bổ" để chia dòng PO, hoặc bấm "＋ Cont nhiều mã hàng".' : 'Không có dòng nào.'} /> : (
          <table className="alloc-table">
            <thead><tr>
              <th>{canManage && ready.length > 0 && <input type="checkbox" checked={allOn} title="Chọn mọi dòng đủ thông tin" onChange={() => setSel(allOn ? new Set() : new Set(ready.map((a) => a._id)))} />}</th>
              <th>Số cont</th><th>Ngày giao</th><th>Nơi nhận / vị trí</th><th>Điểm giao</th><th>Khách hàng / Kho đến</th><th>Mã giao</th><th>Nhà vận chuyển</th>
              <th>PO / BCT</th><th>Công ty</th><th>Mã hàng</th><th className="num">Số lượng (kg)</th><th>Ghi chú</th><th>Trạng thái</th><th></th>
            </tr></thead>
            <tbody>{groups.map((g) => {
              const rowProps = (a, sub) => ({
                key: a._id, a, sub, edit: canManage && ['draft', 'kept'].includes(a.st), canManage, cats, whs,
                checked: sel.has(a._id), onCheck: () => toggle(a._id), save: (p) => save(a, p), setQty: (v) => setQty(a, v),
                onCancel: () => cancel(a), onRemove: () => remove(a), onAttach: () => setAttach(a),
                onDetach: () => detachFromOrder(a, user).catch((e) => setErr(e.message)),
              });
              if (g.rows.length === 1) return <AllocRow {...rowProps(g.rows[0], false)} />;
              const okRows = g.rows.filter((a) => !missingForOrder(a));
              const on = okRows.length > 0 && okRows.every((a) => sel.has(a._id));
              return [
                <ContRow key={g.key} g={g} canManage={canManage} cats={cats} whs={whs}
                  checked={on} onCheck={() => setSel((s0) => { const x = new Set(s0); okRows.forEach((a) => (on ? x.delete(a._id) : x.add(a._id))); return x; })}
                  save={(p) => saveGroup(g, p)} onAdd={() => setContAdd(g)} />,
                ...g.rows.map((a) => <AllocRow {...rowProps(a, true)} />),
              ];
            })}</tbody>
          </table>
        )}
      </div>
      {creating && <CreateOrders rows={picked} cats={cats} user={user} onClose={(m) => { setCreating(false); if (m) { setMsg(m); setSel(new Set()); } }} />}
      {attach && <AttachModal a={attach} orders={orders} allocs={allocs} user={user} onClose={() => setAttach(null)} />}
      {contAdd && <ContModal base={contAdd === 'new' ? null : contAdd} pos={pos} allocated={allocated} user={user} onClose={() => setContAdd(null)} />}
    </div>
  );
}

// Giá trị chung của cont: giống nhau ở mọi dòng thì lấy, khác nhau thì để trống và đánh dấu
function contView(rows) {
  const v = { mixed: {} };
  for (const k of [...CONT_KEYS, 'partyName']) {
    const vals = [...new Set(rows.map((a) => a[k] ?? ''))];
    v[k] = vals.length === 1 ? vals[0] : '';
    if (vals.length > 1) v.mixed[k] = true;
  }
  if (v.mixed.destType) v.destType = '';
  return v;
}

// Các ô điểm giao dùng chung (số cont, ngày giao, nơi nhận, điểm giao, khách / kho đến, mã giao, nhà vận chuyển)
function SharedCells({ v, edit, editCarrier = edit, save, cats, whs }) {
  const [chgFrom, setChgFrom] = useState(false);
  const locs = cats.locations || [];
  const whOf = (c) => whs.find((w) => w.code === c);
  const mixed = (k) => (v.mixed?.[k] ? <div className="small" style={{ color: 'var(--amber)' }}>khác nhau giữa các mã</div> : null);
  const blur = (k, conv = (x) => x.trim()) => (e) => { const x = conv(e.target.value); if (x !== (v[k] ?? '')) save({ [k]: x }); };
  const ships = (cats.shipto || []).filter((sh) => sh.customerCode === v.partyCode);
  const pickCustomer = (e) => {
    const x = e.target.value.trim();
    if (x === (v.partyCode || '')) return;
    const c = (cats.soldto || []).find((r) => r.code === x);
    if (x && !c) { e.target.value = v.partyCode || ''; window.alert(`Mã khách ${x} không có trong danh mục Khách hàng / NCC.`); return; }
    const sh = (cats.shipto || []).filter((r) => r.customerCode === x);
    save({ partyCode: x, partyName: c?.name || '', shipCode: sh.length === 1 ? sh[0].shipCode : '' });
  };
  return (
    <>
      <td>{edit ? <input style={{ width: 125 }} placeholder="Số cont" defaultValue={v.contNo} key={'c' + v.contNo} onBlur={blur('contNo', (x) => x.trim().toUpperCase())} /> : <span className="mono">{v.contNo}</span>}{mixed('contNo')}</td>
      <td>{edit ? <input type="date" style={{ width: 140 }} defaultValue={v.date} key={'d' + v.date} onBlur={blur('date')} /> : <span className="nowrap">{fmtDate(v.date)}</span>}{mixed('date')}</td>
      <td>{edit && (!v.fromWarehouse || chgFrom) ? (
        <WithAdd cat="warehouses" onAdded={(id) => { setChgFrom(false); save({ fromWarehouse: id, fromLocation: '' }); }}><Select value={v.fromWarehouse || ''} onChange={(e) => { setChgFrom(false); save({ fromWarehouse: e.target.value, fromLocation: '' }); }}>
          <option value="">-- Kho --</option>{whs.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
        </Select></WithAdd>) : <span title="Lấy từ kho nhập của dòng PO"><b>{v.fromWarehouse}</b>{edit && <button type="button" className="btn ghost sm" title="Đổi nơi nhận" onClick={() => setChgFrom(true)}>✎</button>}</span>}
        {v.fromWarehouse && whOf(v.fromWarehouse)?.name && <div className="small">{whOf(v.fromWarehouse).name}</div>}
        {mixed('fromWarehouse')}
        <LocCell wh={whOf(v.fromWarehouse)} value={v.fromLocation} edit={edit} locs={locs} onChange={(x) => save({ fromLocation: x })} mixed={v.mixed?.fromLocation} /></td>
      <td>{edit ? (
        <Select value={v.destType || ''} onChange={(e) => e.target.value && save({ destType: e.target.value })}>
          {!v.destType && <option value="">-- Khác nhau --</option>}
          {Object.entries(DEST_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>) : DEST_TYPES[v.destType]}</td>
      <td>{edit && v.destType === 'customer' ? (
        <><WithAdd cat="soldto" onAdded={(id, r) => save({ partyCode: r?.code || id, partyName: r?.name || '', shipCode: '' })}><input list="dl-alloc-soldto" style={{ width: 130 }} placeholder="Mã khách" defaultValue={v.partyCode} key={'p' + v.partyCode} onBlur={pickCustomer} /></WithAdd>
          {v.partyName && <div className="small">{v.partyName}</div>}</>
      ) : edit && v.destType === 'warehouse' ? (
        <WithAdd cat="warehouses" onAdded={(id) => save({ toWarehouse: id, toLocation: '' })}><Select value={v.toWarehouse || ''} onChange={(e) => save({ toWarehouse: e.target.value, toLocation: '' })}>
          <option value="">-- Kho đến --</option>{whs.filter((w) => w.code !== v.fromWarehouse).map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
        </Select></WithAdd>
      ) : v.destType === 'customer' ? <>{v.partyCode}{v.partyName ? <div className="small">{v.partyName}</div> : null}</> : v.destType === 'warehouse' ? <><b>{v.toWarehouse}</b>{whOf(v.toWarehouse)?.name && <div className="small">{whOf(v.toWarehouse).name}</div>}</> : v.destType === 'keep' ? <span className="small">Ở lại {whOf(v.fromWarehouse)?.name || v.fromWarehouse || 'kho nhận'}</span> : <span className="small">–</span>}
        {mixed(v.destType === 'warehouse' ? 'toWarehouse' : 'partyCode')}
        {v.destType === 'warehouse' && <LocCell wh={whOf(v.toWarehouse)} value={v.toLocation} edit={edit} locs={locs} onChange={(x) => save({ toLocation: x })} mixed={v.mixed?.toLocation} />}</td>
      <td>{edit && v.destType === 'customer' && v.partyCode ? (
        <WithAdd cat="shipto" preset={{ customerCode: v.partyCode, customerName: v.partyName }} onAdded={(id, r) => save({ shipCode: r?.shipCode || id })}><Select value={v.shipCode || ''} onChange={(e) => save({ shipCode: e.target.value })}>
          <option value="">-- Mã giao --</option>{ships.map((sh) => <option key={sh.shipCode} value={sh.shipCode} title={sh.address}>{sh.shipCode}</option>)}
        </Select></WithAdd>) : v.destType === 'customer' ? v.shipCode : ''}</td>
      <td>{editCarrier ? (
        <WithAdd cat="carriers" onAdded={(id) => save({ carrier: id })}><Select value={v.carrier || ''} title={edit ? '' : 'Đổi nhà vận chuyển ghi luôn vào dòng đơn'} onChange={(e) => save({ carrier: e.target.value })}>
          <option value="">--</option>{(cats.carriers || []).filter((c) => c.active !== false).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </Select></WithAdd>) : v.carrier}{mixed('carrier')}</td>
    </>
  );
}

// Vị trí trong kho (kho cảng, kho mua nội địa…); kho chỉ cần kho (Đức Hòa) thì không hiện
function LocCell({ wh, value, edit, locs, onChange, mixed }) {
  if (!planNeedsLocation(wh)) return null;
  const list = locs.filter((l) => l.warehouse === wh.code && !l.locked).sort((a, b) => String(a.code).localeCompare(String(b.code)));
  if (!edit) return value ? <div className="small">Vị trí {value}</div> : null;
  return (
    <WithAdd style={{ marginTop: 4 }} cat="locations" preset={{ warehouse: wh.code }} onAdded={(id, r) => onChange(r?.code || String(id).split('__').pop())}>
      <Select value={value || ''} title="Vị trí nhận hàng, chuyển sang phiếu nhập kho" onChange={(e) => onChange(e.target.value)}>
        <option value="">{mixed ? '-- Khác nhau --' : '-- Vị trí --'}</option>
        {list.map((l) => <option key={l.code} value={l.code}>{l.code}{n(l.capacity) ? ` · trống ${fmtNum(Math.max(0, n(l.capacity) - n(l.currentPallets)), 1)} pl` : ''}</option>)}
        {value && !list.some((l) => l.code === value) && <option value={value}>{value}</option>}
      </Select>
    </WithAdd>
  );
}

// Dòng tiêu đề của 1 cont nhiều mã hàng: sửa điểm giao một lần cho cả cont
function ContRow({ g, canManage, cats, whs, checked, onCheck, save, onAdd }) {
  const v = contView(g.rows);
  const drafts = g.rows.filter((a) => ['draft', 'kept'].includes(a.st));
  const edit = canManage && drafts.length === g.rows.length;
  const total = g.rows.reduce((s, a) => s + n(a.qtyKg), 0);
  const sts = [...new Set(g.rows.map((a) => a.st))];
  const pos = [...new Set(g.rows.map((a) => a.poId))];
  return (
    <tr className="cont-head">
      <td>{canManage && g.rows.some((a) => !missingForOrder(a)) && <input type="checkbox" checked={checked} title="Chọn cả cont" onChange={onCheck} />}</td>
      <SharedCells v={v} edit={edit} editCarrier={canManage && g.rows.some((a) => ['draft', 'ordered', 'partial'].includes(a.st))} save={save} cats={cats} whs={whs} />
      <td className="mono small">{pos.join(', ')}</td>
      <td><b>{g.rows[0].company}</b></td>
      <td><b>📦 Cont {g.rows.length} mã hàng</b><div className="small">{[...new Set(g.rows.map((a) => a.item))].join(', ')}</div></td>
      <td className="num"><b>{kg(total)}</b><div className="small">{tn(total)}</div></td>
      <td className="small">{edit ? 'Sửa ở dòng này áp cho mọi mã trong cont' : ''}</td>
      <td>{sts.map((k) => <span key={k} className={'badge ' + (ALLOC_STATUS[k]?.tone || '')} style={{ marginRight: 4 }}>{ALLOC_STATUS[k]?.label}</span>)}</td>
      <td className="nowrap">{canManage && drafts.length > 0 && <button className="btn sm" title="Thêm mã hàng (dòng PO khác) vào cont này" onClick={onAdd}>＋ Mã</button>}</td>
    </tr>
  );
}

// 1 dòng kế hoạch (1 mã hàng của 1 dòng PO). sub = mã hàng nằm trong cont nhiều mã (điểm giao sửa ở dòng cont)
function AllocRow({ a, sub, edit, canManage, cats, whs, checked, onCheck, save, setQty, onCancel, onRemove, onAttach, onDetach }) {
  const miss = missingForOrder(a);
  const st = ALLOC_STATUS[a.st];
  const blur = (k, conv = (v) => v.trim()) => (e) => { const v = conv(e.target.value); if (v !== (a[k] ?? '')) save({ [k]: v }); };
  const orderCell = a.orderId ? <Link to={`/don-hang?tab=${a.orderType || 'SO'}`} className="mono" title={`Dòng ${a.orderLine} của ${a.orderId}`}>{a.orderId}</Link> : null;
  return (
    <tr className={sub ? 'cont-item' : ''} style={{ opacity: a.st === 'cancelled' ? 0.55 : 1 }}>
      <td>{!sub && canManage && !miss && <input type="checkbox" checked={checked} onChange={onCheck} />}</td>
      {sub ? <td colSpan={7} className="small" style={{ paddingLeft: 24 }}>↳ {a.contNo ? `cont ${a.contNo}` : ''}</td>
        : <SharedCells v={a} edit={edit} editCarrier={canManage && ['draft', 'ordered', 'partial'].includes(a.st)} save={save} cats={cats} whs={whs} />}
      <td className="mono nowrap">{a.poId}{a.bct ? <div className="small">BCT {a.bct}</div> : null}</td>
      <td><b>{a.company}</b></td>
      <td>{a.item}<div className="small">{a.itemName}</div></td>
      <td className="num">{edit ? <input type="number" step="any" style={{ width: 100, textAlign: 'right' }} defaultValue={a.qtyKg} key={'q' + a.qtyKg} onBlur={(e) => { if (n(e.target.value) !== n(a.qtyKg) && !setQty(e.target.value)) e.target.value = a.qtyKg; }} /> : kg(a.qtyKg)}<div className="small">{tn(a.qtyKg)}</div></td>
      <td>{edit ? <input style={{ width: 140 }} defaultValue={a.note} key={'n' + a.note} onBlur={blur('note')} /> : <span className="small">{a.note}</span>}</td>
      <td>
        <span className={'badge ' + (st?.tone || '')}>{st?.label}</span>
        {a.st === 'draft' && miss && <div className="small" style={{ color: 'var(--amber)' }}>{miss}</div>}
        {orderCell && <div>{orderCell}{a.attached ? <span className="small"> (gắn vào)</span> : null}</div>}
      </td>
      <td className="nowrap">
        {canManage && a.st === 'draft' && a.destType !== 'warehouse' && <button className="btn sm" title="Gắn vào dòng đơn bán sale đã lập" onClick={onAttach}>Gắn SO</button>}
        {canManage && ['draft', 'kept'].includes(a.st) && <button className="btn sm ghost" title="Hủy dòng kế hoạch" onClick={onCancel}>✕</button>}
        {canManage && a.attached && a.st === 'ordered' && <button className="btn sm ghost" title="Bỏ gắn khỏi đơn bán" onClick={onDetach}>Bỏ gắn</button>}
        {canManage && a.st === 'cancelled' && <button className="btn sm ghost" onClick={onRemove}>🗑</button>}
      </td>
    </tr>
  );
}

// Lập cont nhiều mã hàng (hoặc thêm mã vào cont có sẵn): chọn các dòng PO còn chưa phân bổ, nhập số kg đưa vào cont
function ContModal({ base, preset, pos, allocated, user, onClose }) {
  const first = base?.rows[0];
  const [contNo, setContNo] = useState(first?.contNo || '');
  const [date, setDate] = useState(first?.date || '');
  const [q, setQ] = useState('');
  const [qty, setQtyMap] = useState(() => preset || {});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const inCont = new Set((base?.rows || []).map((a) => poKey(a.poId, a.poLine)));
  const f = norm(q);
  const lines = pos.filter((o) => !first || o.company === first.company).flatMap((o) => o.lines.map((l) => ({ o, l, key: poKey(o.id, l.no), left: Math.max(0, n(l.qtyKg) - (allocated.get(poKey(o.id, l.no)) || 0)) })))
    .filter((r) => r.left > 0.001 && !inCont.has(r.key))
    .sort((x, y) => (n(qty[y.key]) > 0) - (n(qty[x.key]) > 0))
    .filter((r) => n(qty[r.key]) > 0 || !f || norm([r.o.id, r.o.refNo, r.o.partyName, r.l.item, r.l.itemName, lineWh(r.o, r.l, 'in')].join(' ')).includes(f));
  const chosen = pos.flatMap((o) => o.lines.map((l) => ({ o, l, key: poKey(o.id, l.no), left: Math.max(0, n(l.qtyKg) - (allocated.get(poKey(o.id, l.no)) || 0)) }))).filter((r) => n(qty[r.key]) > 0);
  const total = chosen.reduce((s, r) => s + n(qty[r.key]), 0);
  const go = async () => {
    setErr('');
    if (!chosen.length) return setErr('Nhập số kg cho ít nhất 1 dòng PO.');
    if (!base && !contNo.trim()) return setErr('Nhập số cont.');
    const cos = [...new Set(chosen.map((r) => r.o.company))];
    if (cos.length > 1) return setErr(`1 cont chỉ thuộc 1 công ty, đang chọn hàng của ${cos.join(', ')}.`);
    const over = chosen.find((r) => n(qty[r.key]) > r.left + 0.001);
    if (over) return setErr(`${over.o.id} ${over.l.item}: chỉ còn ${kg(over.left)} kg chưa phân bổ.`);
    const shared = base ? Object.fromEntries(CONT_KEYS.map((k) => [k, contView(base.rows)[k]])) : { contNo: contNo.trim().toUpperCase(), date };
    setBusy(true);
    try {
      await addRows(chosen.map((r) => ({ po: r.o, line: r.l, ...shared, qtyKg: Math.round(n(qty[r.key]) * 1000) / 1000, date: shared.date || '' })), user);
      onClose(true);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập kế hoạch phân bổ.' : e.message); setBusy(false); }
  };
  return (
    <Modal title={base ? `Thêm mã hàng vào cont ${first.contNo}` : 'Lập cont nhiều mã hàng'} onClose={onClose} wide>
      {!base && (
        <div className="form-grid">
          <label className="field"><span>Số cont *</span><input value={contNo} onChange={(e) => setContNo(e.target.value)} /></label>
          <label className="field"><span>Ngày giao dự kiến</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
      )}
      <p className="small">Nhập số kg của từng dòng PO đưa vào cont{base ? ` (công ty ${first.company}, điểm giao lấy theo cont)` : ''}. Các mã hàng trong cùng cont có chung ngày giao, nơi nhận, điểm giao và nhà vận chuyển; sửa ở dòng cont.</p>
      <input type="search" placeholder="Tìm số PO, BCT, mã hàng…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8, width: '100%' }} />
      <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
        {!lines.length ? <Empty text="Không còn dòng PO nào chưa phân bổ." /> : (
          <table><thead><tr><th>Số PO</th><th>BCT</th><th>Công ty</th><th>ETA</th><th>Nơi nhận</th><th>Mã hàng</th><th className="num">Chưa phân bổ (kg)</th><th className="num">Đưa vào cont (kg)</th></tr></thead>
            <tbody>{lines.map((r) => (
              <tr key={r.key}><td className="mono">{r.o.id}</td><td className="mono">{r.o.refNo}</td><td>{r.o.company}</td><td>{fmtDate(r.l.dueDate || r.o.dueDate)}</td><td>{lineWh(r.o, r.l, 'in')}</td>
                <td>{r.l.item}<div className="small">{r.l.itemName}</div></td><td className="num">{kg(r.left)}</td>
                <td className="num"><input type="number" step="any" style={{ width: 110, textAlign: 'right' }} value={qty[r.key] ?? ''} onChange={(e) => setQtyMap((m) => ({ ...m, [r.key]: e.target.value }))} /></td></tr>
            ))}</tbody></table>
        )}
      </div>
      <p>Đã chọn {chosen.length} dòng, tổng <b>{kg(total)} kg</b> ({tn(total)}).</p>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={onClose}>Đóng</button><button className="btn primary" disabled={busy} onClick={go}>{base ? 'Thêm vào cont' : 'Lập cont'}</button></div>
    </Modal>
  );
}

// Xem trước các đơn sẽ tạo (SO theo công ty + khách, STO theo công ty) rồi tạo
function CreateOrders({ rows, cats, user, onClose }) {
  const { salesOnly, email } = useApp();
  const users = useCollection(salesOnly ? '' : 'users').rows.filter((u) => u.role === 'kinh_doanh' && u.active !== false);
  const [mode, setMode] = usePref('alloc-order-mode', 'cont');
  const itemType = useMemo(() => new Map((cats.items || []).map((i) => [i.code, i.plasticType || ''])), [cats.items]);
  const groups = useMemo(() => groupForOrders(rows, mode, (c) => itemType.get(c)), [rows, mode, itemType]);
  // Sale phụ trách mặc định theo khách hàng + loại hạt nhựa của SO
  const autoSale = (g) => salesFor((cats.soldto || []).find((c) => c.code === g.partyCode), g.plasticType);
  const nConts = new Set(rows.map((a) => a.contNo || a._id)).size;
  const [salesMap, setSales] = useState({});
  const sales = new Proxy(salesMap, { get: (m, k) => (autoSale(groups.find((g) => g.key === k) || {}) || (k in m ? m[k] : salesOnly ? email : '')) });
  const [done, setDone] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const whName = (c) => (cats.warehouses || []).find((w) => w.code === c)?.name || c;
  const go = async () => {
    setErr(''); setBusy(true);
    const made = { ...done };
    for (const g of groups) {
      if (made[g.key]) continue;
      try { made[g.key] = await createOrderFromGroup(g, { sales: sales[g.key], whName }, user); setDone({ ...made }); } catch (e) {
        setErr(`${g.type} ${g.partyName || g.company}: ${e.code === 'permission-denied' ? 'bạn không có quyền lập đơn này.' : e.message}`);
        setBusy(false); return;
      }
    }
    setBusy(false);
    onClose(`Đã tạo ${Object.values(made).join(', ')} từ ${rows.length} dòng kế hoạch.`);
  };
  return (
    <Modal title="Tạo đơn từ kế hoạch phân bổ" onClose={() => onClose(Object.keys(done).length ? `Đã tạo ${Object.values(done).join(', ')}.` : '')} wide>
      <div className="seg" style={{ marginBottom: 8 }}>
        <button type="button" className={mode === 'cont' ? 'on' : ''} disabled={busy || Object.keys(done).length > 0} onClick={() => setMode('cont')}>Mỗi cont 1 đơn ({nConts} cont)</button>
        <button type="button" className={mode === 'merge' ? 'on' : ''} disabled={busy || Object.keys(done).length > 0} onClick={() => setMode('merge')}>Gộp theo khách / công ty</button>
      </div>
      <p className="small">{mode === 'cont' ? 'Cont về khác ngày: mỗi cont 1 SO / STO riêng, phiếu nhập, phiếu xuất cũng riêng từng cont.' : 'Các cont cùng khách (SO) hoặc cùng công ty (STO) gộp vào 1 đơn.'} Mỗi dòng kế hoạch thành 1 dòng đơn. Kho xuất của SO / kho đi của STO là nơi nhận hàng; số cont, số PO ghi vào ghi chú dòng đơn.</p>
      {groups.map((g) => (
        <div key={g.key} className="card" style={{ marginBottom: 10 }}>
          <div className="section-head">
            <span className={'badge ' + (g.type === 'SO' ? 'blue' : 'teal')}>{g.type === 'SO' ? 'Đơn bán (SO)' : 'Chuyển kho (STO)'}</span>
            <b>{g.company}</b>{g.type === 'SO' ? <> · {g.partyCode} {g.partyName}{g.plasticType ? <> · <span className="badge">{g.plasticType}</span></> : null}</> : null}{g.contNo ? <> · cont <span className="mono">{g.contNo}</span></> : null}
            <span className="small">· {g.rows.length} dòng · {kg(g.rows.reduce((s, a) => s + n(a.qtyKg), 0))} kg</span>
            {done[g.key] && <span className="badge green">Đã tạo {done[g.key]}</span>}
          </div>
          {g.type === 'SO' && !done[g.key] && (
            <label className="small">Sale phụ trách:{' '}
              {autoSale(g) ? <><b>{autoSale(g)}</b> <span className="small">(theo khách hàng, hạt nhựa {g.plasticType})</span></> : salesOnly ? <b>{email}</b> : (
                <Select value={sales[g.key] || ''} onChange={(e) => setSales((s) => ({ ...s, [g.key]: e.target.value }))}>
                  <option value="">-- Không ghi --</option>{users.map((u) => <option key={u.email} value={u.email}>{u.name} ({u.email})</option>)}
                </Select>)}
            </label>
          )}
          <table><thead><tr><th>Ngày giao</th><th>Mã hàng</th><th className="num">Số lượng (kg)</th><th>Cont</th>{g.type === 'SO' ? <><th>Kho xuất</th><th>Mã giao</th></> : <><th>Kho đi</th><th>Kho đến</th></>}<th>PO</th><th>Nhà vận chuyển</th></tr></thead>
            <tbody>{g.rows.map((a) => (
              <tr key={a._id}><td>{fmtDate(a.date)}</td><td>{a.item}</td><td className="num">{kg(a.qtyKg)}</td><td className="mono">{a.contNo}</td>
                <td>{a.fromWarehouse}</td><td>{g.type === 'SO' ? a.shipCode : a.toWarehouse}</td><td className="mono">{a.poId}</td><td>{a.carrier}</td></tr>
            ))}</tbody></table>
        </div>
      ))}
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={() => onClose('')}>Đóng</button>
        <button className="btn primary" disabled={busy || groups.every((g) => done[g.key])} onClick={go}>Tạo {groups.filter((g) => !done[g.key]).length} đơn</button>
      </div>
    </Modal>
  );
}

// Ô tìm đơn bán (nhiều khách cùng đặt 1 mã): số SO, khách, mã giao, sale, ngày giao, ghi chú
const soText = (o, l) => norm([o.id, o.refNo, o.partyCode, o.partyName, lineShip(o, l), o.sales, o.salesName, fmtDate(l.dueDate || o.dueDate), l.note, o.note].join(' '));

// Gắn dòng kế hoạch vào dòng SO đang mở cùng công ty + mã hàng (cùng khách nếu đã chọn khách)
function AttachModal({ a, orders, allocs, user, onClose }) {
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const used = useMemo(() => {
    const m = new Map();
    for (const x of allocs) if (x.orderId && x.status !== 'cancelled') m.set(`${x.orderId}__${x.orderLine}`, (m.get(`${x.orderId}__${x.orderLine}`) || 0) + n(x.qtyKg));
    return m;
  }, [allocs]);
  const cand = orders.filter((o) => o.type === 'SO' && OPEN_STATUSES.includes(o.status) && o.company === a.company && (!a.partyCode || o.partyCode === a.partyCode))
    .flatMap((o) => o.lines.filter((l) => l.item === a.item).map((l) => ({ o, l, planned: used.get(`${o.id}__${l.no}`) || 0 })))
    .sort((x, y) => String(x.l.dueDate || x.o.dueDate || '9999').localeCompare(String(y.l.dueDate || y.o.dueDate || '9999')));
  const shown = cand.filter((r) => !q || soText(r.o, r.l).includes(norm(q)));
  const pick = async (o, l) => {
    setErr('');
    try { await attachToOrder(a, o, l, user); onClose(); } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={`Gắn ${a.item} ${kg(a.qtyKg)} kg vào đơn bán có sẵn`} onClose={onClose} wide>
      <p className="small">Đơn bán đang mở của công ty <b>{a.company}</b>, mã hàng <b>{a.item}</b>{a.partyCode ? <>, khách <b>{a.partyCode}</b></> : ''}. Dòng đơn không thay đổi; dòng kế hoạch chỉ ghi nhớ là hàng cho đơn này.</p>
      {cand.length > 0 && <div className="filters"><input type="search" autoFocus style={{ flex: 1 }} placeholder="Tìm số SO, khách hàng, mã giao, sale, ngày giao…" value={q} onChange={(e) => setQ(e.target.value)} /><span className="small">{shown.length}/{cand.length} dòng</span></div>}
      {!cand.length ? <Empty text="Không có dòng đơn bán phù hợp." /> : !shown.length ? <Empty text="Không tìm thấy đơn bán khớp từ khóa." /> : (
        <table><thead><tr><th>Số SO</th><th>Khách hàng</th><th>Ngày giao</th><th>Kho xuất</th><th>Mã giao</th><th className="num">Còn phải giao (kg)</th><th className="num">Đã có kế hoạch (kg)</th><th></th></tr></thead>
          <tbody>{shown.map(({ o, l, planned }) => (
            <tr key={`${o.id}-${l.no}`}><td className="mono">{o.id}</td><td>{o.partyName || o.partyCode}</td><td>{fmtDate(l.dueDate || o.dueDate)}</td><td>{lineWh(o, l) || 'Kho nào cũng được'}</td>
              <td>{lineShip(o, l)}</td><td className="num">{kg(leftKg(l))}</td><td className="num">{kg(planned)}</td>
              <td><button className="btn sm primary" onClick={() => pick(o, l)}>Gắn</button>
                {lineWh(o, l) && lineWh(o, l) !== a.fromWarehouse && <div className="small" style={{ color: 'var(--amber)' }}>Kho xuất khác nơi nhận {a.fromWarehouse}</div>}</td></tr>
          ))}</tbody></table>
      )}
      <ErrorBox error={err} />
    </Modal>
  );
}
