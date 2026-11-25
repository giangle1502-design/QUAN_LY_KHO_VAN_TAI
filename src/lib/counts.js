import { arrayUnion, collection, doc, getDocs, query, runTransaction, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { postMovement } from './stock';
import { vnDate } from './trips';
import { notifyUsers } from './chat';
import { whLabel } from './whGroups';

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

// Các kho của phiếu (phiếu mới chọn nhiều kho pháp nhân ở Đức Hòa; phiếu cũ chỉ 1 kho)
export const countWhs = (c) => (c?.warehouses?.length ? c.warehouses : [c?.warehouse].filter(Boolean));
export const lineWh = (l, c) => l.warehouse || c?.warehouse || '';
const listOf = (v) => (Array.isArray(v) ? v.map((x) => String(x).toUpperCase()) : splitList(v));

// Chọn dòng tồn theo phạm vi: vị trí (từ - đến, khu vực = đầu mã vị trí) và mã hàng (danh sách chọn / có giao dịch)
export function pickStock(rows, scope, movedItems) {
  const areas = splitList(scope.areas);
  const items = listOf(scope.items);
  const whs = scope.warehouses?.length ? new Set(scope.warehouses) : null;
  return rows.filter((r) => (n(r.bags) > 0 || n(r.pallets) > 0 || n(r.kg) > 0)
    && (!whs || whs.has(r.warehouse))
    && (!scope.company || r.company === scope.company)
    && inLocRange(r.location, scope.locFrom, scope.locTo)
    && (!areas.length || areas.some((a) => String(r.location).toUpperCase().startsWith(a)))
    && (!items.length || items.includes(String(r.item).toUpperCase()))
    && (!movedItems || movedItems.has(r.item)))
    .sort((a, b) => locCmp(a.location, b.location) || String(a.item).localeCompare(String(b.item)) || String(a.lot).localeCompare(String(b.lot)));
}

// Mã hàng có phiếu kho (nhập / xuất / chuyển, chưa hủy) từ ngày → đến ngày ở các kho này
export async function itemsMoved(warehouses, from, to) {
  const whs = new Set(warehouses);
  const snap = await getDocs(query(collection(db, 'movements'), where('date', '>=', from), where('date', '<=', to || from)));
  const set = new Set();
  snap.docs.forEach((d) => {
    const m = d.data();
    if (m.status === 'cancelled') return;
    const mine = whs.has(m.warehouse) || whs.has(m.toWarehouse) || whs.has(m.fromWarehouse);
    (m.lines || []).forEach((l) => l.item && (mine || whs.has(l.warehouse) || whs.has(l.toWarehouse)) && set.add(l.item));
  });
  return set;
}
export const itemsMovedOn = (warehouse, date) => itemsMoved([warehouse], date, date);

const dmy = (x) => String(x || '').split('-').reverse().join('/');
export function scopeText(c) {
  const s = c.scope || {};
  const parts = [];
  if (s.recountOf) parts.push(`đếm lại dòng lệch của ${[].concat(s.recountOf).join(', ')}`);
  if (s.locFrom || s.locTo) parts.push(`vị trí ${s.locFrom || '…'} → ${s.locTo || '…'}`);
  if (s.areas) parts.push(`khu vực ${s.areas}`);
  if (Array.isArray(s.items) ? s.items.length : s.items) {
    const it = [].concat(s.items);
    parts.push(Array.isArray(s.items) ? `${it.length} mã chọn: ${it.slice(0, 6).join(', ')}${it.length > 6 ? '…' : ''}` : `mã ${s.items}`);
  }
  if (s.movedFrom) parts.push(s.movedTo && s.movedTo !== s.movedFrom ? `mã có giao dịch ${dmy(s.movedFrom)} → ${dmy(s.movedTo)}` : `mã có giao dịch ngày ${dmy(s.movedFrom)}`);
  else if (s.movedOn) parts.push(`mã có giao dịch ngày ${dmy(s.movedOn)}`);
  return parts.join(' · ') || 'toàn bộ tồn';
}
export const whsText = (c) => countWhs(c).map(whLabel).join(', ');
export const assigneeText = (c) => (c.assignees || []).map((a) => a.name || a.email).join(', ');
export const isAssigned = (c, email) => (c.assigneeEmails || []).includes(String(email || '').toLowerCase());

// Ghi đầu phiếu + các dòng (dùng chung cho lập phiếu và lệnh đếm lại)
async function writeCount(data, lines, user, action) {
  const ymd = vnDate().slice(2).replace(/-/g, '');
  const cRef = doc(db, 'counters', `KK-${ymd}`);
  const at = new Date().toISOString();
  const assignees = (data.assignees || []).map((a) => ({ email: String(a.email).toLowerCase(), name: a.name || '' }));
  const id = await runTransaction(db, async (tx) => {
    const c = await tx.get(cRef);
    const no = c.exists() ? n(c.data().next) || 1 : 1;
    const newId = `KK${ymd}${String(no).padStart(2, '0')}`;
    tx.set(cRef, { next: no + 1 });
    tx.set(doc(db, 'stockCounts', newId), {
      ...data, assignees, assigneeEmails: assignees.map((a) => a.email),
      id: newId, status: 'preparing', nLines: lines.length, nextNo: lines.length + 1,
      createdAt: at, createdBy: user.email, createdByName: user.name,
      history: [{ at, by: user.email, byName: user.name, action: `${action} (${lines.length} dòng)${assignees.length ? `, giao ${assignees.map((a) => a.name || a.email).join(', ')}` : ''}` }],
    });
    return newId;
  });
  for (let i = 0; i < lines.length; i += 400) {
    const b = writeBatch(db);
    lines.slice(i, i + 400).forEach((l, j) => {
      const no = i + j + 1;
      b.set(doc(db, 'stockCounts', id, 'lines', lineId(no)), { ...l, no });
    });
    await b.commit();
  }
  await updateDoc(doc(db, 'stockCounts', id), { status: 'open' });
  if (assignees.length) {
    notifyUsers(assignees.map((a) => a.email),
      `🧮 ${user.name || user.email} giao cho bạn ${COUNT_KINDS[data.kind].toLowerCase()} ${id} · ${countWhs(data).join(', ')} · ${lines.length} dòng. Mở app: Kho → Kiểm kê & cycle count → 📱 Đếm.`,
      { event: 'count_assign', ref: id, link: `/kho/kiem-ke/${id}/dem` }, user);
  }
  return id;
}

const snapLine = (r, it) => ({
  stockId: r._id, warehouse: r.warehouse || '', location: r.location, item: r.item, itemName: r.itemName || it?.name || '', lot: r.lot || '',
  goodsStatus: r.goodsStatus || '', pledgee: r.pledgee || '', company: r.company || '', inDate: r.inDate || '',
  mfgDate: r.mfgDate || '', expDate: r.expDate || '',
  sysBags: n(r.bags), sysPallets: n(r.pallets), sysKg: n(r.kg), ...specOf(it),
});

// Lập phiếu: cấp số KK + yymmdd + NN, chụp số tồn hệ thống của các kho đã chọn thành các dòng
export async function createCount(data, stockRows, itemMap, user) {
  const whs = countWhs(data);
  const s = data.scope || {};
  const moved = s.movedFrom ? await itemsMoved(whs, s.movedFrom, s.movedTo) : null;
  const rows = pickStock(stockRows, { ...s, warehouses: whs, company: data.company }, moved);
  if (!rows.length) throw new Error(moved && !moved.size ? `Không có mã hàng nào có giao dịch từ ${dmy(s.movedFrom)} đến ${dmy(s.movedTo || s.movedFrom)} ở kho đã chọn.` : 'Không có dòng tồn nào trong phạm vi đã chọn.');
  if (rows.length > MAX_LINES) throw new Error(`Phạm vi có ${rows.length} dòng tồn, quá ${MAX_LINES}. Chia nhỏ theo khu vực / vị trí.`);
  return writeCount({ ...data, warehouse: whs[0], warehouses: whs }, rows.map((r) => snapLine(r, itemMap.get(r.item))), user, `Lập phiếu ${COUNT_KINDS[data.kind].toLowerCase()}`);
}

// Lệnh đếm lại: các dòng lệch (của 1 hay nhiều phiếu) → phiếu cycle count mới, số hệ thống chụp lại theo tồn HIỆN TẠI
// srcLines: [{ ...dòng, warehouse, countId }]
export async function createRecount(srcLines, opts, user) {
  if (!srcLines.length) throw new Error('Chưa chọn dòng lệch nào để đếm lại.');
  const whs = [...new Set(srcLines.map((l) => l.warehouse).filter(Boolean))].sort();
  const cur = new Map();
  for (const wh of whs) {
    const snap = await getDocs(query(collection(db, 'stock'), where('warehouse', '==', wh)));
    snap.docs.forEach((d) => cur.set(d.id, { _id: d.id, ...d.data() }));
  }
  const lines = [...srcLines].sort((a, b) => locCmp(a.location, b.location) || String(a.item).localeCompare(String(b.item))).map((l) => {
    const s = l.stockId ? cur.get(l.stockId) : null;
    const prev = (l.c2 || l.c1)?.kg;
    return {
      stockId: s ? l.stockId : '', extra: !s, warehouse: l.warehouse, location: l.location, item: l.item, itemName: l.itemName || '', lot: l.lot || '',
      goodsStatus: l.goodsStatus || '', pledgee: l.pledgee || '', company: l.company || '', inDate: l.inDate || '', mfgDate: l.mfgDate || '', expDate: l.expDate || '',
      sysBags: n(s?.bags), sysPallets: n(s?.pallets), sysKg: n(s?.kg), bpp: n(l.bpp), bagWeight: n(l.bagWeight),
      prev: { countId: l.countId || '', no: l.no || 0, kg: prev == null ? null : n(prev), sysKg: n(l.sysKg) },
    };
  });
  const from = [...new Set(srcLines.map((l) => l.countId).filter(Boolean))];
  const companies = [...new Set(srcLines.map((l) => l.companyOfCount ?? '').filter((x) => x !== ''))];
  const id = await writeCount({
    kind: 'cycle', company: companies.length === 1 ? companies[0] : '', warehouse: whs[0], warehouses: whs, date: opts.date || vnDate(),
    scope: { recountOf: from }, blind: !!opts.blind, note: opts.note || '', assignees: opts.assignees || [],
  }, lines, user, `Lệnh đếm lại dòng lệch của ${from.join(', ')}`);
  const at = new Date().toISOString();
  for (const c of from) {
    // Ghi ngược vào phiếu gốc (bỏ qua nếu không có quyền, vd. phiếu đã duyệt)
    await updateDoc(doc(db, 'stockCounts', c), { recountIds: arrayUnion(id), updatedAt: at, updatedBy: user.email }).catch(() => {});
  }
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
  const cur = new Map();
  for (const wh of countWhs(count)) {
    const snap = await getDocs(query(collection(db, 'stock'), where('warehouse', '==', wh)));
    snap.docs.forEach((d) => cur.set(d.id, d.data()));
  }
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
  const byWh = new Map();
  for (const x of plan) { const w = lineWh(x.l, count); if (!byWh.has(w)) byWh.set(w, []); byWh.get(w).push(x); }
  for (const [wh, all] of byWh) for (let i = 0; i < all.length; i += 150) {
    const part = all.slice(i, i + 150);
    ids.push(await postMovement({
      type: 'adjust', warehouse: wh, company: count.company || '', date: vnDate(), tripId: '', orderId: '', partyCode: '', partyName: '', shipCode: '',
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
