import { useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { STAGES, ST, STATUS_META, fmtTime, vnDate } from '../../lib/trips';
import { tripKg } from '../../lib/transport';
import { kindText } from '../../lib/dispatch';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum } from '../../lib/utils';
import { Pipeline, StatusBadge } from '../../components/TripBits';
import { Empty } from '../../components/ui';

// ============================================================================
// Báo cáo theo tình trạng xe (giống tab Tổng quan của app QLVT): đếm chuyến theo từng tình trạng (bấm để lọc),
// lọc thời gian Hôm nay / Tuần này / Tháng này / tự chọn, tìm kiếm, Excel; bấm 1 chuyến xem mốc thời gian từng bước.
// Mỗi vai trò thấy đúng phạm vi của mình (đơn vị vận tải: chuyến của đơn vị; 3PL: chuyến GHA giao cho mình).
// ============================================================================
const addDays = (ymd, k) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const weekStart = () => { const t = vnDate(); const d = new Date(`${t}T00:00:00Z`); return addDays(t, -((d.getUTCDay() + 6) % 7)); };
const PRESETS = [['all', 'Tất cả'], ['today', 'Hôm nay'], ['week', 'Tuần này'], ['month', 'Tháng này']];
// Tuần / tháng tính trọn kỳ (gồm cả chuyến đã giao vận tải cho những ngày tới)
const monthEnd = () => { const t = vnDate(); const d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 0)); return d.toISOString().slice(0, 10); };
const rangeOf = (p) => (p === 'today' ? [vnDate(), vnDate()] : p === 'week' ? [weekStart(), addDays(weekStart(), 6)] : p === 'month' ? [vnDate().slice(0, 8) + '01', monthEnd()] : ['', '']);
const STATUSES = [...STAGES, ST.CANCELLED];
// Mốc thời gian của chuyến: luồng kho (bảo vệ, thủ kho) + các bước tài xế
const TIMES = [
  ['arrivalTime', 'Đến kho'], ['gateConfirmTime', 'Vào cổng'], ['dockAssignTime', 'Vào cửa'], ['processDoneTime', 'Xuất/nhập xong'],
  ['gateExitTime', 'Ra cổng'], ['driverLoadedAt', 'Lấy hàng xong'], ['driverAtDestAt', 'Đến điểm giao'], ['deliveryCompleteTime', 'Hoàn thành'],
];
const dayOf = (t) => t.arrivalDate || t.plannedDate || '';

export default function TripReport({ trips, priv }) {
  const { role, can3PL } = useApp();
  const scopedRole = ['van_tai', 'tpl'].includes(role);
  const carriers = useCollection('carriers').rows;
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [statusF, setStatusF] = useState('');
  const [carrier, setCarrier] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [from, to] = preset === 'custom' ? [custom.from, custom.to] : rangeOf(preset);
  const carOf = (t) => carriers.find((c) => c.code === t.carrier) || { kind: t.carrierKind };
  const hay = (t) => [t.id, t.plate, t.driverName, t.driverPhone, t.carrierName, t.warehouse, priv[t.id]?.threeplName,
    ...(t.lines || []).flatMap((l) => [l.orderId, l.partyCode, l.partyName, l.shipCode, l.item])].join(' ').toLowerCase();
  const inScope = useMemo(() => trips.filter((t) => (!from || dayOf(t) >= from) && (!to || dayOf(t) <= to) && (!carrier || t.carrier === carrier)
    && (!q || hay(t).includes(q.toLowerCase()))), [trips, from, to, carrier, q, priv]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => { const c = {}; inScope.forEach((t) => { c[t.status] = (c[t.status] || 0) + 1; }); return c; }, [inScope]);
  const rows = inScope.filter((t) => !statusF || t.status === statusF)
    .sort((a, b) => String(b.arrivalTime || b.plannedDate || '').localeCompare(String(a.arrivalTime || a.plannedDate || '')) || b.id.localeCompare(a.id));
  const setP = (p) => { setPreset(p); setCustom({ from: '', to: '' }); };
  const parties = (t) => [...new Set((t.lines || []).map((l) => l.partyName || l.partyCode))].join(', ');

  const excel = () => exportSheets(`Bao_cao_tinh_trang_xe_${from || 'all'}_${to || ''}`, {
    'Tình trạng xe': rows.map((t) => ({
      'Mã chuyến': t.id, 'Ngày': dayOf(t), 'Số xe': t.plate || '', 'Tài xế': t.driverName || '', 'ĐT tài xế': t.driverPhone || '', CCCD: t.idCard || '',
      'Đơn vị vận tải': t.carrierName || t.carrier || '', Loại: kindText(carOf(t)), ...(can3PL ? { '3PL': priv[t.id]?.threeplName || '' } : {}),
      Kho: t.warehouse, 'Đơn hàng': (t.orderIds || []).join(', '), 'Khách hàng / nơi giao': parties(t), 'Số tấn': +(tripKg(t) / 1000).toFixed(3), Cửa: t.dock || '',
      'Trạng thái': t.selfPickup && t.status === ST.COMPLETED ? 'Khách đã lấy xong' : STATUS_META[t.status]?.label || t.status,
      ...Object.fromEntries(TIMES.map(([k, l]) => [l, t[k] ? fmtTime(t[k]) : ''])),
    })),
  });

  return (
    <div>
      <div className="stats rep-stats">
        {STATUSES.map((s) => (
          <div key={s} className={'stat ' + ({ green: 'green', red: 'red', amber: 'amber' }[STATUS_META[s].tone] || '')}
            style={{ cursor: 'pointer', outline: statusF === s ? '2px solid var(--primary)' : 'none' }} onClick={() => setStatusF(statusF === s ? '' : s)}>
            <div className="stat-label">{STATUS_META[s].label}</div>
            <div className="stat-value">{counts[s] || 0}</div>
          </div>
        ))}
      </div>
      <div className="filters">
        <span className="small">Thời gian:</span>
        <div className="presets">{PRESETS.map(([k, l]) => <button key={k} type="button" className={'chip' + (preset === k ? ' on' : '')} onClick={() => setP(k)}>{l}</button>)}</div>
        <input type="date" value={from} onChange={(e) => { setPreset('custom'); setCustom({ from: e.target.value, to }); }} />
        <span>đến</span>
        <input type="date" value={to} onChange={(e) => { setPreset('custom'); setCustom({ from, to: e.target.value }); }} />
        {!scopedRole && <select value={carrier} onChange={(e) => setCarrier(e.target.value)}><option value="">Mọi đơn vị vận tải</option>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</select>}
        <input type="search" placeholder="Tìm số xe, tài xế, khách, đơn, chuyến…" value={q} onChange={(e) => setQ(e.target.value)} />
        {statusF && <button type="button" className="btn ghost sm" onClick={() => setStatusF('')}>Xóa lọc tình trạng</button>}
        <button type="button" className="btn" onClick={excel} disabled={!rows.length}>⬇ Xuất Excel</button>
      </div>
      <p className="small">{rows.length} chuyến · {fmtNum(rows.reduce((s, t) => s + tripKg(t), 0) / 1000, 3)} tấn. Bấm 1 chuyến để xem mốc thời gian từng bước.</p>
      {!rows.length ? <Empty text="Chưa có chuyến phù hợp." /> : (
        <div className="card" style={{ padding: 0 }}>
          {rows.map((t) => {
            const isOpen = open === t.id;
            return (
              <div key={t.id} className="rep-row">
                <div className="rep-line" role="button" tabIndex={0} onClick={() => setOpen(isOpen ? null : t.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(isOpen ? null : t.id)}>
                  <span className="small">{isOpen ? '▾' : '▸'}</span>
                  <span className="mono small">{t.id}</span>
                  {t.plate ? <span className="plate">{t.plate}</span> : <span className="small">chưa có xe</span>}
                  <span>{t.driverName}</span>
                  <span className="small">{parties(t)}</span>
                  {!scopedRole && <span className="small">{t.carrierName || t.carrier}</span>}
                  <span className="rep-pipe"><Pipeline trip={t} /></span>
                  <StatusBadge status={t.status} />
                </div>
                {isOpen && (
                  <div className="rep-detail">
                    <div className="rep-info">
                      <div><span className="small">Ngày</span><b>{fmtDate(dayOf(t))}</b></div>
                      <div><span className="small">Đơn vị vận tải</span><b>{t.carrierName || t.carrier || '—'}</b> <span className="small">{kindText(carOf(t))}</span></div>
                      {priv[t.id]?.threepl && <div><span className="small">3PL</span><b>{priv[t.id].threeplName || priv[t.id].threepl}</b></div>}
                      <div><span className="small">Tài xế</span><b>{t.driverName || '—'}</b>{t.driverPhone ? <> · <a href={`tel:${t.driverPhone}`}>{t.driverPhone}</a></> : null}</div>
                      <div><span className="small">Kho · cửa</span><b>{t.warehouse}{t.dock ? ` · cửa ${t.dock}` : ''}</b></div>
                      <div><span className="small">Đơn hàng</span><b>{(t.orderIds || []).join(', ') || '—'}</b></div>
                      <div><span className="small">Hàng</span><b>{(t.lines || []).map((l) => `${l.item} ${fmtNum((Number(l.plannedKg) || 0) / 1000, 3)} t`).join('; ')}</b></div>
                    </div>
                    <div className="rep-times">
                      {TIMES.filter(([k]) => !(t.selfPickup || t.purpose === 'import') || !['driverAtDestAt'].includes(k)).map(([k, l]) => (
                        <div key={k}><span className="small">{l}</span><b>{t[k] ? fmtTime(t[k]) : '—'}</b></div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
