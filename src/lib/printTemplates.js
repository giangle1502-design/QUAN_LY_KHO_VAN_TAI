// Mẫu in tự thiết kế: người có quyền thiết lập biểu mẫu soạn nội dung trang in (chữ, bảng, hình, logo)
// và chèn {{Tên trường}} lấy dữ liệu từ phiếu. {{BẢNG HÀNG}} = bảng dòng hàng (cột cấu hình riêng),
// {{CHỮ KÝ}} = hàng ô ký tên, {{#nếu Tên trường}} ... {{/nếu}} = chỉ in đoạn này khi trường có giá trị.
// Mỗi loại phiếu có thể có nhiều mẫu; mẫu áp dụng cho công ty chủ hàng / khách hàng cụ thể được chọn tự động.
import { MOVE_TYPES } from './stock';
import { fmtDate, fmtNum, norm } from './utils';
import { evalTree, parseFormula } from './formula';

export const DOC_TYPES = {
  px: { label: 'Phiếu xuất kho (giao hàng)', icon: '📤', source: 'movement' },
  soan: { label: 'Phiếu soạn hàng', icon: '📋', source: 'movement' },
  pn: { label: 'Phiếu nhập kho', icon: '📥', source: 'movement' },
  kho: { label: 'Phiếu kho khác (chuyển vị trí, đổi tình trạng, điều chỉnh)', icon: '🔀', source: 'movement' },
  nhan: { label: 'Nhãn pallet (nhãn nhập kho)', icon: '🏷️', source: 'movement', perLabel: true },
  giaichap: { label: 'Đề nghị giải chấp', icon: '🔓', source: 'release' },
};
// Loại phiếu kho nào in bằng loại mẫu nào
export const MOVE_TYPES_OF = { px: ['out'], soan: ['out'], pn: ['in'], kho: ['move', 'status', 'adjust'], nhan: ['in'] };
export const docTypeOfMovement = (m, pick) => (pick ? 'soan' : m.type === 'out' ? 'px' : m.type === 'in' ? 'pn' : 'kho');

export const PAPERS = { A4: [210, 297], A5: [148, 210], Letter: [216, 279], 'Nhãn 10,2×15': [102, 150], 'Tùy chỉnh': null };
export const FONTS = [
  ['Times New Roman, Times, serif', 'Times New Roman'],
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['Tahoma, Verdana, sans-serif', 'Tahoma'],
  ['system-ui, -apple-system, Segoe UI, Roboto, sans-serif', 'Chữ hệ thống'],
  ["'IBM Plex Mono', ui-monospace, Menlo, monospace", 'Chữ đều (nhãn)'],
];

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const two = (n) => String(n).padStart(2, '0');

// Định dạng 1 giá trị theo kiểu trường
export function fmtValue(type, v, dec, fixed = false) {
  if (v === '' || v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return '';
  if (type === 'date') return fmtDate(v);
  if (type === 'datetime') { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`; }
  if (type === 'checkbox') return v ? '✓' : '';
  if (type === 'percent') return `${fmtNum(v, 2)}%`;
  if (['number', 'currency', 'num', 'formula'].includes(type)) return Number.isNaN(Number(v)) ? String(v) : fmtNum(v, dec ?? (type === 'currency' ? 0 : 3), fixed ? dec ?? 3 : 0);
  return String(v);
}

// Trường lấy từ 1 danh mục (kể cả trường tự thêm ở Quản lý trường)
function catFields(fieldsOf, catKey, group, prefix, pick) {
  let list = [];
  try { list = fieldsOf(catKey) || []; } catch { list = []; }
  return list.filter((f) => !['multiref'].includes(f.type) && f.key !== 'active').map((f) => ({
    g: group, label: `${prefix}: ${f.label}`, key: `${prefix}.${f.key}`, type: f.type, dec: f.type === 'number' ? 3 : undefined,
    get: (d) => pick(d)?.[f.key],
  }));
}
// Trường của đơn hàng (gộp SO/PO/STO theo nhãn; lấy đúng trường theo loại đơn của phiếu)
function orderFields(fieldsOf, part, group, prefix, pick) {
  const byLabel = new Map();
  for (const t of ['so', 'po', 'sto']) {
    let list = [];
    try { list = fieldsOf(t + part) || []; } catch { list = []; }
    for (const f of list) if (!byLabel.has(f.label)) byLabel.set(f.label, f);
  }
  return [...byLabel.values()].map((f) => ({
    g: group, label: `${prefix}: ${f.label}`, key: `${prefix}.${f.key}`, type: f.type,
    get: (d, l) => {
      const src = pick(d, l);
      if (!src) return '';
      const t = String(d.order?.type || '').toLowerCase();
      let list = [];
      try { list = fieldsOf(t + part) || []; } catch { list = []; }
      const own = list.find((x) => x.label === f.label);
      return src[own ? own.key : f.key];
    },
  }));
}

const now = (d) => d.now || new Date();
const commonTail = [
  { g: 'In', label: 'Ngày in', key: 'printDate', get: (d) => { const t = now(d); return `${two(t.getDate())}/${two(t.getMonth() + 1)}/${t.getFullYear()}`; } },
  { g: 'In', label: 'Giờ in', key: 'printTime', get: (d) => { const t = now(d); return `${two(t.getHours())}:${two(t.getMinutes())}`; } },
  { g: 'In', label: 'Người in', key: 'printBy', get: (d) => d.me || '' },
];
const dateParts = (getDate) => [
  { g: 'Phiếu', label: 'Ngày (dd)', key: 'day', get: (d) => String(getDate(d) || '').split('-')[2] || '' },
  { g: 'Phiếu', label: 'Tháng (mm)', key: 'month', get: (d) => String(getDate(d) || '').split('-')[1] || '' },
  { g: 'Phiếu', label: 'Năm (yyyy)', key: 'year', get: (d) => String(getDate(d) || '').split('-')[0] || '' },
];

function moveTitle(m, docType) {
  if (docType === 'soan') return 'PHIẾU SOẠN HÀNG';
  if (docType === 'nhan') return 'NHÃN NHẬP KHO';
  return `PHIẾU ${(MOVE_TYPES[m?.type]?.label || 'KHO').toUpperCase()}`;
}
const lineSum = (d, k) => (d.m?.lines || []).reduce((s, l) => s + num(l[k]), 0);

// Danh sách trường của 1 loại phiếu: { head: trường chung, line: trường dòng hàng (cột bảng) }
export function fieldDefs(docType, fieldsOf) {
  if (DOC_TYPES[docType]?.source === 'release') {
    const head = [
      { g: 'Phiếu', label: 'Số đề nghị', key: 'id', get: (d) => d.r?.id },
      { g: 'Phiếu', label: 'Ngày đề nghị', key: 'date', type: 'date', get: (d) => d.r?.date },
      ...dateParts((d) => d.r?.date),
      { g: 'Phiếu', label: 'Kho', key: 'warehouse', get: (d) => d.r?.warehouse },
      { g: 'Phiếu', label: 'Ghi chú', key: 'note', get: (d) => d.r?.note },
      { g: 'Phiếu', label: 'Người lập', key: 'createdByName', get: (d) => d.r?.createdByName },
      { g: 'Phiếu', label: 'Tổng số lượng (tấn)', key: 'totalT', get: (d) => fmtNum((d.r?.lines || []).reduce((s, l) => s + num(l.kg), 0) / 1000, 3, 3) },
      { g: 'Phiếu', label: 'Tổng kg', key: 'totalKg', type: 'num', dec: 2, get: (d) => (d.r?.lines || []).reduce((s, l) => s + num(l.kg), 0) },
      ...catFields(fieldsOf, 'companies', 'Công ty', 'Công ty', (d) => d.co),
      ...catFields(fieldsOf, 'pledgees', 'Ngân hàng', 'Ngân hàng', (d) => d.bank),
      ...catFields(fieldsOf, 'warehouses', 'Kho', 'Kho', (d) => d.wh),
      ...commonTail,
    ];
    const line = [
      { label: 'STT', key: 'stt', type: 'num', get: (d, l) => l._stt },
      { label: 'Số CT', key: 'docNo', get: (d, l) => l.docNo },
      { label: 'Mã hàng', key: 'item', get: (d, l) => l.item },
      { label: 'Tên hàng', key: 'itemName', get: (d, l) => l.itemName },
      { label: 'ĐVT', key: 'unit', get: (d, l) => l.unit || 'TẤN' },
      { label: 'Số lượng (tấn)', key: 'tons', type: 'num', dec: 3, fixed: true, get: (d, l) => num(l.kg) / 1000 },
      { label: 'Số kg', key: 'kg', type: 'num', dec: 2, get: (d, l) => num(l.kg) },
      { label: 'Vị trí hàng hóa', key: 'place', get: (d, l) => l.place },
      { label: 'Lot', key: 'lot', get: (d, l) => l.lot },
      ...catFields(fieldsOf, 'items', 'Mã hàng', 'Mã hàng', (d, l) => d.items?.get(l.item)).map((f) => ({ ...f, get: (d, l) => d.items?.get(l.item)?.[f.key.split('.')[1]] })),
    ];
    return { head, line };
  }

  const m = (d) => d.m || {};
  const tr = (d) => d.trip || {};
  const head = [
    { g: 'Phiếu', label: 'Tiêu đề phiếu', key: 'title', get: (d) => moveTitle(d.m, d.docType) },
    { g: 'Phiếu', label: 'Số phiếu', key: 'id', get: (d) => m(d).id },
    { g: 'Phiếu', label: 'Ngày phiếu', key: 'date', type: 'date', get: (d) => m(d).date },
    ...dateParts((d) => m(d).date),
    { g: 'Phiếu', label: 'Loại phiếu', key: 'typeLabel', get: (d) => MOVE_TYPES[m(d).type]?.label },
    { g: 'Phiếu', label: 'Mã kho', key: 'warehouse', get: (d) => m(d).warehouse },
    { g: 'Phiếu', label: 'Mã công ty chủ hàng', key: 'company', get: (d) => m(d).company || m(d).lines?.find((l) => l.company)?.company },
    { g: 'Phiếu', label: 'Mã khách hàng / NCC', key: 'partyCode', get: (d) => m(d).partyCode },
    { g: 'Phiếu', label: 'Tên khách hàng / NCC', key: 'partyName', get: (d) => m(d).partyName || d.party?.name || d.supplier?.name },
    { g: 'Phiếu', label: 'Mã giao hàng', key: 'shipCode', get: (d) => m(d).shipCode },
    { g: 'Phiếu', label: 'Số đơn hàng', key: 'orderId', get: (d) => m(d).orderId },
    { g: 'Phiếu', label: 'Số đơn Ecount / chứng từ', key: 'orderRef', get: (d) => m(d).orderRef },
    { g: 'Phiếu', label: 'Lý do', key: 'reason', get: (d) => m(d).reason },
    { g: 'Phiếu', label: 'Ghi chú', key: 'note', get: (d) => m(d).note },
    { g: 'Phiếu', label: 'Người lập', key: 'createdByName', get: (d) => m(d).createdByName },
    { g: 'Phiếu', label: 'Lý do hủy', key: 'cancelReason', get: (d) => (m(d).status === 'cancelled' ? m(d).cancelReason || 'Đã hủy' : '') },
    { g: 'Xe', label: 'Số xe', key: 'plate', get: (d) => m(d).plate || tr(d).plate },
    { g: 'Xe', label: 'Tài xế', key: 'driverName', get: (d) => m(d).driverName || tr(d).driverName },
    { g: 'Xe', label: 'CCCD tài xế', key: 'idCard', get: (d) => m(d).idCard || tr(d).idCard },
    { g: 'Xe', label: 'Điện thoại tài xế', key: 'driverPhone', get: (d) => m(d).driverPhone || tr(d).driverPhone },
    { g: 'Xe', label: 'Đơn vị vận tải', key: 'carrierName', get: (d) => m(d).carrierName || m(d).carrier || tr(d).carrierName },
    { g: 'Xe', label: 'Số chuyến xe', key: 'tripId', get: (d) => m(d).tripId },
    { g: 'Xe', label: 'Cửa kho', key: 'dock', get: (d) => tr(d).dock },
    { g: 'Tổng', label: 'Tổng kg', key: 'totalKg', type: 'num', dec: 2, get: (d) => lineSum(d, 'kg') },
    { g: 'Tổng', label: 'Tổng tấn', key: 'totalT', get: (d) => fmtNum(lineSum(d, 'kg') / 1000, 3, 3) },
    { g: 'Tổng', label: 'Tổng pallet', key: 'totalPallets', type: 'num', dec: 2, get: (d) => lineSum(d, 'pallets') },
    { g: 'Tổng', label: 'Tổng số bao', key: 'totalBags', type: 'num', dec: 0, get: (d) => lineSum(d, 'bags') },
    { g: 'Tổng', label: 'Số dòng hàng', key: 'lineCount', get: (d) => (m(d).lines || []).length },
    { g: 'Phiếu', label: 'Liên', key: 'copyLabel', get: (d) => d.copyLabel || '' },
    { g: 'Phiếu', label: 'Hình thức xuất', key: 'palletMode', get: (d) => (m(d).palletMode === 'pallet' ? 'Xuất kèm pallet' : m(d).palletMode === 'xa' ? 'Xuất xá' : '') },
    { g: 'Phiếu', label: 'Pallet xuất kèm', key: 'palletText', get: (d) => d.palletText ?? '' },
    ...catFields(fieldsOf, 'companies', 'Công ty chủ hàng', 'Công ty', (d) => d.co),
    ...catFields(fieldsOf, 'warehouses', 'Kho', 'Kho', (d) => d.wh),
    ...catFields(fieldsOf, 'soldto', 'Khách hàng', 'Khách hàng', (d) => d.party),
    ...catFields(fieldsOf, 'shipto', 'Giao đến', 'Giao đến', (d) => d.shipto),
    ...catFields(fieldsOf, 'suppliers', 'Nhà cung cấp', 'NCC', (d) => d.supplier),
    ...orderFields(fieldsOf, 'Head', 'Đơn hàng', 'Đơn', (d) => d.order),
    ...commonTail,
  ];
  const line = [
    { label: 'STT', key: 'stt', type: 'num', get: (d, l) => l._stt },
    { label: 'Mã hàng', key: 'item', get: (d, l) => l.item },
    { label: 'Tên hàng', key: 'itemName', get: (d, l) => l.itemName || d.items?.get(l.item)?.name },
    { label: 'Lot', key: 'lot', get: (d, l) => l.lot },
    { label: 'Vị trí', key: 'location', get: (d, l) => l.location },
    { label: 'Đến vị trí', key: 'toLocation', get: (d, l) => l.toLocation },
    { label: 'Tình trạng', key: 'goodsStatus', get: (d, l) => l.goodsStatus },
    { label: 'Bên nhận thế chấp', key: 'pledgee', get: (d, l) => l.pledgee },
    { label: 'Tình trạng mới', key: 'toStatus', get: (d, l) => [l.toStatus, l.toPledgee].filter(Boolean).join(' ') },
    { label: 'NSX', key: 'mfgDate', type: 'date', get: (d, l) => l.mfgDate },
    { label: 'HSD', key: 'expDate', type: 'date', get: (d, l) => l.expDate },
    { label: 'Số kg', key: 'kg', type: 'num', dec: 2, get: (d, l) => num(l.kg) },
    { label: 'Số tấn', key: 'tons', type: 'num', dec: 3, fixed: true, get: (d, l) => num(l.kg) / 1000 },
    { label: 'Pallet', key: 'pallets', type: 'num', dec: 2, get: (d, l) => num(l.pallets) },
    { label: 'Số bao', key: 'bags', type: 'num', dec: 0, get: (d, l) => num(l.bags) },
    { label: 'Ghi chú dòng', key: 'lineNote', get: (d, l) => l.note },
    { label: 'Công ty dòng', key: 'lineCompany', get: (d, l) => l.company },
    { label: 'Ô trống', key: 'blank', get: () => '' },
    { label: 'Ô tích ☐', key: 'checkbox', get: () => '☐' },
    ...catFields(fieldsOf, 'items', 'Mã hàng', 'Mã hàng', () => null).map((f) => ({ ...f, get: (d, l) => d.items?.get(l.item)?.[f.key.split('.')[1]] })),
    ...orderFields(fieldsOf, 'Line', 'Dòng đơn', 'Dòng đơn', (d, l) => (d.order?.lines || []).find((x) => String(x.no) === String(l.orderLine))),
  ];
  if (docType === 'nhan') {
    // Nhãn: mỗi pallet 1 nhãn, trường dòng hàng dùng trực tiếp trong nội dung nhãn
    line.splice(1, 0,
      { label: 'Pallet số', key: 'palletNo', get: (d, l) => l.palletNo },
      { label: 'Số pallet của dòng', key: 'palletOf', get: (d, l) => l.palletOf },
      { label: 'Pallet lẻ', key: 'partial', get: (d, l) => (l.full === false ? 'lẻ' : '') },
      { label: 'Số lớp/pallet', key: 'layers', get: (d, l) => d.items?.get(l.item)?.layersPerPallet || '' },
      { label: 'Công ty trên nhãn', key: 'labelCompany', get: (d) => d.labelCompany || d.co?.name || '' },
    );
  }
  return { head, line };
}

// ---------- Bộ máy in ----------
const SPECIAL = { table: norm('BẢNG HÀNG'), signs: norm('CHỮ KÝ') };

function valueMap(defs, d, l) {
  const map = new Map();
  for (const f of defs) {
    let raw;
    try { raw = f.get(d, l); } catch { raw = ''; }
    const v = { raw, text: fmtValue(f.type, raw, f.dec, f.fixed) };
    map.set(norm(f.label), v);
    map.set(norm(f.key), v);
  }
  return map;
}

function fill(html, lookup, preview) {
  const val = (name) => lookup(norm(name));
  // {{#nếu X}} ... {{/nếu}} (lồng 1 tầng là đủ)
  // Thay khối trong cùng trước (thân khối không chứa {{# khác) để lồng nhiều tầng được
  const cond = /\{\{#\s*(?:nếu|neu|if)\s+([^}]+?)\s*\}\}((?:(?!\{\{#)[\s\S])*?)\{\{\/\s*(?:nếu|neu|if)\s*\}\}/gi;
  let out = html;
  for (let i = 0; i < 6; i++) {
    const next = out.replace(cond, (_, name, body) => (val(name.replace(/<[^>]*>/g, ''))?.text ? body : ''));
    if (next === out) break;
    out = next;
  }
  return out.replace(/\{\{\s*([^}#/][^}]*?)\s*\}\}/g, (all, name) => {
    const v = val(name.replace(/<[^>]*>/g, ''));
    if (v === undefined) return preview ? `<span class="tpl-unknown" title="Không có trường này">${esc(all)}</span>` : '';
    return esc(v.text).replace(/\n/g, '<br>');
  });
}

// Gộp dòng theo mã hàng: cộng kg, bao, pallet; trường chữ khác nhau thì nối lại
function groupBy(lines, key) {
  const g = new Map();
  for (const l of lines) {
    const k = String(l[key] ?? '');
    if (!g.has(k)) { g.set(k, { ...l, kg: num(l.kg), bags: num(l.bags), pallets: num(l.pallets) }); continue; }
    const x = g.get(k);
    x.kg += num(l.kg); x.bags += num(l.bags); x.pallets += num(l.pallets);
    for (const [p, v] of Object.entries(l)) {
      if (['kg', 'bags', 'pallets'].includes(p) || typeof v !== 'string' || !v) continue;
      const cur = String(x[p] ?? '');
      if (!cur.split(', ').includes(v)) x[p] = cur ? `${cur}, ${v}` : v;
    }
  }
  return [...g.values()];
}

export function tableHtml(tpl, d, defs, headMap, preview) {
  const t = tpl.table || {};
  const cols = (t.columns || []).filter((c) => c.field || c.formula);
  if (!cols.length) return preview ? '<p class="tpl-unknown">Bảng hàng chưa có cột nào: thêm cột ở mục Bảng hàng.</p>' : '';
  let lines = [...(d.lines || [])];
  if (t.groupBy) lines = groupBy(lines, t.groupBy);
  const byName = (name) => defs.line.find((f) => norm(f.label) === norm(name) || norm(f.key) === norm(name));
  if (t.sortBy) {
    const f = byName(t.sortBy);
    if (f) lines.sort((a, b) => String(f.get(d, a) ?? '').localeCompare(String(f.get(d, b) ?? ''), 'vi', { numeric: true }));
  }
  lines = lines.map((l, i) => ({ ...l, _stt: i + 1 }));
  const rows = lines.map((l) => {
    const lm = valueMap(defs.line, d, l);
    const look = (n) => lm.get(norm(n)) ?? headMap.get(norm(n));
    return cols.map((c) => {
      if (c.formula) {
        try {
          const r = evalTree(parseFormula(c.formula), (name) => num(look(name)?.raw), (name) => lines.reduce((s, x) => s + num(byName(name)?.get(d, x)), 0));
          return { raw: r, text: fmtValue('num', Math.round(r * 1e6) / 1e6, c.dec ?? 2) };
        } catch { return { raw: 0, text: preview ? '⚠ công thức' : '' }; }
      }
      const f = byName(c.field);
      if (!f) return { raw: '', text: preview ? `⚠ ${c.field}` : '' };
      let raw;
      try { raw = f.get(d, l); } catch { raw = ''; }
      return { raw, text: fmtValue(f.type, raw, c.dec ?? f.dec, f.fixed) };
    });
  });
  const align = (c) => (c.align ? `text-align:${c.align};` : '');
  const isNum = (c) => c.formula || byName(c.field)?.type === 'num';
  const cell = (c, inner, tag = 'td', extra = '') => `<${tag} style="${align(c) || (isNum(c) && tag === 'td' ? 'text-align:right;' : '')}${extra}">${inner}</${tag}>`;
  const head = `<thead><tr>${cols.map((c) => `<th style="${c.width ? `width:${esc(c.width)};` : ''}${align(c)}">${esc(c.header ?? c.field ?? '')}</th>`).join('')}</tr></thead>`;
  let body = rows.map((r) => `<tr>${r.map((v, i) => cell(cols[i], esc(v.text))).join('')}</tr>`).join('');
  for (let i = rows.length; i < num(t.minRows); i++) body += `<tr>${cols.map(() => '<td>&nbsp;</td>').join('')}</tr>`;
  let foot = '';
  if (t.showTotal && cols.some((c) => c.sum)) {
    const first = cols.findIndex((c) => c.sum);
    const cells = [];
    if (first > 0) cells.push(`<td colspan="${first}"><b>${esc(t.totalLabel ?? 'Cộng')}</b></td>`);
    cols.forEach((c, i) => {
      if (i < first) return;
      const s = rows.reduce((a, r) => a + num(r[i].raw), 0);
      cells.push(cell(c, c.sum ? `<b>${esc(fmtValue('num', s, c.dec ?? byName(c.field)?.dec ?? 2, byName(c.field)?.fixed))}</b>` : ''));
    });
    foot = `<tfoot><tr>${cells.join('')}</tr></tfoot>`;
  }
  const st = [t.fontSize ? `font-size:${num(t.fontSize)}px;` : ''].join('');
  return `<table class="tpl-lines no-resize${t.noBorder ? ' tpl-noborder' : ''}" style="${st}">${head}<tbody>${body}</tbody>${foot}</table>`;
}

function signsHtml(tpl, lookup, preview) {
  const signs = tpl.signs || [];
  if (!signs.some((s) => s.title)) return '';
  const h = num(tpl.signSpace) || 22;
  return `<table class="tpl-signs"><tr>${signs.map((s) => `<td style="width:${100 / signs.length}%">${s.title ? `<b>${esc(s.title)}</b>` : ''}${s.note ? `<br><i class="tpl-small">${esc(s.note)}</i>` : ''}<div style="height:${h}mm"></div>${s.name ? fill(esc(s.name), lookup, preview) : ''}</td>`).join('')}</tr></table>`;
}

// Bỏ thẻ / thuộc tính chạy mã (mẫu in do người dùng soạn)
export function sanitize(html) {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.body.querySelectorAll('script, iframe, object, embed, link, meta, base, form, input, button, textarea, select').forEach((e) => e.remove());
  doc.body.querySelectorAll('*').forEach((e) => {
    for (const a of [...e.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || (['href', 'src', 'xlink:href', 'action', 'formaction'].includes(n) && /^\s*(javascript|vbscript|data:text)/i.test(a.value))) e.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}

// Nội dung 1 trang (hoặc 1 nhãn): HTML đã điền dữ liệu
export function renderBody(tpl, d, fieldsOf, { preview = false } = {}) {
  const defs = fieldDefs(tpl.docType, fieldsOf);
  const headMap = valueMap(defs.head, d);
  const lineMap = d.line ? valueMap(defs.line, d, d.line) : null;
  const lookup = (k) => (lineMap?.get(k)) ?? headMap.get(k);
  let html = String(tpl.body || '');
  html = html.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (all, name) => {
    const k = norm(name.replace(/<[^>]*>/g, ''));
    if (k === SPECIAL.table) return `\u0001T\u0001`;
    if (k === SPECIAL.signs) return `\u0001S\u0001`;
    return all;
  });
  html = fill(html, lookup, preview);
  html = html.replace(/\u0001T\u0001/g, () => tableHtml(tpl, d, defs, headMap, preview)).replace(/\u0001S\u0001/g, () => signsHtml(tpl, lookup, preview));
  return sanitize(html);
}

// Kích thước giấy (mm) theo mẫu
export function paperSize(tpl) {
  const p = PAPERS[tpl.paper];
  let [w, h] = p || [num(tpl.width) || 210, num(tpl.height) || 297];
  if (tpl.orientation === 'landscape') [w, h] = [h, w];
  return [w, h];
}
export const marginOf = (tpl) => (tpl.margin === '' || tpl.margin == null ? 12 : num(tpl.margin));

// CSS chung của trang in theo mẫu (khổ giấy, lề, phông chữ)
export function pageCss(tpl) {
  const [w, h] = paperSize(tpl);
  const mg = marginOf(tpl);
  return `
@page { size: ${w}mm ${h}mm; margin: ${mg}mm; }
.tpl-sheet { width: ${w}mm; min-height: ${h}mm; padding: ${mg}mm; box-sizing: border-box; background: #fff; color: #000; margin: 0 auto 16px; box-shadow: 0 2px 10px rgba(0,0,0,.15); overflow: hidden; position: relative;
  font-family: ${tpl.fontFamily || FONTS[0][0]}; font-size: ${num(tpl.fontSize) || 13}px; line-height: ${num(tpl.lineHeight) || 1.35}; }
.tpl-sheet.tpl-label { height: ${h}mm; }
.tpl-sheet p { margin: 0 0 3px; }
.tpl-sheet h1, .tpl-sheet h2, .tpl-sheet h3 { margin: 6px 0; }
.tpl-sheet table { border-collapse: collapse; width: auto; }
.tpl-sheet td, .tpl-sheet th { vertical-align: top; color: inherit; background: none; position: static; font-size: inherit; border: none; padding: 1px 4px; text-align: inherit; white-space: normal; }
.tpl-sheet table.tpl-lines { width: 100%; margin: 6px 0; }
.tpl-sheet table.tpl-lines th, .tpl-sheet table.tpl-lines td { border: 1px solid #000; padding: 4px 5px; }
.tpl-sheet table.tpl-lines th { background: ${tpl.table?.headBg || '#f2f2f2'}; text-align: center; font-weight: 700; }
.tpl-sheet table.tpl-lines.tpl-noborder th, .tpl-sheet table.tpl-lines.tpl-noborder td { border: none; border-bottom: 1px solid #bbb; }
.tpl-sheet table.tpl-grid td, .tpl-sheet table.tpl-grid th { border: 1px solid #000; padding: 3px 5px; }
.tpl-sheet table.tpl-signs { width: 100%; margin-top: 14px; text-align: center; }
.tpl-sheet table.tpl-signs td { border: none; padding: 0 4px; text-align: center; }
.tpl-sheet .tpl-small { font-size: .85em; font-weight: 400; }
.tpl-sheet img { max-width: 100%; }
.tpl-unknown { color: #c00; background: #ffecec; }
@media print {
  body, .tpl-screen { background: #fff !important; }
  .tpl-sheet { width: auto; min-height: 0; padding: 0; margin: 0; box-shadow: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .tpl-sheet.tpl-label { width: ${w - 2 * mg}mm; height: ${h - 2 * mg}mm; }
  .tpl-sheet + .tpl-sheet { break-before: page; page-break-before: always; }
}
${tpl.css || ''}`;
}

// Chọn mẫu tự động: mẫu đúng khách hàng > đúng công ty chủ hàng > mẫu đặt làm mặc định. Không có → mẫu gốc của hệ thống.
export function pickTemplate(list, docType, { company = '', party = '' } = {}) {
  const score = (t) => (t.parties?.length ? 2 : 0) + (t.companies?.length ? 1 : 0);
  const fits = (t) => (!t.companies?.length || t.companies.includes(company)) && (!t.parties?.length || t.parties.includes(party));
  return (list || [])
    .filter((t) => t.docType === docType && t.active !== false && fits(t) && (score(t) > 0 || t.isDefault))
    .sort((a, b) => score(b) - score(a) || (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || String(a.name).localeCompare(String(b.name)))[0] || null;
}

// ---------- Mẫu khởi tạo (giống bản in gốc) ----------
const HEAD_BLOCK = `<table style="width:100%"><tbody><tr>
<td style="width:62%"><b>{{Công ty: Tên công ty}}</b><br><span class="tpl-small">{{Công ty: Địa chỉ}}</span>{{#nếu Công ty: Mã số thuế / Số ĐKKD}}<br><span class="tpl-small">MST {{Công ty: Mã số thuế / Số ĐKKD}}</span>{{/nếu}}<br><span class="tpl-small">{{Kho: Tên kho}}{{#nếu Kho: Địa chỉ}} – {{Kho: Địa chỉ}}{{/nếu}}</span></td>
<td style="text-align:right">Số: <b>{{Số phiếu}}</b><br><span class="tpl-small">Ngày {{Ngày phiếu}}</span></td>
</tr></tbody></table><hr>`;
const VEHICLE = `{{#nếu Số xe}}<p>Số xe: <b>{{Số xe}}</b>{{#nếu Tài xế}} · Tài xế: {{Tài xế}}{{/nếu}}{{#nếu CCCD tài xế}} · CCCD {{CCCD tài xế}}{{/nếu}}{{#nếu Điện thoại tài xế}} · ĐT {{Điện thoại tài xế}}{{/nếu}}</p>{{/nếu}}
{{#nếu Đơn vị vận tải}}<p>Đơn vị vận tải: {{Đơn vị vận tải}}</p>{{/nếu}}`;
const col = (field, extra = {}) => ({ field, header: field, ...extra });

export function starterTemplate(docType) {
  const base = { docType, name: `Mẫu ${DOC_TYPES[docType].label.toLowerCase()} mới`, paper: 'A4', orientation: 'portrait', margin: 12,
    fontFamily: FONTS[0][0], fontSize: 13, lineHeight: 1.35, companies: [], parties: [], isDefault: false, active: true, css: '', signSpace: 22 };
  const signNote = '(Ký, ghi rõ họ tên)';
  if (docType === 'px') return { ...base,
    body: `${HEAD_BLOCK}
<h2 style="text-align:center">{{Tiêu đề phiếu}}</h2>
<p>Khách hàng: <b>{{Mã khách hàng / NCC}} {{Tên khách hàng / NCC}}</b></p>
{{#nếu Giao đến: Địa chỉ giao hàng}}<p>Giao đến: {{Giao đến: Địa chỉ giao hàng}}{{#nếu Giao đến: Người nhận}} · Người nhận: {{Giao đến: Người nhận}}{{/nếu}}{{#nếu Giao đến: Điện thoại nhận hàng}} · ĐT {{Giao đến: Điện thoại nhận hàng}}{{/nếu}}</p>{{/nếu}}
{{#nếu Số đơn hàng}}<p>Theo đơn bán: {{Số đơn hàng}}{{#nếu Số đơn Ecount / chứng từ}} (số Ecount {{Số đơn Ecount / chứng từ}}){{/nếu}}</p>{{/nếu}}
${VEHICLE}
{{#nếu Ghi chú}}<p>Ghi chú: {{Ghi chú}}</p>{{/nếu}}
<p>{{BẢNG HÀNG}}</p>
<p>{{CHỮ KÝ}}</p>`,
    table: { columns: [col('STT', { width: '8%' }), col('Mã hàng'), col('Tên hàng'), col('Số kg', { header: 'Số lượng (kg)', sum: true }), col('Số bao', { sum: true })],
      groupBy: 'item', showTotal: true, totalLabel: 'Cộng', minRows: 0 },
    signs: [{ title: 'Người lập phiếu', note: signNote, name: '{{Người lập}}' }, { title: 'Thủ kho', note: signNote }, { title: 'Tài xế / Người nhận', note: signNote }, { title: 'Bảo vệ', note: signNote }],
  };
  if (docType === 'soan') return { ...base,
    body: `${HEAD_BLOCK}
<h2 style="text-align:center">{{Tiêu đề phiếu}}</h2>
<p style="text-align:center" class="tpl-small">Theo phiếu xuất kho {{Số phiếu}} · sắp theo vị trí để đi lấy hàng</p>
<p>Khách hàng: <b>{{Mã khách hàng / NCC}} {{Tên khách hàng / NCC}}</b></p>
<p>{{BẢNG HÀNG}}</p>
<p>{{CHỮ KÝ}}</p>`,
    table: { columns: [col('STT'), col('Vị trí'), col('Mã hàng'), col('Tên hàng'), col('Lot'), col('Tình trạng'), col('Số kg', { sum: true }), col('Pallet', { sum: true }), col('Số bao', { sum: true }), col('Ô tích ☐', { header: 'Đã soạn', align: 'center' })],
      sortBy: 'Vị trí', showTotal: true, totalLabel: 'Cộng' },
    signs: [{ title: 'Người soạn hàng', note: signNote }, { title: 'Thủ kho', note: signNote }, { title: 'Người kiểm tra', note: signNote }],
  };
  if (docType === 'pn' || docType === 'kho') return { ...base,
    body: `${HEAD_BLOCK}
<h2 style="text-align:center">{{Tiêu đề phiếu}}</h2>
{{#nếu Mã khách hàng / NCC}}<p>Nhà cung cấp / khách hàng: <b>{{Mã khách hàng / NCC}} {{Tên khách hàng / NCC}}</b></p>{{/nếu}}
{{#nếu Số đơn hàng}}<p>Theo đơn: {{Số đơn hàng}}{{#nếu Số đơn Ecount / chứng từ}} (số {{Số đơn Ecount / chứng từ}}){{/nếu}}</p>{{/nếu}}
${VEHICLE}
{{#nếu Lý do}}<p>Lý do: {{Lý do}}</p>{{/nếu}}
{{#nếu Ghi chú}}<p>Ghi chú: {{Ghi chú}}</p>{{/nếu}}
<p>{{BẢNG HÀNG}}</p>
<p>{{CHỮ KÝ}}</p>`,
    table: { columns: docType === 'pn'
      ? [col('STT'), col('Mã hàng'), col('Tên hàng'), col('Lot'), col('Vị trí'), col('Tình trạng'), col('Số kg', { sum: true }), col('Pallet', { sum: true }), col('Số bao', { sum: true })]
      : [col('STT'), col('Mã hàng'), col('Tên hàng'), col('Lot'), col('Vị trí'), col('Đến vị trí'), col('Tình trạng'), col('Tình trạng mới'), col('Số kg', { sum: true }), col('Pallet', { sum: true }), col('Số bao', { sum: true })],
      showTotal: true, totalLabel: 'Cộng' },
    signs: docType === 'pn'
      ? [{ title: 'Người lập phiếu', note: signNote, name: '{{Người lập}}' }, { title: 'Thủ kho', note: signNote }, { title: 'Người giao hàng', note: signNote }, { title: 'Bảo vệ', note: signNote }]
      : [{ title: 'Người lập phiếu', note: signNote, name: '{{Người lập}}' }, { title: 'Thủ kho', note: signNote }, { title: 'Kế toán', note: signNote }, { title: 'Người duyệt', note: signNote }],
  };
  if (docType === 'nhan') return { ...base, paper: 'Nhãn 10,2×15', margin: 4, fontFamily: FONTS[4][0], fontSize: 12,
    body: `<div style="background:#16222e;color:#fff;text-align:center;font-weight:700;padding:6px;border-radius:4px">NHÃN NHẬP KHO</div>
<table style="width:100%;margin-top:6px"><tbody><tr><td><span class="tpl-small">NGÀY NHẬP</span><br><b>{{Ngày phiếu}}</b></td><td style="text-align:right"><span class="tpl-small">CÔNG TY</span><br><b>{{Công ty trên nhãn}}</b></td></tr></tbody></table>
<p><span class="tpl-small">MÃ HÀNG</span><br><b style="font-size:16px">{{Mã hàng}}</b></p>
<p><span class="tpl-small">TÊN HÀNG</span><br><b style="font-size:16px">{{Tên hàng}}</b></p>
<hr>
<table style="width:100%"><tbody><tr><td><span class="tpl-small">SỐ LOT</span><br><b>{{Lot}}</b></td><td style="text-align:right"><span class="tpl-small">TTHH</span><br><b>{{Tình trạng}} {{Bên nhận thế chấp}}</b></td></tr></tbody></table>
<table class="tpl-grid" style="width:100%;text-align:center;margin:6px 0"><tbody><tr><td><span class="tpl-small">SL/PALLET (KG)</span><br><b>{{Số kg}}</b></td><td><span class="tpl-small">SỐ BAO</span><br><b>{{Số bao}}</b></td><td><span class="tpl-small">LỚP/PALLET</span><br><b>{{Số lớp/pallet}}</b></td></tr></tbody></table>
<div style="background:#c77e00;color:#fff;text-align:center;font-weight:700;padding:4px">VỊ TRÍ NHẬP</div>
<div style="border:3px solid #c77e00;border-top:none;text-align:center;font-size:44px;font-weight:800;color:#c77e00;padding:16px 4px">{{Vị trí}}</div>
<p style="text-align:center;font-size:9px;color:#888;margin-top:4px">{{Số phiếu}} · Pallet {{Pallet số}}/{{Số pallet của dòng}} {{Pallet lẻ}} · In lúc {{Giờ in}} {{Ngày in}}</p>`,
    table: { columns: [] }, signs: [],
  };
  if (docType === 'giaichap') return { ...base, fontSize: 15, lineHeight: 1.45,
    body: `<p style="text-align:center"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM<br>Độc lập - Tự do - Hạnh phúc</b><br>--------o0o---------</p>
<p style="text-align:center"><i>{{Công ty: Nơi lập văn bản}}, ngày {{Ngày (dd)}} tháng {{Tháng (mm)}} năm {{Năm (yyyy)}}</i> &nbsp; &nbsp; <b><i>Số:</i></b> {{Số đề nghị}}</p>
<h1 style="text-align:center">ĐỀ NGHỊ GIẢI CHẤP</h1>
<p style="text-align:center"><i>(V/V giải chấp hàng hóa)</i></p>
<p><b>Kính gửi: {{Ngân hàng: Ngân hàng / Bên nhận thế chấp}}</b></p>
<p>Hôm nay, tại {{Công ty: Địa chỉ}}</p>
<p><b>Tôi/ chúng Tôi là:</b></p>
<table><tbody>
<tr><td style="width:190px"><b>Công ty:</b></td><td><b>{{Công ty: Tên công ty}}</b></td></tr>
<tr><td><b>ĐKKD số:</b></td><td>{{Công ty: Mã số thuế / Số ĐKKD}} {{Công ty: Nơi cấp, ngày cấp ĐKKD}}</td></tr>
<tr><td><b>Đại diện là Ông/bà:</b></td><td><b>{{Công ty: Người đại diện}}</b></td></tr>
<tr><td>Chức vụ:</td><td>{{Công ty: Chức vụ người đại diện}}</td></tr>
<tr><td>Địa chỉ:</td><td>{{Công ty: Địa chỉ}}</td></tr>
</tbody></table>
<p>Điện thoại: {{Công ty: Điện thoại}} Fax: {{Công ty: Fax}} Email: {{Công ty: Email}}</p>
<p>Bằng văn bản này, Tôi/ chúng tôi kính đề nghị {{Ngân hàng: Tên gọi tắt}} chấp nhận cho Tôi/ Chúng tôi giải chấp hàng hóa theo nội dung chi tiết sau đây:</p>
<p>{{BẢNG HÀNG}}</p>
<p>Tôi/ công ty chúng tôi cam kết không hủy ngang bằng văn bản đề nghị giải chấp này và cam kết thực hiện đúng các thỏa thuận tại Hợp đồng tín dụng đã kí kết với Quý ngân hàng</p>
<p><b>Trân trọng cảm ơn!</b></p>
<p>{{CHỮ KÝ}}</p>`,
    table: { columns: [col('STT'), col('Số CT', { header: 'SỐ CT', align: 'center' }), col('Mã hàng', { header: 'MÃ HÀNG' }), col('Tên hàng', { header: 'TÊN HÀNG' }), col('ĐVT', { header: 'ĐVT', align: 'center' }),
      col('Số lượng (tấn)', { header: 'SỐ LƯỢNG', sum: true }), col('Vị trí hàng hóa', { header: 'VỊ TRÍ HÀNG HÓA' })],
      groupBy: '', showTotal: true, totalLabel: 'Total:', headBg: '#f0cdec' },
    signs: [{ title: '' }, { title: 'ĐẠI DIỆN KHÁCH HÀNG', note: '(hoặc người được ủy quyền hợp tác)' }],
    signSpace: 28,
  };
  return { ...base, body: '<p>{{BẢNG HÀNG}}</p>', table: { columns: [] }, signs: [] };
}
