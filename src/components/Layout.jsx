import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { CATALOGS, GROUPS, roleLabel } from '../catalogs';

export default function Layout() {
  const { name, email, role, isAdmin, hasRole, logout, settings } = useApp();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="shell">
      <aside className={'side' + (open ? ' open' : '')}>
        <div className="brand">{settings.companyName}<small>Kho & vận tải</small></div>
        <nav>
          <NavLink to="/" end onClick={close}><span className="ico">📈</span>Tổng quan</NavLink>
          <div className="nav-group">Vận hành xe</div>
          {hasRole('bao_ve', 'thu_kho') && <NavLink to="/xe/dang-ky" onClick={close}><span className="ico">🚚</span>Đăng ký xe</NavLink>}
          {hasRole('bao_ve') && <NavLink to="/xe/bao-ve" onClick={close}><span className="ico">🛡️</span>Bảo vệ cổng</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/xe/thu-kho" onClick={close}><span className="ico">📦</span>Thủ kho điều phối</NavLink>}
          {isAdmin && <NavLink to="/xe/giao-hang" onClick={close}><span className="ico">✅</span>Xác nhận giao hàng</NavLink>}
          <NavLink to="/xe/tong-quan" onClick={close}><span className="ico">📊</span>Tổng quan chuyến xe</NavLink>
          <div className="nav-group">Kho hàng</div>
          <NavLink to="/kho/ton" onClick={close}><span className="ico">🏭</span>Tồn kho</NavLink>
          {hasRole('thu_kho') && <NavLink to="/kho/in" onClick={close}><span className="ico">📥</span>Nhập kho</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/kho/out" onClick={close}><span className="ico">📤</span>Xuất kho</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/kho/move" onClick={close}><span className="ico">🔀</span>Chuyển vị trí</NavLink>}
          {hasRole('ke_toan') && <NavLink to="/kho/status" onClick={close}><span className="ico">🔒</span>Đổi tình trạng thế chấp</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/kho/adjust" onClick={close}><span className="ico">⚖️</span>Điều chỉnh tồn</NavLink>}
          <NavLink to="/kho/phieu" onClick={close}><span className="ico">🧾</span>Phiếu kho</NavLink>
          {hasRole('thu_kho') && <NavLink to="/kho/ton-dau-ky" onClick={close}><span className="ico">📋</span>Nhập tồn đầu kỳ</NavLink>}
          <div className="nav-group">Danh mục</div>
          <NavLink to="/dm" onClick={close}><span className="ico">🏠</span>Tổng quan danh mục</NavLink>
          {GROUPS.map((g) => {
            const list = CATALOGS.filter((c) => c.group === g && (isAdmin || !c.adminOnly));
            if (!list.length) return null;
            return (
              <div key={g}>
                <div className="nav-group">{g}</div>
                {list.map((c) => (
                  <NavLink key={c.key} to={`/dm/${c.key}`} onClick={close}><span className="ico">{c.icon}</span>{c.short}</NavLink>
                ))}
              </div>
            );
          })}
          {isAdmin && (
            <NavLink to="/hang-muc" onClick={close}><span className="ico">🧩</span>Quản lý hạng mục</NavLink>
          )}
        </nav>
        <div className="me">
          <div><b>{name}</b><small>{email}</small><small className="role">{roleLabel(role)}</small></div>
          <button className="btn ghost sm" onClick={logout}>Đăng xuất</button>
        </div>
      </aside>
      {open && <div className="side-bg" onClick={close} />}
      <main>
        <button className="menu-btn" onClick={() => setOpen(true)}>☰</button>
        <Outlet />
      </main>
    </div>
  );
}
