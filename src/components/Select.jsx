import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { norm } from '../lib/utils';

// Ô chọn dùng thay <select> ở mọi nơi: danh sách ngắn giữ nguyên ô chọn của trình duyệt,
// danh sách dài (> SHORT lựa chọn) mở bảng có ô gõ tìm (không dấu, nhiều từ, theo mã / tên / mọi chữ hiển thị).
// Viết y như <select>: <Select value onChange={(e) => …e.target.value}><option value="…">…</option></Select>
// Thêm chữ để tìm mà không hiện ra: <option data-search="mã hàng, tên khách…">
const SHORT = 7;

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf(node.props.children);
  return '';
}

function collect(children, out = [], group = '') {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    if (c.type === Fragment) return collect(c.props.children, out, group);
    if (c.type === 'optgroup') return collect(c.props.children, out, c.props.label || '');
    if (c.type !== 'option') return;
    const label = textOf(c.props.children);
    const value = c.props.value !== undefined ? String(c.props.value) : label;
    out.push({ value, label, group, disabled: !!c.props.disabled, hay: norm(`${value} ${label} ${group} ${c.props['data-search'] || ''}`) });
  });
  return out;
}

export default function Select({ children, value, onChange, disabled, className, style, title, searchable, placeholder, ...rest }) {
  const opts = useMemo(() => collect(children), [children]);
  const real = opts.filter((o) => o.value !== '').length;
  const useSearch = searchable ?? real > SHORT;
  if (!useSearch)
    return <select value={value} onChange={onChange} disabled={disabled} className={className} style={style} title={title} {...rest}>{children}</select>;
  return <SearchSelect opts={opts} value={value} onChange={onChange} disabled={disabled} className={className} style={style} title={title} placeholder={placeholder} />;
}

function SearchSelect({ opts, value, onChange, disabled, className, style, title, placeholder }) {
  const cur = String(value ?? '');
  const sel = opts.find((o) => o.value === cur);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState(null);
  const box = useRef();
  const pop = useRef();
  const list = useRef();

  const words = norm(q).split(' ').filter(Boolean);
  const shown = useMemo(() => (words.length ? opts.filter((o) => words.every((w) => o.hay.includes(w))) : opts), [opts, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const place = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const up = below < 260 && r.top > below;
    const width = Math.min(window.innerWidth - 8, Math.max(r.width, 420));
    // Chiều cao danh sách = chỗ trống còn lại trừ ô tìm + dòng chân (~80px)
    setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - width - 4)), width,
      top: up ? undefined : r.bottom + 2, bottom: up ? window.innerHeight - r.top + 2 : undefined, maxH: Math.max(120, Math.min(380, (up ? r.top : below) - 92)) });
  };
  const show = () => {
    if (disabled) return;
    setQ(''); setHi(Math.max(0, opts.findIndex((o) => o.value === cur))); place(); setOpen(true);
  };
  const close = () => { setOpen(false); box.current?.focus(); };
  const pick = (o) => {
    if (!o || o.disabled) return;
    setOpen(false);
    if (o.value !== cur) onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } });
    box.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const out = (e) => !pop.current?.contains(e.target) && !box.current?.contains(e.target) && setOpen(false);
    // Cuộn trang / hộp thoại thì bảng chọn đi theo ô
    const move = (e) => !pop.current?.contains(e.target) && place();
    document.addEventListener('mousedown', out, true);
    window.addEventListener('scroll', move, true);
    window.addEventListener('resize', place);
    return () => { document.removeEventListener('mousedown', out, true); window.removeEventListener('scroll', move, true); window.removeEventListener('resize', place); };
  }, [open]);
  useEffect(() => { setHi(0); }, [q]);
  useLayoutEffect(() => {
    if (open) list.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(shown.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.nativeEvent.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <>
      {/* Giữ đúng một thẻ <select> để ô trông và co giãn y như các ô chọn khác */}
      <select ref={box} value="x" disabled={disabled} className={'ss-trigger ' + (className || '')} style={style} title={title || sel?.label}
        onChange={() => {}} onMouseDown={(e) => { e.preventDefault(); if (open) setOpen(false); else { box.current.focus(); show(); } }}
        onKeyDown={(e) => {
          if (open) return;
          if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(e.key)) { e.preventDefault(); show(); }
          else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); show(); setQ(e.key); }
        }}>
        <option value="x">{sel ? sel.label : (cur ? cur : placeholder || opts.find((o) => o.value === '')?.label || '-- Chọn --')}</option>
      </select>
      {open && pos && createPortal(
        <div ref={pop} className="ss-pop" style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
          onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <input autoFocus className="ss-search" value={q} placeholder="🔍 Gõ để tìm (mã, tên, khách, mã hàng…)" onChange={(e) => setQ(e.target.value)} onKeyDown={key} />
          <div ref={list} className="ss-list" style={{ maxHeight: pos.maxH }}>
            {shown.map((o, i) => (
              <div key={o.value + '|' + i} className={'ss-opt' + (i === hi ? ' hi' : '') + (o.value === cur ? ' on' : '') + (o.disabled ? ' off' : '') + (o.value === '' ? ' blank' : '')}
                onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
                {o.group && <small className="ss-group">{o.group}</small>}{o.label || ' '}
              </div>
            ))}
            {!shown.length && <div className="ss-empty">Không tìm thấy “{q}”</div>}
          </div>
          <div className="ss-foot">{words.length ? `${shown.length}/${opts.length} kết quả` : `${opts.length} lựa chọn`} · ↑↓ Enter để chọn, Esc để đóng</div>
        </div>,
        document.body,
      )}
    </>
  );
}
