import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { FIELD_TYPES, catalogByKey } from '../catalogs';
import { toStored } from '../lib/fields';
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
export function AddFieldButton({ formKey, vias = [], label = '+ Thêm trường' }) {
  const { canDesign, fieldsOf } = useApp();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ label: '', type: 'text', ref: '', options: '', via: '', field: '', required: false });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!canDesign) return null;
  const via = vias.find((v) => v.key === f.via);
  const targetFields = via ? fieldsOf(via.ref).filter((x) => !x.hidden) : [];
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setErr('');
    const lb = f.label.trim();
    if (!lb) return setErr('Nhập tên trường.');
    const cur = fieldsOf(formKey);
    if (cur.some((x) => norm(x.label) === norm(lb))) return setErr('Đã có trường cùng tên.');
    if (f.type === 'ref' && !f.ref) return setErr('Chọn danh mục để lấy dữ liệu.');
    const slug = norm(lb).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'truong';
    const key = `c_${slug}_${Date.now().toString(36).slice(-4)}`;
    const base = { key, label: lb, type: f.type, custom: true, required: f.required, hidden: false, ...(f.type === 'ref' ? { ref: f.ref } : {}),
      ...(f.type === 'select' ? { options: f.options.split(',').map((s) => s.trim()).filter(Boolean) } : {}) };
    const patch = {};
    if (via) {
      let target = f.field;
      if (target === '__new') {
        // Tạo luôn trường cùng tên trong danh mục được liên kết (vd. "Điều khoản thanh toán" trong Khách hàng)
        target = key;
        patch[via.ref] = [...toStored(fieldsOf(via.ref)), { ...base, required: false }];
      }
      if (!target) return setErr(`Chọn trường của ${catalogByKey(via.ref)?.short} để lấy giá trị.`);
      base.link = { via: via.key, field: target };
    }
    patch[formKey] = [...toStored(cur), base];
    setBusy(true);
    try {
      await setDoc(doc(db, 'settings', 'fields'), patch, { merge: true });
      setOpen(false); setF({ label: '', type: 'text', ref: '', options: '', via: '', field: '', required: false });
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
                  {['soldto', 'shipto', 'items', 'warehouses', 'companies', 'suppliers', 'carriers', 'threepl', 'reasons'].map((k) => <option key={k} value={k}>{catalogByKey(k)?.title}</option>)}
                </select>
              </Field>
            )}
            {f.type === 'select' && <Field label="Danh sách chọn" help="Cách nhau dấu phẩy"><input value={f.options} onChange={(e) => set('options', e.target.value)} placeholder="VD: 30 ngày, 45 ngày, Trả trước" /></Field>}
            {!!vias.length && (
              <Field label="Liên kết với" help="Chọn bản ghi ở mục này thì trường tự điền theo (vẫn sửa tay được)">
                <select value={f.via} onChange={(e) => setF((x) => ({ ...x, via: e.target.value, field: e.target.value ? '__new' : '' }))}>
                  <option value="">-- Không liên kết --</option>
                  {vias.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
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
