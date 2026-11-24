import { collection, deleteDoc, doc, query, serverTimestamp, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { useShared } from './live';
import { useMemo } from 'react';
import { norm, today } from './utils';

// ============================================================================
// Thư mục Sale control (gộp từ app Sale control):
//  • prospects/{id}: khách đang tiếp cận, sale tự nhập, chưa có mã. Bấm "Tạo mã khách hàng" → khách có mã thật
//    trong danh mục Khách hàng / NCC (partners + soldto + shipto) bên kho, prospect ghi status 'converted', convertedCode.
//  • activities/{id}: hoạt động chăm sóc (gọi, gặp, gửi mẫu…), gắn prospectId (khách đang tiếp cận) hoặc partyCode (khách đã có mã).
//    Hoạt động của khách đang tiếp cận vẫn thuộc về khách sau khi tạo mã (tra qua convertedCode, không phải sửa lại hoạt động).
// Quyền xem: sale chỉ thấy bản ghi owner == mình; sale quản lý (Kinh doanh xem đơn của mọi sale), quản trị, kế toán thấy tất cả.
// ============================================================================

export const PROSPECT_STATUS = {
  open: { label: 'Đang tiếp cận', tone: 'blue' },
  converted: { label: 'Đã tạo mã', tone: 'green' },
  dropped: { label: 'Ngừng theo dõi', tone: 'red' },
};

// Thông tin cần có để tạo mã khách hàng: cột "% đủ thông tin" và lọc "thiếu thông tin"
export const CODE_NEEDS = [['name', 'Tên'], ['taxCode', 'MST'], ['address', 'Địa chỉ'], ['contact', 'Người liên hệ'], ['phone', 'Điện thoại'], ['plasticType', 'Loại hạt']];
export const missingInfo = (p) => CODE_NEEDS.filter(([k]) => !String(p[k] ?? '').trim()).map(([, l]) => l);
export const completeness = (p) => Math.round(((CODE_NEEDS.length - missingInfo(p).length) / CODE_NEEDS.length) * 100);

const rowsOf = (st) => (st.snap ? st.snap.docs.map((d) => ({ ...d.data(), id: d.id })) : []);

// Bản ghi sale của mình (sale thường) hoặc của mọi người (sale quản lý, quản trị, kế toán)
function useOwned(coll, enabled) {
  const { salesOnly, email } = useApp();
  const st = useShared(enabled ? `${coll}|${salesOnly ? email : '*'}` : '', () =>
    (salesOnly ? query(collection(db, coll), where('owner', '==', email || '-')) : collection(db, coll)));
  return useMemo(() => ({ rows: rowsOf(st), loading: st.loading, error: st.error }), [st]);
}
export const useProspects = (enabled = true) => useOwned('prospects', enabled);
export const useActivities = (enabled = true) => useOwned('activities', enabled);

const stamp = (user, isNew) => ({ updatedAt: serverTimestamp(), updatedBy: user.email, ...(isNew ? { createdAt: serverTimestamp(), createdBy: user.email } : {}) });

export async function saveProspect(id, data, user) {
  const b = writeBatch(db);
  const ref = id ? doc(db, 'prospects', id) : doc(collection(db, 'prospects'));
  b.set(ref, { status: 'open', ...data, owner: String(data.owner || user.email).toLowerCase(), ...stamp(user, !id) }, { merge: true });
  await b.commit();
  return ref.id;
}
export const setProspectStatus = (id, status, user) => updateDoc(doc(db, 'prospects', id), { status, ...stamp(user, false) });

export async function saveActivity(id, data, user) {
  const b = writeBatch(db);
  const ref = id ? doc(db, 'activities', id) : doc(collection(db, 'activities'));
  b.set(ref, { ...data, owner: String(data.owner || user.email).toLowerCase(), ownerName: data.ownerName || user.name || user.email, ...stamp(user, !id) }, { merge: true });
  await b.commit();
  return ref.id;
}
export const removeActivity = (id) => deleteDoc(doc(db, 'activities', id));

// Khóa khách của 1 hoạt động: 'C:<mã>' (khách có mã) hoặc 'P:<id>' (khách đang tiếp cận); prospect đã tạo mã → 'C:<mã>'
export const custKey = (a, prospectMap) => {
  if (a.partyCode) return `C:${a.partyCode}`;
  const p = prospectMap?.get(a.prospectId);
  return p?.convertedCode ? `C:${p.convertedCode}` : `P:${a.prospectId}`;
};

// Lần liên hệ gần nhất + lịch hẹn của từng khách.
// Hẹn: lịch hẹn sớm nhất từ hôm nay trở đi; không có thì hẹn đã qua mà sau đó chưa liên hệ lại (quá hẹn)
export function contactMap(acts, prospectMap) {
  const m = new Map();
  for (const a of acts) {
    const k = custKey(a, prospectMap);
    if (!m.has(k)) m.set(k, { last: null, next: null, count: 0, list: [] });
    const x = m.get(k);
    x.count++; x.list.push(a);
    if (!x.last || String(a.date || '') > String(x.last.date || '')) x.last = a;
  }
  const t = today();
  for (const x of m.values()) {
    const withNext = x.list.filter((a) => a.nextDate);
    const up = withNext.filter((a) => a.nextDate >= t).sort((a, b) => a.nextDate.localeCompare(b.nextDate))[0];
    const past = withNext.filter((a) => a.nextDate < t && !x.list.some((b) => b !== a && String(b.date || '') >= a.nextDate))
      .sort((a, b) => b.nextDate.localeCompare(a.nextDate))[0];
    x.next = up || past || null;
    delete x.list;
  }
  return m;
}
export const daysSince = (ymd) => (ymd ? Math.round((new Date(today()) - new Date(ymd)) / 86400000) : null);

// Lọc theo tình trạng liên hệ (như Sale control)
export const CONTACT_FILTERS = [
  ['', 'Tình trạng liên hệ: tất cả'],
  ['never', 'Chưa liên hệ lần nào'],
  ['7', 'Quá 7 ngày chưa liên hệ'],
  ['30', 'Quá 30 ngày chưa liên hệ'],
  ['due', 'Có hẹn đến hạn / quá hạn'],
  ['week', 'Đã liên hệ trong 7 ngày'],
];
export function matchContact(info, f) {
  if (!f) return true;
  const d = info?.last ? daysSince(info.last.date) : null;
  if (f === 'never') return !info?.last;
  if (f === '7') return d == null || d > 7;
  if (f === '30') return d == null || d > 30;
  if (f === 'week') return d != null && d <= 7;
  if (f === 'due') return !!info?.next && info.next.nextDate <= today();
  return true;
}

// ---------- Tạo mã khách hàng: kiểm tra trùng ----------
const digits = (s) => norm(s).replace(/[^0-9a-z]/g, '');
// Bỏ chữ chung chung trong tên công ty để so tên
const NAME_NOISE = /\b(cong ty|cty|tnhh|co phan|cp|mtv|mot thanh vien|trach nhiem huu han|thuong mai|dich vu|san xuat|tm|dv|sx|xnk|xuat nhap khau|viet nam|vn|jsc|co|ltd|company|limited)\b/g;
export const nameKey = (s) => norm(s).replace(NAME_NOISE, ' ').replace(/[^0-9a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// rows: mọi đối tác (gộp partners + soldto + NCC, không lọc theo sale) → { taxHit, nameHits }
export function findDuplicates(rows, { taxCode, name }, skipCode = '') {
  const tk = digits(taxCode);
  const nk = nameKey(name);
  const taxHit = tk.length >= 6 ? rows.filter((r) => r.code !== skipCode && digits(r.taxCode) === tk) : [];
  const nameHits = nk.length >= 3 ? rows.filter((r) => r.code !== skipCode && !taxHit.includes(r) && (() => {
    const rk = nameKey(r.name);
    return rk && (rk === nk || (rk.length >= 5 && nk.length >= 5 && (rk.includes(nk) || nk.includes(rk))));
  })()) : [];
  return { taxHit, nameHits };
}
// Mã số thuế VN: 10 số, hoặc 10 số + "-" + 3 số (chi nhánh)
export const badTaxCode = (s) => !!String(s || '').trim() && !/^\d{10}(-?\d{3})?$/.test(String(s).replace(/\s/g, ''));

// Ghi khi tạo mã: prospect đã chuyển sang khách có mã (gọi trong batch của savePartner)
export function convertWrites(batch, prospect, code, user, shipto) {
  if (shipto?.shipCode) batch.set(doc(db, 'shipto', shipto.shipCode), { ...shipto, ...stamp(user, true) }, { merge: true });
  if (prospect?.id) batch.set(doc(db, 'prospects', prospect.id), { status: 'converted', convertedCode: code, convertedAt: serverTimestamp(), convertedBy: user.email, ...stamp(user, false) }, { merge: true });
}
// Khách đang tiếp cận thực ra đã có mã (trùng MST): gắn vào mã có sẵn, không tạo mã mới
export const linkProspect = (prospect, code, user) => updateDoc(doc(db, 'prospects', prospect.id), {
  status: 'converted', convertedCode: code, linkedExisting: true, convertedAt: serverTimestamp(), convertedBy: user.email, ...stamp(user, false),
});
