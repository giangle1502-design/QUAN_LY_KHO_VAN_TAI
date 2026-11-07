import { Fragment, useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useCollection, useCompanies, useOrders, useStock } from '../../lib/hooks';
import { useOrderSecrets, viewOrder } from '../../lib/orderSecrets';
import { useOrderMoney } from '../../lib/orderMoney';
import { OPEN_STATUSES, leftKg, lineFrom, lineTo, transitKg } from '../../lib/orders';
import { PLASTIC_TYPES } from '../../lib/plasticSales';
import { usePref } from '../../lib/prefs';
import { vnDate } from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { Empty, ErrorBox, Modal } from '../../components/ui';
import Select from '../../components/Select';
import { StockDetailModal } from '../../components/StockDetail';
import { ColumnPicker } from '../../components/FormTools';
import { ViewPresets, useTableTools } from '../../components/TableTools';
import { dragHeadProps, orderCols } from '../../lib/colOrder';

// ============================================================================
// Tồn kho và hàng về (giống tab "Có thể bán" của Sale_control) — để sale họp:
// mỗi mã hàng: tồn thực tế, đơn chưa giao (SO), hàng chưa về (PO + STO), có thể bán = tồn − chưa giao + chưa về.
// Bấm 1 dòng → tồn từng kho, các lô hàng đang về (ETA, kg, nơi nhận, BCT, NCC), đơn chưa giao.
// Lưu kg, ô tổng hiện tấn. Giá mua chỉ quản trị / sale quản trị (xem đơn của mọi sale) mới thấy.
// ============================================================================

const n = (v) => Number(v) || 0;
const kg = (v) => fmtNum(v, 0);
const tan = (v) => fmtNum(n(v) / 1000, 1);
const money = (v) => fmtNum(Math.round(n(v)), 0);

function Stat({ label, value, sub, tone, onClick, active }) {
  return (
    <div className={`stat ${tone || ''}`} onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : undefined, outline: active ? '2px solid var(--red)' : undefined }}>
      <div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

const SCOPES = [['active', 'Mã có tồn / đơn / hàng về'], ['sell', 'Còn bán được (dương)'], ['short', 'Thiếu hàng (âm)'],
  ['over', 'Đơn chưa giao > tồn hiện có'], ['all', 'Tất cả mã']];

// Số liệu tồn – chưa giao – chưa về theo từng mã hàng (dùng chung cho báo cáo Tồn kho và hàng về, Tồn kho cho Sale)
export function useSaleStock(wh, co) {
  const { inMyWarehouses, isAdmin, role, salesOnly } = useApp();
  const saleAdmin = isAdmin || (role === 'kinh_doanh' && !salesOnly);
  const { rows: stockAll, error: e1 } = useStock(wh);
  const { rows: ordersAll, error: e2 } = useOrders('');
  const items = useCollection('items').rows;
  const warehouses = useCollection('warehouses').rows;
  const companies = useCompanies();
  const users = useCollection('users').rows;
  const saleName = useMemo(() => new Map(users.map((u) => [u.email, u.name || u.email])), [users]);
  const soMoney = useOrderMoney('SO');
  const poMoney = useOrderMoney('PO');
  const soSec = useOrderSecrets('SO');
  const poSec = useOrderSecrets('PO');


  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const whName = useMemo(() => new Map(warehouses.map((w) => [w.code, w.name || w.code])), [warehouses]);
  const coShort = useMemo(() => new Map(companies.map((c) => [c.code, c.code])), [companies]);
  const inScope = (code) => (code ? inMyWarehouses(code) && (!wh || code === wh) : true);
  const today = vnDate();

  const all = useMemo(() => {
    const m = new Map();
    const get = (code, nm) => {
      if (!code) return null;
      if (!m.has(code)) {
        const it = itemMap.get(code) || {};
        m.set(code, { item: code, itemName: nm || it.name || '', prop: it.property || '', ptype: it.plasticType || '',
          onHand: 0, unshipped: 0, incoming: 0, wh: new Map(), lots: [], sos: [], price: 0, priceDate: '' });
      }
      return m.get(code);
    };
    for (const r of stockAll) {
      if (co && (r.company || '') !== co) continue;
      const x = get(r.item, r.itemName); if (!x) continue;
      x.onHand += n(r.kg);
      const k = `${r.company ? `${coShort.get(r.company) || r.company} - ` : ''}${whName.get(r.warehouse) || r.warehouse}`;
      const w = x.wh.get(k) || { kg: 0, locked: 0, code: r.warehouse };
      w.kg += n(r.kg); if (r.goodsStatus === 'HTC') w.locked += n(r.kg);
      x.wh.set(k, w);
    }
    for (const o0 of ordersAll) {
      if (co && (o0.company || '') !== co) continue;
      if (o0.status === 'cancelled') continue;
      const isOpen = OPEN_STATUSES.includes(o0.status);
      // Giá bán gần nhất: dòng SO mới nhất có giá mà người dùng được xem
      if (o0.type === 'SO' && soMoney.lineSeen.length) {
        const o = viewOrder(o0, soSec, soMoney.headSeen, soMoney.lineSeen);
        for (const l of o.lines || []) {
          const x = m.get(l.item) || (isOpen ? get(l.item, l.itemName) : null);
          if (!x) continue;
          const { price } = soMoney.lineMoney(l, o);
          if (price > 0 && (o.date || '') >= x.priceDate) { x.price = price; x.priceDate = o.date || ''; }
        }
      }
      if (!isOpen) continue;
      const o = o0.type === 'PO' && saleAdmin ? viewOrder(o0, poSec, poMoney.headSeen, poMoney.lineSeen) : o0;
      for (const l of o.lines || []) {
        const eta = l.dueDate || o.dueDate || '';
        if (o.type === 'SO' && inScope(l.warehouse || o.warehouse) && leftKg(l) > 0) {
          const x = get(l.item, l.itemName); x.unshipped += leftKg(l);
          x.sos.push({ id: o.id, due: eta, date: o.date || '', party: o.partyName || o.partyCode, partyCode: o.partyCode || '', left: leftKg(l), qty: n(l.qtyKg), done: n(l.doneKg),
            wh: l.warehouse || o.warehouse || '', sales: o.sales || '', by: o.createdByName || o.createdBy || '', refNo: o.refNo || '', company: o.company || '' });
        }
        if (o.type === 'PO' && inScope(l.warehouse || o.warehouse) && leftKg(l) > 0) {
          const x = get(l.item, l.itemName); x.incoming += leftKg(l);
          x.lots.push({ eta, kg: leftKg(l), place: whName.get(l.warehouse || o.warehouse) || l.warehouse || o.warehouse || '', bct: o.refNo || '',
            sup: `NCC ${o.partyName || o.partyCode || '-'}`, po: o.id, buy: saleAdmin && poMoney.lineSeen.length ? poMoney.lineMoney(l, o).price : 0 });
        }
        if (o.type === 'STO') {
          const fw = lineFrom(o, l); const tw = lineTo(o, l);
          // Cả công ty: chỉ hàng đang đi đường; theo 1 kho: STO về kho này = còn phải xuất + đang đi đường, STO đi khỏi kho = như đơn chưa giao
          const inc = !wh ? transitKg(l) : tw === wh && fw !== wh ? leftKg(l) + transitKg(l) : 0;
          if (inc > 0 && (!tw || inMyWarehouses(tw))) {
            const x = get(l.item, l.itemName); x.incoming += inc;
            x.lots.push({ eta, kg: inc, place: whName.get(tw) || tw, bct: '', sup: `Chuyển kho từ ${whName.get(fw) || fw}`, po: o.id, buy: 0 });
          }
          if (wh && fw === wh && tw !== wh && leftKg(l) > 0) {
            const x = get(l.item, l.itemName); x.unshipped += leftKg(l);
            x.sos.push({ id: o.id, due: eta, date: o.date || '', party: `Chuyển đến ${whName.get(tw) || tw}`, left: leftKg(l), qty: n(l.qtyKg), done: n(l.doneKg), wh: fw, sales: '', by: o.createdByName || o.createdBy || '', sto: true });
          }
        }
      }
    }
    return [...m.values()].map((x) => {
      x.lots.sort((a, b) => (a.eta || '9').localeCompare(b.eta || '9'));
      x.sos.sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
      const next = x.lots.find((l) => l.eta && l.eta >= today) || x.lots.find((l) => l.eta);
      return { ...x, avail: x.onHand - x.unshipped + x.incoming, next };
    });
  }, [stockAll, ordersAll, itemMap, whName, coShort, co, wh, soSec, poSec, soMoney, poMoney, saleAdmin, today]); // eslint-disable-line react-hooks/exhaustive-deps

  return { all, saleName, saleAdmin, salesOnly, soMoney, poMoney, stockAll, error: e1 || e2, today };
}

export default function StockInbound({ wh, co, q }) {
  const { all, saleName, saleAdmin, salesOnly, soMoney, poMoney, stockAll, error, today } = useSaleStock(wh, co);
  const [prop, setProp] = usePref('stockInbound:prop', '');
  const [ptype, setPtype] = usePref('stockInbound:ptype', '');
  const [only, setOnly] = usePref('stockInbound:only', 'active');
  const [open, setOpen] = useState('');
  const [detail, setDetail] = useState(null);
  const props = useMemo(() => [...new Set(all.map((x) => x.prop).filter(Boolean))].sort(), [all]);
  const base = all.filter((x) => (!prop || x.prop === prop) && (!ptype || (ptype === '-' ? !x.ptype : x.ptype === ptype))
    && (!q || norm([x.item, x.itemName, x.prop, x.ptype].join(' ')).includes(q)));
  const rows0 = base.filter((x) => (only === 'all' ? true : only === 'active' ? x.onHand || x.unshipped || x.incoming
    : only === 'short' ? x.avail < 0 : only === 'over' ? x.unshipped > x.onHand : x.avail > 0))
    .sort((a, b) => b.onHand - a.onHand || b.avail - a.avail || a.item.localeCompare(b.item));
  const hasPrice0 = all.some((x) => x.price > 0);
  // Cột bảng: mỗi người tự chọn / đổi thứ tự / sắp xếp nhiều cấp / lọc từng cột (lưu theo tài khoản)
  const allCols = [
    { key: 'item', label: 'Mã hàng', locked: true, render: (x, o) => <><b>{o ? '▾' : '▸'} {x.item}</b><div className="small">{x.itemName}</div></> },
    { key: 'itemName', label: 'Tên hàng', hideDefault: true, render: (x) => x.itemName },
    { key: 'prop', label: 'Tính chất', render: (x) => <span className="small">{x.prop}{x.ptype ? <div>{x.ptype}</div> : null}</span> },
    { key: 'ptype', label: 'Loại hạt', hideDefault: true, render: (x) => x.ptype },
    ...(hasPrice0 ? [{ key: 'price', label: 'Giá bán', num: true, title: `Giá bán của đơn bán gần nhất bạn được xem (${soMoney.unitLabel})`, render: (x) => (x.price ? money(x.price) : '-') }] : []),
    { key: 'onHand', label: 'Tồn thực tế', num: true, render: (x) => <b>{kg(x.onHand)}</b> },
    { key: 'unshipped', label: 'Chưa giao', num: true, render: (x) => (x.unshipped ? <span style={{ color: x.unshipped > x.onHand ? 'var(--red)' : undefined }}>{kg(x.unshipped)}</span> : '-') },
    { key: 'incoming', label: 'Chưa về', num: true, render: (x) => (x.incoming ? kg(x.incoming) : '-') },
    { key: 'avail', label: 'Có thể bán', num: true, render: (x) => <b style={{ color: x.avail < 0 ? 'var(--red)' : x.avail > 0 ? 'var(--green)' : undefined }}>{kg(x.avail)}</b> },
    { key: 'next', label: 'Hàng về gần nhất', date: true, sortVal: (x) => x.next?.eta || '',
      render: (x) => <span className="nowrap small">{x.next ? <span style={{ color: x.next.eta < today ? 'var(--red)' : undefined }}>{fmtDate(x.next.eta)} · {tan(x.next.kg)} t</span> : x.lots.length ? 'Chưa có ETA' : '-'}</span> },
    { key: 'soN', label: 'Số đơn chưa giao', num: true, hideDefault: true, sortVal: (x) => x.sos.length, render: (x) => x.sos.length || '' },
  ];
  const [hidden, setHidden] = usePref('stockInbound:hidden', allCols.filter((c) => c.hideDefault).map((c) => c.key));
  const [colOrder, setColOrder] = usePref('rpOrder:stockInbound', []);
  const ordered = orderCols(allCols, colOrder);
  const colKeys = ordered.map((c) => c.key);
  const shownCols = ordered.filter((c) => c.locked || !hidden.includes(c.key));
  const tools = useTableTools('stockInbound', allCols, rows0);
  const rows = tools.rows;
  const sum = (k) => base.reduce((t, x) => t + x[k], 0);
  const shortList = base.filter((x) => x.avail < 0);
  const hasPrice = all.some((x) => x.price > 0);
  const priceUnit = soMoney.unitLabel;

  const excel = () => exportSheets(`Ton_kho_hang_ve_${today}`, {
    'Tồn kho và hàng về': rows.map((x) => ({
      'Mã hàng': x.item, 'Tên hàng': x.itemName, 'Tính chất': x.prop, 'Loại hạt': x.ptype,
      ...(hasPrice ? { [`Giá bán gần nhất (${priceUnit})`]: x.price ? Math.round(x.price) : '' } : {}),
      'Tồn thực tế (kg)': x.onHand, 'Chưa giao (kg)': x.unshipped, 'Chưa về (kg)': x.incoming, 'Có thể bán (kg)': x.avail,
      'Hàng về gần nhất': x.next ? fmtDate(x.next.eta) : x.lots.length ? 'Chưa có ETA' : '',
      'Tồn từng kho': [...x.wh].map(([k, w]) => `${k}: ${kg(w.kg)}`).join('; '),
    })),
    'Hàng đang về': rows.flatMap((x) => x.lots.map((l) => ({
      'Mã hàng': x.item, 'Tên hàng': x.itemName, ETA: l.eta ? fmtDate(l.eta) : 'Chưa có ETA', 'Số lượng (kg)': l.kg, 'Nơi nhận': l.place,
      'Số đơn': l.po, BCT: l.bct, 'Nhà cung cấp': l.sup, ...(saleAdmin ? { [`Giá mua (${poMoney.unitLabel})`]: l.buy ? Math.round(l.buy) : '' } : {}),
    }))),
  });

  return (
    <>
      <ErrorBox error={error} />
      <div className="stats">
        <Stat tone="green" label="Tồn kho thực tế" value={`${tan(sum('onHand'))} tấn`} sub={`${base.filter((x) => x.onHand > 0).length} mã có tồn`} />
        <Stat tone="amber" label="Đơn chưa giao (đã hứa khách)" value={`${tan(sum('unshipped'))} tấn`} sub={salesOnly ? 'Chỉ tính đơn của bạn' : undefined} />
        <Stat label="Hàng chưa về" value={`${tan(sum('incoming'))} tấn`} />
        <Stat tone="green" label="Có thể bán thêm" value={`${tan(base.reduce((t, x) => t + Math.max(0, x.avail), 0))} tấn`} sub="Tồn − chưa giao + chưa về (mã dương)" />
        <Stat tone="red" label="Mã thiếu hàng (âm)" value={shortList.length} sub={`${tan(-shortList.reduce((t, x) => t + x.avail, 0))} tấn thiếu`}
          onClick={() => setOnly(only === 'short' ? 'active' : 'short')} active={only === 'short'} />
      </div>
      <div className="toolbar no-print" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <Select value={prop} onChange={(e) => setProp(e.target.value)}>
          <option value="">Mọi tính chất</option>{props.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select value={ptype} onChange={(e) => setPtype(e.target.value)}>
          <option value="">Mọi loại hạt</option>{PLASTIC_TYPES.map((p) => <option key={p.type} value={p.type}>{p.type}</option>)}<option value="-">Hàng khác</option>
        </Select>
        <Select value={only} onChange={(e) => setOnly(e.target.value)}>
          {SCOPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={excel} disabled={!rows.length}>⬇ Excel</button>
          <button className="btn" onClick={() => window.print()}>🖨 In</button>
        </span>
      </div>
      {salesOnly && <p className="hint">Cột Chưa giao chỉ gồm đơn bán của bạn (bạn không xem được đơn của sale khác).</p>}
      <div className="report-cols no-print">
        {tools.toolbar}
        <ColumnPicker cols={allCols.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))} hidden={hidden} setHidden={setHidden} order={colOrder} setOrder={setColOrder} />
        <ViewPresets pid="stockInbound" snapshot={() => ({ ...tools.snapshot(), hidden, colOrder })} restore={(v) => { tools.restore(v); if (v?.hidden) setHidden(v.hidden); setColOrder(v?.colOrder || []); }} />
        {rows.length !== rows0.length && <span className="small">Đang lọc: {rows.length} / {rows0.length} mã</span>}
      </div>
      {tools.advPanel}
      {tools.popup}
      <div className="table-wrap">
        {rows0.length === 0 ? <Empty text={all.length ? 'Không có mã phù hợp.' : 'Chưa có tồn kho, đơn bán hay hàng về.'} /> : (
          <table>
            <thead><tr>
              {shownCols.map((c) => <th key={c.key} className={(c.num ? 'num ' : '') + 'col-drag'} title={c.title} {...dragHeadProps(c.key, colKeys, setColOrder)} {...tools.headProps(c)}>{c.label}{tools.headMark(c)}</th>)}
            </tr></thead>
            <tbody>
              {!rows.length && <tr><td colSpan={shownCols.length}><Empty text="Không có mã nào khớp điều kiện lọc." /></td></tr>}
              {rows.map((x) => {
                const isOpen = open === x.item;
                return (
                  <Fragment key={x.item}>
                    <tr onClick={() => setOpen(isOpen ? '' : x.item)} title="Bấm để xem đơn chưa xuất, hàng sắp về theo ngày, tồn từng kho / vị trí"
                      style={{ cursor: 'pointer', background: x.avail < 0 ? 'var(--red-soft)' : isOpen ? 'var(--primary-soft)' : undefined }}>
                      {shownCols.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render(x, isOpen)}</td>)}
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={shownCols.length} style={{ background: '#fafbfd' }}>
                        <SaleItemPanel x={x} ctx={{ saleName, saleAdmin, salesOnly, poMoney, today }} onStockDetail={(f) => setDetail(f)} />
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {detail && <StockDetailModal stock={stockAll.filter((r) => !co || (r.company || '') === co)} filter={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Chi tiết 1 mã hàng cho sale (giống Sale_control): tồn từng kho (bấm → vị trí), hàng sắp về theo ngày
// (ngày gần nhất, các ngày khác, chưa có lịch), đơn chưa xuất còn bao nhiêu, ai đặt.
// ---------------------------------------------------------------------------
export function SaleItemPanel({ x, ctx, onStockDetail }) {
  const { saleName, saleAdmin, salesOnly, poMoney, today } = ctx;
  const dated = x.lots.filter((l) => l.eta);
  const noEta = x.lots.filter((l) => !l.eta);
  const byDate = [...dated.reduce((m, l) => m.set(l.eta, n(m.get(l.eta)) + l.kg), new Map())].sort((a, b) => a[0].localeCompare(b[0]));
  const nearest = byDate.find(([d]) => d >= today) || byDate[0];
  const others = byDate.filter((d) => d !== nearest);
  const noEtaKg = noEta.reduce((t, l) => t + l.kg, 0);
  const whoOf = (s) => (s.sales ? saleName.get(s.sales) || s.sales : s.by ? saleName.get(s.by) || s.by : '');
  const bySale = [...x.sos.reduce((m, s) => { const k = whoOf(s) || (s.sto ? 'Chuyển kho' : '(chưa ghi sale)'); return m.set(k, n(m.get(k)) + s.left); }, new Map())].sort((a, b) => b[1] - a[1]);
  const box = (label, value, sub, tone) => (
    <div className={`stat ${tone || ''}`} style={{ padding: '8px 10px' }}><div className="stat-label">{label}</div><div className="stat-value" style={{ fontSize: 18 }}>{value}</div>{sub && <div className="stat-sub">{sub}</div>}</div>
  );
  return (
    <div className="sale-detail">
      <div className="stats" style={{ marginBottom: 8 }}>
        {box('Tồn thực tế', `${kg(x.onHand)} kg`, `${x.wh.size} kho`, 'green')}
        {box('Đơn chưa xuất', `${kg(x.unshipped)} kg`, `${x.sos.length} dòng đơn${salesOnly ? ' (của bạn)' : ''}`, 'amber')}
        {box('Hàng về gần nhất', nearest ? `${kg(nearest[1])} kg` : '-', nearest ? <span style={{ color: nearest[0] < today ? 'var(--red)' : undefined }}>{fmtDate(nearest[0])}{nearest[0] < today ? ' (trễ)' : ''}</span> : 'Chưa có lịch')}
        {box('Các ngày khác', `${kg(others.reduce((t, d) => t + d[1], 0))} kg`, `${others.length} ngày`)}
        {box('Chưa có lịch về', `${kg(noEtaKg)} kg`, `${noEta.length} lô`, noEtaKg ? 'red' : '')}
        {box('Có thể bán', `${kg(x.avail)} kg`, 'Tồn − chưa xuất + chưa về', x.avail < 0 ? 'red' : 'green')}
      </div>
      <div className="grid2" style={{ marginBottom: 8, alignItems: 'start' }}>
        <div>
          <div className="small"><b>Tồn từng kho</b> <span className="small">(bấm để xem vị trí)</span></div>
          {x.wh.size ? [...x.wh].sort((a, b) => b[1].kg - a[1].kg).map(([k, w]) => (
            <div key={k} className="small">
              <a href="#" onClick={(e) => { e.preventDefault(); onStockDetail?.({ item: x.item, warehouse: w.code }); }}>{k}</a>: <b>{kg(w.kg)}</b> kg{w.locked ? <span style={{ color: 'var(--amber)' }}> (HTC {kg(w.locked)} kg)</span> : null}
            </div>
          )) : <div className="small">Không có tồn</div>}
          {x.wh.size > 0 && <button type="button" className="btn sm" style={{ marginTop: 4 }} onClick={() => onStockDetail?.({ item: x.item })}>🔍 Xem chi tiết vị trí</button>}
        </div>
        <div>
          <div className="small"><b>Hàng sắp về theo ngày</b></div>
          {!x.lots.length && <div className="small">Không có hàng đang về</div>}
          {byDate.map(([d, v]) => (
            <div key={d} className="small" style={d === nearest?.[0] ? { fontWeight: 700 } : undefined}>
              {d === nearest?.[0] ? '⭐ Gần nhất ' : ''}<span style={{ color: d < today ? 'var(--red)' : undefined }}>{fmtDate(d)}{d < today ? ' (trễ)' : ''}</span>: <b>{kg(v)}</b> kg
            </div>
          ))}
          {noEtaKg > 0 && <div className="small" style={{ color: 'var(--red)' }}>Chưa có lịch: <b>{kg(noEtaKg)}</b> kg ({noEta.length} lô)</div>}
        </div>
      </div>
      {x.lots.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="small"><b>Các lô hàng đang về ({x.lots.length})</b></div>
          <div className="table-wrap"><table className="no-resize">
            <thead><tr><th>Ngày về (ETA)</th><th className="num">Số lượng (kg)</th><th>Nơi nhận</th><th>Số đơn</th><th>BCT</th><th>Nguồn</th>{saleAdmin && <th className="num">Giá mua</th>}</tr></thead>
            <tbody>{x.lots.map((l, i) => (
              <tr key={i}><td className="nowrap">{l.eta ? <span style={{ color: l.eta < today ? 'var(--red)' : undefined }}>{fmtDate(l.eta)}</span> : <i>Chưa có lịch</i>}</td>
                <td className="num"><b>{kg(l.kg)}</b></td><td>{l.place || '-'}</td><td className="mono">{l.po}</td><td>{l.bct}</td><td>{l.sup}</td>
                {saleAdmin && <td className="num">{l.buy ? `${money(l.buy)} ${poMoney.unitLabel}` : ''}</td>}</tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
      {x.sos.length > 0 && (
        <div>
          <div className="small"><b>Đơn chưa xuất{salesOnly ? ' của bạn' : ''} ({x.sos.length})</b>{!salesOnly && bySale.length ? <> — theo người đặt: {bySale.map(([k, v]) => `${k} ${kg(v)} kg`).join(' · ')}</> : null}</div>
          <div className="table-wrap"><table className="no-resize">
            <thead><tr><th>Hẹn giao</th><th>Số đơn</th><th>Ngày đặt</th><th>Khách hàng</th><th>Người đặt (sale)</th><th>Kho</th><th className="num">Đặt</th><th className="num">Đã xuất</th><th className="num">Còn chưa xuất</th></tr></thead>
            <tbody>{x.sos.map((so, i) => (
              <tr key={i}><td className="nowrap">{so.due ? <span style={{ color: so.due < today ? 'var(--red)' : undefined }}>{fmtDate(so.due)}</span> : <i>Chưa hẹn</i>}</td>
                <td className="mono nowrap">{so.id}</td><td className="nowrap">{fmtDate(so.date)}</td><td>{so.party}</td><td>{whoOf(so) || '-'}</td><td>{so.wh}</td>
                <td className="num">{kg(so.qty)}</td><td className="num">{kg(so.done)}</td><td className="num"><b>{kg(so.left)}</b></td></tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={6}>Cộng</td><td className="num">{kg(x.sos.reduce((t, so) => t + n(so.qty), 0))}</td><td className="num">{kg(x.sos.reduce((t, so) => t + n(so.done), 0))}</td><td className="num">{kg(x.unshipped)}</td></tr></tfoot>
          </table></div>
        </div>
      )}
    </div>
  );
}

// Hộp chi tiết 1 mã hàng (dùng ở báo cáo Tồn kho cho Sale)
export function SaleItemModal({ item, wh, co, onClose }) {
  const { all, saleName, saleAdmin, salesOnly, poMoney, stockAll, today } = useSaleStock(wh, co);
  const [detail, setDetail] = useState(null);
  const x = all.find((r) => r.item === item);
  return (
    <Modal title={`💼 ${item}${x?.itemName ? ` · ${x.itemName}` : ''}`} onClose={onClose} wide>
      {!x ? <Empty text="Đang tải…" /> : <SaleItemPanel x={x} ctx={{ saleName, saleAdmin, salesOnly, poMoney, today }} onStockDetail={setDetail} />}
      {detail && <StockDetailModal stock={stockAll.filter((r) => !co || (r.company || '') === co)} filter={detail} onClose={() => setDetail(null)} />}
    </Modal>
  );
}
