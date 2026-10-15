import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

// Cấu hình web Firebase lấy từ biến môi trường (Vercel → Settings → Environment Variables,
// hoặc file .env.local khi chạy trên máy). Xem README mục 1.
const env = import.meta.env;
export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const configured = !!firebaseConfig.apiKey && !!firebaseConfig.projectId;
export const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = configured ? getAuth(app) : null;
// Lưu dữ liệu đã đọc trên trình duyệt (IndexedDB): mở lại trang / tab khác dùng bộ nhớ đệm, giảm lượt đọc Firestore
function makeDb() {
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    return getFirestore(app);
  }
}
export const db = configured ? makeDb() : null;
export const googleProvider = new GoogleAuthProvider();

// Chạy thử với Firebase Emulator trên máy: VITE_USE_EMULATOR=1
export const onEmulator = env.VITE_USE_EMULATOR === '1';
if (configured && onEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// Email quản trị gốc (phải khớp superAdmins() trong firestore.rules)
export const SUPER_ADMINS = (env.VITE_SUPER_ADMINS || 'giangle1502@gmail.com,gianglevan.vap@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Link tài xế (không đăng nhập): phiên Firebase riêng (đăng nhập ẩn danh) để không làm đăng xuất
// người đang dùng app trên cùng trình duyệt
let tx = null;
export function txFirebase() {
  if (tx) return tx;
  const a = initializeApp(firebaseConfig, 'tx');
  const txAuth = getAuth(a); const txDb = getFirestore(a);
  if (onEmulator) { connectAuthEmulator(txAuth, 'http://127.0.0.1:9099', { disableWarnings: true }); connectFirestoreEmulator(txDb, '127.0.0.1', 8080); }
  tx = { auth: txAuth, db: txDb };
  return tx;
}
