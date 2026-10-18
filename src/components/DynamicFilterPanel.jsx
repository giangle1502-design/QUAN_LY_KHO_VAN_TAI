import { useEffect, useState } from 'react';
import { NUMERIC_TYPES } from '../catalogs';
import { norm } from '../lib/utils';
import { displayValue } from './FieldInput';
import Select from './Select';

// ============================================================================
// Bảng tìm kiếm nâng cao: người dùng tự thêm bao nhiêu điều kiện cũng được.
// Mỗi điều kiện = trường (có sẵn hoặc tự thêm) + cách so + giá trị; ghép bằng VÀ (khớp tất cả) / HOẶC (khớp một).
// Dùng chung cho mọi danh mục (Đối tác, Soldto, NCC, mã hàng…). Bấm Tìm kiếm (F8) mới áp dụng.
// ============================================================================

export const OPERATORS = [
  ['contains', 'Chứa'],
  ['notContains', 'Không chứa'],
  ['equals', 'Bằng'],
  ['startsWith', 'Bắt đầu bằng'],
  ['gt', 'Lớn hơn'],
  ['lt', 'Nhỏ hơn'],
  ['empty', 'Rỗng'],
  ['notEmpty', 'Không rỗng'],
];
const NO_VALUE = ['empty', 'notEmpty'];
const NUM_OPS = ['equals', 'gt', 'lt', 'empty', 'notEmpty'];
const opsOf = (f) => (f && (NUMERIC_TYPES.includes(f.type) || f.type === 'date') ? OPERATORS.filter(([k]) => NUM_OPS.includes(k))
  : f?.type === 'checkbox' ? OPERATORS.filter(([k]) => ['equals'].includes(k)) : OPERATORS);

export const EMPTY_FILTER = { logic: 'and', conds: [] };
const newCond = () => ({ id: Math.random().toString(36).slice(2), field: '', op: 'contains', value: '' });

// Một điều kiện có khớp bản ghi không
function test(f, r, c) {
  const raw = r[f.key];
  const isEmpty = raw === '' || raw == null || (Array.isArray(raw) && !raw.length);
  if (c.op === 'empty') return isEmpty;
  if (c.op === 'notEmpty') return !isEmpty;
  if (f.type === 'checkbox') return !!raw === (c.value === 'true' || c.value === true);
  if (NUMERIC_TYPES.includes(f.type) || f.type === 'date') {
    if (c.value === '' || c.value == null) return true;
    const a = f.type === 'date' ? String(raw || '') : Number(raw);
    const b = f.type === 'date' ? String(c.value) : Number(c.value);
    if (isEmpty) return false;
    return c.op === 'gt' ? a > b : c.op === 'lt' ? a < b : a === b;
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

// Lọc danh sách theo bộ điều kiện đã áp dụng
export function applyFilter(rows, fields, filter) {
  const conds = (filter?.conds || []).map((c) => ({ c, f: fields.find((x) => x.key === c.field) }))
    .filter(({ c, f }) => f && (NO_VALUE.includes(c.op) || f.type === 'checkbox' || String(c.value ?? '').trim() !== ''));
  if (!conds.length) return rows;
  return rows.filter((r) => (filter.logic === 'or' ? conds.some(({ c, f }) => test(f, r, c)) : conds.every(({ c, f }) => test(f, r, c))));
}
export const activeConds = (filter) => (filter?.conds || []).filter((c) => c.field).length;

// fields: các trường tìm được; value: bộ lọc đang áp dụng; onApply(bộ lọc mới); extra: ô lọc cố định riêng của trang (vd. loại đối tác)
export default function DynamicFilterPanel({ fields, value = EMPTY_FILTER, onApply, onReset, extra }) {
  const [draft, setDraft] = useState(() => (value.conds.length ? value : { ...value, conds: [newCond()] }));
  const apply = () => onApply({ ...draft, conds: draft.conds.filter((c) => c.field) });
  const reset = () => { setDraft({ logic: 'and', conds: [newCond()] }); onApply(EMPTY_FILTER); onReset?.(); };
  // F8 = Tìm kiếm
  useEffect(() => {
    const h = (e) => { if (e.key === 'F8') { e.preventDefault(); apply(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const upd = (id, patch) => setDraft((d) => ({ ...d, conds: d.conds.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const builtin = fields.filter((f) => !f.custom);
  const custom = fields.filter((f) => f.custom);

  return (
    <div className="card" style={{ marginBottom: 10, padding: 12 }}>
      {extra && <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>{extra}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <b>Điều kiện tìm kiếm</b>
        <span className="seg">
          <button type="button" className={draft.logic !== 'or' ? 'on' : ''} onClick={() => setDraft((d) => ({ ...d, logic: 'and' }))} title="Bản ghi phải khớp mọi điều kiện">VÀ · khớp tất cả</button>
          <button type="button" className={draft.logic === 'or' ? 'on' : ''} onClick={() => setDraft((d) => ({ ...d, logic: 'or' }))} title="Bản ghi khớp ít nhất một điều kiện">HOẶC · khớp một</button>
        </span>
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
              <optgroup label="Thông tin chung">{builtin.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>
              {custom.length > 0 && <optgroup label="Thông tin bổ sung (trường tự thêm)">{custom.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>}
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
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn sm" onClick={() => setDraft((d) => ({ ...d, conds: [...d.conds, newCond()] }))}>+ Thêm điều kiện tìm kiếm</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" onClick={reset}>Nhập lại</button>
        <button type="button" className="btn sm primary" onClick={apply}>🔎 Tìm kiếm (F8)</button>
      </div>
    </div>
  );
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
