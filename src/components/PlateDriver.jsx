import { useId, useMemo } from 'react';
import { useCollection } from '../lib/hooks';
import { findPlate, plateOptions, usePlateHistory } from '../lib/plates';
import { WithAdd } from './FormTools';

// Ô Số xe + Tài xế + CCCD + điện thoại dùng chung (Shipment, đăng ký xe, chia xe):
// gõ số xe → tìm trong danh sách xe đơn vị đã khai, rồi lịch sử → tự điền loại xe, tải trọng, tài xế chạy gần nhất.
// Tài xế đổi xe: chọn tài xế khác trong danh sách gợi ý hoặc gõ mới (lưu lịch sử khi chạy).
export default function PlateDriver({ carrier, value, onChange, showDriver = true, layout = 'grid', required = false }) {
  const id = useId().replace(/:/g, '');
  const vehicles = useCollection('vehicles').rows;
  const drivers = useCollection('drivers').rows;
  const hist = usePlateHistory();
  const opts = useMemo(() => plateOptions(carrier, vehicles, hist), [carrier, vehicles, hist]);
  const cur = findPlate(opts, value.plate);
  // Tài xế gợi ý: người đã chạy xe này trước, rồi tài xế đơn vị đã khai
  const drvOpts = useMemo(() => [...new Map([...(cur?.drivers || []), ...drivers.filter((d) => !carrier || d.carrier === carrier).map((d) => ({ name: d.name, idCard: d.idCard, phone: d.phone }))]
    .filter((d) => d.name || d.idCard).map((d) => [d.idCard || d.name, d])).values()], [cur, drivers, carrier]);
  const pickPlate = (v) => {
    const p = v.toUpperCase();
    const o = findPlate(opts, p);
    const d = o?.drivers?.[0];
    onChange({ plate: p, ...(o ? { vehicleType: o.vehicleType || value.vehicleType || '', ...(o.payload ? { payload: o.payload } : {}) } : {}),
      ...(o && d && !value.driverName && !value.idCard ? { driverName: d.name || '', idCard: d.idCard || '', driverPhone: d.phone || '' } : {}) });
  };
  const pickName = (v) => {
    const d = drvOpts.find((x) => x.name === v || `${x.name} · ${x.idCard}` === v);
    onChange(d ? { driverName: d.name || '', idCard: d.idCard || value.idCard || '', driverPhone: d.phone || value.driverPhone || '' } : { driverName: v });
  };
  const pickCard = (v) => { const d = drvOpts.find((x) => x.idCard && x.idCard === v.trim()); onChange(d ? { idCard: v, driverName: d.name || value.driverName, driverPhone: d.phone || value.driverPhone || '' } : { idCard: v }); };
  const st = layout === 'grid' ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 } : { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' };
  return (
    <div style={st}>
      <label className="field"><span>Số xe{required ? ' *' : ''}</span>
        <WithAdd cat="vehicles" preset={{ plate: value.plate, carrier, vehicleType: value.vehicleType || '', driverName: value.driverName || '', idCard: value.idCard || '' }} onAdded={(x, r) => pickPlate(r?.plate || x)}>
          <input list={`pl-${id}`} value={value.plate || ''} onChange={(e) => pickPlate(e.target.value)} placeholder="VD: 51C-12345" /></WithAdd>
        <span className="small">{cur ? `${cur.listed ? '✓ xe đã khai' : '↺ đã chạy trước'}${cur.vehicleType ? ` · ${cur.vehicleType}` : ''}${cur.payload ? ` · ${cur.payload} tấn` : ''}` : value.plate ? 'xe mới: tự lưu lịch sử' : ''}</span></label>
      {showDriver && <>
        <label className="field"><span>Tên tài xế</span><input list={`dr-${id}`} value={value.driverName || ''} onChange={(e) => pickName(e.target.value)} /></label>
        <label className="field"><span>CCCD</span><input list={`cc-${id}`} inputMode="numeric" value={value.idCard || ''} onChange={(e) => pickCard(e.target.value)} /></label>
        <label className="field"><span>Điện thoại</span><input type="tel" value={value.driverPhone || ''} onChange={(e) => onChange({ driverPhone: e.target.value })} /></label>
      </>}
      <datalist id={`pl-${id}`}>{opts.map((o) => <option key={o.plate} value={o.plate}>{[o.listed ? 'xe đã khai' : 'đã chạy', o.vehicleType, o.payload && `${o.payload} tấn`, o.drivers?.[0]?.name].filter(Boolean).join(' · ')}</option>)}</datalist>
      <datalist id={`dr-${id}`}>{drvOpts.map((d) => <option key={d.idCard || d.name} value={d.name}>{d.idCard ? `CCCD ${d.idCard}` : ''}</option>)}</datalist>
      <datalist id={`cc-${id}`}>{drvOpts.filter((d) => d.idCard).map((d) => <option key={d.idCard} value={d.idCard}>{d.name}</option>)}</datalist>
    </div>
  );
}
