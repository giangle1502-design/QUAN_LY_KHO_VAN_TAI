import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, doc, getDocs, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useOpCompany, useOrders } from '../../lib/hooks';
import { useOrderSecrets, viewOrder } from '../../lib/orderSecrets';
import { CompanyPicker } from '../../components/TripBits';
import { ORDER_STATUS, ORDER_TYPES, OPEN_STATUSES, createOrder, leftKg, lineDue, lineFrom, lineShip, lineTo, lineWh, orderTotals, returnableKg, setOrderState, stoRoute, summarizeLines, transitKg } from '../../lib/orders';
import { MOVE_TYPES } from '../../lib/stock';
import { STATUS_META, fmtTime, vnDate } from '../../lib/trips';
import { exportSheets, exportTemplate, readFirstSheet, toNumber, toYmd } from '../../lib/excel';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { Empty, ErrorBox, Modal } from '../../components/ui';
import Balance from './Balance';
import SOForm from './SOForm';
import { ColumnPicker } from '../../components/FormTools';
import { displayValue } from '../../components/FieldInput';
import { usePref } from '../../lib/prefs';
import { useCollection } from '../../lib/hooks';
import { useShortfall } from '../../lib/shortfall';

const t = (kg) => fmtNum((Number(kg) || 0) / 1000, 3);
const pct = (o) => { const x = orderTotals(o); return x.qty ? Math.min(100, (x.done / x.qty) * 100) : 0; };
// SO/PO: kinh doanh, kế toán. STO: thêm thủ kho (kho đi)
export const canManageOrders = (hasRole, type) => (type === 'STO' ? hasRole('kinh_doanh', 'ke_toan', 'thu_kho') : hasRole('kinh_doanh', 'ke_toan'));
const partyText = (o) => (o.type === 'STO' ? stoRoute(o) : o.partyName || o.partyCode);

// Cảnh báo đơn bán thiếu hàng KTC + DGC → xem tổng hợp để làm đề nghị giải chấp
function ShortBanner({ co }) {
  const { inMyWarehouses } = useApp();
  const rows = useShortfall('').rows.filter((r) => (!r.warehouse || inMyWarehouses(r.warehouse)) && (!co || r.company === co));
  if (!rows.length) return null;
  const kg = rows.reduce((s, r) => s + r.short, 0);
  const need = rows.reduce((s, r) => s + r.need, 0);
  const ids = [...new Set(rows.flatMap((r) => r.orders))];
  return (
    <div className="error-box" style={{ marginBottom: 10 }}>
      ⚠ Tồn KTC + DGC không đủ cho đơn bán: thiếu <b>{t(kg)} tấn</b> ở {rows.length} mã hàng ({rows.slice(0, 4).map((r) => `${r.item}${r.warehouse ? ' @' + r.warehouse : ''} ${t(r.short)}`).join('; ')}{rows.length > 4 ? '; …' : ''}).
      {need > 0.001 ? <> Còn cần giải chấp {t(need)} tấn.</> : <> Đã có đề nghị giải chấp chờ ngân hàng duyệt đủ phần thiếu.</>}{' '}
      <span className="small">Đơn: {ids.slice(0, 6).join(', ')}{ids.length > 6 ? '…' : ''}.</span>{' '}
      <Link to="/kho/giai-chap?tab=thieu"><b>Xem tổng hợp hàng thiếu →</b></Link>
    </div>
  );
}

// Nút lập phiếu kho theo đơn: SO/STO → phiếu xuất kho (thủ kho), PO/STO/SO trả về → phiếu nhập kho (quản trị lập, thủ kho nhận hàng)
export function MoveButtons({ o, sm }) {
  const { hasRole, isAdmin, inMyWarehouses } = useApp();
  if (!hasRole('thu_kho') || o.status === 'cancelled') return null;
  const x = orderTotals(o);
  // SO đã giao: hàng khách trả về (phiếu nhập kho theo SO)
  const ret = isAdmin && o.type === 'SO' && (o.lines || []).some((l) => returnableKg(l) > 0);
  if (!OPEN_STATUSES.concat(o.type === 'STO' ? ['closed'] : []).includes(o.status))
    return ret ? <Link className={'btn' + (sm ? ' sm' : '')} onClick={(e) => e.stopPropagation()} to={`/kho/in?order=${o.id}`}>↩ Nhập hàng trả về</Link> : null;
  const cls = 'btn' + (sm ? ' sm' : ' primary');
  // Có dòng còn phải làm ở kho mình phụ trách (dòng không ghi kho = kho nào cũng được)
  const mine = (mt, need) => (o.lines || []).some((l) => need(l) > 0 && (!lineWh(o, l, mt) || inMyWarehouses(lineWh(o, l, mt))));
  const stop = (e) => e.stopPropagation();
  return (
    <>
      {['SO', 'STO'].includes(o.type) && OPEN_STATUSES.includes(o.status) && x.left > 0 && mine('out', leftKg) &&
        <Link className={cls} onClick={stop} to={`/kho/out?order=${o.id}`}>📤 Lập phiếu xuất kho</Link>}
      {isAdmin && (o.type === 'PO' ? OPEN_STATUSES.includes(o.status) && x.left > 0 && mine('in', leftKg) : o.type === 'STO' && x.transit > 0 && mine('in', transitKg)) &&
        <Link className={cls} onClick={stop} to={`/kho/in?order=${o.id}`}>📥 Lập phiếu nhập kho</Link>}
      {ret && !sm && <Link className="btn" onClick={stop} to={`/kho/in?order=${o.id}`}>↩ Nhập hàng trả về</Link>}
    </>
  );
}

export function OrderStatus({ status }) {
  const m = ORDER_STATUS[status] || { label: status };
  return <span className={'badge ' + (m.tone || '')}>{m.label}</span>;
}
export function Progress({ o }) {
  const p = pct(o);
  return <span className="meter"><span className="bar"><div className={p >= 100 ? '' : 'warn'} style={{ width: `${p}%`, background: p >= 100 ? 'var(--green)' : undefined }} /></span>{fmtNum(p, 0)}%</span>;
}

// Trang Đơn hàng: tab Đơn bán (SO), Đơn mua (PO), Cân đối theo mã hàng
export default function Orders() {
  const [params, setParams] = useSearchParams();
  const tab = ['SO', 'PO', 'STO', 'can-doi'].includes(params.get('tab')) ? params.get('tab') : 'SO';
  return (
    <div>
      <div className="page-head">
        <h1>🧾 Đơn hàng</h1>
        <div className="seg">
          {[['SO', 'Đơn bán (SO)'], ['PO', 'Đơn mua (PO)'], ['STO', 'Chuyển kho (STO)'], ['can-doi', 'Cân đối theo mã hàng']].map(([k, l]) => (
            <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setParams({ tab: k })}>{l}</button>
          ))}
        </div>
      </div>
      {tab === 'can-doi' ? <Balance /> : <OrderList key={tab} type={tab} />}
    </div>
  );
}

function OrderList({ type }) {
  const meta = ORDER_TYPES[type];
  const { hasRole, inMyWarehouses, fieldsOf, seenFieldsOf, isAdmin, email } = useApp();
  const canManage = canManageOrders(hasRole, type);
  const sto = type === 'STO';
  const so = type === 'SO';
  const pl = so || type === 'PO'; // SO, PO: kho / ngày / TTHH theo từng dòng
  const fk = type.toLowerCase();
  // Trường được xem (bỏ trường riêng tư không được chỉ định), giá trị riêng tư + công thức gộp vào đơn
  const headSeen = useMemo(() => seenFieldsOf(`${fk}Head`, fieldsOf(`${fk}Line`)), [seenFieldsOf, fieldsOf, fk]);
  const lineSeen = useMemo(() => seenFieldsOf(`${fk}Line`, fieldsOf(`${fk}Head`)), [seenFieldsOf, fieldsOf, fk]);
  const customHead = headSeen.filter((f) => f.custom && !f.hidden);
  const customLine = lineSeen.filter((f) => f.custom && !f.hidden);
  const { rows: rawRows, error } = useOrders(type);
  const secMap = useOrderSecrets(type);
  const rows = useMemo(() => rawRows.map((o) => viewOrder(o, secMap, headSeen, lineSeen)), [rawRows, secMap, headSeen, lineSeen]);
  // Quản trị: giữ "sale phụ trách" trên giá trị riêng tư khớp với đơn (đổi sale / gán sale cho đơn cũ)
  useEffect(() => {
    if (!isAdmin || !secMap.docs?.length || !rawRows.length) return;
    const salesOf = new Map(rawRows.map((o) => [o.id, o.sales || '']));
    const stale = secMap.docs.filter((d) => salesOf.has(d.orderId) && (d.sales || '') !== salesOf.get(d.orderId));
    stale.forEach((d) => updateDoc(doc(db, 'orderSecrets', d._id), { sales: salesOf.get(d.orderId) }).catch(() => {}));
  }, [isAdmin, secMap, rawRows]);
  const [status, setStatus] = useState('opening');
  const [co, setCo] = useOpCompany();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null); // null | 'new' | order
  const [msg, setMsg] = useState('');
  const today = vnDate();

  const list = useMemo(() => {
    const f = norm(q);
    return rows
      .filter((o) => (o.lines || []).some((l) => [lineWh(o, l, 'out'), lineWh(o, l, 'in')].some((w) => !w || inMyWarehouses(w))))
      .filter((o) => !co || o.company === co)
      .filter((o) => (status === 'opening' ? OPEN_STATUSES.includes(o.status) : !status || o.status === status))
      .filter((o) => !f || norm([o.id, o.refNo, o.partyCode, o.partyName, o.fromWarehouse, o.toWarehouse, o.shipCode, ...(o.lines || []).flatMap((l) => [l.item, l.itemName, l.warehouse, l.fromWarehouse, l.toWarehouse, l.shipCode])].join(' ')).includes(f))
      .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [rows, status, q, inMyWarehouses, sto, co]);
  const sum = list.reduce((s, o) => { const x = orderTotals(o); return { qty: s.qty + x.qty, done: s.done + x.done, transit: s.transit + x.transit, left: s.left + (OPEN_STATUSES.includes(o.status) ? x.left : 0) }; }, { qty: 0, done: 0, left: 0, transit: 0 });
  const late = list.filter((o) => OPEN_STATUSES.includes(o.status) && o.dueDate && o.dueDate < today);
  const current = open && rows.find((o) => o.id === open);
  // Cột danh sách đơn: mỗi người dùng tự chọn cột muốn xem (⚙ Cột hiển thị)
  const uniqText = (o, f) => [...new Set((o.lines || []).map((l) => f(o, l)).filter(Boolean))].join(', ');
  const cols = [
    { key: 'id', label: 'Số đơn', locked: true, cls: 'mono nowrap', render: (o) => <>{o.id}{o.direct ? <span className="badge" title="Lập tự động khi nhập kho trực tiếp" style={{ marginLeft: 4 }}>trực tiếp</span> : null}</> },
    { key: 'company', label: 'Công ty', render: (o) => <b>{o.company}</b> },
    { key: 'refNo', label: 'Số Ecount', cls: 'mono', render: (o) => o.refNo, hideDefault: true },
    { key: 'date', label: 'Ngày tạo đơn', cls: 'nowrap', render: (o) => fmtDate(o.date) },
    ...(sto ? [] : [{ key: 'party', label: meta.partyLabel, cls: 'nowrap', render: (o) => partyText(o) }, { key: 'sales', label: 'Sale phụ trách', cls: 'small', render: (o) => o.sales || '' }]),
    ...customHead.map((f) => ({ key: f.key, label: f.label, render: (o) => displayValue(f, o[f.key]) })),
    ...(sto ? [{ key: 'from', label: 'Kho xuất', render: (o) => uniqText(o, lineFrom) }, { key: 'to', label: 'Kho nhập', render: (o) => uniqText(o, lineTo) }]
      : [{ key: 'warehouse', label: so ? 'Kho xuất' : 'Kho nhập', render: (o) => uniqText(o, lineWh) }]),
    ...(so ? [{ key: 'ship', label: 'Mã giao', render: (o) => uniqText(o, lineShip) }] : []),
    { key: 'items', label: 'Mặt hàng', render: (o) => [...new Set(o.lines.map((l) => l.item))].join(', ') },
    { key: 'qty', label: 'Đặt (tấn)', num: true, render: (o, c) => t(c.x.qty) },
    { key: 'done', label: meta.done, num: true, render: (o, c) => t(c.x.done) },
    ...(sto ? [{ key: 'transit', label: meta.transit, num: true, render: (o, c) => t(c.x.transit) }] : []),
    { key: 'left', label: meta.left, num: true, render: (o, c) => <b>{OPEN_STATUSES.includes(o.status) ? t(c.x.left) : '–'}</b> },
    { key: 'progress', label: 'Tiến độ', render: (o) => <div style={{ width: 130 }}><Progress o={o} /></div> },
    { key: 'due', label: so ? 'Ngày giao (sớm nhất)' : pl ? 'ETA (sớm nhất)' : 'Ngày chuyển (sớm nhất)', cls: 'nowrap', style: (o, c) => (c.isLate ? { color: 'var(--red)', fontWeight: 600 } : undefined), render: (o, c) => <>{fmtDate(o.dueDate)}{c.isLate ? ' ⚠' : ''}</> },
    { key: 'status', label: 'Trạng thái', locked: true, render: (o) => <OrderStatus status={o.status} /> },
  ];
  const [hidden, setHidden] = usePref(`orderListHidden:${type}`, cols.filter((c) => c.hideDefault).map((c) => c.key));
  const shownCols = cols.filter((c) => c.locked || !hidden.includes(c.key));

  // Đơn cũ chưa có Sale phụ trách: gán = người lập đơn nếu người đó là kinh doanh
  const users = useCollection(isAdmin && !sto ? 'users' : '').rows;
  const noSales = rawRows.filter((o) => !o.sales && users.some((u) => u.email === o.createdBy && u.role === 'kinh_doanh'));
  const fillSales = async () => {
    if (!window.confirm(`Gán Sale phụ trách = người lập đơn cho ${noSales.length} đơn chưa có sale?`)) return;
    const at = new Date().toISOString();
    try {
      for (const o of noSales) await updateDoc(doc(db, 'orders', o.id), { sales: o.createdBy, updatedAt: at, updatedBy: email });
      setMsg(`Đã gán sale cho ${noSales.length} đơn.`);
    } catch (e) { setMsg(`Không gán được: ${e.message}`); }
  };

  const exportExcel = () => {
    const out = [];
    list.forEach((o) => o.lines.forEach((l) => out.push({
      'Số đơn': o.id, 'Công ty': o.company || '', 'Ngày đơn': o.date,
      ...(sto ? { 'Kho xuất': lineFrom(o, l), 'Kho nhập': lineTo(o, l) } : { [`Mã ${meta.partyLabel}`]: o.partyCode, [`Tên ${meta.partyLabel}`]: o.partyName, 'Sale phụ trách': o.sales || '' }),
      ...Object.fromEntries(customHead.map((f) => [f.label, displayValue(f, o[f.key], true)])),
      ...(so ? { 'Mã giao hàng': lineShip(o, l) } : {}), TTHH: l.goodsStatus || '', ...(sto ? {} : { Kho: lineWh(o, l) }), [meta.due]: lineDue(o, l),
      ...Object.fromEntries(customLine.map((f) => [f.label, displayValue(f, l[f.key], true)])),
      'Mã hàng': l.item, 'Tên hàng': l.itemName, 'Đặt (tấn)': l.qtyKg / 1000, [`${meta.done} (tấn)`]: (l.doneKg || 0) / 1000,
      ...(sto ? { 'Đang đi đường (tấn)': transitKg(l) / 1000, 'Đã nhận (tấn)': (l.receivedKg || 0) / 1000 } : {}),
      [`${meta.left} (tấn)`]: OPEN_STATUSES.includes(o.status) ? leftKg(l) / 1000 : 0, 'Trạng thái': ORDER_STATUS[o.status]?.label, 'Ghi chú': o.note,
    })));
    exportSheets(`${type}_${today}`, { [meta.label]: out.length ? out : [{ 'Số đơn': '' }] });
  };

  return (
    <div>
      <div className="stats">
        <div className="stat"><div className="stat-label">Số đơn đang hiển thị</div><div className="stat-value">{list.length}</div></div>
        <div className="stat"><div className="stat-label">Tổng đặt</div><div className="stat-value">{t(sum.qty)} tấn</div></div>
        <div className="stat green"><div className="stat-label">{meta.done}</div><div className="stat-value">{t(sum.done)} tấn</div></div>
        {sto && <div className="stat"><div className="stat-label">{meta.transit}</div><div className="stat-value">{t(sum.transit)} tấn</div></div>}
        <div className="stat amber"><div className="stat-label">{meta.left}</div><div className="stat-value">{t(sum.left)} tấn</div></div>
        <div className="stat red"><div className="stat-label">{type === 'SO' ? 'Quá hạn giao' : type === 'PO' ? 'Quá ngày hàng về' : 'Quá ngày chuyển'}</div><div className="stat-value">{late.length} đơn</div></div>
      </div>
      <div className="filters">
        <CompanyPicker value={co} onChange={setCo} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="opening">Đang mở (chưa xong)</option>
          <option value="">Tất cả trạng thái</option>
          {Object.entries(ORDER_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <input type="search" placeholder={`Tìm số đơn, ${meta.partyLabel.toLowerCase()}, mã hàng…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="actions" style={{ marginLeft: 'auto' }}>
          <ColumnPicker cols={cols.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))} hidden={hidden} setHidden={setHidden} />
          <button className="btn" onClick={exportExcel}>⬇ Excel</button>
          {canManage && !sto && <ImportOrders type={type} existing={rows} onDone={setMsg} />}
          {isAdmin && noSales.length > 0 && <button className="btn" onClick={fillSales} title="Sale chỉ thấy đơn có Sale phụ trách là mình">Gán sale cho {noSales.length} đơn cũ</button>}
          {canManage && <button className="btn primary" onClick={() => setEdit('new')}>+ Lập {meta.short}</button>}
        </div>
      </div>
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      {type === 'SO' && <ShortBanner co={co} />}
      <ErrorBox error={error} />
      <div className="table-wrap">
        {!list.length ? <Empty /> : (
          <table>
            <thead><tr>{shownCols.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}<th></th></tr></thead>
            <tbody>
              {list.map((o) => {
                const ctx = { x: orderTotals(o), isLate: OPEN_STATUSES.includes(o.status) && o.dueDate && o.dueDate < today };
                return (
                  <tr key={o.id} onClick={() => setOpen(o.id)} style={{ cursor: 'pointer', opacity: ['closed', 'cancelled'].includes(o.status) ? 0.6 : 1 }}>
                    {shownCols.map((c) => <td key={c.key} className={(c.num ? 'num ' : '') + (c.cls || '')} style={c.style?.(o, ctx)}>{c.render(o, ctx)}</td>)}
                    <td className="nowrap"><MoveButtons o={o} sm /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {current && !edit && <OrderDetail o={current} onClose={() => setOpen(null)} onEdit={() => setEdit(current)} />}
      {edit && <SOForm type={type} order={edit === 'new' ? null : edit} onClose={(id) => { setEdit(null); if (id) setOpen(id); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function OrderDetail({ o, onClose, onEdit }) {
  const meta = ORDER_TYPES[o.type];
  const { hasRole, isAdmin, email, name, fieldsOf, seenFieldsOf } = useApp();
  const [assign, setAssign] = useState(false);
  const so = o.type === 'SO';
  const fk = o.type.toLowerCase();
  const headCustom = seenFieldsOf(`${fk}Head`, fieldsOf(`${fk}Line`)).filter((f) => f.custom && !f.hidden && o[f.key] !== '' && o[f.key] != null);
  const lineCustom = seenFieldsOf(`${fk}Line`, fieldsOf(`${fk}Head`)).filter((f) => f.custom && !f.hidden);
  const canManage = canManageOrders(hasRole, o.type);
  const sto = o.type === 'STO';
  const [moves, setMoves] = useState([]);
  const [trips, setTrips] = useState([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => onSnapshot(query(collection(db, 'movements'), where('orderId', '==', o.id)),
    (s) => setMoves(s.docs.map((d) => d.data()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))), () => setMoves([])), [o.id]);
  useEffect(() => onSnapshot(query(collection(db, 'trips'), where('orderIds', 'array-contains', o.id)),
    (s) => setTrips(s.docs.map((d) => ({ ...d.data(), id: d.id }))), () => setTrips([])), [o.id]);
  const x = orderTotals(o);
  const isOpen = OPEN_STATUSES.includes(o.status);
  const hasRet = (o.lines || []).some((l) => Number(l.returnedKg) > 0);
  const act = async (action) => {
    setErr(''); setBusy(true);
    try { await setOrderState(o.id, action, reason.trim(), { email, name }); setReason(''); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const moveType = meta.moveType;

  return (
    <Modal title={`${meta.label} ${o.id}`} onClose={onClose} wide>
      <p>
        <OrderStatus status={o.status} /> {o.refNo ? <> · Số Ecount <b className="mono">{o.refNo}</b></> : null} · Ngày {fmtDate(o.date)}
        {' · '}{meta.partyLabel}: <b>{sto ? partyText(o) : `${o.partyCode} ${o.partyName}`}</b>{o.sales ? <> · Sale: <b>{o.sales}</b></> : null}
        {headCustom.map((f) => <span key={f.key}> · {f.label}: <b>{displayValue(f, o[f.key])}</b></span>)}
        {Number(o.tolerancePct) ? ` · Dung sai ${o.tolerancePct}%` : ''}
      </p>
      {o.direct && <p className="small">Đơn mua lập tự động khi <b>nhập kho trực tiếp</b> (hàng về không có PO trước).</p>}
      {o.note && <p className="small">Ghi chú: {o.note}</p>}
      {o.closeReason && <p className="small">Lý do {o.status === 'cancelled' ? 'hủy' : 'đóng'}: {o.closeReason}</p>}
      <div className="stats">
        <div className="stat"><div className="stat-label">Đặt</div><div className="stat-value">{t(x.qty)} tấn</div></div>
        <div className="stat green"><div className="stat-label">{meta.done}</div><div className="stat-value">{t(x.done)} tấn</div></div>
        {sto && <div className="stat"><div className="stat-label">{meta.transit}</div><div className="stat-value">{t(x.transit)} tấn</div></div>}
        {sto && <div className="stat green"><div className="stat-label">{meta.received}</div><div className="stat-value">{t(x.received)} tấn</div></div>}
        <div className="stat amber"><div className="stat-label">{meta.left}</div><div className="stat-value">{isOpen ? t(x.left) : '0'} tấn</div>{!isOpen && x.left > 0 && <div className="stat-sub">{t(x.left)} tấn không thực hiện ({ORDER_STATUS[o.status].label.toLowerCase()})</div>}</div>
      </div>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>#</th><th>{meta.due}</th>{sto ? <><th>Kho xuất</th><th>Kho nhập</th></> : <th>{so ? 'Kho xuất' : 'Kho nhập'}</th>}<th>Mã hàng</th><th>Tên hàng</th>{so && <th>Mã giao</th>}<th>TTHH</th>{lineCustom.map((f) => <th key={f.key}>{f.label}</th>)}<th className="num">Đặt (tấn)</th><th className="num">{meta.done}</th>{hasRet && <th className="num">Khách trả về</th>}
            {sto && <><th className="num">{meta.transit}</th><th className="num">{meta.received}</th></>}<th className="num">{meta.left}</th>{o.type !== 'PO' && <th>Vận tải</th>}<th>Ghi chú</th></tr></thead>
          <tbody>{o.lines.map((l) => (
            <tr key={l.no}><td>{l.no}</td><td className="nowrap">{fmtDate(lineDue(o, l))}</td>{sto ? <><td>{lineFrom(o, l)}</td><td>{lineTo(o, l)}</td></> : <td>{lineWh(o, l) || 'Kho nào cũng được'}</td>}<td>{l.item}</td><td>{l.itemName}</td>
              {so && <td>{lineShip(o, l)}</td>}<td>{l.goodsStatus || (so ? 'KTC/DGC' : '')}</td>{lineCustom.map((f) => <td key={f.key}>{displayValue(f, l[f.key])}</td>)}<td className="num">{t(l.qtyKg)}</td><td className="num">{t(l.doneKg)}</td>{hasRet && <td className="num">{t(l.returnedKg)}</td>}
              {sto && <><td className="num">{t(transitKg(l))}</td><td className="num">{t(l.receivedKg)}</td></>}
              <td className="num"><b>{isOpen ? t(leftKg(l)) : '–'}</b></td>{o.type !== 'PO' && <td>{l.carrier || <span className="small">–</span>}</td>}<td className="small">{l.note}</td></tr>
          ))}</tbody>
        </table>
      </div>

      <div className="form-actions" style={{ justifyContent: 'flex-start', marginBottom: 8 }}><MoveButtons o={o} />
        {isAdmin && o.type !== 'PO' && isOpen && <button type="button" className="btn" onClick={() => setAssign(true)}>🚛 Giao đơn vị vận tải</button>}</div>
      {assign && <AssignCarrier o={o} onClose={() => setAssign(false)} />}
      <div className="section-head">Phiếu {sto || hasRet ? 'xuất / nhập kho' : MOVE_TYPES[moveType].label.toLowerCase()} theo đơn ({moves.length})</div>
      {!moves.length ? <Empty text={`Chưa có phiếu ${sto ? 'xuất / nhập kho' : MOVE_TYPES[moveType].label.toLowerCase()} nào gắn đơn này.`} /> : (
        <table style={{ marginBottom: 12 }}><tbody>
          {moves.map((m) => (
            <tr key={m.id} style={{ opacity: m.status === 'cancelled' ? 0.5 : 1 }}>
              <td className="mono"><Link to={`/kho/phieu/${m.id}/in`} target="_blank">{m.id}</Link></td><td>{MOVE_TYPES[m.type]?.icon} {MOVE_TYPES[m.type]?.label}</td><td>{fmtDate(m.date)}</td><td>Kho {m.warehouse}</td>
              <td className="mono">{m.tripId}</td>
              <td className="num">{t(m.lines.reduce((s, l) => s + Math.abs(Number(l.kg) || 0), 0))} tấn</td>
              <td>{m.status === 'cancelled' ? <span className="badge red">Đã hủy</span>
                : m.type === 'in' ? <Link className="btn sm" to={`/kho/phieu/${m.id}/nhan`} target="_blank">🏷️ In nhãn</Link> : ''}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <div className="section-head">Chuyến xe đăng ký theo đơn ({trips.length})</div>
      {!trips.length ? <Empty text="Chưa có chuyến xe." /> : (
        <table style={{ marginBottom: 12 }}><tbody>
          {trips.map((tr) => (
            <tr key={tr.id}><td className="mono">{tr.id}</td><td><span className="plate">{tr.plate}</span></td><td>{tr.warehouse}</td>
              <td>{fmtDate(tr.arrivalDate)}</td>
              <td className="num">{fmtNum(tr.lines.filter((l) => l.orderId === o.id).reduce((s, l) => s + (Number(l.payload) || 0), 0), 3)} tấn dự kiến</td>
              <td><span className={'badge ' + (STATUS_META[tr.status]?.tone || '')}>{STATUS_META[tr.status]?.label}</span></td></tr>
          ))}
        </tbody></table>
      )}

      <div className="section-head">Lịch sử</div>
      <table><tbody>{(o.history || []).map((hh, i) => <tr key={i}><td className="nowrap">{fmtTime(hh.at)}</td><td>{hh.action}</td><td className="small">{hh.byName || hh.by}</td></tr>)}</tbody></table>

      <ErrorBox error={err} />
      {canManage && (
        <div className="form-actions" style={{ flexWrap: 'wrap' }}>
          {isOpen && <button className="btn" onClick={onEdit}>✏️ Sửa đơn</button>}
          {isOpen && <input placeholder="Lý do đóng / hủy" value={reason} onChange={(e) => setReason(e.target.value)} />}
          {isOpen && <button className="btn" disabled={!reason.trim() || busy} onClick={() => act('close')} title="Không giao/nhận tiếp phần còn lại">Đóng đơn</button>}
          {isOpen && x.done === 0 && <button className="btn danger" disabled={!reason.trim() || busy} onClick={() => act('cancel')}>Hủy đơn</button>}
          {['closed', 'cancelled'].includes(o.status) && <button className="btn" disabled={busy} onClick={() => act('reopen')}>Mở lại đơn</button>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Nhập đơn từ Excel (xuất từ Ecount): mỗi dòng = 1 mặt hàng, gộp theo Số đơn Ecount
const HEAD = {
  company: ['cong ty', 'ma cong ty', 'cong ty ban', 'cong ty mua'],
  refNo: ['so don ecount', 'so don', 'so chung tu', 'so hop dong'],
  date: ['ngay don', 'ngay', 'ngay chung tu'],
  partyCode: ['ma kh/ncc', 'ma khach hang', 'ma nha cung cap', 'ma doi tac'],
  partyName: ['ten kh/ncc', 'ten khach hang', 'ten nha cung cap', 'ten doi tac'],
  shipCode: ['ma giao hang', 'shipto'],
  warehouse: ['kho', 'ma kho'],
  dueDate: ['han giao/eta', 'han giao', 'eta', 'ngay hang ve', 'ngay giao'],
  item: ['ma hang', 'ma san pham'],
  qtyT: ['so luong (tan)', 'so luong tan', 'tan'],
  qtyKg: ['so luong (kg)', 'kg'],
  tolerancePct: ['dung sai (%)', 'dung sai'],
  note: ['ghi chu'],
};
const TEMPLATE = ['Công ty', 'Số đơn Ecount', 'Ngày đơn', 'Mã KH/NCC', 'Tên KH/NCC', 'Mã giao hàng', 'Kho', 'Hạn giao/ETA', 'Mã hàng', 'Số lượng (tấn)', 'Dung sai (%)', 'Ghi chú'];

function ImportOrders({ type, existing, onDone }) {
  const { email, name } = useApp();
  const ref = useRef();
  const [busy, setBusy] = useState(false);
  const run = async (file) => {
    setBusy(true);
    const errs = [];
    try {
      const [items, parties] = await Promise.all([getDocs(collection(db, 'items')), getDocs(collection(db, ORDER_TYPES[type].party))]);
      const itemMap = new Map(items.docs.map((d) => [d.data().code, d.data()]));
      const partyMap = new Map(parties.docs.map((d) => [d.data().code, d.data()]));
      const rows = await readFirstSheet(file);
      const heads = (rows[0] || []).map((x) => norm(x));
      const col = (k) => heads.findIndex((x) => HEAD[k].includes(x));
      const c = Object.fromEntries(Object.keys(HEAD).map((k) => [k, col(k)]));
      if (c.refNo < 0 || c.item < 0 || (c.qtyT < 0 && c.qtyKg < 0)) throw new Error('File cần có cột Số đơn Ecount, Mã hàng, Số lượng (tấn). Bấm "Tải file mẫu".');
      const v = (r, k) => (c[k] >= 0 ? r[c[k]] : '');
      const groups = new Map();
      rows.slice(1).forEach((r, i) => {
        const refNo = String(v(r, 'refNo') ?? '').trim();
        if (!refNo && !String(v(r, 'item') ?? '').trim()) return;
        const no = `Dòng ${i + 2}: `;
        const item = String(v(r, 'item') ?? '').trim();
        const kg = c.qtyT >= 0 ? (toNumber(v(r, 'qtyT')) || 0) * 1000 : toNumber(v(r, 'qtyKg')) || 0;
        if (!refNo) return errs.push(no + 'thiếu số đơn.');
        if (!itemMap.has(item)) return errs.push(no + `mã hàng "${item}" chưa có trong danh mục.`);
        if (!(kg > 0)) return errs.push(no + 'thiếu số lượng.');
        if (!groups.has(refNo)) {
          const pc = String(v(r, 'partyCode') ?? '').trim();
          groups.set(refNo, {
            type, company: String(v(r, 'company') ?? '').trim().toUpperCase(), refNo, date: toYmd(v(r, 'date')) || vnDate(), partyCode: pc, partyName: String(v(r, 'partyName') || partyMap.get(pc)?.name || '').trim(),
            shipCode: type === 'SO' ? String(v(r, 'shipCode') ?? '').trim() : '', warehouse: String(v(r, 'warehouse') ?? '').trim(),
            dueDate: toYmd(v(r, 'dueDate')), tolerancePct: toNumber(v(r, 'tolerancePct')) || 0, note: String(v(r, 'note') ?? '').trim(), lines: [],
          });
        }
        // SO: kho, mã giao, ngày giao theo từng dòng (1 đơn nhiều kho / nhiều điểm giao)
        groups.get(refNo).lines.push({ item, itemName: itemMap.get(item).name, qtyKg: Math.round(kg * 1000) / 1000, note: '',
          ...(type !== 'STO' ? { warehouse: String(v(r, 'warehouse') ?? '').trim(), shipCode: type === 'SO' ? String(v(r, 'shipCode') ?? '').trim() : '', dueDate: toYmd(v(r, 'dueDate')) || '', goodsStatus: '' } : {}) });
      });
      const have = new Set(existing.filter((o) => o.status !== 'cancelled').map((o) => o.refNo));
      let made = 0;
      let skipped = 0;
      for (const g of groups.values()) {
        if (have.has(g.refNo)) { skipped++; continue; }
        if (!g.partyCode && !g.partyName) { errs.push(`Đơn ${g.refNo}: thiếu mã/tên đối tác.`); continue; }
        if (!g.company) { errs.push(`Đơn ${g.refNo}: thiếu công ty.`); continue; }
        if (type !== 'STO') Object.assign(g, summarizeLines(g.lines));
        await createOrder(g, { email, name });
        made++;
      }
      onDone(`Đã tạo ${made} đơn${skipped ? `, bỏ qua ${skipped} đơn đã có (trùng số Ecount)` : ''}.${errs.length ? ` Lỗi: ${errs.slice(0, 8).join(' ')}${errs.length > 8 ? ` … và ${errs.length - 8} lỗi khác` : ''}` : ''}`);
    } catch (e) {
      onDone(`Không nhập được: ${e.message}`);
    }
    setBusy(false);
    ref.current.value = '';
  };
  return (
    <>
      <button className="btn" onClick={() => exportTemplate(`Mau_${type}`, TEMPLATE)}>Tải file mẫu</button>
      <button className="btn" disabled={busy} onClick={() => ref.current.click()}>{busy ? 'Đang nhập…' : '⬆ Nhập Excel'}</button>
      <input ref={ref} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files[0] && run(e.target.files[0])} />
    </>
  );
}

// Admin giao đơn vị vận tải cho từng dòng đơn (SO / STO): đơn vị đó thấy đơn và chia xe
function AssignCarrier({ o: view, onClose }) {
  const o = view._raw || view;
  const { email, name } = useApp();
  const carriers = useCollection('carriers').rows.filter((c) => c.active !== false);
  const [map, setMap] = useState(() => Object.fromEntries(o.lines.map((l) => [l.no, l.carrier || ''])));
  const [all, setAll] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    const lines = o.lines.map((l) => ({ ...l, carrier: map[l.no] || '' }));
    const at = new Date().toISOString();
    const changed = lines.filter((l, i) => (o.lines[i].carrier || '') !== l.carrier).map((l) => `dòng ${l.no} → ${l.carrier || 'bỏ'}`);
    try {
      await updateDoc(doc(db, 'orders', o.id), { lines, carriers: [...new Set(lines.map((l) => l.carrier).filter(Boolean))], updatedAt: at, updatedBy: email,
        history: [...(o.history || []), { at, by: email, byName: name, action: `Giao vận tải: ${changed.join(', ') || 'không đổi'}` }] });
      onClose();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const opts = <>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}{c.kind === 'Nội bộ' ? ' (nội bộ)' : ''}</option>)}</>;
  return (
    <Modal title={`Giao đơn vị vận tải · ${o.id}`} onClose={onClose} wide>
      <p className="hint">Đơn vị vận tải được giao sẽ thấy các dòng này ở mục <b>Vận chuyển</b> và tự chia xe theo tải trọng.</p>
      <div className="filters">Áp cho tất cả dòng:
        <select value={all} onChange={(e) => { setAll(e.target.value); setMap(Object.fromEntries(o.lines.map((l) => [l.no, e.target.value]))); }}><option value="">-- Chọn --</option>{opts}</select></div>
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Kho xuất</th><th>Mã hàng</th><th>Giao đến</th><th className="num">Còn lại (tấn)</th><th>Đơn vị vận tải</th></tr></thead>
        <tbody>{o.lines.map((l) => (
          <tr key={l.no}><td>{l.no}</td><td>{lineWh(o, l, 'out')}</td><td>{l.item} {l.itemName}</td><td>{o.type === 'STO' ? `Kho ${lineTo(o, l)}` : lineShip(o, l) || o.partyName}</td>
            <td className="num">{t(leftKg(l))}</td>
            <td><select value={map[l.no]} onChange={(e) => setMap((m) => ({ ...m, [l.no]: e.target.value }))}><option value="">-- Chưa giao --</option>{opts}</select></td></tr>
        ))}</tbody>
      </table></div>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={onClose}>Thôi</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu'}</button></div>
    </Modal>
  );
}
