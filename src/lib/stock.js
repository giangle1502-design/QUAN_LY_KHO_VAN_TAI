import { doc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { catalogByKey } from '../catalogs';
import { applyOrder } from './orders';

// ============================================================================
// Tồn kho: mỗi dòng tồn = 1 document `stock/{kho__vị trí__mã hàng__lot__tình trạng}`
// lưu số bao, pallet, kg. Mọi thay đổi tồn đi qua 1 phiếu `movements/{số phiếu}`
// và được ghi trong cùng 1 giao dịch (phiếu + tồn + pallet ở vị trí lưu trữ).
// ============================================================================

export const MOVE_TYPES = {
  in: { code: 'PN', label: 'Nhập kho', icon: '📥' },
  out: { code: 'PX', label: 'Xuất kho', icon: '📤' },
  move: { code: 'CV', label: 'Chuyển vị trí', icon: '🔀' },
  status: { code: 'TC', label: 'Đổi tình trạng thế chấp', icon: '🔒' },
  adjust: { code: 'DC', label: 'Điều chỉnh tồn', icon: '⚖️' },
};

const EPS = 1e-6;
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const clean = (s) => String(s ?? '').trim().replace(/\//g, '_');

export function stockId(k) {
  const st = k.goodsStatus === 'HTC' && k.pledgee ? `HTC-${k.pledgee}` : k.goodsStatus;
  return [k.warehouse, k.location, k.item, k.lot || '-', st].map(clean).join('__');
}
export const locationId = (wh, loc) => `${clean(wh)}__${clean(loc)}`;

// Phiếu → danh sách biến động tồn (sign = -1 khi hủy phiếu)
export function effectsOf(m, sign = 1) {
  const out = [];
  const base = (l, o = {}) => ({
    warehouse: m.warehouse, location: l.location, item: l.item, itemName: l.itemName || '',
    lot: l.lot || '', mfgDate: l.mfgDate || '', expDate: l.expDate || '', inDate: l.inDate || m.date,
    goodsStatus: l.goodsStatus || 'KTC', pledgee: l.goodsStatus === 'HTC' ? l.pledgee || '' : '', ...o,
  });
  const q = (l, s) => ({ dBags: s * n(l.bags), dPallets: s * n(l.pallets), dKg: s * n(l.kg) });
  for (const l of m.lines || []) {
    if (m.type === 'in') out.push({ ...base(l), ...q(l, sign), receive: sign > 0 });
    if (m.type === 'out') out.push({ ...base(l), ...q(l, -sign), ship: sign > 0 });
    if (m.type === 'adjust') out.push({ ...base(l), ...q(l, sign) });
    if (m.type === 'move') {
      out.push({ ...base(l), ...q(l, -sign) });
      out.push({ ...base(l, { location: l.toLocation }), ...q(l, sign), receive: sign > 0 });
    }
    if (m.type === 'status') {
      out.push({ ...base(l), ...q(l, -sign) });
      out.push({ ...base(l, { goodsStatus: l.toStatus, pledgee: l.toStatus === 'HTC' ? l.toPledgee || '' : '' }), ...q(l, sign) });
    }
  }
  return out;
}

// Ghi phiếu mới: cấp số, kiểm tra tồn/vị trí/tình trạng, cập nhật tồn và pallet vị trí
export async function postMovement(m, user) {
  const meta = MOVE_TYPES[m.type];
  const ruleRef = doc(db, 'codeRules', meta.code);
  return runTransaction(db, async (tx) => {
    const ruleSnap = await tx.get(ruleRef);
    const seed = catalogByKey('codeRules').seed.find((s) => s.code === meta.code);
    const rule = ruleSnap.exists() ? ruleSnap.data() : seed;
    const num = Number(rule.next) || 1;
    const id = `${rule.prefix ?? meta.code}${String(num).padStart(Number(rule.digits) || 6, '0')}`;
    const at = new Date().toISOString();
    const mv = { ...m, id, status: 'posted', createdAt: at, createdBy: user.email, createdByName: user.name,
      history: [{ at, by: user.email, byName: user.name, action: 'Lập phiếu' }] };
    const orderRef = m.orderId ? doc(db, 'orders', m.orderId) : null;
    const orderSnap = orderRef ? await tx.get(orderRef) : null;
    if (orderRef && !orderSnap.exists()) throw new Error(`Không tìm thấy đơn ${m.orderId}.`);
    const orderUpd = orderRef ? applyOrder({ ...orderSnap.data(), id: m.orderId }, mv, 1) : null;
    await applyEffects(tx, mv, effectsOf(mv, 1), user);
    if (orderRef) tx.update(orderRef, { ...orderUpd, lastMovement: id, updatedAt: at, updatedBy: user.email });
    if (ruleSnap.exists()) tx.update(ruleRef, { next: num + 1 });
    else tx.set(ruleRef, { ...seed, next: num + 1 });
    tx.set(doc(db, 'movements', id), mv);
    return id;
  });
}

// Hủy phiếu (quản trị): đảo ngược toàn bộ biến động
export async function cancelMovement(m, reason, user) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, 'movements', m.id);
    const cur = await tx.get(ref);
    if (!cur.exists() || cur.data().status === 'cancelled') throw new Error('Phiếu đã bị hủy.');
    const orderRef = m.orderId ? doc(db, 'orders', m.orderId) : null;
    const orderSnap = orderRef ? await tx.get(orderRef) : null;
    const orderUpd = orderSnap?.exists() ? applyOrder({ ...orderSnap.data(), id: m.orderId }, m, -1) : null;
    await applyEffects(tx, { ...m, id: m.id }, effectsOf(m, -1), user);
    const at = new Date().toISOString();
    if (orderUpd) tx.update(orderRef, { ...orderUpd, lastMovement: m.id, updatedAt: at, updatedBy: user.email });
    tx.update(ref, { status: 'cancelled', cancelReason: reason, cancelledAt: at, cancelledBy: user.email,
      history: [...(m.history || []), { at, by: user.email, byName: user.name, action: `Hủy phiếu: ${reason}` }] });
  });
}

async function applyEffects(tx, mv, effects, user) {
  // Gộp biến động theo dòng tồn
  const byStock = new Map();
  for (const e of effects) {
    if (!e.location || !e.item) throw new Error('Thiếu vị trí hoặc mã hàng.');
    const id = stockId(e);
    const cur = byStock.get(id) || { ...e, dBags: 0, dPallets: 0, dKg: 0 };
    cur.dBags += e.dBags; cur.dPallets += e.dPallets; cur.dKg += e.dKg;
    cur.receive = cur.receive || e.receive; cur.ship = cur.ship || e.ship;
    byStock.set(id, cur);
  }
  const locIds = [...new Set(effects.map((e) => locationId(e.warehouse, e.location)))];
  const statusCodes = [...new Set(effects.filter((e) => e.ship).map((e) => e.goodsStatus))];

  // Đọc trước (giao dịch Firestore: đọc hết rồi mới ghi)
  const stockSnaps = new Map();
  for (const id of byStock.keys()) stockSnaps.set(id, await tx.get(doc(db, 'stock', id)));
  const locSnaps = new Map();
  for (const id of locIds) locSnaps.set(id, await tx.get(doc(db, 'locations', id)));
  const statusSnaps = new Map();
  for (const c of statusCodes) statusSnaps.set(c, await tx.get(doc(db, 'goodsStatus', c)));

  // Kiểm tra
  for (const [c, s] of statusSnaps) {
    if (s.exists() && s.data().allowOutbound === false)
      throw new Error(`Hàng tình trạng ${c} (${s.data().name}) bị khóa xuất kho. Đổi sang tình trạng được xuất (vd. DGC) trước.`);
  }
  const locDelta = new Map();
  for (const [id, e] of byStock) {
    const lid = locationId(e.warehouse, e.location);
    const ls = locSnaps.get(lid);
    if (!ls.exists()) throw new Error(`Vị trí ${e.location} không có trong kho ${e.warehouse}.`);
    if (e.receive && e.dPallets > EPS && ls.data().locked) throw new Error(`Vị trí ${e.location} đang bị khóa.`);
    const s = stockSnaps.get(id);
    const cur = s.exists() ? s.data() : { bags: 0, pallets: 0, kg: 0 };
    const bags = n(cur.bags) + e.dBags;
    const pallets = n(cur.pallets) + e.dPallets;
    if (bags < -EPS || pallets < -EPS)
      throw new Error(`Không đủ tồn: ${e.item} lot ${e.lot || '-'} tại ${e.location} (${e.goodsStatus}) còn ${n(cur.bags)} bao, ${n(cur.pallets)} pallet.`);
    e.next = { bags: round(bags), pallets: round(pallets), kg: round(Math.max(0, n(cur.kg) + e.dKg)) };
    e.exists = s.exists();
    e.prev = cur;
    locDelta.set(lid, (locDelta.get(lid) || 0) + e.dPallets);
  }

  // Ghi
  const at = new Date().toISOString();
  for (const [id, e] of byStock) {
    const common = { ...e.next, lastMovement: mv.id, updatedAt: at, updatedBy: user.email };
    if (e.exists) tx.update(doc(db, 'stock', id), common);
    else tx.set(doc(db, 'stock', id), {
      warehouse: e.warehouse, location: e.location, item: e.item, itemName: e.itemName, lot: e.lot,
      mfgDate: e.mfgDate, expDate: e.expDate, inDate: e.inDate, goodsStatus: e.goodsStatus, pledgee: e.pledgee, ...common,
    });
  }
  for (const [lid, d] of locDelta) {
    if (Math.abs(d) < EPS) continue;
    const l = locSnaps.get(lid).data();
    const current = round(Math.max(0, n(l.currentPallets) + d));
    tx.update(doc(db, 'locations', lid), {
      currentPallets: current,
      usedPct: n(l.capacity) ? Math.round((current / n(l.capacity)) * 1000) / 10 : null,
      emptyBin: current < EPS,
      lastMovement: mv.id, updatedAt: at, updatedBy: user.email,
    });
  }
}

const round = (x) => Math.round(x * 1000) / 1000;

// Gợi ý số pallet theo quy cách mã hàng
export function suggestPallets(item, bags) {
  const per = n(item?.bagsPerLayer) * n(item?.layersPerPallet);
  return per && n(bags) ? Math.ceil((n(bags) / per) * 100) / 100 : '';
}
export function kgOf(item, bags) {
  return n(item?.bagWeight) && n(bags) ? n(item.bagWeight) * n(bags) : '';
}
export function ageDays(inDate) {
  if (!inDate) return null;
  return Math.floor((Date.now() - Date.parse(inDate + 'T00:00:00+07:00')) / 86400000);
}
