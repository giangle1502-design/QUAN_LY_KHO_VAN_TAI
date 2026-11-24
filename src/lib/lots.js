import { kgOf, suggestPallets } from './stock';
import { toNumber, toYmd } from './excel';

const n = (v) => Number(v) || 0;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ===== Thứ tự lấy hàng khi xuất: FIFO theo vị trí, trong 1 vị trí lot ít trước =====
// Thực tế kho: 1 cont về 1 mã hàng → để chung 1 vị trí; lot nhiều xếp vào trong cùng, lot ít xếp phía ngoài.
// Nên khi xuất: vị trí nhập trước lấy trước (FIFO), lấy hết vị trí này rồi mới sang vị trí khác;
// trong cùng 1 vị trí + mã hàng: lot còn ít (kg) lấy trước, lot nhiều lấy sau.
// rows: toàn bộ dòng tồn đang xét (để biết ngày nhập sớm nhất của từng vị trí)
const locKey = (r) => [r.warehouse || '', r.location || '', r.item || ''].join('|');
export function lotPickOrder(rows) {
  const first = new Map();
  for (const r of rows || []) {
    const k = locKey(r);
    const d = String(r.inDate || '');
    if (!first.has(k) || d < first.get(k)) first.set(k, d);
  }
  const fd = (r) => (first.has(locKey(r)) ? first.get(locKey(r)) : String(r.inDate || ''));
  return (a, b) => fd(a).localeCompare(fd(b))
    || String(a.location || '').localeCompare(String(b.location || ''))
    || n(a.kg) - n(b.kg)
    || String(a.inDate || '').localeCompare(String(b.inDate || ''))
    || String(a.lot || '').localeCompare(String(b.lot || ''));
}

// Mã hàng tích "Bắt buộc quản lý lot": nhận hàng phải ghi lot, xuất phải lấy đúng lot.
// Mã khác: lot chỉ để tham khảo, không bắt buộc chính xác 100%.
export const lotRequired = (it) => !!it?.lotRequired;
export const LOT_REQ_HINT = 'Mã hàng bắt buộc quản lý lot: phải ghi lot khi nhận hàng, khi xuất phải lấy đúng lot ghi trên phiếu soạn hàng.';

// ===== Danh sách lot NCC gửi trước (dán từ Excel hoặc nhập file) =====
export const LOT_LIST_HEADERS = ['Lot', 'Số kg', 'Số bao', 'Số pallet', 'NSX', 'HSD'];
export const LOT_LIST_NOTES = [
  'Kiểu: Chữ. BẮT BUỘC. Số lot theo packing list / danh sách NCC gửi. Ví dụ: L240115A',
  'Kiểu: Số (kg). Bắt buộc nhập Số kg hoặc Số bao. Để trống thì tính từ Số bao × trọng lượng bao. Ví dụ: 24750',
  'Kiểu: Số. Không bắt buộc. Để trống thì tính từ Số kg ÷ trọng lượng bao. Ví dụ: 990',
  'Kiểu: Số. Không bắt buộc. Để trống thì tính theo quy cách mã hàng (số bao/pallet). Ví dụ: 18',
  'Kiểu: Ngày (dd/mm/yyyy). Không bắt buộc, chỉ dùng cho mã hàng quản lý NSX/HSD. Ví dụ: 15/01/2026',
  'Kiểu: Ngày (dd/mm/yyyy). Không bắt buộc, chỉ dùng cho mã hàng quản lý NSX/HSD. Ví dụ: 15/01/2028',
];

// rows: mảng các dòng (mảng ô) từ Excel hoặc chữ dán (tách bằng Tab / ;). Dòng tiêu đề tự bỏ qua.
// Trả về { lots: [{ lot, kg, bags, pallets, mfgDate, expDate }], errors: [] }
export function parseLotRows(rows, item) {
  const lots = [];
  const errors = [];
  const bagW = n(item?.bagWeight);
  rows.forEach((cells, i) => {
    const c = (cells || []).map((x) => (x instanceof Date ? x : String(x ?? '').trim()));
    if (!c.some((x) => x !== '')) return;
    const lot = String(c[0] ?? '').trim();
    const kg0 = toNumber(c[1]);
    const bags0 = toNumber(c[2]);
    const pal0 = toNumber(c[3]);
    // Dòng tiêu đề (không có số nào ở cột số lượng)
    if (i === 0 && ![c[1], c[2], c[3]].some((x) => x instanceof Date || /\d/.test(String(x ?? '')))) return;
    const no = `Dòng ${i + 1}: `;
    if (!lot) { errors.push(no + 'thiếu số lot.'); return; }
    let kg = kg0 != null ? kg0 : null;
    let bags = bags0 != null ? bags0 : null;
    if (kg == null && bags != null && bagW) kg = n(kgOf(item, bags));
    if (bags == null && kg != null && bagW) bags = r3(kg / bagW);
    if (!n(kg) && !n(bags) && !n(pal0)) { errors.push(no + `lot ${lot} thiếu số kg / số bao.`); return; }
    const pallets = pal0 != null ? pal0 : (bags != null ? suggestPallets(item, bags) : '');
    lots.push({ lot, kg: kg ?? '', bags: bags ?? '', pallets: pallets ?? '', mfgDate: toYmd(c[4]), expDate: toYmd(c[5]) });
  });
  return { lots, errors };
}

export const splitPasted = (text) => String(text || '').split(/\r?\n/).map((s) => s.split(/\t|;/));

// Thay dòng thứ `at` trên phiếu (và các dòng cùng mã hàng, cùng phiếu con / đơn với nó) bằng 1 dòng / lot,
// giữ vị trí, tình trạng, bên nhận thế chấp, dòng đơn… của dòng `at`.
// Lot nhiều đứng trước: nhãn in trước, đưa vào bên trong vị trí trước; lot ít in sau, nằm phía ngoài (xuất trước).
export function applyLotList(lines, at, lots) {
  const base = lines[at];
  if (!base) return lines;
  const same = (l) => l.item === base.item && (l._mv || '') === (base._mv || '') && (l.orderId || '') === (base.orderId || '');
  const { kgTxt, plannedKg, ...tpl } = base; // eslint-disable-line no-unused-vars
  const planned = lines.filter(same).reduce((a, l) => (l.plannedKg != null ? a + n(l.plannedKg) : a), 0);
  const hasPlan = lines.some((l) => same(l) && l.plannedKg != null);
  const sorted = [...lots].sort((a, b) => n(b.kg) - n(a.kg) || n(b.bags) - n(a.bags));
  const add = sorted.map((x, k) => ({ ...tpl, ...(k === 0 && hasPlan ? { plannedKg: planned } : {}), lot: x.lot, kg: x.kg, bags: x.bags, pallets: x.pallets,
    mfgDate: x.mfgDate || tpl.mfgDate || '', expDate: x.expDate || tpl.expDate || '' }));
  const first = lines.findIndex(same);
  const before = lines.slice(0, first).filter((l) => !same(l));
  const after = lines.slice(first).filter((l) => !same(l));
  return [...before, ...add, ...after];
}
