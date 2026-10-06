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
  ['text', 'Chữ (1 dòng)'],
  ['textarea', 'Đoạn văn'],
  ['number', 'Số'],
  ['date', 'Ngày'],
  ['checkbox', 'Có / Không'],
  ['select', 'Danh sách chọn'],
  ['email', 'Email'],
];

export const ROLES = [
  ['admin', 'Quản trị', 'Toàn quyền, sửa mọi danh mục, phân quyền'],
  ['thu_kho', 'Thủ kho', 'Nhập, xuất, chuyển vị trí, điều chỉnh tồn; sửa vị trí lưu trữ và cửa xuất/nhập của kho được giao'],
  ['bao_ve', 'Bảo vệ', 'Xem danh mục (xác nhận xe vào/ra cổng ở bước sau)'],
  ['kinh_doanh', 'Kinh doanh / Mua hàng', 'Lập và theo dõi đơn bán (SO), đơn mua (PO); xem tồn kho và chuyến xe'],
  ['ke_toan', 'Kế toán', 'Xem mọi thứ; lập SO/PO; đổi tình trạng thế chấp (KTC, HTC, DGC)'],
  ['xem', 'Chỉ xem', 'Chỉ xem danh mục'],
];
export const roleLabel = (r) => ROLES.find((x) => x[0] === r)?.[1] || r || '';

const num = (v) => (v === '' || v == null ? null : Number(v));

export const CATALOGS = [
  // ---------------- Khách hàng ----------------
  {
    key: 'soldto', group: 'Khách hàng', icon: '🏢', title: 'Soldto (khách hàng xuất hóa đơn)',
    short: 'Soldto', idField: 'code',
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
    short: 'Shipto', idField: 'shipCode',
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
    key: 'items', group: 'Hàng hóa', icon: '🏷️', title: 'Mã hàng', short: 'Mã hàng', idField: 'code',
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
      { key: 'name', label: 'Ngân hàng / Bên nhận thế chấp', type: 'text', required: true },
      { key: 'contractNo', label: 'Số hợp đồng thế chấp', type: 'text' },
      { key: 'fromDate', label: 'Hiệu lực từ', type: 'date' },
      { key: 'toDate', label: 'Hiệu lực đến', type: 'date' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },
  {
    key: 'suppliers', group: 'Hàng hóa', icon: '🏭', title: 'Nhà cung cấp', short: 'Nhà cung cấp', idField: 'code',
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
    key: 'reasons', group: 'Kho', icon: '📝', title: 'Lý do', short: 'Lý do', idField: 'code',
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
      { key: 'active', label: 'Đang hợp tác', type: 'checkbox', default: true },
    ],
  },
  {
    key: 'vehicles', group: 'Vận tải', icon: '🚚', title: 'Xe', short: 'Xe', idField: 'plate', upperId: true,
    fields: [
      { key: 'plate', label: 'Biển số xe', type: 'text', required: true },
      { key: 'carrier', label: 'Đơn vị vận tải', type: 'ref', ref: 'carriers' },
      { key: 'vehicleType', label: 'Loại xe', type: 'select', options: ['Xe tải', 'Container 20', 'Container 40', 'Đầu kéo + mooc'] },
      { key: 'payload', label: 'Tải trọng (tấn)', type: 'number' },
      { key: 'note', label: 'Ghi chú', type: 'textarea' },
    ],
  },
  {
    key: 'drivers', group: 'Vận tải', icon: '🧑‍✈️', title: 'Tài xế', short: 'Tài xế', idField: 'idCard',
    fields: [
      { key: 'idCard', label: 'Số CCCD', type: 'text', required: true },
      { key: 'name', label: 'Họ tên tài xế', type: 'text', required: true },
      { key: 'phone', label: 'Điện thoại', type: 'text' },
      { key: 'license', label: 'Số bằng lái', type: 'text' },
      { key: 'carrier', label: 'Đơn vị vận tải', type: 'ref', ref: 'carriers' },
    ],
  },
  {
    key: 'threepl', group: 'Vận tải', icon: '🤝', title: 'Danh sách 3-PL', short: 'Danh sách 3-PL', idField: 'code',
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
      { code: 'PN', name: 'Phiếu nhập kho', prefix: 'PN', digits: 6, next: 1 },
      { code: 'PX', name: 'Phiếu xuất kho', prefix: 'PX', digits: 6, next: 1 },
      { code: 'CV', name: 'Phiếu chuyển vị trí', prefix: 'CV', digits: 6, next: 1 },
      { code: 'TC', name: 'Phiếu đổi tình trạng thế chấp', prefix: 'TC', digits: 6, next: 1 },
      { code: 'DC', name: 'Phiếu điều chỉnh tồn', prefix: 'DC', digits: 6, next: 1 },
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
      { key: 'active', label: 'Đang hoạt động', type: 'checkbox', default: true },
    ],
  },
];

export const GROUPS = [...new Set(CATALOGS.map((c) => c.group))];
export const catalogByKey = (k) => CATALOGS.find((c) => c.key === k);
// Tên hiển thị của 1 bản ghi khi được chọn ở trường ref
export const refLabel = (row) => (row ? [row.code || row.plate || row.idCard || row.email, row.name].filter(Boolean).join(' – ') : '');
export const refValue = (catalog, row) => {
  const c = catalogByKey(catalog);
  return c.idOf ? c.idOf(row) : row[c.idField];
};
