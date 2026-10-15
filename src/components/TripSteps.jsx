import { useEffect, useState } from 'react';
import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { STEPS, compressImage, doStep } from '../lib/transport';
import { ErrorBox, Modal } from './ui';
import { WithAdd } from './FormTools';
import { driverLink, isSelfPickup, needsDriverId, newLinkToken } from '../lib/dispatch';
import Select from './Select';

// Thực hiện 1 bước của chuyến (tài xế, hoặc điều phối làm thay)
export function StepModal({ t, step, onClose, plate = '', via3pl = false }) {
  const { email, name, myIdCard, userDoc, role } = useApp();
  const carriers = useCollection('carriers').rows;
  // Họ tên, CCCD và danh mục xe chỉ cho xe nội bộ nhóm (Sơn, Hậu, Quân…) và xe nhà GHA; xe dịch vụ, 3PL, khách tự lấy chỉ nhập số xe
  const showDrv = needsDriverId(carriers.find((c) => c.code === t.carrier) || { kind: t.carrierKind }, via3pl || role === 'tpl');
  const vehicles = useCollection(showDrv ? 'vehicles' : '').rows.filter((v) => !t.carrier || v.carrier === t.carrier);
  const drivers = useCollection(showDrv ? 'drivers' : '').rows.filter((d) => !t.carrier || d.carrier === t.carrier);
  const [f, setF] = useState(() => ({ plate: t.plate || plate || '', vehicleType: t.vehicleType || '', idCard: t.idCard || myIdCard || '',
    driverName: t.driverName || (myIdCard || role === 'tai_xe' ? userDoc?.name || name : ''), driverPhone: t.driverPhone || (myIdCard || role === 'tai_xe' ? userDoc?.phone || '' : ''), note: '' }));
  const [photos, setPhotos] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const pickPlate = (v) => { const veh = vehicles.find((x) => x.plate === v.trim().toUpperCase()); setF((x) => ({ ...x, plate: v.toUpperCase(), ...(veh ? { vehicleType: veh.vehicleType || x.vehicleType } : {}) })); };
  const pickDriver = (v) => { const d = drivers.find((x) => x.idCard === v); setF((x) => ({ ...x, idCard: v, ...(d ? { driverName: d.name || '', driverPhone: d.phone || '' } : {}) })); };
  const addPhotos = async (files) => {
    setErr('');
    try { const out = []; for (const fl of files) out.push(await compressImage(fl)); setPhotos((p) => [...p, ...out].slice(0, 4)); } catch (e) { setErr(e.message); }
  };
  const go = async () => {
    setErr(''); setBusy(true);
    try {
      // Tài xế chỉ xác nhận giao nhận; cước do điều phối / kế toán nhập sau (kể cả xe nội bộ)
      await doStep(t, step, role === 'tpl' ? { email, name, as: t.carrierName || t.carrier || 'GHA' } : { email, name }, { ...f, ...(showDrv ? {} : { idCard: '', driverName: '' }), photos });
      onClose(true);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền thực hiện bước này cho chuyến này.' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`${STEPS[step]} · ${t.id}`} onClose={() => onClose(false)}>
      {step === 'reg' && (
        <div className="form-grid">
          <p className="small full" style={{ margin: 0 }}>{showDrv ? 'Xe nội bộ: chọn số xe trong danh sách, ghi họ tên và CCCD tài xế.' : 'Chỉ cần nhập số xe (gõ thẳng, không cần có trong danh mục).'}</p>
          <label className="field"><span>Số xe *</span>{showDrv ? <WithAdd cat="vehicles" preset={{ plate: f.plate, vehicleType: f.vehicleType }} onAdded={(id, r) => pickPlate(r?.plate || id)}><input list="dl-st-plate" value={f.plate} onChange={(e) => pickPlate(e.target.value)} placeholder="VD: 51C-12345" /></WithAdd>
            : <input value={f.plate} onChange={(e) => pickPlate(e.target.value)} placeholder="VD: 51C-12345" style={{ fontSize: 18 }} />}</label>
          <label className="field"><span>Loại xe</span><Select value={f.vehicleType} onChange={(e) => set('vehicleType', e.target.value)}>
            {['', 'Xe tải', 'Container 20', 'Container 40', 'Đầu kéo + mooc'].map((x) => <option key={x} value={x}>{x || '--'}</option>)}</Select></label>
          {showDrv && <>
          <label className="field"><span>Số CCCD tài xế</span>{myIdCard ? <input value={f.idCard} disabled /> : <WithAdd cat="drivers" preset={{ idCard: f.idCard, name: f.driverName, phone: f.driverPhone }} onAdded={(id, r) => { pickDriver(r?.idCard || id); if (r?.name) set('driverName', r.name); }}><input list="dl-st-driver" value={f.idCard} onChange={(e) => pickDriver(e.target.value)} /></WithAdd>}</label>
          <label className="field"><span>Họ tên tài xế</span><input value={f.driverName} onChange={(e) => set('driverName', e.target.value)} /></label>
          </>}
          <label className="field"><span>Điện thoại tài xế{showDrv ? '' : ' (nếu có)'}</span><input value={f.driverPhone} onChange={(e) => set('driverPhone', e.target.value)} /></label>
          <datalist id="dl-st-plate">{vehicles.map((v) => <option key={v.plate} value={v.plate}>{v.vehicleType} {v.payload ? `${v.payload} tấn` : ''}</option>)}</datalist>
          <datalist id="dl-st-driver">{drivers.map((d) => <option key={d.idCard} value={d.idCard}>{d.name}</option>)}</datalist>
        </div>
      )}
      {step === 'delivered' && (
        <div>
          <p>Chụp phiếu giao hàng có chữ ký khách (tối đa 4 ảnh).</p>
          <label className="btn primary" style={{ display: 'inline-block' }}>📷 Chụp / chọn ảnh
            <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => addPhotos([...e.target.files])} /></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {photos.map((p, i) => <div key={i} style={{ position: 'relative' }}><img src={p} alt="" style={{ height: 110, borderRadius: 6, border: '1px solid var(--line)' }} />
              <button type="button" className="btn ghost sm" style={{ position: 'absolute', top: 2, right: 2 }} onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))}>✕</button></div>)}
          </div>
        </div>
      )}
      {['arrive', 'loaded', 'atDest'].includes(step) && <p>Xác nhận <b>{STEPS[step].toLowerCase()}</b> lúc này?</p>}
      {step !== 'reg' && <label className="field"><span>Ghi chú</span><input value={f.note} onChange={(e) => set('note', e.target.value)} /></label>}
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={() => onClose(false)}>Thôi</button>
        <button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Đang lưu…' : `✓ ${STEPS[step]}`}</button></div>
    </Modal>
  );
}

// Xem ảnh phiếu giao hàng của chuyến; quản trị, điều phối vận tải, 3PL xóa ảnh chụp sai và thêm ảnh thay thế
export function PhotoModal({ t, onClose }) {
  const { isAdmin, role, email, name } = useApp();
  const canEdit = isAdmin || role === 'van_tai' || role === 'tpl';
  const [imgs, setImgs] = useState(null);
  const [count, setCount] = useState(t.photoCount || 0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const loadImgs = (k) => Promise.all(Array.from({ length: k }, (_, i) => getDoc(doc(db, 'tripPhotos', `${t.id}_${i + 1}`))))
    .then((ss) => setImgs(ss.filter((s) => s.exists()).map((s) => ({ id: s.id, src: s.data().data })))).catch(() => setImgs([]));
  useEffect(() => { loadImgs(t.photoCount || 0); }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  // 3PL: lịch sử ghi tên đơn vị (GHA), admin công ty không thấy tên 3PL
  const who = role === 'tpl' ? t.carrierName || t.carrier || 'GHA' : null;
  const log = (action, k) => updateDoc(doc(db, 'trips', t.id), { photoCount: k, updatedAt: new Date().toISOString(), updatedBy: who || email,
    history: [...(t.history || []), { at: new Date().toISOString(), by: who || email, byName: who || name || email, action }] });
  const del = async (im) => {
    if (!window.confirm('Xóa ảnh này?')) return;
    setErr(''); setBusy(true);
    try { await deleteDoc(doc(db, 'tripPhotos', im.id)); await log('Xóa ảnh phiếu giao', count); setImgs((x) => x.filter((y) => y.id !== im.id)); } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền xóa ảnh (dán lại firestore.rules mới).' : e.message); }
    setBusy(false);
  };
  const add = async (files) => {
    setErr(''); setBusy(true);
    try {
      let k = count;
      for (const f of files) { k += 1; await setDoc(doc(db, 'tripPhotos', `${t.id}_${k}`), { tripId: t.id, carrier: t.carrier || '', data: await compressImage(f), by: email, at: new Date().toISOString() }); }
      await log(`Thêm ảnh phiếu giao (${files.length})`, k); setCount(k); await loadImgs(k);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền thêm ảnh.' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`Ảnh phiếu giao · ${t.id}`} onClose={onClose} wide>
      {canEdit && <div style={{ marginBottom: 8 }}><label className="btn primary" style={{ display: 'inline-block' }}>{busy ? 'Đang lưu…' : '📷 Thêm ảnh thay thế'}
        <input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => add([...e.target.files])} /></label>
        <span className="small"> Tài xế chụp sai: xóa ảnh sai rồi thêm ảnh đúng.</span></div>}
      <ErrorBox error={err} />
      {!imgs ? <p>Đang tải…</p> : !imgs.length ? <p>Chưa có ảnh.</p>
        : imgs.map((im) => <div key={im.id} style={{ position: 'relative', marginBottom: 8 }}><a href={im.src} target="_blank" rel="noreferrer"><img src={im.src} alt="" style={{ maxWidth: '100%', borderRadius: 6 }} /></a>
          {canEdit && <button type="button" className="btn sm" style={{ position: 'absolute', top: 6, right: 6, background: 'var(--red)', color: '#fff' }} disabled={busy} onClick={() => del(im)}>🗑 Xóa ảnh</button>}</div>)}
    </Modal>
  );
}

// Link tài xế của từng đơn vị vận tải: gửi vào nhóm Zalo của đơn vị, tài xế mở là dùng (không cần tài khoản).
// Mỗi đơn vị 1 link; tài xế chạy cho nhiều đơn vị thì dùng link của đơn vị đang chạy. Đổi link: link cũ hết hiệu lực.
export function DriverLinkBox({ compact = false }) {
  const { isAdmin, role, myCarrier, email } = useApp();
  const carriers = useCollection('carriers').rows.filter((c) => !isSelfPickup(c) && c.active !== false && (isAdmin || c.code === myCarrier));
  const [links, setLinks] = useState({});
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');
  const canMake = isAdmin || role === 'van_tai';
  useEffect(() => {
    if (isAdmin) return onSnapshot(collection(db, 'carrierLinks'), (s) => setLinks(Object.fromEntries(s.docs.map((d) => [d.id, d.data().token]))), () => {});
    if (!myCarrier) return undefined;
    return onSnapshot(doc(db, 'carrierLinks', myCarrier), (d) => setLinks(d.exists() ? { [myCarrier]: d.data().token } : {}), () => {});
  }, [isAdmin, myCarrier]);
  const copy = async (code) => {
    const url = driverLink(code, links[code]);
    try { await navigator.clipboard.writeText(url); setOk(code); setTimeout(() => setOk(''), 2000); } catch { window.prompt('Copy link này gửi nhóm Zalo:', url); }
  };
  const make = async (code) => {
    if (links[code] && !window.confirm(`Đổi link của ${code}? Link cũ sẽ không dùng được nữa, phải gửi lại link mới vào nhóm Zalo.`)) return;
    setErr('');
    try { await setDoc(doc(db, 'carrierLinks', code), { token: newLinkToken(), at: new Date().toISOString(), by: email }); } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền tạo link (dán lại firestore.rules mới).' : e.message); }
  };
  if (compact) {
    const code = myCarrier;
    return code && links[code] ? <button type="button" className="btn sm" onClick={() => copy(code)}>🔗 {ok === code ? 'Đã copy' : 'Copy link tài xế'}</button> : null;
  }
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="section-head">🔗 Link tài xế (gửi nhóm Zalo của đơn vị vận tải)</div>
      <p className="small" style={{ marginTop: 0 }}>Tài xế bấm link → nhập <b>số xe</b> → (nhóm xe nội bộ, xe nhà GHA: ghi họ tên, CCCD nếu điều phối chưa nhập) → Đến điểm nhận hàng → Lấy hàng xong → Đến điểm giao hàng → Hoàn thành (chụp phiếu giao). <b>Không cần tài khoản, không cần đăng nhập.</b> Tài xế chạy cho nhiều đơn vị thì mở link của đơn vị đang chạy.</p>
      <ErrorBox error={err} />
      <div className="table-wrap"><table><tbody>{carriers.map((c) => (
        <tr key={c.code}><td><b>{c.code}</b> – {c.name}</td>
          <td className="small" style={{ wordBreak: 'break-all' }}>{links[c.code] ? driverLink(c.code, links[c.code]) : 'chưa có link'}</td>
          <td className="nowrap">{links[c.code] && <button type="button" className="btn primary sm" onClick={() => copy(c.code)}>{ok === c.code ? 'Đã copy' : '📋 Copy link'}</button>}{' '}
            {canMake && <button type="button" className="btn sm" onClick={() => make(c.code)}>{links[c.code] ? 'Đổi link' : 'Tạo link'}</button>}</td></tr>))}</tbody></table></div>
    </div>
  );
}
