import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { STATUS_META, fmtTime } from '../../lib/trips';
import { STEPS, nextStep, plateKey, stepBlocked, tripKg } from '../../lib/transport';
import { usePref } from '../../lib/prefs';
import { fmtDate, fmtNum } from '../../lib/utils';
import { Empty, ErrorBox } from '../../components/ui';
import { StepModal } from '../../components/TripSteps';

// Trang tài xế (điện thoại): nhận chuyến của đơn vị, bấm lần lượt từng bước
export default function Driver() {
  const { myCarrier, myIdCard, name } = useApp();
  const [trips, setTrips] = useState([]);
  const [error, setError] = useState('');
  const [step, setStep] = useState(null);
  useEffect(() => onSnapshot(query(collection(db, 'trips'), where('carrier', '==', myCarrier || '-')),
    (s) => setTrips(s.docs.map((d) => ({ ...d.data(), id: d.id })).filter((t) => t.source === 'plan').sort((a, b) => String(a.plannedDate + a.id).localeCompare(String(b.plannedDate + b.id)))),
    (e) => setError(e.message)), [myCarrier]);
  // Tài xế chỉ cần nhập số xe: thấy các chuyến điều phối đã chỉ định cho xe đó, và chuyến chưa có xe để nhận
  const [plate, setPlate] = usePref('driver-plate', '');
  const pk = plateKey(plate);
  const isMine = (t) => (pk && plateKey(t.plate) === pk) || (myIdCard && t.idCard === myIdCard);
  const mine = trips.filter((t) => isMine(t) && !['completed', 'cancelled'].includes(t.status));
  const free = trips.filter((t) => !t.plate && t.status === 'planned');
  const done = trips.filter((t) => isMine(t) && t.status === 'completed').slice(-5).reverse();
  const card = (t, claim) => {
    const st = claim ? 'reg' : nextStep(t); const blocked = st && !claim && stepBlocked(t, st);
    return (
      <div key={t.id} className="card" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <b className="mono">{t.id}</b><span className={'badge ' + (STATUS_META[t.status]?.tone || '')}>{STATUS_META[t.status]?.label}</span></div>
        <div className="small">Ngày {fmtDate(t.plannedDate)} · Kho <b>{t.warehouse}</b> · {fmtNum(tripKg(t) / 1000, 3)} tấn{t.plate ? <> · Xe <b>{t.plate}</b></> : null}</div>
        {t.lines.map((l) => <div key={l.id} className="small">→ {l.partyName || l.partyCode}{l.address ? `, ${l.address}` : ''} · {l.item} {fmtNum(n(l.plannedKg) / 1000, 3)} t</div>)}
        <div className="small">{[['driverArrivedAt', 'Đến điểm nhận'], ['driverLoadedAt', 'Lấy hàng xong'], ['driverAtDestAt', 'Đến điểm giao'], ['driverDeliveredAt', 'Hoàn thành']].filter(([k]) => t[k]).map(([k, l]) => `${l} ${fmtTime(t[k])}`).join(' · ')}</div>
        {st && (blocked ? <p className="small" style={{ marginBottom: 0 }}>⏳ {blocked}</p>
          : <button className="btn primary" style={{ width: '100%', marginTop: 8, padding: 12, fontSize: 16 }} onClick={() => setStep({ t, st })}>{claim ? `✋ Nhận chuyến này${pk ? ` cho xe ${plate}` : ''}` : STEPS[st]}</button>)}
      </div>
    );
  };
  return (
    <div style={{ maxWidth: 560 }}>
      <div className="page-head"><h1>🧑‍✈️ Chuyến của tôi</h1></div>
      {!myCarrier ? <div className="error-box">Tài khoản chưa gắn đơn vị vận tải. Báo điều phối vận tải.</div> : null}
      <label className="field" style={{ marginBottom: 10 }}><span>Số xe bạn đang chạy</span>
        <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="VD: 51C-12345" style={{ fontSize: 18, padding: 10 }} /></label>
      <p className="small">Xin chào {name}. Bấm nút xanh theo thứ tự: Đến điểm nhận hàng → Nhận / lấy hàng xong → Đến điểm giao hàng → Hoàn thành (chụp phiếu giao).</p>
      <ErrorBox error={error} />
      {mine.length ? mine.map((t) => card(t)) : <Empty text="Chưa có chuyến nào đang chạy." />}
      {!pk && !mine.length && <p className="small">Nhập số xe để thấy chuyến điều phối đã giao cho xe của bạn.</p>}
      {free.length > 0 && <><div className="section-head">Chuyến chờ nhận ({free.length})</div>{free.map((t) => card(t, true))}</>}
      {done.length > 0 && <><div className="section-head">Đã giao gần đây</div>{done.map((t) => <div key={t.id} className="small">✓ {t.id} · {fmtTime(t.driverDeliveredAt)} · {t.lines.map((l) => l.partyName).join(', ')}</div>)}</>}
      {step && <StepModal t={step.t} step={step.st} plate={plate} onClose={() => setStep(null)} />}
    </div>
  );
}
const n = (v) => Number(v) || 0;
