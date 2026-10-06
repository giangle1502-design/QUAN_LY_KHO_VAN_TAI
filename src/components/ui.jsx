import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return createPortal(
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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

export function Field({ label, required, help, children, full }) {
  return (
    <label className={'field' + (full ? ' full' : '')}>
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
