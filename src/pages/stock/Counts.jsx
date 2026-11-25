import { countable, locsOfWh, whLabel } from '../../lib/whGroups';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpCompany, useStockMulti } from '../../lib/hooks';
import { CompanyPicker } from '../../components/TripBits';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtInt, fmtNum, matchQ } from '../../lib/utils';
import { COUNT_KINDS, COUNT_STATUS, assigneeText, countWhs, createCount, isAssigned, itemsMoved, lineResult, lineWh, loadLines, pickStock, scopeText, whsText } from '../../lib/counts';
import Select from '../../components/Select';
import MultiPick from '../../components/MultiPick';
import { KeeperPick, RecountModal } from './CountRecount';
import { ExtraFields, useExtraFields } from '../../components/ExtraFields';

// Kiểm kê (toàn kho / theo vị trí) và cycle count (khu vực, mã có giao dịch trong ngày): danh sách, lập phiếu, báo cáo
const pct1 = (x) => (Math.round(x * 1000) / 10).toFixed(1); // tỉ lệ → phần trăm 1 số lẻ
export default function Counts() {
  const { hasRole, email } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'phieu';
  const canManage = hasRole('thu_kho');
  const { rows: all, loading, error } = useCollection('stockCounts');
  const warehouses = useMyWarehouses();
  const mine = useMemo(() => new Set(warehouses.map((w) => w.code)), [warehouses]);
  const counts = useMemo(() => all.filter((c) => mine.has(c.warehouse)).sort((a, b) => String(b.id).localeCompare(String(a.id))), [all, mine]);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();

  return (
    <div>
      <div className="page-head">
        <h1>🧮 Kiểm kê & cycle count</h1>
        <div className="actions">
          <div className="seg">
            <button type="button" className={tab === 'phieu' ? 'on' : ''} onClick={() => setParams({ tab: 'phieu' })}>Phiếu kiểm kê</button>
            <button type="button" className={tab === 'bao-cao' ? 'on' : ''} onClick={() => setParams({ tab: 'bao-cao' })}>Báo cáo chênh lệch</button>
          </div>
          {canManage && <button className="btn primary" onClick={() => setCreating(true)}>＋ Lập phiếu kiểm kê / cycle count</button>}
        </div>
      </div>
      <ErrorBox error={error} />
      {tab === 'bao-cao' ? <Report counts={counts} /> : <List counts={counts} loading={loading} email={email} />}
      {creating && <CreateCount onClose={(id) => { setCreating(false); if (id) nav(`/kho/kiem-ke/${id}`); }} />}
    </div>
  );
}

function StatusBadge({ s }) {
  const m = COUNT_STATUS[s] || { label: s, cls: '' };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function List({ counts, loading, email }) {
  const [kind, setKind] = useState('');
  const [st, setSt] = useState('active');
  const [q, setQ] = useState('');
  const mineOpen = counts.filter((c) => c.status === 'open' && isAssigned(c, email));
  const rows = counts.filter((c) => (!kind || c.kind === kind) && (st === 'all' || (st === 'mine' ? isAssigned(c, email) : st === 'active' ? ['preparing', 'open', 'done'].includes(c.status) : c.status === st))
    && matchQ(q, c.id, c.company, whsText(c), countWhs(c).join(' '), scopeText(c), assigneeText(c), c.createdByName, c.createdBy, c.note, c.date, fmtDate(c.date)));
  return (
    <>
      {mineOpen.length > 0 && (
        <div className="cnt-mine">
          <b>📱 Lệnh kiểm đếm giao cho bạn ({mineOpen.length})</b>
          {mineOpen.map((c) => (
            <Link key={c.id} className="cnt-locbtn" to={`/kho/kiem-ke/${c.id}/dem`}>
              <b>{c.id} · {COUNT_KINDS[c.kind]}</b><span>{fmtDate(c.date)} · {whsText(c)} · {fmtInt(c.nLines)} dòng · {scopeText(c)} →</span>
            </Link>
          ))}
        </div>
      )}
      <p className="hint">
        Chỉ làm ở <b>kho Đức Hòa</b> (chọn được nhiều kho pháp nhân cùng lúc để đi đếm 1 lần). Quản trị lập lệnh theo <b>hàng có giao dịch</b> hoặc <b>mã hàng chọn</b>, giao cho thủ kho;
        thủ kho mở app (📱 Đếm) thấy Vị trí, Mã hàng, SL hệ thống và nhập SL thực kiểm. Quản trị xem báo cáo chênh lệch, tạo lệnh đếm lại các dòng lệch, rồi duyệt điều chỉnh tồn.
      </p>
      <div className="filters">
        <input type="search" placeholder="Tìm số phiếu, kho, vị trí, mã hàng, thủ kho…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Mọi loại</option>
          {Object.entries(COUNT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <Select value={st} onChange={(e) => setSt(e.target.value)}>
          <option value="active">Đang đếm / chưa điều chỉnh</option>
          <option value="mine">Giao cho tôi</option>
          <option value="done">Chờ duyệt</option>
          <option value="adjusted">Đã điều chỉnh tồn</option>
          <option value="closed">Duyệt, không điều chỉnh</option>
          <option value="cancelled">Đã hủy</option>
          <option value="all">Tất cả</option>
        </Select>
      </div>
      {loading ? <div className="center">Đang tải…</div> : !rows.length ? <Empty text="Chưa có phiếu kiểm kê" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Số phiếu</th><th>Loại</th><th>Ngày</th><th>Công ty</th><th>Kho</th><th>Phạm vi</th><th className="num">Số dòng</th><th>Thủ kho đếm</th><th>Trạng thái</th><th>Người lập</th><th></th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td>{COUNT_KINDS[c.kind]}{c.blind ? <span className="small"> · đếm mù</span> : null}</td>
                  <td>{fmtDate(c.date)}</td><td>{c.company || 'Tất cả'}</td><td className="small">{whsText(c)}</td>
                  <td className="small">{scopeText(c)}</td><td className="num">{fmtInt(c.nLines)}</td>
                  <td className="small">{assigneeText(c) || '–'}</td>
                  <td><StatusBadge s={c.status} />{c.recountIds?.length ? <div className="small">đếm lại: {c.recountIds.join(', ')}</div> : null}</td><td className="small">{c.createdByName || c.createdBy}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Link className="btn sm" to={`/kho/kiem-ke/${c.id}`}>👁 Xem</Link>{' '}
                    {c.status === 'open' && <Link className="btn sm primary" to={`/kho/kiem-ke/${c.id}/dem`}>📱 Đếm</Link>}{' '}
                    <Link className="btn sm" to={`/kho/kiem-ke/${c.id}/in`} target="_blank">🖨 In</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const SCOPES = [['moved', 'Hàng có giao dịch'], ['items', 'Chọn mã hàng'], ['all', 'Toàn bộ tồn']];

function CreateCount({ onClose }) {
  const { email, name } = useApp();
  const myWhs = useMyWarehouses();
  const dhWhs = useMemo(() => myWhs.filter((w) => countable(w.code)), [myWhs]);
  const [opCo] = useOpCompany();
  const items = useCollection('items').rows;
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const [f, setF] = useState({ kind: 'cycle', company: opCo || '', warehouses: [], date: vnDate(), mode: 'moved', movedFrom: vnDate(), movedTo: vnDate(),
    items: [], locFrom: '', locTo: '', areas: '', showSys: true, assignees: [], note: '' });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  // Mặc định chọn hết các kho Đức Hòa được giao
  useEffect(() => { if (!f.warehouses.length && dhWhs.length) set({ warehouses: dhWhs.map((w) => w.code) }); }, [dhWhs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const whs = f.warehouses;
  const { rows: stock, loading } = useStockMulti(whs);
  const locRows = useCollection('locations').rows;
  const locs = [...new Set(whs.flatMap((w) => locsOfWh(locRows, w).map((l) => l.code)))];
  const [moved, setMoved] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ex = useExtraFields('stockCount');
  const scope = {
    locFrom: f.locFrom.trim(), locTo: f.locTo.trim(), areas: f.areas.trim(), mode: f.mode,
    ...(f.mode === 'items' ? { items: f.items } : {}), ...(f.mode === 'moved' ? { movedFrom: f.movedFrom, movedTo: f.movedTo || f.movedFrom } : {}),
  };
  const whKey = whs.join(',');
  useEffect(() => {
    setMoved(null);
    if (f.mode !== 'moved' || !whs.length || !f.movedFrom) return undefined;
    let off = false;
    itemsMoved(whs, f.movedFrom, f.movedTo || f.movedFrom).then((m) => !off && setMoved(m)).catch((e) => !off && setErr(e.message));
    return () => { off = true; };
  }, [f.mode, whKey, f.movedFrom, f.movedTo]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => pickStock(stock, { ...scope, warehouses: whs, company: f.company }, f.mode === 'moved' ? moved || new Set() : null),
    [stock, f.company, whKey, scope.locFrom, scope.locTo, scope.areas, f.mode, f.items, moved]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mã hàng có tồn ở các kho đã chọn (để chọn kiểm theo mã)
  const itemOpts = useMemo(() => {
    const m = new Map();
    for (const r of stock) { if (!whs.includes(r.warehouse) || (f.company && r.company !== f.company)) continue; m.set(r.item, (m.get(r.item) || 0) + Number(r.kg || 0)); }
    return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([code, kg]) => ({ value: code, label: `${code} – ${itemMap.get(code)?.name || ''} · ${fmtNum(kg)} kg`, short: code }));
  }, [stock, whKey, f.company, itemMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setErr('');
    if (!whs.length) return setErr('Chọn ít nhất 1 kho Đức Hòa.');
    if (f.mode === 'items' && !f.items.length) return setErr('Chọn mã hàng cần kiểm.');
    if (f.kind === 'cycle' && !f.assignees.length) return setErr('Chọn thủ kho đi đếm.');
    if (ex.missing()) return setErr(`Vui lòng nhập: ${ex.missing()}`);
    setBusy(true);
    try {
      const id = await createCount({ kind: f.kind, company: f.company, warehouses: whs, date: f.date, scope, blind: !f.showSys, assignees: f.assignees, note: f.note.trim(), ...ex.values() }, stock, itemMap, { email, name });
      onClose(id);
    } catch (e) {
      setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập phiếu kiểm kê cho kho này.' : e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Lập lệnh kiểm kê / cycle count" onClose={() => onClose('')} wide>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={f.kind === 'cycle' ? 'on' : ''} onClick={() => set({ kind: 'cycle' })}>Cycle count</button>
        <button type="button" className={f.kind === 'full' ? 'on' : ''} onClick={() => set({ kind: 'full', mode: 'all' })}>Kiểm kê (toàn kho / dãy vị trí)</button>
      </div>
      {!dhWhs.length && <div className="error-box">Kiểm kê chỉ áp dụng cho kho Đức Hòa, bạn chưa được giao kho Đức Hòa nào.</div>}
      <div className="form-grid">
        <Field label="Kho Đức Hòa" required help="Chọn nhiều kho pháp nhân để đi đếm 1 lần">
          <MultiPick value={whs} onChange={(v) => set({ warehouses: v, items: [] })} allLabel="-- Chọn kho --" unit="kho"
            opts={dhWhs.map((w) => ({ value: w.code, label: whLabel(w.code), short: w.code }))} />
        </Field>
        <Field label="Công ty"><CompanyPicker value={f.company} onChange={(v) => set({ company: v })} /></Field>
        <Field label="Ngày kiểm" required><input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        <Field label="Kiểm theo" full>
          <div className="seg">
            {SCOPES.map(([k, l]) => <button key={k} type="button" className={f.mode === k ? 'on' : ''} onClick={() => set({ mode: k })}>{l}</button>)}
          </div>
        </Field>
        {f.mode === 'moved' && <>
          <Field label="Có giao dịch từ ngày" required><input type="date" value={f.movedFrom} onChange={(e) => set({ movedFrom: e.target.value })} /></Field>
          <Field label="Đến ngày" required><input type="date" value={f.movedTo} onChange={(e) => set({ movedTo: e.target.value })} /></Field>
        </>}
        {f.mode === 'items' && (
          <Field label="Mã hàng cần kiểm" required full help="Chỉ hiện mã đang có tồn ở kho đã chọn">
            <MultiPick value={f.items} onChange={(v) => set({ items: v })} opts={itemOpts} allLabel="-- Chọn mã hàng --" unit="mã" />
          </Field>
        )}
        <Field label="Thủ kho đi đếm" required={f.kind === 'cycle'}><KeeperPick whs={whs} value={f.assignees} onChange={(v) => set({ assignees: v })} /></Field>
        <Field label="Số hệ thống">
          <label className="small"><input type="checkbox" checked={f.showSys} onChange={(e) => set({ showSys: e.target.checked })} /> Thủ kho thấy SL hệ thống khi đếm (bỏ tích = đếm mù)</label>
        </Field>
        <Field label="Từ vị trí"><input list="kk-locs" value={f.locFrom} onChange={(e) => set({ locFrom: e.target.value })} placeholder="Để trống = đầu kho" /></Field>
        <Field label="Đến vị trí"><input list="kk-locs" value={f.locTo} onChange={(e) => set({ locTo: e.target.value })} placeholder="Để trống = cuối kho" /></Field>
        <Field label="Khu vực (đầu mã vị trí)" help="Vd. A, B1 (cách nhau dấu phẩy)"><input value={f.areas} onChange={(e) => set({ areas: e.target.value })} /></Field>
        <Field label="Ghi chú" full><input value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>
      </div>
      <ExtraFields ex={ex} />
      <datalist id="kk-locs">{locs.map((l) => <option key={l} value={l} />)}</datalist>
      <p className="small">
        {loading || (f.mode === 'moved' && !moved && whs.length) ? 'Đang tải tồn kho…' : <>Lệnh sẽ có <b>{fmtInt(preview.length)}</b> dòng tồn ({fmtNum(preview.reduce((s, r) => s + Number(r.kg || 0), 0), 3)} kg) ở {new Set(preview.map((r) => r.location)).size} vị trí, {new Set(preview.map((r) => r.item)).size} mã hàng.</>}
        {' '}Số hệ thống được chụp lại lúc lập lệnh.
      </p>
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={() => onClose('')}>Đóng</button>
        <button className="btn primary" disabled={busy || loading || !whs.length} onClick={save}>{busy ? 'Đang lập…' : 'Lập lệnh và giao thủ kho'}</button>
      </div>
    </Modal>
  );
}

// Báo cáo chênh lệch: độ chính xác theo phiếu + danh sách dòng lệch; quản trị chọn dòng lệch → tạo lệnh đếm lại
function Report({ counts }) {
  const { isAdmin } = useApp();
  const nav = useNavigate();
  const [from, setFrom] = useState(vnDate().slice(0, 8) + '01');
  const [to, setTo] = useState(vnDate());
  const [kind, setKind] = useState('');
  const [wh, setWh] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState(new Set());
  const [recount, setRecount] = useState(null);
  const list = counts.filter((c) => c.status !== 'cancelled' && c.date >= from && c.date <= to && (!kind || c.kind === kind) && (!wh || countWhs(c).includes(wh)));
  const whs = [...new Set(counts.flatMap(countWhs))].sort();
  const reset = () => { setData(null); setPick(new Set()); };

  const run = async () => {
    setBusy(true); setErr(''); setPick(new Set());
    try {
      const out = [];
      for (const c of list) out.push({ c, lines: await loadLines(c.id) });
      setData(out);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const summary = (data || []).map(({ c, lines }) => {
    const res = lines.map((l) => ({ l, r: lineResult(l) }));
    const counted = res.filter((x) => x.r.counted);
    const match = counted.filter((x) => x.r.match);
    const plus = counted.reduce((s, x) => s + Math.max(0, x.r.diffKg), 0);
    const minus = counted.reduce((s, x) => s + Math.min(0, x.r.diffKg), 0);
    const who = [...new Set(counted.flatMap((x) => [x.l.c1?.byName, x.l.c2?.byName]).filter(Boolean))].join(', ');
    return { c, lines: res, n: lines.length, counted: counted.length, match: match.length, plus, minus, who,
      sysKg: lines.reduce((s, l) => s + Number(l.sysKg || 0), 0) };
  });
  const tot = summary.reduce((a, s) => ({ n: a.n + s.n, counted: a.counted + s.counted, match: a.match + s.match, plus: a.plus + s.plus, minus: a.minus + s.minus }),
    { n: 0, counted: 0, match: 0, plus: 0, minus: 0 });
  const pct = (a, b) => (b ? `${pct1(a / b)}%` : '–');
  const diffs = summary.flatMap((s) => s.lines.filter((x) => x.r.counted && !x.r.match).map((x) => ({ c: s.c, ...x, key: `${s.c.id}-${x.l.no}` })));
  const togg = (k) => setPick((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allOn = diffs.length > 0 && diffs.every((d) => pick.has(d.key));
  const openRecount = () => setRecount(diffs.filter((d) => pick.has(d.key)).map(({ c, l }) => ({ ...l, warehouse: lineWh(l, c), countId: c.id, companyOfCount: c.company || '' })));

  const excel = () => exportSheets(`Bao_cao_chenh_lech_kiem_ke_${from}_${to}`, {
    'Tổng hợp': summary.map((s) => ({ 'Số phiếu': s.c.id, Loại: COUNT_KINDS[s.c.kind], Ngày: fmtDate(s.c.date), 'Công ty': s.c.company || 'Tất cả', Kho: whsText(s.c),
      'Phạm vi': scopeText(s.c), 'Thủ kho': assigneeText(s.c), 'Số dòng': s.n, 'Đã đếm': s.counted, 'Khớp': s.match, 'Lệch': s.counted - s.match,
      '% chính xác': s.counted ? Math.round((s.match / s.counted) * 1000) / 10 : '', 'Thừa (kg)': s.plus, 'Thiếu (kg)': s.minus, 'Người đếm': s.who, 'Trạng thái': COUNT_STATUS[s.c.status]?.label })),
    'Dòng lệch': diffs.map(({ c, l, r }) => ({ 'Số phiếu': c.id, Ngày: fmtDate(c.date), Kho: whLabel(lineWh(l, c)), 'Công ty': l.company, 'Vị trí': l.location, 'Mã hàng': l.item, 'Tên hàng': l.itemName,
      Lot: l.lot, TTHH: l.goodsStatus, 'SL hệ thống (kg)': l.sysKg, 'Thực kiểm (kg)': l.c1?.kg ?? '', 'Kiểm lại (kg)': l.c2?.kg ?? '', 'Final (kg)': r.final.kg,
      'Chênh lệch (kg)': r.diffKg, 'Chênh lệch (bao)': l.bpp ? r.diffBags : '', 'Người đếm': (l.c2 || l.c1)?.byName || '' })),
  });

  return (
    <>
      <div className="filters">
        <label className="small">Từ ngày <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} /></label>
        <label className="small">Đến ngày <input type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} /></label>
        <Select value={kind} onChange={(e) => { setKind(e.target.value); reset(); }}>
          <option value="">Kiểm kê + cycle count</option><option value="cycle">Cycle count</option><option value="full">Kiểm kê</option>
        </Select>
        <Select value={wh} onChange={(e) => { setWh(e.target.value); reset(); }}>
          <option value="">Mọi kho</option>{whs.map((w) => <option key={w} value={w}>{whLabel(w)}</option>)}
        </Select>
        <button className="btn primary" disabled={busy || !list.length} onClick={run}>{busy ? 'Đang tải…' : `Xem báo cáo (${list.length} phiếu)`}</button>
        {data && <button className="btn" onClick={excel}>⬇ Excel</button>}
      </div>
      <ErrorBox error={err} />
      {data && (
        <>
          <div className="stats">
            <div className="stat"><div className="stat-label">Dòng đã đếm / tổng</div><div className="stat-value">{fmtInt(tot.counted)} / {fmtInt(tot.n)}</div><div className="stat-sub">{pct(tot.counted, tot.n)} hoàn thành</div></div>
            <div className="stat green"><div className="stat-label">Độ chính xác (dòng khớp / đã đếm)</div><div className="stat-value">{pct(tot.match, tot.counted)}</div><div className="stat-sub">{fmtInt(tot.match)} dòng khớp</div></div>
            <div className="stat red"><div className="stat-label">Dòng lệch</div><div className="stat-value">{fmtInt(tot.counted - tot.match)}</div><div className="stat-sub">thừa {fmtNum(tot.plus)} kg · thiếu {fmtNum(-tot.minus)} kg</div></div>
          </div>
          <h3>Theo phiếu</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Số phiếu</th><th>Ngày</th><th>Kho</th><th>Phạm vi</th><th>Thủ kho</th><th className="num">Dòng</th><th className="num">Đã đếm</th><th className="num">Khớp</th><th className="num">Lệch</th><th className="num">% chính xác</th><th className="num">Thừa (kg)</th><th className="num">Thiếu (kg)</th><th>Trạng thái</th><th></th></tr></thead>
              <tbody>{summary.map((s) => (
                <tr key={s.c.id}>
                  <td className="mono">{s.c.id}</td><td>{fmtDate(s.c.date)}</td><td className="small">{whsText(s.c)}</td><td className="small">{scopeText(s.c)}</td><td className="small">{assigneeText(s.c) || s.who}</td>
                  <td className="num">{s.n}</td><td className="num">{s.counted}</td><td className="num">{s.match}</td><td className="num">{s.counted - s.match}</td>
                  <td className="num"><b>{pct(s.match, s.counted)}</b></td><td className="num">{fmtNum(s.plus)}</td><td className="num">{fmtNum(-s.minus)}</td>
                  <td><StatusBadge s={s.c.status} /></td><td><Link className="btn sm" to={`/kho/kiem-ke/${s.c.id}`}>👁 Xem</Link></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="filters" style={{ marginTop: 14 }}>
            <h3 style={{ margin: 0 }}>Dòng lệch ({diffs.length})</h3>
            <span style={{ flex: 1 }} />
            {isAdmin && diffs.length > 0 && <button className="btn primary" disabled={!pick.size} onClick={openRecount}>🔁 Tạo lệnh đếm lại ({pick.size} dòng)</button>}
          </div>
          {!diffs.length ? <Empty text="Không có dòng lệch" /> : (
            <div className="table-wrap">
              <table>
                <thead><tr>{isAdmin && <th><input type="checkbox" checked={allOn} onChange={() => setPick(allOn ? new Set() : new Set(diffs.map((d) => d.key)))} title="Chọn hết" /></th>}
                  <th>Số phiếu</th><th>Kho</th><th>Vị trí</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>TTHH</th><th className="num">Hệ thống (kg)</th><th className="num">Thực kiểm</th><th className="num">Kiểm lại</th><th className="num">Final</th><th className="num">Chênh lệch (kg)</th><th>Người đếm</th></tr></thead>
                <tbody>{diffs.map(({ c, l, r, key }) => (
                  <tr key={key}>
                    {isAdmin && <td><input type="checkbox" checked={pick.has(key)} onChange={() => togg(key)} /></td>}
                    <td className="mono small">{c.id}</td><td className="small">{whLabel(lineWh(l, c))}</td><td><b>{l.location}</b></td><td>{l.item}{l.extra ? <span className="badge amber"> ngoài hệ thống</span> : null}</td><td>{l.itemName}</td><td>{l.lot}</td><td>{l.goodsStatus}</td>
                    <td className="num">{fmtNum(l.sysKg)}</td><td className="num">{l.c1 ? fmtNum(l.c1.kg) : ''}</td><td className="num">{l.c2 ? fmtNum(l.c2.kg) : ''}</td>
                    <td className="num">{fmtNum(r.final.kg)}</td><td className="num" style={{ color: r.diffKg < 0 ? 'var(--red)' : 'var(--green)' }}><b>{r.diffKg > 0 ? '+' : ''}{fmtNum(r.diffKg)}</b>{l.bpp ? <div className="small">{r.diffBags > 0 ? '+' : ''}{fmtInt(r.diffBags)} bao</div> : null}</td>
                    <td className="small">{(l.c2 || l.c1)?.byName}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
      {recount && <RecountModal lines={recount} onClose={(id) => { setRecount(null); if (id) nav(`/kho/kiem-ke/${id}`); }} />}
    </>
  );
}
