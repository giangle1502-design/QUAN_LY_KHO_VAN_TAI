import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useOpWarehouse, useStock } from '../../lib/hooks';
import { MOVE_TYPES, ageDays } from '../../lib/stock';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, today } from '../../lib/utils';
import { WarehousePicker } from '../../components/TripBits';
import { Empty, ErrorBox } from '../../components/ui';
import { canMove } from './MovementForm';

const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const AGE = [['0–30 ngày', 0, 30], ['31–60 ngày', 31, 60], ['61–90 ngày', 61, 90], ['Trên 90 ngày', 91, 1e9]];

export default function Stock() {
  const { hasRole } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const { rows, loading, error } = useStock(wh);
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

  // Tổng hợp theo mã hàng
  const byItem = useMemo(() => {
    const m = new Map();
    list.forEach((r) => {
      const k = `${r.warehouse}__${r.item}`;
      const x = m.get(k) || { warehouse: r.warehouse, item: r.item, itemName: r.itemName, bags: 0, pallets: 0, kg: 0, st: {} };
      x.bags += Number(r.bags) || 0; x.pallets += Number(r.pallets) || 0; x.kg += Number(r.kg) || 0;
      x.st[r.goodsStatus] = (x.st[r.goodsStatus] || 0) + (Number(r.kg) || 0);
      m.set(k, x);
    });
    return [...m.values()];
  }, [list]);

  const statusCodes = statuses.length ? statuses.map((s) => s.code) : ['KTC', 'HTC', 'DGC'];
  const totals = statusCodes.map((c) => [c, sum(rows.filter((r) => r.goodsStatus === c), 'kg')]);

  const exportExcel = () => exportSheets(`Ton_kho_${today()}`, {
    'Chi tiết': list.map((r, i) => ({
      STT: i + 1, Kho: r.warehouse, 'Vị trí': r.location, 'Mã hàng': r.item, 'Tên hàng': r.itemName, Lot: r.lot,
      NSX: r.mfgDate, HSD: r.expDate, 'Tình trạng': r.goodsStatus, 'Bên nhận thế chấp': r.pledgee,
      'Số bao': r.bags, Pallet: r.pallets, Kg: r.kg, 'Ngày nhập': r.inDate, 'Tuổi tồn (ngày)': ageDays(r.inDate),
    })),
    'Theo mã hàng': byItem.map((x, i) => ({
      STT: i + 1, Kho: x.warehouse, 'Mã hàng': x.item, 'Tên hàng': x.itemName, 'Số bao': x.bags, Pallet: x.pallets, Kg: x.kg,
      ...Object.fromEntries(statusCodes.map((c) => [`Kg ${c}`, x.st[c] || 0])),
    })),
    'Tuổi tồn': AGE.map(([l, a, b]) => ({ 'Tuổi tồn': l, Kg: sum(list.filter((r) => { const d = ageDays(r.inDate); return d >= a && d <= b; }), 'kg') })),
  });

  return (
    <div>
      <div className="page-head">
        <h1>🏭 Tồn kho</h1>
        <div className="actions">
          {Object.entries(MOVE_TYPES).filter(([k]) => canMove(hasRole, k)).map(([k, m]) => (
            <Link key={k} className={'btn' + (k === 'in' || k === 'out' ? ' primary' : '')} to={`/kho/${k}`}>{m.icon} {m.label}</Link>
          ))}
          <button className="btn" onClick={exportExcel}>⬇ Excel</button>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><div className="stat-label">Tổng tồn</div><div className="stat-value">{fmtNum(sum(rows, 'kg') / 1000, 2)} tấn</div>
          <div className="stat-sub">{fmtNum(sum(rows, 'bags'))} bao · {fmtNum(sum(rows, 'pallets'), 1)} pallet</div></div>
        {totals.map(([c, kg]) => (
          <div key={c} className={'stat ' + (c === 'HTC' ? 'red' : c === 'DGC' ? 'green' : '')} style={{ cursor: 'pointer', outline: st === c ? '2px solid var(--primary)' : 'none' }}
            onClick={() => setSt(st === c ? '' : c)}>
            <div className="stat-label">{c} – {statuses.find((s) => s.code === c)?.name || ''}</div>
            <div className="stat-value">{fmtNum(kg / 1000, 2)} tấn</div>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <WarehousePicker value={wh} onChange={setWh} />
        <input type="search" placeholder="Tìm mã hàng, tên, lot, vị trí…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          <button type="button" className={view === 'detail' ? 'on' : ''} onClick={() => setView('detail')}>Theo vị trí, lô</button>
          <button type="button" className={view === 'item' ? 'on' : ''} onClick={() => setView('item')}>Theo mã hàng</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {loading ? <Empty text="Đang tải…" /> : !list.length ? <Empty text="Chưa có tồn kho." /> : view === 'detail' ? (
          <table>
            <thead><tr><th className="stt">STT</th><th>Kho</th><th>Vị trí</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>HSD</th><th>Tình trạng</th>
              <th className="num">Số bao</th><th className="num">Pallet</th><th className="num">Kg</th><th>Ngày nhập</th><th className="num">Tuổi tồn</th></tr></thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={r._id}>
                  <td className="stt">{i + 1}</td><td>{r.warehouse}</td><td className="nowrap">{r.location}</td><td className="nowrap">{r.item}</td><td>{r.itemName}</td>
                  <td className="nowrap">{r.lot}</td><td className="nowrap">{fmtDate(r.expDate)}</td>
                  <td><span className={'badge ' + (r.goodsStatus === 'HTC' ? 'red' : r.goodsStatus === 'DGC' ? 'green' : '')}>{r.goodsStatus}{r.pledgee ? ` · ${r.pledgee}` : ''}</span></td>
                  <td className="num">{fmtNum(r.bags)}</td><td className="num">{fmtNum(r.pallets, 2)}</td><td className="num">{fmtNum(r.kg)}</td>
                  <td className="nowrap">{fmtDate(r.inDate)}</td><td className="num">{ageDays(r.inDate)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={8}>Cộng</td><td className="num">{fmtNum(sum(list, 'bags'))}</td><td className="num">{fmtNum(sum(list, 'pallets'), 2)}</td><td className="num">{fmtNum(sum(list, 'kg'))}</td><td colSpan={2} /></tr></tfoot>
          </table>
        ) : (
          <table>
            <thead><tr><th className="stt">STT</th><th>Kho</th><th>Mã hàng</th><th>Tên hàng</th><th className="num">Số bao</th><th className="num">Pallet</th><th className="num">Kg</th>
              {statusCodes.map((c) => <th key={c} className="num">Kg {c}</th>)}</tr></thead>
            <tbody>
              {byItem.map((x, i) => (
                <tr key={x.warehouse + x.item}>
                  <td className="stt">{i + 1}</td><td>{x.warehouse}</td><td>{x.item}</td><td>{x.itemName}</td>
                  <td className="num">{fmtNum(x.bags)}</td><td className="num">{fmtNum(x.pallets, 2)}</td><td className="num">{fmtNum(x.kg)}</td>
                  {statusCodes.map((c) => <td key={c} className="num">{fmtNum(x.st[c] || 0)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
