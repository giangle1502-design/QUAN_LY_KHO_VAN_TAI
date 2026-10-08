import { useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { installColumnResize } from '../lib/colResize';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { CATALOGS, GROUPS, roleLabel } from '../catalogs';
import { REPORTS } from '../pages/reports/Reports';

export default function Layout() {
  const { name, email, role, isAdmin, isSuper, canDesign, hasRole, logout, settings } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const orderTab = (k) => ({ isActive }) => (isActive && (new URLSearchParams(loc.search).get('tab') || 'SO') === k ? 'active' : '');
  const close = () => setOpen(false);
  const mainRef = useRef(null);
  useEffect(() => installColumnResize(mainRef.current), []);
  // Số yêu cầu xóa đang chờ quản trị gốc duyệt
  const [nDel, setNDel] = useState(0);
  useEffect(() => (isSuper ? onSnapshot(query(collection(db, 'deleteRequests'), where('status', '==', 'pending')), (s) => setNDel(s.size), () => {}) : undefined), [isSuper]);
  return (
    <div className="shell">
      <aside className={'side' + (open ? ' open' : '')}>
        <div className="brand">{settings.companyName}<small>Kho & vận tải</small></div>
        <nav>
          <NavLink to="/" end onClick={close}><span className="ico">📈</span>Tổng quan</NavLink>
          <div className="nav-group">Đơn hàng</div>
          <NavLink to="/don-hang?tab=SO" className={orderTab('SO')} onClick={close}><span className="ico">🧾</span>Đơn bán (SO)</NavLink>
          <NavLink to="/don-hang?tab=PO" className={orderTab('PO')} onClick={close}><span className="ico">🛒</span>Đơn mua (PO)</NavLink>
          <NavLink to="/don-hang?tab=STO" className={orderTab('STO')} onClick={close}><span className="ico">🔁</span>Chuyển kho (STO)</NavLink>
          <NavLink to="/don-hang?tab=can-doi" className={orderTab('can-doi')} onClick={close}><span className="ico">⚖️</span>Cân đối theo mã hàng</NavLink>
          <div className="nav-group">Vận hành xe</div>
          {hasRole('bao_ve', 'thu_kho') && <NavLink to="/xe/dang-ky" onClick={close}><span className="ico">🚚</span>Đăng ký xe</NavLink>}
          {hasRole('bao_ve') && <NavLink to="/xe/bao-ve" onClick={close}><span className="ico">🛡️</span>Bảo vệ cổng</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/xe/thu-kho" onClick={close}><span className="ico">📦</span>Thủ kho điều phối</NavLink>}
          {isAdmin && <NavLink to="/xe/giao-hang" onClick={close}><span className="ico">✅</span>Xác nhận giao hàng</NavLink>}
          <NavLink to="/xe/tong-quan" onClick={close}><span className="ico">📊</span>Tổng quan chuyến xe</NavLink>
          <div className="nav-group">Kho hàng</div>
          <NavLink to="/kho/ton" onClick={close}><span className="ico">🏭</span>Tồn kho</NavLink>
          {isAdmin && <NavLink to="/kho/in" onClick={close}><span className="ico">📝</span>Lập phiếu nhập kho</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/kho/nhan-hang" onClick={close}><span className="ico">📥</span>Nhận hàng (chờ nhập)</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/kho/out" onClick={close}><span className="ico">📤</span>Xuất kho</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/kho/move" onClick={close}><span className="ico">🔀</span>Chuyển vị trí</NavLink>}
          {hasRole('ke_toan') && <NavLink to="/kho/status" onClick={close}><span className="ico">🔒</span>Đổi tình trạng thế chấp</NavLink>}
          {hasRole('ke_toan') && <NavLink to="/kho/giai-chap" onClick={close}><span className="ico">🔓</span>Đề nghị giải chấp</NavLink>}
          {hasRole('thu_kho') && <NavLink to="/kho/adjust" onClick={close}><span className="ico">⚖️</span>Điều chỉnh tồn</NavLink>}
          <NavLink to="/kho/phieu" onClick={close}><span className="ico">🧾</span>Phiếu kho</NavLink>
          {hasRole('thu_kho') && <NavLink to="/kho/ton-dau-ky" onClick={close}><span className="ico">📋</span>Nhập tồn đầu kỳ</NavLink>}
          <div className="nav-group">Báo cáo</div>
          {REPORTS.map(([k, ic, l]) => <NavLink key={k} to={`/bao-cao/${k}`} onClick={close}><span className="ico">{ic}</span>{l}</NavLink>)}
          <div className="nav-group">Danh mục</div>
          <NavLink to="/dm" onClick={close}><span className="ico">🏠</span>Tổng quan danh mục</NavLink>
          {canDesign && <NavLink to="/hang-muc" onClick={close}><span className="ico">🧩</span>Quản lý trường (hạng mục)</NavLink>}
          <div className="nav-group">Quản trị dữ liệu</div>
          <NavLink to="/quan-tri/xoa" onClick={close}><span className="ico">🗑️</span>{isSuper ? 'Duyệt xóa & lịch sử' : 'Yêu cầu xóa của tôi'}{nDel ? <span className="badge red" style={{ marginLeft: 6 }}>{nDel}</span> : null}</NavLink>
          {isSuper && <NavLink to="/quan-tri/du-lieu" onClick={close}><span className="ico">🧹</span>Xóa dữ liệu chạy thử</NavLink>}
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
        </nav>
        <div className="me">
          <div><b>{name}</b><small>{email}</small><small className="role">{roleLabel(role)}</small></div>
          <button className="btn ghost sm" onClick={logout}>Đăng xuất</button>
        </div>
      </aside>
      {open && <div className="side-bg" onClick={close} />}
      <main ref={mainRef}>
        <button className="menu-btn" onClick={() => setOpen(true)}>☰</button>
        <Outlet />
      </main>
    </div>
  );
}
