import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpCompany, useOrders } from '../../lib/hooks';
import { CompanyPicker } from '../../components/TripBits';
import { ORDER_STATUS, ORDER_TYPES, OPEN_STATUSES, createOrder, leftKg, orderTotals, saveOrder, setOrderState, transitKg } from '../../lib/orders';
import { MOVE_TYPES } from '../../lib/stock';
import { STATUS_META, fmtTime, vnDate } from '../../lib/trips';
import { exportSheets, exportTemplate, readFirstSheet, toNumber, toYmd } from '../../lib/excel';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import Balance from './Balance';

const t = (kg) => fmtNum((Number(kg) || 0) / 1000, 3);
const pct = (o) => { const x = orderTotals(o); return x.qty ? Math.min(100, (x.done / x.qty) * 100) : 0; };
// SO/PO: kinh doanh, kế toán. STO: thêm thủ kho (kho đi)
export const canManageOrders = (hasRole, type) => (type === 'STO' ? hasRole('kinh_doanh', 'ke_toan', 'thu_kho') : hasRole('kinh_doanh', 'ke_toan'));
const partyText = (o) => (o.type === 'STO' ? `${o.fromWarehouse} → ${o.toWarehouse}` : o.partyName || o.partyCode);

// Nút lập phiếu kho theo đơn: SO/STO → phiếu xuất kho, PO/STO → phiếu nhập kho
export function MoveButtons({ o, sm }) {
  const { hasRole, inMyWarehouses } = useApp();
  if (!hasRole('thu_kho') || !OPEN_STATUSES.concat(o.type === 'STO' ? ['closed'] : []).includes(o.status)) return null;
  const x = orderTotals(o);
  const cls = 'btn' + (sm ? ' sm' : ' primary');
  const outWh = o.type === 'STO' ? o.fromWarehouse : o.warehouse;
  const inWh = o.type === 'STO' ? o.toWarehouse : o.warehouse;
  const stop = (e) => e.stopPropagation();
  return (
    <>
      {['SO', 'STO'].includes(o.type) && OPEN_STATUSES.includes(o.status) && x.left > 0 && (!outWh || inMyWarehouses(outWh)) &&
        <Link className={cls} onClick={stop} to={`/kho/out?order=${o.id}`}>📤 Lập phiếu xuất kho</Link>}
      {(o.type === 'PO' ? OPEN_STATUSES.includes(o.status) && x.left > 0 : o.type === 'STO' && x.transit > 0) && (!inWh || inMyWarehouses(inWh)) &&
        <Link className={cls} onClick={stop} to={`/kho/in?order=${o.id}`}>📥 Lập phiếu nhập kho</Link>}
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
  const { hasRole, inMyWarehouses } = useApp();
  const canManage = canManageOrders(hasRole, type);
  const sto = type === 'STO';
  const { rows, error } = useOrders(type);
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
      .filter((o) => (sto ? inMyWarehouses(o.fromWarehouse) || inMyWarehouses(o.toWarehouse) : !o.warehouse || inMyWarehouses(o.warehouse)))
      .filter((o) => !co || o.company === co)
      .filter((o) => (status === 'opening' ? OPEN_STATUSES.includes(o.status) : !status || o.status === status))
      .filter((o) => !f || norm([o.id, o.refNo, o.partyCode, o.partyName, o.fromWarehouse, o.toWarehouse, o.shipCode, ...(o.lines || []).flatMap((l) => [l.item, l.itemName])].join(' ')).includes(f))
      .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [rows, status, q, inMyWarehouses, sto, co]);
  const sum = list.reduce((s, o) => { const x = orderTotals(o); return { qty: s.qty + x.qty, done: s.done + x.done, transit: s.transit + x.transit, left: s.left + (OPEN_STATUSES.includes(o.status) ? x.left : 0) }; }, { qty: 0, done: 0, left: 0, transit: 0 });
  const late = list.filter((o) => OPEN_STATUSES.includes(o.status) && o.dueDate && o.dueDate < today);
  const current = open && rows.find((o) => o.id === open);

  const exportExcel = () => {
    const out = [];
    list.forEach((o) => o.lines.forEach((l) => out.push({
      'Số đơn': o.id, 'Công ty': o.company || '', 'Số đơn Ecount': o.refNo, 'Ngày đơn': o.date,
      ...(sto ? { 'Kho đi': o.fromWarehouse, 'Kho đến': o.toWarehouse } : { [`Mã ${meta.partyLabel}`]: o.partyCode, [`Tên ${meta.partyLabel}`]: o.partyName }),
      ...(type === 'SO' ? { 'Mã giao hàng': o.shipCode } : {}), Kho: o.warehouse, [meta.due]: o.dueDate,
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
          <button className="btn" onClick={exportExcel}>⬇ Excel</button>
          {canManage && !sto && <ImportOrders type={type} existing={rows} onDone={setMsg} />}
          {canManage && <button className="btn primary" onClick={() => setEdit('new')}>+ Lập {meta.short}</button>}
        </div>
      </div>
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <ErrorBox error={error} />
      <div className="table-wrap">
        {!list.length ? <Empty /> : (
          <table>
            <thead><tr><th>Số đơn</th><th>Công ty</th><th>Số Ecount</th><th>Ngày</th><th>{meta.partyLabel}</th><th>Mặt hàng</th>
              <th className="num">Đặt (tấn)</th><th className="num">{meta.done}</th>{sto && <th className="num">{meta.transit}</th>}<th className="num">{meta.left}</th><th>Tiến độ</th><th>{meta.due}</th><th>Trạng thái</th><th></th></tr></thead>
            <tbody>
              {list.map((o) => {
                const x = orderTotals(o);
                const isLate = OPEN_STATUSES.includes(o.status) && o.dueDate && o.dueDate < today;
                return (
                  <tr key={o.id} onClick={() => setOpen(o.id)} style={{ cursor: 'pointer', opacity: ['closed', 'cancelled'].includes(o.status) ? 0.6 : 1 }}>
                    <td className="mono nowrap">{o.id}</td><td><b>{o.company}</b></td><td className="mono">{o.refNo}</td><td className="nowrap">{fmtDate(o.date)}</td>
                    <td className="nowrap">{partyText(o)}{o.shipCode ? <small className="small"> · {o.shipCode}</small> : null}</td>
                    <td>{[...new Set(o.lines.map((l) => l.item))].join(', ')}</td>
                    <td className="num">{t(x.qty)}</td><td className="num">{t(x.done)}</td>{sto && <td className="num">{t(x.transit)}</td>}
                    <td className="num"><b>{OPEN_STATUSES.includes(o.status) ? t(x.left) : '–'}</b></td>
                    <td style={{ width: 130 }}><Progress o={o} /></td>
                    <td className="nowrap" style={isLate ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{fmtDate(o.dueDate)}{isLate ? ' ⚠' : ''}</td>
                    <td><OrderStatus status={o.status} /></td>
                    <td className="nowrap"><MoveButtons o={o} sm /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {current && !edit && <OrderDetail o={current} onClose={() => setOpen(null)} onEdit={() => setEdit(current)} />}
      {edit && <OrderForm type={type} order={edit === 'new' ? null : edit} onClose={(id) => { setEdit(null); if (id) setOpen(id); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
const emptyLine = () => ({ item: '', itemName: '', qtyT: '', note: '' });

function OrderForm({ type, order, onClose }) {
  const meta = ORDER_TYPES[type];
  const { email, name } = useApp();
  const warehouses = useMyWarehouses();
  const parties = useCollection(meta.party || null).rows;
  const allWarehouses = useCollection('warehouses').rows.filter((w) => w.active !== false).sort((a, b) => a.code.localeCompare(b.code));
  const sto = type === 'STO';
  const shipto = useCollection('shipto').rows;
  const items = useCollection('items').rows;
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const [defaultCo] = useOpCompany();
  const [h, setH] = useState(() => order
    ? { company: order.company || '', refNo: order.refNo || '', date: order.date || '', partyCode: order.partyCode || '', partyName: order.partyName || '', shipCode: order.shipCode || '',
      warehouse: order.warehouse || '', fromWarehouse: order.fromWarehouse || '', toWarehouse: order.toWarehouse || '', dueDate: order.dueDate || '', tolerancePct: order.tolerancePct ?? '', note: order.note || '' }
    : { company: defaultCo, refNo: '', date: vnDate(), partyCode: '', partyName: '', shipCode: '', warehouse: '', fromWarehouse: '', toWarehouse: '', dueDate: '', tolerancePct: '', note: '' });
  const [lines, setLines] = useState(() => order
    ? order.lines.map((l) => ({ no: l.no, item: l.item, itemName: l.itemName, qtyT: l.qtyKg / 1000, doneKg: l.doneKg || 0, note: l.note || '' }))
    : [emptyLine()]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setH((x) => ({ ...x, [k]: v }));
  const setLine = (i, p) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (sto && (!h.fromWarehouse || !h.toWarehouse)) return setErr('Chọn kho đi và kho đến.');
    if (sto && h.fromWarehouse === h.toWarehouse) return setErr('Kho đến phải khác kho đi.');
    if (!sto && !h.partyCode.trim() && !h.partyName.trim()) return setErr(`Chọn ${meta.partyLabel.toLowerCase()}.`);
    if (!h.company) return setErr('Chọn công ty của đơn.');
    if (!h.date) return setErr('Nhập ngày đơn.');
    const out = [];
    for (const [i, l] of lines.entries()) {
      if (!l.item || !itemMap.has(l.item)) return setErr(`Dòng ${i + 1}: chọn mã hàng có trong danh mục.`);
      const kg = Math.round(Number(l.qtyT) * 1000 * 1000) / 1000;
      if (!(kg > 0)) return setErr(`Dòng ${i + 1}: nhập số lượng (tấn).`);
      out.push({ ...(l.no != null ? { no: l.no } : {}), item: l.item, itemName: itemMap.get(l.item).name, qtyKg: kg, note: l.note.trim() });
    }
    const { fromWarehouse, toWarehouse, ...rest } = h;
    const whName = (c) => allWarehouses.find((w) => w.code === c)?.name || c;
    const data = { ...rest, ...(sto ? { fromWarehouse, toWarehouse, warehouse: '', partyCode: toWarehouse, partyName: `Chuyển đến kho ${whName(toWarehouse)}`, shipCode: '' } : {}),
      type, refNo: h.refNo.trim(), note: h.note.trim(), ...(sto ? {} : { partyCode: h.partyCode.trim(), partyName: h.partyName.trim() }),
      tolerancePct: h.tolerancePct === '' ? 0 : Number(h.tolerancePct), lines: out };
    setBusy(true);
    try {
      if (data.refNo && !order) {
        const dup = await getDocs(query(collection(db, 'orders'), where('refNo', '==', data.refNo)));
        if (dup.docs.some((d) => d.data().type === type && d.data().status !== 'cancelled')) throw new Error(`Số đơn Ecount ${data.refNo} đã có trong hệ thống.`);
      }
      const id = order ? (await saveOrder(order.id, data, { email, name }), order.id) : await createOrder(data, { email, name });
      onClose(id);
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền lập/sửa đơn.' : e2.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={order ? `Sửa ${order.id}` : `Lập ${meta.label.toLowerCase()}`} onClose={() => onClose()} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label={type === 'SO' ? 'Công ty bán' : type === 'PO' ? 'Công ty mua' : 'Công ty chủ hàng'} required>
            <CompanyPicker value={h.company} allowAll={false} required onChange={(v) => set('company', v)} />
          </Field>
          {sto && (
            <>
              <Field label="Kho đi (xuất)" required>
                <select value={h.fromWarehouse} disabled={!!order} onChange={(e) => set('fromWarehouse', e.target.value)}>
                  <option value="">-- Chọn --</option>
                  {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
                </select>
              </Field>
              <Field label="Kho đến (nhập)" required>
                <select value={h.toWarehouse} disabled={!!order} onChange={(e) => set('toWarehouse', e.target.value)}>
                  <option value="">-- Chọn --</option>
                  {allWarehouses.filter((w) => w.code !== h.fromWarehouse).map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
                </select>
              </Field>
            </>
          )}
          <Field label={sto ? 'Số chứng từ Ecount (nếu có)' : 'Số đơn Ecount / số hợp đồng'} help="Để đối chiếu với kế toán"><input value={h.refNo} onChange={(e) => set('refNo', e.target.value)} /></Field>
          <Field label="Ngày đơn" required><input type="date" value={h.date} onChange={(e) => set('date', e.target.value)} /></Field>
          {!sto && <Field label={meta.partyLabel} required>
            <input list="dl-ord-party" value={h.partyCode} placeholder="Mã"
              onChange={(e) => { const p = parties.find((x) => x.code === e.target.value); setH((x) => ({ ...x, partyCode: e.target.value, partyName: p ? p.name : x.partyName, shipCode: '' })); }} />
            <input value={h.partyName} placeholder="Tên" style={{ marginTop: 4 }} onChange={(e) => set('partyName', e.target.value)} />
          </Field>}
          {type === 'SO' && (
            <Field label="Giao đến (Shipto)">
              <select value={h.shipCode} onChange={(e) => set('shipCode', e.target.value)}>
                <option value="">-- Chọn --</option>
                {shipto.filter((s) => s.customerCode === h.partyCode).map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
              </select>
            </Field>
          )}
          {!sto && <Field label={type === 'SO' ? 'Xuất từ kho' : 'Nhập về kho'} help="Bỏ trống nếu chưa biết kho">
            <select value={h.warehouse} onChange={(e) => set('warehouse', e.target.value)}>
              <option value="">-- Kho nào cũng được --</option>
              {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
            </select>
          </Field>}
          <Field label={meta.due}><input type="date" value={h.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></Field>
          <Field label="Dung sai cho phép (%)" help="Được giao/nhận vượt số đặt tối đa bao nhiêu %"><input type="number" step="any" min="0" value={h.tolerancePct} onChange={(e) => set('tolerancePct', e.target.value)} /></Field>
          <Field label="Ghi chú" full><textarea rows={2} value={h.note} onChange={(e) => set('note', e.target.value)} /></Field>
        </div>
        <div className="section-head">Mặt hàng</div>
        <table>
          <thead><tr><th>Mã hàng</th><th>Tên hàng</th><th className="num">Số lượng (tấn)</th>{order && <th className="num">{meta.done}</th>}<th>Ghi chú</th><th></th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><input list="dl-ord-item" value={l.item} disabled={l.doneKg > 0} onChange={(e) => setLine(i, { item: e.target.value })} /></td>
                <td className="small">{itemMap.get(l.item)?.name || l.itemName}</td>
                <td><input type="number" step="any" min="0" value={l.qtyT} onChange={(e) => setLine(i, { qtyT: e.target.value })} style={{ width: 110 }} /></td>
                {order && <td className="num">{t(l.doneKg)}</td>}
                <td><input value={l.note} onChange={(e) => setLine(i, { note: e.target.value })} /></td>
                <td><button type="button" className="btn ghost" disabled={lines.length === 1 || l.doneKg > 0} title={l.doneKg > 0 ? 'Dòng đã giao/nhận, không xóa được' : ''}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn sm" style={{ marginTop: 6 }} onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Thêm mặt hàng</button>
        <ErrorBox error={err} />
        <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : order ? 'Lưu' : 'Lập đơn'}</button></div>
        <datalist id="dl-ord-party">{parties.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
        <datalist id="dl-ord-item">{items.filter((x) => x.active !== false).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</datalist>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function OrderDetail({ o, onClose, onEdit }) {
  const meta = ORDER_TYPES[o.type];
  const { hasRole, email, name } = useApp();
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
        {' · '}{meta.partyLabel}: <b>{sto ? partyText(o) : `${o.partyCode} ${o.partyName}`}</b>{o.shipCode ? ` · giao ${o.shipCode}` : ''}
        {o.warehouse ? ` · Kho ${o.warehouse}` : ''}{o.dueDate ? ` · ${meta.due}: ${fmtDate(o.dueDate)}` : ''}
        {Number(o.tolerancePct) ? ` · Dung sai ${o.tolerancePct}%` : ''}
      </p>
      {o.note && <p className="small">Ghi chú: {o.note}</p>}
      {o.closeReason && <p className="small">Lý do {o.status === 'cancelled' ? 'hủy' : 'đóng'}: {o.closeReason}</p>}
      <div className="stats">
        <div className="stat"><div className="stat-label">Đặt</div><div className="stat-value">{t(x.qty)} tấn</div></div>
        <div className="stat green"><div className="stat-label">{meta.done}</div><div className="stat-value">{t(x.done)} tấn</div></div>
        {sto && <div className="stat"><div className="stat-label">{meta.transit}</div><div className="stat-value">{t(x.transit)} tấn</div></div>}
        {sto && <div className="stat green"><div className="stat-label">{meta.received} tại kho {o.toWarehouse}</div><div className="stat-value">{t(x.received)} tấn</div></div>}
        <div className="stat amber"><div className="stat-label">{meta.left}</div><div className="stat-value">{isOpen ? t(x.left) : '0'} tấn</div>{!isOpen && x.left > 0 && <div className="stat-sub">{t(x.left)} tấn không thực hiện ({ORDER_STATUS[o.status].label.toLowerCase()})</div>}</div>
      </div>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>#</th><th>Mã hàng</th><th>Tên hàng</th><th className="num">Đặt (tấn)</th><th className="num">{meta.done}</th>
            {sto && <><th className="num">{meta.transit}</th><th className="num">{meta.received}</th></>}<th className="num">{meta.left}</th><th>Ghi chú</th></tr></thead>
          <tbody>{o.lines.map((l) => (
            <tr key={l.no}><td>{l.no}</td><td>{l.item}</td><td>{l.itemName}</td><td className="num">{t(l.qtyKg)}</td><td className="num">{t(l.doneKg)}</td>
              {sto && <><td className="num">{t(transitKg(l))}</td><td className="num">{t(l.receivedKg)}</td></>}
              <td className="num"><b>{isOpen ? t(leftKg(l)) : '–'}</b></td><td className="small">{l.note}</td></tr>
          ))}</tbody>
        </table>
      </div>

      <div className="form-actions" style={{ justifyContent: 'flex-start', marginBottom: 8 }}><MoveButtons o={o} /></div>
      <div className="section-head">Phiếu {sto ? 'xuất / nhập kho' : MOVE_TYPES[moveType].label.toLowerCase()} theo đơn ({moves.length})</div>
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
        groups.get(refNo).lines.push({ item, itemName: itemMap.get(item).name, qtyKg: Math.round(kg * 1000) / 1000, note: '' });
      });
      const have = new Set(existing.filter((o) => o.status !== 'cancelled').map((o) => o.refNo));
      let made = 0;
      let skipped = 0;
      for (const g of groups.values()) {
        if (have.has(g.refNo)) { skipped++; continue; }
        if (!g.partyCode && !g.partyName) { errs.push(`Đơn ${g.refNo}: thiếu mã/tên đối tác.`); continue; }
        if (!g.company) { errs.push(`Đơn ${g.refNo}: thiếu công ty.`); continue; }
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
