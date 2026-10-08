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
        options: base.type === 'select' && s.options?.length ? s.options : base.options,
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

export function defaultsOf(fields) {
  const r = {};
  for (const f of fields) if (f.default !== undefined) r[f.key] = f.default;
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
export function toStored(list) {
  return list.map((f) => {
    const o = { key: f.key, label: String(f.label || '').trim(), required: !!f.required, hidden: !!f.hidden };
    if (f.type === 'select' && !f.labels && f.options?.length) o.options = f.options;
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
