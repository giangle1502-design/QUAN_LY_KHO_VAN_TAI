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
  const [state, setState] = useState({ rows: [], loading: true, error: '' });
  const { inMyWarehouses } = useApp();
  useEffect(() => {
    const q = wh ? query(collection(db, 'stock'), where('warehouse', '==', wh)) : collection(db, 'stock');
    return onSnapshot(
      q,
      (snap) => setState({ rows: snap.docs.map((d) => ({ _id: d.id, ...d.data() })), loading: false, error: '' }),
      (e) => setState({ rows: [], loading: false, error: e.message })
    );
  }, [wh]);
  const rows = useMemo(
    () => state.rows.filter((r) => inMyWarehouses(r.warehouse) && (Number(r.bags) > 0 || Number(r.pallets) > 0)),
    [state.rows, inMyWarehouses]
  );
  return { ...state, rows };
}
