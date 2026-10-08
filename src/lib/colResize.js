// Kéo chỉnh độ rộng cột cho mọi bảng có <thead> trong khung chính.
// Độ rộng lưu theo trang + tiêu đề cột (localStorage của từng máy). Bấm đúp vào vạch kéo để trả về mặc định.
const PREFIX = 'colw:';
const headCells = (table) => [...(table.tHead?.rows[0]?.cells || [])];
const keyOf = (table) => {
  const page = location.pathname.split('/').filter((x) => x && !/\d/.test(x)).join('/');
  const tab = new URLSearchParams(location.search).get('tab') || '';
  return PREFIX + page + '?' + tab + '#' + headCells(table).map((c) => c.textContent.trim()).join('|');
};
const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const save = (k, v) => { try { v ? localStorage.setItem(k, JSON.stringify(v)) : localStorage.removeItem(k); } catch { /* bỏ qua */ } };

function clear(table) {
  table.classList.remove('resized');
  table.style.width = '';
  headCells(table).forEach((c) => { c.style.width = c.style.minWidth = c.style.maxWidth = ''; });
}
function apply(table, widths) {
  const cells = headCells(table);
  if (!widths || widths.length !== cells.length) return clear(table);
  table.classList.add('resized');
  cells.forEach((c, i) => { c.style.width = c.style.minWidth = c.style.maxWidth = widths[i] + 'px'; });
  table.style.width = widths.reduce((s, w) => s + w, 0) + 'px';
}

function prepare(table) {
  if (table.classList.contains('no-resize') || !headCells(table).length) return;
  const k = keyOf(table);
  if (table.dataset.colKey !== k) { table.dataset.colKey = k; apply(table, load(k)); }
  headCells(table).forEach((c) => {
    if (c.querySelector(':scope > .col-grip')) return;
    const g = document.createElement('span');
    g.className = 'col-grip';
    g.title = 'Kéo để chỉnh độ rộng cột · bấm đúp để trả về mặc định';
    c.appendChild(g);
  });
}

function startDrag(e) {
  const grip = e.target.closest?.('.col-grip');
  if (!grip) return;
  e.preventDefault(); e.stopPropagation();
  const th = grip.parentElement; const table = th.closest('table');
  const cells = headCells(table); const idx = cells.indexOf(th);
  const widths = cells.map((c) => Math.round(c.getBoundingClientRect().width));
  apply(table, widths);
  const x0 = e.clientX; const w0 = widths[idx];
  document.body.classList.add('col-resizing');
  const move = (ev) => { widths[idx] = Math.max(40, Math.round(w0 + ev.clientX - x0)); apply(table, widths); };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    document.body.classList.remove('col-resizing');
    save(table.dataset.colKey = keyOf(table), widths);
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}
function reset(e) {
  const grip = e.target.closest?.('.col-grip');
  if (!grip) return;
  e.preventDefault(); e.stopPropagation();
  const table = grip.closest('table');
  save(keyOf(table), null); clear(table);
}
// Chặn click vào vạch kéo lan ra tiêu đề cột (tránh đổi sắp xếp)
const stopClick = (e) => { if (e.target.closest?.('.col-grip')) { e.preventDefault(); e.stopPropagation(); } };

export function installColumnResize(root) {
  let raf = 0;
  const scan = () => { raf = 0; root.querySelectorAll('table').forEach(prepare); };
  const obs = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(scan); });
  obs.observe(root, { childList: true, subtree: true, characterData: true });
  root.addEventListener('pointerdown', startDrag, true);
  root.addEventListener('dblclick', reset, true);
  root.addEventListener('click', stopClick, true);
  scan();
  return () => {
    obs.disconnect(); cancelAnimationFrame(raf);
    root.removeEventListener('pointerdown', startDrag, true);
    root.removeEventListener('dblclick', reset, true);
    root.removeEventListener('click', stopClick, true);
  };
}
