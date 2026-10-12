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
      return x && (x.key === 'fxRate' || usesFx(x, lists, depth + 1));
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
