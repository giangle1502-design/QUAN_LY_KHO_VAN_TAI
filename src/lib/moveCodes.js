// ============================================================================
// Movetype kiểu SAP cho phiếu kho: mỗi phiếu có 1 mã nghiệp vụ, hủy phiếu = mã đảo (mã + 1, hoặc cặp 343/344, 701/702).
// Số lượng có dấu: nhập vào +, xuất đi −; hủy phiếu đảo dấu. Chuyển vị trí / đổi tình trạng không đổi tổng tồn (±).
// Tính từ dữ liệu phiếu (không cần ghi thêm vào phiếu cũ).
// ============================================================================

export const MVT = {
  101: { label: 'Nhập theo PO / nhận STO', sign: 1 },
  102: { label: 'Hủy nhập theo PO / STO', sign: -1 },
  501: { label: 'Nhập trực tiếp (không có PO trước)', sign: 1 },
  502: { label: 'Hủy nhập trực tiếp', sign: -1 },
  561: { label: 'Nhập tồn đầu kỳ', sign: 1 },
  562: { label: 'Hủy nhập tồn đầu kỳ', sign: -1 },
  651: { label: 'Nhập hàng khách trả về (theo SO / SO trả hàng DRT)', sign: 1 },
  652: { label: 'Hủy nhập hàng trả về', sign: -1 },
  601: { label: 'Xuất bán cho khách (SO)', sign: -1 },
  602: { label: 'Hủy xuất bán', sign: 1 },
  641: { label: 'Xuất chuyển kho (STO)', sign: -1 },
  642: { label: 'Hủy xuất chuyển kho', sign: 1 },
  201: { label: 'Xuất khác (không theo đơn)', sign: -1 },
  202: { label: 'Hủy xuất khác', sign: 1 },
  311: { label: 'Chuyển vị trí trong kho', sign: 0 },
  312: { label: 'Hủy chuyển vị trí', sign: 0 },
  343: { label: 'Giải chấp (HTC → KTC/DGC)', sign: 0 },
  344: { label: 'Thế chấp (→ HTC) / hủy giải chấp', sign: 0 },
  321: { label: 'Đổi tình trạng khác', sign: 0 },
  322: { label: 'Hủy đổi tình trạng', sign: 0 },
  701: { label: 'Điều chỉnh tăng (kiểm kê thừa)', sign: 1 },
  702: { label: 'Điều chỉnh giảm (kiểm kê thiếu)', sign: -1 },
};

// Thứ tự hiện trong bảng tra cứu
export const MVT_GROUPS = [
  ['Nhập kho', [101, 102, 501, 502, 561, 562, 651, 652]],
  ['Xuất kho', [601, 602, 641, 642, 201, 202]],
  ['Trong kho', [311, 312, 343, 344, 321, 322, 701, 702]],
];

const n = (v) => Number(v) || 0;
// Mã đảo khi hủy phiếu
export const reverseCode = (c) => (c % 2 ? c + 1 : c - 1);

// Mã của 1 dòng phiếu (chiều lập phiếu, chưa hủy)
export function lineCode(m, l) {
  if (m.type === 'in') {
    const src = m.source || (m.orderId ? (String(m.orderId).startsWith('SO') ? 'SO' : 'PO') : '');
    if (src === 'PO' || src === 'STO') return 101;
    if (src === 'SO' || src === 'DRT') return 651;
    if (src === 'direct') return 501;
    return /tồn đầu kỳ/i.test(m.reason || '') ? 561 : 501;
  }
  if (m.type === 'out') {
    if (m.orderType === 'STO' || String(m.orderId || '').startsWith('STO')) return 641;
    if (m.orderId) return 601;
    return 201;
  }
  if (m.type === 'move') return 311;
  if (m.type === 'status') {
    if (l?.goodsStatus === 'HTC' && l?.toStatus !== 'HTC') return 343;
    if (l?.toStatus === 'HTC' && l?.goodsStatus !== 'HTC') return 344;
    return 321;
  }
  if (m.type === 'adjust') return (l?.sign === '-' || n(l?.kg) < 0) ? 702 : 701;
  return 0;
}

// Mã của phiếu (gộp các dòng); cancel = true → mã đảo
export function moveCodes(m, cancel = false) {
  const cs = [...new Set((m.lines || []).map((l) => lineCode(m, l)))].filter(Boolean);
  if (!cs.length) cs.push(lineCode(m, null));
  return cs.map((c) => (cancel ? reverseCode(c) : c)).sort();
}

// Kg có dấu của dòng: nhập +, xuất −, điều chỉnh theo dấu dòng, chuyển / đổi tình trạng 0
export function signedKg(m, l, cancel = false) {
  const c = lineCode(m, l);
  const s = MVT[c]?.sign ?? 0;
  const v = Math.abs(n(l.kg)) * s;
  return cancel ? -v : v;
}
export const signedTotal = (m, k = 'kg', cancel = false) => (m.lines || []).reduce((a, l) => {
  const c = lineCode(m, l);
  const s = (MVT[c]?.sign ?? 0) * (cancel ? -1 : 1);
  return a + Math.abs(n(l[k])) * s;
}, 0);

// Phiếu đã từng ghi tồn chưa (để biết hủy có đảo tồn không): phiếu chờ nhận / chờ giải chấp bị hủy thì chưa ghi tồn
export function wasPosted(m) {
  if (m.status !== 'cancelled') return m.status === 'posted';
  if (m.confirmedAt) return true;
  const first = m.history?.[0]?.action || '';
  return !/chờ/i.test(first);
}

// Tình trạng / bước của phiếu cho danh sách (title: giải thích đầy đủ)
export function stepOf(m) {
  if (m.status === 'cancelled') return wasPosted(m) ? { label: 'Đã hủy', title: 'Đã hủy, tồn kho đã đảo lại (xem dòng hủy bên dưới)', tone: 'red', done: true }
    : { label: 'Đã hủy', title: 'Hủy khi chưa ghi tồn kho', tone: 'red', done: true };
  if (m.type === 'in' && m.status === 'pending') return { label: '⏳ 1/2 Chờ thủ kho nhận', title: 'Bước 1/2: đã lập phiếu, chờ thủ kho nhận hàng và xác nhận (chưa vào tồn)', tone: 'amber', step: 1 };
  if (m.type === 'out' && m.status === 'wait_release') return { label: '⏳ 1/2 Chờ giải chấp', title: 'Bước 1/2: đã lập phiếu, soạn hàng được; chờ lập lệnh giải chấp hàng HTC (chưa trừ tồn)', tone: 'amber', step: 1 };
  if (m.type === 'out' && !m.plate && !m.driverName && !m.carrierName && !m.carrier) return { label: '✓ Đã xuất · thiếu thông tin xe', title: 'Đã trừ tồn; chưa ghi số xe / tài xế (bổ sung trong phiếu)', tone: 'blue', done: true };
  return { label: '✓ Hoàn thành', title: m.type === 'in' ? 'Đã nhập kho' : m.type === 'out' ? 'Đã xuất kho' : 'Đã ghi tồn kho', tone: 'green', done: true };
}
