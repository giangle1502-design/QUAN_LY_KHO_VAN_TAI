import { collection, doc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { fmtNum } from './utils';

// ============================================================================
// Pallet xuất kèm hàng (pallet gỗ / pallet nhựa có mã trong danh mục `pallets`):
// - xuất cho khách hàng: trừ tồn pallet kho (khách giữ, đã tính vào giá hàng)
// - cho vận tải mượn: trừ tồn kho, cộng số đang mượn của đơn vị vận tải; vận tải trả thì nhập lại kho
// Tồn pallet theo kho: `palletStock/{kho__mã pallet}`; đang mượn: `palletCarrier/{vận tải__mã pallet}`;
// nhập / trả / điều chỉnh tay: `palletMoves`; pallet theo phiếu xuất lưu ngay trên phiếu (movements.pallets).
// ============================================================================

export const MATERIALS = ['Pallet nhựa', 'Pallet gỗ'];
export const PALLET_TO = { customer: 'Khách hàng giữ', carrier: 'Vận tải mượn', transfer: 'Chuyển theo hàng sang kho nhận' };
// Đơn hàng chỉ ghi Kiện (hàng có pallet, chưa biết gỗ hay nhựa) / Xá (hàng rời); thủ kho chọn loại pallet khi nhập, xuất
export const PACKINGS = ['Kiện', 'Xá'];
export const MODE_LABEL = { pallet: 'Kiện (có pallet)', xa: 'Xá (không pallet)' };

// Kho có quản lý tồn pallet không: trường "Quản lý pallet" Có / Không; bỏ trống thì kho tên có Đức Hòa, Bãi xe, 3-PL → Có
const AUTO_MANAGED = /đức\s*hòa|đức\s*hoà|duc\s*hoa|bãi\s*xe|bai\s*xe|3\s*-?\s*pl/i;
export function palletManaged(wh) {
  if (!wh) return false;
  if (wh.managePallets === 'Có') return true;
  if (wh.managePallets === 'Không') return false;
  return AUTO_MANAGED.test(`${wh.code || ''} ${wh.name || ''}`);
}

// Hình thức đóng gói của đơn (các dòng làm ở kho / theo bộ lọc): có dòng Kiện → 'pallet', toàn bộ Xá → 'xa', chưa ghi → ''
export function packingMode(o, keep = () => true) {
  const ps = (o?.lines || []).filter(keep).map((l) => l.packing).filter(Boolean);
  if (!ps.length) return '';
  return ps.includes('Kiện') ? 'pallet' : 'xa';
}
export const MOVE_KINDS = {
  in: 'Nhập pallet (mua / tồn đầu)',
  return: 'Vận tải trả pallet',
  adjust: 'Điều chỉnh tồn pallet',
  customer: 'Xuất cho khách hàng',
  lend: 'Cho vận tải mượn',
  customerReturn: 'Khách trả pallet',
  slipIn: 'Nhập kèm hàng Kiện (phiếu nhập)',
  transfer: 'Chuyển theo hàng sang kho khác (STO)',
};
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const clean = (s) => String(s ?? '').trim().replace(/\//g, '_');
export const palletStockId = (wh, code) => `${clean(wh)}__${clean(code)}`;
export const palletCarrierId = (carrier, code) => `${clean(carrier)}__${clean(code)}`;

// Pallet của phiếu xuất / nhập → biến động tồn kho pallet / số đang mượn (sign = -1 khi hủy)
// Kho không quản lý pallet (m.palletTracked === false): không ghi tồn pallet kho, chỉ ghi số vận tải mượn
export function palletEffects(m, sign = 1) {
  if (m.palletMode !== 'pallet' || !['in', 'out'].includes(m.type)) return [];
  const tracked = m.palletTracked !== false;
  const out = [];
  for (const p of m.pallets || []) {
    const q = n(p.qty) * sign;
    if (!p.code || !q) continue;
    if (m.type === 'in') {
      if (tracked) out.push({ kind: 'stock', id: palletStockId(m.warehouse, p.code), base: { warehouse: m.warehouse, code: p.code, name: p.name || '', material: p.material || '' }, d: q });
      continue;
    }
    if (tracked) out.push({ kind: 'stock', id: palletStockId(m.warehouse, p.code), base: { warehouse: m.warehouse, code: p.code, name: p.name || '', material: p.material || '' }, d: -q });
    if (p.to === 'carrier') {
      const c = p.carrier || m.carrier;
      out.push({ kind: 'carrier', id: palletCarrierId(c, p.code), base: { carrier: c, carrierName: p.carrierName || m.carrierName || c, code: p.code, name: p.name || '', material: p.material || '' }, d: q });
    }
  }
  return out;
}

// Đọc trước (giao dịch: đọc hết rồi mới ghi), trả về hàm ghi
export async function readPallets(tx, effects) {
  const by = new Map();
  for (const e of effects) {
    const k = `${e.kind}/${e.id}`;
    const cur = by.get(k) || { ...e, d: 0 };
    cur.d += e.d;
    by.set(k, cur);
  }
  const snaps = [];
  for (const e of by.values()) {
    if (Math.abs(e.d) < 1e-9) continue;
    snaps.push([e, await tx.get(doc(db, e.kind === 'stock' ? 'palletStock' : 'palletCarrier', e.id))]);
  }
  return (user, ref) => {
    const at = new Date().toISOString();
    for (const [e, s] of snaps) {
      const r = doc(db, e.kind === 'stock' ? 'palletStock' : 'palletCarrier', e.id);
      const qty = Math.round((n(s.exists() ? s.data().qty : 0) + e.d) * 1000) / 1000;
      if (s.exists()) tx.update(r, { qty, lastRef: ref, updatedAt: at, updatedBy: user.email });
      else tx.set(r, { ...e.base, qty, lastRef: ref, updatedAt: at, updatedBy: user.email });
    }
  };
}

// Kiểm tra lựa chọn pallet trên phiếu xuất / nhập (kind 'in': không có "giao cho ai")
export function palletError(v, m, kind = 'out', { managed = true } = {}) {
  if (!v.palletMode) return kind === 'in' ? 'Chọn hàng về là Kiện (có pallet) hay Xá (không pallet).' : 'Chọn hình thức xuất: Kiện (có pallet) hay Xá (không pallet).';
  // Kho không quản lý pallet: Kiện là đủ, không chọn loại / số pallet
  if (v.palletMode !== 'pallet' || !managed) return '';
  if (!v.pallets?.length) return 'Thêm dòng pallet.';
  for (const [i, p] of v.pallets.entries()) {
    if (!p.material) return `Pallet dòng ${i + 1}: kiểm tra và chọn pallet gỗ hay pallet nhựa.`;
    if (!p.code) return `Pallet dòng ${i + 1}: chọn mã pallet.`;
    if (!(n(p.qty) > 0)) return `Pallet dòng ${i + 1}: nhập số pallet.`;
    if (kind === 'in') continue;
    if (!p.to) return `Pallet dòng ${i + 1}: chọn pallet đi đâu (khách hàng giữ / vận tải mượn / chuyển kho).`;
    if (p.to === 'carrier' && !(p.carrier || m?.carrier)) return `Pallet dòng ${i + 1}: chọn đơn vị vận tải mượn pallet.`;
  }
  return '';
}

// Ghi gọn chọn lựa pallet để lưu trên phiếu
export function cleanPallets(v, m, kind = 'out', { managed = true } = {}) {
  if (v.palletMode !== 'pallet' || !managed) return { palletMode: v.palletMode || '', pallets: [] };
  return {
    palletMode: 'pallet',
    pallets: v.pallets.filter((p) => kind !== 'in' || p.code).map((p) => ({
      code: p.code, name: p.name || '', material: p.material || '', qty: n(p.qty), to: kind === 'in' ? 'in' : p.to,
      ...(p.to === 'carrier' ? { carrier: p.carrier || m?.carrier || '', carrierName: p.carrierName || m?.carrierName || '' } : {}),
    })),
  };
}

// Đổi / chọn hình thức xuất của phiếu đã lập (lúc in phiếu giao hàng): đảo pallet cũ, ghi pallet mới
export async function setSlipPallets(id, v, user, { managed = true } = {}) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, 'movements', id);
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error(`Không tìm thấy phiếu ${id}.`);
    const m = s.data();
    if (m.type !== 'out' || m.status === 'cancelled') throw new Error('Chỉ chọn pallet cho phiếu xuất chưa hủy.');
    const next = cleanPallets(v, m, 'out', { managed });
    // Phiếu chờ giải chấp chưa ghi tồn: pallet tính khi phiếu được ghi xuất
    const live = m.status === 'posted';
    const write = live ? await readPallets(tx, [...palletEffects(m, -1), ...palletEffects({ ...m, ...next }, 1)]) : null;
    const at = new Date().toISOString();
    if (write) write(user, id);
    tx.update(ref, { ...next, updatedAt: at, updatedBy: user.email,
      history: [...(m.history || []), { at, by: user.email, byName: user.name, action: `Hình thức xuất: ${next.palletMode === 'pallet' ? `Kiện, ${palletText(next)}` : 'Xá (không pallet)'}` }] });
  });
}

// Nhập / trả / điều chỉnh pallet tay
export async function postPalletMove(mv, user) {
  const q = n(mv.qty);
  if (!mv.code || !q) throw new Error('Chọn mã pallet và số lượng.');
  const eff = [];
  if (mv.kind === 'in' || mv.kind === 'adjust' || mv.kind === 'customerReturn') eff.push({ kind: 'stock', id: palletStockId(mv.warehouse, mv.code), base: { warehouse: mv.warehouse, code: mv.code, name: mv.name, material: mv.material }, d: q });
  if (mv.kind === 'return') {
    if (!mv.carrier) throw new Error('Chọn đơn vị vận tải trả pallet.');
    eff.push({ kind: 'stock', id: palletStockId(mv.warehouse, mv.code), base: { warehouse: mv.warehouse, code: mv.code, name: mv.name, material: mv.material }, d: q });
    eff.push({ kind: 'carrier', id: palletCarrierId(mv.carrier, mv.code), base: { carrier: mv.carrier, carrierName: mv.carrierName || mv.carrier, code: mv.code, name: mv.name, material: mv.material }, d: -q });
  }
  const ref = doc(collection(db, 'palletMoves'));
  await runTransaction(db, async (tx) => {
    // Kho không quản lý pallet: không ghi tồn pallet kho (vận tải trả thì chỉ giảm số đang mượn)
    const whSnap = mv.warehouse ? await tx.get(doc(db, 'warehouses', mv.warehouse)) : null;
    if (whSnap?.exists() && !palletManaged(whSnap.data())) {
      if (mv.kind !== 'return') throw new Error(`Kho ${mv.warehouse} không quản lý pallet (Danh sách kho → Quản lý pallet).`);
      eff.splice(0, eff.length, ...eff.filter((e) => e.kind !== 'stock'));
    }
    const write = await readPallets(tx, eff);
    write(user, ref.id);
    tx.set(ref, { ...mv, qty: q, id: ref.id, createdAt: new Date().toISOString(), createdBy: user.email, createdByName: user.name });
  });
  return ref.id;
}

export function palletText(v) {
  if (v?.palletMode !== 'pallet') return '';
  return (v.pallets || []).map((p) => `${p.name || p.code} ${fmtNum(p.qty)} cái${palletToText(p) ? ` (${palletToText(p)})` : ''}`).join('; ');
}
export function palletToText(p) {
  if (p.to === 'carrier') return `vận tải ${p.carrierName || p.carrier || ''} mượn, trả lại kho`;
  if (p.to === 'customer') return 'khách hàng giữ';
  if (p.to === 'transfer') return 'chuyển theo hàng sang kho nhận';
  return '';
}
