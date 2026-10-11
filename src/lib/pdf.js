// Xuất trang in ra file PDF (A4 dọc) bằng cách chụp trang: giữ đúng font tiếng Việt, mẫu in tự thiết kế.
// Dùng cho đề nghị giải chấp: lưu PDF rồi mở bằng trình xem PDF của trình duyệt để ký số, gửi ngân hàng.
export async function pageToPdf(el, title = '') {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  pdf.setProperties({ title });
  const sheets = el.querySelectorAll('.tpl-sheet').length ? [...el.querySelectorAll('.tpl-sheet')] : [el];
  let first = true;
  for (const sh of sheets) {
    const c = await html2canvas(sh, { scale: 2, backgroundColor: '#ffffff', useCORS: true,
      ignoreElements: (n) => n.classList?.contains('no-print') });
    const img = c.toDataURL('image/jpeg', 0.92);
    const w = 210;
    const h = (c.height * w) / c.width;
    // Trang dài hơn A4 thì cắt thành nhiều trang
    for (let y = 0; y < h - 0.5; y += 297) {
      if (!first) pdf.addPage();
      first = false;
      pdf.addImage(img, 'JPEG', 0, -y, w, h);
    }
  }
  return pdf.output('blob');
}

// Tải file PDF về máy (tên file) và trả về link để mở bằng trình xem PDF của trình duyệt
export function savePdf(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  return url;
}
