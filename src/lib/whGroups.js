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
// Pháp nhân mặc định của kho (VD VAP-Cảng → VAP)
export const companyOfWh = (wh) => whRows.get(wh)?.company || '';
export const whLabel = (code) => {
  const g = groups.get(code);
  if (g) return `${g.code} – ${g.name || ''} (kho chung)`;
  const w = whRows.get(code);
  return w ? `${w.code} – ${w.name || ''}` : code || '';
};
