import { useEffect } from 'react';
import { useCollection } from '../lib/hooks';
import { MATERIALS, MODE_LABEL } from '../lib/pallets';
import { WithAdd } from './FormTools';

const blank = (material, to, qty) => ({ material, code: '', name: '', qty: qty || '', to, carrier: '', carrierName: '' });

// Hàng Kiện (có pallet) / Xá (không pallet). Đơn hàng chỉ ghi Kiện / Xá; thủ kho kiểm tra thực tế rồi chọn
// pallet gỗ hay nhựa, số pallet. kind 'out': phiếu xuất (khách giữ / vận tải mượn / chuyển kho theo STO); kind 'in': phiếu nhập
export default function PalletChoice({ value, onChange, carrier, carrierName, suggestQty, disabled, kind = 'out', sto = false, managed = true }) {
  const pallets = useCollection('pallets').rows.filter((p) => p.active !== false);
  const carriers = useCollection('carriers').rows;
  const v = value || { palletMode: '', pallets: [] };
  const isIn = kind === 'in';
  const defTo = isIn ? 'in' : sto ? 'transfer' : 'customer';
  const set = (p) => onChange({ ...v, ...p });
  // Đơn ghi Kiện (điền sẵn từ đơn): mở sẵn 1 dòng pallet để thủ kho chọn gỗ / nhựa
  const needLine = v.palletMode === 'pallet' && !v.pallets?.length;
  useEffect(() => { if (needLine) onChange({ ...v, pallets: [blank('', defTo, suggestQty)] }); }, [needLine]); // eslint-disable-line react-hooks/exhaustive-deps
  const setLine = (i, p) => set({ pallets: v.pallets.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const codesOf = (m) => pallets.filter((p) => p.material === m);
  const pickMaterial = (i, m) => {
    const list = codesOf(m);
    setLine(i, { material: m, ...(list.length === 1 ? { code: list[0].code, name: list[0].name } : { code: '', name: '' }) });
  };
  const mode = (m) => {
    if (m !== 'pallet') return set({ palletMode: m, pallets: [] });
    set({ palletMode: 'pallet', pallets: v.pallets.length ? v.pallets : [blank('', defTo, suggestQty)] });
  };
  const toOpts = sto ? [['transfer', 'Chuyển theo hàng sang kho nhận'], ['carrier', 'Cho vận tải mượn']] : [['customer', 'Xuất cho khách hàng'], ['carrier', 'Cho vận tải mượn']];
  const Seg = ({ val, opts, on }) => (
    <div className="seg wrap">
      {opts.map(([k, l]) => <button key={k} type="button" disabled={disabled} className={val === k ? 'on' : ''} onClick={() => on(k)}>{l}</button>)}
    </div>
  );
  return (
    <div className="pallet-choice">
      <Seg val={v.palletMode} opts={[['pallet', MODE_LABEL.pallet], ['xa', MODE_LABEL.xa]]} on={mode} />
      {v.palletMode === 'pallet' && (v.pallets || []).map((p, i) => (
        <div key={i} className="pallet-line">
          <Seg val={p.material} opts={MATERIALS.map((m) => [m, m])} on={(m) => pickMaterial(i, m)} />
          {p.material ? (
            <WithAdd cat="pallets" preset={{ material: p.material }} onAdded={(id, r) => setLine(i, { code: id, name: r?.name || '', material: r?.material || p.material })}>
              <select value={p.code} disabled={disabled} onChange={(e) => { const x = pallets.find((y) => y.code === e.target.value); setLine(i, { code: e.target.value, name: x?.name || '' }); }}>
                <option value="">-- Mã {p.material.toLowerCase()} --</option>
                {codesOf(p.material).map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}{x.size ? ` (${x.size})` : ''}</option>)}
              </select>
            </WithAdd>
          ) : <span className="small" style={{ color: 'var(--red)' }}>Kiểm tra hàng thực tế: pallet gỗ hay pallet nhựa?</span>}
          <label className="small">Số pallet <input type="number" min="0" step="1" style={{ width: 80 }} value={p.qty} disabled={disabled} onChange={(e) => setLine(i, { qty: e.target.value })} /> cái</label>
          {!isIn && <Seg val={p.to} opts={toOpts} on={(t) => setLine(i, { to: t })} />}
          {!isIn && p.to === 'carrier' && (
            <WithAdd cat="carriers" onAdded={(id, r) => setLine(i, { carrier: id, carrierName: r?.name || '' })}>
              <select value={p.carrier || carrier || ''} disabled={disabled} onChange={(e) => { const c = carriers.find((x) => x.code === e.target.value); setLine(i, { carrier: e.target.value, carrierName: c?.name || '' }); }}>
                <option value="">-- Đơn vị vận tải mượn --</option>
                {carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}
              </select>
            </WithAdd>
          )}
          {v.pallets.length > 1 && <button type="button" className="btn sm danger" disabled={disabled} onClick={() => set({ pallets: v.pallets.filter((_, j) => j !== i) })}>✕</button>}
          {p.material && !codesOf(p.material).length && <span className="small" style={{ color: 'var(--red)' }}>Chưa có mã {p.material.toLowerCase()} trong danh mục Mã pallet.</span>}
        </div>
      ))}
      {v.palletMode === 'pallet' && <button type="button" className="btn sm" disabled={disabled} onClick={() => set({ pallets: [...v.pallets, blank('', defTo, '')] })}>＋ Thêm loại pallet (hàng về cả gỗ lẫn nhựa)</button>}
      <div className="small" style={{ marginTop: 4 }}>
        {!managed && v.palletMode === 'pallet' && <div>Kho này không quản lý tồn pallet: số pallet chỉ ghi trên phiếu{isIn ? '' : ' (pallet vận tải mượn vẫn được theo dõi)'}.</div>}
        {isIn && v.palletMode === 'pallet' && managed && 'Xác nhận nhận hàng: số pallet được cộng vào tồn pallet của kho.'}
        {isIn && v.palletMode === 'xa' && 'Hàng xá: không có pallet nhập kho.'}
        {!isIn && v.palletMode === 'xa' && 'Phiếu giao hàng in 3 liên, không có bảng pallet.'}
        {!isIn && v.palletMode === 'pallet' && v.pallets.some((p) => p.to === 'carrier')
          && `Pallet vận tải mượn chuyển sang đơn vị ${v.pallets.find((p) => p.to === 'carrier')?.carrierName || carrierName || carrier || '…'}; vận tải trả lại thì nhập ở Quản lý pallet. Liên kho và liên vận tải có bảng pallet, liên khách hàng không có pallet vận tải mượn.`}
        {!isIn && v.palletMode === 'pallet' && v.pallets.every((p) => p.to !== 'carrier') && (sto
          ? 'Pallet đi theo hàng: trừ tồn pallet kho xuất; kho nhận cộng khi xác nhận nhận hàng.'
          : 'Pallet khách giữ: trừ tồn pallet kho; cả 3 liên phiếu giao hàng có bảng pallet riêng.')}
      </div>
    </div>
  );
}
