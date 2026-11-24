import { noCapacity } from './whGroups';
import { estPallets } from './stock';
// Sức chứa vị trí khi nhập hàng: cảnh báo dòng nhập vượt số pallet còn trống của vị trí
// và chia 1 dòng thành nhiều dòng, mỗi dòng không quá sức chứa vị trí để nhân viên chọn vị trí
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
const EPS = 1e-6;

export const OVER_CAP_MSG = 'Số lượng nhập vượt quá giới hạn vị trí';
export const OVER_CAP_CONFIRM = 'Xác nhận nhập vượt giới hạn';

// Mỗi dòng → { location, capacity, free (còn trống cho dòng này, đã trừ các dòng phía trên cùng vị trí), need, over }
// Kho / kho chung tích "Không cần sức chứa" (cảng, mua nội địa, 3PL): không kiểm tra
export function capacityCheck(lines, locations) {
  if (locations.length && noCapacity(locations[0].warehouse)) return lines.map(() => null);
  const byCode = new Map(locations.map((x) => [x.code, x]));
  const used = new Map();
  return lines.map((l) => {
    const loc = l.location && byCode.get(l.location);
    const need = n(l.pallets);
    if (!loc || !n(loc.capacity) || need <= 0) return null;
    const before = used.get(loc.code) || 0;
    used.set(loc.code, before + need);
    const free = Math.max(0, r3(n(loc.capacity) - n(loc.currentPallets) - before));
    return { location: loc.code, capacity: n(loc.capacity), free, need, over: need > free + EPS };
  });
}

// Chia dòng: dòng đầu giữ vị trí đã chọn với số pallet còn trống, phần còn lại chia thành
// các dòng ≤ sức chứa vị trí, để trống vị trí cho nhân viên chọn. Kg, số bao chia theo tỷ lệ pallet.
export function splitByCapacity(line, info) {
  const total = n(line.pallets);
  if (!info || !info.over || total <= 0 || info.capacity <= 0) return [line];
  const parts = [];
  const first = Math.floor(info.free + EPS);
  if (first > 0) parts.push({ pallets: first, location: line.location });
  let left = r3(total - first);
  while (left > EPS) {
    const p = Math.min(info.capacity, left);
    parts.push({ pallets: r3(p), location: '' });
    left = r3(left - p);
  }
  const kg = n(line.kg), bags = n(line.bags);
  let kgLeft = kg, bagsLeft = bags;
  return parts.map((p, i) => {
    const last = i === parts.length - 1;
    const k = p.pallets / total;
    const pk = last ? r3(kgLeft) : r3(kg * k);
    const pb = last ? r3(bagsLeft) : r3(bags * k);
    kgLeft -= pk; bagsLeft -= pb;
    const { plannedKg, kgTxt, ...rest } = line;
    return { ...rest, ...(i === 0 && plannedKg != null ? { plannedKg } : {}), location: p.location,
      pallets: p.pallets, kg: line.kg === '' ? '' : pk, bags: line.bags === '' ? '' : pb };
  });
}

// Vị trí đang có hàng nhưng số pallet ghi trên vị trí thấp hơn tồn thực tế (VD phiếu nhập cũ chỉ ghi kg, không ghi pallet):
// lấy số pallet theo tồn (quy đổi kg / bao theo quy cách mã hàng) để danh sách chọn vị trí, cảnh báo sức chứa không báo "trống" sai.
// stockRows: tồn của kho đang thao tác; itemMap: mã hàng → bản ghi
export function withStockOccupancy(locations, stockRows, itemMap) {
  const occ = new Map();
  for (const r of stockRows || []) {
    if (!r.location || (n(r.kg) <= EPS && n(r.bags) <= EPS && n(r.pallets) <= EPS)) continue;
    const o = occ.get(r.location) || { pallets: 0, kg: 0 };
    o.pallets = r3(o.pallets + estPallets(itemMap?.get(r.item), r));
    o.kg = r3(o.kg + Math.max(0, n(r.kg)));
    occ.set(r.location, o);
  }
  if (!occ.size) return locations;
  return locations.map((l) => {
    const o = occ.get(l.code);
    if (!o) return l;
    return { ...l, currentPallets: Math.max(n(l.currentPallets), o.pallets), stockKg: o.kg };
  });
}

// Vị trí có tính sức chứa (khai báo sức chứa, kho không tích "Không cần sức chứa")
export const hasCapacity = (loc) => !!loc && n(loc.capacity) > 0 && !noCapacity(loc.warehouse);
