import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useOpCompany, useOpWarehouse, useStock } from '../../lib/hooks';
import { MOVE_TYPES, ageDays } from '../../lib/stock';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, today } from '../../lib/utils';
import { CompanyPicker, WarehousePicker } from '../../components/TripBits';
import { Empty, ErrorBox } from '../../components/ui';
import { canMove } from './MovementForm';
import { ReportTable, toSheet } from '../reports/Reports';
import { StockDetailModal } from '../../components/StockDetail';

const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const AGE = [['0–30 ngày', 0, 30], ['31–60 ngày', 31, 60], ['61–90 ngày', 61, 90], ['Trên 90 ngày', 91, 1e9]];

export default function Stock() {
  const { hasRole, isAdmin } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const [co, setCo] = useOpCompany();
  const { rows: all, loading, error } = useStock(wh);
  const rows = useMemo(() => (co ? all.filter((r) => (r.company || '') === co) : all), [all, co]);
  const ORDER = ['KTC', 'HTC', 'DGC'];
  const rank = (c) => (ORDER.includes(c) ? ORDER.indexOf(c) : 99);
  const statuses = [...useCollection('goodsStatus').rows].sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [view, setView] = useState('detail');

  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    return rows
      .filter((r) => (!st || r.goodsStatus === st) && (!f || [r.item, r.itemName, r.lot, r.location, r.pledgee].join(' ').toLowerCase().includes(f)))
      .sort((a, b) => String(a.warehouse).localeCompare(b.warehouse) || String(a.item).localeCompare(b.item) || String(a.inDate).localeCompare(b.inDate));
  }, [rows, q, st]);
  // Cột NSX / HSD chỉ hiện khi có hàng ghi hạn dùng (hạt nhựa không có)
  const hasDates = list.some((r) => r.mfgDate || r.expDate);

  // Tổng hợp theo mã hàng
  const byItem = useMemo(() => {
    const m = new Map();
    list.forEach((r) => {
      const k = `${r.warehouse}__${r.company || ''}__${r.item}`;
      const x = m.get(k) || { warehouse: r.warehouse, company: r.company || '', item: r.item, itemName: r.itemName, bags: 0, pallets: 0, kg: 0, st: {} };
      x.bags += Number(r.bags) || 0; x.pallets += Number(r.pallets) || 0; x.kg += Number(r.kg) || 0;
      x.st[r.goodsStatus] = (x.st[r.goodsStatus] || 0) + (Number(r.kg) || 0);
      m.set(k, x);
    });
    return [...m.values()];
  }, [list]);

  const statusCodes = statuses.length ? statuses.map((s) => s.code) : ['KTC', 'HTC', 'DGC'];
  const [detail, setDetail] = useState(null);
  // Bảng dùng chung của báo cáo: chọn cột, đổi thứ tự, sắp xếp nhiều cấp, lọc từng cột (lưu riêng người dùng)
  const detailCols = [
    { key: 'warehouse', label: 'Kho' }, { key: 'company', label: 'Công ty' }, { key: 'location', label: 'Vị trí', nowrap: true },
    { key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' }, { key: 'lot', label: 'Lot', nowrap: true },
    ...(hasDates ? [{ key: 'mfgDate', label: 'NSX', date: true, nowrap: true }, { key: 'expDate', label: 'HSD', date: true, nowrap: true }] : []),
    { key: 'goodsStatus', label: 'Tình trạng', render: (r) => <span className={'badge ' + (r.goodsStatus === 'HTC' ? 'red' : r.goodsStatus === 'DGC' ? 'green' : '')}>{r.goodsStatus}{r.pledgee ? ` · ${r.pledgee}` : ''}</span>, excel: (r) => r.goodsStatus },
    { key: 'pledgee', label: 'Bên nhận thế chấp' },
    { key: 'bags', label: 'Số bao', num: true, sum: true }, { key: 'pallets', label: 'Pallet', num: true, digits: 2, sum: true }, { key: 'kg', label: 'Kg', num: true, digits: 2, sum: true },
    { key: 'inDate', label: 'Ngày nhập', date: true, nowrap: true }, { key: 'age', label: 'Tuổi tồn (ngày)', num: true, sortVal: (r) => ageDays(r.inDate), render: (r) => ageDays(r.inDate), excel: (r) => ageDays(r.inDate) },
  ];
  const byItemRows = byItem.map((x) => ({ ...x, _k: `${x.warehouse}__${x.company}__${x.item}`, ...Object.fromEntries(statusCodes.map((c) => [`st_${c}`, x.st[c] || 0])) }));
  const itemCols = [
    { key: 'warehouse', label: 'Kho' }, { key: 'company', label: 'Công ty' }, { key: 'item', label: 'Mã hàng', nowrap: true }, { key: 'itemName', label: 'Tên hàng' },
    { key: 'bags', label: 'Số bao', num: true, sum: true }, { key: 'pallets', label: 'Pallet', num: true, digits: 2, sum: true }, { key: 'kg', label: 'Kg', num: true, digits: 2, sum: true },
    ...statusCodes.map((c) => ({ key: `st_${c}`, label: `Kg ${c}`, num: true, sum: true })),
  ];
  const totals = statusCodes.map((c) => [c, sum(rows.filter((r) => r.goodsStatus === c), 'kg')]);

  const exportExcel = () => exportSheets(`Ton_kho_${today()}`, {
    'Chi tiết': toSheet(detailCols, list),
    'Theo mã hàng': toSheet(itemCols, byItemRows),
    'Tuổi tồn': AGE.map(([l, a, b]) => ({ 'Tuổi tồn': l, Kg: sum(list.filter((r) => { const d = ageDays(r.inDate); return d >= a && d <= b; }), 'kg') })),
  });

  return (
    <div>
      <div className="page-head">
        <h1>🏭 Tồn kho</h1>
        <div className="actions">
          {hasRole('thu_kho') && <Link className="btn primary" to="/kho/nhan-hang">📥 Nhận hàng</Link>}
          {Object.entries(MOVE_TYPES).filter(([k]) => canMove(hasRole, k, isAdmin)).map(([k, m]) => (
            <Link key={k} className={'btn' + (k === 'in' || k === 'out' ? ' primary' : '')} to={`/kho/${k}`}>{m.icon} {m.label}</Link>
          ))}
          <button className="btn" onClick={exportExcel}>⬇ Excel</button>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><div className="stat-label">Tổng tồn</div><div className="stat-value">{fmtNum(sum(rows, 'kg'), 2)} kg</div><div className="stat-sub">= {fmtNum(sum(rows, 'kg') / 1000, 2)} tấn</div>
          <div className="stat-sub">{fmtNum(sum(rows, 'bags'))} bao · {fmtNum(sum(rows, 'pallets'), 1)} pallet</div></div>
        {totals.map(([c, kg]) => (
          <div key={c} className={'stat ' + (c === 'HTC' ? 'red' : c === 'DGC' ? 'green' : '')} style={{ cursor: 'pointer', outline: st === c ? '2px solid var(--primary)' : 'none' }}
            onClick={() => setSt(st === c ? '' : c)}>
            <div className="stat-label">{c} – {statuses.find((s) => s.code === c)?.name || ''}</div>
            <div className="stat-value">{fmtNum(kg, 2)} kg</div>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <WarehousePicker value={wh} onChange={setWh} />
        <CompanyPicker value={co} onChange={setCo} />
        <input type="search" placeholder="Tìm mã hàng, tên, lot, vị trí…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          <button type="button" className={view === 'detail' ? 'on' : ''} onClick={() => setView('detail')}>Theo vị trí, lô</button>
          <button type="button" className={view === 'item' ? 'on' : ''} onClick={() => setView('item')}>Theo mã hàng</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {loading ? <div className="table-wrap"><Empty text="Đang tải…" /></div> : view === 'detail' ? (
        <ReportTable id="stock:detail" cols={detailCols} rows={list} empty="Chưa có tồn kho." defaultSort={[{ key: 'warehouse', dir: 'asc' }, { key: 'item', dir: 'asc' }, { key: 'inDate', dir: 'asc' }]} />
      ) : (
        <>
          <p className="hint">Bấm một dòng để xem mã hàng đó đang nằm ở vị trí nào.</p>
          <ReportTable id="stock:item" cols={itemCols} rows={byItemRows} empty="Chưa có tồn kho." onRowClick={(r) => setDetail({ warehouse: r.warehouse, item: r.item, company: r.company })} rowTitle="Bấm để xem vị trí" />
        </>
      )}
      {detail && <StockDetailModal stock={rows} filter={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
