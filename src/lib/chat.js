import { useMemo } from 'react';
import {
  collection, doc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, startAfter, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { db, SUPER_ADMINS } from '../firebase';
import { onceShared, useShared } from './live';
import { fmtDate, fmtNum } from './utils';

// ============================================================================
// Trò chuyện trong app: trò chuyện riêng (1-1), nhóm (quản trị tạo), tin nhắn hệ thống.
// chats/{id}: { type: 'dm' | 'group' | 'sys', name, members: [email] (['*'] = mọi người), last… }
// chats/{id}/messages/{mid}: { text, by, byName, at, sys?, event?, link? }
// chatReads/{email}: { [chatId]: millis đã đọc } — tính số tin chưa đọc mà không phải ghi vào hội thoại chung
// Tiết kiệm lượt đọc (gói Spark): 1 kết nối danh sách hội thoại của mình, chỉ nghe tin nhắn của hội thoại đang mở (30 tin mới nhất),
// tin cũ hơn tải thêm khi bấm.
// ============================================================================

export const PAGE = 30;
export const SYS_ALL = 'sys_all';
const san = (e) => String(e || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
export const dmId = (a, b) => `dm_${[san(a), san(b)].sort().join('__')}`;
export const sysId = (email) => `sys_${san(email)}`;
export const atMs = (t) => (t?.toMillis ? t.toMillis() : typeof t === 'number' ? t : 0);

// ---------- Nghe dữ liệu ----------
// Mọi hội thoại có mình (và kênh thông báo chung)
export function useMyChats(email) {
  const st = useShared(email ? `chats|${email}` : '', () => query(collection(db, 'chats'), where('members', 'array-contains-any', [email, '*'])));
  return useMemo(() => ({
    loading: st.loading, error: st.error,
    rows: (st.snap ? st.snap.docs.map((d) => ({ ...d.data({ serverTimestamps: 'estimate' }), id: d.id })) : [])
      .sort((a, b) => atMs(b.lastAt) - atMs(a.lastAt)),
  }), [st]);
}

export function useChatReads(email) {
  const st = useShared(email ? `chatReads|${email}` : '', () => doc(db, 'chatReads', email));
  return useMemo(() => (st.snap?.exists() ? st.snap.data() : {}), [st.snap]);
}

// Hội thoại có tin mới chưa đọc (tin của người khác, sau lần đọc cuối)
export const isUnread = (c, reads, email) => !!c.lastAt && c.lastBy !== email && atMs(c.lastAt) > (Number(reads[c.id]) || 0);

// 30 tin mới nhất của 1 hội thoại (realtime)
export function useMessages(chatId) {
  const st = useShared(chatId ? `msgs|${chatId}` : '', () => query(collection(db, 'chats', chatId, 'messages'), orderBy('at', 'desc'), limit(PAGE)));
  return useMemo(() => ({
    loading: st.loading, error: st.error, last: st.snap?.docs[st.snap.docs.length - 1] || null, full: (st.snap?.size || 0) >= PAGE,
    rows: st.snap ? st.snap.docs.map((d) => ({ ...d.data({ serverTimestamps: 'estimate' }), id: d.id })) : [],
  }), [st]);
}

// Tin cũ hơn (đọc 1 lần khi bấm "Xem tin cũ hơn")
export async function loadOlder(chatId, after) {
  const s = await getDocs(query(collection(db, 'chats', chatId, 'messages'), orderBy('at', 'desc'), startAfter(after), limit(PAGE)));
  return { rows: s.docs.map((d) => ({ ...d.data({ serverTimestamps: 'estimate' }), id: d.id })), last: s.docs[s.docs.length - 1] || null, full: s.size >= PAGE };
}

// ---------- Ghi ----------
const preview = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 140);

export async function sendMessage(chat, text, user) {
  const t = String(text || '').trim();
  if (!t) return;
  const b = writeBatch(db);
  const ref = doc(collection(db, 'chats', chat.id, 'messages'));
  if (chat.type === 'dm' && chat._new) {
    b.set(doc(db, 'chats', chat.id), { type: 'dm', members: chat.members, names: chat.names || {}, createdBy: user.email, createdAt: serverTimestamp(),
      lastText: preview(t), lastAt: serverTimestamp(), lastBy: user.email, lastByName: user.name || '' });
  } else {
    b.update(doc(db, 'chats', chat.id), { lastText: preview(t), lastAt: serverTimestamp(), lastBy: user.email, lastByName: user.name || '' });
  }
  b.set(ref, { text: t.slice(0, 4000), by: user.email, byName: user.name || '', at: serverTimestamp() });
  await b.commit();
  await markRead(chat.id, user.email);
}

export async function markRead(chatId, email) {
  if (!chatId || !email) return;
  await setDoc(doc(db, 'chatReads', email), { [chatId]: Date.now() }, { merge: true });
}

// Nhóm: quản trị tạo / sửa tên, thành viên
export async function saveGroup(g, user) {
  const members = [...new Set(g.members.map((e) => e.toLowerCase()))];
  if (g.id) {
    await updateDoc(doc(db, 'chats', g.id), { name: g.name.trim(), note: g.note || '', members, updatedBy: user.email, updatedAt: serverTimestamp() });
    return g.id;
  }
  const id = `g_${Date.now().toString(36)}`;
  await setDoc(doc(db, 'chats', id), { type: 'group', name: g.name.trim(), note: g.note || '', members, createdBy: user.email, createdAt: serverTimestamp(),
    lastText: `Nhóm được tạo bởi ${user.name || user.email}`, lastAt: serverTimestamp(), lastBy: user.email, lastByName: user.name || '' });
  return id;
}

// Mọi nhóm (trang cấu hình: chọn nhóm nhận tin hệ thống) — chỉ quản trị đọc được hết
export function useGroups(enabled) {
  const st = useShared(enabled ? 'chats|groups' : '', () => query(collection(db, 'chats'), where('type', '==', 'group')));
  return useMemo(() => (st.snap ? st.snap.docs.map((d) => ({ ...d.data(), id: d.id })) : []).sort((a, b) => String(a.name).localeCompare(String(b.name))), [st.snap]);
}

// ============================================================================
// Tin nhắn hệ thống: mỗi loại công việc có cấu hình người nhận + mẫu nội dung (settings/chatRules, quản trị sửa)
// ============================================================================
export const VARS = [
  ['so', 'Số chứng từ (SO, DK, PX, PN, HSGC…)'], ['don', 'Số đơn gắn kèm'], ['khach', 'Khách hàng / NCC'], ['kho', 'Kho'],
  ['hang', 'Mã hàng + số lượng'], ['kg', 'Tổng kg'], ['ngay', 'Ngày'], ['cty', 'Công ty'], ['tu', 'Lấy tồn công ty'], ['nganhang', 'Ngân hàng'], ['nguoi', 'Người thực hiện'],
];

export const EVENTS = [
  { key: 'so_new', label: 'Lập đơn bán (SO) mới', icon: '🧾', text: '🧾 {nguoi} lập đơn bán {so} · khách {khach} · {hang}' },
  { key: 'po_new', label: 'Lập đơn mua (PO) mới', icon: '🛒', text: '🛒 {nguoi} lập đơn mua {so} · NCC {khach} · {hang}' },
  { key: 'sto_new', label: 'Lập lệnh chuyển kho (STO) mới', icon: '🔁', text: '🔁 {nguoi} lập lệnh chuyển kho {so} · {kho} · {hang}' },
  { key: 'plan_new', label: 'Tạo dự kiến xuất / DO', icon: '📅', text: '📅 {nguoi} tạo dự kiến xuất cho {don} · khách {khach} · ngày {ngay} · {hang}' },
  { key: 'px_new', label: 'Lập phiếu xuất kho', icon: '📤', text: '📤 {nguoi} lập phiếu xuất {so} ({don}) · kho {kho} · khách {khach} · {hang}' },
  { key: 'pn_new', label: 'Lập phiếu nhập kho', icon: '📥', text: '📥 {nguoi} lập phiếu nhập {so} ({don}) · kho {kho} · {hang}' },
  { key: 'legal_transfer', label: 'Báo chuyển pháp nhân', icon: '🏛️', text: '🏛️ Chuyển pháp nhân: phiếu {so} ({don}) xuất cho {cty} lấy tồn {tu} · {hang}. Kế toán vui lòng chuyển trên phần mềm kế toán.' },
  { key: 'release_new', label: 'Lập đề nghị giải chấp', icon: '🔓', text: '🔓 {nguoi} lập đề nghị giải chấp {so} · {cty} · ngân hàng {nganhang} · {hang}' },
];
// Mặc định (chưa cấu hình): chỉ báo chuyển pháp nhân cho kế toán
export const DEFAULT_RULES = { legal_transfer: { on: true, roles: ['ke_toan'] } };
export const ruleOf = (rules, key) => ({ on: false, all: false, roles: [], users: [], groups: [], sales: false, keepers: false, text: '',
  ...(rules?.[key] || (rules ? {} : DEFAULT_RULES[key]) || {}) });

export function useChatRules() {
  const st = useShared('doc|settings/chatRules', () => doc(db, 'settings', 'chatRules'));
  return useMemo(() => ({ loading: st.loading, rules: st.snap?.exists() ? st.snap.data().events || {} : null }), [st]);
}
export const saveChatRules = (events, user) => setDoc(doc(db, 'settings', 'chatRules'), { events, updatedBy: user.email, updatedAt: serverTimestamp() });

const sumKg = (lines) => lines.reduce((a, l) => a + Math.abs(Number(l.kg ?? l.qtyKg) || 0), 0);
export const linesText = (lines = []) => {
  const by = new Map();
  for (const l of lines) by.set(l.item, (by.get(l.item) || 0) + Math.abs(Number(l.kg ?? l.qtyKg) || 0));
  const s = [...by].map(([i, k]) => `${i} ${fmtNum(k, 2)} kg`);
  return s.length > 4 ? `${s.slice(0, 4).join(', ')} … (+${s.length - 4} mã)` : s.join(', ');
};

export function fillText(tpl, d) {
  const v = {
    so: d.id || '', don: d.orderId || d.id || '', khach: d.partyName || d.partyCode || '', kho: d.warehouse || '', hang: linesText(d.lines),
    kg: fmtNum(sumKg(d.lines || []), 2), ngay: fmtDate(d.date || ''), cty: d.company || '', tu: d.from || '', nganhang: d.pledgee || '', nguoi: d.by || '',
  };
  // Bỏ cả đoạn (ngăn bằng ·) khi mọi biến trong đoạn đều trống, vd. "khách {khach}" khi không có khách
  const one = (seg) => {
    const ks = [...seg.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k in v);
    if (ks.length && ks.every((k) => !v[k])) return '';
    return seg.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)).replace(/\(\s*\)/g, '');
  };
  return String(tpl).split('·').map(one).map((x) => x.trim()).filter(Boolean).join(' · ');
}

// Người nhận: tất cả → kênh thông báo chung; nhóm → tin vào nhóm; vai trò / người / sale phụ trách / thủ kho của kho → hộp thông báo riêng từng người
export async function resolveTargets(rule, d, sender) {
  const chats = new Set();
  if (rule.all) chats.add(SYS_ALL);
  for (const g of rule.groups || []) chats.add(g);
  const emails = new Set((rule.users || []).map((e) => e.toLowerCase()));
  if (rule.sales && d.sales) emails.add(String(d.sales).toLowerCase());
  if ((rule.roles || []).length || rule.keepers) {
    const users = (await onceShared('c|users', () => collection(db, 'users'))).docs.map((x) => ({ ...x.data(), email: x.id }));
    const whs = [d.warehouse, ...(d.warehouses || [])].filter(Boolean);
    for (const u of users) {
      if (u.active === false) continue;
      if ((rule.roles || []).includes(u.role || 'xem')) emails.add(u.email);
      if (rule.keepers && u.role === 'thu_kho' && whs.length && (!(u.warehouses || []).length || whs.some((w) => u.warehouses.includes(w)))) emails.add(u.email);
    }
  }
  if ((rule.roles || []).includes('admin')) SUPER_ADMINS.forEach((e) => emails.add(e));
  emails.delete(String(sender || '').toLowerCase());
  return { chats: [...chats], emails: [...emails] };
}

async function postSystem(targets, text, meta, user) {
  const { chats, emails } = targets;
  if (!chats.length && !emails.length) return 0;
  const b = writeBatch(db);
  const last = { lastText: preview(text), lastAt: serverTimestamp(), lastBy: user.email, lastByName: user.name || '', lastSys: true };
  const msg = { text, by: user.email, byName: user.name || '', at: serverTimestamp(), sys: true, ...meta };
  for (const id of chats) {
    if (id === SYS_ALL) b.set(doc(db, 'chats', id), { type: 'sys', members: ['*'], name: '📢 Thông báo chung', ...last }, { merge: true });
    else b.update(doc(db, 'chats', id), last);
    b.set(doc(collection(db, 'chats', id, 'messages')), msg);
  }
  for (const e of emails) {
    const id = sysId(e);
    b.set(doc(db, 'chats', id), { type: 'sys', members: [e], name: '🔔 Thông báo hệ thống', ...last }, { merge: true });
    b.set(doc(collection(db, 'chats', id, 'messages')), msg);
  }
  await b.commit();
  return chats.length + emails.length;
}

// Gọi sau khi lập chứng từ. Không bao giờ làm hỏng thao tác chính: lỗi chỉ ghi ra console.
// d: { id, orderId, partyName, warehouse, lines, date, company, sales, from, pledgee, link }
export async function sysNotify(event, d, user, { rules: given, test } = {}) {
  try {
    const rules = given !== undefined ? given : (await onceShared('doc|settings/chatRules', () => doc(db, 'settings', 'chatRules')).then((s) => (s.exists() ? s.data().events || {} : null)));
    const rule = ruleOf(rules, event);
    if (!rule.on && !test) return 0;
    const ev = EVENTS.find((e) => e.key === event);
    const text = (test ? '🧪 [Gửi thử] ' : '') + fillText(rule.text || ev.text, { ...d, by: d.by || user.name || user.email });
    const targets = await resolveTargets(rule, d, test ? '' : user.email);
    return await postSystem(targets, text, { event, ref: d.id || '', link: d.link || '' }, user);
  } catch (e) {
    console.warn('Không gửi được tin nhắn hệ thống', event, e);
    if (test) throw e;
    return 0;
  }
}

const whsOf = (lines = []) => [...new Set(lines.flatMap((l) => [l.warehouse, l.fromWarehouse, l.toWarehouse]).filter(Boolean))];
export const notifyOrder = (id, o, user) => sysNotify({ SO: 'so_new', PO: 'po_new', STO: 'sto_new' }[o.type] || 'so_new', {
  id, orderId: id, partyName: o.partyName, sales: o.sales, company: o.company, date: o.date, lines: o.lines,
  warehouse: whsOf(o.lines).join(', '), warehouses: whsOf(o.lines), link: `/don-hang?tab=${o.type}&q=${id}`,
}, user);
export const notifyPlan = (id, p, user) => sysNotify('plan_new', {
  id, orderId: p.orderId, partyName: p.partyName, sales: p.sales, company: p.company, date: p.date, lines: p.lines,
  warehouse: whsOf(p.lines).join(', '), warehouses: whsOf(p.lines), link: '/du-kien-xuat',
}, user);
export const notifySlip = (m, user) => sysNotify(m.type === 'in' ? 'pn_new' : 'px_new', {
  id: m.id, orderId: m.orderId, partyName: m.partyName, sales: m.sales, company: m.company, date: m.date, lines: m.lines,
  warehouse: m.warehouse, link: `/kho/phieu/${m.id}/in`,
}, user);
