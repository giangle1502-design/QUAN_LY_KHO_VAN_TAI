import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { roleLabel } from '../catalogs';
import { matchQ } from '../lib/utils';
import {
  SYS_ALL, atMs, dmId, isUnread, loadOlder, markRead, saveGroup, sendMessage, useChatReads, useMessages, useMyChats,
} from '../lib/chat';
import { ErrorBox, Modal } from '../components/ui';

// Trò chuyện: danh sách hội thoại bên trái (riêng, nhóm, thông báo hệ thống), nội dung bên phải.
// Điện thoại: mở hội thoại thì ẩn danh sách, nút ← để quay lại.
const KIND = { dm: '👤', group: '👥', sys: '🔔' };

export function fmtWhen(ms, full = false) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const same = d.toDateString() === now.toDateString();
  if (same && !full) return hm;
  const dm = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return full ? `${hm} ${dm}` : dm;
}

// Ô chọn nhiều (người dùng, nhóm, vai trò): ô tìm + danh sách đánh dấu
export function MultiPick({ options, value, onChange, placeholder = 'Tìm…', height = 180 }) {
  const [q, setQ] = useState('');
  const set = new Set(value);
  const shown = options.filter((o) => set.has(o.value) || matchQ(q, o.label, o.value, o.sub));
  return (
    <div className="mpick">
      {options.length > 7 && <input type="search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="mpick-list" style={{ maxHeight: height }}>
        {shown.map((o) => (
          <label key={o.value} className={set.has(o.value) ? 'on' : ''}>
            <input type="checkbox" checked={set.has(o.value)}
              onChange={() => onChange(set.has(o.value) ? value.filter((x) => x !== o.value) : [...value, o.value])} />
            <span>{o.label}{o.sub && <small className="small"> · {o.sub}</small>}</span>
          </label>
        ))}
        {!shown.length && <div className="small" style={{ padding: 6 }}>Không có lựa chọn phù hợp.</div>}
      </div>
      {value.length > 0 && <div className="small">Đã chọn {value.length}</div>}
    </div>
  );
}

export default function Chat() {
  const { email, name, isAdmin } = useApp();
  const me = { email, name };
  const [sp, setSp] = useSearchParams();
  const { rows: chats, loading, error } = useMyChats(email);
  const reads = useChatReads(email);
  const { rows: users } = useCollection('users');
  const userMap = useMemo(() => new Map(users.map((u) => [u._id, u])), [users]);
  const nameOf = (e) => userMap.get(e)?.name || e;
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(false);
  const [group, setGroup] = useState(null);
  const [draftDm, setDraftDm] = useState(null);

  const titleOf = (c) => {
    if (c.type === 'dm') { const o = c.members.find((x) => x !== email) || email; return nameOf(o); }
    return c.name || (c.id === SYS_ALL ? '📢 Thông báo chung' : 'Hội thoại');
  };
  const cid = sp.get('c') || '';
  const open = chats.find((c) => c.id === cid) || (draftDm?.id === cid ? draftDm : null);
  const go = (id) => setSp(id ? { c: id } : {});

  // Trò chuyện riêng: mở hội thoại sẵn có hoặc hội thoại mới (chỉ tạo khi gửi tin đầu tiên)
  const startDm = (other) => {
    setPick(false);
    const id = dmId(email, other);
    if (!chats.some((c) => c.id === id)) setDraftDm({ id, type: 'dm', _new: true, members: [email, other].sort(), names: { [email]: name, [other]: nameOf(other) } });
    go(id);
  };

  const list = chats.filter((c) => matchQ(q, titleOf(c), c.lastText, c.type === 'group' ? c.members.map(nameOf) : ''));
  const unread = chats.filter((c) => isUnread(c, reads, email)).length;
  const colleagues = users.filter((u) => u.active !== false && u._id !== email)
    .map((u) => ({ value: u._id, label: u.name || u._id, sub: `${roleLabel(u.role)} · ${u._id}` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className={'chat-page' + (open ? ' has-open' : '')}>
      <div className="chat-side">
        <div className="chat-side-head">
          <h1>💬 Trò chuyện{unread ? <span className="badge red" style={{ marginLeft: 6 }}>{unread}</span> : null}</h1>
          <div className="chat-new">
            <button type="button" className="btn sm primary" onClick={() => setPick(true)}>+ Trò chuyện riêng</button>
            {isAdmin && <button type="button" className="btn sm" onClick={() => setGroup({ name: '', note: '', members: [email] })}>+ Nhóm</button>}
          </div>
          <input type="search" placeholder="🔍 Tìm hội thoại, người, nội dung…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ErrorBox error={error} />
        <div className="chat-list">
          {loading && <div className="small" style={{ padding: 12 }}>Đang tải…</div>}
          {!loading && !list.length && <div className="small" style={{ padding: 12 }}>Chưa có hội thoại. Bấm “+ Trò chuyện riêng” để nhắn cho đồng nghiệp.</div>}
          {list.map((c) => {
            const un = isUnread(c, reads, email);
            return (
              <button type="button" key={c.id} className={'chat-row' + (c.id === cid ? ' on' : '') + (un ? ' unread' : '')} onClick={() => go(c.id)}>
                <span className="chat-ico">{KIND[c.type] || '💬'}</span>
                <span className="chat-row-main">
                  <span className="chat-row-top"><b>{titleOf(c)}</b><small>{fmtWhen(atMs(c.lastAt))}</small></span>
                  <span className="chat-row-last">
                    {c.lastBy && c.lastBy === email && !c.lastSys ? 'Bạn: ' : c.type === 'group' && c.lastByName && !c.lastSys ? `${c.lastByName}: ` : ''}{c.lastText}
                  </span>
                </span>
                {un && <span className="chat-dot" />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="chat-main">
        {open ? (
          <Conversation key={open.id} chat={open} me={me} title={titleOf(open)} nameOf={nameOf} reads={reads}
            onBack={() => go('')} onEditGroup={isAdmin && open.type === 'group' ? () => setGroup(open) : null} />
        ) : (
          <div className="chat-empty">
            <div style={{ fontSize: 40 }}>💬</div>
            <p>Chọn một hội thoại bên trái, hoặc bấm <b>+ Trò chuyện riêng</b>.</p>
            <p className="small">🔔 Thông báo hệ thống: tin tự động khi lập SO, dự kiến xuất / DO, phiếu xuất, chuyển pháp nhân…
              {isAdmin ? <> Chọn ai nhận tin nào ở <Link to="/quan-tri/tin-nhan">Cấu hình tin nhắn hệ thống</Link>.</> : ' Quản trị chọn ai nhận tin nào.'}</p>
          </div>
        )}
      </div>
      {pick && (
        <Modal title="Trò chuyện riêng với…" onClose={() => setPick(false)}>
          <PickOne options={colleagues} onPick={startDm} />
        </Modal>
      )}
      {group && <GroupEditor group={group} options={[{ value: email, label: name || email, sub: 'Bạn' }, ...colleagues]} me={me}
        onClose={() => setGroup(null)} onSaved={(id) => { setGroup(null); go(id); }} />}
    </div>
  );
}

function PickOne({ options, onPick }) {
  const [q, setQ] = useState('');
  const shown = options.filter((o) => matchQ(q, o.label, o.sub));
  return (
    <div className="mpick">
      <input type="search" autoFocus placeholder="Gõ tên, email, vai trò…" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && shown[0] && onPick(shown[0].value)} />
      <div className="mpick-list" style={{ maxHeight: 360 }}>
        {shown.map((o) => (
          <button type="button" key={o.value} className="mpick-one" onClick={() => onPick(o.value)}>
            <b>{o.label}</b> <small className="small">{o.sub}</small>
          </button>
        ))}
        {!shown.length && <div className="small" style={{ padding: 6 }}>Không tìm thấy người dùng.</div>}
      </div>
    </div>
  );
}

function GroupEditor({ group, options, me, onClose, onSaved }) {
  const [g, setG] = useState({ ...group, members: [...(group.members || [])] });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!g.name.trim()) return setErr('Nhập tên nhóm.');
    if (g.members.length < 2) return setErr('Chọn ít nhất 2 thành viên.');
    setBusy(true); setErr('');
    try { onSaved(await saveGroup(g, me)); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={g.id ? `Sửa nhóm ${group.name}` : 'Tạo nhóm trò chuyện'} onClose={onClose}>
      <ErrorBox error={err} />
      <div className="form-grid">
        <label className="field full"><span>Tên nhóm <b className="req">*</b></span>
          <input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} placeholder="vd. Kho Bình Dương, Sale miền Nam, Kế toán…" autoFocus /></label>
        <label className="field full"><span>Ghi chú</span>
          <input value={g.note || ''} onChange={(e) => setG({ ...g, note: e.target.value })} placeholder="Nhóm dùng để làm gì" /></label>
        <div className="field full"><span>Thành viên</span>
          <MultiPick options={options} value={g.members} onChange={(members) => setG({ ...g, members })} placeholder="Tìm người theo tên, vai trò…" height={260} /></div>
      </div>
      <p className="small">Nhóm cũng dùng làm nơi nhận tin nhắn hệ thống (Quản trị → Cấu hình tin nhắn hệ thống).</p>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>Hủy</button>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu nhóm'}</button>
      </div>
    </Modal>
  );
}

function Conversation({ chat, me, title, nameOf, reads, onBack, onEditGroup }) {
  const live = useMessages(chat._new ? '' : chat.id);
  const [older, setOlder] = useState({ rows: [], last: null, full: true, loading: false });
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  const stick = useRef(true);
  const { isAdmin } = useApp();
  const canPost = chat.type !== 'sys' || (chat.id === SYS_ALL && isAdmin);

  const msgs = useMemo(() => {
    const seen = new Set(live.rows.map((m) => m.id));
    return [...live.rows, ...older.rows.filter((m) => !seen.has(m.id))].reverse();
  }, [live.rows, older.rows]);
  const hasMore = older.last ? older.full : live.full;

  // Tự cuộn xuống tin mới nhất (trừ khi người dùng đang kéo lên đọc tin cũ)
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);
  // Đang mở hội thoại → đánh dấu đã đọc (chỉ ghi khi có tin mới, đỡ tốn lượt ghi)
  useEffect(() => {
    if (!chat._new && isUnread(chat, reads, me.email)) markRead(chat.id, me.email).catch(() => {});
  }, [chat.id, atMs(chat.lastAt)]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = async () => {
    const after = older.last || live.last;
    if (!after) return;
    setOlder((o) => ({ ...o, loading: true }));
    stick.current = false;
    try {
      const r = await loadOlder(chat.id, after);
      setOlder((o) => ({ rows: [...o.rows, ...r.rows], last: r.last || o.last, full: r.full, loading: false }));
    } catch (e) { setErr(e.message); setOlder((o) => ({ ...o, loading: false })); }
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr('');
    stick.current = true;
    try { await sendMessage(chat, text, me); setText(''); } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền gửi tin vào hội thoại này.' : e.message); }
    setBusy(false);
  };
  const sub = chat.type === 'group' ? `${chat.members.length} thành viên: ${chat.members.map(nameOf).join(', ')}`
    : chat.type === 'dm' ? (chat.members.find((x) => x !== me.email) || '')
      : chat.id === SYS_ALL ? 'Tin tự động gửi cho mọi người' : 'Tin tự động gửi riêng cho bạn';
  let lastDay = '';
  return (
    <div className="chat-conv">
      <div className="chat-conv-head">
        <button type="button" className="btn ghost sm chat-back" onClick={onBack}>←</button>
        <span className="chat-ico">{KIND[chat.type] || '💬'}</span>
        <div className="chat-conv-title"><b>{title}</b><small className="small" title={sub}>{sub}</small></div>
        {onEditGroup && <button type="button" className="btn sm" onClick={onEditGroup}>⚙ Nhóm</button>}
      </div>
      <div className="chat-msgs" ref={boxRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {hasMore && msgs.length > 0 && (
          <button type="button" className="btn ghost sm chat-more" disabled={older.loading} onClick={more}>{older.loading ? 'Đang tải…' : '↑ Xem tin cũ hơn'}</button>
        )}
        {live.loading && <div className="small" style={{ textAlign: 'center' }}>Đang tải…</div>}
        {!live.loading && !msgs.length && <div className="small" style={{ textAlign: 'center', padding: 20 }}>{chat._new ? `Bắt đầu trò chuyện với ${title}.` : 'Chưa có tin nhắn.'}</div>}
        {msgs.map((m) => {
          const ms = atMs(m.at);
          const day = ms ? new Date(ms).toLocaleDateString('vi-VN') : '';
          const sep = day && day !== lastDay ? day : '';
          if (sep) lastDay = day;
          const mine = m.by === me.email && !m.sys;
          return (
            <div key={m.id}>
              {sep && <div className="chat-day"><span>{sep}</span></div>}
              <div className={'msg' + (mine ? ' mine' : '') + (m.sys ? ' sys' : '')}>
                {!mine && (chat.type === 'group' || m.sys) && <div className="msg-by">{m.sys ? `🔔 Hệ thống${m.byName ? ` · ${m.byName}` : ''}` : m.byName || nameOf(m.by)}</div>}
                <div className="msg-text">{m.text}</div>
                <div className="msg-foot">
                  {m.link && <Link to={m.link}>Mở {m.ref || 'chứng từ'} →</Link>}
                  <small>{fmtWhen(ms, true)}</small>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <ErrorBox error={err} />
      {canPost ? (
        <div className="chat-compose">
          <textarea rows={1} value={text} placeholder={chat.id === SYS_ALL ? 'Gửi thông báo cho mọi người…' : 'Nhập tin nhắn… (Enter gửi, Shift+Enter xuống dòng)'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={send}>Gửi</button>
        </div>
      ) : (
        <div className="chat-ro small">Hộp thông báo tự động, không trả lời được. Muốn trao đổi, nhắn riêng cho người gửi.</div>
      )}
    </div>
  );
}
