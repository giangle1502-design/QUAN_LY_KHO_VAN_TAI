import { useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useOpCompany, useOpWarehouse, useOrders, useStock } from '../../lib/hooks';
import { OPEN_STATUSES, ORDER_STATUS, leftKg, transitKg } from '../../lib/orders';
import { ageDays } from '../../lib/stock';
import { vnDate } from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { CompanyPicker, WarehousePicker } from '../../components/TripBits';
import { Empty, ErrorBox } from '../../components/ui';

// ============================================================================
// Báo cáo: mỗi báo cáo = bộ lọc + 1 hoặc nhiều bảng; bảng nào cũng xuất Excel và in được.
// Số lượng hiển thị theo tấn (lưu kg).
// ============================================================================

export const REPORTS = [
  ['ton-theo-kho', '🏭', 'Tồn kho tổng theo kho'],
  ['ton-theo-vi-tri', '📍', 'Tồn kho theo vị trí'],
  ['ton-theo-trang-thai', '🔒', 'Tồn kho theo trạng thái'],
  ['ton-cho-sale', '💼', 'Tồn kho cho Sale'],
  ['don-chua-giao', '📤', 'Đơn hàng chưa giao'],
  ['po-chua-nhap', '📥', 'Đơn mua chưa nhập kho'],
];

const n = (v) => Number(v) || 0;
const T = (kg) => n(kg) / 1000;
const t3 = (kg) => fmtNum(T(kg), 3);
const STATUS_ORDER = ['KTC', 'HTC', 'DGC'];
const rankSt = (c) => (STATUS_ORDER.includes(c) ? STATUS_ORDER.indexOf(c) : 99);

// Bảng dùng chung. cols: [{ key, label, num, digits, ton (kg→tấn), sum, render, style }]
function ReportTable({ cols, rows, empty = 'Không có dữ liệu.', rowStyle }) {
  if (!rows.length) return <Empty text={empty} />;
  const show = (c, r) => (c.render ? c.render(r) : c.ton ? t3(r[c.key]) : c.num ? fmtNum(r[c.key], c.digits ?? 0) : r[c.key]);
  const hasSum = cols.some((c) => c.sum);
  return (
    <div className="table-wrap report-table">
      <table>
        <thead><tr><th className="stt">STT</th>{cols.map((c) => <th key={c.key} className={c.num || c.ton ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r._k ?? i} style={rowStyle?.(r)}>
              <td className="stt">{i + 1}</td>
              {cols.map((c) => <td key={c.key} className={(c.num || c.ton ? 'num' : '') + (c.nowrap ? ' nowrap' : '')} style={c.style?.(r)}>{show(c, r)}</td>)}
            </tr>
          ))}
        </tbody>
        {hasSum && (
          <tfoot><tr><td />{cols.map((c, i) => (
            <td key={c.key} className={c.num || c.ton ? 'num' : ''}>
              {c.sum ? (c.ton ? t3(rows.reduce((s, r) => s + n(r[c.key]), 0)) : fmtNum(rows.reduce((s, r) => s + n(r[c.key]), 0), c.digits ?? 0)) : i === 0 ? 'Cộng' : ''}
            </td>
          ))}</tr></tfoot>
        )}
      </table>
    </div>
  );
}
// Dòng Excel theo đúng cột trên màn hình (số tấn xuất dạng số)
const toSheet = (cols, rows) => (rows.length ? rows : [{}]).map((r, i) => ({
  STT: rows.length ? i + 1 : '',
  ...Object.fromEntries(cols.filter((c) => !c.noExcel).map((c) => [c.label + (c.ton ? ' (tấn)' : ''),
    !rows.length ? '' : c.excel ? c.excel(r) : c.ton ? Math.round(T(r[c.key]) * 1000) / 1000 : r[c.key] ?? ''])),
}));

export default function Reports() {
  const { report } = useParams();
  const cur = REPORTS.find((r) => r[0] === report) || REPORTS[0];
  const [wh, setWh] = useOpWarehouse();
  const [co, setCo] = useOpCompany();
  const [q, setQ] = useState('');
  const props = { wh, co, q: norm(q) };
  const Body = { 'ton-theo-kho': ByWarehouse, 'ton-theo-vi-tri': ByLocation, 'ton-theo-trang-thai': ByStatus,
    'ton-cho-sale': ForSales, 'don-chua-giao': OpenSO, 'po-chua-nhap': OpenPO }[cur[0]];
  return (
    <div className="report-page">
      <div className="page-head">
        <h1>{cur[1]} {cur[2]}</h1>
        <div className="actions no-print"><span className="small">Ngày {fmtDate(vnDate())}</span></div>
      </div>
      <div className="report-tabs no-print">
        {REPORTS.map(([k, ic, l]) => <NavLink key={k} to={`/bao-cao/${k}`} className={({ isActive }) => (isActive || (k === cur[0]) ? 'on' : '')}>{ic} {l}</NavLink>)}
      </div>
      <div className="filters no-print">
        <WarehousePicker value={wh} onChange={setWh} />
        <CompanyPicker value={co} onChange={setCo} />
        <input type="search" placeholder="Tìm mã hàng, tên hàng, khách, NCC…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className="print-only small">Kho: {wh || 'Tất cả kho được giao'} · Công ty: {co || 'Tất cả'}{q ? ` · Lọc: ${q}` : ''} · In lúc {new Date().toLocaleString('vi-VN')}</p>
      <Body key={cur[0]} {...props} />
    </div>
  );
}

function Actions({ onExcel }) {
  return (
    <div className="actions no-print" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
      <button className="btn" onClick={onExcel}>⬇ Excel</button>
      <button className="btn" onClick={() => window.print()}>🖨 In</button>
    </div>
  );
}

// Dữ liệu dùng chung
function useBase(wh, co) {
  const { inMyWarehouses } = useApp();
  const { rows: all, error } = useStock(wh);
  const stock = useMemo(() => (co ? all.filter((r) => (r.company || '') === co) : all), [all, co]);
  const items = useCollection('items').rows;
  const statuses = useCollection('goodsStatus').rows;
  const warehouses = useCollection('warehouses').rows.filter((w) => w.active !== false && inMyWarehouses(w.code) && (!wh || w.code === wh))
    .sort((a, b) => a.code.localeCompare(b.code));
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const locked = useMemo(() => new Set(statuses.filter((s) => s.allowOutbound === false).map((s) => s.code)), [statuses]);
  const statusCodes = (statuses.length ? statuses.map((s) => s.code) : STATUS_ORDER).sort((a, b) => rankSt(a) - rankSt(b) || a.localeCompare(b));
  return { stock, error, itemMap, locked, statusCodes, statuses, warehouses, inMyWarehouses };
}
const matchItem = (q, ...xs) => !q || norm(xs.join(' ')).includes(q);

// ---------------------------------------------------------------------------
// 1. Tồn kho tổng theo từng kho
function ByWarehouse({ wh, co, q }) {
  const { stock, error, statusCodes, warehouses } = useBase(wh, co);
  const locations = useCollection('locations').rows;
  const list = stock.filter((r) => matchItem(q, r.item, r.itemName));

  const whRows = warehouses.map((w) => {
    const rs = list.filter((r) => r.warehouse === w.code);
    const locs = locations.filter((l) => l.warehouse === w.code);
    const cap = locs.reduce((s, l) => s + n(l.capacity), 0);
    const pal = locs.reduce((s, l) => s + n(l.currentPallets), 0);
    return {
      _k: w.code, code: w.code, name: w.name, kg: rs.reduce((s, r) => s + n(r.kg), 0), bags: rs.reduce((s, r) => s + n(r.bags), 0),
      pallets: rs.reduce((s, r) => s + n(r.pallets), 0), items: new Set(rs.map((r) => r.item)).size,
      used: locs.filter((l) => n(l.currentPallets) > 0).length, locs: locs.length, cap, fill: cap ? Math.round((pal / cap) * 1000) / 10 : null,
      ...Object.fromEntries(statusCodes.map((c) => [`st_${c}`, rs.filter((r) => r.goodsStatus === c).reduce((s, r) => s + n(r.kg), 0)])),
    };
  });
  const whCols = [
    { key: 'code', label: 'Kho' }, { key: 'name', label: 'Tên kho' },
    { key: 'kg', label: 'Tồn (tấn)', ton: true, sum: true },
    ...statusCodes.map((c) => ({ key: `st_${c}`, label: c, ton: true, sum: true })),
    { key: 'bags', label: 'Số bao', num: true, sum: true }, { key: 'pallets', label: 'Pallet', num: true, digits: 1, sum: true },
    { key: 'items', label: 'Số mã hàng', num: true },
    { key: 'used', label: 'Vị trí đang dùng', render: (r) => `${r.used}/${r.locs}`, excel: (r) => `${r.used}/${r.locs}` },
    { key: 'cap', label: 'Sức chứa (pallet)', num: true, sum: true },
    { key: 'fill', label: '% lấp đầy', num: true, digits: 1 },
  ];

  // Ma trận mã hàng × kho
  const pivot = useMemo(() => {
    const m = new Map();
    for (const r of list) {
      const x = m.get(r.item) || { _k: r.item, item: r.item, itemName: r.itemName, total: 0 };
      x[`w_${r.warehouse}`] = n(x[`w_${r.warehouse}`]) + n(r.kg);
      x.total += n(r.kg);
      m.set(r.item, x);
    }
    return [...m.values()].sort((a, b) => a.item.localeCompare(b.item));
  }, [list]);
  const pivotCols = [{ key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' },
    ...warehouses.map((w) => ({ key: `w_${w.code}`, label: w.code, ton: true, sum: true })), { key: 'total', label: 'Tổng', ton: true, sum: true }];

  const excel = () => exportSheets(`BC_ton_theo_kho_${vnDate()}`, { 'Theo kho': toSheet(whCols, whRows), 'Mã hàng x kho': toSheet(pivotCols, pivot) });
  return (
    <>
      <ErrorBox error={error} />
      <Actions onExcel={excel} />
      <div className="section-head">Tổng theo kho</div>
      <ReportTable cols={whCols} rows={whRows} />
      <div className="section-head" style={{ marginTop: 16 }}>Theo mã hàng và kho (tấn)</div>
      <ReportTable cols={pivotCols} rows={pivot} empty="Chưa có tồn kho." />
    </>
  );
}

// ---------------------------------------------------------------------------
// 2. Tồn kho theo vị trí (kể cả vị trí trống)
function ByLocation({ wh, co, q }) {
  const { stock, error, inMyWarehouses } = useBase(wh, co);
  const locations = useCollection('locations').rows;
  const [mode, setMode] = useState('');
  const rows = useMemo(() => {
    const byLoc = new Map();
    for (const r of stock) {
      const k = `${r.warehouse}__${r.location}`;
      const x = byLoc.get(k) || [];
      x.push(r);
      byLoc.set(k, x);
    }
    return locations.filter((l) => inMyWarehouses(l.warehouse) && (!wh || l.warehouse === wh))
      .map((l) => {
        const rs = byLoc.get(`${l.warehouse}__${l.code}`) || [];
        return {
          _k: `${l.warehouse}-${l.code}`, warehouse: l.warehouse, code: l.code, zone: l.zone || '', capacity: n(l.capacity), pallets: n(l.currentPallets),
          free: Math.max(0, n(l.capacity) - n(l.currentPallets)), pct: n(l.usedPct), empty: n(l.currentPallets) <= 0, locked: !!l.locked,
          items: [...new Set(rs.map((r) => r.item))].join(', '), lots: [...new Set(rs.map((r) => r.lot).filter(Boolean))].join(', '),
          status: [...new Set(rs.map((r) => r.goodsStatus))].sort((a, b) => rankSt(a) - rankSt(b)).join(', '),
          bags: rs.reduce((s, r) => s + n(r.bags), 0), kg: rs.reduce((s, r) => s + n(r.kg), 0),
          oldest: rs.map((r) => r.inDate).filter(Boolean).sort()[0] || '',
        };
      })
      .filter((x) => matchItem(q, x.code, x.items, x.lots))
      .filter((x) => !mode || (mode === 'used' && !x.empty) || (mode === 'empty' && x.empty && !x.locked) || (mode === 'full' && x.pct >= 85) || (mode === 'locked' && x.locked))
      .sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.code.localeCompare(b.code, 'vi', { numeric: true }));
  }, [stock, locations, inMyWarehouses, wh, q, mode]);
  const cols = [
    { key: 'warehouse', label: 'Kho' }, { key: 'code', label: 'Vị trí', nowrap: true },
    { key: 'capacity', label: 'Sức chứa (pallet)', num: true, sum: true }, { key: 'pallets', label: 'Đang chứa (pallet)', num: true, digits: 1, sum: true },
    { key: 'free', label: 'Còn trống (pallet)', num: true, digits: 1, sum: true },
    { key: 'pct', label: '% lưu trữ', num: true, digits: 1, style: (r) => (r.pct >= 100 ? { color: 'var(--red)', fontWeight: 700 } : r.pct >= 85 ? { color: 'var(--amber)', fontWeight: 600 } : undefined) },
    { key: 'state', label: 'Trạng thái', render: (r) => (r.locked ? <span className="badge red">Khóa</span> : r.empty ? <span className="badge green">Empty bin</span> : ''),
      excel: (r) => (r.locked ? 'Khóa' : r.empty ? 'Empty bin' : '') },
    { key: 'items', label: 'Mã hàng' }, { key: 'lots', label: 'Lot' }, { key: 'status', label: 'Tình trạng' },
    { key: 'bags', label: 'Số bao', num: true, sum: true }, { key: 'kg', label: 'Tồn (tấn)', ton: true, sum: true },
    { key: 'oldest', label: 'Nhập sớm nhất', render: (r) => fmtDate(r.oldest), nowrap: true },
  ];
  const excel = () => exportSheets(`BC_ton_theo_vi_tri_${vnDate()}`, { 'Theo vị trí': toSheet(cols, rows) });
  const cnt = (f) => rows.filter(f).length;
  return (
    <>
      <ErrorBox error={error} />
      <div className="toolbar no-print">
        <div className="seg">
          {[['', 'Tất cả'], ['used', 'Đang chứa hàng'], ['empty', 'Vị trí trống'], ['full', '≥ 85%'], ['locked', 'Đang khóa']].map(([k, l]) => (
            <button key={k} type="button" className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>{l}</button>
          ))}
        </div>
        <span className="small">{rows.length} vị trí · {cnt((x) => !x.empty)} đang chứa · {cnt((x) => x.empty && !x.locked)} trống</span>
        <span style={{ marginLeft: 'auto' }}><Actions onExcel={excel} /></span>
      </div>
      <ReportTable cols={cols} rows={rows} empty="Không có vị trí nào." />
    </>
  );
}

// ---------------------------------------------------------------------------
// 3. Tồn kho theo trạng thái (KTC, HTC, DGC) và theo bên nhận thế chấp
function ByStatus({ wh, co, q }) {
  const { stock, error, statusCodes, statuses } = useBase(wh, co);
  const pledgees = useCollection('pledgees').rows;
  const list = stock.filter((r) => matchItem(q, r.item, r.itemName, r.pledgee));
  const total = list.reduce((s, r) => s + n(r.kg), 0);
  const sumRows = statusCodes.map((c) => {
    const rs = list.filter((r) => r.goodsStatus === c);
    const kg = rs.reduce((s, r) => s + n(r.kg), 0);
    const st = statuses.find((s) => s.code === c);
    return { _k: c, code: c, name: st?.name || '', outbound: st?.allowOutbound === false ? 'Khóa xuất' : 'Được xuất', kg,
      bags: rs.reduce((s, r) => s + n(r.bags), 0), pallets: rs.reduce((s, r) => s + n(r.pallets), 0), pct: total ? Math.round((kg / total) * 1000) / 10 : 0 };
  });
  const sumCols = [{ key: 'code', label: 'Trạng thái' }, { key: 'name', label: 'Diễn giải' }, { key: 'outbound', label: 'Xuất kho' },
    { key: 'kg', label: 'Tồn (tấn)', ton: true, sum: true }, { key: 'bags', label: 'Số bao', num: true, sum: true },
    { key: 'pallets', label: 'Pallet', num: true, digits: 1, sum: true }, { key: 'pct', label: '% tổng tồn', num: true, digits: 1 }];

  const byItem = useMemo(() => {
    const m = new Map();
    for (const r of list) {
      const k = `${r.warehouse}__${r.item}`;
      const x = m.get(k) || { _k: k, warehouse: r.warehouse, item: r.item, itemName: r.itemName, total: 0 };
      x[`s_${r.goodsStatus}`] = n(x[`s_${r.goodsStatus}`]) + n(r.kg);
      x.total += n(r.kg);
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.item.localeCompare(b.item));
  }, [list]);
  const itemCols = [{ key: 'warehouse', label: 'Kho' }, { key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' },
    ...statusCodes.map((c) => ({ key: `s_${c}`, label: c, ton: true, sum: true })), { key: 'total', label: 'Tổng', ton: true, sum: true }];

  // Hàng thế chấp theo bên nhận thế chấp
  const pledged = useMemo(() => {
    const m = new Map();
    for (const r of list.filter((x) => x.goodsStatus === 'HTC')) {
      const k = `${r.pledgee}__${r.warehouse}__${r.item}`;
      const p = pledgees.find((x) => x.code === r.pledgee);
      const x = m.get(k) || { _k: k, pledgee: r.pledgee || '(chưa ghi)', pledgeeName: p?.name || '', contract: p?.contractNo || '', warehouse: r.warehouse,
        item: r.item, itemName: r.itemName, lots: new Set(), bags: 0, kg: 0 };
      x.lots.add(r.lot); x.bags += n(r.bags); x.kg += n(r.kg);
      m.set(k, x);
    }
    return [...m.values()].map((x) => ({ ...x, lots: [...x.lots].filter(Boolean).join(', ') }))
      .sort((a, b) => a.pledgee.localeCompare(b.pledgee) || a.item.localeCompare(b.item));
  }, [list, pledgees]);
  const pledgeCols = [{ key: 'pledgee', label: 'Bên nhận thế chấp' }, { key: 'pledgeeName', label: 'Tên' }, { key: 'contract', label: 'Số hợp đồng' },
    { key: 'warehouse', label: 'Kho' }, { key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' }, { key: 'lots', label: 'Lot' },
    { key: 'bags', label: 'Số bao', num: true, sum: true }, { key: 'kg', label: 'Tồn (tấn)', ton: true, sum: true }];

  const excel = () => exportSheets(`BC_ton_theo_trang_thai_${vnDate()}`, {
    'Tổng theo trạng thái': toSheet(sumCols, sumRows), 'Theo mã hàng': toSheet(itemCols, byItem), 'Hàng thế chấp': toSheet(pledgeCols, pledged) });
  return (
    <>
      <ErrorBox error={error} />
      <Actions onExcel={excel} />
      <div className="section-head">Tổng theo trạng thái</div>
      <ReportTable cols={sumCols} rows={sumRows} />
      <div className="section-head" style={{ marginTop: 16 }}>Theo mã hàng (tấn)</div>
      <ReportTable cols={itemCols} rows={byItem} empty="Chưa có tồn kho." />
      <div className="section-head" style={{ marginTop: 16 }}>Hàng thế chấp (HTC) theo bên nhận thế chấp</div>
      <ReportTable cols={pledgeCols} rows={pledged} empty="Không có hàng thế chấp." />
    </>
  );
}

// ---------------------------------------------------------------------------
// Đơn đang mở thuộc kho đang xem (đơn chưa ghi kho tính cho mọi kho)
function useOpenOrders(wh, co) {
  const { inMyWarehouses } = useApp();
  const { rows: all, error } = useOrders('', true);
  const rows = useMemo(() => (co ? all.filter((o) => (o.company || '') === co) : all), [all, co]);
  const inScope = (code) => (code ? inMyWarehouses(code) && (!wh || code === wh) : true);
  return { orders: rows, error, inScope };
}

// 4. Tồn kho cho Sale: tồn, sắp về, chưa giao, có thể bán
function ForSales({ wh, co, q }) {
  const { stock, error, locked, itemMap } = useBase(wh, co);
  const { orders, inScope } = useOpenOrders(wh, co);
  const today = vnDate();
  const rows = useMemo(() => {
    const m = new Map();
    const get = (code, nm) => {
      if (!m.has(code)) m.set(code, { _k: code, item: code, itemName: nm || itemMap.get(code)?.name || '', stock: 0, locked: 0, incoming: 0, pending: 0, eta: '', due: '', soN: 0, poN: 0 });
      return m.get(code);
    };
    for (const r of stock) {
      const x = get(r.item, r.itemName);
      x.stock += n(r.kg);
      if (locked.has(r.goodsStatus)) x.locked += n(r.kg);
    }
    for (const o of orders) {
      for (const l of o.lines) {
        if (o.type === 'SO' && inScope(l.warehouse || o.warehouse) && leftKg(l) > 0) {
          const x = get(l.item, l.itemName); x.pending += leftKg(l); x.soN += 1;
          const due = l.dueDate || o.dueDate;
          if (due && (!x.due || due < x.due)) x.due = due;
        }
        // Hàng sắp về: PO còn chưa về; STO về kho đang xem (còn phải xuất + đang đi đường)
        let inc = 0;
        if (o.type === 'PO' && inScope(o.warehouse)) inc = leftKg(l);
        if (o.type === 'STO' && wh && o.toWarehouse === wh && o.fromWarehouse !== wh) inc = leftKg(l) + transitKg(l);
        if (o.type === 'STO' && !wh) inc = transitKg(l);
        if (o.type === 'STO' && wh && o.fromWarehouse === wh && o.toWarehouse !== wh && leftKg(l) > 0) {
          const x = get(l.item, l.itemName); x.pending += leftKg(l); x.soN += 1;
        }
        if (inc > 0) {
          const x = get(l.item, l.itemName); x.incoming += inc; x.poN += 1;
          if (o.dueDate && (!x.eta || o.dueDate < x.eta)) x.eta = o.dueDate;
        }
      }
    }
    return [...m.values()].map((x) => {
      const usable = x.stock - x.locked;
      return { ...x, usable, sellNow: usable - x.pending, sellAll: usable + x.incoming - x.pending };
    }).filter((x) => matchItem(q, x.item, x.itemName)).sort((a, b) => a.item.localeCompare(b.item));
  }, [stock, orders, locked, itemMap, q, wh]); // eslint-disable-line react-hooks/exhaustive-deps
  const neg = (k) => (r) => (r[k] < 0 ? { color: 'var(--red)', fontWeight: 700 } : { fontWeight: 600 });
  const cols = [
    { key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' },
    { key: 'stock', label: 'Tồn kho', ton: true, sum: true },
    { key: 'locked', label: 'Trong đó HTC (khóa)', ton: true, sum: true },
    { key: 'usable', label: 'Tồn được bán', ton: true, sum: true },
    { key: 'pending', label: 'Hàng chưa giao (SO)', ton: true, sum: true },
    { key: 'sellNow', label: 'Có thể bán ngay', ton: true, sum: true, style: neg('sellNow') },
    { key: 'incoming', label: 'Hàng sắp về (PO)', ton: true, sum: true },
    { key: 'eta', label: 'ETA gần nhất', render: (r) => <span style={r.eta && r.eta < today ? { color: 'var(--red)' } : undefined}>{fmtDate(r.eta)}</span>, excel: (r) => r.eta, nowrap: true },
    { key: 'sellAll', label: 'Có thể bán (gồm hàng sắp về)', ton: true, sum: true, style: neg('sellAll') },
  ];
  const excel = () => exportSheets(`BC_ton_cho_sale_${vnDate()}`, { 'Tồn cho Sale': toSheet(cols, rows) });
  return (
    <>
      <p className="hint">
        <b>Tồn được bán</b> = tồn kho − hàng thế chấp (HTC). <b>Có thể bán ngay</b> = tồn được bán − hàng chưa giao.
        <b> Có thể bán (gồm hàng sắp về)</b> = có thể bán ngay + PO còn chưa về{wh ? ' + STO đang chuyển về kho này' : ' + hàng chuyển kho đang đi đường'}. Đơn vị: tấn.
      </p>
      <ErrorBox error={error} />
      <Actions onExcel={excel} />
      <ReportTable cols={cols} rows={rows} empty="Chưa có tồn kho hoặc đơn hàng." />
    </>
  );
}

// ---------------------------------------------------------------------------
// 5 & 6. Đơn bán chưa giao / đơn mua chưa nhập kho (theo từng dòng mặt hàng)
function useOrderLines(type, wh, co, q, onlyLate) {
  const { orders, error, inScope } = useOpenOrders(wh, co);
  const today = vnDate();
  const rows = orders.filter((o) => o.type === type && OPEN_STATUSES.includes(o.status))
    .flatMap((o) => o.lines.filter((l) => leftKg(l) > 0 && inScope(l.warehouse || o.warehouse)).map((l) => {
      const due = l.dueDate || o.dueDate || '';
      return {
        _k: `${o.id}-${l.no}`, id: o.id, refNo: o.refNo || '', date: o.date, partyCode: o.partyCode, partyName: o.partyName, company: o.company || '', shipCode: l.shipCode || o.shipCode || '',
        warehouse: l.warehouse || o.warehouse || '', item: l.item, itemName: l.itemName, qty: n(l.qtyKg), done: n(l.doneKg), left: leftKg(l),
        due, late: due && due < today ? ageDays(due) : 0, status: o.status, goodsStatus: l.goodsStatus || '',
      };
    }))
    .filter((r) => matchItem(q, r.id, r.refNo, r.partyCode, r.partyName, r.item, r.itemName))
    .filter((r) => !onlyLate || r.late > 0)
    .sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.id.localeCompare(b.id));
  return { rows, error };
}
const lateStyle = (r) => (r.late > 0 ? { color: 'var(--red)', fontWeight: 600 } : undefined);

function OpenSO({ wh, co, q }) {
  const [onlyLate, setOnlyLate] = useState(false);
  const { rows, error } = useOrderLines('SO', wh, co, q, onlyLate);
  const { stock, locked } = useBase(wh, co);
  const usable = useMemo(() => {
    const m = new Map();
    for (const r of stock) if (!locked.has(r.goodsStatus)) m.set(r.item, n(m.get(r.item)) + n(r.kg));
    return m;
  }, [stock, locked]);
  const list = rows.map((r) => ({ ...r, avail: n(usable.get(r.item)) }));
  const cols = [
    { key: 'id', label: 'Số SO', nowrap: true }, { key: 'refNo', label: 'Số Ecount' }, { key: 'company', label: 'Công ty' }, { key: 'date', label: 'Ngày đơn', render: (r) => fmtDate(r.date), nowrap: true },
    { key: 'partyCode', label: 'Mã KH' }, { key: 'partyName', label: 'Khách hàng' }, { key: 'shipCode', label: 'Giao đến' }, { key: 'warehouse', label: 'Kho' },
    { key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' },
    { key: 'qty', label: 'Đặt', ton: true, sum: true }, { key: 'done', label: 'Đã giao', ton: true, sum: true },
    { key: 'left', label: 'Còn phải giao', ton: true, sum: true, style: () => ({ fontWeight: 700 }) },
    { key: 'avail', label: 'Tồn được xuất (mã hàng)', ton: true, style: (r) => (r.avail < r.left ? { color: 'var(--amber)', fontWeight: 600 } : undefined) },
    { key: 'due', label: 'Hạn giao', render: (r) => fmtDate(r.due), nowrap: true, style: lateStyle },
    { key: 'late', label: 'Trễ (ngày)', num: true, style: lateStyle },
    { key: 'status', label: 'Trạng thái', render: (r) => ORDER_STATUS[r.status]?.label, excel: (r) => ORDER_STATUS[r.status]?.label },
  ];
  const byCustomer = useMemo(() => {
    const m = new Map();
    for (const r of list) {
      const x = m.get(r.partyCode) || { _k: r.partyCode, partyCode: r.partyCode, partyName: r.partyName, orders: new Set(), left: 0, late: 0 };
      x.orders.add(r.id); x.left += r.left; if (r.late > 0) x.late += r.left;
      m.set(r.partyCode, x);
    }
    return [...m.values()].map((x) => ({ ...x, orders: x.orders.size })).sort((a, b) => b.left - a.left);
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const custCols = [{ key: 'partyCode', label: 'Mã KH' }, { key: 'partyName', label: 'Khách hàng' }, { key: 'orders', label: 'Số đơn', num: true, sum: true },
    { key: 'left', label: 'Còn phải giao', ton: true, sum: true }, { key: 'late', label: 'Trong đó quá hạn', ton: true, sum: true, style: (r) => (r.late > 0 ? { color: 'var(--red)' } : undefined) }];
  const excel = () => exportSheets(`BC_don_chua_giao_${vnDate()}`, { 'Chi tiết': toSheet(cols, list), 'Theo khách hàng': toSheet(custCols, byCustomer) });
  return (
    <>
      <ErrorBox error={error} />
      <div className="toolbar no-print">
        <label className="small"><input type="checkbox" checked={onlyLate} onChange={(e) => setOnlyLate(e.target.checked)} /> Chỉ đơn quá hạn giao</label>
        <span style={{ marginLeft: 'auto' }}><Actions onExcel={excel} /></span>
      </div>
      <div className="section-head">Theo khách hàng (tấn)</div>
      <ReportTable cols={custCols} rows={byCustomer} empty="Không có đơn chưa giao." />
      <div className="section-head" style={{ marginTop: 16 }}>Chi tiết từng dòng đơn (tấn)</div>
      <ReportTable cols={cols} rows={list} empty="Không có đơn chưa giao." />
    </>
  );
}

function OpenPO({ wh, co, q }) {
  const [onlyLate, setOnlyLate] = useState(false);
  const { rows, error } = useOrderLines('PO', wh, co, q, onlyLate);
  const cols = [
    { key: 'id', label: 'Số PO', nowrap: true }, { key: 'refNo', label: 'Số Ecount' }, { key: 'company', label: 'Công ty' }, { key: 'date', label: 'Ngày đơn', render: (r) => fmtDate(r.date), nowrap: true },
    { key: 'partyCode', label: 'Mã NCC' }, { key: 'partyName', label: 'Nhà cung cấp' }, { key: 'warehouse', label: 'Nhập về kho' },
    { key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' },
    { key: 'qty', label: 'Đặt', ton: true, sum: true }, { key: 'done', label: 'Đã nhận', ton: true, sum: true },
    { key: 'left', label: 'Còn chưa về', ton: true, sum: true, style: () => ({ fontWeight: 700 }) },
    { key: 'due', label: 'ETA', render: (r) => fmtDate(r.due), nowrap: true, style: lateStyle },
    { key: 'late', label: 'Trễ ETA (ngày)', num: true, style: lateStyle },
    { key: 'status', label: 'Trạng thái', render: (r) => ORDER_STATUS[r.status]?.label, excel: (r) => ORDER_STATUS[r.status]?.label },
  ];
  const bySupplier = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r.partyCode}__${r.item}`;
      const x = m.get(k) || { _k: k, partyCode: r.partyCode, partyName: r.partyName, item: r.item, itemName: r.itemName, left: 0, eta: '' };
      x.left += r.left; if (r.due && (!x.eta || r.due < x.eta)) x.eta = r.due;
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => a.partyCode.localeCompare(b.partyCode) || a.item.localeCompare(b.item));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const supCols = [{ key: 'partyCode', label: 'Mã NCC' }, { key: 'partyName', label: 'Nhà cung cấp' }, { key: 'item', label: 'Mã hàng', nowrap: true },
    { key: 'itemName', label: 'Tên hàng' }, { key: 'left', label: 'Còn chưa về', ton: true, sum: true },
    { key: 'eta', label: 'ETA gần nhất', render: (r) => fmtDate(r.eta), excel: (r) => r.eta, nowrap: true }];
  const excel = () => exportSheets(`BC_PO_chua_nhap_${vnDate()}`, { 'Chi tiết': toSheet(cols, rows), 'Theo NCC và mã hàng': toSheet(supCols, bySupplier) });
  return (
    <>
      <ErrorBox error={error} />
      <div className="toolbar no-print">
        <label className="small"><input type="checkbox" checked={onlyLate} onChange={(e) => setOnlyLate(e.target.checked)} /> Chỉ PO quá ETA</label>
        <span style={{ marginLeft: 'auto' }}><Actions onExcel={excel} /></span>
      </div>
      <div className="section-head">Theo nhà cung cấp và mã hàng (tấn)</div>
      <ReportTable cols={supCols} rows={bySupplier} empty="Không có PO chưa nhập." />
      <div className="section-head" style={{ marginTop: 16 }}>Chi tiết từng dòng PO (tấn)</div>
      <ReportTable cols={cols} rows={rows} empty="Không có PO chưa nhập." />
    </>
  );
}
