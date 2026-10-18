import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, onSnapshot, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useOrders, useWaitingOut } from '../../lib/hooks';
import { createOrder, leftKg, lineWh, OPEN_STATUSES, ORDER_STATUS, orderTotals, poReturnable, RTV_REASONS, setOrderState } from '../../lib/orders';
import { MOVE_TYPES } from '../../lib/stock';
import { vnDate } from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, matchQ } from '../../lib/utils';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import Select from '../../components/Select';

// ============================================================================
// PO trả hàng nhà cung cấp (RTV, Return to vendor): trả lại NCC 1 phần / toàn bộ hàng đã nhận của 1 PO (số trả ≤ đã nhận).
// Lập từ PO gốc → kho lập phiếu xuất kho theo RTV (MVT 122): tồn giảm, "đã xuất trả" của RTV và "đã trả NCC" của PO gốc cùng cập nhật.
// Không phải SO: không doanh thu, không vào báo cáo bán hàng. Lấy được cả hàng ở khu hàng block.
// ============================================================================

const t = (kg) => fmtNum(Number(kg) || 0, 2);
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const canMakeRtv = (hasRole) => hasRole('kinh_doanh', 'ke_toan');

function Status({ s }) {
  const m = ORDER_STATUS[s] || { label: s };
  const label = { open: 'Chờ xuất trả', partial: 'Đã xuất trả 1 phần', done: 'Đã trả đủ' }[s] || m.label;
  return <span className={'badge ' + (m.tone || '')}>{label}</span>;
}

// Nút trên chi tiết PO
export function RtvButton({ po }) {
  const { hasRole } = useApp();
  const [open, setOpen] = useState(false);
  if (po.type !== 'PO' || po.status === 'cancelled' || !canMakeRtv(hasRole)) return null;
  if (!(po.lines || []).some((l) => n(l.doneKg) - n(l.returnedKg) > 0.001)) return null;
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} title="Trả lại nhà cung cấp hàng đã nhận của PO này (hàng không đạt, giao sai, giao dư…)">↩ Trả hàng NCC (RTV)</button>
      {open && <RtvCreate po={po} onClose={() => setOpen(false)} />}
    </>
  );
}

function RtvCreate({ po, onClose }) {
  const { email, name } = useApp();
  const rtvs = useOrders('RTV').rows;
  const warehouses = useCollection('warehouses').rows;
  const max = useMemo(() => poReturnable(po, rtvs), [po, rtvs]);
  const firstWh = (po.lines || []).map((l) => lineWh(po, l)).find(Boolean) || '';
  const [head, setHead] = useState({ date: vnDate(), warehouse: firstWh, note: '', poPaid: false });
  const [lines, setLines] = useState(() => (po.lines || []).filter((l) => n(l.doneKg) - n(l.returnedKg) > 0.001).map((l) => ({
    poLine: l.no, item: l.item, itemName: l.itemName || '', receivedKg: n(l.doneKg), returnedKg: n(l.returnedKg), qtyKg: '', reason: '', goodsStatus: l.goodsStatus || '',
  })));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const setL = (i, k, v) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const all = () => setLines((ls) => ls.map((l) => ({ ...l, qtyKg: max[l.poLine] || 0 })));
  const total = lines.reduce((a, l) => a + n(l.qtyKg), 0);

  const save = async () => {
    setErr('');
    const pick = lines.filter((l) => n(l.qtyKg) > 0);
    if (!pick.length) return setErr('Nhập số kg trả NCC ít nhất 1 dòng.');
    for (const l of pick) {
      if (n(l.qtyKg) > (max[l.poLine] || 0) + 0.001) return setErr(`${l.item}: chỉ được trả tối đa ${t(max[l.poLine])} kg (đã nhận ${t(l.receivedKg)}, đã trả / đang chờ trả phần còn lại).`);
      if (!l.reason) return setErr(`${l.item}: chọn lý do trả hàng.`);
    }
    if (!head.warehouse) return setErr('Chọn kho xuất trả.');
    setBusy(true);
    try {
      const id = await createOrder({
        type: 'RTV', originalPoId: po.id, company: po.company || '', partyCode: po.partyCode || '', partyName: po.partyName || '', sales: po.sales || '',
        warehouse: head.warehouse, warehouses: [head.warehouse], date: head.date, dueDate: head.date, note: head.note.trim(), tolerancePct: 0, poPaid: !!head.poPaid,
        lines: pick.map((l) => ({ poLine: l.poLine, item: l.item, itemName: l.itemName, receivedKg: l.receivedKg, qtyKg: Math.round(n(l.qtyKg) * 1000) / 1000,
          reason: l.reason, goodsStatus: '', warehouse: head.warehouse, dueDate: head.date, note: '' })),
      }, { email, name }, {});
      // PO đã thanh toán: báo kế toán (chuông 🔔) treo công nợ phải thu NCC trên phần mềm kế toán
      if (head.poPaid) {
        await setDoc(doc(db, 'notices', `RTV-${id}`), {
          kind: 'vendor_return', status: 'open', roles: ['ke_toan', 'admin'], rtvId: id, orderId: po.id, date: head.date, warehouse: head.warehouse,
          company: po.company || '', partyCode: po.partyCode || '', partyName: po.partyName || '', kg: Math.round(total * 1000) / 1000,
          lines: pick.map((l) => ({ item: l.item, itemName: l.itemName, kg: n(l.qtyKg), reason: l.reason })),
          createdAt: serverTimestamp(), createdBy: email, createdByName: name || '',
        }).catch((e) => console.warn('Chưa báo được kế toán', e));
      }
      setDone(id);
    } catch (e) {
      setErr(e.code === 'permission-denied' ? 'Không có quyền lập đơn trả hàng NCC (cần dán quy tắc Firestore mới).' : e.message);
    }
    setBusy(false);
  };

  return (
    <Modal title={`↩ Trả hàng nhà cung cấp (RTV) từ ${po.id}`} onClose={onClose} wide>
      {done ? (
        <>
          <div className="ok-box">Đã lập <b className="mono">{done}</b>. Kho lập phiếu xuất kho theo {done} (MVT 122): tồn kho giảm, phần "đã trả NCC" của {po.id} tự cập nhật.{head.poPaid ? ' Đã báo kế toán treo công nợ phải thu NCC.' : ''}</div>
          <div className="form-actions">
            <Link className="btn" to={`/don-hang?tab=RTV&q=${done}`}>Xem đơn trả hàng NCC</Link>
            <button type="button" className="btn primary" onClick={onClose}>Đóng</button>
          </div>
        </>
      ) : (
        <>
          <p>Nhà cung cấp: <b>{po.partyCode} {po.partyName}</b>{po.company ? <> · Công ty {po.company}</> : null}</p>
          <div className="form-grid">
            <Field label="Ngày trả hàng" required><input type="date" value={head.date} onChange={(e) => setHead((h) => ({ ...h, date: e.target.value }))} /></Field>
            <Field label="Kho xuất trả" required>
              <Select value={head.warehouse} onChange={(e) => setHead((h) => ({ ...h, warehouse: e.target.value }))}>
                <option value="">-- Chọn --</option>
                {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
              </Select>
            </Field>
            <Field label="Ghi chú" size={{ width: 480 }}><input value={head.note} onChange={(e) => setHead((h) => ({ ...h, note: e.target.value }))} placeholder="VD: số biên bản không đạt, số tờ khai…" /></Field>
          </div>
          <label style={{ display: 'block', margin: '8px 0' }}>
            <input type="checkbox" checked={head.poPaid} onChange={(e) => setHead((h) => ({ ...h, poPaid: e.target.checked }))} /> <b>PO đã thanh toán cho NCC</b>
            <span className="small"> · tích thì app báo kế toán (chuông 🔔) treo công nợ phải thu NCC cho phần hàng trả này trên phần mềm kế toán</span>
          </label>
          <div className="table-wrap" style={{ margin: '10px 0' }}>
            <table>
              <thead><tr><th>Dòng PO</th><th>Mã hàng</th><th>Tên hàng</th><th className="num">Đã nhận</th><th className="num">Đã trả NCC</th><th className="num">Còn được trả</th>
                <th className="num">Số kg trả NCC</th><th>Lý do</th></tr></thead>
              <tbody>{lines.map((l, i) => (
                <tr key={l.poLine}>
                  <td>{l.poLine}</td><td>{l.item}</td><td>{l.itemName}</td><td className="num">{t(l.receivedKg)}</td><td className="num">{t(l.returnedKg)}</td>
                  <td className="num"><b>{t(max[l.poLine])}</b></td>
                  <td><input type="number" min="0" step="any" style={{ width: 110 }} value={l.qtyKg} onChange={(e) => setL(i, 'qtyKg', e.target.value)} disabled={!(max[l.poLine] > 0)} /></td>
                  <td><Select value={l.reason} onChange={(e) => setL(i, 'reason', e.target.value)} style={{ minWidth: 180 }}>
                    <option value="">-- Chọn --</option>
                    {RTV_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </Select></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="small">Còn được trả = đã nhận − đã trả NCC − phần đang nằm trong đơn trả NCC khác chưa xuất. Khi lập phiếu xuất, kho lấy được cả hàng ở 🚫 khu hàng block (ưu tiên trước). Tổng trả lần này: <b>{t(total)} kg</b>.</p>
          <ErrorBox error={err} />
          <div className="form-actions">
            <button type="button" className="btn" onClick={all} style={{ marginRight: 'auto' }}>Trả toàn bộ phần còn được trả</button>
            <button type="button" className="btn" onClick={onClose}>Đóng</button>
            <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lập đơn trả hàng NCC'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Tab "PO trả hàng NCC (RTV)" ở trang Đơn hàng
export default function RtvList({ initialQ = '' }) {
  const { inMyWarehouses } = useApp();
  const { rows, error, loading } = useOrders('RTV');
  const waitOut = useWaitingOut();
  const [q, setQ] = useState(initialQ);
  const [fs, setFs] = useState('');
  const [open, setOpen] = useState(null);
  const list = useMemo(() => rows
    .filter((o) => !o.warehouse || inMyWarehouses(o.warehouse))
    .filter((o) => !fs || (fs === 'open' ? OPEN_STATUSES.includes(o.status) : o.status === fs))
    .filter((o) => matchQ(q, o.id, o.originalPoId, o.partyCode, o.partyName, o.warehouse, o.note, (o.lines || []).flatMap((l) => [l.item, l.itemName, l.reason])))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id))), [rows, q, fs, inMyWarehouses]);
  const current = open && rows.find((o) => o.id === open);
  const excel = () => exportSheets(`Tra_hang_NCC_${vnDate()}`, { RTV: list.flatMap((o) => o.lines.map((l) => ({
    'Số RTV': o.id, 'PO gốc': o.originalPoId, Ngày: o.date, 'Mã NCC': o.partyCode, 'Tên NCC': o.partyName, Kho: o.warehouse, 'Mã hàng': l.item, 'Tên hàng': l.itemName,
    'Đã nhận (kg)': n(l.receivedKg), 'Trả NCC (kg)': n(l.qtyKg), 'Đã xuất trả (kg)': n(l.doneKg), 'Lý do': l.reason, 'Trạng thái': ORDER_STATUS[o.status]?.label || o.status,
  }))) });

  return (
    <div>
      <p className="hint">Lập đơn trả hàng NCC từ PO gốc: mở PO ở thẻ <b>Đơn mua (PO)</b> → <b>↩ Trả hàng NCC (RTV)</b>. Kho lập phiếu xuất kho theo RTV (MVT 122); không phải đơn bán nên không tính doanh thu.</p>
      <div className="toolbar">
        <input type="search" placeholder="Tìm số RTV, PO gốc, NCC, mã hàng, lý do…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={fs} onChange={(e) => setFs(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          <option value="open">Chưa trả đủ</option>
          <option value="done">Đã trả đủ</option>
          <option value="closed">Đã đóng</option>
          <option value="cancelled">Đã hủy</option>
        </Select>
        <span className="small">{list.length} đơn</span>
        <button type="button" className="btn sm" onClick={excel}>⬇ Excel</button>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {loading ? <Empty text="Đang tải…" /> : !list.length ? <Empty text="Chưa có đơn trả hàng NCC." /> : (
          <table>
            <thead><tr><th>Số RTV</th><th>Ngày</th><th>PO gốc</th><th>Nhà cung cấp</th><th>Kho xuất</th><th>Mã hàng</th><th>Lý do</th><th className="num">Trả NCC (kg)</th><th className="num">Đã xuất trả</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>{list.map((o) => {
              const x = orderTotals(o);
              const wait = (o.lines || []).reduce((a, l) => a + (waitOut.get(o.id)?.byLine?.[l.no] || 0), 0);
              return (
                <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(o.id)}>
                  <td className="mono">{o.id}</td><td className="nowrap">{fmtDate(o.date)}</td>
                  <td className="mono"><Link to={`/don-hang?tab=PO&q=${o.originalPoId}`} onClick={(e) => e.stopPropagation()}>{o.originalPoId}</Link></td>
                  <td>{o.partyCode} <span className="small">{o.partyName}</span></td><td>{o.warehouse}</td>
                  <td>{[...new Set(o.lines.map((l) => l.item))].join(', ')}</td>
                  <td className="small">{[...new Set(o.lines.map((l) => l.reason).filter(Boolean))].join('; ')}</td>
                  <td className="num">{t(x.qty)}</td><td className="num">{t(x.done)}{wait > 0 ? <div className="small" style={{ color: 'var(--amber)' }}>chờ duyệt {t(wait)}</div> : null}</td>
                  <td><Status s={o.status} />{o.poPaid ? <div className="small" style={{ color: 'var(--amber)' }}>PO đã thanh toán · treo công nợ NCC</div> : null}</td>
                  <td onClick={(e) => e.stopPropagation()}><RtvOutButton o={o} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {current && <RtvDetail o={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RtvOutButton({ o }) {
  const { hasRole, inMyWarehouses } = useApp();
  if (!hasRole('thu_kho') || !OPEN_STATUSES.includes(o.status) || (o.warehouse && !inMyWarehouses(o.warehouse))) return null;
  return <Link className="btn sm primary" to={`/kho/out?order=${o.id}`}>📤 Lập phiếu xuất trả</Link>;
}

function RtvDetail({ o, onClose }) {
  const { email, name, hasRole, isAdmin } = useApp();
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
  const canManage = isAdmin || canMakeRtv(hasRole);
  return (
    <Modal title={`PO trả hàng NCC ${o.id}`} onClose={onClose} wide>
      <p><Status s={o.status} /> · Ngày {fmtDate(o.date)} · PO gốc <Link className="mono" to={`/don-hang?tab=PO&q=${o.originalPoId}`}>{o.originalPoId}</Link> · Nhà cung cấp <b>{o.partyCode} {o.partyName}</b> · Kho xuất <b>{o.warehouse}</b>{o.poPaid ? <> · <span className="badge amber">PO đã thanh toán: treo công nợ phải thu NCC</span></> : null}</p>
      {o.note && <p className="small">Ghi chú: {o.note}</p>}
      {o.closeReason && <p className="small">Lý do {o.status === 'cancelled' ? 'hủy' : 'đóng'}: {o.closeReason}</p>}
      <div className="table-wrap" style={{ marginBottom: 10 }}>
        <table>
          <thead><tr><th>#</th><th>Dòng PO</th><th>Mã hàng</th><th>Tên hàng</th><th className="num">Đã nhận (PO)</th><th className="num">Trả NCC</th><th className="num">Đã xuất trả</th><th className="num">Còn chờ</th><th>Lý do</th></tr></thead>
          <tbody>{o.lines.map((l) => (
            <tr key={l.no}><td>{l.no}</td><td>{l.poLine}</td><td>{l.item}</td><td>{l.itemName}</td><td className="num">{t(l.receivedKg)}</td><td className="num">{t(l.qtyKg)}</td><td className="num">{t(l.doneKg)}</td>
              <td className="num"><b>{OPEN_STATUSES.includes(o.status) ? t(leftKg(l)) : '–'}</b></td><td>{l.reason}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div className="form-actions" style={{ justifyContent: 'flex-start' }}><RtvOutButton o={o} /></div>
      <div className="section-head">Phiếu xuất kho theo đơn ({moves.length})</div>
      {!moves.length ? <Empty text="Chưa có phiếu xuất." /> : (
        <table style={{ marginBottom: 12 }}><tbody>{moves.map((m) => (
          <tr key={m.id} style={{ opacity: m.status === 'cancelled' ? 0.5 : 1 }}><td className="mono"><Link to={`/kho/phieu/${m.id}/out`} target="_blank">{m.id}</Link></td><td>{MOVE_TYPES[m.type]?.label} · MVT 122</td><td>{fmtDate(m.date)}</td><td>Kho {m.warehouse}</td>
            <td className="num">{t(m.lines.reduce((s, l) => s + Math.abs(n(l.kg)), 0))} kg</td>
            <td>{m.status === 'cancelled' ? <span className="badge red">Đã hủy</span> : m.status === 'posted' ? <span className="badge green">Đã xuất</span> : <span className="badge amber">Chờ duyệt</span>}</td></tr>
        ))}</tbody></table>
      )}
      {canManage && o.status !== 'cancelled' && (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <input placeholder="Lý do hủy / đóng" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 240 }} />
          {x.done <= 0.001 && <button type="button" className="btn danger" onClick={() => act('cancel')}>Hủy đơn trả NCC</button>}
          {OPEN_STATUSES.includes(o.status) && x.done > 0.001 && <button type="button" className="btn" onClick={() => act('close')}>Đóng (không trả thêm)</button>}
          {o.status === 'closed' && <button type="button" className="btn" onClick={() => act('reopen')}>Mở lại</button>}
        </div>
      )}
      <ErrorBox error={err} />
      {o.history?.length > 0 && <details><summary className="small">Lịch sử</summary><ul className="small">{o.history.map((h, i) => <li key={i}>{h.at?.slice(0, 16).replace('T', ' ')} · {h.byName || h.by}: {h.action}</li>)}</ul></details>}
    </Modal>
  );
}
