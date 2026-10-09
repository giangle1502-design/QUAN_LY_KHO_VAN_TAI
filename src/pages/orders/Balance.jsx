import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useOpCompany, useOpWarehouse, useOrders, useStock } from '../../lib/hooks';
import { leftKg, transitKg } from '../../lib/orders';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtNum, norm } from '../../lib/utils';
import { CompanyPicker, WarehousePicker } from '../../components/TripBits';
import { Empty, ErrorBox } from '../../components/ui';

const t = (kg) => fmtNum(Number(kg) || 0, 2);

// Cân đối theo mã hàng: tồn được xuất + hàng mua chưa về − hàng bán chưa giao
export default function Balance() {
  const { inMyWarehouses } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const [co, setCo] = useOpCompany();
  const { rows: allStock } = useStock(wh);
  const { rows: allOrders, error } = useOrders('', true);
  const stock = useMemo(() => (co ? allStock.filter((r) => (r.company || '') === co) : allStock), [allStock, co]);
  const orders = useMemo(() => (co ? allOrders.filter((o) => (o.company || '') === co) : allOrders), [allOrders, co]);
  const statuses = useCollection('goodsStatus').rows;
  const items = useCollection('items').rows;
  const [q, setQ] = useState('');
  const [onlyShort, setOnlyShort] = useState(false);

  const rows = useMemo(() => {
    const locked = new Set(statuses.filter((s) => s.allowOutbound === false).map((s) => s.code));
    const names = new Map(items.map((i) => [i.code, i.name]));
    const m = new Map();
    const get = (code, nm) => {
      if (!m.has(code)) m.set(code, { item: code, name: nm || names.get(code) || '', usable: 0, locked: 0, so: 0, po: 0, transit: 0, soOrders: new Set(), poOrders: new Set() });
      return m.get(code);
    };
    for (const r of stock) {
      const x = get(r.item, r.itemName);
      if (locked.has(r.goodsStatus)) x.locked += Number(r.kg) || 0;
      else x.usable += Number(r.kg) || 0;
    }
    // Đơn chưa gắn kho được tính vào mọi kho
    for (const o of orders) {
      // STO: kho đi coi như phải giao, kho đến coi như sắp về; xem tất cả kho thì chỉ còn hàng đang đi đường
      if (o.type === 'STO') {
        for (const l of o.lines) {
          const fw = l.fromWarehouse || o.fromWarehouse;
          const tw = l.toWarehouse || o.toWarehouse;
          const from = !wh ? inMyWarehouses(fw) : fw === wh;
          const to = !wh ? inMyWarehouses(tw) : tw === wh;
          const x = get(l.item, l.itemName);
          const left = leftKg(l);
          const tr = transitKg(l);
          if (from && !to) { x.so += left; if (left > 0) x.soOrders.add(o.id); }
          if (to && !from) { x.po += left + tr; if (left + tr > 0) x.poOrders.add(o.id); }
          if (from && to) { x.transit += tr; if (tr > 0) x.poOrders.add(o.id); }
        }
        continue;
      }
      for (const l of o.lines) {
        const lw = l.warehouse || o.warehouse;
        if (lw && (!inMyWarehouses(lw) || (wh && lw !== wh))) continue;
        const left = leftKg(l);
        if (left <= 0) continue;
        const x = get(l.item, l.itemName);
        if (o.type === 'SO') { x.so += left; x.soOrders.add(o.id); } else { x.po += left; x.poOrders.add(o.id); }
      }
    }
    return [...m.values()].map((x) => ({ ...x, now: x.usable - x.so, plan: x.usable + x.transit + x.po - x.so }))
      .sort((a, b) => a.plan - b.plan || a.item.localeCompare(b.item));
  }, [stock, orders, statuses, items, inMyWarehouses, wh]);

  const f = norm(q);
  const list = rows.filter((r) => (!f || norm(`${r.item} ${r.name}`).includes(f)) && (!onlyShort || r.now < 0 || r.plan < 0));
  const short = rows.filter((r) => r.plan < 0).length;

  const exportExcel = () => exportSheets(`Can_doi_ma_hang_${vnDate()}`, {
    'Cân đối': list.map((r) => ({
      'Mã hàng': r.item, 'Tên hàng': r.name, 'Tồn được xuất (kg)': r.usable, 'Tồn bị khóa xuất - HTC (kg)': r.locked,
      'SO còn phải giao (kg)': r.so, 'PO còn chưa về (kg)': r.po, 'Đang đi đường - STO (kg)': r.transit, 'Thiếu/dư ngay (kg)': r.now, 'Dự kiến sau khi PO về (kg)': r.plan,
      'Đơn bán': [...r.soOrders].join(', '), 'Đơn mua': [...r.poOrders].join(', '),
    })),
  });

  return (
    <div>
      <p className="hint">
        <b>Thiếu/dư ngay</b> = tồn được xuất − SO còn phải giao. <b>Dự kiến</b> = tồn được xuất + PO còn chưa về − SO còn phải giao.
        Hàng thế chấp (HTC) không tính vào tồn được xuất. Đơn chưa ghi kho được tính cho mọi kho.
        Lệnh chuyển kho (STO): xem 1 kho thì kho đi tính như SO, kho đến tính như PO; xem tất cả kho thì hàng đang đi đường cộng vào Dự kiến.
      </p>
      <div className="filters">
        <WarehousePicker value={wh} onChange={setWh} />
        <CompanyPicker value={co} onChange={setCo} />
        <input type="search" placeholder="Tìm mã hàng…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="small"><input type="checkbox" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} /> Chỉ mã hàng bị thiếu</label>
        <span className="small">{short ? <b style={{ color: 'var(--red)' }}>{short} mã hàng dự kiến thiếu</b> : 'Không mã hàng nào dự kiến thiếu'}</span>
        <Link className="btn" style={{ marginLeft: 'auto' }} to="/kho/giai-chap?tab=thieu">⚠ Hàng thiếu cần giải chấp</Link>
        <button className="btn" onClick={exportExcel}>⬇ Excel</button>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {!list.length ? <Empty /> : (
          <table>
            <thead><tr><th>Mã hàng</th><th>Tên hàng</th><th className="num">Tồn được xuất</th><th className="num">Tồn HTC (khóa)</th>
              <th className="num">SO còn phải giao</th><th className="num">PO còn chưa về</th><th className="num">Đang đi đường (STO)</th><th className="num">Thiếu/dư ngay</th><th className="num">Dự kiến</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.item}>
                  <td>{r.item}</td><td>{r.name}</td><td className="num">{t(r.usable)}</td><td className="num small">{r.locked ? t(r.locked) : ''}</td>
                  <td className="num" title={[...r.soOrders].join(', ')}>{r.so ? t(r.so) : ''}</td>
                  <td className="num" title={[...r.poOrders].join(', ')}>{r.po ? t(r.po) : ''}</td>
                  <td className="num">{r.transit ? t(r.transit) : ''}</td>
                  <td className="num" style={r.now < 0 ? { color: 'var(--amber)', fontWeight: 600 } : undefined}>{t(r.now)}</td>
                  <td className="num" style={r.plan < 0 ? { color: 'var(--red)', fontWeight: 700 } : { fontWeight: 600 }}>{t(r.plan)}{r.plan < 0 ? ' ⚠' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="small" style={{ marginTop: 6 }}>Đơn vị: kg.</p>
    </div>
  );
}
