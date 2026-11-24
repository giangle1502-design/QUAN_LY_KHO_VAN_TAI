import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useOrders } from '../../lib/hooks';
import { customerSales } from '../../lib/plasticSales';
import { deleteOrRequest } from '../../lib/deletes';
import { exportSheets } from '../../lib/excel';
import { ORDER_STATUS } from '../../lib/orders';
import { fmtDate, fmtNum, matchQ, today } from '../../lib/utils';
import {
  completeness, CONTACT_FILTERS, contactMap, daysSince, matchContact, missingInfo, PROSPECT_STATUS, removeActivity, setProspectStatus, useActivities, useProspects,
} from '../../lib/sale';
import { PROSPECT_STAGES } from '../../catalogs';
import { usePartnerRows } from '../Partners';
import { ReportTable, toSheet } from '../reports/Reports';
import Select from '../../components/Select';
import { Empty, ErrorBox, Modal } from '../../components/ui';
import { ActivityForm, CreateCodeModal, ProspectForm, useSales } from './SaleForms';

// ============================================================================
// Sale control › Khách hàng, chia 2 phần:
//  • Đang tiếp cận: khách sale tự tìm và nhập (chưa có mã). Chốt đơn → 🏷 Tạo mã khách hàng → sang danh mục kho.
//  • Đã chốt đơn: khách đã có mã trong danh mục Khách hàng / NCC (bên kho), kèm số SO, lần mua gần nhất, sản lượng 90 ngày.
// Sale chỉ thấy khách của mình ở cả hai phần; sale quản lý và quản trị thấy tất cả.
// ============================================================================

const ago = (ymd) => {
  const d = daysSince(ymd);
  return d == null ? '' : d <= 0 ? 'hôm nay' : `${d} ngày trước`;
};
const lastText = (info) => (info?.last ? `${fmtDate(info.last.date)} · ${info.last.type}` : '');
const nextText = (info) => (info?.next ? `${fmtDate(info.next.nextDate)}${info.next.nextAction ? ` · ${info.next.nextAction}` : ''}` : '');
const nextStyle = (info) => (!info?.next ? undefined : info.next.nextDate < today() ? { color: 'var(--red)', fontWeight: 600 } : info.next.nextDate === today() ? { color: 'var(--amber)', fontWeight: 600 } : undefined);
const lastStyle = (info) => {
  const d = info?.last ? daysSince(info.last.date) : null;
  return d == null ? { color: 'var(--muted)' } : d > 30 ? { color: 'var(--red)' } : d > 7 ? { color: 'var(--amber)' } : undefined;
};

export default function SaleCustomers() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'da-chot' ? 'da-chot' : 'tiep-can';
  const { salesOnly } = useApp();
  const prospects = useProspects();
  const acts = useActivities();
  const prospectMap = useMemo(() => new Map(prospects.rows.map((p) => [p.id, p])), [prospects.rows]);
  const contacts = useMemo(() => contactMap(acts.rows, prospectMap), [acts.rows, prospectMap]);
  const [edit, setEdit] = useState(null); // { kind: 'prospect' | 'act' | 'code', rec, target }
  const [detail, setDetail] = useState(null); // { kind: 'P' | 'C', row }
  const nOpen = prospects.rows.filter((p) => (p.status || 'open') === 'open').length;
  return (
    <div>
      <div className="page-head">
        <h1>👥 Khách hàng (Sale)</h1>
        <div className="actions">
          <div className="seg">
            <button type="button" className={tab === 'tiep-can' ? 'on' : ''} onClick={() => setParams({ tab: 'tiep-can' })}>🎯 Đang tiếp cận ({nOpen})</button>
            <button type="button" className={tab === 'da-chot' ? 'on' : ''} onClick={() => setParams({ tab: 'da-chot' })}>✅ Đã chốt đơn</button>
          </div>
          {tab === 'tiep-can' && <button className="btn primary" onClick={() => setEdit({ kind: 'prospect' })}>＋ Thêm khách đang tiếp cận</button>}
        </div>
      </div>
      {salesOnly && <p className="hint">Bạn đang thấy khách của mình. Sale quản lý và quản trị thấy khách của mọi sale.</p>}
      <ErrorBox error={prospects.error || acts.error ? `Chưa đọc được dữ liệu Sale (${prospects.error || acts.error}). Nếu báo thiếu quyền: cần dán quy tắc Firestore mới.` : ''} />
      {tab === 'tiep-can'
        ? <ProspectList rows={prospects.rows} loading={prospects.loading} contacts={contacts} setEdit={setEdit} setDetail={setDetail} />
        : <ClosedList contacts={contacts} setEdit={setEdit} setDetail={setDetail} />}
      {edit?.kind === 'prospect' && <ProspectForm rec={edit.rec} onClose={() => setEdit(null)} />}
      {edit?.kind === 'act' && <ActivityForm rec={edit.rec} target={edit.target} onClose={() => setEdit(null)} />}
      {edit?.kind === 'code' && <CreateCodeModal prospect={edit.rec} onClose={(code) => { setEdit(null); if (code) { setDetail(null); setParams({ tab: 'da-chot', q: code }); } }} />}
      {detail && <CustomerDetail detail={detail} acts={acts.rows} prospectMap={prospectMap} onClose={() => setDetail(null)} setEdit={setEdit} />}
    </div>
  );
}

// ---------------- Đang tiếp cận ----------------
function ProspectList({ rows: all, loading, contacts, setEdit, setDetail }) {
  const { salesOnly, email, name, isSuper } = useApp();
  const { nameOf } = useSales();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('open');
  const [stage, setStage] = useState('');
  const [contact, setContact] = useState('');
  const [lack, setLack] = useState(false);
  const [sale, setSale] = useState('');
  const sales = [...new Set(all.map((p) => p.owner).filter(Boolean))];
  const rows = all.filter((p) => (status === 'all' || (p.status || 'open') === status) && (!stage || p.stage === stage) && (!sale || p.owner === sale)
    && (!lack || missingInfo(p).length > 0) && matchContact(contacts.get(`P:${p.id}`), contact)
    && matchQ(q, p.name, p.taxCode, p.contact, p.phone, p.email, p.address, p.productsUsed, p.note, nameOf(p.owner), p.convertedCode))
    .map((p) => ({ ...p, _k: p.id, pct: completeness(p), _c: contacts.get(`P:${p.id}`) }));
  const drop = async (p) => {
    const st = p.status === 'dropped' ? 'open' : 'dropped';
    if (st === 'dropped' && !window.confirm(`Ngừng theo dõi khách "${p.name}"? (Không xóa, mở lại được.)`)) return;
    try { await setProspectStatus(p.id, st, { email, name }); } catch (e) { window.alert(e.message); }
  };
  const del = async (p) => {
    if (!window.confirm(isSuper ? `Xóa hẳn khách "${p.name}"?` : `Gửi yêu cầu xóa khách "${p.name}" cho quản trị gốc duyệt?`)) return;
    try { const r = await deleteOrRequest({ coll: 'prospects', id: p.id, label: `Khách đang tiếp cận ${p.name}`, data: p }, { email, name }, isSuper); if (r === 'requested') window.alert('Đã gửi yêu cầu xóa.'); } catch (e) { window.alert(e.message); }
  };
  const cols = [
    { key: 'name', label: 'Khách hàng', render: (r) => <><b>{r.name}</b>{r.taxCode && <div className="small">MST {r.taxCode}</div>}</>, excel: (r) => r.name },
    { key: 'actions', label: '', noExcel: true, noSort: true, noFilter: true, render: (r) => (
      <span className="nowrap" onClick={(e) => e.stopPropagation()}>
        <button className="btn sm" title="Ghi hoạt động" onClick={() => setEdit({ kind: 'act', target: { prospectId: r.id, name: r.name } })}>📞</button>{' '}
        <button className="btn sm" title="Sửa" onClick={() => setEdit({ kind: 'prospect', rec: r })}>✎</button>{' '}
        {(r.status || 'open') === 'open' && <button className="btn sm primary" onClick={() => setEdit({ kind: 'code', rec: r })}>🏷 Tạo mã KH</button>}
      </span>) },
    ...(salesOnly ? [] : [{ key: 'owner', label: 'Sale phụ trách', render: (r) => nameOf(r.owner), excel: (r) => nameOf(r.owner), sortVal: (r) => nameOf(r.owner) }]),
    { key: 'stage', label: 'Giai đoạn', render: (r) => (r.status === 'converted' ? <span className="badge green">Đã tạo mã {r.convertedCode}</span> : r.status === 'dropped' ? <span className="badge red">Ngừng theo dõi</span> : r.stage ? <span className="badge blue">{r.stage}</span> : ''),
      excel: (r) => (r.status === 'open' || !r.status ? r.stage : PROSPECT_STATUS[r.status]?.label) },
    { key: 'plasticType', label: 'Loại hạt' },
    { key: 'productsUsed', label: 'Đang dùng' },
    { key: 'monthlyVolume', label: 'Tấn/tháng', num: true, digits: 1 },
    { key: 'contact', label: 'Liên hệ', render: (r) => <>{r.contact}{r.phone && <div className="small nowrap">{r.phone}</div>}</>, excel: (r) => r.contact },
    { key: 'pct', label: '% đủ thông tin', num: true, render: (r) => (
      <span title={missingInfo(r).length ? `Thiếu: ${missingInfo(r).join(', ')}` : 'Đủ thông tin để tạo mã'} className="nowrap">
        <span className="pct-bar"><i style={{ width: `${r.pct}%`, background: r.pct >= 100 ? 'var(--green)' : r.pct >= 50 ? 'var(--amber)' : 'var(--red)' }} /></span> {r.pct}%
      </span>) },
    { key: 'last', label: 'Liên hệ gần nhất', render: (r) => (r._c?.last ? <span style={lastStyle(r._c)}>{lastText(r._c)}<div className="small">{ago(r._c.last.date)}</div></span> : <span className="small">Chưa liên hệ</span>),
      excel: (r) => lastText(r._c), sortVal: (r) => r._c?.last?.date || '' },
    { key: 'next', label: 'Hẹn tiếp theo', render: (r) => <span style={nextStyle(r._c)}>{nextText(r._c)}</span>, excel: (r) => nextText(r._c), sortVal: (r) => r._c?.next?.nextDate || '' },
  ];
  return (
    <>
      <div className="filters">
        <input type="search" placeholder="Tìm tên, MST, SĐT, người liên hệ…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Đang tiếp cận</option>
          <option value="converted">Đã tạo mã</option>
          <option value="dropped">Ngừng theo dõi</option>
          <option value="all">Tất cả</option>
        </Select>
        <Select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">Giai đoạn: tất cả</option>
          {[...new Set([...PROSPECT_STAGES, ...all.map((p) => p.stage).filter(Boolean)])].map((s) => <option key={s}>{s}</option>)}
        </Select>
        <Select value={contact} onChange={(e) => setContact(e.target.value)}>
          {CONTACT_FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {!salesOnly && sales.length > 1 && (
          <Select value={sale} onChange={(e) => setSale(e.target.value)}>
            <option value="">Sale: tất cả</option>
            {sales.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}
          </Select>
        )}
        <label className="small"><input type="checkbox" checked={lack} onChange={(e) => setLack(e.target.checked)} /> Chỉ khách thiếu thông tin</label>
        <button className="btn" onClick={() => exportSheets(`KhachDangTiepCan_${today()}`, { 'Đang tiếp cận': toSheet(cols, rows) })}>⬇ Excel</button>
      </div>
      {loading ? <Empty text="Đang tải…" /> : (
        <ReportTable id="sale-prospects" cols={cols} rows={rows} empty={all.length ? 'Không có khách nào khớp bộ lọc.' : 'Chưa có khách đang tiếp cận. Bấm “＋ Thêm khách đang tiếp cận”.'}
          onRowClick={(r) => setDetail({ kind: 'P', row: r })} rowTitle="Bấm để xem lịch sử chăm sóc"
          extra={[
            { key: 'taxCode', label: 'MST' }, { key: 'phone', label: 'Điện thoại' }, { key: 'source', label: 'Nguồn' }, { key: 'address', label: 'Địa chỉ' },
            { key: 'x_drop', label: 'Ngừng / xóa', noExcel: true, noSort: true, noFilter: true, render: (r) => (
            <span className="nowrap" onClick={(e) => e.stopPropagation()}>
              {r.status !== 'converted' && <button className="btn sm" onClick={() => drop(r)}>{r.status === 'dropped' ? 'Theo dõi lại' : 'Ngừng theo dõi'}</button>}{' '}
              <button className="btn sm danger" onClick={() => del(r)}>Xóa</button>
            </span>) }]} />
      )}
    </>
  );
}

// ---------------- Đã chốt đơn (khách có mã, danh mục bên kho) ----------------
function ClosedList({ contacts, setEdit, setDetail }) {
  const { salesOnly, email } = useApp();
  const [params] = useSearchParams();
  const { nameOf } = useSales();
  const partners = usePartnerRows();
  const so = useOrders('SO');
  const [q, setQ] = useState(params.get('q') || '');
  const [contact, setContact] = useState('');
  const [hasSo, setHasSo] = useState('');
  const stats = useMemo(() => {
    const m = new Map();
    const from90 = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    for (const o of so.rows) {
      if (o.status === 'cancelled' || !o.partyCode) continue;
      const x = m.get(o.partyCode) || { n: 0, last: '', kg90: 0, sales: new Set(), mine: false };
      x.n++;
      if (String(o.date || '') > x.last) x.last = o.date || '';
      if (String(o.date || '') >= from90) x.kg90 += (o.lines || []).reduce((s, l) => s + (Number(l.qtyKg) || 0), 0);
      if (o.sales) x.sales.add(o.sales);
      if (o.sales === email) x.mine = true;
      m.set(o.partyCode, x);
    }
    return m;
  }, [so.rows, email]);
  const rows = partners.rows.filter((r) => r.isCustomer && r.status !== 'inactive')
    // Sale thường: khách được gán cho mình hoặc khách có SO của mình (không hiện khách chưa gán ai mà mình chưa bán)
    .filter((r) => !salesOnly || customerSales(r._soldto || {}).includes(email) || stats.get(r.code)?.mine)
    .map((r) => {
      const s = stats.get(r.code);
      const assigned = [...new Set([r._salesVirgin, r._salesRecycled].filter(Boolean))];
      return { ...r, _k: r.code, soN: s?.n || 0, lastSo: s?.last || '', kg90: s?.kg90 || 0, saleNames: (assigned.length ? assigned : [...(s?.sales || [])]).map(nameOf).join(', '), _c: contacts.get(`C:${r.code}`) };
    })
    .filter((r) => (!hasSo || (hasSo === 'yes' ? r.soN > 0 : r.soN === 0)) && matchContact(r._c, contact)
      && matchQ(q, r.code, r.name, r.taxCode, r.phone, r.email, r.billingAddress, r.saleNames, r.keywords));
  const cols = [
    { key: 'code', label: 'Mã KH', nowrap: true },
    { key: 'name', label: 'Tên khách hàng' },
    { key: 'actions', label: '', noExcel: true, noSort: true, noFilter: true, render: (r) => (
      <span className="nowrap" onClick={(e) => e.stopPropagation()}>
        <button className="btn sm" title="Ghi hoạt động" onClick={() => setEdit({ kind: 'act', target: { partyCode: r.code, name: r.name } })}>📞</button>{' '}
        <Link className="btn sm" to={`/don-hang?tab=SO&q=${encodeURIComponent(r.code)}`} title="Xem SO của khách">🧾 SO</Link>
      </span>) },
    { key: 'taxCode', label: 'MST' },
    { key: 'saleNames', label: 'Sale phụ trách' },
    { key: 'soN', label: 'Số SO', num: true },
    { key: 'lastSo', label: 'SO gần nhất', date: true, render: (r) => (r.lastSo ? <>{fmtDate(r.lastSo)}<div className="small">{ago(r.lastSo)}</div></> : <span className="small">Chưa có SO trong app</span>), excel: (r) => fmtDate(r.lastSo) },
    { key: 'kg90', label: 'Kg đặt 90 ngày', num: true, sum: true },
    { key: 'last', label: 'Liên hệ gần nhất', render: (r) => (r._c?.last ? <span style={lastStyle(r._c)}>{lastText(r._c)}<div className="small">{ago(r._c.last.date)}</div></span> : <span className="small">Chưa ghi</span>),
      excel: (r) => lastText(r._c), sortVal: (r) => r._c?.last?.date || '' },
    { key: 'next', label: 'Hẹn tiếp theo', render: (r) => <span style={nextStyle(r._c)}>{nextText(r._c)}</span>, excel: (r) => nextText(r._c), sortVal: (r) => r._c?.next?.nextDate || '' },
  ];
  return (
    <>
      <p className="hint">Khách đã có mã trong danh mục <Link to="/dm/partners?nhom=kh">Khách hàng / NCC</Link> bên kho. Sửa thông tin khách, điểm giao ở danh mục đó.</p>
      <div className="filters">
        <input type="search" placeholder="Tìm mã, tên, MST, SĐT…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
        <Select value={hasSo} onChange={(e) => setHasSo(e.target.value)}>
          <option value="">Mọi khách có mã</option>
          <option value="yes">Có SO trong app</option>
          <option value="no">Chưa có SO trong app</option>
        </Select>
        <Select value={contact} onChange={(e) => setContact(e.target.value)}>
          {CONTACT_FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <button className="btn" onClick={() => exportSheets(`KhachDaChotDon_${today()}`, { 'Đã chốt đơn': toSheet(cols, rows) })}>⬇ Excel</button>
      </div>
      <ErrorBox error={partners.error || so.error} />
      {partners.loading ? <Empty text="Đang tải…" /> : (
        <ReportTable id="sale-closed" cols={cols} rows={rows} extra={[{ key: 'phone', label: 'Điện thoại' }, { key: 'billingAddress', label: 'Địa chỉ' }]} empty="Chưa có khách nào." defaultSort={[{ key: 'lastSo', dir: 'desc' }]}
          onRowClick={(r) => setDetail({ kind: 'C', row: r })} rowTitle="Bấm để xem lịch sử chăm sóc và SO" />
      )}
    </>
  );
}

// ---------------- Chi tiết khách: lịch sử hoạt động (+ SO nếu có mã) ----------------
function CustomerDetail({ detail, acts, prospectMap, onClose, setEdit }) {
  const { email, isAdmin } = useApp();
  const { nameOf } = useSales();
  const so = useOrders(detail.kind === 'C' ? 'SO' : '__none__');
  const r = detail.kind === 'P' ? { ...detail.row, ...(prospectMap.get(detail.row.id) || {}) } : detail.row;
  const key = detail.kind === 'C' ? `C:${r.code}` : r.convertedCode ? `C:${r.convertedCode}` : `P:${r.id}`;
  const list = acts.filter((a) => (a.partyCode ? `C:${a.partyCode}` : prospectMap.get(a.prospectId)?.convertedCode ? `C:${prospectMap.get(a.prospectId).convertedCode}` : `P:${a.prospectId}`) === key)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const orders = detail.kind === 'C' ? so.rows.filter((o) => o.partyCode === r.code).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))) : [];
  const target = detail.kind === 'C' ? { partyCode: r.code, name: r.name } : r.convertedCode ? { partyCode: r.convertedCode, name: r.name } : { prospectId: r.id, name: r.name };
  const del = async (a) => { if (window.confirm('Xóa hoạt động này?')) try { await removeActivity(a.id); } catch (e) { window.alert(e.message); } };
  return (
    <Modal title={`${detail.kind === 'C' ? `${r.code} – ` : ''}${r.name}`} onClose={onClose} wide>
      <div className="small" style={{ marginBottom: 8 }}>
        {[r.taxCode && `MST ${r.taxCode}`, (r.contact || r.contactName) && `Liên hệ: ${r.contact || r.contactName}`, r.phone, r.email, r.address || r.billingAddress,
          detail.kind === 'P' && r.owner && `Sale: ${nameOf(r.owner)}`, detail.kind === 'C' && r.saleNames && `Sale: ${r.saleNames}`].filter(Boolean).join(' · ')}
      </div>
      {detail.kind === 'P' && r.status === 'converted' && <p className="hint">Đã tạo mã <b>{r.convertedCode}</b>: khách nằm ở phần Đã chốt đơn.</p>}
      <div className="section-head">
        <span className="grow">📞 Lịch sử chăm sóc <span className="count">{list.length}</span></span>
        <button className="btn sm primary" onClick={() => setEdit({ kind: 'act', target })}>＋ Ghi hoạt động</button>
        {detail.kind === 'P' && (r.status || 'open') === 'open' && <button className="btn sm" onClick={() => setEdit({ kind: 'code', rec: r })}>🏷 Tạo mã khách hàng</button>}
      </div>
      {!list.length ? <Empty text="Chưa ghi hoạt động nào." /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ngày</th><th>Loại</th><th>Nội dung / kết quả</th><th>Việc tiếp theo</th><th>Sale</th><th /></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{fmtDate(a.date)}</td>
                  <td><span className="badge blue">{a.type}</span></td>
                  <td>{a.content}{a.result && <div className="small">→ {a.result}</div>}</td>
                  <td>{a.nextAction}{a.nextDate && <div className="small" style={nextStyle({ next: a })}>Hẹn {fmtDate(a.nextDate)}</div>}</td>
                  <td className="small">{a.ownerName || nameOf(a.owner)}</td>
                  <td className="nowrap">{(isAdmin || a.owner === email) && <>
                    <button className="btn sm" onClick={() => setEdit({ kind: 'act', rec: a })}>✎</button>{' '}
                    <button className="btn sm danger" onClick={() => del(a)}>✕</button>
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail.kind === 'C' && (
        <>
          <div className="section-head" style={{ marginTop: 14 }}><span className="grow">🧾 Đơn bán (SO) <span className="count">{orders.length}</span></span></div>
          {!orders.length ? <Empty text="Chưa có SO trong app." /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Số SO</th><th>Ngày</th><th>Mã hàng</th><th className="num">Kg đặt</th><th className="num">Kg đã giao</th><th>Tình trạng</th></tr></thead>
                <tbody>
                  {orders.slice(0, 50).map((o) => (
                    <tr key={o.id}>
                      <td><Link to={`/don-hang?tab=SO&q=${o.id}`}>{o.id}</Link></td>
                      <td className="nowrap">{fmtDate(o.date)}</td>
                      <td>{[...new Set((o.lines || []).map((l) => l.item))].join(', ')}</td>
                      <td className="num">{fmtNum((o.lines || []).reduce((s, l) => s + (Number(l.qtyKg) || 0), 0))}</td>
                      <td className="num">{fmtNum((o.lines || []).reduce((s, l) => s + (Number(l.doneKg) || 0), 0))}</td>
                      <td><span className={`badge ${ORDER_STATUS[o.status]?.tone || ''}`}>{ORDER_STATUS[o.status]?.label || o.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
