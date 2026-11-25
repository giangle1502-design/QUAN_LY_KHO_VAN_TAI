import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { CloseButton, Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtDateTime, fmtNum, norm } from '../../lib/utils';
import {
  COUNT_KINDS, COUNT_STATUS, addFoundLine, adjustPlan, assigneeText, countValue, countWhs, inLocRange, lineResult, lineWh, locCmp, postAdjust, saveCount, scopeText, setCountStatus, specOf, whsText,
} from '../../lib/counts';
import { whLabel } from '../../lib/whGroups';
import { RecountModal } from './CountRecount';
import { WithAdd } from '../../components/FormTools';
import Select from '../../components/Select';

// Phiếu + dòng đếm realtime (nhiều người cùng đếm thấy tiến độ của nhau)
function useCount(id) {
  const [count, setCount] = useState(undefined);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const off1 = onSnapshot(doc(db, 'stockCounts', id), (s) => setCount(s.exists() ? s.data() : null), (e) => { setError(e.message); setCount(null); });
    const off2 = onSnapshot(collection(db, 'stockCounts', id, 'lines'), (s) => setLines(s.docs.map((d) => d.data()).sort((a, b) => a.no - b.no)), (e) => setError(e.message));
    return () => { off1(); off2(); };
  }, [id]);
  return { count, lines, error };
}

const qtyHint = (l, kg, bags) => (l.bpp ? `${fmtNum(Math.floor(bags / l.bpp))} pl + ${fmtNum(bags - Math.floor(bags / l.bpp) * l.bpp)} bao` : '');
const sysText = (l) => `${fmtNum(l.sysKg, 3)} kg`;
const signKg = (x) => `${x > 0 ? '+' : ''}${fmtNum(x, 3)} kg`;

function Progress({ lines }) {
  const res = lines.map(lineResult);
  const counted = res.filter((r) => r.counted).length;
  const diff = res.filter((r) => r.counted && !r.match).length;
  return { counted, diff, match: counted - diff, total: lines.length };
}

// ============================================================================
// Trang chi tiết (máy tính): xem / nhập số đếm từ biểu mẫu giấy, chốt số, điều chỉnh tồn
// ============================================================================
export default function CountDetail() {
  const { id } = useParams();
  const { hasRole, email, name, isSuper, isAdmin } = useApp();
  const { count, lines, error } = useCount(id);
  const nav = useNavigate();
  const [recount, setRecount] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [show, setShow] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const canManage = hasRole('thu_kho');
  const user = { email, name };

  if (count === undefined) return <div className="center">Đang tải…</div>;
  if (!count) return <div className="center">Không tìm thấy phiếu {id}.</div>;
  const open = count.status === 'open';
  const p = Progress({ lines });
  const nq = norm(q);
  const rows = lines.filter((l) => {
    const r = lineResult(l);
    return inLocRange(l.location, from, to)
      && (!show || (show === 'todo' ? !r.counted : show === 'diff' ? r.counted && !r.match : r.counted && r.match))
      && (!nq || norm(`${l.location} ${l.item} ${l.itemName} ${l.lot}`).includes(nq));
  });
  const locs = [...new Set(lines.map((l) => l.location))].sort(locCmp);
  const multiWh = countWhs(count).length > 1;
  const diffLines = lines.filter((l) => { const r = lineResult(l); return r.counted && !r.match; });
  const act = async (fn) => { setErr(''); try { await fn(); } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền.' : e.message); } };
  const printUrl = `/kho/kiem-ke/${id}/in?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`;

  const excel = () => exportSheets(`${id}`, { [id]: lines.map((l) => {
    const r = lineResult(l);
    return { STT: l.no, 'Công ty': l.company, Kho: whLabel(lineWh(l, count)), 'Ngày kiểm kê': fmtDate(count.date), 'Vị trí': l.location, 'Mã hàng': l.item, 'Tên hàng': l.itemName,
      Lot: l.lot, TTHH: l.goodsStatus, 'SL hệ thống (kg)': l.sysKg, 'SL hệ thống (bao)': l.sysBags,
      'Thực kiểm (kg)': l.c1?.kg ?? '', 'Thực kiểm (pallet)': l.c1?.pallets ?? '', 'Thực kiểm (bao lẻ)': l.c1?.bags ?? '',
      'Kiểm lại (kg)': l.c2?.kg ?? '', 'Kiểm lại (pallet)': l.c2?.pallets ?? '', 'Kiểm lại (bao lẻ)': l.c2?.bags ?? '',
      'Final (kg)': r.counted ? r.final.kg : '', 'Chênh lệch (kg)': r.counted ? r.diffKg : '', 'Chênh lệch (bao)': r.counted && l.bpp ? r.diffBags : '',
      'Người đếm': (l.c2 || l.c1)?.byName || '' };
  }) });

  return (
    <div>
      <div className="page-head">
        <h1>🧮 {COUNT_KINDS[count.kind]} <span className="mono">{count.id}</span> <span className={`badge ${COUNT_STATUS[count.status]?.cls}`}>{COUNT_STATUS[count.status]?.label}</span></h1>
        <div className="actions">
          <Link className="btn" to="/kho/kiem-ke">← Danh sách</Link>
          {open && <Link className="btn primary" to={`/kho/kiem-ke/${id}/dem`}>📱 Đếm trên điện thoại</Link>}
          <Link className="btn" to={printUrl} target="_blank">🖨 In biểu mẫu{from || to ? ' (theo vị trí đã lọc)' : ''}</Link>
          <button className="btn" onClick={excel}>⬇ Excel</button>
          <CloseButton to="/kho/kiem-ke" />
        </div>
      </div>
      <p className="hint">
        Công ty <b>{count.company || 'tất cả'}</b> · kho <b>{whsText(count)}</b> · ngày kiểm kê <b>{fmtDate(count.date)}</b> · phạm vi: {scopeText(count)}
        {assigneeText(count) ? <> · thủ kho đếm <b>{assigneeText(count)}</b></> : ''}
        {count.blind ? ' · đếm mù' : ''}{count.note ? ` · ${count.note}` : ''}
        {count.recountIds?.length ? <> · đã tạo lệnh đếm lại {count.recountIds.map((x, i) => <span key={x}>{i ? ', ' : ''}<Link className="mono" to={`/kho/kiem-ke/${x}`}>{x}</Link></span>)}</> : ''}. Số final = số kiểm lại nếu có, không thì số thực kiểm. Chênh lệch = final − hệ thống (lúc lập phiếu).
      </p>
      <div className="stats">
        <div className="stat"><div className="stat-label">Đã đếm</div><div className="stat-value">{p.counted} / {p.total}</div><div className="stat-sub">{p.total ? fmtNum((p.counted / p.total) * 100, 1) : 0}%</div></div>
        <div className="stat green"><div className="stat-label">Khớp</div><div className="stat-value">{p.match}</div><div className="stat-sub">{p.counted ? `${fmtNum((p.match / p.counted) * 100, 1)}% chính xác` : ''}</div></div>
        <div className="stat red"><div className="stat-label">Lệch</div><div className="stat-value">{p.diff}</div>
          <div className="stat-sub">{signKg(lines.reduce((s, l) => { const r = lineResult(l); return s + (r.counted ? r.diffKg : 0); }, 0))}</div></div>
      </div>
      <ErrorBox error={error || err} />
      {count.recountIds?.length && count.status === 'done' ? <div className="hint" style={{ color: 'var(--amber)' }}>Các dòng lệch đã có lệnh đếm lại. Duyệt điều chỉnh tồn trên lệnh đếm lại để không điều chỉnh 2 lần; phiếu này bấm "Không điều chỉnh".</div> : null}
      {count.status === 'done' && !isSuper && <div className="hint" style={{ color: 'var(--amber)' }}>Số đếm đã chốt, chờ quản trị duyệt. Tồn kho chỉ thay đổi khi được duyệt.</div>}
      {count.adjustIds?.length ? <div className="ok-box" style={{ marginBottom: 10 }}>Đã điều chỉnh tồn bằng phiếu {count.adjustIds.map((x, i) => <span key={x}>{i ? ', ' : ''}<Link className="mono" to={`/kho/phieu/${x}/in`} target="_blank">{x}</Link></span>)}.</div> : null}
      <div className="filters">
        <label className="small">Từ vị trí <Select value={from} onChange={(e) => setFrom(e.target.value)}><option value="">(đầu)</option>{locs.map((l) => <option key={l}>{l}</option>)}</Select></label>
        <label className="small">Đến vị trí <Select value={to} onChange={(e) => setTo(e.target.value)}><option value="">(cuối)</option>{locs.map((l) => <option key={l}>{l}</option>)}</Select></label>
        <Select value={show} onChange={(e) => setShow(e.target.value)}>
          <option value="">Mọi dòng</option><option value="todo">Chưa đếm</option><option value="diff">Lệch</option><option value="ok">Khớp</option>
        </Select>
        <input placeholder="Tìm vị trí, mã, lot…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={{ flex: 1 }} />
        {canManage && open && <button className="btn primary" disabled={!p.counted} onClick={() => act(() => setCountStatus(count, 'done', user, `Chốt số đếm, gửi duyệt (${p.counted}/${p.total} dòng)`))}>✔ Chốt số, gửi duyệt</button>}
        {isAdmin && diffLines.length > 0 && ['open', 'done'].includes(count.status) && <button className="btn" onClick={() => setRecount(diffLines.map((l) => ({ ...l, warehouse: lineWh(l, count), countId: count.id, companyOfCount: count.company || '' })))}>🔁 Tạo lệnh đếm lại {diffLines.length} dòng lệch</button>}
        {canManage && count.status === 'done' && <button className="btn" onClick={() => act(() => setCountStatus(count, 'open', user, 'Mở lại để đếm tiếp'))}>Mở lại</button>}
        {/* Chỉ quản trị gốc duyệt mới điều chỉnh tồn; thủ kho chỉ nhập số đếm (ra báo cáo) */}
        {isSuper && count.status === 'done' && <button className="btn primary" onClick={() => setAdjusting(true)}>✅ Duyệt & điều chỉnh tồn</button>}
        {isSuper && count.status === 'done' && <button className="btn" onClick={() => { const r = window.prompt('Đóng phiếu, KHÔNG điều chỉnh tồn. Ghi chú?', 'Chỉ ghi nhận báo cáo'); if (r != null) act(() => setCountStatus(count, 'closed', user, `Duyệt, không điều chỉnh tồn: ${r}`)); }}>Không điều chỉnh</button>}
        {((canManage && open) || (isSuper && count.status === 'done')) && <button className="btn danger" onClick={() => { const r = window.prompt('Lý do hủy phiếu kiểm kê?'); if (r) act(() => setCountStatus(count, 'cancelled', user, `Hủy phiếu: ${r}`)); }}>Hủy phiếu</button>}
      </div>
      {!rows.length ? <Empty text="Không có dòng nào" /> : (
        <div className="table-wrap">
          <table className="count-table">
            <thead><tr><th className="stt">STT</th>{multiWh && <th>Kho</th>}<th>Vị trí</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>TTHH</th><th>Công ty</th>
              <th className="num">SL hệ thống</th><th>SL thực kiểm</th><th>SL kiểm lại</th><th className="num">SL final</th><th className="num">Chênh lệch</th></tr></thead>
            <tbody>
              {rows.map((l) => {
                const r = lineResult(l);
                return (
                  <tr key={l.no} className={r.counted ? (r.match ? 'cnt-ok' : 'cnt-diff') : ''}>
                    <td className="stt">{l.no}</td>{multiWh && <td className="small">{lineWh(l, count)}</td>}<td><b>{l.location}</b></td><td>{l.item}{l.extra ? <div><span className="badge amber">ngoài hệ thống</span></div> : null}</td>
                    <td className="small">{l.itemName}</td><td>{l.lot}</td><td>{l.goodsStatus}{l.pledgee ? ` (${l.pledgee})` : ''}</td><td>{l.company}</td>
                    <td className="num">{sysText(l)}<div className="small">{qtyHint(l, l.sysKg, l.sysBags)}</div></td>
                    <td><CountCell l={l} round={1} disabled={!open || !canManage} onSave={(v) => act(() => saveCount(id, l.no, 1, v, user))} /></td>
                    <td><CountCell l={l} round={2} disabled={!open || !canManage || !l.c1} onSave={(v) => act(() => saveCount(id, l.no, 2, v, user))} /></td>
                    <td className="num">{r.counted ? <>{fmtNum(r.final.kg, 3)}<div className="small">{r.recount ? 'theo kiểm lại' : 'theo thực kiểm'}</div></> : ''}</td>
                    <td className="num">{r.counted ? (r.match ? <span className="badge green">Khớp</span>
                      : <b style={{ color: r.diffKg < 0 ? 'var(--red)' : 'var(--green)' }}>{signKg(r.diffKg)}{l.bpp ? <div className="small">{r.diffBags > 0 ? '+' : ''}{fmtNum(r.diffBags)} bao</div> : null}</b>) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {count.history?.length ? <div className="small" style={{ marginTop: 12 }}>{count.history.map((h, i) => <div key={i}>{fmtDateTime(h.at)} · {h.byName || h.by}: {h.action}</div>)}</div> : null}
      {adjusting && <AdjustModal count={count} lines={lines} user={user} onClose={() => setAdjusting(false)} />}
      {recount && <RecountModal lines={recount} onClose={(nid) => { setRecount(null); if (nid) nav(`/kho/kiem-ke/${nid}`); }} />}
    </div>
  );
}

// Ô nhập số đếm: pallet chẵn + bao lẻ (mã có quy cách) hoặc kg; lưu khi rời ô / Enter
function CountCell({ l, round, disabled, onSave }) {
  const c = round === 2 ? l.c2 : l.c1;
  const spec = { bpp: l.bpp, bagWeight: l.bagWeight };
  const bySpec = spec.bpp && spec.bagWeight;
  const init = () => ({ pallets: c?.pallets ?? '', bags: c?.bags ?? '', kg: c?.kg ?? '' });
  const [v, setV] = useState(init);
  const key = JSON.stringify(c || null);
  useEffect(() => { setV(init()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(init()) !== JSON.stringify(v);
  const commit = () => {
    if (!dirty) return;
    const empty = ['pallets', 'bags', 'kg'].every((k) => v[k] === '' || v[k] == null);
    onSave(empty ? null : countValue(v, spec));
  };
  const inp = (k, ph) => (
    <input className="cnt-in" type="number" inputMode="decimal" min="0" step="any" placeholder={ph} value={v[k]} disabled={disabled}
      onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
  );
  return (
    <div className="cnt-cell">
      {bySpec ? <>{inp('pallets', 'pl')}{inp('bags', 'bao')}</> : inp('kg', 'kg')}
      {c && bySpec ? <div className="small">= {fmtNum(c.kg, 3)} kg</div> : null}
    </div>
  );
}

function AdjustModal({ count, lines, user, onClose }) {
  const reasons = useCollection('reasons').rows.filter((r) => ['Điều chỉnh tồn', 'Hàng lỗi'].includes(r.appliesTo));
  const [plan, setPlan] = useState(null);
  const [reason, setReason] = useState(`Chênh lệch ${COUNT_KINDS[count.kind].toLowerCase()} ${count.id}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { adjustPlan(count, lines).then(setPlan).catch((e) => setErr(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = (plan || []).filter((x) => x.changed);
  const go = async () => {
    if (!reason) return setErr('Chọn lý do điều chỉnh.');
    setBusy(true); setErr('');
    try { await postAdjust(count, plan, reason, user); onClose(); } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền điều chỉnh tồn kho này.' : e.message); setBusy(false); }
  };
  return (
    <Modal title={`Điều chỉnh tồn theo ${count.id}`} onClose={onClose} wide>
      {!plan ? <div>Đang so với tồn hiện tại…</div> : (
        <>
          <p className="small">Số điều chỉnh = số final − tồn <b>hiện tại</b> của từng dòng (đã tính các phiếu nhập/xuất sau khi đếm). {plan.length ? `${plan.length} dòng cần điều chỉnh.` : 'Không có dòng nào cần điều chỉnh; bấm Xác nhận để chốt phiếu.'}</p>
          {changed.length ? <div className="error-box">{changed.length} dòng có phát sinh nhập/xuất sau khi lập phiếu kiểm kê (tồn hiện tại khác số hệ thống lúc đếm). Kiểm tra lại trước khi điều chỉnh.</div> : null}
          {plan.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 360 }}>
              <table>
                <thead><tr><th>Kho</th><th>Vị trí</th><th>Mã hàng</th><th>Lot</th><th>TTHH</th><th className="num">Hệ thống lúc đếm</th><th className="num">Tồn hiện tại</th><th className="num">Final</th><th className="num">Điều chỉnh (kg)</th><th className="num">Bao</th></tr></thead>
                <tbody>{plan.map(({ l, d, now, changed: ch }) => (
                  <tr key={l.no} style={ch ? { background: 'var(--amber-soft)' } : undefined}>
                    <td className="small">{lineWh(l, count)}</td><td>{l.location}</td><td>{l.item}</td><td>{l.lot}</td><td>{l.goodsStatus}</td><td className="num">{fmtNum(l.sysKg, 3)}</td><td className="num">{fmtNum(now.kg, 3)}</td>
                    <td className="num">{fmtNum(lineResult(l).final.kg, 3)}</td><td className="num" style={{ color: d.kg < 0 ? 'var(--red)' : 'var(--green)' }}><b>{signKg(d.kg)}</b></td><td className="num">{d.bags > 0 ? '+' : ''}{fmtNum(d.bags)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <Field label="Lý do điều chỉnh" required>
            <WithAdd cat="reasons" preset={{ appliesTo: 'Điều chỉnh tồn' }} onAdded={(id, r) => setReason(`${id} – ${r?.name || ''}`)}><Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value={`Chênh lệch ${COUNT_KINDS[count.kind].toLowerCase()} ${count.id}`}>Chênh lệch {COUNT_KINDS[count.kind].toLowerCase()} {count.id}</option>
              {reasons.map((r) => <option key={r.code} value={`${r.code} – ${r.name}`}>{r.name}</option>)}
            </Select></WithAdd>
          </Field>
        </>
      )}
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={onClose}>Đóng</button>
        <button className="btn primary" disabled={!plan || busy} onClick={go}>{busy ? 'Đang ghi…' : plan?.length ? `Duyệt, lập phiếu điều chỉnh (${plan.length} dòng)` : 'Duyệt'}</button>
      </div>
    </Modal>
  );
}

// ============================================================================
// Màn hình thủ kho (điện thoại): bảng Vị trí · Mã hàng · SL hệ thống · SL thực kiểm, nhập số ngay trên dòng
// ============================================================================
export function CountMobile() {
  const { id } = useParams();
  const { email, name, hasRole } = useApp();
  const { count, lines, error } = useCount(id);
  const [q, setQ] = useState('');
  const [show, setShow] = useState('todo');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  // Giữ dòng vừa đếm trên màn hình (không biến mất khỏi lọc "Chưa đếm" ngay khi lưu)
  const [keep, setKeep] = useState(() => new Set());
  const user = { email, name };
  const sorted = useMemo(() => [...lines].sort((a, b) => locCmp(a.location, b.location) || String(a.item).localeCompare(String(b.item)) || a.no - b.no), [lines]);
  if (count === undefined) return <div className="center">Đang tải…</div>;
  if (!count) return <div className="center">Không tìm thấy phiếu {id}.</div>;
  const p = Progress({ lines });
  const open = count.status === 'open' && hasRole('thu_kho');
  const multiWh = countWhs(count).length > 1;
  const nq = norm(q);
  const rows = sorted.filter((l) => {
    const r = lineResult(l);
    const ok = show === 'all' || keep.has(l.no) || (show === 'todo' ? !r.counted : r.counted && !r.match);
    return ok && (!nq || norm(`${l.location} ${l.item} ${l.itemName} ${l.lot}`).includes(nq));
  });
  const finish = async () => {
    const left = p.total - p.counted;
    if (!window.confirm(left ? `Còn ${left} dòng chưa đếm. Vẫn chốt số và gửi quản trị?` : 'Chốt số đếm và gửi quản trị xem chênh lệch?')) return;
    setErr('');
    try { await setCountStatus(count, 'done', user, `Thủ kho đếm xong, gửi quản trị (${p.counted}/${p.total} dòng)`); } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền.' : e.message); }
  };
  return (
    <div className="cnt-mobile">
      <div className="cnt-top">
        <Link className="btn sm" to="/kho/kiem-ke">← Danh sách</Link>
        <div><b>{COUNT_KINDS[count.kind]} {count.id}</b><div className="small">{whsText(count)} · {fmtDate(count.date)}</div>
          <div className="small">{scopeText(count)}{assigneeText(count) ? ` · thủ kho: ${assigneeText(count)}` : ''}</div></div>
      </div>
      {count.status !== 'open' && <div className="error-box">Phiếu {COUNT_STATUS[count.status]?.label.toLowerCase()}, không nhập số đếm được nữa.</div>}
      {count.note ? <div className="hint">📝 {count.note}</div> : null}
      <ErrorBox error={error || err} />
      <div className="cnt-progress"><div style={{ width: `${p.total ? (p.counted / p.total) * 100 : 0}%` }} /></div>
      <div className="small" style={{ marginBottom: 6 }}>Đã đếm <b>{p.counted}/{p.total}</b> dòng{count.blind ? '' : <> · khớp {p.match} · <b style={{ color: p.diff ? 'var(--red)' : undefined }}>lệch {p.diff}</b></>}</div>
      <input className="cnt-search" type="search" placeholder="🔍 Gõ / quét vị trí hoặc mã hàng" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="seg" style={{ margin: '6px 0' }}>
        <button type="button" className={show === 'todo' ? 'on' : ''} onClick={() => { setShow('todo'); setKeep(new Set()); }}>Chưa đếm ({p.total - p.counted})</button>
        {!count.blind && <button type="button" className={show === 'diff' ? 'on' : ''} onClick={() => { setShow('diff'); setKeep(new Set()); }}>Lệch ({p.diff})</button>}
        <button type="button" className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>Tất cả ({p.total})</button>
      </div>
      {!rows.length ? <Empty text={show === 'todo' ? 'Đã đếm hết các dòng 👍' : 'Không có dòng nào'} /> : (
        <div className="cnt-tblwrap">
          <table className="cnt-tbl">
            <thead><tr><th>Vị trí</th><th>Mã hàng</th><th className="num">SL hệ thống</th><th>SL thực kiểm</th></tr></thead>
            <tbody>{rows.map((l, i) => {
              const r = lineResult(l);
              const newLoc = i === 0 || rows[i - 1].location !== l.location;
              return (
                <tr key={l.no} className={(r.counted ? (count.blind || r.match ? 'cnt-ok' : 'cnt-diff') : '') + (newLoc ? ' cnt-newloc' : '')}>
                  <td>{newLoc ? <b className="cnt-locb">{l.location}</b> : null}{newLoc && multiWh ? <div className="small">{lineWh(l, count)}</div> : null}</td>
                  <td><b>{l.item}</b>{l.extra ? <span className="badge amber"> mới</span> : null}<div className="small">{l.itemName}</div>
                    <div className="small">{l.lot ? `Lot ${l.lot} · ` : ''}{l.goodsStatus}{l.company ? ` · ${l.company}` : ''}</div></td>
                  <td className="num">{!count.blind || r.counted ? <><b>{fmtNum(l.sysKg, 3)}</b><div className="small">kg{l.bpp ? ` · ${qtyHint(l, l.sysKg, l.sysBags)}` : ''}</div></> : <span className="small">đếm mù</span>}
                    {l.prev?.kg != null ? <div className="small">lần trước {fmtNum(l.prev.kg, 3)}</div> : null}</td>
                  <td><MobileCell l={l} count={count} open={open} user={user} onSaved={() => setKeep((k) => new Set(k).add(l.no))} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {open && <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={() => setAdding(true)}>＋ Có hàng không có trên hệ thống</button>}
      {open && <button className="btn primary cnt-next" disabled={!p.counted} onClick={finish}>✔ Đếm xong, gửi quản trị ({p.counted}/{p.total})</button>}
      {adding && <FoundModal count={count} locs={[...new Set(sorted.map((l) => l.location))]} user={user} onClose={() => setAdding(false)} />}
    </div>
  );
}

// Ô nhập SL thực kiểm trên điện thoại: pallet chẵn + bao lẻ (mã có quy cách) hoặc kg; lưu khi rời ô / Enter
function MobileCell({ l, count, open, user, onSaved }) {
  const round = l.c2 ? 2 : 1;
  const c = round === 2 ? l.c2 : l.c1;
  const spec = { bpp: l.bpp, bagWeight: l.bagWeight };
  const bySpec = spec.bpp && spec.bagWeight;
  const init = () => ({ pallets: c?.pallets ?? '', bags: c?.bags ?? '', kg: c?.kg ?? '' });
  const [v, setV] = useState(init);
  const [st, setSt] = useState('');
  const key = JSON.stringify(c || null);
  useEffect(() => { setV(init()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = lineResult(l);
  const commit = async () => {
    if (JSON.stringify(init()) === JSON.stringify(v)) return;
    const empty = ['pallets', 'bags', 'kg'].every((k) => v[k] === '' || v[k] == null);
    setSt('…');
    try { await saveCount(count.id, l.no, round, empty ? null : countValue(v, spec), user); setSt(''); onSaved?.(); } catch (e) { setSt(e.code === 'permission-denied' ? 'Không có quyền' : e.message); }
  };
  const inp = (k, ph) => (
    <input className="cnt-in2" type="number" inputMode="decimal" min="0" step="any" placeholder={ph} value={v[k]} disabled={!open}
      onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
  );
  return (
    <div className="cnt-cell2">
      {bySpec ? <div className="cnt-pb">{inp('pallets', 'pallet')}{inp('bags', 'bao lẻ')}</div> : inp('kg', 'kg')}
      {bySpec && (v.pallets !== '' || v.bags !== '') ? <div className="small">= {fmtNum(countValue(v, spec).kg, 3)} kg</div> : null}
      {st ? <div className="small" style={{ color: st === '…' ? undefined : 'var(--red)' }}>{st === '…' ? 'Đang lưu…' : st}</div>
        : r.counted && !count.blind ? (r.match ? <div className="cnt-tag ok">✓ Khớp</div> : <div className="cnt-tag diff">Lệch {signKg(r.diffKg)}</div>)
          : r.counted ? <div className="cnt-tag ok">✓ Đã lưu</div> : null}
    </div>
  );
}

function FoundModal({ count, locs, user, onClose }) {
  const items = useCollection('items').rows;
  const statuses = useCollection('goodsStatus').rows;
  const whs = countWhs(count);
  const [f, setF] = useState({ location: '', warehouse: whs[0] || '', item: '', lot: '', goodsStatus: 'KTC', company: count.company || '' });
  const [err, setErr] = useState('');
  const co = useCollection('companies').rows;
  const save = async () => {
    const it = items.find((i) => i.code === f.item.trim());
    if (!f.location.trim()) return setErr('Nhập vị trí.');
    if (!it) return setErr('Chọn mã hàng có trong danh mục.');
    if (!f.company) return setErr('Chọn công ty chủ hàng.');
    try {
      await addFoundLine(count, { location: f.location.trim(), warehouse: f.warehouse, item: it.code, itemName: it.name || '', lot: f.lot.trim(), goodsStatus: f.goodsStatus, company: f.company, ...specOf(it) }, user);
      onClose();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title="Hàng có thực tế, không có trên hệ thống" onClose={onClose}>
      {whs.length > 1 && <Field label="Kho" required><Select value={f.warehouse} onChange={(e) => setF({ ...f, warehouse: e.target.value })}>{whs.map((w) => <option key={w} value={w}>{whLabel(w)}</option>)}</Select></Field>}
      <Field label="Vị trí" required><input list="kk-flocs" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
      <datalist id="kk-flocs">{locs.map((x) => <option key={x} value={x} />)}</datalist>
      <Field label="Mã hàng" required><WithAdd cat="items" onAdded={(id) => setF((x) => ({ ...x, item: id }))}><input list="kk-items" value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} /></WithAdd></Field>
      <datalist id="kk-items">{items.map((i) => <option key={i.code} value={i.code}>{i.name}</option>)}</datalist>
      <Field label="Lot"><input value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} /></Field>
      <Field label="Tình trạng"><WithAdd cat="goodsStatus" onAdded={(id) => setF((x) => ({ ...x, goodsStatus: id }))}><Select value={f.goodsStatus} onChange={(e) => setF({ ...f, goodsStatus: e.target.value })}>{statuses.map((s) => <option key={s.code} value={s.code}>{s.code} – {s.name}</option>)}</Select></WithAdd></Field>
      <Field label="Công ty" required><WithAdd cat="companies" onAdded={(id) => setF((x) => ({ ...x, company: id }))}><Select value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })}><option value="">-- Chọn --</option>{co.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select></WithAdd></Field>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={onClose}>Đóng</button><button className="btn primary" onClick={save}>Thêm dòng để đếm</button></div>
    </Modal>
  );
}

// ============================================================================
// Biểu mẫu in (A4 ngang): lọc từ vị trí → đến vị trí; in trống để đếm tay hoặc in kèm số đã đếm
// ============================================================================
export function PrintCount() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { settings } = useApp();
  const { count, lines } = useCount(id);
  const [co, setCo] = useState(null);
  const [wh, setWh] = useState(null);
  useEffect(() => {
    if (!count) return;
    if (count.company) getDoc(doc(db, 'companies', count.company)).then((x) => x.exists() && setCo(x.data())).catch(() => {});
    getDoc(doc(db, 'warehouses', count.warehouse)).then((x) => x.exists() && setWh(x.data())).catch(() => {});
  }, [count?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (count === undefined) return <div className="center">Đang tải…</div>;
  if (!count) return <div className="center">Không tìm thấy phiếu {id}.</div>;
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const filled = params.get('filled') === '1';
  const hideSys = params.has('sys') ? params.get('sys') === '0' : !!count.blind;
  const setP = (k, v) => { const p = new URLSearchParams(params); if (v === '' || v == null) p.delete(k); else p.set(k, v); setParams(p, { replace: true }); };
  const locs = [...new Set(lines.map((l) => l.location))].sort(locCmp);
  const rows = lines.filter((l) => inLocRange(l.location, from, to)).sort((a, b) => locCmp(a.location, b.location) || a.no - b.no);
  const q = (c, l) => (c ? `${fmtNum(c.kg, 3)}${l.bpp ? ` (${fmtNum(c.pallets)}pl+${fmtNum(c.bags)}b)` : ''}` : '');
  return (
    <div className="print-page count-print">
      <style>{'@media print { @page { size: A4 landscape; margin: 10mm; } }'}</style>
      <div className="no-print toolbar">
        <Link className="btn" to={`/kho/kiem-ke/${id}`}>← Phiếu {id}</Link>
        <label className="small">Từ vị trí <Select value={from} onChange={(e) => setP('from', e.target.value)}><option value="">(đầu)</option>{locs.map((l) => <option key={l}>{l}</option>)}</Select></label>
        <label className="small">Đến vị trí <Select value={to} onChange={(e) => setP('to', e.target.value)}><option value="">(cuối)</option>{locs.map((l) => <option key={l}>{l}</option>)}</Select></label>
        <label className="small"><input type="checkbox" checked={!hideSys} onChange={(e) => setP('sys', e.target.checked ? '1' : '0')} /> In SL hệ thống</label>
        <label className="small"><input type="checkbox" checked={filled} onChange={(e) => setP('filled', e.target.checked ? '1' : '')} /> In kèm số đã đếm</label>
        <button className="btn primary" onClick={() => window.print()}>🖨 In / Lưu PDF</button>
      </div>
      <div className="print-head">
        <div><b>{co?.name || count.company || settings.companyName}</b><br /><span className="small">{wh ? `${wh.name}${wh.address ? ' – ' + wh.address : ''}` : `Kho ${count.warehouse}`}</span></div>
        <div style={{ textAlign: 'right' }}>Số: <b>{count.id}</b><br /><span className="small">Ngày kiểm kê {fmtDate(count.date)}</span></div>
      </div>
      <h2 className="print-title">{count.kind === 'cycle' ? 'PHIẾU CYCLE COUNT' : 'PHIẾU KIỂM KÊ HÀNG TỒN KHO'}</h2>
      <table className="print-info"><tbody>
        <tr><td>Công ty</td><td>{count.company ? `${count.company}${co?.name ? ` – ${co.name}` : ''}` : 'Tất cả công ty'}</td></tr>
        <tr><td>Kho</td><td>{whsText(count)}</td></tr>
        <tr><td>Ngày kiểm kê</td><td>{fmtDate(count.date)}</td></tr>
        <tr><td>Phạm vi</td><td>{scopeText(count)}{from || to ? ` · in từ vị trí ${from || '(đầu)'} đến ${to || '(cuối)'}` : ''}</td></tr>
      </tbody></table>
      <table className="print-lines">
        <thead><tr><th>STT</th><th>Vị trí</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>TTHH</th>{!hideSys && <th className="num">SL hệ thống (kg)</th>}
          <th>SL thực kiểm<div className="small">pallet + bao lẻ / kg</div></th><th>SL kiểm lại</th><th>SL final (kg)</th><th>Chênh lệch (kg)</th><th>Ghi chú</th></tr></thead>
        <tbody>{rows.map((l, i) => {
          const r = lineResult(l);
          return (
            <tr key={l.no}><td>{i + 1}</td><td><b>{l.location}</b></td><td>{l.item}</td><td>{l.itemName}</td><td>{l.lot}</td><td>{l.goodsStatus}</td>
              {!hideSys && <td className="num">{fmtNum(l.sysKg, 3)}{l.bpp ? <div className="small">{qtyHint(l, l.sysKg, l.sysBags)}</div> : null}</td>}
              <td style={{ minWidth: 90 }}>{filled ? q(l.c1, l) : ''}</td><td style={{ minWidth: 80 }}>{filled ? q(l.c2, l) : ''}</td>
              <td className="num" style={{ minWidth: 70 }}>{filled && r.counted ? fmtNum(r.final.kg, 3) : ''}</td>
              <td className="num" style={{ minWidth: 70 }}>{filled && r.counted && !hideSys ? signKg(r.diffKg) : ''}</td><td style={{ minWidth: 70 }}></td></tr>
          );
        })}</tbody>
        {!hideSys && <tfoot><tr><td colSpan={6}>Cộng {rows.length} dòng</td><td className="num">{fmtNum(rows.reduce((s, l) => s + Number(l.sysKg || 0), 0), 2)}</td><td colSpan={5}></td></tr></tfoot>}
      </table>
      <div className="print-signs">
        {['Người kiểm đếm', 'Người kiểm tra', 'Thủ kho', 'Kế toán'].map((s) => <div key={s}><b>{s}</b><br /><span className="small">(Ký, ghi rõ họ tên)</span><div className="sign-space" /></div>)}
      </div>
    </div>
  );
}
