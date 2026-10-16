import Select from './Select';
import { WithAdd } from './FormTools';
import { SHIP_PICKUP } from '../lib/dispatch';

// Ô chọn Điểm nhận hàng: kho của mình (mặc định) · điểm nhận ngoài (cảng, kho ngoại quan…) · khách hàng (thu hồi hàng)
export default function PickupSelect({ value, onChange, whLabel, points = [], shipto = [], disabled, style }) {
  return (
    <WithAdd cat="pickupPoints" style={style} onAdded={(id) => onChange(id)}>
      <Select searchable value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        title="Nơi xe đến lấy hàng: kho của mình, cảng / kho ngoài, hoặc khách hàng khi thu hồi hàng về">
        <option value="">🏬 {whLabel || 'Kho xuất'}</option>
        {points.filter((x) => x.active !== false || x.code === value).map((x) => <option key={x.code} value={x.code} data-search={`${x.kind || ''} ${x.address || ''}`}>⚓ {x.name}</option>)}
        {shipto.map((s) => <option key={s.shipCode} value={SHIP_PICKUP + s.shipCode} data-search={`thu hồi ${s.customerCode} ${s.customerName || ''} ${s.address || ''}`}>↩ Thu hồi từ khách {s.customerName || s.customerCode} ({s.shipCode})</option>)}
      </Select>
    </WithAdd>
  );
}
