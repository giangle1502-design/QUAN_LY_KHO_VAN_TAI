import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { CATALOGS, FIELD_TYPES, catalogByKey } from '../catalogs';
import { CHOICE_TYPES, DATE_DEFAULTS, parseChoices, toStored } from '../lib/fields';

const REF_TARGETS = CATALOGS.filter((c) => !['codeRules', 'users'].includes(c.key));
import { norm } from '../lib/utils';
import { EditForm } from '../pages/CatalogPage';
import { ErrorBox, Field, Modal } from './ui';

// Nút "+" cạnh ô chọn: thêm ngay bản ghi mới vào danh mục mà không phải rời form đang nhập
export function QuickAdd({ catKey, preset, onAdded }) {
  const { canEdit, fieldsOf } = useApp();
  const cat = catalogByKey(catKey);
  const [open, setOpen] = useState(false);
  if (!cat || cat.form || !canEdit(cat)) return null;
  return (
    <>
      <button type="button" className="btn sm quick-add" title={`Thêm ${cat.short} mới`} onClick={() => setOpen(true)}>+</button>
      {open && (
        // Sự kiện React đi xuyên portal: chặn "Lưu" của hộp thêm nhanh khỏi submit luôn form đơn hàng bên dưới
        <span onSubmit={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <EditForm cat={cat} fields={fieldsOf(catKey)} row={preset || {}} onClose={() => setOpen(false)}
            onSaved={(_msg, id, rec) => { setOpen(false); if (id) onAdded?.(id, rec); }} />
        </span>
      )}
    </>
  );
}

// Chọn cột muốn hiển thị (mỗi người dùng một cấu hình). cols: [{ key, label, locked }]
export function ColumnPicker({ cols, hidden, setHidden }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const toggle = (k) => setHidden(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k]);
  return (
    <span className="col-picker" ref={ref}>
      <button type="button" className="btn sm" onClick={() => setOpen((o) => !o)}>⚙ Cột hiển thị</button>
      {open && (
        <div className="col-picker-menu">
          {cols.map((c) => (
            <label key={c.key}><input type="checkbox" checked={c.locked || !hidden.includes(c.key)} disabled={c.locked} onChange={() => toggle(c.key)} /> {c.label}</label>
          ))}
          <small className="small">Chỉ áp dụng cho tài khoản của bạn trên máy này.</small>
        </div>
      )}
    </span>
  );
}

// Thêm trường mới ngay trên form (quản trị). vias: các trường chọn danh mục để liên kết, vd. [{ key: 'partyCode', label: 'Khách hàng', ref: 'soldto' }]
// Ngoài các trường có sẵn còn liên kết được với bất kỳ danh mục nào: tạo thêm 1 ô chọn danh mục đó trên form
export function AddFieldButton({ formKey, vias = [], label = '+ Thêm trường' }) {
  const { canDesign, fieldsOf } = useApp();
  const [open, setOpen] = useState(false);
  const EMPTY = { label: '', type: 'text', ref: '', options: '', def: '', via: '', viaCat: '', field: '', required: false };
  const [f, setF] = useState(EMPTY);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!canDesign) return null;
  const via = f.via === '__cat' ? (f.viaCat ? { key: '__cat', label: catalogByKey(f.viaCat)?.short, ref: f.viaCat } : null) : vias.find((v) => v.key === f.via);
  const targetFields = via ? fieldsOf(via.ref).filter((x) => !x.hidden) : [];
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setErr('');
    const lb = f.label.trim();
    if (!lb) return setErr('Nhập tên trường.');
    const cur = fieldsOf(formKey);
    if (cur.some((x) => norm(x.label) === norm(lb))) return setErr('Đã có trường cùng tên.');
    if (f.type === 'ref' && !f.ref) return setErr('Chọn danh mục để lấy dữ liệu.');
    const choices = parseChoices(f.options, f.type);
    const defVal = f.type === 'checkbox' ? (f.def ? true : '') : f.def === '' ? '' : ['number', 'percent', 'currency'].includes(f.type) ? Number(String(f.def).replace(/%$/, '')) : f.def;
    if (defVal !== '' && ['number', 'percent', 'currency'].includes(f.type) && !Number.isFinite(defVal)) return setErr('Giá trị mặc định phải là số.');
    if (defVal !== '' && f.type !== 'checkbox' && choices.length && !choices.includes(defVal)) return setErr('Giá trị mặc định phải nằm trong danh sách chọn.');
    const slug = norm(lb).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'truong';
    const key = `c_${slug}_${Date.now().toString(36).slice(-4)}`;
    const base = { key, label: lb, type: f.type, custom: true, required: f.required, hidden: false, ...(f.type === 'ref' ? { ref: f.ref } : {}),
      ...(CHOICE_TYPES.includes(f.type) && parseChoices(f.options, f.type).length ? { options: parseChoices(f.options, f.type) } : {}),
      ...(defVal !== '' && defVal !== undefined ? { default: defVal } : {}) };
    const patch = {};
    const extra = [];
    if (f.via === '__cat' && !via) return setErr('Chọn danh mục để liên kết.');
    if (via) {
      let target = f.field;
      if (target === '__new') {
        // Tạo luôn trường cùng tên trong danh mục được liên kết (vd. "Điều khoản thanh toán" trong Khách hàng)
        target = key;
        patch[via.ref] = [...toStored(fieldsOf(via.ref)), { ...base, required: false }];
      }
      if (!target) return setErr(`Chọn trường của ${catalogByKey(via.ref)?.short} để lấy giá trị.`);
      let viaKey = via.key;
      if (viaKey === '__cat') {
        // Thêm ô chọn danh mục đó (vd. "Đơn vị vận tải") ngay trước trường liên kết
        viaKey = `c_${norm(via.label).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'dm'}_${(Date.now() + 1).toString(36).slice(-4)}`;
        const lb2 = cur.some((c) => norm(c.label) === norm(via.label)) ? `${via.label} (liên kết)` : via.label;
        extra.push({ key: viaKey, label: lb2, type: 'ref', ref: via.ref, custom: true, required: false, hidden: false });
      }
      base.link = { via: viaKey, field: target };
    }
    patch[formKey] = [...toStored(cur), ...extra, base];
    setBusy(true);
    try {
      await setDoc(doc(db, 'settings', 'fields'), patch, { merge: true });
      setOpen(false); setF(EMPTY);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <>
      <button type="button" className="btn sm" onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <span onSubmit={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <Modal title={`Thêm trường – ${catalogByKey(formKey)?.title}`} onClose={() => setOpen(false)}>
          <div className="form-grid">
            <Field label="Tên trường" required><input value={f.label} onChange={(e) => set('label', e.target.value)} placeholder="VD: Điều khoản thanh toán" autoFocus /></Field>
            <Field label="Kiểu dữ liệu">
              <select value={f.type} onChange={(e) => set('type', e.target.value)}>{FIELD_TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}</select>
            </Field>
            {f.type === 'ref' && (
              <Field label="Chọn từ danh mục" required>
                <select value={f.ref} onChange={(e) => set('ref', e.target.value)}>
                  <option value="">-- Chọn --</option>
                  {REF_TARGETS.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
                </select>
              </Field>
            )}
            {CHOICE_TYPES.includes(f.type) && (
              <Field label={f.type === 'select' ? 'Danh sách chọn' : 'Danh sách giá trị chọn sẵn (tùy chọn)'} help="Cách nhau dấu phẩy; để trống = nhập tự do">
                <input value={f.options} onChange={(e) => set('options', e.target.value)} placeholder={f.type === 'percent' ? 'VD: 0, 5, 8, 10' : f.type === 'select' ? 'VD: 30 ngày, 45 ngày, Trả trước' : 'VD: 1, 2, 3'} /></Field>
            )}
            {f.type !== 'multiref' && (
              <Field label="Giá trị mặc định" help="Tự điền khi tạo mới (vẫn sửa được)">
                {f.type === 'checkbox' ? <input type="checkbox" checked={!!f.def} onChange={(e) => set('def', e.target.checked)} />
                  : parseChoices(f.options, f.type).length ? (
                    <select value={f.def} onChange={(e) => set('def', e.target.value)}><option value="">-- Không --</option>
                      {parseChoices(f.options, f.type).map((o) => <option key={o} value={o}>{f.type === 'percent' ? `${o}%` : o}</option>)}</select>
                  ) : ['date', 'datetime'].includes(f.type) ? (
                    <select value={f.def} onChange={(e) => set('def', e.target.value)}><option value="">-- Không --</option>
                      {DATE_DEFAULTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  ) : <input value={f.def} onChange={(e) => set('def', e.target.value)} placeholder={f.type === 'percent' ? 'VD: 8' : f.type === 'ref' ? 'Mã mặc định' : ''} />}
              </Field>
            )}
            <Field label="Liên kết với" help="Chọn bản ghi ở mục này thì trường tự điền theo (vẫn sửa tay được)">
              <select value={f.via} onChange={(e) => setF((x) => ({ ...x, via: e.target.value, viaCat: '', field: e.target.value ? '__new' : '' }))}>
                <option value="">-- Không liên kết --</option>
                {vias.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
                <option value="__cat">＋ Danh mục khác…</option>
              </select>
            </Field>
            {f.via === '__cat' && (
              <Field label="Danh mục liên kết" help="Form sẽ có thêm ô chọn danh mục này">
                <select value={f.viaCat} onChange={(e) => setF((x) => ({ ...x, viaCat: e.target.value, field: '__new' }))}>
                  <option value="">-- Chọn --</option>
                  {REF_TARGETS.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
                </select>
              </Field>
            )}
            {via && (
              <Field label={`Lấy từ trường của ${catalogByKey(via.ref)?.short}`}>
                <select value={f.field} onChange={(e) => set('field', e.target.value)}>
                  <option value="__new">＋ Tạo trường "{f.label.trim() || 'mới'}" trong {catalogByKey(via.ref)?.short}</option>
                  {targetFields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
              </Field>
            )}
            <Field label="Bắt buộc nhập"><input type="checkbox" checked={f.required} onChange={(e) => set('required', e.target.checked)} /></Field>
          </div>
          <ErrorBox error={err} />
          <div className="form-actions">
            <Link className="btn ghost" to={`/hang-muc?dm=${formKey}`} target="_blank" style={{ marginRight: 'auto' }}>Sắp xếp / ẩn / đổi tên trường…</Link>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Đóng</button>
            <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Thêm trường'}</button>
          </div>
        </Modal>
        </span>
      )}
    </>
  );
}
