import { useState } from 'react';
import { useApp } from '../context/AppContext';

// Tùy chọn hiển thị riêng của từng người dùng (lưu trên trình duyệt đang dùng)
export function usePref(key, initial) {
  const { email } = useApp();
  const k = `pref:${email || ''}:${key}`;
  const [v, setV] = useState(() => {
    try { const x = localStorage.getItem(k); return x ? JSON.parse(x) : initial; } catch { return initial; }
  });
  const set = (nv) => { setV(nv); try { localStorage.setItem(k, JSON.stringify(nv)); } catch { /* bỏ qua */ } };
  return [v, set];
}
