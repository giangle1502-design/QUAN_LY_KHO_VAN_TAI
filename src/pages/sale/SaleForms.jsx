import { useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { applyComputed, cleanValue, defaultsOf } from '../../lib/fields';
import { mergePartners, savePartner } from '../../lib/partners';
import { PLASTIC_TYPES } from '../../lib/plasticSales';
import { sysNotify } from '../../lib/chat';
import { badTaxCode, convertWrites, findDuplicates, linkProspect, missingInfo, saveActivity, saveProspect } from '../../lib/sale';
import FieldInput from '../../components/FieldInput';
import { AddFieldButton } from '../../components/FormTools';
import Select from '../../components/Select';
import { Field, Modal } from '../../components/ui';

// ---------- Ô nhập theo cấu hình biểu mẫu (trường có sẵn + trường tự thêm, đổi tên / ẩn / bắt buộc ở Quản lý trường) ----------
function useFormFields(formKey, rec) {
  const { fieldsOf } = useApp();
  const fields = useMemo(() => fieldsOf(formKey).filter((f) => !f.hidden), [fieldsOf, formKey]);
  const [v, setV] = useState(() => (rec ? Object.fromEntries(fields.map((f) => [f.key, rec[f.key] ?? ''])) : defaultsOf(fields)));
  const data = applyComputed(fields, v);
  return {
    fields, v, setV, data,
    missing: () => fields.filter((f) => f.required && f.type !== 'formula' && (v[f.key] === '' || v[f.key] == null)).map((f) => f.label),
    values: () => Object.fromEntries(fields.map((f) => [f.key, cleanValue(f, f.type === 'formula' ? data[f.key] : v[f.key])])),
  };
}
function FormFields({ ff, formKey, title }) {
  return (
    <>
      <div className="section-head"><span className="grow">{title}</span><AddFieldButton formKey={formKey} /></div>
      <div className="form-grid">
        {ff.fields.map((f) => (
          <Field key={f.key} label={f.label} required={f.required && f.type !== 'formula'} help={f.help} full={f.type === 'textarea' && !f.width} size={f}>
            <FieldInput field={f} value={f.type === 'formula' ? ff.data[f.key] : ff.v[f.key]} onChange={(x) => ff.setV((o) => ({ ...o, [f.key]: x }))} />
          </Field>
        ))}
      </div>
    </>
  );
}

// Danh sách sale (vai trò Kinh doanh) để chọn sale phụ trách
export function useSales() {
  const { rows } = useCollection('users');
  return useMemo(() => {
    const list = rows.filter((u) => u.role === 'kinh_doanh' && u.active !== false).map((u) => ({ email: u._id, name: u.name || u._id }));
    const names = new Map(rows.map((u) => [u._id, u.name || u._id]));
    return { list, nameOf: (e) => (e ? names.get(String(e).toLowerCase()) || e : '') };
  }, [rows]);
}
function SalePicker({ value, onChange, disabled }) {
  const { list } = useSales();
  return (
    <Select value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">-- Chưa gán --</option>
      {list.map((u) => <option key={u.email} value={u.email}>{u.name} ({u.email})</option>)}
      {value && !list.some((u) => u.email === value) && <option value={value}>{value}</option>}
    </Select>
  );
}

// ---------- Khách hàng đang tiếp cận: thêm / sửa ----------
export function ProspectForm({ rec, onClose }) {
  const { email, name, salesOnly } = useApp();
  const ff = useFormFields('prospect', rec);
  const [owner, setOwner] = useState(rec?.owner || email);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const miss = ff.missing();
    if (miss.length) return setErr(`Còn thiếu: ${miss.join(', ')}`);
    setBusy(true); setErr('');
    try {
      await saveProspect(rec?.id, { ...ff.values(), owner }, { email, name });
      onClose(true);
    } catch (e2) { setErr(e2.code === 'permission-denied' ? 'Chưa có quyền ghi: cần dán quy tắc Firestore mới (mục prospects).' : e2.message); setBusy(false); }
  };
  return (
    <Modal title={rec ? `Sửa khách đang tiếp cận · ${rec.name}` : 'Thêm khách hàng đang tiếp cận'} onClose={() => onClose(false)} wide>
      <form onSubmit={submit}>
        <p className="hint">Nhập tạm những gì biết được. Khi khách chốt đơn, bấm <b>🏷 Tạo mã khách hàng</b> để bổ sung đủ thông tin và chuyển khách sang danh mục Khách hàng / NCC bên kho.</p>
        <FormFields ff={ff} formKey="prospect" title="Thông tin khách" />
        <div className="form-grid" style={{ marginTop: 8 }}>
          <Field label="Sale phụ trách" help={salesOnly ? 'Sale quản lý / quản trị mới đổi được' : 'Sale này thấy và chăm sóc khách'}>
            <SalePicker value={owner} onChange={setOwner} disabled={salesOnly} />
          </Field>
        </div>
        {err && <div className="error-box">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => onClose(false)}>Hủy</button>
          <button className="btn primary" disabled={busy}>Lưu</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Ghi hoạt động ----------
// target: { prospectId } hoặc { partyCode } (mở từ dòng khách) — không có thì chọn khách trong danh sách options
// options: [{ key: 'P:id' | 'C:mã', label, prospectId?, partyCode?, name }]
export function ActivityForm({ rec, target, options = [], onClose }) {
  const { email, name } = useApp();
  const ff = useFormFields('activity', rec);
  const initKey = rec ? (rec.partyCode ? `C:${rec.partyCode}` : `P:${rec.prospectId}`) : target ? (target.partyCode ? `C:${target.partyCode}` : `P:${target.prospectId}`) : '';
  const [cust, setCust] = useState(initKey);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const opt = options.find((o) => o.key === cust) || (target && { ...target, key: initKey }) || (rec && { key: initKey, partyCode: rec.partyCode, prospectId: rec.prospectId, name: rec.customerName });
  const submit = async (e) => {
    e.preventDefault();
    const miss = [...(!cust ? ['Khách hàng'] : []), ...ff.missing()];
    if (miss.length) return setErr(`Còn thiếu: ${miss.join(', ')}`);
    setBusy(true); setErr('');
    try {
      const link = cust.startsWith('C:') ? { partyCode: cust.slice(2), prospectId: '' } : { prospectId: cust.slice(2), partyCode: '' };
      await saveActivity(rec?.id, { ...ff.values(), ...link, customerName: opt?.name || rec?.customerName || '', ...(rec ? { owner: rec.owner, ownerName: rec.ownerName } : {}) }, { email, name });
      onClose(true);
    } catch (e2) { setErr(e2.code === 'permission-denied' ? 'Chưa có quyền ghi: cần dán quy tắc Firestore mới (mục activities).' : e2.message); setBusy(false); }
  };
  return (
    <Modal title={rec ? 'Sửa hoạt động' : 'Ghi hoạt động mới'} onClose={() => onClose(false)} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Khách hàng" required full>
            {target || rec ? <div className="readonly-val">{opt?.name || rec?.customerName}{opt?.partyCode ? ` (mã ${opt.partyCode})` : ' · đang tiếp cận'}</div> : (
              <Select value={cust} onChange={(e) => setCust(e.target.value)} searchable>
                <option value="">-- Chọn khách --</option>
                {options.map((o) => <option key={o.key} value={o.key} data-search={o.search || ''}>{o.label}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <FormFields ff={ff} formKey="activity" title="Nội dung hoạt động" />
        {err && <div className="error-box">{err}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => onClose(false)}>Hủy</button>
          <button className="btn primary" disabled={busy}>Lưu</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Tạo mã khách hàng từ khách đang tiếp cận ----------
// Sale sửa tên đúng theo giấy phép, bổ sung thông tin xuất hóa đơn, điểm giao, sale phụ trách.
// Lưu: hồ sơ Khách hàng / NCC (partners + soldto) + điểm giao (shipto) + đánh dấu khách đã tạo mã, trong 1 lần ghi.
const INVOICE_ENTITIES = [['VAP', 'Hóa đơn chỉ xuất pháp nhân VAP'], ['PLA', 'Hóa đơn chỉ xuất pháp nhân PLA'], ['VAP/PLA', 'Hóa đơn xuất cả hai pháp nhân VAP/PLA']];
export function CreateCodeModal({ prospect: p, onClose }) {
  const { email, name, salesOnly } = useApp();
  const partners = useCollection('partners');
  const soldto = useCollection('soldto');
  const suppliers = useCollection('suppliers');
  const all = useMemo(() => mergePartners(partners.error ? [] : partners.rows, soldto.rows, suppliers.rows), [partners.rows, partners.error, soldto.rows, suppliers.rows]);
  const owner = p.owner || email;
  const [f, setF] = useState({
    code: '', name: p.name || '', taxCode: p.taxCode || '', billingAddress: p.address || '', invoiceEntity: '',
    phone: p.phone || '', email: p.email || '', contact: p.contact || '',
    salesVirgin: ['Nguyên sinh', 'Cả hai'].includes(p.plasticType) || !p.plasticType ? owner : '',
    salesRecycled: ['Tái sinh', 'Cả hai'].includes(p.plasticType) ? owner : '',
    shipCode: '', shipAddress: p.address || '', note: p.note || '',
  });
  const [shipTouched, setShipTouched] = useState(false);
  const [okName, setOkName] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value, ...(k === 'code' && !shipTouched ? { shipCode: e.target.value } : {}) }));
  const code = f.code.trim();
  const codeTaken = code && all.some((r) => r.code.toLowerCase() === code.toLowerCase());
  const dup = useMemo(() => findDuplicates(all.filter((r) => r.status !== 'inactive'), f), [all, f.taxCode, f.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const REQ = [['code', 'Mã khách hàng'], ['name', 'Tên công ty'], ['taxCode', 'Mã số thuế'], ['billingAddress', 'Địa chỉ xuất hóa đơn'], ['invoiceEntity', 'Pháp nhân xuất hóa đơn'], ['phone', 'Điện thoại'], ['shipCode', 'Mã giao hàng'], ['shipAddress', 'Địa chỉ giao hàng']];
  const empty = (k) => !String(f[k] || '').trim();
  const miss = REQ.filter(([k]) => empty(k)).map(([, l]) => l);
  const redIf = (k) => (empty(k) ? { borderColor: 'var(--red)', background: '#fff6f6' } : undefined);

  const link = async (r) => {
    if (!window.confirm(`Gắn khách "${p.name}" vào mã có sẵn ${r.code} – ${r.name}?\nKhông tạo mã mới; lịch sử hoạt động chuyển theo mã ${r.code}.`)) return;
    setBusy(true);
    try { await linkProspect(p, r.code, { email, name }); onClose(r.code); } catch (e) { setErr(e.message); setBusy(false); }
  };
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (miss.length) return setErr(`Còn thiếu: ${miss.join(', ')}`);
    if (codeTaken) return setErr(`Mã ${code} đã có trong danh mục Khách hàng / NCC. Chọn mã khác.`);
    if (dup.taxHit.length) return setErr(`Mã số thuế đã có ở mã ${dup.taxHit.map((r) => r.code).join(', ')}. Gắn vào mã có sẵn thay vì tạo mã mới.`);
    if (dup.nameHits.length && !okName) return setErr('Có khách tên gần giống. Kiểm tra danh sách bên dưới rồi tích "Đã kiểm tra, không trùng".');
    setBusy(true);
    const user = { email, name };
    try {
      await savePartner(
        { code, name: f.name.trim(), taxCode: f.taxCode.trim(), billingAddress: f.billingAddress.trim(), phone: f.phone.trim(), email: f.email.trim().toLowerCase(),
          contactName: f.contact.trim(), note: f.note, isCustomer: true, isVendor: false, status: 'active', fromProspect: p.id },
        { soldto: { salesVirgin: f.salesVirgin, salesRecycled: f.salesRecycled, invoiceEntity: f.invoiceEntity, note: f.note } },
        null, user,
        (b, c) => convertWrites(b, p, c, user, { customerCode: c, customerName: f.name.trim(), taxCode: f.taxCode.trim(), shipCode: f.shipCode.trim(), address: f.shipAddress.trim(), contact: f.contact.trim(), phone: f.phone.trim() }),
      );
      sysNotify('customer_new', { id: code, partyName: f.name.trim(), partyCode: code, sales: owner, link: `/dm/partners?q=${encodeURIComponent(code)}` }, user);
      onClose(code);
    } catch (e2) { setErr(e2.code === 'permission-denied' ? 'Chưa có quyền ghi: cần dán quy tắc Firestore mới.' : e2.message); setBusy(false); }
  };
  const before = missingInfo(p);
  return (
    <Modal title={`🏷 Tạo mã khách hàng · ${p.name}`} onClose={() => onClose('')} wide>
      <form onSubmit={submit}>
        <p className="hint">
          Sửa tên đúng theo giấy phép kinh doanh, bổ sung đủ các ô tô đỏ. Lưu xong khách có mã trong danh mục <b>Khách hàng / NCC</b>, lập SO được ngay, lịch sử chăm sóc vẫn đi theo khách.
          {before.length > 0 && <> Lúc nhập ban đầu còn thiếu: {before.join(', ')}.</>}
        </p>
        <div className="form-grid">
          <Field label="Mã khách hàng" required help="Nên trùng mã trên Ecount / MISA">
            <input value={f.code} onChange={set('code')} style={redIf('code')} autoFocus />
            {codeTaken && <small style={{ color: 'var(--red)' }}>Mã này đã có.</small>}
          </Field>
          <Field label="Tên công ty (đúng theo giấy phép)" required size={{ width: 480 }}><input value={f.name} onChange={set('name')} style={redIf('name')} /></Field>
          <Field label="Mã số thuế" required>
            <input value={f.taxCode} onChange={set('taxCode')} style={redIf('taxCode')} />
            {badTaxCode(f.taxCode) && <small style={{ color: 'var(--amber)' }}>MST thường là 10 số (hoặc 10 số - 3 số chi nhánh).</small>}
          </Field>
          <Field label="Pháp nhân xuất hóa đơn" required>
            <Select value={f.invoiceEntity} onChange={set('invoiceEntity')} style={redIf('invoiceEntity')}>
              <option value="">-- Chọn --</option>
              {INVOICE_ENTITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Địa chỉ đăng ký (xuất hóa đơn)" required full><textarea rows={2} value={f.billingAddress} onChange={set('billingAddress')} style={redIf('billingAddress')} /></Field>
          <Field label="Người liên hệ"><input value={f.contact} onChange={set('contact')} /></Field>
          <Field label="Điện thoại" required><input value={f.phone} onChange={set('phone')} style={redIf('phone')} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
          {PLASTIC_TYPES.map((t) => (
            <Field key={t.key} label={`Sale phụ trách hạt ${t.type.toLowerCase()}`} help="Đã gán sale: chỉ sale được gán mới thấy khách và lập SO loại hàng này">
              <SalePicker value={f[t.key]} onChange={(v) => setF((x) => ({ ...x, [t.key]: v }))} disabled={salesOnly && f[t.key] && f[t.key] !== email} />
            </Field>
          ))}
          <Field label="Mã giao hàng (điểm giao đầu tiên)" required help="Mặc định trùng mã khách. Thêm điểm giao khác ở Khách hàng / NCC">
            <input value={f.shipCode} onChange={(e) => { setShipTouched(true); set('shipCode')(e); }} style={redIf('shipCode')} />
          </Field>
          <Field label="Địa chỉ giao hàng" required full><textarea rows={2} value={f.shipAddress} onChange={set('shipAddress')} style={redIf('shipAddress')} /></Field>
          <Field label="Ghi chú" full><textarea rows={2} value={f.note} onChange={set('note')} /></Field>
        </div>
        {dup.taxHit.length > 0 && (
          <div className="error-box">
            Mã số thuế này đã có trong danh mục:
            {dup.taxHit.map((r) => (
              <div key={r.code} style={{ marginTop: 4 }}>
                <b>{r.code}</b> – {r.name} {r.status === 'inactive' ? '(ngừng sử dụng)' : ''}{' '}
                <button type="button" className="btn sm" disabled={busy} onClick={() => link(r)}>Gắn khách này vào mã {r.code}</button>
              </div>
            ))}
          </div>
        )}
        {dup.nameHits.length > 0 && (
          <div className="error-box" style={{ background: '#fff8e6', borderColor: 'var(--amber)', color: 'inherit' }}>
            ⚠ Tên gần giống khách đã có: {dup.nameHits.slice(0, 8).map((r) => `${r.code} – ${r.name}${r.taxCode ? ` (MST ${r.taxCode})` : ''}`).join(' · ')}
            {dup.nameHits.length > 8 && ` … (+${dup.nameHits.length - 8})`}
            <div style={{ marginTop: 6 }}>
              <label><input type="checkbox" checked={okName} onChange={(e) => setOkName(e.target.checked)} /> Đã kiểm tra, không trùng</label>
              {dup.nameHits.slice(0, 3).map((r) => <button key={r.code} type="button" className="btn sm" style={{ marginLeft: 6 }} disabled={busy} onClick={() => link(r)}>Là mã {r.code}</button>)}
            </div>
          </div>
        )}
        {err && <div className="error-box">{err}</div>}
        <div className="form-actions">
          <span className="small grow" style={{ flex: 1 }}>{miss.length ? `Còn thiếu ${miss.length} ô bắt buộc` : 'Đủ thông tin'}</span>
          <button type="button" className="btn" onClick={() => onClose('')}>Hủy</button>
          <button className="btn primary" disabled={busy}>Tạo mã khách hàng</button>
        </div>
      </form>
    </Modal>
  );
}
