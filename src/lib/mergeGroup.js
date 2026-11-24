import { collection, doc, getDocs, query, where, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { mergeLocRecords } from '../pages/stock/WarehouseGroups';

// ============================================================================
// Lưu Kho chung → tự gộp vị trí và cửa xuất/nhập đang khai báo riêng ở các kho thành viên về Kho chung
// (VD Cát Lái khai ở DAMC → CANG__Cát Lái, VAPC / PLAC / DAMC cùng thấy).
// Trùng mã: sức chứa lấy số lớn nhất, số pallet đang chứa cộng lại. Quản trị gốc: xóa bản ghi riêng cũ;
// quản trị khác: giữ bản cũ (không có quyền xóa), app tự ưu tiên vị trí của Kho chung.
// ============================================================================
const n = (v) => Number(v) || 0;
const idOf = (wh, code) => `${String(wh).trim().replace(/\//g, '_')}__${String(code).trim().replace(/\//g, '_')}`;

async function rowsOf(coll, whs) {
  const out = [];
  for (let i = 0; i < whs.length; i += 30) {
    const s = await getDocs(query(collection(db, coll), where('warehouse', 'in', whs.slice(i, i + 30))));
    s.docs.forEach((d) => out.push({ _id: d.id, ...d.data() }));
  }
  return out;
}

export async function mergeIntoGroup(group, { email, canDelete }) {
  const code = group.code || group._id;
  const members = (group.members || []).filter((m) => m && m !== code);
  if (!code || !members.length) return { locs: 0, docks: 0 };
  const at = new Date().toISOString();
  const ops = [];
  const noCap = !!group.noCapacity;

  const all = await rowsOf('locations', [code, ...members]);
  const byCode = new Map();
  for (const l of all.filter((x) => members.includes(x.warehouse))) byCode.set(l.code, [...(byCode.get(l.code) || []), l]);
  for (const [c, recs] of byCode) {
    const exist = all.find((x) => x.warehouse === code && x.code === c);
    const m = mergeLocRecords(exist ? [exist, ...recs] : recs, 'max');
    const pallets = Math.round([...(exist ? [exist] : []), ...recs].reduce((s, r) => s + n(r.currentPallets), 0) * 1000) / 1000;
    const cap = noCap ? null : m.capacity;
    ops.push({ ref: doc(db, 'locations', idOf(code, c)), data: { warehouse: code, code: c, ...m, currentPallets: pallets,
      usedPct: n(cap) ? Math.round((pallets / n(cap)) * 1000) / 10 : null, emptyBin: pallets < 1e-6,
      mergedFrom: [...new Set(recs.map((r) => r.warehouse))], updatedAt: at, updatedBy: email } });
    if (canDelete) recs.forEach((r) => ops.push({ ref: doc(db, 'locations', r._id), del: true }));
  }

  const docks = await rowsOf('docks', [code, ...members]);
  const dockBy = new Map();
  for (const d of docks.filter((x) => members.includes(x.warehouse))) dockBy.set(d.code, [...(dockBy.get(d.code) || []), d]);
  for (const [c, recs] of dockBy) {
    ops.push({ ref: doc(db, 'docks', idOf(code, c)), data: { warehouse: code, code: c, name: recs[0].name || '', usage: recs[0].usage || 'Nhập và xuất',
      active: recs.some((r) => r.active !== false), mergedFrom: recs.map((r) => r.warehouse), updatedAt: at, updatedBy: email } });
    if (canDelete) recs.forEach((r) => ops.push({ ref: doc(db, 'docks', r._id), del: true }));
  }

  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((o) => (o.del ? b.delete(o.ref) : b.set(o.ref, o.data, { merge: true })));
    await b.commit();
  }
  return { locs: byCode.size, docks: dockBy.size };
}
