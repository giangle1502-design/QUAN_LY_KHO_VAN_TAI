import { useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { useCollection, useOrders, usePendingIn, useTrips, useWaitingOut } from './hooks';
import { OPEN_PLAN, planLeft, usePlans } from './shipPlans';
import { useMovesRange } from './slips';
import { leftKg, lineDue, lineFrom, lineShip, lineTo, lineWh, OPEN_STATUSES, stoRoute, transitKg } from './orders';
import { ACTIVE, ST, vnDate } from './trips';

// ============================================================================
// Điều phối kho: gom mọi đơn CÒN PHẢI XUẤT / CÒN PHẢI NHẬP thành 1 dòng mỗi đơn (không phải mỗi phiếu).
//  - Chờ xuất: SO + STO (kho đi) còn kg chưa xuất
//  - Chờ nhập: PO + SO trả hàng (DRT) còn kg chưa nhập, STO đã xuất đang đi đường / kho đi chưa xuất
// Mỗi dòng có bước đang ở (stage) để màn hình Bàn điều phối xếp thành cột, danh sách lọc theo ô số liệu.
// Không thêm collection: dựng trên orders, movements (phiếu chờ), shipPlans, allocations, trips.
// ============================================================================

const n = (v) => Number(v) || 0;
const EPS = 0.001;
const uniq = (a) => [...new Set(a.filter(Boolean))];
const minDate = (a) => uniq(a).sort()[0] || '';
export const addDays = (ymd, d) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

// Bước của đơn: nhãn, màu, thứ tự trên bảng điều phối
export const OUT_STAGES = [
  { key: 'make', label: 'Chờ lập phiếu xuất', short: 'Chờ lập phiếu', ico: '📋', tone: 'amber' },
  { key: 'goods', label: 'Chờ hàng về', short: 'Chờ hàng về', ico: '⏳', tone: '' },
  { key: 'release', label: 'Chờ giải chấp', short: 'Chờ giải chấp', ico: '🔒', tone: 'purple' },
  { key: 'truck', label: 'Có xe · đang xuất', short: 'Có xe · đang xuất', ico: '🚚', tone: 'blue' },
];
export const IN_STAGES = [
  { key: 'make', label: 'Chưa lập phiếu nhập', short: 'Chưa lập phiếu', ico: '📋', tone: 'amber' },
  { key: 'eta', label: 'Sắp về (chưa đến ngày)', short: 'Sắp về', ico: '🗓', tone: '' },
  { key: 'notShipped', label: 'Kho đi chưa xuất', short: 'Kho đi chưa xuất', ico: '🕓', tone: '' },
  { key: 'transit', label: 'Đang đi đường', short: 'Đang đi đường', ico: '🛣', tone: 'purple' },
  { key: 'truck', label: 'Xe đến · đang nhập', short: 'Xe đến · đang nhập', ico: '🚚', tone: 'blue' },
  { key: 'pending', label: 'Đã lập phiếu · chờ thủ kho nhận', short: 'Chờ thủ kho nhận', ico: '📥', tone: 'teal' },
];
export const stageMeta = (kind, key) => (kind === 'out' ? OUT_STAGES : IN_STAGES).find((s) => s.key === key) || { key, label: key, ico: '', tone: '' };

// Nhóm theo ngày giao / ngày về
export function dueBucket(due, today) {
  if (!due) return { key: '5', label: 'Chưa có ngày' };
  if (due < today) return { key: '0', label: 'Quá hạn' };
  if (due === today) return { key: '1', label: 'Hôm nay' };
  if (due === addDays(today, 1)) return { key: '2', label: 'Ngày mai' };
  if (due <= addDays(today, 7)) return { key: '3', label: 'Trong 7 ngày tới' };
  return { key: '4', label: 'Sau đó' };
}

// Trip (chuyến xe) đang hoạt động gắn với đơn
const TRIP_LIVE = [ST.PLANNED, ...ACTIVE];
const tripStage = (t) => ({
  [ST.PLANNED]: 'Đã giao vận tải, chờ xe', [ST.ARRIVED]: 'Xe đến cổng', [ST.WAITING_GATE]: 'Chờ vào cửa',
  [ST.PROCESSING]: `Đang ${t.purpose === 'import' ? 'nhập' : 'xuất'}${t.dock ? ` · cửa ${t.dock}` : ''}`,
  [ST.WAITING_EXIT]: 'Chờ ra cổng', [ST.WAITING_DELIVERY]: 'Đang đi giao',
}[t.status] || t.status);
export { tripStage };

export function usePendingData() {
  const { inMyWarehouses } = useApp();
  const { rows: orders, loading } = useOrders('');
  const pendIn = usePendingIn();
  const waitOut = useWaitingOut();
  const { rows: plans } = usePlans();
  const allocs = useCollection('allocations').rows;
  const trips = useTrips(TRIP_LIVE, '').rows;
  const today = vnDate();
  const todayMoves = useMovesRange(today, today).rows;

  return useMemo(() => {
    const byId = new Map(orders.map((o) => [o.id, o]));
    // Chuyến xe đang chạy theo đơn (mới nhất trước)
    const tripsOf = new Map();
    for (const t of trips) for (const id of uniq([...(t.orderIds || []), ...(t.lines || []).map((l) => l.orderId)])) {
      tripsOf.set(id, [...(tripsOf.get(id) || []), t]);
    }
    // Kế hoạch phân bổ gắn SO mà PO chưa nhập kg nào → SO đang chờ hàng về
    const waitGoods = new Map();
    for (const a of allocs) {
      if (a.status === 'cancelled' || a.orderType !== 'SO' || !a.orderId || !a.poId) continue;
      const po = byId.get(a.poId);
      const pol = (po?.lines || []).find((x) => x.no === a.poLine);
      if (pol && !(n(pol.doneKg) > 0)) waitGoods.set(`${a.orderId}#${a.orderLine}`, a.poId);
    }
    const plansOf = new Map();
    for (const p of plans) if (OPEN_PLAN.includes(p.status) && p.orderId) plansOf.set(p.orderId, [...(plansOf.get(p.orderId) || []), p]);

    const base = (o, kind, lines, extra) => {
      const ts = (tripsOf.get(o.id) || []).filter((t) => (kind === 'out' ? t.purpose !== 'import' : t.purpose === 'import'));
      const trip = ts.find((t) => t.status !== ST.PLANNED) || ts[0] || null;
      const due = minDate(lines.map((l) => l.due)) || o.dueDate || '';
      const whs = uniq(lines.map((l) => l.wh));
      return {
        key: `${kind}:${o.id}`, id: o.id, kind, type: o.type, o, company: o.company || '', refNo: o.refNo || '',
        party: o.type === 'STO' ? stoRoute(o) : o.partyName || o.partyCode || '', partyCode: o.partyCode || '',
        sales: o.salesName || o.sales || '', whs, wh: whs.join(', '), due, lines,
        items: uniq(lines.map((l) => l.item)), itemNames: uniq(lines.map((l) => l.itemName)),
        ships: uniq(lines.map((l) => l.ship)), qty: lines.reduce((a, l) => a + l.qty, 0), done: lines.reduce((a, l) => a + l.done, 0),
        inSlip: lines.reduce((a, l) => a + l.inSlip, 0), left: lines.reduce((a, l) => a + l.left, 0),
        trips: ts, trip, plate: trip?.plate || '', late: !!due && due < today, ...extra,
      };
    };

    // ----- CHỜ XUẤT: SO, STO (kho đi) -----
    const out = [];
    for (const o of orders) {
      if (!['SO', 'STO'].includes(o.type) || !OPEN_STATUSES.includes(o.status)) continue;
      const wait = waitOut.get(o.id);
      const lines = (o.lines || []).map((l) => ({
        no: l.no, item: l.item, itemName: l.itemName || '', qty: n(l.qtyKg), done: n(l.doneKg),
        inSlip: n(wait?.byLine?.[l.no]), left: leftKg(l), wh: lineWh(o, l), due: lineDue(o, l), ship: o.type === 'SO' ? lineShip(o, l) : '',
        to: o.type === 'STO' ? lineTo(o, l) : '', goods: waitGoods.get(`${o.id}#${l.no}`) || '',
      })).filter((l) => l.left > EPS);
      if (!lines.length) continue;
      const ps = plansOf.get(o.id) || [];
      const r = base(o, 'out', lines, { slipIds: wait?.ids || [], plans: ps });
      const free = lines.reduce((a, l) => a + Math.max(0, l.left - l.inSlip), 0);
      r.goodsPo = uniq(lines.filter((l) => l.goods).map((l) => l.goods));
      r.stage = r.slipIds.length ? 'release'
        : r.trip && r.trip.status !== ST.PLANNED ? 'truck'
          : r.goodsPo.length && lines.every((l) => l.goods || l.left - l.inSlip <= EPS) ? 'goods'
            : 'make';
      r.free = free;
      r.planLeft = ps.reduce((a, p) => a + (p.lines || []).reduce((b, l) => b + planLeft(l), 0), 0);
      out.push(r);
    }

    // ----- CHỜ NHẬP: PO, DRT, STO (kho đến) -----
    const inb = [];
    for (const o of orders) {
      if (!['PO', 'DRT', 'STO'].includes(o.type) || o.status === 'cancelled' || o.status === 'closed') continue;
      const pend = pendIn.get(o.id);
      let lines;
      if (o.type === 'STO') {
        lines = (o.lines || []).map((l) => ({
          no: l.no, item: l.item, itemName: l.itemName || '', qty: n(l.qtyKg), done: n(l.receivedKg), inSlip: n(pend?.byLine?.[l.no]),
          left: Math.max(0, n(l.qtyKg) - n(l.receivedKg)), transit: transitKg(l), notShipped: leftKg(l),
          wh: lineTo(o, l), from: lineFrom(o, l), due: lineDue(o, l), ship: '',
        })).filter((l) => l.left > EPS);
      } else {
        if (!OPEN_STATUSES.includes(o.status)) continue;
        lines = (o.lines || []).map((l) => ({
          no: l.no, item: l.item, itemName: l.itemName || '', qty: n(l.qtyKg), done: n(l.doneKg), inSlip: n(pend?.byLine?.[l.no]),
          left: leftKg(l), wh: lineWh(o, l, 'in') || o.warehouse || '', due: lineDue(o, l), ship: l.contNo || l.container || '',
        })).filter((l) => l.left > EPS);
      }
      if (!lines.length) continue;
      const r = base(o, 'in', lines, { slipIds: pend?.ids || [] });
      if (o.type === 'STO') {
        r.transit = lines.reduce((a, l) => a + l.transit, 0);
        r.notShipped = lines.reduce((a, l) => a + l.notShipped, 0);
        if (o.lastShipDate && !lines.some((l) => l.due)) r.due = o.lastShipDate;
      }
      r.conts = uniq([...lines.map((l) => l.ship), o.contNo, o.container]);
      r.stage = r.slipIds.length ? 'pending'
        : r.trip && r.trip.status !== ST.PLANNED ? 'truck'
          : o.type === 'STO' ? (r.transit > EPS ? 'transit' : 'notShipped')
            : r.due && r.due > today ? 'eta' : 'make';
      r.late = !!r.due && r.due < today;
      inb.push(r);
    }

    const mine = (r) => !r.whs.length || r.whs.some((w) => inMyWarehouses(w));
    return {
      out: out.filter(mine), inb: inb.filter(mine), trips: trips.filter((t) => inMyWarehouses(t.warehouse)),
      todayMoves: todayMoves.filter((m) => inMyWarehouses(m.warehouse) && m.status === 'posted' && ['in', 'out'].includes(m.type) && m.orderId),
      today, loading,
    };
  }, [orders, pendIn, waitOut, plans, allocs, trips, todayMoves, today, loading, inMyWarehouses]);
}

// Lọc theo bộ chọn nhiều kho / nhiều công ty (mảng rỗng = tất cả)
export const scopeRow = (scope) => (r) => (!scope.whs.length || r.whs.some(scope.inWh)) && (!scope.cos.length || scope.inCo(r.company));
export const scopeTrip = (scope) => (t) => !scope.whs.length || scope.inWh(t.warehouse);
export const scopeMove = (scope) => (m) => (!scope.whs.length || scope.inWh(m.warehouse)) && (!scope.cos.length || scope.inCo(m.company) || (m.lines || []).some((l) => scope.inCo(l.company)));

// Nút làm bước tiếp theo của 1 dòng: { to, label, primary } (null = không có việc cho người dùng này)
export function nextAction(r, { hasRole, isAdmin }) {
  if (r.kind === 'out') {
    if (r.stage === 'release') return hasRole('ke_toan', 'thu_kho') ? { to: '/kho/giai-chap', label: '🔓 Giải chấp' } : null;
    if (r.stage === 'truck') return hasRole('thu_kho') ? { to: '/xe/thu-kho', label: '🚚 Điều phối xe' } : null;
    if (!hasRole('thu_kho')) return null;
    const p = (r.plans || []).find((x) => (x.lines || []).some((l) => planLeft(l) > EPS));
    if (p) return { to: `/kho/out?plan=${p.id}`, label: '📤 Lập phiếu xuất', primary: r.stage === 'make' };
    return { to: `/kho/out?order=${r.id}`, label: '📤 Lập phiếu xuất', primary: r.stage === 'make' };
  }
  if (r.stage === 'pending') return hasRole('thu_kho') ? { to: `/kho/nhan-hang/${r.slipIds[0]}`, label: '✅ Nhận hàng', primary: true } : null;
  if (r.stage === 'truck') return hasRole('thu_kho') ? { to: '/xe/thu-kho', label: '🚚 Điều phối xe' } : null;
  if (r.stage === 'notShipped') return null;
  if (!isAdmin) return null;
  return { to: `/kho/in?order=${r.id}${r.type === 'DRT' ? '&src=drt' : ''}`, label: '📥 Lập phiếu nhập', primary: r.stage === 'make' || r.stage === 'transit' };
}
