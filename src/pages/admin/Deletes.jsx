import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { CATALOGS } from '../../catalogs';
import { COLL_LABEL, approveDelete, myRequests, rejectDelete } from '../../lib/deletes';
import { fmtTime } from '../../lib/trips';
import { Empty, ErrorBox, Modal } from '../../components/ui';

const ST = { pending: ['Chờ duyệt', 'amber'], approved: ['Đã duyệt xóa', 'red'], deleted: ['Quản trị gốc xóa', 'red'], rejected: ['Từ chối', 'green'], reset: ['Xóa dữ liệu hàng loạt', 'purple'] };
export const collLabel = (c) => COLL_LABEL[c] || CATALOGS.find((x) => x.key === c)?.short || c;

// Duyệt xóa: quản trị gốc xem các yêu cầu xóa của người dùng khác và lịch sử xóa; người khác xem yêu cầu của mình
export default function Deletes() {
  const { isSuper, email, name } = useApp();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(isSuper ? 'pending' : 'all');
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState('');
  useEffect(() => onSnapshot(isSuper ? collection(db, 'deleteRequests') : myRequests(email),
    (s) => setRows(s.docs.map((d) => d.data()).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))),
    (e) => setError(e.message)), [isSuper, email]);
  const list = rows.filter((r) => tab === 'all' || r.status === tab);
  const nPending = rows.filter((r) => r.status === 'pending').length;

  const approve = async (r) => {
    if (!window.confirm(`Xóa hẳn ${collLabel(r.coll)} "${r.label}"? Không khôi phục được.`)) return;
    setBusy(r.id); setError('');
    try { await approveDelete(r, { email, name }); setView(null); } catch (e) { setError(e.message); }
    setBusy('');
  };
  const reject = async (r) => {
    const note = window.prompt('Lý do từ chối (có thể để trống):', '');
    if (note === null) return;
    setBusy(r.id); setError('');
    try { await rejectDelete(r, { email, name }, note); setView(null); } catch (e) { setError(e.message); }
    setBusy('');
  };

  return (
    <div>
      <div className="page-head"><h1>🗑️ {isSuper ? 'Duyệt xóa & lịch sử xóa' : 'Yêu cầu xóa của tôi'}</h1></div>
      <p className="hint">{isSuper
        ? 'Người dùng khác bấm Xóa chỉ tạo yêu cầu. Anh xem dữ liệu, bấm Duyệt xóa để xóa hẳn hoặc Từ chối để giữ lại. Các lần anh tự xóa cũng được ghi ở đây.'
        : 'Bấm Xóa chỉ gửi yêu cầu. Quản trị gốc duyệt thì bản ghi mới bị xóa.'}</p>
      <div className="seg" style={{ marginBottom: 10 }}>
        {[['pending', `Chờ duyệt (${nPending})`], ['approved', 'Đã duyệt'], ['rejected', 'Từ chối'], ...(isSuper ? [['deleted', 'Tôi tự xóa'], ['reset', 'Xóa hàng loạt']] : []), ['all', 'Tất cả']]
          .map(([k, l]) => <button key={k} type="button" className={'btn sm' + (tab === k ? ' primary' : '')} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {!list.length ? <Empty text="Không có yêu cầu nào." /> : (
          <table>
            <thead><tr><th>Thời gian</th><th>Loại dữ liệu</th><th>Bản ghi</th><th>Lý do</th><th>Người yêu cầu</th><th>Trạng thái</th><th>Người duyệt</th><th></th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{fmtTime(r.requestedAt)}</td><td>{collLabel(r.coll)}</td>
                  <td><b className="mono">{r.docId}</b>{r.label && r.label !== r.docId ? <div className="small">{r.label}</div> : null}</td>
                  <td className="small">{r.reason}{r.note ? <div>Từ chối: {r.note}</div> : null}</td>
                  <td className="small">{r.requestedByName || r.requestedBy}</td>
                  <td><span className={'badge ' + (ST[r.status]?.[1] || '')}>{ST[r.status]?.[0] || r.status}</span></td>
                  <td className="small">{r.decidedByName || r.decidedBy}{r.decidedAt ? <div>{fmtTime(r.decidedAt)}</div> : null}</td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => setView(r)}>Xem</button>{' '}
                    {isSuper && r.status === 'pending' && <>
                      <button className="btn danger sm" disabled={busy === r.id} onClick={() => approve(r)}>Duyệt xóa</button>{' '}
                      <button className="btn sm" disabled={busy === r.id} onClick={() => reject(r)}>Từ chối</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {view && (
        <Modal title={`${collLabel(view.coll)}: ${view.docId}`} onClose={() => setView(null)} wide>
          <p className="small">Dữ liệu tại thời điểm {view.status === 'pending' ? 'yêu cầu xóa' : 'xóa'}:</p>
          <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="no-resize"><tbody>
              {Object.entries(view.data || {}).filter(([k]) => !['history'].includes(k)).map(([k, v]) => (
                <tr key={k}><td className="small nowrap"><b>{k}</b></td><td className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v)}</td></tr>
              ))}
            </tbody></table>
          </div>
          {isSuper && view.status === 'pending' && (
            <div className="form-actions">
              <button className="btn" onClick={() => reject(view)}>Từ chối</button>
              <button className="btn danger" onClick={() => approve(view)}>Duyệt xóa</button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
