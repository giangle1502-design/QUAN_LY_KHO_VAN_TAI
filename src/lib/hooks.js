import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { stockId } from './stock';

// Nghe realtime toàn bộ 1 collection danh mục (danh mục thường nhỏ, vài nghìn dòng)
export function useCollection(name) {
  const [state, setState] = useState({ rows: [], loading: true, error: '' });
  useEffect(() => {
    if (!name) return;
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      collection(db, name),
      (snap) => setState({ rows: snap.docs.map((d) => ({ _id: d.id, ...d.data() })), loading: false, error: '' }),
      (e) => setState({ rows: [], loading: false, error: e.message })
    );
  }, [name]);
  return state;
}

// Nghe nhiều danh mục cùng lúc (danh sách tên thay đổi theo cấu hình trường) → { tên: rows }
export function useCollections(names) {
  const key = [...new Set(names.filter(Boolean))].sort().join(',');
  const [data, setData] = useState({});
  useEffect(() => {
    if (!key) return undefined;
    const offs = key.split(',').map((n) => onSnapshot(collection(db, n),
      (snap) => setData((d) => ({ ...d, [n]: snap.docs.map((x) => ({ _id: x.id, ...x.data() })) })),
      () => setData((d) => ({ ...d, [n]: [] }))));
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
  const [state, setState] = useState({ rows: [], loading: true, error: '' });
  const { inMyWarehouses } = useApp();
  const key = statuses.join(',');
  useEffect(() => {
    const q = query(collection(db, 'trips'), where('status', 'in', key.split(',')));
    return onSnapshot(
      q,
      (snap) => setState({ rows: snap.docs.map((d) => ({ ...d.data(), id: d.id })), loading: false, error: '' }),
      (e) => setState({ rows: [], loading: false, error: e.message })
    );
  }, [key]);
  const rows = useMemo(
    () => state.rows.filter((t) => inMyWarehouses(t.warehouse) && (!wh || t.warehouse === wh)),
    [state.rows, inMyWarehouses, wh]
  );
  return { ...state, rows };
}

// Tồn kho của 1 kho (hoặc mọi kho được giao khi wh rỗng), bỏ dòng đã hết hàng
export function useStock(wh) {
  const [state, setState] = useState({ rows: [], loading: true, error: '', for: undefined });
  const { inMyWarehouses } = useApp();
  useEffect(() => {
    setState({ rows: [], loading: true, error: '', for: wh });
    const q = wh ? query(collection(db, 'stock'), where('warehouse', '==', wh)) : collection(db, 'stock');
    return onSnapshot(
      q,
      (snap) => setState({ rows: snap.docs.map((d) => ({ _id: d.id, ...d.data() })), loading: false, error: '', for: wh }),
      (e) => setState({ rows: [], loading: false, error: e.message, for: wh })
    );
  }, [wh]);
  // Lần render ngay sau khi đổi kho vẫn còn dữ liệu kho cũ: coi như đang tải
  const stale = state.for !== wh;
  const rows = useMemo(
    () => (stale ? [] : state.rows.filter((r) => inMyWarehouses(r.warehouse) && (Number(r.bags) > 0 || Number(r.pallets) > 0))),
    [state.rows, inMyWarehouses, stale]
  );
  return { error: state.error, loading: state.loading || stale, rows };
}

// Tồn của một mã hàng ở mọi kho mình được xem (để chọn kho xuất khi chưa biết hàng nằm ở đâu)
export function useItemStock(item) {
  const [state, setState] = useState({ rows: [], loading: true, for: undefined });
  const { inMyWarehouses } = useApp();
  useEffect(() => {
    if (!item) return setState({ rows: [], loading: false, for: item });
    setState({ rows: [], loading: true, for: item });
    return onSnapshot(
      query(collection(db, 'stock'), where('item', '==', item)),
      (snap) => setState({ rows: snap.docs.map((d) => ({ _id: d.id, ...d.data() })), loading: false, for: item }),
      () => setState({ rows: [], loading: false, for: item })
    );
  }, [item]);
  const stale = state.for !== item;
  const rows = useMemo(
    () => (stale ? [] : state.rows.filter((r) => inMyWarehouses(r.warehouse) && (Number(r.bags) > 0 || Number(r.pallets) > 0 || Number(r.kg) > 0))),
    [state.rows, inMyWarehouses, stale]
  );
  return { loading: state.loading || stale, rows };
}

// Đơn bán / đơn mua (realtime). type: 'SO' | 'PO' | '' (cả hai); onlyOpen: chỉ đơn chưa xong
export function useOrders(type, onlyOpen = false) {
  const [state, setState] = useState({ rows: [], loading: true, error: '' });
  const { salesOnly, email } = useApp();
  useEffect(() => {
    // Lọc trên server theo loại đơn (và sale phụ trách nếu người dùng chỉ được xem đơn của mình), lọc trạng thái trên trình duyệt
    const conds = [...(type ? [where('type', '==', type)] : []), ...(salesOnly ? [where('sales', '==', email || '-')] : [])];
    const q = conds.length ? query(collection(db, 'orders'), ...conds) : collection(db, 'orders');
    return onSnapshot(
      q,
      (snap) => setState({
        rows: snap.docs.map((d) => ({ ...d.data(), id: d.id })).filter((o) => !onlyOpen || ['open', 'partial'].includes(o.status)),
        loading: false, error: '',
      }),
      (e) => setState({ rows: [], loading: false, error: e.message })
    );
  }, [type, onlyOpen, salesOnly, email]);
  return state;
}

// Phiếu nhập đã lập, chờ thủ kho nhận hàng (chưa cập nhật đơn): Map số đơn → { ids: [số phiếu], byLine: { dòng đơn: kg } }
// Dùng để trừ vào phần còn phải nhập của PO / STO, tránh lập trùng phiếu
export const usePendingIn = () => usePendingMoves('in', 'pending');
// Phiếu xuất chờ giải chấp (chưa trừ tồn, chưa cập nhật đơn): trừ vào phần còn phải xuất của đơn
export const useWaitingOut = () => usePendingMoves('out', 'wait_release');
function usePendingMoves(type, status) {
  const [map, setMap] = useState(new Map());
  useEffect(() => onSnapshot(query(collection(db, 'movements'), where('type', '==', type), where('status', '==', status)), (s) => {
    const m = new Map();
    for (const d of s.docs) {
      const x = d.data();
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
  }, () => { const m = new Map(); m.loaded = true; setMap(m); }), [type, status]);
  return map;
}
