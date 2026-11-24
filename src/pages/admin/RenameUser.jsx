import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { ErrorBox, Field, Modal } from '../../components/ui';
import { EMAIL_RE, renameUser } from '../../lib/userRename';

// Phân quyền → mở 1 người dùng → "✏ Đổi email": sửa email nhập sai / đổi email mới,
// giữ nguyên vai trò, kho, quyền và mọi dữ liệu người đó đang phụ trách (đơn, khách hàng, Sale control, nhóm chat…)
export function RenameUserButton({ row, existing = [], onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn sm" onClick={() => setOpen(true)} title="Sửa email đăng nhập (giữ nguyên quyền và dữ liệu)">✏ Đổi email</button>
      {open && <RenameUserModal row={row} existing={existing} onClose={() => setOpen(false)} onDone={(t) => { setOpen(false); onDone(t); }} />}
    </>
  );
}

function RenameUserModal({ row, existing, onClose, onDone }) {
  const { email, name, isSuper } = useApp();
  const from = row._id;
  const [to, setTo] = useState(from);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const t = to.trim().toLowerCase();
  const self = from === email;
  const clash = t !== from && existing.find((r) => r._id === t && !(r.oldEmails || []).includes(from));

  const run = async (e) => {
    e.preventDefault();
    setErr('');
    if (!EMAIL_RE.test(t)) return setErr('Email mới không hợp lệ.');
    if (t === from) return setErr('Email mới trùng email hiện tại.');
    if (clash) return setErr(`Email ${t} đã có trong Phân quyền (${clash.name || ''}).`);
    if (!window.confirm(`Đổi email đăng nhập của ${row.name || from}\n${from} → ${t}\n\nTừ giờ người này đăng nhập bằng email mới; email cũ không vào được nữa. Tiếp tục?`)) return;
    setBusy(true);
    try {
      const r = await renameUser(row, t, { email, name }, { isSuper, onProgress: setStep });
      const errs = r.done.filter((x) => x.includes('lỗi'));
      onDone(`Đã đổi email ${r.from} → ${r.to}. Giữ nguyên vai trò, quyền và dữ liệu phụ trách`
        + (r.done.length - errs.length ? ` (đã chuyển: ${r.done.filter((x) => !x.includes('lỗi')).join(', ')})` : '') + '.'
        + (errs.length ? `\nChưa chuyển được: ${errs.join(', ')}. Bấm đổi lại cùng email mới để làm tiếp.` : ''));
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Không có quyền ghi (cần quản trị; kiểm tra đã dán quy tắc Firestore mới).' : e2.message);
    }
    setBusy(false);
    setStep('');
  };

  return (
    <Modal title="Đổi email đăng nhập" onClose={busy ? () => {} : onClose}>
      <form onSubmit={run}>
        <p className="small">Người dùng: <b>{row.name || from}</b> · email hiện tại <b>{from}</b></p>
        <Field label="Email mới" required help="Email Google / email người này dùng để đăng nhập. Vai trò, kho, quyền, đơn hàng, khách hàng phụ trách, khách đang tiếp cận, hoạt động, nhóm trò chuyện được chuyển sang email mới.">
          <input type="email" value={to} onChange={(e) => setTo(e.target.value)} autoFocus disabled={busy} />
        </Field>
        {clash && <div className="error-box">Email này đã có trong Phân quyền ({clash.name || clash._id}).</div>}
        {self && <p className="hint">Bạn đang đổi email của chính mình: sau khi đổi, đăng xuất và đăng nhập lại bằng email mới.</p>}
        {(row.oldEmails || []).length > 0 && <p className="small">Email cũ trước đây: {row.oldEmails.join(', ')}</p>}
        {step && <p className="small">⏳ {step}</p>}
        <ErrorBox error={err} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Đóng</button>
          <button className="btn primary" disabled={busy || !t || t === from}>{busy ? 'Đang đổi…' : 'Đổi email'}</button>
        </div>
      </form>
    </Modal>
  );
}
