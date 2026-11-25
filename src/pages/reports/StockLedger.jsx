import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useScope } from '../../components/ScopeFilter';
import { useApp } from '../../context/AppContext';
import { useCollection, useStock } from '../../lib/hooks';
import { useMovesRange } from '../../lib/slips';
import { effectsOf } from '../../lib/stock';
import { MVT, lineCode } from '../../lib/moveCodes';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { ErrorBox, Modal } from '../../components/ui';
import { ReportTable, toSheet } from './Reports';

// ============================================================================
// Báo cáo xuất nhập tồn theo mã hàng: Tồn đầu, Nhập, Xuất, Tồn cuối trong khoảng ngày.
// Mọi thay đổi tồn đều đi qua phiếu kho (movements) nên tính lùi từ tồn hiện tại:
//   Tồn cuối = tồn hiện tại − phát sinh sau "đến ngày";  Tồn đầu = Tồn cuối − Nhập + Xuất.
// Chỉ đọc phiếu từ "từ ngày" tới nay (không đọc lại toàn bộ lịch sử) để tiết kiệm lượt đọc.
// Phiếu chờ nhận / chờ giải chấp chưa vào tồn và phiếu đã hủy không tính.
// ============================================================================

const n = (v) => Number(v) || 0;
const EPS = 0.0005;
const addDays = (ymd, d) => { const x = new Date(`${ymd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

// Nhóm cột chi tiết nhập / xuất theo movetype (mặc định ẩn, bật ở ⚙ Cột hiển thị)
const KINDS = [
  ['inPO', 'Nhập mua (PO)', 'in'], ['inSTO', 'Nhập chuyển kho (STO)', 'in'], ['inRet', 'Nhập khách trả về', 'in'],
  ['inDirect', 'Nhập trực tiếp / tồn đầu kỳ', 'in'], ['adjUp', 'Điều chỉnh tăng (kiểm kê)', 'in'],
  ['outSO', 'Xuất bán (SO)', 'out'], ['outSTO', 'Xuất chuyển kho (STO)', 'out'], ['outRTV', 'Xuất trả NCC', 'out'],
  ['outOther', 'Xuất khác', 'out'], ['adjDown', 'Điều chỉnh giảm (kiểm kê)', 'out'],
  ['internal', 'Chuyển vị trí / đổi tình trạng (±)', ''],
];
function kindOf(m, code) {
  if (code === 101) return m.source === 'STO' || m.orderType === 'STO' || String(m.orderId || '').startsWith('STO') ? 'inSTO' : 'inPO';
  if (code === 651) return 'inRet';
  if (code === 501 || code === 561) return 'inDirect';
  if (code === 701) return 'adjUp';
  if (code === 702) return 'adjDown';
  if (code === 601) return 'outSO';
  if (code === 641) return 'outSTO';
  if (code === 122) return 'outRTV';
  if (code === 201) return 'outOther';
  return 'internal';
}

const GROUPS = [
  ['item', 'Mã hàng'], ['item-wh', 'Mã hàng + Kho'], ['item-co', 'Mã hàng + Công ty'], ['item-wh-co', 'Mã hàng + Kho + Công ty'],
];

export default function StockLedger({ wh, co, q }) {
  const S = useScope(wh, co);
  const { inMyWarehouses } = useApp();
  const today = vnDate();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [group, setGroup] = useState('item');
  const [scope, setScope] = useState('any');
  const [detail, setDetail] = useState(null);
  const { rows: stock, error: e1, loading: l1 } = useStock(S.wh);
  const { rows: moves, error: e2, loading: l2 } = useMovesRange(from || '0000', '9999');
  const items = useCollection('items').rows;
  const whs = useCollection('warehouses').rows;
  const companies = useCollection('companies').rows;
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const whLabel = useMemo(() => new Map(whs.map((w) => [w.code, `${w.company ? `${w.company} - ` : ''}${w.name || w.code}`])), [whs]);
  const coName = useMemo(() => new Map(companies.map((c) => [c.code, c.name || c.code])), [companies]);
  const toEnd = to && to >= from ? to : '9999';

  const keyOf = (e) => {
    const w = group.includes('wh') ? e.warehouse : '';
    const c = group.includes('co') ? e.company || '' : '';
    return `${e.item}|${w}|${c}`;
  };
  const inScope = (e) => inMyWarehouses(e.warehouse) && S.row(e);

  const { rows, lines } = useMemo(() => {
    const m = new Map();
    const get = (e) => {
      const k = keyOf(e);
      let x = m.get(k);
      if (!x) {
        x = { _k: k, item: e.item, itemName: itemMap.get(e.item)?.name || e.itemName || '', warehouse: group.includes('wh') ? e.warehouse : '',
          company: group.includes('co') ? e.company || '' : '', now: 0, after: 0, inKg: 0, outKg: 0, nMoves: 0 };
        for (const [kk] of KINDS) x[kk] = 0;
        m.set(k, x);
      }
      if (!x.itemName && e.itemName) x.itemName = e.itemName;
      return x;
    };
    for (const r of stock) if (inScope(r)) get(r).now += n(r.kg);
    // Dòng phát sinh trong kỳ (cho bảng chi tiết khi bấm mã hàng)
    const ls = [];
    for (const mv of moves) {
      if (mv.status !== 'posted' || !mv.date) continue;
      const inPeriod = mv.date <= toEnd;
      (mv.lines || []).forEach((l, i) => {
        const code = lineCode(mv, l);
        const kind = kindOf(mv, code);
        for (const e of effectsOf({ ...mv, lines: [l] })) {
          if (!inScope(e) || Math.abs(n(e.dKg)) < EPS) continue;
          const x = get(e);
          if (!inPeriod) { x.after += n(e.dKg); continue; }
          x[kind] += kind === 'internal' ? n(e.dKg) : Math.abs(n(e.dKg));
          x.nMoves++;
          ls.push({ _k: `${mv.id}|${i}|${e.location}|${e.goodsStatus}|${ls.length}`, key: x._k, date: mv.date, id: mv.id, kind, code,
            codeLabel: MVT[code]?.label || '', orderId: mv.orderId || '', party: mv.partyName || mv.partyCode || '', warehouse: e.warehouse,
            company: e.company || '', location: e.location || '', lot: e.lot || '', status: e.goodsStatus || '',
            inKg: n(e.dKg) > 0 ? n(e.dKg) : 0, outKg: n(e.dKg) < 0 ? -n(e.dKg) : 0, createdAt: mv.createdAt || '' });
        }
      });
    }
    const out = [];
    for (const x of m.values()) {
      // Chuyển vị trí / đổi tình trạng trong cùng nhóm tự triệt tiêu; còn dư (vd. lọc theo vị trí) thì cộng vào nhập / xuất
      const inKg = x.inPO + x.inSTO + x.inRet + x.inDirect + x.adjUp + Math.max(x.internal, 0);
      const outKg = x.outSO + x.outSTO + x.outRTV + x.outOther + x.adjDown + Math.max(-x.internal, 0);
      const end = x.now - x.after;
      const begin = end - inKg + outKg;
      const r = { ...x, inKg, outKg, end, begin, whName: x.warehouse ? whLabel.get(x.warehouse) || x.warehouse : '', coName: x.company ? coName.get(x.company) || x.company : '' };
      for (const k of ['begin', 'inKg', 'outKg', 'end']) if (Math.abs(r[k]) < EPS) r[k] = 0;
      if (scope === 'moved' && !x.nMoves) continue;
      if (scope === 'any' && !x.nMoves && !r.begin && !r.end) continue;
      if (q && !norm([r.item, r.itemName, r.warehouse, r.whName, r.company].join(' ')).includes(q)) continue;
      out.push(r);
    }
    out.sort((a, b) => a.item.localeCompare(b.item) || a.warehouse.localeCompare(b.warehouse) || a.company.localeCompare(b.company));
    return { rows: out, lines: ls };
  }, [stock, moves, toEnd, group, scope, q, itemMap, whLabel, coName, S, inMyWarehouses]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (r) => setDetail(r);
  const cols = [
    { key: 'item', label: 'Mã hàng', nowrap: true, render: (r) => <b>{r.item}</b>, excel: (r) => r.item, onClick: open, clickTitle: 'Bấm để xem từng phiếu nhập / xuất trong kỳ' },
    { key: 'itemName', label: 'Tên hàng' },
    ...(group.includes('wh') ? [{ key: 'whName', label: 'Kho', sortVal: (r) => r.warehouse, title: (r) => r.warehouse }] : []),
    ...(group.includes('co') ? [{ key: 'company', label: 'Công ty', nowrap: true, render: (r) => <span title={r.coName}>{r.company}</span>, excel: (r) => r.company }] : []),
    { key: 'begin', label: 'Tồn đầu (kg)', ton: true, sum: true },
    { key: 'inKg', label: 'Nhập (kg)', ton: true, sum: true, style: (r) => (r.inKg ? { color: '#0a7a33' } : undefined) },
    { key: 'outKg', label: 'Xuất (kg)', ton: true, sum: true, style: (r) => (r.outKg ? { color: '#b42318' } : undefined) },
    { key: 'end', label: 'Tồn cuối (kg)', ton: true, sum: true, style: () => ({ fontWeight: 700 }) },
    ...KINDS.map(([k, l]) => ({ key: k, label: `${l} (kg)`, ton: true, sum: true, hideDefault: true })),
    { key: 'nMoves', label: 'Số dòng phát sinh', num: true, hideDefault: true },
    { key: 'now', label: 'Tồn hiện tại (kg)', ton: true, sum: true, hideDefault: true },
  ];

  const period = `${fmtDate(from)} – ${fmtDate(toEnd === '9999' ? today : toEnd)}`;
  const excel = () => exportSheets(`BC_xuat_nhap_ton_${from}_${toEnd === '9999' ? today : toEnd}`, {
    'Xuất nhập tồn': toSheet(cols, rows),
    'Chi tiết phát sinh': lines.length ? lines.map((l, i) => ({ STT: i + 1, 'Ngày': l.date, 'Số phiếu': l.id, 'Movetype': l.code, 'Nghiệp vụ': l.codeLabel,
      'Đơn': l.orderId, 'KH / NCC': l.party, 'Mã hàng': l.key.split('|')[0], 'Kho': l.warehouse, 'Công ty': l.company, 'Vị trí': l.location, Lot: l.lot,
      'Tình trạng': l.status, 'Nhập (kg)': l.inKg, 'Xuất (kg)': l.outKg })) : [{}],
  });
  const quick = [
    ['Hôm nay', today, today],
    ['Tháng này', `${today.slice(0, 8)}01`, today],
    ['Tháng trước', (() => { const d = addDays(`${today.slice(0, 8)}01`, -1); return `${d.slice(0, 8)}01`; })(), addDays(`${today.slice(0, 8)}01`, -1)],
    ['30 ngày', addDays(today, -29), today],
    ['Năm nay', `${today.slice(0, 4)}-01-01`, today],
  ];

  return (
    <>
      <ErrorBox error={e1 || e2} />
      <div className="toolbar no-print" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="small">Từ ngày <input type="date" value={from} max={to || undefined} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="small">Đến ngày <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="seg">
          {quick.map(([l, f, t]) => <button key={l} type="button" className={from === f && to === t ? 'on' : ''} onClick={() => { setFrom(f); setTo(t); }}>{l}</button>)}
        </div>
      </div>
      <div className="toolbar no-print" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="small">Xem theo</span>
        <div className="seg">
          {GROUPS.map(([k, l]) => <button key={k} type="button" className={group === k ? 'on' : ''} onClick={() => setGroup(k)}>{l}</button>)}
        </div>
        <div className="seg">
          {[['any', 'Có tồn hoặc phát sinh'], ['moved', 'Chỉ mã có phát sinh'], ['all', 'Tất cả']].map(([k, l]) => (
            <button key={k} type="button" className={scope === k ? 'on' : ''} onClick={() => setScope(k)}>{l}</button>
          ))}
        </div>
        <span className="small">{rows.length} dòng{l1 || l2 ? ' · đang tải…' : ''}</span>
        <span style={{ marginLeft: 'auto' }} className="actions">
          <button className="btn" onClick={excel}>⬇ Excel</button>
          <button className="btn" onClick={() => window.print()}>🖨 In</button>
        </span>
      </div>
      <p className="hint no-print">Kỳ {period}. Tồn cuối = Tồn đầu + Nhập − Xuất (kg). Phiếu đã hủy, phiếu chờ nhận hàng / chờ giải chấp chưa tính. Bấm mã hàng để xem từng phiếu trong kỳ; bật thêm cột chi tiết (Nhập mua, Xuất bán, Điều chỉnh…) ở ⚙ Cột hiển thị.</p>
      <p className="print-only small"><b>Kỳ: {period}</b></p>
      <ReportTable id={`rp-xnt-${group}`} cols={cols} rows={rows} empty={l1 || l2 ? 'Đang tải…' : 'Không có tồn hoặc phát sinh trong kỳ.'}
        defaultSort={[{ key: 'item', dir: 'asc' }]} />
      {detail && <LedgerDetail row={detail} lines={lines.filter((l) => l.key === detail._k)} period={period} onClose={() => setDetail(null)} />}
    </>
  );
}

// Thẻ kho của 1 dòng: tồn đầu, từng phiếu nhập / xuất trong kỳ, tồn lũy kế
function LedgerDetail({ row, lines, period, onClose }) {
  // Chuyển vị trí / đổi tình trạng trong cùng dòng báo cáo tự triệt tiêu: mặc định ẩn cho gọn
  const [showInternal, setShowInternal] = useState(Math.abs(row.internal) > EPS);
  const nInternal = lines.filter((l) => l.kind === 'internal').length;
  const list = useMemo(() => {
    let bal = row.begin;
    return lines.filter((l) => showInternal || l.kind !== 'internal').sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))
      .map((l) => { bal += l.inKg - l.outKg; return { ...l, bal }; });
  }, [lines, row.begin, showInternal]);
  const cols = [
    { key: 'date', label: 'Ngày', date: true, nowrap: true },
    { key: 'id', label: 'Số phiếu', nowrap: true, render: (r) => <Link className="mono" to={`/kho/phieu/${r.id}/in`} target="_blank">{r.id}</Link>, excel: (r) => r.id },
    { key: 'code', label: 'Movetype', nowrap: true, hideDefault: true },
    { key: 'codeLabel', label: 'Nghiệp vụ' },
    { key: 'orderId', label: 'Đơn', nowrap: true },
    { key: 'party', label: 'KH / NCC' },
    { key: 'warehouse', label: 'Kho', nowrap: true, hideDefault: !!row.warehouse },
    { key: 'company', label: 'Công ty', nowrap: true, hideDefault: true },
    { key: 'location', label: 'Vị trí', nowrap: true },
    { key: 'lot', label: 'Lot', hideDefault: true },
    { key: 'status', label: 'Tình trạng', hideDefault: true },
    { key: 'inKg', label: 'Nhập (kg)', ton: true, sum: true, render: (r) => (r.inKg ? fmtNum(r.inKg, 3) : '') },
    { key: 'outKg', label: 'Xuất (kg)', ton: true, sum: true, render: (r) => (r.outKg ? fmtNum(r.outKg, 3) : '') },
    { key: 'bal', label: 'Tồn lũy kế (kg)', ton: true, noFilter: true },
  ];
  const t = (v) => fmtNum(v, 3);
  const title = `📒 ${row.item}${row.itemName ? ` · ${row.itemName}` : ''}${row.whName ? ` · ${row.whName}` : ''}${row.company ? ` · ${row.company}` : ''}`;
  const excel = () => exportSheets(`The_kho_${row.item}`, { 'Thẻ kho': toSheet(cols, list) });
  return (
    <Modal title={title} wide onClose={onClose}>
      <div className="toolbar">
        <span className="small">Kỳ {period} · Tồn đầu <b>{t(row.begin)}</b> · Nhập <b style={{ color: '#0a7a33' }}>{t(row.inKg)}</b> · Xuất <b style={{ color: '#b42318' }}>{t(row.outKg)}</b> · Tồn cuối <b>{t(row.end)}</b> kg</span>
        {nInternal > 0 && <label className="small"><input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} /> Hiện chuyển vị trí / đổi tình trạng ({nInternal} dòng)</label>}
        <span style={{ marginLeft: 'auto' }}><button className="btn" onClick={excel}>⬇ Excel</button></span>
      </div>
      <ReportTable id="rp-xnt-detail" cols={cols} rows={list} empty="Không có phiếu nhập / xuất trong kỳ." />
    </Modal>
  );
}
