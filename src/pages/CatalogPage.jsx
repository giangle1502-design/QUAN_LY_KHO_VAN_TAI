import { useMemo, useRef, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import {
  collection, deleteDoc, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, where, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { CATALOGS, catalogByKey, NUMERIC_TYPES } from '../catalogs';
import { applyComputed, cleanValue, defaultsOf, docIdOf, keyFieldsOf } from '../lib/fields';
import { exportSheets, exportTemplate, readFirstSheet, toNumber, toYmd } from '../lib/excel';
import { norm, today } from '../lib/utils';
import FieldInput, { displayValue } from '../components/FieldInput';
import { Empty, ErrorBox, Field, Modal } from '../components/ui';

export default function CatalogPage() {
  const { key } = useParams();
  const cat = catalogByKey(key);
  if (!cat) return <Navigate to="/" />;
  return <Catalog key={key} cat={cat} />;
}

function Catalog({ cat }) {
  const app = useApp();
  const { isAdmin, canEdit, inMyWarehouses, fieldsOf, email } = app;
  const fields = fieldsOf(cat.key);
  const shown = fields.filter((f) => !f.hidden);
  const { rows, loading, error } = useCollection(cat.key);
  const [q, setQ] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [editing, setEditing] = useState(null); // {} = thêm mới
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef();

  // Người không phải quản trị chỉ thấy dữ liệu của kho được giao
  const mine = useMemo(
    () => (cat.warehouseField && !isAdmin ? rows.filter((r) => inMyWarehouses(r[cat.warehouseField])) : rows),
    [rows, cat, isAdmin, inMyWarehouses]
  );
  // Dòng còn thiếu trường bắt buộc (vd. nhập Excel chưa đủ, bổ sung sau)
  const reqFields = fields.filter((f) => f.required && !f.computed && !f.system && !f.hidden);
  const missingOf = (r) => reqFields.filter((f) => r[f.key] === '' || r[f.key] == null);
  const missingCount = mine.filter((r) => missingOf(r).length).length;
  const visible = useMemo(() => {
    let list = mine;
    if (onlyMissing) list = list.filter((r) => missingOf(r).length);
    const nq = norm(q);
    if (nq) list = list.filter((r) => shown.some((f) => norm(displayValue(f, r[f.key])).includes(nq)));
    return [...list].sort((a, b) => String(a._id).localeCompare(String(b._id), 'vi', { numeric: true }));
  }, [mine, q, shown, onlyMissing]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = canEdit(cat);

  const exportExcel = () => {
    const data = visible.map((r, i) => {
      const o = { STT: i + 1 };
      shown.forEach((f) => { o[f.label] = displayValue(f, r[f.key], true); });
      return o;
    });
    exportSheets(`${cat.short}_${today()}`, { [cat.short]: data.length ? data : [{ STT: '' }] });
  };

  const seed = async () => {
    const batch = writeBatch(db);
    cat.seed.forEach((s) => {
      const row = applyComputed(fields, { ...defaultsOf(fields), ...s });
      batch.set(doc(db, cat.key, docIdOf(cat, row)), { ...row, createdAt: serverTimestamp(), createdBy: email });
    });
    await batch.commit();
    setMsg(`Đã tạo ${cat.seed.length} dòng mặc định.`);
  };

  const importExcel = async (file) => {
    setErr(''); setMsg('');
    try {
      const res = await importRows(cat, fields, file, app);
      setMsg(`Nhập Excel: ${res.added} dòng mới, ${res.updated} dòng cập nhật.`
        + (res.incomplete.length ? ` ${res.incomplete.length} dòng còn thiếu thông tin, đã nhập và đánh dấu ⚠ để bổ sung sau.` : '')
        + (res.skipped.length ? ` Bỏ qua ${res.skipped.length} dòng.` : ''));
      const notes = [...res.skipped, ...res.incomplete];
      if (notes.length) setErr(notes.slice(0, 15).join('\n') + (notes.length > 15 ? `\n… và ${notes.length - 15} dòng khác` : ''));
      if (res.incomplete.length) setOnlyMissing(true);
    } catch (e) {
      setErr(e.message);
    }
    fileRef.current.value = '';
  };

  return (
    <div>
      <div className="page-head">
        <h1>{cat.icon} {cat.title}</h1>
        <div className="actions">
          {editable && <button className="btn primary" onClick={() => setEditing({})}>+ Thêm</button>}
          <button className="btn" onClick={exportExcel}>⬇ Excel</button>
          {isAdmin && <Link className="btn" to={`/hang-muc?dm=${cat.key}`} title="Đổi tên, ẩn, thêm trường cho danh mục này">🧩 Quản lý trường</Link>}
          {editable && (
            <>
              <button className="btn" onClick={() => fileRef.current.click()}>⬆ Nhập Excel</button>
              <button className="btn ghost" onClick={() => exportTemplate(`Mau_${cat.short}`, shown.filter((f) => !f.computed && !f.system).map((f) => f.label))}>File mẫu</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files[0] && importExcel(e.target.files[0])} />
            </>
          )}
        </div>
      </div>
      {editable && (
        <p className="hint">
          Nhập Excel: dòng đầu là tiêu đề cột, đặt đúng tên trường như File mẫu. Dòng trùng {keyFieldsOf(cat).map((k) => fields.find((f) => f.key === k)?.label).join(' + ')} sẽ được cập nhật.
        </p>
      )}
      <div className="toolbar">
        <input type="search" placeholder="Tìm kiếm…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="small">{visible.length} / {mine.length} dòng</span>
        {(missingCount > 0 || onlyMissing) && (
          <label className="small" style={{ color: 'var(--amber)' }}>
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Chỉ dòng còn thiếu thông tin ({missingCount})
          </label>
        )}
      </div>
      <ErrorBox error={error} />
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      {err && <div className="error-box" style={{ whiteSpace: 'pre-line' }}>{err}</div>}
      {isAdmin && cat.seed && !loading && rows.length === 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          Danh mục đang trống. <button className="btn sm primary" onClick={seed}>Tạo dữ liệu mặc định ({cat.seed.map((s) => s.code).join(', ')})</button>
        </div>
      )}
      <div className="table-wrap">
        {loading ? <Empty text="Đang tải…" /> : visible.length === 0 ? <Empty /> : (
          <table>
            <thead>
              <tr>
                <th className="stt">STT</th>
                {shown.map((f) => <th key={f.key} className={NUMERIC_TYPES.includes(f.type) ? 'num' : ''}>{f.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r._id} onClick={() => setEditing(r)} style={{ cursor: 'pointer' }}>
                  <td className="stt" title={missingOf(r).length ? 'Còn thiếu: ' + missingOf(r).map((f) => f.label).join(', ') : undefined}>
                    {i + 1}{missingOf(r).length ? <span style={{ color: 'var(--amber)' }}> ⚠</span> : null}
                  </td>
                  {shown.map((f) => <td key={f.key} className={NUMERIC_TYPES.includes(f.type) ? 'num' : f.type === 'textarea' ? '' : 'nowrap'}><Cell f={f} r={r} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <EditForm cat={cat} fields={fields} row={editing} existing={rows} onClose={() => setEditing(null)}
          onSaved={(t) => { setEditing(null); setMsg(t); setErr(''); }} />
      )}
    </div>
  );
}

function Cell({ f, r }) {
  const v = r[f.key];
  if (f.key === 'usedPct' && v != null) {
    const cls = v >= 100 ? 'full' : v >= 85 ? 'warn' : '';
    return (
      <span className="meter"><span className="bar"><div className={cls} style={{ width: `${Math.min(100, v)}%` }} /></span>{displayValue(f, v)}%</span>
    );
  }
  const text = displayValue(f, v);
  if (f.type === 'url' && text) return <a href={/^https?:\/\//i.test(text) ? text : `https://${text}`} target="_blank" rel="noreferrer">{String(text).replace(/^https?:\/\//i, '').slice(0, 40)}</a>;
  if (f.type === 'textarea') return <span className="small" title={text}>{String(text).slice(0, 60)}{String(text).length > 60 ? '…' : ''}</span>;
  return text;
}

// ---------------------------------------------------------------------------
// Form thêm / sửa 1 bản ghi
// ---------------------------------------------------------------------------
function EditForm({ cat, fields, row, existing, onClose, onSaved }) {
  const { canEdit, isAdmin, email } = useApp();
  const isNew = !row._id;
  const editable = canEdit(cat, isNew ? null : row);
  const keys = keyFieldsOf(cat);
  const [form, setForm] = useState(() => (isNew ? defaultsOf(fields) : { ...row }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const shownFields = fields.filter((f) => !f.hidden);
  const data = applyComputed(fields, form);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const onPickRef = (f, refRow) => {
    if (!f.fill) return;
    setForm((p) => {
      const n = { ...p };
      Object.entries(f.fill).forEach(([to, from]) => { n[to] = refRow[from] ?? ''; });
      return n;
    });
  };

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    const missing = fields.filter((f) => f.required && !f.computed && !f.system && (form[f.key] === '' || form[f.key] == null));
    // Thiếu mã/khóa thì không lưu được; thiếu trường khác vẫn cho lưu và đánh dấu ⚠ để bổ sung sau
    const missKey = missing.filter((f) => keys.includes(f.key));
    if (missKey.length) return setErr('Vui lòng nhập: ' + missKey.map((f) => f.label).join(', '));
    if (missing.length && !window.confirm(`Còn thiếu: ${missing.map((f) => f.label).join(', ')}.\nVẫn lưu và bổ sung sau?`)) return;
    if (!canEdit(cat, form)) return setErr('Bạn không có quyền lưu bản ghi cho kho này.');
    const out = {};
    fields.forEach((f) => {
      if (f.system) out[f.key] = isNew ? (form[f.key] ?? f.default ?? null) : row[f.key] ?? null;
      else out[f.key] = cleanValue(f, form[f.key]);
    });
    const final = applyComputed(fields, out);
    const id = isNew ? docIdOf(cat, final) : row._id;
    if (!id) return setErr('Thiếu mã bản ghi.');
    setBusy(true);
    try {
      if (isNew) {
        if (existing.some((r) => r._id === id) || (await getDoc(doc(db, cat.key, id))).exists())
          throw new Error('Mã này đã tồn tại trong danh mục.');
        await setDoc(doc(db, cat.key, id), { ...final, createdAt: serverTimestamp(), createdBy: email, updatedAt: serverTimestamp(), updatedBy: email });
      } else {
        await setDoc(doc(db, cat.key, id), { ...final, updatedAt: serverTimestamp(), updatedBy: email }, { merge: true });
      }
      onSaved(isNew ? 'Đã thêm.' : 'Đã lưu.');
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Không có quyền ghi (kiểm tra phân quyền).' : e2.message);
    }
    setBusy(false);
  };

  const remove = async () => {
    setErr('');
    const used = await findUsage(cat, row._id);
    if (used) return setErr(`Không xóa được: đang được dùng ở ${used}.`);
    if (!window.confirm('Xóa bản ghi này?')) return;
    try {
      await deleteDoc(doc(db, cat.key, row._id));
      onSaved('Đã xóa.');
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <Modal title={(isNew ? 'Thêm ' : editable ? 'Sửa ' : 'Xem ') + cat.short} onClose={onClose}>
      <form onSubmit={save}>
        <div className="form-grid">
          {shownFields.map((f) => {
            const ro = !editable || f.computed || f.system || (!isNew && keys.includes(f.key));
            return (
              <Field key={f.key} label={f.label} required={f.required && !ro} help={f.help} full={f.type === 'textarea' || f.type === 'multiref'}>
                {ro && (f.computed || f.system) ? (
                  <div className="readonly-val">{String(displayValue(f, data[f.key]) || '—')}{f.key === 'usedPct' && data[f.key] != null ? '%' : ''}</div>
                ) : (
                  <FieldInput field={f} value={form[f.key]} onChange={(v) => set(f.key, v)} disabled={ro} onPickRef={onPickRef} />
                )}
              </Field>
            );
          })}
        </div>
        {!isNew && row.updatedBy && <p className="small">Sửa lần cuối bởi {row.updatedBy}</p>}
        <ErrorBox error={err} />
        <div className="form-actions">
          {!isNew && isAdmin && <button type="button" className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>Xóa</button>}
          <button type="button" className="btn" onClick={onClose}>Đóng</button>
          {editable && <button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button>}
        </div>
      </form>
    </Modal>
  );
}

// Tìm danh mục khác đang tham chiếu tới bản ghi (để chặn xóa)
async function findUsage(cat, id) {
  for (const c of CATALOGS) {
    for (const f of c.fields) {
      if (f.ref !== cat.key) continue;
      const cond = f.type === 'multiref' ? where(f.key, 'array-contains', id) : where(f.key, '==', id);
      const s = await getDocs(query(collection(db, c.key), cond, limit(1)));
      if (!s.empty) return `${c.short} (${s.docs[0].id})`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Nhập Excel: khớp tiêu đề cột với tên trường (không phân biệt dấu/hoa thường)
// ---------------------------------------------------------------------------
const TRUE_WORDS = ['x', 'co', 'c', '1', 'true', 'yes', 'y', '✓', 'v'];

async function importRows(cat, fields, file, app) {
  const sheet = await readFirstSheet(file);
  if (sheet.length < 2) throw new Error('File không có dữ liệu (dòng 1 là tiêu đề, dữ liệu từ dòng 2).');
  const header = sheet[0].map(norm);
  const inputFields = fields.filter((f) => !f.computed && !f.system);
  const colOf = {};
  inputFields.forEach((f) => {
    const i = header.findIndex((h) => h && (h === norm(f.label) || h === norm(f.key)));
    if (i >= 0) colOf[f.key] = i;
  });
  const missingKeys = keyFieldsOf(cat).filter((k) => colOf[k] === undefined);
  if (missingKeys.length)
    throw new Error('Thiếu cột bắt buộc: ' + missingKeys.map((k) => fields.find((f) => f.key === k)?.label).join(', ') + '. Hãy dùng File mẫu.');

  // Dữ liệu tham chiếu để kiểm tra mã và tự điền
  const refData = {};
  for (const f of inputFields.filter((x) => x.type === 'ref' && colOf[x.key] !== undefined)) {
    if (refData[f.ref]) continue;
    const s = await getDocs(collection(db, f.ref));
    refData[f.ref] = new Map(s.docs.map((d) => [d.id, d.data()]));
  }

  // Đọc lại dữ liệu hiện có từ máy chủ (không phụ thuộc bảng đang hiển thị)
  const snap = await getDocs(collection(db, cat.key));
  const current = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
  const existingIds = new Set(current.map((r) => r._id));
  const existingMap = new Map(current.map((r) => [r._id, r]));
  const skipped = [];
  const incomplete = [];
  const writes = [];
  sheet.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    if (cells.every((c) => String(c ?? '').trim() === '')) return;
    const r = {};
    for (const f of inputFields) {
      if (colOf[f.key] === undefined) continue;
      const raw = cells[colOf[f.key]];
      if (NUMERIC_TYPES.includes(f.type)) r[f.key] = toNumber(raw);
      else if (f.type === 'date') r[f.key] = toYmd(raw);
      else if (f.type === 'checkbox') r[f.key] = TRUE_WORDS.includes(norm(raw));
      else r[f.key] = cleanValue(f, raw instanceof Date ? toYmd(raw) : String(raw ?? ''));
    }
    // Thiếu thông tin hoặc mã tham chiếu chưa có: vẫn nhập, ghi chú lại để bổ sung sau (chỉ bỏ qua khi thiếu mã/khóa)
    const notes = [];
    for (const f of inputFields.filter((x) => x.type === 'ref' && r[x.key])) {
      const ref = refData[f.ref]?.get(r[f.key]);
      if (!ref) { notes.push(`${f.label} "${r[f.key]}" chưa có trong danh mục`); continue; }
      if (f.fill) Object.entries(f.fill).forEach(([to, from]) => { if (!r[to]) r[to] = ref[from] ?? ''; });
    }
    if (cat.warehouseField && !app.canEdit(cat, r)) return skipped.push(`Dòng ${line}: không có quyền với kho ${r[cat.warehouseField]}`);
    const keyMissing = keyFieldsOf(cat).filter((k) => r[k] === '' || r[k] == null);
    const id = keyMissing.length ? '' : docIdOf(cat, r);
    if (!id) return skipped.push(`Dòng ${line}: thiếu ${keyMissing.map((k) => fields.find((f) => f.key === k)?.label).join(', ') || 'mã'} (bắt buộc để nhận diện dòng)`);
    const isNew = !existingIds.has(id);
    // Cập nhật dòng đã có: ô trống trong file không xóa dữ liệu cũ
    if (!isNew) Object.keys(r).forEach((k) => { if (r[k] === '' || r[k] == null) delete r[k]; });
    const after = { ...(isNew ? {} : existingMap.get(id)), ...r };
    const missing = inputFields.filter((f) => f.required && !f.hidden && (after[f.key] === '' || after[f.key] == null));
    if (missing.length) notes.unshift(`thiếu ${missing.map((f) => f.label).join(', ')}`);
    if (notes.length) incomplete.push(`Dòng ${line}: ${notes.join('; ')}`);
    writes.push({ id, r, isNew });
  });

  // Bản ghi trùng mã trong cùng file: dòng sau ghi đè dòng trước
  const byId = new Map(writes.map((w) => [w.id, w]));
  const list = [...byId.values()];
  for (let i = 0; i < list.length; i += 400) {
    const batch = writeBatch(db);
    list.slice(i, i + 400).forEach(({ id, r, isNew }) => {
      const base = isNew ? defaultsOf(fields) : existingMap.get(id);
      const merged = applyComputed(fields, { ...base, ...r });
      const payload = {};
      fields.forEach((f) => { if (merged[f.key] !== undefined) payload[f.key] = merged[f.key]; });
      delete payload._id;
      Object.assign(payload, { updatedAt: serverTimestamp(), updatedBy: app.email });
      if (isNew) Object.assign(payload, { createdAt: serverTimestamp(), createdBy: app.email });
      batch.set(doc(db, cat.key, id), payload, { merge: true });
    });
    await batch.commit();
  }
  return { added: list.filter((w) => w.isNew).length, updated: list.filter((w) => !w.isNew).length, skipped, incomplete };
}
