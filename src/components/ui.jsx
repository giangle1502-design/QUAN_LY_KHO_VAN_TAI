import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

const UNSAVED = 'Có thay đổi chưa lưu. Vẫn đóng?';
const isDirty = (d) => (typeof d === 'function' ? d() : !!d);

// Theo dõi form đã sửa chưa: lấy mốc ở lần bấm / gõ đầu tiên trong form (sau khi form tự điền xong),
// sau đó so với giá trị hiện tại. Gắn {...bind} lên phần tử bọc form; reset() sau khi lưu.
export function useDirty(value) {
  const base = useRef(null);
  const cur = JSON.stringify(value);
  const curRef = useRef(cur);
  curRef.current = cur;
  const mark = () => { if (base.current === null) base.current = curRef.current; };
  return {
    dirty: base.current !== null && base.current !== cur,
    bind: { onPointerDownCapture: mark, onKeyDownCapture: mark },
    reset: () => { base.current = null; },
  };
}

// Nút ✕ Đóng cho màn hình lập phiếu / chi tiết (trang riêng, không phải hộp thoại):
// quay lại màn hình trước đó trong ứng dụng (danh sách / danh mục đang mở), nếu mở thẳng link thì về `to`.
// Phím Esc cũng đóng (khi không có hộp thoại hay danh sách chọn nào đang mở). Có thay đổi chưa lưu thì hỏi lại.
export function CloseButton({ to = '/', dirty, label = '✕ Đóng', className = 'btn', esc = true }) {
  const nav = useNavigate();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const close = useCallback(() => {
    if (isDirty(dirtyRef.current) && !window.confirm(UNSAVED)) return;
    if ((window.history.state?.idx ?? 0) > 0) nav(-1);
    else nav(to);
  }, [nav, to]);
  useEffect(() => {
    if (!esc) return undefined;
    const h = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat) return;
      if (document.querySelector('.modal-bg, .col-menu')) return;
      close();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [close, esc]);
  return <button type="button" className={className} onClick={close} title="Đóng, quay lại màn hình trước (Esc)">{label}</button>;
}

// dirty: form trong hộp thoại có thay đổi chưa lưu (true/false hoặc hàm) → hỏi lại trước khi đóng
export function Modal({ title, onClose, children, wide, dirty, cls }) {
  const ref = useRef();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const close = useCallback(() => {
    if (isDirty(dirtyRef.current) && !window.confirm(UNSAVED)) return;
    onClose();
  }, [onClose]);
  useEffect(() => {
    // Esc chỉ đóng hộp thoại trên cùng (vd. hộp "+ thêm khách hàng" mở trên form đơn hàng)
    const h = (e) => e.key === 'Escape' && !e.defaultPrevented && ref.current === [...document.querySelectorAll('.modal-bg')].pop() && close();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [close]);
  return createPortal(
    <div ref={ref} className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={'modal' + (wide ? ' wide' : '') + (cls ? ` ${cls}` : '')}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="btn modal-close" onClick={close} title="Đóng (Esc)">✕ Đóng</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

// size: cấu hình trường { width, height } (px) từ Quản lý trường
export function Field({ label, required, help, children, full, size }) {
  const w = Number(size?.width) || 0;
  const h = Number(size?.height) || 0;
  const wide = full || w >= 900;
  const style = {
    ...(!wide && w ? { gridColumn: `span ${Math.min(4, Math.max(1, Math.round(w / 240)))}` } : {}),
    ...(!wide && w && w < 230 ? { maxWidth: w + 40 } : {}),
    ...(h ? { '--fh': `${h}px` } : {}),
  };
  return (
    <label className={'field' + (wide ? ' full' : '') + (w && !wide ? ' fw' : '') + (h ? ' fh' : '')} style={style}>
      <span>{label}{required && <b className="req"> *</b>}{typeof help === 'string' && help && <i className="help-tip" title={help}> ⓘ</i>}</span>
      {children}
      {help && <small className="small field-help">{help}</small>}
    </label>
  );
}

export function Empty({ text = 'Chưa có dữ liệu' }) {
  return <div className="empty">{text}</div>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="error-box">{error}</div>;
}
