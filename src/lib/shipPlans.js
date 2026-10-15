import { useMemo } from 'react';
import { collection, doc, getDocs, query, runTransaction, setDoc, updateDoc, where } from 'firebase/firestore';
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
const r3 = (x) => Math.round(x * 1000) / 1000;
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

// Lập nhiều dự kiến liền nhau (1 xe nhiều SO): không để trùng số theo thời gian
let lastT = 0;
export async function createPlan(p, user) {
  lastT = Math.max(Date.now(), lastT + 1);
  const id = `DK${lastT.toString(36).toUpperCase()}`;
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
      return add > 0 ? { ...l, doneKg: r3(n(l.doneKg) + add), byMove: { ...(l.byMove || {}), [mv.id]: r3(n(l.byMove?.[mv.id]) + add) } } : l;
    });
    const done = lines.every((l) => planLeft(l) <= Math.max(1, n(l.qtyKg) * 0.005));
    tx.update(ref, {
      lines, status: done ? 'done' : 'partial', movementIds: [...new Set([...(p.movementIds || []), mv.id])],
      ...(done ? { doneAt: nowISO() } : {}), updatedAt: nowISO(), updatedBy: user.email,
    });
  });
}

// Hủy phiếu xuất lập từ dự kiến: trả lại số đã xuất cho dòng dự kiến, dự kiến mở lại để lập phiếu khác
export async function revertMovementFromPlan(planId, mv, user) {
  const ref = doc(db, 'shipPlans', planId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const p = snap.data();
    if (p.status === 'cancelled' || !(p.movementIds || []).includes(mv.id)) return;
    const byLine = {};
    for (const l of mv.lines || []) if (l.orderLine != null) byLine[l.orderLine] = (byLine[l.orderLine] || 0) + Math.abs(n(l.kg));
    const lines = (p.lines || []).map((l) => {
      // Số đã ghi theo đúng phiếu này (nếu có), không thì trừ theo dòng phiếu
      const sub = l.byMove ? Math.min(n(l.byMove[mv.id]), n(l.doneKg)) : Math.min(byLine[l.orderLine] || 0, n(l.doneKg));
      if (sub > 0) byLine[l.orderLine] -= sub;
      if (!(sub > 0)) return l;
      const { [mv.id]: _gone, ...rest } = l.byMove || {};
      return { ...l, doneKg: r3(n(l.doneKg) - sub), byMove: rest };
    });
    const any = lines.some((l) => n(l.doneKg) > 0.001);
    tx.update(ref, { lines, status: any ? 'partial' : 'open', movementIds: (p.movementIds || []).filter((x) => x !== mv.id), doneAt: null,
      updatedAt: nowISO(), updatedBy: user.email });
  });
}

// Phiếu xuất theo SO lập không qua dự kiến (lập thẳng từ SO, theo chuyến xe…): trừ dần vào các dự kiến còn mở của SO đó
// (cùng mã giao trước, rồi ngày dự kiến sớm trước) để dự kiến không còn treo "Chờ lập phiếu" khi hàng đã xuất
export async function applyMovementToOrderPlans(orderId, mv, user) {
  if (!orderId || !String(orderId).startsWith('SO')) return [];
  const snap = await getDocs(query(collection(db, 'shipPlans'), where('orderId', '==', orderId)));
  const plans = snap.docs.map((d) => ({ ...d.data(), id: d.id })).filter((p) => OPEN_PLAN.includes(p.status) && !(p.movementIds || []).includes(mv.id))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id.localeCompare(b.id));
  if (!plans.length) return [];
  const rem = {};
  for (const l of mv.lines || []) if (l.orderLine != null) rem[l.orderLine] = (rem[l.orderLine] || 0) + Math.abs(n(l.kg));
  const take = {}; // planId → { idx: kg }
  for (const sameShip of [true, false]) {
    for (const p of plans) {
      (p.lines || []).forEach((l, i) => {
        if (sameShip !== ((l.shipCode || '') === (mv.shipCode || ''))) return;
        const got = take[p.id]?.[i] || 0;
        const add = Math.min(rem[l.orderLine] || 0, planLeft(l) - got);
        if (add > 0.0005) { rem[l.orderLine] -= add; (take[p.id] ||= {})[i] = got + add; }
      });
    }
  }
  const done = [];
  for (const p of plans) {
    const t = take[p.id];
    if (!t) continue;
    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'shipPlans', p.id);
      const s = await tx.get(ref);
      if (!s.exists()) return;
      const cur = s.data();
      const lines = (cur.lines || []).map((l, i) => (t[i] ? { ...l, doneKg: r3(n(l.doneKg) + Math.min(t[i], planLeft(l))), byMove: { ...(l.byMove || {}), [mv.id]: r3(Math.min(t[i], planLeft(l))) } } : l));
      const all = lines.every((l) => planLeft(l) <= Math.max(1, n(l.qtyKg) * 0.005));
      tx.update(ref, { lines, status: all ? 'done' : 'partial', movementIds: [...new Set([...(cur.movementIds || []), mv.id])],
        ...(all ? { doneAt: nowISO() } : {}), updatedAt: nowISO(), updatedBy: user.email });
    });
    done.push(p.id);
  }
  return done;
}

// Hủy / sửa phiếu xuất: trả lại số đã trừ ở mọi dự kiến có ghi phiếu này
export async function revertMovementFromOrderPlans(orderId, mv, user) {
  if (!orderId || !String(orderId).startsWith('SO')) return;
  const snap = await getDocs(query(collection(db, 'shipPlans'), where('orderId', '==', orderId)));
  for (const d of snap.docs) if ((d.data().movementIds || []).includes(mv.id)) await revertMovementFromPlan(d.id, mv, user);
}
