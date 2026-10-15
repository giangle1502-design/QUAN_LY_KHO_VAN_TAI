import { collection, doc, runTransaction, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { createOrder, summarizeLines } from './orders';
import { norm, today } from './utils';

// ============================================================================
// Kế hoạch phân bổ hàng mua: chia từng dòng PO (theo cont hoặc theo kg) cho nơi đến.
// Điểm giao = khách → gom thành đơn bán (SO); = kho của mình → gom thành lệnh chuyển kho (STO)
// từ nơi nhận hàng (kho cảng / KNQ, = kho nhập của dòng PO) tới kho đó.
// Mỗi dòng kế hoạch nhớ đơn + dòng đơn đã sinh ra (orderId, orderLine) để theo dõi giao hàng.
// ============================================================================

export const DEST_TYPES = {
  customer: 'Giao khách',
  warehouse: 'Về kho mình',
  keep: 'Để tồn tại kho nhận',
  pending: 'Chưa chốt',
};

const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const EPS = 0.001;
const nowISO = () => new Date().toISOString();

// Trạng thái hiển thị của dòng kế hoạch (dòng đã tạo đơn: theo tiến độ dòng đơn)
export const ALLOC_STATUS = {
  draft: { label: 'Nháp', tone: '' },
  ordered: { label: 'Đã tạo đơn', tone: 'blue' },
  partial: { label: 'Đang giao', tone: 'amber' },
  done: { label: 'Đã giao', tone: 'green' },
  orderGone: { label: 'Đơn đã hủy / đóng', tone: 'red' },
  cancelled: { label: 'Đã hủy dòng', tone: 'red' },
  kept: { label: 'Để tồn kho nhận', tone: 'green' },
};
export function allocStatus(a, orders) {
  if (a.status === 'cancelled') return 'cancelled';
  if (!a.orderId) return a.destType === 'keep' ? 'kept' : 'draft';
  const o = orders.get(a.orderId);
  if (!o) return 'ordered';
  const l = (o.lines || []).find((x) => x.no === a.orderLine);
  // STO: tính là đã giao khi kho đến đã nhận
  const done = l ? n(o.type === 'STO' ? l.receivedKg : l.doneKg) : 0;
  if (done >= n(l?.qtyKg) - EPS && done > 0) return 'done';
  if (['cancelled', 'closed'].includes(o.status)) return 'orderGone';
  return done > EPS ? 'partial' : 'ordered';
}

// Tổng kg đã phân bổ theo dòng PO (bỏ dòng đã hủy): Map `PO__no` → kg
export const poKey = (poId, no) => `${poId}__${no}`;
export function allocatedByPoLine(allocs, exceptId) {
  const m = new Map();
  for (const a of allocs) {
    if (a.status === 'cancelled' || a._id === exceptId) continue;
    const k = poKey(a.poId, a.poLine);
    m.set(k, (m.get(k) || 0) + n(a.qtyKg));
  }
  return m;
}

// Dòng kế hoạch còn thiếu gì để tạo đơn ('' = đủ)
export function missingForOrder(a) {
  if (a.orderId) return 'đã có đơn';
  if (a.status === 'cancelled') return 'dòng đã hủy';
  if (!(n(a.qtyKg) > 0)) return 'chưa có số lượng';
  if (!a.fromWarehouse) return 'chưa có nơi nhận (kho lấy hàng)';
  if (a.destType === 'keep') return 'để tồn tại kho nhận, không cần đơn';
  if (a.destType === 'customer') return a.partyCode ? '' : 'chưa chọn khách hàng';
  if (a.destType === 'warehouse') {
    if (!a.toWarehouse) return 'chưa chọn kho đến';
    if (a.toWarehouse === a.fromWarehouse) return 'kho đến trùng nơi nhận';
    return '';
  }
  return 'điểm giao chưa chốt';
}

// Trường điểm giao dùng chung cho cả cont (sửa ở dòng cont thì áp cho mọi mã hàng trong cont)
export const CONT_KEYS = ['date', 'contNo', 'fromWarehouse', 'fromLocation', 'destType', 'partyCode', 'partyName', 'shipCode', 'toWarehouse', 'toLocation', 'carrier'];

// Kho có ghi vị trí trong kế hoạch phân bổ không: mặc định có (kho cảng, kho mua nội địa…),
// trừ kho tích "Kế hoạch phân bổ chỉ cần kho" hoặc kho tên Đức Hòa (nhiều vị trí nhỏ)
export function planNeedsLocation(wh) {
  if (!wh) return false;
  if (wh.planNoLocation === true) return false;
  return !norm(`${wh.code} ${wh.name}`).replace(/\s/g, '').includes('duchoa');
}

// Thêm dòng kế hoạch: mỗi phần tử { po, line, qtyKg, contNo?, date?, ...trường điểm giao chung của cont }
export async function addRows(parts, user) {
  const at = nowISO();
  const b = writeBatch(db);
  for (const { po, line, ...p } of parts) {
    const ref = doc(collection(db, 'allocations'));
    b.set(ref, {
      id: ref.id, poId: po.id, poLine: line.no, company: po.company || '', supplier: po.partyCode || '', supplierName: po.partyName || '',
      bct: po.refNo || '', item: line.item, itemName: line.itemName || '', qtyKg: p.qtyKg, date: p.date || line.dueDate || po.dueDate || '',
      contNo: p.contNo || '', fromWarehouse: p.fromWarehouse || line.warehouse || po.warehouse || '', fromLocation: p.fromLocation || '', toLocation: p.toLocation || '', destType: p.destType || 'pending',
      partyCode: p.partyCode || '', partyName: p.partyName || '', shipCode: p.shipCode || '', toWarehouse: p.toWarehouse || '', carrier: p.carrier || '', note: '',
      orderId: '', orderType: '', orderLine: null, status: 'draft', ...(p.extra || {}),
      createdAt: at, createdBy: user.email, updatedAt: at, updatedBy: user.email,
    });
  }
  await b.commit();
}
// N dòng cho 1 dòng PO (chia đều theo cont)
export const addAllocations = (po, line, parts, user) => addRows(parts.map((p) => ({ po, line, ...p })), user);

// Sửa cùng lúc nhiều dòng (các mã hàng của 1 cont)
export async function updateRows(rows, patch, user) {
  const b = writeBatch(db);
  const at = nowISO();
  rows.forEach((a) => b.update(doc(db, 'allocations', a._id), { ...patch, updatedAt: at, updatedBy: user.email }));
  await b.commit();
}

export const updateAllocation = (id, patch, user) =>
  updateDoc(doc(db, 'allocations', id), { ...patch, updatedAt: nowISO(), updatedBy: user.email });

// Gom các dòng kế hoạch đã chọn thành đơn: SO theo công ty + khách, STO theo công ty
// mode 'merge': gộp theo công ty (+ khách); 'cont': mỗi cont 1 đơn (cont về khác ngày → phiếu nhập / xuất riêng)
// typeOf(mã hàng) = loại hạt nhựa: mỗi SO chỉ một loại (Nguyên sinh / Tái sinh) → tách SO theo loại
export function groupForOrders(allocs, mode = 'merge', typeOf = () => '') {
  const groups = new Map();
  for (const a of allocs) {
    const so = a.destType === 'customer';
    const cont = mode === 'cont' ? `|${a.contNo || `#${a._id}`}` : '';
    const pt = so ? typeOf(a.item) || '' : '';
    const k = (so ? `SO|${a.company}|${a.partyCode}|${pt}` : `STO|${a.company}`) + cont;
    if (!groups.has(k)) groups.set(k, { key: k, type: so ? 'SO' : 'STO', company: a.company, partyCode: so ? a.partyCode : '', partyName: so ? a.partyName : '', plasticType: pt, contNo: mode === 'cont' ? a.contNo || '' : '', rows: [] });
    groups.get(k).rows.push(a);
  }
  return [...groups.values()].map((g) => ({ ...g, rows: g.rows.sort((x, y) => String(x.date).localeCompare(String(y.date))) }));
}

// Tạo 1 đơn từ 1 nhóm, ghi số đơn + dòng đơn vào các dòng kế hoạch trong cùng giao dịch
export async function createOrderFromGroup(g, { sales, whName }, user) {
  const sto = g.type === 'STO';
  const lines = g.rows.map((a) => ({
    item: a.item, itemName: a.itemName, qtyKg: n(a.qtyKg), dueDate: a.date || '', goodsStatus: '',
    note: [a.contNo ? `Cont ${a.contNo}` : '', `${a.poId}${a.bct ? ` / BCT ${a.bct}` : ''}`, a.note].filter(Boolean).join(' · '),
    ...(sto ? { fromWarehouse: a.fromWarehouse, toWarehouse: a.toWarehouse, ...(a.toLocation ? { toLocation: a.toLocation } : {}) } : { warehouse: a.fromWarehouse, shipCode: a.shipCode || '' }),
    ...(a.carrier ? { carrier: a.carrier } : {}),
    allocId: a._id, poId: a.poId, poLine: a.poLine, contNo: a.contNo || '',
  }));
  const sum = summarizeLines(lines, sto);
  const data = {
    type: g.type, company: g.company, date: today(),
    ...(sto ? { partyCode: sum.toWarehouses.join(', '), partyName: `Chuyển đến kho ${sum.toWarehouses.map(whName).join(', ')}` }
      : { partyCode: g.partyCode, partyName: g.partyName, sales: sales || '' }),
    refNo: '', tolerancePct: 0, note: `Lập từ kế hoạch phân bổ hàng mua${g.contNo ? ` · cont ${g.contNo}` : ''}`, fromAllocation: true, ...(g.contNo ? { contNo: g.contNo } : {}),
    carriers: [...new Set(lines.map((l) => l.carrier).filter(Boolean))], lines, ...sum,
  };
  const refs = g.rows.map((a) => doc(db, 'allocations', a._id));
  return createOrder(data, user, {}, {
    // Dòng kế hoạch có thể vừa được người khác tạo đơn: kiểm tra lại trước khi ghi
    read: async (tx) => {
      const snaps = [];
      for (const r of refs) snaps.push(await tx.get(r));
      const bad = snaps.find((s) => !s.exists() || s.data().orderId || s.data().status === 'cancelled');
      if (bad) throw new Error(`Dòng kế hoạch ${bad.id} đã có đơn hoặc đã hủy, tải lại trang rồi chọn lại.`);
      return null;
    },
    write: (tx, id, created) => {
      const at = nowISO();
      refs.forEach((r, i) => tx.update(r, { orderId: id, orderType: g.type, orderLine: created[i].no, status: 'ordered', updatedAt: at, updatedBy: user.email }));
    },
  });
}

// Gắn dòng kế hoạch vào dòng SO có sẵn (sale đã lên đơn trước)
// Nhà vận chuyển đã chọn trong kế hoạch ghi luôn vào dòng SO (nếu dòng đơn chưa có), để phiếu xuất kho tự lấy
export async function attachToOrder(a, o, l, user) {
  await updateAllocation(a._id, {
    orderId: o.id, orderType: o.type, orderLine: l.no, status: 'ordered', destType: 'customer', attached: true,
    partyCode: o.partyCode || '', partyName: o.partyName || '', shipCode: l.shipCode || o.shipCode || a.shipCode || '',
  }, user);
  if (a.carrier && !l.carrier) await setCarrier([{ ...a, orderId: o.id, orderLine: l.no }], a.carrier, user);
}

// Đổi nhà vận chuyển cho dòng kế hoạch đã có đơn: ghi cả vào dòng đơn (SO / STO) trong cùng giao dịch
export async function setCarrier(rows, carrier, user) {
  const byOrder = new Map();
  for (const a of rows) if (a.orderId) byOrder.set(a.orderId, [...(byOrder.get(a.orderId) || []), a]);
  return runTransaction(db, async (tx) => {
    const snaps = [];
    for (const id of byOrder.keys()) snaps.push(await tx.get(doc(db, 'orders', id)));
    const at = nowISO();
    for (const s of snaps) {
      if (!s.exists()) continue;
      const o = s.data();
      const nos = new Set(byOrder.get(s.id).map((a) => a.orderLine));
      const lines = o.lines.map((l) => (nos.has(l.no) ? { ...l, carrier } : l));
      tx.update(s.ref, {
        lines, carriers: [...new Set(lines.map((l) => l.carrier).filter(Boolean))], updatedAt: at, updatedBy: user.email,
        history: [...(o.history || []), { at, by: user.email, byName: user.name, action: `Giao vận tải (kế hoạch phân bổ): ${carrier || 'bỏ'} cho dòng ${[...nos].join(', ')}` }],
      });
    }
    rows.forEach((a) => tx.update(doc(db, 'allocations', a._id), { carrier, updatedAt: at, updatedBy: user.email }));
  });
}
// Bỏ gắn (chỉ với đơn có sẵn được gắn vào, không phải đơn lập từ kế hoạch)
export const detachFromOrder = (a, user) => updateAllocation(a._id, { orderId: '', orderType: '', orderLine: null, status: 'draft', attached: false }, user);

// Kiểm tra lại dòng kế hoạch trong giao dịch trước khi hủy
export async function cancelAllocation(a, user) {
  const ref = doc(db, 'allocations', a._id);
  return runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (s.data()?.orderId) throw new Error('Dòng đã có đơn: hủy / sửa dòng đơn trước.');
    tx.update(ref, { status: 'cancelled', updatedAt: nowISO(), updatedBy: user.email });
  });
}
