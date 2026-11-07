import { useMemo, useState } from 'react';
import { useCollection } from '../lib/hooks';
import { fmtDate, fmtNum } from '../lib/utils';
import { exportSheets } from '../lib/excel';
import { vnDate } from '../lib/trips';
import { ReportTable, toSheet } from '../pages/reports/Reports';
import { Modal } from './ui';

// ============================================================================
// 🔍 Xem chi tiết tồn: hàng đang nằm ở đâu (kho → vị trí → lot).
// Vd. KVAC (VAP - Cảng) có HDPE5000 tồn 99,000 kg → Cảng Cát Lái 2,000 kg, VICT 30,000 kg…
// stock: các dòng tồn đã tải sẵn của báo cáo (không đọc thêm); filter: { item?, warehouse?, company?, location? }
// ============================================================================
const n = (v) => Number(v) || 0;
const kg = (v) => fmtNum(v, 0);

export function StockDetailModal({ stock, filter, title, onClose }) {
  const locations = useCollection('locations').rows;
  const warehouses = useCollection('warehouses').rows;
  const [mode, setMode] = useState('loc'); // loc = gộp theo vị trí, lot = từng lot / tình trạng
  const whName = useMemo(() => new Map(warehouses.map((w) => [w.code, w.name || w.code])), [warehouses]);
  const locMap = useMemo(() => new Map(locations.map((l) => [`${l.warehouse}__${l.code}`, l])), [locations]);
  const rows = useMemo(() => stock.filter((r) => (!filter.item || r.item === filter.item) && (!filter.warehouse || r.warehouse === filter.warehouse)
    && (!filter.company || (r.company || '') === filter.company) && (filter.location == null || (r.location || '') === filter.location)), [stock, filter]);
  const total = rows.reduce((s, r) => s + n(r.kg), 0);
  const oneItem = !!filter.item || new Set(rows.map((r) => r.item)).size === 1;

  const grouped = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const k = mode === 'loc' ? `${r.warehouse}__${r.location}__${r.item}` : r._id || `${r.warehouse}__${r.location}__${r.item}__${r.lot}__${r.goodsStatus}`;
      const loc = locMap.get(`${r.warehouse}__${r.location}`);
      const x = m.get(k) || { _k: k, warehouse: r.warehouse, whName: whName.get(r.warehouse) || r.warehouse, location: r.location || '', place: loc?.invoiceInfo || loc?.address || '',
        item: r.item, itemName: r.itemName, company: r.company || '', lots: new Set(), sts: new Set(), bags: 0, pallets: 0, kg: 0, inDate: '', locked: !!loc?.blockStock };
      if (r.lot) x.lots.add(r.lot); if (r.goodsStatus) x.sts.add(r.goodsStatus);
      x.bags += n(r.bags); x.pallets += n(r.pallets); x.kg += n(r.kg);
      if (r.inDate && (!x.inDate || r.inDate < x.inDate)) x.inDate = r.inDate;
      m.set(k, x);
    }
    return [...m.values()].map((x) => ({ ...x, lots: [...x.lots].join(', '), status: [...x.sts].join(', '), pct: total ? Math.round((x.kg / total) * 1000) / 10 : 0 }))
      .sort((a, b) => b.kg - a.kg);
  }, [rows, mode, locMap, whName, total]);
  // Tóm tắt theo vị trí, vd. "Cảng Cát Lái 2,000 kg · VICT 30,000 kg"
  const byLoc = useMemo(() => {
    const m = new Map();
    for (const r of rows) { const k = `${r.warehouse}__${r.location}`; m.set(k, n(m.get(k)) + n(r.kg)); }
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const multiWh = new Set(rows.map((r) => r.warehouse)).size > 1;
  const cols = [
    ...(multiWh || !filter.warehouse ? [{ key: 'warehouse', label: 'Kho', nowrap: true }, { key: 'whName', label: 'Tên kho' }] : []),
    { key: 'location', label: 'Vị trí', nowrap: true, render: (r) => <b>{r.location || '(chưa có vị trí)'}</b>, excel: (r) => r.location },
    { key: 'place', label: 'Nơi / địa chỉ' },
    ...(oneItem ? [] : [{ key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' }]),
    { key: 'company', label: 'Công ty' },
    { key: 'lots', label: 'Lot' }, { key: 'status', label: 'Tình trạng' },
    { key: 'bags', label: 'Số bao', num: true, sum: true }, { key: 'pallets', label: 'Pallet', num: true, digits: 1, sum: true },
    { key: 'kg', label: 'Tồn (kg)', num: true, sum: true, style: () => ({ fontWeight: 700 }) },
    { key: 'pct', label: '% trong tổng', num: true, digits: 1 },
    { key: 'inDate', label: 'Nhập sớm nhất', date: true, nowrap: true },
  ];
  const excel = () => exportSheets(`Chi_tiet_ton_${filter.item || filter.warehouse || ''}_${vnDate()}`, { 'Chi tiết tồn': toSheet(cols, grouped) });
  return (
    <Modal title={title || `🔍 Chi tiết tồn${filter.item ? ` ${filter.item}` : ''}${filter.warehouse ? ` tại ${filter.warehouse}` : ''}`} onClose={onClose} wide>
      <div className="card" style={{ background: 'var(--primary-soft)', marginBottom: 10 }}>
        <div><b>{filter.item || 'Mọi mã hàng'}</b>{rows[0]?.itemName && oneItem ? ` · ${rows[0].itemName}` : ''}
          {filter.location != null ? <> · vị trí <b>{filter.location || '(chưa có)'}</b></> : null}
          {filter.warehouse ? <> · kho <b>{filter.warehouse}</b> {whName.get(filter.warehouse) ? `(${whName.get(filter.warehouse)})` : ''}</> : ' · mọi kho'}
          {' '}· tổng <b>{kg(total)}</b> kg</div>
        {byLoc.length > 0 && (
          <div className="small" style={{ marginTop: 4, lineHeight: 1.7 }}>
            Đang ở: {byLoc.map(([k, v], i) => { const [w, l] = k.split('__'); return (
              <span key={k}>{i ? ' · ' : ''}{multiWh ? `${w} › ` : ''}<b>{l || '(chưa có vị trí)'}</b> {kg(v)} kg</span>
            ); })}
          </div>
        )}
      </div>
      <div className="toolbar no-print">
        <div className="seg">
          <button type="button" className={mode === 'loc' ? 'on' : ''} onClick={() => setMode('loc')}>Gộp theo vị trí</button>
          <button type="button" className={mode === 'lot' ? 'on' : ''} onClick={() => setMode('lot')}>Từng lot / tình trạng</button>
        </div>
        <span style={{ marginLeft: 'auto' }}><button className="btn" onClick={excel}>⬇ Excel</button></span>
      </div>
      <ReportTable id={`stock-detail:${mode}:${oneItem ? 1 : 0}:${multiWh ? 1 : 0}`} cols={cols} rows={grouped} empty="Không có tồn." defaultSort={[{ key: 'kg', dir: 'desc' }]}
        rowStyle={(r) => (r.locked ? { color: 'var(--muted)' } : undefined)} />
      {rows.some((r) => r.inDate) && <p className="small">Ngày nhập hiển thị: {fmtDate(rows.map((r) => r.inDate).filter(Boolean).sort()[0])} (sớm nhất) → {fmtDate(rows.map((r) => r.inDate).filter(Boolean).sort().pop())} (gần nhất).</p>}
    </Modal>
  );
}
