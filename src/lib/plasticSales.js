// Phân sale theo loại hạt nhựa: mã hàng có Loại hạt nhựa (Nguyên sinh / Tái sinh),
// khách hàng có Sale phụ trách từng loại. Sale chỉ thấy khách mình được gán, chỉ chọn mã hàng loại mình phụ trách.
// Khách chưa gán sale nào: mọi sale đều thấy (để dữ liệu cũ vẫn dùng được cho tới khi gán).
export const PLASTIC_TYPES = [
  { type: 'Nguyên sinh', key: 'salesVirgin' },
  { type: 'Tái sinh', key: 'salesRecycled' },
];
const low = (v) => String(v || '').trim().toLowerCase();

// Email sale phụ trách loại hàng t của khách c
export const salesFor = (c, t) => low(c?.[PLASTIC_TYPES.find((p) => p.type === t)?.key]);
// Mọi sale được gán của khách
export const customerSales = (c) => PLASTIC_TYPES.map((p) => low(c?.[p.key])).filter(Boolean);
// Sale (email) có thấy khách c không
export const saleSeesCustomer = (c, email) => {
  const s = customerSales(c);
  return !s.length || s.includes(low(email));
};
// Các loại hàng sale được bán cho khách c (null = không giới hạn)
export const saleTypes = (c, email) => {
  if (!c || !customerSales(c).length) return null;
  return PLASTIC_TYPES.filter((p) => low(c[p.key]) === low(email)).map((p) => p.type);
};
// Mã hàng chưa phân loại: ai cũng chọn được
export const itemAllowed = (item, c, email) => {
  const types = saleTypes(c, email);
  return !item?.plasticType || !types || types.includes(item.plasticType);
};
// Các loại hạt nhựa có trong danh sách mã hàng (bỏ mã chưa phân loại)
export const typesOf = (codes, itemMap) => [...new Set(codes.map((c) => itemMap.get(c)?.plasticType).filter(Boolean))];
