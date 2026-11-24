import { collection, doc, getDoc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { CATALOGS, catalogByKey } from '../catalogs';
import { docIdOf } from './fields';
import { locationId, stockId } from './stock';

// ============================================================================
// Đổi mã 1 bản ghi danh mục (VD Công ty VAPC → VAP) và cập nhật mọi dữ liệu đang dùng mã cũ:
//  - Bản ghi danh mục: tạo bản ghi mã mới (giữ mọi trường, ghi oldCodes) rồi xóa bản ghi mã cũ
//  - Trường tham chiếu ở các danh mục khác (VD Pháp nhân của Kho, Kho chung → thành viên)
//  - Tồn kho, phiếu kho, đơn SO/PO/STO, giải chấp, kế hoạch, chuyến xe, kiểm kê… (kể cả các dòng bên trong)
//  - Tồn kho / vị trí có mã nằm trong mã dòng (kho, vị trí, mã hàng, công ty…): chuyển sang mã dòng mới
// Chỉ quản trị gốc. Chạy lại được: lần trước dừng giữa chừng thì bấm đổi lại cùng mã mới để làm tiếp.
// ============================================================================

// Tên trường lưu mã của từng danh mục trong dữ liệu vận hành (ngoài các trường tham chiếu khai báo trong danh mục)
const EXTRA_KEYS = {
  companies: ['company', 'toCompany', 'fromCompany', 'labelCompany', 'lineCompany', 'companies'],
  warehouses: ['warehouse', 'fromWarehouse', 'toWarehouse', 'warehouses', 'fromWarehouses', 'toWarehouses', 'members'],
  warehouseGroups: ['warehouse'],
  items: ['item'],
  soldto: ['customerCode', 'customer', 'partyCode', 'toCustomer'],
  suppliers: ['partyCode', 'supplier', 'supplierCode'],
  shipto: ['shipCode', 'toShipCode', 'shipCodes'],
  carriers: ['carrier'],
  pledgees: ['pledgee', 'toPledgee'],
  goodsStatus: ['goodsStatus', 'toStatus'],
  vehicles: ['plate'],
  pickupPoints: ['fromPoint'],
};
// Danh mục không đổi mã bằng công cụ này
export const NO_RENAME = new Set(['users', 'locations', 'codeRules']);
export const canRenameCode = (cat) => !!cat && !NO_RENAME.has(cat.key) && !cat.idOf && !cat.keyFields;

// Dữ liệu vận hành (ngoài các danh mục) có thể chứa mã danh mục
const OPS = ['stock', 'movements', 'orders', 'shipPlans', 'allocations', 'releaseRequests', 'trips', 'tripPrivate', 'statements',
  'palletMoves', 'palletStock', 'stockCounts', 'printTemplates', 'prospects', 'activities', 'notices', 'threepl'];

function keysFor(catKey) {
  const ks = new Set(EXTRA_KEYS[catKey] || []);
  CATALOGS.forEach((c) => c.fields.forEach((f) => { if (f.ref === catKey || f.refAlso === catKey) ks.add(f.key); }));
  return ks;
}

// Thay mã cũ ở các trường thuộc danh sách (cả trong mảng dòng, đối tượng lồng nhau). Trả về [giá trị mới, có đổi không]
function swapDeep(v, keys, from, to, inKey = false) {
  if (Array.isArray(v)) {
    let ch = false;
    const out = v.map((x) => { const [y, c] = swapDeep(x, keys, from, to, inKey); ch ||= c; return y; });
    return [ch ? [...new Set(out)] : v, ch];
  }
  if (v && typeof v === 'object' && !(v.toDate instanceof Function)) {
    let ch = false;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const [y, c] = swapDeep(x, keys, from, to, keys.has(k)); out[k] = y; ch ||= c; }
    return [ch ? out : v, ch];
  }
  if (inKey && v === from) return [to, true];
  return [v, false];
}

// Ghi theo lô (Firestore tối đa 500 thao tác / lô)
async function commitAll(ops, onProgress, label) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((o) => (o.del ? b.delete(o.ref) : b.set(o.ref, o.data)));
    onProgress?.(`${label}: ${Math.min(i + 400, ops.length)}/${ops.length}`);
    await b.commit();
  }
}

export async function renameCode(cat, row, toRaw, { email }, { onProgress } = {}) {
  if (!canRenameCode(cat)) throw new Error(`Danh mục ${cat?.short || ''} không đổi mã bằng công cụ này.`);
  const from = row._id;
  const to = docIdOf(cat, { ...row, [cat.idField]: toRaw });
  if (!to) throw new Error('Mã mới không hợp lệ.');
  if (to === from) throw new Error('Mã mới trùng mã hiện tại.');
  const keys = keysFor(cat.key);
  const done = [];

  // 1. Bản ghi mã mới (giữ mọi trường). Đã có mã mới mà không phải do lần đổi trước thì dừng
  const newRef = doc(db, cat.key, to);
  const cur = await getDoc(newRef);
  if (cur.exists() && !(cur.data().oldCodes || []).includes(from)) throw new Error(`Mã ${to} đã có trong ${cat.short}.`);
  const { _id, ...data } = row;
  await writeBatch(db).set(newRef, {
    ...data, ...(cur.exists() ? cur.data() : {}), [cat.idField]: to, oldCodes: [...new Set([...(data.oldCodes || []), from])],
    updatedAt: serverTimestamp(), updatedBy: email,
  }).commit();

  // 2. Danh mục khác + dữ liệu vận hành: đọc hết, đổi trường chứa mã cũ
  const colls = [...new Set([...CATALOGS.map((c) => c.key), ...OPS])];
  for (const c of colls) {
    onProgress?.(`Đang đọc ${catalogByKey(c)?.short || c}…`);
    let snap;
    try { snap = await getDocs(collection(db, c)); } catch { continue; } // không có quyền đọc / chưa có dữ liệu
    const ops = [];
    for (const d of snap.docs) {
      if (c === cat.key && d.id === from) continue;
      const [nd, changed] = swapDeep(d.data(), keys, from, to);
      if (!changed) continue;
      // Mã dòng tồn kho / vị trí ghép từ kho, vị trí, mã hàng, công ty…: đổi mã dòng theo dữ liệu mới
      let id = d.id;
      if (c === 'stock') id = stockId(nd);
      if (c === 'locations') id = locationId(nd.warehouse, nd.code);
      if (id !== d.id) {
        const ex = await getDoc(doc(db, c, id));
        if (ex.exists()) throw new Error(`Không đổi được: ${c}/${id} đã có (trùng dòng sau khi đổi mã). Liên hệ để gộp tay.`);
        ops.push({ ref: doc(db, c, id), data: nd }, { ref: d.ref, del: true });
      } else ops.push({ ref: d.ref, data: nd });
    }
    if (!ops.length) continue;
    try {
      await commitAll(ops, onProgress, catalogByKey(c)?.short || c);
      done.push(`${catalogByKey(c)?.short || c} ${ops.filter((o) => !o.del).length}`);
    } catch (e) {
      done.push(`${catalogByKey(c)?.short || c} lỗi (${e.code || e.message})`);
    }
  }

  // 3. Đối tác cùng mã (khách hàng / NCC)
  if (['soldto', 'suppliers'].includes(cat.key)) {
    const p = await getDoc(doc(db, 'partners', from));
    if (p.exists() && !(await getDoc(doc(db, 'partners', to))).exists()) {
      await writeBatch(db).set(doc(db, 'partners', to), { ...p.data(), code: to, oldCodes: [...new Set([...(p.data().oldCodes || []), from])] })
        .delete(doc(db, 'partners', from)).commit();
      done.push('Đối tác 1');
    }
  }

  // 4. Xóa bản ghi mã cũ (chỉ khi mọi nơi đã chuyển xong)
  if (!done.some((x) => x.includes('lỗi'))) await writeBatch(db).delete(doc(db, cat.key, from)).commit();
  return { from, to, done };
}
