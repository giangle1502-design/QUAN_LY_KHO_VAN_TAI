import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, getDoc, onSnapshot, runTransaction, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpCompany, useStock } from '../../lib/hooks';
import { postMovement } from '../../lib/stock';
import { usePendingRelease, useShortfall } from '../../lib/shortfall';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, today } from '../../lib/utils';
import { CompanyPicker } from '../../components/TripBits';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';

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
// Lưu kg, lên form đổi ra tấn, luôn 3 số lẻ: 25 tấn → 25.000; 1250.5 tấn → 1,250.500
const ton3 = (kg) => fmtNum(num(kg) / 1000, 3, 3);
const tonPrint = ton3;
const totKg = (r) => (r.lines || []).reduce((s, l) => s + num(l.kg), 0);

async function createRelease(data, user) {
  const ymd = data.date.replace(/-/g, '').slice(2);
  const ruleSnap = await getDoc(doc(db, 'codeRules', 'HSGC')).catch(() => null);
  const prefix = ruleSnap?.exists() ? ruleSnap.data().prefix ?? 'HSGC' : 'HSGC';
  const digits = num(ruleSnap?.exists() && ruleSnap.data().digits) || 2;
  const cRef = doc(db, 'counters', `HSGC-${ymd}`);
  return runTransaction(db, async (tx) => {
    const c = await tx.get(cRef);
    const n = c.exists() ? num(c.data().next) || 1 : 1;
    const id = `${prefix}${ymd}${String(n).padStart(digits, '0')}`;
    const at = new Date().toISOString();
    tx.set(cRef, { next: n + 1 });
    tx.set(doc(db, 'releaseRequests', id), {
      ...data, id, status: 'sent', createdAt: at, createdBy: user.email, createdByName: user.name,
      history: [{ at, by: user.email, byName: user.name, action: 'Lập đề nghị' }],
    });
    return id;
  });
}

// Đổi tình trạng HTC → DGC cho đúng các dòng tồn trong đề nghị (phiếu TC), đánh dấu đề nghị đã giải chấp
async function postRelease(r, { email, name }) {
  const lines = [];
  for (const [i, l] of r.lines.entries()) {
    const s = await getDoc(doc(db, 'stock', l.stockId));
    const x = s.exists() ? s.data() : null;
    if (!x || x.goodsStatus !== 'HTC' || num(x.kg) < num(l.kg) - 0.001) {
      throw new Error(`Dòng ${i + 1} (${l.item} lot ${l.lot || '-'}, ${l.location}): tồn HTC hiện chỉ còn ${fmtNum(x?.kg || 0)} kg, không đủ ${fmtNum(l.kg)} kg. Hàng đã bị xuất/chuyển sau khi lập đề nghị; hủy đề nghị và lập lại.`);
    }
    const k = num(x.kg) ? Math.min(1, num(l.kg) / num(x.kg)) : 1;
    lines.push({
      item: x.item, itemName: x.itemName || '', lot: x.lot || '', mfgDate: x.mfgDate || '', expDate: x.expDate || '', inDate: x.inDate || '',
      location: x.location, goodsStatus: 'HTC', pledgee: x.pledgee || '', company: x.company || '',
      bags: k === 1 ? num(x.bags) : Math.round(num(x.bags) * k), pallets: k === 1 ? num(x.pallets) : r3(num(x.pallets) * k), kg: num(l.kg),
      toStatus: 'DGC', toPledgee: '',
    });
  }
  const mid = await postMovement({
    type: 'status', warehouse: r.warehouse, company: r.company, date: today(), tripId: '', orderId: '', orderRef: '',
    partyCode: r.pledgee, partyName: r.pledgeeName, shipCode: '', reason: '', note: `Giải chấp theo đề nghị ${r.id}`, releaseId: r.id, lines,
  }, { email, name });
  const at = new Date().toISOString();
  await updateDoc(doc(db, 'releaseRequests', r.id), {
    status: 'released', movementId: mid, releasedAt: at, releasedBy: email,
    history: [...(r.history || []), { at, by: email, byName: name, action: `Đổi HTC → DGC, phiếu ${mid}` }],
  });
  return mid;
}

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
  const tab = sp.get('tab') === 'thieu' ? 'thieu' : 'de-nghi';
  const [busy, setBusy] = useState('');
  const canEdit = hasRole('ke_toan');

  useEffect(() => onSnapshot(collection(db, 'releaseRequests'),
    (s) => setRows(s.docs.map((d) => d.data())), (e) => setError(e.message)), []);
  const list = rows.filter((r) => inMyWarehouses(r.warehouse) && (!co || r.company === co) && (!st || r.status === st))
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));

  const release = async (r) => {
    if (!window.confirm(`Đổi ${ton3(totKg(r))} tấn trong ${r.id} từ HTC sang DGC?`)) return;
    setBusy(r.id); setMsg('');
    try {
      const mid = await postRelease(r, { email, name });
      setMsg(`Đã đổi ${r.id}: phiếu ${mid} chuyển ${ton3(totKg(r))} tấn sang DGC.`);
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

  const exportExcel = () => exportSheets(`De_nghi_giai_chap_${today()}`, {
    'Đề nghị giải chấp': list.flatMap((r) => r.lines.map((l, i) => ({
      'Số đề nghị': r.id, Ngày: r.date, 'Công ty': r.company, 'Ngân hàng': r.pledgee, Kho: r.warehouse, 'Trạng thái': RELEASE_STATUS[r.status]?.label,
      STT: i + 1, 'Số CT (BCT)': l.docNo, 'Mã hàng': l.item, 'Tên hàng': l.itemName, Lot: l.lot, 'Vị trí': l.location, 'Vị trí hàng hóa': l.place,
      'Số lượng (tấn)': num(l.kg) / 1000, 'Phiếu giải chấp': r.movementId || '',
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
        <button type="button" className={tab === 'de-nghi' ? 'on' : ''} onClick={() => setSp({})}>Đề nghị giải chấp</button>
        <button type="button" className={tab === 'thieu' ? 'on' : ''} onClick={() => setSp({ tab: 'thieu' })}>⚠ Hàng thiếu cho đơn bán</button>
      </div>
      {msg && <div className={msg.startsWith('Lỗi') ? 'error-box' : 'ok-box'}>{msg}</div>}
      {tab === 'thieu' ? <Shortfall co={co} setCo={setCo} canEdit={canEdit} onPlan={(preset) => setForm({ preset })} /> : <>
      <p className="hint">
        Lập đề nghị từ hàng đang thế chấp (HTC): khi lưu, hệ thống <b>đổi ngay</b> các dòng hàng trong đề nghị sang <b>DGC</b> (phiếu TC),
        xuất kho được luôn. Bấm <b>🖨 In</b> → Lưu PDF, chèn chữ ký số và gửi ngân hàng.
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
              <th className="num">Số lượng (tấn)</th><th>Trạng thái</th><th>Phiếu TC</th><th></th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="mono nowrap">{r.id}</td><td className="nowrap">{fmtDate(r.date)}</td><td>{r.company}</td><td>{r.pledgee}</td><td>{r.warehouse}</td>
                  <td>{[...new Set(r.lines.map((l) => l.item))].join(', ')}</td><td className="num">{ton3(totKg(r))}</td>
                  <td><span className={'badge ' + (RELEASE_STATUS[r.status]?.cls || '')}>{RELEASE_STATUS[r.status]?.label}</span>{r.cancelReason ? <span className="small"> {r.cancelReason}</span> : null}</td>
                  <td className="mono">{r.movementId ? <Link to={`/kho/phieu/${r.movementId}/in`}>{r.movementId}</Link> : ''}</td>
                  <td className="nowrap">
                    <Link className="btn sm" to={`/kho/giai-chap/${r.id}/in`}>🖨 In</Link>{' '}
                    {canEdit && r.status === 'sent' && <>
                      <button className="btn sm primary" disabled={!!busy} onClick={() => release(r)}>{busy === r.id ? 'Đang ghi…' : '✅ Đổi DGC'}</button>{' '}
                      <button className="btn sm" onClick={() => cancel(r)}>Hủy</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </>}
      {form && <ReleaseForm preset={form.preset} onClose={(id, m) => { setForm(false); if (id) { setSp({}); setSt(''); setMsg(m || `Đã lập đề nghị ${id}.`); } }} />}
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
      'SO còn phải giao (tấn)': r.so / 1000, 'Tồn KTC + DGC (tấn)': r.usable / 1000, 'Thiếu (tấn)': r.short / 1000,
      'Tồn HTC (tấn)': r.htc / 1000, 'Đang đề nghị giải chấp (tấn)': r.held / 1000, 'Còn cần giải chấp (tấn)': r.need / 1000,
      'HTC không đủ bù (tấn)': r.uncovered / 1000, 'Đơn bán': r.orders.join(', '),
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
        <span className="small">{rows.length ? <b style={{ color: 'var(--red)' }}>{rows.length} mã hàng thiếu · {ton3(tot('short'))} tấn · còn cần giải chấp {ton3(tot('need'))} tấn</b> : ''}</span>
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
            <thead><tr><th>Công ty</th><th>Kho</th><th>Ngân hàng</th><th>Mặt hàng (tấn)</th><th className="num">Tổng giải chấp (tấn)</th><th></th></tr></thead>
            <tbody>
              {groups.map((g) => {
                const note = [...g.items].map(([it, kg]) => `${it} ${ton3(kg)} tấn`).join(', ');
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
      <p className="small" style={{ marginTop: 6 }}>Đơn vị: tấn. Đơn chưa ghi kho được so với tồn của công ty ở mọi kho, cần ghi kho vào đơn để lập đề nghị.</p>
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
  const [pick, setPick] = useState(() => Object.fromEntries(Object.entries(preset?.picks || {}).map(([id, kg]) => [id, { on: true, ton: r3(kg / 1000) }])));
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
  const cur = (r) => ({ on: false, ton: r3(r.free / 1000), docNo: h.bct || '', place: whName, ...pick[r._id] });
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
      const kg = r3(num(p.ton) * 1000);
      if (!String(p.docNo || '').trim()) return setErr(`${r.item} lot ${r.lot || '-'}: nhập số bộ chứng từ (BCT).`);
      if (kg <= 0 || kg > r.free + 0.001) return setErr(`${r.item} lot ${r.lot || '-'}: số lượng phải từ 0 đến ${ton3(r.free)} tấn${r.held ? ' (phần còn lại đang nằm trong đề nghị khác chưa đổi DGC)' : ''}.`);
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
        const mid = await postRelease({ ...data, id, history: [{ at: new Date().toISOString(), by: email, byName: name, action: 'Lập đề nghị' }] }, { email, name });
        onClose(id, `Đã lập đề nghị ${id} và đổi ${fmtNum(total, 3, 3)} tấn sang DGC (phiếu ${mid}). Bấm 🖨 In → Lưu PDF để ký số gửi ngân hàng.`);
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
                <thead><tr><th></th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Vị trí</th><th className="num">Tồn HTC (tấn)</th><th className="num">Đang đề nghị</th>
                  <th className="num">Giải chấp (tấn)</th><th>Số CT (BCT)</th><th>Vị trí hàng hóa (in)</th></tr></thead>
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
        <p className="small">Đã chọn {chosen.length} dòng · <b>{fmtNum(total, 3, 3)} tấn</b>. Vị trí hàng hóa mặc định là tên kho, sửa được trước khi lưu.</p>
        {err && <div className="error-box">{err}</div>}
        <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lập đề nghị'}</button></div>
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
  if (r === undefined || (r && (!co || !bank))) return <div className="center">Đang tải…</div>;
  if (!r) return <div className="center">Không tìm thấy đề nghị {id}.</div>;
  const [y, m, d] = r.date.split('-');
  const dots = (v, n) => v || '.'.repeat(n);
  const bankShort = bank.shortName || bank.name || r.pledgee;

  return (
    <div className="print-page gc">
      <div className="no-print toolbar">
        <Link className="btn" to="/kho/giai-chap">← Đề nghị giải chấp</Link>
        <button className="btn primary" onClick={() => window.print()}>🖨 In / Lưu PDF</button>
        {r.status !== 'sent' && <span className="badge">{RELEASE_STATUS[r.status]?.label}</span>}
      </div>
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
          {r.lines.map((l, i) => (
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
