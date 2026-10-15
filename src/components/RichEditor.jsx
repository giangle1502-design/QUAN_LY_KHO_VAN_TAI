// Ô soạn thảo nội dung mẫu in (như Word thu nhỏ): chữ đậm/nghiêng, cỡ chữ, màu, căn lề, bảng, hình/logo, chèn trường dữ liệu
import { useEffect, useRef, useState } from 'react';
import Select from './Select';

const SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 36, 48];

// Thu nhỏ ảnh trước khi nhúng vào mẫu (mẫu lưu trong 1 bản ghi, tối đa ~1 MB)
function shrinkImage(file, maxW = 700) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onerror = () => reject(new Error('Không đọc được ảnh.'));
    rd.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('File không phải ảnh.'));
      img.onload = () => {
        const k = Math.min(1, maxW / img.width);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const png = c.toDataURL('image/png');
        resolve(png.length < 120000 ? png : c.toDataURL('image/jpeg', 0.85));
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
}

export default function RichEditor({ value, onChange, fieldGroups = [], extraTokens = [], height = 420 }) {
  const ref = useRef(null);
  const range = useRef(null);
  const fileRef = useRef(null);
  const [source, setSource] = useState(false);
  const [cell, setCell] = useState(null); // ô bảng đang đứng
  const [img, setImg] = useState(null); // ảnh đang chọn

  useEffect(() => {
    const el = ref.current;
    if (el && !source && el.innerHTML !== value && document.activeElement !== el) el.innerHTML = value || '';
  }, [value, source]);

  useEffect(() => {
    const onSel = () => {
      const s = window.getSelection();
      if (!s.rangeCount || !ref.current?.contains(s.anchorNode)) return;
      range.current = s.getRangeAt(0).cloneRange();
      const n = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
      setCell(n?.closest('td, th') && ref.current.contains(n.closest('td, th')) ? n.closest('td, th') : null);
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const emit = () => ref.current && onChange(ref.current.innerHTML);
  const restore = () => {
    const el = ref.current;
    el.focus();
    if (range.current) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range.current); }
  };
  const cmd = (name, arg = null) => {
    restore();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(name, false, arg);
    emit();
  };
  const insertHtml = (html) => { restore(); document.execCommand('insertHTML', false, html); emit(); };
  const insertText = (t) => { restore(); document.execCommand('insertText', false, t); emit(); };

  const fontSize = (px) => {
    if (!px) return;
    restore();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7');
    ref.current.querySelectorAll('font[size="7"]').forEach((f) => {
      const sp = document.createElement('span');
      sp.style.fontSize = `${px}px`;
      sp.innerHTML = f.innerHTML;
      f.replaceWith(sp);
    });
    emit();
  };

  const addTable = (grid) => {
    const r = Number(window.prompt('Số dòng?', '2')) || 0;
    const c = Number(window.prompt('Số cột?', '2')) || 0;
    if (r < 1 || c < 1) return;
    const row = `<tr>${'<td>&nbsp;</td>'.repeat(c)}</tr>`;
    insertHtml(`<table class="${grid ? 'tpl-grid' : ''}" style="width:100%"><tbody>${row.repeat(r)}</tbody></table><p><br></p>`);
  };
  const tableOp = (op) => {
    const td = cell;
    if (!td) return;
    const tr = td.parentElement;
    const table = td.closest('table');
    const idx = [...tr.children].indexOf(td);
    if (op === 'row+') { const n = tr.cloneNode(true); n.querySelectorAll('td, th').forEach((x) => { x.innerHTML = '&nbsp;'; }); tr.after(n); }
    if (op === 'row-') { if (table.rows.length > 1) tr.remove(); else table.remove(); }
    if (op === 'col+') [...table.rows].forEach((r) => { const x = r.children[idx]; if (x) { const n = x.cloneNode(false); n.innerHTML = '&nbsp;'; x.after(n); } });
    if (op === 'col-') [...table.rows].forEach((r) => r.children[idx]?.remove());
    if (op === 'grid') table.classList.toggle('tpl-grid');
    if (op === 'del') table.remove();
    if (op === 'width') {
      const w = window.prompt('Độ rộng cột này (vd. 30% hoặc 40mm; để trống = tự động)', td.style.width || '');
      if (w === null) return;
      [...table.rows].forEach((r) => { if (r.children[idx]) r.children[idx].style.width = w; });
    }
    if (op === 'bg') {
      const c = window.prompt('Màu nền ô (vd. #f2f2f2; để trống = bỏ màu)', td.style.backgroundColor || '');
      if (c === null) return;
      td.style.backgroundColor = c;
    }
    setCell(null);
    emit();
  };
  const addImage = async (file) => {
    if (!file) return;
    try {
      const src = await shrinkImage(file);
      insertHtml(`<img src="${src}" style="height:60px" alt="">`);
    } catch (e) { window.alert(e.message); }
  };
  const sizeImage = () => {
    if (!img) return;
    const h = window.prompt('Chiều cao ảnh (vd. 60px, 25mm). Để trống = theo độ rộng', img.style.height || '');
    if (h === null) return;
    img.style.height = h; if (h) img.style.width = '';
    const w = h ? '' : window.prompt('Chiều rộng ảnh (vd. 120px, 40%)', img.style.width || '');
    if (w) img.style.width = w;
    emit();
  };

  const B = ({ c, a, t, children, on }) => <button type="button" className={'btn sm' + (on ? ' primary' : '')} title={t} onMouseDown={(e) => e.preventDefault()} onClick={() => (typeof c === 'function' ? c() : cmd(c, a))}>{children}</button>;

  return (
    <div className="rte">
      <div className="rte-bar">
        <B c="bold" t="Đậm (Ctrl+B)"><b>B</b></B>
        <B c="italic" t="Nghiêng (Ctrl+I)"><i>I</i></B>
        <B c="underline" t="Gạch chân (Ctrl+U)"><u>U</u></B>
        <Select title="Cỡ chữ" value="" onMouseDown={() => restore()} onChange={(e) => fontSize(e.target.value)}>
          <option value="">Cỡ chữ</option>
          {SIZES.map((s) => <option key={s} value={s}>{s}px</option>)}
        </Select>
        <Select title="Kiểu đoạn" value="" onChange={(e) => e.target.value && cmd('formatBlock', e.target.value)}>
          <option value="">Đoạn</option>
          <option value="p">Chữ thường</option>
          <option value="h1">Tiêu đề lớn</option>
          <option value="h2">Tiêu đề vừa</option>
          <option value="h3">Tiêu đề nhỏ</option>
        </Select>
        <label className="btn sm" title="Màu chữ">A<input type="color" style={{ width: 22, height: 18, padding: 0, border: 0 }} onChange={(e) => cmd('foreColor', e.target.value)} /></label>
        <B c="justifyLeft" t="Căn trái">⇤</B>
        <B c="justifyCenter" t="Căn giữa">≡</B>
        <B c="justifyRight" t="Căn phải">⇥</B>
        <B c="insertUnorderedList" t="Danh sách">•</B>
        <B c="insertHorizontalRule" t="Đường kẻ ngang">―</B>
        <B c={() => addTable(true)} t="Chèn bảng có kẻ ô">⊞ Bảng</B>
        <B c={() => addTable(false)} t="Chèn bảng không kẻ (để chia cột bố cục, vd. logo bên trái, số phiếu bên phải)">▭ Bảng bố cục</B>
        <B c={() => fileRef.current?.click()} t="Chèn hình / logo">🖼 Hình</B>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { addImage(e.target.files[0]); e.target.value = ''; }} />
        <B c="removeFormat" t="Xóa định dạng">⌫ Định dạng</B>
        <B c="undo" t="Hoàn tác (Ctrl+Z)">↶</B>
        <B c="redo" t="Làm lại (Ctrl+Y)">↷</B>
        <B c={() => { if (source) { setSource(false); } else { emit(); setSource(true); } }} on={source} t="Sửa trực tiếp mã HTML">&lt;/&gt; HTML</B>
      </div>
      <div className="rte-bar">
        <Select value="" onMouseDown={() => restore()} onChange={(e) => e.target.value && insertText(`{{${e.target.value}}}`)} style={{ maxWidth: 320 }}>
          <option value="">➕ Chèn trường dữ liệu…</option>
          {fieldGroups.map(([g, list]) => (
            <optgroup key={g} label={g}>{list.map((f) => <option key={f.label} value={f.label}>{f.label}</option>)}</optgroup>
          ))}
        </Select>
        {extraTokens.map(([t, label, help]) => <B key={t} c={() => insertText(t)} t={help}>{label}</B>)}
        {cell && (
          <span className="rte-cell">
            Ô bảng: <B c={() => tableOp('row+')}>+ dòng</B><B c={() => tableOp('col+')}>+ cột</B><B c={() => tableOp('row-')}>− dòng</B><B c={() => tableOp('col-')}>− cột</B>
            <B c={() => tableOp('width')}>Rộng cột</B><B c={() => tableOp('bg')}>Màu nền</B><B c={() => tableOp('grid')}>Kẻ / bỏ kẻ</B><B c={() => tableOp('del')}>Xóa bảng</B>
          </span>
        )}
        {img && ref.current?.contains(img) && <span className="rte-cell">Ảnh: <B c={sizeImage}>Đổi cỡ</B><B c={() => { img.remove(); setImg(null); emit(); }}>Xóa ảnh</B></span>}
      </div>
      {source ? (
        <textarea className="rte-src" style={{ height }} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      ) : (
        <div ref={ref} className="rte-area" style={{ minHeight: height }} contentEditable suppressContentEditableWarning
          onInput={emit} onBlur={emit} onClick={(e) => setImg(e.target.tagName === 'IMG' ? e.target : null)} />
      )}
    </div>
  );
}
