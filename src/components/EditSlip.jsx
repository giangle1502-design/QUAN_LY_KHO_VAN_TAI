import { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useCollection, useOrders, usePendingIn } from '../lib/hooks';
import { openKg } from '../lib/orders';
import { suggestPallets } from '../lib/stock';
import { saveSlipEdit } from '../lib/slips';
import { fmtNum } from '../lib/utils';
import { ErrorBox, Modal } from './ui';

const n = (v) => Number(v) || 0;
const r3 = (x) => Math.round(x * 1000) / 1000;

// Ai sửa được phiếu: quản trị (mọi phiếu chưa hủy); thủ kho: phiếu xuất chờ giải chấp ở kho mình (chưa trừ tồn)
export function canEditSlip(m, { isAdmin, hasRole, inMyWarehouses }) {
  if (!m || m.status === 'cancelled' || !['in', 'out'].includes(m.type)) return false;
  if (isAdmin) return true;
  return hasRole('thu_kho') && m.type === 'out' && m.status === 'wait_release' && inMyWarehouses(m.warehouse);
}

// Sửa phiếu xuất (DO) / phiếu nhập: ngày, số chứng từ, ghi chú, mã giao, số lượng từng dòng.
// Lưu là cập nhật lại tồn kho (phiếu đã ghi tồn) và số đã giao / đã nhận của SO, PO, STO.
export default function EditSlip({ m, onClose, onSaved }) {
  const { email, name } = useApp();
  const items = useCollection('items').rows;
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const { rows: orders } = useOrders(m.orderId ? '' : '__none__');
  const order = orders.find((o) => o.id === m.orderId);
  const pendIn = usePendingIn();
  const posted = m.status === 'posted';
  const [h, setH] = useState({ date: m.date || '', refNo: m.refNo || '', shipCode: m.shipCode || '', note: m.note || '' });
  const [lines, setLines] = useState(() => (m.lines || []).map((l) => ({ ...l })));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const it = itemMap.get(l.item);
    const x = { ...l, [k]: v };
    // Nhập theo kg (đơn vị chính) → tự tính số bao, pallet theo quy cách mã hàng
    if (k === 'kg' && n(it?.bagWeight)) {
      x.bags = r3(n(v) / n(it.bagWeight));
      const p = suggestPallets(it, x.bags);
      if (p !== '') x.pallets = p;
    }
    if (k === 'bags' && n(it?.bagWeight)) {
      x.kg = r3(n(v) * n(it.bagWeight));
      const p = suggestPallets(it, v);
      if (p !== '') x.pallets = p;
    }
    return x;
  }));
  const total0 = (m.lines || []).reduce((a, l) => a + n(l.kg), 0);
  const total1 = lines.reduce((a, l) => a + n(l.kg), 0);

  // Kiểm tra trước khi lưu (phiếu đã ghi tồn: giao dịch kiểm tra thêm tồn kho, số lượng đơn)
  const check = () => {
    for (const [i, l] of lines.entries()) if (n(l.kg) < 0 || n(l.bags) < 0 || n(l.pallets) < 0) return `Dòng ${i + 1}: số lượng không được âm.`;
    if (!lines.some((l) => n(l.kg) > 0)) return 'Phiếu phải còn ít nhất 1 dòng có số lượng. Muốn bỏ cả phiếu thì dùng Hủy phiếu.';
    // Phiếu xuất chờ giải chấp: hàng đã giữ chỗ theo số cũ → chỉ được giảm
    if (m.type === 'out' && m.status === 'wait_release') {
      const bad = lines.find((l, i) => n(l.kg) > n(m.lines[i]?.kg) + 0.001);
      if (bad) return `Phiếu chờ giải chấp chỉ được giảm số lượng (${bad.item}). Cần xuất thêm thì lập phiếu xuất mới.`;
    }
    // Phiếu nhập chờ thủ kho nhận: không vượt phần đơn còn phải nhập (trừ các phiếu chờ khác)
    if (m.type === 'in' && m.status === 'pending' && order && order.type !== 'SO') {
      const mine = {};
      for (const l of m.lines) mine[l.orderLine] = (mine[l.orderLine] || 0) + n(l.kg);
      const want = {};
      for (const l of lines) want[l.orderLine] = (want[l.orderLine] || 0) + n(l.kg);
      const tol = 1 + n(order.tolerancePct) / 100;
      for (const [no, kg] of Object.entries(want)) {
        const ol = order.lines.find((x) => String(x.no) === String(no));
        if (!ol) continue;
        const others = (pendIn.get(order.id)?.byLine?.[no] || 0) - (mine[no] || 0);
        const cap = (order.type === 'PO' ? openKg(order, ol, 'in') * tol : openKg(order, ol, 'in')) - others;
        if (kg > cap + 0.001) return `${ol.item}: đơn ${order.id} chỉ còn ${fmtNum(Math.max(0, cap), 2)} kg chưa lập phiếu nhập, phiếu đang ghi ${fmtNum(kg, 2)} kg.`;
      }
    }
    if (posted && !reason.trim()) return 'Ghi lý do sửa (phiếu đã ghi tồn kho).';
    return '';
  };
  const save = async () => {
    const e = check();
    if (e) return setErr(e);
    setErr(''); setBusy(true);
    try {
      const patch = { date: h.date, note: h.note.trim(), lines: lines.map((l) => ({ ...l, kg: r3(n(l.kg)), bags: r3(n(l.bags)), pallets: r3(n(l.pallets)) })) };
      if (m.type === 'in') patch.refNo = h.refNo.trim();
      if (m.type === 'out' && orderIsSO(m)) patch.shipCode = h.shipCode.trim();
      const next = await saveSlipEdit(m, patch, reason.trim(), { email, name });
      onSaved?.(next);
      onClose();
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền sửa phiếu này.' : e2.message);
    }
    setBusy(false);
  };

  return (
    <Modal title={`✏️ Sửa ${m.type === 'out' ? 'phiếu xuất (DO)' : 'phiếu nhập'} ${m.id}`} onClose={onClose} wide>
      <p className="small" style={{ marginTop: 0 }}>
        {posted ? <>Phiếu <b>đã ghi tồn kho</b>: lưu sẽ đảo số cũ và ghi số mới vào tồn kho, pallet vị trí và số {m.type === 'out' ? 'đã giao' : 'đã nhận'} của đơn <b>{m.orderId || '–'}</b> trong cùng 1 lần. Đổi mã hàng / lot / vị trí thì hủy phiếu và lập lại.</>
          : <>Phiếu <b>chưa ghi tồn</b> ({m.status === 'pending' ? 'chờ thủ kho nhận' : 'chờ giải chấp'}): lưu chỉ sửa phiếu; phần còn phải {m.type === 'out' ? 'xuất' : 'nhập'} của đơn <b>{m.orderId || '–'}</b> tự tính lại.</>}
      </p>
      <div className="form-grid">
        <label className="field"><span>Ngày phiếu</span><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} /></label>
        {m.type === 'in' && <label className="field"><span>Số chứng từ</span><input value={h.refNo} onChange={(e) => setH({ ...h, refNo: e.target.value })} /></label>}
        {m.type === 'out' && orderIsSO(m) && <label className="field"><span>Giao đến (mã giao)</span><input value={h.shipCode} onChange={(e) => setH({ ...h, shipCode: e.target.value })} /></label>}
        <label className="field full"><span>Ghi chú</span><input value={h.note} onChange={(e) => setH({ ...h, note: e.target.value })} /></label>
      </div>
      <div className="table-wrap" style={{ margin: '10px 0' }}>
        <table>
          <thead><tr><th>Mã hàng</th><th>Lot</th><th>Vị trí</th><th>TTHH</th><th className="num">Kg cũ</th><th className="num">Số kg</th><th className="num">Pallet</th><th className="num">Số bao</th><th></th></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const off = !(n(l.kg) > 0);
              return (
                <tr key={i} style={off ? { opacity: 0.5 } : undefined}>
                  <td><b>{l.item}</b><div className="small">{l.itemName}</div></td><td>{l.lot}</td><td>{l.location}</td><td>{l.goodsStatus}</td>
                  <td className="num small">{fmtNum(m.lines[i]?.kg, 2)}</td>
                  <td className="num"><input type="number" min="0" step="any" style={{ width: 110 }} value={l.kg} onChange={(e) => setLine(i, 'kg', e.target.value)} /></td>
                  <td className="num"><input type="number" min="0" step="any" style={{ width: 80 }} value={l.pallets} onChange={(e) => setLine(i, 'pallets', e.target.value)} /></td>
                  <td className="num"><input type="number" min="0" step="any" style={{ width: 90 }} value={l.bags} onChange={(e) => setLine(i, 'bags', e.target.value)} /></td>
                  <td><button type="button" className="btn ghost sm" title="Bỏ dòng này (số lượng 0)" onClick={() => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, kg: 0, bags: 0, pallets: 0 } : x)))}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr><td colSpan={4}><b>Tổng</b></td><td className="num small">{fmtNum(total0, 2)}</td><td className="num"><b>{fmtNum(total1, 2)}</b></td><td colSpan={3} className="small">{Math.abs(total1 - total0) > 0.001 ? `${total1 > total0 ? '+' : '−'}${fmtNum(Math.abs(total1 - total0), 2)} kg so với phiếu cũ` : ''}</td></tr></tfoot>
        </table>
      </div>
      <label className="field"><span>Lý do sửa{posted && <b className="req"> *</b>}</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="VD: cân lại thực tế, khách lấy thiếu…" /></label>
      <ErrorBox error={err} />
      <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Thôi</button>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : posted ? 'Lưu & cập nhật tồn, đơn' : 'Lưu phiếu'}</button></div>
    </Modal>
  );
}

const orderIsSO = (m) => (m.orderType || String(m.orderId || '').slice(0, 2)) === 'SO';
