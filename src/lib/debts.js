import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { norm } from './utils';

// ============================================================================
// Công nợ phải thu theo tuổi nợ — nhập file MISA "Phân tích công nợ phải thu theo tuổi nợ"
// (giống Sale_control). Mỗi công ty, mỗi ngày số liệu lưu 1 bản chụp:
//   debtSnapshots/{CO}_{yyyy-mm-dd}: số tổng (nhẹ, dùng cho danh sách ngày + xu hướng)
//   debtRows/{CO}_{yyyy-mm-dd}:      chi tiết từng khách hàng (chỉ tải khi xem / so sánh)
// Nhập lại cùng ngày (đầu ngày rồi cuối ngày) → ghi đè bản của ngày đó.
// ============================================================================

export const DEFAULT_BUCKETS = ['1-30 ngày', '31-60 ngày', '61-90 ngày', 'Trên 90 ngày'];
export const snapId = (company, asOf) => `${company}_${asOf}`;
const squash = (s) => norm(s).replace(/ /g, '');
const cellText = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim());

// Số trong file MISA: thường là số; nếu là chữ thì hiểu 1,234,567 / 1.234.567 / (1,000) = âm
export function money(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v ?? '').trim();
  if (!s || s === '-') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.,-]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

// Khóa so khớp 1 khách hàng giữa các ngày: công ty + mã KH (không có mã thì theo tên)
export const custKey = (company, r) => `${company}|${r.code ? 'c:' + norm(r.code) : 'n:' + norm(r.name)}`;

const isBucket = (t) => /\d+\s*-\s*\d+\s*ngày|trên\s*\d+\s*ngày|>\s*\d+|quá hạn\s*\d+/i.test(String(t));

// Đọc file tuổi nợ (mảng dòng, mỗi dòng là mảng ô) → { asOf, company, buckets, groups, rows, fileTotal }
export function parseAging(rows) {
  const txt = (r, i) => (i >= 0 ? cellText(r?.[i]) : '');
  // Ngày số liệu: "Tài khoản: 131, Đến ngày 28/09/2026" (hoặc "Ngày 28/09/2026")
  let asOf = '';
  rows.slice(0, 12).forEach((r) => r.forEach((c) => {
    const m = String(c || '').match(/(?:đến ngày|den ngay|ngày|ngay)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (m && !asOf) asOf = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }));
  const company = rows.slice(0, 4).map((r) => r.map(cellText).find((c) => /công ty|cong ty|company/i.test(c)) || '').find(Boolean) || '';

  // Dòng tiêu đề chính: có "Mã khách hàng" và "Tổng nợ"
  const hr = rows.findIndex((r) => r.some((c) => ['ma khach hang', 'ma kh', 'ma doi tuong'].includes(norm(c)))
    && r.some((c) => norm(c).startsWith('tong no') || norm(c).startsWith('so du') || norm(c) === 'tong cong no'));
  if (hr < 0) throw new Error('Không tìm thấy dòng tiêu đề "Mã khách hàng … Tổng nợ". Hãy xuất báo cáo "Phân tích công nợ phải thu theo tuổi nợ" trên MISA.');
  const head = rows[hr].map(norm);
  const col = (pred) => head.findIndex(pred);
  const cCode = col((h) => ['ma khach hang', 'ma kh', 'ma doi tuong'].includes(h));
  const cName = col((h) => ['ten khach hang', 'ten kh', 'ten doi tuong'].includes(h));
  const cAddr = col((h) => h === 'dia chi');
  const cStaff = col((h) => h.startsWith('nhan vien') || h.startsWith('ten nhan vien'));
  const cTotal = col((h) => h.startsWith('tong no') || h.startsWith('so du') || h === 'tong cong no');
  const cOver = col((h) => h.startsWith('no qua han') || h === 'qua han');
  const cNotDue = col((h) => h.includes('chua den han') || h.includes('trong han'));

  // Dòng tiêu đề phụ có các khoảng tuổi nợ (1-30 ngày, 31-60 ngày…). Có file để luôn trên dòng tiêu đề chính.
  let sub = -1;
  for (let i = hr; i < Math.min(hr + 4, rows.length); i++) {
    if (rows[i].some(isBucket)) { sub = i; break; }
  }
  const buckets = [];
  let cOverTotal = -1;
  if (sub >= 0) {
    rows[sub].forEach((c, i) => {
      const t = cellText(c);
      if (cOver >= 0 && i < cOver) return;
      if (i === cNotDue) return;
      if (isBucket(t)) buckets.push({ label: t, col: i });
      else if (norm(t) === 'tong' && buckets.length) cOverTotal = i;
    });
  }
  if (cOverTotal < 0 && cOver >= 0 && !buckets.some((b) => b.col === cOver)) cOverTotal = cOver;
  const start = (sub >= 0 ? Math.max(sub, hr) : hr) + 1;

  const out = [];
  const groups = new Map();
  let group = { code: '', name: '' };
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const a = txt(r, 0) || txt(r, 1);
    const na = norm(a);
    // Dòng nhóm: "Mã nhóm khách hàng: DAUQUANGTHANG" … "Tên nhóm khách hàng: ĐẬU QUANG THẮNG" (hoặc "Nhân viên: …")
    if (na.startsWith('ma nhom khach hang') || na.startsWith('nhom khach hang') || na.startsWith('ma nhan vien') || na.startsWith('nhan vien:')) {
      const nameCell = r.map(cellText).find((c) => /^(tên nhóm khách hàng|ten nhom khach hang|tên nhân viên|ten nhan vien)/i.test(c)) || '';
      group = { code: a.split(':').slice(1).join(':').trim(), name: nameCell.split(':').slice(1).join(':').trim() };
      if (!groups.has(group.code)) groups.set(group.code, { ...group, count: 0, amount: 0, overdue: 0 });
      continue;
    }
    if (na.startsWith('cong nhom') || na.startsWith('tong cong') || na === 'cong' || na === 'ma khach hang' || na.startsWith('nguoi lap')) continue;
    const code = txt(r, cCode);
    const name = txt(r, cName);
    const rawTotal = r[cTotal];
    if ((!code && !name) || rawTotal === '' || rawTotal == null) continue;
    const amount = money(rawTotal);
    const aging = buckets.map((b) => money(r[b.col]));
    const overdue = cOverTotal >= 0 ? money(r[cOverTotal]) : aging.reduce((s, v) => s + v, 0);
    if (!amount && !overdue) continue;
    const notDue = cNotDue >= 0 ? money(r[cNotDue]) : amount - overdue;
    const g = group.code ? group : cStaff >= 0 && txt(r, cStaff) ? { code: txt(r, cStaff), name: txt(r, cStaff) } : group;
    if (g !== group && !groups.has(g.code)) groups.set(g.code, { ...g, count: 0, amount: 0, overdue: 0 });
    out.push({ line: i + 1, code, name, address: txt(r, cAddr), group: g.code, groupName: g.name, amount, notDue, overdue, aging });
    if (groups.has(g.code)) { const x = groups.get(g.code); x.count += 1; x.amount += amount; x.overdue += overdue; }
  }
  const totalRow = rows.slice(start).find((r) => norm(r[0]).startsWith('tong cong') || norm(r[1]).startsWith('tong cong'));
  return {
    asOf, company, rows: out, groups: [...groups.values()],
    buckets: buckets.length ? buckets.map((b) => b.label) : DEFAULT_BUCKETS,
    fileTotal: totalRow && cTotal >= 0 ? money(totalRow[cTotal]) : null,
  };
}

// Tự nhận công ty theo tên ở đầu file (so với danh mục Công ty)
export function detectCompany(companies, text) {
  const t = squash(text);
  if (!t) return '';
  const hit = companies.find((c) => c.name && (t.includes(squash(c.name)) || squash(c.name).includes(t)));
  if (hit) return hit.code;
  return companies.find((c) => new RegExp(`\\b${norm(c.code)}\\b`).test(norm(text)))?.code || '';
}

// Nhóm khách hàng trong file (VD: DAUQUANGTHANG) → người dùng có Họ tên / email khớp
export function userForGroup(users, code, name) {
  const keys = [squash(code), squash(name)].filter(Boolean);
  if (!keys.length) return null;
  return users.find((u) => keys.includes(squash(u.name)) || keys.includes(squash(String(u.email || u._id || '').split('@')[0]))) || null;
}

const sumAging = (rows, n) => Array.from({ length: n }, (_, i) => rows.reduce((s, r) => s + (Number(r.aging?.[i]) || 0), 0));

// Lưu bản chụp của 1 công ty / 1 ngày (ghi đè nếu đã có)
export async function saveSnapshot({ company, asOf, buckets, rows, fileName, fileCompany, fileTotal, email }) {
  const id = snapId(company, asOf);
  const clean = rows.map(({ line, ...r }) => ({
    code: r.code || '', name: r.name || '', address: r.address || '', group: r.group || '', groupName: r.groupName || '',
    amount: Math.round(r.amount), notDue: Math.round(r.notDue), overdue: Math.round(r.overdue), aging: r.aging.map((v) => Math.round(v)),
  }));
  const size = JSON.stringify(clean).length;
  if (size > 900000) throw new Error(`File quá lớn để lưu 1 ngày (${clean.length} khách hàng). Hãy lọc bớt khách hàng không còn nợ trên MISA rồi xuất lại.`);
  const gm = new Map();
  clean.forEach((r) => {
    const k = r.group || '';
    if (!gm.has(k)) gm.set(k, { code: k, name: r.groupName || '', count: 0, amount: 0, overdue: 0 });
    const g = gm.get(k); g.count += 1; g.amount += r.amount; g.overdue += r.overdue;
  });
  const meta = {
    id, company, asOf, buckets, fileName: fileName || '', fileCompany: fileCompany || '', fileTotal: fileTotal ?? null,
    count: clean.length, amount: clean.reduce((s, r) => s + r.amount, 0), notDue: clean.reduce((s, r) => s + r.notDue, 0),
    overdue: clean.reduce((s, r) => s + r.overdue, 0), overdueCount: clean.filter((r) => r.overdue > 0).length,
    aging: sumAging(clean, buckets.length), groups: [...gm.values()],
    importedAt: serverTimestamp(), importedBy: email,
  };
  const b = writeBatch(db);
  b.set(doc(db, 'debtSnapshots', id), meta);
  b.set(doc(db, 'debtRows', id), { id, company, asOf, buckets, rows: clean, importedBy: email });
  await b.commit();
  rowCache.delete(id);
  return meta;
}

// Chi tiết khách hàng của 1 bản chụp (nhớ tạm trên trình duyệt)
const rowCache = new Map();
export function loadRows(id) {
  if (!rowCache.has(id)) {
    const p = getDoc(doc(db, 'debtRows', id)).then((s) => (s.exists() ? s.data().rows || [] : []));
    p.catch(() => rowCache.delete(id));
    rowCache.set(id, p);
  }
  return rowCache.get(id);
}
export const forgetRows = (id) => rowCache.delete(id);

// Bản chụp có hiệu lực của mỗi công ty tại ngày d (bản gần nhất có ngày ≤ d)
export function snapsAt(snaps, companies, d) {
  return companies.map((co) => snaps.filter((s) => s.company === co && s.asOf <= d).sort((a, b) => b.asOf.localeCompare(a.asOf))[0]).filter(Boolean);
}

// Tuổi nợ xấu nhất (chỉ số khoảng quá hạn cuối cùng còn tiền), -1 = không quá hạn
export const worstBucket = (aging) => { for (let i = (aging || []).length - 1; i >= 0; i--) if (Number(aging[i]) > 0) return i; return -1; };

// So sánh 2 tập khách hàng (đã gắn company) → từng khách + trạng thái thay đổi
export function compareRows(prevRows, curRows) {
  const P = new Map(prevRows.map((r) => [r.k, r]));
  const C = new Map(curRows.map((r) => [r.k, r]));
  return [...new Set([...P.keys(), ...C.keys()])].map((k) => {
    const p = P.get(k); const c = C.get(k); const b = c || p;
    const prevAmt = Number(p?.amount) || 0; const curAmt = Number(c?.amount) || 0;
    const prevOver = Number(p?.overdue) || 0; const curOver = Number(c?.overdue) || 0;
    const prevWorst = worstBucket(p?.aging); const curWorst = worstBucket(c?.aging);
    const delta = curAmt - prevAmt;
    const kind = !p ? 'new' : !c ? 'gone' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
    return {
      k, company: b.company, code: b.code, name: b.name, group: c?.group || p?.group || '', groupName: c?.groupName || p?.groupName || '',
      prevAmt, curAmt, delta, up: Math.max(0, delta), down: Math.max(0, -delta),
      prevOver, curOver, overDelta: curOver - prevOver, prevWorst, curWorst,
      worse: !!c && curOver > 0 && curWorst > prevWorst, cleared: prevOver > 0 && curOver === 0, kind,
    };
  });
}
