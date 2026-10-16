// ============================================================================
// Thông tin xuất hóa đơn cước vận chuyển: "Cước vận chuyển hạt nhựa từ <nơi nhận> đến <nơi giao>"
//  • Nơi nhận: điểm nhận (cảng…) nếu chuyến có; không thì kho xuất:
//      - kho tích "Kho phổ biến" (Đức Hòa, 3PL Sotrans, Đặng Huỳnh…): thông tin xuất hóa đơn của kho, không có thì địa chỉ kho
//      - kho khác: vị trí tích "Cần thông tin xuất hóa đơn" (cảng SP-ITC, kho mua nội địa…) → thông tin của vị trí;
//        không có thì thông tin xuất hóa đơn của kho (thiếu thì báo ⚠ và tạm lấy địa chỉ / tên kho)
//  • Nơi giao: mã giao → khách hàng → địa chỉ mã giao; chuyển kho (STO) → kho nhận theo cách trên
// ============================================================================
const s = (v) => String(v ?? '').trim();
const uniq = (a) => [...new Set(a.map(s).filter(Boolean))];
export const INVOICE_PREFIX = 'Cước vận chuyển hạt nhựa';

// Thông tin của 1 kho (+ các vị trí lấy hàng / nhận hàng ở kho đó)
export function whInvoice(code, locs = [], { warehouses = [], locations = [] } = {}) {
  const w = warehouses.find((x) => x.code === code);
  if (!w) return { text: s(code), missing: !!code };
  const base = s(w.invoiceInfo) || s(w.address) || s(w.name) || code;
  if (w.invoiceCommon) return { text: base, missing: false };
  const special = uniq(locs).map((lc) => locations.find((x) => x.warehouse === code && x.code === lc)).filter((x) => x?.needInvoice);
  if (special.length) {
    const texts = uniq(special.map((x) => s(x.invoiceInfo) || `${s(w.name) || code} – vị trí ${x.code}`));
    return { text: texts.join('; '), missing: special.some((x) => !s(x.invoiceInfo)) };
  }
  return { text: base, missing: !s(w.invoiceInfo) };
}

// Vị trí lấy hàng của chuyến (ghi khi giao vận tải từ phân bổ / phiếu xuất)
export const tripLocations = (t) => uniq([...(String(t.pickupLocation || '').split(',')), ...(t.lines || []).map((l) => l.location)]);

export function tripInvoice(t, cats = {}) {
  const { pickupPoints = [], soldto = [], shipto = [], warehouses = [] } = cats;
  let from;
  if (t.pickup) {
    const p = pickupPoints.find((x) => x.code === t.pickup);
    from = { text: s(p?.invoiceInfo) || s(t.pickupName) || s(p?.name) || t.pickup, missing: false };
  } else from = whInvoice(t.warehouse, tripLocations(t), cats);
  const seen = new Map();
  for (const l of t.lines || []) {
    const k = `${l.partyCode}|${l.shipCode}`;
    if (seen.has(k)) continue;
    const whCode = String(l.partyCode || '').split(',')[0].trim();
    if (!l.shipCode && warehouses.some((w) => w.code === whCode)) { seen.set(k, whInvoice(whCode, [l.toLocation], cats)); continue; }
    const st = l.shipCode ? shipto.find((x) => x.shipCode === l.shipCode && (!l.partyCode || !x.customerCode || x.customerCode === l.partyCode)) || shipto.find((x) => x.shipCode === l.shipCode) : null;
    const c = soldto.find((x) => x.code === l.partyCode);
    const info = s(st?.invoiceInfo) || s(c?.invoiceInfo);
    seen.set(k, { text: info || s(l.address) || s(st?.address) || s(l.partyName) || s(c?.name) || l.partyCode, missing: false });
  }
  const to = [...seen.values()];
  const toText = uniq(to.map((x) => x.text)).join('; ');
  const missing = [...(from.missing ? ['nơi nhận'] : []), ...(to.some((x) => x.missing) ? ['nơi giao'] : [])];
  return { from: from.text, to: toText, missing, text: `${INVOICE_PREFIX} từ ${from.text || '…'} đến ${toText || '…'}` };
}
