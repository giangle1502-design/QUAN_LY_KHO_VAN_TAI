import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { stockId } from './stock';
import { listenShared, useShared } from './live';

// Nghe realtime toàn bộ 1 collection danh mục (danh mục thường nhỏ, vài nghìn dòng)
// (dùng chung 1 kết nối cho mọi trang, xem lib/live.js)
export function useCollection(name) {
  const st = useShared(name ? `c|${name}` : '', () => collection(db, name));
  const rows = useMemo(() => (st.snap ? st.snap.docs.map((d) => ({ _id: d.id, ...d.data() })) : []), [st.snap]);
  return { rows, loading: st.loading, error: st.error };
}

// Nghe nhiều danh mục cùng lúc (danh sách tên thay đổi theo cấu hình trường) → { tên: rows }
export function useCollections(names) {
  const key = [...new Set(names.filter(Boolean))].sort().join(',');
  const [data, setData] = useState({});
  useEffect(() => {
    if (!key) return undefined;
    const offs = key.split(',').map((n) => listenShared(`c|${n}`, () => collection(db, n),
      (s) => setData((d) => ({ ...d, [n]: s.snap ? s.snap.docs.map((x) => ({ _id: x.id, ...x.data() })) : [] }))));
    return () => offs.forEach((off) => off());
  }, [key]);
  return data;
}

// Kho đang thao tác (nhớ trên trình duyệt). '' = tất cả kho được giao

export function useMyWarehouses() {
  const { rows } = useCollection('warehouses');
  const { inMyWarehouses } = useApp();
  return useMemo(
    () => rows.filter((w) => w.active !== false && inMyWarehouses(w.code)).sort((a, b) => a.code.localeCompare(b.code)),
    [rows, inMyWarehouses]
  );
}

const WH_KEY = 'op-warehouse';
export function useOpWarehouse() {
  const [wh, setWh] = useState(() => { try { return localStorage.getItem(WH_KEY) || ''; } catch { return ''; } });
  const set = (v) => { setWh(v); try { localStorage.setItem(WH_KEY, v); } catch { /* bỏ qua */ } };
  return [wh, set];
}

// Công ty chủ hàng đang xem (nhớ trên trình duyệt). '' = tất cả công ty
const CO_KEY = 'op-company';
export function useOpCompany() {
  const [co, setCo] = useState(() => { try { return localStorage.getItem(CO_KEY) || ''; } catch { return ''; } });
  const set = (v) => { setCo(v); try { localStorage.setItem(CO_KEY, v); } catch { /* bỏ qua */ } };
  return [co, set];
}
export function useCompanies() {
  const { rows } = useCollection('companies');
  return useMemo(() => rows.filter((c) => c.active !== false).sort((a, b) =>
    String(a.kind).localeCompare(String(b.kind)) || a.code.localeCompare(b.code)), [rows]);
}

// Chuyến xe theo trạng thái (realtime), lọc theo kho được giao và kho đang chọn
export function useTrips(statuses, wh) {
  const { inMyWarehouses } = useApp();
  const key = statuses.join(',');
  const st = useShared(`trips|${key}`, () => query(collection(db, 'trips'), where('status', 'in', key.split(','))));
  const state = useMemo(() => ({ rows: st.snap ? st.snap.docs.map((d) => ({ ...d.data(), id: d.id })) : [], loading: st.loading, error: st.error }), [st]);
  const rows = useMemo(
    () => state.rows.filter((t) => inMyWarehouses(t.warehouse) && (!wh || t.warehouse === wh)),
    [state.rows, inMyWarehouses, wh]
  );
  return { ...state, rows };
}

// Tồn kho của 1 kho (hoặc mọi kho được giao khi wh rỗng), bỏ dòng đã hết hàng
export function useStock(wh) {
  const { inMyWarehouses } = useApp();
  const st = useShared(wh === '__none__' ? '' : `stock|${wh || ''}`, () => (wh ? query(collection(db, 'stock'), where('warehouse', '==', wh)) : collection(db, 'stock')));
  const state = useMemo(() => ({ rows: st.snap ? st.snap.docs.map((d) => ({ _id: d.id, ...d.data() })) : [], loading: st.loading, error: st.error }), [st]);
  const stale = false;
  const rows = useMemo(
    () => (stale ? [] : state.rows.filter((r) => inMyWarehouses(r.warehouse) && (Number(r.bags) > 0 || Number(r.pallets) > 0))),
    [state.rows, inMyWarehouses, stale]
  );
  return { error: state.error, loading: state.loading || stale, rows };
}

// Tồn của một mã hàng ở mọi kho mình được xem (để chọn kho xuất khi chưa biết hàng nằm ở đâu)
export function useItemStock(item) {
  const { inMyWarehouses } = useApp();
  const st = useShared(item ? `stock-item|${item}` : '', () => query(collection(db, 'stock'), where('item', '==', item)));
  const state = useMemo(() => ({ rows: st.snap ? st.snap.docs.map((d) => ({ _id: d.id, ...d.data() })) : [], loading: st.loading }), [st]);
  const stale = false;
  const rows = useMemo(
    () => (stale ? [] : state.rows.filter((r) => inMyWarehouses(r.warehouse) && (Number(r.bags) > 0 || Number(r.pallets) > 0 || Number(r.kg) > 0))),
    [state.rows, inMyWarehouses, stale]
  );
  return { loading: state.loading || stale, rows };
}

// Đơn bán / đơn mua (realtime). type: 'SO' | 'PO' | '' (cả hai); onlyOpen: chỉ đơn chưa xong
export function useOrders(type, onlyOpen = false) {
  const { salesOnly, email } = useApp();
  // Lọc trên server theo loại đơn (và sale phụ trách nếu người dùng chỉ được xem đơn của mình), lọc trạng thái trên trình duyệt
  const st = useShared(type === '__none__' ? '' : `orders|${type}|${salesOnly ? email : ''}`, () => {
    const conds = [...(type ? [where('type', '==', type)] : []), ...(salesOnly ? [where('sales', '==', email || '-')] : [])];
    return conds.length ? query(collection(db, 'orders'), ...conds) : collection(db, 'orders');
  });
  return useMemo(() => ({
    rows: st.snap ? st.snap.docs.map((d) => ({ ...d.data(), id: d.id })).filter((o) => !onlyOpen || ['open', 'partial'].includes(o.status)) : [],
    loading: st.loading, error: st.error,
  }), [st, onlyOpen]);
}

// Phiếu nhập đã lập, chờ thủ kho nhận hàng (chưa cập nhật đơn): Map số đơn → { ids: [số phiếu], byLine: { dòng đơn: kg } }
// Dùng để trừ vào phần còn phải nhập của PO / STO, tránh lập trùng phiếu
export const usePendingIn = () => usePendingMoves('in', 'pending');
// Phiếu xuất chờ giải chấp (chưa trừ tồn, chưa cập nhật đơn): trừ vào phần còn phải xuất của đơn
export const useWaitingOut = () => usePendingMoves('out', 'wait_release');
function usePendingMoves(type, status) {
  const [map, setMap] = useState(new Map());
  useEffect(() => listenShared(`mv|${type}|${status}`, () => query(collection(db, 'movements'), where('type', '==', type), where('status', '==', status)), (st) => {
    if (!st.snap) { const m = new Map(); m.byPlan = new Map(); m.loaded = true; setMap(m); return; }
    const s = st.snap;
    const m = new Map();
    // Phiếu theo dự kiến xuất: planId → [số phiếu]
    m.byPlan = new Map();
    for (const d of s.docs) {
      const x = d.data();
      if (x.planId) m.byPlan.set(x.planId, [...(m.byPlan.get(x.planId) || []), x.id || d.id]);
      if (!x.orderId) continue;
      if (!m.has(x.orderId)) m.set(x.orderId, { ids: [], byLine: {} });
      const e = m.get(x.orderId);
      e.ids.push(x.id || d.id);
      for (const l of x.lines || []) if (l.orderLine != null) e.byLine[l.orderLine] = (e.byLine[l.orderLine] || 0) + Math.abs(Number(l.kg) || 0);
    }
    // Phiếu xuất chờ giải chấp giữ chỗ dòng tồn (chưa trừ tồn): stockId → { kg, bags, pallets }
    m.byStock = new Map();
    if (type === 'out') {
      for (const d of s.docs) {
        const x = d.data();
        for (const l of x.lines || []) {
          const k = stockId({ ...l, warehouse: x.warehouse, company: l.company ?? x.company ?? '' });
          const c = m.byStock.get(k) || { kg: 0, bags: 0, pallets: 0 };
          c.kg += Math.abs(Number(l.kg) || 0); c.bags += Math.abs(Number(l.bags) || 0); c.pallets += Math.abs(Number(l.pallets) || 0);
          m.byStock.set(k, c);
        }
      }
    }
    m.loaded = true;
    setMap(m);
  }), [type, status]);
  return map;
}
