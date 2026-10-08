import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db, SUPER_ADMINS } from '../firebase';
import { canSeeField, mergeFields, visibleFields } from '../lib/fields';

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
  // Điều phối vận tải / tài xế thuộc 1 đơn vị vận tải
  const myCarrier = ['van_tai', 'tai_xe'].includes(role) ? userDoc?.carrier || '' : '';
  const myIdCard = role === 'tai_xe' ? userDoc?.idCard || '' : '';
  const [carrierDoc, setCarrierDoc] = useState(null);
  useEffect(() => {
    if (!myCarrier) { setCarrierDoc(null); return; }
    return onSnapshot(doc(db, 'carriers', myCarrier), (s) => setCarrierDoc(s.exists() ? s.data() : null), () => setCarrierDoc(null));
  }, [myCarrier]);
  // 3PL chỉ GHA (đơn vị vận tải được dùng 3PL) và quản trị gốc thấy, admin khách không thấy
  const can3PL = isSuper || (role === 'van_tai' && carrierDoc?.uses3PL === true);
  const inMyWarehouses = useCallback((wh) => !myWarehouses.length || myWarehouses.includes(wh), [myWarehouses]);

  const canEdit = useCallback((cat, row) => {
    if (cat.only3PL && !can3PL) return false;
    if (isAdmin) return true;
    if (cat.adminOnly || !cat.editRoles?.includes(role)) return false;
    // Đơn vị vận tải chỉ sửa xe, tài xế của đơn vị mình
    if (role === 'van_tai') return !!myCarrier && (!cat.carrierField || !row || row[cat.carrierField] === myCarrier);
    return !cat.warehouseField || !row || inMyWarehouses(row[cat.warehouseField]);
  }, [isAdmin, role, inMyWarehouses, myCarrier, can3PL]);

  // Thiết lập biểu mẫu (thêm / sửa trường): quản trị hoặc người được cấp quyền
  const canDesign = isAdmin || userDoc?.formDesigner === true;
  const hasRole = useCallback((...roles) => isAdmin || roles.includes(role), [isAdmin, role]);
  // Kinh doanh chỉ thấy đơn SO/PO có Sale phụ trách là mình (trừ người được cho xem đơn của mọi sale)
  const salesOnly = role === 'kinh_doanh' && userDoc?.seeAllOrders !== true;
  // Trường chỉ người được chỉ định xem
  const seeField = useCallback((f) => canSeeField(f, { isAdmin, email, role }), [isAdmin, email, role]);
  const seenFieldsOf = useCallback((key, ...others) => visibleFields(fieldsOf(key), { isAdmin, email, role }, ...others), [fieldsOf, isAdmin, email, role]);

  const value = useMemo(() => ({
    user, email, role, isAdmin, isSuper, canDesign, allowed, myWarehouses, inMyWarehouses, canEdit, hasRole, myCarrier, myIdCard, carrierDoc, can3PL, userDoc,
    name: userDoc?.name || user?.displayName || email,
    fieldConfig, fieldsOf, settings, salesOnly, seeField, seenFieldsOf,
    loading: user === undefined || (!!user && userDoc === undefined && !isSuper),
    logout: () => signOut(auth),
  }), [user, email, role, isAdmin, canDesign, allowed, myWarehouses, inMyWarehouses, canEdit, hasRole, myCarrier, myIdCard, carrierDoc, can3PL, userDoc, fieldConfig, fieldsOf, settings, isSuper, salesOnly, seeField, seenFieldsOf]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
