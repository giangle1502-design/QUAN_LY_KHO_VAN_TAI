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
export const PALLET_TO = { customer: 'Khách hàng giữ', carrier: 'Vận tải mượn' };
export const MOVE_KINDS = {
  in: 'Nhập pallet (mua / tồn đầu)',
  return: 'Vận tải trả pallet',
  adjust: 'Điều chỉnh tồn pallet',
  customer: 'Xuất cho khách hàng',
  lend: 'Cho vận tải mượn',
  customerReturn: 'Khách trả pallet',
};
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const clean = (s) => String(s ?? '').trim().replace(/\//g, '_');
export const palletStockId = (wh, code) => `${clean(wh)}__${clean(code)}`;
export const palletCarrierId = (carrier, code) => `${clean(carrier)}__${clean(code)}`;

// Pallet của phiếu xuất → biến động tồn kho pallet / số đang mượn (sign = -1 khi hủy)
export function palletEffects(m, sign = 1) {
  if (m.palletMode !== 'pallet') return [];
  const out = [];
  for (const p of m.pallets || []) {
    const q = n(p.qty) * sign;
    if (!p.code || !q) continue;
    out.push({ kind: 'stock', id: palletStockId(m.warehouse, p.code), base: { warehouse: m.warehouse, code: p.code, name: p.name || '', material: p.material || '' }, d: -q });
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

// Kiểm tra lựa chọn pallet trên phiếu xuất
export function palletError(v, m) {
  if (!v.palletMode) return 'Chọn hình thức xuất: xuất xá hoặc xuất kèm pallet.';
  if (v.palletMode !== 'pallet') return '';
  if (!v.pallets?.length) return 'Thêm dòng pallet.';
  for (const [i, p] of v.pallets.entries()) {
    if (!p.code) return `Pallet dòng ${i + 1}: chọn mã pallet.`;
    if (!(n(p.qty) > 0)) return `Pallet dòng ${i + 1}: nhập số lượng.`;
    if (!p.to) return `Pallet dòng ${i + 1}: chọn xuất cho khách hàng hay vận tải mượn.`;
    if (p.to === 'carrier' && !(p.carrier || m?.carrier)) return `Pallet dòng ${i + 1}: chọn đơn vị vận tải mượn pallet.`;
  }
  return '';
}

// Ghi gọn chọn lựa pallet để lưu trên phiếu
export function cleanPallets(v, m) {
  if (v.palletMode !== 'pallet') return { palletMode: v.palletMode || '', pallets: [] };
  return {
    palletMode: 'pallet',
    pallets: v.pallets.map((p) => ({
      code: p.code, name: p.name || '', material: p.material || '', qty: n(p.qty), to: p.to,
      ...(p.to === 'carrier' ? { carrier: p.carrier || m?.carrier || '', carrierName: p.carrierName || m?.carrierName || '' } : {}),
    })),
  };
}

// Đổi / chọn hình thức xuất của phiếu đã lập (lúc in phiếu giao hàng): đảo pallet cũ, ghi pallet mới
export async function setSlipPallets(id, v, user) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, 'movements', id);
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error(`Không tìm thấy phiếu ${id}.`);
    const m = s.data();
    if (m.type !== 'out' || m.status === 'cancelled') throw new Error('Chỉ chọn pallet cho phiếu xuất chưa hủy.');
    const next = cleanPallets(v, m);
    // Phiếu chờ giải chấp chưa ghi tồn: pallet tính khi phiếu được ghi xuất
    const live = m.status === 'posted';
    const write = live ? await readPallets(tx, [...palletEffects(m, -1), ...palletEffects({ ...m, ...next }, 1)]) : null;
    const at = new Date().toISOString();
    if (write) write(user, id);
    tx.update(ref, { ...next, updatedAt: at, updatedBy: user.email,
      history: [...(m.history || []), { at, by: user.email, byName: user.name, action: `Hình thức xuất: ${palletText(next) || 'xuất xá'}` }] });
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
    const write = await readPallets(tx, eff);
    write(user, ref.id);
    tx.set(ref, { ...mv, qty: q, id: ref.id, createdAt: new Date().toISOString(), createdBy: user.email, createdByName: user.name });
  });
  return ref.id;
}

export function palletText(v) {
  if (v?.palletMode !== 'pallet') return '';
  return (v.pallets || []).map((p) => `${p.name || p.code} ${fmtNum(p.qty)} cái (${p.to === 'carrier' ? `vận tải ${p.carrierName || p.carrier || ''} mượn` : 'khách hàng giữ'})`).join('; ');
}
