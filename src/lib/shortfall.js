// Hàng thiếu cho đơn bán: theo công ty + kho + mã hàng, SO còn phải giao nhiều hơn tồn được xuất (KTC + DGC)
// → phần thiếu cần giải chấp từ hàng HTC. Dùng ở Đề nghị giải chấp (tab Hàng thiếu) và cảnh báo ở Đơn bán.
import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useCollection, useOrders, useStock } from './hooks';
import { leftKg } from './orders';

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
export const shortKey = (co, wh, item) => `${co}|${wh}|${item}`;

// kg mỗi dòng tồn đang nằm trong đề nghị giải chấp chờ ngân hàng duyệt
export function usePendingRelease() {
  const [pending, setPending] = useState(new Map());
  useEffect(() => onSnapshot(query(collection(db, 'releaseRequests'), where('status', '==', 'sent')), (s) => {
    const m = new Map();
    s.docs.forEach((d) => (d.data().lines || []).forEach((l) => m.set(l.stockId, (m.get(l.stockId) || 0) + num(l.kg))));
    setPending(m);
  }, () => {}), []);
  return pending;
}

// stock: dòng tồn; orders: đơn đang mở; locked: Set tình trạng bị khóa xuất (HTC); pending: Map stockId → kg chờ duyệt
export function computeShortfall({ stock, orders, locked, pending = new Map() }) {
  const m = new Map();
  const get = (co, wh, item, nm) => {
    const k = shortKey(co, wh, item);
    if (!m.has(k)) m.set(k, { key: k, company: co, warehouse: wh, item, itemName: nm || '', so: 0, usable: 0, htc: 0, held: 0, orders: new Set(), lots: [] });
    return m.get(k);
  };
  for (const o of orders) {
    if (o.type !== 'SO') continue;
    for (const l of o.lines || []) {
      const left = leftKg(l);
      if (left <= 0) continue;
      const x = get(l.company || o.company || '', l.warehouse || o.warehouse || '', l.item, l.itemName);
      x.so += left; x.orders.add(o.id);
    }
  }
  for (const r of stock) {
    const k = shortKey(r.company || '', r.warehouse, r.item);
    const x = m.get(k);
    if (!x) continue;
    if (!x.itemName && r.itemName) x.itemName = r.itemName;
    if (locked.has(r.goodsStatus)) {
      const held = pending.get(r._id) || 0;
      x.htc += num(r.kg); x.held += held;
      if (r.goodsStatus === 'HTC') x.lots.push({ ...r, free: r3(num(r.kg) - held) });
    } else x.usable += num(r.kg);
  }
  // Đơn chưa ghi kho: so với tồn của công ty ở mọi kho
  for (const x of m.values()) {
    if (x.warehouse) continue;
    for (const r of stock) {
      if ((r.company || '') !== x.company || r.item !== x.item) continue;
      if (locked.has(r.goodsStatus)) { x.htc += num(r.kg); x.held += pending.get(r._id) || 0; } else x.usable += num(r.kg);
    }
  }
  return [...m.values()].map((x) => {
    const short = r3(Math.max(0, x.so - x.usable));
    // Phần thiếu chưa có đề nghị nào chờ duyệt; lấy HTC theo FIFO ngày nhập
    const need = r3(Math.max(0, short - x.held));
    let rest = need;
    const plan = [];
    if (x.warehouse) {
      for (const lot of [...x.lots].filter((s) => s.free > 0.001).sort((a, b) => String(a.inDate).localeCompare(String(b.inDate)))) {
        if (rest <= 0.001) break;
        const kg = r3(Math.min(rest, lot.free));
        plan.push({ stockId: lot._id, pledgee: lot.pledgee || '', kg });
        rest = r3(rest - kg);
      }
    }
    return { ...x, orders: [...x.orders], short, need, plan, uncovered: r3(Math.max(0, rest)) };
  }).filter((x) => x.short > 0.001)
    .sort((a, b) => a.company.localeCompare(b.company) || a.warehouse.localeCompare(b.warehouse) || a.item.localeCompare(b.item));
}

export function useShortfall(wh = '') {
  const { rows: stock, loading } = useStock(wh);
  const { rows: orders } = useOrders('SO', true);
  const statuses = useCollection('goodsStatus').rows;
  const pending = usePendingRelease();
  const rows = useMemo(() => {
    const locked = new Set(statuses.filter((s) => s.allowOutbound === false).map((s) => s.code));
    if (!statuses.length) locked.add('HTC');
    return computeShortfall({ stock, orders: wh ? orders.map((o) => ({ ...o, lines: o.lines.filter((l) => (l.warehouse || o.warehouse) === wh) })) : orders, locked, pending });
  }, [stock, orders, statuses, pending, wh]);
  return { rows, loading };
}
