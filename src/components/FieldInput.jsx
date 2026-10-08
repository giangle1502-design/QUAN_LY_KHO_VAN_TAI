import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { catalogByKey, refLabel, refValue } from '../catalogs';
import { fmtDate, fmtNum } from '../lib/utils';

// Ô nhập cho 1 trường theo kiểu dữ liệu
export default function FieldInput({ field: f, value, onChange, disabled, onPickRef }) {
  if (f.type === 'ref') return <RefInput field={f} value={value} onChange={onChange} disabled={disabled} onPick={onPickRef} />;
  if (f.type === 'multiref') return <MultiRefInput field={f} value={value} onChange={onChange} disabled={disabled} />;
  if (f.type === 'select')
    return (
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">-- Chọn --</option>
        {(f.options || []).map((o) => <option key={o} value={o}>{f.labels?.[o] || o}</option>)}
      </select>
    );
  // Trường số / % / tiền / chữ có danh sách giá trị chọn sẵn (vd. VAT 5%, 8%, 10%)
  if (f.options?.length && ['number', 'percent', 'currency', 'text'].includes(f.type))
    return (
      <select value={value ?? ''} onChange={(e) => onChange(f.type === 'text' || e.target.value === '' ? e.target.value : Number(e.target.value))} disabled={disabled}>
        <option value="">-- Chọn --</option>
        {f.options.map((o) => <option key={o} value={o}>{f.type === 'percent' ? `${o}%` : f.type === 'currency' ? fmtNum(o) : o}</option>)}
      </select>
    );
  if (f.type === 'checkbox') return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />;
  if (f.type === 'textarea') return <textarea rows={2} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
  if (f.type === 'currency') return <MoneyInput value={value} onChange={onChange} disabled={disabled} />;
  if (f.type === 'percent')
    return (
      <span className="suffix-input">
        <input type="number" step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} /><b>%</b>
      </span>
    );
  return (
    <input
      type={{ number: 'number', date: 'date', datetime: 'datetime-local', email: 'email', phone: 'tel', url: 'url' }[f.type] || 'text'}
      placeholder={f.type === 'url' ? 'https://…' : undefined}
      step="any"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    />
  );
}

// Danh sách bản ghi của danh mục được tham chiếu (lọc theo kho được giao nếu là danh sách kho)
function useRefRows(refKey) {
  const { rows } = useCollection(refKey);
  const { inMyWarehouses } = useApp();
  return useMemo(() => {
    const list = refKey === 'warehouses' ? rows.filter((r) => inMyWarehouses(r.code)) : rows;
    return list.map((r) => ({ value: refValue(refKey, r), label: refLabel(r), row: r })).sort((a, b) => String(a.value).localeCompare(String(b.value)));
  }, [rows, refKey, inMyWarehouses]);
}

function RefInput({ field: f, value, onChange, disabled, onPick }) {
  const opts = useRefRows(f.ref);
  const listId = `dl-${f.key}`;
  const known = !value || opts.some((o) => o.value === value);
  // Gõ mã trước khi danh mục tải xong: tự điền khi dữ liệu về
  const pending = useRef('');
  useEffect(() => {
    if (!pending.current) return;
    const hit = opts.find((o) => o.value === pending.current);
    if (hit) { pending.current = ''; onPick?.(f, hit.row); }
  }, [opts, f, onPick]);
  return (
    <>
      <input
        list={listId}
        value={value ?? ''}
        disabled={disabled}
        placeholder={`Gõ hoặc chọn ${catalogByKey(f.ref)?.short || ''}`}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v);
          const hit = opts.find((o) => o.value === v);
          if (hit && onPick) onPick(f, hit.row);
          pending.current = hit ? '' : v;
        }}
      />
      <datalist id={listId}>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </datalist>
      {!known && <small className="req">Không có trong danh mục {catalogByKey(f.ref)?.short}</small>}
    </>
  );
}

function MultiRefInput({ field: f, value, onChange, disabled }) {
  const opts = useRefRows(f.ref);
  const sel = Array.isArray(value) ? value : [];
  const toggle = (v) => onChange(sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]);
  if (!opts.length) return <div className="readonly-val">Chưa có dữ liệu {catalogByKey(f.ref)?.short}</div>;
  return (
    <div className="tags">
      {opts.map((o) => (
        <label key={o.value} className={'chip' + (sel.includes(o.value) ? ' on' : '')} title={o.label}>
          <input type="checkbox" hidden checked={sel.includes(o.value)} onChange={() => !disabled && toggle(o.value)} />
          {o.value}
        </label>
      ))}
    </div>
  );
}

// Tiền: hiện dấu chấm phân cách hàng nghìn khi gõ, lưu số
function MoneyInput({ value, onChange, disabled }) {
  const shown = value === '' || value == null ? '' : fmtNum(value);
  return (
    <span className="suffix-input">
      <input inputMode="numeric" value={shown} disabled={disabled}
        onChange={(e) => { const d = e.target.value.replace(/[^\d-]/g, ''); onChange(d === '' || d === '-' ? '' : Number(d)); }} /><b>đ</b>
    </span>
  );
}

// Giá trị hiển thị trong bảng / Excel
export function displayValue(f, v, forExcel) {
  if (v === null || v === undefined || v === '') return '';
  if (f.type === 'currency') return forExcel ? Number(v) : `${fmtNum(v)} đ`;
  if (f.type === 'percent') return forExcel ? Number(v) : `${fmtNum(v, 2)}%`;
  if (f.type === 'datetime') return forExcel ? String(v).replace('T', ' ') : `${fmtDate(String(v).slice(0, 10))} ${String(v).slice(11, 16)}`;
  if (f.type === 'checkbox') return v ? (forExcel ? 'x' : '✓') : '';
  if (f.type === 'multiref') return (v || []).join(', ');
  if (f.type === 'select') return f.labels?.[v] || v;
  if (f.type === 'number') return forExcel ? v : fmtNum(v, 2);
  if (f.type === 'date') return forExcel ? v : fmtDate(v);
  return v;
}
