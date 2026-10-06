import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

// Cấu hình web Firebase lấy từ biến môi trường (Vercel → Settings → Environment Variables,
// hoặc file .env.local khi chạy trên máy). Xem README mục 1.
const env = import.meta.env;
const firebaseConfig = {
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
export const db = configured ? getFirestore(app) : null;
export const googleProvider = new GoogleAuthProvider();

// Chạy thử với Firebase Emulator trên máy: VITE_USE_EMULATOR=1
if (configured && env.VITE_USE_EMULATOR === '1') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// Email quản trị gốc (phải khớp superAdmins() trong firestore.rules)
export const SUPER_ADMINS = (env.VITE_SUPER_ADMINS || 'giangle1502@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
