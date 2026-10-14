import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useOrders, useWaitingOut } from '../../lib/hooks';
import { OPEN_STATUSES, leftKg, lineShip, lineWh } from '../../lib/orders';
import { OPEN_PLAN, PLAN_STATUS, createPlan, planLeft, plannedByLine, updatePlan, usePlans } from '../../lib/shipPlans';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { WithAdd } from '../../components/FormTools';

const kg = (v) => fmtNum(Number(v) || 0, 2);

// Dự kiến xuất kho: Sale lập từ SO của mình; quản trị kho / thủ kho căn cứ vào đây để lập phiếu xuất kho
export default function ShipPlans() {
  const { hasRole, email, name } = useApp();
  const canPlan = hasRole('kinh_doanh', 'ke_toan');
  const canOut = hasRole('thu_kho');
  const { rows: plans, error } = usePlans();
  // Phiếu xuất đã lập nhưng chờ giải chấp hàng HTC (chưa trừ SO): khóa nút lập phiếu để không lập trùng
  const waitOut = useWaitingOut();
  const { rows: allSO, loading: soLoading } = useOrders('SO');
  const soMap = useMemo(() => new Map(allSO.map((o) => [o.id, o])), [allSO]);
  // Dự kiến còn mở mà SO đã giao đủ / đã đóng / đã hủy (phiếu xuất lập không qua dự kiến, hoặc lập trước khi có tự trừ):
  // tự đóng để không còn treo "Chờ lập phiếu"
  const tried = useRef(new Set());
  useEffect(() => {
    if (soLoading || !waitOut.loaded || !(canOut || canPlan)) return;
    for (const p of plans) {
      const o = soMap.get(p.orderId);
      if (!OPEN_PLAN.includes(p.status) || !o || OPEN_STATUSES.includes(o.status) || waitOut.get(p.orderId)?.ids?.length || tried.current.has(p.id)) continue;
      tried.current.add(p.id);
      const patch = o.status === 'cancelled' && canPlan ? { status: 'cancelled', cancelReason: `Tự hủy: đơn ${o.id} đã hủy`, cancelledBy: email }
        : { status: 'done', doneAt: new Date().toISOString() };
      updatePlan(p.id, patch, { email, name }).catch(() => {});
    }
  }, [plans, soMap, soLoading, waitOut]); // eslint-disable-line react-hooks/exhaustive-deps
  // Phần SO còn lập phiếu xuất được cho 1 dòng dự kiến = SO còn phải giao − phiếu xuất đang chờ giải chấp
  const soFree = (p, l) => {
    const o = soMap.get(p.orderId);
    const ol = o?.lines?.find((x) => x.no === l.orderLine);
    return ol ? leftKg(ol) - (waitOut.get(p.orderId)?.byLine?.[l.orderLine] || 0) : 0;
  };
  // Tên Sale phụ trách (đơn chỉ lưu email)
  const users = useCollection('users').rows;
  const saleName = (p) => p.salesName || users.find((u) => (u._id || u.email) === p.sales)?.name || p.sales || '';
  const [params, setParams] = useSearchParams();
  const [fStatus, setFStatus] = useState('open');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [edit, setEdit] = useState(params.get('so') ? { orderId: params.get('so') } : null);
  const [err, setErr] = useState('');

  const list = useMemo(() => {
    const f = norm(q);
    return plans.filter((p) => (fStatus === 'all' || (fStatus === 'open' ? OPEN_PLAN.includes(p.status) : p.status === fStatus))
      && (!from || (p.date || '') >= from) && (!to || (p.date || '') <= to)
      && (!f || norm([p.id, p.orderId, p.orderRef, p.partyCode, p.partyName, p.salesName, p.sales, p.note, ...(p.lines || []).flatMap((l) => [l.item, l.itemName, l.shipCode])].join(' ')).includes(f)))
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id.localeCompare(b.id));
  }, [plans, fStatus, q, from, to]);

  const cancel = async (p) => {
    const why = window.prompt(`Hủy dự kiến xuất ${p.id}? Ghi lý do:`);
    if (why == null) return;
    try { await updatePlan(p.id, { status: 'cancelled', cancelReason: why, cancelledBy: email }, { email, name }); } catch (e) { setErr(e.message); }
  };
  const markDone = async (p) => {
    if (!window.confirm(`Đánh dấu ${p.id} đã xong (không xuất thêm theo dự kiến này)?`)) return;
    try { await updatePlan(p.id, { status: 'done', doneAt: new Date().toISOString() }, { email, name }); } catch (e) { setErr(e.message); }
  };

  const exportExcel = () => exportSheets(`du-kien-xuat-${vnDate()}`, {
    'Dự kiến xuất': list.flatMap((p) => (p.lines || []).map((l) => ({
      'Số dự kiến': p.id, 'Ngày dự kiến xuất': p.date, 'Đơn bán': p.orderId, 'Số đơn KH': p.orderRef || '', 'Công ty': p.company || '',
      'Khách hàng': p.partyCode, 'Tên khách hàng': p.partyName, 'Mã giao': l.shipCode, 'Địa chỉ giao': l.shipAddress || '',
      'Mã hàng': l.item, 'Tên hàng': l.itemName, 'Kiện/Xá': l.packing || '', 'Kho (theo SO)': l.warehouse || '',
      'SL dự kiến (kg)': Number(l.qtyKg) || 0, 'Đã xuất (kg)': Number(l.doneKg) || 0, 'Còn (kg)': planLeft(l),
      'Trạng thái': PLAN_STATUS[p.status]?.label || p.status, 'Sale': saleName(p), 'Ghi chú': p.note || '', 'Phiếu xuất': (p.movementIds || []).join(', '),
    }))),
  });

  return (
    <div>
      <div className="page-head">
        <h1>📅 Dự kiến xuất kho</h1>
        <div className="actions">
          {canPlan && <button className="btn primary" onClick={() => setEdit({})}>＋ Tạo dự kiến xuất</button>}
        </div>
      </div>
      <p className="hint">
        Sale lập dự kiến xuất từ đơn bán (SO) của mình: số lượng cần xuất và mã giao, không cần chọn kho.
        Quản trị kho / thủ kho căn cứ vào đây bấm <b>📤 Lập phiếu xuất</b>; phiếu xuất lưu xong thì dự kiến tự chuyển <i>Đã lập phiếu xuất</i>.
      </p>
      <div className="filters">
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="open">Chờ lập phiếu (còn mở)</option>
          <option value="done">Đã lập phiếu xuất</option>
          <option value="cancelled">Đã hủy</option>
          <option value="all">Tất cả</option>
        </select>
        <label className="small">Từ <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">đến <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <input type="search" placeholder="Tìm số dự kiến, SO, khách, mã hàng, mã giao…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={exportExcel}>⬇ Excel</button>
      </div>
      <ErrorBox error={error || err} />
      <div className="table-wrap">
        {!list.length ? <Empty text="Chưa có dự kiến xuất nào" /> : (
          <table>
            <thead><tr>
              <th>Số dự kiến</th><th>Ngày dự kiến xuất</th><th>Đơn bán</th><th>Khách hàng</th>
              <th>Mã giao</th><th>Mã hàng</th><th>Kiện/Xá</th><th className="num">SL dự kiến (kg)</th><th className="num">Đã xuất (kg)</th>
              <th>Trạng thái</th><th>Sale</th><th></th>
            </tr></thead>
            <tbody>
              {list.map((p) => {
                const ls = p.lines || [];
                const open = OPEN_PLAN.includes(p.status);
                // Mỗi mã giao lập 1 phiếu xuất
                const ships = [...new Set(ls.filter((l) => planLeft(l) > 0.001).map((l) => l.shipCode || ''))];
                const waitIds = waitOut.byPlan?.get(p.id) || [];
                const soWait = waitOut.get(p.orderId)?.ids || [];
                // Mã giao không còn gì lập phiếu được (đã có phiếu chờ giải chấp / SO đã giao đủ, đã đóng)
                const blocked = (sc) => waitOut.loaded && !ls.some((l) => (l.shipCode || '') === sc && planLeft(l) > 0.001 && soFree(p, l) > 0.001);
                return ls.map((l, i) => (
                  <tr key={`${p.id}#${i}`} >
                    {!i && <>
                      <td rowSpan={ls.length} className="mono">{p.id}{p.note && <div className="small">{p.note}</div>}</td>
                      <td rowSpan={ls.length}>{fmtDate(p.date)}</td>
                      <td rowSpan={ls.length} className="mono">{p.orderId}{p.orderRef && <div className="small">{p.orderRef}</div>}</td>
                      <td rowSpan={ls.length}>{p.partyCode}<div className="small">{p.partyName}</div></td>
                    </>}
                    <td title={l.shipAddress || ''}>{l.shipCode}{l.shipAddress && <div className="small">{l.shipAddress}</div>}</td>
                    <td>{l.item}<div className="small">{l.itemName}</div></td>
                    <td>{l.packing || ''}</td>
                    <td className="num">{kg(l.qtyKg)}</td>
                    <td className="num">{Number(l.doneKg) ? kg(l.doneKg) : ''}</td>
                    {!i && <>
                      <td rowSpan={ls.length}><span className={'badge ' + (PLAN_STATUS[p.status]?.tone || '')}>{PLAN_STATUS[p.status]?.label || p.status}</span>
                        {waitIds.length > 0 && <div><Link className="badge amber" to="/kho/giai-chap" title={`Phiếu xuất chờ giải chấp: ${waitIds.join(', ')}`}>⏳ Chờ giải chấp ({waitIds.length})</Link></div>}
                        {(p.movementIds || []).length > 0 && <div className="small">{p.movementIds.map((m) => <Link key={m} className="mono" to={`/kho/phieu/${m}/in`} target="_blank" style={{ marginRight: 4 }}>{m}</Link>)}</div>}
                        {p.cancelReason && <div className="small">{p.cancelReason}</div>}</td>
                      <td rowSpan={ls.length} className="small">{saleName(p)}</td>
                      <td rowSpan={ls.length} style={{ whiteSpace: 'nowrap' }}>
                        {open && canOut && ships.map((s) => (blocked(s)
                          ? <div key={s}><span className="btn sm" aria-disabled="true" style={{ opacity: 0.5, cursor: 'not-allowed' }}
                            title={soWait.length ? `Đơn ${p.orderId} đã lập đủ phiếu xuất, đang chờ giải chấp hàng HTC: ${soWait.join(', ')}` : `Đơn ${p.orderId} không còn phần nào để xuất (đã giao đủ hoặc đã đóng)`}>
                            {soWait.length ? '⏳ Đã lập phiếu · chờ giải chấp' : '📤 SO không còn hàng phải giao'}{ships.length > 1 ? ` (${s || 'chưa có mã giao'})` : ''}</span></div>
                          : <div key={s}><Link className="btn primary sm" to={`/kho/out?plan=${p.id}${s ? `&ship=${encodeURIComponent(s)}` : ''}`}>📤 Lập phiếu xuất{ships.length > 1 ? ` (${s || 'chưa có mã giao'})` : ''}</Link></div>
                        ))}
                        {open && canPlan && p.status === 'open' && <button className="btn sm" onClick={() => setEdit(p)}>✎ Sửa</button>}
                        {open && canPlan && p.status === 'open' && <button className="btn sm danger" onClick={() => cancel(p)}>Hủy</button>}
                        {p.status === 'partial' && (canOut || canPlan) && <button className="btn sm" onClick={() => markDone(p)}>✓ Xong</button>}
                      </td>
                    </>}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        )}
      </div>
      {edit && <PlanForm plan={edit.id ? edit : null} orderId={edit.orderId || ''} plans={plans}
        onClose={() => { setEdit(null); if (params.get('so')) setParams({}); }} />}
    </div>
  );
}

function PlanForm({ plan, orderId, plans, onClose }) {
  const { email, name } = useApp();
  const { rows: orders } = useOrders('SO', true);
  const shipto = useCollection('shipto').rows;
  const [oid, setOid] = useState(plan?.orderId || orderId || '');
  const [date, setDate] = useState(plan?.date || vnDate());
  const [note, setNote] = useState(plan?.note || '');
  const [qty, setQty] = useState(() => Object.fromEntries((plan?.lines || []).map((l) => [l.orderLine, String(l.qtyKg)])));
  const [ship, setShip] = useState(() => Object.fromEntries((plan?.lines || []).map((l) => [l.orderLine, l.shipCode || ''])));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const planned = useMemo(() => plannedByLine(plans, plan?.id), [plans, plan]);
  const order = orders.find((o) => o.id === oid);
  const myShips = shipto.filter((s) => s.customerCode === order?.partyCode);
  const rows = (order?.lines || []).map((l) => {
    const left = leftKg(l);
    const inPlans = planned[oid]?.[l.no] || 0;
    return { l, left, inPlans, free: Math.max(0, left - inPlans) };
  }).filter((r) => r.left > 0.001 || qty[r.l.no]);
  // Mã giao mặc định: mã giao của dòng SO, khách chỉ có 1 mã thì lấy mã đó
  useEffect(() => {
    if (!order) return;
    setShip((s) => {
      const nx = { ...s };
      for (const l of order.lines) if (!nx[l.no]) nx[l.no] = lineShip(order, l) || (myShips.length === 1 ? myShips[0].shipCode : '');
      return nx;
    });
  }, [oid, order?.id, myShips.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const orderOpts = orders.filter((o) => OPEN_STATUSES.includes(o.status) && o.lines.some((l) => leftKg(l) > 0.001))
    .sort((a, b) => a.id.localeCompare(b.id));

  const save = async () => {
    setErr('');
    if (!order) return setErr('Chọn đơn bán (SO).');
    if (!date) return setErr('Chọn ngày dự kiến xuất.');
    const lines = [];
    for (const r of rows) {
      const v = Number(qty[r.l.no]) || 0;
      if (v <= 0) continue;
      const max = r.free * (1 + (Number(order.tolerancePct) || 0) / 100);
      if (v > max + 0.5) return setErr(`${r.l.item}: chỉ còn ${kg(r.free)} kg chưa có dự kiến xuất (SO còn ${kg(r.left)} kg, các dự kiến khác ${kg(r.inPlans)} kg).`);
      const sc = ship[r.l.no] || '';
      if (!sc && myShips.length > 1) return setErr(`${r.l.item}: khách ${order.partyCode} có ${myShips.length} mã giao, chọn mã giao.`);
      if (sc && myShips.length && !myShips.some((s) => s.shipCode === sc)) return setErr(`${r.l.item}: mã giao ${sc} không thuộc khách ${order.partyCode}.`);
      lines.push({ orderLine: r.l.no, item: r.l.item, itemName: r.l.itemName || '', qtyKg: v, shipCode: sc,
        shipAddress: shipto.find((s) => s.shipCode === sc)?.address || '', packing: r.l.packing || '', warehouse: lineWh(order, r.l, 'out') });
    }
    if (!lines.length) return setErr('Nhập số lượng cần xuất cho ít nhất 1 dòng.');
    setBusy(true);
    try {
      const head = { orderId: order.id, orderRef: order.refNo || '', company: order.company || '', partyCode: order.partyCode || '', partyName: order.partyName || '',
        sales: order.sales || '', salesName: order.salesName || '', date, note: note.trim() };
      if (plan) await updatePlan(plan.id, { ...head, lines: lines.map((l) => ({ ...l, doneKg: 0 })) }, { email, name });
      else await createPlan({ ...head, lines }, { email, name });
      onClose();
    } catch (e) {
      setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập dự kiến xuất cho đơn này.' : e.message);
    }
    setBusy(false);
  };

  return (
    <Modal title={plan ? `Sửa dự kiến xuất ${plan.id}` : 'Tạo dự kiến xuất kho'} onClose={onClose} wide>
      <div className="form-grid">
        <Field label="Đơn bán (SO)" required>
          <select value={oid} disabled={!!plan} onChange={(e) => { setOid(e.target.value); setQty({}); setShip({}); }}>
            <option value="">-- Chọn đơn bán --</option>
            {orderOpts.map((o) => <option key={o.id} value={o.id}>{o.id}{o.refNo ? ` (${o.refNo})` : ''} · {o.partyName || o.partyCode} · còn {kg(o.lines.reduce((s, l) => s + leftKg(l), 0))} kg</option>)}
          </select>
        </Field>
        <Field label="Ngày dự kiến xuất" required><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Ghi chú"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {order && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Mã hàng</th><th>Kiện/Xá</th><th>Kho (theo SO)</th><th className="num">SO còn phải giao</th><th className="num">Đã có dự kiến</th>
              <th className="num">SL cần xuất (kg)</th><th>Mã giao{myShips.length > 1 && <b className="req"> *</b>}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.l.no}>
                  <td>{r.l.item}<div className="small">{r.l.itemName}</div></td>
                  <td>{r.l.packing || ''}</td>
                  <td className="small">{lineWh(order, r.l, 'out') || 'chưa chọn'}</td>
                  <td className="num">{kg(r.left)}</td>
                  <td className="num">{r.inPlans ? kg(r.inPlans) : ''}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <input type="number" min="0" step="any" style={{ width: 110 }} value={qty[r.l.no] ?? ''} onChange={(e) => setQty((x) => ({ ...x, [r.l.no]: e.target.value }))} />
                    {r.free > 0.001 && !qty[r.l.no] && <button type="button" className="btn ghost sm" title="Lấy hết phần còn lại" onClick={() => setQty((x) => ({ ...x, [r.l.no]: String(Math.round(r.free * 1000) / 1000) }))}>hết</button>}
                  </td>
                  <td>
                    <WithAdd cat="shipto" preset={{ customerCode: order.partyCode, customerName: order.partyName }} onAdded={(id, rec) => setShip((x) => ({ ...x, [r.l.no]: rec?.shipCode || id }))}>
                      <select value={ship[r.l.no] || ''} onChange={(e) => setShip((x) => ({ ...x, [r.l.no]: e.target.value }))}>
                        <option value="">-- Chọn --</option>
                        {myShips.map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
                      </select>
                    </WithAdd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty text="Đơn này không còn hàng phải giao" />}
        </div>
      )}
      <ErrorBox error={err} />
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu dự kiến xuất'}</button>
        <button className="btn" onClick={onClose}>Đóng</button>
      </div>
    </Modal>
  );
}
