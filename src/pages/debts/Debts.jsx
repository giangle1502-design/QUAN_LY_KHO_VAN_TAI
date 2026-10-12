import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { collection, deleteDoc, doc, onSnapshot } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useCompanies, useOrders } from '../../lib/hooks';
import { leftKg } from '../../lib/orders';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, norm, today } from '../../lib/utils';
import {
  compareRows, custKey, detectCompany, forgetRows, loadRows, parseAging, saveSnapshot, snapId, snapsAt, userForGroup, worstBucket,
} from '../../lib/debts';
import { ReportTable } from '../reports/Reports';
import { Empty, ErrorBox, Modal } from '../../components/ui';

// ============================================================================
// Theo dõi công nợ phải thu: kế toán nhập file tuổi nợ MISA đầu / cuối ngày,
// app tổng hợp theo công ty – nhóm KH (sale) – khách hàng và so sánh giữa các ngày.
// ============================================================================

const TABS = [['tong-hop', '📋 Tổng hợp'], ['so-sanh', '⚖️ So sánh'], ['xu-huong', '📈 Xu hướng'], ['lich-su', '🗂️ Các lần nhập']];
const n = (v) => Number(v) || 0;
const m = (v) => fmtNum(Math.round(n(v)));
const short = (v) => (Math.abs(v) >= 1e9 ? fmtNum(v / 1e9, 2) + ' tỷ' : Math.abs(v) >= 1e6 ? fmtNum(v / 1e6, 1) + ' tr' : fmtNum(v));
const pct = (a, b) => (b ? fmtNum((a / b) * 100, 1) + '%' : '-');
const CO_KEY = 'debt-company';
const daysBefore = (ymd, d) => { const t = new Date(ymd + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };
const tsText = (v) => { const d = v?.toDate ? v.toDate() : v ? new Date(v) : null; return d && !isNaN(d) ? d.toLocaleString('vi-VN') : ''; };

function Delta({ v, good = 'down' }) {
  if (!Math.round(v)) return <span className="small">–</span>;
  const up = v > 0;
  const bad = good === 'down' ? up : !up;
  return <span style={{ color: bad ? 'var(--red)' : 'var(--green)', fontWeight: 600, whiteSpace: 'nowrap' }}>{up ? '▲ +' : '▼ −'}{m(Math.abs(v))}</span>;
}
function Stat({ label, value, sub, tone }) {
  return <div className={'stat' + (tone ? ' ' + tone : '')}><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub && <div className="stat-sub">{sub}</div>}</div>;
}

// Bản chụp (số tổng) của mọi công ty, realtime
function useSnapshots() {
  const [s, setS] = useState({ rows: [], loading: true, error: '' });
  useEffect(() => onSnapshot(collection(db, 'debtSnapshots'),
    (q) => setS({ rows: q.docs.map((d) => ({ ...d.data(), id: d.id })), loading: false, error: '' }),
    (e) => setS({ rows: [], loading: false, error: e.message })), []);
  return s;
}

// Chi tiết khách hàng của các bản chụp → mảng dòng có company + k (khóa so khớp)
function useRows(list) {
  const key = list.map((s) => s.id + '@' + tsText(s.importedAt)).join(',');
  const [st, setSt] = useState({ key: '', rows: [], error: '' });
  useEffect(() => {
    if (!list.length) { setSt({ key, rows: [], error: '' }); return undefined; }
    let live = true;
    Promise.all(list.map((s) => loadRows(s.id).then((rows) => rows.map((r) => ({ ...r, company: s.company, k: custKey(s.company, r) })))))
      .then((all) => live && setSt({ key, rows: all.flat(), error: '' }))
      .catch((e) => live && setSt({ key, rows: [], error: e.message }));
    return () => { live = false; };
  }, [key]);
  return { rows: st.key === key ? st.rows : [], loading: st.key !== key, error: st.error };
}

export default function Debts() {
  const { hasRole, isSuper } = useApp();
  const canImport = hasRole('ke_toan');
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'tong-hop';
  const { rows: snaps, loading, error } = useSnapshots();
  const companies = useCompanies();
  const users = useCollection('users').rows;
  const [co, setCoState] = useState(() => { try { return localStorage.getItem(CO_KEY) || ''; } catch { return ''; } });
  const setCo = (v) => { setCoState(v); try { localStorage.setItem(CO_KEY, v); } catch { /* bỏ qua */ } };
  const [importing, setImporting] = useState(false);

  const snapCos = useMemo(() => [...new Set(snaps.map((s) => s.company))].sort(), [snaps]);
  const cos = co && snapCos.includes(co) ? [co] : snapCos;
  const mine = useMemo(() => snaps.filter((s) => cos.includes(s.company)), [snaps, cos.join(',')]);
  const dates = useMemo(() => [...new Set(mine.map((s) => s.asOf))].sort().reverse(), [mine]);
  const coName = (c) => companies.find((x) => x.code === c)?.name || c;
  const groupLabel = (code, name) => {
    const u = userForGroup(users, code, name);
    return u ? (u.name || u._id) : code ? `${name || code}` : 'Không có nhóm';
  };
  const ctx = { snaps: mine, cos, dates, users, groupLabel, coName, multi: cos.length > 1 };

  return (
    <div>
      <div className="page-head">
        <h1>💳 Theo dõi công nợ</h1>
        <div className="actions">
          <div className="seg">
            {TABS.map(([k, l]) => <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}
          </div>
          {canImport && <button className="btn primary" onClick={() => setImporting(true)}>⬆ Nhập tuổi nợ MISA</button>}
        </div>
      </div>
      <div className="presets" style={{ marginBottom: 10 }}>
        <button className={'chip' + (!co || !snapCos.includes(co) ? ' on' : '')} onClick={() => setCo('')}>∑ Tất cả công ty</button>
        {snapCos.map((c) => <button key={c} className={'chip' + (co === c ? ' on' : '')} onClick={() => setCo(c)}>🏢 {c}{coName(c) !== c ? ' – ' + coName(c) : ''}</button>)}
      </div>
      <ErrorBox error={error} />
      {loading ? <Empty text="Đang tải…" /> : !snaps.length ? (
        <Empty text={canImport ? 'Chưa có số liệu công nợ. Bấm "⬆ Nhập tuổi nợ MISA" để tải file báo cáo tuổi nợ đầu tiên.' : 'Chưa có số liệu công nợ — kế toán chưa nhập file tuổi nợ MISA.'} />
      ) : tab === 'so-sanh' ? <Compare {...ctx} />
        : tab === 'xu-huong' ? <Trend {...ctx} />
          : tab === 'lich-su' ? <History {...ctx} isSuper={isSuper} />
            : <Summary {...ctx} />}
      {importing && <ImportAging snaps={snaps} companies={companies} users={users} onClose={() => setImporting(false)} onDone={(c) => { setCo(c); setParams({ tab: 'tong-hop' }); }} />}
    </div>
  );
}

function DateSelect({ dates, value, onChange, label }) {
  return (
    <label className="nowrap">{label}{' '}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {dates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
      </select>
    </label>
  );
}

// Thanh tỷ trọng: trong hạn + từng khoảng quá hạn
const BUCKET_COLORS = ['#ffd54f', '#ffb74d', '#ff8a65', '#e57373', '#d32f2f', '#b71c1c', '#7f0000'];
function AgingBar({ notDue, aging, buckets, total }) {
  if (!total) return null;
  const parts = [['Trong hạn', notDue, '#81c784'], ...buckets.map((b, i) => ['QH ' + b, aging[i] || 0, BUCKET_COLORS[Math.min(i + Math.max(0, 5 - buckets.length), BUCKET_COLORS.length - 1)]])].filter((p) => p[1] > 0);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', height: 22, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)' }}>
        {parts.map(([l, v, c]) => <div key={l} title={`${l}: ${m(v)} đ (${pct(v, total)})`} style={{ width: (v / total) * 100 + '%', background: c }} />)}
      </div>
      <div className="small" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
        {parts.map(([l, v, c]) => <span key={l}><span style={{ display: 'inline-block', width: 10, height: 10, background: c, borderRadius: 2, marginRight: 4 }} />{l}: <b>{short(v)}</b> ({pct(v, total)})</span>)}
      </div>
    </div>
  );
}

// Khóa đơn bán đang mở theo khách hàng (mã hoặc tên) để biết khách nợ có đang chờ giao hàng
function useOpenSO() {
  const { rows } = useOrders('SO', true);
  return useMemo(() => {
    const map = new Map();
    const add = (k, o, kg) => { if (!map.has(k)) map.set(k, { kg: 0, ids: new Set() }); const x = map.get(k); x.kg += kg; x.ids.add(o.id); };
    rows.forEach((o) => {
      const kg = (o.lines || []).reduce((s, l) => s + leftKg(l), 0);
      if (kg <= 0) return;
      if (o.partyCode) add(custKey(o.company || '', { code: o.partyCode }), o, kg);
      if (o.partyName) add(custKey(o.company || '', { name: o.partyName }), o, kg);
    });
    return (r) => map.get(custKey(r.company, { code: r.code })) || map.get(custKey(r.company, { name: r.name })) || null;
  }, [rows]);
}

// ================= Tổng hợp tại 1 ngày =================
function Summary({ snaps, cos, dates, groupLabel, coName, multi }) {
  const [date, setDate] = useState('');
  const d = dates.includes(date) ? date : dates[0];
  const prevDate = dates.find((x) => x < d) || '';
  const cur = useMemo(() => snapsAt(snaps, cos, d), [snaps, cos.join(','), d]);
  const prev = useMemo(() => (prevDate ? snapsAt(snaps, cos, prevDate) : []), [snaps, cos.join(','), prevDate]);
  const C = useRows(cur);
  const P = useRows(prev);
  const openSO = useOpenSO();
  const [search, setSearch] = useState('');
  const [only, setOnly] = useState('');
  const [grp, setGrp] = useState(null);
  const buckets = cur.reduce((b, s) => ((s.buckets || []).length > b.length ? s.buckets : b), []);
  const last = buckets.length - 1;

  // Chỉ so với ngày trước cho công ty có số liệu ở ngày đó (công ty mới nhập lần đầu không tính là nợ tăng)
  const prevCos = prev.map((x) => x.company);
  const cmpList = useMemo(() => compareRows(P.rows, C.rows.filter((r) => prevCos.includes(r.company))), [P.rows, C.rows, prevCos.join(',')]);
  const cmp = useMemo(() => new Map(cmpList.map((x) => [x.k, x])), [cmpList]);
  const gone = cmpList.filter((x) => x.kind === 'gone');
  const all = useMemo(() => C.rows.map((r) => {
    const so = openSO(r);
    return { ...r, _k: r.k, aging: buckets.map((_, i) => n(r.aging?.[i])), delta: prevDate ? cmp.get(r.k)?.delta || 0 : 0, isNew: prevDate && cmp.get(r.k)?.kind === 'new',
      soKg: so?.kg || 0, soCount: so?.ids.size || 0, sale: groupLabel(r.group, r.groupName) };
  }), [C.rows, cmp, openSO, buckets.length, prevDate]);
  const tot = (list) => list.reduce((t, r) => ({
    amount: t.amount + n(r.amount), notDue: t.notDue + n(r.notDue), overdue: t.overdue + n(r.overdue), count: t.count + 1,
    overCount: t.overCount + (n(r.overdue) > 0 ? 1 : 0), aging: t.aging.map((v, i) => v + n(r.aging?.[i])),
  }), { amount: 0, notDue: 0, overdue: 0, count: 0, overCount: 0, aging: buckets.map(() => 0) });
  const T = tot(all);
  const prevTotal = prev.reduce((s, x) => s + n(x.amount), 0) + cur.filter((x) => !prevCos.includes(x.company)).reduce((s, x) => s + n(x.amount), 0);
  const prevOver = prev.reduce((s, x) => s + n(x.overdue), 0) + cur.filter((x) => !prevCos.includes(x.company)).reduce((s, x) => s + n(x.overdue), 0);

  const groups = useMemo(() => {
    const g = new Map();
    all.forEach((r) => {
      const k = r.sale;
      if (!g.has(k)) g.set(k, { _k: k, sale: k, codes: new Set(), list: [] });
      g.get(k).list.push(r); if (r.group) g.get(k).codes.add(r.group);
    });
    return [...g.values()].map((x) => {
      const t = tot(x.list);
      const goneDelta = gone.filter((r) => groupLabel(r.group, r.groupName) === x.sale).reduce((s, r) => s + r.delta, 0);
      return { ...x, ...t, group: [...x.codes].join(', '), delta: x.list.reduce((s, r) => s + r.delta, 0) + goneDelta, overPct: t.amount ? t.overdue / t.amount : 0,
        ...Object.fromEntries(buckets.map((_, i) => ['b' + i, t.aging[i]])) };
    }).sort((a, b) => b.overdue - a.overdue || b.amount - a.amount);
  }, [all, gone]);

  const s = norm(search);
  const list = all.filter((r) => (!grp || r.sale === grp)
    && (!s || norm(r.name).includes(s) || norm(r.code).includes(s) || norm(r.sale).includes(s))
    && (only !== 'over' || n(r.overdue) > 0) && (only !== 'last' || n(r.aging[last]) > 0) && (only !== 'so' || r.soKg > 0)
    && (only !== 'risk' || (n(r.overdue) > 0 && r.soKg > 0)) && (only !== 'new' || r.isNew))
    .map((r) => ({ ...r, ...Object.fromEntries(buckets.map((_, i) => ['b' + i, r.aging[i]])) }))
    .sort((a, b) => n(b.overdue) - n(a.overdue) || n(b.amount) - n(a.amount));

  const bucketCols = buckets.map((b, i) => ({ key: 'b' + i, label: 'QH ' + b, num: true, sum: true,
    style: (r) => (i === last && r['b' + i] > 0 ? { color: 'var(--red)', fontWeight: 700 } : undefined), render: (r) => (r['b' + i] ? m(r['b' + i]) : '-') }));
  const gCols = [
    { key: 'sale', label: 'Nhóm KH / Sale', render: (r) => <a href="#" onClick={(e) => { e.preventDefault(); setGrp(grp === r.sale ? null : r.sale); }}><b>{r.sale}</b></a> },
    { key: 'group', label: 'Mã nhóm (MISA)' },
    { key: 'count', label: 'Số KH', num: true, sum: true },
    { key: 'amount', label: 'Tổng nợ', num: true, sum: true },
    ...(prevDate ? [{ key: 'delta', label: 'Tăng/giảm', num: true, sum: true, render: (r) => <Delta v={r.delta} /> }] : []),
    { key: 'notDue', label: 'Trong hạn', num: true, sum: true },
    ...bucketCols,
    { key: 'overdue', label: 'Tổng quá hạn', num: true, sum: true, render: (r) => (r.overdue > 0 ? <span className="badge red">{m(r.overdue)}</span> : '-') },
    { key: 'overPct', label: '% quá hạn', num: true, render: (r) => pct(r.overdue, r.amount) },
  ];
  const cCols = [
    ...(multi ? [{ key: 'company', label: 'Cty', render: (r) => <span className="badge blue">{r.company}</span> }] : []),
    { key: 'code', label: 'Mã KH', nowrap: true },
    { key: 'name', label: 'Khách hàng', render: (r) => <><b>{r.name}</b>{r.isNew && <span className="badge green" style={{ marginLeft: 4 }}>mới</span>}{r.address && <div className="small">{r.address}</div>}</> },
    { key: 'sale', label: 'Nhóm / Sale' },
    { key: 'amount', label: 'Tổng nợ', num: true, sum: true },
    ...(prevDate ? [{ key: 'delta', label: 'Tăng/giảm', num: true, sum: true, render: (r) => <Delta v={r.delta} /> }] : []),
    { key: 'notDue', label: 'Trong hạn', num: true, sum: true, render: (r) => (r.notDue ? m(r.notDue) : '-') },
    ...bucketCols,
    { key: 'overdue', label: 'Tổng quá hạn', num: true, sum: true, render: (r) => (r.overdue > 0 ? <span className="badge red">{m(r.overdue)}</span> : '-') },
    { key: 'soKg', label: 'SO chưa giao (kg)', num: true, sum: true, render: (r) => (r.soKg ? <span title={`${r.soCount} đơn đang mở`} style={r.overdue > 0 ? { color: 'var(--red)', fontWeight: 700 } : undefined}>{fmtNum(r.soKg)}</span> : '-') },
  ];
  const agingX = (r) => ({ 'Tổng nợ': Math.round(n(r.amount)), ...(prevDate ? { ['Tăng/giảm so với ' + fmtDate(prevDate)]: Math.round(r.delta) } : {}), 'Trong hạn': Math.round(n(r.notDue)),
    ...Object.fromEntries(buckets.map((b, i) => ['Quá hạn ' + b, Math.round(n(r.aging[i]))])), 'Tổng quá hạn': Math.round(n(r.overdue)) });
  const doExport = () => exportSheets(`CongNo_${cos.join('-')}_${d}`, {
    'Theo nhóm - sale': groups.map((g) => ({ 'Nhóm KH / Sale': g.sale, 'Mã nhóm': g.group, 'Số KH': g.count, ...agingX(g) })),
    'Theo khách hàng': list.map((r) => ({ 'Công ty': r.company, 'Mã KH': r.code, 'Khách hàng': r.name, 'Địa chỉ': r.address, 'Nhóm / Sale': r.sale, ...agingX(r), 'SO chưa giao (kg)': Math.round(r.soKg) })),
  });
  const risk = all.filter((r) => n(r.overdue) > 0 && r.soKg > 0);

  return (
    <>
      <div className="filters">
        <DateSelect label="Số liệu ngày" dates={dates} value={d} onChange={setDate} />
        <span className="small">
          {cur.map((x) => <span key={x.id} style={{ marginRight: 8 }}><b>{x.company}</b> đến {fmtDate(x.asOf)}{x.asOf !== d ? ' (bản gần nhất)' : ''}</span>)}
          {prevDate && <> · so với ngày {fmtDate(prevDate)}</>}
        </span>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={doExport} disabled={!all.length}>⬇ Excel</button>
      </div>
      <ErrorBox error={C.error || P.error} />
      <div className="stats">
        <Stat label={'Tổng phải thu' + (multi ? ` (${cos.join(' + ')})` : ' ' + coName(cos[0]))} value={short(T.amount) + ' đ'} tone="amber"
          sub={<>{T.count} khách hàng{prevDate && <> · <Delta v={T.amount - prevTotal} /></>}</>} />
        <Stat label="Trong hạn" value={short(T.notDue) + ' đ'} sub={pct(T.notDue, T.amount) + ' tổng nợ'} tone="green" />
        <Stat label="Quá hạn" value={short(T.overdue) + ' đ'} tone="red" sub={<>{T.overCount} KH · {pct(T.overdue, T.amount)}{prevDate && <> · <Delta v={T.overdue - prevOver} /></>}</>} />
        {last >= 0 && <Stat label={'Quá hạn ' + buckets[last]} value={short(T.aging[last]) + ' đ'} tone="red" sub={pct(T.aging[last], T.amount) + ' tổng nợ'} />}
        <Stat label="Khách quá hạn còn đơn chưa giao" value={risk.length} tone={risk.length ? 'red' : ''}
          sub={risk.length ? <a href="#" onClick={(e) => { e.preventDefault(); setOnly('risk'); }}>Xem danh sách ›</a> : 'Không có'} />
      </div>
      <AgingBar notDue={T.notDue} aging={T.aging} buckets={buckets} total={T.amount} />
      {C.loading ? <Empty text="Đang tải chi tiết…" /> : (
        <>
          <div className="section-title">Theo nhóm khách hàng / sale</div>
          <ReportTable cols={gCols} rows={groups} rowStyle={(r) => (grp === r.sale ? { background: 'var(--primary-soft)' } : undefined)} />
          <div className="section-title">
            Chi tiết theo khách hàng{grp && <> – {grp} · <a href="#" className="small" onClick={(e) => { e.preventDefault(); setGrp(null); }}>bỏ lọc nhóm</a></>}
          </div>
          <div className="filters">
            <input placeholder="Tìm khách hàng / mã KH / sale…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="presets">
              {[['', 'Tất cả'], ['over', 'Chỉ quá hạn'], ...(last >= 0 ? [['last', 'Quá hạn ' + buckets[last]]] : []), ['so', 'Có SO chưa giao'], ['risk', 'Quá hạn + còn SO'], ...(prevDate ? [['new', 'Khách mới phát sinh']] : [])].map(([k, l]) => (
                <button key={k} className={'chip' + (only === k ? ' on' : '')} onClick={() => setOnly(k)}>{l}</button>
              ))}
            </div>
            <span className="small">{list.length} khách hàng{gone.length > 0 && <> · {gone.length} khách đã hết nợ so với {fmtDate(prevDate)} ({m(-gone.reduce((s, r) => s + r.delta, 0))} đ) — xem tab So sánh</>}</span>
          </div>
          <ReportTable cols={cCols} rows={list} empty="Không có khách hàng nào." />
        </>
      )}
    </>
  );
}

// ================= So sánh 2 ngày =================
const KINDS = [['changed', 'Có thay đổi'], ['up', 'Nợ tăng'], ['down', 'Nợ giảm'], ['new', 'Khách mới'], ['gone', 'Hết nợ'], ['worse', 'Quá hạn xấu đi'], ['cleared', 'Hết quá hạn'], ['all', 'Tất cả']];
const KIND_LABEL = { new: ['Mới', 'green'], gone: ['Hết nợ', 'blue'], up: ['Tăng', 'red'], down: ['Giảm', 'green'], same: ['Không đổi', ''] };

function Compare({ snaps, cos, dates, groupLabel, coName, multi }) {
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const B = dates.includes(to) ? to : dates[0];
  const older = dates.filter((x) => x < B);
  const A = older.includes(from) ? from : older[0] || '';
  const pick = (days) => { const t = daysBefore(B, days); setFrom(older.find((x) => x <= t) || older[older.length - 1] || ''); };
  const monthStart = B ? B.slice(0, 8) + '01' : '';
  const sA = useMemo(() => (A ? snapsAt(snaps, cos, A) : []), [snaps, cos.join(','), A]);
  // Công ty chưa có số liệu ở ngày "Từ ngày" thì không đưa vào so sánh
  const sB = useMemo(() => snapsAt(snaps, sA.map((x) => x.company), B), [snaps, sA, B]);
  const skipped = cos.filter((c) => !sA.some((x) => x.company === c));
  const RA = useRows(sA);
  const RB = useRows(sB);
  const [kind, setKind] = useState('changed');
  const [search, setSearch] = useState('');
  const buckets = sB.reduce((b, s) => ((s.buckets || []).length > b.length ? s.buckets : b), []);

  const rows = useMemo(() => compareRows(RA.rows, RB.rows).map((r) => ({ ...r, _k: r.k, sale: groupLabel(r.group, r.groupName) })), [RA.rows, RB.rows]);
  const sum = (f, list = rows) => list.reduce((s, r) => s + f(r), 0);
  const K = {
    a: sum((r) => r.prevAmt), b: sum((r) => r.curAmt), up: sum((r) => r.up), down: sum((r) => r.down),
    oa: sum((r) => r.prevOver), ob: sum((r) => r.curOver),
    nNew: rows.filter((r) => r.kind === 'new').length, nGone: rows.filter((r) => r.kind === 'gone').length,
    nWorse: rows.filter((r) => r.worse).length, nCleared: rows.filter((r) => r.cleared).length,
  };
  const agingOf = (list) => buckets.map((_, i) => list.reduce((s, r) => s + n(r.aging?.[i]), 0));
  const bucketRows = useMemo(() => {
    const aA = agingOf(RA.rows); const aB = agingOf(RB.rows);
    const nd = (list) => list.reduce((s, r) => s + n(r.notDue), 0);
    return [['Trong hạn', nd(RA.rows), nd(RB.rows)], ...buckets.map((b, i) => ['Quá hạn ' + b, aA[i], aB[i]])]
      .map(([l, a, b]) => ({ _k: l, label: l, a, b, d: b - a, pa: K.a ? a / K.a : 0, pb: K.b ? b / K.b : 0 }));
  }, [RA.rows, RB.rows]);

  const groups = useMemo(() => {
    const g = new Map();
    rows.forEach((r) => {
      if (!g.has(r.sale)) g.set(r.sale, { _k: r.sale, sale: r.sale, prevAmt: 0, up: 0, down: 0, curAmt: 0, prevOver: 0, curOver: 0, cust: 0 });
      const x = g.get(r.sale);
      x.prevAmt += r.prevAmt; x.up += r.up; x.down += r.down; x.curAmt += r.curAmt; x.prevOver += r.prevOver; x.curOver += r.curOver; if (r.kind !== 'gone') x.cust += 1;
    });
    return [...g.values()].map((x) => ({ ...x, delta: x.curAmt - x.prevAmt, overDelta: x.curOver - x.prevOver })).sort((a, b) => b.curOver - a.curOver);
  }, [rows]);

  const s = norm(search);
  const list = rows.filter((r) => (kind === 'all' || (kind === 'changed' ? r.kind !== 'same' || r.overDelta !== 0 || r.curWorst !== r.prevWorst : kind === 'worse' ? r.worse : kind === 'cleared' ? r.cleared : r.kind === kind))
    && (!s || norm(r.name).includes(s) || norm(r.code).includes(s) || norm(r.sale).includes(s)))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || Math.abs(b.overDelta) - Math.abs(a.overDelta));

  if (dates.length < 2) return <Empty text="Cần ít nhất 2 ngày số liệu để so sánh. Mỗi lần kế toán nhập file tuổi nợ là 1 ngày số liệu." />;
  const bName = (i) => (i < 0 ? 'Trong hạn' : buckets[i] || '');
  const gCols = [
    { key: 'sale', label: 'Nhóm KH / Sale', render: (r) => <b>{r.sale}</b> },
    { key: 'cust', label: 'Số KH', num: true, sum: true },
    { key: 'prevAmt', label: 'Nợ ' + fmtDate(A), num: true, sum: true },
    { key: 'up', label: 'Nợ tăng', num: true, sum: true, render: (r) => (r.up ? m(r.up) : '-') },
    { key: 'down', label: 'Nợ giảm (đã thu)', num: true, sum: true, render: (r) => (r.down ? m(r.down) : '-') },
    { key: 'curAmt', label: 'Nợ ' + fmtDate(B), num: true, sum: true },
    { key: 'delta', label: 'Chênh lệch', num: true, sum: true, render: (r) => <Delta v={r.delta} /> },
    { key: 'prevOver', label: 'Quá hạn ' + fmtDate(A), num: true, sum: true },
    { key: 'curOver', label: 'Quá hạn ' + fmtDate(B), num: true, sum: true },
    { key: 'overDelta', label: 'Chênh lệch QH', num: true, sum: true, render: (r) => <Delta v={r.overDelta} /> },
  ];
  const cCols = [
    ...(multi ? [{ key: 'company', label: 'Cty', render: (r) => <span className="badge blue">{r.company}</span> }] : []),
    { key: 'code', label: 'Mã KH', nowrap: true },
    { key: 'name', label: 'Khách hàng', render: (r) => <b>{r.name}</b> },
    { key: 'sale', label: 'Nhóm / Sale' },
    { key: 'kind', label: 'Thay đổi', render: (r) => <>{KIND_LABEL[r.kind][0] && <span className={'badge ' + KIND_LABEL[r.kind][1]}>{KIND_LABEL[r.kind][0]}</span>}{r.worse && <span className="badge red" style={{ marginLeft: 4 }}>QH xấu đi</span>}{r.cleared && <span className="badge green" style={{ marginLeft: 4 }}>Hết QH</span>}</> },
    { key: 'prevAmt', label: 'Nợ ' + fmtDate(A), num: true, sum: true },
    { key: 'curAmt', label: 'Nợ ' + fmtDate(B), num: true, sum: true },
    { key: 'delta', label: 'Chênh lệch', num: true, sum: true, render: (r) => <Delta v={r.delta} /> },
    { key: 'prevOver', label: 'QH ' + fmtDate(A), num: true, sum: true },
    { key: 'curOver', label: 'QH ' + fmtDate(B), num: true, sum: true },
    { key: 'overDelta', label: 'Chênh lệch QH', num: true, sum: true, render: (r) => <Delta v={r.overDelta} /> },
    { key: 'curWorst', label: 'Tuổi nợ xấu nhất', render: (r) => (r.prevWorst === r.curWorst ? bName(r.curWorst) : <>{bName(r.prevWorst)} → <b style={{ color: r.curWorst > r.prevWorst ? 'var(--red)' : 'var(--green)' }}>{r.kind === 'gone' ? '–' : bName(r.curWorst)}</b></>) },
  ];
  const doExport = () => exportSheets(`SoSanhCongNo_${cos.join('-')}_${A}_${B}`, {
    'Tổng hợp': [
      { 'Chỉ tiêu': 'Tổng nợ', [fmtDate(A)]: Math.round(K.a), [fmtDate(B)]: Math.round(K.b), 'Chênh lệch': Math.round(K.b - K.a) },
      { 'Chỉ tiêu': 'Tổng quá hạn', [fmtDate(A)]: Math.round(K.oa), [fmtDate(B)]: Math.round(K.ob), 'Chênh lệch': Math.round(K.ob - K.oa) },
      ...bucketRows.map((r) => ({ 'Chỉ tiêu': r.label, [fmtDate(A)]: Math.round(r.a), [fmtDate(B)]: Math.round(r.b), 'Chênh lệch': Math.round(r.d) })),
      { 'Chỉ tiêu': 'Nợ tăng (phát sinh, ước tính)', 'Chênh lệch': Math.round(K.up) },
      { 'Chỉ tiêu': 'Nợ giảm (đã thu, ước tính)', 'Chênh lệch': Math.round(-K.down) },
    ],
    'Theo nhóm - sale': groups.map((g) => ({ 'Nhóm KH / Sale': g.sale, 'Số KH': g.cust, ['Nợ ' + fmtDate(A)]: Math.round(g.prevAmt), 'Nợ tăng': Math.round(g.up), 'Nợ giảm': Math.round(g.down), ['Nợ ' + fmtDate(B)]: Math.round(g.curAmt), 'Chênh lệch': Math.round(g.delta), ['QH ' + fmtDate(A)]: Math.round(g.prevOver), ['QH ' + fmtDate(B)]: Math.round(g.curOver) })),
    'Theo khách hàng': list.map((r) => ({ 'Công ty': r.company, 'Mã KH': r.code, 'Khách hàng': r.name, 'Nhóm / Sale': r.sale, 'Thay đổi': KIND_LABEL[r.kind][0] + (r.worse ? ', quá hạn xấu đi' : '') + (r.cleared ? ', hết quá hạn' : ''),
      ['Nợ ' + fmtDate(A)]: Math.round(r.prevAmt), ['Nợ ' + fmtDate(B)]: Math.round(r.curAmt), 'Chênh lệch': Math.round(r.delta), ['QH ' + fmtDate(A)]: Math.round(r.prevOver), ['QH ' + fmtDate(B)]: Math.round(r.curOver), 'Tuổi nợ xấu nhất': bName(r.curWorst) })),
  });

  return (
    <>
      <div className="filters">
        <DateSelect label="Từ ngày" dates={older} value={A} onChange={setFrom} />
        <DateSelect label="đến ngày" dates={dates} value={B} onChange={setTo} />
        <div className="presets">
          <button className="chip" onClick={() => setFrom(older[0] || '')}>Bản liền trước</button>
          <button className="chip" onClick={() => pick(7)}>~7 ngày</button>
          <button className="chip" onClick={() => pick(30)}>~30 ngày</button>
          <button className="chip" onClick={() => setFrom(older.find((x) => x < monthStart) || older[older.length - 1] || '')}>Cuối tháng trước</button>
        </div>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={doExport} disabled={!rows.length}>⬇ Excel</button>
      </div>
      <ErrorBox error={RA.error || RB.error} />
      <div className="stats">
        <Stat label={'Tổng nợ ' + fmtDate(A) + ' → ' + fmtDate(B)} value={short(K.b) + ' đ'} tone="amber" sub={<>trước: {short(K.a)} · <Delta v={K.b - K.a} /></>} />
        <Stat label="Nợ tăng (phát sinh mới, ước tính)" value={short(K.up) + ' đ'} tone="red" sub={`${rows.filter((r) => r.up > 0).length} KH tăng nợ · ${K.nNew} KH mới`} />
        <Stat label="Nợ giảm (đã thu, ước tính)" value={short(K.down) + ' đ'} tone="green" sub={`${rows.filter((r) => r.down > 0).length} KH giảm nợ · ${K.nGone} KH hết nợ`} />
        <Stat label="Quá hạn" value={short(K.ob) + ' đ'} tone="red" sub={<>trước: {short(K.oa)} · <Delta v={K.ob - K.oa} /></>} />
        <Stat label="Tuổi nợ" value={`${K.nWorse} xấu đi`} tone={K.nWorse ? 'red' : ''} sub={`${K.nCleared} KH hết quá hạn`} />
      </div>
      <p className="small">Nợ tăng / giảm tính từ chênh lệch tổng nợ từng khách giữa 2 ngày (cùng một khách vừa mua thêm vừa trả tiền thì chỉ thấy phần chênh lệch).{multi && ' Công ty nào không có số liệu đúng ngày chọn thì lấy bản gần nhất trước đó.'}
        {skipped.length > 0 && <b> {skipped.join(', ')} chưa có số liệu đến ngày {fmtDate(A)} nên không đưa vào so sánh.</b>}</p>
      {RA.loading || RB.loading ? <Empty text="Đang tải chi tiết…" /> : (
        <>
          <div className="section-title">Cơ cấu tuổi nợ</div>
          <ReportTable rows={bucketRows} cols={[
            { key: 'label', label: 'Khoảng' },
            { key: 'a', label: fmtDate(A), num: true, sum: true }, { key: 'pa', label: '%', num: true, render: (r) => pct(r.pa, 1) },
            { key: 'b', label: fmtDate(B), num: true, sum: true }, { key: 'pb', label: '%', num: true, render: (r) => pct(r.pb, 1) },
            { key: 'd', label: 'Chênh lệch', num: true, sum: true, render: (r) => <Delta v={r.d} good={r.label === 'Trong hạn' ? 'up' : 'down'} /> },
          ]} />
          <div className="section-title">Theo nhóm khách hàng / sale</div>
          <ReportTable cols={gCols} rows={groups} />
          <div className="section-title">Theo khách hàng</div>
          <div className="filters">
            <input placeholder="Tìm khách hàng / mã KH / sale…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="presets">{KINDS.map(([k, l]) => <button key={k} className={'chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>{l}</button>)}</div>
            <span className="small">{list.length} khách hàng</span>
          </div>
          <ReportTable cols={cCols} rows={list} empty="Không có khách hàng nào thay đổi." />
        </>
      )}
    </>
  );
}

// ================= Xu hướng theo ngày =================
function LineChart({ points, series }) {
  const W = 900; const H = 240; const L = 70; const R = 16; const Tp = 14; const Bt = 30;
  const max = Math.max(1, ...points.flatMap((p) => series.map((s) => p[s.key])));
  const x = (i) => L + (points.length < 2 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v) => Tp + (H - Tp - Bt) * (1 - v / max);
  const step = Math.max(1, Math.ceil(points.length / 12));
  return (
    <div className="table-wrap" style={{ padding: 10, marginBottom: 14 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}><line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="#e5e7eb" /><text x={L - 6} y={y(max * f) + 4} fontSize="11" textAnchor="end" fill="#6b7280">{short(max * f)}</text></g>
        ))}
        {points.map((p, i) => (i % step === 0 || i === points.length - 1) && <text key={p.date} x={x(i)} y={H - 10} fontSize="11" textAnchor="middle" fill="#6b7280">{fmtDate(p.date).slice(0, 5)}</text>)}
        {series.map((s) => (
          <g key={s.key}>
            <polyline fill="none" stroke={s.color} strokeWidth="2.5" points={points.map((p, i) => `${x(i)},${y(p[s.key])}`).join(' ')} />
            {points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p[s.key])} r="3" fill={s.color}><title>{`${fmtDate(p.date)} – ${s.label}: ${m(p[s.key])} đ`}</title></circle>)}
          </g>
        ))}
      </svg>
      <div className="small" style={{ display: 'flex', gap: 14 }}>{series.map((s) => <span key={s.key}><span style={{ display: 'inline-block', width: 12, height: 3, background: s.color, marginRight: 4, verticalAlign: 'middle' }} />{s.label}</span>)}</div>
    </div>
  );
}

function Trend({ snaps, cos, dates }) {
  const [span, setSpan] = useState(30);
  const pts = useMemo(() => {
    const asc = [...dates].reverse().slice(-span);
    return asc.map((d, i) => {
      const at = snapsAt(snaps, cos, d);
      const lastOf = (s) => n((s.aging || [])[(s.aging || []).length - 1]);
      return { _k: d, date: d, amount: at.reduce((t, s) => t + n(s.amount), 0), overdue: at.reduce((t, s) => t + n(s.overdue), 0),
        last: at.reduce((t, s) => t + lastOf(s), 0), count: at.reduce((t, s) => t + n(s.count), 0), overCount: at.reduce((t, s) => t + n(s.overdueCount), 0),
        note: [...at.filter((s) => s.asOf !== d).map((s) => `${s.company} lấy ngày ${fmtDate(s.asOf)}`),
          ...cos.filter((c) => !at.some((s) => s.company === c)).map((c) => `chưa có ${c}`)].join(', '), i };
    }).map((p, i, arr) => ({ ...p, dAmt: i ? p.amount - arr[i - 1].amount : 0, dOver: i ? p.overdue - arr[i - 1].overdue : 0 }));
  }, [snaps, cos.join(','), dates, span]);
  const lastLabel = snaps.find((s) => s.buckets?.length)?.buckets.slice(-1)[0] || '';
  return (
    <>
      <div className="filters">
        <span>Hiển thị</span>
        <div className="presets">{[[10, '10 ngày gần nhất'], [30, '30 ngày'], [90, '90 ngày'], [9999, 'Tất cả']].map(([k, l]) => <button key={k} className={'chip' + (span === k ? ' on' : '')} onClick={() => setSpan(k)}>{l}</button>)}</div>
      </div>
      <LineChart points={pts} series={[{ key: 'amount', label: 'Tổng nợ', color: '#1565c0' }, { key: 'overdue', label: 'Quá hạn', color: '#e53935' }, ...(lastLabel ? [{ key: 'last', label: 'Quá hạn ' + lastLabel, color: '#7f0000' }] : [])]} />
      <ReportTable rows={[...pts].reverse()} cols={[
        { key: 'date', label: 'Ngày số liệu', render: (r) => <>{fmtDate(r.date)}{r.note && <div className="small">{r.note}</div>}</> },
        { key: 'count', label: 'Số KH', num: true },
        { key: 'amount', label: 'Tổng nợ', num: true },
        { key: 'dAmt', label: 'So với ngày trước', num: true, render: (r) => <Delta v={r.dAmt} /> },
        { key: 'overdue', label: 'Quá hạn', num: true },
        { key: 'dOver', label: 'QH so với ngày trước', num: true, render: (r) => <Delta v={r.dOver} /> },
        { key: 'pct', label: '% quá hạn', num: true, render: (r) => pct(r.overdue, r.amount) },
        ...(lastLabel ? [{ key: 'last', label: 'QH ' + lastLabel, num: true }] : []),
        { key: 'overCount', label: 'KH quá hạn', num: true },
      ]} />
    </>
  );
}

// ================= Các lần nhập =================
function History({ snaps, isSuper, coName }) {
  const [msg, setMsg] = useState('');
  const list = [...snaps].sort((a, b) => b.asOf.localeCompare(a.asOf) || a.company.localeCompare(b.company)).map((s) => ({ ...s, _k: s.id }));
  const del = async (s) => {
    if (!window.confirm(`Xóa số liệu công nợ ${s.company} ngày ${fmtDate(s.asOf)}?`)) return;
    try {
      await deleteDoc(doc(db, 'debtRows', s.id)); await deleteDoc(doc(db, 'debtSnapshots', s.id)); forgetRows(s.id);
      setMsg(`Đã xóa số liệu ${s.company} ngày ${fmtDate(s.asOf)}.`);
    } catch (e) { setMsg('Không xóa được: ' + e.message); }
  };
  return (
    <>
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <p className="small">Mỗi công ty, mỗi ngày số liệu giữ 1 bản. Nhập lại cùng ngày (VD: đầu ngày rồi cuối ngày) sẽ thay bản cũ của ngày đó.{!isSuper && ' Muốn xóa bản nhập sai, báo quản trị gốc.'}</p>
      <ReportTable rows={list} cols={[
        { key: 'asOf', label: 'Ngày số liệu', render: (r) => fmtDate(r.asOf) },
        { key: 'company', label: 'Công ty', render: (r) => <><b>{r.company}</b> <span className="small">{coName(r.company) !== r.company ? coName(r.company) : ''}</span></> },
        { key: 'count', label: 'Số KH', num: true },
        { key: 'amount', label: 'Tổng nợ', num: true },
        { key: 'overdue', label: 'Quá hạn', num: true },
        { key: 'check', label: 'Đối chiếu dòng Tổng cộng', render: (r) => (r.fileTotal == null ? '-' : Math.round(r.fileTotal) === Math.round(r.amount) ? <span className="badge green">Khớp</span> : <span className="badge red">File: {m(r.fileTotal)}</span>) },
        { key: 'fileName', label: 'File' },
        { key: 'importedBy', label: 'Người nhập', render: (r) => <>{r.importedBy}<div className="small">{tsText(r.importedAt)}</div></> },
        ...(isSuper ? [{ key: 'x', label: '', render: (r) => <button className="btn sm danger" onClick={() => del(r)}>Xóa</button> }] : []),
      ]} />
    </>
  );
}

// ================= Nhập file tuổi nợ MISA =================
function ImportAging({ snaps, companies, users, onClose, onDone }) {
  const { email } = useApp();
  const [company, setCompany] = useState('');
  const [fileName, setFileName] = useState('');
  const [res, setRes] = useState(null);
  const [asOf, setAsOf] = useState(today());
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  const load = async (file) => {
    setErr(''); setDone(''); setRes(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const r = parseAging(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }));
      if (!r.rows.length) throw new Error('Không đọc được dòng khách hàng nào trong file.');
      setRes(r); setFileName(file.name);
      if (r.asOf) setAsOf(r.asOf);
      const c = detectCompany(companies, r.company);
      if (c) setCompany(c);
    } catch (e) { setErr(e.message); }
  };
  const detected = res ? detectCompany(companies, res.company) : '';
  const total = res ? res.rows.reduce((s, r) => s + r.amount, 0) : 0;
  const existing = snaps.find((s) => s.id === snapId(company, asOf));
  const groups = res ? res.groups.map((g) => ({ ...g, user: userForGroup(users, g.code, g.name) })) : [];

  const run = async () => {
    if (!company) { setErr('Hãy chọn công ty của file này.'); return; }
    if (!asOf) { setErr('Hãy nhập ngày số liệu.'); return; }
    if (detected && detected !== company && !window.confirm(`Tên công ty trong file là "${res.company}" (có vẻ là ${detected}) nhưng bạn chọn ${company}. Vẫn nhập vào ${company}?`)) return;
    if (existing && !window.confirm(`Đã có số liệu ${company} ngày ${fmtDate(asOf)} (nhập bởi ${existing.importedBy} lúc ${tsText(existing.importedAt)}). Thay bằng file này?`)) return;
    setBusy(true); setErr('');
    try {
      await saveSnapshot({ company, asOf, buckets: res.buckets, rows: res.rows, fileName, fileCompany: res.company, fileTotal: res.fileTotal, email });
      setDone(`Đã nhập công nợ ${company} ngày ${fmtDate(asOf)}: ${res.rows.length} khách hàng, tổng nợ ${m(total)} đ.`);
      setRes(null);
      onDone(company);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <Modal title="Nhập công nợ phải thu theo tuổi nợ (MISA)" onClose={onClose} wide>
      <p className="small">
        Trên MISA: <b>Báo cáo → Công nợ → Phân tích công nợ phải thu theo tuổi nợ</b> (nên nhóm theo <b>Nhóm khách hàng</b> = sale), xuất Excel rồi chọn file ở đây.
        Mỗi công ty nhập <b>1 file riêng</b>. Có thể nhập đầu ngày và cuối ngày; cùng công ty + cùng ngày số liệu thì bản sau thay bản trước.
      </p>
      <div className="filters">
        <b>Công ty của file:</b>
        <select value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">-- Chọn công ty --</option>
          {companies.map((c) => <option key={c.code} value={c.code}>{c.code}{c.name && c.name !== c.code ? ' – ' + c.name : ''}</option>)}
        </select>
        <input type="file" accept=".xlsx,.xls" onChange={(e) => e.target.files[0] && load(e.target.files[0])} />
      </div>
      {res?.company && <div className="small" style={{ marginBottom: 6 }}>Tên công ty trong file: <b>{res.company}</b>{detected ? ` → tự nhận là ${detected}` : ' → hãy chọn công ty ở trên'}</div>}
      {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
      {done && <div className="ok-box" style={{ marginTop: 10 }}>{done}</div>}
      {res && (
        <>
          <div className="filters" style={{ marginTop: 12 }}>
            <span>Số liệu đến ngày</span>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            <span className="small">Các khoảng quá hạn: {res.buckets.join(' · ')}</span>
            {existing && <span className="badge amber">Đã có bản {company} ngày này → sẽ thay thế</span>}
          </div>
          <div className="stats">
            <Stat label="Số khách hàng" value={res.rows.length} />
            <Stat label="Tổng nợ đọc được" value={m(total)} tone="amber"
              sub={res.fileTotal != null ? (Math.round(res.fileTotal) === Math.round(total) ? '✔ Khớp dòng Tổng cộng trong file' : `⚠ Tổng cộng trong file: ${m(res.fileTotal)}`) : ''} />
            <Stat label="Tổng quá hạn" value={m(res.rows.reduce((s, r) => s + r.overdue, 0))} tone="red" />
          </div>
          {groups.length > 0 && (
            <>
              <div className="section-title">Nhóm khách hàng trong file</div>
              <ReportTable rows={groups.map((g) => ({ ...g, _k: g.code }))} cols={[
                { key: 'code', label: 'Mã nhóm' }, { key: 'name', label: 'Tên nhóm' }, { key: 'count', label: 'Số KH', num: true, sum: true },
                { key: 'amount', label: 'Tổng nợ', num: true, sum: true },
                { key: 'user', label: 'Người dùng trong app', render: (g) => (g.user ? <span className="badge green">{g.user.name || g.user._id}</span> : <span className="small">Chưa khớp (hiện theo tên nhóm)</span>) },
              ]} />
            </>
          )}
          <div className="section-title">Xem trước</div>
          <div className="table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
            <table>
              <thead><tr><th>Dòng</th><th>Mã KH</th><th>Khách hàng</th><th>Nhóm</th><th className="num">Tổng nợ</th><th className="num">Trong hạn</th>
                {res.buckets.map((b) => <th key={b} className="num">{b}</th>)}<th className="num">Quá hạn</th></tr></thead>
              <tbody>
                {res.rows.slice(0, 300).map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td><td>{r.code}</td><td>{r.name}{!r.code && <span className="badge amber" style={{ marginLeft: 4 }}>⚠ thiếu mã KH</span>}</td><td className="small">{r.group}</td>
                    <td className="num">{m(r.amount)}</td><td className="num">{r.notDue ? m(r.notDue) : '-'}</td>
                    {r.aging.map((v, i) => <td key={i} className="num">{v ? m(v) : '-'}</td>)}
                    <td className="num">{r.overdue ? m(r.overdue) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>Đóng</button>
        {res && <button type="button" className="btn primary" disabled={busy || !company} onClick={run}>{busy ? 'Đang lưu…' : `Nhập công nợ ${company || '(chọn công ty)'} – ${res.rows.length} khách hàng`}</button>}
      </div>
    </Modal>
  );
}
