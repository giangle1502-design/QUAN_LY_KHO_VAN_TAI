import { useEffect, useRef, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';

// ============================================================================
// Tùy chọn hiển thị riêng của từng người dùng.
// Lưu ngay trên trình duyệt; các cấu hình quan trọng (định dạng ngày/số, cột hiển thị, thứ tự cột, sắp xếp, lọc, mẫu đã lưu…)
// còn lưu lên tài khoản (userPrefs/{email}) để đăng nhập máy khác / điện thoại vẫn giữ nguyên.
// ============================================================================
export const SYNC_RE = /^(fmt$|tv:|rp(Hidden|Extra|Order):|orderList(Hidden|Order|Extra):|slips:[^:]+:(cols|hidden)$|costs:|filter-presets:|filter-layout:|nav-layout$|order-tabs$|\w+Line(HiddenCols|Order)$|catCols:|formOrder:|\w+:hidden$)/;
// Tên trường Firestore không dùng dấu chấm
export const remoteKey = (k) => k.replace(/%/g, '%25').replace(/\./g, '%2E');

const pending = new Map();
let timer = 0;
export function saveRemotePref(email, key, value) {
  if (!email || !SYNC_RE.test(key)) return;
  pending.set(remoteKey(key), JSON.stringify(value ?? null));
  clearTimeout(timer);
  timer = setTimeout(() => {
    const data = Object.fromEntries(pending); pending.clear();
    setDoc(doc(db, 'userPrefs', email), data, { merge: true }).catch(() => { /* chưa dán quy tắc mới: vẫn lưu trên trình duyệt */ });
  }, 700);
}
export function readLocalPref(email, key, initial) {
  try { const x = localStorage.getItem(`pref:${email || ''}:${key}`); return x ? JSON.parse(x) : initial; } catch { return initial; }
}

export function usePref(key, initial) {
  const { email, remotePrefs } = useApp();
  const k = `pref:${email || ''}:${key}`;
  const [v, setV] = useState(() => readLocalPref(email, key, initial));
  // Bản lưu trên tài khoản (máy khác vừa đổi) → áp dụng
  const remote = SYNC_RE.test(key) ? remotePrefs?.[remoteKey(key)] : undefined;
  const last = useRef(undefined);
  useEffect(() => {
    if (remote === undefined || remote === last.current) return;
    last.current = remote;
    try {
      if (remote === JSON.stringify(v)) return;
      setV(JSON.parse(remote) ?? initial);
      localStorage.setItem(k, remote);
    } catch { /* bỏ qua */ }
  }, [remote]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (nv) => {
    setV(nv);
    try { localStorage.setItem(k, JSON.stringify(nv)); } catch { /* bỏ qua */ }
    last.current = JSON.stringify(nv ?? null);
    saveRemotePref(email, key, nv);
  };
  return [v, set];
}
