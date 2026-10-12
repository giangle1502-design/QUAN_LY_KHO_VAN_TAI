import { Fragment, useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useOrders } from '../../lib/hooks';
import { OPEN_STATUSES, leftKg, lineDue, lineFrom, lineTo, lineWh, transitKg } from '../../lib/orders';
import { OPEN_PLAN, planLeft, plannedByLine, usePlans } from '../../lib/shipPlans';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { Empty, ErrorBox } from '../../components/ui';

const n = (v) => Number(v) || 0;
const kg = (v) => (n(v) ? fmtNum(n(v), 2) : '');
const addDays = (ymd, d) => { const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
// Kiện / Xá: dòng đơn ghi 'Kiện' | 'Xá'; phiếu ghi palletMode 'pallet' | 'xa'
const packOf = (v) => (v === 'Kiện' || v === 'pallet' ? 'kien' : v === 'Xá' || v === 'xa' ? 'xa' : 'none');
const PACK = { xa: 'Xá', kien: 'Kiện', none: 'Chưa ghi' };

// Kế hoạch xuất nhập: tổng xuất Xá / xuất Kiện / nhập theo ngày và kho để sắp xếp nhân sự bốc xếp
export default function IOPlan({ wh, co, q }) {
  const { inMyWarehouses } = useApp();
  const [mode, setMode] = useState('plan');
  const today = vnDate();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 6));
  const [late, setLate] = useState(true);
  const [showDetail, setShowDetail] = useState(false);
  const { rows: orders, error: e1 } = useOrders('', true);
  const { rows: plans, error: e2 } = usePlans();
  const items = useCollection('items').rows;
  const whs = useCollection('warehouses').rows;
  const [moves, setMoves] = useState([]);
  const [e3, setE3] = useState('');
  useEffect(() => {
    if (mode !== 'actual') return undefined;
    const qy = query(collection(db, 'movements'), where('date', '>=', from || '0000'), where('date', '<=', to || '9999'));
    return onSnapshot(qy, (s) => { setMoves(s.docs.map((d) => ({ ...d.data(), id: d.id }))); setE3(''); }, (e) => setE3(e.message));
  }, [mode, from, to]);

  const palKg = useMemo(() => new Map(items.map((i) => [i.code, n(i.bagsPerLayer) * n(i.layersPerPallet) * n(i.bagWeight)])), [items]);
  const whName = useMemo(() => new Map(whs.map((w) => [w.code, w.name])), [whs]);

  // Từng dòng việc: { date, wh, dir 'out'|'in', pack, kg, pallets, src, ref, who, item }
  const tasks = useMemo(() => {
    const out = [];
    const push = (t) => {
      if (t.kg <= 0.001) return;
      if (co && (t.company || '') !== co) return;
      if (wh ? t.wh !== wh : t.wh && !inMyWarehouses(t.wh)) return;
      const pk = palKg.get(t.item);
      out.push({ ...t, pallets: t.pallets ?? (t.pack === 'kien' && pk ? Math.ceil(t.kg / pk) : 0) });
    };
    if (mode === 'actual') {
      for (const m of moves) {
        if (!['in', 'out'].includes(m.type) || m.status === 'cancelled') continue;
        const pack = packOf(m.palletMode);
        const pals = (m.pallets || []).reduce((s, p) => s + n(p.qty), 0);
        (m.lines || []).forEach((l, i) => push({ date: m.date, wh: m.warehouse, dir: m.type, pack, kg: Math.abs(n(l.kg)), item: l.item, company: l.company || m.company || '',
          pallets: pack === 'kien' ? (pals ? (i === 0 ? pals : 0) : Math.ceil(Math.abs(n(l.pallets)))) : 0,
          src: m.type === 'out' ? 'Phiếu xuất' : m.status === 'pending' ? 'Phiếu nhập (chờ nhận)' : 'Phiếu nhập', ref: m.id, who: m.partyName || m.partyCode || '' }));
      }
      return out;
    }
    // Kế hoạch: dự kiến xuất của Sale + phần SO còn lại chưa có dự kiến, STO, PO còn chưa về
    const planned = plannedByLine(plans);
    const byId = new Map(orders.map((o) => [o.id, o]));
    for (const p of plans) {
      if (!OPEN_PLAN.includes(p.status)) continue;
      const o = byId.get(p.orderId);
      for (const l of p.lines || []) {
        const ol = o?.lines.find((x) => x.no === l.orderLine);
        push({ date: p.date, wh: (o && ol ? lineWh(o, ol, 'out') : l.warehouse) || '', dir: 'out', pack: packOf(l.packing || ol?.packing), kg: planLeft(l), item: l.item,
          company: p.company || '', src: 'Dự kiến xuất (Sale)', ref: p.id, who: p.partyName || p.partyCode });
      }
    }
    for (const o of orders) {
      if (!OPEN_STATUSES.includes(o.status) && !(o.type === 'STO' && o.status === 'closed')) continue;
      for (const l of o.lines || []) {
        const base = { date: lineDue(o, l), pack: packOf(l.packing), item: l.item, company: o.company || '', ref: o.id };
        if (o.type === 'SO') push({ ...base, wh: lineWh(o, l, 'out'), dir: 'out', kg: leftKg(l) - (planned[o.id]?.[l.no] || 0), src: 'SO chưa có dự kiến xuất', who: o.partyName || o.partyCode });
        if (o.type === 'PO') push({ ...base, wh: lineWh(o, l, 'in'), dir: 'in', kg: leftKg(l), src: 'PO chưa về', who: o.partyName || o.partyCode });
        if (o.type === 'STO') {
          push({ ...base, wh: lineFrom(o, l), dir: 'out', kg: leftKg(l), src: 'STO xuất', who: `→ ${lineTo(o, l)}` });
          push({ ...base, wh: lineTo(o, l), dir: 'in', kg: leftKg(l) + transitKg(l), src: 'STO nhập', who: `← ${lineFrom(o, l)}` });
        }
      }
    }
    return out;
  }, [mode, moves, plans, orders, wh, co, inMyWarehouses, palKg]);

  // Ngày ngoài khoảng: quá hạn (trước "từ ngày") gộp 1 nhóm nếu tích; chưa có ngày gộp 1 nhóm
  const LATE = '0000-late';
  const NODATE = '9999-none';
  const shown = useMemo(() => tasks.map((t) => {
    if (mode === 'actual') return t;
    if (!t.date) return { ...t, day: NODATE };
    if (t.date < from) return late ? { ...t, day: LATE } : null;
    if (to && t.date > to) return null;
    return t;
  }).filter(Boolean).map((t) => ({ ...t, day: t.day || t.date }))
    .filter((t) => !q || norm([t.item, t.ref, t.who, t.wh, t.src].join(' ')).includes(q)), [tasks, mode, from, to, late, q]);

  const dayLabel = (d) => (d === LATE ? `Quá hạn (trước ${fmtDate(from)})` : d === NODATE ? 'Chưa có ngày' : fmtDate(d));
  const groups = useMemo(() => {
    const m = new Map();
    for (const t of shown) {
      const k = `${t.day}|${t.wh}`;
      const g = m.get(k) || { day: t.day, wh: t.wh, out: { xa: 0, kien: 0, none: 0 }, in: { xa: 0, kien: 0, none: 0 }, palOut: 0, palIn: 0, refs: new Set() };
      g[t.dir][t.pack] += t.kg;
      if (t.dir === 'out') g.palOut += t.pallets; else g.palIn += t.pallets;
      g.refs.add(t.ref);
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => a.day.localeCompare(b.day) || String(a.wh).localeCompare(String(b.wh)));
  }, [shown]);
  const tot = groups.reduce((s, g) => {
    for (const d of ['out', 'in']) for (const p of ['xa', 'kien', 'none']) s[d][p] += g[d][p];
    s.palOut += g.palOut; s.palIn += g.palIn;
    return s;
  }, { out: { xa: 0, kien: 0, none: 0 }, in: { xa: 0, kien: 0, none: 0 }, palOut: 0, palIn: 0 });
  const sum3 = (x) => x.xa + x.kien + x.none;
  const days = [...new Set(groups.map((g) => g.day))];

  const exportExcel = () => exportSheets(`ke-hoach-xuat-nhap-${from}-${to}`, {
    'Theo ngày, kho': groups.map((g) => ({
      'Ngày': dayLabel(g.day), 'Kho': g.wh || 'Chưa chọn kho', 'Tên kho': whName.get(g.wh) || '',
      'Xuất Xá (kg)': g.out.xa, 'Xuất Kiện (kg)': g.out.kien, 'Pallet xuất (ước)': g.palOut, 'Xuất chưa ghi Kiện/Xá (kg)': g.out.none, 'Tổng xuất (kg)': sum3(g.out),
      'Nhập Xá (kg)': g.in.xa, 'Nhập Kiện (kg)': g.in.kien, 'Pallet nhập (ước)': g.palIn, 'Nhập chưa ghi Kiện/Xá (kg)': g.in.none, 'Tổng nhập (kg)': sum3(g.in),
      'Số đơn / phiếu': g.refs.size,
    })),
    'Chi tiết': shown.map((t) => ({ 'Ngày': dayLabel(t.day), 'Kho': t.wh || 'Chưa chọn kho', 'Xuất/Nhập': t.dir === 'out' ? 'Xuất' : 'Nhập', 'Kiện/Xá': PACK[t.pack],
      'Số kg': Math.round(t.kg * 1000) / 1000, 'Pallet (ước)': t.pallets || '', 'Mã hàng': t.item, 'Nguồn': t.src, 'Số đơn / phiếu': t.ref, 'Khách / NCC / tuyến': t.who })),
  });

  const Tile = ({ label, v, pal, tone }) => (
    <div className="card" style={{ flex: '1 1 160px', padding: '10px 14px' }}>
      <div className="small">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone }}>{fmtNum(v, 0)} kg</div>
      <div className="small">= {fmtNum(v / 1000, 2)} tấn{pal ? ` · ~${fmtNum(pal, 0)} pallet` : ''}</div>
    </div>
  );

  return (
    <div>
      <div className="filters no-print">
        <div className="seg">
          <button type="button" className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>Kế hoạch (đơn còn mở)</button>
          <button type="button" className={mode === 'actual' ? 'on' : ''} onClick={() => setMode('actual')}>Thực tế (phiếu đã lập)</button>
        </div>
        <label className="small">Từ <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">đến <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className="btn sm" onClick={() => { setFrom(today); setTo(today); }}>Hôm nay</button>
        <button type="button" className="btn sm" onClick={() => { setFrom(addDays(today, 1)); setTo(addDays(today, 1)); }}>Ngày mai</button>
        <button type="button" className="btn sm" onClick={() => { setFrom(today); setTo(addDays(today, 6)); }}>7 ngày</button>
        {mode === 'plan' && <label className="small"><input type="checkbox" checked={late} onChange={(e) => setLate(e.target.checked)} /> Gồm việc quá hạn</label>}
        <label className="small"><input type="checkbox" checked={showDetail} onChange={(e) => setShowDetail(e.target.checked)} /> Xem chi tiết từng dòng</label>
        <span style={{ marginLeft: 'auto' }} />
        <button className="btn" onClick={exportExcel}>⬇ Excel</button>
        <button className="btn" onClick={() => window.print()}>🖨 In</button>
      </div>
      <p className="hint no-print">
        {mode === 'plan'
          ? <>Xuất = dự kiến xuất Sale đã lập + phần SO còn lại chưa có dự kiến (theo ngày giao) + STO kho đi. Nhập = PO chưa về (theo ETA) + STO kho đến. Kiện/Xá lấy theo dòng đơn; pallet ước tính theo quy cách mã hàng.</>
          : <>Theo phiếu xuất / nhập kho đã lập trong khoảng ngày (cả phiếu nhập chờ thủ kho nhận). Kiện/Xá, số pallet theo phiếu.</>}
      </p>
      <ErrorBox error={e1 || e2 || e3} />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Tile label="Xuất Xá" v={tot.out.xa} tone="var(--primary)" />
        <Tile label="Xuất Kiện" v={tot.out.kien} pal={tot.palOut} tone="var(--primary)" />
        {tot.out.none > 0 && <Tile label="Xuất chưa ghi Kiện/Xá" v={tot.out.none} tone="var(--amber)" />}
        <Tile label="Nhập Xá" v={tot.in.xa} tone="var(--green)" />
        <Tile label="Nhập Kiện" v={tot.in.kien} pal={tot.palIn} tone="var(--green)" />
        {tot.in.none > 0 && <Tile label="Nhập chưa ghi Kiện/Xá" v={tot.in.none} tone="var(--amber)" />}
      </div>
      <div className="table-wrap">
        {!groups.length ? <Empty text="Không có việc xuất / nhập nào trong khoảng ngày này" /> : (
          <table>
            <thead>
              <tr><th rowSpan={2}>Ngày</th><th rowSpan={2}>Kho</th><th colSpan={5} style={{ textAlign: 'center' }}>XUẤT (kg)</th><th colSpan={5} style={{ textAlign: 'center' }}>NHẬP (kg)</th><th rowSpan={2} className="num">Số đơn / phiếu</th></tr>
              <tr><th className="num">Xá</th><th className="num">Kiện</th><th className="num">Pallet</th><th className="num">Chưa ghi</th><th className="num">Tổng</th>
                <th className="num">Xá</th><th className="num">Kiện</th><th className="num">Pallet</th><th className="num">Chưa ghi</th><th className="num">Tổng</th></tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const gs = groups.filter((g) => g.day === d);
                const dayTot = gs.reduce((s, g) => {
                  for (const k of ['out', 'in']) for (const p of ['xa', 'kien', 'none']) s[k][p] += g[k][p];
                  s.palOut += g.palOut; s.palIn += g.palIn; return s;
                }, { out: { xa: 0, kien: 0, none: 0 }, in: { xa: 0, kien: 0, none: 0 }, palOut: 0, palIn: 0 });
                return (
                  <Fragment key={d}>
                    {gs.map((g, i) => (
                      <tr key={g.wh || '-'}>
                        {!i && <td rowSpan={gs.length + (gs.length > 1 ? 1 : 0)} style={{ fontWeight: 600, color: d === LATE ? 'var(--red)' : undefined }}>{dayLabel(d)}</td>}
                        <td>{g.wh || <span className="small">Chưa chọn kho</span>}{g.wh && <div className="small">{whName.get(g.wh)}</div>}</td>
                        <td className="num">{kg(g.out.xa)}</td><td className="num">{kg(g.out.kien)}</td><td className="num small">{g.palOut || ''}</td>
                        <td className="num" style={{ color: 'var(--amber)' }}>{kg(g.out.none)}</td><td className="num"><b>{kg(sum3(g.out))}</b></td>
                        <td className="num">{kg(g.in.xa)}</td><td className="num">{kg(g.in.kien)}</td><td className="num small">{g.palIn || ''}</td>
                        <td className="num" style={{ color: 'var(--amber)' }}>{kg(g.in.none)}</td><td className="num"><b>{kg(sum3(g.in))}</b></td>
                        <td className="num small" title={[...g.refs].join(', ')}>{g.refs.size}</td>
                      </tr>
                    ))}
                    {gs.length > 1 && (
                      <tr style={{ background: 'var(--bg-soft, #f6f8fb)' }}>
                        <td className="small"><b>Cộng ngày</b></td>
                        <td className="num"><b>{kg(dayTot.out.xa)}</b></td><td className="num"><b>{kg(dayTot.out.kien)}</b></td><td className="num small">{dayTot.palOut || ''}</td>
                        <td className="num">{kg(dayTot.out.none)}</td><td className="num"><b>{kg(sum3(dayTot.out))}</b></td>
                        <td className="num"><b>{kg(dayTot.in.xa)}</b></td><td className="num"><b>{kg(dayTot.in.kien)}</b></td><td className="num small">{dayTot.palIn || ''}</td>
                        <td className="num">{kg(dayTot.in.none)}</td><td className="num"><b>{kg(sum3(dayTot.in))}</b></td><td />
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={2}>TỔNG</td>
                <td className="num">{kg(tot.out.xa)}</td><td className="num">{kg(tot.out.kien)}</td><td className="num">{tot.palOut || ''}</td><td className="num">{kg(tot.out.none)}</td><td className="num">{kg(sum3(tot.out))}</td>
                <td className="num">{kg(tot.in.xa)}</td><td className="num">{kg(tot.in.kien)}</td><td className="num">{tot.palIn || ''}</td><td className="num">{kg(tot.in.none)}</td><td className="num">{kg(sum3(tot.in))}</td><td />
              </tr>
            </tbody>
          </table>
        )}
      </div>
      {showDetail && shown.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 14 }}>Chi tiết ({shown.length} dòng)</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ngày</th><th>Kho</th><th>Xuất/Nhập</th><th>Kiện/Xá</th><th className="num">Số kg</th><th className="num">Pallet</th><th>Mã hàng</th><th>Nguồn</th><th>Số đơn / phiếu</th><th>Khách / NCC / tuyến</th></tr></thead>
              <tbody>
                {[...shown].sort((a, b) => a.day.localeCompare(b.day) || String(a.wh).localeCompare(String(b.wh)) || a.dir.localeCompare(b.dir)).map((t, i) => (
                  <tr key={i}>
                    <td>{dayLabel(t.day)}</td><td>{t.wh || '–'}</td><td>{t.dir === 'out' ? '📤 Xuất' : '📥 Nhập'}</td><td>{PACK[t.pack]}</td>
                    <td className="num">{kg(t.kg)}</td><td className="num small">{t.pallets || ''}</td><td>{t.item}</td><td className="small">{t.src}</td><td className="mono">{t.ref}</td><td className="small">{t.who}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="small" style={{ marginTop: 6 }}>Đơn vị: kg. Pallet ước tính = số kg ÷ (số bao/lớp × số lớp/pallet × kg/bao) của mã hàng, làm tròn lên.</p>
    </div>
  );
}
