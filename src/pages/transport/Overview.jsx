import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useOpWarehouse } from '../../lib/hooks';
import {
  ACTIVE, ST, STAGES, STATUS_META, fmtDuration, fmtTime, matchesTrip, minutesBetween, nowISO, purposeLabel, vnDate,
} from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtNum } from '../../lib/utils';
import { Pipeline, StatusBadge, WarehousePicker, totalPayload } from '../../components/TripBits';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { useTripAction } from './Ops';
import { QuickAdd } from '../../components/FormTools';

const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const PRESETS = [
  ['Hôm nay', () => [vnDate(), vnDate()]],
  ['7 ngày', () => [addDays(vnDate(), -6), vnDate()]],
  ['Tháng này', () => [vnDate().slice(0, 8) + '01', vnDate()]],
];

export default function Overview() {
  const { inMyWarehouses } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const [range, setRange] = useState(() => { const [f, t] = PRESETS[1][1](); return { from: f, to: t }; });
  const [statusF, setStatusF] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const qy = query(collection(db, 'trips'), where('arrivalDate', '>=', range.from || '0000'), where('arrivalDate', '<=', range.to || '9999'));
    return onSnapshot(qy, (s) => { setRows(s.docs.map((d) => ({ ...d.data(), id: d.id }))); setError(''); }, (e) => setError(e.message));
  }, [range.from, range.to]);

  const scoped = useMemo(() => rows.filter((t) => inMyWarehouses(t.warehouse) && (!wh || t.warehouse === wh)), [rows, inMyWarehouses, wh]);
  const counts = useMemo(() => {
    const c = {};
    scoped.forEach((t) => { c[t.status] = (c[t.status] || 0) + 1; });
    return c;
  }, [scoped]);
  const list = useMemo(
    () => scoped.filter((t) => (!statusF || t.status === statusF) && matchesTrip(t, q)).sort((a, b) => b.arrivalTime.localeCompare(a.arrivalTime)),
    [scoped, statusF, q]
  );
  const current = open && rows.find((t) => t.id === open);

  const exportExcel = () => {
    const out = [];
    list.forEach((t) => (t.lines || []).forEach((l) => out.push({
      'Mã chuyến': t.id, 'Mã lô': l.id, Kho: t.warehouse, 'Mục đích': purposeLabel(t.purpose),
      'Biển số': t.plate, 'Đơn vị vận tải': t.carrierName, 'Tài xế': t.driverName, CCCD: t.idCard,
      'Mã KH/NCC': l.partyCode, 'Tên KH/NCC': l.partyName, 'Mã giao hàng': l.shipCode, 'Địa chỉ giao': l.address,
      'Khối lượng (tấn)': l.payload, Cửa: t.dock, 'Trạng thái': STATUS_META[t.status]?.label,
      'Đến kho': fmtTime(t.arrivalTime), 'Vào cổng': fmtTime(t.gateConfirmTime), 'Vào cửa': fmtTime(t.dockAssignTime),
      'Xuất/nhập xong': fmtTime(t.processDoneTime), 'Ra cổng': fmtTime(t.gateExitTime),
      'Giao xong': fmtTime(l.deliveredTime || t.deliveryCompleteTime),
      'Chờ vào cửa (phút)': minutesBetween(t.gateConfirmTime, t.dockAssignTime),
      'Xuất/nhập (phút)': minutesBetween(t.dockAssignTime, t.processDoneTime),
    })));
    exportSheets(`Chuyen_xe_${range.from}_${range.to}`, { 'Chuyến xe': out.length ? out : [{ 'Mã chuyến': '' }] });
  };

  return (
    <div>
      <div className="page-head">
        <h1>📊 Tổng quan chuyến xe</h1>
        <button className="btn" onClick={exportExcel}>⬇ Excel</button>
      </div>
      <div className="filters">
        <div className="presets">
          {PRESETS.map(([l, fn]) => {
            const [f, t] = fn();
            return <button key={l} className={'chip' + (range.from === f && range.to === t ? ' on' : '')} onClick={() => setRange({ from: f, to: t })}>{l}</button>;
          })}
        </div>
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        <span>→</span>
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        <WarehousePicker value={wh} onChange={setWh} />
      </div>
      <div className="stats">
        {[...STAGES, ST.CANCELLED].map((s) => (
          <div key={s} className={'stat ' + (STATUS_META[s].tone === 'green' ? 'green' : STATUS_META[s].tone === 'red' ? 'red' : STATUS_META[s].tone === 'amber' ? 'amber' : '')}
            style={{ cursor: 'pointer', outline: statusF === s ? '2px solid var(--primary)' : 'none' }}
            onClick={() => setStatusF(statusF === s ? '' : s)}>
            <div className="stat-label">{STATUS_META[s].label}</div>
            <div className="stat-value">{counts[s] || 0}</div>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <input type="search" placeholder="Tìm biển số, tài xế, khách, mã chuyến…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="small">{list.length} chuyến · {fmtNum(list.reduce((s, t) => s + totalPayload(t), 0), 2)} tấn</span>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {list.length === 0 ? <Empty /> : (
          <table>
            <thead>
              <tr><th>Tiến trình</th><th>Mã chuyến</th><th>Biển số</th><th>Mục đích</th><th>Kho</th><th>Khách / NCC</th><th className="num">Tấn</th><th>Đến kho</th><th>Chờ vào cửa</th><th>Xuất/nhập</th><th>Trạng thái</th></tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} onClick={() => setOpen(t.id)} style={{ cursor: 'pointer' }}>
                  <td><Pipeline trip={t} /></td>
                  <td className="mono nowrap">{t.id}</td>
                  <td className="nowrap"><span className="plate">{t.plate}</span></td>
                  <td className="nowrap">{purposeLabel(t.purpose)}</td>
                  <td>{t.warehouse}{t.dock ? ` · cửa ${t.dock}` : ''}</td>
                  <td>{(t.lines || []).map((l) => l.partyName || l.partyCode).join(', ')}</td>
                  <td className="num">{fmtNum(totalPayload(t), 2)}</td>
                  <td className="nowrap">{fmtTime(t.arrivalTime)}</td>
                  <td className="nowrap">{fmtDuration(minutesBetween(t.gateConfirmTime, t.dockAssignTime))}</td>
                  <td className="nowrap">{fmtDuration(minutesBetween(t.dockAssignTime, t.processDoneTime))}</td>
                  <td><StatusBadge status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {current && <TripDetail trip={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

// Chi tiết chuyến xe: mốc thời gian, lịch sử; quản trị được sửa, hủy, xóa
function TripDetail({ trip: t, onClose }) {
  const { isAdmin } = useApp();
  const reasons = useCollection('reasons').rows.filter((r) => r.appliesTo === 'Hủy chuyến');
  const [act, err] = useTripAction();
  const [edit, setEdit] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const timeline = [
    ['Đến kho', t.arrivalTime], ['Vào cổng', t.gateConfirmTime], ['Vào cửa', t.dockAssignTime],
    ['Xuất/nhập xong', t.processDoneTime], ['Ra cổng', t.gateExitTime], ['Hoàn thành', t.deliveryCompleteTime],
  ];

  const saveEdit = async () => {
    await act(t, {
      plate: edit.plate.trim().toUpperCase(), driverName: edit.driverName.trim(), idCard: edit.idCard.trim(),
      driverPhone: edit.driverPhone.trim(), carrierName: edit.carrierName.trim(), note: edit.note.trim(),
      lines: t.lines.map((l, i) => ({ ...l, partyName: edit.lines[i].partyName, payload: edit.lines[i].payload === '' ? null : Number(edit.lines[i].payload) })),
    }, 'Sửa thông tin');
    setEdit(null);
  };

  return (
    <Modal title={`Chuyến ${t.id} · ${t.plate}`} onClose={onClose} wide>
      <ErrorBox error={err} />
      {!edit ? (
        <>
          <div className="trip-main" style={{ marginBottom: 10 }}>
            <StatusBadge status={t.status} /><span className="badge">{purposeLabel(t.purpose)}</span>
            <span className="badge blue">Kho {t.warehouse}{t.hasGuard ? '' : ' (không bảo vệ)'}</span>
            {t.dock && <span className="badge purple">Cửa {t.dock}</span>}
          </div>
          <p>{t.driverName} · CCCD {t.idCard}{t.driverPhone ? ` · ${t.driverPhone}` : ''}{t.carrierName ? ` · ${t.carrierName}` : ''}</p>
          {t.note && <p className="small">Ghi chú: {t.note}</p>}
          {t.cancelReason && <div className="error-box">Đã hủy: {t.cancelReason}</div>}
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table>
              <thead><tr><th>Mã lô</th><th>Khách / NCC</th><th>Giao đến</th><th className="num">Tấn</th><th>Giao xong</th></tr></thead>
              <tbody>
                {t.lines.map((l) => (
                  <tr key={l.id}><td className="mono">{l.id}</td><td>{l.partyCode} {l.partyName}</td><td>{l.shipCode} {l.address}</td>
                    <td className="num">{fmtNum(l.payload, 2)}</td><td>{l.delivered ? fmtTime(l.deliveredTime) : ''}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid2">
            <div>
              <div className="section-head">Mốc thời gian</div>
              <table><tbody>{timeline.map(([l, v]) => <tr key={l}><td>{l}</td><td>{fmtTime(v)}</td></tr>)}</tbody></table>
            </div>
            <div>
              <div className="section-head">Lịch sử thao tác</div>
              <table><tbody>{(t.history || []).map((h, i) => <tr key={i}><td className="nowrap">{fmtTime(h.at)}</td><td>{h.action}</td><td className="small">{h.byName || h.by}</td></tr>)}</tbody></table>
            </div>
          </div>
          {isAdmin && (
            <div className="form-actions">
              <button className="btn danger" style={{ marginRight: 'auto' }} onClick={async () => {
                if (window.confirm(`Xóa hẳn chuyến ${t.id}? Không khôi phục được.`)) { await deleteDoc(doc(db, 'trips', t.id)); onClose(); }
              }}>Xóa</button>
              {ACTIVE.includes(t.status) && (
                <>
                  <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
                    <option value="">-- Lý do hủy --</option>
                    {reasons.map((r) => <option key={r.code} value={`${r.code} – ${r.name}`}>{r.name}</option>)}
                    <option value="Khác">Khác</option>
                  </select>
                  <QuickAdd catKey="reasons" preset={{ appliesTo: 'Hủy chuyến' }} onAdded={(id, r) => setCancelReason(`${id} – ${r?.name || ''}`)} />
                  <button className="btn danger" disabled={!cancelReason} onClick={() => act(t, { status: ST.CANCELLED, cancelReason, cancelTime: nowISO() }, `Hủy chuyến: ${cancelReason}`)}>Hủy chuyến</button>
                </>
              )}
              <button className="btn" onClick={() => setEdit({ ...t, lines: t.lines.map((l) => ({ partyName: l.partyName || '', payload: l.payload ?? '' })) })}>Sửa</button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="form-grid">
            {[['plate', 'Biển số'], ['carrierName', 'Đơn vị vận tải'], ['driverName', 'Tài xế'], ['idCard', 'CCCD'], ['driverPhone', 'Điện thoại']].map(([k, l]) => (
              <Field key={k} label={l}><input value={edit[k] || ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>
            ))}
            <Field label="Ghi chú" full><textarea value={edit.note || ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></Field>
            {t.lines.map((l, i) => (
              <Field key={l.id} label={`${l.id} · ${l.partyCode}`}>
                <input value={edit.lines[i].partyName} onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x, j) => (j === i ? { ...x, partyName: e.target.value } : x)) })} />
                <input type="number" step="any" placeholder="Tấn" value={edit.lines[i].payload} style={{ marginTop: 4 }}
                  onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x, j) => (j === i ? { ...x, payload: e.target.value } : x)) })} />
              </Field>
            ))}
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setEdit(null)}>Bỏ</button>
            <button className="btn primary" onClick={saveEdit}>Lưu</button>
          </div>
        </>
      )}
    </Modal>
  );
}
