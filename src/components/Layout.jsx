import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { CATALOGS, GROUPS, roleLabel } from '../catalogs';

export default function Layout() {
  const { name, email, role, isAdmin, logout, settings } = useApp();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="shell">
      <aside className={'side' + (open ? ' open' : '')}>
        <div className="brand">{settings.companyName}<small>Thiết lập danh mục</small></div>
        <nav>
          <NavLink to="/" end onClick={close}><span className="ico">🏠</span>Tổng quan danh mục</NavLink>
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
