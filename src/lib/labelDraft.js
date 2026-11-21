// In nhãn pallet TRƯỚC khi thủ kho xác nhận nhận hàng.
// Màn Nhận hàng lưu số liệu đang nhập (chưa ghi tồn) vào trình duyệt, mở trang in nhãn ở tab mới;
// trang in ghi lại "đã in" kèm chữ ký số liệu. Nút xác nhận chỉ mở khi nhãn đã in đúng số liệu hiện tại.
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const DRAFT = (id) => `labelDraft:${id}`;
const PRINTED = (id) => `labelPrinted:${id}`;

// Chữ ký số liệu ảnh hưởng tới nhãn: đổi mã, lot, vị trí, số lượng… sau khi in thì phải in lại
export function labelSig(lines) {
  return JSON.stringify((lines || [])
    .filter((l) => num(l.kg) || num(l.bags) || num(l.pallets))
    .map((l) => [l._mv || '', l.item || '', String(l.lot || '').trim(), l.location || '', num(l.kg), num(l.bags), num(l.pallets),
      l.goodsStatus || '', l.goodsStatus === 'HTC' ? l.pledgee || '' : '', l.mfgDate || '', l.expDate || '', l.company || '']));
}

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

export function saveLabelDraft(id, movement) {
  return write(DRAFT(id), { movement, sig: labelSig(movement.lines), at: new Date().toISOString() });
}
export const readLabelDraft = (id) => read(DRAFT(id));

export function markLabelsPrinted(id, sig, by) {
  write(PRINTED(id), { sig, at: new Date().toISOString(), by: by || '' });
}
export const readLabelsPrinted = (id) => read(PRINTED(id));

export function clearLabelState(ids) {
  for (const id of ids) { try { localStorage.removeItem(DRAFT(id)); localStorage.removeItem(PRINTED(id)); } catch { /* bỏ qua */ } }
}
export const PRINTED_KEY = PRINTED;
