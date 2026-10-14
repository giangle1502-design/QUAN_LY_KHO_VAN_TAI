import { useEffect, useMemo, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { listenShared, useShared } from './live';
import { applyMovementToPlan, revertMovementFromPlan } from './shipPlans';
import { editMovement } from './stock';

// ============================================================================
// DO (phiếu xuất theo SO / STO) và Danh sách đơn chờ nhập (phiếu nhập theo PO / STO):
// dựng trên phiếu kho sẵn có (movements), không thêm collection. Dùng chung kết nối realtime
// với trang Phiếu kho / nút lập phiếu để không tăng lượt đọc Firestore.
// ============================================================================

// Phiếu kho trong khoảng ngày (chung 1 kết nối cho mọi tab cùng khoảng ngày)
export function useMovesRange(from, to) {
  const st = useShared(`mv|range|${from}|${to}`, () => query(collection(db, 'movements'), where('date', '>=', from || '0000'), where('date', '<=', to || '9999')));
  return useMemo(() => ({ rows: st.snap ? st.snap.docs.map((d) => ({ ...d.data(), id: d.id })) : [], loading: st.loading, error: st.error }), [st]);
}

// Phiếu đang chờ (mọi ngày): nhập chờ thủ kho nhận, xuất chờ giải chấp. Cùng truy vấn với usePendingIn / useWaitingOut
export function useWaitingMoves(type, status) {
  const [rows, setRows] = useState([]);
  useEffect(() => listenShared(`mv|${type}|${status}`, () => query(collection(db, 'movements'), where('type', '==', type), where('status', '==', status)),
    (s) => setRows(s.snap ? s.snap.docs.map((d) => ({ ...d.data(), id: d.data().id || d.id })) : [])), [type, status]);
  return rows;
}

// Gộp phiếu trong khoảng ngày + phiếu đang chờ (kể cả lập trước khoảng ngày)
export function useSlips(type, from, to, waitStatus) {
  const range = useMovesRange(from, to);
  const waiting = useWaitingMoves(type, waitStatus);
  const rows = useMemo(() => {
    const by = new Map();
    for (const m of [...waiting, ...range.rows]) if (m.type === type) by.set(m.id, m);
    return [...by.values()];
  }, [range.rows, waiting, type]);
  return { rows, loading: range.loading, error: range.error };
}

// Loại đơn của phiếu (phiếu cũ chưa ghi orderType: đoán theo tiền tố số đơn)
export const orderTypeOf = (m) => m.orderType || (String(m.orderId || '').match(/^(SO|PO|STO)/) || [])[1] || '';

// Phiếu xuất được lập từ đâu: dự kiến xuất kho, kế hoạch phân bổ (đơn lập từ phân bổ) hay lập trực tiếp
export function doSource(m, order) {
  if (m.planId) return { key: 'plan', label: '📅 Dự kiến xuất', ref: m.planId };
  const nos = new Set((m.lines || []).map((l) => l.orderLine));
  const al = (order?.lines || []).find((l) => nos.has(l.no) && l.allocId);
  if (al) return { key: 'alloc', label: '📋 Kế hoạch phân bổ', ref: al.poId || '' };
  if (m.tripId) return { key: 'trip', label: '🚚 Theo chuyến xe', ref: m.tripId };
  return { key: 'direct', label: '📤 Lập trực tiếp', ref: '' };
}
export const DO_SOURCES = [['plan', '📅 Dự kiến xuất'], ['alloc', '📋 Kế hoạch phân bổ'], ['trip', '🚚 Theo chuyến xe'], ['direct', '📤 Lập trực tiếp']];

// Sửa phiếu rồi cập nhật dự kiến xuất (nếu phiếu lập từ dự kiến): trả số cũ, cộng số mới
export async function saveSlipEdit(m, patch, reason, user) {
  const { old, next } = await editMovement(m.id, patch, reason, user);
  if (old.type === 'out' && old.planId) {
    await revertMovementFromPlan(old.planId, old, user);
    await applyMovementToPlan(old.planId, next, user);
  }
  return next;
}
