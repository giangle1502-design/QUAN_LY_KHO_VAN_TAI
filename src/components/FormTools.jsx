import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { CATALOGS, FIELD_TYPES, RESULT_TYPES, catalogByKey } from '../catalogs';
import { checkFormula, formulaToKeys, formulaToLabels } from '../lib/formula';
import { CHOICE_TYPES, DATE_DEFAULTS, HEIGHT_OPTS, WIDTH_OPTS, badChoices, parseChoices, toStored } from '../lib/fields';
import { dragHeadProps, orderCols } from '../lib/colOrder';

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
// order / setOrder (tùy chọn): thứ tự cột riêng của người dùng, kéo thả hoặc bấm ▲▼ trong danh sách
export function ColumnPicker({ cols, hidden, setHidden, order, setOrder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const toggle = (k) => setHidden(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k]);
  const list = setOrder ? orderCols(cols, order) : cols;
  const keys = list.map((c) => c.key);
  const step = (k, d) => { const i = keys.indexOf(k); const j = i + d; if (j < 0 || j >= keys.length) return; const n = [...keys]; [n[i], n[j]] = [n[j], n[i]]; setOrder(n); };
  return (
    <span className="col-picker" ref={ref}>
      <button type="button" className="btn sm" onClick={() => setOpen((o) => !o)}>⚙ Cột hiển thị</button>
      {open && (
        <div className="col-picker-menu">
          {list.map((c, i) => (
            <div key={c.key} className="col-picker-row" {...(setOrder ? dragHeadProps(c.key, keys, setOrder) : {})}>
              {setOrder && <span className="col-handle" title="Kéo để đổi thứ tự">☰</span>}
              <label><input type="checkbox" checked={c.locked || !hidden.includes(c.key)} disabled={c.locked} onChange={() => toggle(c.key)} /> {c.label}</label>
              {setOrder && <span className="col-steps">
                <button type="button" disabled={!i} onClick={() => step(c.key, -1)} title="Lên trước">▲</button>
                <button type="button" disabled={i === list.length - 1} onClick={() => step(c.key, 1)} title="Xuống sau">▼</button></span>}
            </div>
          ))}
          {setOrder && <button type="button" className="btn sm" style={{ marginTop: 6 }} onClick={() => setOrder([])}>↺ Thứ tự mặc định</button>}
          <small className="small">{setOrder ? 'Kéo ☰ (hoặc kéo tiêu đề cột trên bảng) để đổi thứ tự. ' : ''}Chỉ áp dụng cho tài khoản của bạn trên máy này.</small>
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
  const [listOpen, setListOpen] = useState(false);
  const [editing, setEditing] = useState(null); // trường tự thêm đang sửa
  const EMPTY = { label: '', type: 'text', ref: '', options: '', def: '', via: '', viaCat: '', field: '', required: false, formula: '', resultType: 'currency', width: 0, height: 0 };
  const [f, setF] = useState(EMPTY);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!canDesign) return null;
  const startAdd = () => { setEditing(null); setF(EMPTY); setErr(''); setOpen(true); };
  // Sửa trường đã thêm: điền sẵn cấu hình hiện tại
  const startEdit = (x) => {
    setEditing(x); setErr('');
    setF({ label: x.label, type: x.type, ref: x.ref || '', options: (x.options || []).join(', '), def: x.default === undefined ? '' : x.default,
      via: x.link?.via || '', viaCat: '', field: x.link?.field || '', required: !!x.required,
      formula: x.type === 'formula' ? formulaToLabels(x.formula, fieldsOf(formKey), otherList()) : '', resultType: x.resultType || 'number',
      width: Number(x.width) || 0, height: Number(x.height) || 0 });
    setOpen(true);
  };
  // Chỉnh nhanh độ rộng / cao cho mọi trường (trường chính và trường thêm)
  const setSize = async (x, k, v) => {
    try { await setDoc(doc(db, 'settings', 'fields'), { [formKey]: toStored(fieldsOf(formKey).map((y) => (y.key === x.key ? { ...y, [k]: v || undefined } : y))) }, { merge: true }); } catch (e) { window.alert(e.message); }
  };
  const remove = async (x) => {
    if (!window.confirm(`Xóa trường "${x.label}"? Dữ liệu đã nhập ở trường này vẫn còn trong bản ghi nhưng không hiển thị nữa.`)) return;
    try { await setDoc(doc(db, 'settings', 'fields'), { [formKey]: toStored(fieldsOf(formKey).filter((y) => y.key !== x.key)) }, { merge: true }); } catch (e) { window.alert(e.message); }
  };
  const via = f.via === '__cat' ? (f.viaCat ? { key: '__cat', label: catalogByKey(f.viaCat)?.short, ref: f.viaCat } : null) : vias.find((v) => v.key === f.via);
  const targetFields = via ? fieldsOf(via.ref).filter((x) => !x.hidden) : [];
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  // Công thức: tra tên trường cùng phần và phần còn lại của đơn (dòng hàng ↔ phần chung)
  const otherKey = /Head$/.test(formKey) ? formKey.replace(/Head$/, 'Line') : /Line$/.test(formKey) ? formKey.replace(/Line$/, 'Head') : '';
  const own = fieldsOf(formKey).filter((x) => !x.hidden);
  const otherList = () => (otherKey && catalogByKey(otherKey) ? fieldsOf(otherKey) : []);
  const other = otherList().filter((x) => !x.hidden);
  const numericFields = (list) => list.filter((x) => ['number', 'currency', 'percent', 'formula'].includes(x.type));
  const fErr = f.type === 'formula' && f.formula ? checkFormula(f.formula, [own, other], /Head$/.test(formKey) ? other : []) : '';
  const save = async () => {
    setErr('');
    const lb = f.label.trim();
    if (!lb) return setErr('Nhập tên trường.');
    const cur = fieldsOf(formKey);
    if (cur.some((x) => x.key !== editing?.key && norm(x.label) === norm(lb))) return setErr('Đã có trường cùng tên.');
    if (f.type === 'ref' && !f.ref) return setErr('Chọn danh mục để lấy dữ liệu.');
    if (f.type === 'formula' && !f.formula.trim()) return setErr('Nhập công thức.');
    if (fErr) return setErr(fErr);
    const bad = badChoices(f.options, f.type);
    if (bad.length) return setErr(`Kiểu "${FIELD_TYPES.find((x) => x[0] === f.type)?.[1]}" chỉ nhận số, không lưu được: ${bad.join(', ')}. Muốn chọn chữ (vd. VNĐ, USD) hãy đổi Kiểu dữ liệu sang "Danh sách chọn".`);
    const choices = parseChoices(f.options, f.type);
    const defVal = f.type === 'checkbox' ? (f.def ? true : '') : f.def === '' ? '' : ['number', 'percent', 'currency'].includes(f.type) ? Number(String(f.def).replace(/%$/, '')) : f.def;
    if (defVal !== '' && ['number', 'percent', 'currency'].includes(f.type) && !Number.isFinite(defVal)) return setErr('Giá trị mặc định phải là số.');
    if (defVal !== '' && f.type !== 'checkbox' && choices.length && !choices.includes(defVal)) return setErr('Giá trị mặc định phải nằm trong danh sách chọn.');
    const slug = norm(lb).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'truong';
    const key = editing ? editing.key : `c_${slug}_${Date.now().toString(36).slice(-4)}`;
    // Sửa: giữ ẩn / người được xem như cũ
    const keep = editing ? { hidden: !!editing.hidden, ...(editing.viewers?.length ? { viewers: editing.viewers } : {}), ...(editing.salesSees ? { salesSees: true } : {}) } : { hidden: false };
    const base = { key, label: lb, type: f.type, custom: true, required: f.required, ...keep, ...(f.type === 'ref' ? { ref: f.ref } : {}),
      ...(Number(f.width) ? { width: Number(f.width) } : {}), ...(Number(f.height) ? { height: Number(f.height) } : {}),
      ...(CHOICE_TYPES.includes(f.type) && parseChoices(f.options, f.type).length ? { options: parseChoices(f.options, f.type) } : {}),
      ...(defVal !== '' && defVal !== undefined && f.type !== 'formula' ? { default: defVal } : {}),
      ...(f.type === 'formula' ? { formula: formulaToKeys(f.formula, own, other), resultType: f.resultType } : {}) };
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
    patch[formKey] = editing
      ? toStored(cur).flatMap((x) => (x.key === key ? [...extra, base] : [x]))
      : [...toStored(cur), ...extra, base];
    setBusy(true);
    try {
      await setDoc(doc(db, 'settings', 'fields'), patch, { merge: true });
      setOpen(false); setF(EMPTY); setEditing(null);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <>
      <button type="button" className="btn sm" onClick={startAdd}>{label}</button>
      <button type="button" className="btn sm" title="Sửa / xóa trường, chỉnh độ rộng / cao" onClick={() => setListOpen(true)}>✎ Sửa trường</button>
      {listOpen && !open && (
        <span onSubmit={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <Modal title={`Trường – ${catalogByKey(formKey)?.title}`} onClose={() => setListOpen(false)} wide>
          <p className="hint">Chỉnh độ rộng, độ cao ô nhập của mọi trường (lưu ngay). Trường tự thêm sửa / xóa được.</p>
          {(
            <table><thead><tr><th>Trường</th><th>Rộng</th><th>Cao</th><th></th></tr></thead><tbody>
              {fieldsOf(formKey).filter((x) => !x.system && !x.hidden || x.custom).map((x) => (
                <tr key={x.key}>
                  <td><b>{x.label}</b>{x.hidden && <span className="badge" style={{ marginLeft: 4 }}>đang ẩn</span>}
                    <div className="small">{FIELD_TYPES.find((t) => t[0] === x.type)?.[1] || x.type}{x.link ? ' · có liên kết' : ''}{x.viewers?.length || x.salesSees ? ' · 🔒 giới hạn người xem' : ''}
                      {x.type === 'formula' ? ` · ${formulaToLabels(x.formula, fieldsOf(formKey), otherList())}` : ''}{!x.custom ? ' · trường chính' : ''}</div></td>
                  <td><select value={Number(x.width) || 0} onChange={(e) => setSize(x, 'width', Number(e.target.value))}>{WIDTH_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                  <td><select value={Number(x.height) || 0} onChange={(e) => setSize(x, 'height', Number(e.target.value))}>{HEIGHT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                  <td className="nowrap">
                    {x.custom && <><button type="button" className="btn sm" onClick={() => startEdit(x)}>✎ Sửa</button>{' '}
                    <button type="button" className="btn sm danger" onClick={() => remove(x)}>🗑 Xóa</button></>}
                  </td>
                </tr>
              ))}
            </tbody></table>
          )}
          <div className="form-actions">
            <Link className="btn ghost" to={`/hang-muc?dm=${formKey}`} target="_blank" style={{ marginRight: 'auto' }}>Sắp xếp / ẩn / người được xem…</Link>
            <button type="button" className="btn" onClick={() => setListOpen(false)}>Đóng</button>
          </div>
        </Modal>
        </span>
      )}
      {open && (
        <span onSubmit={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <Modal title={`${editing ? `Sửa trường "${editing.label}"` : 'Thêm trường'} – ${catalogByKey(formKey)?.title}`} onClose={() => setOpen(false)}>
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
                <input value={f.options} onChange={(e) => set('options', e.target.value)} placeholder={f.type === 'percent' ? 'VD: 0, 5, 8, 10' : f.type === 'select' ? 'VD: VNĐ, USD hoặc 30 ngày, 45 ngày' : 'VD: 1, 2, 3'} />
                {badChoices(f.options, f.type).length > 0 && <small className="req">Kiểu số chỉ nhận số: {badChoices(f.options, f.type).join(', ')} sẽ bị bỏ.{' '}
                  <button type="button" className="btn sm" onClick={() => set('type', 'select')}>Đổi sang Danh sách chọn</button></small>}</Field>
            )}
            {f.type === 'formula' && (
              <Field label="Công thức" required full help="Bấm tên trường để chèn. Dùng + − * / ( ); phần trăm tính như Excel (8% = 0,08). Ở phần chung dùng SUM([trường dòng hàng]) để cộng mọi dòng.">
                <textarea rows={2} value={f.formula} onChange={(e) => set('formula', e.target.value)} placeholder="VD: [Số lượng (tấn)] * [Đơn giá] * (1 + [VAT])" />
                <div className="tags" style={{ marginTop: 4 }}>
                  {numericFields(own).map((x) => <button type="button" key={x.key} className="chip" onClick={() => set('formula', `${f.formula}${f.formula && !/[\s(+\-*/]$/.test(f.formula) ? ' * ' : ''}[${x.label}]`)}>{x.label}</button>)}
                  {numericFields(other).map((x) => <button type="button" key={x.key} className="chip" title={/Head$/.test(formKey) ? 'Cộng mọi dòng hàng' : 'Lấy từ phần chung'}
                    onClick={() => set('formula', `${f.formula}${f.formula && !/[\s(+\-*/]$/.test(f.formula) ? ' + ' : ''}${/Head$/.test(formKey) ? `SUM([${x.label}])` : `[${x.label}]`}`)}>{/Head$/.test(formKey) ? `Σ ${x.label}` : `${x.label} (phần chung)`}</button>)}
                </div>
                {fErr && <small className="req">{fErr}</small>}
              </Field>
            )}
            {f.type === 'formula' && (
              <Field label="Kết quả hiện dạng">
                <select value={f.resultType} onChange={(e) => set('resultType', e.target.value)}>{RESULT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
            )}
            {!['multiref', 'formula'].includes(f.type) && (
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
            {f.type !== 'formula' && (
            <Field label="Liên kết với" help="Chọn bản ghi ở mục này thì trường tự điền theo (vẫn sửa tay được)">
              <select value={f.via} onChange={(e) => setF((x) => ({ ...x, via: e.target.value, viaCat: '', field: e.target.value ? '__new' : '' }))}>
                <option value="">-- Không liên kết --</option>
                {vias.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
                <option value="__cat">＋ Danh mục khác…</option>
              </select>
            </Field>
            )}
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
            <Field label="Độ rộng × độ cao ô nhập">
              <span className="nowrap">
                <select value={f.width} onChange={(e) => set('width', Number(e.target.value))}>{WIDTH_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                <select value={f.height} onChange={(e) => set('height', Number(e.target.value))} style={{ marginLeft: 4 }}>{HEIGHT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </span>
            </Field>
            <Field label="Bắt buộc nhập"><input type="checkbox" checked={f.required} onChange={(e) => set('required', e.target.checked)} /></Field>
          </div>
          <ErrorBox error={err} />
          <div className="form-actions">
            <Link className="btn ghost" to={`/hang-muc?dm=${formKey}`} target="_blank" style={{ marginRight: 'auto' }}>Sắp xếp / ẩn / đổi tên trường…</Link>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Đóng</button>
            <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : editing ? 'Lưu' : 'Thêm trường'}</button>
          </div>
        </Modal>
        </span>
      )}
    </>
  );
}
