// Bỏ dấu tiếng Việt, chữ thường — dùng để so khớp tìm kiếm và tiêu đề cột Excel
export function norm(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Ô tìm kiếm: mọi từ gõ vào (không dấu) đều phải có trong các giá trị của dòng
export function matchQ(q, ...vals) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = norm(vals.flat(Infinity).filter((v) => v != null).join(' '));
  return words.every((w) => hay.includes(w));
}

// Quy ước số của công ty: dấu "," ngăn cách hàng nghìn, dấu "." thập phân (1,234.5)
export function fmtNum(n, digits = 0, minDigits = 0) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: Math.min(minDigits, digits) });
}

export function fmtDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = String(ymd).split('-');
  return d ? `${d}/${m}/${y}` : ymd;
}

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
}
