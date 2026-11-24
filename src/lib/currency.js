// Đơn vị tiền tệ của đơn SO / PO: VNĐ (mặc định) hoặc USD + tỷ giá.
// Giá nhập trên đơn USD là USD; Thành tiền (VNĐ) = số lượng × đơn giá × [Tỷ giá]. Đơn VNĐ: [Tỷ giá] = 1 trong công thức.
import { fieldResolver, parseFormula, refsOf } from './formula';

export const CURRENCIES = ['VNĐ', 'USD'];
export const isUSD = (o) => String(o?.currency || '').trim().toUpperCase() === 'USD';
// Hệ số quy đổi ra VNĐ của đơn (đơn cũ chưa có đơn vị tiền tệ = VNĐ)
export const fxOf = (o) => (isUSD(o) ? Number(o.fxRate) || 0 : 1);
// Đơn để tính công thức: đơn VNĐ thì [Tỷ giá] = 1 nên 1 công thức dùng được cho cả 2 loại tiền
export const withFx = (o) => ({ ...o, fxRate: isUSD(o) ? o.fxRate : 1 });

// Công thức có nhân tỷ giá (trực tiếp hoặc qua công thức khác / SUM) → kết quả là VNĐ
export function usesFx(f, lists, depth = 0) {
  if (!f || f.type !== 'formula' || !f.formula || depth > 5) return false;
  const find = fieldResolver(...lists);
  try {
    return refsOf(parseFormula(f.formula)).some((r) => {
      const x = find(r.replace(/^SUM:/, ''));
      return x && (x.key === 'fxRate' || headFxKey(x) === 'fxRate' || usesFx(x, lists, depth + 1));
    });
  } catch { return false; }
}

// Đơn vị hiển thị của 1 trường tiền trên đơn: đơn USD thì giá nhập tay là USD, công thức có nhân tỷ giá là VNĐ
export function moneyUnit(f, o, lists) {
  if (!isUSD(o)) return 'đ';
  if (f.type === 'currency') return 'USD';
  if (f.type === 'formula' && f.resultType === 'currency' && !usesFx(f, lists)) return 'USD';
  return 'đ';
}

// Trường tự thêm ở dòng hàng trùng nghĩa với Đơn vị tiền tệ / Tỷ giá của phần chung (vd. "Đơn vị tiền tệ", "Loại tiền", "Tỷ giá"):
// luôn lấy theo phần chung, không nhập riêng từng dòng → cả đơn chỉ một loại tiền, một tỷ giá
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
export function headFxKey(f) {
  if (!f || f.key === 'currency' || f.key === 'fxRate' || f.type === 'formula') return null;
  const s = plain(`${f.label} ${f.key}`);
  if (/ty gia|fx ?rate|exchange/.test(s)) return 'fxRate';
  if (/tien te|loai tien|currency/.test(s) && !['number', 'currency', 'percent'].includes(f.type)) return 'currency';
  return null;
}
// Dòng hàng sau khi chép đơn vị tiền tệ / tỷ giá của phần chung xuống (đơn VNĐ: tỷ giá = 1)
export function mirrorHeadFx(lineFields, line, head) {
  const fs = lineFields.filter(headFxKey);
  if (!fs.length) return line;
  const out = { ...line };
  for (const f of fs) out[f.key] = headFxKey(f) === 'currency' ? (isUSD(head) ? 'USD' : 'VNĐ') : isUSD(head) ? (head.fxRate === '' || head.fxRate == null ? '' : Number(head.fxRate)) : 1;
  return out;
}
