import { useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { parseScan, parseTripQr, verifyTripQr } from '../../lib/qr';
import { Link, NavLink } from 'react-router-dom';
import { arrayUnion, doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpWarehouse, useTrips } from '../../lib/hooks';
import { ST, STATUS_META, afterExit, afterProcess, destPhase, fmtTime, inYard, isUnloading, matchesTrip, nowISO, vnDate, waitingIn, yardWh } from '../../lib/trips';
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
    // Xe giao hàng vào kho: bảo vệ xác nhận = xe đến điểm giao
    if (destPhase(t)) await act(t, { status: ST.WAITING_GATE, yard: 'dest', gateConfirmTime: at, driverAtDestAt: at }, 'Bảo vệ xác nhận xe đến điểm giao (xếp tài)');
    else await act(t, { status: ST.WAITING_GATE, gateConfirmTime: at, ...(t.arrivalTime ? {} : { arrivalTime: at, arrivalDate: vnDate(at) }) }, 'Bảo vệ xác nhận xe đã đến kho (xếp tài)');
  }
}
// Bảo vệ (hoặc quản trị làm thay): xe ra cổng
export async function guardExit(act, trips) {
  const at = nowISO();
  for (const t of trips) {
    const status = afterExit(t);
    await act(t, { status, gateExitTime: at, ...(status === ST.COMPLETED && !t.deliveryCompleteTime ? { deliveryCompleteTime: at } : {}) }, 'Bảo vệ xác nhận xe ra cổng');
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
        <span className={'badge ' + (isUnloading(t) || destPhase(t) ? 'teal' : 'blue')}>{isUnloading(t) || destPhase(t) ? '⬇ Giao hàng vào kho' : '⬆ Lấy hàng'}</span>
      </div>
      <div className="guard-info">
        {/* Bảo vệ đối chiếu giấy tờ: tên tài xế, CCCD, đơn vị vận tải */}
        <div>👤 Tài xế: <b>{t.driverName || '—'}</b>{t.driverPhone ? ` · ☎ ${t.driverPhone}` : ''}</div>
        <div>🪪 CCCD: <b>{t.idCard || '—'}</b></div>
        <div>🚚 Vận tải: <b>{t.carrierName || t.carrier || '—'}</b></div>
        {parties.length ? <div>🏢 {parties.join(', ')}</div> : null}
        {time ? <div className="small">🕒 {time}</div> : null}
        {note ? <div className="guard-note">{note}</div> : null}
      </div>
      <div className="guard-acts">{children}</div>
    </div>
  );
}

// Tìm chuyến theo chuỗi quét QR (KVT-<số phiếu>-<số chuyến>, số Job) hoặc số phiếu gõ tay
async function findByScan(raw, all) {
  // QR trên điện thoại tài xế (tự đổi 30 giây): kiểm tra mã còn hạn, đúng chuyến
  const tq = parseTripQr(raw);
  if (tq) {
    const t = all.find((x) => x.id === tq.id);
    if (!t) return { codes: [tq.id], hits: [] };
    const v = await verifyTripQr(tq, t);
    if (v !== 'ok') return { codes: [tq.id], hits: [], err: v === 'expired' ? 'Mã QR đã hết hạn (ảnh chụp cũ?). Bảo tài xế mở lại mã QR trên điện thoại.' : 'Mã QR không đúng. Bảo tài xế mở lại mã QR trên điện thoại.' };
    return { codes: [tq.id], hits: [t] };
  }
  // QR trên phiếu in (dự phòng) hoặc gõ số phiếu / số chuyến
  const codes = parseScan(raw);
  if (!codes.length) return { codes, hits: [] };
  let hits = all.filter((t) => codes.includes(t.id) || (t.jobId && codes.includes(t.jobId)));
  if (!hits.length) {
    for (const c of codes) {
      const s = await getDoc(doc(db, 'movements', c)).catch(() => null);
      if (!s?.exists()) continue;
      const m = s.data();
      hits = m.tripId ? all.filter((t) => t.id === m.tripId) : [];
      // Phiếu chưa gắn chuyến: tìm theo số xe ghi trên phiếu
      if (!hits.length && m.plate) hits = all.filter((t) => plateKey(t.plate) === plateKey(m.plate));
      if (hits.length) break;
    }
  }
  return { codes, hits };
}

// Quét QR bằng camera điện thoại (máy scan cầm tay gõ thẳng vào ô quét, không cần mở camera)
function CameraScan({ onCode, onClose }) {
  const videoRef = useRef(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream; let raf; let stop = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const v = videoRef.current; if (!v) return;
        v.srcObject = stream; await v.play();
        const tick = () => {
          if (stop) return;
          if (v.videoWidth) {
            const w = 480; const h = Math.round((v.videoHeight / v.videoWidth) * w);
            canvas.width = w; canvas.height = h; ctx.drawImage(v, 0, 0, w, h);
            const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (code?.data) { stop = true; onCode(code.data); return; }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { setErr('Không mở được camera: ' + (e.message || e.name) + '. Cho phép trình duyệt dùng camera rồi thử lại.'); }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="guard-cam">
      {err ? <div className="error-box">{err}</div> : <video ref={videoRef} playsInline muted />}
      <button className="btn guard-btn ghost-dark" onClick={onClose}>✕ Đóng camera</button>
    </div>
  );
}

export function Guard() {
  const { isAdmin } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const myWhs = useMyWarehouses();
  const [tab, setTab] = useState('in');
  const [q, setQ] = useState('');
  const [scan, setScan] = useState('');
  const [cam, setCam] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }
  const [picked, setPicked] = useState(null); // xe vừa quét QR ở tab Đăng ký xe
  const [busy, setBusy] = useState('');
  const scanRef = useRef(null);
  const { rows, error } = useTrips([ST.PLANNED, ST.ARRIVED, ST.WAITING_GATE, ST.PROCESSING, ST.WAITING_EXIT, ST.WAITING_DELIVERY], wh, true);
  const [act, err] = useTripAction();
  // Chỉ chuyến chưa hoàn thành cần bảo vệ kho này: xe đến lấy hàng, xe giao hàng vào kho; chuyến kế hoạch phải có số xe
  const all = rows.filter(inYard);
  const k = plateKey(q);
  const hit = (t) => !q || (k && plateKey(t.plate).includes(k)) || matchesTrip(t, q);
  const toIn = groupByPlate(all.filter((t) => waitingIn(t) && (picked ? picked.includes(t.id) : hit(t))))
    .sort((a, b) => (minOf(a, 'arrivalTime') ? 0 : 1) - (minOf(b, 'arrivalTime') ? 0 : 1)
      || (minOf(a, 'arrivalTime') || minOf(a, 'plannedDate')).localeCompare(minOf(b, 'arrivalTime') || minOf(b, 'plannedDate')));
  const queue = groupByPlate(all.filter((t) => t.status === ST.WAITING_GATE))
    .sort((a, b) => minOf(a, 'gateConfirmTime').localeCompare(minOf(b, 'gateConfirmTime')));
  const outAll = all.filter((t) => t.status === ST.WAITING_EXIT);
  const toOut = groupByPlate(outAll).sort((a, b) => minOf(a, 'processDoneTime').localeCompare(minOf(b, 'processDoneTime')));
  const stillIn = (g) => all.filter((t) => plateKey(t.plate) && plateKey(t.plate) === plateKey(g[0].plate) && [ST.WAITING_GATE, ST.PROCESSING].includes(t.status)).length;
  const run = async (key, fn) => { setBusy(key); try { await fn(); setQ(''); } finally { setBusy(''); } };
  const focusScan = () => setTimeout(() => scanRef.current?.focus(), 50);
  useEffect(() => { if (tab === 'out') focusScan(); }, [tab]);

  // Quét QR (điện thoại tài xế / phiếu in):
  //  • tab Đăng ký xe: hiện đúng xe đó để đối chiếu giấy tờ rồi bấm ĐĂNG KÝ
  //  • tab Ra cổng: hợp lệ (thủ kho đã xong) thì xác nhận xe ra cổng luôn
  const onScan = async (raw) => {
    const text = String(raw || '').trim();
    setScan(''); setCam(false);
    if (!text) return;
    setBusy('scan');
    try {
      const { codes, hits, err: bad } = await findByScan(text, all);
      if (bad) return setResult({ ok: false, text: bad });
      if (!codes.length) return setResult({ ok: false, text: 'Không đọc được mã. Quét lại mã QR.' });
      if (!hits.length) return setResult({ ok: false, text: `Mã ${codes.join(' ')} không có xe đang chờ ở kho này (xe đã ra cổng, chuyến đã hủy, hoặc của kho khác).` });
      const t0 = hits[0];
      if (tab === 'in') {
        const wait = hits.filter(waitingIn);
        if (!wait.length) {
          const stt = queue.findIndex((g) => g.some((x) => hits.some((h) => h.id === x.id)));
          return setResult({ ok: false, text: stt >= 0 ? `Xe ${t0.plate} đã đăng ký rồi, số thứ tự ${stt + 1}.` : `Xe ${t0.plate} không chờ đăng ký: ${STATUS_META[t0.status]?.label || t0.status}.` });
        }
        setPicked(wait.map((x) => x.id));
        return setResult({ ok: true, text: `Mã QR đúng xe ${t0.plate}.`, sub: 'Đối chiếu tên tài xế, CCCD, đơn vị vận tải với giấy tờ rồi bấm ĐĂNG KÝ.' });
      }
      const ready = hits.filter((t) => t.status === ST.WAITING_EXIT);
      if (!ready.length) return setResult({ ok: false, text: `Xe ${t0.plate} CHƯA được ra: ${STATUS_META[t0.status]?.label || t0.status}. Chờ thủ kho xác nhận xuất/nhập xong.` });
      // Cùng xe (Job / nhiều Shipment): ra cổng cùng lúc
      const group = outAll.filter((t) => ready.some((r) => r.id === t.id) || (plateKey(t.plate) && plateKey(t.plate) === plateKey(ready[0].plate)));
      await guardExit(act, group);
      setResult({ ok: true, text: `Xe ${ready[0].plate} đã ra cổng lúc ${fmtTime(nowISO())}.`, sub: `Mã ${codes.join(' ')} hợp lệ` });
    } finally { setBusy(''); focusScan(); }
  };
  // Ô quét: máy scan cầm tay gõ mã + Enter; gõ tay số xe thì lọc danh sách (tab Đăng ký xe)
  const scanBox = (
    <div className="guard-scan">
      {!cam && <button className="btn guard-btn blue" onClick={() => { setResult(null); setCam(true); }}>📷 Quét mã QR trên điện thoại tài xế</button>}
      {cam && <CameraScan onCode={onScan} onClose={() => { setCam(false); focusScan(); }} />}
      <input ref={scanRef} className="guard-search" type="search" placeholder={tab === 'in' ? '🔍 hoặc nhập số xe (vd 51C12345)' : 'Máy scan: bấm vào đây rồi quét'}
        value={tab === 'in' ? q : scan} disabled={busy === 'scan'}
        onChange={(e) => { setResult(null); setPicked(null); if (tab === 'in') setQ(e.target.value); else setScan(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const v = tab === 'in' ? q : scan;
          if (tab === 'out' || /^KVT/i.test(v.trim())) { e.preventDefault(); if (tab === 'in') setQ(''); onScan(v); }
        }} />
      {busy === 'scan' && <div className="guard-result">Đang kiểm tra…</div>}
      {result && (
        <div className={'guard-result ' + (result.ok ? 'ok' : 'bad')}>
          <div className="guard-result-icon">{result.ok ? '✅' : '❌'}</div>
          <div><b>{result.text}</b>{result.sub ? <div className="small">{result.sub}</div> : null}</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="guard-page">
      {(isAdmin || myWhs.length > 1) && <div style={{ marginBottom: 8 }}><WarehousePicker value={wh} onChange={setWh} /></div>}
      <div className="guard-tabs">
        <button className={tab === 'in' ? 'on' : ''} onClick={() => { setTab('in'); setResult(null); setPicked(null); setCam(false); }}>📝 Đăng ký xe <span className="count">{toIn.length}</span></button>
        <button className={tab === 'out' ? 'on' : ''} onClick={() => { setTab('out'); setResult(null); setCam(false); }}>🚪 Xác nhận xe ra cổng <span className="count">{toOut.length}</span></button>
      </div>
      <ErrorBox error={error || err} />
      {tab === 'in' ? (
        <>
          {scanBox}
          {picked && <button className="btn ghost" style={{ marginBottom: 8 }} onClick={() => { setPicked(null); setResult(null); }}>← Xem tất cả xe chờ đăng ký</button>}
          {toIn.length ? toIn.map((g) => (
            <GuardCard key={g[0].id} trips={g}
              time={destPhase(g[0]) ? `Tài xế lấy hàng lúc ${fmtTime(minOf(g, 'driverLoadedAt'))} tại ${g[0].pickupName || g[0].warehouseName || g[0].warehouse}`
                : g.some((t) => t.status === ST.ARRIVED) ? `Tài xế báo đến lúc ${fmtTime(minOf(g, 'arrivalTime'))}` : g[0].plannedDate ? `Ngày dự kiến ${fmtDate(g[0].plannedDate)}` : ''}>
              <button className="btn guard-btn" disabled={!!busy} onClick={() => window.confirm(`Đăng ký xe ${g[0].plate} vào kho?\nĐã đối chiếu tên tài xế, CCCD, đơn vị vận tải.`) && run(g[0].id, async () => { await guardArrive(act, g); setPicked(null); setResult({ ok: true, text: `Đã đăng ký xe ${g[0].plate}.` }); })}>
                {busy === g[0].id ? 'Đang lưu…' : '✅ ĐĂNG KÝ'}
              </button>
              <CancelTrip trips={g} act={act} />
            </GuardCard>
          )) : <Empty text={q ? `Không thấy xe "${q}". Xe chưa có số xe hoặc chưa được giao chuyến: báo quản trị / điều phối.` : 'Không có xe chờ đăng ký.'} />}
          <div className="section-head" style={{ marginTop: 16 }}>Thứ tự xe đã đăng ký (thủ kho gọi vào cửa theo số này) <span className="count">{queue.length}</span></div>
          {queue.length ? (
            <div className="guard-queue">
              {queue.map((g, i) => <div key={g[0].id}><span className="guard-stt sm">{i + 1}</span><b className="plate">{g[0].plate}</b> <span className="small">{fmtTime(minOf(g, 'gateConfirmTime'))}</span></div>)}
            </div>
          ) : <Empty text="Chưa có xe nào đang chờ thủ kho." />}
          {isAdmin ? <div className="small" style={{ marginTop: 12 }}>Xe không có trong danh sách (xe nhập hàng, khách đến không báo trước): <Link to="/xe/dang-ky">+ Đăng ký xe tại cổng</Link></div> : null}
        </>
      ) : (
        <>
          {scanBox}
          <div className="section-head" style={{ marginTop: 16 }}>Xe đã xuất/nhập xong, chờ ra cổng <span className="count">{toOut.length}</span></div>
          {toOut.length ? toOut.map((g) => {
            const left = stillIn(g);
            return (
              <GuardCard key={g[0].id} trips={g} time={`Thủ kho báo xong lúc ${fmtTime(minOf(g, 'processDoneTime'))}${g[0].dock ? ` · cửa ${g[0].dock}` : ''}`}
                note={left ? `⚠ Xe này còn ${left} chuyến chưa xuất/nhập xong` : ''}>
                {/* Bảo vệ phải quét QR; quản trị (làm thay) bấm được */}
                {isAdmin && <button className="btn guard-btn" disabled={!!busy} onClick={() => window.confirm(`Cho xe ${g[0].plate} ra cổng (không quét QR)?`) && run(g[0].id, () => guardExit(act, g))}>
                  {busy === g[0].id ? 'Đang lưu…' : '🚪 XÁC NHẬN XE RA CỔNG'}
                </button>}
              </GuardCard>
            );
          }) : <Empty text="Không có xe chờ ra cổng." />}
        </>
      )}
    </div>
  );
}

// Bảo vệ đăng nhập: chỉ có màn hình Bảo vệ cổng (không menu, không trang khác)
export function GuardApp() {
  const { name, email, logout } = useApp();
  return (
    <div className="guard-app">
      <div className="guard-appbar">
        <b>🛡️ Bảo vệ cổng</b>
        <span className="small">{name || email}</span>
        <button className="btn sm" onClick={logout}>Đăng xuất</button>
      </div>
      <Guard />
    </div>
  );
}

// Thủ kho: chỉ 2 màn hình (Xe & cửa: chờ vào cửa, chỉ định cửa, xuất/nhập xong · Kiểm kê), không menu
export function KeeperApp({ children }) {
  const { name, email, logout } = useApp();
  return (
    <div className="guard-app keeper-app">
      <div className="guard-appbar">
        <b>📦 Thủ kho</b>
        <span className="small">{name || email}</span>
        <button className="btn sm" onClick={logout}>Đăng xuất</button>
      </div>
      <div className="guard-tabs keeper-tabs">
        <NavLink to="/xe/thu-kho" className={({ isActive }) => `guard-tab${isActive ? ' on' : ''}`}>🚚 Xe & cửa</NavLink>
        <NavLink to="/kho/kiem-ke" className={({ isActive }) => `guard-tab${isActive ? ' on' : ''}`}>🧮 Kiểm kê</NavLink>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Thủ kho
export function Dock() {
  const { role } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const [q, setQ] = useState('');
  const { rows, error } = useTrips([ST.WAITING_GATE, ST.PROCESSING], wh, true);
  const docks = useCollection('docks').rows;
  const [act, err] = useTripAction();
  const [pick, setPick] = useState({});
  const list = rows.filter((t) => inYard(t) && matchesTrip(t, q));
  const waiting = list.filter((t) => t.status === ST.WAITING_GATE).sort(byTime('gateConfirmTime'));
  const processing = list.filter((t) => t.status === ST.PROCESSING).sort(byTime('dockAssignTime'));
  // Cửa đang có xe (để cảnh báo trùng)
  const busy = useMemo(() => new Map(processing.map((t) => [`${locWh(yardWh(t))}__${t.dock}`, t.plate])), [processing]);
  const docksOf = (t) => docks.filter((d) => (d.warehouse === yardWh(t) || d.warehouse === locWh(yardWh(t))) && d.active !== false
    && (d.usage !== (isUnloading(t) ? 'Chỉ xuất' : 'Chỉ nhập')));

  return (
    <div>
      <OpsHead title="📦 Thủ kho điều phối cửa" wh={wh} setWh={setWh} q={q} setQ={setQ} />
      <div className="small" style={{ margin: '-4px 0 10px' }}>Việc của thủ kho: ① chỉ định cửa cho xe theo thứ tự bảo vệ đã xếp · ② bấm <b>Xuất xong</b> (xe lấy hàng) hoặc <b>Nhập xong (hoàn thành)</b> (xe giao hàng vào kho){role !== 'thu_kho' && <> · ③ <Link to="/kho/kiem-ke">🧮 Kiểm kê / cycle count</Link></>}</div>
      <ErrorBox error={error || err} />
      <Section title="Chờ vào cửa (theo thứ tự xếp tài)" count={waiting.length}>
        {waiting.length ? waiting.map((t, i) => {
          const opts = docksOf(t);
          const v = pick[t.id] || '';
          return (
            <TripCard key={t.id} trip={t} timeLabel={`STT ${i + 1} · đăng ký`} timeValue={t.gateConfirmTime}>
              {opts.length ? (
                <WithAdd cat="docks" preset={{ warehouse: locWh(yardWh(t)) }} onAdded={(id, r) => setPick({ ...pick, [t.id]: r?.code || String(id).split('__').pop() })}>
                <Select value={v} onChange={(e) => setPick({ ...pick, [t.id]: e.target.value })}>
                  <option value="">-- Chọn cửa --</option>
                  {opts.map((d) => {
                    const by = busy.get(`${locWh(yardWh(t))}__${d.code}`);
                    return <option key={d.code} value={d.code}>{d.code}{d.name ? ` – ${d.name}` : ''}{by ? ` (đang có xe ${by})` : ''}</option>;
                  })}
                </Select>
                </WithAdd>
              ) : (
                <WithAdd cat="docks" preset={{ warehouse: locWh(yardWh(t)) }} onAdded={(id, r) => setPick({ ...pick, [t.id]: r?.code || String(id).split('__').pop() })}>
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
            {t.yard !== 'dest' && role !== 'thu_kho' && <Link className="btn" to={`/kho/${t.purpose === 'import' ? 'in' : 'out'}?trip=${t.id}`}>Lập phiếu {t.purpose === 'import' ? 'nhập' : 'xuất'}</Link>}
            <button className="btn primary" onClick={() => {
              const status = afterProcess(t);
              const at = nowISO();
              // Xe giao hàng vào kho: thủ kho nhập xong = chuyến hoàn thành (giao xong); bảo vệ chỉ còn cho ra cổng
              const done = isUnloading(t) || status === ST.COMPLETED;
              act(t, { status, processDoneTime: at, ...(done ? { deliveryCompleteTime: at } : {}),
                ...(t.yard === 'dest' ? { lines: (t.lines || []).map((l) => ({ ...l, delivered: true, deliveredTime: l.deliveredTime || at })) } : {}) },
              t.yard === 'dest' ? 'Thủ kho xác nhận nhập xong (hoàn thành)' : 'Xuất/nhập xong');
            }}>{isUnloading(t) ? 'Nhập xong (hoàn thành)' : 'Xuất xong'}</button>
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
