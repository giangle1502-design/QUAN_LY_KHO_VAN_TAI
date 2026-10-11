import { collection, doc, getDocs, query, runTransaction, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { postMovement } from './stock';
import { vnDate } from './trips';

// ============================================================================
// Kiểm kê / cycle count: `stockCounts/{KKyymmddNN}` (đầu phiếu) + `stockCounts/{id}/lines/{00001}`
// mỗi dòng = 1 dòng tồn (vị trí, mã, lot, TTHH, công ty) chụp số hệ thống lúc lập phiếu.
// Nhân viên đếm lần 1 (thực kiểm), lệch thì đếm lại (lần 2); số final = lần 2 nếu có, không thì lần 1.
// Dòng con lưu riêng để nhiều điện thoại cùng đếm không đè nhau.
// ============================================================================

export const COUNT_KINDS = { full: 'Kiểm kê', cycle: 'Cycle count' };
export const COUNT_STATUS = {
  preparing: { label: 'Đang lập', cls: 'gray' },
  open: { label: 'Đang đếm', cls: 'amber' },
  done: { label: 'Chờ duyệt điều chỉnh', cls: 'blue' },
  adjusted: { label: 'Đã duyệt, điều chỉnh tồn', cls: 'green' },
  closed: { label: 'Đã duyệt, không điều chỉnh', cls: 'gray' },
  cancelled: { label: 'Đã hủy', cls: 'red' },
};
export const MATCH_KG = 0.5; // lệch dưới 0,5 kg coi như khớp
const MAX_LINES = 5000;

const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
export const lineId = (no) => String(no).padStart(5, '0');

// So sánh vị trí kiểu tự nhiên (A2 < A10)
export const locCmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'vi', { numeric: true, sensitivity: 'base' });
export const inLocRange = (loc, from, to) => (!from || locCmp(loc, from) >= 0) && (!to || locCmp(loc, to) <= 0);
const splitList = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

export const bagsPerPallet = (it) => n(it?.bagsPerLayer) * n(it?.layersPerPallet);
// Quy cách để đổi pallet chẵn + bao lẻ ra kg (không có quy cách thì nhập kg)
export const specOf = (it) => ({ bpp: bagsPerPallet(it), bagWeight: n(it?.bagWeight) });

// Số đếm nhập trên điện thoại → { pallets, bags, totalBags, kg }
export function countValue({ pallets, bags, kg }, spec) {
  const p = n(pallets), b = n(bags);
  if (spec.bpp && spec.bagWeight) {
    const totalBags = p * spec.bpp + b;
    return { pallets: p, bags: b, totalBags, kg: r3(totalBags * spec.bagWeight) };
  }
  return { pallets: p, bags: b, totalBags: spec.bpp ? p * spec.bpp + b : b, kg: r3(n(kg)) };
}

// Số final và chênh lệch của 1 dòng
export function lineResult(l) {
  const fin = l.c2 || l.c1 || null;
  if (!fin) return { counted: false };
  const diffKg = r3(n(fin.kg) - n(l.sysKg));
  const diffBags = r3(n(fin.totalBags) - n(l.sysBags));
  return { counted: true, final: fin, diffKg, diffBags, match: Math.abs(diffKg) < MATCH_KG, recount: !!l.c2 };
}

// Chọn dòng tồn theo phạm vi: vị trí (từ - đến, khu vực = đầu mã vị trí) và mã hàng (danh sách / có giao dịch trong ngày)
export function pickStock(rows, scope, movedItems) {
  const areas = splitList(scope.areas);
  const items = splitList(scope.items);
  return rows.filter((r) => (n(r.bags) > 0 || n(r.pallets) > 0 || n(r.kg) > 0)
    && (!scope.company || r.company === scope.company)
    && inLocRange(r.location, scope.locFrom, scope.locTo)
    && (!areas.length || areas.some((a) => String(r.location).toUpperCase().startsWith(a)))
    && (!items.length || items.includes(String(r.item).toUpperCase()))
    && (!movedItems || movedItems.has(r.item)))
    .sort((a, b) => locCmp(a.location, b.location) || String(a.item).localeCompare(String(b.item)) || String(a.lot).localeCompare(String(b.lot)));
}

// Mã hàng có phiếu kho (đã ghi) trong ngày ở kho này
export async function itemsMovedOn(warehouse, date) {
  const snap = await getDocs(query(collection(db, 'movements'), where('date', '==', date)));
  const set = new Set();
  snap.docs.forEach((d) => {
    const m = d.data();
    if (m.warehouse !== warehouse || m.status === 'cancelled') return;
    (m.lines || []).forEach((l) => l.item && set.add(l.item));
  });
  return set;
}

export function scopeText(c) {
  const s = c.scope || {};
  const parts = [];
  if (s.locFrom || s.locTo) parts.push(`vị trí ${s.locFrom || '…'} → ${s.locTo || '…'}`);
  if (s.areas) parts.push(`khu vực ${s.areas}`);
  if (s.items) parts.push(`mã ${s.items}`);
  if (s.movedOn) parts.push(`mã có giao dịch ngày ${s.movedOn.split('-').reverse().join('/')}`);
  return parts.join(' · ') || 'toàn kho';
}

// Lập phiếu: cấp số KK + yymmdd + NN, chụp số tồn hệ thống thành các dòng
export async function createCount(data, stockRows, itemMap, user) {
  const moved = data.scope.movedOn ? await itemsMovedOn(data.warehouse, data.scope.movedOn) : null;
  const rows = pickStock(stockRows, { ...data.scope, company: data.company }, moved);
  if (!rows.length) throw new Error(moved && !moved.size ? `Không có mã hàng nào có giao dịch ngày ${data.scope.movedOn} ở kho ${data.warehouse}.` : 'Không có dòng tồn nào trong phạm vi đã chọn.');
  if (rows.length > MAX_LINES) throw new Error(`Phạm vi có ${rows.length} dòng tồn, quá ${MAX_LINES}. Chia nhỏ theo khu vực / vị trí.`);
  const ymd = vnDate().slice(2).replace(/-/g, '');
  const cRef = doc(db, 'counters', `KK-${ymd}`);
  const at = new Date().toISOString();
  const id = await runTransaction(db, async (tx) => {
    const c = await tx.get(cRef);
    const no = c.exists() ? n(c.data().next) || 1 : 1;
    const newId = `KK${ymd}${String(no).padStart(2, '0')}`;
    tx.set(cRef, { next: no + 1 });
    tx.set(doc(db, 'stockCounts', newId), {
      ...data, id: newId, status: 'preparing', nLines: rows.length, nextNo: rows.length + 1,
      createdAt: at, createdBy: user.email, createdByName: user.name,
      history: [{ at, by: user.email, byName: user.name, action: `Lập phiếu ${COUNT_KINDS[data.kind].toLowerCase()} (${rows.length} dòng)` }],
    });
    return newId;
  });
  for (let i = 0; i < rows.length; i += 400) {
    const b = writeBatch(db);
    rows.slice(i, i + 400).forEach((r, j) => {
      const no = i + j + 1;
      const it = itemMap.get(r.item);
      b.set(doc(db, 'stockCounts', id, 'lines', lineId(no)), {
        no, stockId: r._id, location: r.location, item: r.item, itemName: r.itemName || it?.name || '', lot: r.lot || '',
        goodsStatus: r.goodsStatus || '', pledgee: r.pledgee || '', company: r.company || '', inDate: r.inDate || '',
        mfgDate: r.mfgDate || '', expDate: r.expDate || '',
        sysBags: n(r.bags), sysPallets: n(r.pallets), sysKg: n(r.kg), ...specOf(it),
      });
    });
    await b.commit();
  }
  await updateDoc(doc(db, 'stockCounts', id), { status: 'open' });
  return id;
}

// Lưu số đếm lần 1 / lần 2 của 1 dòng
export function saveCount(countId, no, round, value, user) {
  return updateDoc(doc(db, 'stockCounts', countId, 'lines', lineId(no)), {
    [round === 2 ? 'c2' : 'c1']: value ? { ...value, at: new Date().toISOString(), by: user.email, byName: user.name } : null,
  });
}

// Hàng có thực tế nhưng không có trên hệ thống (số hệ thống = 0)
export async function addFoundLine(count, line, user) {
  const no = await runTransaction(db, async (tx) => {
    const ref = doc(db, 'stockCounts', count.id);
    const s = await tx.get(ref);
    if (!s.exists() || s.data().status !== 'open') throw new Error('Phiếu không còn mở để đếm.');
    const next = n(s.data().nextNo) || n(s.data().nLines) + 1;
    tx.update(ref, { nextNo: next + 1, nLines: n(s.data().nLines) + 1 });
    tx.set(doc(db, 'stockCounts', count.id, 'lines', lineId(next)), {
      no: next, stockId: '', extra: true, sysBags: 0, sysPallets: 0, sysKg: 0, inDate: count.date, mfgDate: '', expDate: '', pledgee: '', ...line,
      addedBy: user.email, addedAt: new Date().toISOString(),
    });
    return next;
  });
  return no;
}

export async function setCountStatus(count, status, user, action) {
  const at = new Date().toISOString();
  await updateDoc(doc(db, 'stockCounts', count.id), {
    status, updatedAt: at, updatedBy: user.email,
    history: [...(count.history || []), { at, by: user.email, byName: user.name, action }],
  });
}

export async function loadLines(id) {
  const snap = await getDocs(collection(db, 'stockCounts', id, 'lines'));
  return snap.docs.map((d) => d.data()).sort((a, b) => a.no - b.no);
}

// Điều chỉnh tồn theo số final: chênh lệch so với tồn HIỆN TẠI (hàng có thể đã nhập/xuất sau khi đếm)
export async function adjustPlan(count, lines) {
  const snap = await getDocs(query(collection(db, 'stock'), where('warehouse', '==', count.warehouse)));
  const cur = new Map(snap.docs.map((d) => [d.id, d.data()]));
  const out = [];
  for (const l of lines) {
    const r = lineResult(l);
    if (!r.counted) continue;
    const s = l.stockId ? cur.get(l.stockId) : null;
    const now = { bags: n(s?.bags), pallets: n(s?.pallets), kg: n(s?.kg) };
    const fin = r.final;
    const bags = l.bpp ? n(fin.totalBags) : n(fin.bags);
    const pallets = l.bpp ? r3(n(fin.totalBags) / l.bpp) : n(fin.pallets);
    const d = { bags: r3(bags - now.bags), pallets: r3(pallets - now.pallets), kg: r3(n(fin.kg) - now.kg) };
    if (Math.abs(d.kg) < MATCH_KG && Math.abs(d.bags) < 0.001) continue;
    const changed = Math.abs(now.kg - n(l.sysKg)) > 0.001;
    out.push({ l, d, now, changed });
  }
  return out;
}

export async function postAdjust(count, plan, reason, user) {
  const ids = [];
  for (let i = 0; i < plan.length; i += 150) {
    const part = plan.slice(i, i + 150);
    ids.push(await postMovement({
      type: 'adjust', warehouse: count.warehouse, company: count.company || '', date: vnDate(), tripId: '', orderId: '', partyCode: '', partyName: '', shipCode: '',
      reason, note: `Điều chỉnh theo ${COUNT_KINDS[count.kind].toLowerCase()} ${count.id}`, countId: count.id,
      lines: part.map(({ l, d }) => ({
        item: l.item, itemName: l.itemName, lot: l.lot, mfgDate: l.mfgDate || '', expDate: l.expDate || '', inDate: l.inDate || count.date,
        location: l.location, goodsStatus: l.goodsStatus, pledgee: l.pledgee || '', company: l.company || count.company || '',
        bags: d.bags, pallets: d.pallets, kg: d.kg,
      })),
    }, user));
  }
  const at = new Date().toISOString();
  await updateDoc(doc(db, 'stockCounts', count.id), {
    status: 'adjusted', adjustIds: ids, updatedAt: at, updatedBy: user.email,
    history: [...(count.history || []), { at, by: user.email, byName: user.name, action: ids.length ? `Duyệt, điều chỉnh tồn: ${ids.join(', ')}` : 'Duyệt: không có chênh lệch cần điều chỉnh' }],
  });
  return ids;
}
