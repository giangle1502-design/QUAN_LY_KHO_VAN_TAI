import { useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { installColumnResize } from '../lib/colResize';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { CATALOGS, GROUPS, roleLabel } from '../catalogs';
import { REPORTS } from '../pages/reports/Reports';
import { norm } from '../lib/utils';
import { usePref } from '../lib/prefs';
import { FAV_KEY, MenuEditor, itemId, useNavLayout } from './NavCustom';

// Nhóm thu gọn sẵn lần đầu: các nhóm danh mục, quản trị dữ liệu
const DEFAULT_CLOSED = ['quan-tri', ...GROUPS.map((g) => `dm:${g}`)];

export default function Layout() {
  const { name, email, role, isAdmin, isSuper, can3PL, canDesign, hasRole, logout, settings, seesDebt } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const orderTab = (k) => ({ isActive }) => (isActive && (new URLSearchParams(loc.search).get('tab') || 'SO') === k ? 'active' : '');
  const [q, setQ] = useState('');
  const close = () => { setOpen(false); setQ(''); };
  const navRef = useRef(null);
  const searchRef = useRef(null);
  // Lọc menu theo ô tìm kiếm (không dấu, nhiều từ). Gõ trúng tên nhóm thì hiện cả nhóm.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const words = norm(q).split(' ').filter(Boolean);
    const hit = (el) => { const t = norm(el.textContent); return words.every((w) => t.includes(w)); };
    let header = null, headerHas = false, groupHit = false, total = 0;
    const endGroup = () => { if (header) header.hidden = words.length > 0 && !headerHas; };
    nav.querySelectorAll('a, .nav-group').forEach((el) => {
      if (el.classList.contains('nav-group')) {
        endGroup();
        header = el; headerHas = false; groupHit = words.length > 0 && hit(el);
        return;
      }
      const show = !words.length || groupHit || hit(el);
      el.hidden = !show;
      if (show) { headerHas = true; total++; }
    });
    endGroup();
    const empty = nav.querySelector('.nav-empty');
    if (empty) empty.hidden = total > 0;
  });
  // Ctrl+K hoặc "/" để nhảy vào ô tìm kiếm
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        e.preventDefault(); setOpen(true); searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onSearchKey = (e) => {
    if (e.key === 'Escape') { setQ(''); e.currentTarget.blur(); }
    if (e.key === 'Enter') navRef.current?.querySelector('a:not([hidden])')?.click();
  };
  const mainRef = useRef(null);
  useEffect(() => installColumnResize(mainRef.current), []);
  // Số yêu cầu xóa đang chờ quản trị gốc duyệt
  const [nDel, setNDel] = useState(0);
  useEffect(() => (isSuper ? onSnapshot(query(collection(db, 'deleteRequests'), where('status', '==', 'pending')), (s) => setNDel(s.size), () => {}) : undefined), [isSuper]);
  // Menu theo nhóm công việc (bán: SO → dự kiến xuất → phiếu xuất; mua: PO → phân bổ → phiếu nhập …).
  // Bấm tên nhóm để thu gọn / mở (nhớ trên trình duyệt); nhóm đang mở trang hiện tại luôn mở; khi tìm kiếm thì hiện hết.
  const [closed, setClosed] = usePref('nav-closed', DEFAULT_CLOSED);
  const toggle = (k) => setClosed(closed.includes(k) ? closed.filter((x) => x !== k) : [...closed, k]);
  const here = (to) => {
    const [path, qs] = to.split('?');
    if (path === '/' ? loc.pathname !== '/' : !(loc.pathname === path || loc.pathname.startsWith(path + '/'))) return false;
    const tab = qs && new URLSearchParams(qs).get('tab');
    return !tab || path !== '/don-hang' || (new URLSearchParams(loc.search).get('tab') || 'SO') === tab;
  };
  // Phiếu xuất / nhập mở từ nhóm Chuyển kho (?src=sto) và từ nhóm Bán / Mua dùng chung 1 trang: tô sáng đúng mục
  // DO / Danh sách đơn chờ nhập mở từ nhóm Bán / Mua (mọi loại đơn) hoặc nhóm Chuyển kho (?loai=STO)
  const slipTab = (k, loai) => ({ isActive }) => {
    const p = new URLSearchParams(loc.search);
    return isActive && p.get('tab') === k && (p.get('loai') || '') === loai ? 'active' : '';
  };
  const srcTab = (sto) => ({ isActive }) => (isActive && (new URLSearchParams(loc.search).get('src') === 'sto') === sto ? 'active' : '');
  const sections = [
    { key: 'ban', title: '🧾 Bán hàng (SO → xuất kho)', items: [
      { to: '/don-hang?tab=SO', cls: orderTab('SO'), ico: '🧾', label: 'Đơn bán (SO)' },
      { to: '/du-kien-xuat', ico: '📅', label: 'Dự kiến xuất kho (Sale)' },
      { to: '/kho/out', cls: srcTab(false), ico: '📤', label: 'Lập phiếu xuất kho', show: hasRole('thu_kho') },
      { to: '/don-hang?tab=DO', cls: slipTab('DO', ''), ico: '🚚', label: 'DO (lệnh giao hàng)' },
      { to: '/xe/giao-hang', ico: '✅', label: 'Xác nhận giao hàng', show: isAdmin },
    ] },
    { key: 'mua', title: '🛒 Mua hàng (PO → nhập kho)', items: [
      { to: '/don-hang?tab=PO', cls: orderTab('PO'), ico: '🛒', label: 'Đơn mua (PO)' },
      { to: '/phan-bo', ico: '📋', label: 'Kế hoạch phân bổ hàng mua' },
      { to: '/kho/in', cls: srcTab(false), ico: '📝', label: 'Lập phiếu nhập kho', show: isAdmin },
      { to: '/don-hang?tab=cho-nhap', cls: slipTab('cho-nhap', ''), ico: '📥', label: 'Danh sách đơn chờ nhập' },
      { to: '/kho/nhan-hang', ico: '📥', label: 'Nhận hàng (chờ nhập)', show: hasRole('thu_kho') },
    ] },
    { key: 'sto', title: '🔁 Chuyển kho (STO)', items: [
      { to: '/don-hang?tab=STO', cls: orderTab('STO'), ico: '🔁', label: 'Lệnh chuyển kho (STO)' },
      { to: '/kho/out?src=sto', cls: srcTab(true), ico: '📤', label: 'Xuất chuyển kho (kho đi)', show: hasRole('thu_kho') },
      { to: '/kho/in?src=sto', cls: srcTab(true), ico: '📥', label: 'Nhập chuyển kho (kho đến)', show: isAdmin },
      { to: '/don-hang?tab=DO&loai=STO', cls: slipTab('DO', 'STO'), ico: '🚚', label: 'DO chuyển kho (đã xuất)' },
      { to: '/don-hang?tab=cho-nhap&loai=STO', cls: slipTab('cho-nhap', 'STO'), ico: '⏳', label: 'STO chờ nhập (đang đi đường)' },
    ] },
    { key: 'kho', title: '🏭 Tồn kho & vận hành kho', items: [
      { to: '/kho/ton', ico: '🏭', label: 'Tồn kho' },
      { to: '/don-hang?tab=can-doi', cls: orderTab('can-doi'), ico: '⚖️', label: 'Cân đối theo mã hàng' },
      { to: '/kho/phieu', ico: '🧾', label: 'Phiếu kho (danh sách)' },
      { to: '/kho/move', ico: '🔀', label: 'Chuyển vị trí', show: hasRole('thu_kho') },
      { to: '/kho/adjust', ico: '⚖️', label: 'Điều chỉnh tồn', show: hasRole('thu_kho') },
      { to: '/kho/kiem-ke', ico: '🧮', label: 'Kiểm kê & cycle count' },
      { to: '/kho/pallet', ico: '🪵', label: 'Quản lý pallet' },
      { to: '/kho/ton-dau-ky', ico: '📋', label: 'Nhập tồn đầu kỳ', show: hasRole('thu_kho') },
    ] },
    { key: 'the-chap', title: '🔒 Thế chấp ngân hàng', items: [
      { to: '/kho/status', ico: '🔒', label: 'Đổi tình trạng thế chấp', show: hasRole('ke_toan') },
      { to: '/kho/giai-chap', ico: '🔓', label: 'Đề nghị giải chấp', show: hasRole('ke_toan') },
    ] },
    { key: 'xe', title: '🚚 Xe & vận tải', items: [
      { to: '/xe/dang-ky', ico: '🚚', label: 'Đăng ký xe', show: hasRole('bao_ve', 'thu_kho') },
      { to: '/xe/bao-ve', ico: '🛡️', label: 'Bảo vệ cổng', show: hasRole('bao_ve') },
      { to: '/xe/thu-kho', ico: '📦', label: 'Thủ kho điều phối', show: hasRole('thu_kho') },
      { to: '/xe/tong-quan', ico: '📊', label: 'Tổng quan chuyến xe' },
      { to: '/van-tai', ico: '🚛', label: 'Vận chuyển (chia xe, cước)' },
    ] },
    { key: 'cong-no', title: '💳 Công nợ', items: [
      { to: '/cong-no?tab=tong-hop', ico: '💳', label: 'Theo dõi công nợ (MISA)', show: seesDebt },
    ] },
    { key: 'bao-cao', title: '📊 Báo cáo', items: REPORTS.map(([k, ic, l]) => ({ to: `/bao-cao/${k}`, ico: ic, label: l })) },
    { key: 'thiet-lap', title: '🧩 Danh mục & thiết lập', items: [
      { to: '/dm', end: true, ico: '🏠', label: 'Tổng quan danh mục' },
      { to: '/hang-muc', ico: '🧩', label: 'Quản lý trường (hạng mục)', show: canDesign },
      { to: '/mau-in', ico: '🖨️', label: 'Thiết kế mẫu in', show: canDesign },
    ] },
    { key: 'quan-tri', title: '🗑️ Quản trị dữ liệu', items: [
      { to: '/quan-tri/xoa', ico: '🗑️', label: isSuper ? 'Duyệt xóa & lịch sử' : 'Yêu cầu xóa của tôi', badge: nDel },
      { to: '/quan-tri/du-lieu', ico: '🧹', label: 'Xóa dữ liệu chạy thử', show: isSuper },
    ] },
    ...GROUPS.map((g) => ({ key: `dm:${g}`, title: `📚 ${g}`, items: CATALOGS.filter((c) => c.group === g && (isAdmin || !c.adminOnly) && (!c.only3PL || can3PL))
      .map((c) => ({ to: `/dm/${c.key}`, ico: c.icon, label: c.short })) })),
  ];
  // Menu theo ý từng người: yêu thích, thư mục tự tạo, thứ tự, ẩn mục (lưu trên trình duyệt)
  const [nav, navApi] = useNavLayout(sections.map((sec) => ({ ...sec, items: sec.items.filter((x) => x.show !== false) })));
  const [editMenu, setEditMenu] = useState(false);
  const shownSecs = [...(nav.fav.length ? [{ key: FAV_KEY, title: '⭐ Yêu thích', items: nav.fav }] : []), ...nav.secs];
  const navItem = (x) => (
    <NavLink key={x.to + x.label} to={x.to} end={x.end} className={x.cls} onClick={close}>
      <span className="ico">{x.ico}</span>{x.label}{x.badge ? <span className="badge red" style={{ marginLeft: 6 }}>{x.badge}</span> : null}
      <span className={'fav-star' + (x.fav ? ' on' : '')} role="button" title={x.fav ? 'Bỏ khỏi Yêu thích' : 'Ghim vào Yêu thích'}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); navApi.toggleFav(itemId(x)); }}>{x.fav ? '★' : '☆'}</span>
    </NavLink>
  );
  return (
    <div className="shell">
      <aside className={'side' + (open ? ' open' : '')}>
        <div className="brand">{settings.companyName}<small>Kho & vận tải</small></div>
        <div className="nav-search">
          <input ref={searchRef} type="search" placeholder="🔍 Tìm chức năng… (Ctrl+K)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} />
          {role !== 'tai_xe' && role !== 'van_tai' && <button type="button" className="nav-cfg" title="Tùy chỉnh menu: yêu thích, thư mục, thứ tự, ẩn mục" onClick={() => setEditMenu(true)}>⚙</button>}
        </div>
        <div className="nav-wrap" ref={navRef}>
        {role === 'tai_xe' ? (
        <nav>
          <NavLink to="/tai-xe" onClick={close}><span className="ico">🧑‍✈️</span>Chuyến của tôi</NavLink>
        </nav>
        ) : role === 'van_tai' ? (
        <nav>
          <NavLink to="/van-tai?tab=don" onClick={close}><span className="ico">🚛</span>Vận chuyển</NavLink>
          <NavLink to="/dm/vehicles" onClick={close}><span className="ico">🚚</span>Xe của đơn vị</NavLink>
          <NavLink to="/dm/drivers" onClick={close}><span className="ico">🧑‍✈️</span>Tài xế của đơn vị</NavLink>
          {can3PL && <NavLink to="/dm/threepl" onClick={close}><span className="ico">🤝</span>3PL</NavLink>}
          <NavLink to="/quan-tri/xoa" onClick={close}><span className="ico">🗑️</span>Yêu cầu xóa của tôi</NavLink>
        </nav>
        ) : (
        <nav className={q ? 'searching' : ''}>
          <NavLink to="/" end onClick={close}><span className="ico">📈</span>Tổng quan</NavLink>
          {shownSecs.map((sec) => {
            const items = sec.items;
            if (!items.length) return null;
            const isOpen = !closed.includes(sec.key) || items.some((x) => here(x.to));
            return (
              <div key={sec.key} className={'nav-sec' + (isOpen ? '' : ' closed') + (sec.key === FAV_KEY ? ' nav-fav' : '')}>
                <div className="nav-group" role="button" tabIndex={0} onClick={() => toggle(sec.key)} onKeyDown={(e) => e.key === 'Enter' && toggle(sec.key)}
                  title={isOpen ? 'Thu gọn nhóm' : 'Mở nhóm'}>
                  <span>{sec.title}</span><span className="caret">{isOpen ? '▾' : '▸'}</span>
                </div>
                {items.map(navItem)}
              </div>
            );
          })}
        </nav>
        )}
        <div className="nav-empty" hidden>Không tìm thấy chức năng nào.</div>
        </div>
        <div className="me">
          <div><b>{name}</b><small>{email}</small><small className="role">{roleLabel(role)}</small></div>
          <button className="btn ghost sm" onClick={logout}>Đăng xuất</button>
        </div>
      </aside>
      {open && <div className="side-bg" onClick={close} />}
      {editMenu && <MenuEditor view={nav} api={navApi} onClose={() => setEditMenu(false)} />}
      <main ref={mainRef}>
        <button className="menu-btn" onClick={() => setOpen(true)}>☰</button>
        <Outlet />
      </main>
    </div>
  );
}
