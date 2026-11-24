import { useMemo } from 'react';
import { collection, doc, getDoc, setDoc } from 'firebase/firestore';
import { db as mainDb } from '../firebase';
import { useShared } from './live';

// ============================================================================
// Số xe → tài xế: mọi đơn vị vận tải tự khai trước danh sách xe (danh mục Xe: số xe, loại, tải trọng, tài xế thường chạy, CCCD);
// xe 3PL / xe thuê thỉnh thoảng mới chạy thì gõ số xe khi cần. Mỗi lần nhập số xe + tài xế (Shipment, đăng ký xe, link tài xế)
// đều ghi lịch sử plateHistory/{đơn vị}__{số xe}: lần sau gõ số xe là tự hiện tài xế, CCCD; tài xế đổi xe thì chọn lại / thêm mới.
// ============================================================================
export const plateKey = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const histId = (carrier, plate) => `${String(carrier || '-').replace(/\//g, '_')}__${plateKey(plate)}`;
const clean = (v) => String(v || '').trim();

// Ghi lịch sử (không chặn bước chính nếu lỗi quyền)
export async function savePlateHistory({ carrier, plate, vehicleType = '', payload = '', driverName = '', idCard = '', driverPhone = '' }, database = mainDb) {
  if (!plateKey(plate) || !carrier) return;
  try {
    const ref = doc(database, 'plateHistory', histId(carrier, plate));
    const cur = await getDoc(ref).then((s) => (s.exists() ? s.data() : null)).catch(() => null);
    const at = new Date().toISOString();
    const d = { name: clean(driverName), idCard: clean(idCard), phone: clean(driverPhone) };
    const same = (x) => (d.idCard && x.idCard === d.idCard) || (!d.idCard && d.name && x.name.toLowerCase() === d.name.toLowerCase());
    const old = (cur?.drivers || []).filter((x) => !same(x));
    const drivers = d.name || d.idCard ? [{ ...((cur?.drivers || []).find(same) || {}), ...Object.fromEntries(Object.entries(d).filter(([, v]) => v)), lastAt: at }, ...old].slice(0, 12) : cur?.drivers || [];
    await setDoc(ref, { carrier, plate: String(plate).trim().toUpperCase(), plateKey: plateKey(plate), vehicleType: vehicleType || cur?.vehicleType || '',
      payload: payload || cur?.payload || '', drivers, lastAt: at, trips: (cur?.trips || 0) + 1 });
  } catch { /* lịch sử chỉ để gợi ý */ }
}

export function usePlateHistory(enabled = true) {
  const st = useShared(enabled ? 'c|plateHistory' : '', () => collection(mainDb, 'plateHistory'));
  return useMemo(() => (st.snap ? st.snap.docs.map((d) => ({ _id: d.id, ...d.data() })) : []), [st.snap]);
}

// Gợi ý cho 1 đơn vị vận tải: xe đã khai (danh mục) trước, rồi xe trong lịch sử
export function plateOptions(carrier, vehicles = [], hist = []) {
  const m = new Map();
  for (const v of vehicles) if (!carrier || v.carrier === carrier) {
    const k = plateKey(v.plate);
    m.set(k, { plate: v.plate, vehicleType: v.vehicleType || '', payload: v.payload || '', listed: true,
      drivers: v.driverName || v.idCard ? [{ name: v.driverName || '', idCard: v.idCard || '', phone: v.driverPhone || '' }] : [] });
  }
  for (const h of hist) if (!carrier || h.carrier === carrier) {
    const k = h.plateKey || plateKey(h.plate);
    const cur = m.get(k);
    if (cur) {
      // Tài xế chạy gần nhất lên đầu, tài xế khai trong danh mục đứng sau
      cur.drivers = [...new Map([...(h.drivers || []), ...cur.drivers].map((d) => [d.idCard || d.name, d])).values()];
      if (!cur.payload) cur.payload = h.payload || '';
    } else m.set(k, { plate: h.plate, vehicleType: h.vehicleType || '', payload: h.payload || '', listed: false, drivers: h.drivers || [] });
  }
  return [...m.values()];
}
export const findPlate = (opts, plate) => opts.find((o) => plateKey(o.plate) === plateKey(plate));
