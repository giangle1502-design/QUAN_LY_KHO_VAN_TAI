import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { CATALOGS, FIELD_TYPES, FORM_DEFS, GROUPS, catalogByKey } from '../catalogs';
import { keyFieldsOf } from '../lib/fields';
import { norm } from '../lib/utils';
import { ErrorBox } from '../components/ui';

const typeLabel = (t) => FIELD_TYPES.find((x) => x[0] === t)?.[1] || { multiref: 'Chọn nhiều từ danh mục' }[t] || t;
const REF_TARGETS = CATALOGS.filter((c) => !['codeRules', 'users'].includes(c.key));

// Quản lý trường (hạng mục): đổi tên, sắp xếp, ẩn, bắt buộc, danh sách chọn và thêm trường mới cho mọi danh mục
export default function FieldManager() {
  const { fieldsOf, isAdmin } = useApp();
  const [params] = useSearchParams();
  const [catKey, setCatKey] = useState(() => (catalogByKey(params.get('dm')) ? params.get('dm') : CATALOGS[0].key));
  const cat = catalogByKey(catKey);
  const [list, setList] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [nf, setNf] = useState({ label: '', type: 'text', ref: '' });

  useEffect(() => {
    setList(fieldsOf(catKey).map((f) => ({ ...f, optionsText: (f.options || []).join(', ') })));
    setDirty(false); setMsg(''); setErr('');
  }, [catKey, fieldsOf]);

  const keys = keyFieldsOf(cat);
  // Mô tả trường liên kết: "Tự lấy theo Khách hàng → Điều khoản thanh toán"
  const linkText = (lk) => {
    const viaF = cat.fields.find((x) => x.key === lk.via);
    const target = viaF?.ref && catalogByKey(viaF.ref) ? fieldsOf(viaF.ref).find((x) => x.key === lk.field) : null;
    return `Tự lấy theo ${viaF?.label || lk.via} → ${target?.label || lk.field}`;
  };
  const upd = (i, patch) => { setList((l) => l.map((f, j) => (j === i ? { ...f, ...patch } : f))); setDirty(true); };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    setList((l) => { const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n; });
    setDirty(true);
  };
  const removeCustom = (i) => {
    if (!window.confirm('Xóa trường này? Dữ liệu đã nhập ở trường này vẫn còn trong bản ghi nhưng không hiển thị nữa.')) return;
    setList((l) => l.filter((_, j) => j !== i)); setDirty(true);
  };
  const add = () => {
    const label = nf.label.trim();
    if (!label) return;
    if (nf.type === 'ref' && !nf.ref) return setErr('Chọn danh mục để lấy dữ liệu cho trường này.');
    if (list.some((f) => norm(f.label) === norm(label))) return setErr('Đã có trường cùng tên.');
    const slug = norm(label).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'truong';
    const key = `c_${slug}_${Date.now().toString(36).slice(-4)}`;
    setList((l) => [...l, { key, label, type: nf.type, ...(nf.type === 'ref' ? { ref: nf.ref } : {}), custom: true, required: false, hidden: false, optionsText: '' }]);
    setNf({ label: '', type: 'text', ref: '' }); setDirty(true); setErr('');
  };

  const save = async () => {
    setErr(''); setMsg('');
    const bad = list.find((f) => !String(f.label || '').trim());
    if (bad) return setErr('Tên trường không được để trống.');
    const noRef = list.find((f) => f.custom && f.type === 'ref' && !f.ref);
    if (noRef) return setErr(`Trường "${noRef.label}": chọn danh mục để lấy dữ liệu.`);
    const out = list.map((f) => {
      const o = { key: f.key, label: f.label.trim(), required: !!f.required, hidden: !!f.hidden };
      if (f.type === 'select' && !f.labels) o.options = f.optionsText.split(',').map((s) => s.trim()).filter(Boolean);
      if (f.custom) Object.assign(o, { custom: true, type: f.type, ...(f.type === 'ref' ? { ref: f.ref } : {}), ...(f.link ? { link: f.link } : {}) });
      return o;
    });
    try {
      await setDoc(doc(db, 'settings', 'fields'), { [catKey]: out }, { merge: true });
      setDirty(false); setMsg('Đã lưu. Các form, bảng và Excel của danh mục này đã cập nhật.');
    } catch (e) {
      setErr(e.message);
    }
  };

  if (!isAdmin) return <p>Chỉ quản trị được sửa hạng mục.</p>;

  return (
    <div>
      <div className="page-head">
        <h1>🧩 Quản lý trường (hạng mục)</h1>
        <div className="actions">
          <select value={catKey} onChange={(e) => (!dirty || window.confirm('Bỏ các thay đổi chưa lưu?')) && setCatKey(e.target.value)}>
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {CATALOGS.filter((c) => c.group === g).map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
              </optgroup>
            ))}
            <optgroup label="Biểu mẫu đơn hàng">{FORM_DEFS.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}</optgroup>
          </select>
          <button className="btn primary" disabled={!dirty} onClick={save}>Lưu thay đổi</button>
        </div>
      </div>
      <p className="hint">
        Chọn danh mục ở góc phải. Đổi tên, sắp xếp, ẩn hoặc bắt buộc nhập cho từng trường; thêm trường mới với kiểu dữ liệu:
        {' '}{FIELD_TYPES.map((x) => x[1]).join(', ')}.
        Trường khóa ({keys.map((k) => cat.fields.find((f) => f.key === k)?.label).join(' + ')}) luôn bắt buộc. Trường có sẵn không xóa được, chỉ ẩn.
      </p>
      <ErrorBox error={err} />
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th className="stt">STT</th><th>Tên trường</th><th>Kiểu dữ liệu</th><th>Danh sách chọn (cách nhau dấu phẩy)</th><th>Bắt buộc</th><th>Ẩn</th><th></th></tr>
          </thead>
          <tbody>
            {list.map((f, i) => {
              const isKey = keys.includes(f.key);
              const auto = f.computed || f.system;
              return (
                <tr key={f.key} className="fm-row">
                  <td className="stt">{i + 1}</td>
                  <td>
                    <input type="text" value={f.label} onChange={(e) => upd(i, { label: e.target.value })} />
                    <div className="small">{f.custom ? 'Trường tự thêm' : auto ? 'Hệ thống tự tính' : isKey ? 'Trường khóa' : 'Trường có sẵn'}</div>
                  </td>
                  <td>
                    {f.custom ? (
                      <>
                        <select value={f.type} onChange={(e) => upd(i, { type: e.target.value })}>
                          {FIELD_TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
                        </select>
                        {f.type === 'ref' && (
                          <select value={f.ref || ''} onChange={(e) => upd(i, { ref: e.target.value })} style={{ marginTop: 4 }}>
                            <option value="">-- Lấy từ danh mục --</option>
                            {REF_TARGETS.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
                          </select>
                        )}
                      </>
                    ) : <span className="small">{typeLabel(f.type)}{f.ref ? `: ${catalogByKey(f.ref)?.short}` : ''}</span>}
                    {f.link && <div className="link-hint">↳ {linkText(f.link)}</div>}
                  </td>
                  <td>
                    {f.type === 'select' && !f.labels
                      ? <input type="text" value={f.optionsText} onChange={(e) => upd(i, { optionsText: e.target.value })} placeholder="VD: Bao, Kg, Tấn" />
                      : <span className="small">—</span>}
                  </td>
                  <td><input type="checkbox" checked={!!f.required} disabled={isKey || auto || (f.builtin && cat.fields.find((x) => x.key === f.key)?.required)} onChange={(e) => upd(i, { required: e.target.checked })} /></td>
                  <td><input type="checkbox" checked={!!f.hidden} disabled={isKey} onChange={(e) => upd(i, { hidden: e.target.checked })} /></td>
                  <td className="act">
                    <button className="btn ghost sm" onClick={() => move(i, -1)} title="Lên">▲</button>
                    <button className="btn ghost sm" onClick={() => move(i, 1)} title="Xuống">▼</button>
                    {f.custom && <button className="btn ghost sm" onClick={() => removeCustom(i)} title="Xóa">🗑</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="inline-add card" style={{ marginTop: 12, alignItems: 'center' }}>
        <b>Thêm trường:</b>
        <input placeholder="Tên trường mới" value={nf.label} onChange={(e) => setNf({ ...nf, label: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <select value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value })}>
          {FIELD_TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
        </select>
        {nf.type === 'ref' && (
          <select value={nf.ref} onChange={(e) => setNf({ ...nf, ref: e.target.value })}>
            <option value="">-- Lấy từ danh mục --</option>
            {REF_TARGETS.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
          </select>
        )}
        <button className="btn" onClick={add}>+ Thêm</button>
      </div>
    </div>
  );
}
