import {
  collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import { CATALOGS } from '../catalogs';
import { PLASTIC_TYPES } from './plasticSales';

// ============================================================================
// Đổi email đăng nhập của người dùng (Phân quyền), giữ nguyên vai trò, quyền và dữ liệu đang phụ trách.
// Hồ sơ users có mã = email, nên đổi email = tạo hồ sơ mới (giữ mọi trường, ghi oldEmails) rồi chuyển các liên kết:
//  - Đơn SO/PO/DRT/RTV (sales), dự kiến xuất kho, giá trị trường bảo mật (orderSecrets: sales, viewers)
//  - Sale phụ trách khách hàng (Nguyên sinh / Tái sinh) ở Khách hàng và Đối tác, trường liên kết tới Phân quyền
//  - Sale control: khách đang tiếp cận, hoạt động (owner)
//  - Nhóm trò chuyện, người được xem trường (Quản lý trường), cấu hình tin nhắn hệ thống
// Trò chuyện riêng, hộp thông báo, cài đặt hiển thị: người dùng tự chuyển khi đăng nhập bằng email mới (migrateMyOldEmails).
// Chạy lại được: nếu lần trước dừng giữa chừng, bấm đổi lại cùng email mới sẽ làm tiếp.
// ============================================================================
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const low = (v) => String(v || '').trim().toLowerCase();

// Ghi theo lô (Firestore tối đa 500 thao tác / lô)
async function updateAll(snapDocs, patchOf) {
  let n = 0;
  for (let i = 0; i < snapDocs.length; i += 400) {
    const b = writeBatch(db);
    snapDocs.slice(i, i + 400).forEach((d) => { const p = patchOf(d.data()); if (p) { b.update(d.ref, p); n += 1; } });
    await b.commit();
  }
  return n;
}
const swap = (list, from, to) => [...new Set((list || []).map((x) => (x === from ? to : x)))];
// Thay đúng chuỗi email cũ ở mọi chỗ trong một cấu hình (mảng người xem, danh sách người nhận…)
function deepSwap(v, from, to) {
  if (Array.isArray(v)) return [...new Set(v.map((x) => deepSwap(x, from, to)))];
  if (v && typeof v === 'object' && !(v.toDate instanceof Function)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k === from ? to : k, deepSwap(x, from, to)]));
  return v === from ? to : v;
}

// Các nơi lưu email người dùng, kèm cách cập nhật
function targets(from, to) {
  const eq = (coll, key) => ({ label: `${coll}.${key}`, q: query(collection(db, coll), where(key, '==', from)), patch: () => ({ [key]: to }) });
  const list = [
    eq('orders', 'sales'), eq('shipPlans', 'sales'), eq('orderSecrets', 'sales'),
    { label: 'orderSecrets.viewers', q: query(collection(db, 'orderSecrets'), where('viewers', 'array-contains', from)), patch: (d) => ({ viewers: swap(d.viewers, from, to) }) },
    eq('prospects', 'owner'), eq('activities', 'owner'),
    { label: 'chats(group)', q: query(collection(db, 'chats'), where('type', '==', 'group'), where('members', 'array-contains', from)),
      patch: (d) => ({ members: swap(d.members, from, to), ...(d.names ? { names: deepSwap(d.names, from, to) } : {}) }) },
  ];
  // Sale phụ trách khách hàng theo loại hạt nhựa (Khách hàng + Đối tác) và mọi trường danh mục liên kết tới Phân quyền
  const keys = new Set();
  PLASTIC_TYPES.forEach((p) => { keys.add(`soldto|${p.key}`); keys.add(`partners|${p.key}`); });
  CATALOGS.forEach((c) => c.fields.forEach((f) => { if (f.ref === 'users' && f.type === 'ref') keys.add(`${c.key}|${f.key}`); }));
  keys.forEach((k) => { const [c, f] = k.split('|'); list.push(eq(c, f)); });
  return list;
}

export async function renameUser(row, newEmailRaw, by, { isSuper = false, onProgress = () => {} } = {}) {
  const from = low(row._id || row.email);
  const to = low(newEmailRaw);
  if (!EMAIL_RE.test(to)) throw new Error('Email mới không hợp lệ.');
  if (to === from) throw new Error('Email mới trùng email hiện tại.');
  const at = serverTimestamp();

  // 1. Hồ sơ mới: giữ vai trò, kho, quyền…; ghi lại email cũ để người dùng tự chuyển trò chuyện / cài đặt
  const newRef = doc(db, 'users', to);
  const exist = await getDoc(newRef);
  if (exist.exists() && !(exist.data().oldEmails || []).includes(from))
    throw new Error(`Email ${to} đã có trong Phân quyền. Chọn email khác, hoặc xóa / khóa tài khoản kia trước.`);
  const { _id, createdAt, renamedTo, ...data } = row; // eslint-disable-line no-unused-vars
  onProgress('Tạo hồ sơ với email mới…');
  await setDoc(newRef, {
    ...data, email: to, oldEmails: [...new Set([...(row.oldEmails || []), from])],
    renamedAt: at, renamedBy: by.email, createdAt: createdAt || at, updatedAt: at, updatedBy: by.email,
  }, { merge: true });

  // 2. Chuyển dữ liệu đang phụ trách sang email mới
  const done = [];
  for (const t of targets(from, to)) {
    onProgress(`Chuyển dữ liệu: ${t.label}…`);
    try {
      const s = await getDocs(t.q);
      const n = await updateAll(s.docs, t.patch);
      if (n) done.push(`${t.label}: ${n}`);
    } catch (e) {
      // Danh mục chưa có dữ liệu / chưa dán quy tắc mới: báo, không dừng cả quá trình
      done.push(`${t.label}: lỗi ${e.code || e.message}`);
    }
  }
  // Cấu hình: người được xem trường (Quản lý trường), người nhận tin nhắn hệ thống
  for (const id of ['fields', 'chatRules']) {
    onProgress(`Cập nhật cấu hình ${id}…`);
    try {
      const s = await getDoc(doc(db, 'settings', id));
      if (!s.exists()) continue;
      const before = s.data();
      const after = deepSwap(before, from, to);
      if (JSON.stringify(after) !== JSON.stringify(before)) { await setDoc(s.ref, after); done.push(`settings/${id}`); }
    } catch (e) { done.push(`settings/${id}: lỗi ${e.code || e.message}`); }
  }

  // 3. Hồ sơ cũ: quản trị gốc xóa hẳn; quản trị khác khóa lại và ẩn khỏi danh sách (trỏ sang email mới)
  onProgress('Khóa hồ sơ email cũ…');
  const oldRef = doc(db, 'users', from);
  if (isSuper) await deleteDoc(oldRef);
  else await updateDoc(oldRef, { active: false, renamedTo: to, updatedAt: at, updatedBy: by.email });
  return { from, to, done };
}

// Người dùng vừa được đổi email: tự chuyển trò chuyện riêng / hộp thông báo, đã đọc, cài đặt hiển thị từ email cũ
// (quy tắc chỉ cho chính người đó đọc các dữ liệu này). Chạy mỗi lần đăng nhập, không có gì để chuyển thì thôi.
export async function migrateMyOldEmails(email, oldEmails) {
  for (const from of oldEmails || []) {
    if (!from || from === email) continue;
    try {
      const s = await getDocs(query(collection(db, 'chats'), where('members', 'array-contains', from)));
      await updateAll(s.docs, (d) => ({ members: swap(d.members, from, email), ...(d.names ? { names: deepSwap(d.names, from, email) } : {}) }));
    } catch { /* chưa dán quy tắc mới */ }
    for (const coll of ['chatReads', 'userPrefs']) {
      try {
        const old = await getDoc(doc(db, coll, from));
        if (!old.exists()) continue;
        const cur = await getDoc(doc(db, coll, email));
        // Giữ cài đặt đã có ở email mới, chỉ bổ sung phần còn thiếu
        await setDoc(doc(db, coll, email), { ...old.data(), ...(cur.exists() ? cur.data() : {}) });
      } catch { /* bỏ qua */ }
    }
    try {
      // Trình duyệt này: cài đặt lưu theo email cũ → email mới
      Object.keys(localStorage).filter((k) => k.startsWith(`pref:${from}:`)).forEach((k) => {
        const nk = `pref:${email}:${k.slice(`pref:${from}:`.length)}`;
        if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k));
      });
    } catch { /* bỏ qua */ }
  }
}
