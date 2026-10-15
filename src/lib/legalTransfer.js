import { collection, doc, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useShared } from './live';
import { useMemo } from 'react';

// ============================================================================
// Chuyển pháp nhân giữa các công ty cùng chủ (VAP / PLA / DAM).
// Phiếu xuất mang tên công ty xuất (công ty của SO, in trên phiếu giao hàng); mỗi dòng phiếu trừ tồn
// của đúng công ty chủ hàng đã chọn ở bước chọn vị trí xuất. Dòng có công ty tồn ≠ công ty xuất là
// chuyển pháp nhân: hệ thống không tự chuyển đổi, chỉ báo cho kế toán làm trên phần mềm kế toán.
// ============================================================================

export const CO_SHORT_MSG = 'Tồn kho công ty không đủ, bạn vui lòng chọn pháp nhân khác hoặc thực hiện chuyển đổi tồn kho cá nhân';

const n = (v) => Number(v) || 0;

// Công ty cùng chủ (loại "Công ty trong nhóm"); công ty khách gửi hàng không được lấy lẫn
export const groupCodes = (companies) => new Set(companies.filter((c) => c.kind !== 'Công ty khách').map((c) => c.code));

// Các dòng phiếu xuất lấy tồn của công ty khác công ty xuất
export const crossLines = (m) => (m.type === 'out' && m.company
  ? (m.lines || []).filter((l) => l.company && l.company !== m.company) : []);

// Tóm tắt: { PLA: kg, DAM: kg }
export function crossSummary(m) {
  const by = {};
  for (const l of crossLines(m)) by[l.company] = (by[l.company] || 0) + Math.abs(n(l.kg));
  return by;
}

// Thông báo cho kế toán (trong app: chuông 🔔 trên đầu trang). Id = số phiếu để không báo trùng.
export async function notifyLegalTransfer(m, user, extra = {}) {
  const by = crossSummary(m);
  const froms = Object.keys(by);
  if (!froms.length) return;
  const kg = Object.values(by).reduce((a, b) => a + b, 0);
  await setDoc(doc(db, 'notices', `LT-${m.id}`), {
    kind: 'legal_transfer', status: 'open', roles: ['ke_toan', 'admin'],
    movementId: m.id, orderId: m.orderId || '', date: m.date || '', warehouse: m.warehouse || '',
    company: m.company, fromCompanies: froms, byCompany: by, kg: Math.round(kg * 1000) / 1000,
    partyCode: m.partyCode || '', partyName: m.partyName || '',
    lines: crossLines(m).map((l) => ({ item: l.item, itemName: l.itemName || '', lot: l.lot || '', from: l.company, kg: Math.abs(n(l.kg)) })),
    shortWarned: !!extra.shortWarned,
    createdAt: serverTimestamp(), createdBy: user.email, createdByName: user.name || '',
  });
}

// Kế toán đánh dấu đã làm chuyển pháp nhân trên phần mềm kế toán (hoặc mở lại)
export async function setNoticeDone(id, done, user, note = '') {
  await updateDoc(doc(db, 'notices', id), done
    ? { status: 'done', doneBy: user.email, doneByName: user.name || '', doneAt: serverTimestamp(), doneNote: note }
    : { status: 'open', doneBy: '', doneByName: '', doneAt: null, doneNote: '' });
}

// Phiếu cũ chưa có thông báo: kế toán đánh dấu đã xử lý từ báo cáo
export async function markMovementDone(m, user) {
  await notifyLegalTransfer(m, user);
  await setNoticeDone(`LT-${m.id}`, true, user);
}

// Thông báo đang mở (cho chuông) — chung 1 kết nối realtime
export function useOpenNotices(enabled) {
  const st = useShared(enabled ? 'notices|open' : '', () => query(collection(db, 'notices'), where('status', '==', 'open')));
  return useMemo(() => (st.snap ? st.snap.docs.map((d) => ({ ...d.data(), id: d.id })) : [])
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)), [st.snap]);
}

// Mọi thông báo chuyển pháp nhân (báo cáo: biết dòng nào kế toán đã xử lý)
export function useLegalNotices() {
  const st = useShared('notices|lt', () => query(collection(db, 'notices'), where('kind', '==', 'legal_transfer')));
  return useMemo(() => new Map((st.snap ? st.snap.docs : []).map((d) => [d.data().movementId, { ...d.data(), id: d.id }])), [st.snap]);
}
