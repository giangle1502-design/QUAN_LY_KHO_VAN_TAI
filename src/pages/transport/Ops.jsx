import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { arrayUnion, doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpWarehouse, useTrips } from '../../lib/hooks';
import { ST, STATUS_META, afterExit, afterProcess, fmtTime, matchesTrip, noYard, nowISO, vnDate } from '../../lib/trips';
import { plateKey } from '../../lib/transport';
import { fmtDate } from '../../lib/utils';
import { TripCard, WarehousePicker } from '../../components/TripBits';
import { Empty, ErrorBox } from '../../components/ui';
import Select from '../../components/Select';
import { QuickAdd, WithAdd } from '../../components/FormTools';
import { locWh } from '../../lib/whGroups';

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
// Gom các chuyến cùng số xe (Job / nhiều Shipment trên 1 xe) thành 1 thẻ: bảo vệ bấm 1 lần
export function groupByPlate(list) {
  const m = new Map();
  for (const t of list) {
    const k = plateKey(t.plate) || t.id;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m.values()];
}
const minOf = (ts, k) => ts.map((t) => t[k] || '').filter(Boolean).sort()[0] || '';

// Bảo vệ (hoặc quản trị làm thay): xe đã đến kho → ghi giờ đăng ký, thủ kho gọi vào cửa theo thứ tự này
export async function guardArrive(act, trips) {
  const at = nowISO();
  for (const t of trips) {
    await act(t, { status: ST.WAITING_GATE, gateConfirmTime: at, ...(t.arrivalTime ? {} : { arrivalTime: at, arrivalDate: vnDate(at) }) }, 'Bảo vệ xác nhận xe đã đến kho (xếp tài)');
  }
}
// Bảo vệ (hoặc quản trị làm thay): xe ra cổng
export async function guardExit(act, trips) {
  const at = nowISO();
  for (const t of trips) {
    const status = afterExit(t);
    await act(t, { status, gateExitTime: at, ...(status === ST.COMPLETED ? { deliveryCompleteTime: at } : {}) }, 'Bảo vệ xác nhận xe ra cổng');
  }
}

// Quản trị hủy chuyến (xe đã đăng ký nhưng không lấy hàng): chọn lý do trong danh mục Lý do (+ thêm nhanh)
export function CancelTrip({ trips, act }) {
  const { isAdmin } = useApp();
  const reasons = useCollection('reasons').rows.filter((r) => r.appliesTo === 'Hủy chuyến');
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState('');
  if (!isAdmin) return null;
  if (!open) return <button className="btn ghost sm" title="Xe đã đăng ký nhưng không lấy hàng" onClick={() => setOpen(true)}>✕ Hủy chuyến</button>;
  return (
    <span className="cell-add" style={{ gap: 4 }}>
      <Select value={why} onChange={(e) => setWhy(e.target.value)}>
        <option value="">-- Lý do hủy --</option>
        {reasons.map((r) => <option key={r.code} value={`${r.code} – ${r.name}`}>{r.name}</option>)}
        <option value="Khác">Khác</option>
      </Select>
      <QuickAdd catKey="reasons" preset={{ appliesTo: 'Hủy chuyến' }} onAdded={(id, r) => setWhy(`${id} – ${r?.name || ''}`)} />
      <button className="btn danger sm" disabled={!why} onClick={async () => {
        if (!window.confirm(`Hủy ${trips.length > 1 ? `${trips.length} chuyến của xe` : 'chuyến'} ${trips[0].plate || trips[0].id}?`)) return;
        const at = nowISO();
        for (const t of trips) await act(t, { status: ST.CANCELLED, cancelReason: why, cancelTime: at }, `Hủy chuyến: ${why}`);
        setOpen(false);
      }}>Hủy</button>
      <button className="btn ghost sm" onClick={() => setOpen(false)}>Thôi</button>
    </span>
  );
}

// Thẻ xe cho bảo vệ: biển số thật to, ít chữ, 1 nút lớn
function GuardCard({ trips, stt, time, children, note }) {
  const t = trips[0];
  const parties = [...new Set(trips.flatMap((x) => (x.lines || []).map((l) => l.partyName || l.partyCode)).filter(Boolean))];
  return (
    <div className="guard-card">
      <div className="guard-top">
        {stt ? <span className="guard-stt">{stt}</span> : null}
        <span className="guard-plate">{t.plate || '(chưa có số xe)'}</span>
        <span className={'badge ' + (t.purpose === 'import' ? 'teal' : 'blue')}>{t.purpose === 'import' ? '⬇ Nhập hàng' : '⬆ Lấy hàng'}</span>
      </div>
      <div className="guard-info">
        {t.driverName ? <div>👤 <b>{t.driverName}</b>{t.idCard ? ` · CCCD ${t.idCard}` : ''}{t.driverPhone ? ` · ☎ ${t.driverPhone}` : ''}</div> : null}
        {t.carrierName ? <div>🚚 {t.carrierName}</div> : null}
        {parties.length ? <div>🏢 {parties.join(', ')}</div> : null}
        {time ? <div className="small">🕒 {time}</div> : null}
        {note ? <div className="guard-note">{note}</div> : null}
      </div>
      <div className="guard-acts">{children}</div>
    </div>
  );
}

export function Guard() {
  const { isAdmin } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const myWhs = useMyWarehouses();
  const [tab, setTab] = useState('in');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const { rows, error } = useTrips([ST.PLANNED, ST.ARRIVED, ST.WAITING_GATE, ST.PROCESSING, ST.WAITING_EXIT], wh);
  const [act, err] = useTripAction();
  // Chỉ chuyến của kho có bảo vệ, chưa hoàn thành; chuyến kế hoạch phải có số xe (bảo vệ tìm theo số xe)
  const all = rows.filter((t) => t.hasGuard && !noYard(t) && (t.status !== ST.PLANNED || t.plate));
  const k = plateKey(q);
  const hit = (t) => !q || (k && plateKey(t.plate).includes(k)) || matchesTrip(t, q);
  const toIn = groupByPlate(all.filter((t) => [ST.PLANNED, ST.ARRIVED].includes(t.status) && hit(t)))
    .sort((a, b) => (minOf(a, 'arrivalTime') ? 0 : 1) - (minOf(b, 'arrivalTime') ? 0 : 1)
      || (minOf(a, 'arrivalTime') || minOf(a, 'plannedDate')).localeCompare(minOf(b, 'arrivalTime') || minOf(b, 'plannedDate')));
  const queue = groupByPlate(all.filter((t) => t.status === ST.WAITING_GATE))
    .sort((a, b) => minOf(a, 'gateConfirmTime').localeCompare(minOf(b, 'gateConfirmTime')));
  const outAll = all.filter((t) => t.status === ST.WAITING_EXIT);
  const toOut = groupByPlate(outAll.filter(hit)).sort((a, b) => minOf(a, 'processDoneTime').localeCompare(minOf(b, 'processDoneTime')));
  const stillIn = (g) => all.filter((t) => plateKey(t.plate) && plateKey(t.plate) === plateKey(g[0].plate) && [ST.WAITING_GATE, ST.PROCESSING].includes(t.status)).length;
  const run = async (key, fn) => { setBusy(key); try { await fn(); setQ(''); } finally { setBusy(''); } };

  return (
    <div className="guard-page">
      <div className="page-head"><h1>🛡️ Bảo vệ cổng</h1>{(isAdmin || myWhs.length > 1) && <WarehousePicker value={wh} onChange={setWh} />}</div>
      <div className="guard-tabs">
        <button className={tab === 'in' ? 'on' : ''} onClick={() => setTab('in')}>🚚 Xe chờ vào kho <span className="count">{toIn.length}</span></button>
        <button className={tab === 'out' ? 'on' : ''} onClick={() => setTab('out')}>🚪 Xe chờ ra cổng <span className="count">{groupByPlate(outAll).length}</span></button>
      </div>
      <input className="guard-search" type="search" inputMode="search" placeholder="🔍 Nhập số xe (vd 51C12345)" value={q} onChange={(e) => setQ(e.target.value)} />
      <ErrorBox error={error || err} />
      {tab === 'in' ? (
        <>
          {toIn.length ? toIn.map((g) => (
            <GuardCard key={g[0].id} trips={g}
              time={g.some((t) => t.status === ST.ARRIVED) ? `Tài xế báo đến lúc ${fmtTime(minOf(g, 'arrivalTime'))}` : g[0].plannedDate ? `Ngày dự kiến ${fmtDate(g[0].plannedDate)}` : ''}>
              <button className="btn guard-btn" disabled={!!busy} onClick={() => window.confirm(`Xe ${g[0].plate} đã đến kho?`) && run(g[0].id, () => guardArrive(act, g))}>
                {busy === g[0].id ? 'Đang lưu…' : '✅ XE ĐÃ ĐẾN KHO'}
              </button>
              <CancelTrip trips={g} act={act} />
            </GuardCard>
          )) : <Empty text={q ? `Không thấy xe "${q}" trong danh sách chờ vào. Xe chưa có số xe hoặc chưa được giao chuyến: báo quản trị / điều phối.` : 'Không có xe chờ vào kho.'} />}
          <div className="section-head" style={{ marginTop: 16 }}>Thứ tự xe đã vào (thủ kho gọi vào cửa theo số này) <span className="count">{queue.length}</span></div>
          {queue.length ? (
            <div className="guard-queue">
              {queue.map((g, i) => <div key={g[0].id}><span className="guard-stt sm">{i + 1}</span><b className="plate">{g[0].plate}</b> <span className="small">{fmtTime(minOf(g, 'gateConfirmTime'))}</span></div>)}
            </div>
          ) : <Empty text="Chưa có xe nào đang chờ thủ kho." />}
          {(isAdmin || myWhs.length) ? <div className="small" style={{ marginTop: 12 }}>Xe không có trong danh sách (xe nhập hàng, khách đến không báo trước): <Link to="/xe/dang-ky">+ Đăng ký xe tại cổng</Link></div> : null}
        </>
      ) : (
        toOut.length ? toOut.map((g) => {
          const left = stillIn(g);
          return (
            <GuardCard key={g[0].id} trips={g} time={`Thủ kho báo xong lúc ${fmtTime(minOf(g, 'processDoneTime'))}${g[0].dock ? ` · cửa ${g[0].dock}` : ''}`}
              note={left ? `⚠ Xe này còn ${left} chuyến chưa xuất/nhập xong` : ''}>
              <button className="btn guard-btn" disabled={!!busy} onClick={() => window.confirm(`Cho xe ${g[0].plate} ra cổng?`) && run(g[0].id, () => guardExit(act, g))}>
                {busy === g[0].id ? 'Đang lưu…' : '🚪 XÁC NHẬN XE RA CỔNG'}
              </button>
            </GuardCard>
          );
        }) : <Empty text={q ? `Không thấy xe "${q}" đang chờ ra cổng.` : 'Không có xe chờ ra cổng.'} />
      )}
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
  const list = rows.filter((t) => !noYard(t) && matchesTrip(t, q));
  const waiting = list.filter((t) => t.status === ST.WAITING_GATE).sort(byTime('gateConfirmTime'));
  const processing = list.filter((t) => t.status === ST.PROCESSING).sort(byTime('dockAssignTime'));
  // Cửa đang có xe (để cảnh báo trùng)
  const busy = useMemo(() => new Map(processing.map((t) => [`${locWh(t.warehouse)}__${t.dock}`, t.plate])), [processing]);
  const docksOf = (t) => docks.filter((d) => (d.warehouse === t.warehouse || d.warehouse === locWh(t.warehouse)) && d.active !== false
    && (d.usage !== (t.purpose === 'import' ? 'Chỉ xuất' : 'Chỉ nhập')));

  return (
    <div>
      <OpsHead title="📦 Thủ kho điều phối cửa" wh={wh} setWh={setWh} q={q} setQ={setQ} />
      <div className="small" style={{ margin: '-4px 0 10px' }}>Việc của thủ kho: ① chỉ định cửa cho xe theo thứ tự bảo vệ đã xếp · ② bấm <b>Xuất/nhập xong</b> · ③ <Link to="/kho/kiem-ke">🧮 Kiểm kê / cycle count</Link></div>
      <ErrorBox error={error || err} />
      <Section title="Chờ vào cửa (theo thứ tự xếp tài)" count={waiting.length}>
        {waiting.length ? waiting.map((t, i) => {
          const opts = docksOf(t);
          const v = pick[t.id] || '';
          return (
            <TripCard key={t.id} trip={t} timeLabel={`STT ${i + 1} · đăng ký`} timeValue={t.gateConfirmTime}>
              {opts.length ? (
                <WithAdd cat="docks" preset={{ warehouse: locWh(t.warehouse) }} onAdded={(id, r) => setPick({ ...pick, [t.id]: r?.code || String(id).split('__').pop() })}>
                <Select value={v} onChange={(e) => setPick({ ...pick, [t.id]: e.target.value })}>
                  <option value="">-- Chọn cửa --</option>
                  {opts.map((d) => {
                    const by = busy.get(`${locWh(t.warehouse)}__${d.code}`);
                    return <option key={d.code} value={d.code}>{d.code}{d.name ? ` – ${d.name}` : ''}{by ? ` (đang có xe ${by})` : ''}</option>;
                  })}
                </Select>
                </WithAdd>
              ) : (
                <WithAdd cat="docks" preset={{ warehouse: locWh(t.warehouse) }} onAdded={(id, r) => setPick({ ...pick, [t.id]: r?.code || String(id).split('__').pop() })}>
                  <input placeholder="Số cửa" value={v} onChange={(e) => setPick({ ...pick, [t.id]: e.target.value })} style={{ width: 110 }} />
                </WithAdd>
              )}
              <button className="btn primary" disabled={!v} onClick={async () => {
                // Cùng xe (Job / nhiều Shipment): vào chung 1 cửa
                const at = nowISO();
                const same = waiting.filter((x) => x.id === t.id || (plateKey(t.plate) && plateKey(x.plate) === plateKey(t.plate)));
                for (const x of same) await act(x, { status: ST.PROCESSING, dock: v, dockAssignTime: at }, `Vào cửa ${v}`);
              }}>Xác nhận cửa</button>
              <CancelTrip trips={[t]} act={act} />
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
