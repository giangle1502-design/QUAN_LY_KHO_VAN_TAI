import { STATUS_META, fmtTime, purposeLabel, stagesOf } from '../lib/trips';
import { useMyWarehouses } from '../lib/hooks';
import { fmtNum } from '../lib/utils';

export function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status };
  return <span className={'badge ' + (m.tone || '')}>{m.label}</span>;
}

export function Pipeline({ trip }) {
  const stages = stagesOf(trip);
  const idx = stages.indexOf(trip.status);
  return (
    <div className="pipeline" title={stages.map((s) => STATUS_META[s].label).join(' → ')}>
      {stages.map((s, i) => <span key={s} className={i <= idx ? 'on ' + (STATUS_META[s].tone || '') : ''} />)}
    </div>
  );
}

// Chọn kho đang thao tác (chỉ các kho được giao)
export function WarehousePicker({ value, onChange, allowAll = true }) {
  const list = useMyWarehouses();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAll && <option value="">Tất cả kho</option>}
      {list.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}{w.hasGuard === false ? ' (không bảo vệ)' : ''}</option>)}
    </select>
  );
}

export const totalPayload = (t) => (t.lines || []).reduce((s, l) => s + (Number(l.payload) || 0), 0);

// Thẻ 1 chuyến xe: thông tin xe + danh sách khách/lô, phần thao tác truyền qua children
export function TripCard({ trip: t, timeLabel, timeValue, children, onOpen }) {
  return (
    <div className="trip-card">
      <div className="trip-head">
        <div className="trip-main" onClick={onOpen} style={onOpen ? { cursor: 'pointer' } : undefined}>
          <span className="plate">{t.plate}</span>
          <span className="small mono">{t.id}</span>
          <span className="badge">{purposeLabel(t.purpose)}</span>
          <span className="badge blue">Kho {t.warehouse}</span>
          {t.dock && <span className="badge purple">Cửa {t.dock}</span>}
          <StatusBadge status={t.status} />
        </div>
        <div className="trip-actions">{children}</div>
      </div>
      <div className="trip-sub small">
        {t.driverName}{t.idCard ? ` · CCCD ${t.idCard}` : ''}{t.driverPhone ? ` · ${t.driverPhone}` : ''}
        {t.carrierName ? ` · ${t.carrierName}` : ''}
        {timeLabel && ` · ${timeLabel}: ${fmtTime(timeValue)}`}
        {totalPayload(t) ? ` · ${fmtNum(totalPayload(t), 2)} tấn` : ''}
      </div>
      <ul className="trip-lines">
        {(t.lines || []).map((l) => (
          <li key={l.id}>
            <span className="mono small">{l.id}</span> <b>{l.partyName || l.partyCode}</b>
            {l.shipCode ? <span className="small"> · {l.shipCode}</span> : ''}
            {l.payload ? <span className="small"> · {fmtNum(l.payload, 2)} tấn</span> : ''}
            {l.delivered && <span className="badge green" style={{ marginLeft: 6 }}>Đã giao</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
