import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { useCollection, useOpWarehouse, useOrders, useStock, useTrips } from '../lib/hooks';
import { orderTotals } from '../lib/orders';
import { ACTIVE, ST, STATUS_META, fmtDuration, minutesBetween, nowISO, vnDate } from '../lib/trips';
import { MOVE_TYPES } from '../lib/stock';
import { fmtDate, fmtNum } from '../lib/utils';
import { StatusBadge, WarehousePicker } from '../components/TripBits';
import { Empty } from '../components/ui';

const sumKg = (rows) => rows.reduce((s, r) => s + (Number(r.kg) || 0), 0);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Trang tổng quan: xe đang trong kho, tồn theo tình trạng, vị trí sắp đầy, hàng sắp hết hạn, phiếu hôm nay
export default function Dashboard() {
  const { name, inMyWarehouses } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const { rows: trips } = useTrips(ACTIVE, wh);
  const { rows: stock } = useStock(wh);
  const locations = useCollection('locations').rows.filter((l) => inMyWarehouses(l.warehouse) && (!wh || l.warehouse === wh));
  const [moves, setMoves] = useState([]);
  const today = vnDate();

  useEffect(() => onSnapshot(query(collection(db, 'movements'), where('date', '==', today)),
    (s) => setMoves(s.docs.map((d) => d.data())), () => setMoves([])), [today]);
  const todayMoves = moves.filter((m) => m.status === 'posted' && inMyWarehouses(m.warehouse) && (!wh || m.warehouse === wh));

  const now = nowISO();
  const inYard = trips.filter((t) => [ST.WAITING_GATE, ST.PROCESSING].includes(t.status))
    .sort((a, b) => String(a.gateConfirmTime).localeCompare(String(b.gateConfirmTime)));
  const full = locations.filter((l) => Number(l.usedPct) >= 85).sort((a, b) => b.usedPct - a.usedPct);
  const empty = locations.filter((l) => l.emptyBin !== false && !l.locked).length;
  const expiring = useMemo(() => stock.filter((r) => r.expDate && r.expDate <= addDays(today, 30)).sort((a, b) => a.expDate.localeCompare(b.expDate)), [stock, today]);
  const { rows: openOrders } = useOrders('', true);
  const ordersHere = openOrders.filter((o) => o.type === 'STO' || (o.lines || []).some((l) => { const w = l.warehouse || o.warehouse; return !w || (inMyWarehouses(w) && (!wh || w === wh)); }));
  const orderSum = (ty) => {
    const list = ordersHere.filter((o) => o.type === ty);
    return { count: list.length, left: list.reduce((s, o) => s + orderTotals(o).left, 0), late: list.filter((o) => o.dueDate && o.dueDate < today).length };
  };
  const stoHere = openOrders.filter((o) => o.type === 'STO' && (o.lines || []).flatMap((l) => [l.fromWarehouse || o.fromWarehouse, l.toWarehouse || o.toWarehouse]).some((w) => inMyWarehouses(w) && (!wh || w === wh)));
  const stoTransit = stoHere.reduce((s, o) => s + orderTotals(o).transit, 0);
  const byStatus = ['KTC', 'HTC', 'DGC'].map((c) => [c, sumKg(stock.filter((r) => r.goodsStatus === c))]);

  return (
    <div>
      <div className="page-head">
        <h1>Tổng quan</h1>
        <div className="actions"><span className="small">Xin chào {name}</span><WarehousePicker value={wh} onChange={setWh} /></div>
      </div>

      <div className="section-head">Đơn hàng đang mở</div>
      <div className="stats">
        {[['SO', 'Đơn bán (SO): còn phải giao'], ['PO', 'Đơn mua (PO): còn chưa về']].map(([ty, label]) => {
          const x = orderSum(ty);
          return (
            <Link key={ty} to={`/don-hang?tab=${ty}`} className={'stat ' + (x.late ? 'red' : 'amber')} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="stat-label">{label}</div>
              <div className="stat-value">{fmtNum(x.left, 0)} kg</div>
              <div className="stat-sub">{x.count} đơn{x.late ? ` · ${x.late} đơn quá hạn` : ''}</div>
            </Link>
          );
        })}
        <Link to="/don-hang?tab=STO" className="stat" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stat-label">Chuyển kho (STO): đang đi đường</div><div className="stat-value">{fmtNum(stoTransit, 0)} kg</div><div className="stat-sub">{stoHere.length} lệnh đang mở</div>
        </Link>
        <Link to="/don-hang?tab=can-doi" className="stat" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="stat-label">Cân đối theo mã hàng</div><div className="stat-value">Xem →</div><div className="stat-sub">Tồn + PO − SO</div>
        </Link>
      </div>

      <div className="section-head">Xe đang hoạt động</div>
      <div className="stats">
        {ACTIVE.map((s) => (
          <Link key={s} to="/xe/tong-quan" className="stat" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="stat-label">{STATUS_META[s].label}</div>
            <div className="stat-value">{trips.filter((t) => t.status === s).length}</div>
          </Link>
        ))}
      </div>

      <div className="grid2">
        <div className="card">
          <div className="section-head">Xe trong kho ({inYard.length})</div>
          {!inYard.length ? <Empty text="Không có xe trong kho." /> : (
            <table><tbody>
              {inYard.map((t) => (
                <tr key={t.id}>
                  <td><span className="plate">{t.plate}</span></td><td>{t.warehouse}{t.dock ? ` · cửa ${t.dock}` : ''}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="num small">{fmtDuration(minutesBetween(t.gateConfirmTime || t.arrivalTime, now))}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
        <div className="card">
          <div className="section-head">Tồn kho: {fmtNum(sumKg(stock), 0)} kg</div>
          <table><tbody>
            {byStatus.map(([c, kg]) => (
              <tr key={c}><td><span className={'badge ' + (c === 'HTC' ? 'red' : c === 'DGC' ? 'green' : '')}>{c}</span></td><td className="num">{fmtNum(kg, 0)} kg</td></tr>
            ))}
          </tbody></table>
          <p className="small" style={{ marginTop: 8 }}>{locations.length} vị trí · {empty} vị trí trống · {full.length} vị trí ≥ 85%</p>
          <Link to="/kho/ton">Xem tồn kho →</Link>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="section-head">Vị trí sắp đầy ({full.length})</div>
          {!full.length ? <Empty text="Không có vị trí nào trên 85%." /> : (
            <table><tbody>
              {full.slice(0, 10).map((l) => (
                <tr key={l.warehouse + l.code}><td>{l.warehouse} · {l.code}</td><td className="num">{fmtNum(l.currentPallets, 1)}/{fmtNum(l.capacity)} pallet</td>
                  <td style={{ width: 140 }}><span className="meter"><span className="bar"><div className={l.usedPct >= 100 ? 'full' : 'warn'} style={{ width: `${Math.min(100, l.usedPct)}%` }} /></span>{fmtNum(l.usedPct, 1)}%</span></td></tr>
              ))}
            </tbody></table>
          )}
        </div>
        <div className="card">
          <div className="section-head">Hàng hết hạn trong 30 ngày ({expiring.length})</div>
          {!expiring.length ? <Empty text="Không có." /> : (
            <table><tbody>
              {expiring.slice(0, 10).map((r) => (
                <tr key={r._id} style={r.expDate < today ? { color: 'var(--red)' } : undefined}>
                  <td>{r.item}</td><td>lot {r.lot}</td><td>{r.warehouse} · {r.location}</td><td className="num">{fmtNum(r.kg)} kg</td><td>HSD {fmtDate(r.expDate)}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="section-head">Phiếu kho hôm nay ({todayMoves.length})</div>
        <div className="tags">
          {Object.entries(MOVE_TYPES).map(([k, m]) => {
            const list = todayMoves.filter((x) => x.type === k);
            const kg = list.reduce((s, x) => s + x.lines.reduce((a, l) => a + Math.abs(Number(l.kg) || 0), 0), 0);
            return <span key={k} className="tag" style={{ padding: '4px 10px' }}>{m.icon} {m.label}: <b>{list.length}</b> phiếu · {fmtNum(kg, 0)} kg</span>;
          })}
        </div>
        <p style={{ marginTop: 8 }}><Link to="/kho/phieu">Xem phiếu kho →</Link></p>
      </div>
    </div>
  );
}
