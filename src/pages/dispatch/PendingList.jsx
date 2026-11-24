import { Fragment, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { ScopeFilters, useOpScope } from '../../components/ScopeFilter';
import { ColumnPicker } from '../../components/FormTools';
import { ViewPresets, useTableTools } from '../../components/TableTools';
import { Empty, Modal } from '../../components/ui';
import Select from '../../components/Select';
import { usePref } from '../../lib/prefs';
import { dragHeadProps, orderCols } from '../../lib/colOrder';
import { exportSheets } from '../../lib/excel';
import { fmtDate, norm } from '../../lib/utils';
import { IN_STAGES, OUT_STAGES, addDays, dueBucket, nextAction, scopeRow, stageMeta, usePendingData } from '../../lib/pending';
import { planLeft } from '../../lib/shipPlans';
import { ActionBtn, DueCell, Items, Progress, StageBadge, TYPE_LABEL, TypeTag, kg, tan, tripText } from './bits';

// ============================================================================
// Đơn chờ xuất (SO + STO) / Đơn chờ nhập (PO + STO + SO trả hàng DRT): mỗi dòng 1 đơn còn phải làm.
// Ô số liệu trên cùng = nút lọc theo bước; nhóm theo ngày giao / kho / khách; bấm ▸ xem dòng hàng;
// tích nhiều đơn để lập phiếu gộp; cột, thứ tự cột, nhóm, mật độ, ô số liệu: mỗi người tự thiết lập (lưu theo tài khoản).
// ============================================================================

const GROUPS = [['date', 'Ngày giao / ngày về'], ['wh', 'Kho'], ['party', 'Khách / NCC / tuyến'], ['type', 'Loại đơn'], ['stage', 'Tình trạng'], ['company', 'Công ty'], ['none', 'Không nhóm']];
const HORIZON = [['all', 'Mọi ngày'], ['0', 'Đến hôm nay (gồm quá hạn)'], ['1', 'Đến ngày mai'], ['7', '7 ngày tới'], ['30', '30 ngày tới']];
const DEFAULT_LAYOUT = { group: 'date', kpi: true, compact: false, horizon: 'all', bar: true };

export default function PendingList({ kind }) {
  const isOut = kind === 'out';
  const { hasRole, isAdmin } = useApp();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const data = usePendingData();
  const scope = useOpScope();
  const today = data.today;
  const STAGES = isOut ? OUT_STAGES : IN_STAGES;
  const types = isOut ? ['SO', 'STO'] : ['PO', 'STO', 'DRT'];
  const [layout, setLayoutRaw] = usePref(`dp:${kind}:layout`, DEFAULT_LAYOUT);
  const L = { ...DEFAULT_LAYOUT, ...layout };
  const setLayout = (p) => setLayoutRaw({ ...L, ...p });
  const [type, setType] = usePref(`dp:${kind}:type`, '');
  const [stage, setStage] = useState(sp.get('buoc') || '');
  const [q, setQ] = useState(sp.get('q') || '');
  const [openId, setOpenId] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [showLayout, setShowLayout] = useState(false);

  const all = useMemo(() => (isOut ? data.out : data.inb).filter(scopeRow(scope)), [data, isOut, scope]);
  const inHorizon = (r) => L.horizon === 'all' || (r.due && r.due <= addDays(today, Number(L.horizon)));
  const base = useMemo(() => {
    const f = norm(q);
    return all.filter((r) => inHorizon(r) && (!type || r.type === type) && (!f || norm([r.id, r.refNo, r.party, r.partyCode, r.wh, r.company, r.plate, r.sales,
      ...r.items, ...r.itemNames, ...r.ships, ...(r.conts || []), ...r.slipIds, ...(r.plans || []).map((p) => p.id)].join(' ')).includes(f)));
  }, [all, q, type, L.horizon]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => base.filter((r) => !stage || (stage === 'late' ? r.late : r.stage === stage)), [base, stage]);

  // Cột: mỗi người chọn ẩn / hiện, kéo thứ tự
  const cols = [
    { key: 'id', label: 'Số đơn', locked: true, cls: 'nowrap', sortVal: (r) => r.id, render: (r) => <span className="dp-idcell"><TypeTag type={r.type} /><span><b className="mono">{r.id}</b>{r.refNo && <div className="small mono">{r.refNo}</div>}</span></span> },
    { key: 'stage', label: 'Tình trạng', cls: 'nowrap', sortVal: (r) => STAGES.findIndex((s) => s.key === r.stage), excel: (r) => stageMeta(kind, r.stage).label, render: (r) => <StageBadge r={r} /> },
    { key: 'due', label: isOut ? 'Ngày giao' : 'Ngày về / ETA', cls: 'nowrap', date: true, sortVal: (r) => r.due, render: (r) => <DueCell r={r} today={today} /> },
    { key: 'party', label: isOut ? 'Khách hàng / tuyến' : 'NCC / khách trả / tuyến', sortVal: (r) => r.party, render: (r) => <span className="dp-ell" title={r.party}>{r.party}</span> },
    { key: 'wh', label: isOut ? 'Kho xuất' : 'Kho nhập', cls: 'nowrap', sortVal: (r) => r.wh, render: (r) => r.wh || <span className="small">chưa chọn</span> },
    { key: 'company', label: 'Công ty', hideDefault: true, cls: 'nowrap', sortVal: (r) => r.company, render: (r) => r.company },
    { key: 'items', label: 'Mặt hàng', cls: 'nowrap', sortVal: (r) => r.items.join(', '), excel: (r) => r.items.join(', '), render: (r) => <Items r={r} /> },
    { key: 'itemNames', label: 'Tên hàng', hideDefault: true, sortVal: (r) => r.itemNames.join(', '), render: (r) => <span className="dp-ell small">{r.itemNames.join(', ')}</span> },
    { key: 'qty', label: 'Đặt (kg)', num: true, sortVal: (r) => r.qty, render: (r) => kg(r.qty) },
    { key: 'done', label: isOut ? 'Đã xuất' : 'Đã nhập', num: true, hideDefault: true, sortVal: (r) => r.done, render: (r) => (r.done ? kg(r.done) : <span className="small">–</span>) },
    { key: 'inSlip', label: 'Trong phiếu', num: true, hideDefault: true, title: isOut ? 'Phiếu xuất chờ giải chấp' : 'Phiếu nhập chờ thủ kho nhận', sortVal: (r) => r.inSlip, render: (r) => (r.inSlip ? kg(r.inSlip) : '') },
    ...(!isOut ? [{ key: 'transit', label: 'Đang đi đường', num: true, hideDefault: true, sortVal: (r) => r.transit || 0, render: (r) => (r.transit ? kg(r.transit) : '') }] : []),
    { key: 'left', label: isOut ? 'Còn xuất' : 'Còn nhập', title: isOut ? 'Còn phải xuất (kg)' : 'Còn phải nhập (kg)', num: true, sortVal: (r) => r.left, render: (r) => <b>{kg(r.left)}</b> },
    { key: 'prog', label: 'Tiến độ', noFilter: true, sortVal: (r) => (r.qty ? r.done / r.qty : 0), excel: (r) => (r.qty ? Math.round((r.done / r.qty) * 100) + '%' : ''), render: (r) => <Progress r={r} /> },
    ...(isOut ? [
      { key: 'ships', label: 'Mã giao', cls: 'nowrap small', hideDefault: true, sortVal: (r) => r.ships.join(', '), render: (r) => r.ships.join(', ') },
      { key: 'plans', label: 'Dự kiến xuất', cls: 'nowrap small mono', hideDefault: true, sortVal: (r) => (r.plans || []).map((p) => p.id).join(', '), render: (r) => (r.plans || []).map((p) => p.id).join(', ') },
    ] : [
      { key: 'conts', label: 'Cont / tuyến', cls: 'nowrap small mono', sortVal: (r) => (r.conts || []).join(', '), render: (r) => (r.type === 'STO' ? r.lines.map((l) => l.from).filter((x, i, a) => x && a.indexOf(x) === i).join(', ') + ' →' : (r.conts || []).join(', ')) },
    ]),
    { key: 'slips', label: isOut ? 'Phiếu chờ giải chấp' : 'Phiếu chờ nhận', cls: 'nowrap small mono', hideDefault: true, sortVal: (r) => r.slipIds.join(', '), render: (r) => r.slipIds.join(', ') },
    { key: 'plate', label: 'Số xe', hideDefault: true, cls: 'nowrap', sortVal: (r) => r.plate, render: (r) => (r.plate ? <span className="plate">{r.plate}</span> : <span className="small">–</span>) },
    { key: 'carrier', label: 'Đơn vị vận tải', hideDefault: true, cls: 'small', sortVal: (r) => r.trip?.carrierName || r.trip?.carrier || '', render: (r) => r.trip?.carrierName || r.trip?.carrier || '' },
    { key: 'sales', label: 'Sale phụ trách', hideDefault: true, cls: 'small', sortVal: (r) => r.sales, render: (r) => r.sales },
    { key: 'orderDate', label: 'Ngày lập đơn', hideDefault: true, cls: 'nowrap', date: true, sortVal: (r) => r.o.date || '', render: (r) => fmtDate(r.o.date) },
    { key: 'note', label: 'Ghi chú đơn', hideDefault: true, cls: 'small', sortVal: (r) => r.o.note || '', render: (r) => <span className="dp-ell">{r.o.note || ''}</span> },
  ];
  const [hidden, setHidden] = usePref(`dp:${kind}:hidden`, cols.filter((c) => c.hideDefault).map((c) => c.key));
  const [colOrder, setColOrder] = usePref(`dp:${kind}:cols`, []);
  const ordered = orderCols(cols, colOrder);
  const colKeys = ordered.map((c) => c.key);
  const shown = ordered.filter((c) => c.locked || !hidden.includes(c.key));
  const tools = useTableTools(`dp:${kind}`, cols, list, { defaultSort: [{ key: 'due', dir: 'asc' }] });
  const view = tools.rows;

  // Nhóm dòng (giữ thứ tự đã sắp xếp bên trong nhóm)
  const groupOf = (r) => {
    if (L.group === 'date') return dueBucket(r.due, today);
    if (L.group === 'wh') return { key: r.wh || '~', label: r.wh || 'Chưa chọn kho' };
    if (L.group === 'party') return { key: r.party || '~', label: r.party || '(chưa có)' };
    if (L.group === 'type') return { key: String(types.indexOf(r.type)), label: TYPE_LABEL[r.type] || r.type };
    if (L.group === 'stage') { const i = STAGES.findIndex((s) => s.key === r.stage); return { key: String(i), label: `${STAGES[i]?.ico || ''} ${STAGES[i]?.label || r.stage}` }; }
    if (L.group === 'company') return { key: r.company || '~', label: r.company || 'Chưa có công ty' };
    return { key: '', label: '' };
  };
  const groups = useMemo(() => {
    if (L.group === 'none') return [{ key: '', label: '', rows: view }];
    const m = new Map();
    for (const r of view) { const g = groupOf(r); if (!m.has(g.key)) m.set(g.key, { ...g, rows: [] }); m.get(g.key).rows.push(r); }
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key, 'vi', { numeric: true }));
  }, [view, L.group]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ô số liệu (đếm trên danh sách đã lọc kho / công ty / loại / tìm kiếm, chưa lọc bước)
  const cnt = (f) => { const rs = base.filter(f); return { n: rs.length, kg: rs.reduce((a, r) => a + r.left, 0) }; };
  const kpis = [
    { key: '', label: isOut ? 'Tất cả đơn chờ xuất' : 'Tất cả đơn chờ nhập', tone: 'blue', ...cnt(() => true) },
    ...STAGES.map((s) => ({ key: s.key, label: s.label, tone: { amber: 'amber', purple: 'purple', blue: 'teal', teal: 'teal' }[s.tone] || 'grey', ...cnt((r) => r.stage === s.key) })).filter((k) => k.n || stage === k.key),
    { key: 'late', label: isOut ? 'Trễ ngày giao' : 'Trễ ngày về / ETA', tone: 'red', ...cnt((r) => r.late) },
  ];
  const typeCount = (t) => base.filter((r) => !t || r.type === t).length;
  const totals = view.reduce((a, r) => ({ qty: a.qty + r.qty, done: a.done + r.done, left: a.left + r.left }), { qty: 0, done: 0, left: 0 });

  // Chọn nhiều đơn → lập phiếu gộp (1 xe)
  const selRows = view.filter((r) => sel.has(r.id));
  const toggle = (id) => setSel((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const allOn = view.length > 0 && view.every((r) => sel.has(r.id));
  const bulk = (() => {
    if (!selRows.length) return null;
    const party = new Set(selRows.map((r) => (r.type === 'STO' ? r.party : r.partyCode || r.party)));
    const co = new Set(selRows.map((r) => r.company));
    const kinds = new Set(selRows.map((r) => (r.type === 'STO' ? 'STO' : 'X')));
    const same = party.size === 1 && co.size === 1 && kinds.size === 1;
    if (!same) return { ok: false, why: 'Chỉ gộp 1 phiếu các đơn cùng khách / NCC (hoặc cùng tuyến STO) và cùng công ty.' };
    if (isOut) {
      const plans = selRows.flatMap((r) => (r.plans || []).filter((p) => (p.lines || []).some((l) => planLeft(l) > 0.001)).map((p) => p.id));
      if (plans.length && selRows.every((r) => (r.plans || []).length)) return { ok: true, to: `/kho/out?plans=${plans.join(',')}`, label: '📤 Lập phiếu xuất gộp (1 xe)' };
      return { ok: true, to: `/kho/out?order=${selRows[0].id}`, label: '📤 Lập phiếu xuất gộp (1 xe)', hint: 'Mở phiếu đơn đầu, bấm "🔎 Chọn nhiều đơn" để thêm các đơn còn lại.' };
    }
    return { ok: true, to: `/kho/in?order=${selRows[0].id}${selRows[0].type === 'DRT' ? '&src=drt' : ''}`, label: '📥 Lập phiếu nhập gộp (1 xe)', hint: 'Mở phiếu đơn đầu, bấm "🔎 Chọn nhiều đơn" để thêm các đơn còn lại.' };
  })();

  const exportExcel = (rows) => {
    const out = [];
    rows.forEach((r) => r.lines.forEach((l) => out.push({
      'Loại đơn': r.type, 'Số đơn': r.id, 'Số Ecount': r.refNo, 'Tình trạng': stageMeta(kind, r.stage).label + (r.late ? ' (trễ)' : ''),
      [isOut ? 'Ngày giao' : 'Ngày về / ETA']: l.due || r.due, [isOut ? 'Khách / tuyến' : 'NCC / tuyến']: r.party, Kho: l.wh, 'Công ty': r.company,
      'Mã hàng': l.item, 'Tên hàng': l.itemName, 'Đặt (kg)': l.qty, [isOut ? 'Đã xuất (kg)' : 'Đã nhập (kg)']: l.done, 'Trong phiếu (kg)': l.inSlip,
      [isOut ? 'Còn phải xuất (kg)' : 'Còn phải nhập (kg)']: l.left, ...(isOut ? { 'Mã giao': l.ship } : { 'Cont': l.ship || '' }),
      'Số xe': r.plate, 'Sale': r.sales,
    })));
    exportSheets(`${isOut ? 'Don_cho_xuat' : 'Don_cho_nhap'}_${today}`, { [isOut ? 'Đơn chờ xuất' : 'Đơn chờ nhập']: out.length ? out : [{ 'Số đơn': '' }] });
  };

  const newBtn = isOut ? hasRole('thu_kho') && <Link className="btn primary" to="/kho/out">➕ Lập phiếu xuất</Link>
    : isAdmin && <Link className="btn primary" to="/kho/in">➕ Lập phiếu nhập</Link>;
  const nCols = shown.length + 3;

  return (
    <div className={'dp' + (L.compact ? ' dp-compact' : '')}>
      <div className="page-head">
        <div>
          <h1>{isOut ? '📤 Đơn chờ xuất' : '📥 Đơn chờ nhập'}</h1>
          <div className="small">{isOut ? 'Mọi DO từ SO và STO chưa xuất xong, mỗi dòng 1 đơn' : 'Mọi PO, STO (đang đi đường / kho đi chưa xuất) và SO trả hàng (DRT) chưa nhập xong'}</div>
        </div>
        <div className="actions">
          <Link className="btn" to="/dieu-phoi">🧭 Bàn điều phối</Link>
          <Link className="btn" to={isOut ? '/don-hang?tab=DO' : '/don-hang?tab=cho-nhap'} title="Danh sách phiếu đã lập (cả phiếu đã xong)">🧾 {isOut ? 'Phiếu xuất đã lập' : 'Phiếu nhập đã lập'}</Link>
          <button type="button" className="btn" onClick={() => setShowLayout(true)}>⚙ Bố cục</button>
          {newBtn}
        </div>
      </div>

      {L.kpi && (
        <div className="dp-kpis">
          {kpis.map((k) => (
            <button type="button" key={k.key || 'all'} className={`dp-kpi k-${k.tone}` + (stage === k.key ? ' on' : '')} onClick={() => setStage(stage === k.key && k.key ? '' : k.key)}>
              <span className="l">{k.label}</span>
              <span className="v">{k.n}</span>
              <span className="s">{tan(k.kg)} tấn còn lại</span>
            </button>
          ))}
        </div>
      )}

      {L.bar && selRows.length > 0 && (
        <div className="dp-bulk">
          <b>Đã chọn {selRows.length} đơn · {kg(selRows.reduce((a, r) => a + r.left, 0))} kg</b>
          <span className="small">{bulk?.ok ? bulk.hint || 'Gộp được 1 phiếu' : bulk?.why}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {bulk?.ok && (isOut ? hasRole('thu_kho') : isAdmin) && <button type="button" className="btn primary" onClick={() => navigate(bulk.to)}>{bulk.label}</button>}
            <button type="button" className="btn" onClick={() => exportExcel(selRows)}>⬇ Excel đơn đã chọn</button>
            <button type="button" className="btn" onClick={() => setSel(new Set())}>✕ Bỏ chọn</button>
          </span>
        </div>
      )}

      <div className="filters dp-bar">
        <div className="seg">
          <button type="button" className={!type ? 'on' : ''} onClick={() => setType('')}>Tất cả <span className="dp-n">{typeCount('')}</span></button>
          {types.map((t) => <button type="button" key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{TYPE_LABEL[t]} <span className="dp-n">{typeCount(t)}</span></button>)}
        </div>
        <input type="search" placeholder={isOut ? 'Tìm số đơn, số Ecount, khách, mã hàng, mã giao, số xe…' : 'Tìm số đơn, số Ecount, NCC, mã hàng, cont, số xe…'} value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240, flex: 1 }} />
        <ScopeFilters scope={scope} noLoc />
        <Select value={L.horizon} onChange={(e) => setLayout({ horizon: e.target.value })} title={isOut ? 'Ngày giao' : 'Ngày về'}>
          {HORIZON.map(([k, l]) => <option key={k} value={k}>{(isOut ? 'Ngày giao: ' : 'Ngày về: ') + l}</option>)}
        </Select>
        <Select value={L.group} onChange={(e) => setLayout({ group: e.target.value })} title="Nhóm dòng theo">
          {GROUPS.map(([k, l]) => <option key={k} value={k}>Nhóm: {l}</option>)}
        </Select>
        <div className="actions">
          {tools.toolbar}
          <ColumnPicker cols={cols.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))} hidden={hidden} setHidden={setHidden} order={colOrder} setOrder={setColOrder} />
          <ViewPresets pid={`dp:${kind}`} snapshot={() => ({ ...tools.snapshot(), hidden, colOrder, layout: L, type })}
            restore={(v) => { tools.restore(v); if (v?.hidden) setHidden(v.hidden); setColOrder(v?.colOrder || []); if (v?.layout) setLayoutRaw(v.layout); if (v?.type != null) setType(v.type); }} />
          <button type="button" className="btn sm" onClick={() => exportExcel(view)}>⬇ Excel</button>
        </div>
      </div>
      {(stage || type || q) && (
        <div className="dp-chips">
          {stage && <span className="dp-chip"><b>Tình trạng:</b> {stage === 'late' ? 'trễ hạn' : stageMeta(kind, stage).label}<button type="button" onClick={() => setStage('')}>✕</button></span>}
          {type && <span className="dp-chip"><b>Loại:</b> {TYPE_LABEL[type]}<button type="button" onClick={() => setType('')}>✕</button></span>}
          {q && <span className="dp-chip"><b>Tìm:</b> {q}<button type="button" onClick={() => setQ('')}>✕</button></span>}
        </div>
      )}
      {tools.advPanel}
      {tools.popup}

      <div className="table-wrap dp-table">
        {!view.length ? <Empty text={data.loading ? 'Đang tải…' : isOut ? 'Không có đơn nào chờ xuất khớp điều kiện.' : 'Không có đơn nào chờ nhập khớp điều kiện.'} /> : (
          <table>
            <thead><tr>
              <th className="dp-cb"><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(view.map((r) => r.id)))} title="Chọn tất cả" /></th>
              <th className="dp-caret" />
              {shown.map((c) => <th key={c.key} className={c.num ? 'num' : undefined} title={c.title} {...dragHeadProps(c.key, colKeys, setColOrder)} {...tools.headProps(c)}>{c.label}{tools.headMark(c)}</th>)}
              <th className="dp-act">Thao tác</th>
            </tr></thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key || 'all'}>
                  {g.label && (
                    <tr className={'dp-grp' + (L.group === 'date' && g.key === '0' ? ' late' : '')}>
                      <td colSpan={nCols}>{L.group === 'date' && g.key === '0' ? '🔴 ' : ''}{g.label}<span className="dp-gs">{g.rows.length} đơn · {kg(g.rows.reduce((a, r) => a + r.left, 0))} kg</span></td>
                    </tr>
                  )}
                  {g.rows.map((r) => {
                    const open = openId === r.id;
                    const warn = !r.late && (r.stage === 'goods' || r.stage === 'release' || (r.stage === 'truck' && !r.plate));
                    return (
                      <Fragment key={r.key}>
                        <tr className={'dp-row' + (r.late ? ' late' : warn ? ' warn' : '') + (open ? ' open' : '')} onClick={() => setOpenId(open ? '' : r.id)}>
                          <td className="dp-cb" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                          <td className="dp-caret"><span>▸</span></td>
                          {shown.map((c) => <td key={c.key} className={c.cls || (c.num ? 'num' : undefined)}>{c.render(r)}</td>)}
                          <td className="dp-act" onClick={(e) => e.stopPropagation()}>
                            <ActionBtn a={nextAction(r, { hasRole, isAdmin })} />
                            <Link className="btn sm" to={`/don-hang?tab=${r.type}&q=${r.id}`} title="Mở đơn">↗</Link>
                          </td>
                        </tr>
                        {open && <tr className="dp-det"><td colSpan={nCols}><Detail r={r} kind={kind} /></td></tr>}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
            <tfoot><tr>
              <td colSpan={2} />
              {shown.map((c, i) => <td key={c.key} className={c.num ? 'num' : undefined}>{i === 0 ? `Tổng ${view.length} đơn` : c.key === 'qty' ? kg(totals.qty) : c.key === 'done' ? kg(totals.done) : c.key === 'left' ? kg(totals.left) : ''}</td>)}
              <td className="dp-act" />
            </tr></tfoot>
          </table>
        )}
      </div>
      <div className="dp-legend small">
        <span><i className="lg-red" />Viền đỏ: quá hạn</span>
        <span><i className="lg-amber" />Viền cam: cần chú ý (chờ hàng về, chờ giải chấp, xe chưa có số)</span>
        <span>Bấm dòng để xem dòng hàng · kéo tiêu đề cột để đổi thứ tự · Shift + bấm tiêu đề để sắp nhiều cấp</span>
      </div>

      {showLayout && (
        <Modal title="⚙ Bố cục danh sách (riêng tài khoản của bạn)" onClose={() => setShowLayout(false)}>
          <div className="dp-layout-form">
            <label><input type="checkbox" checked={L.kpi} onChange={(e) => setLayout({ kpi: e.target.checked })} /> Hiện các ô số liệu trên cùng (bấm để lọc)</label>
            <label><input type="checkbox" checked={L.bar} onChange={(e) => setLayout({ bar: e.target.checked })} /> Hiện thanh thao tác khi chọn nhiều đơn</label>
            <label><input type="checkbox" checked={L.compact} onChange={(e) => setLayout({ compact: e.target.checked })} /> Dòng gọn (nhiều dòng trên màn hình hơn)</label>
            <label>Nhóm dòng theo <Select value={L.group} onChange={(e) => setLayout({ group: e.target.value })}>{GROUPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
            <label>{isOut ? 'Ngày giao' : 'Ngày về'} mặc định <Select value={L.horizon} onChange={(e) => setLayout({ horizon: e.target.value })}>{HORIZON.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
            <p className="small">Cột hiển thị và thứ tự cột: dùng nút ⚙ Cột hiển thị hoặc kéo tiêu đề cột. Lưu cả bộ (cột, lọc, sắp xếp, bố cục) thành mẫu bằng nút 💾 Mẫu.</p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => { setLayoutRaw(DEFAULT_LAYOUT); setHidden(cols.filter((c) => c.hideDefault).map((c) => c.key)); setColOrder([]); }}>↺ Về mặc định</button>
              <button type="button" className="btn primary" onClick={() => setShowLayout(false)}>Xong</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Chi tiết đơn khi bấm dòng: dòng hàng còn phải làm, phiếu / dự kiến / xe liên quan
function Detail({ r, kind }) {
  const isOut = kind === 'out';
  const t = r.trip;
  return (
    <div className="dp-detbox">
      <div>
        <div className="dp-h5">Dòng hàng còn phải {isOut ? 'xuất' : 'nhập'} của {r.id}</div>
        <table className="dp-mini">
          <thead><tr><th>#</th><th>Mã hàng</th><th>Tên hàng</th><th>{isOut ? 'Kho xuất' : 'Kho nhập'}</th><th>{isOut ? 'Ngày giao' : 'Ngày về'}</th>
            {isOut ? <th>Mã giao</th> : <th>{r.type === 'STO' ? 'Kho đi' : 'Cont'}</th>}
            <th className="num">Đặt</th><th className="num">{isOut ? 'Đã xuất' : 'Đã nhập'}</th><th className="num">Trong phiếu</th>{r.type === 'STO' && !isOut && <th className="num">Đi đường</th>}<th className="num">Còn lại</th></tr></thead>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.no}>
                <td>{l.no}</td><td className="mono">{l.item}</td><td>{l.itemName}</td><td>{l.wh}</td><td className="nowrap">{fmtDate(l.due)}</td>
                <td className="small">{isOut ? l.ship : r.type === 'STO' ? l.from : l.ship}{l.goods ? <span className="badge" style={{ marginLeft: 4 }}>⏳ chờ {l.goods}</span> : null}</td>
                <td className="num">{kg(l.qty)}</td><td className="num">{kg(l.done)}</td><td className="num">{l.inSlip ? kg(l.inSlip) : ''}</td>
                {r.type === 'STO' && !isOut && <td className="num">{l.transit ? kg(l.transit) : ''}</td>}
                <td className="num"><b>{kg(l.left)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="dp-h5">Liên quan</div>
        <ul className="dp-rel">
          <li><span className="small">Đơn:</span> <Link to={`/don-hang?tab=${r.type}&q=${r.id}`}>{r.id}</Link>{r.refNo ? ` · ${r.refNo}` : ''}{r.o.date ? ` · lập ${fmtDate(r.o.date)}` : ''}{r.sales ? ` · sale ${r.sales}` : ''}</li>
          {(r.plans || []).map((p) => <li key={p.id}><span className="small">Dự kiến xuất:</span> <Link to="/du-kien-xuat">{p.id}</Link> · {fmtDate(p.date)} · còn {kg((p.lines || []).reduce((a, l) => a + planLeft(l), 0))} kg</li>)}
          {r.slipIds.map((id) => <li key={id}><span className="small">{isOut ? 'Phiếu xuất chờ giải chấp:' : 'Phiếu nhập chờ nhận:'}</span> <Link to={`/kho/phieu/${id}/in`} target="_blank">{id}</Link></li>)}
          {t ? <li><span className="small">Xe:</span> <span className="plate">{t.plate || '—'}</span> {t.carrierName || t.carrier || ''} {t.driverName ? `· ${t.driverName}` : ''}{t.driverPhone ? ` ${t.driverPhone}` : ''} · <b>{tripText(t)}</b> <Link to="/xe/tong-quan">(chuyến {t.id})</Link></li>
            : <li className="small">Chưa có xe gắn với đơn này.</li>}
          {r.o.note && <li><span className="small">Ghi chú:</span> {r.o.note}</li>}
        </ul>
      </div>
    </div>
  );
}
