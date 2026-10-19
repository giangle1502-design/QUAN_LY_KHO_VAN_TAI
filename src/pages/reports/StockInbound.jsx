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
import { Empty, ErrorBox } from '../../components/ui';
import Select from '../../components/Select';

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

export default function StockInbound({ wh, co, q }) {
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

  const [prop, setProp] = usePref('stockInbound:prop', '');
  const [ptype, setPtype] = usePref('stockInbound:ptype', '');
  const [only, setOnly] = usePref('stockInbound:only', 'active');
  const [open, setOpen] = useState('');

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
      const w = x.wh.get(k) || { kg: 0, locked: 0 };
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
          x.sos.push({ id: o.id, due: eta, party: o.partyName || o.partyCode, left: leftKg(l), sales: o.sales || '' });
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
            x.sos.push({ id: o.id, due: eta, party: `Chuyển đến ${whName.get(tw) || tw}`, left: leftKg(l), sales: '' });
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

  const props = useMemo(() => [...new Set(all.map((x) => x.prop).filter(Boolean))].sort(), [all]);
  const base = all.filter((x) => (!prop || x.prop === prop) && (!ptype || (ptype === '-' ? !x.ptype : x.ptype === ptype))
    && (!q || norm([x.item, x.itemName, x.prop, x.ptype].join(' ')).includes(q)));
  const rows = base.filter((x) => (only === 'all' ? true : only === 'active' ? x.onHand || x.unshipped || x.incoming
    : only === 'short' ? x.avail < 0 : only === 'over' ? x.unshipped > x.onHand : x.avail > 0))
    .sort((a, b) => b.onHand - a.onHand || b.avail - a.avail || a.item.localeCompare(b.item));
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
      <ErrorBox error={e1 || e2} />
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
      <div className="table-wrap">
        {rows.length === 0 ? <Empty text={all.length ? 'Không có mã phù hợp.' : 'Chưa có tồn kho, đơn bán hay hàng về.'} /> : (
          <table>
            <thead><tr>
              <th>Mã hàng</th><th>Tính chất</th>{hasPrice && <th className="num" title={`Giá bán của đơn bán gần nhất bạn được xem (${priceUnit})`}>Giá bán</th>}
              <th className="num">Tồn thực tế</th><th className="num">Chưa giao</th><th className="num">Chưa về</th><th className="num">Có thể bán</th><th>Hàng về gần nhất</th>
            </tr></thead>
            <tbody>
              {rows.map((x) => {
                const isOpen = open === x.item;
                const ne = x.next;
                return (
                  <Fragment key={x.item}>
                    <tr onClick={() => setOpen(isOpen ? '' : x.item)}
                      style={{ cursor: 'pointer', background: x.avail < 0 ? 'var(--red-soft)' : isOpen ? 'var(--primary-soft)' : undefined }}>
                      <td><b>{isOpen ? '▾' : '▸'} {x.item}</b><div className="small">{x.itemName}</div></td>
                      <td className="small">{x.prop}{x.ptype ? <div>{x.ptype}</div> : null}</td>
                      {hasPrice && <td className="num">{x.price ? money(x.price) : '-'}</td>}
                      <td className="num"><b>{kg(x.onHand)}</b></td>
                      <td className="num">{x.unshipped ? <span style={{ color: x.unshipped > x.onHand ? 'var(--red)' : undefined }}>{kg(x.unshipped)}</span> : '-'}</td>
                      <td className="num">{x.incoming ? kg(x.incoming) : '-'}</td>
                      <td className="num"><b style={{ color: x.avail < 0 ? 'var(--red)' : x.avail > 0 ? 'var(--green)' : undefined }}>{kg(x.avail)}</b></td>
                      <td className="nowrap small">{ne ? <span style={{ color: ne.eta < today ? 'var(--red)' : undefined }}>{fmtDate(ne.eta)} · {tan(ne.kg)} t</span> : x.lots.length ? 'Chưa có ETA' : '-'}</td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={hasPrice ? 8 : 7} style={{ background: '#fafbfd' }}>
                        <div className="grid2" style={{ marginBottom: 6 }}>
                          <div>
                            <div className="small"><b>Tồn từng kho</b></div>
                            {x.wh.size ? [...x.wh].sort((a, b) => b[1].kg - a[1].kg).map(([k, w]) => (
                              <div key={k} className="small">{k}: <b>{kg(w.kg)}</b> kg{w.locked ? <span style={{ color: 'var(--amber)' }}> (HTC {kg(w.locked)} kg)</span> : null}</div>
                            )) : <div className="small">Không có tồn</div>}
                          </div>
                          <div>
                            <div className="small"><b>Hàng đang về ({x.lots.length} lô)</b></div>
                            {x.lots.length ? x.lots.map((l, i) => (
                              <div key={i} className="small">
                                {l.eta ? <span style={{ color: l.eta < today ? 'var(--red)' : undefined }}>{fmtDate(l.eta)}</span> : 'Chưa có ETA'} · <b>{kg(l.kg)}</b> kg · {l.place || '-'} · {l.bct ? `BCT ${l.bct}` : l.po} · {l.sup}
                                {saleAdmin && l.buy ? <> · giá mua <b>{money(l.buy)}</b> {poMoney.unitLabel}</> : null}
                              </div>
                            )) : <div className="small">Không có hàng đang về</div>}
                          </div>
                        </div>
                        {x.sos.length > 0 && (
                          <div>
                            <div className="small"><b>Đơn chưa giao{salesOnly ? ' của bạn' : ''} ({x.sos.length})</b></div>
                            {x.sos.map((s, i) => (
                              <div key={i} className="small">{s.due ? fmtDate(s.due) : 'Chưa hẹn ngày'} · {s.id} · {s.party} · còn <b>{kg(s.left)}</b> kg{!salesOnly && s.sales ? ` · ${saleName.get(s.sales) || s.sales}` : ''}</div>
                            ))}
                          </div>
                        )}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
