import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useOrders, useWaitingOut } from '../../lib/hooks';
import { OPEN_STATUSES, leftKg, lineDue, lineShip, lineWh } from '../../lib/orders';
import { useOrderSecrets, viewOrder } from '../../lib/orderSecrets';
import { useOrderMoney } from '../../lib/orderMoney';
import { isUSD } from '../../lib/currency';
import { OPEN_PLAN, PLAN_STATUS, createPlan, planLeft, plannedByLine, updatePlan, usePlans } from '../../lib/shipPlans';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtNum, matchQ, norm } from '../../lib/utils';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { WithAdd } from '../../components/FormTools';
import Select from '../../components/Select';

const kg = (v) => fmtNum(Number(v) || 0, 2);
const r3 = (x) => Math.round(x * 1000) / 1000;

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
  // Mở thẳng form tạo dự kiến xuất từ menu / thanh yêu thích (?new=1)
  useEffect(() => { if (params.get('new') === '1' && canPlan) setEdit({}); }, [params.get('new')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState('');

  const list = useMemo(() => {
    const f = norm(q);
    return plans.filter((p) => (fStatus === 'all' || (fStatus === 'open' ? OPEN_PLAN.includes(p.status) : p.status === fStatus))
      && (!from || (p.date || '') >= from) && (!to || (p.date || '') <= to)
      && (!f || norm([p.id, p.orderId, p.orderRef, p.partyCode, p.partyName, p.salesName, p.sales, p.note, ...(p.lines || []).flatMap((l) => [l.item, l.itemName, l.shipCode])].join(' ')).includes(f)))
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id.localeCompare(b.id));
  }, [plans, fStatus, q, from, to]);

  // 1 xe đi nhiều SO: dự kiến cùng mã gộp xe (Sale tích nhiều SO khi tạo), hoặc kho tự tích nhiều dự kiến cùng khách để gộp
  const [pick, setPick] = useState([]);
  const groupOf = (p) => (p.groupId ? plans.filter((x) => x.groupId === p.groupId && OPEN_PLAN.includes(x.status)).sort((a, b) => a.id.localeCompare(b.id)) : []);
  const shipsOfPlans = (ps) => [...new Set(ps.flatMap((p) => (p.lines || []).filter((l) => planLeft(l) > 0.001).map((l) => l.shipCode || '')))];
  const gopLink = (ps, sc) => `/kho/out?plans=${ps.map((x) => x.id).join(',')}${sc ? `&ship=${encodeURIComponent(sc)}` : ''}`;
  const picked = pick.map((id) => plans.find((p) => p.id === id)).filter((p) => p && OPEN_PLAN.includes(p.status));
  const pickBad = picked.find((p) => p.partyCode !== picked[0].partyCode || (p.company || '') !== (picked[0].company || ''));
  const togglePick = (p) => setPick((x) => (x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id]));

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
        <Select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="open">Chờ lập phiếu (còn mở)</option>
          <option value="done">Đã lập phiếu xuất</option>
          <option value="cancelled">Đã hủy</option>
          <option value="all">Tất cả</option>
        </Select>
        <label className="small">Từ <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">đến <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <input type="search" placeholder="Tìm số dự kiến, SO, khách, mã hàng, mã giao…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={exportExcel}>⬇ Excel</button>
      </div>
      {canOut && picked.length > 0 && (
        <div className={pickBad ? 'error-box' : 'ok-box'} style={{ marginBottom: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>🚚 Đã tích {picked.length} dự kiến ({[...new Set(picked.map((p) => p.orderId))].join(', ')})</span>
          {pickBad ? <span>· chỉ gộp 1 xe các dự kiến cùng khách hàng và cùng công ty xuất ({pickBad.id}: {pickBad.partyCode}{pickBad.company ? `, ${pickBad.company}` : ''} khác {picked[0].partyCode}{picked[0].company ? `, ${picked[0].company}` : ''})</span>
            : shipsOfPlans(picked).map((sc) => <Link key={sc} className="btn primary sm" to={gopLink(picked, sc)}>📤 Lập phiếu xuất gộp 1 xe{shipsOfPlans(picked).length > 1 ? ` (${sc || 'chưa có mã giao'})` : ''}</Link>)}
          <button className="btn sm" onClick={() => setPick([])}>Bỏ chọn</button>
        </div>
      )}
      <ErrorBox error={error || err} />
      <div className="table-wrap">
        {!list.length ? <Empty text="Chưa có dự kiến xuất nào" /> : (
          <table>
            <thead><tr>
              {canOut && <th title="Tích nhiều dự kiến cùng khách để lập 1 phiếu xuất gộp (1 xe nhiều đơn)">🚚</th>}
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
                      {canOut && <td rowSpan={ls.length}>{open && <input type="checkbox" checked={pick.includes(p.id)} onChange={() => togglePick(p)} title="Tích để gộp 1 xe với dự kiến khác cùng khách" />}</td>}
                      <td rowSpan={ls.length} className="mono">{p.id}{p.note && <div className="small">{p.note}</div>}
                        {p.groupId && <div className="small" title="Sale lập chung 1 xe nhiều đơn">🚚 gộp xe: {(p.groupOrders || []).filter((x) => x !== p.orderId).join(', ')}</div>}</td>
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
                        {p.cancelReason && <div className="small">{p.cancelReason}</div>}
                        {p.carrier && <div className="small" title="Đơn vị vận tải (admin giao ở Vận chuyển → Chờ giao vận tải)">🚚 {p.carrier}</div>}</td>
                      <td rowSpan={ls.length} className="small">{saleName(p)}</td>
                      <td rowSpan={ls.length} style={{ whiteSpace: 'nowrap' }}>
                        {open && canOut && ships.map((s) => (blocked(s)
                          ? <div key={s}><span className="btn sm" aria-disabled="true" style={{ opacity: 0.5, cursor: 'not-allowed' }}
                            title={soWait.length ? `Đơn ${p.orderId} đã lập đủ phiếu xuất, đang chờ giải chấp hàng HTC: ${soWait.join(', ')}` : `Đơn ${p.orderId} không còn phần nào để xuất (đã giao đủ hoặc đã đóng)`}>
                            {soWait.length ? '⏳ Đã lập phiếu · chờ giải chấp' : '📤 SO không còn hàng phải giao'}{ships.length > 1 ? ` (${s || 'chưa có mã giao'})` : ''}</span></div>
                          : <div key={s}><Link className="btn primary sm" to={`/kho/out?plan=${p.id}${s ? `&ship=${encodeURIComponent(s)}` : ''}`}>📤 Lập phiếu xuất{ships.length > 1 ? ` (${s || 'chưa có mã giao'})` : ''}</Link></div>
                        ))}
                        {open && canOut && (() => {
                          const g = groupOf(p);
                          if (g.length < 2 || g[0].id !== p.id) return null;
                          return shipsOfPlans(g).map((sc) => <div key={'g' + sc}><Link className="btn primary sm" to={gopLink(g, sc)} title={`1 xe giao ${g.length} đơn: ${g.map((x) => x.orderId).join(', ')}`}>
                            🚚 Xuất gộp 1 xe ({g.length} đơn){shipsOfPlans(g).length > 1 ? ` · ${sc || 'chưa có mã giao'}` : ''}</Link></div>);
                        })()}
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
        onClose={() => { setEdit(null); if (params.get('so') || params.get('new')) setParams({}); }} />}
    </div>
  );
}

// Tạo / sửa dự kiến xuất: chọn dòng đơn từ BẢNG (tìm theo khách, mã hàng, số SO; mỗi dòng SO đủ thông tin: ngày giao, kho, mã giao, đơn giá…)
// Tích nhiều dòng của nhiều SO cùng khách, cùng công ty xuất = 1 xe đi nhiều đơn: lưu mỗi SO 1 dự kiến, chung mã gộp xe
function PlanForm({ plan, orderId, plans, onClose }) {
  const { email, name } = useApp();
  const { rows: orders } = useOrders('SO', true);
  const shipto = useCollection('shipto').rows;
  // Đơn giá: chỉ hiện khi người dùng được xem trường giá (giá bán riêng tư theo Sale / người được xem)
  const { headSeen, lineSeen, priceKey } = useOrderMoney('SO');
  const secMap = useOrderSecrets('SO');
  const priceField = lineSeen.find((f) => f.key === priceKey);
  const [date, setDate] = useState(plan?.date || vnDate());
  const [note, setNote] = useState(plan?.note || '');
  // Đơn vị vận tải: chỉ định ở đây thì chuyến tự vào Vận chuyển → Chờ giao vận tải để admin kiểm tra, giao
  const carriers = useCollection('carriers').rows.filter((c) => c.active !== false);
  const [carrier, setCarrier] = useState(plan?.carrier ?? null);
  // Dòng đã chọn: `${SO}#${dòng}` → { qty, ship }
  const [sel, setSel] = useState(() => Object.fromEntries((plan?.lines || []).map((l) => [`${plan.orderId}#${l.orderLine}`, { qty: String(l.qtyKg), ship: l.shipCode || '' }])));
  const [q, setQ] = useState('');
  const [fCo, setFCo] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const planned = useMemo(() => plannedByLine(plans, plan?.id), [plans, plan]);
  const shipsOf = (cust) => shipto.filter((s) => s.customerCode === cust);

  // Mỗi dòng SO còn phải giao = 1 dòng bảng
  const all = useMemo(() => orders.filter((o) => OPEN_STATUSES.includes(o.status) && (!plan || o.id === plan.orderId)).flatMap((o0) => {
    const o = viewOrder(o0, secMap, headSeen, lineSeen);
    return (o.lines || []).map((l) => {
      const left = leftKg(l);
      const inPlans = planned[o.id]?.[l.no] || 0;
      return { key: `${o.id}#${l.no}`, o, l, left, inPlans, free: Math.max(0, left - inPlans), wh: lineWh(o, l, 'out'), due: lineDue(o, l), ship: lineShip(o, l),
        price: priceField ? l[priceKey] : '' };
    });
  }).filter((r) => r.left > 0.001 || sel[r.key])
    .sort((a, b) => String(a.o.partyCode).localeCompare(String(b.o.partyCode)) || String(a.l.item).localeCompare(String(b.l.item))
      || String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.o.id.localeCompare(b.o.id)),
  [orders, secMap, headSeen, lineSeen, planned, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const byKey = useMemo(() => new Map(all.map((r) => [r.key, r])), [all]);
  const chosen = Object.keys(sel).map((k) => byKey.get(k)).filter(Boolean);
  // Gộp 1 xe chỉ trong cùng khách hàng + cùng công ty xuất
  const anchor = chosen[0]?.o;
  const clash = (r) => anchor && (r.o.partyCode !== anchor.partyCode || (r.o.company || '') !== (anchor.company || ''));
  const companies = [...new Set(all.map((r) => r.o.company || '').filter(Boolean))].sort();
  // Mở từ SO (?so=…): chọn sẵn các dòng còn lại của SO đó, bảng lọc theo khách để tích thêm đơn khác cùng xe
  const pre = useRef(false);
  useEffect(() => {
    if (pre.current || plan || !orderId || !all.length) return;
    pre.current = true;
    const rs = all.filter((r) => r.o.id === orderId && r.free > 0.001);
    if (!rs.length) return;
    setQ(rs[0].o.partyCode || '');
    setSel(Object.fromEntries(rs.map((r) => [r.key, { qty: String(r3(r.free)), ship: defShip(r) }])));
  }, [all.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const defShip = (r) => {
    const my = shipsOf(r.o.partyCode);
    return r.ship || (my.length === 1 ? my[0].shipCode : '');
  };
  const toggle = (r) => setSel((x) => {
    if (x[r.key]) { const { [r.key]: _gone, ...rest } = x; return rest; }
    return { ...x, [r.key]: { qty: r.free > 0.001 ? String(r3(r.free)) : '', ship: defShip(r) } };
  });
  const setOne = (k, patch) => setSel((x) => ({ ...x, [k]: { ...x[k], ...patch } }));

  const shown = useMemo(() => all.filter((r) => (!fCo || (r.o.company || '') === fCo)
    && matchQ(q, r.o.id, r.o.refNo, r.o.partyCode, r.o.partyName, r.l.item, r.l.itemName, r.ship, r.wh, r.o.company, r.o.salesName, r.l.packing)),
  [all, q, fCo]);
  const LIMIT = 300;
  const carrierOpts = [...new Set(chosen.map((r) => r.l.carrier).filter(Boolean))];
  const carrierVal = carrier ?? (carrierOpts.length === 1 ? carrierOpts[0] : '');
  const money = (r) => {
    if (r.price === '' || r.price == null || r.price === undefined) return '';
    const v = Number(String(r.price).replace(/,/g, ''));
    return Number.isFinite(v) && String(r.price).trim() !== '' ? `${fmtNum(v, isUSD(r.o) ? 2 : 0)}${isUSD(r.o) ? ' USD' : ''}` : String(r.price);
  };

  const save = async () => {
    setErr('');
    if (!date) return setErr('Chọn ngày dự kiến xuất.');
    if (!chosen.length) return setErr('Tích chọn ít nhất 1 dòng đơn trong bảng.');
    if (chosen.some(clash)) return setErr('Chỉ gộp 1 xe các dòng cùng khách hàng và cùng công ty xuất. Bỏ tích các dòng khác khách / khác công ty.');
    const byOrder = new Map();
    for (const r of chosen) {
      const { qty, ship } = sel[r.key];
      const v = Number(qty) || 0;
      if (v <= 0) return setErr(`${r.o.id} · ${r.l.item}: nhập số lượng cần xuất (hoặc bỏ tích dòng).`);
      const max = r.free * (1 + (Number(r.o.tolerancePct) || 0) / 100);
      if (v > max + 0.5) return setErr(`${r.o.id} · ${r.l.item}: chỉ còn ${kg(r.free)} kg chưa có dự kiến xuất (SO còn ${kg(r.left)} kg, các dự kiến khác ${kg(r.inPlans)} kg).`);
      const my = shipsOf(r.o.partyCode);
      if (!ship && my.length > 1) return setErr(`${r.o.id} · ${r.l.item}: khách ${r.o.partyCode} có ${my.length} mã giao, chọn mã giao.`);
      if (ship && my.length && !my.some((s) => s.shipCode === ship)) return setErr(`${r.o.id} · ${r.l.item}: mã giao ${ship} không thuộc khách ${r.o.partyCode}.`);
      if (!byOrder.has(r.o.id)) byOrder.set(r.o.id, { o: r.o, lines: [] });
      byOrder.get(r.o.id).lines.push({ orderLine: r.l.no, item: r.l.item, itemName: r.l.itemName || '', qtyKg: v, shipCode: ship || '',
        shipAddress: shipto.find((s) => s.shipCode === ship)?.address || '', packing: r.l.packing || '', warehouse: r.wh });
    }
    const groups = [...byOrder.values()];
    const groupId = groups.length > 1 ? `GD${Date.now().toString(36).toUpperCase()}` : '';
    setBusy(true);
    try {
      for (const g of groups) {
        const o = g.o._raw || g.o;
        const head = { orderId: o.id, orderRef: o.refNo || '', company: o.company || '', partyCode: o.partyCode || '', partyName: o.partyName || '',
          sales: o.sales || '', salesName: o.salesName || '', date, note: note.trim(), carrier: carrierVal,
          ...(groupId ? { groupId, groupOrders: groups.map((x) => x.o.id) } : {}) };
        if (plan) await updatePlan(plan.id, { ...head, lines: g.lines.map((l) => ({ ...l, doneKg: 0 })) }, { email, name });
        else await createPlan({ ...head, lines: g.lines }, { email, name });
      }
      onClose();
    } catch (e) {
      setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập dự kiến xuất cho đơn này.' : e.message);
    }
    setBusy(false);
  };

  const nOrders = new Set(chosen.map((r) => r.o.id)).size;
  return (
    <Modal title={plan ? `Sửa dự kiến xuất ${plan.id}` : 'Tạo dự kiến xuất kho'} onClose={onClose} wide>
      <div className="form-grid">
        <Field label="Ngày dự kiến xuất" required><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Đơn vị vận tải"><WithAdd cat="carriers" onAdded={(id) => setCarrier(id)}><Select value={carrierVal} onChange={(e) => setCarrier(e.target.value)}>
          <option value="">-- Chưa chỉ định --</option>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</Select></WithAdd></Field>
        <Field label="Ghi chú"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <div className="section-head" style={{ marginTop: 10 }}>1. Chọn dòng đơn bán (SO) {!plan && <span className="small">· tích nhiều dòng, nhiều SO cùng khách = 1 xe đi nhiều đơn</span>}</div>
      <div className="filters">
        <input type="search" autoFocus placeholder="Tìm khách hàng, mã hàng, số SO, mã giao, kho…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
        {companies.length > 1 && <Select value={fCo} onChange={(e) => setFCo(e.target.value)}>
          <option value="">Mọi công ty xuất</option>{companies.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}
        <span className="small">{shown.length} dòng</span>
      </div>
      <div className="table-wrap plan-pick" style={{ maxHeight: 340, overflow: 'auto' }}>
        <table>
          <thead><tr><th></th><th>Đơn bán</th><th>Ngày đơn</th><th>Công ty</th><th>Khách hàng</th><th>Mã hàng</th><th>Kiện/Xá</th><th>Kho</th><th>Ngày giao</th><th>Mã giao</th>
            {priceField && <th className="num">{priceField.label}</th>}<th className="num">SO còn (kg)</th><th className="num">Đã có dự kiến</th><th className="num">Còn lập được</th><th>Sale</th></tr></thead>
          <tbody>
            {shown.slice(0, LIMIT).map((r) => {
              const on = !!sel[r.key];
              const bad = !on && clash(r);
              return (
                <tr key={r.key} className={on ? 'row-on' : ''} style={{ cursor: bad ? 'not-allowed' : 'pointer', opacity: bad ? 0.45 : 1 }}
                  title={bad ? `Khác khách hàng / công ty xuất với dòng đã chọn (${anchor.partyCode}${anchor.company ? `, ${anchor.company}` : ''}): không gộp chung xe` : ''}
                  onClick={() => !bad && (r.free > 0.001 || on) && toggle(r)}>
                  <td><input type="checkbox" checked={on} disabled={bad || (!on && r.free <= 0.001)} readOnly /></td>
                  <td className="mono">{r.o.id}{r.o.refNo && <div className="small">{r.o.refNo}</div>}</td>
                  <td>{fmtDate(r.o.date)}</td>
                  <td>{r.o.company || ''}</td>
                  <td>{r.o.partyCode}<div className="small">{r.o.partyName}</div></td>
                  <td><b>{r.l.item}</b><div className="small">{r.l.itemName}</div></td>
                  <td>{r.l.packing || ''}</td>
                  <td>{r.wh || <span className="small">chưa chọn</span>}</td>
                  <td>{fmtDate(r.due)}</td>
                  <td>{r.ship}</td>
                  {priceField && <td className="num">{money(r)}</td>}
                  <td className="num">{kg(r.left)}</td>
                  <td className="num">{r.inPlans ? kg(r.inPlans) : ''}</td>
                  <td className="num"><b>{kg(r.free)}</b></td>
                  <td className="small">{r.o.salesName || r.o.sales || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && <Empty text={q ? 'Không có dòng đơn nào khớp' : 'Không có đơn bán nào còn hàng phải giao'} />}
        {shown.length > LIMIT && <p className="small">Đang hiện {LIMIT}/{shown.length} dòng: gõ thêm từ khóa để lọc.</p>}
      </div>
      {chosen.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 10 }}>2. Số lượng cần xuất, mã giao ({chosen.length} dòng · {nOrders} đơn{nOrders > 1 ? ' · 🚚 1 xe gộp nhiều đơn' : ''})</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Đơn bán</th><th>Mã hàng</th><th>Kiện/Xá</th><th>Kho (theo SO)</th>{priceField && <th className="num">{priceField.label}</th>}<th className="num">Còn lập được</th>
                <th className="num">SL cần xuất (kg)</th><th>Mã giao</th><th></th></tr></thead>
              <tbody>
                {chosen.map((r) => {
                  const my = shipsOf(r.o.partyCode);
                  const v = sel[r.key];
                  return (
                    <tr key={r.key} className={clash(r) ? 'row-bad' : ''}>
                      <td className="mono">{r.o.id}<div className="small">{r.o.partyCode}</div></td>
                      <td>{r.l.item}<div className="small">{r.l.itemName}</div></td>
                      <td>{r.l.packing || ''}</td>
                      <td className="small">{r.wh || 'chưa chọn'}</td>
                      {priceField && <td className="num">{money(r)}</td>}
                      <td className="num">{kg(r.free)}</td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        <input type="number" min="0" step="any" style={{ width: 110 }} value={v.qty} onChange={(e) => setOne(r.key, { qty: e.target.value })} />
                        {r.free > 0.001 && Number(v.qty) !== r3(r.free) && <button type="button" className="btn ghost sm" title="Lấy hết phần còn lại" onClick={() => setOne(r.key, { qty: String(r3(r.free)) })}>hết</button>}
                      </td>
                      <td>
                        <WithAdd cat="shipto" preset={{ customerCode: r.o.partyCode, customerName: r.o.partyName }} onAdded={(id, rec) => setOne(r.key, { ship: rec?.shipCode || id })}>
                          <Select value={v.ship || ''} onChange={(e) => setOne(r.key, { ship: e.target.value })}>
                            <option value="">-- Chọn --</option>
                            {my.map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
                          </Select>
                        </WithAdd>
                      </td>
                      <td><button type="button" className="btn ghost sm" title="Bỏ dòng" onClick={() => toggle(r)}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><td colSpan={priceField ? 6 : 5}>Cộng</td><td className="num"><b>{kg(chosen.reduce((a, r) => a + (Number(sel[r.key].qty) || 0), 0))}</b></td><td colSpan={2}></td></tr></tfoot>
            </table>
          </div>
          {nOrders > 1 && <p className="hint">Lưu thành {nOrders} dự kiến (mỗi SO 1 dự kiến) chung 1 mã gộp xe. Kho bấm <b>📤 Lập phiếu xuất gộp</b> sẽ ra 1 phiếu soạn hàng (cùng mã hàng gộp 1 dòng) và 1 phiếu giao hàng ghi đủ các SO.</p>}
        </>
      )}
      <ErrorBox error={err} />
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : nOrders > 1 ? `Lưu dự kiến xuất (${nOrders} đơn, 1 xe)` : 'Lưu dự kiến xuất'}</button>
        <button className="btn" onClick={onClose}>Đóng</button>
      </div>
    </Modal>
  );
}
