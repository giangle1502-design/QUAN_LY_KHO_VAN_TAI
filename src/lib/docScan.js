// Đọc ảnh chụp phiếu Ecount (Biên bản giao hàng → SO, Phiếu đề nghị nhập kho → PO / STO) bằng OCR ngay trên trình duyệt.
//  - Không cần máy chủ, không cần khóa API: Tesseract.js tải từ CDN lần đầu (~15 MB, trình duyệt giữ lại cho lần sau).
//  - Bảng hàng hóa: tìm đường kẻ ô của bảng, đọc riêng từng ô (chính xác hơn đọc cả trang).
//  - Phần chữ (ngày, số phiếu, công ty, xe…) đọc theo nhãn "Ngày giao:", "Số phiếu:"…
//  - Cũng nhận chữ dán vào (copy từ trang in của Ecount).
// Kết quả chỉ là bản nháp: người dùng luôn kiểm tra, sửa trên form đơn trước khi lưu.
import { norm } from './utils';

const TV = '5.1.1';
const CDN = 'https://cdn.jsdelivr.net/npm';
export const OCR_PATHS = {
  script: `${CDN}/tesseract.js@${TV}/dist/tesseract.min.js`,
  workerPath: `${CDN}/tesseract.js@${TV}/dist/worker.min.js`,
  corePath: `${CDN}/tesseract.js-core@${TV}`,
  langPath: `${CDN}/@tesseract.js-data/vie@1.0.0/4.0.0_best_int`,
};

let workerP = null;
let progressCb = null;
function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = ok; s.onerror = () => fail(new Error('Không tải được bộ đọc ảnh (kiểm tra mạng Internet).'));
    document.head.appendChild(s);
  });
}
async function getWorker() {
  if (!workerP) {
    workerP = (async () => {
      if (!window.Tesseract) await loadScript(OCR_PATHS.script);
      return window.Tesseract.createWorker('vie', 1, {
        workerPath: OCR_PATHS.workerPath, corePath: OCR_PATHS.corePath, langPath: OCR_PATHS.langPath,
        logger: (m) => progressCb?.(m),
      });
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

// ---------------------------------------------------------------------------
// Ảnh → canvas phóng to (chữ phiếu Ecount nhỏ: phóng ~3 lần đọc chính xác hơn) + mảng xám
// ---------------------------------------------------------------------------
async function toCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.max(1, Math.min(4, 2000 / bmp.width));
  const W = Math.round(bmp.width * scale);
  const H = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const gray = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
  return { canvas: c, gray, W, H, scale };
}

// ---------------------------------------------------------------------------
// Tìm bảng theo đường kẻ: đường ngang dài cùng mép trái/phải xếp chồng = 1 bảng; đường dọc trong từng dòng = ranh giới ô
// ---------------------------------------------------------------------------
const LINE_DARK = 205;
export function findTables(gray, W, H) {
  const dark = (x, y) => gray[y * W + x] < LINE_DARK;
  const segs = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!dark(x, y)) { x++; continue; }
      const s = x;
      while (x < W && dark(x, y)) x++;
      if (x - s >= W * 0.25) segs.push({ y, x0: s, x1: x - 1 });
    }
  }
  // Gộp các đoạn liền nhau (đường dày nhiều pixel)
  const lines = [];
  for (const s of segs) {
    const l = lines.find((q) => s.y - q.y1 <= 2 && Math.abs(q.x0 - s.x0) < 6 && Math.abs(q.x1 - s.x1) < 6);
    if (l) { l.y1 = s.y; } else lines.push({ y0: s.y, y1: s.y, x0: s.x0, x1: s.x1 });
  }
  // Nhóm thành bảng: các đường cùng mép trái / phải (lệch ≤ 1% bề ngang)
  const tol = Math.max(6, W * 0.01);
  const groups = [];
  for (const l of lines.sort((a, b) => a.y0 - b.y0)) {
    const g = groups.find((q) => Math.abs(q.x0 - l.x0) <= tol && Math.abs(q.x1 - l.x1) <= tol);
    if (g) g.lines.push(l); else groups.push({ x0: l.x0, x1: l.x1, lines: [l] });
  }
  const tables = [];
  for (const g of groups) {
    if (g.lines.length < 3) continue;
    const rows = [];
    for (let i = 0; i + 1 < g.lines.length; i++) {
      const top = g.lines[i].y1 + 1;
      const bot = g.lines[i + 1].y0 - 1;
      if (bot - top < 12) continue;
      // Ranh giới cột: cột pixel tối gần hết chiều cao dòng
      const y0 = top + 2; const y1 = bot - 2;
      const need = (y1 - y0 + 1) * 0.9;
      const xs = [];
      for (let x = Math.max(0, g.x0 - 3); x <= Math.min(W - 1, g.x1 + 3); x++) {
        let c = 0;
        for (let y = y0; y <= y1; y++) if (dark(x, y)) c++;
        if (c >= need) xs.push(x);
      }
      const bounds = [];
      for (const x of xs) {
        const b = bounds[bounds.length - 1];
        if (b && x - b.x1 <= 2) b.x1 = x; else bounds.push({ x0: x, x1: x });
      }
      if (!bounds.length || bounds[0].x0 > g.x0 + tol) bounds.unshift({ x0: g.x0, x1: g.x0 });
      if (bounds[bounds.length - 1].x1 < g.x1 - tol) bounds.push({ x0: g.x1, x1: g.x1 });
      const cells = [];
      for (let k = 0; k + 1 < bounds.length; k++) {
        const cx0 = bounds[k].x1 + 1; const cx1 = bounds[k + 1].x0 - 1;
        if (cx1 - cx0 >= 8) cells.push({ x0: cx0, x1: cx1, y0: top, y1: bot });
      }
      if (cells.length) rows.push({ y0: top, y1: bot, cells, bounds });
    }
    if (rows.length >= 2 && rows[0].cells.length >= 3) tables.push({ x0: g.x0, x1: g.x1, y0: g.lines[0].y0, y1: g.lines[g.lines.length - 1].y1, rows, lines: g.lines });
  }
  return tables;
}

// Xóa đường kẻ bảng trước khi đọc cả trang (đường kẻ làm OCR đọc sai chữ sát bên)
function eraseLines(ctx, tables) {
  ctx.fillStyle = '#fff';
  for (const t of tables) {
    for (const l of t.lines) ctx.fillRect(l.x0 - 1, l.y0 - 1, l.x1 - l.x0 + 3, l.y1 - l.y0 + 3);
    for (const r of t.rows) for (const b of r.bounds) ctx.fillRect(b.x0 - 1, r.y0 - 2, b.x1 - b.x0 + 3, r.y1 - r.y0 + 5);
  }
}

function cropCell(src, c) {
  const pad = 12; const inset = 3;
  const w = c.x1 - c.x0 + 1 - inset * 2; const h = c.y1 - c.y0 + 1 - inset * 2;
  const out = document.createElement('canvas');
  out.width = w + pad * 2; out.height = h + pad * 2;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, c.x0 + inset, c.y0 + inset, w, h, pad, pad, w, h);
  return out;
}
// Cắt ô theo vùng có chữ (bỏ khoảng trắng thừa), chữ thấp thì phóng thêm: số ngắn như "90" đọc chắc hơn
function inkBox(gray, W, c) {
  let x0 = 1e9; let y0 = 1e9; let x1 = -1; let y1 = -1;
  for (let y = c.y0 + 3; y <= c.y1 - 3; y++) for (let x = c.x0 + 3; x <= c.x1 - 3; x++) {
    if (gray[y * W + x] < 160) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
function cropBox(src, b, minH = 0) {
  const w = b.x1 - b.x0 + 1; const h = b.y1 - b.y0 + 1;
  const k = minH && h < minH ? minH / h : 1;
  const pad = Math.round(14 * Math.max(1, k));
  const out = document.createElement('canvas');
  out.width = Math.round(w * k) + pad * 2; out.height = Math.round(h * k) + pad * 2;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, b.x0, b.y0, w, h, pad, pad, Math.round(w * k), Math.round(h * k));
  return out;
}
// Ô trống: gần như không có pixel tối thì bỏ qua, không cần đọc
function cellEmpty(gray, W, c) {
  let n = 0;
  for (let y = c.y0 + 3; y <= c.y1 - 3; y++) for (let x = c.x0 + 3; x <= c.x1 - 3; x++) if (gray[y * W + x] < 140) n++;
  return n < 12;
}

// Đọc ảnh: trả { text, tables: [[[ô, …], …dòng], …], ms }
export async function ocrImage(blob, onProgress) {
  const t0 = Date.now();
  const say = (stage, pct) => onProgress?.({ stage, pct });
  say('Đang tải bộ đọc ảnh…', 0);
  progressCb = (m) => { if (m.status && /load|init/i.test(m.status)) say('Đang tải bộ đọc ảnh (lần đầu ~15 MB)…', Math.round((m.progress || 0) * 100)); };
  const worker = await getWorker();
  const img = await toCanvas(blob);
  const tables = findTables(img.gray, img.W, img.H);
  const page = document.createElement('canvas');
  page.width = img.W; page.height = img.H;
  const pctx = page.getContext('2d');
  pctx.drawImage(img.canvas, 0, 0);
  eraseLines(pctx, tables);
  progressCb = (m) => { if (m.status === 'recognizing text') say('Đang đọc chữ trên phiếu…', Math.round((m.progress || 0) * 100)); };
  await worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '', preserve_interword_spaces: '1' });
  const pageRes = await worker.recognize(page);
  // Từng ô bảng (chế độ "1 khối chữ"). Cột số (STT, số lượng, số bao) biết được từ dòng tiêu đề:
  // đọc chế độ "1 dòng" chỉ nhận chữ số → số ngắn như "90", "990" không bị bỏ sót
  progressCb = null;
  let psm = ''; let wl = null;
  const setMode = async (m, digits) => {
    const w = digits ? '0123456789.,' : '';
    if (psm === m && wl === w) return;
    psm = m; wl = w;
    await worker.setParameters({ tessedit_pageseg_mode: m, tessedit_char_whitelist: w });
  };
  const read = async (cv) => (await worker.recognize(cv)).data.text.replace(/\s+/g, ' ').trim();
  const total = tables.reduce((s, t) => s + t.rows.reduce((a, r) => a + r.cells.length, 0), 0);
  let done = 0;
  const outTables = [];
  for (const t of tables) {
    const rows = [];
    let numCols = [];
    for (const [ri, r] of t.rows.entries()) {
      const cells = [];
      for (const c of r.cells) {
        let txt = '';
        if (!cellEmpty(img.gray, img.W, c)) {
          const isNum = ri > 0 && numCols.some((h) => Math.min(c.x1, h.x1) - Math.max(c.x0, h.x0) > (c.x1 - c.x0) * 0.6);
          if (isNum) {
            await setMode('7', true); txt = await read(cropCell(img.canvas, c));
            if (!/\d/.test(txt)) { await setMode('8', true); txt = await read(cropCell(img.canvas, c)); }
            if (!/\d/.test(txt)) { const b = inkBox(img.gray, img.W, c); if (b) { await setMode('7', true); txt = await read(cropBox(img.canvas, b, 48)); } }
          }
          if (!txt) { await setMode('6', false); txt = await read(cropCell(img.canvas, c)); }
        }
        cells.push({ text: txt, x0: c.x0, x1: c.x1 });
        done++;
        say('Đang đọc bảng hàng hóa…', Math.round((done / Math.max(1, total)) * 100));
      }
      if (ri === 0) numCols = cells.filter((c) => ['no', 'qty', 'bags'].includes(colOf(c.text)));
      rows.push(cells);
    }
    outTables.push({ y0: t.y0, y1: t.y1, rows });
  }
  await setMode('3', false);
  // Tiêu đề nhóm "HÀNG KIỆN" / "HÀNG XÁ" phía trên từng bảng
  const pageLines = (pageRes.data.lines || []).map((l) => ({ text: l.text.trim(), y: l.bbox?.y0 ?? 0 }));
  for (const t of outTables) {
    const above = pageLines.filter((l) => l.y < t.y0 && /^hang (kien|xa)\b/.test(norm(l.text))).pop();
    t.packing = above ? (/kien/.test(norm(above.text)) ? 'Kiện' : 'Xá') : '';
  }
  return { text: pageRes.data.text, tables: outTables, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Đọc nội dung phiếu
// ---------------------------------------------------------------------------
// Số kiểu Ecount: 24,750 · 2,250.5 · OCR có thể đọc thành 24.750
export function parseNum(s) {
  let t = String(s ?? '').replace(/[^\d.,-]/g, '');
  if (!t || !/\d/.test(t)) return null;
  const hasC = t.includes(','); const hasD = t.includes('.');
  if (hasC && hasD) t = t.lastIndexOf('.') > t.lastIndexOf(',') ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  else if (hasC) t = /,\d{3}(?!\d)/.test(t) && !/,\d{1,2}$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  else if (hasD) t = /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
export function parseDate(s) {
  const m = String(s || '').match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4})/);
  if (!m) return '';
  const d = Number(m[1]); const mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Bỏ dấu giữ nguyên độ dài chuỗi (để cắt giá trị trên chuỗi gốc theo vị trí tìm được trên chuỗi không dấu)
const flat = (s) => [...String(s)].map((c) => (c === 'đ' || c === 'Đ' ? 'd' : c.normalize('NFD')[0].toLowerCase())).join('');

// Nhãn trên phiếu (không dấu, chịu được lỗi OCR hay gặp)
const LABELS = {
  date: /ngay (giao|nhap|xuat|chuyen)\s*:/,
  slipNo: /so phi[eê]?u( chuy[eê]n kho| xuat kho| nhap kho)?\s*:/,
  soNo: /so don hang\s*:/,
  seller: /cong ty ban\s*:/,
  buyer: /cong ty mua\s*:/,
  address: /dia ch[iỉ]\s*:/,
  taxCode: /ma so thu[eê]\s*:/,
  carrier: /don v[iị] v[aâ]n (chuy[eê]n|tai)\s*:/,
  plate: /(so xe\s*\/?\s*:?\s*cont|so xe|bien so)\s*:/,
  driver: /(thong tin )?tai xe\s*:/,
  recipient: /kinh g[uư]i\s*:/,
  toCompany: /nhap hang cho cong ty\s*:/,
  warehouse: /kho nhap\s*:|kho xuat\s*:/,
};

function fieldsFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = {};
  let ctx = '';
  for (const raw of lines) {
    // OCR hay đọc "Số" thành "$6", "S6"
    const line = raw.replace(/^\$\s?[6o]\b/i, 'Số').replace(/^S[6o]\b/, 'Số');
    const f = flat(line);
    if (/^(stt|so thu|thong tin hang hoa|tong cong)/.test(f)) { if (/thong tin hang hoa|tong cong/.test(f)) ctx = 'table'; continue; }
    // Tìm mọi nhãn trên dòng (1 dòng có thể có 2 nhãn: "Đơn vị vận tải: GHA   Số xe/cont: ONEU…")
    const hits = [];
    for (const [k, re] of Object.entries(LABELS)) {
      // OCR hay dính chữ ("Sốxe:36k61512"): khoảng trắng trong nhãn có thể không có
      const g = new RegExp(re.source.replace(/ /g, '\\s*'), 'g');
      let m;
      while ((m = g.exec(f))) hits.push({ k, i: m.index, end: m.index + m[0].length });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => a.i - b.i);
    // Nhãn lồng nhau (vd. "so xe" trong "so xe/cont"): giữ nhãn dài
    const keep = hits.filter((h, i) => !hits.some((o, j) => j !== i && o.i <= h.i && o.end >= h.end && (o.end - o.i) > (h.end - h.i)));
    keep.forEach((h, i) => {
      const val = line.slice(h.end, keep[i + 1] ? keep[i + 1].i : undefined).trim().replace(/^[:\s|]+|[\s|,;]+$/g, '');
      if (!val) return;
      if (h.k === 'seller' || h.k === 'buyer') ctx = h.k;
      if (h.k === 'address' || h.k === 'taxCode') {
        const who = ctx === 'seller' || ctx === 'buyer' ? ctx : 'party';
        out[who] = { ...(out[who] || {}), [h.k]: val };
        return;
      }
      if (h.k === 'seller' || h.k === 'buyer') { out[h.k] = { ...(out[h.k] || {}), name: val }; return; }
      if (!(h.k in out)) out[h.k] = val;
    });
  }
  if (out.seller?.taxCode) out.seller.taxCode = out.seller.taxCode.replace(/[^\dA-Z-]/gi, '');
  if (out.buyer?.taxCode) out.buyer.taxCode = out.buyer.taxCode.replace(/[^\dA-Z-]/gi, '');
  // Số phiếu, số đơn: chỉ lấy cụm chữ-số đầu tiên
  const code = (v) => (String(v || '').toUpperCase().replace(/[^A-Z0-9-]/g, ' ').trim().split(' ')[0] || '');
  if (out.slipNo) out.slipNo = code(out.slipNo);
  if (out.soNo) out.soNo = code(out.soNo);
  // Tài xế: "BÙI MINH TOÀN CCCD: 030083012865"
  if (out.driver) {
    const m = out.driver.match(/^(.*?)(?:CCCD|CMND|CC)\s*:?\s*([\d\s]{9,14})/i);
    if (m) { out.driverName = m[1].replace(/[-,;|]+$/, '').trim(); out.idCard = m[2].replace(/\s/g, ''); } else out.driverName = out.driver;
    delete out.driver;
  }
  if (out.plate) {
    out.plate = out.plate.replace(/[|_~]+/g, ' ').replace(/\s*-\s*$/, '').trim().toUpperCase();
    // Biển số dính liền "36K61512" → "36K 61512"
    out.plate = out.plate.replace(/^(\d{2}[A-Z]{1,2}\d?)[\s.-]*(\d{3}\.?\d{2})$/, '$1 $2');
  }
  if (out.carrier) out.carrier = out.carrier.replace(/[|]+/g, ' ').trim();
  out.date = parseDate(out.date);
  return out;
}

// Loại phiếu theo tiêu đề / số phiếu
export function detectKind(text, f = {}) {
  const t = flat(text);
  if (/bien ban giao hang|phieu xuat kho/.test(t) || /^PXK/.test(f.slipNo || '') || f.buyer) return 'BBGH';
  if (/de nghi nhap kho|phieu nhap kho/.test(t) || /^(PCK|PNK)/.test(f.slipNo || '') || f.toCompany) return 'DNNK';
  return '';
}

// Cột của bảng hàng theo tiêu đề
const COLS = [
  ['no', /^(stt|so thu|thu tu|^tt$)/],
  ['code', /ma (mat )?hang|^ma\b/],
  ['name', /ten (mat )?hang|ten hang|dien giai/],
  ['unit', /don ?v[iị]|dvt/],
  ['bags', /so bao|bao/],
  ['qty', /so luong|luong|khoi luong|trong luong/],
  ['status', /tinh trang|tthh/],
  ['note', /ghi chu/],
];
function colOf(h) {
  const t = flat(h).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [k, re] of COLS) if (re.test(t)) return k;
  return '';
}
const looksCode = (s) => /^[A-Z0-9][A-Z0-9._/-]{3,}$/i.test(String(s || '').replace(/\s/g, '')) && /\d/.test(s) && /[A-Z]/i.test(s);

// rows: [[{text, x0, x1}]] (ảnh) hoặc [[chuỗi]] (chữ dán vào)
function linesFromTable(rows, packing = '') {
  const cellsOf = (r) => r.map((c) => (typeof c === 'string' ? { text: c } : c));
  const hi = rows.findIndex((r) => { const ks = cellsOf(r).map((c) => colOf(c.text)); return ks.includes('code') || (ks.includes('name') && ks.includes('qty')); });
  if (hi < 0) return { lines: [], total: null };
  const head = cellsOf(rows[hi]);
  const keys = head.map((c) => colOf(c.text));
  // Ô theo vị trí x (ảnh: ô gộp như "Tổng cộng" → cột trùng nhiều nhất); chữ dán vào: theo thứ tự
  const keyAt = (c, i, n) => {
    if (c.x0 == null || head[0].x0 == null) return n === keys.length ? keys[i] : '';
    let best = ''; let ov = 0;
    head.forEach((hc, j) => { const o = Math.min(c.x1, hc.x1) - Math.max(c.x0, hc.x0); if (o > ov) { ov = o; best = keys[j]; } });
    return best;
  };
  const lines = []; let total = null;
  for (const r of rows.slice(hi + 1)) {
    const cs = cellsOf(r);
    const rec = {};
    cs.forEach((c, i) => { const k = keyAt(c, i, cs.length); if (k && c.text) rec[k] = rec[k] ? `${rec[k]} ${c.text}` : c.text; });
    const all = flat(cs.map((c) => c.text).join(' '));
    if (/tong cong|cong:|^tong\b/.test(all)) {
      total = { qty: parseNum(rec.qty), bags: parseNum(rec.bags) };
      // Ô gộp lấy mất cột số lượng: lấy 2 số cuối dòng
      if (total.qty == null) { const nums = cs.map((c) => parseNum(c.text)).filter((v) => v != null); total = { qty: nums[0] ?? null, bags: nums[1] ?? null }; }
      continue;
    }
    if (!rec.code && !rec.name) {
      // Dòng tiếp của tên hàng bị xuống dòng
      continue;
    }
    const code = String(rec.code || '').toUpperCase().replace(/\s+/g, '').replace(/[|[\]{}()]/g, '');
    lines.push({
      code, name: String(rec.name || '').trim(), unit: String(rec.unit || '').trim(),
      qtyKg: parseNum(rec.qty), bags: parseNum(rec.bags),
      status: String(rec.status || '').trim(), note: String(rec.note || '').trim(), packing,
    });
  }
  return { lines, total };
}

// Chữ dán vào (copy từ trang Ecount): bảng tách bằng Tab, hoặc nhiều khoảng trắng
function tablesFromText(text) {
  const rows = String(text || '').split(/\r?\n/).map((l) => (l.includes('\t') ? l.split('\t') : l.split(/\s{2,}|\s\|\s/)).map((c) => c.trim()))
    .filter((r) => r.some(Boolean));
  const out = [];
  let packing = '';
  let cur = null;
  for (const r of rows) {
    const t = flat(r.join(' '));
    if (/^hang (kien|xa)\b/.test(t)) { packing = /kien/.test(t) ? 'Kiện' : 'Xá'; continue; }
    const ks = r.map(colOf);
    if (ks.includes('code') && (ks.includes('qty') || ks.includes('name'))) { cur = { packing, rows: [r] }; out.push(cur); continue; }
    if (cur) { cur.rows.push(r.filter((c, i) => c || i < cur.rows[0].length)); if (/tong cong/.test(t)) cur = null; }
  }
  return out;
}

// Từ chữ OCR / dán: dòng hàng dạng "1 HDPEHXM50100 Hạt nhựa … KG 2,250 90" (khi không tìm được đường kẻ bảng)
function linesFromLooseText(text) {
  const out = []; let total = null; let packing = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.replace(/[|[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
    const f = flat(l);
    if (/^hang (kien|xa)\b/.test(f)) { packing = /kien/.test(f) ? 'Kiện' : 'Xá'; continue; }
    if (/^tong cong/.test(f)) { const nums = l.match(/[\d.,]+/g)?.map(parseNum).filter((v) => v != null) || []; total = { qty: nums[0] ?? null, bags: nums[1] ?? null }; continue; }
    const m = l.match(/^(\d{1,3})\s+([A-Z0-9][A-Z0-9._/-]{3,})\s+(.+)$/i);
    if (!m || !looksCode(m[2])) continue;
    const rest = m[3];
    const nums = [...rest.matchAll(/(\d[\d.,]*)/g)];
    const tail = nums.slice(-2).map((x) => parseNum(x[1]));
    const status = (rest.match(/\b(KTC|HTC|DGC)\b[^\s]*/) || [''])[0];
    const nameEnd = nums.length >= 2 ? nums[nums.length - 2].index : rest.length;
    out.push({ code: m[2].toUpperCase(), name: rest.slice(0, nameEnd).replace(/\b(KG|TAN|TẤN|BAO)\s*$/i, '').trim(), unit: /\bKG\b/i.test(rest) ? 'KG' : '',
      qtyKg: tail[0] ?? null, bags: tail[1] ?? null, status, note: '', packing });
  }
  return { lines: out, total };
}

// Gộp kết quả thành phiếu: { kind, date, slipNo, soNo, seller, buyer, …, lines, total }
export function parseSlip({ text = '', tables = null } = {}) {
  const f = fieldsFromText(text);
  const kind = detectKind(text, f);
  let lines = []; let total = null;
  const tbls = tables?.length ? tables : tablesFromText(text);
  for (const t of tbls) {
    const r = linesFromTable(t.rows, t.packing || '');
    lines.push(...r.lines);
    if (r.total) total = total ? { qty: (total.qty || 0) + (r.total.qty || 0), bags: (total.bags || 0) + (r.total.bags || 0) } : r.total;
  }
  if (!lines.length) { const r = linesFromLooseText(text); lines = r.lines; total = total || r.total; }
  // Đơn vị tính: Tấn → kg
  for (const l of lines) if (l.qtyKg != null && /^t[aấ]n$/i.test(l.unit)) l.qtyKg *= 1000;
  // Tình trạng hàng hóa: "KTC-PPPR590C2M" → KTC (+ mã hàng đọc lần 2 để đối chiếu)
  for (const l of lines) {
    const m = String(l.status || '').toUpperCase().match(/\b(KTC|HTC|DGC)\b(?:\s*-\s*([A-Z0-9._/-]+))?/);
    l.goodsStatus = m ? m[1] : '';
    l.code2 = m?.[2] || '';
  }
  // Chỉ 1 dòng hàng mà số lượng đọc lệch "Tổng cộng" → dòng tổng thường đọc đúng hơn: lấy theo tổng, ghi chú để người dùng xem lại
  if (lines.length === 1 && total?.qty && lines[0].qtyKg !== total.qty) { lines[0].qtyRead = lines[0].qtyKg; lines[0].qtyKg = total.qty; }
  if (lines.length === 1 && total?.bags && lines[0].bags !== total.bags) { lines[0].bagsRead = lines[0].bags; lines[0].bags = total.bags; }
  const packings = [...new Set(lines.map((l) => l.packing).filter(Boolean))];
  return { kind, ...f, packing: packings.length === 1 ? packings[0] : '', lines, total };
}

// ---------------------------------------------------------------------------
// Khớp với danh mục
// ---------------------------------------------------------------------------
const lev = (a, b) => {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
};
// Ký tự OCR hay nhầm: O/0, I/L/1, S/5, B/8, Z/2, G/6
const ocrKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2').replace(/G/g, '6');
const words = (s) => norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 1);
// Tên công ty: bỏ phần chung "công ty tnhh / cổ phần / mtv …" rồi so từ
const CO_WORDS = new Set(['cong', 'ty', 'tnhh', 'co', 'phan', 'mtv', 'thanh', 'vien', 'mot', 'jsc', 'ltd', 'company', 'limited', 'cp', 'tm', 'dv', 'sx']);
function nameScore(a, b) {
  const wa = words(a).filter((w) => !CO_WORDS.has(w)); const wb = new Set(words(b).filter((w) => !CO_WORDS.has(w)));
  if (!wa.length || !wb.size) return 0;
  const hit = wa.filter((w) => wb.has(w)).length;
  return hit / Math.max(wa.length, wb.size);
}

// Mã hàng: trùng mã → khớp; gần đúng (lỗi OCR ≤ 2 ký tự, hoặc mã đọc ở cột TTHH) → đoán; theo tên → đoán
export function matchItem(line, items) {
  const act = items.filter((x) => x.active !== false);
  const k = ocrKey(line.code);
  const exact = act.find((x) => String(x.code).toUpperCase() === String(line.code).toUpperCase());
  if (exact) return { rec: exact, how: 'exact' };
  const k2 = ocrKey(line.code2);
  const same = act.find((x) => (k && ocrKey(x.code) === k) || (k2 && ocrKey(x.code) === k2));
  if (same) return { rec: same, how: 'ocr' };
  let best = null; let bd = 99;
  for (const x of act) {
    const d = Math.min(k ? lev(ocrKey(x.code), k) : 99, k2 ? lev(ocrKey(x.code), k2) : 99);
    if (d < bd) { bd = d; best = x; }
  }
  if (best && bd <= Math.max(1, Math.floor(String(best.code).length / 6))) return { rec: best, how: 'near' };
  if (line.name) {
    let bn = null; let bs = 0;
    for (const x of act) { const s = nameScore(line.name, x.name); if (s > bs) { bs = s; bn = x; } }
    if (bn && bs >= 0.75) return { rec: bn, how: 'name' };
  }
  return { rec: null, how: '' };
}

// Đối tác / công ty: mã số thuế trước, rồi tên
export function matchParty({ name, taxCode } = {}, rows) {
  const act = rows.filter((x) => x.active !== false);
  const tc = String(taxCode || '').replace(/[^\dA-Z]/gi, '');
  const byTax = tc.length >= 8 ? act.filter((x) => String(x.taxCode || '').replace(/[^\dA-Z]/gi, '') === tc) : [];
  let best = null; let bs = 0;
  if (name) {
    const nn = norm(name);
    const byCode = act.find((x) => norm(x.code) === nn);
    if (byCode) return { rec: byCode, how: 'exact' };
    for (const x of act) { const s = Math.max(nameScore(name, x.name), x.fullName ? nameScore(name, x.fullName) : 0); if (s > bs) { bs = s; best = x; } }
  }
  // Tên trùng gần hết thắng MST (mẫu in Ecount có thể in nhầm MST công ty khác trong nhóm)
  if (best && bs >= 0.8) return { rec: best, how: byTax.includes(best) ? 'tax' : bs >= 0.99 ? 'exact' : 'name' };
  if (byTax.length === 1) return { rec: byTax[0], how: 'tax' };
  if (byTax.length > 1 && best && byTax.includes(best)) return { rec: best, how: 'tax' };
  if (best && bs >= 0.6) return { rec: best, how: 'name' };
  return { rec: null, how: '' };
}

// Kho: theo mã kho đứng đầu ("VAP - KHO SOTRANS…" không phải mã kho), theo tên
export function matchWarehouse(text, rows) {
  const act = rows.filter((x) => x.active !== false);
  if (!text) return null;
  const nn = norm(text);
  const exact = act.find((x) => norm(x.name) === nn || norm(x.code) === nn);
  if (exact) return exact;
  let best = null; let bs = 0;
  const strip = (s) => norm(s).replace(/\((kho moi|moi|cu)\)/g, '').replace(/^(vap|pla|dam)\s*-\s*/, '');
  for (const x of act) {
    const s = Math.max(nameScore(strip(text), strip(x.name)), nameScore(text, x.name));
    if (s > bs) { bs = s; best = x; }
  }
  return bs >= 0.6 ? best : null;
}
// Kho Đức Hòa của công ty (kho chạy hệ thống này): ưu tiên kho tên có "Đức Hòa" + mã / tên công ty
export function ducHoaWarehouse(rows, company) {
  const dh = rows.filter((x) => x.active !== false && /duc hoa/.test(norm(`${x.name} ${x.code}`)));
  if (!dh.length) return null;
  const co = norm(company || '');
  return dh.find((x) => co && norm(`${x.code} ${x.name}`).split(/[^a-z0-9]+/).includes(co)) || (dh.length === 1 ? dh[0] : null);
}
export function matchCarrier(text, rows) {
  if (!text) return null;
  const k = norm(text).replace(/\s/g, '');
  return rows.find((x) => norm(x.code).replace(/\s/g, '') === k)
    || rows.find((x) => norm(x.name).replace(/\s/g, '') === k)
    || rows.find((x) => norm(x.name).replace(/\s/g, '').includes(k) && k.length >= 3)
    // Mã ngắn đọc sai 1 ký tự (vd. "GHA" đọc thành "CHÀ"): chỉ nhận khi đúng 1 đơn vị gần như vậy
    || (() => { const near = rows.filter((x) => x.active !== false && lev(norm(x.code).replace(/\s/g, ''), k) <= (k.length >= 6 ? 2 : 1)); return near.length === 1 ? { ...near[0], _near: true } : null; })();
}
