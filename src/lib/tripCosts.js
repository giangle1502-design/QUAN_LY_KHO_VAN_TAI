import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

// ============================================================================
// Chi phí chuyến xe. Tổng cước vận chuyển = Cước × (1 + % hỗ trợ dầu) + các phụ thu (vé, hạ rỗng trái tuyến…);
// Tổng chi phí = Tổng cước + các phí khác (hạ rỗng, nâng, cược cont, bốc xếp, chi hộ…).
// Quản trị tự thêm trường (nhóm Phụ thu: cộng vào tổng cước; nhóm Phí: cộng ngoài) ở settings/tripCostFields.
// ============================================================================
const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
export const COST_GROUPS = { surcharge: 'Phụ thu (cộng vào tổng cước)', fee: 'Phí khác (cộng ngoài tổng cước)' };
export const BASE_COST_FIELDS = [
  { key: 'freight', label: 'Cước vận chuyển', group: 'base' },
  { key: 'fuelPct', label: '% hỗ trợ dầu', group: 'pct' },
  { key: 'ticket', label: 'Phụ thu vé', group: 'surcharge' },
  { key: 'offRoute', label: 'Phụ thu hạ rỗng trái tuyến', group: 'surcharge' },
  { key: 'liftOff', label: 'Phí hạ rỗng', group: 'fee' },
  { key: 'liftOn', label: 'Phí nâng', group: 'fee' },
  { key: 'contDeposit', label: 'Phí cược cont', group: 'fee' },
  { key: 'bocXep', label: 'Phí bốc xếp', group: 'fee' },
  { key: 'chiHo', label: 'Phí chi hộ', group: 'fee' },
  { key: 'other', label: 'Phí khác', group: 'fee' },
];

// Danh sách trường chi phí (gốc + quản trị tự thêm, theo thứ tự: phụ thu trước, phí sau)
export function useCostFields() {
  const [extra, setExtra] = useState([]);
  useEffect(() => onSnapshot(doc(db, 'settings', 'tripCostFields'), (s) => setExtra(s.exists() ? s.data().extra || [] : []), () => setExtra([])), []);
  return costFieldsWith(extra);
}
export function costFieldsWith(extra = []) {
  const ex = extra.filter((f) => f.key && f.label && !BASE_COST_FIELDS.some((b) => b.key === f.key));
  const by = (g) => [...BASE_COST_FIELDS.filter((f) => f.group === g), ...ex.filter((f) => f.group === g)];
  return [...by('base'), ...by('pct'), ...by('surcharge'), ...by('fee')];
}

// Tính tổng từ các ô đã nhập
export function calcCosts(c = {}, fields = BASE_COST_FIELDS) {
  const fuel = Math.round(n(c.freight) * n(c.fuelPct) / 100);
  const surcharge = fields.filter((f) => f.group === 'surcharge').reduce((s, f) => s + n(c[f.key]), 0);
  const fees = fields.filter((f) => f.group === 'fee').reduce((s, f) => s + n(c[f.key]), 0);
  const freightTotal = n(c.freight) + fuel + surcharge;
  return { fuel, surcharge, freightTotal, fees, total: freightTotal + fees };
}
// Tổng cước vận chuyển của chuyến (đã lưu; chuyến cũ: chỉ có cước)
export const freightTotalOf = (c) => (c ? (c.freightTotal != null ? n(c.freightTotal) : n(c.freight)) : 0);
