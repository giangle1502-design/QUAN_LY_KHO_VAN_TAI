import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { savePlateHistory } from './plates';
import { calcFreight, matchRate } from './freight';
import { fmtNum } from './utils';

// ============================================================================
// Job = 1 xe chạy nhiều Shipment (nhiều điểm lấy và / hoặc nhiều điểm giao).
//  • Shipment (chuyến, trips) = 1 điểm lấy → 1 điểm giao. Job ghép nhiều Shipment cùng 1 đơn vị vận tải, 1 xe.
//  • VD: lấy Đức Hòa 2 t + Sotrans 1 t + Linh Phát 1 t rồi giao 1 khách = 1 Job 3 Shipment, in 1 phiếu giao gộp.
//  • Mỗi Shipment giữ bước riêng (bảo vệ / thủ kho chỉ ở kho có bảo vệ), tài xế đi theo thứ tự jobSeq.
//  • Cước Job theo cách tính của đơn vị vận tải (A / B / C), phân bổ về từng Shipment theo tấn.
// jobs/{JB…}: carrier, plate, tài xế, tripIds (theo thứ tự), pricing. Mỗi trip: jobId, jobSeq, jobTrips.
// ============================================================================
const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
const nowISO = () => new Date().toISOString();
const kgOf = (t) => (t.lines || []).reduce((s, l) => s + num(l.plannedKg), 0);

export const JOB_PRICING = {
  A: 'A. Giá điểm giao đắt nhất × tổng tấn + phí mỗi điểm thêm',
  B: 'B. Cộng cước từng Shipment theo bảng giá',
  C: 'C. Giá khoán cả Job (nhập tay)',
};
export const pricingOf = (c) => { const k = String(c?.jobPricing || 'A').trim().charAt(0).toUpperCase(); return JOB_PRICING[k] ? k : 'A'; };

// Điểm lấy / điểm giao của 1 Shipment
export const pickKey = (t) => t.pickup || `wh:${t.warehouse || ''}`;
export const pickName = (t) => t.pickupName || t.warehouseName || t.warehouse || '';
export const dropKey = (t) => { const l = t.lines?.[0] || {}; return l.shipCode ? `ship:${l.shipCode}` : `party:${l.partyCode || ''}${l.toLocation ? `/${l.toLocation}` : ''}`; };
export const dropName = (t) => { const l = t.lines?.[0] || {}; return `${l.partyName || l.partyCode || ''}${l.shipCode ? ` · ${l.shipCode}` : ''}`; };

// Các điểm dừng của Job theo thứ tự: điểm lấy trước, điểm giao sau (gộp điểm trùng)
export function jobStops(trips) {
  const ts = [...trips].sort((a, b) => num(a.jobSeq) - num(b.jobSeq));
  const picks = new Map(); const drops = new Map();
  for (const t of ts) {
    const pk = pickKey(t); const dk = dropKey(t);
    if (!picks.has(pk)) picks.set(pk, { kind: 'pick', key: pk, name: pickName(t), kg: 0, trips: [] });
    if (!drops.has(dk)) drops.set(dk, { kind: 'drop', key: dk, name: dropName(t), address: t.lines?.[0]?.address || '', kg: 0, trips: [] });
    picks.get(pk).kg += kgOf(t); picks.get(pk).trips.push(t.id);
    drops.get(dk).kg += kgOf(t); drops.get(dk).trips.push(t.id);
  }
  return [...picks.values(), ...drops.values()];
}
// Số điểm thêm (ngoài 1 điểm lấy + 1 điểm giao)
export const extraStops = (trips) => { const s = jobStops(trips); return Math.max(0, s.filter((x) => x.kind === 'pick').length - 1) + Math.max(0, s.filter((x) => x.kind === 'drop').length - 1); };

let lastT = 0;
export async function createJob({ trips, carrier, vehicle = {}, cap = '', note = '' }, user) {
  if (trips.length < 2) throw new Error('Job cần ít nhất 2 Shipment.');
  if (trips.some((t) => t.carrier !== trips[0].carrier)) throw new Error('Các Shipment phải cùng 1 đơn vị vận tải.');
  if (trips.some((t) => t.jobId)) throw new Error(`${trips.find((t) => t.jobId).id} đã nằm trong Job ${trips.find((t) => t.jobId).jobId}: tách ra trước.`);
  if (trips.some((t) => t.status !== 'planned')) throw new Error('Chỉ ghép Shipment chưa chạy (đã giao vận tải, chờ xe đến).');
  const plates = [...new Set([vehicle.plate, ...trips.map((t) => t.plate)].map((p) => String(p || '').trim().toUpperCase()).filter(Boolean))];
  if (plates.length > 1) throw new Error(`Các Shipment đang ghi khác xe (${plates.join(', ')}): 1 Job chỉ 1 xe.`);
  lastT = Math.max(Date.now(), lastT + 1);
  const id = `JB${lastT.toString(36).toUpperCase()}`;
  const at = nowISO();
  const ids = trips.map((t) => t.id);
  const v = { plate: plates[0] || '', vehicleType: vehicle.vehicleType || trips.find((t) => t.vehicleType)?.vehicleType || '',
    driverName: vehicle.driverName || trips.find((t) => t.driverName)?.driverName || '', idCard: vehicle.idCard || trips.find((t) => t.idCard)?.idCard || '',
    driverPhone: vehicle.driverPhone || trips.find((t) => t.driverPhone)?.driverPhone || '' };
  await setDoc(doc(db, 'jobs', id), { id, carrier: carrier.code, carrierName: carrier.name || '', tripIds: ids, ...v, capacityTons: num(cap) || null, note,
    date: trips.map((t) => t.plannedDate).filter(Boolean).sort()[0] || '', pricing: { method: pricingOf(carrier), extraStopFee: num(carrier.extraStopFee) },
    createdAt: at, createdBy: user.email, updatedAt: at, updatedBy: user.email });
  for (const [i, t] of trips.entries()) {
    await updateDoc(doc(db, 'trips', t.id), { jobId: id, jobSeq: i + 1, jobTrips: ids, ...(v.plate ? v : {}), updatedAt: at, updatedBy: user.email,
      history: [...(t.history || []), { at, by: user.email, byName: user.name || user.email, action: `Ghép Job ${id} (điểm ${i + 1}/${ids.length})` }] });
  }
  if (v.plate) await savePlateHistory({ carrier: carrier.code, plate: v.plate, vehicleType: v.vehicleType, payload: cap, driverName: v.driverName, idCard: v.idCard, driverPhone: v.driverPhone });
  return id;
}

export async function leaveJob(t, user) {
  const at = nowISO();
  const rest = (t.jobTrips || []).filter((x) => x !== t.id);
  await updateDoc(doc(db, 'trips', t.id), { jobId: null, jobSeq: null, jobTrips: null, updatedAt: at, updatedBy: user.email,
    history: [...(t.history || []), { at, by: user.email, byName: user.name || user.email, action: `Tách khỏi Job ${t.jobId}` }] });
  // Job còn 1 Shipment thì giải tán
  for (const id of rest) await updateDoc(doc(db, 'trips', id), rest.length > 1 ? { jobTrips: rest } : { jobId: null, jobSeq: null, jobTrips: null }).catch(() => {});
  await updateDoc(doc(db, 'jobs', t.jobId), rest.length > 1 ? { tripIds: rest, updatedAt: at, updatedBy: user.email } : { tripIds: rest, status: 'cancelled', updatedAt: at, updatedBy: user.email }).catch(() => {});
}

// Tài xế nhập xe cho 1 Shipment của Job: chép xe / tài xế sang các Shipment khác của Job còn trống xe
export async function shareVehicle(t, v, database = db) {
  for (const id of (t.jobTrips || []).filter((x) => x !== t.id)) {
    try {
      const s = await getDoc(doc(database, 'trips', id));
      if (!s.exists() || s.data().plate) continue;
      await updateDoc(doc(database, 'trips', id), { plate: v.plate, vehicleType: v.vehicleType || '', idCard: v.idCard || '', driverName: v.driverName || '', driverPhone: v.driverPhone || '',
        driverRegAt: nowISO(), updatedAt: nowISO(), updatedBy: v.by || '' });
    } catch { /* Shipment khác của Job: điều phối nhập lại */ }
  }
}

// Cước gợi ý cả Job theo cách tính. Trả về { amount, detail, per: [{ id, kg, sug }] }
export function jobFreight(trips, rates, method, fee) {
  const totalKg = trips.reduce((s, t) => s + kgOf(t), 0);
  const per = trips.map((t) => {
    const l = t.lines?.[0] || {};
    const rate = matchRate(rates, { date: t.plannedDate || '', carrier: t.carrier, warehouse: t.warehouse, pickup: t.pickup || '', partyCode: l.partyCode || '', shipCode: l.shipCode || '' }, t.vehicleType || '');
    return { id: t.id, kg: kgOf(t), rate, sug: calcFreight(rate, kgOf(t)) };
  });
  const extra = extraStops(trips);
  if (method === 'B') return { amount: per.reduce((s, p) => s + num(p.sug?.amount), 0), detail: `Cộng ${per.length} Shipment theo bảng giá`, per, extra };
  if (method === 'C') return { amount: null, detail: 'Giá khoán: nhập tay', per, extra };
  // A: điểm có giá cao nhất áp cho cả xe + phí mỗi điểm thêm
  const best = per.filter((p) => p.rate).map((p) => ({ p, amt: p.rate.basis === 'Theo chuyến' ? num(p.rate.price) : Math.round(num(p.rate.price) * totalKg / 1000) }))
    .sort((a, b) => b.amt - a.amt)[0];
  const base = best ? Math.max(best.amt, best.p.rate.basis === 'Theo chuyến' ? 0 : num(best.p.rate.minAmount)) : 0;
  return { amount: base + num(fee) * extra, base, detail: best ? `Giá ${best.p.rate.code || ''} (${best.p.id}) cho ${fmtNum(totalKg / 1000)} tấn + ${extra} điểm thêm × phí` : 'Chưa có bảng giá khớp', per, extra };
}

// Phân bổ số tiền về từng Shipment theo tấn (Shipment cuối nhận phần lẻ)
export function allocate(amount, trips) {
  const tot = trips.reduce((s, t) => s + kgOf(t), 0) || 1;
  let left = Math.round(num(amount));
  return trips.map((t, i) => { const v = i === trips.length - 1 ? left : Math.round(num(amount) * kgOf(t) / tot); left -= v; return { id: t.id, kg: kgOf(t), amount: v }; });
}
