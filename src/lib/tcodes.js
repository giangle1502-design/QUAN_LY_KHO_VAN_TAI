// Mã lệnh tắt kiểu SAP cho ô "Tìm chức năng" trên menu:
//   /MÃ      → chuyển sang chức năng đó ngay trên màn hình đang dùng   (vd /PO, /so, /ton)
//   /O&MÃ    → mở chức năng đó ở tab (màn hình) mới của trình duyệt   (vd /O&PO, /o po)
//   /N&MÃ    → như /MÃ (cách gõ của SAP)
//   /O       → mở trang đang xem ở tab mới
// Không phân biệt hoa / thường, bỏ dấu. Gõ sai mã thì tìm gần đúng theo tên chức năng.
import { norm } from './utils';

// Mã của từng mục menu (theo đường dẫn). Mục nào chưa có mã ở đây thì không có lệnh tắt nhưng vẫn tìm theo tên được.
export const TCODES = {
  '/': 'TQ',
  '/tro-chuyen': 'CHAT',
  // Sale control
  '/sale/khach-hang?tab=tiep-can': 'KTC',
  '/sale/khach-hang?tab=da-chot': 'KDC',
  '/sale/hoat-dong': 'HD',
  // Điều phối kho
  '/dieu-phoi': 'DP',
  '/dieu-phoi/cho-xuat': 'CX',
  '/dieu-phoi/cho-nhap': 'CN',
  // Bán hàng
  '/don-hang?tab=SO&new=1': 'SON',
  '/don-hang?tab=SO&scan=1': 'SOA',
  '/du-kien-xuat?new=1': 'DKN',
  '/don-hang?tab=SO': 'SO',
  '/du-kien-xuat': 'DK',
  '/kho/out': 'PX',
  '/don-hang?tab=DO': 'DO',
  '/xe/giao-hang': 'XNGH',
  '/don-hang?tab=DRT': 'DRT',
  '/kho/in?src=so': 'THKT',
  '/dm/partners?nhom=kh': 'KH',
  // Mua hàng
  '/don-hang?tab=PO&new=1': 'PON',
  '/don-hang?tab=PO&scan=1': 'POA',
  '/don-hang?tab=PO': 'PO',
  '/phan-bo': 'PB',
  '/kho/in': 'PN',
  '/don-hang?tab=cho-nhap': 'IB',
  '/don-hang?tab=RTV': 'RTV',
  '/dm/partners?nhom=ncc': 'NCC',
  '/kho/nhan-hang': 'NH',
  // Chuyển kho
  '/don-hang?tab=STO&new=1': 'STON',
  '/don-hang?tab=STO': 'STO',
  '/kho/out?src=sto': 'PXCK',
  '/kho/in?src=sto': 'PNCK',
  '/don-hang?tab=DO&loai=STO': 'DOCK',
  '/don-hang?tab=cho-nhap&loai=STO': 'STOCN',
  // Tồn kho & vận hành
  '/kho/ton': 'TON',
  '/don-hang?tab=can-doi': 'CD',
  '/kho/phieu': 'PK',
  '/kho/phieu?mvt=1': 'MVT',
  '/kho/move': 'CV',
  '/kho/adjust': 'DC',
  '/kho/kiem-ke': 'KK',
  '/kho/pallet': 'PL',
  '/kho/kho-chung': 'KC',
  '/kho/ton-dau-ky': 'TDK',
  // Thế chấp
  '/kho/status': 'TC',
  '/kho/giai-chap': 'GC',
  // Xe & vận tải
  '/xe/dang-ky': 'DKX',
  '/xe/bao-ve': 'BV',
  '/xe/thu-kho': 'TK',
  '/xe/tong-quan': 'TQX',
  '/van-tai?tab=cho-giao': 'CGVT',
  '/van-tai?tab=chuyen': 'VT',
  '/van-tai?tab=tinh-trang': 'TTX',
  '/van-tai?tab=bang-ke': 'BKC',
  // Báo cáo
  '/bao-cao/ke-hoach-xuat-nhap': 'BCKH',
  '/bao-cao/ton-theo-kho': 'BCTK',
  '/bao-cao/ton-theo-vi-tri': 'BCVT',
  '/bao-cao/ton-theo-trang-thai': 'BCTT',
  '/bao-cao/ton-kho-hang-ve': 'BCHV',
  '/bao-cao/ton-cho-sale': 'BCTS',
  '/bao-cao/don-chua-giao': 'BCDG',
  '/bao-cao/po-chua-nhap': 'BCPO',
  '/bao-cao/tong-quan': 'BCTQ',
  '/bao-cao/phan-tich-ban-hang': 'PTBH',
  '/bao-cao/chuyen-phap-nhan': 'BCPHN',
  // Thiết lập, quản trị
  '/dm': 'DM',
  '/hang-muc': 'HM',
  '/mau-in': 'MI',
  '/cai-dat': 'CAIDAT',
  '/quan-tri/xoa': 'XOA',
  '/quan-tri/du-lieu': 'XDL',
  '/quan-tri/tin-nhan': 'CHTN',
  // Danh mục
  '/dm/companies': 'CTY',
  '/dm/partners': 'BP',
  '/dm/items': 'MH',
  '/dm/goodsStatus': 'TTH',
  '/dm/pledgees': 'NTC',
  '/dm/warehouseGroups': 'DMKC',
  '/dm/warehouses': 'KHO',
  '/dm/locations': 'VTR',
  '/dm/docks': 'CUA',
  '/dm/pallets': 'MPL',
  '/dm/reasons': 'LD',
  '/dm/carriers': 'DVVT',
  '/dm/vehicles': 'XE',
  '/dm/drivers': 'TX',
  '/dm/pickupPoints': 'DN',
  '/dm/freightRates': 'GCUOC',
  '/dm/threepl': '3PL',
  '/dm/codeRules': 'MTS',
  '/dm/users': 'PQ',
  '/dm/soHead': 'BMSOH',
  '/dm/soLine': 'BMSOL',
  '/dm/poHead': 'BMPOH',
  '/dm/poLine': 'BMPOL',
  '/dm/stoHead': 'BMSTOH',
  '/dm/stoLine': 'BMSTOL',
  '/dm/mvIn': 'BMPN',
  '/dm/mvOut': 'BMPX',
  '/dm/mvMove': 'BMCV',
  '/dm/mvStatus': 'BMTC',
  '/dm/mvAdjust': 'BMDC',
  '/dm/tripReg': 'BMDKX',
  '/dm/tripPlan': 'BMCX',
  '/dm/shipPlan': 'BMDK',
  '/dm/stockCount': 'BMKK',
  '/dm/releaseReq': 'BMGC',
  '/dm/drtForm': 'BMDRT',
  '/dm/rtvForm': 'BMRTV',
  '/dm/palletMove': 'BMPL',
  '/dm/prospect': 'BMKTC',
  '/dm/activity': 'BMHD',
};

// Cách gõ khác của cùng một mã (vd SO+ = SON = Lập SO mới, 651 = thu hồi hàng khách trả)
const ALIASES = { 'SO+': 'SON', 'PO+': 'PON', 'STO+': 'STON', 'DK+': 'DKN', 651: 'THKT', CK: 'STO', TONKHO: 'TON' };

// Danh mục mới thêm sau này chưa có trong bảng trên: mã tự sinh "DM" + khóa danh mục
export const tcodeOf = (to) => TCODES[to] || (/^\/dm\/[A-Za-z0-9]+$/.test(to) ? 'DM' + to.slice(4).toUpperCase() : '');

const clean = (s) => norm(s).toUpperCase().replace(/\s+/g, '');

// Tách lệnh gõ vào ô tìm kiếm. Trả về null nếu không phải lệnh (không bắt đầu bằng "/").
//   { newTab, term }  term rỗng = không chỉ định chức năng (vd "/O" → mở trang hiện tại ở tab mới)
export function parseCommand(q) {
  const s = String(q || '').trim();
  if (!s.startsWith('/')) return null;
  let rest = s.slice(1).trim();
  let newTab = false;
  const m = rest.match(/^([on])(?:\s*&\s*|\s+|$)(.*)$/i);
  if (m) { newTab = m[1].toLowerCase() === 'o'; rest = m[2]; }
  return { newTab, term: rest.trim() };
}

// Tìm chức năng theo mã / tên trong danh sách mục menu người dùng được phép mở ({ to, label, ico }).
// Thứ tự ưu tiên: đúng mã → đúng mã viết khác → mã bắt đầu bằng chữ gõ → tên chứa đủ các từ gõ.
export function findTarget(items, term) {
  const t = clean(term);
  if (!t) return null;
  const code = (x) => tcodeOf(x.to);
  const exact = items.find((x) => code(x) === t) || (ALIASES[t] && items.find((x) => code(x) === ALIASES[t]));
  if (exact) return exact;
  const prefix = items.filter((x) => code(x) && code(x).startsWith(t)).sort((a, b) => code(a).length - code(b).length);
  if (prefix.length) return prefix[0];
  const words = norm(term).split(' ').filter(Boolean);
  return items.find((x) => { const s = norm(`${x.label} ${code(x)}`); return words.every((w) => s.includes(w)); }) || null;
}

// Mã của mục menu có khớp chữ đang gõ sau "/" không (đúng mã viết khác, hoặc mã bắt đầu bằng chữ gõ)
export function codeMatches(to, term) {
  const t = clean(term);
  const c = tcodeOf(to);
  return !!(t && c && (c.startsWith(t) || ALIASES[t] === c));
}
