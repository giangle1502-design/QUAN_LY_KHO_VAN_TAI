import { useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { catalogByKey, refLabel, refValue } from '../catalogs';
import { QuickAdd } from './FormTools';
import { fmtClock, fmtDate, fmtNum } from '../lib/utils';
import Select from './Select';
import { addChoice, canChoose, editChoice } from '../lib/fields';
import { locWh } from '../lib/whGroups';

// Ô nhập cho 1 trường theo kiểu dữ liệu
// unit: đơn vị tiền của trường kiểu Tiền ('đ' mặc định, 'USD' trên đơn USD)
export default function FieldInput({ field: f, value, onChange, disabled, onPickRef, unit, form }) {
  if (f.type === 'formula') return <div className="readonly-val" title="Tự tính theo công thức">{displayValue(f, value, false, unit) || '–'}</div>;
  if (f.type === 'ref') return <RefInput field={f} value={value} onChange={onChange} disabled={disabled} onPick={onPickRef} form={form} />;
  if (f.type === 'multiref') return <MultiRefInput field={f} value={value} onChange={onChange} disabled={disabled} />;
  if (f.type === 'select')
    return (
      <ChoiceAdd field={f} disabled={disabled} onAdded={onChange} value={value}>
        <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">-- Chọn --</option>
          {(f.options || []).map((o) => <option key={o} value={o}>{f.labels?.[o] || o}</option>)}
        </Select>
      </ChoiceAdd>
    );
  // Trường số / % / tiền / chữ có danh sách giá trị chọn sẵn (vd. VAT 5%, 8%, 10%)
  if (f.options?.length && ['number', 'percent', 'currency', 'text'].includes(f.type))
    return (
      <ChoiceAdd field={f} disabled={disabled} onAdded={onChange} value={value}>
        <Select value={value ?? ''} onChange={(e) => onChange(f.type === 'text' || e.target.value === '' ? e.target.value : Number(e.target.value))} disabled={disabled}>
          <option value="">-- Chọn --</option>
          {f.options.map((o) => <option key={o} value={o}>{f.type === 'percent' ? `${o}%` : f.type === 'currency' ? fmtNum(o) : o}</option>)}
        </Select>
      </ChoiceAdd>
    );
  if (f.type === 'image') return <ImageInput value={value} onChange={onChange} disabled={disabled} />;
  if (f.type === 'checkbox') return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />;
  if (f.type === 'textarea' || (f.type === 'text' && Number(f.height) > 40 && !f.options?.length)) return <textarea rows={2} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
  if (f.type === 'currency') return <MoneyInput value={value} onChange={onChange} disabled={disabled} unit={unit} />;
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

// Ô danh sách chọn + nút (+) thêm lựa chọn mới ngay trên form (vd. Hãng tàu chưa có trong danh sách)
function ChoiceAdd({ field: f, disabled, onAdded, children, value }) {
  const { role, canDesign } = useApp();
  const [busy, setBusy] = useState(false);
  const can = !disabled && f.form && !f.fixedChoices && canChoose(f) && (canDesign || ['admin', 'kinh_doanh', 'ke_toan', 'thu_kho', 'van_tai'].includes(role));
  if (!can) return children;
  const add = async () => {
    const txt = window.prompt(`Thêm lựa chọn mới cho "${f.label}":`, '');
    const raw = String(txt ?? '').trim().replace(/%$/, '').trim();
    if (!raw) return;
    const num = ['number', 'percent', 'currency'].includes(f.type);
    if (num && !Number.isFinite(Number(raw))) return window.alert(`"${f.label}" là trường số, chỉ thêm được số.`);
    const v = num ? Number(raw) : raw;
    const dup = (f.options || []).find((o) => String(o).toLowerCase() === String(v).toLowerCase());
    if (dup !== undefined) return onAdded(dup);
    setBusy(true);
    try { await addChoice(f, v); onAdded(v); }
    catch (e) { window.alert(e.code === 'permission-denied' ? 'Chưa có quyền thêm lựa chọn: quản trị cần cập nhật Firestore rules (settings/choices).' : e.message); }
    setBusy(false);
  };
  const cur = value === '' || value == null ? '' : String(value);
  const edit = async () => {
    const txt = window.prompt(`Sửa lựa chọn "${cur}" của "${f.label}" (để trống = xóa lựa chọn này khỏi danh sách):`, cur);
    if (txt === null) return;
    const raw = String(txt).trim().replace(/%$/, '').trim();
    const num = ['number', 'percent', 'currency'].includes(f.type);
    if (raw && num && !Number.isFinite(Number(raw))) return window.alert(`"${f.label}" là trường số, chỉ nhập được số.`);
    if (raw === cur) return;
    if (!raw && !window.confirm(`Xóa lựa chọn "${cur}" khỏi danh sách "${f.label}"? Bản ghi đã lưu giữ nguyên giá trị cũ.`)) return;
    setBusy(true);
    try { await editChoice(f, cur, raw ? (num ? Number(raw) : raw) : ''); onAdded(raw ? (num ? Number(raw) : raw) : ''); }
    catch (e) { window.alert(e.code === 'permission-denied' ? 'Chưa có quyền sửa danh sách chọn (cần quản trị).' : e.message); }
    setBusy(false);
  };
  return (
    <div className="cell-add">{children}
      <button type="button" className="btn sm quick-add" disabled={busy} title={`Thêm lựa chọn mới cho ${f.label}`} onClick={add}>+</button>
      {cur && (f.options || []).some((o) => String(o) === cur) && (
        <button type="button" className="btn sm quick-add" disabled={busy} title={`Sửa / xóa lựa chọn "${cur}"`} onClick={edit}>✏</button>
      )}
    </div>
  );
}

// Danh sách bản ghi của danh mục được tham chiếu (lọc theo kho được giao nếu là danh sách kho)
// role: chỉ lấy người dùng có vai trò này (vd. Sale phụ trách = Kinh doanh)
function useRefRows(refKey, role) {
  const { rows } = useCollection(refKey);
  const { inMyWarehouses } = useApp();
  return useMemo(() => {
    const list = refKey === 'warehouses' ? rows.filter((r) => inMyWarehouses(r.code))
      : role ? rows.filter((r) => r.role === role && r.active !== false) : rows;
    return list.map((r) => ({ value: refValue(refKey, r), label: refLabel(r), row: r })).sort((a, b) => String(a.value).localeCompare(String(b.value)));
  }, [rows, refKey, inMyWarehouses, role]);
}

// Ô chọn danh mục: ô chọn có tìm kiếm (Select.jsx, gõ mã / tên không dấu) + nút (+) thêm nhanh, ✏ sửa nhanh
// f.refBy { trườngDanhMục: trườngForm }: chỉ hiện bản ghi khớp giá trị đang nhập trên form (VD tài xế của đơn vị vận tải đang chọn)
// f.presetFrom { trườngDanhMục: trườngForm }: khi bấm + thì điền sẵn từ form (VD thêm tài xế mới mang theo tên, điện thoại đã gõ)
function RefInput({ field: f, value, onChange, disabled, onPick, form }) {
  const main = useRefRows(f.ref, f.refRole);
  // refAlso: chọn thêm từ danh mục thứ 2 (VD vị trí thuộc Kho hoặc Kho chung)
  const also = useRefRows(f.refAlso || '');
  // Vị trí của kho thuộc Kho chung lưu ở Kho chung: chỉ hiện Kho chung (đầu danh sách) + kho riêng chưa thuộc Kho chung nào
  const { whTick, myCarrier } = useApp();
  const by = f.refBy ? Object.entries(f.refBy).filter(([, fk]) => form?.[fk]) : [];
  const byKey = by.map(([k, fk]) => `${k}=${form[fk]}`).join('|');
  const opts = useMemo(() => {
    let list = f.refAlso
      ? [...also.map((o) => ({ ...o, label: `${o.label} (kho chung)` })), ...main.filter((o) => o.value === value || locWh(o.value) === o.value)]
      : main;
    // Đơn vị vận tải chỉ thấy xe / tài xế của mình
    const rc = catalogByKey(f.ref)?.carrierField;
    if (rc && myCarrier) list = list.filter((o) => o.value === value || !o.row[rc] || o.row[rc] === myCarrier);
    if (by.length) list = list.filter((o) => o.value === value || by.every(([k, fk]) => !o.row[k] || o.row[k] === form[fk]));
    return list;
  }, [main, also, f.refAlso, f.ref, value, whTick, myCarrier, byKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const known = !value || opts.some((o) => o.value === value);
  const short = catalogByKey(f.ref)?.short || '';
  const preset = { ...(f.addPreset || {}), ...Object.fromEntries(Object.entries(f.presetFrom || {}).map(([k, fk]) => [k, form?.[fk] ?? '']).filter(([, v]) => v !== '')) };
  return (
    <div className="cell-add ref-input">
      <Select searchable value={value ?? ''} disabled={disabled} placeholder={`-- Chọn ${short} --`}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v);
          const hit = opts.find((o) => o.value === v);
          if (hit && onPick) onPick(f, hit.row);
        }}>
        <option value="">{`-- Chọn ${short} --`}</option>
        {!known && <option value={value}>{`${value} (chưa có trong danh mục)`}</option>}
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label || o.value}</option>)}
      </Select>
      {!disabled && !f.noQuickAdd && <QuickAdd catKey={f.ref} preset={Object.keys(preset).length ? preset : undefined} value={main.some((o) => o.value === value) ? value : ''} onAdded={(id, rec) => { const v = rec ? refValue(f.ref, rec) || id : id; onChange(v); if (rec) onPick?.(f, rec); }} />}
      {!known && <small className="req" style={{ flexBasis: '100%' }}>Không có trong danh mục {short}: bấm + để thêm</small>}
    </div>
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
// USD: nhập được số lẻ (vd. 1,250.50) — giữ nguyên chữ đang gõ, định dạng lại khi rời ô
function MoneyInput({ value, onChange, disabled, unit = 'đ' }) {
  const usd = unit === 'USD';
  const [typing, setTyping] = useState(null);
  const shown = typing ?? (value === '' || value == null ? '' : fmtNum(value, usd ? 4 : 0));
  return (
    <span className="suffix-input">
      <input inputMode={usd ? 'decimal' : 'numeric'} value={shown} disabled={disabled} onBlur={() => setTyping(null)}
        onChange={(e) => {
          const d = e.target.value.replace(usd ? /[^\d.-]/g : /[^\d-]/g, '');
          if (usd) setTyping(e.target.value);
          onChange(d === '' || d === '-' || d === '.' || Number.isNaN(Number(d)) ? '' : Number(d));
        }} /><b>{unit}</b>
    </span>
  );
}

// Giá trị hiển thị trong bảng / Excel
export function displayValue(f, v, forExcel, unit = 'đ') {
  if (v === null || v === undefined || v === '') return '';
  if (f.type === 'formula') return displayValue({ type: f.resultType || 'number' }, v, forExcel, unit);
  if (f.type === 'currency') return forExcel ? Number(v) : `${fmtNum(v, unit === 'USD' ? 4 : 0)} ${unit || 'đ'}`;
  if (f.type === 'percent') return forExcel ? Number(v) : `${fmtNum(v, 2)}%`;
  if (f.type === 'datetime') return forExcel ? String(v).replace('T', ' ') : `${fmtDate(String(v).slice(0, 10))} ${String(v).length > 11 ? fmtClock(String(v).slice(11, 13), String(v).slice(14, 16)) : ''}`;
  if (f.type === 'checkbox') return v ? (forExcel ? 'x' : '✓') : '';
  if (f.type === 'image') return forExcel ? '' : '🖼 Có';
  if (f.type === 'multiref') return (v || []).join(', ');
  if (f.type === 'select') return f.labels?.[v] || v;
  if (f.type === 'number') return forExcel ? v : fmtNum(v, 2);
  if (f.type === 'date') return forExcel ? v : fmtDate(v);
  return v;
}

// Ô tải hình (VD logo công ty): thu nhỏ còn tối đa 600×240 px, lưu thẳng vào bản ghi (data URL, khoảng vài chục KB)
function ImageInput({ value, onChange, disabled }) {
  const ref = useRef();
  const [err, setErr] = useState('');
  const pick = (file) => {
    setErr('');
    if (!file) return;
    if (!/^image\//.test(file.type)) return setErr('Chỉ nhận file hình (PNG, JPG).');
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 600 / img.width, 240 / img.height);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        // PNG giữ nền trong suốt; quá nặng thì đổi sang JPG nền trắng
        let url = c.toDataURL('image/png');
        if (url.length > 150000) {
          const ctx = c.getContext('2d');
          ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          url = c.toDataURL('image/jpeg', 0.85);
        }
        onChange(url);
      };
      img.onerror = () => setErr('Không đọc được hình này.');
      img.src = r.result;
    };
    r.readAsDataURL(file);
    if (ref.current) ref.current.value = '';
  };
  return (
    <div className="image-input">
      {value ? <img src={value} alt="" style={{ maxHeight: 70, maxWidth: 220, display: 'block', border: '1px solid #ddd', background: '#fff', padding: 2 }} /> : <span className="small">Chưa có hình</span>}
      {!disabled && (
        <span style={{ display: 'inline-flex', gap: 6, marginTop: 4 }}>
          <button type="button" className="btn sm" onClick={() => ref.current?.click()}>{value ? 'Đổi hình' : '⬆ Tải hình'}</button>
          {value && <button type="button" className="btn sm ghost" onClick={() => onChange('')}>Xóa</button>}
        </span>
      )}
      <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files[0])} />
      {err && <div className="small" style={{ color: '#c00' }}>{err}</div>}
    </div>
  );
}
