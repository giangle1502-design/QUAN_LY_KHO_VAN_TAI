import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useOrders, usePendingIn } from '../../lib/hooks';
import { createOrder, leftKg, lineShip, lineWh, OPEN_STATUSES, ORDER_STATUS, orderTotals, RETURN_CONDITIONS, setOrderState, soReturnable } from '../../lib/orders';
import { MOVE_TYPES } from '../../lib/stock';
import { vnDate } from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, matchQ } from '../../lib/utils';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { WithAdd } from '../../components/FormTools';
import Select from '../../components/Select';

// ============================================================================
// SO trả hàng (DRT): khách từ chối nhận / trả lại hàng của 1 SO đã giao (số trả ≤ số đã giao).
// Lập từ SO gốc → là 1 IB (chờ nhập) ở "Danh sách đơn chờ nhập"; thủ kho lập phiếu nhập kho theo DRT (MVT 651):
// tồn kho tăng, "đã nhận về" của DRT và "khách trả về" của SO gốc cùng cập nhật.
// ============================================================================

const t = (kg) => fmtNum(Number(kg) || 0, 2);
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const canMakeDrt = (hasRole) => hasRole('kinh_doanh', 'ke_toan');

function Status({ s }) {
  const m = ORDER_STATUS[s] || { label: s };
  const label = { open: 'Chờ nhận về', partial: 'Đã nhận 1 phần', done: 'Đã nhận đủ' }[s] || m.label;
  return <span className={'badge ' + (m.tone || '')}>{label}</span>;
}

// Nút trên chi tiết SO
export function DrtButton({ so }) {
  const { hasRole } = useApp();
  const [open, setOpen] = useState(false);
  if (so.type !== 'SO' || so.status === 'cancelled' || !canMakeDrt(hasRole)) return null;
  if (!(so.lines || []).some((l) => n(l.doneKg) - n(l.returnedKg) > 0.001)) return null;
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} title="Khách từ chối nhận / trả lại hàng của SO này">↩ Tạo đơn trả hàng (DRT)</button>
      {open && <DrtCreate so={so} onClose={() => setOpen(false)} />}
    </>
  );
}

export function DrtCreate({ so, onClose, onDone }) {
  const { email, name } = useApp();
  const drts = useOrders('DRT').rows;
  const warehouses = useCollection('warehouses').rows;
  const reasons = useCollection('reasons').rows;
  const max = useMemo(() => soReturnable(so, drts), [so, drts]);
  const firstWh = (so.lines || []).map((l) => lineWh(so, l)).find(Boolean) || '';
  const [head, setHead] = useState({ date: vnDate(), warehouse: firstWh, note: '' });
  const [lines, setLines] = useState(() => (so.lines || []).filter((l) => n(l.doneKg) - n(l.returnedKg) > 0.001).map((l) => ({
    soLine: l.no, item: l.item, itemName: l.itemName || '', deliveredKg: n(l.doneKg), returnedKg: n(l.returnedKg), shipCode: lineShip(so, l),
    qtyKg: '', reason: '', condition: RETURN_CONDITIONS[0], goodsStatus: l.goodsStatus === 'HTC' ? 'KTC' : l.goodsStatus || 'KTC',
  })));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const setL = (i, k, v) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const all = () => setLines((ls) => ls.map((l) => ({ ...l, qtyKg: max[l.soLine] || 0 })));
  const total = lines.reduce((a, l) => a + n(l.qtyKg), 0);

  const save = async () => {
    setErr('');
    const pick = lines.filter((l) => n(l.qtyKg) > 0);
    if (!pick.length) return setErr('Nhập số kg trả về ít nhất 1 dòng.');
    for (const l of pick) {
      if (n(l.qtyKg) > (max[l.soLine] || 0) + 0.001) return setErr(`${l.item}: chỉ được trả tối đa ${t(max[l.soLine])} kg (đã giao ${t(l.deliveredKg)}, đã trả / đang chờ trả phần còn lại).`);
      if (!l.reason) return setErr(`${l.item}: chọn lý do trả hàng.`);
    }
    if (!head.warehouse) return setErr('Chọn kho nhận hàng trả về.');
    setBusy(true);
    try {
      const ship = pick.map((l) => l.shipCode).find(Boolean) || so.shipCode || '';
      const id = await createOrder({
        type: 'DRT', originalSoId: so.id, company: so.company || '', partyCode: so.partyCode || '', partyName: so.partyName || '', sales: so.sales || '',
        shipCode: ship, warehouse: head.warehouse, warehouses: [head.warehouse], date: head.date, dueDate: head.date, note: head.note.trim(), tolerancePct: 0,
        lines: pick.map((l) => ({ soLine: l.soLine, item: l.item, itemName: l.itemName, deliveredKg: l.deliveredKg, qtyKg: Math.round(n(l.qtyKg) * 1000) / 1000,
          reason: l.reason, condition: l.condition, goodsStatus: l.goodsStatus, warehouse: head.warehouse, dueDate: head.date, shipCode: l.shipCode || ship, note: '' })),
      }, { email, name }, {});
      setDone(id);
      onDone?.(id);
    } catch (e) {
      setErr(e.code === 'permission-denied' ? 'Không có quyền lập đơn trả hàng (cần dán quy tắc Firestore mới, hoặc SO không phải của bạn).' : e.message);
    }
    setBusy(false);
  };

  return (
    <Modal title={`↩ Tạo đơn trả hàng (DRT) từ ${so.id}`} onClose={onClose} wide>
      {done ? (
        <>
          <div className="ok-box">Đã lập <b className="mono">{done}</b>. Đơn nằm ở <b>IB · Danh sách đơn chờ nhập</b>: kho lập phiếu nhập kho theo {done} (MVT 651), khi thủ kho nhận hàng thì tồn kho và phần "khách trả về" của {so.id} tự cập nhật.</div>
          <div className="form-actions">
            <Link className="btn" to="/don-hang?tab=cho-nhap">📥 Mở danh sách chờ nhập</Link>
            <Link className="btn" to={`/don-hang?tab=DRT&q=${done}`}>Xem đơn trả hàng</Link>
            <button type="button" className="btn primary" onClick={onClose}>Đóng</button>
          </div>
        </>
      ) : (
        <>
          <p>Khách hàng: <b>{so.partyCode} {so.partyName}</b>{so.company ? <> · Công ty {so.company}</> : null}{so.sales ? <> · Sale {so.sales}</> : null}</p>
          <div className="form-grid">
            <Field label="Ngày trả hàng" required><input type="date" value={head.date} onChange={(e) => setHead((h) => ({ ...h, date: e.target.value }))} /></Field>
            <Field label="Kho nhận hàng trả về" required>
              <Select value={head.warehouse} onChange={(e) => setHead((h) => ({ ...h, warehouse: e.target.value }))}>
                <option value="">-- Chọn --</option>
                {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
              </Select>
            </Field>
            <Field label="Ghi chú" size={{ width: 480 }}><input value={head.note} onChange={(e) => setHead((h) => ({ ...h, note: e.target.value }))} /></Field>
          </div>
          <div className="table-wrap" style={{ margin: '10px 0' }}>
            <table>
              <thead><tr><th>Dòng SO</th><th>Mã hàng</th><th>Tên hàng</th><th className="num">Đã giao</th><th className="num">Đã trả</th><th className="num">Còn được trả</th>
                <th className="num">Số kg trả về</th><th>Lý do</th><th>Tình trạng hàng</th><th>TTHH khi nhập</th></tr></thead>
              <tbody>{lines.map((l, i) => (
                <tr key={l.soLine}>
                  <td>{l.soLine}</td><td>{l.item}</td><td>{l.itemName}</td><td className="num">{t(l.deliveredKg)}</td><td className="num">{t(l.returnedKg)}</td>
                  <td className="num"><b>{t(max[l.soLine])}</b></td>
                  <td><input type="number" min="0" step="any" style={{ width: 110 }} value={l.qtyKg} onChange={(e) => setL(i, 'qtyKg', e.target.value)} disabled={!(max[l.soLine] > 0)} /></td>
                  <td>
                    <WithAdd cat="reasons" preset={{ appliesTo: 'Nhập kho' }} onAdded={(id, r) => setL(i, 'reason', r?.name || id)}>
                      <Select value={l.reason} onChange={(e) => setL(i, 'reason', e.target.value)} style={{ minWidth: 160 }}>
                        <option value="">-- Chọn --</option>
                        {reasons.filter((r) => !r.appliesTo || ['Nhập kho', 'Trả hàng'].includes(r.appliesTo)).map((r) => <option key={r.code} value={r.name}>{r.name}</option>)}
                        <option value="Khách từ chối nhận hàng">Khách từ chối nhận hàng</option>
                        <option value="Hàng không đạt chất lượng">Hàng không đạt chất lượng</option>
                        <option value="Giao sai / giao dư">Giao sai / giao dư</option>
                      </Select>
                    </WithAdd>
                  </td>
                  <td><Select value={l.condition} onChange={(e) => { setL(i, 'condition', e.target.value); setL(i, 'goodsStatus', e.target.value === RETURN_CONDITIONS[0] ? 'KTC' : 'BLK'); }}>{RETURN_CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}</Select></td>
                  <td><Select value={l.goodsStatus} onChange={(e) => setL(i, 'goodsStatus', e.target.value)}>{[['KTC', 'KTC'], ['DGC', 'DGC'], ['BLK', 'BLK – Block, không bán']].map(([c, lb]) => <option key={c} value={c}>{lb}</option>)}</Select></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="small">Hàng hư hỏng / cần kiểm tra tự nhập kho ở tình trạng <b>BLK (Block)</b>: không xuất bán được cho tới khi kế toán đổi tình trạng. Còn được trả = đã giao − đã nhận trả về − phần đang nằm trong đơn trả hàng khác chưa nhận. Tổng trả lần này: <b>{t(total)} kg</b>.</p>
          <ErrorBox error={err} />
          <div className="form-actions">
            <button type="button" className="btn" onClick={all} style={{ marginRight: 'auto' }}>Trả toàn bộ phần còn được trả</button>
            <button type="button" className="btn" onClick={onClose}>Đóng</button>
            <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lập đơn trả hàng'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Tab "SO trả hàng (DRT)" ở trang Đơn hàng
export default function DrtList({ initialQ = '' }) {
  const { inMyWarehouses } = useApp();
  const { rows, error, loading } = useOrders('DRT');
  const pendIn = usePendingIn();
  const [q, setQ] = useState(initialQ);
  const [fs, setFs] = useState('');
  const [open, setOpen] = useState(null);
  const list = useMemo(() => rows
    .filter((o) => !o.warehouse || inMyWarehouses(o.warehouse))
    .filter((o) => !fs || (fs === 'open' ? OPEN_STATUSES.includes(o.status) : o.status === fs))
    .filter((o) => matchQ(q, o.id, o.originalSoId, o.partyCode, o.partyName, o.warehouse, o.note, (o.lines || []).flatMap((l) => [l.item, l.itemName, l.reason, l.condition])))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id))), [rows, q, fs, inMyWarehouses]);
  const current = open && rows.find((o) => o.id === open);
  const excel = () => exportSheets(`SO_tra_hang_${vnDate()}`, { DRT: list.flatMap((o) => o.lines.map((l) => ({
    'Số DRT': o.id, 'SO gốc': o.originalSoId, Ngày: o.date, 'Mã KH': o.partyCode, 'Tên KH': o.partyName, Kho: o.warehouse, 'Mã hàng': l.item, 'Tên hàng': l.itemName,
    'Đã giao (kg)': n(l.deliveredKg), 'Trả về (kg)': n(l.qtyKg), 'Đã nhận về (kg)': n(l.doneKg), 'Lý do': l.reason, 'Tình trạng hàng': l.condition, 'Trạng thái': ORDER_STATUS[o.status]?.label || o.status,
  }))) });

  return (
    <div>
      <p className="hint">Lập đơn trả hàng từ SO gốc: mở SO ở thẻ <b>SO đã tạo</b> → <b>↩ Tạo đơn trả hàng (DRT)</b>. Đơn trả hàng là 1 IB chờ nhập: kho lập phiếu nhập kho theo DRT (MVT 651).</p>
      <div className="toolbar">
        <input type="search" placeholder="Tìm số DRT, SO gốc, khách, mã hàng, lý do…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={fs} onChange={(e) => setFs(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          <option value="open">Chưa nhận đủ</option>
          <option value="done">Đã nhận đủ</option>
          <option value="closed">Đã đóng</option>
          <option value="cancelled">Đã hủy</option>
        </Select>
        <span className="small">{list.length} đơn</span>
        <button type="button" className="btn sm" onClick={excel}>⬇ Excel</button>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {loading ? <Empty text="Đang tải…" /> : !list.length ? <Empty text="Chưa có đơn trả hàng." /> : (
          <table>
            <thead><tr><th>Số DRT</th><th>Ngày</th><th>SO gốc</th><th>Khách hàng</th><th>Kho nhận</th><th>Mã hàng</th><th>Lý do</th><th className="num">Trả về (kg)</th><th className="num">Đã nhận về</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>{list.map((o) => {
              const x = orderTotals(o);
              const pend = (o.lines || []).reduce((a, l) => a + (pendIn.get(o.id)?.byLine?.[l.no] || 0), 0);
              return (
                <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(o.id)}>
                  <td className="mono">{o.id}</td><td className="nowrap">{fmtDate(o.date)}</td>
                  <td className="mono"><Link to={`/don-hang?tab=SO&q=${o.originalSoId}`} onClick={(e) => e.stopPropagation()}>{o.originalSoId}</Link></td>
                  <td>{o.partyCode} <span className="small">{o.partyName}</span></td><td>{o.warehouse}</td>
                  <td>{[...new Set(o.lines.map((l) => l.item))].join(', ')}</td>
                  <td className="small">{[...new Set(o.lines.map((l) => l.reason).filter(Boolean))].join('; ')}</td>
                  <td className="num">{t(x.qty)}</td><td className="num">{t(x.done)}{pend > 0 ? <div className="small" style={{ color: 'var(--amber)' }}>chờ thủ kho nhận {t(pend)}</div> : null}</td>
                  <td><Status s={o.status} /></td>
                  <td onClick={(e) => e.stopPropagation()}><DrtInButton o={o} pend={pend} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {current && <DrtDetail o={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DrtInButton({ o, pend }) {
  const { isAdmin, inMyWarehouses } = useApp();
  if (!isAdmin || !OPEN_STATUSES.includes(o.status) || (o.warehouse && !inMyWarehouses(o.warehouse))) return null;
  const left = orderTotals(o).left - pend;
  if (left <= 0.001) return <span className="small">Đã lập đủ phiếu, chờ thủ kho nhận</span>;
  return <Link className="btn sm primary" to={`/kho/in?order=${o.id}&src=drt`}>📥 Lập phiếu nhập</Link>;
}

function DrtDetail({ o, onClose }) {
  const { email, name, hasRole, isAdmin } = useApp();
  const pendIn = usePendingIn();
  const [moves, setMoves] = useState([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => onSnapshot(query(collection(db, 'movements'), where('orderId', '==', o.id)),
    (s) => setMoves(s.docs.map((d) => d.data())), () => setMoves([])), [o.id]);
  const x = orderTotals(o);
  const act = async (a) => {
    setErr('');
    if (a !== 'reopen' && !reason.trim()) return setErr('Nhập lý do.');
    try { await setOrderState(o.id, a, reason.trim(), { email, name }); setReason(''); } catch (e) { setErr(e.message); }
  };
  const canManage = isAdmin || canMakeDrt(hasRole);
  return (
    <Modal title={`SO trả hàng ${o.id}`} onClose={onClose} wide>
      <p><Status s={o.status} /> · Ngày {fmtDate(o.date)} · SO gốc <Link className="mono" to={`/don-hang?tab=SO&q=${o.originalSoId}`}>{o.originalSoId}</Link> · Khách hàng <b>{o.partyCode} {o.partyName}</b> · Kho nhận <b>{o.warehouse}</b>{o.shipCode ? <> · Lấy hàng tại {o.shipCode}</> : null}</p>
      {o.note && <p className="small">Ghi chú: {o.note}</p>}
      {o.closeReason && <p className="small">Lý do {o.status === 'cancelled' ? 'hủy' : 'đóng'}: {o.closeReason}</p>}
      <div className="table-wrap" style={{ marginBottom: 10 }}>
        <table>
          <thead><tr><th>#</th><th>Dòng SO</th><th>Mã hàng</th><th>Tên hàng</th><th className="num">Đã giao (SO)</th><th className="num">Trả về</th><th className="num">Đã nhận về</th><th className="num">Còn chờ</th><th>Lý do</th><th>Tình trạng</th><th>TTHH</th></tr></thead>
          <tbody>{o.lines.map((l) => (
            <tr key={l.no}><td>{l.no}</td><td>{l.soLine}</td><td>{l.item}</td><td>{l.itemName}</td><td className="num">{t(l.deliveredKg)}</td><td className="num">{t(l.qtyKg)}</td><td className="num">{t(l.doneKg)}</td>
              <td className="num"><b>{OPEN_STATUSES.includes(o.status) ? t(leftKg(l)) : '–'}</b>{pendIn.get(o.id)?.byLine?.[l.no] ? <div className="small" style={{ color: 'var(--amber)' }}>đã lập phiếu chờ nhận {t(pendIn.get(o.id).byLine[l.no])}</div> : null}</td>
              <td>{l.reason}</td><td>{l.condition}</td><td>{l.goodsStatus}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div className="form-actions" style={{ justifyContent: 'flex-start' }}><DrtInButton o={o} pend={(o.lines || []).reduce((a, l) => a + (pendIn.get(o.id)?.byLine?.[l.no] || 0), 0)} /></div>
      <div className="section-head">Phiếu nhập kho theo đơn ({moves.length})</div>
      {!moves.length ? <Empty text="Chưa có phiếu nhập." /> : (
        <table style={{ marginBottom: 12 }}><tbody>{moves.map((m) => (
          <tr key={m.id} style={{ opacity: m.status === 'cancelled' ? 0.5 : 1 }}><td className="mono"><Link to={`/kho/phieu/${m.id}/in`} target="_blank">{m.id}</Link></td><td>{MOVE_TYPES[m.type]?.label} · MVT 651</td><td>{fmtDate(m.date)}</td><td>Kho {m.warehouse}</td>
            <td className="num">{t(m.lines.reduce((s, l) => s + Math.abs(n(l.kg)), 0))} kg</td>
            <td>{m.status === 'cancelled' ? <span className="badge red">Đã hủy</span> : m.status === 'pending' ? <span className="badge amber">Chờ thủ kho nhận</span> : <span className="badge green">Đã nhập kho</span>}</td></tr>
        ))}</tbody></table>
      )}
      {canManage && o.status !== 'cancelled' && (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <input placeholder="Lý do hủy / đóng" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 240 }} />
          {x.done <= 0.001 && <button type="button" className="btn danger" onClick={() => act('cancel')}>Hủy đơn trả hàng</button>}
          {OPEN_STATUSES.includes(o.status) && x.done > 0.001 && <button type="button" className="btn" onClick={() => act('close')}>Đóng (không nhận thêm)</button>}
          {o.status === 'closed' && <button type="button" className="btn" onClick={() => act('reopen')}>Mở lại</button>}
        </div>
      )}
      <ErrorBox error={err} />
      {o.history?.length > 0 && <details><summary className="small">Lịch sử</summary><ul className="small">{o.history.map((h, i) => <li key={i}>{h.at?.slice(0, 16).replace('T', ' ')} · {h.byName || h.by}: {h.action}</li>)}</ul></details>}
    </Modal>
  );
}
