import { useEffect, useState } from 'react';
import { NUMERIC_TYPES } from '../catalogs';
import { usePref } from '../lib/prefs';
import { norm } from '../lib/utils';
import { displayValue } from './FieldInput';
import Select from './Select';

// ============================================================================
// Bảng tìm kiếm nâng cao (kiểu MISA): nút Tìm kiếm (F3) mở bảng có nhiều thẻ (Mặc định, Thông tin khác, Thông tin bổ sung…),
// mỗi thẻ là danh sách ô tìm theo từng trường. Người dùng tự chỉnh: thêm / bớt / đổi thứ tự trường, thêm / đổi tên / xóa thẻ
// (⚙ Tùy chỉnh), lưu bộ lọc hay dùng thành mẫu. Thẻ "Điều kiện tự do" cho ghép điều kiện VÀ / HOẶC với cách so tùy chọn.
// Bố cục thẻ và bộ lọc đã lưu nhớ riêng từng người, từng danh sách (trên trình duyệt). Bấm Tìm kiếm (F8) mới áp dụng.
// ============================================================================

export const OPERATORS = [
  ['contains', 'Chứa'],
  ['notContains', 'Không chứa'],
  ['equals', 'Bằng'],
  ['startsWith', 'Bắt đầu bằng'],
  ['gt', 'Lớn hơn'],
  ['lt', 'Nhỏ hơn'],
  ['gte', 'Từ (≥)'],
  ['lte', 'Đến (≤)'],
  ['empty', 'Rỗng'],
  ['notEmpty', 'Không rỗng'],
];
const NO_VALUE = ['empty', 'notEmpty'];
const NUM_OPS = ['equals', 'gt', 'lt', 'gte', 'lte', 'empty', 'notEmpty'];
const opsOf = (f) => (f && (NUMERIC_TYPES.includes(f.type) || f.type === 'date') ? OPERATORS.filter(([k]) => NUM_OPS.includes(k))
  : f?.type === 'checkbox' ? OPERATORS.filter(([k]) => ['equals'].includes(k)) : OPERATORS);

export const EMPTY_FILTER = { form: {}, logic: 'and', conds: [] };
const newCond = () => ({ id: Math.random().toString(36).slice(2), field: '', op: 'contains', value: '' });

// Một điều kiện có khớp bản ghi không
function test(f, r, c) {
  const raw = r[f.key];
  // Trường theo dòng hàng (mảng giá trị): khớp khi có ít nhất 1 dòng khớp ("Không chứa" = không dòng nào chứa)
  if (Array.isArray(raw) && raw.length && !['empty', 'notEmpty'].includes(c.op)) {
    const one = (v) => test(f, { [f.key]: v }, c);
    return c.op === 'notContains' ? raw.every(one) : raw.some(one);
  }
  const isEmpty = raw === '' || raw == null || (Array.isArray(raw) && !raw.length);
  if (c.op === 'empty') return isEmpty;
  if (c.op === 'notEmpty') return !isEmpty;
  if (f.type === 'checkbox') return !!raw === (c.value === 'true' || c.value === true);
  if (NUMERIC_TYPES.includes(f.type) || f.type === 'date') {
    if (c.value === '' || c.value == null) return true;
    const a = f.type === 'date' ? String(raw || '') : Number(raw);
    const b = f.type === 'date' ? String(c.value) : Number(c.value);
    if (isEmpty) return false;
    return c.op === 'gt' ? a > b : c.op === 'lt' ? a < b : c.op === 'gte' ? a >= b : c.op === 'lte' ? a <= b : a === b;
  }
  const v = norm(c.value);
  if (!v) return true;
  // So cả mã lẫn chữ hiển thị (vd. danh sách chọn có nhãn)
  const hay = [raw, displayValue(f, raw)].flat().map(norm);
  if (c.op === 'equals') return hay.some((h) => h === v);
  if (c.op === 'startsWith') return hay.some((h) => h.startsWith(v));
  if (c.op === 'notContains') return hay.every((h) => !h.includes(v));
  return hay.some((h) => h.includes(v));
}

const isNumDate = (f) => NUMERIC_TYPES.includes(f?.type) || f?.type === 'date';
const hasOpts = (f) => f?.type === 'checkbox' || !!f?.options?.length;
const filled = (v) => (v && typeof v === 'object' ? filled(v.from) || filled(v.to) : String(v ?? '').trim() !== '');

// Ô tìm theo trường (form) → điều kiện: chữ = Chứa, danh sách chọn = Bằng, số / ngày = Từ… Đến…
function formConds(form, fields) {
  const out = [];
  Object.entries(form || {}).forEach(([key, v]) => {
    const f = fields.find((x) => x.key === key);
    if (!f || !filled(v)) return;
    if (isNumDate(f)) {
      if (filled(v?.from)) out.push({ c: { op: 'gte', value: v.from }, f });
      if (filled(v?.to)) out.push({ c: { op: 'lte', value: v.to }, f });
    } else out.push({ c: { op: hasOpts(f) ? 'equals' : 'contains', value: v }, f });
  });
  return out;
}

// Lọc danh sách: mọi ô tìm theo trường phải khớp (VÀ), cộng nhóm điều kiện tự do (VÀ / HOẶC)
export function applyFilter(rows, fields, filter) {
  const fc = formConds(filter?.form, fields);
  const conds = (filter?.conds || []).map((c) => ({ c, f: fields.find((x) => x.key === c.field) }))
    .filter(({ c, f }) => f && (NO_VALUE.includes(c.op) || f.type === 'checkbox' || String(c.value ?? '').trim() !== ''));
  if (!fc.length && !conds.length) return rows;
  return rows.filter((r) => fc.every(({ c, f }) => test(f, r, c))
    && (!conds.length || (filter.logic === 'or' ? conds.some(({ c, f }) => test(f, r, c)) : conds.every(({ c, f }) => test(f, r, c)))));
}
export const activeConds = (filter) => Object.values(filter?.form || {}).filter(filled).length + (filter?.conds || []).filter((c) => c.field).length;

// Thẻ mặc định: Mặc định (12 trường đầu), Thông tin khác, Dòng hàng (trường l_…), Thông tin bổ sung (trường tự thêm)
function autoTabs(fields) {
  const line = fields.filter((f) => f.key.startsWith('l_'));
  const head = fields.filter((f) => !f.key.startsWith('l_'));
  const builtin = head.filter((f) => !f.custom);
  const custom = head.filter((f) => f.custom);
  return [
    { id: 't1', name: 'Mặc định', keys: builtin.slice(0, 12).map((f) => f.key) },
    builtin.length > 12 && { id: 't2', name: 'Thông tin khác', keys: builtin.slice(12).map((f) => f.key) },
    line.length > 0 && { id: 't3', name: 'Dòng hàng', keys: line.map((f) => f.key) },
    custom.length > 0 && { id: 't4', name: 'Thông tin bổ sung', keys: custom.map((f) => f.key) },
  ].filter(Boolean);
}
const COND_TAB = '__cond';
const uid = () => Math.random().toString(36).slice(2, 8);

// scope: khóa nhớ bố cục / bộ lọc đã lưu (vd. 'partners', 'orders:SO'); fields: các trường tìm được
// value: bộ lọc đang áp dụng; onApply(bộ lọc mới); extra: ô lọc cố định riêng của trang (vd. tình trạng sử dụng), hiện ở thẻ đầu
// defaultTabs: [{ name, keys }] bố cục gợi ý riêng của trang (không có thì tự chia)
export default function DynamicFilterPanel({ scope = 'x', fields, value = EMPTY_FILTER, onApply, onReset, extra, defaultTabs }) {
  const init = (v) => ({ form: { ...(v.form || {}) }, logic: v.logic || 'and', conds: v.conds?.length ? v.conds : [newCond()] });
  const [draft, setDraft] = useState(() => init(value));
  const [layout, setLayout] = usePref(`filter-layout:${scope}`, null);
  const [presets, setPresets] = usePref(`filter-presets:${scope}`, []);
  const [preset, setPreset] = useState('');
  const [tabId, setTabId] = useState('');
  const [editing, setEditing] = useState(false);
  const known = new Set(fields.map((f) => f.key));
  const custKeys = fields.filter((f) => f.custom && !defaultTabs?.some((t) => t.keys.includes(f.key))).map((f) => f.key);
  const baseTabs = defaultTabs ? [...defaultTabs.map((t, i) => ({ id: `d${i}`, ...t })), ...(custKeys.length ? [{ id: 'dc', name: 'Thông tin bổ sung', keys: custKeys }] : [])] : autoTabs(fields);
  const tabs = (layout || baseTabs).map((t) => ({ ...t, keys: t.keys.filter((k) => known.has(k)) }));
  const tab = tabs.find((t) => t.id === tabId) || (tabId === COND_TAB ? null : tabs[0]);
  const cur = tabId === COND_TAB ? COND_TAB : tab?.id;

  const toApply = (d) => ({ ...d, form: Object.fromEntries(Object.entries(d.form).filter(([, v]) => filled(v))), conds: d.conds.filter((c) => c.field) });
  const apply = () => onApply(toApply(draft));
  const reset = () => { setDraft(init(EMPTY_FILTER)); setPreset(''); onApply(EMPTY_FILTER); onReset?.(); };
  // F8 = Tìm kiếm
  useEffect(() => {
    const h = (e) => { if (e.key === 'F8') { e.preventDefault(); apply(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const setForm = (key, v) => setDraft((d) => ({ ...d, form: { ...d.form, [key]: v } }));
  const upd = (id, patch) => setDraft((d) => ({ ...d, conds: d.conds.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  // Tùy chỉnh bố cục (lưu riêng người dùng)
  const saveTabs = (fn) => setLayout(fn(tabs.map((t) => ({ ...t, keys: [...t.keys] }))));
  const editTab = (fn) => saveTabs((ts) => ts.map((t) => (t.id === tab.id ? fn(t) : t)));
  const move = (k, dir) => editTab((t) => {
    const keys = [...t.keys]; const i = keys.indexOf(k); const j = i + dir;
    if (j < 0 || j >= keys.length) return t;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    return { ...t, keys };
  });
  const addTab = () => { const id = uid(); saveTabs((ts) => [...ts, { id, name: 'Thẻ mới', keys: [] }]); setTabId(id); setEditing(true); };
  const delTab = () => { if (tabs.length < 2 || !window.confirm(`Xóa thẻ "${tab.name}"?`)) return; saveTabs((ts) => ts.filter((t) => t.id !== tab.id)); setTabId(''); };
  // Bộ lọc đã lưu
  const loadPreset = (name) => {
    setPreset(name);
    const p = presets.find((x) => x.name === name);
    if (!p) return;
    setDraft(init(p.value)); onApply(toApply(init(p.value)));
  };
  const savePreset = () => {
    const name = window.prompt('Tên bộ lọc (trùng tên sẽ ghi đè):', preset || '');
    if (!name?.trim()) return;
    setPresets([...presets.filter((x) => x.name !== name.trim()), { name: name.trim(), value: toApply(draft) }]);
    setPreset(name.trim());
  };
  const delPreset = () => { if (preset && window.confirm(`Xóa bộ lọc đã lưu "${preset}"?`)) { setPresets(presets.filter((x) => x.name !== preset)); setPreset(''); } };
  const builtin = fields.filter((f) => !f.custom);
  const custom = fields.filter((f) => f.custom);
  const fieldOpts = (list) => (
    <>
      <optgroup label="Thông tin chung">{list.filter((f) => !f.custom).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>
      {list.some((f) => f.custom) && <optgroup label="Thông tin bổ sung (trường tự thêm)">{list.filter((f) => f.custom).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>}
    </>
  );

  return (
    <div className="card adv-panel" style={{ marginBottom: 10, padding: 0, overflow: 'hidden' }}>
      <div className="adv-tabs">
        {tabs.map((t) => <button key={t.id} type="button" className={cur === t.id ? 'on' : ''} onClick={() => setTabId(t.id)}>{t.name}</button>)}
        <button type="button" className={cur === COND_TAB ? 'on' : ''} onClick={() => setTabId(COND_TAB)} title="Ghép điều kiện VÀ / HOẶC, chọn cách so (Chứa, Bằng, Rỗng…)">Điều kiện tự do</button>
        <button type="button" className="adv-plus" onClick={addTab} title="Thêm thẻ tìm kiếm mới">+</button>
        <span style={{ flex: 1 }} />
        {cur !== COND_TAB && <button type="button" className={'btn sm' + (editing ? ' primary' : ' ghost')} onClick={() => setEditing(!editing)} title="Thêm / bớt / đổi thứ tự trường, đổi tên thẻ">⚙ {editing ? 'Xong tùy chỉnh' : 'Tùy chỉnh'}</button>}
      </div>

      <div style={{ padding: 14 }}>
        {cur !== COND_TAB && tab && (
          <>
            {editing && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <label className="small">Tên thẻ <input value={tab.name} onChange={(e) => editTab((t) => ({ ...t, name: e.target.value }))} style={{ width: 200 }} /></label>
                <Select searchable value="" style={{ minWidth: 240 }} onChange={(e) => e.target.value && editTab((t) => ({ ...t, keys: [...t.keys, e.target.value] }))}>
                  <option value="">+ Thêm trường vào thẻ này…</option>
                  {fieldOpts(fields.filter((f) => !tab.keys.includes(f.key)))}
                </Select>
                <span style={{ flex: 1 }} />
                {tabs.length > 1 && <button type="button" className="btn sm ghost" onClick={delTab}>🗑 Xóa thẻ</button>}
                {layout && <button type="button" className="btn sm ghost" onClick={() => { if (window.confirm('Đưa các thẻ về bố cục mặc định?')) { setLayout(null); setTabId(''); } }}>↺ Bố cục mặc định</button>}
              </div>
            )}
            {!tab.keys.length && <p className="hint">Thẻ chưa có trường nào. Bấm ⚙ Tùy chỉnh → “+ Thêm trường vào thẻ này”.</p>}
            <div className="adv-grid">
              {tab.keys.map((k, i) => {
                const f = fields.find((x) => x.key === k);
                return (
                  <div key={k} className="adv-row">
                    <span className="adv-label">{f.label}</span>
                    <FormInput f={f} value={draft.form[k]} onChange={(v) => setForm(k, v)} onEnter={apply} />
                    {editing && (
                      <span className="nowrap">
                        <button type="button" className="btn sm ghost" disabled={!i} onClick={() => move(k, -1)} title="Lên">↑</button>
                        <button type="button" className="btn sm ghost" disabled={i === tab.keys.length - 1} onClick={() => move(k, 1)} title="Xuống">↓</button>
                        <button type="button" className="btn sm ghost" onClick={() => editTab((t) => ({ ...t, keys: t.keys.filter((x) => x !== k) }))} title="Bỏ trường khỏi thẻ">✕</button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {extra && tab.id === tabs[0].id && <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>{extra}</div>}
          </>
        )}

        {cur === COND_TAB && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <span className="seg">
                <button type="button" className={draft.logic !== 'or' ? 'on' : ''} onClick={() => setDraft((d) => ({ ...d, logic: 'and' }))} title="Bản ghi phải khớp mọi điều kiện">VÀ · khớp tất cả</button>
                <button type="button" className={draft.logic === 'or' ? 'on' : ''} onClick={() => setDraft((d) => ({ ...d, logic: 'or' }))} title="Bản ghi khớp ít nhất một điều kiện">HOẶC · khớp một</button>
              </span>
              <span className="small">Các ô ở những thẻ khác luôn phải khớp hết; nhóm điều kiện này ghép thêm vào.</span>
            </div>
            {draft.conds.map((c, i) => {
              const f = fields.find((x) => x.key === c.field);
              const ops = opsOf(f);
              return (
                <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                  <span className="small" style={{ width: 34, textAlign: 'right' }}>{i === 0 ? '' : draft.logic === 'or' ? 'HOẶC' : 'VÀ'}</span>
                  <Select searchable value={c.field} style={{ minWidth: 200 }} onChange={(e) => {
                    const nf = fields.find((x) => x.key === e.target.value);
                    const nops = opsOf(nf).map(([k]) => k);
                    upd(c.id, { field: e.target.value, op: nops.includes(c.op) ? c.op : nops[0], value: nf?.type === 'checkbox' ? 'true' : '' });
                  }}>
                    <option value="">-- Chọn trường --</option>
                    {fieldOpts(builtin.concat(custom))}
                  </Select>
                  <Select value={c.op} onChange={(e) => upd(c.id, { op: e.target.value })} style={{ width: 140 }}>
                    {ops.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </Select>
                  {!NO_VALUE.includes(c.op) && <ValueInput f={f} value={c.value} onChange={(v) => upd(c.id, { value: v })} onEnter={apply} />}
                  <button type="button" className="btn sm ghost" title="Bỏ điều kiện này"
                    onClick={() => setDraft((d) => ({ ...d, conds: d.conds.length > 1 ? d.conds.filter((x) => x.id !== c.id) : [newCond()] }))}>✕</button>
                </div>
              );
            })}
            <button type="button" className="btn sm" onClick={() => setDraft((d) => ({ ...d, conds: [...d.conds, newCond()] }))}>+ Thêm điều kiện tìm kiếm</button>
          </>
        )}
      </div>

      <div className="adv-foot">
        <Select value={preset} onChange={(e) => loadPreset(e.target.value)} style={{ minWidth: 170 }}>
          <option value="">{presets.length ? 'Bộ lọc đã lưu…' : '(Chưa lưu bộ lọc nào)'}</option>
          {presets.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </Select>
        <button type="button" className="btn sm ghost" onClick={savePreset} title="Lưu các ô đang nhập thành bộ lọc dùng lại">💾 Lưu bộ lọc</button>
        {preset && <button type="button" className="btn sm ghost" onClick={delPreset} title="Xóa bộ lọc đã lưu này">🗑</button>}
        <button type="button" className="btn sm primary" onClick={apply}>🔎 Tìm kiếm (F8)</button>
        <button type="button" className="btn sm ghost" onClick={reset}>Nhập lại</button>
      </div>
    </div>
  );
}

// Ô nhập của 1 trường trong thẻ: chữ (chứa), danh sách chọn, Có / Không, số và ngày (từ… đến…)
function FormInput({ f, value, onChange, onEnter }) {
  const key = (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } };
  if (f.type === 'checkbox')
    return <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">Tất cả</option><option value="true">Có</option><option value="false">Không</option></Select>;
  if (f.options?.length)
    return (
      <Select searchable value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Tất cả</option>
        {f.options.map((o) => <option key={o} value={o}>{f.labels?.[o] || o}</option>)}
      </Select>
    );
  if (isNumDate(f)) {
    const type = f.type === 'date' ? 'date' : 'number';
    const v = value && typeof value === 'object' ? value : {};
    return (
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type={type} value={v.from ?? ''} placeholder="Từ" onChange={(e) => onChange({ ...v, from: e.target.value })} onKeyDown={key} style={{ flex: 1, minWidth: 0 }} />
        <span className="small">→</span>
        <input type={type} value={v.to ?? ''} placeholder="Đến" onChange={(e) => onChange({ ...v, to: e.target.value })} onKeyDown={key} style={{ flex: 1, minWidth: 0 }} />
      </span>
    );
  }
  return <input value={value ?? ''} placeholder={f.label} onChange={(e) => onChange(e.target.value)} onKeyDown={key} />;
}

function ValueInput({ f, value, onChange, onEnter }) {
  const key = (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } };
  if (f?.type === 'checkbox')
    return <Select value={String(value)} onChange={(e) => onChange(e.target.value)} style={{ width: 120 }}><option value="true">Có</option><option value="false">Không</option></Select>;
  const opts = f?.options?.length ? f.options : null;
  if (opts)
    return (
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 180 }}>
        <option value="">-- Giá trị --</option>
        {opts.map((o) => <option key={o} value={o}>{f.labels?.[o] || o}</option>)}
      </Select>
    );
  const type = f && (NUMERIC_TYPES.includes(f.type)) ? 'number' : f?.type === 'date' ? 'date' : 'text';
  return <input type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} onKeyDown={key} placeholder="Giá trị…" style={{ minWidth: 180, flex: '1 1 180px', maxWidth: 320 }} />;
}

// Nút mở / đóng bảng tìm kiếm nâng cao (đặt cạnh ô tìm nhanh). Phím F3 cũng mở / đóng.
export function AdvButton({ open, n, onClick }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'F3') { e.preventDefault(); onClick(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  return (
    <button type="button" className={'btn' + (open || n ? ' primary' : '')} onClick={onClick} style={{ fontWeight: 600 }}
      title="Tìm theo nhiều trường, chia thẻ, tự thêm / bớt trường và lưu bộ lọc hay dùng">
      🔎 Tìm kiếm (F3){n ? ` · đang lọc ${n}` : ''} {open ? '▲' : '▼'}
    </button>
  );
}
