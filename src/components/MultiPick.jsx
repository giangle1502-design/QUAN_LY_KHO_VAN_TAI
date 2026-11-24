import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { norm } from '../lib/utils';

// Ô chọn nhiều có ô tìm kiếm (không dấu, nhiều từ). opts: [{ value, label, group?, search? }]
// quick: [{ label, values: [...] }] → nút chọn nhanh cả nhóm (VD "Cảng (tất cả)" = VAP-Cảng, PLA-Cảng, DAM-Cảng)
// Danh sách lớn chỉ vẽ MAX dòng đầu, gõ để tìm thêm (chịu được hàng chục nghìn lựa chọn).
const MAX = 300;

export default function MultiPick({ value = [], onChange, opts, quick = [], allLabel = 'Tất cả', unit = 'mục', style, title }) {
  const sel = useMemo(() => new Set(value), [value]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState(null);
  const box = useRef();
  const pop = useRef();
  const hayOpts = useMemo(() => opts.map((o) => ({ ...o, hay: norm(`${o.value} ${o.label} ${o.group || ''} ${o.search || ''}`) })), [opts]);
  const words = norm(q).split(' ').filter(Boolean);
  const shown = useMemo(() => (words.length ? hayOpts.filter((o) => words.every((w) => o.hay.includes(w))) : hayOpts), [hayOpts, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const place = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(window.innerWidth - 8, Math.max(r.width, 380));
    const below = window.innerHeight - r.bottom;
    setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - width - 4)), width, top: r.bottom + 2, maxH: Math.max(160, Math.min(420, below - 130)) });
  };
  useEffect(() => {
    if (!open) return undefined;
    const out = (e) => !pop.current?.contains(e.target) && !box.current?.contains(e.target) && setOpen(false);
    const move = (e) => !pop.current?.contains(e.target) && place();
    document.addEventListener('mousedown', out, true);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', move, true);
    window.addEventListener('resize', place);
    return () => { document.removeEventListener('keydown', esc); document.removeEventListener('mousedown', out, true); window.removeEventListener('scroll', move, true); window.removeEventListener('resize', place); };
  }, [open]);

  const set = (vals) => onChange([...new Set(vals)]);
  const toggle = (v) => set(sel.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const allOn = (vals) => vals.length > 0 && vals.every((v) => sel.has(v));
  const toggleMany = (vals) => set(allOn(vals) ? value.filter((x) => !vals.includes(x)) : [...value, ...vals]);
  const labelOf = (v) => opts.find((o) => o.value === v)?.short || v;
  const text = !value.length ? allLabel : value.length <= 2 ? value.map(labelOf).join(', ') : `${value.length} ${unit} đã chọn`;

  return (
    <>
      <button ref={box} type="button" className="mp-trigger" style={style} title={title || value.map(labelOf).join(', ') || allLabel}
        onClick={() => { if (open) setOpen(false); else { setQ(''); place(); setOpen(true); } }}>
        <span className="mp-text">{text}</span>{value.length > 0 && <span className="mp-count">{value.length}</span>}<span className="mp-caret">▾</span>
      </button>
      {open && pos && createPortal(
        <div ref={pop} className="ss-pop mp-pop" style={{ left: pos.left, width: pos.width, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
          <input autoFocus className="ss-search" value={q} placeholder="🔍 Gõ để tìm" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } }} />
          <div className="mp-bar">
            <button type="button" className="btn sm" onClick={() => onChange([])}>{allLabel}</button>
            <button type="button" className="btn sm" onClick={() => set([...value, ...shown.map((o) => o.value)])}>Chọn {words.length ? 'kết quả tìm' : 'hết'}</button>
            {quick.map((g) => (
              <button key={g.label} type="button" className={'btn sm' + (allOn(g.values) ? ' primary' : '')} title={g.values.join(', ')} onClick={() => toggleMany(g.values)}>{g.label}</button>
            ))}
          </div>
          <div className="ss-list" style={{ maxHeight: pos.maxH }}>
            {shown.slice(0, MAX).map((o) => (
              <label key={o.value} className={'ss-opt mp-opt' + (sel.has(o.value) ? ' on' : '')}>
                <input type="checkbox" checked={sel.has(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.group && <small className="ss-group">{o.group}</small>}{o.label}</span>
              </label>
            ))}
            {shown.length > MAX && <div className="ss-empty">Còn {shown.length - MAX} lựa chọn: gõ để tìm thêm</div>}
            {!shown.length && <div className="ss-empty">Không tìm thấy “{q}”</div>}
          </div>
          <div className="ss-foot">{value.length ? `Đã chọn ${value.length}` : allLabel} · {opts.length} lựa chọn</div>
        </div>,
        document.body,
      )}
    </>
  );
}
