import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useCompanies } from '../../lib/hooks';
import { costTotal, tripKg } from '../../lib/transport';
import { nowISO } from '../../lib/trips';
import { freightTotalOf, useCostFields } from '../../lib/tripCosts';
import { exportSheets } from '../../lib/excel';
import { tripInvoice } from '../../lib/invoiceInfo';
import { fmtDate, fmtNum, matchQ, today } from '../../lib/utils';
import { Empty, ErrorBox } from '../../components/ui';
import Select from '../../components/Select';

// ============================================================================
// Bảng kê cước: chọn đơn vị vận tải (cước với VAP / PLA / DAM… theo công ty) hoặc 3PL (cước 3PL ↔ GHA),
// khoảng ngày → các chuyến đã hoàn thành, bỏ chọn chuyến không muốn, cộng tiền các chuyến còn lại, in / Excel.
// Lưu bảng kê để 2 bên cùng xem: 3PL mở bảng kê của mình, đối chiếu và bấm Xác nhận.
// ============================================================================
const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
const t3 = (kg) => fmtNum(n(kg) / 1000, 3);
const vnd = (v) => fmtNum(n(v));
const monthStart = () => today().slice(0, 8) + '01';
const BK_STATUS = { draft: ['Đang đối chiếu', 'amber'], confirmed: ['Đã xác nhận', 'green'] };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default function Statements({ trips, priv }) {
  const { isAdmin, role, hasRole, can3PL, myCarrier, myThreepl, email, name } = useApp();
  const isTpl = role === 'tpl';
  const isCarrier = role === 'van_tai';
  const carriers = useCollection('carriers').rows;
  const threepl = useCollection(can3PL ? 'threepl' : '').rows;
  const companies = useCompanies();
  const modes = [...(isTpl ? [] : [['carrier', 'Đơn vị vận tải']]), ...(can3PL || isTpl ? [['3pl', '3PL ↔ GHA']] : [])];
  const [f, setF] = useState({ mode: modes[0][0], party: isCarrier ? myCarrier : isTpl ? myThreepl : '', company: '', from: monthStart(), to: today() });
  const [off, setOff] = useState({}); // chuyến bỏ chọn
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // bảng kê đã lưu đang mở
  const [saved, setSaved] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const is3 = f.mode === '3pl';
  const fixedParty = (isCarrier && !is3) || isTpl;
  const party = fixedParty ? (isTpl ? myThreepl : myCarrier) : f.party;
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v, ...(k === 'mode' ? { party: '' } : {}) })); setOpen(null); setOff({}); };

  // Bảng kê đã lưu (truy vấn đúng phạm vi được đọc)
  useEffect(() => {
    const cs = [where('kind', '==', f.mode)];
    if (isTpl) cs.push(where('party', '==', myThreepl || '-'));
    else if (isCarrier) cs.push(where('carrier', '==', myCarrier || '-'));
    return onSnapshot(query(collection(db, 'statements'), ...cs), (s) => setSaved(s.docs.map((d) => ({ ...d.data(), id: d.id })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))),
      () => setSaved([]));
  }, [f.mode, isTpl, isCarrier, myThreepl, myCarrier]);

  const costOf = (t) => (is3 ? priv[t.id]?.cost3pl : t.costs);
  const list = useMemo(() => {
    if (open) return trips.filter((t) => open.tripIds.includes(t.id));
    return trips.filter((t) => t.status === 'completed' && (!f.from || (t.plannedDate || '') >= f.from) && (!f.to || (t.plannedDate || '') <= f.to)
      && (is3 ? !!priv[t.id]?.threepl && (!party || priv[t.id].threepl === party) : (!party || t.carrier === party))
      && (!f.company || t.company === f.company) && matchQ(q, t.id, t.plate, t.driverName, t.warehouse, (t.lines || []).map((l) => [l.partyCode, l.partyName, l.item, l.orderId]), t.company, t.carrier, t.carrierName));
  }, [trips, priv, f, party, is3, open, q]);
  // Tách cước / dầu + phụ thu / phí khác (chuyến cũ: phí khác = chi hộ + bốc xếp + khác)
  const costFields = useCostFields();
  const parts = (c) => { const ft = freightTotalOf(c); return { ft, sur: ft - n(c.freight), fees: costTotal(c) - ft }; };
  const picked = list.filter((t) => !off[t.id]);
  // Mỗi khoản phí / chi hộ có số là 1 cột riêng
  const feeCols = costFields.filter((x) => ['fee', 'chiho'].includes(x.group) && list.some((t) => n(costOf(t)?.[x.key])));
  const feeSum = (k) => picked.reduce((s, t) => s + n(costOf(t)?.[k]), 0);
  const sum = picked.reduce((s, t) => { const c = costOf(t) || {}; const x = parts(c); return { kg: s.kg + tripKg(t), freight: s.freight + n(c.freight), sur: s.sur + x.sur, ft: s.ft + x.ft, fees: s.fees + x.fees, total: s.total + costTotal(c) }; },
    { kg: 0, freight: 0, sur: 0, ft: 0, fees: 0, total: 0 });
  const missing = picked.filter((t) => !costOf(t)).length;
  const partyName = is3 ? (priv[list[0]?.id]?.threeplName || threepl.find((x) => x.code === party)?.name || party) : (carriers.find((c) => c.code === party)?.name || party);
  // Thông tin xuất hóa đơn: "Cước vận chuyển hạt nhựa từ <nơi nhận> đến <nơi giao>" (theo danh mục kho, vị trí, khách hàng)
  const invCats = { pickupPoints: useCollection('pickupPoints').rows, soldto: useCollection('soldto').rows, shipto: useCollection('shipto').rows,
    warehouses: useCollection('warehouses').rows, locations: useCollection('locations').rows };
  const inv = (t) => tripInvoice(t, invCats);
  const route = (t) => `${t.pickupName || t.warehouse} → ${[...new Set(t.lines.map((l) => l.partyName || l.partyCode))].join(', ')}`;
  const title = `BẢNG KÊ CƯỚC VẬN CHUYỂN${is3 ? ' 3PL' : ''}`;
  const sub = `${is3 ? '3PL' : 'Đơn vị vận tải'}: ${party ? `${party} – ${partyName}` : 'tất cả'}${f.company ? ` · Công ty: ${f.company}` : ''} · Từ ${fmtDate(open?.from || f.from)} đến ${fmtDate(open?.to || f.to)}`;

  const print = () => {
    const w = window.open('', '_blank');
    if (!w) return setErr('Trình duyệt chặn cửa sổ in. Cho phép pop-up rồi bấm lại.');
    const rows = picked.map((t, i) => { const c = costOf(t) || {}; return `<tr><td>${i + 1}</td><td>${esc(fmtDate(t.plannedDate))}</td><td>${esc(t.id)}</td><td>${esc(t.plate)}</td><td>${esc(t.driverName)}</td><td>${esc(route(t))}</td><td>${esc(inv(t).text)}</td>
      <td>${esc(t.lines.map((l) => l.item).join(', '))}</td><td class="n">${t3(tripKg(t))}</td><td class="n">${vnd(c.freight)}</td><td class="n">${vnd(parts(c).sur)}</td><td class="n">${vnd(parts(c).ft)}</td>${feeCols.map((x) => `<td class="n">${vnd(c[x.key])}</td>`).join('')}<td class="n"><b>${vnd(costTotal(c))}</b></td></tr>`; }).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Arial,sans-serif;font-size:12px;margin:16px}h2{text-align:center;margin:0}p{text-align:center;margin:4px 0 12px}
      table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:4px}th{background:#eee}.n{text-align:right}.sign{display:flex;justify-content:space-around;margin-top:30px;text-align:center}@page{size:A4 landscape;margin:10mm}</style></head><body>
      <h2>${esc(title)}</h2><p>${esc(sub)}${open ? ` · Số: ${esc(open.id)}` : ''}</p>
      <table><thead><tr><th>#</th><th>Ngày</th><th>Chuyến</th><th>Số xe</th><th>Tài xế</th><th>Tuyến</th><th>Thông tin xuất hóa đơn</th><th>Hàng</th><th>Tấn</th><th>Cước</th><th>Dầu + phụ thu</th><th>Tổng cước VC</th>${feeCols.map((x) => `<th>${esc(x.label)}</th>`).join('')}<th>Thành tiền</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><th colspan="8">Cộng ${picked.length} chuyến</th><th class="n">${t3(sum.kg)}</th><th class="n">${vnd(sum.freight)}</th><th class="n">${vnd(sum.sur)}</th><th class="n">${vnd(sum.ft)}</th>${feeCols.map((x) => `<th class="n">${vnd(feeSum(x.key))}</th>`).join('')}<th class="n">${vnd(sum.total)}</th></tr></tfoot></table>
      <div class="sign"><div><b>${is3 ? 'GHA' : 'Bên thuê vận chuyển'}</b><br/><i>(ký, ghi rõ họ tên)</i></div><div><b>${is3 ? '3PL' : 'Đơn vị vận tải'}</b><br/><i>(ký, ghi rõ họ tên)</i></div></div>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  };
  const excel = () => exportSheets(`Bang_ke_${is3 ? '3PL' : 'van_tai'}_${party || 'all'}_${f.from}_${f.to}`, {
    'Bảng kê': picked.map((t, i) => { const c = costOf(t) || {}; return { '#': i + 1, 'Ngày': t.plannedDate, 'Chuyến': t.id, 'Số xe': t.plate || '', 'Tài xế': t.driverName || '', 'Tuyến': route(t), 'Thông tin xuất hóa đơn': inv(t).text,
      'Hàng': t.lines.map((l) => l.item).join(', '), 'Đơn': (t.orderIds || []).join(', '), 'Công ty': t.company || '', 'Tấn': +(tripKg(t) / 1000).toFixed(3),
      'Điểm nhận': t.pickupName || t.warehouseName || t.warehouse, 'Cước': n(c.freight), '% hỗ trợ dầu': n(c.fuelPct), 'Dầu + phụ thu': parts(c).sur, 'Tổng cước vận chuyển': parts(c).ft,
      ...Object.fromEntries(costFields.filter((x) => !['base', 'pct'].includes(x.group) && list.some((y) => n(costOf(y)?.[x.key]))).map((x) => [x.label, n(c[x.key])])), 'Thành tiền': costTotal(c), 'Ghi chú': c.note || '' }; }),
  });
  const save = async () => {
    setErr(''); setMsg('');
    if (!party) return setErr(`Chọn ${is3 ? '3PL' : 'đơn vị vận tải'} trước khi lưu bảng kê.`);
    if (!picked.length) return setErr('Chưa chọn chuyến nào.');
    const id = `BK${Date.now().toString(36).toUpperCase()}`;
    try {
      await setDoc(doc(db, 'statements', id), { id, kind: f.mode, party, partyName, carrier: is3 ? (priv[picked[0].id]?.carrier || myCarrier || picked[0].carrier) : party, company: f.company,
        from: f.from, to: f.to, tripIds: picked.map((t) => t.id), count: picked.length, kg: sum.kg, total: sum.total, status: 'draft', createdAt: nowISO(), createdBy: email, createdByName: name });
      setMsg(`Đã lưu bảng kê ${id}. ${is3 ? '3PL' : 'Đơn vị vận tải'} mở tab Bảng kê để đối chiếu và xác nhận.`);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền lưu bảng kê.' : e.message); }
  };
  const confirm = async (b) => {
    try { await updateDoc(doc(db, 'statements', b.id), { status: 'confirmed', confirmedAt: nowISO(), confirmedBy: email, confirmedByName: name, total: sum.total, count: picked.length }); setOpen({ ...b, status: 'confirmed' }); }
    catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền xác nhận.' : e.message); }
  };
  const canEditCost = isAdmin || hasRole('ke_toan') || isCarrier || isTpl;

  return (
    <div>
      <div className="filters">
        {modes.length > 1 && <Select value={f.mode} onChange={(e) => set('mode', e.target.value)}>{modes.map(([k, l]) => <option key={k} value={k}>Bảng kê {l}</option>)}</Select>}
        {!fixedParty && (is3
          ? <Select value={f.party} onChange={(e) => set('party', e.target.value)}><option value="">-- Chọn 3PL --</option>{threepl.map((x) => <option key={x.code} value={x.code}>{x.code} – {x.name}</option>)}</Select>
          : <Select value={f.party} onChange={(e) => set('party', e.target.value)}><option value="">-- Chọn đơn vị vận tải --</option>{carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}</Select>)}
        {!is3 && <Select value={f.company} onChange={(e) => set('company', e.target.value)} title="Cước của từng công ty (VAP, PLA, DAM…)"><option value="">Mọi công ty</option>{companies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select>}
        {!open && <input type="search" placeholder="Tìm chuyến, số xe, tài xế, tuyến…" value={q} onChange={(e) => setQ(e.target.value)} />}
        <label>Từ <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
        <label>Đến <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
        <button className="btn" onClick={print} disabled={!picked.length}>🖨 In bảng kê</button>
        <button className="btn" onClick={excel} disabled={!picked.length}>⬇ Excel</button>
        {!open && !isTpl && <button className="btn primary" onClick={save} disabled={!picked.length}>💾 Lưu bảng kê</button>}
      </div>
      <p className="small">Bỏ tích các chuyến không muốn đưa vào bảng kê; tiền cộng theo các chuyến còn tích. {canEditCost ? `Nhập / sửa cước ở tab Chuyến xe → 💰 ${is3 ? 'Cước 3PL' : 'Chi phí'}.` : ''}</p>
      {open && <div className="ok-box" style={{ marginBottom: 10 }}>Đang xem bảng kê đã lưu <b>{open.id}</b> ({BK_STATUS[open.status]?.[0]}) · {open.count} chuyến · lập bởi {open.createdByName || open.createdBy}.
        {' '}<button className="btn sm" onClick={() => { setOpen(null); setOff({}); }}>Đóng, quay về chọn chuyến</button>
        {open.status !== 'confirmed' && <> <button className="btn primary sm" onClick={() => confirm(open)}>✓ Xác nhận bảng kê</button></>}</div>}
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <ErrorBox error={err} />
      <div className="table-wrap">
        {!list.length ? <Empty text="Không có chuyến hoàn thành nào khớp bộ lọc." /> : (
          <table>
            <thead><tr><th><input type="checkbox" checked={!picked.length ? false : picked.length === list.length} onChange={(e) => setOff(e.target.checked ? {} : Object.fromEntries(list.map((t) => [t.id, true])))} /></th>
              <th>Ngày</th><th>Chuyến</th><th>Số xe · tài xế</th><th>Tuyến</th><th>Thông tin xuất hóa đơn</th>{!is3 && <th>Công ty</th>}<th className="num">Tấn</th><th className="num">Cước</th><th className="num">Dầu + phụ thu</th><th className="num">Tổng cước VC</th>{feeCols.map((x) => <th key={x.key} className="num">{x.label}</th>)}<th className="num">Thành tiền</th></tr></thead>
            <tbody>{list.map((t) => { const c = costOf(t); return (
              <tr key={t.id} className={off[t.id] ? '' : 'picked'} style={off[t.id] ? { opacity: 0.45 } : undefined}>
                <td><input type="checkbox" checked={!off[t.id]} onChange={() => setOff((m) => ({ ...m, [t.id]: !m[t.id] }))} /></td>
                <td className="nowrap">{fmtDate(t.plannedDate)}</td><td className="mono">{t.id}</td><td>{t.plate}<div className="small">{t.driverName}</div></td><td className="small">{route(t)}</td><td className="small" style={{ minWidth: 220 }}>{inv(t).text}{inv(t).missing.length ? <div style={{ color: 'var(--amber)' }} title="Điền Thông tin xuất hóa đơn ở Danh mục kho / vị trí (tích Cần thông tin xuất hóa đơn) / khách hàng">⚠ chưa có thông tin xuất hóa đơn {inv(t).missing.join(', ')}</div> : null}</td>{!is3 && <td>{t.company}</td>}
                <td className="num">{t3(tripKg(t))}</td>
                {c ? <><td className="num">{vnd(c.freight)}</td><td className="num">{vnd(parts(c).sur)}</td><td className="num">{vnd(parts(c).ft)}</td>{feeCols.map((x) => <td key={x.key} className="num">{vnd(c[x.key])}</td>)}<td className="num"><b>{vnd(costTotal(c))}</b></td></>
                  : <td colSpan={4 + feeCols.length} className="small" style={{ color: 'var(--amber)' }}>chưa nhập cước</td>}
              </tr>); })}</tbody>
            <tfoot><tr><td colSpan={is3 ? 6 : 7}><b>Cộng {picked.length}/{list.length} chuyến đã chọn</b>{missing ? <span className="small" style={{ color: 'var(--amber)' }}> · {missing} chuyến chưa nhập cước</span> : null}</td>
              <td className="num"><b>{t3(sum.kg)}</b></td><td className="num">{vnd(sum.freight)}</td><td className="num">{vnd(sum.sur)}</td><td className="num">{vnd(sum.ft)}</td>{feeCols.map((x) => <td key={x.key} className="num">{vnd(feeSum(x.key))}</td>)}<td className="num"><b>{vnd(sum.total)}</b></td></tr></tfoot>
          </table>
        )}
      </div>
      <div className="section-head" style={{ marginTop: 16 }}>Bảng kê đã lưu</div>
      {!saved.length ? <Empty text="Chưa có bảng kê nào." /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Số</th><th>{f.mode === '3pl' ? '3PL' : 'Đơn vị vận tải'}</th><th>Công ty</th><th>Kỳ</th><th className="num">Chuyến</th><th className="num">Tổng tiền</th><th>Trạng thái</th><th></th></tr></thead>
          <tbody>{saved.map((b) => <tr key={b.id}><td className="mono">{b.id}</td><td>{b.party} – {b.partyName}</td><td>{b.company}</td><td className="nowrap">{fmtDate(b.from)} – {fmtDate(b.to)}</td>
            <td className="num">{b.count}</td><td className="num"><b>{vnd(b.total)}</b></td><td><span className={'badge ' + (BK_STATUS[b.status]?.[1] || '')}>{BK_STATUS[b.status]?.[0]}</span>{b.confirmedByName ? <div className="small">{b.confirmedByName}</div> : null}</td>
            <td><button className="btn sm" onClick={() => { setOpen(b); setOff({}); }}>Mở</button></td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}
