import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { evalTree, fieldResolver, parseFormula, refsOf } from './formula';

// ============================================================================
// Chi phí chuyến xe. Tổng cước vận chuyển = Cước × (1 + % hỗ trợ dầu) + các phụ thu (vé, hạ rỗng trái tuyến…);
// Tổng chi phí = Tổng cước + các phí khác (hạ rỗng, nâng, cược cont…) + các khoản chi hộ (tách riêng).
// Quản trị tự thêm trường, đặt công thức, đổi nhóm của trường ở settings/tripCostFields { extra, groups }.
// ============================================================================
const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
export const COST_GROUPS = { surcharge: 'Phụ thu (cộng vào tổng cước)', fee: 'Phí khác (cộng ngoài tổng cước)', chiho: 'Chi hộ (tách riêng, cộng vào tổng chi phí)' };
export const GROUP_TOTAL = { surcharge: 'Tổng phụ thu', fee: 'Tổng phí khác', chiho: 'Tổng chi hộ' };
export const BASE_COST_FIELDS = [
  { key: 'freight', label: 'Cước vận chuyển', group: 'base' },
  { key: 'fuelPct', label: '% hỗ trợ dầu', group: 'pct', type: 'percent' },
  { key: 'ticket', label: 'Phụ thu vé', group: 'surcharge' },
  { key: 'offRoute', label: 'Phụ thu hạ rỗng trái tuyến', group: 'surcharge' },
  { key: 'liftOff', label: 'Phí hạ rỗng', group: 'fee' },
  { key: 'liftOn', label: 'Phí nâng', group: 'fee' },
  { key: 'contDeposit', label: 'Phí cược cont', group: 'fee' },
  { key: 'bocXep', label: 'Phí bốc xếp', group: 'fee' },
  { key: 'chiHo', label: 'Phí chi hộ', group: 'chiho' },
  { key: 'other', label: 'Phí khác', group: 'fee' },
];
// Số liệu của chuyến dùng được trong công thức
export const TRIP_VARS = [{ key: '_tons', label: 'Số lượng (tấn)' }, { key: '_kg', label: 'Số lượng (kg)' }];
const GROUPS = ['base', 'pct', 'surcharge', 'fee', 'chiho'];

export function useCostConfig() {
  const [cfg, setCfg] = useState({ extra: [], groups: {}, over: {}, order: [] });
  useEffect(() => onSnapshot(doc(db, 'settings', 'tripCostFields'), (s) => {
    const d = s.exists() ? s.data() : {};
    setCfg({ extra: d.extra || [], groups: d.groups || {}, over: d.over || {}, order: d.order || [] });
  }, () => {}), []);
  return cfg;
}
// Danh sách trường chi phí đang dùng (gốc + tự thêm; bỏ trường ẩn), theo nhóm: cước, %, phụ thu, phí khác, chi hộ
export function useCostFields() {
  const cfg = useCostConfig();
  return costFieldsWith(cfg).filter((f) => !f.hidden);
}
// Mọi trường (kể cả trường ẩn) sau khi áp cấu hình: đổi tên, đổi nhóm, công thức, ẩn, thứ tự
export function costFieldsWith({ extra = [], groups = {}, over = {}, order = [] } = {}) {
  const fixed = (f) => ['base', 'pct'].includes(f.group);
  const base = BASE_COST_FIELDS.map((f) => {
    const o = over[f.key] || {};
    const g = o.group || groups[f.key];
    return { ...f, base: true, label: String(o.label || '').trim() || f.label, ...(o.formula ? { formula: o.formula } : {}), hidden: !!o.hidden,
      group: fixed(f) || !COST_GROUPS[g] ? f.group : g };
  });
  const ex = extra.filter((f) => f.key && f.label && !BASE_COST_FIELDS.some((b) => b.key === f.key)).map((f) => ({ ...f, group: COST_GROUPS[f.group] ? f.group : 'fee' }));
  const idx = new Map(order.map((k, i) => [k, i]));
  const all = [...base, ...ex].map((f, i) => ({ f, w: idx.has(f.key) ? idx.get(f.key) : 1000 + i })).sort((a, b) => a.w - b.w).map((x) => x.f);
  return GROUPS.flatMap((g) => all.filter((f) => f.group === g));
}

// Kiểm tra công thức: trả về '' nếu đúng, ngược lại là lỗi
export function checkCostFormula(src, fields, selfKey) {
  try {
    const find = fieldResolver(fields, TRIP_VARS);
    for (const r of refsOf(parseFormula(src))) {
      const f = find(String(r).replace(/^SUM:/, ''));
      if (!f) return `Không có trường [${r}]. Dùng tên trường chi phí hoặc [Số lượng (tấn)].`;
      if (f.key === selfKey) return 'Công thức không được dùng chính trường này.';
    }
    return '';
  } catch (e) { return e.message; }
}

// Tính trường công thức + các tổng từ các ô đã nhập. ctx: { kg } của chuyến
export function calcCosts(c = {}, fields = BASE_COST_FIELDS, ctx = {}) {
  const v = { ...c };
  const fs = fields.filter((f) => f.formula);
  if (fs.length) {
    const find = fieldResolver(fields, TRIP_VARS);
    const trip = { _kg: n(ctx.kg), _tons: n(ctx.kg) / 1000 };
    const get = (name) => { const f = find(name); if (!f) return 0; if (f.key in trip) return trip[f.key]; return f.type === 'percent' ? n(v[f.key]) / 100 : n(v[f.key]); };
    // Vài lượt để công thức dùng kết quả công thức khác
    for (let i = 0; i < 3; i++) for (const f of fs) { try { v[f.key] = Math.round(evalTree(parseFormula(f.formula), get)); } catch { v[f.key] = 0; } }
  }
  const sumOf = (g) => fields.filter((f) => f.group === g).reduce((s, f) => s + n(v[f.key]), 0);
  const fuel = Math.round(n(v.freight) * n(v.fuelPct) / 100);
  const surcharge = sumOf('surcharge');
  const fees = sumOf('fee');
  const chiho = sumOf('chiho');
  const freightTotal = n(v.freight) + fuel + surcharge;
  return { ...Object.fromEntries(fs.map((f) => [f.key, v[f.key]])), fuel, surcharge, freightTotal, fees, chiho, total: freightTotal + fees + chiho };
}
// Tổng cước vận chuyển của chuyến (đã lưu; chuyến cũ: chỉ có cước)
export const freightTotalOf = (c) => (c ? (c.freightTotal != null ? n(c.freightTotal) : n(c.freight)) : 0);
// Tổng 1 nhóm của chuyến theo cấu hình trường hiện tại
export const groupTotalOf = (c, fields, g) => (c ? fields.filter((f) => f.group === g).reduce((s, f) => s + n(c[f.key]), 0) : 0);
