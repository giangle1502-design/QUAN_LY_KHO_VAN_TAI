import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';

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

// Đơn bán / đơn mua (realtime). type: 'SO' | 'PO' | '' (cả hai); onlyOpen: chỉ đơn chưa xong
export function useOrders(type, onlyOpen = false) {
  const [state, setState] = useState({ rows: [], loading: true, error: '' });
  useEffect(() => {
    // Lọc 1 trường trên server (không cần tạo chỉ mục kép), lọc trạng thái trên trình duyệt
    const q = type ? query(collection(db, 'orders'), where('type', '==', type)) : collection(db, 'orders');
    return onSnapshot(
      q,
      (snap) => setState({
        rows: snap.docs.map((d) => ({ ...d.data(), id: d.id })).filter((o) => !onlyOpen || ['open', 'partial'].includes(o.status)),
        loading: false, error: '',
      }),
      (e) => setState({ rows: [], loading: false, error: e.message })
    );
  }, [type, onlyOpen]);
  return state;
}
