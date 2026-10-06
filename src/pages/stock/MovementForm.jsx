import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpWarehouse, useOrders, useStock, useTrips } from '../../lib/hooks';
import { ORDER_TYPES, leftKg, matchOrderLine } from '../../lib/orders';
import { MOVE_TYPES, ageDays, kgOf, postMovement, suggestPallets } from '../../lib/stock';
import { ST, vnDate } from '../../lib/trips';
import { fmtDate, fmtNum } from '../../lib/utils';
import { ErrorBox, Field } from '../../components/ui';

const num = (v) => (v === '' || v == null ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
const newLine = () => ({ item: '', lot: '', mfgDate: '', expDate: '', location: '', goodsStatus: 'KTC', pledgee: '', bags: '', pallets: '', kg: '' });
const stockLine = () => ({ stockId: '', bags: '', pallets: '', kg: '', toLocation: '', toStatus: '', toPledgee: '', sign: '+' });

// Ai được lập loại phiếu nào
export function canMove(hasRole, type) {
  return type === 'status' ? hasRole('ke_toan') : hasRole('thu_kho');
}

export default function MovementForm() {
  const { type } = useParams();
  const { hasRole } = useApp();
  if (!MOVE_TYPES[type] || !canMove(hasRole, type)) return <Navigate to="/kho/ton" />;
  return <Form key={type} type={type} />;
}

function Form({ type }) {
  const meta = MOVE_TYPES[type];
  const { email, name } = useApp();
  const [params] = useSearchParams();
  const warehouses = useMyWarehouses();
  const [opWh, setOpWh] = useOpWarehouse();
  const wh = warehouses.find((w) => w.code === opWh) || (warehouses.length === 1 ? warehouses[0] : null);
  const whCode = wh?.code || '';
  const items = useCollection('items').rows;
  const locations = useCollection('locations').rows.filter((l) => l.warehouse === whCode);
  const statuses = useCollection('goodsStatus').rows;
  const pledgees = useCollection('pledgees').rows;
  const suppliers = useCollection('suppliers').rows;
  const soldto = useCollection('soldto').rows;
  const shipto = useCollection('shipto').rows;
  const reasons = useCollection('reasons').rows;
  const { rows: stock } = useStock(whCode || '__none__');
  const { rows: trips } = useTrips([ST.PROCESSING], whCode);
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const statusMap = useMemo(() => new Map(statuses.map((s) => [s.code, s])), [statuses]);

  const orderType = type === 'in' ? 'PO' : type === 'out' ? 'SO' : '__none__';
  const { rows: orders } = useOrders(orderType, true);
  const [head, setHead] = useState({ date: vnDate(), tripId: params.get('trip') || '', orderId: params.get('order') || '', partyCode: '', partyName: '', shipCode: '', reason: '', note: '' });
  const [lines, setLines] = useState(() => [type === 'in' ? newLine() : stockLine()]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [filter, setFilter] = useState('');

  const tripOpts = trips.filter((t) => (type === 'in' ? t.purpose === 'import' : t.purpose === 'export'));
  // Chọn chuyến xe → tự điền kho, khách / nhà cung cấp
  useEffect(() => {
    const t = trips.find((x) => x.id === head.tripId);
    if (!t) return;
    if (t.warehouse !== opWh) setOpWh(t.warehouse);
    const l = t.lines?.find((x) => x.orderId) || t.lines?.[0];
    if (l && l.orderId && !head.orderId) pickOrder(l.orderId);
    else if (l && !head.partyCode) setHead((h) => ({ ...h, partyCode: l.partyCode, partyName: l.partyName, shipCode: l.shipCode || '' }));
  }, [head.tripId, trips, orders.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Đơn SO/PO đang mở phù hợp kho và khách / nhà cung cấp
  const order = orders.find((o) => o.id === head.orderId);
  const orderOpts = orders.filter((o) => (!o.warehouse || o.warehouse === whCode) && (!head.partyCode || o.partyCode === head.partyCode || o.id === head.orderId))
    .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  const pickOrder = (id) => {
    const o = orders.find((x) => x.id === id);
    if (!o) return setHead((h) => ({ ...h, orderId: id }));
    setHead((h) => ({ ...h, orderId: id, partyCode: o.partyCode, partyName: o.partyName, shipCode: o.shipCode || h.shipCode }));
    if (o.warehouse && o.warehouse !== opWh) setOpWh(o.warehouse);
    // Phiếu nhập: điền sẵn các mặt hàng còn chưa về của PO (thủ kho chọn vị trí, sửa số thực nhận)
    if (type === 'in') {
      setLines((ls) => {
        if (ls.some((l) => l.item)) return ls;
        const next = o.lines.filter((l) => leftKg(l) > 0).map((l) => {
          const it = itemMap.get(l.item);
          const kg = leftKg(l);
          const bags = num(it?.bagWeight) ? Math.round(kg / num(it.bagWeight)) : '';
          return { ...newLine(), item: l.item, orderLine: l.no, bags, pallets: suggestPallets(it, bags), kg };
        });
        return next.length ? next : ls;
      });
    }
  };

  const setH = (k, v) => setHead((h) => ({ ...h, [k]: v }));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Dòng tồn sắp xếp FIFO (nhập trước xuất trước)
  const stockRows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return stock
      .filter((r) => !f || [r.item, r.itemName, r.lot, r.location].join(' ').toLowerCase().includes(f))
      .sort((a, b) => String(a.item).localeCompare(String(b.item)) || String(a.inDate).localeCompare(String(b.inDate)) || String(a.location).localeCompare(String(b.location)));
  }, [stock, filter]);
  const stockById = useMemo(() => new Map(stock.map((r) => [r._id, r])), [stock]);
  const blocked = (r) => type === 'out' && statusMap.get(r.goodsStatus)?.allowOutbound === false;

  const parties = type === 'in' ? suppliers : soldto;

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!wh) return setErr('Chọn kho.');
    if (type === 'adjust' && !head.reason) return setErr('Chọn lý do điều chỉnh.');
    const out = [];
    for (const [i, l] of lines.entries()) {
      const no = `Dòng ${i + 1}: `;
      if (type === 'in') {
        if (!l.item || !itemMap.has(l.item)) return setErr(no + 'chọn mã hàng có trong danh mục.');
        if (!l.location) return setErr(no + 'chọn vị trí.');
        if (!num(l.bags) && !num(l.pallets)) return setErr(no + 'nhập số bao hoặc pallet.');
        if (l.goodsStatus === 'HTC' && !l.pledgee) return setErr(no + 'hàng HTC cần chọn bên nhận thế chấp.');
        out.push({ ...(l.orderLine != null ? { orderLine: l.orderLine } : {}), item: l.item, itemName: itemMap.get(l.item).name, lot: l.lot.trim(), mfgDate: l.mfgDate, expDate: l.expDate,
          location: l.location, goodsStatus: l.goodsStatus, pledgee: l.goodsStatus === 'HTC' ? l.pledgee : '',
          bags: num(l.bags), pallets: num(l.pallets), kg: num(l.kg) });
        continue;
      }
      const r = stockById.get(l.stockId);
      if (!r) return setErr(no + 'chọn dòng tồn.');
      if (blocked(r)) return setErr(no + `hàng ${r.goodsStatus} bị khóa xuất kho.`);
      const sign = type === 'adjust' && l.sign === '-' ? -1 : 1;
      if (!num(l.bags) && !num(l.pallets)) return setErr(no + 'nhập số lượng.');
      if (type === 'move' && (!l.toLocation || l.toLocation === r.location)) return setErr(no + 'chọn vị trí mới khác vị trí cũ.');
      if (type === 'status' && (!l.toStatus || l.toStatus === r.goodsStatus)) return setErr(no + 'chọn tình trạng mới.');
      if (type === 'status' && l.toStatus === 'HTC' && !l.toPledgee) return setErr(no + 'chọn bên nhận thế chấp.');
      out.push({
        ...(l.orderLine != null ? { orderLine: l.orderLine } : {}),
        item: r.item, itemName: r.itemName, lot: r.lot, mfgDate: r.mfgDate, expDate: r.expDate, inDate: r.inDate,
        location: r.location, goodsStatus: r.goodsStatus, pledgee: r.pledgee || '',
        bags: sign * num(l.bags), pallets: sign * num(l.pallets), kg: sign * num(l.kg),
        ...(type === 'move' ? { toLocation: l.toLocation } : {}),
        ...(type === 'status' ? { toStatus: l.toStatus, toPledgee: l.toStatus === 'HTC' ? l.toPledgee : '' } : {}),
      });
    }
    // Gắn từng dòng phiếu vào dòng đơn SO/PO cùng mã hàng
    if (head.orderId) {
      if (!order) return setErr(`Đơn ${head.orderId} không còn mở.`);
      const used = {};
      for (const [i, l] of out.entries()) {
        const keep = order.lines.find((x) => x.no === l.orderLine && x.item === l.item);
        l.orderLine = keep ? keep.no : matchOrderLine(order, l.item, used);
        if (l.orderLine == null) return setErr(`Dòng ${i + 1}: mã hàng ${l.item} không có trong đơn ${order.id}.`);
        used[l.orderLine] = (used[l.orderLine] || 0) + Math.abs(num(l.kg));
      }
    }
    setBusy(true);
    try {
      const id = await postMovement({
        type, warehouse: wh.code, date: head.date, tripId: head.tripId || '', orderId: head.orderId || '', orderRef: order?.refNo || '',
        partyCode: head.partyCode.trim(), partyName: head.partyName.trim(), shipCode: head.shipCode,
        reason: head.reason, note: head.note.trim(), lines: out,
      }, { email, name });
      setDone(id);
      setLines([type === 'in' ? newLine() : stockLine()]);
      setHead((h) => ({ ...h, tripId: '', orderId: '', partyCode: '', partyName: '', shipCode: '', note: '' }));
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền lập phiếu cho kho này.' : e2.message);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <h1>{meta.icon} {meta.label}</h1>
        <Link className="btn" to="/kho/phieu">Danh sách phiếu</Link>
      </div>
      {done && <div className="ok-box" style={{ marginBottom: 10 }}>Đã lập phiếu <b className="mono">{done}</b>. Tồn kho đã cập nhật. <Link to={`/kho/phieu/${done}/in`} target="_blank">🖨 In phiếu</Link></div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="form-grid">
          <Field label="Kho" required>
            <select value={whCode} onChange={(e) => { setOpWh(e.target.value); setLines([type === 'in' ? newLine() : stockLine()]); }}>
              <option value="">-- Chọn kho --</option>
              {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
            </select>
          </Field>
          <Field label="Ngày chứng từ" required><input type="date" value={head.date} onChange={(e) => setH('date', e.target.value)} /></Field>
          {(type === 'in' || type === 'out') && (
            <>
              <Field label="Chuyến xe đang xuất/nhập">
                <select value={head.tripId} onChange={(e) => setH('tripId', e.target.value)}>
                  <option value="">-- Không gắn chuyến --</option>
                  {tripOpts.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.plate} · cửa {t.dock}</option>)}
                </select>
              </Field>
              <Field label={type === 'in' ? 'Nhà cung cấp' : 'Khách hàng'}>
                <input list="dl-mv-party" value={head.partyCode} placeholder="Mã"
                  onChange={(e) => { const p = parties.find((x) => x.code === e.target.value); setHead((h) => ({ ...h, partyCode: e.target.value, partyName: p ? p.name : h.partyName, shipCode: '', orderId: '' })); }} />
                <input value={head.partyName} placeholder="Tên" style={{ marginTop: 4 }} onChange={(e) => setH('partyName', e.target.value)} />
              </Field>
              <Field label={ORDER_TYPES[orderType].label} help={orderOpts.length ? 'Phiếu sẽ tự trừ phần còn lại của đơn' : 'Không có đơn đang mở phù hợp'}>
                <select value={head.orderId} onChange={(e) => pickOrder(e.target.value)}>
                  <option value="">-- Không theo đơn --</option>
                  {orderOpts.map((o) => {
                    const left = o.lines.reduce((s2, l) => s2 + leftKg(l), 0);
                    return <option key={o.id} value={o.id}>{o.id}{o.refNo ? ` (${o.refNo})` : ''} · {o.partyName || o.partyCode} · còn {fmtNum(left / 1000, 3)} tấn</option>;
                  })}
                </select>
              </Field>
              {type === 'out' && (
                <Field label="Giao đến (Shipto)">
                  <select value={head.shipCode} onChange={(e) => setH('shipCode', e.target.value)}>
                    <option value="">-- Chọn --</option>
                    {shipto.filter((s) => s.customerCode === head.partyCode).map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
                  </select>
                </Field>
              )}
            </>
          )}
          {(type === 'adjust' || type === 'in' || type === 'out') && (
            <Field label="Lý do" required={type === 'adjust'}>
              <select value={head.reason} onChange={(e) => setH('reason', e.target.value)}>
                <option value="">-- Chọn --</option>
                {reasons.filter((r) => type !== 'adjust' || ['Điều chỉnh tồn', 'Hàng lỗi'].includes(r.appliesTo)).map((r) => <option key={r.code} value={`${r.code} – ${r.name}`}>{r.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Ghi chú" full><textarea rows={2} value={head.note} onChange={(e) => setH('note', e.target.value)} /></Field>
        </div>
      </div>

      {order && <OrderBox order={order} lines={lines} type={type} stockById={stockById} />}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-head">Hàng hóa ({lines.length})</div>
        {type !== 'in' && (
          <input type="search" placeholder="Lọc tồn theo mã hàng, lot, vị trí…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
        )}
        {lines.map((l, i) => (
          <div key={i} className="mv-line">
            {type === 'in' ? (
              <InLine l={l} set={(p) => setLine(i, p)} itemMap={itemMap} items={items} locations={locations} statuses={statuses} pledgees={pledgees} />
            ) : (
              <StockLine type={type} l={l} set={(p) => setLine(i, p)} rows={stockRows} byId={stockById} blocked={blocked}
                locations={locations} statuses={statuses} pledgees={pledgees} />
            )}
            <button type="button" className="btn ghost" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        {lines.length < 30 && <button type="button" className="btn sm" onClick={() => setLines((ls) => [...ls, type === 'in' ? newLine() : stockLine()])}>+ Thêm dòng</button>}
      </div>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang ghi…' : `Lập phiếu ${meta.label.toLowerCase()}`}</button></div>
      <datalist id="dl-mv-party">{parties.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
      <datalist id="dl-mv-item">{items.filter((x) => x.active !== false).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</datalist>
    </form>
  );
}

// Đơn đang chọn: đặt / đã giao-nhận / còn lại, và còn lại sau phiếu này
function OrderBox({ order, lines, type, stockById }) {
  const meta = ORDER_TYPES[order.type];
  const thisKg = {};
  for (const l of lines) {
    const item = type === 'in' ? l.item : stockById.get(l.stockId)?.item;
    if (item) thisKg[item] = (thisKg[item] || 0) + Math.abs(num(l.kg));
  }
  const t = (kg) => fmtNum(kg / 1000, 3);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="section-head">{meta.label} {order.id}{order.refNo ? ` · Ecount ${order.refNo}` : ''}{order.dueDate ? ` · ${meta.due} ${fmtDate(order.dueDate)}` : ''}</div>
      <table>
        <thead><tr><th>Mã hàng</th><th>Tên hàng</th><th className="num">Đặt (tấn)</th><th className="num">{meta.done}</th><th className="num">{meta.left}</th><th className="num">Phiếu này</th><th className="num">Còn lại sau phiếu</th></tr></thead>
        <tbody>
          {order.lines.map((l) => {
            const same = order.lines.filter((x) => x.item === l.item);
            const share = same[0] === l ? thisKg[l.item] || 0 : 0;
            const after = leftKg(l) - share;
            return (
              <tr key={l.no}><td>{l.item}</td><td>{l.itemName}</td><td className="num">{t(l.qtyKg)}</td><td className="num">{t(num(l.doneKg))}</td>
                <td className="num">{t(leftKg(l))}</td><td className="num">{share ? t(share) : ''}</td>
                <td className="num" style={after < 0 ? { color: 'var(--red)', fontWeight: 600 } : { fontWeight: 600 }}>{t(after)}{after < 0 ? ' (vượt đơn)' : ''}</td></tr>
            );
          })}
        </tbody>
      </table>
      {lines.some((l) => { const it = type === 'in' ? l.item : stockById.get(l.stockId)?.item; return it && !order.lines.some((x) => x.item === it); }) &&
        <div className="error-box">Có mặt hàng không nằm trong đơn {order.id}.</div>}
    </div>
  );
}

function LocationSelect({ value, onChange, locations, exclude }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">-- Vị trí --</option>
      {locations.filter((x) => x.code !== exclude).sort((a, b) => a.code.localeCompare(b.code)).map((x) => {
        const free = num(x.capacity) - num(x.currentPallets);
        return <option key={x.code} value={x.code} disabled={x.locked}>{x.code} · trống {fmtNum(free, 1)}/{fmtNum(x.capacity)} pallet{x.locked ? ' (khóa)' : ''}</option>;
      })}
    </select>
  );
}

function InLine({ l, set, itemMap, locations, statuses, pledgees }) {
  const it = itemMap.get(l.item);
  const setBags = (v) => set({ bags: v, pallets: suggestPallets(it, v), kg: kgOf(it, v) });
  return (
    <div className="mv-grid">
      <Field label="Mã hàng" required>
        <input list="dl-mv-item" value={l.item} onChange={(e) => { const x = itemMap.get(e.target.value); set({ item: e.target.value, ...(x && l.bags ? { pallets: suggestPallets(x, l.bags), kg: kgOf(x, l.bags) } : {}) }); }} />
        {it && <small className="small">{it.name}</small>}
      </Field>
      <Field label="Lot"><input value={l.lot} onChange={(e) => set({ lot: e.target.value })} /></Field>
      <Field label="NSX"><input type="date" value={l.mfgDate} onChange={(e) => set({ mfgDate: e.target.value })} /></Field>
      <Field label="HSD"><input type="date" value={l.expDate} onChange={(e) => set({ expDate: e.target.value })} /></Field>
      <Field label="Vị trí" required><LocationSelect value={l.location} onChange={(v) => set({ location: v })} locations={locations} /></Field>
      <Field label="Tình trạng">
        <select value={l.goodsStatus} onChange={(e) => set({ goodsStatus: e.target.value })}>
          {statuses.map((s) => <option key={s.code} value={s.code}>{s.code} – {s.name}</option>)}
          {!statuses.length && <option value="KTC">KTC</option>}
        </select>
      </Field>
      {l.goodsStatus === 'HTC' && (
        <Field label="Bên nhận thế chấp" required>
          <select value={l.pledgee} onChange={(e) => set({ pledgee: e.target.value })}>
            <option value="">-- Chọn --</option>
            {pledgees.map((p) => <option key={p.code} value={p.code}>{p.code} – {p.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Số bao"><input type="number" step="any" value={l.bags} onChange={(e) => setBags(e.target.value)} /></Field>
      <Field label="Pallet"><input type="number" step="any" value={l.pallets} onChange={(e) => set({ pallets: e.target.value })} /></Field>
      <Field label="Kg"><input type="number" step="any" value={l.kg} onChange={(e) => set({ kg: e.target.value })} /></Field>
    </div>
  );
}

function StockLine({ type, l, set, rows, byId, blocked, locations, statuses, pledgees }) {
  const r = byId.get(l.stockId);
  // Số lượng xuất/chuyển → pallet, kg chia theo tỷ lệ tồn
  const setBags = (v) => {
    if (!r || !num(r.bags)) return set({ bags: v });
    const k = num(v) / num(r.bags);
    set({ bags: v, pallets: r3(num(r.pallets) * k), kg: r3(num(r.kg) * k) });
  };
  const pick = (id) => {
    const x = byId.get(id);
    if (!x) return set({ stockId: id });
    const all = type === 'move' || type === 'status';
    set({ stockId: id, bags: all ? x.bags : '', pallets: all ? x.pallets : '', kg: all ? x.kg : '' });
  };
  return (
    <div className="mv-grid">
      <Field label="Dòng tồn (FIFO)" required full>
        <select value={l.stockId} onChange={(e) => pick(e.target.value)}>
          <option value="">-- Chọn hàng trong kho --</option>
          {rows.map((x) => (
            <option key={x._id} value={x._id} disabled={blocked(x)}>
              {x.item} · lot {x.lot || '-'} · {x.location} · {x.goodsStatus}{x.pledgee ? `(${x.pledgee})` : ''} · {fmtNum(x.bags)} bao / {fmtNum(x.pallets, 2)} pl · nhập {fmtDate(x.inDate)} ({ageDays(x.inDate)} ngày){blocked(x) ? ' · KHÓA XUẤT' : ''}
            </option>
          ))}
        </select>
        {r && <small className="small">{r.itemName} · còn {fmtNum(r.bags)} bao, {fmtNum(r.pallets, 2)} pallet, {fmtNum(r.kg)} kg</small>}
      </Field>
      {type === 'adjust' && (
        <Field label="Tăng / giảm">
          <select value={l.sign} onChange={(e) => set({ sign: e.target.value })}><option value="+">Tăng (+)</option><option value="-">Giảm (−)</option></select>
        </Field>
      )}
      {type === 'move' && <Field label="Đến vị trí" required><LocationSelect value={l.toLocation} onChange={(v) => set({ toLocation: v })} locations={locations} exclude={r?.location} /></Field>}
      {type === 'status' && (
        <>
          <Field label="Tình trạng mới" required>
            <select value={l.toStatus} onChange={(e) => set({ toStatus: e.target.value })}>
              <option value="">-- Chọn --</option>
              {statuses.filter((s) => s.code !== r?.goodsStatus).map((s) => <option key={s.code} value={s.code}>{s.code} – {s.name}</option>)}
            </select>
          </Field>
          {l.toStatus === 'HTC' && (
            <Field label="Bên nhận thế chấp" required>
              <select value={l.toPledgee} onChange={(e) => set({ toPledgee: e.target.value })}>
                <option value="">-- Chọn --</option>
                {pledgees.map((p) => <option key={p.code} value={p.code}>{p.code} – {p.name}</option>)}
              </select>
            </Field>
          )}
        </>
      )}
      <Field label="Số bao"><input type="number" step="any" value={l.bags} onChange={(e) => setBags(e.target.value)} /></Field>
      <Field label="Pallet"><input type="number" step="any" value={l.pallets} onChange={(e) => set({ pallets: e.target.value })} /></Field>
      <Field label="Kg"><input type="number" step="any" value={l.kg} onChange={(e) => set({ kg: e.target.value })} /></Field>
    </div>
  );
}
