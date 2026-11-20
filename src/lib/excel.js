import * as XLSX from 'xlsx';

// sheets: { 'Tên sheet': [ {cột: giá trị}, ... ] }
export function exportSheets(fileName, sheets) {
  const wb = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name, rows]) => {
    const ws = XLSX.utils.json_to_sheet(rows);
    const cols = Object.keys(rows[0] || {});
    ws['!cols'] = cols.map((c) => ({
      wch: Math.min(50, Math.max(c.length, ...rows.slice(0, 200).map((r) => String(r[c] ?? '').length)) + 2),
    }));
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  });
  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

// File mẫu: dòng tiêu đề + ghi chú (comment) hướng dẫn trên từng ô tiêu đề
// notes: mảng song song với headers (kiểu dữ liệu, bắt buộc hay không, giá trị hợp lệ, ví dụ).
// Thêm sheet "Huong dan" liệt kê lại toàn bộ ghi chú (sheet nhập vẫn là sheet đầu tiên).
export function exportTemplate(fileName, headers, notes = []) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(14, String(h).length + 4) }));
  headers.forEach((h, i) => {
    if (!notes[i]) return;
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: i })];
    cell.c = [{ a: 'Hướng dẫn', t: `${h}:\n${notes[i]}` }];
    cell.c.hidden = true;
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Mau');
  if (notes.some(Boolean)) {
    const guide = XLSX.utils.aoa_to_sheet([
      ['Cột', 'Hướng dẫn nhập'],
      ...headers.map((h, i) => [h, notes[i] || '']),
      [],
      ['', 'Nhập dữ liệu ở sheet "Mau" (sheet đầu tiên), dòng 1 giữ nguyên tiêu đề, dữ liệu từ dòng 2. Rê chuột vào ô tiêu đề (góc có dấu đỏ) để xem ghi chú.'],
    ]);
    guide['!cols'] = [{ wch: Math.max(16, ...headers.map((h) => String(h).length + 2)) }, { wch: 110 }];
    XLSX.utils.book_append_sheet(wb, guide, 'Huong dan');
  }
  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  download(`${fileName}.xlsx`, notes.some(Boolean) ? widenNotes(data) : data);
}

// Khung ghi chú mặc định của thư viện chỉ 2 cột × 4 dòng (cắt chữ): nới rộng khung để đọc hết
function widenNotes(data) {
  try {
    const zip = XLSX.CFB.read(new Uint8Array(data), { type: 'array' });
    let changed = false;
    zip.FullPaths.forEach((path, i) => {
      if (!/vmlDrawing\d*\.vml$/i.test(path)) return;
      const entry = zip.FileIndex[i];
      const xml = new TextDecoder().decode(entry.content);
      const out = xml
        .replace(/width:104pt;height:64pt/g, 'width:300pt;height:150pt')
        .replace(/<x:Anchor>(\d+),0,(\d+),0,\d+,20,\d+,20<\/x:Anchor>/g,
          (m, c, r) => `<x:Anchor>${c},0,${r},0,${+c + 4},20,${+r + 10},20</x:Anchor>`);
      if (out !== xml) { entry.content = new TextEncoder().encode(out); entry.size = entry.content.length; changed = true; }
    });
    return changed ? XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' }) : data;
  } catch {
    return data;
  }
}

function download(name, data) {
  const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Đọc sheet đầu tiên: dòng 1 là tiêu đề → mảng object theo tiêu đề
export async function readFirstSheet(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

// Ô Excel → YYYY-MM-DD
export function toYmd(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v)) return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return '';
}

// Ô Excel → số. Quy ước chính 1,234.5 ("," hàng nghìn, "." thập phân); vẫn đọc được 1.234,5
export function toNumber(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.replace(/[^\d.,-]/g, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
