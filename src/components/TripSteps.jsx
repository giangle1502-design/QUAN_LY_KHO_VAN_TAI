import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { STEPS, compressImage, doStep } from '../lib/transport';
import { ErrorBox, Modal } from './ui';

// Thực hiện 1 bước của chuyến (tài xế, hoặc điều phối làm thay)
export function StepModal({ t, step, onClose }) {
  const { email, name, myIdCard, userDoc } = useApp();
  const vehicles = useCollection('vehicles').rows.filter((v) => !t.carrier || v.carrier === t.carrier);
  const drivers = useCollection('drivers').rows.filter((d) => !t.carrier || d.carrier === t.carrier);
  const [f, setF] = useState(() => ({ plate: t.plate || '', vehicleType: t.vehicleType || '', idCard: t.idCard || myIdCard || '',
    driverName: t.driverName || (myIdCard ? userDoc?.name || name : ''), driverPhone: t.driverPhone || (myIdCard ? userDoc?.phone || '' : ''), note: '' }));
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
      await doStep(t, step, { email, name }, { ...f, photos });
      onClose(true);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền thực hiện bước này cho chuyến này.' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`${STEPS[step]} · ${t.id}`} onClose={() => onClose(false)}>
      {step === 'reg' && (
        <div className="form-grid">
          <label className="field"><span>Số xe *</span><input list="dl-st-plate" value={f.plate} onChange={(e) => pickPlate(e.target.value)} placeholder="VD: 51C-12345" /></label>
          <label className="field"><span>Loại xe</span><select value={f.vehicleType} onChange={(e) => set('vehicleType', e.target.value)}>
            {['', 'Xe tải', 'Container 20', 'Container 40', 'Đầu kéo + mooc'].map((x) => <option key={x} value={x}>{x || '--'}</option>)}</select></label>
          <label className="field"><span>Số CCCD tài xế *</span><input list="dl-st-driver" value={f.idCard} onChange={(e) => pickDriver(e.target.value)} disabled={!!myIdCard} /></label>
          <label className="field"><span>Họ tên tài xế *</span><input value={f.driverName} onChange={(e) => set('driverName', e.target.value)} /></label>
          <label className="field"><span>Điện thoại</span><input value={f.driverPhone} onChange={(e) => set('driverPhone', e.target.value)} /></label>
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

// Xem ảnh phiếu giao hàng của chuyến
export function PhotoModal({ t, onClose }) {
  const [imgs, setImgs] = useState(null);
  useEffect(() => {
    Promise.all(Array.from({ length: t.photoCount || 0 }, (_, i) => getDoc(doc(db, 'tripPhotos', `${t.id}_${i + 1}`))))
      .then((ss) => setImgs(ss.filter((s) => s.exists()).map((s) => s.data().data))).catch(() => setImgs([]));
  }, [t]);
  return (
    <Modal title={`Ảnh phiếu giao · ${t.id}`} onClose={onClose} wide>
      {!imgs ? <p>Đang tải…</p> : !imgs.length ? <p>Chưa có ảnh.</p>
        : imgs.map((src, i) => <a key={i} href={src} target="_blank" rel="noreferrer"><img src={src} alt="" style={{ maxWidth: '100%', marginBottom: 8, borderRadius: 6 }} /></a>)}
    </Modal>
  );
}
