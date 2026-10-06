import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { sendEmailVerification } from 'firebase/auth';
import { useApp } from './context/AppContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Home from './pages/Home';
import CatalogPage from './pages/CatalogPage';
import FieldManager from './pages/FieldManager';
import Register from './pages/transport/Register';
import { Delivery, Dock, Guard } from './pages/transport/Ops';
import Overview from './pages/transport/Overview';
import Stock from './pages/stock/Stock';
import Movements from './pages/stock/Movements';
import MovementForm from './pages/stock/MovementForm';
import OpeningImport from './pages/stock/OpeningImport';
import PrintMovement from './pages/stock/PrintMovement';
import PrintLabels from './pages/stock/PrintLabels';
import Dashboard from './pages/Dashboard';
import Orders from './pages/orders/Orders';

export default function App() {
  const { user, allowed, isAdmin, hasRole, loading, logout, email } = useApp();
  if (loading) return <div className="center">Đang tải…</div>;
  if (!user) return <Login />;
  if (!user.emailVerified) return <VerifyEmail user={user} logout={logout} />;
  if (!allowed)
    return (
      <div className="center">
        <div className="card narrow">
          <h2>Chưa được cấp quyền</h2>
          <p>Tài khoản <b>{email}</b> chưa có trong danh sách phân quyền. Vui lòng báo quản trị thêm email này ở mục <i>Phân quyền</i>.</p>
          <button className="btn" onClick={logout}>Đăng xuất</button>
        </div>
      </div>
    );
  return (
    <Routes>
      <Route path="kho/phieu/:id/in" element={<PrintMovement />} />
      <Route path="kho/phieu/:id/nhan" element={<PrintLabels />} />
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="dm" element={<Home />} />
        <Route path="dm/:key" element={<CatalogPage />} />
        {hasRole('bao_ve', 'thu_kho') && <Route path="xe/dang-ky" element={<Register />} />}
        {hasRole('bao_ve') && <Route path="xe/bao-ve" element={<Guard />} />}
        {hasRole('thu_kho') && <Route path="xe/thu-kho" element={<Dock />} />}
        {isAdmin && <Route path="xe/giao-hang" element={<Delivery />} />}
        <Route path="xe/tong-quan" element={<Overview />} />
        <Route path="don-hang" element={<Orders />} />
        <Route path="kho/ton" element={<Stock />} />
        <Route path="kho/phieu" element={<Movements />} />
        {hasRole('thu_kho') && <Route path="kho/ton-dau-ky" element={<OpeningImport />} />}
        <Route path="kho/:type" element={<MovementForm />} />
        {isAdmin && <Route path="hang-muc" element={<FieldManager />} />}
        <Route path="*" element={<Navigate to="/" />} />
      </Route>
    </Routes>
  );
}

function VerifyEmail({ user, logout }) {
  const [msg, setMsg] = useState('');
  return (
    <div className="center">
      <div className="card narrow">
        <h2>Xác nhận email</h2>
        <p>Đã gửi thư xác nhận tới <b>{user.email}</b>. Mở hộp thư (kể cả mục Spam), bấm link xác nhận rồi quay lại bấm nút bên dưới.</p>
        {msg && <div className="ok-box">{msg}</div>}
        <button className="btn primary" onClick={async () => { await user.reload(); await user.getIdToken(true); window.location.reload(); }}>
          Tôi đã xác nhận
        </button>
        <button className="btn" onClick={() => sendEmailVerification(user).then(() => setMsg('Đã gửi lại thư xác nhận.')).catch((e) => setMsg(e.message))}>
          Gửi lại thư
        </button>
        <button className="btn ghost" onClick={logout}>Đăng xuất</button>
      </div>
    </div>
  );
}
