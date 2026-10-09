// Thứ tự cột riêng của từng người dùng: lưu danh sách mã cột; cột mới (chưa có trong danh sách) xếp cuối theo thứ tự gốc
export function orderCols(cols, order) {
  if (!order?.length) return cols;
  const idx = new Map(order.map((k, i) => [k, i]));
  return cols.map((c, i) => ({ c, w: idx.has(c.key) ? idx.get(c.key) : 1000 + i })).sort((a, b) => a.w - b.w).map((x) => x.c);
}
// Đưa cột `from` tới vị trí của cột `to` (kéo thả)
export function moveCol(keys, from, to) {
  if (from === to) return keys;
  const out = keys.filter((k) => k !== from);
  const i = out.indexOf(to);
  const j = keys.indexOf(from) < keys.indexOf(to) ? i + 1 : i;
  out.splice(i < 0 ? out.length : j, 0, from);
  return out;
}
// Thuộc tính kéo thả cho ô tiêu đề <th>: kéo tiêu đề cột thả lên cột khác để đổi chỗ
export function dragHeadProps(key, keys, setOrder) {
  return {
    draggable: true,
    title: 'Kéo thả tiêu đề để đổi thứ tự cột',
    onDragStart: (e) => { e.dataTransfer.setData('text/col', key); e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e) => { if ([...e.dataTransfer.types].includes('text/col')) { e.preventDefault(); e.currentTarget.classList.add('col-drop'); } },
    onDragLeave: (e) => e.currentTarget.classList.remove('col-drop'),
    onDrop: (e) => {
      e.preventDefault(); e.currentTarget.classList.remove('col-drop');
      const from = e.dataTransfer.getData('text/col');
      if (from && from !== key) setOrder(moveCol(keys, from, key));
    },
  };
}
