import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { STEPS, compressImage, doStep } from '../lib/transport';
import { ErrorBox, Modal } from './ui';
import { WithAdd } from './FormTools';
import { driverLink, needsDriverId } from '../lib/dispatch';

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
      await doStep(t, step, { email, name }, { ...f, ...(showDrv ? {} : { idCard: '', driverName: '' }), photos });
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
          <label className="field"><span>Loại xe</span><select value={f.vehicleType} onChange={(e) => set('vehicleType', e.target.value)}>
            {['', 'Xe tải', 'Container 20', 'Container 40', 'Đầu kéo + mooc'].map((x) => <option key={x} value={x}>{x || '--'}</option>)}</select></label>
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

// Link riêng cho tài xế: gửi qua Zalo / tin nhắn, tài xế mở trên điện thoại rồi đăng nhập
export function DriverLinkBox({ compact = false }) {
  const [ok, setOk] = useState('');
  const url = driverLink();
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setOk('Đã copy'); } catch { window.prompt('Copy link này gửi cho tài xế:', url); }
    setTimeout(() => setOk(''), 2000);
  };
  const share = () => navigator.share({ title: 'Link tài xế', text: 'Mở link, đăng nhập bằng email đã được cấp rồi nhập số xe:', url }).catch(() => {});
  if (compact) return <button type="button" className="btn sm" onClick={copy} title={url}>🔗 {ok || 'Copy link tài xế'}</button>;
  return (
    <div className="card driver-link" style={{ marginBottom: 12 }}>
      <div className="section-head">🔗 Link cho tài xế</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input readOnly value={url} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220, fontSize: 16 }} />
        <button type="button" className="btn primary" onClick={copy}>{ok || '📋 Copy link'}</button>
        {typeof navigator !== 'undefined' && navigator.share && <button type="button" className="btn" onClick={share}>📤 Gửi</button>}
      </div>
      <p className="small" style={{ marginBottom: 0 }}>Gửi link này cho tài xế (Zalo, tin nhắn). Tài xế mở trên điện thoại, đăng nhập bằng <b>email đã khai bên dưới</b> (Google, hoặc lần đầu bấm <b>Đăng ký</b> để tự đặt mật khẩu), rồi nhập <b>số xe</b> để nhận chuyến và bấm từng bước.
        Họ tên, CCCD chỉ khai cho tài xế nhóm xe nội bộ (Sơn, Hậu, Quân…) và xe nhà GHA.</p>
    </div>
  );
}
