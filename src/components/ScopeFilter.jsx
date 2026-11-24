import { createContext, useContext, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { useCollection, useCompanies, useMyWarehouses } from '../lib/hooks';
import { usePref } from '../lib/prefs';
import { allGroups, locWh, whsOfLocWh } from '../lib/whGroups';
import MultiPick from './MultiPick';

// Bộ lọc chọn nhiều kho, nhiều vị trí, nhiều pháp nhân (công ty chủ hàng) cho báo cáo và bảng danh sách.
// Lưu theo người dùng (opScope). Mảng rỗng = tất cả.
// Vị trí lưu dạng `${mã kho hoặc kho chung}__${mã vị trí}` (vị trí dùng chung của kho chung chỉ 1 mã).
const oldOne = (k) => { try { const v = localStorage.getItem(k); return v ? [v] : []; } catch { return []; } };

let init0 = null;
const INIT = () => (init0 ||= { whs: oldOne('op-warehouse'), cos: oldOne('op-company'), locs: [] });

export function useOpScope() {
  const { whTick } = useApp();
  const [v, setV] = usePref('opScope', INIT());
  const whs = v?.whs || [], cos = v?.cos || [], locs = v?.locs || [];
  return useMemo(() => {
    const W = new Set(whs), C = new Set(cos), L = new Set(locs);
    return {
      whs, cos, locs,
      setWhs: (x) => setV({ whs: x, cos, locs: locs.filter((l) => !x.length || whsOfLocWh(l.split('__')[0]).some((m) => x.includes(m))) }),
      setCos: (x) => setV({ whs, cos: x, locs }),
      setLocs: (x) => setV({ whs, cos, locs: x }),
      // 1 kho / 1 công ty đang chọn ('' khi chọn nhiều hoặc tất cả): dùng cho phần chỉ hiểu 1 kho
      wh: whs.length === 1 ? whs[0] : '',
      co: cos.length === 1 ? cos[0] : '',
      inWh: (code) => !W.size || W.has(code),
      inCo: (code) => !C.size || C.has(code || ''),
      inLoc: (wh, loc) => !L.size || L.has(`${locWh(wh)}__${loc || ''}`),
      // Dòng tồn / dòng phiếu: { warehouse, company, location }
      row: (r) => (!W.size || W.has(r.warehouse)) && (!C.size || C.has(r.company || '')) && (!L.size || L.has(`${locWh(r.warehouse)}__${r.location || ''}`)),
      // Vị trí trong danh mục (warehouse = kho hoặc kho chung)
      locRow: (l) => (!W.size || whsOfLocWh(l.warehouse).some((m) => W.has(m))) && (!L.size || L.has(`${l.warehouse}__${l.code}`)),
      text: () => [`Kho: ${whs.join(', ') || 'Tất cả kho được giao'}`, `Công ty: ${cos.join(', ') || 'Tất cả'}`, locs.length ? `Vị trí: ${locs.map((l) => l.split('__')[1]).join(', ')}` : ''].filter(Boolean).join(' · '),
    };
  }, [JSON.stringify(v), whTick]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Ô chọn nhiều kho (có chọn nhanh theo kho chung)
export function WarehouseMulti({ value, onChange }) {
  const list = useMyWarehouses();
  const { whTick } = useApp();
  const opts = list.map((w) => ({ value: w.code, label: `${w.code} – ${w.name || ''}`, short: w.code, group: locWh(w.code) !== w.code ? `Kho chung ${locWh(w.code)}` : '' }));
  const codes = new Set(list.map((w) => w.code));
  const quick = useMemo(() => allGroups().map((g) => ({ label: `${g.name || g.code} (tất cả)`, values: g.members.filter((m) => codes.has(m)) })).filter((g) => g.values.length),
    [whTick, list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return <MultiPick value={value} onChange={onChange} opts={opts} quick={quick} allLabel="Tất cả kho" unit="kho" />;
}

export function CompanyMulti({ value, onChange }) {
  const list = useCompanies();
  const opts = list.map((c) => ({ value: c.code, label: `${c.code}${c.name && c.name !== c.code ? ` – ${c.name}` : ''}${c.kind === 'Công ty khách' ? ' (khách)' : ''}`, short: c.code }));
  return <MultiPick value={value} onChange={onChange} opts={opts} allLabel="Tất cả công ty" unit="công ty" />;
}

// Ô chọn nhiều vị trí: chỉ vị trí của các kho đang chọn; vị trí dùng chung hiện 1 lần (ghi kho chung)
export function LocationMulti({ value, onChange, whs = [] }) {
  const { inMyWarehouses } = useApp();
  const { rows } = useCollection('locations');
  const opts = useMemo(() => rows
    .filter((l) => inMyWarehouses(l.warehouse) && (!whs.length || whsOfLocWh(l.warehouse).some((m) => whs.includes(m))))
    .sort((a, b) => String(a.warehouse).localeCompare(String(b.warehouse)) || String(a.code).localeCompare(String(b.code), 'vi', { numeric: true }))
    .map((l) => ({ value: `${l.warehouse}__${l.code}`, label: l.code, short: l.code, group: l.warehouse, search: l.note || '' })), [rows, whs, inMyWarehouses]);
  return <MultiPick value={value} onChange={onChange} opts={opts} allLabel="Tất cả vị trí" unit="vị trí" />;
}

// Bộ 3 ô lọc dùng trên đầu trang báo cáo / danh sách
export function ScopeFilters({ scope, noLoc, noCo }) {
  return (
    <>
      <WarehouseMulti value={scope.whs} onChange={scope.setWhs} />
      {!noLoc && <LocationMulti value={scope.locs} onChange={scope.setLocs} whs={scope.whs} />}
      {!noCo && <CompanyMulti value={scope.cos} onChange={scope.setCos} />}
    </>
  );
}

// Trang (VD Báo cáo) đặt bộ lọc chọn nhiều cho mọi bảng bên trong; bảng nào không có thì lọc theo 1 kho / 1 công ty như cũ
export const ScopeContext = createContext(null);
export function useScope(wh = '', co = '') {
  const s = useContext(ScopeContext);
  return useMemo(() => s || {
    whs: wh ? [wh] : [], cos: co ? [co] : [], locs: [], wh, co,
    inWh: (c) => !wh || c === wh, inCo: (c) => !co || (c || '') === co, inLoc: () => true,
    row: (r) => (!wh || r.warehouse === wh) && (!co || (r.company || '') === co),
    locRow: (l) => !wh || whsOfLocWh(l.warehouse).includes(wh), text: () => `Kho: ${wh || 'Tất cả kho được giao'} · Công ty: ${co || 'Tất cả'}`,
  }, [s, wh, co]);
}
