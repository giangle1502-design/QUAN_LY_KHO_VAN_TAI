import { useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { exportSheets } from '../../lib/excel';
import { displayValue } from '../../components/FieldInput';
import { fmtDate, matchQ, today } from '../../lib/utils';
import { removeActivity, useActivities, useProspects } from '../../lib/sale';
import { customerSales } from '../../lib/plasticSales';
import { usePartnerRows } from '../Partners';
import { ReportTable, toSheet } from '../reports/Reports';
import Select from '../../components/Select';
import { Empty, ErrorBox } from '../../components/ui';
import { ActivityForm, useSales } from './SaleForms';

// ============================================================================
// Sale control › Hoạt động khách hàng (giữ như app Sale control): gọi điện, gặp khách, gửi mẫu, báo giá…
// Khách là khách đang tiếp cận (chưa có mã) hoặc khách đã có mã. Sale thấy hoạt động của mình; sale quản lý, quản trị thấy tất cả.
// ============================================================================

const shift = (days) => new Date(Date.now() + 7 * 3600e3 - days * 864e5).toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const PRESETS = [['7', '7 ngày', () => [shift(6), today()]], ['30', '30 ngày', () => [shift(29), today()]], ['m', 'Tháng này', () => [monthStart(), today()]], ['all', 'Tất cả', () => ['', '']]];

export default function SaleActivities() {
  const { salesOnly, email, isAdmin, fieldsOf } = useApp();
  const { nameOf } = useSales();
  const acts = useActivities();
  const prospects = useProspects();
  const partners = usePartnerRows();
  const [preset, setPreset] = useState('7');
  const [[from, to], setRange] = useState(PRESETS[0][2]());
  const [type, setType] = useState('');
  const [sale, setSale] = useState('');
  const [due, setDue] = useState(false);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const prospectMap = useMemo(() => new Map(prospects.rows.map((p) => [p.id, p])), [prospects.rows]);
  const partnerMap = useMemo(() => new Map(partners.rows.map((p) => [p.code, p])), [partners.rows]);
  // Khách chọn được khi ghi hoạt động: khách đang tiếp cận của mình + khách có mã của mình
  const options = useMemo(() => [
    ...prospects.rows.filter((p) => (p.status || 'open') === 'open').map((p) => ({ key: `P:${p.id}`, prospectId: p.id, name: p.name, label: `🎯 ${p.name} (đang tiếp cận)`, search: [p.taxCode, p.phone, p.contact].join(' ') })),
    ...partners.rows.filter((r) => r.isCustomer && r.status !== 'inactive' && (!salesOnly || customerSales(r._soldto || {}).includes(email)))
      .map((r) => ({ key: `C:${r.code}`, partyCode: r.code, name: r.name, label: `${r.code} – ${r.name}`, search: [r.taxCode, r.phone].join(' ') })),
  ], [prospects.rows, partners.rows, salesOnly, email]);
  const fields = fieldsOf('activity').filter((f) => !f.hidden);
  const types = [...new Set([...(fields.find((f) => f.key === 'type')?.options || []), ...acts.rows.map((a) => a.type).filter(Boolean)])];
  const sales = [...new Set(acts.rows.map((a) => a.owner).filter(Boolean))];
  const custOf = (a) => {
    const p = a.prospectId ? prospectMap.get(a.prospectId) : null;
    const code = a.partyCode || p?.convertedCode || '';
    const c = code ? partnerMap.get(code) : null;
    return { code, name: c?.name || p?.name || a.customerName || '', kind: code ? 'Đã có mã' : 'Đang tiếp cận', taxCode: c?.taxCode || p?.taxCode || '', phone: c?.phone || p?.phone || '' };
  };
  const rows = acts.rows
    .filter((a) => (due ? a.nextDate && a.nextDate <= today() : (!from || String(a.date || '') >= from) && (!to || String(a.date || '') <= to))
      && (!type || a.type === type) && (!sale || a.owner === sale))
    .map((a) => ({ ...a, _k: a.id, _cust: custOf(a) }))
    .filter((a) => matchQ(q, a._cust.name, a._cust.code, a._cust.taxCode, a.content, a.result, a.nextAction, a.ownerName, a.type));
  const del = async (a) => { if (window.confirm('Xóa hoạt động này?')) try { await removeActivity(a.id); } catch (e) { window.alert(e.message); } };
  const custom = fields.filter((f) => f.custom);
  const cols = [
    { key: 'date', label: 'Ngày', date: true, nowrap: true },
    ...(salesOnly ? [] : [{ key: 'owner', label: 'Sale', render: (r) => r.ownerName || nameOf(r.owner), excel: (r) => r.ownerName || nameOf(r.owner), sortVal: (r) => r.ownerName || nameOf(r.owner) }]),
    { key: 'cust', label: 'Khách hàng', render: (r) => <>{r._cust.code && <span className="mono">{r._cust.code} – </span>}{r._cust.name}</>, excel: (r) => [r._cust.code, r._cust.name].filter(Boolean).join(' – '), sortVal: (r) => r._cust.name },
    { key: 'kind', label: 'Loại khách', render: (r) => <span className={`badge ${r._cust.code ? 'green' : 'blue'}`}>{r._cust.kind}</span>, excel: (r) => r._cust.kind, sortVal: (r) => r._cust.kind },
    { key: 'type', label: 'Loại', render: (r) => <span className="badge blue">{r.type}</span>, excel: (r) => r.type },
    { key: 'content', label: 'Nội dung' },
    { key: 'result', label: 'Kết quả' },
    { key: 'nextAction', label: 'Việc tiếp theo' },
    { key: 'nextDate', label: 'Hẹn ngày', date: true, nowrap: true, style: (r) => (r.nextDate && r.nextDate < today() ? { color: 'var(--red)', fontWeight: 600 } : r.nextDate === today() ? { color: 'var(--amber)', fontWeight: 600 } : undefined) },
    { key: 'actions', label: '', noExcel: true, noSort: true, noFilter: true, render: (r) => ((isAdmin || r.owner === email) && (
      <span className="nowrap" onClick={(e) => e.stopPropagation()}>
        <button className="btn sm" onClick={() => setEdit({ rec: r })}>✎</button>{' '}
        <button className="btn sm danger" onClick={() => del(r)}>✕</button>
      </span>)) },
  ];
  const extra = [
    { key: 'x_tax', label: 'MST', render: (r) => r._cust.taxCode, excel: (r) => r._cust.taxCode, sortVal: (r) => r._cust.taxCode },
    { key: 'x_phone', label: 'Điện thoại', render: (r) => r._cust.phone, excel: (r) => r._cust.phone, sortVal: (r) => r._cust.phone },
    ...custom.map((f) => ({ key: f.key, label: f.label, render: (r) => displayValue(f, r[f.key]), excel: (r) => displayValue(f, r[f.key], true) })),
  ];
  return (
    <div>
      <div className="page-head">
        <h1>📞 Hoạt động khách hàng</h1>
        <div className="actions">
          <button className="btn" onClick={() => exportSheets(`HoatDong_${from || 'dau'}_${to || today()}`, { 'Hoạt động': toSheet(cols, rows) })}>⬇ Excel</button>
          <button className="btn primary" onClick={() => setEdit({})}>＋ Ghi hoạt động</button>
        </div>
      </div>
      <div className="filters">
        <div className="presets">
          {PRESETS.map(([k, l, fn]) => <button key={k} type="button" className={'chip' + (preset === k && !due ? ' on' : '')} onClick={() => { setPreset(k); setRange(fn()); setDue(false); }}>{l}</button>)}
          <button type="button" className={'chip' + (due ? ' on' : '')} onClick={() => setDue(!due)} title="Hoạt động có lịch hẹn đến hôm nay hoặc đã quá hẹn">⏰ Hẹn đến hạn</button>
        </div>
        <label className="small">Từ <input type="date" value={from} onChange={(e) => { setPreset(''); setDue(false); setRange([e.target.value, to]); }} /></label>
        <label className="small">đến <input type="date" value={to} onChange={(e) => { setPreset(''); setDue(false); setRange([from, e.target.value]); }} /></label>
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Loại: tất cả</option>
          {types.map((t) => <option key={t}>{t}</option>)}
        </Select>
        {!salesOnly && sales.length > 1 && (
          <Select value={sale} onChange={(e) => setSale(e.target.value)}>
            <option value="">Sale: tất cả</option>
            {sales.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}
          </Select>
        )}
        <input type="search" placeholder="Tìm khách, nội dung…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 200 }} />
      </div>
      <ErrorBox error={acts.error ? `Chưa đọc được hoạt động (${acts.error}). Nếu báo thiếu quyền: cần dán quy tắc Firestore mới.` : ''} />
      {acts.loading ? <Empty text="Đang tải…" /> : (
        <ReportTable id="sale-activities" cols={cols} rows={rows} extra={extra} defaultSort={[{ key: 'date', dir: 'desc' }]}
          empty={acts.rows.length ? 'Không có hoạt động nào trong khoảng này.' : 'Chưa ghi hoạt động nào. Bấm “＋ Ghi hoạt động”.'} />
      )}
      {edit && <ActivityForm rec={edit.rec} options={options} onClose={() => setEdit(null)} />}
    </div>
  );
}
