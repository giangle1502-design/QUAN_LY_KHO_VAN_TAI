import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useOpCompany, useOpWarehouse } from '../../lib/hooks';
import { MOVE_TYPES, cancelMovement } from '../../lib/stock';
import { fmtTime, vnDate } from '../../lib/trips';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum } from '../../lib/utils';
import { CompanyPicker, WarehousePicker } from '../../components/TripBits';
import { Empty, ErrorBox, Modal } from '../../components/ui';

const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const tot = (m, k) => (m.lines || []).reduce((s, l) => s + (Number(l[k]) || 0), 0);

export default function Movements() {
  const { inMyWarehouses } = useApp();
  const [wh, setWh] = useOpWarehouse();
  const [range, setRange] = useState({ from: addDays(vnDate(), -30), to: vnDate() });
  const [type, setType] = useState('');
  const [co, setCo] = useOpCompany();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const qy = query(collection(db, 'movements'), where('date', '>=', range.from || '0000'), where('date', '<=', range.to || '9999'));
    return onSnapshot(qy, (s) => setRows(s.docs.map((d) => ({ ...d.data(), id: d.id }))), (e) => setError(e.message));
  }, [range.from, range.to]);

  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    return rows
      .filter((m) => inMyWarehouses(m.warehouse) && (!wh || m.warehouse === wh) && (!type || m.type === type) && (!co || m.company === co || (m.lines || []).some((l) => l.company === co)))
      .filter((m) => !f || [m.id, m.tripId, m.plate, m.driverName, m.carrierName, m.orderId, m.orderRef, m.partyCode, m.partyName, ...(m.lines || []).flatMap((l) => [l.item, l.lot, l.location])].join(' ').toLowerCase().includes(f))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [rows, inMyWarehouses, wh, type, q, co]);
  const current = open && rows.find((m) => m.id === open);

  const exportExcel = () => {
    const out = [];
    list.forEach((m) => m.lines.forEach((l) => out.push({
      'Số phiếu': m.id, Loại: MOVE_TYPES[m.type]?.label, 'Ngày': m.date, Kho: m.warehouse, 'Công ty': m.company || '', 'Chuyến xe': m.tripId, 'Số xe': m.plate || '', 'Đơn vị vận tải': m.carrierName || m.carrier || '', 'Tài xế': m.driverName || '', 'CCCD tài xế': m.idCard || '', 'ĐT tài xế': m.driverPhone || '', 'Đơn SO/PO': m.orderId || '', 'Số Ecount': m.orderRef || '',
      'Mã KH/NCC': m.partyCode, 'Tên KH/NCC': m.partyName, 'Mã hàng': l.item, 'Tên hàng': l.itemName, Lot: l.lot,
      'Vị trí': l.location, 'Đến vị trí': l.toLocation || '', 'Tình trạng': l.goodsStatus, 'Tình trạng mới': l.toStatus || '',
      'Số bao': l.bags, Pallet: l.pallets, Kg: l.kg, 'Lý do': m.reason, 'Trạng thái': m.status === 'cancelled' ? 'Đã hủy' : '',
      'Người lập': m.createdByName || m.createdBy,
    })));
    exportSheets(`Phieu_kho_${range.from}_${range.to}`, { 'Phiếu kho': out.length ? out : [{ 'Số phiếu': '' }] });
  };

  return (
    <div>
      <div className="page-head"><h1>🧾 Phiếu kho</h1><button className="btn" onClick={exportExcel}>⬇ Excel</button></div>
      <div className="filters">
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        <span>→</span>
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        <WarehousePicker value={wh} onChange={setWh} />
        <CompanyPicker value={co} onChange={setCo} />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Tất cả loại phiếu</option>
          {Object.entries(MOVE_TYPES).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <input type="search" placeholder="Tìm số phiếu, mã hàng, lot, khách…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {!list.length ? <Empty /> : (
          <table>
            <thead><tr><th>Số phiếu</th><th>Loại</th><th>Ngày</th><th>Kho</th><th>Công ty</th><th>Số xe / chuyến</th><th>Đơn</th><th>Khách / NCC</th><th>Mặt hàng</th>
              <th className="num">Số bao</th><th className="num">Kg</th><th>Người lập</th><th></th></tr></thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id} onClick={() => setOpen(m.id)} style={{ cursor: 'pointer', opacity: m.status === 'cancelled' ? 0.5 : 1 }}>
                  <td className="mono nowrap">{m.id}</td><td className="nowrap">{MOVE_TYPES[m.type]?.icon} {MOVE_TYPES[m.type]?.label}</td>
                  <td className="nowrap">{fmtDate(m.date)}</td><td>{m.warehouse}</td><td>{m.company || [...new Set((m.lines || []).map((l) => l.company).filter(Boolean))].join(', ')}</td><td className="mono">{m.plate ? <span className="plate">{m.plate}</span> : m.tripId}</td><td className="mono">{m.orderId}</td>
                  <td>{m.partyName || m.partyCode}</td><td>{[...new Set(m.lines.map((l) => l.item))].join(', ')}</td>
                  <td className="num">{fmtNum(tot(m, 'bags'))}</td><td className="num">{fmtNum(tot(m, 'kg'))}</td>
                  <td className="small">{m.createdByName || m.createdBy}</td>
                  <td className="nowrap" onClick={(e) => e.stopPropagation()}>{m.status === 'cancelled' ? <span className="badge red">Đã hủy</span>
                    : m.type === 'in' ? <Link className="btn sm" to={`/kho/phieu/${m.id}/nhan`} target="_blank">🏷️ In nhãn</Link>
                    : m.type === 'out' ? <Link className="btn sm" to={`/kho/phieu/${m.id}/soan`} target="_blank">📋 Soạn hàng</Link> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {current && <Detail m={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Detail({ m, onClose }) {
  const { isAdmin, email, name } = useApp();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setErr(''); setBusy(true);
    try { await cancelMovement(m, reason, { email, name }); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`${MOVE_TYPES[m.type]?.label} ${m.id}`} onClose={onClose} wide>
      <p>
        Ngày {fmtDate(m.date)} · Kho {m.warehouse}{m.tripId ? ` · Chuyến ${m.tripId}` : ''}{m.orderId ? ` · Đơn ${m.orderId}${m.orderRef ? ` (${m.orderRef})` : ''}` : ''}
        {m.partyCode || m.partyName ? ` · ${m.partyCode} ${m.partyName}` : ''}{m.shipCode ? ` · giao ${m.shipCode}` : ''}
        {m.reason ? ` · Lý do: ${m.reason}` : ''}
      </p>
      {m.note && <p className="small">Ghi chú: {m.note}</p>}
      <p><Link className="btn sm" to={`/kho/phieu/${m.id}/in`} target="_blank">🖨 In phiếu</Link>
        {m.type === 'in' && m.status !== 'cancelled' && <> <Link className="btn sm" to={`/kho/phieu/${m.id}/nhan`} target="_blank">🏷️ In nhãn pallet</Link></>}
        {m.type === 'out' && <> <Link className="btn sm" to={`/kho/phieu/${m.id}/soan`} target="_blank">📋 Phiếu soạn hàng</Link></>}</p>
      {m.status === 'cancelled' && <div className="error-box">Đã hủy: {m.cancelReason}</div>}
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Vị trí</th>{m.type === 'move' && <th>Đến vị trí</th>}<th>Tình trạng</th>
            {m.type === 'status' && <th>Tình trạng mới</th>}<th className="num">Số bao</th><th className="num">Pallet</th><th className="num">Kg</th></tr></thead>
          <tbody>
            {m.lines.map((l, i) => (
              <tr key={i}><td>{l.item}</td><td>{l.itemName}</td><td>{l.lot}</td><td>{l.location}</td>{m.type === 'move' && <td>{l.toLocation}</td>}
                <td>{l.goodsStatus}{l.pledgee ? ` (${l.pledgee})` : ''}</td>{m.type === 'status' && <td>{l.toStatus}{l.toPledgee ? ` (${l.toPledgee})` : ''}</td>}
                <td className="num">{fmtNum(l.bags)}</td><td className="num">{fmtNum(l.pallets, 2)}</td><td className="num">{fmtNum(l.kg)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="section-head">Lịch sử</div>
      <table><tbody>{(m.history || []).map((h, i) => <tr key={i}><td className="nowrap">{fmtTime(h.at)}</td><td>{h.action}</td><td className="small">{h.byName || h.by}</td></tr>)}</tbody></table>
      <ErrorBox error={err} />
      {isAdmin && m.status !== 'cancelled' && (
        <div className="form-actions">
          <input placeholder="Lý do hủy phiếu" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn danger" disabled={!reason.trim() || busy} onClick={cancel}>Hủy phiếu (đảo tồn kho)</button>
        </div>
      )}
    </Modal>
  );
}
