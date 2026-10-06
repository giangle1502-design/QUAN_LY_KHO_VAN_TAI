import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { arrayUnion, doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useOpWarehouse, useTrips } from '../../lib/hooks';
import { ST, STATUS_META, afterExit, afterProcess, matchesTrip, nowISO } from '../../lib/trips';
import { TripCard, WarehousePicker } from '../../components/TripBits';
import { Empty, ErrorBox } from '../../components/ui';

// Cập nhật chuyến xe + ghi lịch sử thao tác
export function useTripAction() {
  const { email, name } = useApp();
  const [err, setErr] = useState('');
  const run = async (trip, patch, action) => {
    setErr('');
    try {
      const at = nowISO();
      await updateDoc(doc(db, 'trips', trip.id), {
        ...patch,
        updatedAt: at, updatedBy: email,
        history: arrayUnion({ at, by: email, byName: name, action, status: patch.status || trip.status }),
      });
    } catch (e) {
      setErr(e.code === 'permission-denied' ? 'Bạn không có quyền thực hiện bước này.' : e.message);
    }
  };
  return [run, err];
}

function Section({ title, count, children }) {
  return (
    <div className="section">
      <div className="section-head">{title} <span className="count">{count}</span></div>
      {children}
    </div>
  );
}

function OpsHead({ title, wh, setWh, q, setQ }) {
  return (
    <>
      <div className="page-head"><h1>{title}</h1></div>
      <div className="toolbar">
        <WarehousePicker value={wh} onChange={setWh} />
        <input type="search" placeholder="Tìm biển số, tài xế, khách, mã chuyến…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
    </>
  );
}

const byTime = (k) => (a, b) => String(a[k] || '').localeCompare(String(b[k] || ''));

// ---------------------------------------------------------------- Bảo vệ
export function Guard() {
  const [wh, setWh] = useOpWarehouse();
  const [q, setQ] = useState('');
  const { rows, error } = useTrips([ST.ARRIVED, ST.WAITING_EXIT], wh);
  const [act, err] = useTripAction();
  const list = rows.filter((t) => t.hasGuard && matchesTrip(t, q));
  const arrived = list.filter((t) => t.status === ST.ARRIVED).sort(byTime('arrivalTime'));
  const exiting = list.filter((t) => t.status === ST.WAITING_EXIT).sort(byTime('processDoneTime'));
  return (
    <div>
      <OpsHead title="🛡️ Bảo vệ cổng" wh={wh} setWh={setWh} q={q} setQ={setQ} />
      <ErrorBox error={error || err} />
      <Section title="Xe đến kho, chờ cho vào cổng" count={arrived.length}>
        {arrived.length ? arrived.map((t) => (
          <TripCard key={t.id} trip={t} timeLabel="Đến" timeValue={t.arrivalTime}>
            <button className="btn primary" onClick={() => act(t, { status: ST.WAITING_GATE, gateConfirmTime: nowISO() }, 'Cho vào cổng')}>Cho vào cổng</button>
          </TripCard>
        )) : <Empty text="Không có xe chờ vào cổng." />}
      </Section>
      <Section title="Xe xuất/nhập xong, chờ ra cổng" count={exiting.length}>
        {exiting.length ? exiting.map((t) => (
          <TripCard key={t.id} trip={t} timeLabel="Xong" timeValue={t.processDoneTime}>
            <button className="btn primary" onClick={() => {
              const status = afterExit(t);
              act(t, { status, gateExitTime: nowISO(), ...(status === ST.COMPLETED ? { deliveryCompleteTime: nowISO() } : {}) }, 'Cho ra cổng');
            }}>Cho ra cổng</button>
          </TripCard>
        )) : <Empty text="Không có xe chờ ra cổng." />}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- Thủ kho
export function Dock() {
  const [wh, setWh] = useOpWarehouse();
  const [q, setQ] = useState('');
  const { rows, error } = useTrips([ST.WAITING_GATE, ST.PROCESSING], wh);
  const docks = useCollection('docks').rows;
  const [act, err] = useTripAction();
  const [pick, setPick] = useState({});
  const list = rows.filter((t) => matchesTrip(t, q));
  const waiting = list.filter((t) => t.status === ST.WAITING_GATE).sort(byTime('gateConfirmTime'));
  const processing = list.filter((t) => t.status === ST.PROCESSING).sort(byTime('dockAssignTime'));
  // Cửa đang có xe (để cảnh báo trùng)
  const busy = useMemo(() => new Map(processing.map((t) => [`${t.warehouse}__${t.dock}`, t.plate])), [processing]);
  const docksOf = (t) => docks.filter((d) => d.warehouse === t.warehouse && d.active !== false
    && (d.usage !== (t.purpose === 'import' ? 'Chỉ xuất' : 'Chỉ nhập')));

  return (
    <div>
      <OpsHead title="📦 Thủ kho điều phối cửa" wh={wh} setWh={setWh} q={q} setQ={setQ} />
      <ErrorBox error={error || err} />
      <Section title="Chờ vào cửa" count={waiting.length}>
        {waiting.length ? waiting.map((t) => {
          const opts = docksOf(t);
          const v = pick[t.id] || '';
          return (
            <TripCard key={t.id} trip={t} timeLabel="Vào cổng" timeValue={t.gateConfirmTime}>
              {opts.length ? (
                <select value={v} onChange={(e) => setPick({ ...pick, [t.id]: e.target.value })}>
                  <option value="">-- Chọn cửa --</option>
                  {opts.map((d) => {
                    const by = busy.get(`${t.warehouse}__${d.code}`);
                    return <option key={d.code} value={d.code}>{d.code}{d.name ? ` – ${d.name}` : ''}{by ? ` (đang có xe ${by})` : ''}</option>;
                  })}
                </select>
              ) : (
                <input placeholder="Số cửa" value={v} onChange={(e) => setPick({ ...pick, [t.id]: e.target.value })} style={{ width: 110 }} />
              )}
              <button className="btn primary" disabled={!v} onClick={() => act(t, { status: ST.PROCESSING, dock: v, dockAssignTime: nowISO() }, `Vào cửa ${v}`)}>Xác nhận cửa</button>
            </TripCard>
          );
        }) : <Empty text="Không có xe chờ vào cửa." />}
      </Section>
      <Section title="Đang xuất/nhập" count={processing.length}>
        {processing.length ? processing.map((t) => (
          <TripCard key={t.id} trip={t} timeLabel="Vào cửa" timeValue={t.dockAssignTime}>
            <Link className="btn" to={`/kho/${t.purpose === 'import' ? 'in' : 'out'}?trip=${t.id}`}>Lập phiếu {t.purpose === 'import' ? 'nhập' : 'xuất'}</Link>
            <button className="btn primary" onClick={() => {
              const status = afterProcess(t);
              const at = nowISO();
              act(t, { status, processDoneTime: at, ...(status === ST.COMPLETED ? { deliveryCompleteTime: at } : {}) }, 'Xuất/nhập xong');
            }}>Xuất/nhập xong</button>
          </TripCard>
        )) : <Empty text="Không có xe đang xuất/nhập." />}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- Giao hàng
export function Delivery() {
  const [wh, setWh] = useOpWarehouse();
  const [q, setQ] = useState('');
  const { rows, error } = useTrips([ST.WAITING_DELIVERY], wh);
  const [act, err] = useTripAction();
  const list = rows.filter((t) => matchesTrip(t, q)).sort(byTime('gateExitTime'));

  const deliver = (t, lineIds) => {
    const at = nowISO();
    const fresh = t.lines.filter((l) => lineIds.includes(l.id) && !l.delivered).map((l) => l.id);
    const lines = t.lines.map((l) => (lineIds.includes(l.id) && !l.delivered ? { ...l, delivered: true, deliveredTime: at } : l));
    const all = lines.every((l) => l.delivered);
    act(t, { lines, ...(all ? { status: ST.COMPLETED, deliveryCompleteTime: at } : {}) },
      `Đã giao ${fresh.join(', ')}`);
  };

  return (
    <div>
      <OpsHead title="✅ Xác nhận giao hàng" wh={wh} setWh={setWh} q={q} setQ={setQ} />
      <ErrorBox error={error || err} />
      <Section title={STATUS_META[ST.WAITING_DELIVERY].label} count={list.length}>
        {list.length ? list.map((t) => (
          <TripCard key={t.id} trip={t} timeLabel="Ra cổng" timeValue={t.gateExitTime || t.processDoneTime}>
            {t.lines.filter((l) => !l.delivered).length > 1 && t.lines.filter((l) => !l.delivered).map((l) => (
              <button key={l.id} className="btn sm" onClick={() => deliver(t, [l.id])}>Đã giao {l.partyCode || l.partyName}</button>
            ))}
            <button className="btn primary" onClick={() => deliver(t, t.lines.map((l) => l.id))}>Giao xong tất cả</button>
          </TripCard>
        )) : <Empty text="Không có chuyến chờ giao hàng." />}
      </Section>
    </div>
  );
}
