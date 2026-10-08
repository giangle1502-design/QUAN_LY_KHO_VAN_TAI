import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db, SUPER_ADMINS } from '../firebase';
import { mergeFields } from '../lib/fields';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = đang tải
  const [userDoc, setUserDoc] = useState(undefined);
  const [fieldConfig, setFieldConfig] = useState({});
  const [settings, setSettings] = useState({ companyName: 'Hệ thống kho & vận tải' });

  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u || null)), []);

  const email = user?.email?.toLowerCase() || '';
  const isSuper = SUPER_ADMINS.includes(email);

  useEffect(() => {
    if (!email) { setUserDoc(undefined); return; }
    return onSnapshot(doc(db, 'users', email), (s) => setUserDoc(s.exists() ? s.data() : null), () => setUserDoc(null));
  }, [email]);

  const active = userDoc && userDoc.active !== false;
  const allowed = !!user && (isSuper || !!active);
  const role = isSuper ? 'admin' : active ? userDoc.role || 'xem' : '';
  const isAdmin = role === 'admin';
  const myWarehouses = isAdmin ? [] : userDoc?.warehouses || [];

  useEffect(() => {
    if (!allowed) return;
    const u1 = onSnapshot(doc(db, 'settings', 'fields'), (s) => setFieldConfig(s.exists() ? s.data() : {}));
    const u2 = onSnapshot(doc(db, 'settings', 'general'), (s) => s.exists() && setSettings((p) => ({ ...p, ...s.data() })));
    return () => { u1(); u2(); };
  }, [allowed]);

  const fieldsOf = useCallback((key) => mergeFields(key, fieldConfig[key]), [fieldConfig]);

  // Kho người dùng được thao tác (mảng rỗng = tất cả)
  const inMyWarehouses = useCallback((wh) => !myWarehouses.length || myWarehouses.includes(wh), [myWarehouses]);

  const canEdit = useCallback((cat, row) => {
    if (isAdmin) return true;
    if (cat.adminOnly || !cat.editRoles?.includes(role)) return false;
    return !cat.warehouseField || !row || inMyWarehouses(row[cat.warehouseField]);
  }, [isAdmin, role, inMyWarehouses]);

  // Thiết lập biểu mẫu (thêm / sửa trường): quản trị hoặc người được cấp quyền
  const canDesign = isAdmin || userDoc?.formDesigner === true;
  const hasRole = useCallback((...roles) => isAdmin || roles.includes(role), [isAdmin, role]);

  const value = useMemo(() => ({
    user, email, role, isAdmin, isSuper, canDesign, allowed, myWarehouses, inMyWarehouses, canEdit, hasRole,
    name: userDoc?.name || user?.displayName || email,
    fieldConfig, fieldsOf, settings,
    loading: user === undefined || (!!user && userDoc === undefined && !isSuper),
    logout: () => signOut(auth),
  }), [user, email, role, isAdmin, canDesign, allowed, myWarehouses, inMyWarehouses, canEdit, hasRole, userDoc, fieldConfig, fieldsOf, settings, isSuper]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
