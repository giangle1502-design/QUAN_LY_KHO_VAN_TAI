import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { norm } from './utils';

// ============================================================================
// Đối tác (BP): mỗi công ty 1 mã, vừa có thể là khách hàng vừa là nhà cung cấp.
// partners/{mã} là hồ sơ chung. Soldto (khách hàng) và suppliers (NCC) giữ nguyên làm nơi SO / PO / phiếu kho đọc:
//  • lưu đối tác → ghi phần chung sang soldto / suppliers cùng mã (tích vai trò nào thì bật danh mục đó, bỏ tích → "ngừng giao dịch", không xóa)
//  • lưu ở trang Soldto / Nhà cung cấp cũ → cập nhật ngược hồ sơ đối tác (syncFromCatalog)
// Mã chưa có hồ sơ đối tác vẫn hiện (gộp từ Soldto + NCC theo mã), bấm Lưu hoặc "Tạo hồ sơ" là có.
// ============================================================================

export const PARTNER_TYPES = [
  ['', 'Tất cả'],
  ['anyCustomer', 'Mọi khách hàng (kể cả vừa là NCC)'],
  ['anyVendor', 'Mọi nhà cung cấp (kể cả vừa là KH)'],
  ['customer', 'Chỉ khách hàng'],
  ['vendor', 'Chỉ nhà cung cấp'],
  ['both', 'Vừa KH vừa NCC'],
];
export const PARTNER_STATUS = [['', 'Tất cả'], ['active', 'Sử dụng'], ['inactive', 'Ngừng sử dụng']];

export const roleText = (p) => (p.isCustomer && p.isVendor ? 'KH + NCC' : p.isCustomer ? 'Khách hàng' : p.isVendor ? 'Nhà cung cấp' : 'Chưa chọn vai trò');
export const matchType = (p, t) => !t || (t === 'anyCustomer' ? !!p.isCustomer : t === 'anyVendor' ? !!p.isVendor : t === 'customer' ? p.isCustomer && !p.isVendor : t === 'vendor' ? p.isVendor && !p.isCustomer : !!(p.isCustomer && p.isVendor));

// Trường chung giữa hồ sơ đối tác và từng danh mục cũ: [trường đối tác, trường soldto / suppliers]
const COMMON = {
  soldto: [['code', 'code'], ['name', 'name'], ['taxCode', 'taxCode'], ['billingAddress', 'taxAddress'], ['phone', 'phone'], ['email', 'email']],
  suppliers: [['code', 'code'], ['name', 'name'], ['taxCode', 'taxCode'], ['billingAddress', 'address'], ['phone', 'phone'], ['email', 'email']],
};
// Trường chỉ thuộc vai trò (sale phụ trách, pháp nhân hóa đơn / loại NCC, quốc gia…): sửa ở thẻ Khách hàng / Nhà cung cấp của hồ sơ
export const roleOnlyFields = (catKey, fields) => {
  const skip = new Set([...COMMON[catKey].map(([, k]) => k), 'active']);
  return fields.filter((f) => !skip.has(f.key) && !f.hidden && !f.computed && !f.system);
};

const fromRole = (catKey, r) => {
  const o = {};
  COMMON[catKey].forEach(([pk, rk]) => { if (r[rk] !== undefined && r[rk] !== '') o[pk] = r[rk]; });
  return o;
};
const toRole = (catKey, p) => {
  const o = {};
  COMMON[catKey].forEach(([pk, rk]) => { o[rk] = p[pk] ?? ''; });
  return o;
};

// Gộp hồ sơ đối tác với Soldto + NCC theo mã → danh sách hiển thị (có _soldto, _supplier để sửa thẻ vai trò)
export function mergePartners(partners, soldto, suppliers) {
  const P = new Map(partners.map((p) => [p._id, p]));
  const S = new Map(soldto.map((s) => [s._id, s]));
  const V = new Map(suppliers.map((s) => [s._id, s]));
  const codes = new Set([...P.keys(), ...S.keys(), ...V.keys()]);
  const out = [];
  for (const code of codes) {
    const p = P.get(code); const s = S.get(code); const v = V.get(code);
    const base = p ? { ...p } : {
      ...(v ? fromRole('suppliers', v) : {}), ...(s ? fromRole('soldto', s) : {}),
      _id: code, code, _virtual: true,
      isCustomer: !!s && s.active !== false, isVendor: !!v && v.active !== false,
      status: (s && s.active !== false) || (v && v.active !== false) ? 'active' : 'inactive',
    };
    // Hồ sơ tạo từ 1 phía (vd. lưu ở trang Soldto) chưa ghi vai trò kia: lấy theo danh mục cũ
    if (p && p.isCustomer == null) base.isCustomer = !!s && s.active !== false;
    if (p && p.isVendor == null) base.isVendor = !!v && v.active !== false;
    out.push({ ...base, code: base.code || code, _soldto: s || null, _supplier: v || null });
  }
  return out;
}

// Các mã khác nhau nhưng trùng mã số thuế (thường là 1 công ty được tạo 2 lần: 1 mã KH, 1 mã NCC)
export function dupTaxGroups(rows) {
  const by = new Map();
  rows.forEach((r) => {
    const k = norm(r.taxCode).replace(/[^0-9a-z]/g, '');
    if (k.length < 6 || r.status === 'inactive') return;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  });
  return [...by.values()].filter((g) => g.length > 1);
}

const stamp = (user, isNew) => ({ updatedAt: serverTimestamp(), updatedBy: user.email, ...(isNew ? { createdAt: serverTimestamp(), createdBy: user.email } : {}) });

// Lưu hồ sơ đối tác + đồng bộ Soldto / NCC cùng mã trong 1 lần ghi
// p: hồ sơ (trường đối tác + trường tự thêm); roleData: { soldto: {...}, suppliers: {...} } trường riêng của vai trò
// prev: dòng đang sửa (có _soldto, _supplier, _virtual) hoặc null khi thêm mới
export async function savePartner(p, roleData, prev, user) {
  const batch = writeBatch(db);
  const code = partnerWrites(batch, p, roleData, prev, user);
  await batch.commit();
  return code;
}
function partnerWrites(batch, p, roleData, prev, user) {
  const code = String(p.code || '').trim();
  if (!code) throw new Error('Thiếu mã đối tác.');
  const active = p.status !== 'inactive';
  const clean = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_')));
  batch.set(doc(db, 'partners', code), { ...clean, code, isCustomer: !!p.isCustomer, isVendor: !!p.isVendor, ...stamp(user, !prev || prev._virtual) }, { merge: true });
  const role = (catKey, on, cur) => {
    if (on) batch.set(doc(db, catKey, code), { ...(roleData?.[catKey] || {}), ...toRole(catKey, { ...clean, code }), active, ...stamp(user, !cur) }, { merge: true });
    // Bỏ vai trò: không xóa (SO / PO cũ vẫn trỏ tới), chỉ ngừng giao dịch
    else if (cur && cur.active !== false) batch.set(doc(db, catKey, code), { active: false, ...stamp(user, false) }, { merge: true });
  };
  role('soldto', !!p.isCustomer, prev?._soldto);
  role('suppliers', !!p.isVendor, prev?._supplier);
  return code;
}
// Nhập Excel danh mục Đối tác: đồng bộ sang Soldto / NCC cho các mã vừa nhập. list: [{ id, data }], current: mergePartners hiện có
export async function syncPartnersToRoles(list, current, user) {
  const byCode = new Map(current.map((r) => [r.code, r]));
  for (let i = 0; i < list.length; i += 120) {
    const batch = writeBatch(db);
    list.slice(i, i + 120).forEach(({ id, data }) => {
      const prev = byCode.get(id) || null;
      partnerWrites(batch, { ...(prev || {}), ...data, code: id }, {}, prev, user);
    });
    await batch.commit();
  }
}

// Thêm nhanh 1 vai trò cho mã đã có (NCC → cũng là khách hàng, hoặc ngược lại), giữ nguyên mã và lịch sử
export async function addRole(row, role, user) {
  const p = { ...row, ...(role === 'customer' ? { isCustomer: true } : { isVendor: true }), status: 'active' };
  return savePartner(p, {}, row, user);
}

// Gộp các mã trùng mã số thuế vào 1 mã giữ lại: mã giữ lại nhận đủ vai trò; mã kia ngừng sử dụng (SO / PO cũ không đổi)
export async function mergeInto(keep, others, user) {
  const roleData = {};
  const p = { ...keep, status: 'active' };
  for (const o of others) {
    if (o.isCustomer) { p.isCustomer = true; if (!keep._soldto && o._soldto) roleData.soldto = stripMeta(o._soldto); }
    if (o.isVendor) { p.isVendor = true; if (!keep._supplier && o._supplier) roleData.suppliers = stripMeta(o._supplier); }
  }
  await savePartner(p, roleData, keep, user);
  for (const o of others) {
    await savePartner({ ...o, status: 'inactive', mergedInto: keep.code, note: [o.note, `Đã gộp vào mã ${keep.code}`].filter(Boolean).join(' · ') }, {}, o, user);
  }
}
const stripMeta = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_') && !['code', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'active'].includes(k)));

// Tạo hồ sơ đối tác cho mọi mã Soldto / NCC chưa có (không đổi Soldto / NCC)
export async function createMissingPartners(rows, user) {
  const list = rows.filter((r) => r._virtual);
  for (let i = 0; i < list.length; i += 400) {
    const batch = writeBatch(db);
    list.slice(i, i + 400).forEach((r) => {
      const clean = Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));
      batch.set(doc(db, 'partners', r.code), { ...clean, ...stamp(user, true), migratedAt: new Date().toISOString() }, { merge: true });
    });
    await batch.commit();
  }
  return list.length;
}

// Lưu ở trang Soldto / Nhà cung cấp (hoặc nhập Excel, thêm nhanh +) → cập nhật hồ sơ đối tác cùng mã.
// Không chặn việc lưu chính nếu lỗi (vd. chưa dán quy tắc Firestore cho partners)
export async function syncFromCatalog(catKey, items, user) {
  if (!COMMON[catKey] || !items.length) return;
  try {
    for (let i = 0; i < items.length; i += 400) {
      const batch = writeBatch(db);
      items.slice(i, i + 400).forEach(({ id, data }) => {
        const on = data.active !== false;
        batch.set(doc(db, 'partners', id), {
          ...fromRole(catKey, { ...data, code: id }), code: id,
          [catKey === 'soldto' ? 'isCustomer' : 'isVendor']: on,
          ...(on ? { status: 'active' } : {}),
          updatedAt: serverTimestamp(), updatedBy: user.email,
        }, { merge: true });
      });
      await batch.commit();
    }
  } catch (e) {
    console.warn('Chưa đồng bộ được hồ sơ đối tác', e);
  }
}
