import { useCollection } from '../lib/hooks';
import { MATERIALS } from '../lib/pallets';

const blank = (material, to, qty) => ({ material, code: '', name: '', qty: qty || '', to, carrier: '', carrierName: '' });

// Hình thức xuất của phiếu giao hàng: xuất xá / xuất kèm pallet → pallet nhựa / gỗ → khách hàng giữ / vận tải mượn
export default function PalletChoice({ value, onChange, carrier, carrierName, suggestQty, disabled }) {
  const pallets = useCollection('pallets').rows.filter((p) => p.active !== false);
  const carriers = useCollection('carriers').rows;
  const v = value || { palletMode: '', pallets: [] };
  const set = (p) => onChange({ ...v, ...p });
  const setLine = (i, p) => set({ pallets: v.pallets.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const codesOf = (m) => pallets.filter((p) => p.material === m);
  const pickMaterial = (i, m) => {
    const list = codesOf(m);
    setLine(i, { material: m, ...(list.length === 1 ? { code: list[0].code, name: list[0].name } : { code: '', name: '' }) });
  };
  const mode = (m) => {
    if (m !== 'pallet') return set({ palletMode: m, pallets: [] });
    const first = blank('Pallet nhựa', 'customer', suggestQty);
    const list = codesOf('Pallet nhựa');
    if (list.length === 1) Object.assign(first, { code: list[0].code, name: list[0].name });
    set({ palletMode: 'pallet', pallets: v.pallets.length ? v.pallets : [first] });
  };
  const Seg = ({ val, opts, on }) => (
    <div className="seg wrap">
      {opts.map(([k, l]) => <button key={k} type="button" disabled={disabled} className={val === k ? 'on' : ''} onClick={() => on(k)}>{l}</button>)}
    </div>
  );
  return (
    <div className="pallet-choice">
      <Seg val={v.palletMode} opts={[['xa', 'Xuất xá (không pallet)'], ['pallet', 'Xuất kèm pallet']]} on={mode} />
      {v.palletMode === 'pallet' && v.pallets.map((p, i) => (
        <div key={i} className="pallet-line">
          <Seg val={p.material} opts={MATERIALS.map((m) => [m, m])} on={(m) => pickMaterial(i, m)} />
          <select value={p.code} disabled={disabled} onChange={(e) => { const x = pallets.find((y) => y.code === e.target.value); setLine(i, { code: e.target.value, name: x?.name || '' }); }}>
            <option value="">-- Mã {p.material.toLowerCase()} --</option>
            {codesOf(p.material).map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}{x.size ? ` (${x.size})` : ''}</option>)}
          </select>
          <label className="small">Số lượng <input type="number" min="0" step="1" style={{ width: 80 }} value={p.qty} disabled={disabled} onChange={(e) => setLine(i, { qty: e.target.value })} /> cái</label>
          <Seg val={p.to} opts={[['customer', 'Xuất cho khách hàng'], ['carrier', 'Cho vận tải mượn']]} on={(t) => setLine(i, { to: t })} />
          {p.to === 'carrier' && (
            <select value={p.carrier || carrier || ''} disabled={disabled} onChange={(e) => { const c = carriers.find((x) => x.code === e.target.value); setLine(i, { carrier: e.target.value, carrierName: c?.name || '' }); }}>
              <option value="">-- Đơn vị vận tải mượn --</option>
              {carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}
            </select>
          )}
          {v.pallets.length > 1 && <button type="button" className="btn sm danger" disabled={disabled} onClick={() => set({ pallets: v.pallets.filter((_, j) => j !== i) })}>✕</button>}
          {!codesOf(p.material).length && <span className="small" style={{ color: 'var(--red)' }}>Chưa có mã {p.material.toLowerCase()} trong danh mục Mã pallet.</span>}
        </div>
      ))}
      {v.palletMode === 'pallet' && <button type="button" className="btn sm" disabled={disabled} onClick={() => set({ pallets: [...v.pallets, blank('Pallet gỗ', 'customer', '')] })}>＋ Thêm loại pallet</button>}
      <div className="small" style={{ marginTop: 4 }}>
        {v.palletMode === 'xa' && 'Phiếu giao hàng in 3 liên, không có dòng pallet.'}
        {v.palletMode === 'pallet' && v.pallets.some((p) => p.to === 'carrier')
          && `Pallet vận tải mượn chuyển sang đơn vị ${v.pallets.find((p) => p.to === 'carrier')?.carrierName || carrierName || carrier || '…'}; vận tải trả lại thì nhập ở Quản lý pallet. Phiếu in 3 liên: liên kho và liên vận tải có dòng pallet, liên khách hàng không có.`}
        {v.palletMode === 'pallet' && v.pallets.every((p) => p.to !== 'carrier') && 'Pallet khách giữ: trừ tồn pallet kho, cả 3 liên phiếu giao hàng có dòng pallet.'}
      </div>
    </div>
  );
}
