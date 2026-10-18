import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { setNoticeDone, useOpenNotices } from '../lib/legalTransfer';
import { fmtDate, fmtNum } from '../lib/utils';

// Chuông thông báo trên đầu trang (kế toán, quản trị): hiện các việc cần làm trên phần mềm kế toán,
// vd. phiếu xuất lấy tồn công ty khác → chuyển pháp nhân. Bấm "Đã xử lý" khi đã làm xong.
export default function NoticeBell() {
  const { hasRole, isAdmin, email, name } = useApp();
  const show = isAdmin || hasRole('ke_toan');
  const list = useOpenNotices(show);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  if (!show) return null;
  const done = async (n) => {
    setErr('');
    try { await setNoticeDone(n.id, true, { email, name }); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="bell-wrap">
      <button type="button" className={'bell' + (list.length ? ' has' : '')} onClick={() => setOpen(!open)} title="Thông báo cho kế toán">
        🔔{list.length > 0 && <span className="bell-n">{list.length}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="bell-head"><b>Thông báo ({list.length})</b><Link to="/bao-cao/chuyen-phap-nhan" onClick={() => setOpen(false)}>Báo cáo chuyển pháp nhân →</Link></div>
          {err && <div className="error-box">{err}</div>}
          {!list.length && <div className="small" style={{ padding: 10 }}>Không có việc nào cần xử lý.</div>}
          {list.map((n) => (n.kind === 'vendor_return' ? (
            <div key={n.id} className="bell-item">
              <div>↩ <b>Trả hàng NCC, PO đã thanh toán</b> · <Link className="mono" to={`/don-hang?tab=RTV&q=${n.rtvId}`} onClick={() => setOpen(false)}>{n.rtvId}</Link> · PO {n.orderId} · {fmtDate(n.date)}</div>
              <div className="small">Treo công nợ phải thu NCC <b>{n.partyCode} {n.partyName}</b>{n.company ? ` (công ty ${n.company})` : ''}: {fmtNum(n.kg, 2)} kg trả lại. Người lập: {n.createdByName || n.createdBy}.</div>
              <div className="small">{(n.lines || []).map((l) => `${l.item} ${fmtNum(l.kg, 2)} kg${l.reason ? ` (${l.reason})` : ''}`).join(' · ')}</div>
              <button type="button" className="btn sm" onClick={() => done(n)}>✓ Đã treo công nợ trên phần mềm kế toán</button>
            </div>
          ) : (
            <div key={n.id} className="bell-item">
              <div>🏛️ <b>Chuyển pháp nhân</b> · phiếu <Link className="mono" to={`/kho/phieu/${n.movementId}/in`} target="_blank">{n.movementId}</Link>
                {n.orderId ? <> · {n.orderId}</> : null} · {fmtDate(n.date)} · kho {n.warehouse}</div>
              <div className="small">
                Xuất cho <b>{n.company}</b>{n.partyName ? ` (khách ${n.partyName})` : ''}, lấy tồn của {Object.entries(n.byCompany || {}).map(([c, k]) => `${c} ${fmtNum(k, 2)} kg`).join(', ')}.
                {n.shortWarned ? ' Tồn công ty xuất không đủ.' : ''} Người lập: {n.createdByName || n.createdBy}.
              </div>
              <div className="small">{(n.lines || []).map((l) => `${l.from}→${n.company}: ${l.item}${l.lot ? ` lot ${l.lot}` : ''} ${fmtNum(l.kg, 2)} kg`).join(' · ')}</div>
              <button type="button" className="btn sm" onClick={() => done(n)}>✓ Đã chuyển trên phần mềm kế toán</button>
            </div>
          )))}
        </div>
      )}
    </div>
  );
}
