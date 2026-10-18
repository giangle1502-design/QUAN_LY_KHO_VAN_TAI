import { doc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { catalogByKey } from '../catalogs';
import { applyOrder, applyPoReturn, drtToSo, summarizeLines } from './orders';
import { palletEffects, palletManaged, readPallets } from './pallets';

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
  // Công ty chủ hàng là 1 phần của dòng tồn (cùng mã, lot, vị trí nhưng khác công ty = 2 dòng)
  return [k.warehouse, k.location, k.item, k.lot || '-', st, ...(k.company ? [k.company] : [])].map(clean).join('__');
}
export const locationId = (wh, loc) => `${clean(wh)}__${clean(loc)}`;

// Phiếu → danh sách biến động tồn (sign = -1 khi hủy phiếu)
export function effectsOf(m, sign = 1) {
  const out = [];
  const base = (l, o = {}) => ({
    warehouse: m.warehouse, location: l.location, item: l.item, itemName: l.itemName || '',
    lot: l.lot || '', mfgDate: l.mfgDate || '', expDate: l.expDate || '', inDate: l.inDate || m.date,
    goodsStatus: l.goodsStatus || 'KTC', pledgee: l.goodsStatus === 'HTC' ? l.pledgee || '' : '', company: l.company ?? m.company ?? '', ...o,
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

// Cấp số phiếu theo Quy tắc mã tự sinh (trong giao dịch)
async function nextNo(tx, code) {
  const ref = doc(db, 'codeRules', code);
  const snap = await tx.get(ref);
  const seed = catalogByKey('codeRules').seed.find((s) => s.code === code);
  const rule = snap.exists() ? snap.data() : seed;
  const num = Number(rule.next) || 1;
  const id = `${rule.prefix ?? code}${String(num).padStart(Number(rule.digits) || 6, '0')}`;
  // Ghi sau cùng (Firestore: đọc hết rồi mới ghi)
  const bump = () => (snap.exists() ? tx.update(ref, { next: num + 1 }) : tx.set(ref, { ...seed, next: num + 1 }));
  return { id, bump };
}

// Ghi phiếu mới: cấp số, kiểm tra tồn/vị trí/tình trạng, cập nhật tồn và pallet vị trí
// newOrder (nhập trực tiếp): lập luôn đơn mua PO đã nhận đủ theo đúng các dòng phiếu, trong cùng giao dịch
export async function postMovement(m, user, { newOrder } = {}) {
  return runTransaction(db, async (tx) => {
    const no = await nextNo(tx, MOVE_TYPES[m.type].code);
    const at = new Date().toISOString();
    const mv = { ...m, id: no.id, status: 'posted', createdAt: at, createdBy: user.email, createdByName: user.name,
      history: [{ at, by: user.email, byName: user.name, action: 'Lập phiếu' }] };
    return commit(tx, mv, user, at, newOrder, no.bump);
  });
}

// Phiếu nhập 2 bước: quản trị lập và in phiếu (chưa vào tồn), thủ kho nhận hàng thực tế rồi xác nhận
export async function createPendingIn(m, user) {
  return runTransaction(db, async (tx) => {
    const no = await nextNo(tx, 'PN');
    const at = new Date().toISOString();
    no.bump();
    tx.set(doc(db, 'movements', no.id), { ...m, type: 'in', id: no.id, status: 'pending', createdAt: at, createdBy: user.email, createdByName: user.name,
      history: [{ at, by: user.email, byName: user.name, action: 'Lập phiếu, chờ thủ kho nhận hàng' }] });
    return no.id;
  });
}
// Phiếu xuất bán có hàng HTC: lưu "Chờ giải chấp" (chưa trừ tồn) để in phiếu, soạn hàng;
// khi lập lệnh giải chấp, các dòng HTC đổi sang DGC rồi phiếu mới được ghi tồn (postWaitingOut)
export async function createWaitingOut(m, user) {
  return runTransaction(db, async (tx) => {
    const no = await nextNo(tx, 'PX');
    const at = new Date().toISOString();
    no.bump();
    tx.set(doc(db, 'movements', no.id), { ...m, type: 'out', id: no.id, status: 'wait_release', createdAt: at, createdBy: user.email, createdByName: user.name,
      history: [{ at, by: user.email, byName: user.name, action: 'Lập phiếu, chờ giải chấp hàng HTC' }] });
    return no.id;
  });
}
export async function postWaitingOut(id, user) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, 'movements', id));
    if (!snap.exists()) throw new Error(`Không tìm thấy phiếu ${id}.`);
    const cur = snap.data();
    if (cur.status !== 'wait_release') throw new Error(`Phiếu ${id} không còn chờ giải chấp.`);
    if (cur.lines.some((l) => l.goodsStatus === 'HTC')) throw new Error(`Phiếu ${id} còn dòng hàng HTC chưa giải chấp.`);
    const at = new Date().toISOString();
    const mv = { ...cur, status: 'posted', confirmedBy: user.email, confirmedByName: user.name, confirmedAt: at,
      history: [...(cur.history || []), { at, by: user.email, byName: user.name, action: 'Đã giải chấp hết hàng HTC: ghi xuất kho' }] };
    return commit(tx, mv, user, at, null, null);
  });
}

// Thủ kho xác nhận: số thực nhận, lot, vị trí… → ghi tồn, cập nhật đơn (nhập trực tiếp: lập PO theo số thực nhận)
export async function confirmIn(id, lines, user, patch = {}) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, 'movements', id));
    if (!snap.exists()) throw new Error(`Không tìm thấy phiếu ${id}.`);
    const cur = snap.data();
    if (cur.status !== 'pending') throw new Error(`Phiếu ${id} đã ${cur.status === 'cancelled' ? 'bị hủy' : 'được xác nhận'}.`);
    const at = new Date().toISOString();
    const mv = { ...cur, ...patch, lines, status: 'posted', confirmedBy: user.email, confirmedByName: user.name, confirmedAt: at,
      history: [...(cur.history || []), { at, by: user.email, byName: user.name, action: 'Thủ kho xác nhận đã nhận hàng' }] };
    return commit(tx, mv, user, at, cur.directPO || null, null);
  });
}

async function commit(tx, mv, user, at, newOrder, bump) {
  const id = mv.id;
  let direct = null;
  if (newOrder) {
    const po = await nextNo(tx, 'PO');
    // Gộp dòng phiếu theo mã hàng + tình trạng thành dòng PO
    const keys = new Map();
    const lines = [];
    mv.lines = mv.lines.map((l) => {
      const key = `${l.item}|${l.goodsStatus}`;
      if (!keys.has(key)) {
        keys.set(key, lines.length + 1);
        lines.push({ no: lines.length + 1, item: l.item, itemName: l.itemName || '', qtyKg: 0, doneKg: 0, dueDate: mv.date, warehouse: mv.warehouse, goodsStatus: l.goodsStatus || '', note: '' });
      }
      const ol = lines[keys.get(key) - 1];
      ol.qtyKg = round(ol.qtyKg + n(l.kg));
      ol.doneKg = ol.qtyKg;
      return { ...l, orderLine: ol.no };
    });
    mv.orderId = po.id; mv.orderType = 'PO'; mv.orderRef = newOrder.refNo || '';
    direct = { po, order: {
      ...newOrder, type: 'PO', id: po.id, direct: true, lines, nextLineNo: lines.length + 1, ...summarizeLines(lines), status: 'done', lastMovement: id,
      createdAt: at, createdBy: user.email, updatedAt: at, updatedBy: user.email,
      history: [{ at, by: user.email, byName: user.name, action: `Lập đơn khi nhập kho trực tiếp (phiếu ${id})` }] } };
  }
  const orderRef = mv.orderId && !direct ? doc(db, 'orders', mv.orderId) : null;
  const orderSnap = orderRef ? await tx.get(orderRef) : null;
  if (orderRef && !orderSnap.exists()) throw new Error(`Không tìm thấy đơn ${mv.orderId}.`);
  if (orderSnap) mv.orderType = orderSnap.data().type;
  const orderUpd = orderRef ? applyOrder({ ...orderSnap.data(), id: mv.orderId }, mv, 1) : null;
  // Phiếu nhập theo SO trả hàng (DRT): ghi luôn "khách trả về" của SO gốc
  const soLink = orderSnap ? await readDrtSo(tx, { ...orderSnap.data(), id: mv.orderId }, mv, 1) : null;
  // Pallet nhập / xuất kèm hàng: chỉ ghi tồn pallet ở kho có "Quản lý pallet"; đọc trước, ghi sau cùng
  let writePallets = null;
  if (mv.type === 'out' || mv.type === 'in') {
    const whSnap = await tx.get(doc(db, 'warehouses', mv.warehouse));
    mv.palletTracked = whSnap.exists() ? palletManaged(whSnap.data()) : false;
    writePallets = await readPallets(tx, palletEffects(mv, 1));
  }
  await applyEffects(tx, mv, effectsOf(mv, 1), user);
  if (writePallets) writePallets(user, id);
  if (direct) {
    tx.set(doc(db, 'orders', direct.order.id), direct.order);
    direct.po.bump();
  }
  if (orderRef) tx.update(orderRef, { ...orderUpd, lastMovement: id, updatedAt: at, updatedBy: user.email });
  if (soLink) soLink.write(id, at, user);
  if (bump) bump();
  tx.set(doc(db, 'movements', id), mv);
  return direct ? { id, orderId: direct.order.id } : id;
}

// Phiếu nhập theo DRT: đọc SO gốc (trước mọi lệnh ghi của giao dịch), trả về hàm ghi "khách trả về" lên dòng SO.
// sign = +1 ghi phiếu, −1 hủy phiếu; then (khi sửa phiếu) = phiếu mới ghi lại sau khi đảo phiếu cũ
// Phiếu xuất theo RTV (trả hàng NCC): tương tự, ghi "đã trả NCC" lên dòng PO gốc
async function readDrtSo(tx, order, m, sign, then = null) {
  const rtv = order.type === 'RTV';
  const srcId = rtv ? order.originalPoId : order.type === 'DRT' ? order.originalSoId : '';
  if (!srcId) return null;
  const ref = doc(db, 'orders', srcId);
  const snap = await tx.get(ref);
  if (!snap.exists()) return null;
  const so = { ...snap.data(), id: srcId };
  const step = (base, mv, sg) => (rtv ? applyPoReturn(base, order, mv, sg) : applyOrder(base, drtToSo(order, mv), sg));
  let upd = step(so, m, sign);
  if (then) upd = step({ ...so, lines: upd.lines }, then, 1);
  return {
    // Thủ kho chỉ được đổi lines / lastMovement / updatedAt / updatedBy của SO (quy tắc Firestore)
    write: (mid, at, user) => tx.update(ref, { lines: upd.lines, lastMovement: mid, updatedAt: at, updatedBy: user.email }),
  };
}

// Hủy phiếu (quản trị): đảo ngược toàn bộ biến động
export async function cancelMovement(m, reason, user) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, 'movements', m.id);
    const cur = await tx.get(ref);
    if (!cur.exists() || cur.data().status === 'cancelled') throw new Error('Phiếu đã bị hủy.');
    const at0 = new Date().toISOString();
    // Phiếu chờ nhận hàng / chờ giải chấp chưa vào tồn: chỉ đánh dấu hủy
    if (['pending', 'wait_release'].includes(cur.data().status)) {
      tx.update(ref, { status: 'cancelled', cancelReason: reason, cancelledAt: at0, cancelledBy: user.email,
        history: [...(m.history || []), { at: at0, by: user.email, byName: user.name, action: `Hủy phiếu: ${reason}` }] });
      return;
    }
    const orderRef = m.orderId ? doc(db, 'orders', m.orderId) : null;
    const orderSnap = orderRef ? await tx.get(orderRef) : null;
    const orderUpd = orderSnap?.exists() ? applyOrder({ ...orderSnap.data(), id: m.orderId }, m, -1) : null;
    const soLink = orderSnap?.exists() ? await readDrtSo(tx, { ...orderSnap.data(), id: m.orderId }, m, -1) : null;
    const cur0 = cur.data();
    const writePallets = ['in', 'out'].includes(cur0.type) ? await readPallets(tx, palletEffects(cur0, -1)) : null;
    await applyEffects(tx, { ...m, id: m.id }, effectsOf(m, -1), user);
    if (writePallets) writePallets(user, m.id);
    const at = new Date().toISOString();
    if (orderUpd) tx.update(orderRef, { ...orderUpd, lastMovement: m.id, updatedAt: at, updatedBy: user.email });
    if (soLink) soLink.write(m.id, at, user);
    tx.update(ref, { status: 'cancelled', cancelReason: reason, cancelledAt: at, cancelledBy: user.email,
      history: [...(m.history || []), { at, by: user.email, byName: user.name, action: `Hủy phiếu: ${reason}` }] });
  });
}

// Sửa phiếu đã lập (DO / phiếu nhập): đổi ngày, số chứng từ, ghi chú, mã giao và số lượng từng dòng (bỏ dòng = số lượng 0).
// Phiếu chưa ghi tồn (chờ nhận / chờ giải chấp): chỉ ghi lại phiếu, phần "đang chờ" của đơn tự tính lại.
// Phiếu đã ghi tồn: trong 1 giao dịch đảo số cũ, ghi số mới vào tồn kho, pallet vị trí và "đã giao / đã nhận" của SO / PO / STO.
export async function editMovement(id, patch, reason, user) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, 'movements', id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error(`Không tìm thấy phiếu ${id}.`);
    const old = { ...snap.data(), id };
    if (old.status === 'cancelled') throw new Error(`Phiếu ${id} đã hủy, không sửa được.`);
    const at = new Date().toISOString();
    const lines = (patch.lines || old.lines).filter((l) => n(l.kg) > EPS || n(l.bags) > EPS);
    if (!lines.length) throw new Error('Phiếu phải còn ít nhất 1 dòng. Muốn bỏ cả phiếu thì dùng Hủy phiếu.');
    const before = (old.lines || []).reduce((a, l) => a + n(l.kg), 0);
    const after = lines.reduce((a, l) => a + n(l.kg), 0);
    const what = `Sửa phiếu${reason ? `: ${reason}` : ''} (${round(before)} → ${round(after)} kg)`;
    const next = { ...old, ...patch, lines, id, updatedAt: at, updatedBy: user.email, editedAt: at,
      history: [...(old.history || []), { at, by: user.email, byName: user.name, action: what }] };
    if (old.status !== 'posted') { tx.set(ref, next); return { old, next }; }
    const orderRef = old.orderId ? doc(db, 'orders', old.orderId) : null;
    const orderSnap = orderRef ? await tx.get(orderRef) : null;
    let orderUpd = null;
    let soLink = null;
    if (orderSnap?.exists() && ['DRT', 'RTV'].includes(orderSnap.data().type)) soLink = await readDrtSo(tx, { ...orderSnap.data(), id: old.orderId }, old, -1, next);
    if (orderSnap?.exists()) {
      const ord = { ...orderSnap.data(), id: old.orderId };
      const back = applyOrder(ord, old, -1);
      // Đơn đã đóng vẫn cho sửa phiếu đã lập (giữ trạng thái đóng)
      const reopened = ord.status === 'closed' ? 'partial' : back.status;
      const fwd = applyOrder({ ...ord, lines: back.lines, status: reopened }, next, 1);
      orderUpd = { lines: fwd.lines, status: ord.status === 'closed' ? 'closed' : fwd.status,
        history: [...(ord.history || []), { at, by: user.email, byName: user.name, action: `${what} — phiếu ${id}` }] };
    }
    const writePallets = ['in', 'out'].includes(old.type) ? await readPallets(tx, [...palletEffects(old, -1), ...palletEffects(next, 1)]) : null;
    await applyEffects(tx, next, [...effectsOf(old, -1), ...effectsOf(next, 1)], user);
    if (writePallets) writePallets(user, id);
    if (orderUpd) tx.update(orderRef, { ...orderUpd, lastMovement: id, updatedAt: at, updatedBy: user.email });
    if (soLink) soLink.write(id, at, user);
    tx.set(ref, next);
    return { old, next };
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
  // Xuất bán (SO / xuất lẻ) chỉ được hàng tình trạng cho phép xuất (KTC, DGC); STO chuyển kho được mọi tình trạng (kể cả HTC)
  const statusCodes = mv.orderType === 'STO' ? [] : [...new Set(effects.filter((e) => e.ship).map((e) => e.goodsStatus))];

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
      throw new Error(`Hàng tình trạng ${c} (${s.data().name}) bị khóa xuất kho. Lập đề nghị giải chấp (Kho → Đề nghị giải chấp → tab Hàng thiếu) để chuyển sang DGC trước.`);
  }
  const locDelta = new Map();
  for (const [id, e] of byStock) {
    const lid = locationId(e.warehouse, e.location);
    const ls = locSnaps.get(lid);
    if (!ls.exists()) throw new Error(`Vị trí ${e.location} không có trong kho ${e.warehouse}.`);
    if (e.receive && e.dPallets > EPS && ls.data().locked) throw new Error(`Vị trí ${e.location} đang bị khóa.`);
    if (e.ship && !['STO', 'RTV'].includes(mv.orderType) && ls.data().blockStock)
      throw new Error(`Hàng ${e.item} lot ${e.lot || '-'} đang ở khu hàng block (${e.location}): không xuất bán được. Chuyển sang vị trí thường trước khi xuất.`);
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
      warehouse: e.warehouse, company: e.company || '', location: e.location, item: e.item, itemName: e.itemName, lot: e.lot,
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
