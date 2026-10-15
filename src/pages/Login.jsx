import { useState } from 'react';
import {
  createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup,
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';

const MSG = {
  'auth/invalid-credential': 'Sai email hoặc mật khẩu.',
  'auth/email-already-in-use': 'Email đã được đăng ký, hãy đăng nhập.',
  'auth/weak-password': 'Mật khẩu tối thiểu 6 ký tự.',
  'auth/invalid-email': 'Email không hợp lệ.',
};

export default function Login() {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  // Mở từ link tài xế (/tai-xe): trang đăng nhập riêng, to, dễ bấm trên điện thoại
  const driver = window.location.pathname.startsWith('/tai-xe');

  const run = async (fn) => {
    setErr(''); setInfo(''); setBusy(true);
    try { await fn(); } catch (e) { setErr(MSG[e.code] || e.message); }
    setBusy(false);
  };
  const submit = (e) => {
    e.preventDefault();
    run(() => mode === 'login'
      ? signInWithEmailAndPassword(auth, email.trim(), pw)
      : createUserWithEmailAndPassword(auth, email.trim(), pw).then((c) => sendEmailVerification(c.user)));
  };

  return (
    <div className="center login">
      <form className="card narrow" onSubmit={submit}>
        <h2>{driver ? '🧑‍✈️ Đăng nhập tài xế' : 'Hệ thống kho & vận tải'}</h2>
        <p className="muted">{mode === 'login' ? (driver ? 'Dùng email điều phối đã khai cho bạn. Đăng nhập xong nhập số xe để nhận chuyến.' : 'Đăng nhập để tiếp tục')
          : 'Tạo mật khẩu cho email đã được quản lý cấp quyền'}</p>
        {driver && mode === 'login' && <p className="small" style={{ marginTop: 0 }}>Lần đầu dùng: bấm <b>Lần đầu sử dụng? Đăng ký</b> ở dưới, nhập email đó và tự đặt mật khẩu, rồi mở email để xác nhận.</p>}
        <button type="button" className="btn google" disabled={busy} onClick={() => run(() => signInWithPopup(auth, googleProvider))}>
          Đăng nhập bằng Google
        </button>
        <div className="or">hoặc</div>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Mật khẩu" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={6} />
        {err && <div className="error-box">{err}</div>}
        {info && <div className="ok-box">{info}</div>}
        <button className="btn primary" disabled={busy}>{mode === 'login' ? 'Đăng nhập' : 'Đăng ký'}</button>
        <div className="row-between">
          <a onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
            {mode === 'login' ? 'Lần đầu sử dụng? Đăng ký' : 'Đã có tài khoản? Đăng nhập'}
          </a>
          {mode === 'login' && (
            <a onClick={() => email ? run(async () => { await sendPasswordResetEmail(auth, email.trim()); setInfo('Đã gửi email đặt lại mật khẩu.'); }) : setErr('Nhập email trước.')}>
              Quên mật khẩu?
            </a>
          )}
        </div>
      </form>
    </div>
  );
}
