import { collection, doc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { enrichLine } from './dispatch';
import { db } from '../firebase';
import { ST, firstStatus, nowISO, reserveCodes, vnDate } from './trips';
import { calcFreight, matchRate } from './freight';

// ============================================================================
// Vận tải theo chuyến: admin giao đơn vị vận tải trên đơn → điều phối chia xe thành chuyến (status 'planned')
// → tài xế đăng ký xe/CCCD → Đến kho (vào luồng bảo vệ / thủ kho) → Lấy hàng xong → Đến điểm giao
// → Giao xong (chụp phiếu) → điều phối nhập cước, chi hộ, bốc xếp, số HĐ → kế toán chốt.
// Tài xế chỉ xác nhận giao nhận; cước (kể cả xe nội bộ) do điều phối / kế toán nhập sau.
// ============================================================================
const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
export const tripKg = (t) => (t.lines || []).reduce((s, l) => s + num(l.plannedKg ?? num(l.payload) * 1000), 0);

// So khớp số xe không phân biệt khoảng trắng, dấu chấm, gạch (51C-123.45 = 51C12345)
export const plateKey = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const STEPS = {
  reg: 'Nhập số xe',
  arrive: 'Đến điểm nhận hàng',
  loaded: 'Nhận / lấy hàng xong',
  atDest: 'Đến điểm giao hàng',
  delivered: 'Hoàn thành (giao xong)',
};
export function nextStep(t) {
  if (t.source !== 'plan' || [ST.COMPLETED, ST.CANCELLED].includes(t.status)) return null;
  // Chỉ cần số xe (xe thuê ngoài không có trong danh mục, không cần CCCD)
  if (!t.plate) return 'reg';
  if (t.status === ST.PLANNED) return 'arrive';
  // Khách tự lấy: xe ra cổng / xuất xong là hoàn thành, không có bước giao hàng
  if (t.selfPickup) return null;
  if (!t.driverLoadedAt) return 'loaded';
  if (!t.driverAtDestAt) return 'atDest';
  return 'delivered';
}
// Bước chưa làm được vì còn chờ kho / bảo vệ
export function stepBlocked(t, step) {
  if (step === 'loaded' && [ST.ARRIVED, ST.WAITING_GATE].includes(t.status)) return t.status === ST.ARRIVED ? 'Chờ bảo vệ cho xe vào cổng' : 'Chờ thủ kho gọi vào cửa';
  if ((step === 'atDest' || step === 'delivered') && t.status !== ST.WAITING_DELIVERY)
    return t.status === ST.WAITING_EXIT ? 'Chờ bảo vệ xác nhận ra cổng' : 'Chờ thủ kho xuất hàng xong';
  return '';
}

const hist = (t, user, action, status) => [...(t.history || []), { at: nowISO(), by: user.email, byName: user.name || user.email, action, ...(status ? { status } : {}) }];

// Thực hiện 1 bước của tài xế (điều phối vận tải làm thay được)
export async function doStep(t, step, user, data = {}, database = db) {
  const at = nowISO();
  let upd = {};
  if (step === 'reg') {
    upd = { plate: String(data.plate || '').trim().toUpperCase(), vehicleType: data.vehicleType || t.vehicleType || '', idCard: String(data.idCard || '').trim(),
      driverName: String(data.driverName || '').trim(), driverPhone: String(data.driverPhone || '').trim(), driverRegAt: at };
    if (!upd.plate) throw new Error('Nhập số xe.');
    if (t.plate && plateKey(t.plate) !== plateKey(upd.plate)) throw new Error(`Chuyến này điều phối đã chỉ định xe ${t.plate}.`);
    if (t.plate) upd.plate = t.plate; // gõ 51C12345 hay 51C-123.45 đều là xe đã chỉ định
    // Giữ thông tin điều phối đã nhập nếu tài xế để trống
    for (const k of ['idCard', 'driverName', 'driverPhone', 'vehicleType']) if (!upd[k]) upd[k] = t[k] || '';
  } else if (step === 'arrive') {
    const status = firstStatus(t.hasGuard !== false);
    upd = { status, arrivalTime: at, arrivalDate: vnDate(at), driverArrivedAt: at, ...(status === ST.WAITING_GATE ? { gateConfirmTime: at } : {}) };
  } else if (step === 'loaded') upd = { driverLoadedAt: at };
  else if (step === 'atDest') upd = { driverAtDestAt: at };
  else if (step === 'delivered') {
    if (!data.photos?.length) throw new Error('Chụp ít nhất 1 ảnh phiếu giao hàng.');
    for (const [i, img] of data.photos.entries()) {
      await setDoc(doc(database, 'tripPhotos', `${t.id}_${(t.photoCount || 0) + i + 1}`), { tripId: t.id, carrier: t.carrier || '', data: img, by: user.email, at });
    }
    upd = { status: ST.COMPLETED, deliveryCompleteTime: at, driverDeliveredAt: at, photoCount: (t.photoCount || 0) + data.photos.length,
      lines: t.lines.map((l) => ({ ...l, delivered: true, deliveredTime: l.deliveredTime || at })) };
  }
  await updateDoc(doc(database, 'trips', t.id), { ...upd, updatedAt: at, updatedBy: user.email,
    history: hist(t, user, STEPS[step] + (data.note ? `: ${data.note}` : ''), upd.status) });
}

// Cước gợi ý theo bảng giá cho 1 chuyến (lấy điểm giao của dòng đầu)
export function suggestFreight(t, rates) {
  const l = t.lines?.[0] || {};
  const m = { date: t.plannedDate || t.arrivalDate || '', carrier: t.carrier, warehouse: t.warehouse, partyCode: l.partyCode || '', shipCode: l.shipCode || '' };
  return calcFreight(matchRate(rates, m, t.vehicleType || ''), tripKg(t));
}
export const costTotal = (c) => (c ? num(c.freight) + num(c.chiHo) + num(c.bocXep) + num(c.other) : 0);

// Chia số tấn của các dòng đơn thành nhiều chuyến theo tải trọng xe (xếp lần lượt từng dòng)
export function splitLoads(lines, loadsKg) {
  const left = lines.map((l) => ({ ...l, rest: num(l.kg) }));
  return loadsKg.map((cap) => {
    const out = []; let room = num(cap);
    for (const l of left) {
      if (room <= 0.5) break;
      const k = Math.min(l.rest, room);
      if (k > 0.5) { out.push({ ...l, kg: Math.round(k) }); l.rest -= k; room -= k; }
    }
    return out;
  });
}

// Tạo các chuyến đã chia (status 'planned')
export async function createPlannedTrips({ wh, carrier, trips }, user, action = 'Chia xe') {
  // Địa chỉ, người nhận, định vị điểm giao chép vào chuyến (tài xế mở link không đọc được danh mục)
  const [shipto, whs] = await Promise.all(['shipto', 'warehouses'].map((c) => getDocs(collection(db, c)).then((q) => q.docs.map((d) => d.data())).catch(() => [])));
  trips = trips.map((t) => ({ ...t, lines: t.lines.map((l) => enrichLine(l, shipto, whs)) }));
  const [first, ...rest] = await reserveCodes('GRP', trips.length);
  const gids = [first, ...rest];
  const sids = await reserveCodes('SP', trips.reduce((s, t) => s + t.lines.length, 0));
  const at = nowISO(); let k = 0;
  for (const [i, t] of trips.entries()) {
    const id = gids[i];
    const trip = {
      source: 'plan', purpose: 'export', warehouse: wh.code, warehouseName: wh.name || '', warehouseAddress: wh.address || '', warehouseMap: wh.mapLink || '', hasGuard: wh.hasGuard !== false,
      carrier: carrier.code, carrierName: carrier.name || '', plate: (t.plate || '').trim().toUpperCase(), vehicleType: t.vehicleType || '',
      idCard: (t.idCard || '').trim(), driverName: (t.driverName || '').trim(), driverPhone: (t.driverPhone || '').trim(),
      plannedDate: t.date, arrivalDate: t.date, arrivalTime: null, note: t.note || '',
      lines: t.lines.map((l) => ({ id: sids[k++], orderId: l.orderId, orderLine: l.no, item: l.item, itemName: l.itemName || '', partyCode: l.partyCode || '', partyName: l.partyName || '',
        shipCode: l.shipCode || '', address: l.address || '', contact: l.contact || '', contactPhone: l.contactPhone || '', mapLink: l.mapLink || '', plannedKg: l.kg, payload: Math.round(l.kg) / 1000, delivered: false, deliveredTime: null,
        // Nguồn của phần hàng (để biết dự kiến xuất / phân bổ / phiếu xuất nào đã giao vận tải)
        ...(l.planId ? { planId: l.planId } : {}), ...(l.allocId ? { allocId: l.allocId } : {}), ...(l.movementId ? { movementId: l.movementId } : {}) })),
      company: t.company || '', carrierKind: carrier.kind || '', selfPickup: carrier.kind === 'Khách tự lấy',
      orderIds: [...new Set(t.lines.map((l) => l.orderId))],
      status: ST.PLANNED, gateConfirmTime: null, dock: null, dockAssignTime: null, processDoneTime: null, gateExitTime: null, deliveryCompleteTime: null,
      createdBy: user.email, createdAt: at,
      history: [{ at, by: user.email, byName: user.name || user.email, action: `${action}: ${fmtT(t.lines.reduce((s, l) => s + l.kg, 0))} tấn`, status: ST.PLANNED }],
    };
    await setDoc(doc(db, 'trips', id), trip);
    // 3PL chỉ GHA thấy: lưu riêng
    if (t.threepl) await setDoc(doc(db, 'tripPrivate', id), { tripId: id, carrier: carrier.code, threepl: t.threepl, threeplName: t.threeplName || '', by: user.email, at });
  }
  return gids;
}
const fmtT = (kg) => (Math.round(kg) / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 3 });

// Nén ảnh chụp phiếu (JPEG, cạnh dài tối đa 1280px) để lưu thẳng vào Firestore (< ~700 KB)
export function compressImage(file, maxSide = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let side = maxSide; let q = 0.7; let out = '';
      for (let i = 0; i < 6; i++) {
        const k = Math.min(1, side / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', q);
        if (out.length < 700000) break;
        side = Math.round(side * 0.8); q = Math.max(0.4, q - 0.1);
      }
      URL.revokeObjectURL(url);
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được ảnh.')); };
    img.src = url;
  });
}
