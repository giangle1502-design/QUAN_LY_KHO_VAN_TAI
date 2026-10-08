import { useState } from 'react';
import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { CATALOGS } from '../../catalogs';
import { resetCodeRules, resetLocations, wipeCollection } from '../../lib/deletes';
import { ErrorBox } from '../../components/ui';

// Xóa dữ liệu chạy thử để làm lại từ đầu (chỉ quản trị gốc). Giữ phân quyền (users) và cấu hình biểu mẫu.
const TX = [
  ['orders', 'Đơn hàng SO / PO / STO'],
  ['movements', 'Phiếu kho (nhập, xuất, chuyển vị trí, điều chỉnh, đổi tình trạng)'],
  ['stock', 'Tồn kho'],
  ['releaseRequests', 'Đề nghị giải chấp'],
  ['trips', 'Chuyến xe'],
  ['counters', 'Bộ đếm số theo ngày (số đề nghị giải chấp…)'],
];
const CATS = CATALOGS.filter((c) => !['users', 'codeRules'].includes(c.key));
const CONFIRM = 'XOA DU LIEU';

export default function ResetData() {
  const { isSuper, email, name } = useApp();
  const [pick, setPick] = useState(() => Object.fromEntries([...TX.map(([k]) => [k, true]), ['locReset', true], ['codeReset', true], ['deleteRequests', false]]));
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [err, setErr] = useState('');
  if (!isSuper) return <p>Chỉ quản trị gốc dùng được chức năng này.</p>;
  const tog = (k) => setPick((p) => ({ ...p, [k]: !p[k] }));
  const chosen = Object.keys(pick).filter((k) => pick[k]);
  const add = (line) => setLog((l) => [...l, line]);

  const run = async () => {
    setErr(''); setLog([]);
    if (typed.trim().toUpperCase() !== CONFIRM) return setErr(`Gõ đúng "${CONFIRM}" để xác nhận.`);
    if (!chosen.length) return setErr('Chưa chọn dữ liệu nào.');
    if (!window.confirm('Xóa hẳn các dữ liệu đã chọn? Không khôi phục được.')) return;
    setBusy(true);
    const summary = {};
    try {
      for (const [k, l] of [...TX, ...CATS.map((c) => [c.key, c.title]), ['deleteRequests', 'Lịch sử xóa']]) {
        if (!pick[k]) continue;
        add(`Đang xóa ${l}…`);
        summary[k] = await wipeCollection(k);
        add(`✓ ${l}: đã xóa ${summary[k]} bản ghi`);
      }
      if (pick.locReset && !pick.locations) { const n = await resetLocations(); add(`✓ Vị trí: đưa ${n} vị trí về 0 pallet`); summary.locationsReset = n; }
      if (pick.codeReset) { const n = await resetCodeRules(); add(`✓ Mã tự sinh: đưa ${n} quy tắc về số 1`); summary.codeRulesReset = n; }
      const ref = doc(collection(db, 'deleteRequests'));
      await setDoc(ref, { id: ref.id, coll: '*', docId: 'Xóa dữ liệu chạy thử', label: chosen.join(', '), data: summary, reason: 'Làm lại từ đầu',
        status: 'reset', requestedBy: email, requestedByName: name, requestedAt: new Date().toISOString(), decidedBy: email, decidedByName: name,
        decidedAt: new Date().toISOString(), createdAt: serverTimestamp() });
      add('Hoàn tất.');
      setTyped('');
    } catch (e) {
      setErr(e.code === 'permission-denied' ? 'Không có quyền xóa: cần publish lại firestore.rules mới.' : e.message);
    }
    setBusy(false);
  };

  return (
    <div>
      <div className="page-head"><h1>🧹 Xóa dữ liệu chạy thử</h1></div>
      <p className="hint">Dùng khi muốn làm lại từ đầu. <b>Không xóa</b> tài khoản & phân quyền và cấu hình biểu mẫu. Đã xóa thì không khôi phục được, nên xuất Excel các danh mục cần giữ trước.</p>
      <div className="grid2">
        <div className="card">
          <div className="section-head">Dữ liệu giao dịch</div>
          {TX.map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={!!pick[k]} onChange={() => tog(k)} /> {l}</label>)}
          <label className="check"><input type="checkbox" checked={!!pick.locReset} onChange={() => tog('locReset')} /> Đưa số pallet đang chứa của mọi vị trí về 0 (giữ danh mục vị trí)</label>
          <label className="check"><input type="checkbox" checked={!!pick.codeReset} onChange={() => tog('codeReset')} /> Đưa số chứng từ tự sinh (PN, PX, SO, PO…) về 1</label>
          <label className="check"><input type="checkbox" checked={!!pick.deleteRequests} onChange={() => tog('deleteRequests')} /> Lịch sử xóa / yêu cầu xóa</label>
        </div>
        <div className="card">
          <div className="section-head">Danh mục (chỉ chọn khi muốn nhập lại danh mục)</div>
          {CATS.map((c) => <label key={c.key} className="check"><input type="checkbox" checked={!!pick[c.key]} onChange={() => tog(c.key)} /> {c.icon} {c.title}</label>)}
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <p style={{ marginTop: 0 }}>Gõ <b className="mono">{CONFIRM}</b> để xác nhận:</p>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={CONFIRM} style={{ maxWidth: 260 }} />{' '}
        <button className="btn danger" disabled={busy} onClick={run}>{busy ? 'Đang xóa…' : '🧹 Xóa dữ liệu đã chọn'}</button>
        <ErrorBox error={err} />
        {log.length > 0 && <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{log.join('\n')}</pre>}
      </div>
    </div>
  );
}
