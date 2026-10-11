import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpCompany, useOpWarehouse, useStock } from '../../lib/hooks';
import { CompanyPicker } from '../../components/TripBits';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtNum } from '../../lib/utils';
import { COUNT_KINDS, COUNT_STATUS, createCount, lineResult, loadLines, pickStock, scopeText } from '../../lib/counts';

// Kiểm kê (toàn kho / theo vị trí) và cycle count (khu vực, mã có giao dịch trong ngày): danh sách, lập phiếu, báo cáo
export default function Counts() {
  const { hasRole } = useApp();
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
            <button type="button" className={tab === 'bao-cao' ? 'on' : ''} onClick={() => setParams({ tab: 'bao-cao' })}>Báo cáo cycle count</button>
          </div>
          {canManage && <button className="btn primary" onClick={() => setCreating(true)}>＋ Lập phiếu kiểm kê / cycle count</button>}
        </div>
      </div>
      <ErrorBox error={error} />
      {tab === 'bao-cao' ? <Report counts={counts} /> : <List counts={counts} loading={loading} />}
      {creating && <CreateCount onClose={(id) => { setCreating(false); if (id) nav(`/kho/kiem-ke/${id}`); }} />}
    </div>
  );
}

function StatusBadge({ s }) {
  const m = COUNT_STATUS[s] || { label: s, cls: '' };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function List({ counts, loading }) {
  const [kind, setKind] = useState('');
  const [st, setSt] = useState('active');
  const rows = counts.filter((c) => (!kind || c.kind === kind) && (st === 'all' || (st === 'active' ? ['preparing', 'open', 'done'].includes(c.status) : c.status === st)));
  return (
    <>
      <p className="hint">
        <b>Kiểm kê</b>: đếm toàn kho hoặc theo dãy vị trí, in biểu mẫu để đếm trên giấy rồi nhập lại, hoặc đếm trên điện thoại.
        <b> Cycle count</b>: quản trị chỉ định khu vực / vị trí / mã hàng có giao dịch trong ngày; nhân viên mở trên điện thoại, đến từng vị trí nhập số pallet chẵn và số bao lẻ, hệ thống báo ngay khớp hay lệch. Thủ kho chỉ nhập số đếm và chốt gửi duyệt; tồn kho chỉ điều chỉnh khi quản trị duyệt.
      </p>
      <div className="filters">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Mọi loại</option>
          {Object.entries(COUNT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={st} onChange={(e) => setSt(e.target.value)}>
          <option value="active">Đang đếm / chưa điều chỉnh</option>
          <option value="done">Chờ duyệt</option>
          <option value="adjusted">Đã điều chỉnh tồn</option>
          <option value="closed">Duyệt, không điều chỉnh</option>
          <option value="cancelled">Đã hủy</option>
          <option value="all">Tất cả</option>
        </select>
      </div>
      {loading ? <div className="center">Đang tải…</div> : !rows.length ? <Empty text="Chưa có phiếu kiểm kê" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Số phiếu</th><th>Loại</th><th>Ngày</th><th>Công ty</th><th>Kho</th><th>Phạm vi</th><th className="num">Số dòng</th><th>Trạng thái</th><th>Người lập</th><th></th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td><Link className="mono" to={`/kho/kiem-ke/${c.id}`}>{c.id}</Link></td>
                  <td>{COUNT_KINDS[c.kind]}{c.blind ? <span className="small"> · đếm mù</span> : null}</td>
                  <td>{fmtDate(c.date)}</td><td>{c.company || 'Tất cả'}</td><td>{c.warehouse}</td>
                  <td className="small">{scopeText(c)}</td><td className="num">{fmtNum(c.nLines)}</td>
                  <td><StatusBadge s={c.status} /></td><td className="small">{c.createdByName || c.createdBy}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
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

function CreateCount({ onClose }) {
  const { email, name } = useApp();
  const warehouses = useMyWarehouses();
  const [opWh, setOpWh] = useOpWarehouse();
  const [opCo] = useOpCompany();
  const items = useCollection('items').rows;
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const [f, setF] = useState({ kind: 'cycle', company: opCo || '', warehouse: warehouses.some((w) => w.code === opWh) ? opWh : warehouses[0]?.code || '', date: vnDate(),
    locFrom: '', locTo: '', areas: '', items: '', moved: false, movedOn: vnDate(), blind: true, note: '' });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const { rows: stock, loading } = useStock(f.warehouse || '__none__');
  const locs = useCollection('locations').rows.filter((l) => l.warehouse === f.warehouse).map((l) => l.code);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const scope = { locFrom: f.locFrom.trim(), locTo: f.locTo.trim(), areas: f.areas.trim(), items: f.items.trim(), ...(f.moved ? { movedOn: f.movedOn } : {}) };
  const preview = useMemo(() => pickStock(stock, { ...scope, company: f.company }, null), [stock, f.company, scope.locFrom, scope.locTo, scope.areas, scope.items]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setErr('');
    if (!f.warehouse) return setErr('Chọn kho.');
    setBusy(true);
    try {
      const id = await createCount({ kind: f.kind, company: f.company, warehouse: f.warehouse, date: f.date, scope, blind: f.blind, note: f.note.trim() }, stock, itemMap, { email, name });
      setOpWh(f.warehouse);
      onClose(id);
    } catch (e) {
      setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập phiếu kiểm kê cho kho này.' : e.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Lập phiếu kiểm kê / cycle count" onClose={() => onClose('')} wide>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={f.kind === 'cycle' ? 'on' : ''} onClick={() => set({ kind: 'cycle', blind: true })}>Cycle count (chỉ định khu vực / mã)</button>
        <button type="button" className={f.kind === 'full' ? 'on' : ''} onClick={() => set({ kind: 'full', blind: false })}>Kiểm kê (toàn kho / dãy vị trí)</button>
      </div>
      <div className="form-grid">
        <Field label="Công ty"><CompanyPicker value={f.company} onChange={(v) => set({ company: v })} /></Field>
        <Field label="Kho" required>
          <select value={f.warehouse} onChange={(e) => set({ warehouse: e.target.value })}>
            <option value="">-- Chọn kho --</option>
            {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
          </select>
        </Field>
        <Field label="Ngày kiểm kê" required><input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        <Field label="Từ vị trí"><input list="kk-locs" value={f.locFrom} onChange={(e) => set({ locFrom: e.target.value })} placeholder="Để trống = đầu kho" /></Field>
        <Field label="Đến vị trí"><input list="kk-locs" value={f.locTo} onChange={(e) => set({ locTo: e.target.value })} placeholder="Để trống = cuối kho" /></Field>
        <Field label="Khu vực (đầu mã vị trí)" help="Vd. A, B1 (cách nhau dấu phẩy)"><input value={f.areas} onChange={(e) => set({ areas: e.target.value })} /></Field>
        <Field label="Chỉ các mã hàng" help="Danh sách mã, cách nhau dấu phẩy"><input value={f.items} onChange={(e) => set({ items: e.target.value })} /></Field>
        <Field label="Mã có giao dịch trong ngày">
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={f.moved} onChange={(e) => set({ moved: e.target.checked })} /> Chỉ mã có phiếu nhập/xuất/chuyển ngày
            <input type="date" value={f.movedOn} disabled={!f.moved} onChange={(e) => set({ movedOn: e.target.value })} />
          </label>
        </Field>
        <Field label="Đếm mù">
          <label className="small"><input type="checkbox" checked={f.blind} onChange={(e) => set({ blind: e.target.checked })} /> Nhân viên không thấy số hệ thống trước khi nhập số đếm</label>
        </Field>
        <Field label="Ghi chú" full><input value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>
      </div>
      <datalist id="kk-locs">{locs.map((l) => <option key={l} value={l} />)}</datalist>
      <p className="small">
        {loading ? 'Đang tải tồn kho…' : <>Phạm vi hiện có <b>{preview.length}</b> dòng tồn ({fmtNum(preview.reduce((s, r) => s + Number(r.kg || 0), 0), 2)} kg) ở {new Set(preview.map((r) => r.location)).size} vị trí{f.moved ? '; sẽ lọc tiếp theo mã có giao dịch ngày đã chọn khi lập phiếu' : ''}.</>}
        {' '}Số hệ thống được chụp lại lúc lập phiếu.
      </p>
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={() => onClose('')}>Đóng</button>
        <button className="btn primary" disabled={busy || loading || !f.warehouse} onClick={save}>{busy ? 'Đang lập…' : 'Lập phiếu'}</button>
      </div>
    </Modal>
  );
}

// Báo cáo cycle count: độ chính xác theo phiếu + danh sách dòng lệch
function Report({ counts }) {
  const [from, setFrom] = useState(vnDate().slice(0, 8) + '01');
  const [to, setTo] = useState(vnDate());
  const [kind, setKind] = useState('cycle');
  const [wh, setWh] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const list = counts.filter((c) => c.status !== 'cancelled' && c.date >= from && c.date <= to && (!kind || c.kind === kind) && (!wh || c.warehouse === wh));
  const whs = [...new Set(counts.map((c) => c.warehouse))].sort();

  const run = async () => {
    setBusy(true); setErr('');
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
  const pct = (a, b) => (b ? `${fmtNum((a / b) * 100, 1)}%` : '–');
  const diffs = summary.flatMap((s) => s.lines.filter((x) => x.r.counted && !x.r.match).map((x) => ({ c: s.c, ...x })));

  const excel = () => exportSheets(`Bao_cao_cycle_count_${from}_${to}`, {
    'Tổng hợp': summary.map((s) => ({ 'Số phiếu': s.c.id, Loại: COUNT_KINDS[s.c.kind], Ngày: fmtDate(s.c.date), 'Công ty': s.c.company || 'Tất cả', Kho: s.c.warehouse,
      'Phạm vi': scopeText(s.c), 'Số dòng': s.n, 'Đã đếm': s.counted, 'Khớp': s.match, 'Lệch': s.counted - s.match,
      '% chính xác': s.counted ? Math.round((s.match / s.counted) * 1000) / 10 : '', 'Thừa (kg)': s.plus, 'Thiếu (kg)': s.minus, 'Người đếm': s.who, 'Trạng thái': COUNT_STATUS[s.c.status]?.label })),
    'Dòng lệch': diffs.map(({ c, l, r }) => ({ 'Số phiếu': c.id, Ngày: fmtDate(c.date), Kho: c.warehouse, 'Công ty': l.company, 'Vị trí': l.location, 'Mã hàng': l.item, 'Tên hàng': l.itemName,
      Lot: l.lot, TTHH: l.goodsStatus, 'SL hệ thống (kg)': l.sysKg, 'Thực kiểm (kg)': l.c1?.kg ?? '', 'Kiểm lại (kg)': l.c2?.kg ?? '', 'Final (kg)': r.final.kg,
      'Chênh lệch (kg)': r.diffKg, 'Chênh lệch (bao)': l.bpp ? r.diffBags : '', 'Người đếm': (l.c2 || l.c1)?.byName || '' })),
  });

  return (
    <>
      <div className="filters">
        <label className="small">Từ ngày <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setData(null); }} /></label>
        <label className="small">Đến ngày <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setData(null); }} /></label>
        <select value={kind} onChange={(e) => { setKind(e.target.value); setData(null); }}>
          <option value="cycle">Cycle count</option><option value="full">Kiểm kê</option><option value="">Cả hai</option>
        </select>
        <select value={wh} onChange={(e) => { setWh(e.target.value); setData(null); }}>
          <option value="">Mọi kho</option>{whs.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        <button className="btn primary" disabled={busy || !list.length} onClick={run}>{busy ? 'Đang tải…' : `Xem báo cáo (${list.length} phiếu)`}</button>
        {data && <button className="btn" onClick={excel}>⬇ Excel</button>}
      </div>
      <ErrorBox error={err} />
      {data && (
        <>
          <div className="stats">
            <div className="stat"><div className="stat-label">Dòng đã đếm / tổng</div><div className="stat-value">{fmtNum(tot.counted)} / {fmtNum(tot.n)}</div><div className="stat-sub">{pct(tot.counted, tot.n)} hoàn thành</div></div>
            <div className="stat green"><div className="stat-label">Độ chính xác (dòng khớp / đã đếm)</div><div className="stat-value">{pct(tot.match, tot.counted)}</div><div className="stat-sub">{fmtNum(tot.match)} dòng khớp</div></div>
            <div className="stat red"><div className="stat-label">Dòng lệch</div><div className="stat-value">{fmtNum(tot.counted - tot.match)}</div><div className="stat-sub">thừa {fmtNum(tot.plus, 2)} kg · thiếu {fmtNum(-tot.minus, 2)} kg</div></div>
          </div>
          <h3>Theo phiếu</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Số phiếu</th><th>Ngày</th><th>Kho</th><th>Phạm vi</th><th className="num">Dòng</th><th className="num">Đã đếm</th><th className="num">Khớp</th><th className="num">Lệch</th><th className="num">% chính xác</th><th className="num">Thừa (kg)</th><th className="num">Thiếu (kg)</th><th>Người đếm</th><th>Trạng thái</th></tr></thead>
              <tbody>{summary.map((s) => (
                <tr key={s.c.id}>
                  <td><Link className="mono" to={`/kho/kiem-ke/${s.c.id}`}>{s.c.id}</Link></td><td>{fmtDate(s.c.date)}</td><td>{s.c.warehouse}</td><td className="small">{scopeText(s.c)}</td>
                  <td className="num">{s.n}</td><td className="num">{s.counted}</td><td className="num">{s.match}</td><td className="num">{s.counted - s.match}</td>
                  <td className="num"><b>{pct(s.match, s.counted)}</b></td><td className="num">{fmtNum(s.plus, 2)}</td><td className="num">{fmtNum(-s.minus, 2)}</td>
                  <td className="small">{s.who}</td><td><StatusBadge s={s.c.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <h3>Dòng lệch ({diffs.length})</h3>
          {!diffs.length ? <Empty text="Không có dòng lệch" /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Số phiếu</th><th>Vị trí</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>TTHH</th><th className="num">Hệ thống (kg)</th><th className="num">Thực kiểm</th><th className="num">Kiểm lại</th><th className="num">Final</th><th className="num">Chênh lệch (kg)</th><th>Người đếm</th></tr></thead>
                <tbody>{diffs.map(({ c, l, r }) => (
                  <tr key={`${c.id}-${l.no}`}>
                    <td className="mono small">{c.id}</td><td><b>{l.location}</b></td><td>{l.item}{l.extra ? <span className="badge amber"> ngoài hệ thống</span> : null}</td><td>{l.itemName}</td><td>{l.lot}</td><td>{l.goodsStatus}</td>
                    <td className="num">{fmtNum(l.sysKg, 2)}</td><td className="num">{l.c1 ? fmtNum(l.c1.kg, 2) : ''}</td><td className="num">{l.c2 ? fmtNum(l.c2.kg, 2) : ''}</td>
                    <td className="num">{fmtNum(r.final.kg, 2)}</td><td className="num" style={{ color: r.diffKg < 0 ? 'var(--red)' : 'var(--green)' }}><b>{r.diffKg > 0 ? '+' : ''}{fmtNum(r.diffKg, 2)}</b>{l.bpp ? <div className="small">{r.diffBags > 0 ? '+' : ''}{fmtNum(r.diffBags)} bao</div> : null}</td>
                    <td className="small">{(l.c2 || l.c1)?.byName}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
