import { collection, doc, getDoc, getDocs, query, runTransaction, updateDoc, where } from 'firebase/firestore';
import { db } from '../firebase';
import { postMovement, stockId } from './stock';
import { fmtNum, norm, today } from './utils';

// ============================================================================
// Đề nghị giải chấp (releaseRequests): lập tay ở Kho → Đề nghị giải chấp, hoặc tự lập khi
// phiếu xuất bán lấy hàng HTC. Lưu là đổi ngay HTC → DGC (cảng: KTC) bằng phiếu TC;
// đề nghị chỉ còn để in PDF, ký số, gửi ngân hàng.
// ============================================================================

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;

export async function createRelease(data, user) {
  const ymd = data.date.replace(/-/g, '').slice(2);
  const ruleSnap = await getDoc(doc(db, 'codeRules', 'HSGC')).catch(() => null);
  const prefix = ruleSnap?.exists() ? ruleSnap.data().prefix ?? 'HSGC' : 'HSGC';
  const digits = num(ruleSnap?.exists() && ruleSnap.data().digits) || 2;
  const cRef = doc(db, 'counters', `HSGC-${ymd}`);
  return runTransaction(db, async (tx) => {
    const c = await tx.get(cRef);
    const n = c.exists() ? num(c.data().next) || 1 : 1;
    const id = `${prefix}${ymd}${String(n).padStart(digits, '0')}`;
    const at = new Date().toISOString();
    tx.set(cRef, { next: n + 1 });
    tx.set(doc(db, 'releaseRequests', id), {
      ...data, id, status: 'sent', createdAt: at, createdBy: user.email, createdByName: user.name,
      history: [{ at, by: user.email, byName: user.name, action: data.auto ? `Tự lập khi xuất hàng HTC${data.orderIds?.length ? ` (đơn ${data.orderIds.join(', ')})` : ''}` : 'Lập đề nghị' }],
    });
    return id;
  });
}

// Tình trạng sau giải chấp theo danh mục kho (TTHH khi giải chấp); bỏ trống: cảng → KTC, kho khác → DGC
export const releaseStatusOfWh = (w) => (['KTC', 'DGC'].includes(w?.releaseStatus) ? w.releaseStatus
  : /\b(cang|port)\b/.test(norm(`${w?.name || ''} ${w?.code || ''}`)) ? 'KTC' : 'DGC');
export async function releaseStatusOf(whCode) {
  const w = await getDoc(doc(db, 'warehouses', whCode)).then((x) => (x.exists() ? x.data() : null)).catch(() => null);
  return releaseStatusOfWh(w);
}

// Gộp dòng đề nghị theo mã hàng (+ số CT, vị trí hàng hóa) để in / gửi ngân hàng
export const groupKey = (l) => [l.item, l.docNo || '', l.place || ''].join('|');
export function groupLines(lines) {
  const m = new Map();
  for (const l of lines || []) {
    const k = groupKey(l);
    if (!m.has(k)) m.set(k, { ...l, key: k, kg: 0, orders: [] });
    const g = m.get(k);
    g.kg += num(l.kg);
    if (l.orderId && !g.orders.includes(l.orderId)) g.orders.push(l.orderId);
  }
  return [...m.values()];
}

// Phiếu TC cho các dòng tồn: giải chấp HTC → to, hoặc (back) trả lại DGC/KTC → HTC khi giảm số lượng đề nghị
// lines: { stockId, kg, bags?, pallets? }; kiểm tra tồn hiện tại đủ trước khi ghi
async function postStatus(r, lines, to, user, { back = false } = {}) {
  const out = [];
  for (const [i, l] of lines.entries()) {
    const s = await getDoc(doc(db, 'stock', l.stockId));
    const x = s.exists() ? s.data() : null;
    const need = back ? to : 'HTC';
    if (!x || x.goodsStatus !== need || num(x.kg) < num(l.kg) - 0.001) {
      throw new Error(back
        ? `${l.item} lot ${l.lot || '-'} (${l.location}): tồn ${to} chỉ còn ${fmtNum(x?.kg || 0)} kg, không trả lại HTC được ${fmtNum(l.kg)} kg (hàng đã xuất).`
        : `Dòng ${i + 1} (${l.item} lot ${l.lot || '-'}, ${l.location}): tồn HTC hiện chỉ còn ${fmtNum(x?.kg || 0)} kg, không đủ ${fmtNum(l.kg)} kg. Hàng đã bị xuất/chuyển sau khi lập đề nghị; hủy đề nghị và lập lại.`);
    }
    const k = num(x.kg) ? Math.min(1, num(l.kg) / num(x.kg)) : 1;
    out.push({
      item: x.item, itemName: x.itemName || '', lot: x.lot || '', mfgDate: x.mfgDate || '', expDate: x.expDate || '', inDate: x.inDate || '',
      location: x.location, goodsStatus: x.goodsStatus, pledgee: x.pledgee || '', company: x.company || '',
      bags: l.bags != null && l.bags !== '' ? num(l.bags) : k === 1 ? num(x.bags) : Math.round(num(x.bags) * k),
      pallets: l.pallets != null && l.pallets !== '' ? num(l.pallets) : k === 1 ? num(x.pallets) : r3(num(x.pallets) * k), kg: num(l.kg),
      toStatus: back ? 'HTC' : to, toPledgee: back ? r.pledgee : '',
    });
  }
  return postMovement({
    type: 'status', warehouse: r.warehouse, company: r.company, date: today(), tripId: '', orderId: '', orderRef: '',
    partyCode: r.pledgee, partyName: r.pledgeeName || r.pledgee, shipCode: '', reason: '',
    note: back ? `Giảm số lượng đề nghị giải chấp ${r.id}: trả lại HTC` : `Giải chấp theo đề nghị ${r.id}`, releaseId: r.id, lines: out,
  }, user);
}

// Đổi HTC → DGC (cảng: KTC) cho đúng các dòng tồn trong đề nghị (phiếu TC), đánh dấu đề nghị đã giải chấp
export async function postRelease(r, { email, name }) {
  const to = await releaseStatusOf(r.warehouse);
  const mid = await postStatus(r, r.lines, to, { email, name });
  const at = new Date().toISOString();
  await updateDoc(doc(db, 'releaseRequests', r.id), {
    status: 'released', movementId: mid, movementIds: [mid], releasedAt: at, releasedBy: email, toStatus: to,
    history: [...(r.history || []), { at, by: email, byName: name, action: `Đổi HTC → ${to}, phiếu ${mid}` }],
  });
  return { mid, to };
}

// Phiếu xuất bán lấy hàng HTC: tự đưa vào đề nghị giải chấp và đổi ngay sang DGC (cảng: KTC).
// Gộp vào đề nghị tự lập trong ngày của cùng công ty + ngân hàng + kho chưa đánh dấu "Đã gửi ngân hàng",
// để bản in tổng hợp theo mã hàng mọi đơn trong ngày. picks: { stock (dòng tồn HTC), kg, bags, pallets }
// Trả về { to, ids: [số đề nghị] }
export async function autoReleaseForSlip({ warehouse, whName, company: co0, date, order, picks }, user) {
  const to = await releaseStatusOf(warehouse);
  // Mỗi đề nghị: 1 công ty (bên thế chấp) + 1 ngân hàng
  const byBank = new Map();
  for (const p of picks) {
    const k = `${p.stock.company || co0 || ''}|${p.stock.pledgee || ''}`;
    if (!byBank.has(k)) byBank.set(k, []);
    byBank.get(k).push(p);
  }
  const existing = (await getDocs(query(collection(db, 'releaseRequests'), where('warehouse', '==', warehouse)))).docs.map((d) => d.data());
  const ids = [];
  for (const [key, ps] of byBank) {
    const [company, pledgee] = key.split('|');
    const lines = ps.map((p) => ({
      stockId: p.stock._id, item: p.stock.item, itemName: p.stock.itemName || '', lot: p.stock.lot || '', location: p.stock.location,
      docNo: '', place: whName || warehouse, unit: 'TẤN', kg: r3(num(p.kg)), bags: num(p.bags), pallets: num(p.pallets),
      orderId: order?.id || '', partyName: order?.partyName || '',
    }));
    const open = existing.find((r) => r.auto && r.status === 'released' && !r.bankSentAt && r.date === date
      && (r.company || '') === (company || '') && r.pledgee === pledgee);
    if (open) {
      const mid = await postStatus(open, lines, to, user);
      const at = new Date().toISOString();
      const fresh = (await getDoc(doc(db, 'releaseRequests', open.id))).data();
      // Lot đã có trong đề nghị thì cộng thêm kg, không thêm dòng mới
      const merged = [...(fresh.lines || [])];
      for (const l of lines) {
        const same = merged.findIndex((x) => x.stockId === l.stockId && (x.orderId || '') === l.orderId && !x.docNo);
        if (same >= 0) merged[same] = { ...merged[same], kg: r3(num(merged[same].kg) + l.kg), bags: num(merged[same].bags) + l.bags, pallets: r3(num(merged[same].pallets) + l.pallets) };
        else merged.push(l);
      }
      await updateDoc(doc(db, 'releaseRequests', open.id), {
        lines: merged, orderIds: [...new Set([...(fresh.orderIds || []), ...(order?.id ? [order.id] : [])])],
        movementIds: [...(fresh.movementIds || [fresh.movementId].filter(Boolean)), mid],
        history: [...(fresh.history || []), { at, by: user.email, byName: user.name, action: `Thêm ${fmtNum(lines.reduce((a, l) => a + l.kg, 0), 2)} kg khi xuất hàng HTC${order?.id ? ` (đơn ${order.id})` : ''}, phiếu ${mid}` }],
      });
      ids.push(open.id);
      continue;
    }
    const [pl, co] = await Promise.all([
      pledgee ? getDoc(doc(db, 'pledgees', pledgee)).then((x) => (x.exists() ? x.data() : null)).catch(() => null) : null,
      company ? getDoc(doc(db, 'companies', company)).then((x) => (x.exists() ? x.data() : null)).catch(() => null) : null,
    ]);
    const data = { date, company: company || '', companyName: co?.name || company || '', pledgee, pledgeeName: pl?.name || pledgee,
      warehouse, bct: '', note: 'Tự lập khi lập phiếu xuất hàng HTC', auto: true, orderIds: order?.id ? [order.id] : [], lines };
    const id = await createRelease(data, user);
    await postRelease({ ...data, id, history: [{ at: new Date().toISOString(), by: user.email, byName: user.name, action: 'Tự lập khi xuất hàng HTC' }] }, user);
    ids.push(id);
  }
  return { to, ids };
}

// Sửa đề nghị đã giải chấp: theo từng dòng gộp (mã hàng + số CT + vị trí) đổi số CT, vị trí, số lượng.
// Tăng kg: lấy thêm hàng HTC cùng mã, công ty, ngân hàng, kho (nhập trước trước) và đổi DGC ngay.
// Giảm kg: chỉ phần không gắn phiếu xuất của đơn, trả lại HTC nếu hàng còn trong kho.
// edits: { [groupKey]: { kg, docNo, place } }
export async function editRelease(r, edits, user) {
  if (r.status !== 'released') throw new Error('Chỉ sửa được đề nghị đã đổi DGC. Bấm ✅ Đổi DGC trước.');
  const to = r.toStatus || await releaseStatusOf(r.warehouse);
  let lines = (r.lines || []).map((l) => ({ ...l }));
  const mids = [];
  const notes = [];
  const add = [];
  const back = [];
  for (const g of groupLines(lines)) {
    const e = edits[g.key];
    if (!e) continue;
    const mine = lines.filter((l) => groupKey(l) === g.key);
    const delta = r3(num(e.kg) - g.kg);
    if (delta > 0.001) {
      // HTC còn trống của mã này (trừ phần đang nằm trong đề nghị chưa đổi DGC)
      const snap = await getDocs(query(collection(db, 'stock'), where('warehouse', '==', r.warehouse)));
      const held = new Map();
      (await getDocs(query(collection(db, 'releaseRequests'), where('status', '==', 'sent')))).docs
        .forEach((d) => (d.data().lines || []).forEach((l) => held.set(l.stockId, (held.get(l.stockId) || 0) + num(l.kg))));
      const free = snap.docs.map((d) => ({ _id: d.id, ...d.data() }))
        .filter((x) => x.item === g.item && x.goodsStatus === 'HTC' && x.pledgee === r.pledgee && (x.company || '') === (r.company || ''))
        .map((x) => ({ ...x, free: r3(num(x.kg) - (held.get(x._id) || 0) - add.filter((a) => a.stockId === x._id).reduce((s, a) => s + a.kg, 0)) }))
        .filter((x) => x.free > 0.001)
        .sort((a, b) => String(a.inDate).localeCompare(String(b.inDate)) || String(a.location).localeCompare(String(b.location)));
      let need = delta;
      for (const x of free) {
        if (need <= 0.001) break;
        const kg = r3(Math.min(need, x.free));
        add.push({ stockId: x._id, item: x.item, itemName: x.itemName || '', lot: x.lot || '', location: x.location,
          docNo: e.docNo ?? g.docNo ?? '', place: e.place ?? g.place ?? '', unit: 'TẤN', kg, orderId: '', partyName: '', extra: true });
        need = r3(need - kg);
      }
      if (need > 0.001) throw new Error(`${g.item}: kho ${r.warehouse} chỉ còn ${fmtNum(delta - need, 2)} kg HTC của ${r.company} tại ${r.pledgee} để giải chấp thêm (cần thêm ${fmtNum(delta, 2)} kg).`);
      notes.push(`${g.item} +${fmtNum(delta, 2)} kg`);
    } else if (delta < -0.001) {
      let cut = -delta;
      const free = mine.filter((l) => !l.orderId).reduce((s, l) => s + num(l.kg), 0);
      if (cut > free + 0.001) throw new Error(`${g.item}: chỉ giảm được ${fmtNum(free, 2)} kg; phần còn lại đã gắn với phiếu xuất của đơn ${g.orders.join(', ')}.`);
      for (const l of [...mine].reverse()) {
        if (cut <= 0.001) break;
        if (l.orderId) continue;
        const kg = r3(Math.min(cut, num(l.kg)));
        // Hàng đã đổi DGC nằm ở dòng tồn cùng kho, vị trí, mã, lot, công ty với tình trạng mới
        back.push({ ...l, kg, stockId: stockId({ warehouse: r.warehouse, location: l.location, item: l.item, lot: l.lot, goodsStatus: to, company: r.company }), _line: l });
        l.kg = r3(num(l.kg) - kg);
        cut = r3(cut - kg);
      }
      notes.push(`${g.item} −${fmtNum(-delta, 2)} kg`);
    }
    for (const l of mine) {
      if (e.docNo != null) l.docNo = String(e.docNo).trim();
      if (e.place != null) l.place = String(e.place).trim();
    }
  }
  if (back.length) mids.push(await postStatus(r, back.map(({ _line, ...l }) => ({ ...l, bags: null, pallets: null })), to, user, { back: true }));
  if (add.length) mids.push(await postStatus(r, add, to, user));
  lines = [...lines.filter((l) => num(l.kg) > 0.0005), ...add];
  const at = new Date().toISOString();
  await updateDoc(doc(db, 'releaseRequests', r.id), {
    lines, movementIds: [...(r.movementIds || [r.movementId].filter(Boolean)), ...mids], updatedAt: at, updatedBy: user.email,
    history: [...(r.history || []), { at, by: user.email, byName: user.name, action: `Sửa đề nghị${notes.length ? `: ${notes.join(', ')}` : ' (số CT, vị trí)'}${mids.length ? `, phiếu ${mids.join(', ')}` : ''}` }],
  });
  return { mids, notes };
}
