import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useCollection, useOrders } from '../../lib/hooks';
import { useOrderSecrets, viewOrder } from '../../lib/orderSecrets';
import { lineWh } from '../../lib/orders';
import { usePref } from '../../lib/prefs';
import { useOrderMoney } from '../../lib/orderMoney';
import MoneyConfig, { NoMoneyNote } from './MoneyConfig';
import { vnDate } from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { Empty, ErrorBox } from '../../components/ui';
import { ReportTable, toSheet } from './Reports';
import Select from '../../components/Select';

// ============================================================================
// Phân tích bán hàng theo tháng (giống trang Phân tích bán hàng của Sale_control),
// tính từ đơn bán (SO) trong hệ thống: ngày = Ngày tạo đơn, bỏ đơn đã hủy.
// Sản lượng theo kg (đặt hoặc đã giao). Doanh thu lấy từ trường tiền của dòng đơn
// (vd. Thành tiền = [Số lượng (tấn)] * [Đơn giá]) — chỉ người được xem giá mới thấy.
// ============================================================================

const n = (v) => Number(v) || 0;
const kg = (v) => fmtNum(v, 0);
const tan = (v) => fmtNum(n(v) / 1000, 2);
const money = (v) => fmtNum(Math.round(n(v)), 0);
const pct = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 100) : null);
const monthLabel = (m) => (m ? `Tháng ${m.slice(5)}/${m.slice(0, 4)}` : '');
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
function Chg({ cur, prev }) {
  if (prev == null) return null;
  const p = pct(cur, prev);
  if (p === null) return <span className="small">{cur ? 'mới' : ''}</span>;
  if (p === 0) return <span className="small">=</span>;
  return <span className="small" style={{ color: p > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{p > 0 ? '▲' : '▼'} {Math.abs(p)}%</span>;
}

// Biểu đồ cột (kỳ này) + đường (kỳ so sánh), SVG thuần
function BarChart({ data, fmt, curLabel, prevLabel, height = 220 }) {
  if (!data.length) return <Empty text="Không có dữ liệu." />;
  const W = 760;
  const H = height; const L = 64; const B = 24; const T = 10;
  const max = Math.max(1, ...data.map((d) => Math.max(d.v, d.pv || 0)));
  const step = (W - L - 8) / data.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const hasPrev = data.some((d) => d.pv != null);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 8} y1={y(t)} y2={y(t)} stroke="#eef1f5" />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#6b7684">{fmt(t, true)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const bw = Math.min(26, step * 0.7);
          const x = L + i * step + (step - bw) / 2;
          return (
            <g key={d.k}>
              <rect x={x} y={y(d.v)} width={bw} height={Math.max(0, H - B - y(d.v))} rx="3" fill="#1565c0">
                <title>{`${d.title || d.k}: ${fmt(d.v)}${d.pv != null ? ` · ${prevLabel}: ${fmt(d.pv)}` : ''}`}</title>
              </rect>
              <text x={L + i * step + step / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#6b7684">{d.k}</text>
            </g>
          );
        })}
        {hasPrev && (
          <polyline fill="none" stroke="#9aa5b1" strokeWidth="2"
            points={data.map((d, i) => `${L + i * step + step / 2},${y(d.pv || 0)}`).join(' ')} />
        )}
      </svg>
      <div className="small" style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#1565c0', borderRadius: 2, marginRight: 4 }} />{curLabel}</span>
        {hasPrev && <span><span style={{ display: 'inline-block', width: 14, height: 2, background: '#9aa5b1', verticalAlign: 'middle', marginRight: 4 }} />{prevLabel}</span>}
      </div>
    </div>
  );
}

// Tổng hợp theo một khóa
function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, { k, a: 0, q: 0, cust: new Set(), so: new Set(), minP: Infinity, maxP: 0, rows: [] });
    const x = m.get(k);
    x.a += r.a; x.q += r.q; x.cust.add(r.cc); x.so.add(r.so); x.rows.push(r);
    if (r.p > 0) { x.minP = Math.min(x.minP, r.p); x.maxP = Math.max(x.maxP, r.p); }
  }
  return m;
}

export default function SalesAnalysis({ wh, co, q }) {
  const { inMyWarehouses } = useApp();
  const money$ = useOrderMoney('SO');
  const { headSeen, lineSeen, amountKey, priceKey, perUnit, unitLabel, lineMoney } = money$;
  const { rows: raw, error, loading } = useOrders('SO');
  const secMap = useOrderSecrets('SO');
  const users = useCollection('users').rows;
  const saleName = useMemo(() => new Map(users.map((u) => [u.email, u.name || u.email])), [users]);

  const [basis, setBasis] = usePref('salesAnalysis:basis', 'order'); // order = số lượng đặt, done = đã giao (trừ hàng trả về)
  const [showCfg, setShowCfg] = useState(false);

  // Mỗi dòng đơn → 1 dòng bán hàng
  const all = useMemo(() => raw.filter((o) => o.status !== 'cancelled' && o.date).flatMap((o0) => {
    const o = viewOrder(o0, secMap, headSeen, lineSeen);
    return (o.lines || []).map((l) => {
      const ordered = n(l.qtyKg);
      const q2 = basis === 'done' ? Math.max(0, n(l.doneKg) - n(l.returnedKg)) : ordered;
      const { full: amtFull, price } = lineMoney(l, o);
      const a = ordered ? amtFull * (q2 / ordered) : 0;
      return {
        d: o.date, m: o.date.slice(0, 7), so: o.id, co: o.company || '', st: o.status, cc: o.partyCode || o.partyName || '', cn: o.partyName || o.partyCode || '',
        sp: o.sales || '', wh: lineWh(o, l), ic: l.item || '', in: l.itemName || '', q: q2, a,
        p: price, full: amtFull, _l: l,
      };
    });
  }).filter((r) => (!r.wh || inMyWarehouses(r.wh)) && (!wh || r.wh === wh) && (!co || r.co === co)
    && (!q || norm([r.so, r.cc, r.cn, r.ic, r.in, r.sp].join(' ')).includes(q))),
  [raw, secMap, headSeen, lineSeen, basis, priceKey, amountKey, perUnit, inMyWarehouses, wh, co, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const months = useMemo(() => [...new Set(all.map((r) => r.m))].sort(), [all]);
  const [month, setMonth] = useState('');
  const [cmp, setCmp] = useState(null); // null = tự chọn tháng trước
  useEffect(() => {
    if (!months.length) return;
    if (!month || !months.includes(month)) setMonth(months.includes(vnDate().slice(0, 7)) ? vnDate().slice(0, 7) : months[months.length - 1]);
  }, [months.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const cmpM = cmp ?? (month ? prevMonth(month) : '');
  const sp = (r) => (r.sp ? saleName.get(r.sp) || r.sp : '(chưa ghi sale)');

  const A = useMemo(() => {
    const cur = all.filter((r) => r.m === month);
    const prev = cmpM ? all.filter((r) => r.m === cmpM) : null;
    const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
    const k = (rows) => rows && ({
      a: sum(rows, (r) => r.a), q: sum(rows, (r) => r.q), cust: new Set(rows.map((r) => r.cc)).size, so: new Set(rows.map((r) => r.so)).size,
      open: new Set(rows.filter((r) => r.st === 'open' || r.st === 'partial').map((r) => r.so)).size,
    });
    const K = k(cur); const KP = k(prev);
    const prevCust = new Set((prev || []).map((r) => r.cc));
    const curCust = new Set(cur.map((r) => r.cc));
    const hasMoney = all.some((r) => r.full);

    const salesP = prev ? groupBy(prev, sp) : new Map();
    const bySale = [...groupBy(cur, sp).values()].map((x) => ({
      _k: x.k, sale: x.k, a: x.a, q: x.q, avgP: x.q ? (x.a / x.q) * perUnit : 0, nCust: x.cust.size, nSo: x.so.size, share: K.a ? (x.a / K.a) * 100 : K.q ? (x.q / K.q) * 100 : 0,
      newCust: prev ? [...x.cust].filter((c) => !prevCust.has(c)).length : '', prevA: salesP.get(x.k)?.a ?? (prev ? 0 : null), prevQ: salesP.get(x.k)?.q ?? (prev ? 0 : null),
    })).sort((x, y) => y.a - x.a || y.q - x.q);

    const itemsP = prev ? groupBy(prev, (r) => r.ic) : new Map();
    const byItem = [...groupBy(cur, (r) => r.ic).values()].map((x) => {
      const p = itemsP.get(x.k);
      return {
        _k: x.k, item: x.k, itemName: x.rows.find((r) => r.in)?.in || '', q: x.q, a: x.a, avgP: x.q ? (x.a / x.q) * perUnit : 0,
        range: x.minP === Infinity ? '' : x.minP === x.maxP ? money(x.minP) : `${money(x.minP)} – ${money(x.maxP)}`, nCust: x.cust.size,
        prevQ: p ? p.q : prev ? 0 : null, prevAvg: p && p.q ? (p.a / p.q) * perUnit : null,
      };
    }).sort((x, y) => y.a - x.a || y.q - x.q);

    const custsP = prev ? groupBy(prev, (r) => r.cc) : new Map();
    const custRow = (x) => ({ _k: x.k, code: x.rows[0].cc, name: x.rows[0].cn, sale: [...new Set(x.rows.map(sp))].join(', '), a: x.a, q: x.q, nSo: x.so.size });
    const byCust = [...groupBy(cur, (r) => r.cc).values()].map((x) => ({
      ...custRow(x), prevA: custsP.get(x.k)?.a ?? (prev ? 0 : null), prevQ: custsP.get(x.k)?.q ?? (prev ? 0 : null), isNew: prev ? !prevCust.has(x.k) : false,
    })).sort((x, y) => y.a - x.a || y.q - x.q);
    const lost = prev ? [...custsP.values()].filter((x) => !curCust.has(x.k)).map(custRow).sort((x, y) => y.a - x.a || y.q - x.q) : [];

    const byCo = [...groupBy(cur, (r) => r.co || '(khác)').values()].map((x) => ({ _k: x.k, k: x.k, a: x.a, q: x.q, share: K.a ? (x.a / K.a) * 100 : K.q ? (x.q / K.q) * 100 : 0 })).sort((x, y) => y.a - x.a || y.q - x.q);
    const byWh = [...groupBy(cur, (r) => r.wh || '(chưa ghi kho)').values()].map((x) => ({ _k: x.k, k: x.k, a: x.a, q: x.q })).sort((x, y) => y.q - x.q);

    // Theo ngày trong tháng, so với kỳ so sánh cùng ngày
    const val = (r) => (hasMoney ? r.a : r.q);
    const days = new Map(); const daysP = new Map();
    cur.forEach((r) => { const d = r.d.slice(8, 10); days.set(d, n(days.get(d)) + val(r)); });
    (prev || []).forEach((r) => { const d = r.d.slice(8, 10); daysP.set(d, n(daysP.get(d)) + val(r)); });
    const nDays = month ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate() : 0;
    const daily = Array.from({ length: nDays }, (_, i) => String(i + 1).padStart(2, '0')).map((d) => ({ k: d, title: `Ngày ${d}`, v: n(days.get(d)), pv: prev ? n(daysP.get(d)) : undefined }));

    // 12 tháng gần nhất tính tới tháng đang xem
    const trend = [];
    for (let i = 11, m = month; i >= 0 && m; i--) { trend.unshift(m); m = prevMonth(m); }
    const byM = groupBy(all, (r) => r.m);
    const monthly = month ? trend.slice(-12).map((m) => ({ k: m.slice(5) + '/' + m.slice(2, 4), title: monthLabel(m), v: byM.get(m) ? (hasMoney ? byM.get(m).a : byM.get(m).q) : 0 })) : [];

    // Đơn giá bất thường: thấp hơn 70% giá bình quân của mã hàng
    const avgBy = Object.fromEntries(byItem.map((x) => [x.item, x.avgP]));
    const odd = hasMoney ? cur.filter((r) => r.q > 0 && r.p > 0 && avgBy[r.ic] && r.p < avgBy[r.ic] * 0.7)
      .map((r, i) => ({ ...r, _k: `${r.so}-${i}`, avg: avgBy[r.ic], sale: sp(r) })).sort((x, y) => x.p / x.avg - y.p / y.avg) : [];

    return { K, KP, hasMoney, bySale, byItem, byCust, lost, byCo, byWh, daily, monthly, odd };
  }, [all, month, cmpM, saleName, perUnit]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Empty text="Đang tải…" />;
  const M = A.hasMoney;
  const cmpOn = !!A.KP;
  const qLabel = basis === 'done' ? 'Đã giao (kg)' : 'Đặt (kg)';
  const chgCol = (cur, prev, label = 'So kỳ trước') => (cmpOn ? [{ key: '_chg' + label, label, render: (r) => <Chg cur={r[cur]} prev={r[prev]} />, excel: (r) => { const p = pct(r[cur], r[prev]); return r[prev] == null ? '' : p == null ? 'mới' : `${p}%`; } }] : []);
  const mainKey = M ? 'a' : 'q'; const prevKey = M ? 'prevA' : 'prevQ';

  const saleCols = [
    { key: 'sale', label: 'Sale phụ trách' },
    ...(M ? [{ key: 'a', label: 'Doanh thu (đ)', num: true, sum: true, style: () => ({ fontWeight: 700 }) }] : []),
    { key: 'share', label: '% tổng', render: (r) => `${Math.round(r.share)}%`, excel: (r) => Math.round(r.share) },
    { key: 'q', label: qLabel, num: true, sum: true },
    ...(M ? [{ key: 'avgP', label: `Giá BQ (${unitLabel})`, num: true }] : []),
    { key: 'nCust', label: 'Số KH', num: true }, ...(cmpOn ? [{ key: 'newCust', label: 'KH mới', num: true }] : []), { key: 'nSo', label: 'Số đơn', num: true },
    ...chgCol(mainKey, prevKey),
  ];
  const itemCols = [
    { key: 'item', label: 'Mã hàng', nowrap: true, style: () => ({ fontWeight: 700 }) }, { key: 'itemName', label: 'Tên hàng' },
    { key: 'q', label: qLabel, num: true, sum: true }, { key: '_t', label: 'Tấn', render: (r) => tan(r.q), excel: (r) => n(r.q) / 1000 },
    ...(M ? [{ key: 'a', label: 'Doanh thu (đ)', num: true, sum: true }, { key: 'avgP', label: `Giá BQ (${unitLabel})`, num: true, style: () => ({ fontWeight: 700 }) },
      { key: 'range', label: 'Giá thấp – cao' }] : []),
    { key: 'nCust', label: 'Số KH', num: true },
    ...(cmpOn ? [{ key: 'prevQ', label: 'Kỳ trước (kg)', num: true }, ...chgCol('q', 'prevQ', '± sản lượng'), ...(M ? [{ key: 'prevAvg', label: 'Giá BQ kỳ trước', num: true }] : [])] : []),
  ];
  const custCols = [
    { key: 'name', label: 'Khách hàng', render: (r) => <>{r.name}{r.isNew && <> <span className="badge green">KH mới</span></>}</>, excel: (r) => r.name },
    { key: 'code', label: 'Mã KH' }, { key: 'sale', label: 'Sale' },
    ...(M ? [{ key: 'a', label: 'Doanh thu (đ)', num: true, sum: true, style: () => ({ fontWeight: 700 }) }] : []),
    { key: 'q', label: qLabel, num: true, sum: true }, { key: 'nSo', label: 'Số đơn', num: true },
    ...chgCol(mainKey, prevKey),
  ];
  const smallCust = [{ key: 'name', label: 'Khách hàng' }, { key: 'sale', label: 'Sale' }, ...(M ? [{ key: 'a', label: 'Doanh thu (đ)', num: true, sum: true }] : []), { key: 'q', label: qLabel, num: true, sum: true }];
  const coCols = [{ key: 'k', label: 'Công ty xuất' }, ...(M ? [{ key: 'a', label: 'Doanh thu (đ)', num: true, sum: true }] : []), { key: 'q', label: qLabel, num: true, sum: true },
    { key: 'share', label: '% tổng', render: (r) => `${Math.round(r.share)}%`, excel: (r) => Math.round(r.share) }];
  const whCols = [{ key: 'k', label: 'Kho xuất' }, { key: 'q', label: qLabel, num: true, sum: true }, ...(M ? [{ key: 'a', label: 'Doanh thu (đ)', num: true, sum: true }] : [])];
  const oddCols = [
    { key: 'd', label: 'Ngày đơn', render: (r) => fmtDate(r.d), nowrap: true }, { key: 'so', label: 'Số SO', nowrap: true }, { key: 'cn', label: 'Khách hàng' },
    { key: 'ic', label: 'Mã hàng', nowrap: true }, { key: 'q', label: qLabel, num: true }, { key: 'p', label: `Đơn giá (${unitLabel})`, num: true, style: () => ({ color: 'var(--red)', fontWeight: 700 }) },
    { key: 'avg', label: 'Giá BQ mã hàng', num: true }, { key: 'sale', label: 'Sale' },
  ];
  const newCust = A.byCust.filter((x) => x.isNew);

  const excel = () => exportSheets(`PhanTichBanHang_${month}`, {
    'Theo sale': toSheet(saleCols, A.bySale), 'Theo mặt hàng': toSheet(itemCols, A.byItem), 'Theo khách hàng': toSheet(custCols, A.byCust),
    ...(cmpOn ? { 'KH mới': toSheet(smallCust, newCust), 'KH ngừng mua': toSheet(smallCust, A.lost) } : {}),
    'Theo công ty': toSheet(coCols, A.byCo), 'Theo kho': toSheet(whCols, A.byWh), ...(M ? { 'Đơn giá bất thường': toSheet(oddCols, A.odd) } : {}),
  });
  const fmtChart = (v, axis) => (M ? (axis ? (v >= 1e9 ? `${fmtNum(v / 1e9, 1)} tỷ` : `${fmtNum(v / 1e6, v >= 1e7 ? 0 : 1)} tr`) : `${money(v)} đ`) : (axis ? `${fmtNum(v / 1000, 1)} t` : `${kg(v)} kg`));

  return (
    <>
      <ErrorBox error={error} />
      <div className="filters no-print">
        <Select value={month} onChange={(e) => { setMonth(e.target.value); setCmp(null); }}>
          {[...months].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </Select>
        <span className="small">so với</span>
        <Select value={cmpM} onChange={(e) => setCmp(e.target.value)}>
          <option value="">(không so sánh)</option>
          {[...new Set([prevMonth(month || vnDate().slice(0, 7)), ...months.filter((m) => m < month)])].sort().reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </Select>
        <Select value={basis} onChange={(e) => setBasis(e.target.value)} title="Sản lượng tính theo">
          <option value="order">Theo số lượng đặt</option>
          <option value="done">Theo số lượng đã giao</option>
        </Select>
        <button className="btn ghost" onClick={() => setShowCfg((x) => !x)}>⚙ Cách tính doanh thu</button>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={excel} disabled={!months.length}>⬇ Excel</button>
        <button className="btn" onClick={() => window.print()}>🖨 In</button>
      </div>
      {showCfg && <MoneyConfig m={money$} what="doanh thu" />}
      <p className="print-only small">{monthLabel(month)}{cmpOn ? ` so với ${monthLabel(cmpM).toLowerCase()}` : ''} · {basis === 'done' ? 'theo số lượng đã giao' : 'theo số lượng đặt'}</p>
      {!months.length ? <Empty text="Chưa có đơn bán (SO) nào phù hợp bộ lọc." /> : (
        <>
          {!M && <NoMoneyNote m={money$} rows={all} what="doanh thu" onConfig={() => setShowCfg(true)} />}
          <div className="stats">
            {M && <div className="stat green"><div className="stat-label">Doanh thu (trước thuế)</div><div className="stat-value">{money(A.K.a)} đ</div>
              {cmpOn && <div className="stat-sub"><Chg cur={A.K.a} prev={A.KP.a} /> ({monthLabel(cmpM)}: {money(A.KP.a)})</div>}</div>}
            <div className="stat green"><div className="stat-label">Sản lượng {basis === 'done' ? 'đã giao' : 'đặt'}</div><div className="stat-value">{kg(A.K.q)} kg</div>
              <div className="stat-sub">= {tan(A.K.q)} tấn{cmpOn && <> · <Chg cur={A.K.q} prev={A.KP.q} /> (trước: {kg(A.KP.q)} kg)</>}</div></div>
            {M && <div className="stat"><div className="stat-label">Giá bán bình quân</div><div className="stat-value">{money(A.K.q ? (A.K.a / A.K.q) * perUnit : 0)} {unitLabel}</div>
              {cmpOn && A.KP.q > 0 && <div className="stat-sub">Kỳ trước: {money((A.KP.a / A.KP.q) * perUnit)} {unitLabel}</div>}</div>}
            <div className="stat"><div className="stat-label">Khách hàng mua</div><div className="stat-value">{A.K.cust}</div>
              {cmpOn && <div className="stat-sub"><Chg cur={A.K.cust} prev={A.KP.cust} /> · {newCust.length} KH mới · {A.lost.length} KH ngừng mua</div>}</div>
            <div className="stat amber"><div className="stat-label">Số đơn (SO)</div><div className="stat-value">{A.K.so}</div>
              <div className="stat-sub">{A.K.open ? `${A.K.open} đơn chưa giao xong` : 'Đã giao xong hết'}</div></div>
          </div>

          <div className="grid2">
            <div className="card">
              <div className="section-head">{M ? 'Doanh thu' : 'Sản lượng'} theo ngày {cmpOn && `(so với ${monthLabel(cmpM).toLowerCase()})`}</div>
              <BarChart data={A.daily} fmt={fmtChart} curLabel={monthLabel(month)} prevLabel={monthLabel(cmpM)} />
            </div>
            <div className="card">
              <div className="section-head">{M ? 'Doanh thu' : 'Sản lượng'} 12 tháng</div>
              <BarChart data={A.monthly} fmt={fmtChart} curLabel={M ? 'Doanh thu' : 'Sản lượng'} />
            </div>
          </div>

          <div className="section-head">Theo nhân viên sale</div>
          <ReportTable cols={saleCols} rows={A.bySale} />
          <div className="section-head" style={{ marginTop: 16 }}>Theo mặt hàng</div>
          <ReportTable cols={itemCols} rows={A.byItem} />
          <div className="section-head" style={{ marginTop: 16 }}>Top 20 khách hàng {A.byCust.length > 20 && <span className="small">(Excel có đủ {A.byCust.length} khách)</span>}</div>
          <ReportTable cols={custCols} rows={A.byCust.slice(0, 20)} links={[{ key: 'code', cat: 'soldto' }]} />

          {cmpOn && (
            <div className="grid2" style={{ marginTop: 16 }}>
              <div>
                <div className="section-head">🆕 Khách mới mua trong tháng ({newCust.length})</div>
                <ReportTable cols={smallCust} rows={newCust} empty="Không có" />
              </div>
              <div>
                <div className="section-head">⚠ Kỳ trước có mua, tháng này chưa mua ({A.lost.length})</div>
                <ReportTable cols={smallCust} rows={A.lost} empty="Không có" />
              </div>
            </div>
          )}

          <div className="grid2" style={{ marginTop: 16 }}>
            <div>
              <div className="section-head">Theo công ty xuất</div>
              <ReportTable cols={coCols} rows={A.byCo} />
            </div>
            <div>
              <div className="section-head">Theo kho xuất</div>
              <ReportTable cols={whCols} rows={A.byWh} />
            </div>
          </div>

          {M && (
            <>
              <div className="section-head" style={{ marginTop: 16 }}>🔎 Đơn giá bất thường ({A.odd.length}) <span className="small">— thấp hơn 70% giá bình quân của mã hàng trong tháng</span></div>
              <ReportTable cols={oddCols} rows={A.odd.slice(0, 50)} empty="Không có" />
            </>
          )}
        </>
      )}
    </>
  );
}
