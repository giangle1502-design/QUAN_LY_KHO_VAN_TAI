import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { ScopeFilters, useOpScope } from '../../components/ScopeFilter';
import { Modal, noSel } from '../../components/ui';
import Select from '../../components/Select';
import { usePref } from '../../lib/prefs';
import { addDays, nextAction, scopeMove, scopeRow, scopeTrip, usePendingData } from '../../lib/pending';
import { fmtDate } from '../../lib/utils';
import { fmtTime } from '../../lib/trips';
import { MovementDetail } from '../stock/Movements';
import { ActionBtn, StageBadge, TypeTag, kg, tan, tripText } from './bits';

// ============================================================================
// Bàn điều phối kho: màn hình mở đầu ngày cho thủ kho / điều phối / quản lý.
//  - Ô số liệu: phải xuất, hàng về, chờ giải chấp, trễ hạn, đã xong hôm nay (bấm → danh sách đã lọc)
//  - 2 luồng Xuất / Nhập: mỗi đơn là 1 thẻ đi qua các bước từ trái sang phải, nút trên thẻ làm bước tiếp theo
//  - Xe đang trong kho, việc cần xử lý ngay
// Mỗi người tự thiết lập bố cục: bật / tắt, sắp thứ tự khối, xếp 2 luồng cạnh nhau hay trên dưới, ẩn bước, số thẻ mỗi cột.
// ============================================================================

const PANELS = [['kpi', '📊 Ô số liệu'], ['out', '📤 Luồng xuất hàng'], ['in', '📥 Luồng nhập hàng'], ['trucks', '🚚 Xe đang trong kho'], ['alerts', '⚠ Cần xử lý ngay']];
const OUT_COLS = [
  { key: 'make', label: '1. Chờ lập phiếu', stages: ['make', 'goods'] },
  { key: 'release', label: '2. Chờ giải chấp', stages: ['release'] },
  { key: 'truck', label: '3. Có xe · đang xuất', stages: ['truck'] },
  { key: 'done', label: '4. Đã xuất hôm nay', done: true },
];
const IN_COLS = [
  { key: 'make', label: '1. Sắp về · chưa lập phiếu', stages: ['make', 'eta'] },
  { key: 'transit', label: '2. STO đang đi đường', stages: ['transit'] },
  { key: 'truck', label: '3. Xe đến · đang nhập', stages: ['truck', 'pending'] },
  { key: 'done', label: '4. Đã nhập hôm nay', done: true },
];
const clock = (iso) => (iso ? fmtTime(iso).split(' ').pop() : '');
const DEFAULT = { order: PANELS.map((p) => p[0]), hidden: [], lanes: 'side', perStage: 6, hideCols: [], horizon: 2, compact: false };
const ACTIVE_STAGES = ['release', 'truck', 'pending', 'transit'];
// STO kho đi chưa xuất: đã nằm ở luồng xuất, không lặp lại ở luồng nhập trên bảng (vẫn có trong Đơn chờ nhập)

export default function Board() {
  const { hasRole, isAdmin } = useApp();
  const navigate = useNavigate();
  const data = usePendingData();
  const scope = useOpScope();
  const today = data.today;
  const [cfgRaw, setCfgRaw] = usePref('dp:board', DEFAULT);
  const cfg = { ...DEFAULT, ...cfgRaw, order: [...(cfgRaw?.order || []), ...DEFAULT.order].filter((k, i, a) => a.indexOf(k) === i && PANELS.some((p) => p[0] === k)) };
  const setCfg = (p) => setCfgRaw({ ...cfg, ...p });
  const [edit, setEdit] = useState(false);
  const [openMove, setOpenMove] = useState(null);
  const until = addDays(today, Number(cfg.horizon) || 0);

  const out = useMemo(() => data.out.filter(scopeRow(scope)), [data.out, scope]);
  const inb = useMemo(() => data.inb.filter(scopeRow(scope)), [data.inb, scope]);
  const trips = useMemo(() => data.trips.filter(scopeTrip(scope)), [data.trips, scope]);
  const moves = useMemo(() => data.todayMoves.filter(scopeMove(scope)), [data.todayMoves, scope]);
  // Trên bảng: việc đang làm luôn hiện; việc chờ lập phiếu chỉ hiện trong khoảng ngày đang xem (gồm quá hạn)
  const onBoard = (r) => ACTIVE_STAGES.includes(r.stage) || (r.due && r.due <= until) || (!r.due && r.stage === 'make');
  const sortCards = (a, b) => (b.late - a.late) || String(a.due || '9').localeCompare(String(b.due || '9')) || a.id.localeCompare(b.id);

  const sum = (rs) => rs.reduce((a, r) => a + r.left, 0);
  const outToday = out.filter((r) => r.due && r.due <= today);
  const inToday = inb.filter((r) => r.due && r.due <= today);
  const rel = out.filter((r) => r.stage === 'release');
  const lateOut = out.filter((r) => r.late && ['make', 'goods'].includes(r.stage));
  const lateIn = inb.filter((r) => r.late && r.stage === 'make');
  const movesOut = moves.filter((m) => m.type === 'out');
  const movesIn = moves.filter((m) => m.type === 'in');
  const mkg = (ms) => ms.reduce((a, m) => a + (m.lines || []).reduce((b, l) => b + Math.abs(Number(l.kg) || 0), 0), 0);
  const liveTrips = trips.filter((t) => t.status !== 'planned');

  const kpis = [
    { tone: 'blue', label: 'Phải xuất đến hôm nay', v: `${outToday.length} đơn`, s: `${tan(sum(outToday))} tấn · ${liveTrips.filter((t) => t.purpose !== 'import').length} xe lấy hàng trong kho`, to: '/dieu-phoi/cho-xuat' },
    { tone: 'teal', label: 'Hàng về đến hôm nay', v: `${inToday.length} đơn`, s: `${tan(sum(inToday))} tấn · ${liveTrips.filter((t) => t.purpose === 'import').length} xe giao hàng trong kho`, to: '/dieu-phoi/cho-nhap' },
    { tone: 'amber', label: 'Chờ giải chấp', v: `${rel.length} đơn`, s: `${tan(rel.reduce((a, r) => a + r.inSlip, 0))} tấn trong phiếu`, to: '/dieu-phoi/cho-xuat?buoc=release' },
    { tone: 'red', label: 'Trễ hạn', v: lateOut.length + lateIn.length, s: `${lateOut.length} giao trễ · ${lateIn.length} hàng về trễ`, to: lateOut.length || !lateIn.length ? '/dieu-phoi/cho-xuat?buoc=late' : '/dieu-phoi/cho-nhap?buoc=late' },
    { tone: 'green', label: 'Đã xong hôm nay', v: `${moves.length} phiếu`, s: `xuất ${tan(mkg(movesOut))} tấn · nhập ${tan(mkg(movesIn))} tấn`, to: '/kho/phieu' },
  ];

  const alerts = [
    ...lateOut.slice(0, 5).map((r) => ({ tone: 'red', ico: '⏰', text: <><b>{r.id}</b> trễ ngày giao {fmtDate(r.due)}, chưa lập phiếu xuất</>, sub: `${r.party} · ${kg(r.left)} kg`, a: nextAction(r, { hasRole, isAdmin }) })),
    ...lateIn.slice(0, 5).map((r) => ({ tone: 'red', ico: r.type === 'PO' ? '🚢' : '🕓', text: <><b>{r.id}</b> quá ngày về {fmtDate(r.due)}</>, sub: `${r.party} · ${kg(r.left)} kg`, a: { to: `/dieu-phoi/cho-nhap?q=${r.id}`, label: 'Xem' } })),
    ...(rel.length ? [{ tone: 'amber', ico: '🔒', text: <><b>{rel.length} đơn</b> có phiếu xuất chờ giải chấp</>, sub: rel.map((r) => r.id).slice(0, 6).join(', '), a: hasRole('ke_toan', 'thu_kho') ? { to: '/kho/giai-chap', label: 'Đề nghị giải chấp' } : null }] : []),
    ...movesOut.filter((m) => !m.plate && !m.driverName && !m.carrierName && !m.carrier).slice(0, 4).map((m) => ({ tone: 'amber', ico: '🚚', text: <>Phiếu <b>{m.id}</b> đã xuất nhưng chưa ghi số xe</>, sub: `${m.orderId || ''} · ${m.partyName || ''}`, a: { to: `/kho/phieu/${m.id}/in`, label: 'Xem phiếu' } })),
    ...trips.filter((t) => t.status === 'waiting_gate').slice(0, 4).map((t) => ({ tone: 'blue', ico: '🚪', text: <>Xe <b>{t.plate}</b> chờ vào cửa từ {clock(t.gateConfirmTime || t.arrivalTime)}</>, sub: `${t.warehouse} · ${t.purpose === 'import' ? 'giao hàng' : 'lấy hàng'}`, a: hasRole('thu_kho') ? { to: '/xe/thu-kho', label: 'Chỉ định cửa' } : null })),
  ];

  const lane = (kind) => {
    const isOut = kind === 'out';
    const rows = (isOut ? out : inb).filter(onBoard);
    const colsDef = (isOut ? OUT_COLS : IN_COLS).filter((c) => !cfg.hideCols.includes(`${kind}:${c.key}`));
    const done = isOut ? movesOut : movesIn;
    const listTo = isOut ? '/dieu-phoi/cho-xuat' : '/dieu-phoi/cho-nhap';
    return (
      <div className="dp-lane" key={kind}>
        <div className="dp-lane-h">
          <h3>{isOut ? '📤 Xuất hàng (SO, STO)' : '📥 Nhập hàng (PO, STO, SO trả hàng)'}</h3>
          <span className={'badge ' + (isOut ? 'blue' : 'green')}>{rows.length} đơn · {tan(sum(rows))} tấn</span>
          <Link className="btn sm ghost" style={{ marginLeft: 'auto' }} to={listTo}>Xem dạng danh sách →</Link>
        </div>
        <div className="dp-stages" style={{ gridTemplateColumns: `repeat(${colsDef.length || 1}, minmax(0, 1fr))` }}>
          {colsDef.map((c) => {
            if (c.done) {
              return (
                <div className="dp-stage" key={c.key}>
                  <div className="dp-stage-h">{c.label}<span className="n">{done.length}</span></div>
                  {done.slice(0, cfg.perStage).map((m) => (
                    <div key={m.id} className="dp-card" role="button" tabIndex={0} onClick={noSel(() => setOpenMove(m))}>
                      <div className="top"><TypeTag type={m.orderType || String(m.orderId || '').replace(/\d+$/, '')} /><span className="mono">{m.id}</span><span className="tm">{clock(m.createdAt || m.postedAt)}</span></div>
                      <div className="p">{m.partyName || m.orderId}</div>
                      <div className="m"><b>{kg(mkg([m]))} kg</b>{m.plate ? <span className="plate">{m.plate}</span> : null}<span className="small">{m.warehouse}</span></div>
                    </div>
                  ))}
                  {done.length > cfg.perStage && <Link className="dp-more" to="/kho/phieu">+ {done.length - cfg.perStage} phiếu khác</Link>}
                  {!done.length && <div className="dp-none">Chưa có</div>}
                </div>
              );
            }
            const cs = rows.filter((r) => c.stages.includes(r.stage)).sort(sortCards);
            return (
              <div className="dp-stage" key={c.key}>
                <div className="dp-stage-h">{c.label}<span className="n">{cs.length}</span><span className="kg">{tan(sum(cs))} t</span></div>
                {cs.slice(0, cfg.perStage).map((r) => <Card key={r.key} r={r} today={today} a={nextAction(r, { hasRole, isAdmin })} onOpen={() => navigate(`${listTo}?q=${r.id}`)} />)}
                {cs.length > cfg.perStage && <Link className="dp-more" to={`${listTo}?buoc=${c.stages[0]}`}>+ {cs.length - cfg.perStage} đơn khác</Link>}
                {!cs.length && <div className="dp-none">Không có</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const panel = (k) => {
    if (k === 'kpi') return (
      <div className="dp-kpis" key="kpi">
        {kpis.map((x) => (
          <button type="button" key={x.label} className={`dp-kpi k-${x.tone}`} onClick={() => navigate(x.to)}>
            <span className="l">{x.label}</span><span className="v">{x.v}</span><span className="s">{x.s}</span>
          </button>
        ))}
      </div>
    );
    if (k === 'trucks') return (
      <div className="dp-panel" key="trucks">
        <h3>🚚 Xe đang trong kho <span className="badge">{liveTrips.length}</span>{hasRole('thu_kho') && <Link className="btn sm ghost" style={{ float: 'right' }} to="/xe/thu-kho">Thủ kho điều phối →</Link>}</h3>
        {!liveTrips.length ? <div className="dp-none">Không có xe nào đang trong kho.</div> : (
          <div className="table-wrap dp-table"><table>
            <thead><tr><th>Số xe</th><th>Việc</th><th>Kho</th><th>Bước</th><th>Đến lúc</th><th>Đơn</th><th>Vận tải / tài xế</th></tr></thead>
            <tbody>
              {liveTrips.sort((a, b) => String(a.arrivalTime || '').localeCompare(String(b.arrivalTime || ''))).map((t) => (
                <tr key={t.id}>
                  <td><span className="plate">{t.plate}</span></td>
                  <td><span className={'badge ' + (t.purpose === 'import' ? 'green' : 'blue')}>{t.purpose === 'import' ? 'Giao hàng (nhập)' : 'Lấy hàng (xuất)'}</span></td>
                  <td>{t.warehouse}</td>
                  <td className="nowrap"><b>{tripText(t)}</b></td>
                  <td className="nowrap">{clock(t.arrivalTime)}</td>
                  <td className="mono small">{(t.orderIds || []).join(', ')}</td>
                  <td className="small">{[t.carrierName || t.carrier, t.driverName, t.driverPhone].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    );
    if (k === 'alerts') return (
      <div className="dp-panel" key="alerts">
        <h3>⚠ Cần xử lý ngay <span className={'badge ' + (alerts.length ? 'red' : 'green')}>{alerts.length}</span></h3>
        {!alerts.length && <div className="dp-none">Không có việc bất thường. 👍</div>}
        {alerts.map((x, i) => (
          <div className="dp-exc" key={i}>
            <span className={`dp-ic badge ${x.tone}`}>{x.ico}</span>
            <div><div>{x.text}</div>{x.sub && <div className="small">{x.sub}</div>}</div>
            <span style={{ marginLeft: 'auto' }}>{x.a && <ActionBtn a={{ ...x.a, primary: false }} />}</span>
          </div>
        ))}
      </div>
    );
    return null;
  };

  // Xếp các khối theo thứ tự người dùng chọn; 2 luồng liền nhau thì đặt cạnh nhau (nếu chọn "cạnh nhau"),
  // Xe trong kho + Cần xử lý liền nhau cũng đặt cạnh nhau
  const shownPanels = cfg.order.filter((k) => !cfg.hidden.includes(k));
  const blocks = [];
  for (let i = 0; i < shownPanels.length; i++) {
    const k = shownPanels[i], nx = shownPanels[i + 1];
    const pairLane = ['out', 'in'].includes(k) && ['out', 'in'].includes(nx) && cfg.lanes === 'side';
    const pairInfo = ['trucks', 'alerts'].includes(k) && ['trucks', 'alerts'].includes(nx);
    if (pairLane || pairInfo) {
      blocks.push(<div key={k + nx} className={pairLane ? 'dp-lanes' : 'dp-side-panels'}>{[k, nx].map((x) => (['out', 'in'].includes(x) ? lane(x) : panel(x)))}</div>);
      i++;
    } else blocks.push(['out', 'in'].includes(k) ? <div key={k} className="dp-lanes one">{lane(k)}</div> : panel(k));
  }

  return (
    <div className={'dp' + (cfg.compact ? ' dp-compact' : '')}>
      <div className="page-head">
        <div>
          <h1>🧭 Bàn điều phối kho</h1>
          <div className="small">{fmtDate(today)} · cập nhật trực tiếp · thẻ việc chờ lập phiếu: đến {fmtDate(until)}</div>
        </div>
        <div className="filters" style={{ margin: 0 }}>
          <ScopeFilters scope={scope} noLoc />
          <Select value={String(cfg.horizon)} onChange={(e) => setCfg({ horizon: Number(e.target.value) })} title="Thẻ chờ lập phiếu hiện đến ngày">
            {[[0, 'Hôm nay'], [1, 'Hôm nay + 1 ngày'], [2, 'Hôm nay + 2 ngày'], [7, '7 ngày tới'], [30, '30 ngày tới']].map(([v, l]) => <option key={v} value={String(v)}>{l}</option>)}
          </Select>
          <button type="button" className="btn" onClick={() => setEdit(true)}>⚙ Tùy chỉnh bố cục</button>
        </div>
      </div>
      {blocks}
      {openMove && <MovementDetail m={openMove} onClose={() => setOpenMove(null)} />}
      {edit && <LayoutEditor cfg={cfg} setCfg={setCfg} reset={() => setCfgRaw(DEFAULT)} onClose={() => setEdit(false)} />}
    </div>
  );
}

function Card({ r, today, a, onOpen }) {
  const warn = !r.late && (r.stage === 'goods' || (r.stage === 'truck' && !r.plate));
  return (
    <div className={'dp-card' + (r.late ? ' late' : warn ? ' warn' : '')} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="top">
        <TypeTag type={r.type} /><span className="mono">{r.id}</span>
        <span className="tm">{r.late ? <span className="badge red">trễ {Math.round((new Date(today) - new Date(r.due)) / 86400000)} ngày</span> : r.due === today ? 'hôm nay' : r.due ? fmtDate(r.due).slice(0, 5) : ''}</span>
      </div>
      <div className="p" title={r.party}>{r.party}{r.ships.length ? ` · ${r.ships.join(', ')}` : ''}</div>
      <div className="m">
        <span className="mono">{r.items[0]}{r.items.length > 1 ? ` +${r.items.length - 1}` : ''}</span><b>{kg(r.left)} kg</b><span className="small">{r.wh}</span>
      </div>
      {(['goods', 'release', 'truck', 'pending', 'transit', 'notShipped'].includes(r.stage) || r.plate) && <div className="m"><StageBadge r={r} /></div>}
      {a && <div className="go" onClick={(e) => e.stopPropagation()}><ActionBtn a={a} /></div>}
    </div>
  );
}

function LayoutEditor({ cfg, setCfg, reset, onClose }) {
  const move = (k, d) => {
    const o = [...cfg.order]; const i = o.indexOf(k); const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]]; setCfg({ order: o });
  };
  const tog = (key, k) => setCfg({ [key]: cfg[key].includes(k) ? cfg[key].filter((x) => x !== k) : [...cfg[key], k] });
  return (
    <Modal title="⚙ Tùy chỉnh bố cục Bàn điều phối (riêng tài khoản của bạn)" onClose={onClose}>
      <div className="dp-layout-form">
        <div className="dp-h5">Các khối và thứ tự (▲▼ để đổi chỗ)</div>
        {cfg.order.map((k, i) => (
          <div className="dp-layout-row" key={k}>
            <label><input type="checkbox" checked={!cfg.hidden.includes(k)} onChange={() => tog('hidden', k)} /> {PANELS.find((p) => p[0] === k)?.[1]}</label>
            <span className="col-steps"><button type="button" disabled={!i} onClick={() => move(k, -1)}>▲</button><button type="button" disabled={i === cfg.order.length - 1} onClick={() => move(k, 1)}>▼</button></span>
          </div>
        ))}
        <label>Hai luồng xuất / nhập <Select value={cfg.lanes} onChange={(e) => setCfg({ lanes: e.target.value })}><option value="side">Cạnh nhau (màn hình rộng)</option><option value="stack">Trên dưới (mỗi luồng 1 hàng ngang)</option></Select></label>
        <label>Số thẻ mỗi cột <Select value={String(cfg.perStage)} onChange={(e) => setCfg({ perStage: Number(e.target.value) })}>{[3, 4, 6, 8, 12, 20, 50].map((v) => <option key={v} value={String(v)}>{v}</option>)}</Select></label>
        <label><input type="checkbox" checked={cfg.compact} onChange={(e) => setCfg({ compact: e.target.checked })} /> Thẻ gọn</label>
        <div className="dp-h5">Cột bước hiện trên bảng</div>
        <div className="dp-layout-cols">
          {[['out', OUT_COLS, '📤 Xuất'], ['in', IN_COLS, '📥 Nhập']].map(([kind, cs, t]) => (
            <div key={kind}><b>{t}</b>{cs.map((c) => <label key={c.key}><input type="checkbox" checked={!cfg.hideCols.includes(`${kind}:${c.key}`)} onChange={() => tog('hideCols', `${kind}:${c.key}`)} /> {c.label}</label>)}</div>
          ))}
        </div>
        <div className="actions" style={{ marginTop: 10 }}>
          <button type="button" className="btn" onClick={reset}>↺ Về mặc định</button>
          <button type="button" className="btn primary" onClick={onClose}>Xong</button>
        </div>
      </div>
    </Modal>
  );
}
