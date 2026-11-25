import { useRef, useState } from 'react';
import { collection, doc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { exportTemplate, readFirstSheet, toNumber } from '../lib/excel';
import { norm, today } from '../lib/utils';

// ============================================================================
// Báo giá trên danh mục Mã hàng:
//  • 💲 File mẫu báo giá: Mã hàng, Tên hàng, Giá hiện tại, Giá mới, chỉ các mã đang có tồn kho
//  • ⬆ Nhập báo giá: đọc cột Giá mới → ghi Giá hiện tại của mã hàng (giữ Giá trước, ngày, người cập nhật)
// ============================================================================

const HEADS = ['Mã hàng', 'Tên hàng', 'Giá hiện tại', 'Giá mới'];
const NOTES = [
  'Kiểu: Chữ.\nBẮT BUỘC (dùng để nhận diện mã hàng). Không sửa cột này.\nVí dụ: PP-1102K',
  'Kiểu: Chữ.\nChỉ để xem, nhập lại không đổi tên hàng.',
  'Kiểu: Số.\nGiá bán đang lưu trên mã hàng, chỉ để xem (nhập lại không đọc cột này). Trống = chưa có giá.',
  'Kiểu: Số.\nKhông bắt buộc. Ghi giá mới cần cập nhật. Để trống = giữ giá hiện tại.\nDấu phẩy ngăn hàng nghìn, dấu chấm thập phân.\nVí dụ: 32,500.000',
];
const n = (v) => Number(v) || 0;

export function PriceQuoteButtons({ items, onMsg }) {
  const { email } = useApp();
  const fileRef = useRef();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      // Tồn kho mọi kho, cộng theo mã hàng (đọc 1 lần khi bấm, không giữ kết nối)
      const kg = new Map();
      (await getDocs(collection(db, 'stock'))).docs.forEach((d) => {
        const s = d.data();
        if (n(s.kg) > 0.001 || n(s.bags) > 0 || n(s.pallets) > 0) kg.set(s.item, (kg.get(s.item) || 0) + Math.max(n(s.kg), 0.001));
      });
      const byCode = new Map(items.map((it) => [it.code || it._id, it]));
      const codes = [...kg.keys()].filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), 'vi', { numeric: true }));
      if (!codes.length) return onMsg('', 'Không có mã hàng nào đang có tồn kho.');
      const rows = codes.map((c) => {
        const it = byCode.get(c);
        const p = it?.price;
        return [c, it?.name || '', p === '' || p == null ? '' : n(p), ''];
      });
      exportTemplate(`Mau_bao_gia_${today()}`, HEADS, NOTES, rows, [2, 3]);
      onMsg(`Đã tải file mẫu báo giá: ${rows.length} mã hàng đang có tồn kho. Ghi cột Giá mới rồi bấm ⬆ Nhập báo giá.`);
    } catch (e) {
      onMsg('', e.message);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file) => {
    setBusy(true);
    try {
      const sheet = await readFirstSheet(file);
      const header = (sheet[0] || []).map(norm);
      const ci = header.indexOf(norm('Mã hàng'));
      const pi = header.indexOf(norm('Giá mới'));
      if (ci < 0 || pi < 0) throw new Error('File thiếu cột Mã hàng hoặc Giá mới. Hãy dùng File mẫu báo giá.');
      const byCode = new Map(items.map((it) => [String(it.code || it._id), it]));
      const notes = [];
      const updates = new Map();
      let same = 0;
      sheet.slice(1).forEach((cells, idx) => {
        const line = idx + 2;
        const code = String(cells[ci] ?? '').trim();
        const raw = cells[pi];
        if (!code || String(raw ?? '').trim() === '') return;
        const price = toNumber(raw);
        const it = byCode.get(code);
        if (!it) return notes.push(`Dòng ${line}: mã hàng ${code} không có trong danh mục`);
        if (price == null || price < 0) return notes.push(`Dòng ${line}: Giá mới "${String(raw).trim()}" không phải số hợp lệ`);
        if (it.price !== '' && it.price != null && Math.abs(n(it.price) - price) < 1e-9) { same += 1; return; }
        updates.set(code, { price, priceOld: it.price === '' || it.price == null ? null : n(it.price) });
      });
      if (!updates.size) {
        onMsg(same ? `Không có giá nào thay đổi (${same} mã giữ nguyên giá).` : '', notes.length ? notes.join('\n') : same ? '' : 'Cột Giá mới đang trống: chưa có giá nào để cập nhật.');
        return;
      }
      if (!window.confirm(`Cập nhật giá mới cho ${updates.size} mã hàng?`)) return;
      const list = [...updates.entries()];
      const date = today();
      for (let i = 0; i < list.length; i += 400) {
        const batch = writeBatch(db);
        list.slice(i, i + 400).forEach(([code, u]) => {
          batch.set(doc(db, 'items', code), { ...u, priceDate: date, priceBy: email, updatedAt: serverTimestamp(), updatedBy: email }, { merge: true });
        });
        await batch.commit();
      }
      onMsg(`Đã cập nhật giá mới cho ${updates.size} mã hàng${same ? `, ${same} mã giữ nguyên giá` : ''}.`, notes.slice(0, 15).join('\n') + (notes.length > 15 ? `\n… và ${notes.length - 15} dòng khác` : ''));
    } catch (e) {
      onMsg('', e.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <button className="btn ghost" disabled={busy} onClick={download} title="Tải Excel: Mã hàng, Tên hàng, Giá hiện tại, Giá mới, chỉ các mã đang có tồn kho. Ghi cột Giá mới rồi Nhập báo giá">💲 File mẫu báo giá</button>
      <button className="btn" disabled={busy} onClick={() => fileRef.current.click()} title="Nhập file báo giá đã ghi cột Giá mới: cập nhật Giá hiện tại của mã hàng (giữ Giá trước)">⬆ Nhập báo giá</button>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
    </>
  );
}
