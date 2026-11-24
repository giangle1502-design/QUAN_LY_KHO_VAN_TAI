import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { ErrorBox, Field, Modal } from '../../components/ui';
import { canRenameCode, renameCode } from '../../lib/renameCode';

// Form sửa danh mục → "✏ Đổi mã" (quản trị gốc): đổi mã bản ghi (VD Công ty VAPC → VAP)
// và cập nhật tồn kho, phiếu, đơn, danh mục khác đang dùng mã cũ
export function RenameCodeButton({ cat, row, onDone }) {
  const { isSuper } = useApp();
  const [open, setOpen] = useState(false);
  if (!isSuper || !canRenameCode(cat) || !row?._id) return null;
  return (
    <>
      <button type="button" className="btn sm" onClick={() => setOpen(true)} title="Đổi mã và cập nhật mọi dữ liệu đang dùng mã cũ">✏ Đổi mã</button>
      {open && <span onSubmit={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}><RenameCodeModal cat={cat} row={row} onClose={() => setOpen(false)} onDone={(t, id) => { setOpen(false); onDone(t, id); }} /></span>}
    </>
  );
}

function RenameCodeModal({ cat, row, onClose, onDone }) {
  const { email } = useApp();
  const from = row._id;
  const [to, setTo] = useState(from);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const t = cat.upperId ? to.trim().toUpperCase() : to.trim();

  const run = async (e) => {
    e.preventDefault();
    e.stopPropagation(); // không để "Lưu" của form danh mục bên dưới chạy theo (sự kiện React đi xuyên portal)
    setErr('');
    if (!t || t === from) return setErr('Nhập mã mới khác mã hiện tại.');
    if (!window.confirm(`Đổi mã ${cat.short} ${from} → ${t}?\n\nMọi tồn kho, phiếu, đơn hàng, danh mục đang dùng ${from} sẽ chuyển sang ${t}. Nên làm lúc không ai đang nhập liệu. Tiếp tục?`)) return;
    setBusy(true);
    try {
      const r = await renameCode(cat, row, t, { email }, { onProgress: setStep });
      const errs = r.done.filter((x) => x.includes('lỗi'));
      const ok = r.done.filter((x) => !x.includes('lỗi'));
      onDone(`Đã đổi mã ${r.from} → ${r.to}.` + (ok.length ? ` Đã cập nhật: ${ok.join(', ')}.` : ' Chưa có dữ liệu nào dùng mã cũ.')
        + (errs.length ? `\nChưa cập nhật được: ${errs.join(', ')}. Mã cũ được giữ lại; bấm đổi lại cùng mã mới để làm tiếp.` : ''), r.to);
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Không có quyền ghi (cần quản trị gốc; kiểm tra đã dán quy tắc Firestore mới).' : e2.message);
    }
    setBusy(false);
    setStep('');
  };

  return (
    <Modal title={`Đổi mã ${cat.short}`} onClose={busy ? () => {} : onClose}>
      <form onSubmit={run}>
        <p className="small">{cat.short}: <b>{from}</b>{row.name ? ` – ${row.name}` : ''}</p>
        <Field label="Mã mới" required help="Tồn kho, phiếu kho, đơn SO/PO/STO, giải chấp, chuyến xe và các danh mục đang dùng mã cũ đều được chuyển sang mã mới. Mã cũ ghi lại ở bản ghi (oldCodes).">
          <input value={to} onChange={(e) => setTo(e.target.value)} autoFocus disabled={busy} />
        </Field>
        {(row.oldCodes || []).length > 0 && <p className="small">Mã cũ trước đây: {row.oldCodes.join(', ')}</p>}
        {step && <p className="small">⏳ {step}</p>}
        <ErrorBox error={err} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Đóng</button>
          <button className="btn primary" disabled={busy || !t || t === from}>{busy ? 'Đang đổi…' : 'Đổi mã'}</button>
        </div>
      </form>
    </Modal>
  );
}
