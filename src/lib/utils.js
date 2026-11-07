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

// ----------------------------------------------------------------------------
// Định dạng hiển thị riêng của từng người dùng (⚙ Cài đặt hiển thị): kiểu ngày, giờ, dấu thập phân, dấu hàng nghìn.
// Mặc định theo quy ước công ty: 1,234.5 · 31/12/2026 · 14:30. Chỉ đổi cách HIỂN THỊ, dữ liệu lưu không đổi.
// ----------------------------------------------------------------------------
export const DEFAULT_FORMAT = { date: 'dd/MM/yyyy', time: 'HH:mm', dec: '.', group: ',' };
export const DATE_FORMATS = ['dd/MM/yyyy', 'dd-MM-yyyy', 'dd.MM.yyyy', 'd/M/yyyy', 'dd/MM/yy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'yyyy/MM/dd'];
export const TIME_FORMATS = [['HH:mm', '24 giờ (14:30)'], ['HH:mm:ss', '24 giờ có giây (14:30:05)'], ['hh:mm a', '12 giờ (02:30 CH)'], ['hh:mm:ss a', '12 giờ có giây (02:30:05 CH)']];
export const DEC_SEPS = [['.', 'Dấu chấm  .'], [',', 'Dấu phẩy  ,']];
export const GROUP_SEPS = [[',', 'Dấu phẩy  ,'], ['.', 'Dấu chấm  .'], [' ', 'Khoảng trắng'], ["'", "Dấu nháy  '"], ['', 'Không ngăn cách']];
let FMT = { ...DEFAULT_FORMAT };
export const getFormat = () => FMT;
export function setFormat(f) {
  FMT = { ...DEFAULT_FORMAT, ...(f || {}) };
  if (FMT.group === FMT.dec) FMT.group = FMT.dec === ',' ? '.' : ',';
}

// Số: dấu ngăn cách theo cài đặt của người dùng
export function fmtNum(n, digits = 0, minDigits = 0) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '';
  const s = Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: Math.min(minDigits, digits) });
  if (FMT.dec === '.' && FMT.group === ',') return s;
  return s.replace(/[,.]/g, (c) => (c === ',' ? FMT.group : FMT.dec));
}

const pad = (x) => String(x).padStart(2, '0');
function applyDate(pattern, y, m, d) {
  return pattern.replace(/yyyy|yy|MM|M|dd|d/g, (t) => ({ yyyy: y, yy: String(y).slice(-2), MM: pad(m), M: String(Number(m)), dd: pad(d), d: String(Number(d)) }[t]));
}
// Ngày lưu dạng yyyy-mm-dd → hiển thị theo kiểu ngày đã chọn
export function fmtDate(ymd) {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd));
  return m ? applyDate(FMT.date, m[1], m[2], m[3]) : String(ymd);
}
// Ngày + tháng (bỏ năm), vd. 31/12 hoặc 12-31
export function fmtDayMonth(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return '';
  const p = FMT.date.replace(/^y+[^dMy]+|[^dMy]+y+$/, '');
  return applyDate(p, m[1], m[2], m[3]);
}
// Giờ phút (giây) theo kiểu giờ đã chọn
export function fmtClock(h, mi, sec = 0) {
  const t = FMT.time;
  const h12 = Number(h) % 12 || 12;
  return t.replace(/HH|hh|mm|ss|a/g, (k) => ({ HH: pad(h), hh: pad(h12), mm: pad(mi), ss: pad(sec), a: Number(h) < 12 ? 'SA' : 'CH' }[k]));
}
// Thời điểm (ISO / Date / Timestamp Firestore) theo giờ Việt Nam
export function vnParts(v) {
  const d = v?.toDate ? v.toDate() : v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}
export function fmtDateTime(v, { year = true } = {}) {
  if (!v) return '';
  const p = vnParts(v);
  if (!p) return String(v);
  return `${year ? fmtDate(p.ymd) : fmtDayMonth(p.ymd)} ${fmtClock(p.h, p.mi, p.s)}`;
}
export function fmtTimeOnly(v) {
  const p = v ? vnParts(v) : null;
  return p ? fmtClock(p.h, p.mi, p.s) : '';
}

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
}
