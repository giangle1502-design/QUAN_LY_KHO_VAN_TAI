import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses } from '../../lib/hooks';
import { Empty, ErrorBox, Field, Modal } from '../../components/ui';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtNum, matchQ } from '../../lib/utils';
import { MOVE_KINDS, palletManaged, postPalletMove } from '../../lib/pallets';
import { WithAdd } from '../../components/FormTools';
import Select from '../../components/Select';

// Quản lý pallet gỗ / nhựa: tồn theo kho, vận tải đang mượn (nhận trả), sổ pallet
export default function Pallets() {
  const { hasRole, role, myCarrier } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'muon';
  const canManage = hasRole('thu_kho');
  const warehouses = useMyWarehouses();
  const mine = useMemo(() => new Set(warehouses.map((w) => w.code)), [warehouses]);
  const stock = useCollection('palletStock');
  const lent = useCollection('palletCarrier');
  const catalog = useCollection('pallets').rows;
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const carrierOnly = role === 'van_tai' ? myCarrier : '';
  const lentRows = lent.rows.filter((r) => Math.abs(Number(r.qty) || 0) > 0.001 && (!carrierOnly || r.carrier === carrierOnly))
    .sort((a, b) => String(a.carrierName).localeCompare(String(b.carrierName)) || a.code.localeCompare(b.code));
  const stockRows = stock.rows.filter((r) => mine.has(r.warehouse)).sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.code.localeCompare(b.code));
  const tabs = [['muon', `Vận tải đang mượn (${lentRows.reduce((s, r) => s + Number(r.qty || 0), 0)})`], ['ton', 'Tồn pallet theo kho'], ['so', 'Sổ pallet']];

  return (
    <div>
      <div className="page-head">
        <h1>🪵 Quản lý pallet</h1>
        <div className="actions">
          <div className="seg">{tabs.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setParams({ tab: k })}>{l}</button>)}</div>
          {canManage && <button className="btn primary" onClick={() => setForm({ kind: 'return' })}>📥 Vận tải trả pallet</button>}
          {canManage && <button className="btn" onClick={() => setForm({ kind: 'in' })}>＋ Nhập / điều chỉnh pallet</button>}
        </div>
      </div>
      <p className="hint">
        Đơn hàng chỉ ghi <b>Kiện</b> (có pallet) hoặc <b>Xá</b>. Thủ kho kiểm tra pallet gỗ / nhựa và số pallet khi nhận hàng (phiếu nhập: cộng tồn pallet kho) và trên phiếu xuất (hoặc lúc in phiếu giao hàng):
        <b> xuất cho khách hàng</b> trừ tồn pallet kho; <b>cho vận tải mượn</b> trừ tồn kho và ghi nợ cho đơn vị vận tải; <b>chuyển theo hàng (STO)</b> trừ kho đi, kho nhận cộng khi nhận hàng.
        Tồn pallet chỉ tính ở kho quản lý theo <b>Pallet</b> ({warehouses.filter(palletManaged).map((w) => w.code).join(', ') || 'chưa có kho nào'}; chỉnh ở <Link to="/dm/warehouses">Danh sách kho</Link>).
        Khi vận tải mang trả, bấm <b>Vận tải trả pallet</b> để nhập lại kho. Mã pallet khai ở <Link to="/dm/pallets">Danh mục → Mã pallet</Link>.
        {!catalog.length && <b style={{ color: 'var(--red)' }}> Chưa có mã pallet nào, hãy tạo mã pallet nhựa / gỗ trước.</b>}
      </p>
      <ErrorBox error={stock.error || lent.error} />
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      {tab === 'muon' && (!lentRows.length ? <Empty text="Không có vận tải nào đang mượn pallet" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Đơn vị vận tải</th><th>Mã pallet</th><th>Tên</th><th>Loại</th><th className="num">Đang mượn (cái)</th><th>Phiếu gần nhất</th><th>Cập nhật</th><th></th></tr></thead>
            <tbody>{lentRows.map((r) => (
              <tr key={r._id}>
                <td><b>{r.carrierName || r.carrier}</b> <span className="small">{r.carrier}</span></td><td>{r.code}</td><td>{r.name}</td><td>{r.material}</td>
                <td className="num"><b>{fmtNum(r.qty)}</b></td><td className="mono small">{String(r.lastRef || "").startsWith("PX") ? r.lastRef : ""}</td><td className="small">{r.updatedAt ? new Date(r.updatedAt).toLocaleString('vi-VN') : ''}</td>
                <td>{canManage && <button className="btn sm primary" onClick={() => setForm({ kind: 'return', carrier: r.carrier, carrierName: r.carrierName, code: r.code, qty: r.qty })}>Nhận trả</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {tab === 'ton' && (!stockRows.length ? <Empty text="Chưa có tồn pallet" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kho</th><th>Mã pallet</th><th>Tên</th><th>Loại</th><th className="num">Tồn (cái)</th><th>Cập nhật</th></tr></thead>
            <tbody>{stockRows.map((r) => (
              <tr key={r._id} style={Number(r.qty) < 0 ? { background: 'var(--red-soft)' } : undefined}>
                <td>{r.warehouse}</td><td>{r.code}</td><td>{r.name}</td><td>{r.material}</td>
                <td className="num"><b>{fmtNum(r.qty)}</b>{Number(r.qty) < 0 ? <div className="small">tồn âm: nhập tồn đầu pallet</div> : null}</td>
                <td className="small">{r.updatedAt ? new Date(r.updatedAt).toLocaleString('vi-VN') : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {tab === 'so' && <Ledger mine={mine} carrierOnly={carrierOnly} />}
      {form && <MoveForm init={form} warehouses={warehouses} catalog={catalog} onClose={(m) => { setForm(null); if (m) setMsg(m); }} />}
    </div>
  );
}

function MoveForm({ init, warehouses, catalog, onClose }) {
  const { email, name } = useApp();
  const carriers = useCollection('carriers').rows;
  const [f, setF] = useState({ kind: 'in', warehouse: warehouses.length === 1 ? warehouses[0].code : '', date: vnDate(), code: '', qty: '', carrier: '', carrierName: '', sign: '+', note: '', ...init });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const pal = catalog.find((p) => p.code === f.code);
  const save = async () => {
    setErr('');
    if (!f.warehouse) return setErr('Chọn kho.');
    if (!pal) return setErr('Chọn mã pallet.');
    if (!(Number(f.qty) > 0)) return setErr('Nhập số lượng.');
    if (f.kind === 'return' && !f.carrier) return setErr('Chọn đơn vị vận tải trả pallet.');
    setBusy(true);
    try {
      const qty = f.kind === 'adjust' && f.sign === '-' ? -Number(f.qty) : Number(f.qty);
      await postPalletMove({ kind: f.kind, warehouse: f.warehouse, date: f.date, code: pal.code, name: pal.name, material: pal.material, qty,
        ...(f.kind === 'return' ? { carrier: f.carrier, carrierName: f.carrierName || carriers.find((c) => c.code === f.carrier)?.name || f.carrier } : {}), note: f.note.trim() }, { email, name });
      onClose(`Đã ghi ${MOVE_KINDS[f.kind].toLowerCase()}: ${pal.code} ${qty > 0 ? '+' : ''}${fmtNum(qty)} cái tại kho ${f.warehouse}.`);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền ghi pallet cho kho này.' : e.message); setBusy(false); }
  };
  return (
    <Modal title={f.kind === 'return' ? 'Vận tải trả pallet về kho' : 'Nhập / điều chỉnh pallet'} onClose={() => onClose('')}>
      <div className="form-grid">
        <Field label="Nghiệp vụ" required>
          <Select value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
            {['return', 'in', 'customerReturn', 'adjust'].map((k) => <option key={k} value={k}>{MOVE_KINDS[k]}</option>)}
          </Select>
        </Field>
        <Field label="Kho" required>
          <WithAdd cat="warehouses" onAdded={(id) => set({ warehouse: id })}>
            <Select value={f.warehouse} onChange={(e) => set({ warehouse: e.target.value })}>
              <option value="">-- Chọn kho --</option>
              {warehouses.filter((w) => f.kind === 'return' || palletManaged(w)).map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}{palletManaged(w) ? '' : ' (quản lý theo Kiện)'}</option>)}
            </Select>
          </WithAdd>
        </Field>
        <Field label="Ngày" required><input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        {f.kind === 'return' && (
          <Field label="Đơn vị vận tải" required>
            <WithAdd cat="carriers" onAdded={(id, r) => set({ carrier: id, carrierName: r?.name || '' })}>
              <Select value={f.carrier} onChange={(e) => set({ carrier: e.target.value, carrierName: carriers.find((c) => c.code === e.target.value)?.name || '' })}>
                <option value="">-- Chọn --</option>
                {carriers.map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}
              </Select>
            </WithAdd>
          </Field>
        )}
        <Field label="Mã pallet" required>
          <WithAdd cat="pallets" onAdded={(id) => set({ code: id })}>
            <Select value={f.code} onChange={(e) => set({ code: e.target.value })}>
              <option value="">-- Chọn --</option>
              {catalog.map((p) => <option key={p.code} value={p.code}>{p.code} – {p.name} ({p.material})</option>)}
            </Select>
          </WithAdd>
        </Field>
        {f.kind === 'adjust' && (
          <Field label="Tăng / giảm"><Select value={f.sign} onChange={(e) => set({ sign: e.target.value })}><option value="+">Tăng (+)</option><option value="-">Giảm (−)</option></Select></Field>
        )}
        <Field label="Số lượng (cái)" required><input type="number" min="0" step="1" value={f.qty} onChange={(e) => set({ qty: e.target.value })} /></Field>
        <Field label="Ghi chú" full><input value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>
      </div>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={() => onClose('')}>Đóng</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang ghi…' : 'Ghi'}</button></div>
    </Modal>
  );
}

// Sổ pallet: pallet theo phiếu xuất + nhập / trả / điều chỉnh tay
function Ledger({ mine, carrierOnly }) {
  const [from, setFrom] = useState(vnDate().slice(0, 8) + '01');
  const [to, setTo] = useState(vnDate());
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setErr('');
    try {
      const [mv, pm] = await Promise.all([
        getDocs(query(collection(db, 'movements'), where('date', '>=', from), where('date', '<=', to))),
        getDocs(query(collection(db, 'palletMoves'), where('date', '>=', from), where('date', '<=', to))),
      ]);
      const out = [];
      for (const d of mv.docs) {
        const m = d.data();
        if (!['in', 'out'].includes(m.type) || m.palletMode !== 'pallet' || m.status !== 'posted' || !mine.has(m.warehouse)) continue;
        const tracked = m.palletTracked !== false;
        for (const p of m.pallets || []) {
          if (m.type === 'in') {
            out.push({ date: m.date, ref: m.id, link: `/kho/phieu/${m.id}/in`, warehouse: m.warehouse, code: p.code, name: p.name, material: p.material,
              kind: 'slipIn', stock: tracked ? Number(p.qty) : 0, lent: 0, who: `${m.partyCode || ''} ${m.partyName || ''}`.trim(), carrier: '', by: m.confirmedByName || m.createdByName });
            continue;
          }
          out.push({ date: m.date, ref: m.id, link: `/kho/phieu/${m.id}/in`, warehouse: m.warehouse, code: p.code, name: p.name, material: p.material,
            kind: p.to === 'carrier' ? 'lend' : p.to === 'transfer' ? 'transfer' : 'customer', stock: tracked ? -Number(p.qty) : 0, lent: p.to === 'carrier' ? Number(p.qty) : 0,
            who: p.to === 'carrier' ? p.carrierName || p.carrier : `${m.partyCode || ''} ${m.partyName || ''}`.trim(), carrier: p.carrier || '', by: m.createdByName });
        }
      }
      for (const d of pm.docs) {
        const x = d.data();
        if (!mine.has(x.warehouse)) continue;
        out.push({ date: x.date, ref: '', warehouse: x.warehouse, code: x.code, name: x.name, material: x.material, kind: x.kind,
          stock: Number(x.qty), lent: x.kind === 'return' ? -Number(x.qty) : 0, who: x.carrierName || '', carrier: x.carrier || '', by: x.createdByName, note: x.note });
      }
      out.sort((a, b) => b.date.localeCompare(a.date));
      setRows(carrierOnly ? out.filter((r) => r.carrier === carrierOnly) : out);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const excel = () => exportSheets(`So_pallet_${from}_${to}`, { 'Sổ pallet': rows.map((r) => ({
    Ngày: fmtDate(r.date), 'Chứng từ': r.ref, Kho: r.warehouse, 'Mã pallet': r.code, 'Tên': r.name, Loại: r.material, 'Nghiệp vụ': MOVE_KINDS[r.kind],
    'Tồn kho (+/−)': r.stock, 'Vận tải đang mượn (+/−)': r.lent, 'Vận tải / khách hàng': r.who, 'Người ghi': r.by, 'Ghi chú': r.note || '' })) });
  return (
    <>
      <div className="filters">
        <label className="small">Từ ngày <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">Đến ngày <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Đang tải…' : 'Xem sổ pallet'}</button>
        {rows?.length ? <button className="btn" onClick={excel}>⬇ Excel</button> : null}
        {rows?.length ? <input type="search" placeholder="Tìm chứng từ, mã pallet, kho, vận tải / khách…" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
      </div>
      <ErrorBox error={err} />
      {rows && (!rows.length ? <Empty text="Không có phát sinh pallet" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ngày</th><th>Chứng từ</th><th>Kho</th><th>Mã pallet</th><th>Loại</th><th>Nghiệp vụ</th><th className="num">Tồn kho</th><th className="num">Vận tải mượn</th><th>Vận tải / khách hàng</th><th>Người ghi</th><th>Ghi chú</th></tr></thead>
            <tbody>{rows.filter((r) => matchQ(q, r.ref, r.warehouse, r.code, r.name, r.material, MOVE_KINDS[r.kind], r.who, r.by, r.note)).map((r, i) => (
              <tr key={i}>
                <td>{fmtDate(r.date)}</td><td>{r.link ? <Link className="mono" to={r.link} target="_blank">{r.ref}</Link> : ''}</td><td>{r.warehouse}</td><td>{r.code}</td><td>{r.material}</td>
                <td>{MOVE_KINDS[r.kind]}</td><td className="num">{r.stock > 0 ? '+' : ''}{fmtNum(r.stock)}</td><td className="num">{r.lent ? `${r.lent > 0 ? '+' : ''}${fmtNum(r.lent)}` : ''}</td>
                <td>{r.who}</td><td className="small">{r.by}</td><td className="small">{r.note}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
    </>
  );
}
