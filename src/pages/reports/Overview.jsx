import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useOrders } from '../../lib/hooks';
import { useOrderSecrets, viewOrder } from '../../lib/orderSecrets';
import { lineFrom, lineTo, lineWh } from '../../lib/orders';
import { useOrderMoney, n } from '../../lib/orderMoney';
import { costTotal } from '../../lib/transport';
import { vnDate } from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { Empty, ErrorBox } from '../../components/ui';
import { ReportTable, toSheet } from './Reports';
import MoneyConfig, { NoMoneyNote } from './MoneyConfig';
import Select from '../../components/Select';

// ============================================================================
// Báo cáo tổng quan trong một khoảng ngày: Mua hàng (PO) · Chuyển kho & vận tải (STO, chuyến xe) · Bán hàng (SO)
// Ngày của đơn = Ngày tạo đơn; ngày của chuyến = ngày đi (plannedDate). Bỏ đơn / chuyến đã hủy.
// Tiền mua / doanh thu lấy từ trường tiền của dòng đơn (chỉ người được xem giá mới thấy).
// Cước = chi phí điều phối nhập trên chuyến; chuyến chở nhiều đơn thì chia theo số kg của từng đơn.
// ============================================================================

const kgf = (v) => fmtNum(v, 0);
const tan = (v) => fmtNum(n(v) / 1000, 2);
const money = (v) => fmtNum(Math.round(n(v)), 0);
const monthStart = (d = vnDate()) => d.slice(0, 8) + '01';
const addMonths = (ymd, k) => { const [y, m] = ymd.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return d.toISOString().slice(0, 10); };
const lastDay = (ymd) => { const [y, m] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const PRESETS = [
  ['Tháng này', () => [monthStart(), vnDate()]],
  ['Tháng trước', () => { const s = addMonths(monthStart(), -1); return [s, lastDay(s)]; }],
  ['Quý này', () => { const d = vnDate(); const q = Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1; return [`${d.slice(0, 4)}-${String(q).padStart(2, '0')}-01`, d]; }],
  ['Năm nay', () => [vnDate().slice(0, 4) + '-01-01', vnDate()]],
];

function group(rows, key, init) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, { _k: k, ...init(r), __rows: [] });
    m.get(k).__rows.push(r);
  }
  return [...m.values()];
}
const sum = (rows, f) => rows.reduce((s, r) => s + n(f(r)), 0);

function Stat({ label, value, sub, tone }) {
  return <div className={'stat ' + (tone || '')}><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub && <div className="stat-sub">{sub}</div>}</div>;
}

export default function Overview({ wh, co, q }) {
  const { inMyWarehouses } = useApp();
  const [range, setRange] = useState(() => [monthStart(), vnDate()]);
  const [from, to] = range;
  const [scope, setScope] = useState('STO'); // chuyến xe tính vào phần vận tải: STO | SO | all
  const [cfg, setCfg] = useState(''); // '' | 'PO' | 'SO'
  const { rows: raw, error, loading } = useOrders('');
  const secSO = useOrderSecrets('SO');
  const secPO = useOrderSecrets('PO');
  const mSO = useOrderMoney('SO');
  const mPO = useOrderMoney('PO');
  const trips = useCollection('trips');
  const carriers = useCollection('carriers').rows;
  const suppliers = useCollection('suppliers').rows;
  const users = useCollection('users').rows;
  const carrierName = useMemo(() => new Map(carriers.map((c) => [c.code, c.name || c.code])), [carriers]);
  const saleName = useMemo(() => new Map(users.map((u) => [u.email, u.name || u.email])), [users]);

  const inRange = (d) => !!d && d >= from && d <= to;
  const whOk = (w) => (!w || inMyWarehouses(w)) && (!wh || w === wh);
  const qOk = (...xs) => !q || norm(xs.join(' ')).includes(q);

  // Dòng đơn trong kỳ
  const lines = useMemo(() => {
    const out = { SO: [], PO: [], STO: [] };
    for (const o0 of raw) {
      if (o0.status === 'cancelled' || !inRange(o0.date) || (co && (o0.company || '') !== co)) continue;
      const t = o0.type;
      const m = t === 'SO' ? mSO : t === 'PO' ? mPO : null;
      const o = m ? viewOrder(o0, t === 'SO' ? secSO : secPO, m.headSeen, m.lineSeen) : o0;
      for (const l of o.lines || []) {
        const w = t === 'STO' ? lineFrom(o, l) : lineWh(o, l, t === 'PO' ? 'in' : 'out');
        const w2 = t === 'STO' ? lineTo(o, l) : '';
        if (!(whOk(w) || (w2 && whOk(w2)))) continue;
        if (!qOk(o.id, o.partyCode, o.partyName, l.item, l.itemName, w, w2)) continue;
        const qty = n(l.qtyKg); const done = n(l.doneKg);
        const mm = m ? m.lineMoney(l, o) : { full: 0, price: 0 };
        out[t]?.push({
          id: o.id, date: o.date, co: o.company || '', party: o.partyCode || '', partyName: o.partyName || o.partyCode || '', sales: o.sales || '', direct: !!o.direct,
          item: l.item || '', itemName: l.itemName || '', wh: w, wh2: w2, carrier: l.carrier || '', qty, done, left: Math.max(0, qty - done), received: n(l.receivedKg),
          transit: Math.max(0, done - n(l.receivedKg)), amt: mm.full, amtDone: qty ? mm.full * Math.min(1, done / qty) : 0, _l: l,
        });
      }
    }
    return out;
  }, [raw, from, to, co, wh, q, secSO, secPO, mSO, mPO, inMyWarehouses]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chuyến xe trong kỳ, phần thuộc phạm vi (STO / SO), cước chia theo kg
  const typeOf = useMemo(() => new Map(raw.map((o) => [o.id, o.type])), [raw]);
  const tripRows = useMemo(() => trips.rows.filter((t) => t.status !== 'cancelled' && inRange(t.plannedDate || t.arrivalDate) && whOk(t.warehouse)).map((t) => {
    const ls = t.lines || [];
    const kgOf = (l) => n(l.plannedKg ?? n(l.payload) * 1000);
    const total = sum(ls, kgOf);
    const mine = ls.filter((l) => { const ty = typeOf.get(l.orderId) || String(l.orderId || '').replace(/\d+$/, ''); return scope === 'all' || ty === scope; });
    const kg = sum(mine, kgOf);
    const share = total ? kg / total : 0;
    const c = t.costs || {};
    return {
      _k: t.id, id: t.id, date: t.plannedDate || t.arrivalDate || '', carrier: t.carrier || '', carrierName: t.carrierName || carrierName.get(t.carrier) || t.carrier || '(chưa có đơn vị)',
      plate: t.plate || '', wh: t.warehouse || '', dest: [...new Set(mine.map((l) => l.partyName || l.partyCode).filter(Boolean))].join(', '),
      orders: [...new Set(mine.map((l) => l.orderId))].join(', '), kg, freight: n(c.freight) * share, extra: (n(c.chiHo) + n(c.bocXep) + n(c.other)) * share,
      cost: costTotal(c) * share, hasCost: !!t.costs, approved: t.costStatus === 'approved', status: t.status,
      _q: [t.id, t.plate, t.carrier, t.carrierName, ...mine.flatMap((l) => [l.orderId, l.item, l.partyName])].join(' '),
    };
  }).filter((r) => r.kg > 0 && qOk(r._q)), [trips.rows, from, to, wh, q, scope, typeOf, carrierName, inMyWarehouses]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Empty text="Đang tải…" />;
  const PO = lines.PO; const SO = lines.SO; const STO = lines.STO;
  const hasPOmoney = PO.some((r) => r.amt); const hasSOmoney = SO.some((r) => r.amt);
  const supName = new Map(suppliers.map((s) => [s.code, s.name]));

  // ---- Mua hàng
  const poAgg = (rows) => ({ nPO: new Set(rows.map((r) => r.id)).size, qty: sum(rows, (r) => r.qty), done: sum(rows, (r) => r.done), left: sum(rows, (r) => r.left), amt: sum(rows, (r) => r.amt), amtDone: sum(rows, (r) => r.amtDone) });
  const PK = poAgg(PO);
  const poBySup = group(PO, (r) => r.party || '(không ghi NCC)', (r) => ({ code: r.party, name: r.partyName || supName.get(r.party) || '' }))
    .map((x) => { const a = poAgg(x.__rows); return { ...x, ...a, avg: a.qty ? (a.amt / a.qty) * mPO.perUnit : 0 }; }).sort((a, b) => b.amt - a.amt || b.qty - a.qty);
  const poByItem = group(PO, (r) => r.item, (r) => ({ item: r.item, itemName: r.itemName }))
    .map((x) => { const a = poAgg(x.__rows); return { ...x, ...a, avg: a.qty ? (a.amt / a.qty) * mPO.perUnit : 0 }; }).sort((a, b) => b.qty - a.qty);
  const poMoneyCols = (h) => (h ? [{ key: 'amt', label: 'Tiền mua (đ)', num: true, sum: true, style: () => ({ fontWeight: 700 }) }, { key: 'amtDone', label: 'Tiền hàng đã nhận (đ)', num: true, sum: true }, { key: 'avg', label: `Giá BQ (${mPO.unitLabel})`, num: true }] : []);
  const poCols = (first) => [...first, { key: 'nPO', label: 'Số PO', num: true }, { key: 'qty', label: 'Đặt mua (kg)', num: true, sum: true }, { key: 'done', label: 'Đã nhận (kg)', num: true, sum: true },
    { key: 'left', label: 'Còn chưa về (kg)', num: true, sum: true }, ...poMoneyCols(hasPOmoney)];
  const supCols = poCols([{ key: 'code', label: 'Mã NCC' }, { key: 'name', label: 'Nhà cung cấp' }]);
  const pItemCols = poCols([{ key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' }]);

  // ---- Chuyển kho & vận tải
  const tk = { n: tripRows.length, kg: sum(tripRows, (r) => r.kg), freight: sum(tripRows, (r) => r.freight), cost: sum(tripRows, (r) => r.cost), missing: tripRows.filter((r) => !r.hasCost).length };
  const byCarrier = group(tripRows, (r) => r.carrier || '-', (r) => ({ carrier: r.carrier, name: r.carrierName })).map((x) => {
    const rs = x.__rows; const kg = sum(rs, (r) => r.kg); const cost = sum(rs, (r) => r.cost);
    return { ...x, trips: rs.length, kg, freight: sum(rs, (r) => r.freight), extra: sum(rs, (r) => r.extra), cost, perT: kg ? (cost / kg) * 1000 : 0, missing: rs.filter((r) => !r.hasCost).length, approved: rs.filter((r) => r.approved).length };
  }).sort((a, b) => b.kg - a.kg);
  const carCols = [{ key: 'carrier', label: 'Mã' }, { key: 'name', label: 'Đơn vị vận tải' }, { key: 'trips', label: 'Số chuyến', num: true, sum: true },
    { key: 'kg', label: 'Đã chở (kg)', num: true, sum: true }, { key: 'freight', label: 'Cước (đ)', num: true, sum: true, style: () => ({ fontWeight: 700 }) },
    { key: 'extra', label: 'Chi hộ, bốc xếp, khác (đ)', num: true, sum: true }, { key: 'cost', label: 'Tổng chi phí (đ)', num: true, sum: true },
    { key: 'perT', label: 'Chi phí BQ (đ/tấn)', num: true }, { key: 'missing', label: 'Chuyến chưa nhập cước', num: true, sum: true, style: (r) => (r.missing ? { color: 'var(--amber)', fontWeight: 600 } : undefined) },
    { key: 'approved', label: 'Kế toán đã chốt', num: true, sum: true }];
  const tripCols = [{ key: 'date', label: 'Ngày đi', render: (r) => fmtDate(r.date), nowrap: true }, { key: 'id', label: 'Chuyến', nowrap: true }, { key: 'carrierName', label: 'Đơn vị vận tải' },
    { key: 'plate', label: 'Số xe' }, { key: 'wh', label: 'Kho đi' }, { key: 'dest', label: 'Giao đến' }, { key: 'orders', label: 'Đơn' },
    { key: 'kg', label: 'Kg', num: true, sum: true }, { key: 'freight', label: 'Cước (đ)', num: true, sum: true }, { key: 'cost', label: 'Tổng chi phí (đ)', num: true, sum: true },
    { key: 'hasCost', label: 'Chi phí', render: (r) => (r.approved ? 'Đã chốt' : r.hasCost ? 'Đã nhập' : 'Chưa nhập'), excel: (r) => (r.approved ? 'Đã chốt' : r.hasCost ? 'Đã nhập' : 'Chưa nhập') }];
  const stoK = { n: new Set(STO.map((r) => r.id)).size, qty: sum(STO, (r) => r.qty), done: sum(STO, (r) => r.done), received: sum(STO, (r) => r.received), transit: sum(STO, (r) => r.transit) };
  const byRoute = group(STO, (r) => `${r.wh || '?'} → ${r.wh2 || '?'}`, (r) => ({ route: `${r.wh || '?'} → ${r.wh2 || '?'}` })).map((x) => {
    const rs = x.__rows;
    return { ...x, nSto: new Set(rs.map((r) => r.id)).size, qty: sum(rs, (r) => r.qty), done: sum(rs, (r) => r.done), received: sum(rs, (r) => r.received), transit: sum(rs, (r) => r.transit), left: sum(rs, (r) => r.left),
      carriers: [...new Set(rs.map((r) => carrierName.get(r.carrier) || r.carrier).filter(Boolean))].join(', ') };
  }).sort((a, b) => b.qty - a.qty);
  const routeCols = [{ key: 'route', label: 'Kho đi → kho đến' }, { key: 'nSto', label: 'Số lệnh', num: true }, { key: 'qty', label: 'Kế hoạch (kg)', num: true, sum: true },
    { key: 'done', label: 'Đã xuất (kg)', num: true, sum: true }, { key: 'received', label: 'Đã nhận (kg)', num: true, sum: true },
    { key: 'transit', label: 'Đang đi đường (kg)', num: true, sum: true, style: (r) => (r.transit ? { color: 'var(--amber)', fontWeight: 600 } : undefined) },
    { key: 'left', label: 'Còn phải xuất (kg)', num: true, sum: true }, { key: 'carriers', label: 'Đơn vị vận tải' }];

  // ---- Bán hàng
  const soAgg = (rows) => ({ nSo: new Set(rows.map((r) => r.id)).size, nCust: new Set(rows.map((r) => r.party)).size, qty: sum(rows, (r) => r.qty), done: sum(rows, (r) => r.done), left: sum(rows, (r) => r.left), amt: sum(rows, (r) => r.amt), amtDone: sum(rows, (r) => r.amtDone) });
  const SK = soAgg(SO);
  const soMoneyCols = hasSOmoney ? [{ key: 'amt', label: 'Doanh thu (đ)', num: true, sum: true, style: () => ({ fontWeight: 700 }) }, { key: 'amtDone', label: 'Doanh thu đã giao (đ)', num: true, sum: true }, { key: 'avg', label: `Giá BQ (${mSO.unitLabel})`, num: true }] : [];
  const soBySale = group(SO, (r) => r.sales || '-', (r) => ({ sale: r.sales ? saleName.get(r.sales) || r.sales : '(chưa ghi sale)' }))
    .map((x) => { const a = soAgg(x.__rows); return { ...x, ...a, avg: a.qty ? (a.amt / a.qty) * mSO.perUnit : 0 }; }).sort((a, b) => b.amt - a.amt || b.qty - a.qty);
  const soByCust = group(SO, (r) => r.party, (r) => ({ code: r.party, name: r.partyName }))
    .map((x) => { const a = soAgg(x.__rows); return { ...x, ...a, avg: a.qty ? (a.amt / a.qty) * mSO.perUnit : 0 }; }).sort((a, b) => b.amt - a.amt || b.qty - a.qty);
  const soQtyCols = [{ key: 'nSo', label: 'Số đơn', num: true }, { key: 'qty', label: 'Đặt (kg)', num: true, sum: true }, { key: 'done', label: 'Đã giao (kg)', num: true, sum: true }, { key: 'left', label: 'Còn phải giao (kg)', num: true, sum: true }];
  const saleCols = [{ key: 'sale', label: 'Sale phụ trách' }, { key: 'nCust', label: 'Số KH', num: true }, ...soQtyCols, ...soMoneyCols];
  const custCols = [{ key: 'code', label: 'Mã KH' }, { key: 'name', label: 'Khách hàng' }, ...soQtyCols, ...soMoneyCols];

  const excel = () => exportSheets(`BC_tong_quan_${from}_${to}`, {
    'Mua - theo NCC': toSheet(supCols, poBySup), 'Mua - theo mã hàng': toSheet(pItemCols, poByItem),
    'Vận tải - theo đơn vị': toSheet(carCols, byCarrier), 'Vận tải - chuyến': toSheet(tripCols, tripRows), 'Chuyển kho - tuyến': toSheet(routeCols, byRoute),
    'Bán - theo sale': toSheet(saleCols, soBySale), 'Bán - theo khách': toSheet(custCols, soByCust),
  });
  const scopeLabel = { STO: 'chuyến chở hàng chuyển kho (STO)', SO: 'chuyến giao hàng bán (SO)', all: 'mọi chuyến' }[scope];

  return (
    <>
      <ErrorBox error={error || trips.error} />
      <div className="filters no-print">
        <label>Từ <input type="date" value={from} onChange={(e) => setRange([e.target.value, to])} /></label>
        <label>đến <input type="date" value={to} onChange={(e) => setRange([from, e.target.value])} /></label>
        {PRESETS.map(([l, f]) => <button key={l} className="chip" onClick={() => setRange(f())}>{l}</button>)}
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={excel}>⬇ Excel</button>
        <button className="btn" onClick={() => window.print()}>🖨 In</button>
      </div>
      <p className="print-only small">Từ {fmtDate(from)} đến {fmtDate(to)}</p>

      <div className="section-head">📥 Mua hàng <span className="small">— đơn mua (PO) lập trong kỳ, kể cả nhập trực tiếp</span>
        <button className="btn ghost no-print" style={{ marginLeft: 'auto' }} onClick={() => setCfg(cfg === 'PO' ? '' : 'PO')}>⚙ Cách tính tiền mua</button></div>
      {cfg === 'PO' && <MoneyConfig m={mPO} what="tiền mua" />}
      <div className="stats">
        <Stat label="Đặt mua" value={`${kgf(PK.qty)} kg`} sub={`= ${tan(PK.qty)} tấn · ${PK.nPO} PO`} />
        <Stat label="Đã nhận về kho" value={`${kgf(PK.done)} kg`} sub={`= ${tan(PK.done)} tấn · còn chưa về ${kgf(PK.left)} kg`} tone="green" />
        {hasPOmoney && <Stat label="Tổng tiền mua vào (VNĐ)" value={`${money(PK.amt)} đ`} sub={`Hàng đã nhận: ${money(PK.amtDone)} đ`} tone="amber" />}
        {hasPOmoney && <Stat label="Giá mua bình quân" value={`${money(PK.qty ? (PK.amt / PK.qty) * mPO.perUnit : 0)} ${mPO.unitLabel}`} />}
      </div>
      {!hasPOmoney && PO.length > 0 && <NoMoneyNote m={mPO} rows={PO} what="tiền mua" onConfig={() => setCfg('PO')} />}
      <div className="section-head">Theo nhà cung cấp</div>
      <ReportTable cols={supCols} rows={poBySup} links={[{ key: 'code', cat: 'suppliers', label: 'NCC' }]} empty="Không có đơn mua trong kỳ." />
      <div className="section-head" style={{ marginTop: 16 }}>Theo mã hàng</div>
      <ReportTable cols={pItemCols} rows={poByItem} empty="Không có đơn mua trong kỳ." />

      <div className="section-head" style={{ marginTop: 20 }}>🚚 Chuyển kho & vận tải
        <Select className="no-print" value={scope} onChange={(e) => setScope(e.target.value)} style={{ fontWeight: 400 }}>
          <option value="STO">Chuyến chở hàng chuyển kho (STO)</option>
          <option value="SO">Chuyến giao hàng bán (SO)</option>
          <option value="all">Mọi chuyến</option>
        </Select></div>
      <div className="stats">
        <Stat label="Số chuyến" value={tk.n} sub={tk.missing ? `${tk.missing} chuyến chưa nhập cước` : 'Đã nhập cước đủ'} tone={tk.missing ? 'amber' : ''} />
        <Stat label="Đã chở" value={`${kgf(tk.kg)} kg`} sub={`= ${tan(tk.kg)} tấn`} tone="green" />
        <Stat label="Cước vận chuyển" value={`${money(tk.freight)} đ`} sub={`Tổng chi phí (cả chi hộ, bốc xếp): ${money(tk.cost)} đ`} tone="amber" />
        <Stat label="Chi phí BQ" value={`${money(tk.kg ? (tk.cost / tk.kg) * 1000 : 0)} đ/tấn`} />
        {scope !== 'SO' && <Stat label="Lệnh chuyển kho trong kỳ" value={stoK.n} sub={`Đã xuất ${kgf(stoK.done)} kg · đang đi đường ${kgf(stoK.transit)} kg`} />}
      </div>
      <div className="section-head">Theo đơn vị vận tải <span className="small">— {scopeLabel}, ngày đi trong kỳ</span></div>
      <ReportTable cols={carCols} rows={byCarrier} empty="Không có chuyến xe trong kỳ." />
      {scope !== 'SO' && <>
        <div className="section-head" style={{ marginTop: 16 }}>Theo tuyến chuyển kho <span className="small">— lệnh chuyển kho (STO) lập trong kỳ</span></div>
        <ReportTable cols={routeCols} rows={byRoute} empty="Không có lệnh chuyển kho trong kỳ." />
      </>}
      <details style={{ marginTop: 12 }}>
        <summary className="small" style={{ cursor: 'pointer' }}>Chi tiết {tripRows.length} chuyến</summary>
        <ReportTable cols={tripCols} rows={tripRows} empty="Không có chuyến." />
      </details>

      <div className="section-head" style={{ marginTop: 20 }}>📤 Bán hàng <span className="small">— đơn bán (SO) lập trong kỳ</span>
        <span style={{ marginLeft: 'auto' }} className="no-print">
          <button className="btn ghost" onClick={() => setCfg(cfg === 'SO' ? '' : 'SO')}>⚙ Cách tính doanh thu</button>{' '}
          <Link className="btn" to="/bao-cao/phan-tich-ban-hang">📈 Phân tích bán hàng chi tiết</Link>
        </span></div>
      {cfg === 'SO' && <MoneyConfig m={mSO} what="doanh thu" />}
      <div className="stats">
        <Stat label="Đặt bán" value={`${kgf(SK.qty)} kg`} sub={`= ${tan(SK.qty)} tấn · ${SK.nSo} đơn · ${SK.nCust} khách`} />
        <Stat label="Đã giao" value={`${kgf(SK.done)} kg`} sub={`còn phải giao ${kgf(SK.left)} kg`} tone="green" />
        {hasSOmoney && <Stat label="Doanh thu (VNĐ)" value={`${money(SK.amt)} đ`} sub={`Đã giao: ${money(SK.amtDone)} đ`} tone="amber" />}
        {hasSOmoney && <Stat label="Giá bán bình quân" value={`${money(SK.qty ? (SK.amt / SK.qty) * mSO.perUnit : 0)} ${mSO.unitLabel}`} />}
      </div>
      {!hasSOmoney && SO.length > 0 && <NoMoneyNote m={mSO} rows={SO} what="doanh thu" onConfig={() => setCfg('SO')} />}
      <div className="section-head">Theo nhân viên sale</div>
      <ReportTable cols={saleCols} rows={soBySale} empty="Không có đơn bán trong kỳ." />
      <div className="section-head" style={{ marginTop: 16 }}>Top 15 khách hàng {soByCust.length > 15 && <span className="small">(Excel có đủ {soByCust.length} khách)</span>}</div>
      <ReportTable cols={custCols} rows={soByCust.slice(0, 15)} links={[{ key: 'code', cat: 'soldto' }]} empty="Không có đơn bán trong kỳ." />
    </>
  );
}
