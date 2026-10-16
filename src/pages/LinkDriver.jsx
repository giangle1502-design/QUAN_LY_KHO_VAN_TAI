import { useEffect, useState } from 'react';
import { signInAnonymously } from 'firebase/auth';
import { collection, doc, getDoc, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import { txFirebase } from '../firebase';
import { STATUS_META, fmtTime } from '../lib/trips';
import { STEPS, compressImage, doStep, nextStep, plateKey, stepBlocked, tripKg } from '../lib/transport';
import { fmtDate, fmtNum } from '../lib/utils';
import { navUrl } from '../lib/dispatch';

// ============================================================================
// Link tài xế (gửi vào nhóm Zalo của đơn vị vận tải), không cần tài khoản:
// mở link → nhập số xe → (xe nội bộ nhóm / xe nhà GHA: ghi họ tên, CCCD nếu điều phối chưa nhập)
// → Đến điểm nhận hàng → Lấy hàng xong → Đến điểm giao hàng → Hoàn thành (chụp phiếu giao).
// Link dạng /tx/<mã đơn vị>/<mã bí mật>; quản trị đổi mã là link cũ hết hiệu lực.
// ============================================================================
const n = (v) => Number(v) || 0;
const KEY = 'tx-driver';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const keep = (v) => { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...v })); } catch { /* bỏ qua */ } };
// Họ tên, CCCD chỉ cho nhóm xe nội bộ và xe nhà GHA
const needsId = (t) => ['Nội bộ', 'GHA'].includes(t.carrierKind);
const big = { width: '100%', marginTop: 8, padding: 14, fontSize: 17 };

export default function LinkDriver() {
  const [, , code = '', token = ''] = window.location.pathname.split('/');
  const { auth, db } = txFirebase();
  const [state, setState] = useState('loading'); // loading | ok | bad | noanon
  const [carrierName, setCarrierName] = useState('');
  const [trips, setTrips] = useState([]);
  const [plate, setPlate] = useState(() => load().plate || '');
  const [me, setMe] = useState(() => ({ driverName: load().driverName || '', idCard: load().idCard || '', driverPhone: load().driverPhone || '' }));
  const [vehicles, setVehicles] = useState([]);
  const [open, setOpen] = useState(null); // { t, st }
  const [photos, setPhotos] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      try {
        const cred = auth.currentUser || (await signInAnonymously(auth)).user;
        await setDoc(doc(db, 'txSessions', cred.uid), { carrier: decodeURIComponent(code), token, at: new Date().toISOString() });
        const c = await getDoc(doc(db, 'carriers', decodeURIComponent(code))).catch(() => null);
        setCarrierName(c?.exists() ? c.data().name || code : code);
        unsub = onSnapshot(query(collection(db, 'trips'), where('carrier', '==', decodeURIComponent(code))),
          (s) => { setTrips(s.docs.map((d) => ({ ...d.data(), id: d.id })).filter((t) => t.source === 'plan').sort((a, b) => String(a.plannedDate + a.id).localeCompare(String(b.plannedDate + b.id)))); setState('ok'); },
          () => setState('bad'));
        onSnapshot(query(collection(db, 'vehicles'), where('carrier', '==', decodeURIComponent(code))), (s) => setVehicles(s.docs.map((d) => d.data())), () => {});
      } catch (e) {
        setState(['auth/operation-not-allowed', 'auth/admin-restricted-operation'].includes(e.code) ? 'noanon' : 'bad');
      }
    })();
    return () => unsub();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pk = plateKey(plate);
  const mine = pk ? trips.filter((t) => plateKey(t.plate) === pk && !['completed', 'cancelled'].includes(t.status)) : [];
  const free = trips.filter((t) => !t.plate && t.status === 'planned');
  const done = pk ? trips.filter((t) => plateKey(t.plate) === pk && t.status === 'completed').slice(-3).reverse() : [];
  // Xe nội bộ / xe nhà GHA: điều phối chưa ghi tài xế thì tài xế tự đăng ký họ tên, CCCD trước khi chạy
  const stepOf = (t) => { const st = nextStep(t); return st === 'arrive' && needsId(t) && !t.driverName ? 'reg' : st; };
  const setM = (k, v) => setMe((x) => ({ ...x, [k]: v }));

  const go = async () => {
    const { t, st } = open;
    setErr(''); setBusy(true);
    try {
      if (st === 'reg' && needsId(t) && !me.driverName.trim()) throw new Error('Nhập họ tên tài xế.');
      const p = t.plate || plate;
      if (!plateKey(p)) throw new Error('Nhập số xe ở ô trên cùng trước.');
      const info = needsId(t) ? me : { driverName: '', idCard: '', driverPhone: me.driverPhone };
      await doStep(t, st, { email: `link:${plateKey(p)}`, name: me.driverName || `Tài xế xe ${p}` }, { ...info, plate: p, photos }, db);
      keep({ plate, ...me });
      setOpen(null); setPhotos([]);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không lưu được: link đã đổi hoặc chuyến này không còn của xe bạn. Báo điều phối.' : e.message); }
    setBusy(false);
  };
  const addPhotos = async (files) => {
    setErr('');
    try { const out = []; for (const f of files) out.push(await compressImage(f)); setPhotos((p) => [...p, ...out].slice(0, 4)); } catch (e) { setErr(e.message); }
  };

  const card = (t, claim) => {
    const st = claim ? 'reg' : stepOf(t); const blocked = st && !claim && stepBlocked(t, st);
    const isOpen = open?.t.id === t.id;
    const label = claim ? `✋ Nhận chuyến này cho xe ${plate}` : st === 'reg' ? (t.plate ? '🪪 Đăng ký tài xế' : STEPS.reg) : STEPS[st];
    return (
      <div key={t.id} className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <b className="mono">{t.id}</b><span className={'badge ' + (STATUS_META[t.status]?.tone || '')}>{t.selfPickup && t.status === 'completed' ? 'Đã lấy xong' : STATUS_META[t.status]?.label}</span></div>
        <div>Ngày đi: <b>{fmtDate(t.plannedDate)}</b>{t.plate ? <> · Xe <b>{t.plate}</b></> : null}</div>
        {/* Nơi nhận hàng: điểm nhận (cảng…) hoặc kho; vị trí lấy hàng (cảng SP-ITC, kho mua nội địa…) có địa chỉ riêng thì chỉ đường tới vị trí */}
        {t.pickup ? <div>Nơi nhận hàng: <b>{t.pickupName || t.pickup}</b>
          {t.pickupAddress && <div className="small">Địa chỉ: {t.pickupAddress}</div>}
          {navUrl({ mapLink: t.pickupMap, address: t.pickupAddress }) && <div className="small"><a href={navUrl({ mapLink: t.pickupMap, address: t.pickupAddress })} target="_blank" rel="noreferrer">📍 Chỉ đường đến điểm nhận</a></div>}</div>
          : <div>Nơi nhận hàng: <b>{t.warehouseName || t.warehouse}</b>
          {t.warehouseAddress && <div className="small">Địa chỉ: {t.warehouseAddress}</div>}
          {!t.pickupLocAddress && !t.pickupLocMap && navUrl({ mapLink: t.warehouseMap, address: t.warehouseAddress }) && <div className="small"><a href={navUrl({ mapLink: t.warehouseMap, address: t.warehouseAddress })} target="_blank" rel="noreferrer">📍 Chỉ đường đến kho</a></div>}</div>}
        {t.pickupLocation && <div className="small">Vị trí lấy hàng: <b>{t.pickupLocation}</b>{t.pickupLocAddress ? <> · {t.pickupLocAddress}</> : null}
          {navUrl({ mapLink: t.pickupLocMap, address: t.pickupLocAddress }) && <> · <a href={navUrl({ mapLink: t.pickupLocMap, address: t.pickupLocAddress })} target="_blank" rel="noreferrer">📍 Chỉ đường đến vị trí</a></>}</div>}
        {[...new Map(t.lines.map((l) => [`${l.partyCode}|${l.shipCode}`, l])).values()].map((l) => {
          const nav = navUrl({ mapLink: l.mapLink, address: l.address });
          return (
            <div key={`${l.partyCode}${l.shipCode}`} style={{ marginTop: 4 }}>Giao đến: <b>{l.partyName || l.partyCode}</b>
              {l.shipCode && <div className="small">Mã giao hàng: <b>{l.shipCode}</b></div>}
              {l.toLocation && <div className="small">Vị trí nhận hàng: <b>{l.toLocation}</b></div>}
              {l.address && <div className="small">Địa chỉ giao: {l.address}</div>}
              {(l.contact || l.contactPhone) && <div className="small">Người nhận: {l.contact}{l.contactPhone ? <> · <a href={`tel:${l.contactPhone}`}>📞 {l.contactPhone}</a></> : null}</div>}
              {nav && <a className="btn" href={nav} target="_blank" rel="noreferrer" style={{ display: 'block', textAlign: 'center', marginTop: 6, padding: 10, fontSize: 16 }}>📍 Chỉ đường đến điểm giao</a>}
            </div>
          );
        })}
        <div className="small">{t.lines.map((l) => `${l.item} ${fmtNum(n(l.plannedKg) / 1000, 3)} t`).join(' · ')} · Tổng {fmtNum(tripKg(t) / 1000, 3)} tấn</div>
        {t.driverName && <div className="small">Tài xế: {t.driverName}{t.driverPhone ? ` · ${t.driverPhone}` : ''}</div>}
        <div className="small">{[['driverArrivedAt', 'Đến điểm nhận'], ['driverLoadedAt', 'Lấy hàng xong'], ['driverAtDestAt', 'Đến điểm giao'], ['driverDeliveredAt', 'Hoàn thành']].filter(([k]) => t[k]).map(([k, l]) => `${l} ${fmtTime(t[k])}`).join(' · ')}</div>
        {st && (blocked ? <p className="small" style={{ marginBottom: 0 }}>⏳ {blocked}</p>
          : !isOpen && <button className="btn primary" style={big} onClick={() => { setErr(''); setPhotos([]); setOpen({ t, st }); }}>{label}</button>)}
        {isOpen && (
          <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            {st === 'reg' && (needsId(t) ? <>
              <label className="field"><span>Họ tên tài xế *</span><input value={me.driverName} onChange={(e) => setM('driverName', e.target.value)} style={{ fontSize: 17 }} /></label>
              <label className="field"><span>Số CCCD</span><input inputMode="numeric" value={me.idCard} onChange={(e) => setM('idCard', e.target.value)} style={{ fontSize: 17 }} /></label>
              <label className="field"><span>Điện thoại</span><input type="tel" value={me.driverPhone} onChange={(e) => setM('driverPhone', e.target.value)} style={{ fontSize: 17 }} /></label>
            </> : <>
              <p style={{ margin: '0 0 6px' }}>Xác nhận nhận chuyến cho xe <b>{plate}</b>?</p>
              <label className="field"><span>Điện thoại (nếu muốn)</span><input type="tel" value={me.driverPhone} onChange={(e) => setM('driverPhone', e.target.value)} style={{ fontSize: 17 }} /></label>
            </>)}
            {['arrive', 'loaded', 'atDest'].includes(st) && <p style={{ margin: 0 }}>Xác nhận <b>{STEPS[st].toLowerCase()}</b> lúc này?</p>}
            {st === 'delivered' && <div>
              <p style={{ margin: '0 0 6px' }}>Chụp phiếu giao hàng có chữ ký khách (tối đa 4 ảnh).</p>
              <label className="btn" style={{ display: 'inline-block', padding: 12 }}>📷 Chụp / chọn ảnh
                <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => addPhotos([...e.target.files])} /></label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {photos.map((p, i) => <div key={i} style={{ position: 'relative' }}><img src={p} alt="" style={{ height: 110, borderRadius: 6, border: '1px solid var(--line)' }} />
                  <button type="button" className="btn ghost sm" style={{ position: 'absolute', top: 2, right: 2 }} onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))}>✕</button></div>)}
              </div>
            </div>}
            {err && <div className="error-box" style={{ marginTop: 8 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" style={{ ...big, width: '35%' }} onClick={() => setOpen(null)}>Thôi</button>
              <button className="btn primary" style={big} disabled={busy} onClick={go}>{busy ? 'Đang lưu…' : `✓ ${claim ? 'Nhận chuyến' : st === 'reg' && t.plate ? 'Lưu tài xế' : STEPS[st]}`}</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (state === 'loading') return <div className="center">Đang mở…</div>;
  if (state !== 'ok') return (
    <div className="center"><div className="card narrow">
      <h2>🧑‍✈️ Link tài xế</h2>
      <p>{state === 'noanon' ? 'Hệ thống chưa bật đăng nhập ẩn danh (quản trị bật trong Firebase: Authentication → Sign-in method → Anonymous).' : 'Link không đúng hoặc đã được đổi. Hỏi điều phối vận tải link mới.'}</p>
    </div></div>
  );
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: 12 }}>
      <h2 style={{ margin: '4px 0' }}>🧑‍✈️ Tài xế · {carrierName}</h2>
      <label className="field" style={{ marginBottom: 8 }}><span>Số xe bạn đang chạy</span>
        <input list="dl-tx-plates" value={plate} onChange={(e) => { setPlate(e.target.value.toUpperCase()); setOpen(null); }} onBlur={() => keep({ plate })} placeholder="VD: 51C-12345" style={{ fontSize: 20, padding: 12 }} /></label>
      <datalist id="dl-tx-plates">{vehicles.map((v) => <option key={v.plate} value={v.plate}>{v.vehicleType}</option>)}</datalist>
      {vehicles.length > 0 && !vehicles.some((v) => plateKey(v.plate) === pk) && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <span className="small" style={{ width: '100%' }}>Xe của nhóm (bấm để chọn):</span>
        {vehicles.map((v) => <button key={v.plate} type="button" className="btn" style={{ fontSize: 18, padding: '8px 12px' }} onClick={() => { setPlate(v.plate); setOpen(null); keep({ plate: v.plate }); }}>{v.plate}</button>)}</div>}
      {!trips.some((t) => !['completed', 'cancelled'].includes(t.status)) && <p className="small" style={{ background: '#fff7e6', padding: 8, borderRadius: 6 }}>
        Hiện chưa có chuyến nào được giao cho <b>{carrierName}</b>. Hàng chỉ định cho đơn vị vận tải chỉ hiện ở đây sau khi quản trị bấm <b>Giao vận tải</b> (Vận chuyển → Chờ giao vận tải).</p>}
      {!pk ? <p>Nhập số xe để thấy chuyến của xe bạn.</p> : <>
        <p className="small">Bấm nút xanh theo thứ tự: Đến điểm nhận hàng → Lấy hàng xong → Đến điểm giao hàng → Hoàn thành (chụp phiếu giao).</p>
        {mine.length ? mine.map((t) => card(t)) : <p>Xe <b>{plate}</b> chưa có chuyến đang chạy.</p>}
        {free.length > 0 && <><h3 style={{ margin: '14px 0 6px' }}>Chuyến chờ nhận ({free.length})</h3>{free.map((t) => card(t, true))}</>}
        {done.length > 0 && <><h3 style={{ margin: '14px 0 6px' }}>Đã giao gần đây</h3>{done.map((t) => <div key={t.id} className="small">✓ {t.id} · {fmtTime(t.driverDeliveredAt || t.deliveryCompleteTime)} · {t.lines.map((l) => l.partyName).join(', ')}</div>)}</>}
      </>}
    </div>
  );
}
