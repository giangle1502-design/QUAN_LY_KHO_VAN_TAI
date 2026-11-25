import { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { JOB_PRICING, allocate, createJob, extraStops, jobFreight, jobStops, pricingOf } from '../../lib/jobs';
import { tripKg } from '../../lib/transport';
import { calcCosts, useCostFields } from '../../lib/tripCosts';
import { fmtNum } from '../../lib/utils';
import { ErrorBox, Modal } from '../../components/ui';
import PlateDriver from '../../components/PlateDriver';
import Select from '../../components/Select';

const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
const t3 = (kg) => fmtNum(n(kg) / 1000, 3);
const nowISO = () => new Date().toISOString();

// 🔗 Ghép Job: 1 xe chạy nhiều Shipment (nhiều điểm lấy / giao). Sắp thứ tự, nhập xe, kiểm tải trọng
export function JobModal({ trips: init, carrier, onClose }) {
  const { email, name } = useApp();
  const [trips, setTrips] = useState(() => [...init].sort((a, b) => String(a.plannedDate + a.id).localeCompare(String(b.plannedDate + b.id))));
  const t0 = init.find((t) => t.plate) || {};
  const [v, setV] = useState({ plate: t0.plate || '', vehicleType: t0.vehicleType || '', payload: '', driverName: t0.driverName || '', idCard: t0.idCard || '', driverPhone: t0.driverPhone || '' });
  const [cap, setCap] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const total = trips.reduce((s, t) => s + tripKg(t), 0);
  const stops = jobStops(trips.map((t, i) => ({ ...t, jobSeq: i + 1 })));
  const capKg = n(cap || v.payload) * 1000;
  const move = (i, d) => setTrips((ts) => { const x = [...ts]; const j = i + d; if (j < 0 || j >= x.length) return x; [x[i], x[j]] = [x[j], x[i]]; return x; });
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const id = await createJob({ trips, carrier, vehicle: v, cap: cap || v.payload }, { email, name });
      onClose(`Đã ghép Job ${id}: ${trips.length} Shipment, ${stops.filter((s) => s.kind === 'pick').length} điểm lấy, ${stops.filter((s) => s.kind === 'drop').length} điểm giao.`);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền ghép Job (dán lại firestore.rules mới).' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`🔗 Ghép Job · ${carrier?.name || carrier?.code || ''}`} onClose={() => onClose()} wide>
      <p className="small">1 xe chạy nhiều Shipment. Sắp thứ tự tài xế đi (lấy hàng trước, giao sau). Các Shipment cùng giao 1 khách được in chung 1 phiếu giao hàng.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Shipment</th><th>Lấy tại</th><th>Giao đến</th><th className="num">Tấn</th><th></th></tr></thead>
        <tbody>{trips.map((t, i) => (
          <tr key={t.id}><td>{i + 1}</td><td className="mono">{t.id}</td><td>{t.pickupName || t.warehouseName || t.warehouse}</td>
            <td>{t.lines?.[0]?.partyName || t.lines?.[0]?.partyCode}{t.lines?.[0]?.shipCode ? <div className="small">{t.lines[0].shipCode}</div> : null}</td>
            <td className="num">{t3(tripKg(t))}</td>
            <td className="nowrap"><button type="button" className="btn ghost sm" disabled={!i} onClick={() => move(i, -1)}>▲</button><button type="button" className="btn ghost sm" disabled={i === trips.length - 1} onClick={() => move(i, 1)}>▼</button></td></tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={4}><b>Tổng Job</b> · {stops.filter((s) => s.kind === 'pick').length} điểm lấy, {stops.filter((s) => s.kind === 'drop').length} điểm giao</td><td className="num"><b>{t3(total)}</b></td><td /></tr></tfoot>
      </table></div>
      <p className="small" style={{ margin: '8px 0 4px' }}>Lộ trình: {stops.map((s) => `${s.kind === 'pick' ? '⬆ lấy' : '⬇ giao'} ${s.name} (${t3(s.kg)} t)`).join(' → ')}</p>
      <PlateDriver carrier={carrier?.code} value={v} onChange={(p) => setV((x) => ({ ...x, ...p }))} />
      <div className="filters" style={{ marginTop: 6 }}>
        <label>Tải trọng xe (tấn) <input type="number" step="0.5" value={cap || v.payload || ''} onChange={(e) => setCap(e.target.value)} style={{ width: 90 }} /></label>
        {capKg > 0 && <span className="small" style={{ color: total > capKg + 1 ? 'var(--red)' : 'var(--green)' }}>{total > capKg + 1 ? `⚠ vượt ${t3(total - capKg)} tấn` : `✓ còn trống ${t3(capKg - total)} tấn`}</span>}
      </div>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={() => onClose()}>Thôi</button>
        <button className="btn primary" disabled={busy || (capKg > 0 && total > capKg + 1)} onClick={save}>{busy ? 'Đang ghép…' : '🔗 Ghép Job'}</button></div>
    </Modal>
  );
}

// 💰 Cước Job: tính theo cách của đơn vị vận tải (A / B / C) rồi phân bổ về từng Shipment theo tấn
export function JobCostModal({ jobId, trips, carrier, onClose }) {
  const { email, name } = useApp();
  const rates = useCollection('freightRates').rows;
  const fields = useCostFields();
  const [method, setMethod] = useState(pricingOf(carrier));
  const [fee, setFee] = useState(n(carrier?.extraStopFee) || '');
  const [manual, setManual] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fr = jobFreight(trips, rates, method, fee);
  const amount = method === 'C' || manual !== '' ? n(manual) : n(fr.amount);
  const parts = allocate(amount, trips);
  const approved = trips.some((t) => t.costStatus === 'approved');
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      for (const p of parts) {
        const t = trips.find((x) => x.id === p.id);
        const base = { ...(t.costs || {}), freight: p.amount, note: `Cước Job ${jobId} (${method}) phân bổ theo tấn`, jobId };
        const costs = { ...base, ...calcCosts(base, fields, { kg: tripKg(t) }) };
        await updateDoc(doc(db, 'trips', t.id), { costs, costStatus: 'entered', costBy: email, costAt: nowISO(), updatedAt: nowISO(), updatedBy: email,
          history: [...(t.history || []), { at: nowISO(), by: email, byName: name, action: `Cước Job ${jobId}: ${fmtNum(p.amount)} đ (${t3(p.kg)} t / tổng ${fmtNum(amount)} đ, cách ${method})` }] });
      }
      await updateDoc(doc(db, 'jobs', jobId), { pricing: { method, extraStopFee: n(fee), amount, extraStops: fr.extra, by: email, at: nowISO() }, updatedAt: nowISO(), updatedBy: email }).catch(() => {});
      onClose(`Đã nhập cước Job ${jobId}: ${fmtNum(amount)} đ, phân bổ cho ${parts.length} Shipment.`);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Không có quyền nhập cước.' : e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`💰 Cước Job ${jobId}`} onClose={() => onClose()} wide>
      <div className="filters">
        <label>Cách tính <Select value={method} onChange={(e) => { setMethod(e.target.value); setManual(''); }}>{Object.entries(JOB_PRICING).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
        {method === 'A' && <label>Phí mỗi điểm thêm (đ) <input type="number" value={fee} onChange={(e) => setFee(e.target.value)} style={{ width: 120 }} /></label>}
        <span className="small">{extraStops(trips)} điểm thêm (ngoài 1 điểm lấy + 1 điểm giao)</span>
      </div>
      <p className="small">{fr.detail}{fr.amount != null ? ` = ${fmtNum(fr.amount)} đ` : ''}</p>
      <label className="field"><span>Tổng cước Job (đ){method === 'C' ? ' *' : ' (sửa nếu khác gợi ý)'}</span>
        <input type="number" value={method === 'C' || manual !== '' ? manual : n(fr.amount) || ''} onChange={(e) => setManual(e.target.value)} style={{ maxWidth: 200 }} /></label>
      <div className="table-wrap"><table>
        <thead><tr><th>Shipment</th><th className="num">Tấn</th><th className="num">Cước bảng giá riêng</th><th className="num">Phân bổ (đ)</th></tr></thead>
        <tbody>{parts.map((p) => <tr key={p.id}><td className="mono">{p.id}</td><td className="num">{t3(p.kg)}</td><td className="num">{fmtNum(fr.per.find((x) => x.id === p.id)?.sug?.amount || 0)}</td><td className="num"><b>{fmtNum(p.amount)}</b></td></tr>)}</tbody>
        <tfoot><tr><td><b>Tổng</b></td><td className="num">{t3(parts.reduce((s, p) => s + p.kg, 0))}</td><td /><td className="num"><b>{fmtNum(amount)}</b></td></tr></tfoot>
      </table></div>
      <p className="small">Ghi vào ô Cước của từng Shipment (giữ phụ thu, chi hộ… đã nhập). Kế toán chốt từng Shipment như cũ.</p>
      {approved && <div className="error-box">Có Shipment kế toán đã chốt chi phí: không sửa được cước Job.</div>}
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={() => onClose()}>Thôi</button>
        <button className="btn primary" disabled={busy || approved || !amount} onClick={save}>{busy ? 'Đang lưu…' : '💾 Lưu cước Job'}</button></div>
    </Modal>
  );
}
