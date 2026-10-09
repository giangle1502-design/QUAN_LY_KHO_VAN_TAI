// ============================================================================
// Định nghĩa các danh mục. Mỗi danh mục = 1 collection Firestore cùng tên `key`.
// Trường có sẵn (system) khai báo ở đây; admin đổi tên, ẩn, bắt buộc, sắp xếp
// và thêm trường mới ở mục "Quản lý hạng mục" (lưu tại settings/fields).
//
// Kiểu trường: text, textarea, number, date, checkbox, select, ref, multiref, email
//  • ref:      chọn 1 bản ghi ở danh mục khác (lưu mã), `fill` tự điền trường khác
//  • computed: hàm tính từ bản ghi, chỉ đọc, được lưu kèm khi bấm Lưu
//  • system:   hệ thống tự cập nhật (vd. tồn kho theo phiếu), không nhập tay
// ============================================================================

export const FIELD_TYPES = [
  ['text', 'Văn bản (1 dòng)'],
  ['textarea', 'Đoạn văn (nhiều dòng)'],
  ['number', 'Số'],
  ['currency', 'Số tiền (VNĐ)'],
  ['percent', 'Phần trăm (%)'],
  ['date', 'Ngày'],
  ['datetime', 'Ngày giờ'],
  ['checkbox', 'Có / Không'],
  ['select', 'Danh sách chọn'],
  ['ref', 'Chọn từ danh mục'],
  ['email', 'Email'],
  ['phone', 'Số điện thoại'],
  ['url', 'Đường link'],
  ['formula', 'Công thức (tự tính)'],
];
// Kết quả trường công thức hiện dạng
export const RESULT_TYPES = [['number', 'Số'], ['currency', 'Tiền (VNĐ)'], ['percent', 'Phần trăm (%)']];
// Kiểu lưu dạng số (căn phải, cộng được, Excel ra số)
export const NUMERIC_TYPES = ['number', 'currency', 'percent'];

export const ROLES = [
  ['admin', 'Quản trị', 'Toàn quyền, sửa mọi danh mục, phân quyền'],
  ['thu_kho', 'Thủ kho', 'Nhập, xuất, chuyển vị trí, điều chỉnh tồn; sửa vị trí lưu trữ và cửa xuất/nhập của kho được giao'],
  ['bao_ve', 'Bảo vệ', 'Xem danh mục (xác nhận xe vào/ra cổng ở bước sau)'],
  ['kinh_doanh', 'Kinh doanh / Mua hàng', 'Lập và theo dõi đơn bán (SO), đơn mua (PO), lệnh chuyển kho (STO); xem tồn kho và chuyến xe'],
  ['ke_toan', 'Kế toán', 'Xem mọi thứ; lập SO/PO; đổi tình trạng thế chấp (KTC, HTC, DGC)'],
  ['van_tai', 'Điều phối vận tải', 'Thấy đơn được giao cho đơn vị mình, chia xe thành chuyến, làm thay tài xế, nhập cước / chi hộ / bốc xếp / số HĐ; quản lý xe, tài xế của đơn vị'],
  ['tai_xe', 'Tài xế', 'Dùng điện thoại: nhận chuyến, đăng ký số xe / CCCD, xác nhận đến kho, lấy hàng xong, đến điểm giao, giao xong (chụp phiếu)'],
  ['xem', 'Chỉ xem', 'Chỉ xem danh mục'],
];
export const roleLabel = (r) => ROLES.find((x) => x[0] === r)?.[1] || r || '';

const num = (v) => (v === '' || v == null ? null : Number(v));

export const CATALOGS = [
  // ---------------- Công ty ----------------
  // Công ty sở hữu hàng trong kho: công ty trong nhóm (VAP, DAM, PLA) và công ty khách gửi hàng
  {
    key: 'companies', group: 'Công ty', icon: '🏛️', title: 'Công ty (chủ hàng)', short: 'Công ty', idField: 'code', upperId: true,
    fields: [
      { key: 'code', label: 'Mã công ty', type: 'text', required: true, help: 'VD: VAP, DAM, PLA' },
      { key: 'name', label: 'Tên công ty', type: 'text', required: true },
      { key: 'kind', label: 'Loại', type: 'select', options: ['Công ty trong nhóm', 'Công ty khách'], default: 'Công ty trong nhóm',
        help: 'Công ty khách: khách gửi hàng / thuê kho' },
      { key: 'taxCode', label: 'Mã số thuế / Số ĐKKD', type: 'text' },
      { key: 'bizRegInfo', label: 'Nơi cấp, ngày cấp ĐKKD', type: 'textarea',
        help: 'In sau số ĐKKD trên đề nghị giải chấp. VD: do Sở KH&ĐT ... cấp, đăng ký lần đầu ngày ...' },
      { key: 'address', label: 'Địa chỉ', type: 'textarea' },
      { key: 'representative', label: 'Người đại diện', type: 'text' },
      { key: 'repTitle', label: 'Chức vụ người đại diện', type: 'text', default: 'Giám đốc' },
      { key: 'place', label: 'Nơi lập văn bản', type: 'text', default: 'HCM', help: 'In ở dòng "HCM, ngày ... tháng ... năm ..."' },
      { key: 'contact', label: 'Người liên hệ', type: 'text' },
      { key: 'phone', label: 'Điện thoại', type: 'text' },
      { key: 'fax', label: 'Fax', type: 'text' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
      { key: 'active', label: 'Đang hoạt động', type: 'checkbox', default: true },
    ],
    seed: [
      { code: 'VAP', name: 'CÔNG TY TNHH VIỆT AN PHA', kind: 'Công ty trong nhóm', active: true, taxCode: '3702210726',
        bizRegInfo: 'do Sở Kế Hoạch và Đầu Tư tỉnh Bình Dương cấp, đăng ký lần đầu ngày 04/09/2013, đăng ký thay đổi lần thứ 4: ngày 16 tháng 02 năm 2022, và các lần đăng ký thay đổi, bổ sung (nếu có)',
        address: 'Số 34 Đường D17A, Khu TĐC Mỹ Phước I mở rộng, Phường Thới Hòa, Thành phố Hồ Chí Minh, Việt Nam',
        representative: 'LÊ THỊ THU HÀ', repTitle: 'Giám đốc', place: 'HCM' },
      { code: 'DAM', name: 'CÔNG TY CỔ PHẦN HÓA CHẤT DIAMOND', kind: 'Công ty trong nhóm', active: true, repTitle: 'Giám đốc', place: 'HCM' },
      { code: 'PLA', name: 'CÔNG TY TNHH PLASTIC VIỆT NAM', kind: 'Công ty trong nhóm', active: true, taxCode: '0316285785',
        bizRegInfo: 'do Sở Kế hoạch và Đầu tư thành phố Hồ Chí Minh cấp, đăng ký lần đầu ngày 28/05/2020, đăng ký thay đổi lần thứ 1 ngày 17/11/2022, và các lần đăng ký thay đổi, bổ sung (nếu có)',
        address: 'Số A7 Khu dân cư ấp Mới 1, đường Liên xã Tân Xuân - Trung Chánh, Xã Hóc Môn, Thành phố Hồ Chí Minh, Việt Nam',
        representative: 'HOÀNG TRẦN HỒNG PHÚC', repTitle: 'Giám đốc', place: 'HCM' },
    ],
  },
  // ---------------- Khách hàng ----------------
  {
    key: 'soldto', group: 'Khách hàng', icon: '🏢', title: 'Soldto (khách hàng xuất hóa đơn)',
    short: 'Soldto', idField: 'code', editRoles: ['kinh_doanh', 'ke_toan'],
    fields: [
      { key: 'code', label: 'Mã khách hàng', type: 'text', required: true, help: 'Nên trùng mã trên Ecount' },
      { key: 'name', label: 'Tên khách hàng', type: 'text', required: true },
      { key: 'taxCode', label: 'Mã số thuế', type: 'text' },
      { key: 'taxAddress', label: 'Địa chỉ đăng ký thuế', type: 'textarea' },
      { key: 'phone', label: 'Điện thoại', type: 'text' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
      { key: 'active', label: 'Đang giao dịch', type: 'checkbox', default: true },
    ],
  },
  {
    key: 'shipto', group: 'Khách hàng', icon: '📍', title: 'Shipto (địa chỉ giao hàng)',
    short: 'Shipto', idField: 'shipCode', editRoles: ['kinh_doanh', 'ke_toan'],
    fields: [
      { key: 'customerCode', label: 'Mã khách hàng', type: 'ref', ref: 'soldto', required: true,
        fill: { customerName: 'name', taxCode: 'taxCode' } },
      { key: 'customerName', label: 'Tên khách hàng', type: 'text' },
      { key: 'taxCode', label: 'Mã số thuế', type: 'text' },
      { key: 'shipCode', label: 'Mã giao hàng', type: 'text', required: true },
      { key: 'address', label: 'Địa chỉ giao hàng', type: 'textarea', required: true },
      { key: 'contact', label: 'Người nhận', type: 'text' },
      { key: 'phone', label: 'Điện thoại nhận hàng', type: 'text' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },

  // ---------------- Hàng hóa ----------------
  {
    key: 'items', group: 'Hàng hóa', icon: '🏷️', title: 'Mã hàng', short: 'Mã hàng', idField: 'code', editRoles: ['kinh_doanh', 'ke_toan'],
    fields: [
      { key: 'code', label: 'Mã hàng', type: 'text', required: true, help: 'Nên trùng mã trên Ecount' },
      { key: 'name', label: 'Tên hàng', type: 'text', required: true },
      { key: 'unit', label: 'Đơn vị tính', type: 'select', options: ['Bao', 'Kg', 'Tấn', 'Jumbo'], default: 'Bao' },
      { key: 'bagWeight', label: 'Trọng lượng bao (kg)', type: 'number' },
      { key: 'bagsPerLayer', label: 'Số bao/lớp', type: 'number' },
      { key: 'layersPerPallet', label: 'Số lớp/pallet', type: 'number' },
      { key: 'bagsPerPallet', label: 'Số bao/pallet', type: 'number',
        computed: (r) => (num(r.bagsPerLayer) && num(r.layersPerPallet) ? num(r.bagsPerLayer) * num(r.layersPerPallet) : null) },
      { key: 'palletWeight', label: 'Trọng lượng pallet (kg)', type: 'number',
        computed: (r) => {
          const b = num(r.bagsPerLayer) * num(r.layersPerPallet) * num(r.bagWeight);
          return b ? b : null;
        } },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
      { key: 'active', label: 'Đang sử dụng', type: 'checkbox', default: true },
    ],
  },
  {
    key: 'goodsStatus', group: 'Hàng hóa', icon: '🔒', title: 'Tình trạng hàng hóa', short: 'Tình trạng hàng', idField: 'code',
    fields: [
      { key: 'code', label: 'Mã', type: 'text', required: true },
      { key: 'name', label: 'Tên tình trạng', type: 'text', required: true },
      { key: 'allowOutbound', label: 'Được xuất kho', type: 'checkbox', default: true,
        help: 'Bỏ tích thì hàng ở tình trạng này bị khóa xuất kho' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
    seed: [
      { code: 'KTC', name: 'Không thế chấp', allowOutbound: true },
      { code: 'HTC', name: 'Hàng thế chấp', allowOutbound: false, note: 'Chỉ xuất được sau khi giải chấp (DGC)' },
      { code: 'DGC', name: 'Đã giải chấp', allowOutbound: true },
    ],
  },
  {
    key: 'pledgees', group: 'Hàng hóa', icon: '🏦', title: 'Bên nhận thế chấp', short: 'Bên nhận thế chấp', idField: 'code',
    fields: [
      { key: 'code', label: 'Mã', type: 'text', required: true },
      { key: 'name', label: 'Ngân hàng / Bên nhận thế chấp', type: 'text', required: true, help: 'Tên đầy đủ, in ở dòng "Kính gửi"' },
      { key: 'shortName', label: 'Tên gọi tắt', type: 'text', help: 'VD: Techcombank (in trong câu đề nghị)' },
      { key: 'contractNo', label: 'Số hợp đồng thế chấp', type: 'text' },
      { key: 'fromDate', label: 'Hiệu lực từ', type: 'date' },
      { key: 'toDate', label: 'Hiệu lực đến', type: 'date' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
    seed: [
      { code: 'TCB', name: 'NGÂN HÀNG THƯƠNG MẠI CỔ PHẦN KỸ THƯƠNG VIỆT NAM (TECHCOMBANK)', shortName: 'Techcombank' },
    ],
  },
  {
    key: 'suppliers', group: 'Hàng hóa', icon: '🏭', title: 'Nhà cung cấp', short: 'Nhà cung cấp', idField: 'code', editRoles: ['kinh_doanh', 'ke_toan'],
    fields: [
      { key: 'code', label: 'Mã nhà cung cấp', type: 'text', required: true },
      { key: 'name', label: 'Tên nhà cung cấp', type: 'text', required: true },
      { key: 'taxCode', label: 'Mã số thuế', type: 'text' },
      { key: 'country', label: 'Quốc gia', type: 'text' },
      { key: 'address', label: 'Địa chỉ', type: 'textarea' },
      { key: 'phone', label: 'Điện thoại', type: 'text' },
      { key: 'email', label: 'Email', type: 'email' },
    ],
  },

  // ---------------- Kho ----------------
  {
    key: 'warehouses', group: 'Kho', icon: '🏬', title: 'Danh sách kho', short: 'Danh sách kho', idField: 'code',
    fields: [
      { key: 'code', label: 'Mã kho', type: 'text', required: true },
      { key: 'name', label: 'Tên kho', type: 'text', required: true },
      { key: 'hasGuard', label: 'Có bảo vệ', type: 'checkbox', default: true,
        help: 'Kho không có bảo vệ: luồng xe bỏ qua bước Chờ vào cửa và Chờ ra cổng' },
      { key: 'releaseStatus', label: 'TTHH khi giải chấp', type: 'select', options: ['DGC', 'KTC'],
        help: 'Hàng HTC ở kho này khi giải chấp chuyển sang tình trạng nào. Bỏ trống: kho có chữ "Cảng" → KTC, kho khác → DGC' },
      { key: 'address', label: 'Địa chỉ', type: 'textarea' },
      { key: 'manager', label: 'Người phụ trách', type: 'text' },
      { key: 'phone', label: 'Điện thoại', type: 'text' },
      { key: 'active', label: 'Đang hoạt động', type: 'checkbox', default: true },
    ],
  },
  {
    key: 'locations', group: 'Kho', icon: '🗄️', title: 'Vị trí lưu trữ', short: 'Vị trí lưu trữ',
    idOf: (r) => `${r.warehouse}__${r.code}`, keyFields: ['warehouse', 'code'],
    warehouseField: 'warehouse', editRoles: ['thu_kho'],
    fields: [
      { key: 'warehouse', label: 'Kho', type: 'ref', ref: 'warehouses', required: true },
      { key: 'code', label: 'Vị trí', type: 'text', required: true },
      { key: 'capacity', label: 'Sức chứa (pallet)', type: 'number', required: true },
      { key: 'currentPallets', label: 'Tồn kho hiện tại (pallet)', type: 'number', system: true, default: 0,
        help: 'Hệ thống tự cập nhật từ phiếu nhập/xuất' },
      { key: 'usedPct', label: '% pallet lưu trữ', type: 'number',
        computed: (r) => (num(r.capacity) ? Math.round((num(r.currentPallets) || 0) / num(r.capacity) * 1000) / 10 : null) },
      { key: 'emptyBin', label: 'Empty bin', type: 'checkbox', computed: (r) => !num(r.currentPallets) },
      { key: 'locked', label: 'Khóa vị trí', type: 'checkbox', help: 'Không cho xếp hàng vào vị trí này' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },
  {
    key: 'docks', group: 'Kho', icon: '🚪', title: 'Cửa xuất/nhập (dock)', short: 'Cửa xuất/nhập',
    idOf: (r) => `${r.warehouse}__${r.code}`, keyFields: ['warehouse', 'code'],
    warehouseField: 'warehouse', editRoles: ['thu_kho'],
    fields: [
      { key: 'warehouse', label: 'Kho', type: 'ref', ref: 'warehouses', required: true },
      { key: 'code', label: 'Mã cửa', type: 'text', required: true },
      { key: 'name', label: 'Tên cửa', type: 'text' },
      { key: 'usage', label: 'Dùng cho', type: 'select', options: ['Nhập và xuất', 'Chỉ nhập', 'Chỉ xuất'], default: 'Nhập và xuất' },
      { key: 'active', label: 'Đang dùng', type: 'checkbox', default: true },
    ],
  },
  {
    key: 'reasons', group: 'Kho', icon: '📝', title: 'Lý do', short: 'Lý do', idField: 'code', editRoles: ['thu_kho', 'ke_toan', 'kinh_doanh'],
    fields: [
      { key: 'code', label: 'Mã lý do', type: 'text', required: true },
      { key: 'name', label: 'Lý do', type: 'text', required: true },
      { key: 'appliesTo', label: 'Áp dụng cho', type: 'select',
        options: ['Nhập kho', 'Xuất kho', 'Điều chỉnh tồn', 'Trả hàng', 'Hàng lỗi', 'Hủy chuyến'] },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
    seed: [
      { code: 'DC01', name: 'Kiểm kê chênh lệch', appliesTo: 'Điều chỉnh tồn' },
      { code: 'TH01', name: 'Khách trả hàng', appliesTo: 'Trả hàng' },
      { code: 'HL01', name: 'Bao rách / hàng hỏng', appliesTo: 'Hàng lỗi' },
      { code: 'HC01', name: 'Xe không đến', appliesTo: 'Hủy chuyến' },
    ],
  },

  // ---------------- Vận tải ----------------
  {
    key: 'carriers', group: 'Vận tải', icon: '🚛', title: 'Đơn vị vận tải', short: 'Đơn vị vận tải', idField: 'code',
    fields: [
      { key: 'code', label: 'Mã đơn vị', type: 'text', required: true },
      { key: 'name', label: 'Tên đơn vị vận tải', type: 'text', required: true },
      { key: 'taxCode', label: 'Mã số thuế', type: 'text' },
      { key: 'contact', label: 'Người liên hệ', type: 'text' },
      { key: 'phone', label: 'Điện thoại', type: 'text' },
      { key: 'kind', label: 'Loại', type: 'select', options: ['Thuê ngoài', 'Nội bộ'], default: 'Thuê ngoài', help: 'Nhóm xe nội bộ của công ty; cước do người tính cước cập nhật sau' },
      { key: 'uses3PL', label: 'Được dùng 3PL (GHA)', type: 'checkbox', default: false, help: 'Điều phối của đơn vị này thấy danh mục 3PL và chỉ định 3PL cho chuyến; admin khách không thấy' },
      { key: 'active', label: 'Đang hợp tác', type: 'checkbox', default: true },
    ],
  },
  {
    key: 'vehicles', group: 'Vận tải', icon: '🚚', title: 'Xe', short: 'Xe', idField: 'plate', upperId: true, editRoles: ['van_tai'], carrierField: 'carrier',
    fields: [
      { key: 'plate', label: 'Biển số xe', type: 'text', required: true },
      { key: 'carrier', label: 'Đơn vị vận tải', type: 'ref', ref: 'carriers' },
      { key: 'vehicleType', label: 'Loại xe', type: 'select', options: ['Xe tải', 'Container 20', 'Container 40', 'Đầu kéo + mooc'] },
      { key: 'payload', label: 'Tải trọng (tấn)', type: 'number' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },
  {
    key: 'drivers', group: 'Vận tải', icon: '🧑‍✈️', title: 'Tài xế', short: 'Tài xế', idField: 'idCard', editRoles: ['van_tai'], carrierField: 'carrier',
    fields: [
      { key: 'idCard', label: 'Số CCCD', type: 'text', required: true },
      { key: 'name', label: 'Họ tên tài xế', type: 'text', required: true },
      { key: 'phone', label: 'Điện thoại', type: 'text' },
      { key: 'license', label: 'Số bằng lái', type: 'text' },
      { key: 'carrier', label: 'Đơn vị vận tải', type: 'ref', ref: 'carriers' },
    ],
  },  {
    key: 'freightRates', group: 'Vận tải', icon: '💰', title: 'Bảng giá cước vận chuyển', short: 'Bảng giá cước', idField: 'code', upperId: true, editRoles: ['ke_toan'],
    help: 'Để trống một điều kiện = áp dụng cho mọi giá trị. Phiếu xuất lấy dòng giá khớp cụ thể nhất (địa chỉ giao > đơn vị vận tải > khách hàng / kho nhận > loại xe > kho đi).',
    fields: [
      { key: 'code', label: 'Mã giá', type: 'text', required: true, help: 'VD: K1-BD-T (tự đặt)' },
      { key: 'basis', label: 'Cách tính', type: 'select', options: ['Theo tấn', 'Theo chuyến'], default: 'Theo tấn', required: true },
      { key: 'price', label: 'Đơn giá (đ/tấn hoặc đ/chuyến)', type: 'currency', required: true },
      { key: 'minAmount', label: 'Cước tối thiểu mỗi chuyến (đ)', type: 'currency', help: 'Tính theo tấn mà thấp hơn mức này thì lấy mức này' },
      { key: 'carrier', label: 'Đơn vị vận tải', type: 'ref', ref: 'carriers' },
      { key: 'fromWarehouse', label: 'Kho đi', type: 'ref', ref: 'warehouses' },
      { key: 'toCustomer', label: 'Khách hàng', type: 'ref', ref: 'soldto' },
      { key: 'toShipCode', label: 'Địa chỉ giao (mã giao)', type: 'ref', ref: 'shipto' },
      { key: 'toWarehouse', label: 'Kho nhận (chuyển kho)', type: 'ref', ref: 'warehouses' },
      { key: 'vehicleType', label: 'Loại xe', type: 'select', options: ['', 'Xe tải', 'Container 20', 'Container 40', 'Đầu kéo + mooc'] },
      { key: 'fromDate', label: 'Hiệu lực từ', type: 'date' },
      { key: 'toDate', label: 'Hiệu lực đến', type: 'date' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
      { key: 'active', label: 'Đang áp dụng', type: 'checkbox', default: true },
    ],
  },

  {
    key: 'threepl', group: 'Vận tải', icon: '🤝', title: 'Danh sách 3-PL', short: 'Danh sách 3-PL', idField: 'code', only3PL: true, editRoles: ['van_tai'],
    fields: [
      { key: 'code', label: 'Mã 3-PL', type: 'text', required: true },
      { key: 'name', label: 'Tên 3-PL', type: 'text', required: true },
      { key: 'contact', label: 'Người liên hệ', type: 'text' },
      { key: 'phone', label: 'Điện thoại', type: 'text' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },

  // ---------------- Hệ thống ----------------
  {
    key: 'codeRules', group: 'Hệ thống', icon: '#️⃣', title: 'Quy tắc mã tự sinh', short: 'Mã tự sinh', idField: 'code', adminOnly: true,
    fields: [
      { key: 'code', label: 'Loại chứng từ', type: 'text', required: true },
      { key: 'name', label: 'Tên', type: 'text', required: true },
      { key: 'prefix', label: 'Tiền tố', type: 'text' },
      { key: 'digits', label: 'Số chữ số', type: 'number', default: 5 },
      { key: 'next', label: 'Số tiếp theo', type: 'number', default: 1 },
      { key: 'example', label: 'Ví dụ', type: 'text',
        computed: (r) => `${r.prefix || ''}${String(num(r.next) || 1).padStart(num(r.digits) || 5, '0')}` },
    ],
    seed: [
      { code: 'SO', name: 'Đơn bán', prefix: 'SO', digits: 6, next: 1 },
      { code: 'PO', name: 'Đơn mua', prefix: 'PO', digits: 6, next: 1 },
      { code: 'STO', name: 'Lệnh chuyển kho', prefix: 'STO', digits: 6, next: 1 },
      { code: 'PN', name: 'Phiếu nhập kho', prefix: 'PN', digits: 6, next: 1 },
      { code: 'PX', name: 'Phiếu xuất kho', prefix: 'PX', digits: 6, next: 1 },
      { code: 'CV', name: 'Phiếu chuyển vị trí', prefix: 'CV', digits: 6, next: 1 },
      { code: 'TC', name: 'Phiếu đổi tình trạng thế chấp', prefix: 'TC', digits: 6, next: 1 },
      { code: 'DC', name: 'Phiếu điều chỉnh tồn', prefix: 'DC', digits: 6, next: 1 },
      { code: 'HSGC', name: 'Đề nghị giải chấp (số = HSGC + yymmdd + số thứ tự trong ngày)', prefix: 'HSGC', digits: 2, next: 1 },
      { code: 'GRP', name: 'Chuyến xe (đăng ký cổng)', prefix: 'GRP', digits: 5, next: 1 },
      { code: 'SP', name: 'Lô vận chuyển', prefix: 'SP', digits: 5, next: 1 },
      { code: 'KH', name: 'Mã khách hàng mới', prefix: 'KH', digits: 6, next: 1 },
      { code: 'LOT', name: 'Lô hàng (khi nhập không có Lot)', prefix: 'LOT', digits: 6, next: 1 },
    ],
  },
  {
    key: 'users', group: 'Hệ thống', icon: '🔑', title: 'Phân quyền', short: 'Phân quyền', idField: 'email', lowerId: true, adminOnly: true,
    fields: [
      { key: 'email', label: 'Email đăng nhập', type: 'email', required: true },
      { key: 'name', label: 'Họ tên', type: 'text', required: true },
      { key: 'role', label: 'Vai trò', type: 'select', options: ROLES.map((r) => r[0]), labels: Object.fromEntries(ROLES.map((r) => [r[0], r[1]])), required: true, default: 'xem' },
      { key: 'warehouses', label: 'Kho được thao tác', type: 'multiref', ref: 'warehouses', help: 'Để trống = tất cả kho' },
      { key: 'carrier', label: 'Thuộc đơn vị vận tải', type: 'ref', ref: 'carriers', help: 'Bắt buộc với vai trò Điều phối vận tải / Tài xế: chỉ thấy dữ liệu của đơn vị này' },
      { key: 'idCard', label: 'CCCD (tài xế)', type: 'text', help: 'Vai trò Tài xế: số CCCD để nhận chuyến' },
      { key: 'seeAllOrders', label: 'Kinh doanh: xem đơn của mọi sale', type: 'checkbox', default: false, help: 'Không tích: vai trò Kinh doanh chỉ thấy đơn SO/PO có Sale phụ trách là mình' },
      { key: 'formDesigner', label: 'Được thiết lập biểu mẫu', type: 'checkbox', default: false, help: 'Tự thêm / sửa / ẩn trường của danh mục và biểu mẫu đơn hàng (Quản lý trường, nút + Thêm trường)' },
      { key: 'active', label: 'Đang hoạt động', type: 'checkbox', default: true },
    ],
  },
];

export const GROUPS = [...new Set(CATALOGS.map((c) => c.group))];
// Biểu mẫu đơn hàng (không phải danh mục): cấu hình trường ở "Quản lý trường" như danh mục.
// Trường "liên kết" (link: { via, field }) tự lấy giá trị từ bản ghi đã chọn ở trường via (vd. khách hàng → điều khoản thanh toán)
export const FORM_DEFS = [
  {
    key: 'soHead', group: 'Biểu mẫu đơn hàng', icon: '🧾', title: 'Đơn bán (SO) – phần chung', short: 'SO phần chung', form: true,
    fields: [
      { key: 'date', label: 'Ngày tạo đơn', type: 'date', required: true },
      { key: 'company', label: 'Công ty xuất', type: 'ref', ref: 'companies', required: true },
      { key: 'partyCode', label: 'Khách hàng', type: 'ref', ref: 'soldto', required: true },
      { key: 'sales', label: 'Sale phụ trách', type: 'email', help: 'Sale chỉ thấy đơn của mình (trừ người được cho xem đơn của mọi sale)' },
      { key: 'tolerancePct', label: 'Dung sai cho phép (%)', type: 'percent', help: 'Được giao vượt số đặt tối đa bao nhiêu %' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },
  {
    key: 'soLine', group: 'Biểu mẫu đơn hàng', icon: '📦', title: 'Đơn bán (SO) – dòng hàng', short: 'SO dòng hàng', form: true,
    fields: [
      { key: 'dueDate', label: 'Ngày giao', type: 'date' },
      { key: 'warehouse', label: 'Kho xuất', type: 'ref', ref: 'warehouses' },
      { key: 'item', label: 'Mã hàng', type: 'ref', ref: 'items', required: true },
      { key: 'itemName', label: 'Tên hàng', type: 'text', system: true },
      { key: 'qtyT', label: 'Số lượng (tấn)', type: 'number', required: true },
      { key: 'shipCode', label: 'Mã giao', type: 'ref', ref: 'shipto' },
      { key: 'goodsStatus', label: 'TTHH', type: 'select', options: ['KTC', 'DGC'], help: 'Bỏ trống = KTC hoặc DGC đều được' },
      { key: 'note', label: 'Ghi chú', type: 'text' },
    ],
  },
];
FORM_DEFS.push(
  {
    key: 'poHead', group: 'Biểu mẫu đơn hàng', icon: '🧾', title: 'Đơn mua (PO) – phần chung', short: 'PO phần chung', form: true,
    fields: [
      { key: 'date', label: 'Ngày tạo đơn', type: 'date', required: true },
      { key: 'company', label: 'Công ty mua', type: 'ref', ref: 'companies', required: true },
      { key: 'partyCode', label: 'Nhà cung cấp', type: 'ref', ref: 'suppliers', required: true },
      { key: 'sales', label: 'Sale phụ trách', type: 'email', help: 'Sale chỉ thấy đơn của mình (trừ người được cho xem đơn của mọi sale)' },
      { key: 'tolerancePct', label: 'Dung sai cho phép (%)', type: 'percent', help: 'Được nhận vượt số đặt tối đa bao nhiêu %' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },
  {
    key: 'poLine', group: 'Biểu mẫu đơn hàng', icon: '📦', title: 'Đơn mua (PO) – dòng hàng', short: 'PO dòng hàng', form: true,
    fields: [
      { key: 'dueDate', label: 'Ngày hàng về (ETA)', type: 'date' },
      { key: 'warehouse', label: 'Kho nhập', type: 'ref', ref: 'warehouses' },
      { key: 'item', label: 'Mã hàng', type: 'ref', ref: 'items', required: true },
      { key: 'itemName', label: 'Tên hàng', type: 'text', system: true },
      { key: 'qtyT', label: 'Số lượng (tấn)', type: 'number', required: true },
      { key: 'goodsStatus', label: 'TTHH khi nhập', type: 'select', options: ['KTC', 'HTC', 'DGC'], help: 'Điền sẵn tình trạng trên phiếu nhập kho' },
      { key: 'note', label: 'Ghi chú', type: 'text' },
    ],
  },
  {
    key: 'stoHead', group: 'Biểu mẫu đơn hàng', icon: '🧾', title: 'Lệnh chuyển kho (STO) – phần chung', short: 'STO phần chung', form: true,
    fields: [
      { key: 'date', label: 'Ngày tạo đơn', type: 'date', required: true },
      { key: 'company', label: 'Công ty chủ hàng', type: 'ref', ref: 'companies', required: true },
      { key: 'tolerancePct', label: 'Dung sai cho phép (%)', type: 'percent', help: 'Được xuất vượt số lệnh tối đa bao nhiêu %' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },
  {
    key: 'stoLine', group: 'Biểu mẫu đơn hàng', icon: '📦', title: 'Lệnh chuyển kho (STO) – dòng hàng', short: 'STO dòng hàng', form: true,
    fields: [
      { key: 'dueDate', label: 'Ngày chuyển', type: 'date' },
      { key: 'fromWarehouse', label: 'Kho xuất', type: 'ref', ref: 'warehouses', required: true },
      { key: 'toWarehouse', label: 'Kho nhập', type: 'ref', ref: 'warehouses', required: true },
      { key: 'item', label: 'Mã hàng', type: 'ref', ref: 'items', required: true },
      { key: 'itemName', label: 'Tên hàng', type: 'text', system: true },
      { key: 'qtyT', label: 'Số lượng (tấn)', type: 'number', required: true },
      { key: 'goodsStatus', label: 'TTHH', type: 'select', options: ['KTC', 'HTC', 'DGC'], help: 'Bỏ trống = tình trạng nào cũng được' },
      { key: 'note', label: 'Ghi chú', type: 'text' },
    ],
  },
);
export const catalogByKey = (k) => CATALOGS.find((c) => c.key === k) || FORM_DEFS.find((c) => c.key === k);
// Tên hiển thị của 1 bản ghi khi được chọn ở trường ref
export const refLabel = (row) => (row ? [row.code || row.plate || row.idCard || row.email, row.name].filter(Boolean).join(' – ') : '');
export const refValue = (catalog, row) => {
  const c = catalogByKey(catalog);
  return c.idOf ? c.idOf(row) : row[c.idField];
};
