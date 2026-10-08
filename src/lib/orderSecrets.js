// Trường đơn hàng chỉ người được chỉ định xem (vd. Đơn giá): giá trị không nằm trong đơn mà ở
// orderSecrets/{số đơn}__{mã trường}, kèm danh sách người xem; firestore.rules chỉ cho họ (và quản trị) đọc.
import { useEffect, useMemo, useState } from 'react';
import { collection, deleteField, doc, getDocs, onSnapshot, query, where, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { isPrivate } from './fields';
import { computeFormulas } from './formula';

export const secretId = (orderId, key) => `${orderId}__${key}`;

// Tách giá trị trường riêng tư khỏi dữ liệu đơn. headVals: { key: value }, lineVals: [{ key: value }] theo thứ tự dòng
// Trả về { head, lines, secrets: { key: { viewers, value } | { viewers, byIndex: [..] } } }
export function splitSecrets(headFields, lineFields, headVals, lineVals) {
  const secrets = {};
  const head = { ...headVals };
  for (const f of headFields.filter(isPrivate)) {
    secrets[f.key] = { viewers: f.viewers || [], salesSees: !!f.salesSees, value: head[f.key] ?? '' };
    delete head[f.key];
  }
  const lines = lineVals.map((l) => ({ ...l }));
  for (const f of lineFields.filter(isPrivate)) {
    secrets[f.key] = { viewers: f.viewers || [], salesSees: !!f.salesSees, byIndex: lines.map((l) => l[f.key] ?? '') };
    lines.forEach((l) => delete l[f.key]);
  }
  return { head, lines, secrets };
}

// Ghi trong giao dịch lập / sửa đơn (lines đã có số dòng no)
export function writeSecrets(tx, order, lines, secrets, by) {
  const at = new Date().toISOString();
  for (const [key, s] of Object.entries(secrets || {})) {
    const data = { orderId: order.id, orderType: order.type, field: key, viewers: s.viewers, salesSees: !!s.salesSees, sales: order.sales || '', updatedAt: at, updatedBy: by };
    if (s.byIndex) data.lines = Object.fromEntries(lines.map((l, i) => [String(l.no), s.byIndex[i] ?? '']));
    else data.value = s.value ?? '';
    tx.set(doc(db, 'orderSecrets', secretId(order.id, key)), data);
  }
}

// Nghe các giá trị riêng tư mình được xem → Map số đơn → { head: {key: v}, lines: { no: {key: v} } }
export function useOrderSecrets(type) {
  const { isAdmin, email, role, allowed } = useApp();
  const [docs, setDocs] = useState({});
  useEffect(() => {
    if (!allowed || !email) return undefined;
    const col = collection(db, 'orderSecrets');
    const sources = isAdmin
      ? [type ? query(col, where('orderType', '==', type)) : col]
      : [query(col, where('viewers', 'array-contains', email)), ...(role ? [query(col, where('viewers', 'array-contains', role))] : []),
        // Sale phụ trách xem giá trị (vd. Giá bán) trong đơn của mình
        ...(role === 'kinh_doanh' ? [query(col, where('salesSees', '==', true), where('sales', '==', email))] : [])];
    const parts = {};
    const offs = sources.map((q, i) => onSnapshot(q, (snap) => {
      parts[i] = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
      const all = {};
      Object.values(parts).flat().forEach((x) => { all[x._id] = x; });
      setDocs(all);
    }, () => { parts[i] = []; }));
    return () => offs.forEach((off) => off());
  }, [isAdmin, email, role, allowed, type]);
  return useMemo(() => {
    const m = new Map();
    for (const s of Object.values(docs)) {
      if (type && s.orderType !== type) continue;
      if (!m.has(s.orderId)) m.set(s.orderId, { head: {}, lines: {} });
      const e = m.get(s.orderId);
      if (s.lines) for (const [no, v] of Object.entries(s.lines)) { e.lines[no] = { ...(e.lines[no] || {}), [s.field]: v }; }
      else e.head[s.field] = s.value;
    }
    m.docs = Object.values(docs);
    return m;
  }, [docs, type]);
}

export function withSecrets(order, secMap) {
  const s = secMap?.get(order.id);
  if (!s) return order;
  return { ...order, ...s.head, lines: (order.lines || []).map((l) => ({ ...l, ...(s.lines[String(l.no)] || {}) })) };
}

// Quản trị đổi người được xem 1 trường đơn hàng: cập nhật / chuyển dữ liệu đã có
// type: SO | PO | STO; level: 'head' | 'line'
export async function syncFieldPrivacy(type, level, key, viewers, salesSees = false, onProgress = () => {}) {
  const secSnap = await getDocs(query(collection(db, 'orderSecrets'), where('field', '==', key)));
  const secrets = secSnap.docs.filter((d) => d.data().orderType === type);
  const ordSnap = await getDocs(query(collection(db, 'orders'), where('type', '==', type)));
  let batch = writeBatch(db);
  let n = 0;
  const flush = async () => { if (n) { await batch.commit(); batch = writeBatch(db); n = 0; } };
  const add = async (fn) => { fn(batch); n++; if (n >= 400) await flush(); };
  let moved = 0;
  const salesOf = new Map(ordSnap.docs.map((d) => [d.id, d.data().sales || '']));
  if (viewers.length || salesSees) {
    // Còn riêng tư: cập nhật người xem; chuyển giá trị đang nằm công khai trong đơn sang orderSecrets
    for (const d of secrets) await add((b) => b.update(d.ref, { viewers, salesSees, sales: salesOf.get(d.data().orderId) || '' }));
    for (const od of ordSnap.docs) {
      const o = od.data();
      const base = { orderId: o.id, orderType: type, field: key, viewers, salesSees, sales: o.sales || '' };
      if (level === 'head' && o[key] !== undefined) {
        if (!secrets.some((d) => d.id === secretId(o.id, key))) await add((b) => b.set(doc(db, 'orderSecrets', secretId(o.id, key)), { ...base, value: o[key] }));
        await add((b) => b.update(od.ref, { [key]: deleteField() }));
        moved++;
      }
      if (level === 'line' && (o.lines || []).some((l) => l[key] !== undefined)) {
        if (!secrets.some((d) => d.id === secretId(o.id, key))) {
          await add((b) => b.set(doc(db, 'orderSecrets', secretId(o.id, key)), { ...base,
            lines: Object.fromEntries(o.lines.map((l) => [String(l.no), l[key] ?? ''])) }));
        }
        await add((b) => b.update(od.ref, { lines: o.lines.map(({ [key]: _drop, ...l }) => l) })); // eslint-disable-line no-unused-vars
        moved++;
      }
    }
  } else {
    // Bỏ riêng tư: trả giá trị về đơn, xóa bản riêng
    const byId = new Map(ordSnap.docs.map((d) => [d.id, d]));
    for (const d of secrets) {
      const s = d.data();
      const od = byId.get(s.orderId);
      if (od) {
        const o = od.data();
        if (s.lines) await add((b) => b.update(od.ref, { lines: o.lines.map((l) => ({ ...l, [key]: s.lines[String(l.no)] ?? '' })) }));
        else await add((b) => b.update(od.ref, { [key]: s.value ?? '' }));
        moved++;
      }
      await add((b) => b.delete(d.ref));
    }
  }
  await flush();
  onProgress(moved);
  return moved;
}

// Đơn để hiển thị: gộp giá trị riêng tư được xem + tính trường công thức (dòng trước, phần chung sau)
export function viewOrder(order, secMap, headFields, lineFields) {
  const o = withSecrets(order, secMap);
  const lines = (o.lines || []).map((l) => computeFormulas(lineFields, { ...l, qtyT: (Number(l.qtyKg) || 0) / 1000 }, { extraFields: headFields, rowExtra: o }));
  // _raw: đơn gốc, dùng khi ghi lại (không để lọt giá trị riêng tư / công thức vào đơn)
  return { ...computeFormulas(headFields, o, { lines, lineFields }), lines, _raw: order };
}
