import { catalogByKey } from '../catalogs';

// Trường khóa (tạo mã bản ghi) không được ẩn hay bỏ bắt buộc
export function keyFieldsOf(cat) {
  return cat.keyFields || [cat.idField];
}

// Gộp trường có sẵn trong code với cấu hình admin (settings/fields)
// stored: [{ key, label, required, hidden, options, type, custom }] — thứ tự mảng = thứ tự hiển thị
export function mergeFields(catKey, stored = []) {
  const cat = catalogByKey(catKey);
  const sys = new Map(cat.fields.map((f) => [f.key, f]));
  const keys = keyFieldsOf(cat);
  const out = [];
  const seen = new Set();
  for (const s of stored) {
    if (seen.has(s.key)) continue;
    const base = sys.get(s.key);
    if (base) {
      out.push({
        ...base,
        label: s.label || base.label,
        required: keys.includes(base.key) || base.required ? true : !!s.required,
        hidden: keys.includes(base.key) ? false : !!s.hidden,
        options: CHOICE_TYPES.includes(base.type) && !base.labels && !base.computed && !base.system && s.options?.length ? s.options : base.options,
        // default '' = admin bỏ giá trị mặc định có sẵn trong code
        ...('default' in s ? (s.default === '' ? { default: undefined } : { default: s.default }) : {}),
        builtin: true,
      });
      seen.add(s.key);
    } else if (s.custom) {
      out.push({ ...s, builtin: false });
      seen.add(s.key);
    }
  }
  for (const f of cat.fields) if (!seen.has(f.key)) out.push({ ...f, builtin: true });
  return out;
}

export function applyComputed(fields, row) {
  const r = { ...row };
  for (const f of fields) if (f.computed) r[f.key] = f.computed(r);
  return r;
}

// Mặc định ngày: 'today' = hôm nay, 'today+3' = 3 ngày sau
export function resolveDefault(v) {
  const m = typeof v === 'string' && v.match(/^today([+-]\d+)?$/);
  if (!m) return v;
  const d = new Date(Date.now() + 7 * 3600e3 + Number(m[1] || 0) * 864e5); // giờ Việt Nam
  return d.toISOString().slice(0, 10);
}
export const DATE_DEFAULTS = [['today', 'Hôm nay'], ['today+1', 'Ngày mai'], ['today+2', 'Sau 2 ngày'], ['today+3', 'Sau 3 ngày'], ['today+7', 'Sau 7 ngày'], ['today+30', 'Sau 30 ngày']];
export const canDefault = (f) => f.type !== 'multiref' && !f.computed && !f.system;
export const canChoose = (f) => CHOICE_TYPES.includes(f.type) && !f.labels && !f.computed && !f.system;

export function defaultsOf(fields) {
  const r = {};
  for (const f of fields) if (f.default !== undefined && f.default !== '') r[f.key] = resolveDefault(f.default);
  return r;
}

export function safeId(s) {
  // Firestore chỉ cấm '/' trong mã bản ghi (giữ nguyên dấu chấm để email làm mã được)
  const id = String(s ?? '').trim().replace(/\//g, '_').slice(0, 300);
  return id === '.' || id === '..' || /^__.*__$/.test(id) ? `_${id}` : id;
}

export function docIdOf(cat, row) {
  let id = cat.idOf ? cat.idOf(row) : row[cat.idField];
  id = String(id ?? '').trim();
  if (cat.upperId) id = id.toUpperCase();
  if (cat.lowerId) id = id.toLowerCase();
  return safeId(id);
}

// Chuẩn hóa giá trị trước khi lưu
export function cleanValue(f, v) {
  if (['number', 'currency', 'percent'].includes(f.type)) return v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v);
  if (f.type === 'checkbox') return !!v;
  if (f.type === 'multiref') return Array.isArray(v) ? v : String(v || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  if (f.type === 'email') return String(v ?? '').trim().toLowerCase();
  if (typeof v === 'string') return v.trim();
  return v ?? '';
}

// Danh sách trường đã gộp → dạng lưu ở settings/fields (giữ trường tự thêm, liên kết, danh sách chọn)
// Kiểu được phép có danh sách giá trị chọn sẵn (vd. VAT 5%, 8%, 10%)
export const CHOICE_TYPES = ['select', 'number', 'percent', 'currency', 'text'];
// Chuỗi "5, 8, 10" → danh sách; kiểu số giữ dạng số
export function parseChoices(text, type) {
  const list = String(text || '').split(',').map((s) => s.trim().replace(/%$/, '').trim()).filter(Boolean);
  return ['number', 'percent', 'currency'].includes(type) ? list.map(Number).filter((x) => Number.isFinite(x)) : list;
}
export function toStored(list) {
  return list.map((f) => {
    const o = { key: f.key, label: String(f.label || '').trim(), required: !!f.required, hidden: !!f.hidden };
    if (f.options?.length && canChoose(f)) o.options = f.options;
    if (f.default !== undefined && f.default !== '') o.default = f.default;
    if (f.custom) Object.assign(o, { custom: true, type: f.type, ...(f.ref ? { ref: f.ref } : {}), ...(f.link ? { link: f.link } : {}) });
    return o;
  });
}

// Trường liên kết: chọn bản ghi ở trường `via` (vd. khách hàng) thì tự lấy giá trị từ trường tương ứng của bản ghi đó
export function linkPatch(fields, via, rec) {
  const p = {};
  for (const f of fields) if (f.link?.via === via) p[f.key] = rec ? rec[f.link.field] ?? '' : '';
  return p;
}
// Chỉ điền các trường liên kết đang trống (dùng khi giá trị mặc định / dữ liệu danh mục vừa tải xong)
export function fillEmptyLinks(fields, row, recFor) {
  const p = {};
  for (const f of fields) {
    if (!f.link || (row[f.key] !== undefined && row[f.key] !== '' && row[f.key] !== null)) continue;
    const rec = recFor(f.link.via);
    if (rec && rec[f.link.field] !== undefined && rec[f.link.field] !== '') p[f.key] = rec[f.link.field];
  }
  return p;
}
