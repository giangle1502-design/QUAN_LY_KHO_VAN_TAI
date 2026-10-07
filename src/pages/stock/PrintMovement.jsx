import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { MOVE_TYPES } from '../../lib/stock';
import { fmtDate, fmtNum } from '../../lib/utils';

// Bản in phiếu kho (In → Lưu PDF hoặc in giấy A4)
export default function PrintMovement() {
  const { id } = useParams();
  const { settings } = useApp();
  const [m, setM] = useState(undefined);
  const [trip, setTrip] = useState(null);
  const [wh, setWh] = useState(null);
  const [co, setCo] = useState(null);

  useEffect(() => {
    getDoc(doc(db, 'movements', id)).then(async (s) => {
      const d = s.exists() ? s.data() : null;
      setM(d);
      if (d?.tripId) getDoc(doc(db, 'trips', d.tripId)).then((t) => t.exists() && setTrip(t.data())).catch(() => {});
      const c = d?.company || d?.lines?.find((l) => l.company)?.company;
      if (c) getDoc(doc(db, 'companies', c)).then((x) => setCo(x.exists() ? x.data() : { code: c, name: c })).catch(() => setCo({ code: c, name: c }));
      if (d?.warehouse) getDoc(doc(db, 'warehouses', d.warehouse)).then((w) => w.exists() && setWh(w.data())).catch(() => {});
    }).catch(() => setM(null));
  }, [id]);

  if (m === undefined) return <div className="center">Đang tải…</div>;
  if (!m) return <div className="center">Không tìm thấy phiếu {id}.</div>;
  const meta = MOVE_TYPES[m.type];
  const tot = (k) => m.lines.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  const signs = m.type === 'out'
    ? ['Người lập phiếu', 'Thủ kho', 'Tài xế / Người nhận', 'Bảo vệ']
    : m.type === 'in' ? ['Người lập phiếu', 'Thủ kho', 'Người giao hàng', 'Bảo vệ'] : ['Người lập phiếu', 'Thủ kho', 'Kế toán', 'Người duyệt'];

  return (
    <div className="print-page">
      <div className="no-print toolbar">
        <Link className="btn" to="/kho/phieu">← Phiếu kho</Link>
        <button className="btn primary" onClick={() => window.print()}>🖨 In / Lưu PDF</button>
        {m.type === 'in' && m.status !== 'cancelled' && <Link className="btn" to={`/kho/phieu/${m.id}/nhan`}>🏷️ In nhãn pallet</Link>}
      </div>
      <div className="print-head">
        <div><b>{co?.name || settings.companyName}</b>{(co ? co.address : settings.companyAddress) ? <><br /><span className="small">{co ? co.address : settings.companyAddress}</span></> : null}{co?.taxCode ? <><br /><span className="small">MST {co.taxCode}</span></> : null}<br /><span className="small">{wh ? `${wh.name}${wh.address ? ' – ' + wh.address : ''}` : `Kho ${m.warehouse}`}</span></div>
        <div style={{ textAlign: 'right' }}>Số: <b>{m.id}</b><br /><span className="small">Ngày {fmtDate(m.date)}</span></div>
      </div>
      <h2 className="print-title">PHIẾU {meta.label.toUpperCase()}</h2>
      {m.status === 'cancelled' && <div className="error-box">PHIẾU ĐÃ HỦY: {m.cancelReason}</div>}
      <table className="print-info"><tbody>
        {co && <tr><td>Công ty chủ hàng</td><td>{co.code}{co.name && co.name !== co.code ? ` – ${co.name}` : ''}</td></tr>}
        {(m.partyCode || m.partyName) && <tr><td>{m.type === 'in' ? 'Nhà cung cấp' : 'Khách hàng'}</td><td>{m.partyCode} {m.partyName}</td></tr>}
        {m.shipCode && <tr><td>Giao đến</td><td>{m.shipCode}</td></tr>}
        {(m.carrier || m.carrierName) && <tr><td>Đơn vị vận tải</td><td>{m.carrierName || m.carrier}</td></tr>}
        {m.plate && <tr><td>Số xe</td><td>{m.plate}</td></tr>}
        {m.driverName && <tr><td>Tài xế</td><td>{m.driverName}{m.idCard ? ` · CCCD ${m.idCard}` : ''}{m.driverPhone ? ` · ĐT ${m.driverPhone}` : ''}</td></tr>}
        {m.orderId && <tr><td>{m.type === 'in' ? 'Theo đơn mua' : 'Theo đơn bán'}</td><td>{m.orderId}{m.orderRef ? ` (số Ecount ${m.orderRef})` : ''}</td></tr>}
        {trip && <tr><td>Xe</td><td>{trip.plate} · {trip.driverName} · CCCD {trip.idCard}{trip.carrierName ? ` · ${trip.carrierName}` : ''} · chuyến {m.tripId}{trip.dock ? ` · cửa ${trip.dock}` : ''}</td></tr>}
        {m.reason && <tr><td>Lý do</td><td>{m.reason}</td></tr>}
        {m.note && <tr><td>Ghi chú</td><td>{m.note}</td></tr>}
      </tbody></table>
      <table className="print-lines">
        <thead><tr><th>STT</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Vị trí</th>{m.type === 'move' && <th>Đến vị trí</th>}
          <th>Tình trạng</th>{m.type === 'status' && <th>Tình trạng mới</th>}<th className="num">Số bao</th><th className="num">Pallet</th><th className="num">Kg</th></tr></thead>
        <tbody>
          {m.lines.map((l, i) => (
            <tr key={i}><td>{i + 1}</td><td>{l.item}</td><td>{l.itemName}</td><td>{l.lot}</td><td>{l.location}</td>{m.type === 'move' && <td>{l.toLocation}</td>}
              <td>{l.goodsStatus}</td>{m.type === 'status' && <td>{l.toStatus}{l.toPledgee ? ` (${l.toPledgee})` : ''}</td>}
              <td className="num">{fmtNum(l.bags)}</td><td className="num">{fmtNum(l.pallets, 2)}</td><td className="num">{fmtNum(l.kg)}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={m.type === 'move' || m.type === 'status' ? 7 : 6}>Cộng</td><td className="num">{fmtNum(tot('bags'))}</td><td className="num">{fmtNum(tot('pallets'), 2)}</td><td className="num">{fmtNum(tot('kg'))}</td></tr></tfoot>
      </table>
      <div className="print-signs">
        {signs.map((s) => <div key={s}><b>{s}</b><br /><span className="small">(Ký, ghi rõ họ tên)</span><div className="sign-space" />{s === 'Người lập phiếu' ? m.createdByName : ''}</div>)}
      </div>
    </div>
  );
}
