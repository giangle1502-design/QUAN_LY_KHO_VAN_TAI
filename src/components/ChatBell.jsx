import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { atMs, isUnread, useChatReads, useMyChats } from '../lib/chat';

// Nút 💬 trên đầu trang: số hội thoại có tin chưa đọc; tin mới đến (khi không ở trang Trò chuyện) hiện thông báo nhỏ góc màn hình
export default function ChatBell() {
  const { email } = useApp();
  const on = !!email;
  const { rows } = useMyChats(on ? email : '');
  const reads = useChatReads(on ? email : '');
  const loc = useLocation();
  const nav = useNavigate();
  const seen = useRef(null);
  const [toast, setToast] = useState(null);
  const n = rows.filter((c) => isUnread(c, reads, email)).length;

  useEffect(() => {
    if (!rows.length) return;
    const cur = new Map(rows.map((c) => [c.id, atMs(c.lastAt)]));
    const prev = seen.current;
    seen.current = cur;
    if (!prev) return; // lần tải đầu: không bật thông báo cho tin cũ
    const fresh = rows.find((c) => c.lastBy !== email && atMs(c.lastAt) > (prev.get(c.id) || 0) && isUnread(c, reads, email));
    if (fresh && !(loc.pathname === '/tro-chuyen' && new URLSearchParams(loc.search).get('c') === fresh.id)) setToast(fresh);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => { document.title = document.title.replace(/^\(\d+\) /, ''); if (n) document.title = `(${n}) ${document.title}`; }, [n]);

  if (!on) return null;
  return (
    <>
      <Link to="/tro-chuyen" className={'bell chat-bell' + (n ? ' has' : '')} title="Trò chuyện, thông báo hệ thống">
        💬{n > 0 && <span className="bell-n">{n}</span>}
      </Link>
      {toast && (
        <div className="chat-toast" role="button" tabIndex={0} onClick={() => { setToast(null); nav(`/tro-chuyen?c=${toast.id}`); }}>
          <b>{toast.lastSys ? '🔔 ' : '💬 '}{toast.type === 'dm' ? toast.lastByName || toast.lastBy : toast.name || 'Tin nhắn mới'}</b>
          {toast.type === 'group' && !toast.lastSys && <small> · {toast.lastByName}</small>}
          <div>{toast.lastText}</div>
          <button type="button" className="chat-toast-x" onClick={(e) => { e.stopPropagation(); setToast(null); }}>✕</button>
        </div>
      )}
    </>
  );
}
