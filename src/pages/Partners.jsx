import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { catalogByKey } from '../catalogs';
import { cleanValue, defaultsOf } from '../lib/fields';
import { addRole, createMissingPartners, dupTaxGroups, mergeInto, mergePartners, PARTNER_STATUS, PARTNER_TYPES, roleOnlyFields, roleText, savePartner } from '../lib/partners';
import { saleSeesCustomer } from '../lib/plasticSales';
import FieldInput from '../components/FieldInput';
import { Empty, ErrorBox, Field, Modal } from '../components/ui';
import Select from '../components/Select';
import { EditForm } from './CatalogPage';

// Danh sách đối tác = hồ sơ partners gộp với Soldto + NCC theo mã (mã chưa có hồ sơ vẫn hiện)
export function usePartnerRows(enabled = true) {
  const { salesOnly, email } = useApp();
  const p = useCollection(enabled ? 'partners' : '');
  const s = useCollection(enabled ? 'soldto' : '');
  const v = useCollection(enabled ? 'suppliers' : '');
  const rows = useMemo(() => {
    const all = mergePartners(p.error ? [] : p.rows, s.rows, v.rows);
    // Sale chỉ thấy khách hàng mình được gán (NCC thì thấy hết)
    return salesOnly ? all.filter((r) => !r.isCustomer || saleSeesCustomer(r._soldto || {}, email)) : all;
  }, [p.rows, p.error, s.rows, v.rows, salesOnly, email]);
  return { rows, loading: p.loading || s.loading || v.loading, error: s.error || v.error, partnerError: p.error };
}

// Ô lọc cố định của trang Đối tác: loại đối tác, tình trạng sử dụng
export function PartnerFixedFilters({ value, onChange }) {
  return (
    <>
      <label className="small">Loại đối tác{' '}
        <Select value={value.type || ''} onChange={(e) => onChange({ ...value, type: e.target.value })}>
          {PARTNER_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </label>
      <span className="small">Tình trạng:{' '}
        {PARTNER_STATUS.map(([k, l]) => (
          <label key={k} style={{ marginRight: 8 }}><input type="radio" checked={(value.status || '') === k} onChange={() => onChange({ ...value, status: k })} /> {l}</label>
        ))}
      </span>
    </>
  );
}

// Thông báo: mã chưa có hồ sơ đối tác, mã khác nhau trùng mã số thuế (gộp)
export function PartnerNotices({ rows, partnerError, onMsg }) {
  const { isAdmin, email, name, canEdit } = useApp();
  const [dupOpen, setDupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const virtual = rows.filter((r) => r._virtual).length;
  const dups = useMemo(() => dupTaxGroups(rows), [rows]);
  const editable = canEdit(catalogByKey('partners'));
  const migrate = async () => {
    if (!window.confirm(`Tạo hồ sơ đối tác cho ${virtual} mã đang có ở Soldto / Nhà cung cấp?\nKhông đổi, không xóa dữ liệu Soldto / NCC.`)) return;
    setBusy(true);
    try { onMsg(`Đã tạo ${await createMissingPartners(rows, { email, name })} hồ sơ đối tác.`); } catch (e) { onMsg('', e.code === 'permission-denied' ? 'Chưa có quyền ghi danh mục Đối tác: cần dán quy tắc Firestore mới.' : e.message); }
    setBusy(false);
  };
  return (
    <>
      {partnerError && <div className="error-box">Chưa đọc được danh mục Đối tác (partners): cần dán quy tắc Firestore mới. Danh sách dưới đây gộp tạm từ Soldto và Nhà cung cấp.</div>}
      {virtual > 0 && (
        <p className="hint">
          {virtual} mã ở Soldto / Nhà cung cấp chưa có hồ sơ đối tác (vẫn hiện, vẫn dùng được; bấm vào để lưu hồ sơ).{' '}
          {isAdmin && <button type="button" className="btn sm" disabled={busy} onClick={migrate}>Tạo hồ sơ cho tất cả</button>}
        </p>
      )}
      {dups.length > 0 && (
        <div className="error-box" style={{ background: '#fff8e6', borderColor: 'var(--amber)', color: 'inherit' }}>
          ⚠ {dups.length} công ty có nhiều mã trùng mã số thuế (vd. {dups[0].map((r) => r.code).join(' / ')}). {' '}
          <button type="button" className="btn sm" onClick={() => setDupOpen(true)}>Xem và gộp</button>
        </div>
      )}
      {dupOpen && <DupModal groups={dups} editable={editable} onClose={() => setDupOpen(false)} onMsg={onMsg} />}
    </>
  );
}

function DupModal({ groups, editable, onClose, onMsg }) {
  const { email, name } = useApp();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const merge = async (keep, g) => {
    const others = g.filter((r) => r.code !== keep.code);
    if (!window.confirm(`Giữ mã ${keep.code} (${keep.name}), nhận đủ vai trò ${[...new Set(g.flatMap((r) => [r.isCustomer && 'khách hàng', r.isVendor && 'nhà cung cấp']).filter(Boolean))].join(' + ')}.\n`
      + `Mã ${others.map((r) => r.code).join(', ')} chuyển Ngừng sử dụng (SO / PO cũ vẫn giữ mã cũ, không đổi). Tiếp tục?`)) return;
    setErr(''); setBusy(keep.code);
    try { await mergeInto(keep, others, { email, name }); onMsg(`Đã gộp ${others.map((r) => r.code).join(', ')} vào ${keep.code}.`); }
    catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền ghi (cần dán quy tắc Firestore mới cho Đối tác).' : e.message); }
    setBusy('');
  };
  return (
    <Modal title="Mã khác nhau trùng mã số thuế" onClose={onClose} wide>
      <p className="hint">Thường là 1 công ty được tạo 2 lần (1 mã khách hàng, 1 mã nhà cung cấp). Chọn mã giữ lại: mã đó nhận đủ vai trò, mã còn lại ngừng sử dụng. Đơn hàng, phiếu kho cũ giữ nguyên mã cũ.</p>
      <ErrorBox error={err} />
      {groups.map((g) => (
        <div key={g[0].code} className="table-wrap" style={{ marginBottom: 10 }}>
          <table>
            <thead><tr><th>Mã</th><th>Tên</th><th>MST</th><th>Vai trò</th><th /></tr></thead>
            <tbody>{g.map((r) => (
              <tr key={r.code}><td className="mono">{r.code}</td><td>{r.name}</td><td>{r.taxCode}</td><td>{roleText(r)}</td>
                <td>{editable && <button type="button" className="btn sm" disabled={!!busy} onClick={() => merge(r, g)}>{busy === r.code ? 'Đang gộp…' : 'Giữ mã này'}</button>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ))}
    </Modal>
  );
}

// Nút trên form Soldto / Nhà cung cấp cũ: thêm vai trò kia cho cùng mã (NCC → cũng là khách hàng và ngược lại)
export function AddRoleButton({ catKey, row, onDone }) {
  const { email, name, canEdit } = useApp();
  const { rows } = usePartnerRows();
  const p = rows.find((r) => r.code === row._id);
  if (!p || !canEdit(catalogByKey('partners'))) return null;
  const role = catKey === 'soldto' ? 'vendor' : 'customer';
  const has = role === 'vendor' ? p.isVendor : p.isCustomer;
  const label = role === 'vendor' ? 'nhà cung cấp' : 'khách hàng';
  if (has) return <Link className="btn" to={`/dm/partners?q=${encodeURIComponent(row._id)}`} title="Mã này đã là cả khách hàng và nhà cung cấp">🤝 Hồ sơ đối tác</Link>;
  const go = async () => {
    if (!window.confirm(`Mã ${row._id} (${p.name || ''}) cũng là ${label}?\nGiữ nguyên mã và lịch sử, thêm vào danh mục ${role === 'vendor' ? 'Nhà cung cấp' : 'Soldto'} cùng mã.`)) return;
    try { await addRole(p, role, { email, name }); onDone(`Mã ${row._id} giờ là cả khách hàng và nhà cung cấp.`); } catch (e) { onDone('', e.message); }
  };
  return <button type="button" className="btn" onClick={go}>➕ Thêm vai trò {label}</button>;
}

// ---------------------------------------------------------------------------
// Form hồ sơ đối tác: thẻ Thông tin chung / Khách hàng (+ mã giao) / Nhà cung cấp / Thông tin bổ sung
// ---------------------------------------------------------------------------
export function PartnerForm({ row, existing, onClose, onSaved }) {
  const { fieldsOf, canEdit, email, name, canDesign } = useApp();
  const cat = catalogByKey('partners');
  const fields = fieldsOf('partners');
  const isNew = !row._id;
  const editable = canEdit(cat);
  const custFields = useMemo(() => roleOnlyFields('soldto', fieldsOf('soldto')), [fieldsOf]);
  const vendFields = useMemo(() => roleOnlyFields('suppliers', fieldsOf('suppliers')), [fieldsOf]);
  const [form, setForm] = useState(() => (isNew ? { ...defaultsOf(fields), ...row } : { ...row }));
  const [roles, setRoles] = useState(() => ({
    soldto: { ...defaultsOf(custFields), ...(row._soldto || {}) },
    suppliers: { ...defaultsOf(vendFields), ...(row._supplier || {}) },
  }));
  const [tab, setTab] = useState('chung');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));
  const setRole = (c, k, v) => setRoles((r) => ({ ...r, [c]: { ...r[c], [k]: v } }));
  const general = fields.filter((f) => !f.custom && !f.hidden && !f.key.startsWith('_') && !['isCustomer', 'isVendor'].includes(f.key));
  const extra = fields.filter((f) => f.custom && !f.hidden);
  const tabs = [['chung', 'Thông tin chung'], ...(form.isCustomer ? [['kh', '🏢 Khách hàng · điểm giao hàng']] : []), ...(form.isVendor ? [['ncc', '🏭 Nhà cung cấp']] : []), ['them', `Thông tin bổ sung${extra.length ? ` (${extra.length})` : ''}`]];
  const curTab = tabs.some(([k]) => k === tab) ? tab : 'chung';

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    const code = String(form.code || '').trim();
    if (!code) return setErr('Nhập mã đối tác.');
    if (/[/]/.test(code)) return setErr('Mã không được có dấu /.');
    if (!String(form.name || '').trim()) return setErr('Nhập tên công ty.');
    if (!form.isCustomer && !form.isVendor && !window.confirm('Chưa tích Là khách hàng / Là nhà cung cấp. Vẫn lưu?')) return;
    if (isNew && existing.some((r) => r.code === code)) return setErr(`Mã ${code} đã có. Mở mã đó và tích thêm vai trò thay vì tạo mã mới.`);
    const out = {};
    fields.forEach((f) => { out[f.key] = cleanValue(f, form[f.key]); });
    const clean = (list, data) => Object.fromEntries(list.map((f) => [f.key, cleanValue(f, data[f.key])]));
    setBusy(true);
    try {
      await savePartner({ ...out, code }, { soldto: clean(custFields, roles.soldto), suppliers: clean(vendFields, roles.suppliers) }, isNew ? null : row, { email, name });
      onSaved(isNew ? `Đã thêm đối tác ${code}.` : `Đã lưu ${code}.`);
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Không có quyền ghi (kiểm tra phân quyền, hoặc chưa dán quy tắc Firestore mới cho Đối tác).' : e2.message);
    }
    setBusy(false);
  };

  const input = (f, value, onChange, ro) => (
    <Field key={f.key} label={f.label} required={f.required && !ro} help={f.help} full={f.type === 'textarea' && !f.width} size={f}>
      <FieldInput field={f} value={value} onChange={onChange} disabled={ro} />
    </Field>
  );

  return (
    <Modal title={(isNew ? 'Thêm đối tác' : editable ? 'Sửa đối tác ' : 'Xem đối tác ') + (isNew ? '' : row.code)} onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="card" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 10, padding: 10 }}>
          <label><input type="checkbox" checked={!!form.isCustomer} disabled={!editable} onChange={(e) => set('isCustomer', e.target.checked)} /> <b>Là khách hàng</b></label>
          <label><input type="checkbox" checked={!!form.isVendor} disabled={!editable} onChange={(e) => set('isVendor', e.target.checked)} /> <b>Là nhà cung cấp</b></label>
          <span className="small" style={{ flex: '1 1 260px' }}>Tích cả hai khi vừa mua vừa bán (mượn hàng, mua lại hàng của khách). Đổi vai trò lúc nào cũng được: mã và lịch sử giữ nguyên; bỏ tích = ngừng giao dịch vai trò đó, không xóa.</span>
        </div>
        <div className="seg seg-wrap" style={{ marginBottom: 10 }}>
          {tabs.map(([k, l]) => <button type="button" key={k} className={curTab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {curTab === 'chung' && (
          <div className="form-grid">
            {general.map((f) => input(f, form[f.key], (v) => set(f.key, v), !editable || (!isNew && f.key === 'code')))}
          </div>
        )}
        {curTab === 'kh' && (
          <>
            <p className="small">Thiết lập riêng khi bán hàng cho đối tác này (lưu ở danh mục Soldto, mã {form.code || '…'}).</p>
            <div className="form-grid">{custFields.map((f) => input(f, roles.soldto[f.key], (v) => setRole('soldto', f.key, v), !editable))}</div>
            <ShipTos code={String(form.code || '').trim()} partner={form} saved={!isNew && !!row._soldto} />
          </>
        )}
        {curTab === 'ncc' && (
          <>
            <p className="small">Thiết lập riêng khi mua hàng của đối tác này (lưu ở danh mục Nhà cung cấp, mã {form.code || '…'}).</p>
            <div className="form-grid">{vendFields.map((f) => input(f, roles.suppliers[f.key], (v) => setRole('suppliers', f.key, v), !editable))}</div>
          </>
        )}
        {curTab === 'them' && (
          <>
            {extra.length ? <div className="form-grid">{extra.map((f) => input(f, form[f.key], (v) => set(f.key, v), !editable))}</div>
              : <Empty text="Chưa có trường bổ sung." />}
            {canDesign && <p className="small"><Link to="/hang-muc?dm=partners">🧩 Thêm trường bổ sung</Link> (vd. Loại hình XNK, Lĩnh vực…): trường mới tự có trong form, danh sách và bảng tìm kiếm nâng cao.</p>}
          </>
        )}
        {!isNew && row.updatedBy && <p className="small">Sửa lần cuối bởi {row.updatedBy}</p>}
        <ErrorBox error={err} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Đóng</button>
          {editable && <button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button>}
        </div>
      </form>
    </Modal>
  );
}

// Mã giao hàng (Shipto) của khách hàng: thêm / sửa ngay trong hồ sơ đối tác
function ShipTos({ code, partner, saved }) {
  const { fieldsOf } = useApp();
  const { rows } = useCollection('shipto');
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState('');
  const list = rows.filter((r) => r.customerCode === code);
  const cat = catalogByKey('shipto');
  return (
    <div style={{ marginTop: 12 }}>
      <div className="section-head">📍 Điểm giao hàng ({list.length})
        {saved ? <button type="button" className="btn sm" style={{ marginLeft: 8 }} onClick={() => setEditing({ customerCode: code, customerName: partner.name || '', taxCode: partner.taxCode || '' })}>+ Thêm điểm giao hàng</button>
          : <span className="small"> · lưu đối tác (là khách hàng) trước rồi thêm điểm giao hàng</span>}
      </div>
      {msg && <div className="ok-box">{msg}</div>}
      {list.length ? (
        <table><thead><tr><th>Mã giao</th><th>Địa chỉ</th><th>Người nhận</th><th>Điện thoại</th></tr></thead>
          <tbody>{list.map((s) => (
            <tr key={s._id} style={{ cursor: 'pointer' }} onClick={() => setEditing(s)}><td className="mono">{s.shipCode}</td><td>{s.address}</td><td>{s.contact}</td><td>{s.phone}</td></tr>
          ))}</tbody></table>
      ) : <p className="small">Chưa có điểm giao hàng.</p>}
      {editing && <EditForm cat={cat} fields={fieldsOf('shipto')} row={editing} existing={rows} onClose={() => setEditing(null)} onSaved={(t) => { setEditing(null); setMsg(t); }} />}
    </div>
  );
}
