import { useEffect, useState } from 'react';
import { SlipQr } from '../../lib/qr';
import { Link, useParams } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useCollection } from '../../lib/hooks';
import { dropKey, jobStops, pickName } from '../../lib/jobs';
import { fmtDate, fmtNum } from '../../lib/utils';

const n = (v) => (v === '' || v == null ? 0 : Number(v) || 0);

// Phiếu giao hàng gộp của 1 Job: các Shipment cùng giao 1 khách / 1 điểm giao in chung 1 phiếu
// (hàng lấy ở nhiều kho: Đức Hòa, Sotrans, Linh Phát… cộng đủ trên 1 phiếu). Mỗi điểm giao 1 trang.
export default function PrintJob() {
  const { id } = useParams();
  const companies = useCollection('companies').rows;
  const [job, setJob] = useState(undefined);
  const [trips, setTrips] = useState([]);
  const [moves, setMoves] = useState([]);
  useEffect(() => {
    (async () => {
      const j = await getDoc(doc(db, 'jobs', id)).then((s) => (s.exists() ? s.data() : null)).catch(() => null);
      const ts = await getDocs(query(collection(db, 'trips'), where('jobId', '==', id))).then((q) => q.docs.map((d) => ({ ...d.data(), id: d.id }))).catch(() => []);
      // Phiếu xuất kho gắn với các Shipment (nếu đã lập): ghi số phiếu xuất lên phiếu giao
      const ms = ts.length ? await getDocs(query(collection(db, 'movements'), where('tripId', 'in', ts.map((t) => t.id).slice(0, 10)))).then((q) => q.docs.map((d) => ({ ...d.data(), id: d.id }))).catch(() => []) : [];
      setTrips(ts.filter((t) => t.status !== 'cancelled').sort((a, b) => n(a.jobSeq) - n(b.jobSeq)));
      setMoves(ms.filter((m) => m.status !== 'cancelled'));
      setJob(j);
    })();
  }, [id]);
  if (job === undefined) return <div className="center">Đang tải…</div>;
  if (!job || !trips.length) return <div className="center">Không tìm thấy Job {id}.</div>;
  const drops = jobStops(trips).filter((s) => s.kind === 'drop');
  const picks = jobStops(trips).filter((s) => s.kind === 'pick');
  const t0 = trips[0];
  const co = companies.find((c) => c.code === t0.company);
  return (
    <div>
      <div className="no-print toolbar" style={{ padding: 10, display: 'flex', gap: 8 }}>
        <Link className="btn" to="/van-tai?tab=chuyen">← Shipment</Link>
        <button className="btn primary" onClick={() => window.print()}>🖨 In ({drops.length} phiếu)</button>
        <span className="small">Job {id} · {trips.length} Shipment · {picks.length} điểm lấy · {drops.length} điểm giao</span>
      </div>
      {drops.map((d) => {
        const ts = trips.filter((t) => dropKey(t) === d.key);
        const rows = ts.flatMap((t) => (t.lines || []).map((l) => ({ t, l, px: moves.filter((m) => m.tripId === t.id && m.orderId === l.orderId).map((m) => m.id).join(', ') })));
        const total = rows.reduce((s, r) => s + n(r.l.plannedKg), 0);
        const l0 = ts[0].lines?.[0] || {};
        return (
          <div key={d.key} className="print-page" style={{ pageBreakAfter: 'always', padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>{co?.logo && <img src={co.logo} alt="" style={{ height: 48 }} />}<div><b>{co?.name || t0.company}</b></div>{co?.address && <div className="small">{co.address}</div>}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ textAlign: 'right' }} className="small">Số: <b>{id}{drops.length > 1 ? `-${drops.indexOf(d) + 1}` : ''}</b><br />Ngày: {fmtDate(job.date || t0.plannedDate)}</div>
                <SlipQr id={id} tripId={ts[0].id} size={20} />
              </div>
            </div>
            <h2 style={{ textAlign: 'center', margin: '14px 0 4px' }}>PHIẾU GIAO HÀNG</h2>
            <div style={{ textAlign: 'center' }} className="small">(gộp {ts.length} Shipment: {ts.map((t) => t.id).join(', ')})</div>
            <table style={{ width: '100%', margin: '12px 0' }}><tbody>
              <tr><td style={{ width: '50%', verticalAlign: 'top' }}><b>Bên nhận:</b> {l0.partyName || l0.partyCode}<br />{l0.shipCode && <>Mã giao: {l0.shipCode}<br /></>}Địa chỉ giao: {l0.address || d.address}<br />{(l0.contact || l0.contactPhone) && <>Người nhận: {l0.contact} {l0.contactPhone}</>}</td>
                <td style={{ verticalAlign: 'top' }}><b>Vận chuyển:</b> {job.carrierName || job.carrier}<br />Số xe: <b>{t0.plate || job.plate}</b><br />Tài xế: {t0.driverName || job.driverName}{(t0.idCard || job.idCard) ? ` · CCCD ${t0.idCard || job.idCard}` : ''}{(t0.driverPhone || job.driverPhone) ? ` · ${t0.driverPhone || job.driverPhone}` : ''}</td></tr>
            </tbody></table>
            <table className="print-lines" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['STT', 'Đơn hàng', 'Phiếu xuất', 'Mã hàng', 'Tên hàng', 'Lấy tại', 'Số lượng (kg)'].map((h) => <th key={h} style={{ background: '#000', color: '#fff', fontWeight: 700, textAlign: 'center', verticalAlign: 'middle', border: '1px solid #000', padding: 4 }}>{h}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={`${r.t.id}${r.l.id}`}>{[i + 1, r.l.orderId, r.px, r.l.item, r.l.itemName, pickName(r.t), fmtNum(n(r.l.plannedKg))].map((v, k) => <td key={k} style={{ border: '1px solid #000', padding: 4, textAlign: k === 6 ? 'right' : 'center', verticalAlign: 'middle' }}>{v}</td>)}</tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={6} style={{ border: '1px solid #000', padding: 4, textAlign: 'center', fontWeight: 700 }}>Tổng cộng</td><td style={{ border: '1px solid #000', padding: 4, textAlign: 'right', fontWeight: 700 }}>{fmtNum(total)}</td></tr></tfoot>
            </table>
            <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: 30, textAlign: 'center' }}>
              {['Bên giao', 'Tài xế', 'Bên nhận'].map((x) => <div key={x}><b>{x}</b><div className="small">(Ký, ghi rõ họ tên)</div><div style={{ height: 70 }} /></div>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
