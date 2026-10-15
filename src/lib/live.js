import { useEffect, useState } from 'react';
import { onSnapshot } from 'firebase/firestore';

// Nghe realtime dùng chung: nhiều trang / ô chọn cùng nghe 1 truy vấn chỉ mở 1 kết nối,
// rời trang vẫn giữ kết nối thêm KEEP_MS để quay lại không phải đọc lại toàn bộ (giảm lượt đọc Firestore).
const KEEP_MS = 15 * 60 * 1000;
const subs = new Map();

function open(key, makeQuery) {
  let s = subs.get(key);
  if (s) return s;
  s = { snap: null, error: '', cbs: new Set(), unsub: null, timer: null };
  subs.set(key, s);
  s.unsub = onSnapshot(makeQuery(),
    (snap) => { s.snap = snap; s.error = ''; s.cbs.forEach((cb) => cb(s)); },
    (e) => { s.error = e.message || String(e); s.snap = null; s.cbs.forEach((cb) => cb(s)); subs.delete(key); s.unsub = null; });
  return s;
}

// cb(state) mỗi khi có dữ liệu; trả về hàm hủy nghe
export function listenShared(key, makeQuery, cb) {
  const s = open(key, makeQuery);
  clearTimeout(s.timer);
  s.cbs.add(cb);
  if (s.snap || s.error) cb(s);
  return () => {
    s.cbs.delete(cb);
    if (s.cbs.size) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      if (s.cbs.size) return;
      s.unsub?.();
      if (subs.get(key) === s) subs.delete(key);
    }, KEEP_MS);
  };
}

// { snap, loading, error } của truy vấn key (key rỗng = không nghe)
export function useShared(key, makeQuery) {
  const [st, setSt] = useState({ snap: null, loading: !!key, error: '', key });
  useEffect(() => {
    if (!key) { setSt({ snap: null, loading: false, error: '', key }); return undefined; }
    setSt((x) => (x.key === key ? x : { snap: null, loading: true, error: '', key }));
    return listenShared(key, makeQuery, (s) => setSt({ snap: s.snap, loading: false, error: s.error, key }));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ngay sau khi đổi truy vấn: coi như đang tải
  return st.key === key ? st : { snap: null, loading: !!key, error: '', key };
}

// Đọc 1 lần qua kết nối dùng chung (đã có sẵn thì không tốn lượt đọc; giữ kết nối thêm KEEP_MS cho lần sau)
export function onceShared(key, makeQuery) {
  return new Promise((resolve, reject) => {
    let off = null; let done = false;
    off = listenShared(key, makeQuery, (s) => {
      if (done) return;
      done = true;
      setTimeout(() => off?.(), 0);
      if (s.error) reject(new Error(s.error)); else resolve(s.snap);
    });
  });
}
