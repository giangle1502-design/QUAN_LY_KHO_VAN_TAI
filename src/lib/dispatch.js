import { OPEN_STATUSES, leftKg, lineDue, lineShip, lineTo, lineWh } from './orders';
import { OPEN_PLAN } from './shipPlans';

// ============================================================================
// 4 loại đơn vị vận tải (danh mục Đơn vị vận tải → Loại):
//  • Nội bộ: nhóm xe nội bộ (VD nhóm xe Sơn, Hậu, Quân). Admin giao chuyến cho nhóm, tài xế của nhóm tự nhận chuyến.
//  • GHA: xe nhà GHA (có sẵn số xe, tài xế) + thuê 3PL. GHA chỉ định 3PL cho từng chuyến, 3PL nhập xe / tài xế,
//    xác nhận các bước, nhập cước 3PL ↔ GHA (lưu riêng, admin khách không thấy). Cước GHA ↔ VAP/PLA/DAM do GHA nhập.
//  • Thuê ngoài (dịch vụ vận tải: Quang Lộc, Quang Khải, Lê Phát…): tự nhập số xe, tài xế, chụp ảnh khi hoàn thành, nhập cước.
//  • Khách tự lấy: admin nhập số xe, tài xế; chuyến hoàn thành khi xe lấy hàng xong ra về (không có bước giao hàng).
// Danh mục Xe chỉ dùng cho xe nội bộ và xe nhà GHA; xe thuê ngoài gõ số xe tự do.
// ============================================================================
export const KIND = { internal: 'Nội bộ', gha: 'GHA', service: 'Thuê ngoài', self: 'Khách tự lấy' };
export const KIND_LABEL = {
  [KIND.internal]: 'Nhóm xe nội bộ (tài xế tự nhận chuyến)',
  [KIND.gha]: 'GHA (xe nhà GHA + thuê 3PL)',
  [KIND.service]: 'Dịch vụ vận tải (tự nhập xe, tài xế, cước)',
  [KIND.self]: 'Khách tự lấy hàng',
};
// GHA: loại GHA, hoặc tích 'Được dùng 3PL', hoặc mã GHA (danh mục cũ chưa chọn loại)
export const isGHA = (c) => !!c && (c.kind === KIND.gha || c.uses3PL === true || String(c.code || '').toUpperCase() === 'GHA');
export const isSelfPickup = (c) => !!c && c.kind === KIND.self;
export const isInternal = (c) => !!c && c.kind === KIND.internal;
// Xe trong danh mục Xe: chỉ xe nội bộ / xe nhà GHA
export const usesVehicleList = (c) => isInternal(c) || isGHA(c);
// Họ tên + CCCD tài xế chỉ khai cho xe nội bộ (nhóm xe) và xe nhà GHA; dịch vụ, 3PL, khách chỉ cần số xe
export const needsDriverId = (c, via3pl = false) => usesVehicleList(c) && !via3pl;
// Link tài xế của từng đơn vị vận tải (gửi nhóm Zalo; tài xế mở là dùng, không cần tài khoản)
export const driverLink = (code, token) => `${window.location.origin}/tx/${encodeURIComponent(code)}/${token}`;
export const newLinkToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
// Vận tải không hiểu ký hiệu kho: hiện tên kho đầy đủ (+ địa chỉ kho) thay cho mã
export const whOf = (code, whs = []) => whs.find((w) => w.code === code);
export const whText = (code, whs = []) => { const w = whOf(code, whs); return w?.name ? `${w.name} (${code})` : code || ''; };
// Nơi giao của 1 dòng chuyến: khách (tên + địa chỉ giao) hoặc kho nhận của STO (tên kho + địa chỉ kho)
export function placeOf(l, whs = []) {
  const ws = String(l.partyCode || '').split(',').map((x) => whOf(x.trim(), whs)).filter(Boolean);
  if (ws.length) return { sto: true, name: `Kho ${ws.map((w) => w.name || w.code).join(', ')}`, address: l.address || ws.map((w) => w.address).filter(Boolean).join('; ') };
  return { sto: false, name: `${l.partyCode ? `${l.partyCode} – ` : ''}${l.partyName || ''}`, short: l.partyName || l.partyCode, address: l.address || '' };
}
// Chỉ đường cho tài xế: ưu tiên định vị đã ghim (link Google Maps / tọa độ), không có thì theo địa chỉ
export function navUrl({ mapLink = '', address = '' } = {}) {
  const m = String(mapLink).trim();
  if (/^https?:\/\//i.test(m)) return m;
  const ll = m.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  const dest = ll ? `${ll[1]},${ll[2]}` : m || address;
  return dest ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}` : '';
}
// Chép thông tin điểm giao vào dòng chuyến (địa chỉ, người nhận, điện thoại, định vị) để tài xế mở link
// (không đăng nhập, không đọc được danh mục) vẫn thấy. Dòng STO: lấy địa chỉ kho nhận.
export function enrichLine(l, shipto = [], whs = []) {
  const s = l.shipCode ? shipto.find((x) => x.shipCode === l.shipCode) : null;
  const w = !s && l.partyCode ? whs.find((x) => x.code === String(l.partyCode).split(',')[0].trim()) : null;
  const src = s ? { address: s.address, contact: s.contact, contactPhone: s.phone, mapLink: s.mapLink }
    : w ? { address: w.address, contact: w.manager, contactPhone: w.phone, mapLink: w.mapLink } : {};
  const out = { ...l };
  for (const [k, v] of Object.entries(src)) if (v && !out[k]) out[k] = v;
  return out;
}
export const kindText = (c) => (isGHA(c) ? 'GHA' : isSelfPickup(c) ? 'Khách tự lấy' : isInternal(c) ? 'Nội bộ' : 'Dịch vụ');

const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);

// Phần đã giao vận tải (đã có chuyến, trừ chuyến hủy) theo nguồn
export function coverage(trips) {
  const byPlan = new Map(); const byAlloc = new Map(); const byMove = new Map(); const byLine = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const t of trips) {
    if (t.status === 'cancelled') continue;
    for (const l of t.lines || []) {
      const kg = n(l.plannedKg);
      if (l.planId) add(byPlan, `${l.planId}#${l.orderLine}#${l.shipCode || ''}`, kg);
      if (l.allocId) add(byAlloc, l.allocId, kg);
      if (l.movementId) add(byMove, `${l.movementId}#${l.orderLine}`, kg);
      // Phiếu xuất đã trừ số còn phải giao của đơn → không tính vào phần đã giao vận tải của dòng đơn
      else if (l.orderId) add(byLine, `${l.orderId}#${l.orderLine}`, kg);
    }
  }
  return { byPlan, byAlloc, byMove, byLine };
}

// Danh sách "Chờ giao vận tải": phần hàng đã chỉ định đơn vị vận tải (ở Dự kiến xuất, Kế hoạch phân bổ, SO / STO, phiếu xuất)
// nhưng chưa giao cho đơn vị đó. Mỗi dòng = 1 chuyến đề xuất; admin kiểm tra rồi bấm Giao vận tải.
export function pendingDispatch({ orders, plans, allocs, moves, trips, shipto = [] }) {
  const cov = coverage(trips);
  const oMap = new Map(orders.map((o) => [o.id, o]));
  const addr = (sc) => shipto.find((s) => s.shipCode === sc)?.address || '';
  const rows = [];
  const lineTaken = new Map(); // phần của dòng đơn đã nằm trong dòng Dự kiến xuất / Phân bổ đang chờ
  const take = (k, kg) => lineTaken.set(k, (lineTaken.get(k) || 0) + kg);

  // 1. Dự kiến xuất kho (theo mã giao, theo kho)
  for (const p of plans) {
    if (!OPEN_PLAN.includes(p.status)) continue;
    const o = oMap.get(p.orderId);
    if (!o || !OPEN_STATUSES.includes(o.status)) continue;
    const groups = new Map();
    for (const l of p.lines || []) {
      const ol = o.lines.find((x) => x.no === l.orderLine);
      const carrier = p.carrier || ol?.carrier || '';
      if (!carrier) continue;
      const kg = Math.max(0, n(l.qtyKg) - n(cov.byPlan.get(`${p.id}#${l.orderLine}#${l.shipCode || ''}`)));
      if (kg <= 0.5) continue;
      take(`${o.id}#${l.orderLine}`, kg);
      const wh = l.warehouse || (ol ? lineWh(o, ol, 'out') : '');
      const gk = `${l.shipCode || ''}|${wh}|${carrier}`;
      const g = groups.get(gk) || { key: `plan:${p.id}:${gk}`, src: 'plan', srcId: p.id, srcLabel: `📅 Dự kiến xuất ${p.id}`, orderId: o.id, orderType: o.type, company: o.company || '',
        date: p.date || '', warehouse: wh, partyCode: o.partyCode || '', partyName: o.partyName || '', shipCode: l.shipCode || '', address: l.shipAddress || addr(l.shipCode), carrier, items: [] };
      g.items.push({ orderId: o.id, no: l.orderLine, item: l.item, itemName: l.itemName || '', kg, planId: p.id, shipCode: l.shipCode || '', address: g.address, partyCode: g.partyCode, partyName: g.partyName });
      groups.set(gk, g);
    }
    rows.push(...groups.values());
  }

  // 2. Kế hoạch phân bổ đã gắn SO / STO (mỗi dòng phân bổ / cont = 1 chuyến)
  for (const a of allocs) {
    if (a.status === 'cancelled' || !a.orderId || !a.carrier) continue;
    const o = oMap.get(a.orderId);
    if (!o || !OPEN_STATUSES.includes(o.status)) continue;
    const kg = Math.max(0, n(a.qtyKg) - n(cov.byAlloc.get(a._id || a.id)));
    if (kg <= 0.5) continue;
    take(`${o.id}#${a.orderLine}`, kg);
    const ol = o.lines.find((x) => x.no === a.orderLine);
    const sto = o.type === 'STO';
    const party = sto ? { partyCode: a.toWarehouse || (ol ? lineTo(o, ol) : ''), partyName: `Kho ${a.toWarehouse || (ol ? lineTo(o, ol) : '')}` } : { partyCode: o.partyCode || '', partyName: o.partyName || '' };
    rows.push({ key: `alloc:${a._id || a.id}`, src: 'alloc', srcId: a._id || a.id, srcLabel: `📋 Phân bổ ${a.poId}${a.contNo ? ` · cont ${a.contNo}` : ''}`, orderId: o.id, orderType: o.type, company: o.company || '',
      date: a.date || '', warehouse: a.fromWarehouse || (ol ? lineWh(o, ol, 'out') : ''), ...party, shipCode: a.shipCode || '', address: addr(a.shipCode), carrier: a.carrier,
      items: [{ orderId: o.id, no: a.orderLine, item: a.item, itemName: a.itemName || '', kg, allocId: a._id || a.id, shipCode: a.shipCode || '', address: addr(a.shipCode), ...party }] });
  }

  // 3. Phiếu xuất đã ghi đơn vị vận tải nhưng chưa có chuyến
  for (const m of moves) {
    if (m.type !== 'out' || m.status === 'cancelled' || !m.carrier || m.tripId || !m.orderId) continue;
    const o = oMap.get(m.orderId);
    const items = [];
    for (const l of m.lines || []) {
      const kg = Math.max(0, n(l.kg) - n(cov.byMove.get(`${m.id}#${l.orderLine}`)));
      if (kg <= 0.5) continue;
      const it = items.find((x) => x.no === l.orderLine && x.item === l.item);
      if (it) it.kg += kg;
      else items.push({ orderId: m.orderId, no: l.orderLine, item: l.item, itemName: l.itemName || '', kg, movementId: m.id, shipCode: m.shipCode || '', address: addr(m.shipCode),
        partyCode: m.partyCode || o?.partyCode || '', partyName: m.partyName || o?.partyName || '' });
    }
    if (!items.length) continue;
    rows.push({ key: `px:${m.id}`, src: 'px', srcId: m.id, srcLabel: `📤 Phiếu xuất ${m.id}`, orderId: m.orderId, orderType: m.orderType || o?.type || '', company: m.company || o?.company || '',
      date: m.date || '', warehouse: m.warehouse, partyCode: items[0].partyCode, partyName: items[0].partyName, shipCode: m.shipCode || '', address: addr(m.shipCode), carrier: m.carrier, items });
  }

  // 4. Phần còn lại của dòng SO / STO đã chỉ định đơn vị vận tải
  for (const o of orders) {
    if (!['SO', 'STO'].includes(o.type) || !OPEN_STATUSES.includes(o.status)) continue;
    for (const l of o.lines || []) {
      if (!l.carrier) continue;
      const k = `${o.id}#${l.no}`;
      const rest = Math.min(n(l.qtyKg) - n(cov.byLine.get(k)), leftKg(l)) - n(lineTaken.get(k));
      if (rest <= 0.5) continue;
      const sto = o.type === 'STO';
      const ship = sto ? '' : lineShip(o, l);
      const party = sto ? { partyCode: lineTo(o, l), partyName: `Kho ${lineTo(o, l)}` } : { partyCode: o.partyCode || '', partyName: o.partyName || '' };
      rows.push({ key: `order:${k}`, src: 'order', srcId: o.id, srcLabel: `${sto ? '🔁 STO' : '🧾 SO'} ${o.id}`, orderId: o.id, orderType: o.type, company: o.company || '',
        date: lineDue(o, l) || '', warehouse: lineWh(o, l, 'out'), ...party, shipCode: ship, address: addr(ship), carrier: l.carrier,
        items: [{ orderId: o.id, no: l.no, item: l.item, itemName: l.itemName || '', kg: rest, shipCode: ship, address: addr(ship), ...party }] });
    }
  }
  return rows.map((r) => ({ ...r, kg: r.items.reduce((s, i) => s + i.kg, 0) }))
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || a.key.localeCompare(b.key));
}
export const SRC_LABEL = { plan: '📅 Dự kiến xuất', alloc: '📋 Kế hoạch phân bổ', px: '📤 Phiếu xuất', order: '🧾 SO / STO' };
