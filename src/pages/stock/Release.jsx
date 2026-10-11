import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, getDoc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpCompany, useStock } from '../../lib/hooks';
import { postWaitingOut } from '../../lib/stock';
import { createRelease, createReleaseFromSlips, editRelease, groupLines, postRelease, releaseStatusOf, releaseStatusOfWh } from '../../lib/release';
import { usePendingRelease, useShortfall } from '../../lib/shortfall';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, today } from '../../lib/utils';
import { CompanyPicker } from '../../components/TripBits';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { loadReleaseData } from '../../lib/printData';
import { pageToPdf, savePdf } from '../../lib/pdf';
import { TemplatePage, useTemplateChoice } from '../../components/PrintTemplate';

// ============================================================================
// Đề nghị giải chấp: kế toán chọn hàng HTC (1 công ty, 1 ngân hàng, 1 kho), in đề nghị
// gửi ngân hàng theo mẫu (PDF, ký số). Lưu đề nghị là đổi ngay: hệ thống lập phiếu đổi
// tình trạng (TC) HTC → DGC cho đúng các dòng tồn trong đề nghị.
// Số đề nghị: HSGC + yymmdd + số thứ tự trong ngày (vd. HSGC26070210).
// ============================================================================

export const RELEASE_STATUS = {
  sent: { label: 'Chưa đổi DGC', cls: 'amber' },
  released: { label: 'Đã giải chấp', cls: 'green' },
  cancelled: { label: 'Đã hủy', cls: '' },
};
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;
export { groupLines, releaseStatusOf, releaseStatusOfWh };
// Màn hình dùng kg (đơn vị chính); bản in gửi ngân hàng theo mẫu ĐVT TẤN, luôn 3 số lẻ: 25 tấn → 25.000
const ton3 = (kg) => fmtNum(num(kg), 2);
const tonPrint = (kg) => fmtNum(num(kg) / 1000, 3, 3);
const totKg = (r) => (r.lines || []).reduce((s, l) => s + num(l.kg), 0);

// Danh sách đề nghị giải chấp
export default function Release() {
  const { hasRole, inMyWarehouses, email, name } = useApp();
  const [co, setCo] = useOpCompany();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [st, setSt] = useState('');
  const [form, setForm] = useState(false); // false | true | { preset }
  const [msg, setMsg] = useState('');
  const [sp, setSp] = useSearchParams();
  const tab = ['thieu', 'de-nghi'].includes(sp.get('tab')) ? sp.get('tab') : 'cho';
  const [busy, setBusy] = useState('');
  const canEdit = hasRole('ke_toan');
  // Sửa số lượng / số CT, đánh dấu đã gửi ngân hàng: kế toán và thủ kho
  const canFix = hasRole('ke_toan', 'thu_kho');
  const [edit, setEdit] = useState(null);

  // Phiếu xuất có hàng HTC đang chờ lập lệnh giải chấp
  const [waitAll, setWaitAll] = useState([]);
  useEffect(() => onSnapshot(query(collection(db, 'movements'), where('status', '==', 'wait_release')),
    (s) => setWaitAll(s.docs.map((d) => d.data())), () => {}), []);
  const waiting = waitAll.filter((m) => inMyWarehouses(m.warehouse));
  const waitN = waiting.length;
  useEffect(() => onSnapshot(collection(db, 'releaseRequests'),
    (s) => setRows(s.docs.map((d) => d.data())), (e) => setError(e.message)), []);
  const list = rows.filter((r) => inMyWarehouses(r.warehouse) && (!co || r.company === co) && (!st || r.status === st))
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));

  const release = async (r) => {
    if (!window.confirm(`Đổi ${ton3(totKg(r))} kg trong ${r.id} từ HTC sang ${await releaseStatusOf(r.warehouse)}?`)) return;
    setBusy(r.id); setMsg('');
    try {
      const { mid, to } = await postRelease(r, { email, name });
      setMsg(`Đã đổi ${r.id}: phiếu ${mid} chuyển ${ton3(totKg(r))} kg sang ${to}.`);
    } catch (e) {
      setMsg('Lỗi: ' + (e.code === 'permission-denied' ? 'Bạn không có quyền giải chấp hàng ở kho này.' : e.message));
    }
    setBusy('');
  };
  const cancel = async (r) => {
    const why = window.prompt(`Lý do hủy đề nghị ${r.id}?`);
    if (!why) return;
    const at = new Date().toISOString();
    await updateDoc(doc(db, 'releaseRequests', r.id), {
      status: 'cancelled', cancelReason: why, history: [...(r.history || []), { at, by: email, byName: name, action: `Hủy: ${why}` }],
    }).catch((e) => setMsg('Lỗi: ' + e.message));
  };
  // Đã in PDF, ký số, gửi email ngân hàng: đề nghị tự lập sau đó sẽ sang số mới
  const markSent = async (r) => {
    const at = new Date().toISOString();
    const on = !r.bankSentAt;
    await updateDoc(doc(db, 'releaseRequests', r.id), {
      bankSentAt: on ? at : null, bankSentBy: on ? email : null,
      history: [...(r.history || []), { at, by: email, byName: name, action: on ? 'Đánh dấu đã gửi ngân hàng' : 'Bỏ đánh dấu đã gửi ngân hàng' }],
    }).catch((e) => setMsg('Lỗi: ' + e.message));
  };

  const exportExcel = () => exportSheets(`De_nghi_giai_chap_${today()}`, {
    'Đề nghị giải chấp': list.flatMap((r) => groupLines(r.lines).map((l, i) => ({
      'Số đề nghị': r.id, Ngày: r.date, 'Công ty': r.company, 'Ngân hàng': r.pledgee, Kho: r.warehouse, 'Trạng thái': RELEASE_STATUS[r.status]?.label,
      STT: i + 1, 'Số CT (BCT)': l.docNo, 'Đơn bán': (l.orders || []).join(', '), 'Mã hàng': l.item, 'Tên hàng': l.itemName, 'Vị trí hàng hóa': l.place,
      'Số lượng (kg)': num(l.kg), 'Đổi sang': r.toStatus || (r.status === 'released' ? 'DGC' : ''), 'Phiếu giải chấp': r.movementId || '',
    }))),
    'Chi tiết theo lot': list.flatMap((r) => r.lines.map((l) => ({
      'Số đề nghị': r.id, Kho: r.warehouse, 'Mã hàng': l.item, Lot: l.lot, 'Vị trí': l.location, 'Số lượng (kg)': num(l.kg),
    }))),
  });

  return (
    <div>
      <div className="page-head">
        <h1>🔓 Đề nghị giải chấp</h1>
        <div className="actions">
          {canEdit && <button className="btn primary" onClick={() => setForm(true)}>+ Lập đề nghị giải chấp</button>}
          <button className="btn" onClick={exportExcel}>⬇ Excel</button>
        </div>
      </div>
      <div className="seg wrap" style={{ marginBottom: 10 }}>
        <button type="button" className={tab === 'cho' ? 'on' : ''} onClick={() => setSp({})}>⏳ Chờ giải chấp{waitN ? ` (${waitN})` : ''}</button>
        <button type="button" className={tab === 'de-nghi' ? 'on' : ''} onClick={() => setSp({ tab: 'de-nghi' })}>Đề nghị giải chấp</button>
        <button type="button" className={tab === 'thieu' ? 'on' : ''} onClick={() => setSp({ tab: 'thieu' })}>⚠ Hàng thiếu cho đơn bán</button>
      </div>
      {msg && <div className={msg.startsWith('Lỗi') ? 'error-box' : 'ok-box'}>{msg}</div>}
      {tab === 'cho' ? <Waiting co={co} setCo={setCo} canEdit={canFix} slips={waiting} onDone={(m) => { setMsg(m); }} />
        : tab === 'thieu' ? <Shortfall co={co} setCo={setCo} canEdit={canEdit} onPlan={(preset) => setForm({ preset })} /> : <>
      <p className="hint">
        Phiếu xuất bán lấy hàng HTC sẽ <b>tự đưa vào đề nghị</b> (gộp theo ngày, công ty, ngân hàng, kho; nhãn <i>Tự lập</i>) và đổi tình trạng ngay.
        Lập tay từ hàng đang thế chấp (HTC): khi lưu, hệ thống <b>đổi ngay</b> các dòng hàng trong đề nghị sang tình trạng đặt ở <i>Danh sách kho → TTHH khi giải chấp</i> (mặc định: cảng → <b>KTC</b>, kho → <b>DGC</b>) bằng phiếu TC,
        xuất kho được luôn. Bấm <b>🖨 In</b> (tổng hợp theo mã hàng mọi đơn) → Lưu PDF, chèn chữ ký số, gửi email ngân hàng rồi bấm <b>📧 Đã gửi</b>.
        Bấm <b>✏️ Sửa</b> để nhập số CT hoặc tăng số lượng giải chấp (lấy thêm HTC nhập trước).
      </p>
      <div className="toolbar">
        <CompanyPicker value={co} onChange={setCo} />
        <select value={st} onChange={(e) => setSt(e.target.value)}>
          <option value="">Tất cả trạng thái</option>
          {Object.entries(RELEASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {!list.length ? <Empty /> : (
          <table>
            <thead><tr><th>Số đề nghị</th><th>Ngày</th><th>Công ty</th><th>Ngân hàng</th><th>Kho</th><th>Mặt hàng</th>
              <th className="num">Số lượng (kg)</th><th>Trạng thái</th><th>Đơn bán</th><th>Phiếu TC</th><th></th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="mono nowrap">{r.id}{r.auto ? <div><span className="badge">Tự lập</span></div> : null}</td><td className="nowrap">{fmtDate(r.date)}</td><td>{r.company}</td><td>{r.pledgee}</td><td>{(r.warehouses || [r.warehouse]).join(', ')}</td>
                  <td>{[...new Set(r.lines.map((l) => l.item))].join(', ')}</td><td className="num">{ton3(totKg(r))}</td>
                  <td><span className={'badge ' + (RELEASE_STATUS[r.status]?.cls || '')}>{RELEASE_STATUS[r.status]?.label}</span>{r.cancelReason ? <span className="small"> {r.cancelReason}</span> : null}
                    {r.bankSentAt ? <div className="small">📧 đã gửi NH {fmtDate(r.bankSentAt.slice(0, 10))}</div> : null}</td>
                  <td className="small">{[...new Set(r.lines.map((l) => l.orderId).filter(Boolean))].join(', ')}</td>
                  <td className="mono">{(r.movementIds || [r.movementId].filter(Boolean)).map((m, i) => <span key={m}>{i ? ', ' : ''}<Link to={`/kho/phieu/${m}/in`}>{m}</Link></span>)}</td>
                  <td className="nowrap">
                    <Link className="btn sm" to={`/kho/giai-chap/${r.id}/in`}>🖨 In</Link>{' '}
                    {canEdit && r.status === 'sent' && <>
                      <button className="btn sm primary" disabled={!!busy} onClick={() => release(r)}>{busy === r.id ? 'Đang ghi…' : '✅ Đổi DGC'}</button>{' '}
                      <button className="btn sm" onClick={() => cancel(r)}>Hủy</button>
                    </>}
                    {canFix && r.status === 'released' && <>
                      <button className="btn sm" onClick={() => setEdit(r)}>✏️ Sửa</button>{' '}
                      <button className="btn sm" title="Đã lưu PDF, ký số và gửi email ngân hàng" onClick={() => markSent(r)}>{r.bankSentAt ? '↩ Chưa gửi' : '📧 Đã gửi'}</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </>}
      {edit && <EditRelease r={edit} onClose={(m) => { setEdit(null); if (m) setMsg(m); }} />}
      {form && <ReleaseForm preset={form.preset} onClose={(id, m) => { setForm(false); if (id) { setSp({ tab: 'de-nghi' }); setSt(''); setMsg(m || `Đã lập đề nghị ${id}.`); } }} />}
    </div>
  );
}

// Chờ giải chấp: phiếu xuất bán có hàng HTC (đã in, soạn hàng; chưa trừ tồn). Nhân viên chọn công ty, tick mã hàng
// (tất cả hoặc từng mã) → Tạo lệnh giải chấp: gộp mọi đơn thành 1 đề nghị cho mỗi ngân hàng, đổi HTC → DGC ngay,
// ghi xuất kho các phiếu đã hết HTC, rồi mở bản PDF của đề nghị để ký số, gửi ngân hàng
function Waiting({ co, setCo, canEdit, slips, onDone }) {
  const { email, name } = useApp();
  const myWh = useMyWarehouses();
  const pledgees = useCollection('pledgees').rows;
  const bankName = (c) => pledgees.find((p) => p.code === c)?.shortName || c || '(chưa ghi ngân hàng)';
  const [tick, setTick] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const mine = slips.filter((m) => !co || (m.company || '') === co || m.lines.some((l) => l.goodsStatus === 'HTC' && l.company === co))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rows = useMemo(() => {
    const g = new Map();
    for (const m of mine) {
      for (const l of m.lines) {
        if (l.goodsStatus !== 'HTC') continue;
        const c = l.company || m.company || '';
        if (co && c !== co) continue;
        const key = `${l.pledgee || ''}|${l.item}`;
        const k = `${c}|${key}`;
        if (!g.has(k)) g.set(k, { k, key, company: c, pledgee: l.pledgee || '', item: l.item, itemName: l.itemName || '', kg: 0, whs: new Set(), slips: new Set(), orders: new Set() });
        const x = g.get(k);
        x.kg += Math.abs(num(l.kg)); x.whs.add(m.warehouse); x.slips.add(m.id); if (m.orderId) x.orders.add(m.orderId);
      }
    }
    return [...g.values()].sort((a, b) => a.company.localeCompare(b.company) || a.pledgee.localeCompare(b.pledgee) || a.item.localeCompare(b.item));
  }, [mine, co]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = rows.length > 0 && rows.every((r) => tick.has(r.key));
  const toggle = (k) => setTick((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const chosen = rows.filter((r) => tick.has(r.key));
  const total = chosen.reduce((s, r) => s + r.kg, 0);
  // Phiếu đã giải chấp hết HTC nhưng ghi xuất kho bị lỗi (vd. thiếu tồn KTC): sửa xong bấm ghi lại
  const stuck = mine.filter((m) => !m.lines.some((l) => l.goodsStatus === 'HTC'));
  const retry = async (m) => {
    setBusy(true);
    try {
      await postWaitingOut(m.id, { email, name });
      onDone(`Đã ghi xuất kho phiếu ${m.id}.`);
    } catch (e) {
      onDone(`Lỗi: ${m.id}: ${e.message}`);
    }
    setBusy(false);
  };

  const create = async () => {
    if (!co) return onDone('Lỗi: chọn công ty (bên thế chấp) trước khi tạo lệnh giải chấp.');
    if (!chosen.length) return onDone('Lỗi: tick ít nhất 1 mã hàng.');
    const banks = [...new Set(chosen.map((r) => r.pledgee))];
    if (!window.confirm(`Tạo lệnh giải chấp ${co}: ${chosen.length} mã hàng, ${ton3(total)} kg${banks.length > 1 ? ` (${banks.length} ngân hàng → ${banks.length} đề nghị)` : ''}.\nHàng đổi sang DGC ngay và các phiếu xuất đủ điều kiện được ghi xuất kho. Tiếp tục?`)) return;
    // Mở sẵn tab (trình duyệt chặn cửa sổ mở sau khi chờ) để hiện file PDF đề nghị
    const win = window.open('', '_blank');
    setBusy(true);
    try {
      const res = await createReleaseFromSlips({ company: co, date: today(), slips: mine, items: new Set(chosen.map((r) => r.key)),
        whNames: Object.fromEntries(myWh.map((w) => [w.code, w.name])) }, { email, name });
      if (win) win.location.href = `/kho/giai-chap/${res.ids[0]}/in?pdf=1`;
      setTick(new Set());
      onDone(`${res.errors.length ? 'Lỗi: ' : ''}Đã lập lệnh giải chấp ${res.ids.join(', ')} (đã đổi DGC). ${res.posted.length ? `Đã ghi xuất kho phiếu ${res.posted.join(', ')}.` : ''}`
        + `${res.waiting.length ? ` Phiếu ${res.waiting.join(', ')} còn mã HTC chưa giải chấp.` : ''}${res.errors.length ? ` Chưa ghi được: ${res.errors.join('; ')}` : ''}`
        + `${res.ids.length > 1 ? ` Bấm 🖨 In ở tab Đề nghị giải chấp để lưu PDF các đề nghị còn lại.` : ''}`);
    } catch (e) {
      if (win) win.close();
      onDone('Lỗi: ' + (e.code === 'permission-denied' ? 'Bạn không có quyền giải chấp hàng ở kho này.' : e.message));
    }
    setBusy(false);
  };

  return (
    <div>
      <p className="hint">
        Phiếu xuất bán lấy hàng <b>HTC</b> được lưu ở trạng thái <b>Chờ giải chấp</b>: in phiếu, soạn hàng được nhưng chưa trừ tồn.
        Chọn <b>công ty</b>, tick mã hàng (hoặc <i>Tất cả</i>) rồi bấm <b>Tạo lệnh giải chấp</b>: hệ thống gộp mọi đơn thành 1 đề nghị cho mỗi ngân hàng,
        đổi sang DGC ngay, ghi xuất kho các phiếu, rồi mở file PDF đề nghị (tổng hợp theo mã hàng) để ký số và gửi email ngân hàng.
      </p>
      <div className="toolbar">
        <CompanyPicker value={co} onChange={(v) => { setCo(v); setTick(new Set()); }} />
        <span className="small">{rows.length ? <>{mine.length} phiếu chờ · đã tick <b>{chosen.length}</b> mã · <b>{ton3(total)} kg</b> (= {fmtNum(total / 1000, 3)} tấn)</> : ''}</span>
        {canEdit && <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={busy || !co || !chosen.length} onClick={create}
          title={!co ? 'Chọn công ty trước' : ''}>{busy ? 'Đang tạo…' : '🔓 Tạo lệnh giải chấp'}</button>}
      </div>
      {!co && rows.length > 0 && <div className="hint" style={{ color: 'var(--amber)' }}>Chọn công ty để tạo lệnh giải chấp (mỗi lệnh thuộc 1 công ty).</div>}
      <div className="table-wrap">
        {!rows.length ? <Empty text="Không có phiếu xuất nào chờ giải chấp." /> : (
          <table>
            <thead><tr><th><label className="nowrap"><input type="checkbox" checked={all} onChange={(e) => setTick(e.target.checked ? new Set(rows.map((r) => r.key)) : new Set())} /> Tất cả</label></th>
              <th>Công ty</th><th>Ngân hàng</th><th>Mã hàng</th><th>Tên hàng</th><th>Kho</th><th>Đơn bán</th><th>Phiếu xuất</th><th className="num">HTC cần giải chấp (kg)</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.k} className={tick.has(r.key) ? 'picked' : ''} onClick={() => toggle(r.key)} style={{ cursor: 'pointer' }}>
                  <td><input type="checkbox" checked={tick.has(r.key)} onChange={() => toggle(r.key)} onClick={(e) => e.stopPropagation()} /></td>
                  <td>{r.company}</td><td>{bankName(r.pledgee)}</td><td className="nowrap"><b>{r.item}</b></td><td>{r.itemName}</td>
                  <td>{[...r.whs].join(', ')}</td><td className="small">{[...r.orders].join(', ')}</td>
                  <td className="small mono">{[...r.slips].map((id, i) => <span key={id}>{i ? ', ' : ''}<Link to={`/kho/phieu/${id}/in`} target="_blank" onClick={(e) => e.stopPropagation()}>{id}</Link></span>)}</td>
                  <td className="num"><b>{ton3(r.kg)}</b></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={8}><b>Tổng</b></td><td className="num"><b>{ton3(rows.reduce((s, r) => s + r.kg, 0))}</b></td></tr></tfoot>
          </table>
        )}
      </div>
      {!!stuck.length && <>
        <h3 style={{ margin: '16px 0 6px' }}>Đã giải chấp, chưa ghi được xuất kho</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Phiếu xuất</th><th>Kho</th><th>Đơn bán</th><th>Khách hàng</th><th className="num">Số lượng (kg)</th><th>Đề nghị</th><th></th></tr></thead>
            <tbody>
              {stuck.map((m) => (
                <tr key={m.id}>
                  <td className="mono"><Link to={`/kho/phieu/${m.id}/in`} target="_blank">{m.id}</Link></td><td>{m.warehouse}</td><td>{m.orderId}</td><td>{m.partyName}</td>
                  <td className="num">{ton3(m.lines.reduce((s, l) => s + Math.abs(num(l.kg)), 0))}</td><td className="small">{(m.releaseIds || []).join(', ')}</td>
                  <td>{canEdit && <button className="btn sm primary" disabled={busy} onClick={() => retry(m)}>Ghi xuất kho</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">Thường do hàng KTC/DGC trong phiếu đã bị phiếu khác xuất trước. Admin hủy phiếu rồi lập lại, hoặc bổ sung tồn rồi bấm Ghi xuất kho.</p>
      </>}
    </div>
  );
}

// Hàng thiếu cho đơn bán: SO còn phải giao > tồn KTC + DGC → tổng hợp phần thiếu theo công ty, kho, mã hàng
// và gợi ý đề nghị giải chấp (gom theo công ty + kho + ngân hàng) từ hàng HTC nhập trước
function Shortfall({ co, setCo, canEdit, onPlan }) {
  const { inMyWarehouses } = useApp();
  const { rows: all, loading } = useShortfall('');
  const pledgees = useCollection('pledgees').rows;
  const bankName = (c) => pledgees.find((p) => p.code === c)?.shortName || c || '(chưa ghi ngân hàng)';
  const rows = all.filter((r) => (!r.warehouse || inMyWarehouses(r.warehouse)) && (!co || r.company === co));
  const groups = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      for (const p of r.plan) {
        const k = `${r.company}|${r.warehouse}|${p.pledgee}`;
        if (!m.has(k)) m.set(k, { company: r.company, warehouse: r.warehouse, pledgee: p.pledgee, kg: 0, picks: {}, items: new Map() });
        const g = m.get(k);
        g.kg += p.kg; g.picks[p.stockId] = (g.picks[p.stockId] || 0) + p.kg;
        g.items.set(r.item, (g.items.get(r.item) || 0) + p.kg);
      }
    }
    return [...m.values()];
  }, [rows]);
  const tot = (k) => rows.reduce((s, r) => s + r[k], 0);

  const exportExcel = () => exportSheets(`Hang_thieu_don_ban_${today()}`, {
    'Hàng thiếu': rows.map((r) => ({
      'Công ty': r.company, Kho: r.warehouse || '(chưa ghi kho)', 'Mã hàng': r.item, 'Tên hàng': r.itemName,
      'SO còn phải giao (kg)': r.so, 'Tồn KTC + DGC (kg)': r.usable, 'Thiếu (kg)': r.short,
      'Tồn HTC (kg)': r.htc, 'Đang đề nghị giải chấp (kg)': r.held, 'Còn cần giải chấp (kg)': r.need,
      'HTC không đủ bù (kg)': r.uncovered, 'Đơn bán': r.orders.join(', '),
    })),
  });

  return (
    <div>
      <p className="hint">
        Đơn bán chỉ xuất được hàng <b>KTC</b> và <b>DGC</b>. Khi SO còn phải giao nhiều hơn tồn KTC + DGC (cùng công ty, cùng kho, cùng mã hàng),
        phần <b>thiếu</b> được tổng hợp ở đây. <b>Còn cần giải chấp</b> = thiếu − phần nằm trong đề nghị chưa đổi DGC. Lập đề nghị là hàng chuyển DGC ngay, dòng thiếu tự mất.
        Bấm <b>Lập đề nghị</b> ở phần gợi ý để tích sẵn hàng HTC (nhập trước giải chấp trước) đủ bù phần thiếu.
      </p>
      <div className="toolbar">
        <CompanyPicker value={co} onChange={setCo} />
        <span className="small">{rows.length ? <b style={{ color: 'var(--red)' }}>{rows.length} mã hàng thiếu · {ton3(tot('short'))} kg · còn cần giải chấp {ton3(tot('need'))} kg</b> : ''}</span>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={exportExcel}>⬇ Excel</button>
      </div>
      <div className="table-wrap">
        {loading ? <Empty text="Đang tải…" /> : !rows.length ? <Empty text="Không đơn bán nào thiếu hàng KTC + DGC." /> : (
          <table>
            <thead><tr><th>Công ty</th><th>Kho</th><th>Mã hàng</th><th>Tên hàng</th><th className="num">SO còn giao</th><th className="num">Tồn KTC + DGC</th>
              <th className="num">Thiếu</th><th className="num">Tồn HTC</th><th className="num">Đang đề nghị</th><th className="num">Còn cần giải chấp</th><th>Đơn bán</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.company}</td><td>{r.warehouse || <span className="small">(chưa ghi kho)</span>}</td><td className="nowrap">{r.item}</td><td>{r.itemName}</td>
                  <td className="num">{ton3(r.so)}</td><td className="num">{ton3(r.usable)}</td>
                  <td className="num" style={{ color: 'var(--red)', fontWeight: 700 }}>{ton3(r.short)}</td>
                  <td className="num">{r.htc ? ton3(r.htc) : ''}</td><td className="num small">{r.held ? ton3(r.held) : ''}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{r.need ? ton3(r.need) : '✓'}{r.uncovered > 0.001 ? <div className="small" style={{ color: 'var(--amber)' }}>HTC thiếu {ton3(r.uncovered)}</div> : null}</td>
                  <td className="small">{r.orders.join(', ')}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4}><b>Tổng</b></td><td className="num">{ton3(tot('so'))}</td><td className="num">{ton3(tot('usable'))}</td><td className="num"><b>{ton3(tot('short'))}</b></td>
              <td className="num">{ton3(tot('htc'))}</td><td className="num">{ton3(tot('held'))}</td><td className="num"><b>{ton3(tot('need'))}</b></td><td /></tr></tfoot>
          </table>
        )}
      </div>
      {!!groups.length && <>
        <h3 style={{ margin: '16px 0 6px' }}>Gợi ý đề nghị giải chấp</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Công ty</th><th>Kho</th><th>Ngân hàng</th><th>Mặt hàng (kg)</th><th className="num">Tổng giải chấp (kg)</th><th></th></tr></thead>
            <tbody>
              {groups.map((g) => {
                const note = [...g.items].map(([it, kg]) => `${it} ${ton3(kg)} kg`).join(', ');
                return (
                  <tr key={`${g.company}|${g.warehouse}|${g.pledgee}`}>
                    <td>{g.company}</td><td>{g.warehouse}</td><td>{bankName(g.pledgee)}</td><td className="small">{note}</td><td className="num"><b>{ton3(g.kg)}</b></td>
                    <td>{canEdit && g.pledgee && <button className="btn sm primary" onClick={() => onPlan({ company: g.company, warehouse: g.warehouse, pledgee: g.pledgee, picks: g.picks, note: `bù thiếu cho đơn bán: ${note}` })}>+ Lập đề nghị</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>}
      <p className="small" style={{ marginTop: 6 }}>Đơn vị: kg. Đơn chưa ghi kho được so với tồn của công ty ở mọi kho, cần ghi kho vào đơn để lập đề nghị.</p>
    </div>
  );
}

// Lập đề nghị: chọn công ty, ngân hàng, kho → tích các dòng tồn HTC cần giải chấp
function ReleaseForm({ onClose, preset }) {
  const { email, name } = useApp();
  const myWh = useMyWarehouses();
  const [opCo] = useOpCompany();
  const [h, setH] = useState({ date: today(), company: preset?.company ?? (opCo || ''), pledgee: preset?.pledgee || '', warehouse: preset?.warehouse || (myWh.length === 1 ? myWh[0].code : ''), bct: '', note: preset?.note || '' });
  const { rows: stock, loading } = useStock(h.warehouse || '__none__');
  const pledgees = useCollection('pledgees').rows;
  const companies = useCollection('companies').rows;
  // stockId → { on, ton, docNo, place }; lập từ Hàng thiếu thì tích sẵn các dòng HTC đủ bù phần thiếu
  const [pick, setPick] = useState(() => Object.fromEntries(Object.entries(preset?.picks || {}).map(([id, kg]) => [id, { on: true, ton: r3(kg) }])));
  const pending = usePendingRelease(); // stockId → kg đang nằm trong đề nghị chờ duyệt
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const whName = myWh.find((w) => w.code === h.warehouse)?.name || h.warehouse;

  // Chỉ còn phần chưa nằm trong đề nghị khác đang chờ ngân hàng duyệt
  const htc = useMemo(() => stock.filter((r) => r.goodsStatus === 'HTC' && (!h.pledgee || r.pledgee === h.pledgee) && (r.company || '') === h.company)
    .map((r) => ({ ...r, held: pending.get(r._id) || 0, free: r3(num(r.kg) - (pending.get(r._id) || 0)) }))
    .filter((r) => r.free > 0.001)
    .sort((a, b) => String(a.item).localeCompare(b.item) || String(a.inDate).localeCompare(b.inDate)), [stock, h.pledgee, h.company, pending]);
  const set = (k, v) => { setH((x) => ({ ...x, [k]: v })); if (!['date', 'note', 'bct'].includes(k)) setPick({}); };
  // Đổi số bộ chứng từ chung → áp cho mọi dòng đang chọn
  const setBct = (v) => { set('bct', v); setPick((x) => Object.fromEntries(Object.entries(x).map(([k, p]) => [k, { ...p, docNo: v }]))); };
  const cur = (r) => ({ on: false, ton: r3(r.free), docNo: h.bct || '', place: whName, ...pick[r._id] });
  const setP = (r, p) => setPick((x) => ({ ...x, [r._id]: { ...cur(r), ...p } }));
  const chosen = htc.filter((r) => cur(r).on);
  const total = chosen.reduce((s, r) => s + num(cur(r).ton), 0);

  const submit = async (e) => {
    e.preventDefault(); setErr('');
    if (!h.company || !h.pledgee || !h.warehouse) return setErr('Chọn công ty, ngân hàng và kho.');
    if (!chosen.length) return setErr('Tích ít nhất 1 dòng hàng cần giải chấp.');
    const lines = [];
    for (const r of chosen) {
      const p = cur(r);
      const kg = r3(num(p.ton));
      if (!String(p.docNo || '').trim()) return setErr(`${r.item} lot ${r.lot || '-'}: nhập số bộ chứng từ (BCT).`);
      if (kg <= 0 || kg > r.free + 0.001) return setErr(`${r.item} lot ${r.lot || '-'}: số lượng phải từ 0 đến ${ton3(r.free)} kg${r.held ? ' (phần còn lại đang nằm trong đề nghị khác chưa đổi DGC)' : ''}.`);
      lines.push({ stockId: r._id, item: r.item, itemName: r.itemName || '', lot: r.lot || '', location: r.location, docNo: String(p.docNo || '').trim(),
        place: String(p.place || '').trim(), unit: 'TẤN', kg });
    }
    const pl = pledgees.find((x) => x.code === h.pledgee);
    const c = companies.find((x) => x.code === h.company);
    setBusy(true);
    try {
      const data = { ...h, pledgeeName: pl?.name || h.pledgee, companyName: c?.name || h.company, lines };
      const id = await createRelease(data, { email, name });
      // Lưu đề nghị là đổi ngay HTC → DGC; đề nghị chỉ còn để in PDF, ký số, gửi ngân hàng
      try {
        const { mid, to } = await postRelease({ ...data, id, history: [{ at: new Date().toISOString(), by: email, byName: name, action: 'Lập đề nghị' }] }, { email, name });
        onClose(id, `Đã lập đề nghị ${id} và đổi ${fmtNum(total, 2)} kg sang ${to} (phiếu ${mid}). Bấm 🖨 In → Lưu PDF để ký số gửi ngân hàng.`);
      } catch (e3) {
        onClose(id, `Lỗi: đã lập đề nghị ${id} nhưng chưa đổi được sang DGC (${e3.message}). Bấm ✅ Đổi DGC ở dòng đề nghị để thử lại.`);
      }
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền lập đề nghị giải chấp cho kho này.' : e2.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Lập đề nghị giải chấp" onClose={() => onClose()} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Công ty (bên thế chấp)" required><CompanyPicker value={h.company} allowAll={false} required onChange={(v) => set('company', v)} /></Field>
          <Field label="Ngân hàng nhận thế chấp" required>
            <select value={h.pledgee} onChange={(e) => set('pledgee', e.target.value)}>
              <option value="">-- Chọn --</option>
              {pledgees.map((p) => <option key={p.code} value={p.code}>{p.code} – {p.shortName || p.name}</option>)}
            </select>
          </Field>
          <Field label="Kho" required>
            <select value={h.warehouse} onChange={(e) => set('warehouse', e.target.value)}>
              <option value="">-- Chọn --</option>
              {myWh.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
            </select>
          </Field>
          <Field label="Ngày đề nghị" required><input type="date" value={h.date} onChange={(e) => set('date', e.target.value)} /></Field>
          <Field label="Số bộ chứng từ (BCT)" required help="Nhân viên tự đặt. In ở cột SỐ CT; áp cho mọi dòng, sửa riêng từng dòng được">
            <input value={h.bct} onChange={(e) => setBct(e.target.value)} />
          </Field>
        </div>
        {preset && <p className="hint">Đã tích sẵn hàng HTC (nhập trước giải chấp trước) để bù phần thiếu cho đơn bán: {preset.note}. Kiểm tra lại, nhập số BCT rồi bấm Lập đề nghị.</p>}
        <h4 style={{ margin: '12px 0 6px' }}>Hàng đang thế chấp (HTC){h.pledgee ? ` tại ${h.pledgee}` : ''}</h4>
        <div className="table-wrap">
          {!h.company || !h.pledgee || !h.warehouse ? <Empty text="Chọn công ty, ngân hàng và kho để hiện hàng HTC." />
            : loading ? <Empty text="Đang tải…" /> : !htc.length ? <Empty text="Không có hàng HTC của công ty này tại ngân hàng này trong kho." /> : (
              <table>
                <thead><tr><th></th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Vị trí</th><th className="num">Tồn HTC (kg)</th><th className="num">Đang đề nghị</th>
                  <th className="num">Giải chấp (kg)</th><th>Số CT (BCT)</th><th>Vị trí hàng hóa (in)</th></tr></thead>
                <tbody>
                  {htc.map((r) => {
                    const p = cur(r);
                    return (
                      <tr key={r._id}>
                        <td><input type="checkbox" checked={p.on} onChange={(e) => setP(r, { on: e.target.checked })} /></td>
                        <td className="nowrap">{r.item}</td><td>{r.itemName}</td><td>{r.lot}</td><td>{r.location}</td><td className="num">{ton3(r.kg)}</td><td className="num small">{r.held ? ton3(r.held) : ''}</td>
                        <td><input type="number" step="0.001" min="0" style={{ width: 100 }} value={p.ton} disabled={!p.on} onChange={(e) => setP(r, { ton: e.target.value })} /></td>
                        <td><input style={{ width: 90 }} value={p.docNo} disabled={!p.on} onChange={(e) => setP(r, { docNo: e.target.value })} /></td>
                        <td><input style={{ width: 140 }} value={p.place} disabled={!p.on} onChange={(e) => setP(r, { place: e.target.value })} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </div>
        <p className="small">Đã chọn {chosen.length} dòng · <b>{fmtNum(total, 2)} kg</b> (= {fmtNum(total / 1000, 3)} tấn trên bản in). Bản in gộp theo mã hàng (cùng số CT, vị trí hàng hóa).{h.warehouse ? <> Khi lưu, hàng chuyển ngay sang <b>{releaseStatusOfWh(myWh.find((w) => w.code === h.warehouse))}</b>.</> : null} Vị trí hàng hóa mặc định là tên kho, sửa được trước khi lưu.</p>
        {err && <div className="error-box">{err}</div>}
        <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lập đề nghị'}</button></div>
      </form>
    </Modal>
  );
}

// Sửa đề nghị đã giải chấp: theo dòng gộp mã hàng (như bản in) sửa số CT, vị trí hàng hóa, số lượng.
// Tăng số lượng = giải chấp thêm hàng HTC (nhập trước trước); phần đã gắn phiếu xuất của đơn không giảm được.
function EditRelease({ r, onClose }) {
  const { email, name } = useApp();
  const groups = groupLines(r.lines);
  const [v, setV] = useState(() => Object.fromEntries(groups.map((g) => [g.key, { kg: r3(g.kg), docNo: g.docNo || '', place: g.place || '' }])));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const minOf = (g) => r.lines.filter((l) => l.orderId && [l.item, l.docNo || '', l.place || ''].join('|') === g.key).reduce((s, l) => s + num(l.kg), 0);
  const set = (k, p) => setV((x) => ({ ...x, [k]: { ...x[k], ...p } }));
  const total = groups.reduce((s, g) => s + num(v[g.key]?.kg), 0);
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    const edits = {};
    for (const g of groups) {
      const x = v[g.key];
      if (num(x.kg) < minOf(g) - 0.001) return setErr(`${g.item}: tối thiểu ${ton3(minOf(g))} kg (đã xuất theo đơn ${g.orders.join(', ')}).`);
      if (Math.abs(num(x.kg) - g.kg) > 0.001 || x.docNo !== (g.docNo || '') || x.place !== (g.place || '')) edits[g.key] = { kg: num(x.kg), docNo: x.docNo, place: x.place };
    }
    if (!Object.keys(edits).length) return onClose();
    setBusy(true);
    try {
      const { mids, notes } = await editRelease(r, edits, { email, name });
      onClose(`Đã sửa ${r.id}${notes.length ? `: ${notes.join(', ')}` : ''}${mids.length ? ` (phiếu ${mids.join(', ')})` : ''}.`);
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền đổi tình trạng hàng ở kho này.' : e2.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Sửa đề nghị ${r.id}`} onClose={() => onClose()} wide>
      <form onSubmit={submit}>
        <p className="hint">Số lượng theo mã hàng như bản in. <b>Tăng</b> = giải chấp thêm hàng HTC cùng mã tại {r.pledgee} (nhập trước giải chấp trước), đổi sang {r.toStatus || 'DGC'} ngay.
          <b> Giảm</b> chỉ được phần không gắn phiếu xuất của đơn, hàng trả lại HTC. Số CT (BCT) áp cho cả dòng.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Mã hàng</th><th>Tên hàng</th><th>Đơn bán</th><th>Số CT (BCT)</th><th>Vị trí hàng hóa (in)</th><th className="num">Hiện tại (kg)</th><th className="num">Số lượng (kg)</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td className="nowrap">{g.item}</td><td>{g.itemName}</td><td className="small">{g.orders.join(', ')}</td>
                  <td><input style={{ width: 100 }} value={v[g.key].docNo} onChange={(e) => set(g.key, { docNo: e.target.value })} /></td>
                  <td><input style={{ width: 150 }} value={v[g.key].place} onChange={(e) => set(g.key, { place: e.target.value })} /></td>
                  <td className="num">{ton3(g.kg)}</td>
                  <td><input type="number" step="0.001" min="0" style={{ width: 120 }} value={v[g.key].kg} onChange={(e) => set(g.key, { kg: e.target.value })} />
                    {num(v[g.key].kg) !== r3(g.kg) && <div className="small">{num(v[g.key].kg) > g.kg ? '+' : ''}{ton3(num(v[g.key].kg) - g.kg)} kg</div>}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={5}><b>Tổng</b></td><td className="num">{ton3(totKg(r))}</td><td className="num"><b>{ton3(total)}</b> <span className="small">= {fmtNum(total / 1000, 3)} tấn</span></td></tr></tfoot>
          </table>
        </div>
        {err && <div className="error-box">{err}</div>}
        <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button></div>
      </form>
    </Modal>
  );
}

// Bản in theo mẫu "ĐỀ NGHỊ GIẢI CHẤP" (A4 dọc)
export function PrintRelease() {
  const { id } = useParams();
  const [r, setR] = useState(undefined);
  const [co, setCo] = useState(null);
  const [bank, setBank] = useState(null);
  useEffect(() => {
    getDoc(doc(db, 'releaseRequests', id)).then((s) => {
      const d = s.exists() ? s.data() : null;
      setR(d);
      if (!d) return;
      getDoc(doc(db, 'companies', d.company)).then((x) => setCo(x.exists() ? x.data() : {})).catch(() => setCo({}));
      getDoc(doc(db, 'pledgees', d.pledgee)).then((x) => setBank(x.exists() ? x.data() : {})).catch(() => setBank({}));
    }).catch(() => setR(null));
  }, [id]);
  const choice = useTemplateChoice(r ? 'giaichap' : null, { company: r?.company, party: r?.pledgee });
  const [pdfMsg, setPdfMsg] = useState('');
  // Lưu PDF (tải file về máy) rồi mở bằng trình xem PDF của trình duyệt; ?pdf=1: tự làm khi trang in sẵn sàng
  const makePdf = async (win, replace) => {
    setPdfMsg('Đang tạo PDF…');
    try {
      for (let i = 0; i < 50 && !document.querySelector('.tpl-sheet, .print-page.gc'); i++) await new Promise((ok) => setTimeout(ok, 200));
      const el = document.querySelector('.tpl-pages') || document.querySelector('.print-page.gc');
      const blob = await pageToPdf(el, `De nghi giai chap ${id}`);
      const url = savePdf(blob, `De_nghi_giai_chap_${id}.pdf`);
      if (replace) window.location.replace(url);
      else if (win) win.location.href = url;
      else window.open(url, '_blank');
      setPdfMsg('');
    } catch (e) {
      if (win) win.close();
      setPdfMsg('Lỗi tạo PDF: ' + e.message + '. Dùng 🖨 In / Lưu PDF.');
    }
  };
  const auto = useRef(new URLSearchParams(window.location.search).get('pdf') === '1');
  const ready = r && co && bank && !choice.loading;
  useEffect(() => {
    if (!ready || !auto.current) return;
    auto.current = false;
    setTimeout(() => makePdf(null, true), 300);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  if (r === undefined || (r && (!co || !bank)) || choice.loading) return <div className="center">Đang tải…</div>;
  if (!r) return <div className="center">Không tìm thấy đề nghị {id}.</div>;
  const toolbar = (
    <>
      <Link className="btn" to="/kho/giai-chap">← Đề nghị giải chấp</Link>
      <button className="btn primary" onClick={() => makePdf(window.open('', '_blank'))}>📄 Lưu PDF & mở</button>
      <button className="btn" onClick={() => window.print()}>🖨 In</button>
      {pdfMsg && <span className="small">{pdfMsg}</span>}
      {r.status !== 'sent' && <span className="badge">{RELEASE_STATUS[r.status]?.label}</span>}
      {choice.select}
    </>
  );
  if (choice.tpl) return <TemplatePage key={choice.tpl.id} tpl={choice.tpl} toolbar={toolbar} load={() => loadReleaseData(r)} deps={[r.id]} />;
  const [y, m, d] = r.date.split('-');
  const dots = (v, n) => v || '.'.repeat(n);
  const bankShort = bank.shortName || bank.name || r.pledgee;

  return (
    <div className="print-page gc">
      <div className="no-print toolbar">{toolbar}</div>
      <div className="gc-nation">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM<br /><span>Độc lập - Tự do - Hạnh phúc</span><br /><span className="gc-dash">--------o0o---------</span></div>
      <div className="gc-dateline">
        <i>{co.place || 'HCM'}, ngày {d} tháng {m} năm {y}</i>
        <span className="gc-no"><b><i>Số:</i></b> <span>{r.id}</span></span>
      </div>
      <h2 className="gc-title">ĐỀ NGHỊ GIẢI CHẤP</h2>
      <div className="gc-sub">(V/V giải chấp hàng hóa)</div>
      {r.status === 'cancelled' && <div className="error-box">ĐỀ NGHỊ ĐÃ HỦY: {r.cancelReason}</div>}
      <div><b>Kính gửi: {bank.name || r.pledgeeName}</b></div>
      <div>Hôm nay, tại {co.address}</div>
      <div><b>Tôi/ chúng Tôi là:</b></div>
      <table className="gc-info"><tbody>
        <tr><td><b>Công ty:</b></td><td><b>{co.name || r.companyName}</b></td></tr>
        <tr><td><b>ĐKKD số:</b></td><td>{co.taxCode} {co.bizRegInfo}</td></tr>
        <tr><td><b>Đại diện là Ông/bà:</b></td><td><b>{co.representative}</b></td></tr>
        <tr><td>Chức vụ:</td><td>{co.repTitle}</td></tr>
        <tr><td>Địa chỉ:</td><td>{co.address}</td></tr>
      </tbody></table>
      <div>Điện thoại: {dots(co.phone, 14)} Fax: {dots(co.fax, 16)} Email: {dots(co.email, 26)}</div>
      <div style={{ marginTop: 6 }}>Bằng văn bản này, Tôi/ chúng tôi kính đề nghị {bankShort} chấp nhận cho Tôi/ Chúng tôi giải chấp hàng hóa theo nội dung chi tiết sau đây:</div>
      <table className="gc-lines">
        <thead><tr><th>STT</th><th>SỐ CT</th><th>MÃ HÀNG</th><th>TÊN HÀNG</th><th>ĐVT</th><th>SỐ LƯỢNG</th><th>VỊ TRÍ HÀNG HÓA</th></tr></thead>
        <tbody>
          {groupLines(r.lines).map((l, i) => (
            <tr key={i}><td className="c">{i + 1}</td><td className="c">{l.docNo}</td><td>{l.item}</td><td>{l.itemName}</td><td className="c">{l.unit || 'TẤN'}</td>
              <td className="num">{tonPrint(l.kg)}</td><td>{l.place}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={5}>Total:</td><td className="num">{tonPrint(totKg(r))}</td><td /></tr></tfoot>
      </table>
      <p>Tôi/ công ty chúng tôi cam kết không hủy ngang bằng văn bản đề nghị giải chấp này và cam kết thực hiện đúng các thỏa thuận tại Hợp đồng tín dụng đã kí kết với Quý ngân hàng</p>
      <div className="gc-sign">
        <b>Trân trọng cảm ơn!</b>
        <div><b><i>ĐẠI DIỆN KHÁCH HÀNG</i></b><br /><i>(hoặc người được ủy quyền hợp tác)</i></div>
      </div>
    </div>
  );
}
