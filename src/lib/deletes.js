import { collection, deleteDoc, doc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
const nowISO = () => new Date().toISOString();

// Xóa dữ liệu: quản trị gốc xóa ngay (có ghi lịch sử); người khác chỉ gửi yêu cầu xóa,
// quản trị gốc xem lại ở "Duyệt xóa" rồi mới xóa hẳn.
export const COLL_LABEL = {
  trips: 'Chuyến xe', orders: 'Đơn hàng', movements: 'Phiếu kho', stock: 'Tồn kho', releaseRequests: 'Đề nghị giải chấp',
  counters: 'Bộ đếm số', deleteRequests: 'Lịch sử xóa',
};

// Bỏ các giá trị Firestore không lưu lại được trong bản chụp (hàm, undefined)
const snap = (data) => JSON.parse(JSON.stringify(data || {}, (k, v) => (v && typeof v === 'object' && typeof v.toDate === 'function' ? v.toDate().toISOString() : v)));

export async function deleteOrRequest({ coll, id, label, data, reason = '' }, user, isSuper) {
  const ref = doc(collection(db, 'deleteRequests'));
  const base = { id: ref.id, coll, docId: id, label: label || id, data: snap(data), reason,
    requestedBy: user.email, requestedByName: user.name || user.email, requestedAt: nowISO(), createdAt: serverTimestamp() };
  if (isSuper) {
    await deleteDoc(doc(db, coll, id));
    await setDoc(ref, { ...base, status: 'deleted', decidedBy: user.email, decidedByName: user.name || user.email, decidedAt: nowISO() });
    return 'deleted';
  }
  await setDoc(ref, { ...base, status: 'pending' });
  return 'requested';
}

export async function approveDelete(req, user) {
  await deleteDoc(doc(db, req.coll, req.docId));
  await updateDoc(doc(db, 'deleteRequests', req.id), { status: 'approved', decidedBy: user.email, decidedByName: user.name || user.email, decidedAt: nowISO() });
}
export async function rejectDelete(req, user, note) {
  await updateDoc(doc(db, 'deleteRequests', req.id), { status: 'rejected', note: note || '', decidedBy: user.email, decidedByName: user.name || user.email, decidedAt: nowISO() });
}

// Xóa toàn bộ 1 collection (theo lô 400 bản ghi). Trả về số bản ghi đã xóa.
export async function wipeCollection(coll, onProgress) {
  const s = await getDocs(collection(db, coll));
  let n = 0;
  for (let i = 0; i < s.docs.length; i += 400) {
    const b = writeBatch(db);
    s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
    n += Math.min(400, s.docs.length - i);
    onProgress?.(coll, n, s.docs.length);
  }
  return n;
}

// Vị trí: giữ danh mục, đưa số pallet đang chứa về 0
export async function resetLocations() {
  const s = await getDocs(collection(db, 'locations'));
  let n = 0;
  for (let i = 0; i < s.docs.length; i += 400) {
    const b = writeBatch(db);
    s.docs.slice(i, i + 400).forEach((d) => b.update(d.ref, { currentPallets: 0, usedPct: 0, emptyBin: true, lastMovement: '', updatedAt: nowISO() }));
    await b.commit(); n += Math.min(400, s.docs.length - i);
  }
  return n;
}
// Quy tắc mã tự sinh: đưa "Số tiếp theo" về 1
export async function resetCodeRules() {
  const s = await getDocs(collection(db, 'codeRules'));
  const b = writeBatch(db);
  s.docs.forEach((d) => b.update(d.ref, { next: 1 }));
  await b.commit();
  return s.size;
}

export const myRequests = (email) => query(collection(db, 'deleteRequests'), where('requestedBy', '==', email));
