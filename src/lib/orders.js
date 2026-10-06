import { doc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { catalogByKey } from '../catalogs';

// ============================================================================
// Đơn bán (SO) và đơn mua (PO). Mỗi dòng đơn: số dòng cố định (no), mã hàng,
// số lượng đặt (kg), đã giao/nhận (kg). Dòng phiếu kho trỏ tới dòng đơn qua `orderLine` = no.
// Phiếu xuất gắn SO, phiếu nhập gắn PO: khi ghi phiếu, "đã giao/nhận" của dòng đơn
// được cộng trong cùng giao dịch (hủy phiếu thì trừ lại). Còn lại = đặt − đã giao/nhận.
// ============================================================================

export const ORDER_TYPES = {
  SO: { label: 'Đơn bán (SO)', short: 'SO', party: 'soldto', partyLabel: 'Khách hàng', moveType: 'out', done: 'Đã giao', left: 'Còn phải giao', due: 'Hạn giao' },
  PO: { label: 'Đơn mua (PO)', short: 'PO', party: 'suppliers', partyLabel: 'Nhà cung cấp', moveType: 'in', done: 'Đã nhận', left: 'Còn chưa về', due: 'Ngày hàng về (ETA)' },
};

export const ORDER_STATUS = {
  open: { label: 'Chưa thực hiện', tone: '' },
  partial: { label: 'Đang thực hiện', tone: 'amber' },
  done: { label: 'Hoàn tất', tone: 'green' },
  closed: { label: 'Đã đóng', tone: 'purple' },
  cancelled: { label: 'Đã hủy', tone: 'red' },
};
export const OPEN_STATUSES = ['open', 'partial'];

const EPS = 0.001;
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
export const leftKg = (l) => Math.max(0, n(l.qtyKg) - n(l.doneKg));
export const orderTotals = (o) => (o.lines || []).reduce(
  (t, l) => ({ qty: t.qty + n(l.qtyKg), done: t.done + n(l.doneKg), left: t.left + leftKg(l) }), { qty: 0, done: 0, left: 0 });

// Trạng thái tự tính (trừ khi đã đóng / hủy)
export function statusOf(o, lines = o.lines) {
  if (o.status === 'closed' || o.status === 'cancelled') return o.status;
  const done = lines.reduce((s, l) => s + n(l.doneKg), 0);
  if (done <= EPS) return 'open';
  return lines.every((l) => n(l.doneKg) >= n(l.qtyKg) - EPS) ? 'done' : 'partial';
}

// Lập đơn mới: cấp số SO/PO theo Quy tắc mã tự sinh
export async function createOrder(o, user) {
  const ruleRef = doc(db, 'codeRules', o.type);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ruleRef);
    const seed = catalogByKey('codeRules').seed.find((s) => s.code === o.type);
    const rule = snap.exists() ? snap.data() : seed;
    const num = n(rule.next) || 1;
    const id = `${rule.prefix ?? o.type}${String(num).padStart(n(rule.digits) || 6, '0')}`;
    const at = new Date().toISOString();
    const lines = o.lines.map((l, i) => ({ ...l, no: i + 1, doneKg: 0 }));
    tx.set(doc(db, 'orders', id), {
      ...o, id, lines, nextLineNo: lines.length + 1, status: 'open', createdAt: at, createdBy: user.email, updatedAt: at, updatedBy: user.email,
      history: [{ at, by: user.email, byName: user.name, action: 'Lập đơn' }],
    });
    if (snap.exists()) tx.update(ruleRef, { next: num + 1 });
    else tx.set(ruleRef, { ...seed, next: num + 1 });
    return id;
  });
}

// Dùng trong giao dịch ghi/hủy phiếu: cộng/trừ "đã giao/nhận" theo dòng đơn
export function applyOrder(order, m, sign) {
  const lines = order.lines.map((l) => ({ ...l }));
  for (const ml of m.lines) {
    const i = lines.findIndex((l) => l.no === ml.orderLine);
    if (i < 0) throw new Error(`Dòng ${ml.item} không khớp dòng nào của đơn ${order.id}.`);
    if (lines[i].item !== ml.item) throw new Error(`Mã hàng ${ml.item} khác mã hàng dòng đơn (${lines[i].item}).`);
    lines[i].doneKg = Math.round((n(lines[i].doneKg) + sign * Math.abs(n(ml.kg))) * 1000) / 1000;
    if (lines[i].doneKg < -EPS) lines[i].doneKg = 0;
  }
  if (sign > 0) {
    if (!OPEN_STATUSES.includes(order.status)) throw new Error(`Đơn ${order.id} đang ở trạng thái "${ORDER_STATUS[order.status]?.label}", không giao/nhận thêm được.`);
    const tol = 1 + n(order.tolerancePct) / 100;
    const over = lines.find((l) => n(l.doneKg) > n(l.qtyKg) * tol + EPS);
    if (over) throw new Error(`Vượt số lượng đơn ${order.id}: ${over.item} đặt ${n(over.qtyKg) / 1000} tấn, tổng giao/nhận sẽ là ${n(over.doneKg) / 1000} tấn.`);
  }
  return { lines, status: statusOf(order, lines) };
}

// Gán dòng phiếu vào dòng đơn theo mã hàng (dòng còn lại nhiều nhất trước). Trả về no của dòng đơn, null nếu không có
export function matchOrderLine(order, item, usedKg = {}) {
  let best = null;
  let bestLeft = -Infinity;
  for (const l of order?.lines || []) {
    if (l.item !== item) continue;
    const left = leftKg(l) - (usedKg[l.no] || 0);
    if (left > bestLeft) { best = l.no; bestLeft = left; }
  }
  return best;
}

// Sửa đơn (kinh doanh / kế toán / quản trị): giữ "đã giao/nhận", không cho đặt ít hơn phần đã làm
export async function saveOrder(id, patch, user) {
  const ref = doc(db, 'orders', id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error(`Không tìm thấy đơn ${id}.`);
    const cur = snap.data();
    if (!OPEN_STATUSES.includes(cur.status)) throw new Error('Đơn đã hoàn tất, đóng hoặc hủy: mở lại đơn trước khi sửa.');
    const old = new Map(cur.lines.map((l) => [l.no, l]));
    let next = n(cur.nextLineNo) || cur.lines.length + 1;
    const lines = patch.lines.map((l) => {
      const o = l.no != null ? old.get(l.no) : null;
      const done = o ? n(o.doneKg) : 0;
      if (o && l.item !== o.item && done > EPS) throw new Error(`Dòng ${o.item} đã giao/nhận ${done / 1000} tấn, không đổi mã hàng được.`);
      if (n(l.qtyKg) < done - EPS) throw new Error(`Dòng ${l.item}: số lượng đặt không được nhỏ hơn phần đã giao/nhận (${done / 1000} tấn).`);
      return { ...l, no: o ? o.no : next++, doneKg: done };
    });
    for (const o of cur.lines) {
      if (n(o.doneKg) > EPS && !lines.some((l) => l.no === o.no)) throw new Error(`Dòng ${o.item} đã giao/nhận, không xóa được.`);
    }
    const at = new Date().toISOString();
    tx.update(ref, {
      ...patch, lines, nextLineNo: next, status: statusOf(cur, lines), updatedAt: at, updatedBy: user.email,
      history: [...(cur.history || []), { at, by: user.email, byName: user.name, action: 'Sửa đơn' }],
    });
  });
}

// Đóng đơn (không giao/nhận tiếp phần còn lại), hủy đơn (chưa giao/nhận gì), mở lại đơn đã đóng
export async function setOrderState(id, action, reason, user) {
  const ref = doc(db, 'orders', id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    const done = orderTotals(cur).done;
    let status;
    if (action === 'close') status = 'closed';
    else if (action === 'cancel') {
      if (done > EPS) throw new Error('Đơn đã có giao/nhận, chỉ đóng đơn được, không hủy.');
      status = 'cancelled';
    } else status = statusOf({ ...cur, status: 'open' });
    const at = new Date().toISOString();
    const label = { close: 'Đóng đơn', cancel: 'Hủy đơn', reopen: 'Mở lại đơn' }[action];
    tx.update(ref, {
      status, closeReason: action === 'reopen' ? '' : reason, updatedAt: at, updatedBy: user.email,
      history: [...(cur.history || []), { at, by: user.email, byName: user.name, action: reason ? `${label}: ${reason}` : label }],
    });
  });
}
