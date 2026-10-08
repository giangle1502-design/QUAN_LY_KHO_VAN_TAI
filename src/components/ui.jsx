import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function Modal({ title, onClose, children, wide }) {
  const ref = useRef();
  useEffect(() => {
    // Esc chỉ đóng hộp thoại trên cùng (vd. hộp "+ thêm khách hàng" mở trên form đơn hàng)
    const h = (e) => e.key === 'Escape' && ref.current === [...document.querySelectorAll('.modal-bg')].pop() && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
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
      <span>{label}{required && <b className="req"> *</b>}</span>
      {children}
      {help && <small className="small">{help}</small>}
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
