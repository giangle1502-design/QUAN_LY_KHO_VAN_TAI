// Kho chung (kho vật lý) dùng chung vị trí cho nhiều kho pháp nhân.
// VD Kho Cảng gồm VAP-Cảng, PLA-Cảng, DAM-Cảng: vị trí Cát Lái lưu 1 lần ở `locations/CANG__Cát Lái`,
// hàng của mọi pháp nhân trong nhóm cùng tính sức chứa / Empty bin trên vị trí đó.
// Tồn kho, phiếu, đơn vẫn ghi theo kho pháp nhân như cũ.
// Bảng tra cứu nạp từ danh mục warehouseGroups + warehouses (AppContext gọi setWhGroups khi dữ liệu đổi).

let byWh = new Map(); // mã kho pháp nhân → bản ghi kho chung
let groups = new Map(); // mã kho chung → bản ghi
let whRows = new Map(); // mã kho → bản ghi kho
let tick = 0;

export function setWhGroups(groupRows = [], warehouseRows = []) {
  groups = new Map(groupRows.filter((g) => g.active !== false).map((g) => [g.code || g._id, { ...g, code: g.code || g._id, members: g.members || [] }]));
  byWh = new Map();
  for (const g of groups.values()) for (const m of g.members) if (!byWh.has(m)) byWh.set(m, g);
  whRows = new Map(warehouseRows.map((w) => [w.code || w._id, w]));
  tick += 1;
  return tick;
}
export const whGroupsTick = () => tick;

// Mã "kho" của vị trí: kho chung nếu kho thuộc kho chung, không thì chính kho đó
export const locWh = (wh) => (wh && byWh.get(wh)?.code) || wh || '';
export const groupOf = (wh) => byWh.get(wh) || null;
export const groupByCode = (code) => groups.get(code) || null;
export const allGroups = () => [...groups.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
// Các kho pháp nhân dùng chung vị trí với kho này (kể cả chính nó)
export const siblingsOf = (wh) => byWh.get(wh)?.members || (wh ? [wh] : []);
// Mã kho / kho chung (của vị trí) → các kho pháp nhân dùng vị trí đó
export const whsOfLocWh = (code) => groups.get(code)?.members || (code ? [code] : []);
export const locIdOf = (wh, loc) => `${locWh(wh)}__${loc}`;
// Vị trí thuộc kho: vị trí của kho chung, hoặc vị trí còn khai báo riêng ở chính kho pháp nhân (chưa bấm Gộp)
export const locOfWh = (l, wh) => !!wh && (l.warehouse === locWh(wh) || l.warehouse === wh);
// Vị trí của 1 kho pháp nhân (lọc danh mục Vị trí lưu trữ). Trùng mã ở kho chung và kho riêng: lấy của kho chung
export const locsOfWh = (locations, wh) => {
  const k = locWh(wh);
  const all = (locations || []).filter((l) => locOfWh(l, wh));
  return k === wh ? all : all.filter((l) => l.warehouse === k || !all.some((x) => x.warehouse === k && x.code === l.code));
};
// Kho / kho chung không cần sức chứa (cảng, mua nội địa, 3PL…)
export const noCapacity = (whOrGroup) => {
  const g = groups.get(whOrGroup) || byWh.get(whOrGroup);
  return !!(g?.noCapacity || whRows.get(whOrGroup)?.noCapacity);
};
// Quy tắc nhập hàng: hàng mua (PO / nhập trực tiếp từ NCC) chỉ vào kho tích "Nhận hàng mua (PO)" (Cảng, Mua nội địa, Ngoại quan),
// kho khác chỉ nhập bằng chuyển kho (STO) hoặc khách trả hàng. Chưa kho / kho chung nào tích = không giới hạn.
export const poRuleOn = () => [...groups.values()].some((g) => g.poReceive) || [...whRows.values()].some((w) => w.poReceive && w.active !== false);
export const buysInto = (wh) => !poRuleOn() || !wh || !!(whRows.get(wh)?.poReceive || byWh.get(wh)?.poReceive);
export const buyWhText = () => [...[...groups.values()].filter((g) => g.poReceive).map((g) => g.name || g.code), ...[...whRows.values()].filter((w) => w.poReceive && !byWh.get(w.code || w._id)?.poReceive).map((w) => w.code || w._id)].join(', ');

// Kho có bảo vệ & thủ kho (hiện chỉ Kho Đức Hòa): chuyến xe qua bảo vệ cổng; thủ kho chỉ định xe vào cửa nào, xác nhận nhập / xuất xong.
// Kho không có: chuyến xe bỏ các bước đó. (Phiếu nhập ở mọi kho đều ghi tồn ngay khi lưu, không chờ thủ kho.)
// Kho thuộc Kho chung: theo ô của Kho chung (chưa đặt: Kho chung tên / mã có "Đức Hòa" = có). Kho lẻ: ô "Có bảo vệ" của kho (mặc định có)
const isDucHoa = (g) => { const t = `${g.code || ''} ${g.name || ''}`.normalize('NFC').toUpperCase(); return t.includes('DUCHOA') || t.includes('DUC HOA') || t.includes('ĐỨC HÒA') || t.includes('ĐỨC HOÀ'); };
export const hasKeeper = (wh) => {
  if (!wh) return true;
  const g = groups.get(wh) || byWh.get(wh);
  if (g) return typeof g.hasGuard === 'boolean' ? g.hasGuard : isDucHoa(g);
  return whRows.get(wh)?.hasGuard !== false;
};

// In nhãn pallet / lot: chỉ kho mình tự quản lý (Kho Đức Hòa). Kho khách (Cảng, Mua nội địa, Ngoại quan, 3PL…) không in nhãn.
// Kho thuộc Kho chung: theo ô "In nhãn pallet" của Kho chung (chưa đặt: Kho chung tên / mã có "Đức Hòa" = có).
// Kho lẻ: ô "In nhãn pallet" của kho (chưa đặt: tên / mã có "Đức Hòa" = có)
export const printsLabels = (wh) => {
  if (!wh) return false;
  const g = groups.get(wh) || byWh.get(wh);
  if (g) return typeof g.printLabels === 'boolean' ? g.printLabels : isDucHoa(g);
  const w = whRows.get(wh);
  return typeof w?.printLabels === 'boolean' ? w.printLabels : isDucHoa(w || { code: wh });
};

// Pháp nhân mặc định của kho (VD VAP-Cảng → VAP)
export const companyOfWh = (wh) => whRows.get(wh)?.company || '';
export const whLabel = (code) => {
  const g = groups.get(code);
  if (g) return `${g.code} – ${g.name || ''} (kho chung)`;
  const w = whRows.get(code);
  return w ? `${w.code} – ${w.name || ''}` : code || '';
};

// Tên kho đầy đủ để hiển thị trên báo cáo (không bắt nhớ mã kho): "VAP - Việt An Pha Đức Hòa", "Kho ngoại quan ICD Long Bình".
// Kho có pháp nhân mà tên chưa ghi pháp nhân → thêm "PHÁP NHÂN - " phía trước. Kho chung → tên kho chung. Không có trong danh mục → giữ mã.
const plainUp = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'D').toUpperCase();
export const whFullName = (code) => {
  if (!code) return '';
  const w = whRows.get(code);
  if (w) {
    const name = String(w.name || '').trim() || code;
    const co = String(w.company || '').trim();
    return co && !plainUp(name).startsWith(plainUp(co)) ? `${co} - ${name}` : name;
  }
  const g = groups.get(code);
  return g ? String(g.name || '').trim() || code : code;
};
// Danh sách mã kho "K1, K2" → tên đầy đủ
export const whFullNames = (codes) => String(codes || '').split(/\s*,\s*/).filter(Boolean).map(whFullName).join(', ');
