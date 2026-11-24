import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { allGroups, locWh, noCapacity } from '../../lib/whGroups';
import { fmtNum } from '../../lib/utils';
import { ErrorBox, Field } from '../../components/ui';
import Select from '../../components/Select';

// ============================================================================
// Kho chung (kho vật lý dùng chung vị trí cho nhiều pháp nhân):
//  1. Kiểm tra thiết lập (kho thuộc 2 kho chung, kho chưa ghi pháp nhân)
//  2. Gộp vị trí: vị trí đang khai báo riêng ở từng kho pháp nhân → 1 vị trí của kho chung
//  3. Tạo vị trí hàng loạt theo dãy (A01→A29…)
//  4. Tính lại số pallet đang chứa của mọi vị trí từ tồn kho thực tế
// ============================================================================
const n = (v) => Number(v) || 0;
const r3 = (x) => Math.round(x * 1000) / 1000;
const nowISO = () => new Date().toISOString();
// Giống locationId (lib/stock.js): đổi '/' thành '_'
const locDocId = (wh, code) => `${String(wh).trim().replace(/\//g, '_')}__${String(code).trim().replace(/\//g, '_')}`;
// Ghi nhiều bản ghi, mỗi lô 400
async function commitAll(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => (op.del ? b.delete(op.ref) : b.set(op.ref, op.data, { merge: !!op.merge })));
    await b.commit();
  }
}
// Gộp các bản ghi vị trí trùng mã: sức chứa lấy số lớn nhất, ô tích lấy "có" nếu một bản có, chữ lấy bản đầu tiên có
export function mergeLocRecords(recs, capRule = 'max') {
  const caps = recs.map((r) => n(r.capacity)).filter((x) => x > 0);
  const firstText = (k) => recs.map((r) => r[k]).find((x) => x != null && String(x).trim() !== '') ?? '';
  return {
    capacity: !caps.length ? null : capRule === 'sum' ? caps.reduce((s, x) => s + x, 0) : Math.max(...caps),
    locked: recs.some((r) => r.locked), blockStock: recs.some((r) => r.blockStock), needInvoice: recs.some((r) => r.needInvoice),
    invoiceInfo: firstText('invoiceInfo'), address: firstText('address'), mapLink: firstText('mapLink'), note: firstText('note'), zone: firstText('zone'),
  };
}

// Dãy vị trí: "A-E" hoặc "A,B,C" + số từ..đến, đủ chữ số → [A01, A02…]
export function expandRange(prefixes, from, to, digits) {
  const ps = String(prefixes).split(',').flatMap((p) => {
    const m = p.trim().match(/^([A-Za-z])\s*-\s*([A-Za-z])$/);
    if (!m) return p.trim() ? [p.trim()] : [];
    const a = m[1].toUpperCase().charCodeAt(0), b = m[2].toUpperCase().charCodeAt(0);
    return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => String.fromCharCode(Math.min(a, b) + i));
  });
  const out = [];
  for (const p of ps) for (let i = n(from); i <= n(to); i += 1) out.push(`${p}${String(i).padStart(n(digits) || 0, '0')}`);
  return out;
}

export default function WarehouseGroups() {
  const { isAdmin, isSuper, email, whTick } = useApp();
  const groupsRows = useCollection('warehouseGroups').rows;
  const warehouses = useCollection('warehouses').rows;
  const locations = useCollection('locations').rows;
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [capRule, setCapRule] = useState('max');
  const groups = useMemo(() => allGroups(), [whTick, groupsRows]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1. Kiểm tra thiết lập
  const issues = useMemo(() => {
    const out = [];
    const seen = new Map();
    for (const g of groupsRows) for (const m of g.members || []) {
      if (seen.has(m)) out.push(`Kho ${m} nằm trong 2 kho chung: ${seen.get(m)} và ${g.code}. Mỗi kho chỉ thuộc 1 kho chung (đang lấy ${seen.get(m)}).`);
      else seen.set(m, g.code);
      if (!warehouses.some((w) => w.code === m)) out.push(`Kho chung ${g.code}: kho ${m} không có trong Danh sách kho.`);
    }
    for (const g of groups) for (const m of g.members) {
      const w = warehouses.find((x) => x.code === m);
      if (w && !w.company) out.push(`Kho ${m} (thuộc ${g.code}) chưa ghi Pháp nhân: phiếu ở kho này không tự điền công ty.`);
    }
    return out;
  }, [groupsRows, groups, warehouses]);

  // 2. Gộp vị trí: vị trí còn ghi theo kho pháp nhân của 1 kho chung
  const plan = useMemo(() => {
    const rows = [];
    for (const g of groups) {
      const byCode = new Map();
      for (const l of locations.filter((x) => g.members.includes(x.warehouse))) byCode.set(l.code, [...(byCode.get(l.code) || []), l]);
      for (const [code, recs] of byCode) {
        const exist = locations.find((x) => x.warehouse === g.code && x.code === code);
        const merged = mergeLocRecords(exist ? [exist, ...recs] : recs, capRule);
        const caps = [...new Set(recs.map((r) => n(r.capacity)).filter(Boolean))];
        rows.push({ group: g.code, code, from: recs.map((r) => r.warehouse), caps, conflict: caps.length > 1, merged, exist: !!exist, recs });
      }
    }
    return rows.sort((a, b) => a.group.localeCompare(b.group) || a.code.localeCompare(b.code, 'vi', { numeric: true }));
  }, [groups, locations, capRule]);

  const run = async (label, fn) => {
    setErr(''); setMsg(''); setBusy(label);
    try { setMsg(await fn()); } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  // Tồn kho thực tế → số pallet từng vị trí (theo kho chung)
  const palletsByLoc = async () => {
    const s = await getDocs(collection(db, 'stock'));
    const m = new Map();
    for (const d of s.docs) {
      const r = d.data();
      if (!r.location) continue;
      const k = `${locWh(r.warehouse)}__${r.location}`;
      m.set(k, r3(n(m.get(k)) + Math.max(0, n(r.pallets))));
    }
    return m;
  };
  const locFields = (rec, pallets) => {
    const cap = noCapacity(rec.warehouse) ? null : rec.capacity;
    return { currentPallets: pallets, usedPct: n(cap) ? Math.round((pallets / n(cap)) * 1000) / 10 : null, emptyBin: pallets < 1e-6 };
  };

  const doMerge = () => run('merge', async () => {
    if (!plan.length) return 'Không có vị trí nào cần gộp.';
    if (!window.confirm(`Gộp ${plan.length} vị trí vào kho chung? Bản ghi vị trí riêng của từng kho pháp nhân (${plan.reduce((s, p) => s + p.recs.length, 0)} bản ghi) sẽ được xóa sau khi gộp. Tồn kho, phiếu không đổi.`)) return '';
    const pal = await palletsByLoc();
    const at = nowISO();
    const ops = [];
    for (const p of plan) {
      const rec = { warehouse: p.group, code: p.code, ...p.merged };
      ops.push({ ref: doc(db, 'locations', locDocId(p.group, p.code)), merge: true,
        data: { ...rec, ...locFields(rec, pal.get(`${p.group}__${p.code}`) || 0), mergedFrom: p.from, updatedAt: at, updatedBy: email } });
      for (const r of p.recs) ops.push({ ref: doc(db, 'locations', r._id), del: true });
    }
    await commitAll(ops);
    return `Đã gộp ${plan.length} vị trí vào kho chung, tính lại số pallet đang chứa.`;
  });

  const doRecount = () => run('recount', async () => {
    const pal = await palletsByLoc();
    const at = nowISO();
    const ops = locations.map((l) => ({ ref: doc(db, 'locations', l._id), merge: true, data: { ...locFields(l, pal.get(`${l.warehouse}__${l.code}`) || 0), updatedAt: at, updatedBy: email } }));
    await commitAll(ops);
    const orphan = [...pal.keys()].filter((k) => !locations.some((l) => `${l.warehouse}__${l.code}` === k));
    return `Đã tính lại ${ops.length} vị trí.` + (orphan.length ? ` Có ${orphan.length} vị trí đang có tồn nhưng chưa khai báo: ${orphan.slice(0, 15).map((k) => k.replace('__', ' · ')).join(', ')}${orphan.length > 15 ? '…' : ''}` : '');
  });

  // 3. Tạo vị trí hàng loạt
  const [gen, setGen] = useState({ wh: '', prefixes: 'A-E', from: 1, to: 29, digits: 2, capacity: 14 });
  const genCodes = expandRange(gen.prefixes, gen.from, gen.to, gen.digits);
  const genNew = genCodes.filter((c) => !locations.some((l) => l.warehouse === gen.wh && l.code === c));
  const doGen = () => run('gen', async () => {
    if (!gen.wh) throw new Error('Chọn kho hoặc kho chung.');
    if (!genNew.length) return 'Các vị trí này đã có, không tạo thêm.';
    const at = nowISO();
    const cap = noCapacity(gen.wh) || !n(gen.capacity) ? null : n(gen.capacity);
    await commitAll(genNew.map((code) => ({ ref: doc(db, 'locations', locDocId(gen.wh, code)),
      data: { warehouse: gen.wh, code, capacity: cap, currentPallets: 0, usedPct: cap ? 0 : null, emptyBin: true, createdAt: at, createdBy: email, updatedAt: at, updatedBy: email } })));
    return `Đã tạo ${genNew.length} vị trí ở ${gen.wh} (${genNew[0]} → ${genNew[genNew.length - 1]}), sức chứa ${cap ? `${cap} pallet` : 'không giới hạn'}.`;
  });

  if (!isAdmin) return <div className="card">Chỉ quản trị dùng được trang này.</div>;
  const whOpts = [...groups.map((g) => ({ v: g.code, l: `${g.code} – ${g.name || ''} (kho chung)` })),
    ...warehouses.filter((w) => w.active !== false && locWh(w.code) === w.code).map((w) => ({ v: w.code, l: `${w.code} – ${w.name || ''}` }))];
  return (
    <div>
      <div className="page-head"><h1>🏭 Kho chung & vị trí dùng chung</h1>
        <div className="actions"><Link className="btn" to="/dm/warehouseGroups">Danh mục Kho chung</Link><Link className="btn" to="/dm/locations">Vị trí lưu trữ</Link></div></div>
      <ErrorBox error={err} />
      {msg && <div className="card" style={{ borderColor: 'var(--green)' }}>✅ {msg}</div>}

      <div className="card">
        <h3>1. Kho chung đang thiết lập</h3>
        {!groups.length && <p className="hint">Chưa có kho chung. Vào <Link to="/dm/warehouseGroups">Danh mục Kho chung</Link> thêm VD: DUCHOA (VAP-Đức Hòa, PLA-Đức Hòa), CANG (VAP-Cảng, PLA-Cảng, DAM-Cảng), MUANOIDIA (VAP-Mua nội địa, PLA-Mua nội địa).</p>}
        {groups.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Kho chung</th><th>Tên</th><th>Gồm các kho</th><th>Sức chứa</th><th className="num">Số vị trí</th><th className="num">Empty bin</th></tr></thead>
            <tbody>{groups.map((g) => {
              const ls = locations.filter((l) => l.warehouse === g.code);
              return <tr key={g.code}><td className="mono">{g.code}</td><td>{g.name}</td>
                <td>{g.members.map((m) => `${m}${warehouses.find((w) => w.code === m)?.company ? ` (${warehouses.find((w) => w.code === m).company})` : ''}`).join(', ')}</td>
                <td>{g.noCapacity ? 'Không cần sức chứa' : 'Theo từng vị trí'}</td><td className="num">{ls.length}</td><td className="num">{ls.filter((l) => !n(l.currentPallets)).length}</td></tr>;
            })}</tbody>
          </table></div>
        )}
        {issues.map((x) => <p key={x} className="req">⚠ {x}</p>)}
      </div>

      <div className="card">
        <h3>2. Gộp vị trí cũ vào kho chung</h3>
        <p className="hint">Vị trí đang khai báo riêng ở từng kho pháp nhân (VD Cát Lái ở VAP-Cảng và PLA-Cảng) gộp thành 1 vị trí của kho chung. Tồn kho, phiếu, đơn không đổi.</p>
        <div className="filters">
          <Field label="Vị trí trùng mã có sức chứa khác nhau">
            <Select value={capRule} onChange={(e) => setCapRule(e.target.value)}>
              <option value="max">Lấy sức chứa lớn nhất</option><option value="sum">Cộng sức chứa các kho</option>
            </Select>
          </Field>
          <button className="btn primary" disabled={!!busy || !plan.length || !isSuper} title={isSuper ? '' : 'Chỉ quản trị gốc (được xóa bản ghi vị trí cũ)'} onClick={doMerge}>{busy === 'merge' ? 'Đang gộp…' : `🔗 Gộp ${plan.length} vị trí`}</button>
        </div>
        {plan.length > 0 ? (
          <div className="table-wrap" style={{ maxHeight: 360 }}><table>
            <thead><tr><th>Kho chung</th><th>Vị trí</th><th>Đang khai báo ở kho</th><th>Sức chứa đang có</th><th className="num">Sức chứa sau gộp</th><th>Ghi chú</th></tr></thead>
            <tbody>{plan.map((p) => (
              <tr key={p.group + p.code} style={p.conflict ? { background: '#fff6e0' } : undefined}>
                <td className="mono">{p.group}</td><td className="mono">{p.code}</td><td>{p.from.join(', ')}</td>
                <td>{p.caps.map((c) => fmtNum(c)).join(' / ') || '—'}</td><td className="num">{p.merged.capacity ? fmtNum(p.merged.capacity) : '—'}</td>
                <td className="small">{p.conflict ? 'Sức chứa khác nhau' : ''}{p.exist ? ' Đã có ở kho chung (bổ sung)' : ''}</td>
              </tr>))}
            </tbody>
          </table></div>
        ) : <p className="small">Không còn vị trí nào khai báo riêng ở kho pháp nhân thuộc kho chung.</p>}
      </div>

      <div className="card">
        <h3>3. Tạo vị trí hàng loạt</h3>
        <div className="form-grid">
          <Field label="Kho / Kho chung" required>
            <Select value={gen.wh} onChange={(e) => setGen({ ...gen, wh: e.target.value })}>
              <option value="">-- Chọn --</option>{whOpts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </Select>
          </Field>
          <Field label="Dãy" help="VD A-E (A, B, C, D, E) hoặc A,E"><input value={gen.prefixes} onChange={(e) => setGen({ ...gen, prefixes: e.target.value })} /></Field>
          <Field label="Từ số"><input type="number" value={gen.from} onChange={(e) => setGen({ ...gen, from: e.target.value })} /></Field>
          <Field label="Đến số"><input type="number" value={gen.to} onChange={(e) => setGen({ ...gen, to: e.target.value })} /></Field>
          <Field label="Số chữ số" help="2 → A01"><input type="number" value={gen.digits} onChange={(e) => setGen({ ...gen, digits: e.target.value })} /></Field>
          <Field label="Sức chứa (pallet)" help={noCapacity(gen.wh) ? 'Kho này không cần sức chứa' : 'Bỏ trống: không giới hạn'}>
            <input type="number" value={gen.capacity} disabled={noCapacity(gen.wh)} onChange={(e) => setGen({ ...gen, capacity: e.target.value })} /></Field>
        </div>
        <p className="small">{genCodes.length} vị trí: {genCodes.slice(0, 6).join(', ')}{genCodes.length > 6 ? ` … ${genCodes[genCodes.length - 1]}` : ''} · mới {genNew.length}, đã có {genCodes.length - genNew.length}</p>
        <button className="btn primary" disabled={!!busy || !gen.wh || !genNew.length} onClick={doGen}>{busy === 'gen' ? 'Đang tạo…' : `➕ Tạo ${genNew.length} vị trí`}</button>
      </div>

      <div className="card">
        <h3>4. Tính lại số pallet đang chứa</h3>
        <p className="hint">Cộng pallet tồn kho thực tế của mọi pháp nhân theo từng vị trí (vị trí dùng chung cộng chung), cập nhật % lưu trữ và Empty bin.</p>
        <button className="btn" disabled={!!busy} onClick={doRecount}>{busy === 'recount' ? 'Đang tính…' : '🔄 Tính lại'}</button>
      </div>
    </div>
  );
}
