// Cước vận chuyển: tìm dòng bảng giá khớp phiếu xuất và tính cước (theo tấn hoặc theo chuyến)
const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
const split = (s) => String(s || '').split(/[,;\s]+/).filter(Boolean);

// Điều kiện để trống = mọi giá trị; điều kiện có ghi mà không khớp thì bỏ dòng giá đó.
// Dòng khớp nhiều điều kiện cụ thể hơn thì được ưu tiên; bằng nhau thì lấy dòng có hiệu lực mới hơn.
export function matchRate(rates, m, vehType = '') {
  const d = m.date || '';
  const dest = split(m.partyCode);
  let best = null; let bestScore = -1;
  for (const r of rates) {
    if (r.active === false || !num(r.price)) continue;
    if (r.fromDate && d < r.fromDate) continue;
    if (r.toDate && d > r.toDate) continue;
    const conds = [
      [r.toShipCode, (v) => v === m.shipCode, 32],
      [r.carrier, (v) => v === m.carrier, 16],
      [r.toCustomer, (v) => v === m.partyCode, 8],
      [r.toWarehouse, (v) => dest.includes(v), 8],
      [r.vehicleType, (v) => v === vehType, 4],
      [r.fromWarehouse, (v) => v === m.warehouse, 2],
    ];
    let score = 0; let ok = true;
    for (const [want, test, w] of conds) {
      if (!want) continue;
      if (!test(want)) { ok = false; break; }
      score += w;
    }
    if (!ok) continue;
    if (score > bestScore || (score === bestScore && String(r.fromDate || '') > String(best.fromDate || ''))) { best = r; bestScore = score; }
  }
  return best;
}

export function calcFreight(rate, kg) {
  if (!rate) return null;
  const perTrip = rate.basis === 'Theo chuyến';
  let amount = perTrip ? num(rate.price) : Math.round(num(rate.price) * num(kg) / 1000);
  if (!perTrip && num(rate.minAmount) > amount) amount = num(rate.minAmount);
  return { amount, rate: rate.code, basis: rate.basis || 'Theo tấn', price: num(rate.price) };
}
