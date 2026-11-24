import { useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { installColumnResize } from '../lib/colResize';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { CATALOGS, GROUPS, roleLabel } from '../catalogs';
import { REPORTS } from '../pages/reports/Reports';
import { norm } from '../lib/utils';
import { usePref } from '../lib/prefs';
import NoticeBell from './NoticeBell';
import ChatBell from './ChatBell';
import { codeMatches, findTarget, parseCommand, tcodeOf } from '../lib/tcodes';
import { BarEditor, FAV_KEY, MenuEditor, itemId, useNavLayout } from './NavCustom';
import { Modal } from './ui';

// Nhóm thu gọn sẵn lần đầu: các nhóm danh mục, quản trị dữ liệu
const DEFAULT_CLOSED = ['quan-tri', ...GROUPS.map((g) => `dm:${g}`)];
// Hạng mục lớn "Danh mục & thiết lập" gom các nhóm con: thiết lập chung, từng nhóm danh mục, quản trị dữ liệu
const PARENT = { key: 'dm-all', title: '📚 Danh mục & thiết lập' };
const isSub = (k) => k === 'thiet-lap' || k === 'quan-tri' || k.startsWith('dm:');

export default function Layout() {
  const { name, email, role, isAdmin, isSuper, can3PL, canDesign, hasRole, logout, settings, fmtKey } = useApp();
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
    // Gõ lệnh "/MÃ" hoặc "/O&MÃ": lọc theo mã chức năng; không mã nào khớp thì lọc gần đúng theo tên
    const cmd = parseCommand(q);
    const words = norm(cmd ? cmd.term : q).split(' ').filter(Boolean);
    const byCode = cmd && words.length > 0 && [...nav.querySelectorAll('a')].some((a) => codeMatches(a.getAttribute('href'), cmd.term));
    const hit = (el) => {
      if (byCode) return el.tagName === 'A' && codeMatches(el.getAttribute('href'), cmd.term);
      const t = norm(el.textContent); return words.every((w) => t.includes(w));
    };
    let header = null, headerHas = false, groupHit = false, total = 0;
    const endGroup = () => { if (header) header.hidden = words.length > 0 && !headerHas; };
    nav.querySelectorAll('a, .nav-group:not(.nav-parent-head)').forEach((el) => {
      if (el.classList.contains('nav-group')) {
        endGroup();
        header = el; headerHas = false; groupHit = !cmd && words.length > 0 && hit(el);
        return;
      }
      const show = !words.length || groupHit || hit(el);
      el.hidden = !show;
      if (show) { headerHas = true; total++; }
    });
    endGroup();
    nav.querySelectorAll('.nav-parent').forEach((p) => { p.hidden = words.length > 0 && !p.querySelector('a:not([hidden])'); });
    const empty = nav.querySelector('.nav-empty');
    if (empty) empty.hidden = total > 0;
  });
  // Ctrl+K hoặc "/" để nhảy vào ô tìm kiếm
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        e.preventDefault(); setOpen(true); searchRef.current?.focus();
        if (e.key === '/') setQ('/'); // phím "/" vào thẳng chế độ gõ mã lệnh
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onSearchKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setQ(''); e.currentTarget.blur(); }
    if (e.key !== 'Enter') return;
    const cmd = parseCommand(q);
    if (!cmd) {
      // Gõ đúng mã (không có "/") cũng mở luôn chức năng đó, còn lại mở mục đầu tiên đang hiện
      const exact = q.trim() && cmdItems().find((x) => tcodeOf(x.to) && tcodeOf(x.to) === norm(q).toUpperCase().replace(/\s+/g, ''));
      if (exact) { navigate(exact.to); close(); e.currentTarget.blur(); return; }
      navRef.current?.querySelector('a:not([hidden])')?.click();
      return;
    }
    e.preventDefault();
    const target = cmd.term ? findTarget(cmdItems(), cmd.term) : { to: loc.pathname + loc.search };
    if (!target || (!cmd.term && !cmd.newTab)) return;
    if (cmd.newTab) window.open(target.to, '_blank', 'noopener');
    else navigate(target.to);
    close(); e.currentTarget.blur();
  };
  const mainRef = useRef(null);
  useEffect(() => installColumnResize(mainRef.current), []);
  // Số yêu cầu xóa đang chờ quản trị gốc duyệt
  const [nDel, setNDel] = useState(0);
  useEffect(() => (isSuper ? onSnapshot(query(collection(db, 'deleteRequests'), where('status', '==', 'pending')), (s) => setNDel(s.size), () => {}) : undefined), [isSuper]);
  // Menu theo nhóm công việc (bán: SO → dự kiến xuất → phiếu xuất; mua: PO → phân bổ → phiếu nhập …).
  // Mặc định "gọn": mỗi lúc chỉ mở 1 nhóm (bấm nhóm khác thì nhóm cũ tự đóng), tự mở nhóm của trang đang xem → menu vừa màn hình.
  // Tắt chế độ gọn (⚙ Tùy chỉnh menu) thì mở / đóng từng nhóm tự do như trước. Khi tìm kiếm thì hiện hết.
  const [closed, setClosed] = usePref('nav-closed', DEFAULT_CLOSED);
  const [multi, setMulti] = usePref('nav-multi', false);
  const [acc, setAcc] = usePref('nav-acc', { top: null, sub: null });
  const toggleClosed = (k) => setClosed(closed.includes(k) ? closed.filter((x) => x !== k) : [...closed, k]);
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
  const srcTab = (sto) => ({ isActive }) => (isActive && (new URLSearchParams(loc.search).get('src') || '') === (sto === true ? 'sto' : sto || '') ? 'active' : '');
  // Mục "➕ Lập … mới": mở thẳng form tạo mới (?new=1), không tô sáng như trang đang xem
  const noActive = () => '';
  const saleTab = (k) => ({ isActive }) => (isActive && (new URLSearchParams(loc.search).get('tab') || 'tiep-can') === k ? 'active' : '');
  const navigate = useNavigate();
  const fullMenu = !['tai_xe', 'van_tai', 'tpl'].includes(role);
  const canSO = hasRole('kinh_doanh', 'ke_toan');
  const isSale = hasRole('kinh_doanh');
  const sections = [
    // Thư mục Sale control (gộp từ app Sale control): khách đang tiếp cận / đã chốt đơn, hoạt động, phân tích bán hàng
    { key: 'sale', title: '💼 Sale control', items: [
      { to: '/sale/khach-hang?tab=tiep-can', cls: saleTab('tiep-can'), ico: '🎯', label: 'Khách hàng đang tiếp cận', show: isSale },
      { to: '/sale/khach-hang?tab=da-chot', cls: saleTab('da-chot'), ico: '✅', label: 'Khách hàng đã chốt đơn', show: isSale },
      { to: '/sale/hoat-dong', ico: '📞', label: 'Hoạt động khách hàng', show: isSale },
      { to: '/bao-cao/phan-tich-ban-hang', ico: '📈', label: 'Phân tích bán hàng', show: isSale },
    ] },
    // Điều phối kho: bàn điều phối đầu ngày + 2 danh sách đơn còn phải xuất / nhập (mỗi dòng 1 đơn)
    { key: 'dieu-phoi', title: '🧭 Điều phối kho', items: [
      { to: '/dieu-phoi', end: true, ico: '🧭', label: 'Bàn điều phối kho' },
      { to: '/dieu-phoi/cho-xuat', ico: '📤', label: 'Đơn chờ xuất (SO, STO)' },
      { to: '/dieu-phoi/cho-nhap', ico: '📥', label: 'Đơn chờ nhập (PO, STO, DRT)' },
    ] },
    { key: 'ban', title: '🧾 Bán hàng (SO → xuất)', items: [
      { to: '/don-hang?tab=SO&new=1', cls: noActive, ico: '➕', label: 'Lập SO mới', show: canSO },
      { to: '/don-hang?tab=SO&scan=1', cls: noActive, ico: '📷', label: 'Lập SO từ ảnh Biên bản giao hàng (Ecount)', show: canSO },
      { to: '/du-kien-xuat?new=1', cls: noActive, ico: '➕', label: 'Tạo dự kiến xuất', show: canSO },
      { to: '/don-hang?tab=SO', cls: orderTab('SO'), ico: '🧾', label: 'Danh sách SO đã tạo' },
      { to: '/du-kien-xuat', ico: '📅', label: 'Dự kiến xuất kho (Sale)' },
      { to: '/kho/out', cls: srcTab(false), ico: '📤', label: 'Lập phiếu xuất kho', show: hasRole('thu_kho') },
      { to: '/don-hang?tab=DO', cls: slipTab('DO', ''), ico: '🚚', label: 'Danh sách đơn hàng xuất kho DO' },
      { to: '/xe/giao-hang', ico: '✅', label: 'Xác nhận giao hàng', show: isAdmin },
      { to: '/don-hang?tab=DRT', cls: orderTab('DRT'), ico: '↩️', label: 'Danh sách SO trả hàng (DRT)' },
      { to: '/kho/in?src=so', cls: srcTab('so'), ico: '↩️', label: 'Thu hồi / khách trả hàng (MVT 651)', show: isAdmin },
      { to: '/dm/partners?nhom=kh', ico: '🤝', label: 'Khách hàng / NCC · khách hàng' },
    ] },
    { key: 'mua', title: '🛒 Mua hàng (PO → nhập)', items: [
      { to: '/don-hang?tab=PO&new=1', cls: noActive, ico: '➕', label: 'Lập PO mới', show: canSO },
      { to: '/don-hang?tab=PO&scan=1', cls: noActive, ico: '📷', label: 'Lập PO từ ảnh Phiếu đề nghị nhập kho (Ecount)', show: canSO },
      { to: '/don-hang?tab=PO', cls: orderTab('PO'), ico: '🛒', label: 'Đơn mua (PO)' },
      { to: '/phan-bo', ico: '📋', label: 'Kế hoạch phân bổ hàng mua' },
      { to: '/kho/in', cls: srcTab(false), ico: '📝', label: 'Lập phiếu nhập kho', show: isAdmin },
      { to: '/don-hang?tab=cho-nhap', cls: slipTab('cho-nhap', ''), ico: '📥', label: 'IB · Danh sách đơn chờ nhập' },
      { to: '/don-hang?tab=RTV', cls: orderTab('RTV'), ico: '↩️', label: 'Danh sách PO trả hàng NCC (RTV)' },
      { to: '/dm/partners?nhom=ncc', ico: '🤝', label: 'Khách hàng / NCC · nhà cung cấp' },
      { to: '/kho/nhan-hang', ico: '📥', label: 'Nhận hàng (chờ nhập)', show: hasRole('thu_kho') },
    ] },
    { key: 'sto', title: '🔁 Chuyển kho (STO)', items: [
      { to: '/don-hang?tab=STO&new=1', cls: noActive, ico: '➕', label: 'Lập STO mới', show: hasRole('kinh_doanh', 'ke_toan', 'thu_kho') },
      { to: '/don-hang?tab=STO', cls: orderTab('STO'), ico: '🔁', label: 'Lệnh chuyển kho (STO)' },
      { to: '/kho/out?src=sto', cls: srcTab(true), ico: '📤', label: 'Xuất chuyển kho (kho đi)', show: hasRole('thu_kho') },
      { to: '/kho/in?src=sto', cls: srcTab(true), ico: '📥', label: 'Nhập chuyển kho (kho đến)', show: isAdmin },
      { to: '/don-hang?tab=DO&loai=STO', cls: slipTab('DO', 'STO'), ico: '🚚', label: 'DO chuyển kho (đã xuất)' },
      { to: '/don-hang?tab=cho-nhap&loai=STO', cls: slipTab('cho-nhap', 'STO'), ico: '⏳', label: 'STO chờ nhập (đang đi đường)' },
    ] },
    { key: 'kho', title: '🏭 Tồn kho & vận hành', items: [
      { to: '/kho/ton', ico: '🏭', label: 'Tồn kho' },
      { to: '/don-hang?tab=can-doi', cls: orderTab('can-doi'), ico: '⚖️', label: 'Cân đối theo mã hàng' },
      { to: '/kho/phieu', ico: '🧾', label: 'Phiếu kho (danh sách)' },
      { to: '/kho/phieu?mvt=1', ico: '🔢', label: 'Bảng mã movetype' },
      { to: '/kho/move', ico: '🔀', label: 'Chuyển vị trí', show: hasRole('thu_kho') },
      { to: '/kho/adjust', ico: '⚖️', label: 'Điều chỉnh tồn', show: hasRole('thu_kho') },
      { to: '/kho/kiem-ke', ico: '🧮', label: 'Kiểm kê & cycle count' },
      { to: '/kho/pallet', ico: '🪵', label: 'Quản lý pallet' },
      { to: '/kho/kho-chung', ico: '🏘️', label: 'Kho chung & vị trí dùng chung', show: isAdmin },
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
      { to: '/van-tai?tab=cho-giao', ico: '📦', label: 'DO chờ vận tải', show: isAdmin },
      { to: '/van-tai?tab=chuyen', ico: '🚛', label: can3PL ? 'Shipment / chuyến xe (xe, 3PL, cước)' : 'Shipment / chuyến xe (xe, cước)' },
      { to: '/van-tai?tab=tinh-trang', ico: '🚦', label: 'Báo cáo tình trạng xe' },
      { to: '/van-tai?tab=bang-ke', ico: '🧾', label: 'Bảng kê cước' },
    ] },
    { key: 'bao-cao', title: '📊 Báo cáo', items: REPORTS.map(([k, ic, l]) => ({ to: `/bao-cao/${k}`, ico: ic, label: l })) },
    { key: 'thiet-lap', title: '🧩 Tổng quan & thiết lập', items: [
      { to: '/dm', end: true, ico: '🏠', label: 'Tổng quan danh mục' },
      { to: '/hang-muc', ico: '🧩', label: 'Quản lý trường (hạng mục)', show: canDesign },
      { to: '/mau-in', ico: '🖨️', label: 'Thiết kế mẫu in', show: canDesign },
    ] },
    { key: 'quan-tri', title: '🗑️ Quản trị dữ liệu', items: [
      { to: '/quan-tri/xoa', ico: '🗑️', label: isSuper ? 'Duyệt xóa & lịch sử' : 'Yêu cầu xóa của tôi', badge: nDel },
      { to: '/quan-tri/du-lieu', ico: '🧹', label: 'Xóa dữ liệu chạy thử', show: isSuper },
      { to: '/quan-tri/tin-nhan', ico: '💬', label: 'Cấu hình tin nhắn hệ thống', show: isAdmin },
    ] },
    ...GROUPS.map((g) => ({ key: `dm:${g}`, title: `📚 ${g}`, items: CATALOGS.filter((c) => c.group === g && !c.menuHidden && (isAdmin || !c.adminOnly) && (!c.only3PL || can3PL))
      .map((c) => ({ to: `/dm/${c.key}`, ico: c.icon, label: c.short })) })),
  ];
  // Menu theo ý từng người: yêu thích, thư mục tự tạo, thứ tự, ẩn mục (lưu trên trình duyệt)
  // Danh mục công cụ mặc định trên thanh trên cùng (khi người dùng chưa tự tạo); mục không có quyền tự ẩn
  const defaultBar = role === 'thu_kho' ? [
    { key: 'c:xuat', title: '📤 Xuất kho', items: ['/don-hang?tab=DO', '/kho/out', '/kho/out?src=sto'] },
    { key: 'c:nhap', title: '📥 Nhập kho', items: ['/don-hang?tab=cho-nhap', '/kho/nhan-hang', '/don-hang?tab=cho-nhap&loai=STO'] },
    { key: 'c:kho', title: '🏭 Kho', items: ['/kho/ton', '/kho/phieu', '/kho/move', '/kho/kiem-ke'] },
  ] : [
    ...(role === 'kinh_doanh' ? [{ key: 'c:sale', title: '💼 Sale control', items: ['/sale/khach-hang?tab=tiep-can', '/sale/khach-hang?tab=da-chot', '/sale/hoat-dong', '/bao-cao/phan-tich-ban-hang'] }] : []),
    { key: 'c:ban', title: '🧾 Bán hàng', items: ['/don-hang?tab=SO&new=1', '/don-hang?tab=SO&scan=1', '/du-kien-xuat?new=1', '/don-hang?tab=DO', '/du-kien-xuat', '/don-hang?tab=SO'] },
    { key: 'c:mua', title: '🛒 Mua hàng', items: ['/don-hang?tab=PO&new=1', '/don-hang?tab=PO&scan=1', '/don-hang?tab=PO', '/phan-bo', '/don-hang?tab=cho-nhap'] },
    { key: 'c:sto', title: '🔁 Chuyển kho', items: ['/don-hang?tab=STO&new=1', '/don-hang?tab=STO', '/don-hang?tab=cho-nhap&loai=STO'] },
    { key: 'c:kho', title: '🏭 Kho', items: ['/kho/out', '/kho/in', '/kho/ton', '/kho/phieu', '/don-hang?tab=can-doi'] },
  ];
  // Các chức năng người dùng được mở (theo quyền) để chạy lệnh "/MÃ": mục menu + mục có trên màn hình (vai trò tài xế, 3PL…)
  const cmdItems = () => {
    const list = [{ to: '/', label: 'Tổng quan' }, { to: '/tro-chuyen', label: 'Trò chuyện' }, { to: '/cai-dat', label: 'Cài đặt hiển thị' }];
    if (fullMenu) sections.forEach((sec) => sec.items.forEach((x) => { if (x.show !== false) list.push(x); }));
    else list.length = 0;
    navRef.current?.querySelectorAll('a').forEach((a) => {
      const to = a.getAttribute('href');
      if (to && !list.some((x) => x.to === to)) list.push({ to, label: a.textContent });
    });
    return list;
  };
  const cmdNow = parseCommand(q);
  const cmdTarget = cmdNow?.term ? findTarget(cmdItems(), cmdNow.term) : null;
  const [nav, navApi] = useNavLayout(sections.map((sec) => ({ ...sec, items: sec.items.filter((x) => x.show !== false) })), [], defaultBar);
  const [editBar, setEditBar] = useState(false);
  // Danh mục đang mở trên thanh trên cùng: đóng khi đổi trang hoặc bấm ra ngoài
  const [barOpen, setBarOpen] = useState(null);
  const topRef = useRef(null);
  useEffect(() => setBarOpen(null), [loc.pathname, loc.search]);
  useEffect(() => {
    if (!barOpen) return undefined;
    const off = (e) => { if (!topRef.current?.contains(e.target)) setBarOpen(null); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [barOpen]);
  // Hiện cả danh mục trống (vừa bấm ➕ Thêm Favorite) để người dùng kéo công cụ vào
  const barCats = nav.bar;
  const openCat = barCats.find((c) => c.key === barOpen);
  // ---------- Kéo thả công cụ từ menu trái lên thanh trên cùng ----------
  // drag: { id } (mục menu trái) | { id, from } (công cụ trong bảng danh mục) | { cat } (đổi chỗ danh mục)
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const [hover, setHover] = useState(null); // ô đang được kéo qua: key danh mục / 'new' / 'fav' / 'trash' / 'tool:<id>'
  const hoverTimer = useRef(0);
  const [flash, setFlash] = useState('');
  const flashTimer = useRef(0);
  const say = (t) => { setFlash(t); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(''), 2600); };
  const labelOf = (id) => nav.all.get(id)?.label || id;
  const catTitle = (k) => barCats.find((c) => c.key === k)?.title || '';
  const startDrag = (e, d) => {
    dragRef.current = d;
    e.dataTransfer.effectAllowed = 'copyMove';
    try { e.dataTransfer.setData('application/x-nav', d.id || d.cat); } catch { /* trình duyệt cũ */ }
    setTimeout(() => setDrag(d), 0); // đổi giao diện sau khi trình duyệt chụp ảnh kéo
  };
  const endDrag = () => { dragRef.current = null; setDrag(null); setHover(null); clearTimeout(hoverTimer.current); };
  // accept(d) → ô này có nhận kiểu kéo này không
  const dropZone = (zone, accept, onDrop, openKey) => ({
    onDragOver: (e) => {
      const d = dragRef.current;
      if (!d || !accept(d)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = d.from || d.cat ? 'move' : 'copy';
      if (hover !== zone) {
        setHover(zone);
        clearTimeout(hoverTimer.current);
        // Giữ chuột trên danh mục một lúc → mở bảng công cụ để thả đúng vị trí
        if (openKey && d.id) hoverTimer.current = setTimeout(() => setBarOpen(openKey), 650);
      }
    },
    onDragLeave: (e) => {
      // Chrome hay báo rời ô khi đi qua chữ / biểu tượng bên trong → chỉ tính là rời khi chuột thật sự ra ngoài ô
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return;
      setHover((h) => (h === zone ? null : h)); clearTimeout(hoverTimer.current);
    },
    onDrop: (e) => { const d = dragRef.current; if (!d || !accept(d)) return; e.preventDefault(); e.stopPropagation(); onDrop(d); endDrag(); },
  });
  const addToCat = (id, key, beforeId = null, from = null) => {
    if (from === key && !beforeId) return;
    const r = navApi.barDrop(id, key, beforeId, from);
    say(r === 'exists' ? `“${labelOf(id)}” đã có trong ${catTitle(key)}` : from && from !== key ? `↪ Đã chuyển “${labelOf(id)}” sang ${catTitle(key)}` : from ? '✓ Đã đổi thứ tự' : `✓ Đã thêm “${labelOf(id)}” vào ${catTitle(key)}`);
  };
  const newCat = (id) => {
    const t = window.prompt('Tên mục Favorite mới (VD: 🧾 Việc hằng ngày)', id ? (nav.secs.find((s) => s.key === nav.all.get(id)?.home)?.title || '') : '⭐ Favorite');
    if (t === null) return null;
    const key = navApi.barNew(t, id);
    say(id ? `✓ Đã tạo “${t.trim() || 'Danh mục mới'}” với “${labelOf(id)}”` : `✓ Đã tạo “${t.trim() || 'Danh mục mới'}” — kéo chức năng ở menu trái thả vào đây`);
    return key;
  };
  const delCat = (c) => {
    if (!window.confirm(`Xóa mục “${c.title}” khỏi thanh trên cùng? (Các chức năng vẫn còn trong menu trái)`)) return;
    navApi.setBar(nav.bar.filter((x) => x.key !== c.key).map((x) => ({ key: x.key, title: x.title, items: x.items.map(itemId) })));
    if (barOpen === c.key) setBarOpen(null);
    say(`🗑 Đã xóa “${c.title}”`);
  };
  const toFav = (id) => { if (!nav.fav.some((x) => itemId(x) === id)) navApi.toggleFav(id); say(`⭐ Đã ghim “${labelOf(id)}”`); };
  // Điện thoại / máy cảm ứng (không kéo thả được): giữ ngón tay trên mục menu hoặc bấm chuột phải → chọn mục để thêm vào
  const [pick, setPick] = useState(null);
  const press = useRef({ t: 0, fired: false });
  const pressProps = (id) => ({
    onContextMenu: (e) => { e.preventDefault(); setPick(id); },
    onTouchStart: () => { press.current.fired = false; clearTimeout(press.current.t); press.current.t = setTimeout(() => { press.current.fired = true; setPick(id); }, 550); },
    onTouchMove: () => clearTimeout(press.current.t),
    onTouchEnd: () => clearTimeout(press.current.t),
  });
  const [editMenu, setEditMenu] = useState(false);
  const shownSecs = [...(nav.fav.length ? [{ key: FAV_KEY, title: '⭐ Yêu thích', items: nav.fav }] : []), ...nav.secs];
  // Hạng mục lớn → hạng mục con: các nhóm danh mục / thiết lập / quản trị gom vào 1 mục lớn (đặt ở vị trí nhóm con đầu tiên)
  const blocks = [];
  let parent = null;
  for (const s of shownSecs) {
    if (!s.items.length) continue;
    if (isSub(s.key)) {
      if (!parent) { parent = { ...PARENT, subs: [] }; blocks.push(parent); }
      parent.subs.push(s);
    } else blocks.push(s);
  }
  const hasHere = (s) => (s.subs ? s.subs.some(hasHere) : s.items.some((x) => here(x.to)));
  const curTop = blocks.find((b) => b.key !== FAV_KEY && hasHere(b));
  const curSub = curTop?.subs?.find(hasHere);
  // Đổi trang → mở đúng nhóm của trang đó (các nhóm khác đóng lại)
  const curKey = `${curTop?.key || ''}|${curSub?.key || ''}`;
  useEffect(() => {
    if (multi || !curTop) return;
    if (acc.top !== curTop.key || (curSub && acc.sub !== curSub.key)) setAcc({ top: curTop.key, sub: curSub?.key || acc.sub });
  }, [curKey, multi]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mục đang mở luôn nằm trong vùng nhìn thấy của menu
  useEffect(() => { navRef.current?.querySelector('a.active')?.scrollIntoView?.({ block: 'nearest' }); }, [loc.pathname, loc.search, open]);
  const isOpen = (s, sub) => {
    if (multi) return !closed.includes(s.key) || (s.key !== FAV_KEY && hasHere(s));
    return sub ? acc.sub === s.key : acc.top === s.key;
  };
  const toggle = (s, sub) => {
    if (multi) return toggleClosed(s.key);
    if (sub) setAcc({ ...acc, sub: acc.sub === s.key ? null : s.key });
    else setAcc({ ...acc, top: acc.top === s.key ? null : s.key });
  };
  const countOf = (s) => (s.subs ? s.subs.reduce((n, x) => n + x.items.length, 0) : s.items.length);
  const groupHead = (s, sub, opened, extra = '') => (
    <div className={'nav-group' + extra} role="button" tabIndex={0} onClick={() => toggle(s, sub)} onKeyDown={(e) => e.key === 'Enter' && toggle(s, sub)}
      title={opened ? 'Thu gọn nhóm' : 'Mở nhóm'} aria-expanded={opened}>
      <span>{s.title}</span>
      <span className="nav-head-r">{!opened && <span className="nav-count">{countOf(s)}</span>}<span className="caret">{opened ? '▾' : '▸'}</span></span>
    </div>
  );
  const navItem = (x) => (
    <NavLink key={x.to + x.label} to={x.to} end={x.end} className={x.cls}
      onClick={(e) => { if (press.current.fired) { e.preventDefault(); press.current.fired = false; return; } close(); }}
      draggable={fullMenu} onDragStart={(e) => startDrag(e, { id: itemId(x) })} onDragEnd={endDrag} {...(fullMenu ? pressProps(itemId(x)) : {})}
      title={fullMenu ? 'Kéo thả lên thanh phía trên để thêm vào Favorite (điện thoại: giữ ngón tay)' : undefined}>
      <span className="ico">{x.ico}</span>{x.label}{x.badge ? <span className="badge red" style={{ marginLeft: 6 }}>{x.badge}</span> : null}
      {tcodeOf(x.to) && <span className="tcode" title={`Mã lệnh tắt: gõ /${tcodeOf(x.to)} (mở tại đây) hoặc /O&${tcodeOf(x.to)} (mở tab mới) vào ô Tìm chức năng`}>{tcodeOf(x.to)}</span>}
      <span className={'fav-star' + (x.fav ? ' on' : '')} role="button" title={x.fav ? 'Bỏ khỏi Yêu thích' : 'Ghim vào Yêu thích'}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); navApi.toggleFav(itemId(x)); }}>{x.fav ? '★' : '☆'}</span>
    </NavLink>
  );
  return (
    <div className="shell">
      <aside className={'side' + (open ? ' open' : '')}>
        <div className="brand">{settings.companyName}<small>Kho & vận tải</small></div>
        <div className="nav-search">
          <input ref={searchRef} type="search" placeholder="🔍 Tìm chức năng hoặc /mã… (Ctrl+K)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey}
            title={'Gõ tên chức năng, hoặc mã lệnh tắt:\n/PO → mở Đơn mua ngay tại màn hình này\n/O&PO → mở Đơn mua ở tab mới\n/O → mở trang đang xem ở tab mới\nMã hiện bên phải từng mục menu.'} />
          {!['tai_xe', 'van_tai', 'tpl'].includes(role) && <button type="button" className="nav-cfg" title="Tùy chỉnh menu: yêu thích, thư mục, thứ tự, ẩn mục" onClick={() => setEditMenu(true)}>⚙</button>}
        </div>
        {cmdNow && (
          <div className="nav-cmd">
            {!cmdNow.term ? (cmdNow.newTab
              ? <span>↵ Mở trang đang xem ở <b>tab mới</b></span>
              : <span>Gõ mã chức năng (hiện bên phải từng mục), vd <b>/PO</b>. <b>/O&amp;PO</b> mở ở tab mới.</span>)
              : cmdTarget
                ? <span>↵ {cmdTarget.ico} <b>{cmdTarget.label}</b> {cmdNow.newTab ? '· tab mới' : '· tại màn hình này'}</span>
                : <span className="nav-cmd-miss">Không có chức năng nào khớp “{cmdNow.term}”.</span>}
          </div>
        )}
        <div className="nav-wrap" ref={navRef}>
        {role === 'tai_xe' ? (
        <nav>
          <NavLink to="/tai-xe" onClick={close}><span className="ico">🧑‍✈️</span>Chuyến của tôi</NavLink>
          <NavLink to="/tro-chuyen" onClick={close}><span className="ico">💬</span>Trò chuyện</NavLink>
        </nav>
        ) : role === 'tpl' ? (
        <nav>
          <NavLink to="/van-tai?tab=chuyen" onClick={close}><span className="ico">🚛</span>Chuyến 3PL của tôi</NavLink>
          <NavLink to="/van-tai?tab=tinh-trang" onClick={close}><span className="ico">🚦</span>Tình trạng xe</NavLink>
          <NavLink to="/van-tai?tab=bang-ke" onClick={close}><span className="ico">🧾</span>Bảng kê</NavLink>
          <NavLink to="/tro-chuyen" onClick={close}><span className="ico">💬</span>Trò chuyện</NavLink>
        </nav>
        ) : role === 'van_tai' ? (
        <nav>
          <NavLink to="/van-tai?tab=chuyen" onClick={close}><span className="ico">🚛</span>Vận chuyển</NavLink>
          <NavLink to="/van-tai?tab=tinh-trang" onClick={close}><span className="ico">🚦</span>Tình trạng xe</NavLink>
          <NavLink to="/dm/vehicles" onClick={close}><span className="ico">🚚</span>Xe của đơn vị</NavLink>
          <NavLink to="/dm/drivers" onClick={close}><span className="ico">🧑‍✈️</span>Tài xế của đơn vị</NavLink>
          {can3PL && <NavLink to="/dm/threepl" onClick={close}><span className="ico">🤝</span>3PL</NavLink>}
          <NavLink to="/quan-tri/xoa" onClick={close}><span className="ico">🗑️</span>Yêu cầu xóa của tôi</NavLink>
          <NavLink to="/tro-chuyen" onClick={close}><span className="ico">💬</span>Trò chuyện</NavLink>
        </nav>
        ) : (
        <nav className={q ? 'searching' : ''}>
          <NavLink to="/" end onClick={close}><span className="ico">📈</span>Tổng quan<span className="tcode">TQ</span></NavLink>
          <NavLink to="/tro-chuyen" onClick={close}><span className="ico">💬</span>Trò chuyện<span className="tcode">CHAT</span></NavLink>
          {blocks.map((sec) => {
            const op = isOpen(sec, false);
            if (sec.subs) return (
              <div key={sec.key} className={'nav-sec nav-parent' + (op ? ' open' : ' closed')}>
                {groupHead(sec, false, op, ' nav-parent-head')}
                {sec.subs.map((sub) => {
                  const so = isOpen(sub, true);
                  return (
                    <div key={sub.key} className={'nav-sec nav-sub' + (so ? ' open' : ' closed')}>
                      {groupHead(sub, true, so)}
                      {sub.items.map(navItem)}
                    </div>
                  );
                })}
              </div>
            );
            return (
              <div key={sec.key} className={'nav-sec' + (op ? ' open' : ' closed') + (sec.key === FAV_KEY ? ' nav-fav' : '')}>
                {groupHead(sec, false, op)}
                {sec.items.map(navItem)}
              </div>
            );
          })}
        </nav>
        )}
        <div className="nav-empty" hidden>Không tìm thấy chức năng nào.</div>
        </div>
        <div className="me">
          <div title={email}><b>{name}</b><small className="me-mail">{email}</small><small className="role">{roleLabel(role)}</small></div>
          <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
            <NavLink className="btn ghost sm" to="/cai-dat" title="Cài đặt hiển thị: kiểu ngày, giờ, dấu thập phân, hàng nghìn">⚙</NavLink>
            <button className="btn ghost sm" onClick={logout}>Đăng xuất</button>
          </span>
        </div>
      </aside>
      {open && <div className="side-bg" onClick={close} />}
      {editBar && <BarEditor view={nav} api={navApi} onClose={() => setEditBar(false)} />}
      {pick && (
        <Modal title={`Thêm “${labelOf(pick)}” vào…`} onClose={() => setPick(null)}>
          <div className="pick-cats">
            {barCats.map((c) => (
              <button key={c.key} type="button" className="btn" onClick={() => { addToCat(pick, c.key); setPick(null); }}>
                {c.title}{c.items.some((x) => itemId(x) === pick) ? ' ✓' : ''}
              </button>
            ))}
            <button type="button" className="btn" onClick={() => { toFav(pick); setPick(null); }}>⭐ Ghim lẻ lên thanh</button>
            <button type="button" className="btn primary" onClick={() => { if (newCat(pick)) setPick(null); }}>➕ Tạo mục Favorite mới</button>
          </div>
        </Modal>
      )}
      {editMenu && <MenuEditor view={nav} api={navApi} multi={multi} setMulti={setMulti} onClose={() => setEditMenu(false)} />}
      <main ref={mainRef}>
        <div className={'topwrap' + (fullMenu ? ' has-fav' : '')} ref={topRef}>
        <div className="topbar">
          <button className="menu-btn" onClick={() => setOpen(true)}>☰</button>
          {fullMenu && (
            <div className={'fav-bar' + (drag ? ' dragging' : '')}>
              {barCats.map((c) => (
                <span key={c.key} className={'bar-cat-wrap' + (hover === c.key ? ' drop' : '')}
                  {...dropZone(c.key, (d) => (d.cat ? d.cat !== c.key : d.from !== c.key), (d) => (d.cat ? navApi.barMoveCat(d.cat, c.key) : addToCat(d.id, c.key, null, d.from)), c.key)}>
                  <button type="button" className={'bar-cat' + (barOpen === c.key ? ' on' : '') + (c.items.some((x) => here(x.to)) ? ' cur' : '') + (c.items.length ? '' : ' empty')}
                    draggable onDragStart={(e) => startDrag(e, { cat: c.key })} onDragEnd={endDrag}
                    onClick={() => setBarOpen(barOpen === c.key ? null : c.key)} aria-expanded={barOpen === c.key}
                    title={c.items.length ? `${c.items.length} chức năng · kéo để đổi chỗ` : 'Mục trống — kéo chức năng ở menu trái thả vào đây'}>
                    {c.title} {!c.items.length && <span className="bar-empty">trống</span>}<span className="caret">{barOpen === c.key ? '▴' : '▾'}</span>
                  </button>
                  <button type="button" className="bar-del" title={`Xóa mục “${c.title}”`} onClick={() => delCat(c)}>✕</button>
                </span>
              ))}
              {nav.fav.map((x) => (
                <NavLink key={x.to} to={x.to} end={x.end} className={x.cls} title="Yêu thích (bấm ☆ trong menu để ghim / bỏ)">{x.ico} {x.label}</NavLink>
              ))}
              {drag?.id && !drag.from && !nav.fav.some((x) => itemId(x) === drag.id) && (
                <span className={'bar-drop' + (hover === 'fav' ? ' drop' : '')} {...dropZone('fav', (d) => d.id && !d.from, (d) => toFav(d.id))}>⭐ Ghim lẻ</span>
              )}
              <button type="button" className={'fav-add' + (hover === 'new' ? ' drop' : '')} title="Tạo mục Favorite mới trên thanh này, rồi kéo chức năng ở menu trái thả vào"
                onClick={() => { const k = newCat(null); if (k) setBarOpen(k); }}
                {...dropZone('new', (d) => !!d.id, (d) => { const k = newCat(d.id); if (k && d.from) navApi.barRemove(d.from, d.id); })}>
                {drag?.id ? '➕ Thả vào đây để tạo mục mới' : '➕ Thêm Favorite'}
              </button>
              {drag?.from && <span className={'bar-drop trash' + (hover === 'trash' ? ' drop' : '')} {...dropZone('trash', (d) => !!d.from, (d) => { navApi.barRemove(d.from, d.id); say(`🗑 Đã bỏ “${labelOf(d.id)}” khỏi ${catTitle(d.from)}`); })}>🗑 Thả vào đây để bỏ</span>}
              <button type="button" className="fav-edit" title="Sửa danh mục công cụ của tôi (đổi tên, thứ tự, xóa)" onClick={() => setEditBar(true)}>⚙</button>
              {flash && !openCat && <span className="bar-flash">{flash}</span>}
            </div>
          )}
          <div className="top-tools"><ChatBell /><NoticeBell /></div>
        </div>
        {openCat && (
          <div className="bar-panel">
            <div className="bar-panel-head">
              <b>{openCat.title}</b>
              <span className="actions">
                <button type="button" className="btn ghost sm" onClick={() => { setBarOpen(null); setEditBar(true); }}>⚙ Sửa danh mục</button>
                <button type="button" className="btn ghost sm" onClick={() => delCat(openCat)}>🗑 Xóa mục này</button>
              </span>
            </div>
            <div className={'bar-tools' + (hover === `end:${openCat.key}` ? ' drop' : '')}
              {...dropZone(`end:${openCat.key}`, (d) => !!d.id, (d) => addToCat(d.id, openCat.key, null, d.from))}>
              {openCat.items.map((x) => (
                <NavLink key={x.to} to={x.to} end={x.end} className={x.cls}
                  draggable onDragStart={(e) => startDrag(e, { id: itemId(x), from: openCat.key })} onDragEnd={endDrag}
                  onClick={() => setBarOpen(null)} title="Kéo để đổi thứ tự, kéo sang mục khác để chuyển, kéo ra 🗑 để bỏ"
                  {...dropZone(`tool:${itemId(x)}`, (d) => !!d.id && d.id !== itemId(x), (d) => addToCat(d.id, openCat.key, itemId(x), d.from))}
                  style={hover === `tool:${itemId(x)}` ? { boxShadow: 'inset 3px 0 0 var(--primary)' } : undefined}>
                  <span className="ico">{x.ico}</span>{x.label}{tcodeOf(x.to) && <span className="tcode">{tcodeOf(x.to)}</span>}
                  <span className="tool-x" role="button" title="Bỏ khỏi mục này" onClick={(e) => { e.preventDefault(); e.stopPropagation(); navApi.barRemove(openCat.key, itemId(x)); }}>✕</span>
                </NavLink>
              ))}
              {!openCat.items.length && <div className="bar-hint">Mục này đang trống. Kéo chức năng ở menu bên trái thả vào đây (điện thoại: giữ ngón tay trên chức năng).</div>}
            </div>
          </div>
        )}
        </div>
        <Outlet key={fmtKey} />
      </main>
    </div>
  );
}
