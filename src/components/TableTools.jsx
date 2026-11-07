import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePref } from '../lib/prefs';
import { fmtDate, fmtNum, getFormat, norm } from '../lib/utils';
import DynamicFilterPanel, { activeConds, applyFilter, EMPTY_FILTER } from './DynamicFilterPanel';
import Select from './Select';

// ============================================================================
// Công cụ bảng dùng chung cho danh sách và báo cáo (mỗi người, mỗi màn hình một cấu hình, lưu theo tài khoản):
//  - Sắp xếp nhiều cấp: bấm tiêu đề cột (Shift + bấm = thêm cấp), hoặc nút ↕ Sắp xếp (vd. Kho → Vị trí → Mã hàng)
//  - Lọc kiểu Excel trên từng cột (▾): tích chọn giá trị / điều kiện chứa, bằng, lớn hơn, trong khoảng, rỗng…
//  - 🔎 Lọc nâng cao: nhiều điều kiện VÀ / HOẶC, lưu bộ lọc hay dùng (DynamicFilterPanel)
//  - 💾 Mẫu hiển thị: lưu cả bộ cột + thứ tự + sắp xếp + lọc thành mẫu có tên
// cols: [{ key, label, num | ton (số), date (ngày yyyy-mm-dd), sortVal(r) | excel(r) (giá trị để so), noSort, noFilter }]
// ============================================================================

const isNumCol = (c) => !!(c.num || c.ton || c.type === 'number' || c.type === 'currency' || c.type === 'percent');
// Chữ bên trong 1 phần tử React (để sắp xếp / lọc cột chỉ có hàm render)
function nodeText(x) {
  if (x == null || typeof x === 'boolean') return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);
  if (Array.isArray(x)) return x.map(nodeText).join('');
  if (x.props) return nodeText(x.props.children);
  return '';
}
// Số đã định dạng (theo cài đặt) → số
const parseShown = (t) => {
  const { dec, group } = getFormat();
  let x = String(t).trim();
  if (group) x = x.split(group).join('');
  x = x.replace(dec, '.').replace(/[^0-9.-]/g, '');
  return x === '' || x === '-' ? '' : Number(x);
};
export const colVal = (c, r) => {
  if (c.sortVal) return c.sortVal(r);
  if (c.value) return c.value(r);
  const v = r?.[c.key];
  if (v !== undefined) return v;
  if (c.excel) return c.excel(r);
  if (c.render) {
    try {
      const t = nodeText(c.render(r, {})).trim();
      return isNumCol(c) ? parseShown(t) : t;
    } catch { return ''; }
  }
  return v;
};
const empty = (v) => v === '' || v == null || (Array.isArray(v) && !v.length);
const txt = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
// So 2 giá trị: số theo số, ngày / chữ theo chữ (có số bên trong: A2 < A10), ô trống luôn xuống cuối
export function compareVals(a, b) {
  const ea = empty(a); const eb = empty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const na = typeof a === 'number' ? a : typeof a === 'boolean' ? Number(a) : null;
  const nb = typeof b === 'number' ? b : typeof b === 'boolean' ? Number(b) : null;
  if (na != null && nb != null) return na - nb;
  return txt(a).localeCompare(txt(b), 'vi', { numeric: true, sensitivity: 'base' });
}
export function sortRows(rows, sorts, cols, getVal = colVal) {
  const list = (sorts || []).map((s) => ({ ...s, c: cols.find((c) => c.key === s.key) })).filter((s) => s.c);
  if (!list.length) return rows;
  return rows.map((r, i) => ({ r, i })).sort((x, y) => {
    for (const s of list) {
      const a = getVal(s.c, x.r); const b = getVal(s.c, y.r);
      const ea = empty(a); const eb = empty(b);
      // Ô trống luôn xuống cuối, cả khi sắp giảm dần
      if (ea || eb) { if (ea !== eb) return ea ? 1 : -1; continue; }
      const d = compareVals(a, b);
      if (d) return s.dir === 'desc' ? -d : d;
    }
    return x.i - y.i;
  }).map((x) => x.r);
}

const looksDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
const kindOf = (c, rows, getVal) => {
  if (isNumCol(c)) return 'number';
  if (c.date || c.type === 'date' || c.type === 'datetime') return 'date';
  const sample = rows.slice(0, 30).map((r) => getVal(c, r)).filter((v) => !empty(v));
  if (sample.length && sample.every((v) => typeof v === 'number')) return 'number';
  if (sample.length && sample.every(looksDate)) return 'date';
  return 'text';
};
// Chữ hiển thị của 1 giá trị trong danh sách tích chọn
const showVal = (v, kind, c) => {
  if (empty(v)) return '(Trống)';
  if (kind === 'number') return fmtNum(v, c.ton ? 3 : c.digits ?? 2);
  if (kind === 'date') return fmtDate(String(v).slice(0, 10));
  return txt(v);
};
const keyOf = (v) => (empty(v) ? '' : Array.isArray(v) ? v.join(', ') : String(v));

const TEXT_OPS = [['contains', 'Chứa'], ['notContains', 'Không chứa'], ['equals', 'Bằng'], ['startsWith', 'Bắt đầu bằng'], ['endsWith', 'Kết thúc bằng'], ['empty', 'Trống'], ['notEmpty', 'Không trống']];
const NUM_OPS = [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['between', 'Trong khoảng'], ['empty', 'Trống'], ['notEmpty', 'Không trống']];
const DATE_OPS = [['between', 'Từ ngày … đến ngày'], ['eq', 'Đúng ngày'], ['gte', 'Từ ngày'], ['lte', 'Đến ngày'], ['past', 'Trước hôm nay (quá hạn)'], ['today', 'Hôm nay'], ['next7', '7 ngày tới'], ['month', 'Tháng này'], ['empty', 'Trống'], ['notEmpty', 'Không trống']];
const NO_INPUT = ['empty', 'notEmpty', 'past', 'today', 'next7', 'month'];
const vnToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
const addDays = (ymd, d) => { const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

// Một điều kiện lọc cột có khớp giá trị không
function testCond(f, v, kind) {
  if (!f?.op) return true;
  if (f.op === 'empty') return empty(v);
  if (f.op === 'notEmpty') return !empty(v);
  if (Array.isArray(v)) return v.some((x) => testCond(f, x, kind));
  if (kind === 'number') {
    const a = Number(v); const b = Number(f.v); const b2 = Number(f.v2);
    if (f.op === 'between') return (f.v === '' || f.v == null || a >= b) && (f.v2 === '' || f.v2 == null || a <= b2);
    if (f.v === '' || f.v == null) return true;
    if (empty(v)) return false;
    return { eq: a === b, ne: a !== b, gt: a > b, gte: a >= b, lt: a < b, lte: a <= b }[f.op] ?? true;
  }
  if (kind === 'date') {
    const a = String(v || '').slice(0, 10); const t = vnToday();
    if (f.op === 'past') return !!a && a < t;
    if (f.op === 'today') return a === t;
    if (f.op === 'next7') return !!a && a >= t && a <= addDays(t, 7);
    if (f.op === 'month') return a.slice(0, 7) === t.slice(0, 7);
    if (f.op === 'between') return (!f.v || a >= f.v) && (!f.v2 || a <= f.v2) && (!!a || (!f.v && !f.v2));
    if (!f.v) return true;
    if (!a) return false;
    return { eq: a === f.v, gte: a >= f.v, lte: a <= f.v }[f.op] ?? true;
  }
  const q = norm(f.v);
  if (!q) return true;
  const h = norm(txt(v));
  return { contains: h.includes(q), notContains: !h.includes(q), equals: h === q, startsWith: h.startsWith(q), endsWith: h.endsWith(q) }[f.op] ?? true;
}
const activeCol = (f) => !!f && (Array.isArray(f.vals) || (f.op && (NO_INPUT.includes(f.op) || String(f.v ?? '') !== '' || String(f.v2 ?? '') !== '')));
export function filterRows(rows, colFilters, cols, getVal = colVal, kinds = {}) {
  const list = Object.entries(colFilters || {}).map(([k, f]) => ({ f, c: cols.find((c) => c.key === k) })).filter(({ f, c }) => c && activeCol(f));
  if (!list.length) return rows;
  return rows.filter((r) => list.every(({ f, c }) => {
    const v = getVal(c, r);
    if (Array.isArray(f.vals)) {
      const set = new Set(f.vals);
      const ks = Array.isArray(v) && v.length ? v.map(keyOf) : [keyOf(v)];
      if (!ks.some((k) => set.has(k))) return false;
    }
    return testCond(f, v, kinds[c.key] || 'text');
  }));
}

// ---------------------------------------------------------------------------
// Hook: trạng thái sắp xếp + lọc của 1 bảng (pid = mã màn hình / bảng)
// ---------------------------------------------------------------------------
export function useTableTools(pid, cols, rows, { getVal = colVal, defaultSort = [] } = {}) {
  const [sorts, setSorts] = usePref(`tv:${pid}:sort`, defaultSort);
  const [colFilters, setColFilters] = usePref(`tv:${pid}:cf`, {});
  const [adv, setAdv] = usePref(`tv:${pid}:adv`, EMPTY_FILTER);
  const [advOpen, setAdvOpen] = useState(false);
  const [menu, setMenu] = useState(null); // { key, rect }
  const kinds = useMemo(() => Object.fromEntries(cols.map((c) => [c.key, kindOf(c, rows, getVal)])), [cols, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const advFields = useMemo(() => cols.filter((c) => !c.noFilter).map((c) => ({ key: c.key, label: c.label, type: kinds[c.key] === 'number' ? 'number' : kinds[c.key] === 'date' ? 'date' : 'text' })), [cols, kinds]);
  const advN = activeConds(adv);
  const nColF = Object.values(colFilters || {}).filter(activeCol).length;

  const out = useMemo(() => {
    let list = filterRows(rows, colFilters, cols, getVal, kinds);
    if (advN) {
      const wrapped = list.map((r) => ({ __r: r, ...Object.fromEntries(advFields.map((f) => [f.key, getVal(cols.find((c) => c.key === f.key), r)])) }));
      list = applyFilter(wrapped, advFields, adv).map((x) => x.__r);
    }
    return sortRows(list, sorts, cols, getVal);
  }, [rows, colFilters, cols, kinds, adv, advN, advFields, sorts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bấm tiêu đề: tăng → giảm → bỏ; Shift / Ctrl + bấm: thêm cấp sắp xếp
  const clickHead = (key, e) => {
    if (e.target.closest?.('.th-tools, .col-grip')) return;
    const multi = e.shiftKey || e.ctrlKey || e.metaKey;
    const cur = sorts.find((s) => s.key === key);
    const next = !cur ? 'asc' : cur.dir === 'asc' ? 'desc' : null;
    if (multi) setSorts(next ? (cur ? sorts.map((s) => (s.key === key ? { ...s, dir: next } : s)) : [...sorts, { key, dir: next }]) : sorts.filter((s) => s.key !== key));
    else setSorts(next ? [{ key, dir: next }] : []);
  };
  const headProps = (c) => (c.noSort ? {} : { onClick: (e) => clickHead(c.key, e), 'data-sortable': '1' });
  const headMark = (c) => {
    const i = sorts.findIndex((s) => s.key === c.key);
    const f = colFilters?.[c.key];
    return (
      <span className="th-tools">
        {i >= 0 && <span className="sort-mark" title={`Sắp xếp cấp ${i + 1}`}>{sorts[i].dir === 'asc' ? '▲' : '▼'}{sorts.length > 1 ? <sub>{i + 1}</sub> : null}</span>}
        {!c.noFilter && (
          <button type="button" className={'th-filter' + (activeCol(f) ? ' on' : '')} title="Lọc / sắp xếp cột này"
            onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.closest('th').getBoundingClientRect(); setMenu(menu?.key === c.key ? null : { key: c.key, rect: r }); }}>▾</button>
        )}
      </span>
    );
  };
  const menuCol = menu && cols.find((c) => c.key === menu.key);
  const popup = menuCol && (
    <ColumnMenu c={menuCol} rect={menu.rect} kind={kinds[menuCol.key]} rows={filterRows(rows, Object.fromEntries(Object.entries(colFilters || {}).filter(([k]) => k !== menuCol.key)), cols, getVal, kinds)}
      getVal={getVal} value={colFilters?.[menuCol.key]} sorts={sorts} setSorts={setSorts}
      onApply={(f) => { const nx = { ...(colFilters || {}) }; if (f) nx[menuCol.key] = f; else delete nx[menuCol.key]; setColFilters(nx); setMenu(null); }}
      onClose={() => setMenu(null)} />
  );
  const clearAll = () => { setColFilters({}); setAdv(EMPTY_FILTER); };
  const toolbar = (
    <>
      <SortButton cols={cols.filter((c) => !c.noSort)} sorts={sorts} setSorts={setSorts} />
      <button type="button" className={'btn sm' + (advOpen || advN ? ' primary' : '')} onClick={() => setAdvOpen(!advOpen)}
        title="Lọc nhiều điều kiện VÀ / HOẶC, tìm theo từng cột, lưu bộ lọc hay dùng">🔎 Lọc nâng cao{advN ? ` (${advN})` : ''}</button>
      {(nColF + advN > 0) && <button type="button" className="btn sm ghost" onClick={clearAll} title="Bỏ mọi điều kiện lọc của bảng này">✕ Bỏ lọc ({nColF + advN})</button>}
    </>
  );
  const advPanel = advOpen ? <DynamicFilterPanel scope={`tv:${pid}`} fields={advFields} value={adv} onApply={setAdv} /> : null;
  const snapshot = () => ({ sorts, colFilters, adv });
  const restore = (v) => { setSorts(v?.sorts || []); setColFilters(v?.colFilters || {}); setAdv(v?.adv || EMPTY_FILTER); };
  return { rows: out, sorts, setSorts, colFilters, setColFilters, headProps, headMark, popup, toolbar, advPanel, snapshot, restore, filtered: nColF + advN > 0 };
}

// ---------------------------------------------------------------------------
// ↕ Sắp xếp nhiều cấp
// ---------------------------------------------------------------------------
export function SortButton({ cols, sorts, setSorts }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useOutside(ref, open, () => setOpen(false));
  const upd = (i, patch) => setSorts(sorts.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= sorts.length) return; const n = [...sorts]; [n[i], n[j]] = [n[j], n[i]]; setSorts(n); };
  const free = cols.filter((c) => !sorts.some((s) => s.key === c.key));
  const label = sorts.length ? sorts.map((s) => cols.find((c) => c.key === s.key)?.label).filter(Boolean).join(' → ') : '';
  return (
    <span className="col-picker" ref={ref}>
      <button type="button" className={'btn sm' + (sorts.length ? ' primary' : '')} onClick={() => setOpen(!open)} title={label ? `Đang sắp xếp: ${label}` : 'Sắp xếp theo nhiều cột'}>
        ↕ Sắp xếp{sorts.length ? ` (${sorts.length})` : ''}
      </button>
      {open && (
        <div className="col-picker-menu" style={{ minWidth: 340 }}>
          <div className="small" style={{ marginBottom: 6 }}><b>Sắp xếp theo nhiều cấp</b> — cấp 1 trước, trùng thì xét cấp 2…</div>
          {sorts.map((s, i) => (
            <div key={s.key} className="sort-level">
              <span className="small" style={{ width: 44 }}>{i === 0 ? 'Theo' : 'Rồi theo'}</span>
              <Select value={s.key} onChange={(e) => upd(i, { key: e.target.value })} style={{ flex: 1, minWidth: 120 }}>
                {[cols.find((c) => c.key === s.key), ...free].filter(Boolean).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </Select>
              <Select value={s.dir} onChange={(e) => upd(i, { dir: e.target.value })} style={{ width: 110 }}>
                <option value="asc">Tăng dần ▲</option><option value="desc">Giảm dần ▼</option>
              </Select>
              <span className="col-steps">
                <button type="button" disabled={!i} onClick={() => move(i, -1)} title="Lên cấp trên">▲</button>
                <button type="button" disabled={i === sorts.length - 1} onClick={() => move(i, 1)} title="Xuống cấp dưới">▼</button>
                <button type="button" onClick={() => setSorts(sorts.filter((_, j) => j !== i))} title="Bỏ cấp này">✕</button>
              </span>
            </div>
          ))}
          {free.length > 0 && (
            <Select value="" onChange={(e) => e.target.value && setSorts([...sorts, { key: e.target.value, dir: 'asc' }])} style={{ width: '100%', marginTop: 4 }}>
              <option value="">+ Thêm cấp sắp xếp…</option>
              {free.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </Select>
          )}
          <div className="actions" style={{ marginTop: 8 }}>
            {sorts.length > 0 && <button type="button" className="btn sm ghost" onClick={() => setSorts([])}>↺ Bỏ sắp xếp</button>}
          </div>
          <small className="small">Mẹo: bấm tiêu đề cột để sắp xếp, giữ Shift khi bấm để thêm cấp.</small>
        </div>
      )}
    </span>
  );
}

function useOutside(ref, open, close) {
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => !ref.current?.contains(e.target) && close();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------------------------------------------------------------------------
// ▾ Menu cột kiểu Excel: sắp xếp, điều kiện, tích chọn giá trị
// ---------------------------------------------------------------------------
function ColumnMenu({ c, rect, kind, rows, getVal, value, sorts, setSorts, onApply, onClose }) {
  const ref = useRef();
  useOutside(ref, true, onClose);
  const [pos, setPos] = useState({ left: rect.left, top: rect.bottom + 2 });
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth || 300; const h = ref.current?.offsetHeight || 400;
    setPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)), top: Math.max(8, Math.min(rect.bottom + 2, window.innerHeight - h - 8)) });
  }, [rect]);
  const ops = kind === 'number' ? NUM_OPS : kind === 'date' ? DATE_OPS : TEXT_OPS;
  const [op, setOp] = useState(value?.op || '');
  const [v, setV] = useState(value?.v ?? '');
  const [v2, setV2] = useState(value?.v2 ?? '');
  // Các giá trị khác nhau trong cột (theo các lọc khác đang áp dụng)
  const distinct = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const raw = getVal(c, r);
      const list = Array.isArray(raw) && raw.length ? raw : [raw];
      for (const x of list) { const k = keyOf(x); const e = m.get(k); if (e) e.n += 1; else m.set(k, { k, raw: x, n: 1 }); }
    }
    return [...m.values()].sort((a, b) => compareVals(a.raw, b.raw));
  }, [rows, c, getVal]);
  const [picked, setPicked] = useState(() => new Set(Array.isArray(value?.vals) ? value.vals : distinct.map((d) => d.k)));
  const [find, setFind] = useState('');
  const fq = norm(find);
  const view = fq ? distinct.filter((d) => norm(showVal(d.raw, kind, c)).includes(fq)) : distinct;
  const allOn = view.every((d) => picked.has(d.k));
  const toggleAll = () => { const n = new Set(picked); view.forEach((d) => (allOn ? n.delete(d.k) : n.add(d.k))); setPicked(n); };
  const cur = sorts.find((s) => s.key === c.key);
  const sortOnly = (dir) => { setSorts([{ key: c.key, dir }]); onClose(); };
  const sortAdd = (dir) => { setSorts(cur ? sorts.map((s) => (s.key === c.key ? { ...s, dir } : s)) : [...sorts, { key: c.key, dir }]); onClose(); };
  const apply = () => {
    const everyPicked = distinct.every((d) => picked.has(d.k));
    // Đang tìm trong danh sách: chỉ giữ giá trị khớp đã tích
    const vals = fq ? view.filter((d) => picked.has(d.k)).map((d) => d.k) : everyPicked ? null : [...picked];
    const f = { ...(vals ? { vals } : {}), ...(op ? { op, v, v2 } : {}) };
    onApply(Object.keys(f).length ? f : null);
  };
  const az = kind === 'number' ? ['Nhỏ → lớn', 'Lớn → nhỏ'] : kind === 'date' ? ['Cũ → mới', 'Mới → cũ'] : ['A → Z', 'Z → A'];
  const inputType = kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text';
  return createPortal(
    <div className="col-menu" ref={ref} style={{ left: pos.left, top: pos.top }} onKeyDown={(e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') onClose(); }}>
      <div className="col-menu-title">{c.label}</div>
      <div className="col-menu-sort">
        <button type="button" className="btn sm" onClick={() => sortOnly('asc')}>▲ {az[0]}</button>
        <button type="button" className="btn sm" onClick={() => sortOnly('desc')}>▼ {az[1]}</button>
        {sorts.length > 0 && !(sorts.length === 1 && cur) && <>
          <button type="button" className="btn sm ghost" onClick={() => sortAdd('asc')} title="Giữ các cấp đang có, thêm cột này làm cấp tiếp theo">+ cấp ▲</button>
          <button type="button" className="btn sm ghost" onClick={() => sortAdd('desc')}>+ cấp ▼</button>
        </>}
      </div>
      <div className="col-menu-cond">
        <Select value={op} onChange={(e) => setOp(e.target.value)} style={{ width: '100%' }}>
          <option value="">— Lọc theo điều kiện —</option>
          {ops.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {op && !NO_INPUT.includes(op) && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <input type={inputType} value={v} onChange={(e) => setV(e.target.value)} placeholder={op === 'between' ? 'Từ' : 'Giá trị'} autoFocus style={{ flex: 1, minWidth: 0 }} />
            {op === 'between' && <input type={inputType} value={v2} onChange={(e) => setV2(e.target.value)} placeholder="Đến" style={{ flex: 1, minWidth: 0 }} />}
          </div>
        )}
      </div>
      <input type="search" placeholder="Tìm giá trị…" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: '100%', margin: '6px 0 4px' }} />
      <div className="col-menu-vals">
        <label><input type="checkbox" checked={allOn} onChange={toggleAll} /> <b>(Chọn tất cả{fq ? ' kết quả tìm' : ''})</b></label>
        {view.slice(0, 500).map((d) => (
          <label key={d.k}><input type="checkbox" checked={picked.has(d.k)} onChange={() => { const n = new Set(picked); if (n.has(d.k)) n.delete(d.k); else n.add(d.k); setPicked(n); }} />
            <span className="cv-text">{showVal(d.raw, kind, c)}</span><span className="small">{d.n}</span></label>
        ))}
        {view.length > 500 && <div className="small">… còn {view.length - 500} giá trị, gõ để tìm</div>}
      </div>
      <div className="actions" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn sm ghost" onClick={() => onApply(null)}>Xóa lọc cột</button>
        <button type="button" className="btn sm primary" onClick={apply}>Áp dụng</button>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// 💾 Mẫu hiển thị: lưu / chọn lại cấu hình có tên (cột, thứ tự, sắp xếp, lọc)
// ---------------------------------------------------------------------------
export function ViewPresets({ pid, snapshot, restore }) {
  const [views, setViews] = usePref(`tv:${pid}:views`, []);
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useOutside(ref, open, () => setOpen(false));
  const save = () => {
    const name = window.prompt('Tên mẫu hiển thị (trùng tên sẽ ghi đè):', '');
    if (!name?.trim()) return;
    setViews([...views.filter((v) => v.name !== name.trim()), { name: name.trim(), at: new Date().toISOString(), data: snapshot() }]);
  };
  return (
    <span className="col-picker" ref={ref}>
      <button type="button" className="btn sm" onClick={() => setOpen(!open)} title="Lưu cột + thứ tự + sắp xếp + lọc thành mẫu, lần sau chọn lại">💾 Mẫu{views.length ? ` (${views.length})` : ''}</button>
      {open && (
        <div className="col-picker-menu" style={{ minWidth: 260 }}>
          <div className="small" style={{ marginBottom: 6 }}><b>Mẫu hiển thị đã lưu</b> (cột, thứ tự cột, sắp xếp, lọc)</div>
          {!views.length && <div className="small">Chưa có mẫu nào.</div>}
          {views.map((v) => (
            <div key={v.name} className="col-picker-row">
              <button type="button" className="btn sm ghost" style={{ flex: 1, textAlign: 'left' }} onClick={() => { restore(v.data); setOpen(false); }}>📄 {v.name}</button>
              <button type="button" className="btn sm ghost" title="Xóa mẫu" onClick={() => window.confirm(`Xóa mẫu "${v.name}"?`) && setViews(views.filter((x) => x.name !== v.name))}>🗑</button>
            </div>
          ))}
          <button type="button" className="btn sm primary" style={{ marginTop: 6 }} onClick={save}>💾 Lưu cấu hình hiện tại thành mẫu…</button>
        </div>
      )}
    </span>
  );
}
