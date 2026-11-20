import { catalogByKey } from '../catalogs';
import { keyFieldsOf } from './fields';
import { norm } from './utils';

// ---------------------------------------------------------------------------
// Ghi chú hướng dẫn trên từng cột của file Excel mẫu danh mục + đọc giá trị Danh sách chọn khi nhập
// ---------------------------------------------------------------------------

// Ví dụ theo mã trường (dùng chung cho mọi danh mục)
const EXAMPLES = {
  code: 'KH000123', name: 'Công ty TNHH Nhựa ABC', taxCode: '0312345678', phone: '028 3812 3456', mobile: '0903 123 456',
  fax: '028 3812 3457', email: 'ketoan@abc.vn', billingAddress: '12 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM', taxAddress: '12 Nguyễn Huệ, Q.1, TP.HCM',
  representativeName: 'Nguyễn Văn A', businessLine: 'Bao bì nhựa', partnerGroup: 'KH chiến lược', keywords: 'ABC, Nhựa ABC',
  creditLimit: '500,000,000', note: 'Giao giờ hành chính', address: '12 Nguyễn Huệ, Q.1, TP.HCM',
};

const TYPE_TEXT = {
  text: 'Chữ', textarea: 'Chữ (xuống dòng trong ô: Alt+Enter)', number: 'Số', currency: 'Số tiền (VNĐ)', percent: 'Phần trăm, ghi số (10 = 10%)',
  date: 'Ngày', datetime: 'Ngày giờ', checkbox: 'Có / Không', select: 'Danh sách chọn', ref: 'Mã trong danh mục', multiref: 'Nhiều mã trong danh mục',
  email: 'Email', phone: 'Số điện thoại (gõ dạng chữ để giữ số 0 đầu)', url: 'Đường link',
};

// Giá trị gõ thêm được chấp nhận cho một số lựa chọn (ngoài mã và tên hiển thị)
const ALIASES = {
  active: ['dang dung', 'dang su dung', 'su dung', 'con dung', 'hoat dong', 'dang hoat dong'],
  inactive: ['ngung', 'ngung dung', 'ngung su dung', 'ngưng', 'ngung hoat dong', 'khong dung', 'khong su dung'],
};

// Cách gọi khác hiện trong ghi chú file mẫu
const ALIAS_SHOWN = { active: ['Đang sử dụng', 'Đang dùng'], inactive: ['Ngừng', 'Ngừng dùng'] };

export const optionLabel = (f, o) => f.labels?.[o] || o;

// Ô Excel → giá trị lựa chọn: khớp mã, tên hiển thị hoặc cách gọi khác (không phân biệt dấu / hoa thường)
// Trả về undefined nếu không khớp lựa chọn nào
export function matchOption(f, raw) {
  const s = norm(raw);
  if (!s) return '';
  const opts = (f.options || []).filter((o) => o !== '');
  return opts.find((o) => norm(o) === s)
    ?? opts.find((o) => norm(optionLabel(f, o)) === s)
    ?? opts.find((o) => (ALIASES[o] || []).map(norm).includes(s));
}

export const TRUE_WORDS = ['x', 'co', 'c', '1', 'true', 'yes', 'y', '✓', 'v', 'dung'];

function example(f) {
  if (f.example) return f.example;
  if (EXAMPLES[f.key]) return EXAMPLES[f.key];
  switch (f.type) {
    case 'number': return '1,250.5';
    case 'currency': return '50,000,000';
    case 'percent': return '10';
    case 'date': return '15/11/2026';
    case 'datetime': return '15/11/2026 08:30';
    case 'checkbox': return 'x';
    case 'email': return 'ten@congty.vn';
    case 'phone': return '0903 123 456';
    case 'url': return 'https://...';
    case 'select': { const o = (f.options || []).find((x) => x !== ''); return o != null ? optionLabel(f, o) : ''; }
    default: return '';
  }
}

// Ghi chú cho 1 trường của danh mục
export function fieldNote(cat, f) {
  const isKey = keyFieldsOf(cat).includes(f.key);
  const lines = [`Kiểu: ${TYPE_TEXT[f.type] || 'Chữ'}.`];
  if (isKey) lines.push('BẮT BUỘC (dùng để nhận diện dòng). Dòng thiếu cột này bị bỏ qua. Trùng mã đã có thì cập nhật dòng đó.');
  else if (f.required) lines.push('Bắt buộc. Để trống vẫn nhập được, dòng được đánh dấu ⚠ để bổ sung sau.');
  else lines.push('Không bắt buộc.');

  if (f.type === 'checkbox') lines.push('Có: x, Có, 1, Yes. Không: để trống, Không, 0. Dòng đã có mà để trống thì giữ nguyên như cũ.');
  if (f.type === 'select') {
    const opts = (f.options || []).filter((o) => o !== '');
    if (opts.length) {
      const shown = opts.map((o) => optionLabel(f, o));
      lines.push(`Gõ đúng một trong: ${shown.join(' | ')}.`);
      const codes = opts.filter((o) => optionLabel(f, o) !== o);
      if (codes.length) lines.push(`(Gõ mã cũng được: ${codes.join(' | ')}.)`);
      const alias = opts.flatMap((o) => ALIAS_SHOWN[o] || []);
      if (alias.length) lines.push(`(Cũng nhận: ${alias.join(', ')}.)`);
    }
    if (f.default) lines.push(`Để trống: ${optionLabel(f, f.default)}.`);
    lines.push('Không phân biệt hoa thường, có dấu hay không dấu.');
  }
  if (f.type === 'ref' || f.type === 'multiref') {
    const ref = catalogByKey(f.ref);
    lines.push(`Ghi mã có trong danh mục ${ref?.short || ref?.title || f.ref}${f.type === 'multiref' ? ', nhiều mã cách nhau dấu phẩy' : ''}. Mã chưa có vẫn nhập, dòng được đánh dấu ⚠.`);
  }
  if (NUM.includes(f.type)) lines.push('Dấu phẩy ngăn hàng nghìn, dấu chấm thập phân (1,250.5).');
  if (f.type === 'date') lines.push('Dạng ngày/tháng/năm (dd/mm/yyyy) hoặc ô định dạng Ngày của Excel.');
  if (f.help) lines.push(String(f.help));
  const ex = example(f);
  if (ex) lines.push(`Ví dụ: ${ex}`);
  return lines.join('\n');
}
const NUM = ['number', 'currency', 'percent'];
