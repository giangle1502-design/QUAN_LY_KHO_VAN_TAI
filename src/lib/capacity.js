// Sức chứa vị trí khi nhập hàng: cảnh báo dòng nhập vượt số pallet còn trống của vị trí
// và chia 1 dòng thành nhiều dòng, mỗi dòng không quá sức chứa vị trí để nhân viên chọn vị trí
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
const EPS = 1e-6;

export const OVER_CAP_MSG = 'Số lượng nhập vượt quá giới hạn vị trí';
export const OVER_CAP_CONFIRM = 'Xác nhận nhập vượt giới hạn';

// Mỗi dòng → { location, capacity, free (còn trống cho dòng này, đã trừ các dòng phía trên cùng vị trí), need, over }
export function capacityCheck(lines, locations) {
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
