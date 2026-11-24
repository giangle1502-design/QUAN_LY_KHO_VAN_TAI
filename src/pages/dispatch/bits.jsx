import { Link } from 'react-router-dom';
import { fmtDate, fmtDayMonth, fmtNum } from '../../lib/utils';
import { stageMeta } from '../../lib/pending';

// Mảnh giao diện dùng chung cho Bàn điều phối kho và 2 danh sách Đơn chờ xuất / Đơn chờ nhập
export const kg = (v) => fmtNum(Math.round(Number(v) || 0));
export const tan = (v) => fmtNum((Number(v) || 0) / 1000, 1);

export const TYPE_LABEL = { SO: 'Đơn bán (SO)', STO: 'Chuyển kho (STO)', PO: 'Đơn mua (PO)', DRT: 'SO trả hàng (DRT)' };
export const TypeTag = ({ type }) => <span className={`dp-type t-${type}`}>{type}</span>;

export function StageBadge({ r }) {
  const s = stageMeta(r.kind, r.stage);
  let text = s.label;
  if (r.kind === 'out' && r.stage === 'release') text += r.slipIds.length ? ` · ${r.slipIds.join(', ')}` : '';
  if (r.kind === 'out' && r.stage === 'goods') text += r.goodsPo?.length ? ` · ${r.goodsPo.join(', ')}` : '';
  if (r.stage === 'truck' && r.trip) text = `${s.ico} ${r.plate || 'Xe'} · ${tripText(r.trip)}`;
  else text = `${s.ico} ${text}`;
  const tone = r.late && ['make', 'goods'].includes(r.stage) ? 'red' : s.tone;
  return <span className={'badge dp-stage-b ' + tone} title={text}>{r.late && ['make', 'goods'].includes(r.stage) ? `⏰ Trễ · ${s.short.toLowerCase()}` : text}</span>;
}

const TRIP_TXT = { planned: 'chờ xe', arrived: 'đến cổng', waiting_gate: 'chờ vào cửa', processing: 'đang làm', waiting_exit: 'chờ ra cổng', waiting_delivery: 'đang giao' };
export const tripText = (t) => (t.status === 'processing' && t.dock ? `cửa ${t.dock}` : TRIP_TXT[t.status] || t.status);

// Thanh tiến độ: đã xong (xanh) + đang trong phiếu (cam) / tổng đặt
export function Progress({ r }) {
  const q = r.qty || 1;
  const d = Math.min(100, (r.done / q) * 100);
  const p = Math.min(100 - d, (r.inSlip / q) * 100);
  return (
    <span className="dp-prog" title={`${r.kind === 'out' ? 'Đã xuất' : 'Đã nhập'} ${kg(r.done)} · trong phiếu ${kg(r.inSlip)} · còn ${kg(r.left)} / ${kg(r.qty)} kg`}>
      <span className="dp-trk"><span className="d" style={{ width: `${d}%` }} /><span className="p" style={{ width: `${p}%` }} /></span>
      <span className="dp-pct">{Math.round(d)}%</span>
    </span>
  );
}

export function DueCell({ r, today }) {
  if (!r.due) return <span className="small">chưa có</span>;
  const days = Math.round((new Date(today) - new Date(r.due)) / 86400000);
  return <span className="nowrap" title={fmtDate(r.due)}>{fmtDayMonth(r.due)}{r.late ? <span className="badge red" style={{ marginLeft: 4 }}>trễ {days}n</span> : r.due === today ? <span className="badge blue" style={{ marginLeft: 4 }}>hôm nay</span> : null}</span>;
}

export function ActionBtn({ a, sm = true }) {
  if (!a) return null;
  return <Link className={'btn' + (sm ? ' sm' : '') + (a.primary ? ' primary' : '')} to={a.to} onClick={(e) => e.stopPropagation()}>{a.label}</Link>;
}

export const Items = ({ r }) => (
  <span title={r.itemNames.join(', ')}><span className="mono">{r.items[0] || ''}</span>{r.items.length > 1 && <span className="small"> +{r.items.length - 1}</span>}</span>
);
