import { doc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { catalogByKey } from '../catalogs';

// ============================================================================
// Luồng xe (giống app QLVT): Xe đến kho → Chờ vào cửa → Đang xuất/nhập → Chờ ra cổng
// → Chờ giao hàng → Hoàn thành.
//  • Kho không có bảo vệ: bỏ bước Xe đến kho (vào thẳng Chờ vào cửa) và Chờ ra cổng.
//  • Xe nhập hàng: hoàn thành khi ra cổng (không có bước giao hàng cho khách).
// Mỗi chuyến xe (GRP) là 1 document trong `trips`, các khách/lô (SP) nằm trong `lines`.
// ============================================================================

export const ST = {
  PLANNED: 'planned',
  ARRIVED: 'arrived',
  WAITING_GATE: 'waiting_gate',
  PROCESSING: 'processing',
  WAITING_EXIT: 'waiting_exit',
  WAITING_DELIVERY: 'waiting_delivery',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

export const STAGES = [ST.PLANNED, ST.ARRIVED, ST.WAITING_GATE, ST.PROCESSING, ST.WAITING_EXIT, ST.WAITING_DELIVERY, ST.COMPLETED];

export const STATUS_META = {
  [ST.PLANNED]: { label: 'Đã chia xe, chờ đến kho', tone: '' },
  [ST.ARRIVED]: { label: 'Xe đến kho', tone: '' },
  [ST.WAITING_GATE]: { label: 'Chờ vào cửa', tone: 'amber' },
  [ST.PROCESSING]: { label: 'Đang xuất/nhập', tone: 'blue' },
  [ST.WAITING_EXIT]: { label: 'Chờ ra cổng', tone: 'purple' },
  [ST.WAITING_DELIVERY]: { label: 'Chờ giao hàng', tone: 'teal' },
  [ST.COMPLETED]: { label: 'Hoàn thành', tone: 'green' },
  [ST.CANCELLED]: { label: 'Đã hủy', tone: 'red' },
};
export const ACTIVE = [ST.ARRIVED, ST.WAITING_GATE, ST.PROCESSING, ST.WAITING_EXIT, ST.WAITING_DELIVERY];

export const PURPOSES = [['export', 'Lấy hàng (xuất kho)'], ['import', 'Nhập hàng (vào kho)']];
export const purposeLabel = (p) => (p === 'import' ? 'Nhập hàng' : 'Lấy hàng');

// Các bước chuyến xe sẽ đi qua (để vẽ thanh tiến trình)
export function stagesOf(trip) {
  return STAGES.filter((s) => {
    if (s === ST.PLANNED && trip.source !== 'plan') return false;
    if (!trip.hasGuard && (s === ST.ARRIVED || s === ST.WAITING_EXIT)) return false;
    if (trip.purpose === 'import' && s === ST.WAITING_DELIVERY) return false;
    return true;
  });
}
export const firstStatus = (hasGuard) => (hasGuard ? ST.ARRIVED : ST.WAITING_GATE);
const afterExit = (trip) => (trip.purpose === 'import' ? ST.COMPLETED : ST.WAITING_DELIVERY);
export const afterProcess = (trip) => (trip.hasGuard ? ST.WAITING_EXIT : afterExit(trip));
export { afterExit };

export const nowISO = () => new Date().toISOString();
export function fmtTime(iso) {
  if (!iso) return '—';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}
export function vnDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(iso ? new Date(iso) : new Date());
}
export function minutesBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}
export function fmtDuration(min) {
  if (min == null) return '';
  if (min < 60) return `${min} phút`;
  return `${Math.floor(min / 60)} giờ ${min % 60} phút`;
}

// Cấp nhiều mã liên tiếp theo Quy tắc mã tự sinh (codeRules/{code}) trong 1 giao dịch
export async function reserveCodes(code, count = 1) {
  const ref = doc(db, 'codeRules', code);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const seed = catalogByKey('codeRules').seed.find((s) => s.code === code);
    const rule = snap.exists() ? snap.data() : seed;
    if (!rule) throw new Error(`Chưa có quy tắc mã ${code}.`);
    const start = Number(rule.next) || 1;
    const digits = Number(rule.digits) || 5;
    const prefix = rule.prefix ?? code;
    const next = start + count;
    if (snap.exists()) tx.update(ref, { next });
    else tx.set(ref, { ...seed, next });
    return Array.from({ length: count }, (_, i) => `${prefix}${String(start + i).padStart(digits, '0')}`);
  });
}

export function matchesTrip(t, q) {
  if (!q) return true;
  const hay = [t.id, t.plate, t.driverName, t.idCard, t.carrierName, t.warehouse, t.dock,
    ...(t.lines || []).flatMap((l) => [l.id, l.partyCode, l.partyName, l.shipCode])].join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}
