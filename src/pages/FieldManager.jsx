import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { CATALOGS, FIELD_TYPES, FORM_DEFS, GROUPS, RESULT_TYPES, ROLES, catalogByKey } from '../catalogs';
import { checkFormula, formulaToKeys, formulaToLabels } from '../lib/formula';
import { syncFieldPrivacy } from '../lib/orderSecrets';
import { useCollection } from '../lib/hooks';
import { DATE_DEFAULTS, HEIGHT_OPTS, WIDTH_OPTS, badChoices, canChoose, canDefault, keyFieldsOf, parseChoices } from '../lib/fields';
import { norm } from '../lib/utils';
import { ErrorBox, Modal } from '../components/ui';

const typeLabel = (t) => FIELD_TYPES.find((x) => x[0] === t)?.[1] || { multiref: 'Chọn nhiều từ danh mục' }[t] || t;
const REF_TARGETS = CATALOGS.filter((c) => !['codeRules', 'users'].includes(c.key));

// Quản lý trường (hạng mục): đổi tên, sắp xếp, ẩn, bắt buộc, danh sách chọn và thêm trường mới cho mọi danh mục
export default function FieldManager() {
  const { fieldsOf, canDesign, isAdmin } = useApp();
  const [params] = useSearchParams();
  const [catKey, setCatKey] = useState(() => (catalogByKey(params.get('dm')) ? params.get('dm') : CATALOGS[0].key));
  const cat = catalogByKey(catKey);
  // Biểu mẫu đơn hàng: phần chung ↔ dòng hàng tra tên trường của nhau (công thức SUM, dùng giá trị phần chung)
  const otherKey = cat?.form ? (catKey.endsWith('Head') ? catKey.replace(/Head$/, 'Line') : catKey.replace(/Line$/, 'Head')) : '';
  const other = otherKey ? fieldsOf(otherKey) : [];
  const [viewersOf, setViewersOf] = useState(null); // vị trí trường đang chọn người xem
  const [list, setList] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [nf, setNf] = useState({ label: '', type: 'text', ref: '' });

  useEffect(() => {
    const all = fieldsOf(catKey);
    const oth = otherKey ? fieldsOf(otherKey) : [];
    setList(all.map((f) => ({ ...f, optionsText: (f.options || []).join(', '), defText: f.default === undefined ? '' : f.default === true ? 'true' : String(f.default),
      formulaText: f.type === 'formula' ? formulaToLabels(f.formula, all, oth) : '' })));
    setDirty(false); setMsg(''); setErr('');
  }, [catKey, fieldsOf]);

  const keys = keyFieldsOf(cat);
  // Mô tả trường liên kết: "Tự lấy theo Khách hàng → Điều khoản thanh toán"
  const linkText = (lk) => {
    const head = lk.via.startsWith('h:');
    const viaF = head ? fieldsOf(catKey.replace(/Line$/, 'Head')).find((x) => x.key === lk.via.slice(2)) : list.find((x) => x.key === lk.via);
    const target = viaF?.ref && catalogByKey(viaF.ref) ? fieldsOf(viaF.ref).find((x) => x.key === lk.field) : null;
    return `Tự lấy theo ${head ? '(phần chung) ' : ''}${viaF?.label || lk.via} → ${target?.label || lk.field}`;
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
    setList((l) => [...l, { key, label, type: nf.type, ...(nf.type === 'ref' ? { ref: nf.ref } : {}), custom: true, required: false, hidden: false, optionsText: '', defText: '' }]);
    setNf({ label: '', type: 'text', ref: '' }); setDirty(true); setErr('');
  };

  const save = async () => {
    setErr(''); setMsg('');
    const bad = list.find((f) => !String(f.label || '').trim());
    if (bad) return setErr('Tên trường không được để trống.');
    const noRef = list.find((f) => f.custom && f.type === 'ref' && !f.ref);
    if (noRef) return setErr(`Trường "${noRef.label}": chọn danh mục để lấy dữ liệu.`);
    for (const f of list.filter((x) => x.custom && x.type === 'formula')) {
      const e = checkFormula(f.formulaText, [list, other], catKey.endsWith('Head') ? other : []);
      if (e) return setErr(`Công thức "${f.label}": ${e}`);
    }
    const badF = list.find((f) => canChoose(f) && badChoices(f.optionsText, f.type).length);
    if (badF) return setErr(`Trường "${badF.label}" kiểu số chỉ nhận số, không lưu được: ${badChoices(badF.optionsText, badF.type).join(', ')}. Muốn chọn chữ (vd. VNĐ, USD) hãy đổi Kiểu dữ liệu sang "Danh sách chọn".`);
    const out = list.map((f) => {
      const o = { key: f.key, label: f.label.trim(), required: !!f.required, hidden: !!f.hidden,
        ...(Number(f.width) ? { width: Number(f.width) } : {}), ...(Number(f.height) ? { height: Number(f.height) } : {}) };
      if (canChoose(f)) { const c = parseChoices(f.optionsText, f.type); if (c.length) o.options = c; }
      // Giá trị mặc định khi tạo mới ('' = bỏ mặc định có sẵn trong code)
      const d = String(f.defText ?? '').trim().replace(/%$/, '');
      const baseDef = cat.fields.find((x) => x.key === f.key)?.default;
      if (canDefault(f)) {
        if (f.type === 'checkbox') { if (d === 'true' || baseDef !== undefined) o.default = d === 'true'; }
        else if (d !== '') o.default = ['number', 'percent', 'currency'].includes(f.type) ? Number(d) : d;
        else if (baseDef !== undefined && baseDef !== '') o.default = '';
      }
      if (f.custom) Object.assign(o, { custom: true, type: f.type, ...(f.type === 'ref' ? { ref: f.ref } : {}), ...(f.link ? { link: f.link } : {}),
        ...(f.type === 'formula' ? { formula: formulaToKeys(f.formulaText, list, other), resultType: f.resultType || 'number' } : {}),
        ...(f.viewers?.length && f.type !== 'formula' ? { viewers: f.viewers } : {}), ...(f.salesSees && f.type !== 'formula' ? { salesSees: true } : {}) });
      return o;
    });
    // Đổi người được xem trường đơn hàng: chuyển dữ liệu đã nhập sang / ra khỏi phần riêng tư
    const before = fieldsOf(catKey);
    const changed = cat.form ? out.filter((o) => o.custom && o.type !== 'formula'
      && ((before.find((b) => b.key === o.key)?.viewers || []).join(',') !== (o.viewers || []).join(',')
        || !!before.find((b) => b.key === o.key)?.salesSees !== !!o.salesSees)) : [];
    try {
      await setDoc(doc(db, 'settings', 'fields'), { [catKey]: out }, { merge: true });
      let moved = 0;
      for (const o of changed) moved += await syncFieldPrivacy(catKey.slice(0, -4).toUpperCase(), catKey.endsWith('Head') ? 'head' : 'line', o.key, o.viewers || [], !!o.salesSees);
      setDirty(false); setMsg(`Đã lưu. Các form, bảng và Excel của danh mục này đã cập nhật.${changed.length ? ` Đã áp quyền xem cho ${changed.length} trường (${moved} đơn có dữ liệu).` : ''}`);
    } catch (e) {
      setErr(e.message);
    }
  };

  if (!canDesign) return <p>Chỉ quản trị hoặc người được cấp quyền "Thiết lập biểu mẫu" được sửa trường.</p>;

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
        Trường khóa ({keys.map((k) => cat.fields.find((f) => f.key === k)?.label).join(' + ')}) luôn bắt buộc. Trường có sẵn không xóa được, chỉ ẩn. Cột Mặc định: giá trị tự điền khi tạo mới (vd. VAT 8%, ngày = Hôm nay), người nhập vẫn sửa được.
      </p>
      <ErrorBox error={err} />
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th className="stt">STT</th><th>Tên trường</th><th>Kiểu dữ liệu</th><th>Danh sách chọn / Công thức</th><th>Mặc định</th><th title="Độ rộng / cao ô nhập trên form">Rộng × Cao</th>{cat.form && <th>Người được xem</th>}<th>Bắt buộc</th><th>Ẩn</th><th></th></tr>
          </thead>
          <tbody>
            {list.map((f, i) => {
              const isKey = keys.includes(f.key);
              const auto = !!(f.computed || f.system);
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
                    {f.custom && f.type === 'formula' ? (
                      <>
                        <textarea rows={2} value={f.formulaText || ''} onChange={(e) => upd(i, { formulaText: e.target.value })} placeholder="VD: [Số lượng (tấn)] * [Đơn giá]" />
                        <select value={f.resultType || 'number'} onChange={(e) => upd(i, { resultType: e.target.value })} style={{ marginTop: 4 }}>
                          {RESULT_TYPES.map(([v, l]) => <option key={v} value={v}>Kết quả: {l}</option>)}</select>
                        {f.formulaText && checkFormula(f.formulaText, [list, other], catKey.endsWith('Head') ? other : []) && <div className="req small">{checkFormula(f.formulaText, [list, other], catKey.endsWith('Head') ? other : [])}</div>}
                      </>
                    ) : canChoose(f)
                      ? <><input type="text" value={f.optionsText} onChange={(e) => upd(i, { optionsText: e.target.value })} placeholder={f.type === 'percent' ? 'VD: 0, 5, 8, 10' : 'VD: VNĐ, USD'} />
                        {badChoices(f.optionsText, f.type).length > 0 && <div className="req small">Kiểu số chỉ nhận số: {badChoices(f.optionsText, f.type).join(', ')} sẽ bị bỏ.
                          {f.custom && <> <button type="button" className="btn sm" onClick={() => upd(i, { type: 'select' })}>Đổi sang Danh sách chọn</button></>}</div>}</>
                      : <span className="small">—</span>}
                  </td>
                  <td>
                    {!canDefault(f) ? <span className="small">—</span>
                      : f.type === 'checkbox' ? <input type="checkbox" checked={f.defText === 'true'} onChange={(e) => upd(i, { defText: e.target.checked ? 'true' : '' })} />
                      : parseChoices(f.optionsText, f.type).length ? (
                        <select value={f.defText} onChange={(e) => upd(i, { defText: e.target.value })}><option value="">--</option>
                          {parseChoices(f.optionsText, f.type).map((o) => <option key={o} value={o}>{f.type === 'percent' ? `${o}%` : o}</option>)}</select>
                      ) : ['date', 'datetime'].includes(f.type) ? (
                        <select value={f.defText} onChange={(e) => upd(i, { defText: e.target.value })}><option value="">--</option>
                          {DATE_DEFAULTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                      ) : <input type="text" value={f.defText} onChange={(e) => upd(i, { defText: e.target.value })} style={{ width: 110 }}
                        placeholder={f.type === 'ref' ? `Mã ${catalogByKey(f.ref)?.short || ''}` : f.type === 'percent' ? 'VD: 8' : ''} />}
                  </td>
                  <td className="nowrap">
                    <select value={Number(f.width) || 0} onChange={(e) => upd(i, { width: Number(e.target.value) })} title="Độ rộng">
                      {WIDTH_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    <select value={Number(f.height) || 0} onChange={(e) => upd(i, { height: Number(e.target.value) })} title="Độ cao" style={{ marginLeft: 4 }}>
                      {HEIGHT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  </td>
                  {cat.form && (
                    <td>
                      {!f.custom ? <span className="small">Mọi người</span>
                        : f.type === 'formula' ? <span className="small" title="Chỉ hiện với người xem được mọi trường trong công thức">Theo trường trong công thức</span>
                        : <button type="button" className="btn ghost sm" disabled={!isAdmin} title={isAdmin ? '' : 'Chỉ quản trị đặt người được xem'} onClick={() => setViewersOf(i)}>
                          {f.viewers?.length || f.salesSees ? `🔒 ${[f.salesSees ? 'Sale của đơn' : '', viewerText(f.viewers || [])].filter(Boolean).join(', ')}` : 'Mọi người'}</button>}
                    </td>
                  )}
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
      {viewersOf != null && list[viewersOf] && (
        <ViewersPicker field={list[viewersOf]} hasSales={/^(so|po)/.test(catKey)} onClose={() => setViewersOf(null)}
          onSave={(v, ss) => { upd(viewersOf, { viewers: v, salesSees: ss }); setViewersOf(null); }} />
      )}
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

const viewerText = (v) => v.map((x) => ROLES.find((r) => r[0] === x)?.[1] || x).join(', ');

// Chọn người / vai trò được xem 1 trường đơn hàng (quản trị luôn xem được)
function ViewersPicker({ field, hasSales, onClose, onSave }) {
  const users = useCollection('users').rows.filter((u) => u.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const [sel, setSel] = useState(field.viewers || []);
  const [ss, setSs] = useState(!!field.salesSees);
  const toggle = (x) => setSel((s) => (s.includes(x) ? s.filter((y) => y !== x) : [...s, x]));
  return (
    <Modal title={`Người được xem: ${field.label}`} onClose={onClose}>
      <p className="hint">Không chọn ai = mọi người xem được. Đã chọn thì chỉ những người / vai trò này và quản trị thấy trường này (cả trên màn hình, Excel và dữ liệu tải về). Trường công thức dùng trường này cũng ẩn với người khác.</p>
      {hasSales && (
        <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={ss} onChange={(e) => setSs(e.target.checked)} />
          <span><b>Sale phụ trách của đơn</b> xem được giá trị trong đơn của mình (vd. Giá bán: sale nào thấy đơn của sale đó). Người / vai trò chọn dưới đây xem được tất cả.</span></label>
      )}
      <div className="section-head">Người / vai trò xem được tất cả · theo vai trò</div>
      <div className="tags">{ROLES.filter((r) => r[0] !== 'admin').map(([k, l]) => (
        <label key={k} className={'chip' + (sel.includes(k) ? ' on' : '')}><input type="checkbox" hidden checked={sel.includes(k)} onChange={() => toggle(k)} />{l}</label>
      ))}</div>
      <div className="section-head" style={{ marginTop: 10 }}>Theo người dùng</div>
      <div className="tags">{users.filter((u) => u.role !== 'admin').map((u) => (
        <label key={u.email} className={'chip' + (sel.includes(u.email) ? ' on' : '')} title={u.email}><input type="checkbox" hidden checked={sel.includes(u.email)} onChange={() => toggle(u.email)} />{u.name || u.email}</label>
      ))}</div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => { setSel([]); setSs(false); }}>Bỏ giới hạn</button>
        <button type="button" className="btn primary" onClick={() => onSave(sel, ss)}>Xong</button>
      </div>
    </Modal>
  );
}
