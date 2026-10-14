import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useOpCompany, useOpWarehouse, useOrders, usePendingIn, useWaitingOut } from '../../lib/hooks';
import { OPEN_PLAN, planLeft, plannedByLine, usePlans } from '../../lib/shipPlans';
import { DO_SOURCES, doSource, orderTypeOf, useSlips } from '../../lib/slips';
import { leftKg, lineShip, lineWh, lineTo, orderTotals, OPEN_STATUSES, stoRoute, transitKg } from '../../lib/orders';
import { stepOf } from '../../lib/moveCodes';
import { vnDate } from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { usePref } from '../../lib/prefs';
import { CompanyPicker, WarehousePicker } from '../../components/TripBits';
import { Empty, ErrorBox } from '../../components/ui';
import { MovementDetail } from '../stock/Movements';
import EditSlip, { canEditSlip } from '../../components/EditSlip';

const n = (v) => Number(v) || 0;
const kgOf = (m) => (m.lines || []).reduce((a, l) => a + n(l.kg), 0);
const t = (kg) => fmtNum(n(kg), 2);
const addDays = (ymd, d) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const uniq = (a) => [...new Set(a.filter(Boolean))];
const lineDueOf = (o, l) => l.dueDate || o.dueDate || '';

// Nhóm tình trạng để lọc: đang chờ (chưa ghi tồn / STO chưa lập phiếu nhập), hoàn thành, đã hủy
const bucketOf = (r) => (r.virtual ? 'doing' : r.m.status === 'cancelled' ? 'cancelled' : ['pending', 'wait_release'].includes(r.m.status) ? 'doing' : 'done');

// kind 'DO': mọi phiếu xuất theo SO / STO (lập trực tiếp, từ Dự kiến xuất kho, từ đơn của Kế hoạch phân bổ, theo chuyến xe)
// kind 'IN': Danh sách đơn chờ nhập — phiếu nhập đã lập theo PO / STO và STO đã xuất, đang đi đường chưa lập phiếu nhập
export default function SlipList({ kind, loai = '' }) {
  const isDO = kind === 'DO';
  const { inMyWarehouses, salesOnly, isAdmin, hasRole } = useApp();
  const [range, setRange] = useState({ from: addDays(vnDate(), -30), to: vnDate() });
  const [wh, setWh] = useOpWarehouse();
  const [co, setCo] = useOpCompany();
  const [oTypePref, setOType] = usePref(`slips:${kind}:type`, '');
  // Mở từ nhóm Chuyển kho (?loai=STO): chỉ STO; mở từ nhóm Bán / Mua: theo lựa chọn đã nhớ
  const [oTypeUrl, setOTypeUrl] = useState(loai);
  const oType = oTypeUrl || oTypePref;
  const [fStep, setFStep] = usePref(`slips:${kind}:step`, isDO ? '' : 'doing');
  const [fSrc, setFSrc] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  const { rows: slips, error } = useSlips(isDO ? 'out' : 'in', range.from, range.to, isDO ? 'wait_release' : 'pending');
  const { rows: orders } = useOrders('');
  const orderMap = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const pendIn = usePendingIn();
  const waitOut = useWaitingOut();
  const types = isDO ? ['SO', 'STO'] : ['PO', 'STO'];
  // DO: thêm các dòng chờ lập phiếu xuất từ Dự kiến xuất kho và Kế hoạch phân bổ (đã gắn / đã tạo SO)
  const { rows: plans } = usePlans();
  const allocs = useCollection(isDO ? 'allocations' : '').rows;

  const rows = useMemo(() => {
    const out = slips
      .filter((m) => m.orderId && types.includes(orderTypeOf(m)))
      .map((m) => {
        const o = orderMap.get(m.orderId);
        return { key: m.id, m, o, type: orderTypeOf(m), src: isDO ? doSource(m, o, allocs) : null };
      });
    // STO đã xuất ở kho đi, chưa lập phiếu nhập ở kho đến: hiện thành dòng "chưa lập phiếu nhập"
    if (!isDO) {
      for (const o of orders) {
        if (o.type !== 'STO' || o.status === 'cancelled') continue;
        const left = (o.lines || []).reduce((a, l) => a + Math.max(0, transitKg(l) - (pendIn.get(o.id)?.byLine?.[l.no] || 0)), 0);
        if (left > 0.001) out.push({ key: 'v:' + o.id, virtual: true, o, type: 'STO', left, m: { id: '', orderId: o.id, date: o.lastShipDate || o.date, warehouse: uniq((o.lines || []).filter((l) => transitKg(l) > 0).map((l) => lineTo(o, l))).join(', '), lines: (o.lines || []).filter((l) => transitKg(l) > 0).map((l) => ({ item: l.item, kg: transitKg(l) })) } });
      }
    }
    if (isDO) {
      // Phần SO còn lập DO được = còn phải giao − DO chờ giải chấp
      const free = (o, l) => leftKg(l) - (waitOut.get(o.id)?.byLine?.[l.no] || 0);
      // 1) Dự kiến xuất còn mở: mỗi dự kiến 1 dòng chờ lập DO
      const usedByPlan = {};
      for (const p of plans) {
        if (!OPEN_PLAN.includes(p.status)) continue;
        const o = orderMap.get(p.orderId);
        if (!o || !OPEN_STATUSES.includes(o.status)) continue;
        const ls = (p.lines || []).map((l) => {
          const ol = (o.lines || []).find((x) => x.no === l.orderLine);
          const k = `${o.id}#${l.orderLine}`;
          const kgLeft = ol ? Math.max(0, Math.min(planLeft(l), free(o, ol) - (usedByPlan[k] || 0))) : 0;
          usedByPlan[k] = (usedByPlan[k] || 0) + kgLeft;
          return { ...l, kg: kgLeft };
        }).filter((l) => l.kg > 0.001);
        if (!ls.length) continue;
        out.push({ key: 'p:' + p.id, virtual: 'plan', o, type: 'SO', left: ls.reduce((a, l) => a + l.kg, 0), plan: p, ships: [...new Set(ls.map((l) => l.shipCode || ''))],
          src: { key: 'plan', label: '📅 Dự kiến xuất', ref: p.id },
          m: { id: '', orderId: o.id, date: p.date || '', warehouse: uniq(ls.map((l) => l.warehouse || lineWh(o, (o.lines || []).find((x) => x.no === l.orderLine) || {}))).join(', '), shipCode: uniq(ls.map((l) => l.shipCode)).join(', '), lines: ls } });
      }
      // 2) Kế hoạch phân bổ đã gắn / tạo SO: phần chưa có DO, chưa nằm trong dự kiến xuất
      const planned = plannedByLine(plans);
      const byLine = new Map();
      for (const a of allocs) {
        if (a.status === 'cancelled' || a.orderType !== 'SO' || !a.orderId) continue;
        const k = `${a.orderId}#${a.orderLine}`;
        const g = byLine.get(k) || { orderId: a.orderId, no: a.orderLine, kg: 0, rows: [] };
        g.kg += n(a.qtyKg); g.rows.push(a);
        byLine.set(k, g);
      }
      for (const g of byLine.values()) {
        const o = orderMap.get(g.orderId);
        const ol = (o?.lines || []).find((x) => x.no === g.no);
        if (!o || !ol || !OPEN_STATUSES.includes(o.status)) continue;
        const kgLeft = Math.min(g.kg, free(o, ol) - (planned[o.id]?.[g.no] || 0));
        if (kgLeft <= 0.001) continue;
        const a0 = g.rows[0];
        // Hàng mua chưa về: PO của dòng phân bổ chưa nhập kg nào
        const po = orderMap.get(a0.poId);
        const pol = (po?.lines || []).find((x) => x.no === a0.poLine);
        const notIn = !!pol && !(n(pol.doneKg) > 0);
        out.push({ key: 'a:' + o.id + '#' + g.no, virtual: 'alloc', o, type: 'SO', left: kgLeft, notIn, alloc: a0,
          src: { key: 'alloc', label: '📋 Kế hoạch phân bổ', ref: [a0.poId, a0.contNo].filter(Boolean).join(' · ') },
          m: { id: '', orderId: o.id, date: lineDueOf(o, ol) || a0.date || '', warehouse: lineWh(o, ol) || a0.fromWarehouse || '', shipCode: lineShip(o, ol) || a0.shipCode || '', lines: [{ item: ol.item, itemName: ol.itemName, kg: kgLeft }] } });
      }
    }
    return out;
  }, [slips, orders, orderMap, pendIn, waitOut, plans, allocs, isDO]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const f = norm(q);
    return rows
      .filter((r) => !r.m.warehouse || r.m.warehouse.split(', ').some((w) => inMyWarehouses(w)))
      .filter((r) => !wh || r.m.warehouse === wh || (r.virtual && r.m.warehouse.split(', ').includes(wh)))
      .filter((r) => !co || r.o?.company === co || r.m.company === co || (r.m.lines || []).some((l) => l.company === co))
      .filter((r) => !salesOnly || r.o) // Sale chỉ thấy phiếu của đơn mình phụ trách
      .filter((r) => !oType || r.type === oType)
      .filter((r) => !fStep || bucketOf(r) === fStep)
      .filter((r) => !fSrc || r.src?.key === fSrc)
      .filter((r) => !f || norm([r.m.id, r.m.orderId, r.o?.refNo, r.o?.partyCode, r.o?.partyName, r.m.partyName, r.m.plate, r.m.driverName, r.m.carrierName, r.m.shipCode, r.m.planId, r.m.warehouse, ...(r.m.lines || []).flatMap((l) => [l.item, l.itemName, l.lot])].join(' ')).includes(f))
      // Đang chờ lên đầu, rồi mới nhất trước
      .sort((a, b) => (bucketOf(b) === 'doing') - (bucketOf(a) === 'doing') || String(b.m.date).localeCompare(String(a.m.date)) || String(b.m.createdAt || '').localeCompare(String(a.m.createdAt || '')));
  }, [rows, q, wh, co, oType, fStep, fSrc, inMyWarehouses, salesOnly]);

  const sum = list.reduce((s, r) => ({ n: s.n + 1, kg: s.kg + (r.virtual ? r.left : r.m.status === 'cancelled' ? 0 : kgOf(r.m)), doing: s.doing + (bucketOf(r) === 'doing' ? 1 : 0), done: s.done + (bucketOf(r) === 'done' ? 1 : 0) }), { n: 0, kg: 0, doing: 0, done: 0 });
  const current = open && slips.find((m) => m.id === open);
  const editing = edit && slips.find((m) => m.id === edit);

  // Đơn còn lại sau các phiếu: SO/STO còn phải xuất (trừ phiếu chờ giải chấp), PO còn phải nhập / STO đang đi đường (trừ phiếu chờ nhận)
  const orderLeft = (r) => {
    const o = r.o;
    if (!o) return null;
    if (isDO) return Math.max(0, orderTotals(o).left - (o.lines || []).reduce((a, l) => a + (waitOut.get(o.id)?.byLine?.[l.no] || 0), 0));
    const pend = (o.lines || []).reduce((a, l) => a + (pendIn.get(o.id)?.byLine?.[l.no] || 0), 0);
    return Math.max(0, (o.type === 'STO' ? orderTotals(o).transit : (OPEN_STATUSES.includes(o.status) ? orderTotals(o).left : 0)) - pend);
  };
  const party = (r) => (r.type === 'STO' ? (r.o ? stoRoute(r.o) : '') : r.o?.partyName || r.m.partyName || r.o?.partyCode || r.m.partyCode || '');
  const statusCell = (r) => {
    if (r.virtual === 'plan') return <span className="badge amber" title="Sale đã lập dự kiến xuất, kho chưa lập phiếu xuất">📅 Chờ lập DO</span>;
    if (r.virtual === 'alloc') return r.notIn ? <span className="badge" title={`PO ${r.alloc.poId} chưa nhập kho: hàng về thì lập DO`}>⏳ Chờ hàng về · {r.alloc.poId}</span>
      : <span className="badge amber" title="Kế hoạch phân bổ đã gắn SO, kho chưa lập phiếu xuất">📋 Chờ lập DO</span>;
    if (r.virtual) return <span className="badge amber" title="Kho đi đã xuất, hàng đang đi đường; chưa lập phiếu nhập ở kho đến">🚚 Đang đi đường · chưa lập phiếu nhập</span>;
    const st = stepOf(r.m);
    return <span className={'badge ' + st.tone} title={st.title}>{st.label}</span>;
  };
  const actions = (r) => {
    const m = r.m;
    if (r.virtual === 'plan') return hasRole('thu_kho') ? r.ships.map((sc) => <Link key={sc} className="btn sm primary" to={`/kho/out?plan=${r.plan.id}&ship=${encodeURIComponent(sc)}`}>📤 Lập DO{r.ships.length > 1 ? ` (${sc || 'chưa có mã giao'})` : ''}</Link>) : null;
    if (r.virtual === 'alloc') return hasRole('thu_kho') ? <Link className={'btn sm' + (r.notIn ? '' : ' primary')} to={`/kho/out?order=${r.o.id}`}>📤 Lập DO</Link> : null;
    if (r.virtual) return isAdmin ? <Link className="btn sm primary" to={`/kho/in?order=${r.o.id}`}>📥 Lập phiếu nhập</Link> : null;
    if (m.status === 'cancelled') return null;
    return (
      <>
        {m.status === 'pending' && hasRole('thu_kho') && <Link className="btn sm primary" to={`/kho/nhan-hang/${m.id}`}>📥 Nhận hàng</Link>}
        {m.status === 'wait_release' && <Link className="btn sm" to="/kho/giai-chap">🔓 Giải chấp</Link>}
        <Link className="btn sm" to={`/kho/phieu/${m.id}/in`} target="_blank">🖨</Link>
        {m.type === 'out' && <Link className="btn sm" to={`/kho/phieu/${m.id}/soan`} target="_blank" title="Phiếu soạn hàng">📋</Link>}
        {m.type === 'in' && m.status === 'posted' && <Link className="btn sm" to={`/kho/phieu/${m.id}/nhan`} target="_blank" title="In nhãn pallet">🏷️</Link>}
        {canEditSlip(m, { isAdmin, hasRole, inMyWarehouses }) && <button type="button" className="btn sm" onClick={() => setEdit(m.id)}>✏️ Sửa</button>}
      </>
    );
  };

  const exportExcel = () => {
    const out = [];
    list.forEach((r) => (r.m.lines || []).forEach((l) => out.push({
      [isDO ? 'Số DO (phiếu xuất)' : 'Số phiếu nhập']: r.m.id || '(chưa lập)', Ngày: r.m.date, 'Loại đơn': r.type, 'Số đơn': r.m.orderId, 'Số Ecount': r.o?.refNo || '',
      ...(isDO ? { Nguồn: r.src?.label.replace(/^\S+\s/, '') || '', 'Số dự kiến / PO phân bổ / chuyến': r.src?.ref || '', 'Mã giao': r.m.shipCode || '' } : {}),
      [isDO ? 'Khách / tuyến' : 'NCC / tuyến']: party(r), Kho: r.m.warehouse, 'Công ty': r.o?.company || r.m.company || '',
      'Mã hàng': l.item, 'Tên hàng': l.itemName || '', Lot: l.lot || '', 'Vị trí': l.location || '', 'Số kg': n(l.kg), 'Pallet': n(l.pallets), 'Số bao': n(l.bags),
      'Số xe': r.m.plate || '', 'Đơn vị vận tải': r.m.carrierName || r.m.carrier || '', 'Tài xế': r.m.driverName || '',
      'Tình trạng': r.virtual === 'plan' ? 'Chờ lập DO (dự kiến xuất)' : r.virtual === 'alloc' ? (r.notIn ? `Chờ hàng về (${r.alloc.poId})` : 'Chờ lập DO (kế hoạch phân bổ)') : r.virtual ? 'Đang đi đường · chưa lập phiếu nhập' : stepOf(r.m).label.replace(/^\S+\s/, ''),
      [isDO ? 'Đơn còn phải xuất (kg)' : 'Đơn còn phải nhập (kg)']: orderLeft(r) ?? '',
    })));
    exportSheets(`${isDO ? 'DO' : 'Don_cho_nhap'}_${range.from}_${range.to}`, { [isDO ? 'DO' : 'Đơn chờ nhập']: out.length ? out : [{ Ngày: '' }] });
  };

  return (
    <div>
      <p className="small" style={{ marginTop: 0 }}>
        {isDO ? <>Bước giữa SO / STO và giao hàng: mỗi phiếu xuất kho lập theo đơn là 1 <b>DO</b>, dù lập trực tiếp, từ <Link to="/du-kien-xuat">Dự kiến xuất kho</Link> hay từ đơn của <Link to="/phan-bo">Kế hoạch phân bổ</Link>. Dự kiến xuất và kế hoạch phân bổ đã gắn SO mà kho chưa lập phiếu hiện ở đây là <b>Chờ lập DO</b>. Lập DO là phần còn lại của đơn giảm theo; sửa / hủy DO thì đơn cập nhật lại.</>
          : <>PO / STO đã lập phiếu nhập kho (chờ thủ kho nhận hoặc đã nhập), và STO kho đi đã xuất nhưng chưa lập phiếu nhập. Sửa / hủy phiếu thì số đã nhận, còn phải nhập của đơn cập nhật lại.</>}
      </p>
      <div className="stats">
        <div className="stat"><div className="stat-label">{isDO ? 'Số DO' : 'Số dòng'} đang hiển thị</div><div className="stat-value">{sum.n}</div></div>
        <div className="stat"><div className="stat-label">Tổng kg</div><div className="stat-value">{t(sum.kg)} kg</div><div className="stat-sub">= {fmtNum(sum.kg / 1000, 3)} tấn</div></div>
        <div className="stat amber"><div className="stat-label">{isDO ? 'Đang chờ (chờ lập DO / giải chấp)' : 'Đang chờ nhập'}</div><div className="stat-value">{sum.doing}</div></div>
        <div className="stat green"><div className="stat-label">{isDO ? 'Đã xuất kho' : 'Đã nhập kho'}</div><div className="stat-value">{sum.done}</div></div>
      </div>
      <div className="filters">
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} title="Phiếu đang chờ luôn hiện, kể cả lập trước ngày này" />
        <span>→</span>
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        <WarehousePicker value={wh} onChange={setWh} />
        <CompanyPicker value={co} onChange={setCo} />
        <select value={oType} onChange={(e) => { setOTypeUrl(''); setOType(e.target.value); }}>
          <option value="">{isDO ? 'SO + STO' : 'PO + STO'}</option>
          {types.map((x) => <option key={x} value={x}>{x === 'SO' ? 'Đơn bán (SO)' : x === 'PO' ? 'Đơn mua (PO)' : 'Chuyển kho (STO)'}</option>)}
        </select>
        <select value={fStep} onChange={(e) => setFStep(e.target.value)}>
          <option value="">Mọi tình trạng</option>
          <option value="doing">{isDO ? 'Đang chờ (chờ lập DO / chờ giải chấp)' : 'Đang chờ nhập'}</option>
          <option value="done">{isDO ? 'Đã xuất kho' : 'Đã nhập kho'}</option>
          <option value="cancelled">Đã hủy</option>
        </select>
        {isDO && <select value={fSrc} onChange={(e) => setFSrc(e.target.value)}>
          <option value="">Mọi nguồn lập</option>
          {DO_SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>}
        <input type="search" placeholder="Tìm số phiếu, đơn, khách, mã hàng, số xe…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="actions" style={{ marginLeft: 'auto' }}><button className="btn" onClick={exportExcel}>⬇ Excel</button></div>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {!list.length ? <Empty text={isDO ? 'Chưa có DO trong khoảng ngày này' : 'Không có đơn chờ nhập'} /> : (
          <table>
            <thead><tr>
              <th>{isDO ? 'Số DO' : 'Số phiếu nhập'}</th><th>Ngày</th><th>Tình trạng</th>{isDO && <th>Nguồn lập</th>}<th>Đơn</th><th>{isDO ? 'Khách / tuyến' : 'NCC / tuyến'}</th>
              {isDO && <th>Mã giao</th>}<th>{isDO ? 'Kho xuất' : 'Kho nhập'}</th><th>Mặt hàng</th><th className="num">Số kg</th>{isDO && <th>Số xe</th>}
              <th className="num" title={isDO ? 'SL đơn − đã xuất − DO chờ giải chấp' : 'PO: SL đơn − đã nhận − phiếu chờ nhận; STO: đang đi đường − phiếu chờ nhận'}>{isDO ? 'Đơn còn phải xuất' : 'Đơn còn phải nhập'}</th><th></th>
            </tr></thead>
            <tbody>
              {list.map((r) => {
                const m = r.m;
                const left = orderLeft(r);
                return (
                  <tr key={r.key} onClick={() => !r.virtual && setOpen(m.id)} style={{ cursor: r.virtual ? 'default' : 'pointer', opacity: m.status === 'cancelled' ? 0.55 : 1 }}>
                    <td className="mono nowrap">{m.id || <span className="small">{isDO ? '(chưa lập DO)' : '(chưa lập)'}</span>}{m.editedAt ? <span className="badge" title="Phiếu đã được sửa, xem lịch sử trong chi tiết" style={{ marginLeft: 4 }}>đã sửa</span> : null}</td>
                    <td className="nowrap">{fmtDate(m.date)}</td>
                    <td className="nowrap">{statusCell(r)}</td>
                    {isDO && <td className="nowrap small">{r.src.label}{r.src.ref ? <div className="mono">{r.src.ref}</div> : null}</td>}
                    <td className="mono nowrap"><Link to={`/don-hang?tab=${r.type}&q=${m.orderId}`} onClick={(e) => e.stopPropagation()}>{m.orderId}</Link><div className="small">{r.type}{r.o?.refNo ? ` · ${r.o.refNo}` : ''}</div></td>
                    <td>{party(r)}</td>
                    {isDO && <td className="small">{m.shipCode || ''}</td>}
                    <td>{m.warehouse}</td>
                    <td>{uniq((m.lines || []).map((l) => l.item)).join(', ')}</td>
                    <td className="num"><b>{t(r.virtual ? r.left : kgOf(m))}</b></td>
                    {isDO && <td className="mono">{m.plate ? <span className="plate">{m.plate}</span> : <span className="small">–</span>}</td>}
                    <td className="num">{left == null ? '' : left > 0.001 ? t(left) : <span className="badge green">đủ</span>}</td>
                    <td className="nowrap" onClick={(e) => e.stopPropagation()}>{actions(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {current && <MovementDetail m={current} onClose={() => setOpen(null)} />}
      {editing && <EditSlip m={editing} onClose={() => setEdit(null)} />}
    </div>
  );
}
