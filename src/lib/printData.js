import { palletManaged } from './pallets';
// Nạp dữ liệu liên quan của 1 phiếu để điền vào mẫu in tự thiết kế
import { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../firebase';

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
const one = (coll, id) => (id ? getDoc(doc(db, coll, String(id))).then((s) => (s.exists() ? s.data() : null)).catch(() => null) : Promise.resolve(null));

// Kg của 1 pallet full theo quy cách mã hàng
export function fullPalletKg(item) {
  if (!item) return 0;
  return num(item.palletWeight) || num(item.bagsPerLayer) * num(item.layersPerPallet) * num(item.bagWeight);
}

// Chia 1 dòng phiếu nhập thành các pallet: mỗi pallet full 1 nhãn, phần lẻ 1 nhãn riêng
export function splitPallets(line, item) {
  const kg = Math.abs(num(line.kg));
  const bags = Math.abs(num(line.bags));
  const per = fullPalletKg(item);
  const bagW = num(item?.bagWeight) || (bags ? kg / bags : 0);
  if (per > 0 && kg > 0) {
    const out = [];
    let left = kg;
    while (left > 0.001) {
      const k = Math.min(per, left);
      out.push({ kg: r3(k), bags: bagW ? Math.round(k / bagW) : '', full: k >= per - 0.001 });
      left -= k;
    }
    return out;
  }
  // Mã hàng chưa khai quy cách pallet: chia đều theo số pallet trên phiếu
  const n = Math.max(1, Math.ceil(Math.abs(num(line.pallets)) - 1e-9));
  return Array.from({ length: n }, () => ({ kg: r3(kg / n), bags: bags ? r3(bags / n) : '', full: true }));
}

// Mỗi pallet 1 nhãn: dòng phiếu nhập + số kg, số bao của pallet đó
export function labelLines(m, items) {
  const out = [];
  (m?.lines || []).forEach((l, li) => {
    const parts = splitPallets(l, items?.get(l.item));
    parts.forEach((p, pi) => out.push({ ...l, kg: p.kg, bags: p.bags, pallets: 1, full: p.full, palletNo: pi + 1, palletOf: parts.length, _line: li }));
  });
  return out;
}

async function itemsOf(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  const docs = await Promise.all(list.map((c) => one('items', c)));
  return new Map(list.map((c, i) => [c, docs[i]]).filter(([, v]) => v));
}

// 1 xe nhiều SO: các phiếu xuất cùng mã gộp (groupId) in chung 1 bộ. Trả về phiếu gộp: số phiếu = phiếu đầu,
// dòng hàng của mọi phiếu (mỗi dòng ghi số đơn), orderId = các SO nối nhau, orderIds = danh sách SO, groupMoves = các phiếu con
export async function loadGroupMovement(m) {
  if (!m?.groupId) return m;
  const snap = await getDocs(query(collection(db, 'movements'), where('groupId', '==', m.groupId)));
  let list = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  const live = list.filter((x) => x.status !== 'cancelled');
  if (live.length) list = live;
  list.sort((a, b) => num(a.groupIndex) - num(b.groupIndex) || a.id.localeCompare(b.id));
  if (list.length < 2) return m;
  const first = list[0];
  const orderIds = [...new Set(list.map((x) => x.orderId).filter(Boolean))];
  const refs = [...new Set(list.map((x) => x.orderRef).filter(Boolean))];
  return {
    ...first,
    orderId: orderIds.join(', '), orderRef: refs.join(', '), orderIds, groupMoves: list,
    lines: list.flatMap((x) => (x.lines || []).map((l) => ({ ...l, orderId: x.orderId, orderRef: x.orderRef || '', moveId: x.id }))),
    pallets: list.flatMap((x) => x.pallets || []),
    status: list.some((x) => x.status === 'wait_release') ? 'wait_release' : first.status,
    note: [...new Set(list.map((x) => x.note).filter(Boolean))].join('; '),
  };
}

export async function loadMovementData(m) {
  const company = m.company || m.lines?.find((l) => l.company)?.company || '';
  const [co, wh, trip, party, supplier, order, items, shipto] = await Promise.all([
    one('companies', company),
    one('warehouses', m.warehouse),
    one('trips', m.tripId),
    one('soldto', m.partyCode),
    one('suppliers', m.partyCode),
    one('orders', m.orderIds ? m.orderIds[0] : m.orderId),
    itemsOf((m.lines || []).map((l) => l.item)),
    m.shipCode
      ? getDocs(query(collection(db, 'shipto'), where('shipCode', '==', m.shipCode), limit(5)))
        .then((s) => { const rows = s.docs.map((d) => d.data()); return rows.find((r) => r.customerCode === m.partyCode) || rows[0] || null; }).catch(() => null)
      : null,
  ]);
  // Phiếu gộp nhiều SO: dòng hàng tra đúng dòng của đơn mình
  const orders = m.orderIds?.length > 1 ? new Map((await Promise.all(m.orderIds.map((id) => one('orders', id)))).map((o, i) => [m.orderIds[i], o]).filter(([, o]) => o)) : null;
  return { m, co: co || (company ? { code: company, name: company } : null), wh, trip, party, supplier, order, orders, items, shipto, lines: m.lines || [],
    palletRows: m.palletMode === 'pallet' && ['in', 'out'].includes(m.type) && palletManaged(wh) && m.palletTracked !== false ? m.pallets || [] : [] };
}

// Dòng đề nghị giải chấp gộp theo mã hàng + số CT + vị trí (như bản in gốc)
export function groupRelease(lines) {
  const g = new Map();
  for (const l of lines || []) {
    const k = [l.item, l.docNo, l.place].join('|');
    if (!g.has(k)) g.set(k, { ...l, kg: 0 });
    g.get(k).kg += num(l.kg);
  }
  return [...g.values()];
}

export async function loadReleaseData(r) {
  const [co, bank, wh, items] = await Promise.all([
    one('companies', r.company), one('pledgees', r.pledgee), one('warehouses', r.warehouse),
    itemsOf((r.lines || []).map((l) => l.item)),
  ]);
  return { r, co: co || {}, bank: bank || { name: r.pledgeeName }, wh, items, lines: groupRelease(r.lines) };
}

// Danh sách mẫu in (nghe 1 lần khi mở trang in)
export function usePrintTemplates() {
  const [list, setList] = useState(null);
  useEffect(() => {
    getDocs(collection(db, 'printTemplates')).then((s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() })))).catch(() => setList([]));
  }, []);
  return list;
}
