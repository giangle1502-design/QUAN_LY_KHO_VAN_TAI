import { useMemo } from 'react';
import { collection, doc, query, runTransaction, setDoc, updateDoc, where } from 'firebase/firestore';
import { useShared } from './live';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';

// Dự kiến xuất kho: Sale lập từ SO của mình (số lượng cần xuất + mã giao từng dòng, không chọn kho);
// quản trị kho / thủ kho căn cứ vào đó lập phiếu xuất kho. Phiếu xuất ghi planId, cộng doneKg vào dòng dự kiến.
export const PLAN_STATUS = {
  open: { label: 'Chờ lập phiếu', tone: 'amber' },
  partial: { label: 'Đã xuất một phần', tone: 'blue' },
  done: { label: 'Đã lập phiếu xuất', tone: 'green' },
  cancelled: { label: 'Đã hủy', tone: 'gray' },
};
export const OPEN_PLAN = ['open', 'partial'];

const n = (v) => Number(v) || 0;
const nowISO = () => new Date().toISOString();
export const planLeft = (l) => Math.max(0, n(l.qtyKg) - n(l.doneKg));

export function usePlans() {
  const { salesOnly, email } = useApp();
  const st = useShared(`plans|${salesOnly ? email : ''}`, () => (salesOnly ? query(collection(db, 'shipPlans'), where('sales', '==', email || '-')) : collection(db, 'shipPlans')));
  return useMemo(() => ({ rows: st.snap ? st.snap.docs.map((d) => ({ ...d.data(), id: d.id })) : [], loading: st.loading, error: st.error }), [st]);
}

// Phần dòng SO đã nằm trong các dự kiến còn mở (chưa lập phiếu): { orderId: { dòng: kg } }
export function plannedByLine(plans, exceptId) {
  const m = {};
  for (const p of plans) {
    if (p.id === exceptId || !OPEN_PLAN.includes(p.status)) continue;
    for (const l of p.lines || []) {
      const o = (m[p.orderId] ||= {});
      o[l.orderLine] = (o[l.orderLine] || 0) + planLeft(l);
    }
  }
  return m;
}

export async function createPlan(p, user) {
  const id = `DK${Date.now().toString(36).toUpperCase()}`;
  const at = nowISO();
  await setDoc(doc(db, 'shipPlans', id), {
    ...p, id, status: 'open', lines: p.lines.map((l) => ({ ...l, doneKg: 0 })), movementIds: [],
    createdAt: at, createdBy: user.email, createdByName: user.name || '', updatedAt: at, updatedBy: user.email,
  });
  return id;
}

export const updatePlan = (id, patch, user) => updateDoc(doc(db, 'shipPlans', id), { ...patch, updatedAt: nowISO(), updatedBy: user.email });

// Sau khi lưu phiếu xuất lập từ dự kiến: cộng số đã xuất vào dòng dự kiến (theo dòng SO), đủ thì đánh dấu xong
export async function applyMovementToPlan(planId, mv, user) {
  const ref = doc(db, 'shipPlans', planId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const p = snap.data();
    const byLine = {};
    for (const l of mv.lines || []) if (l.orderLine != null) byLine[l.orderLine] = (byLine[l.orderLine] || 0) + Math.abs(n(l.kg));
    const lines = (p.lines || []).map((l) => {
      const add = Math.min(byLine[l.orderLine] || 0, planLeft(l));
      if (add > 0) byLine[l.orderLine] -= add;
      return add > 0 ? { ...l, doneKg: Math.round((n(l.doneKg) + add) * 1000) / 1000 } : l;
    });
    const done = lines.every((l) => planLeft(l) <= Math.max(1, n(l.qtyKg) * 0.005));
    tx.update(ref, {
      lines, status: done ? 'done' : 'partial', movementIds: [...new Set([...(p.movementIds || []), mv.id])],
      ...(done ? { doneAt: nowISO() } : {}), updatedAt: nowISO(), updatedBy: user.email,
    });
  });
}
