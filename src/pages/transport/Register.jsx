import { useMemo, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpWarehouse, useOrders } from '../../lib/hooks';
import { leftKg } from '../../lib/orders';
import { fmtNum } from '../../lib/utils';
import { PURPOSES, firstStatus, nowISO, reserveCodes, vnDate, STATUS_META } from '../../lib/trips';
import { ErrorBox, Field } from '../../components/ui';

const emptyLine = () => ({ partyCode: '', partyName: '', shipCode: '', address: '', payload: '', orderId: '' });
const emptyForm = () => ({ purpose: 'export', plate: '', carrier: '', carrierName: '', vehicleType: '', idCard: '', driverName: '', driverPhone: '', note: '' });

// Đăng ký xe tại cổng: chọn xe, tài xế, khách từ danh mục (vẫn gõ tay được nếu chưa có)
export default function Register() {
  const { email, name } = useApp();
  const warehouses = useMyWarehouses();
  const [opWh, setOpWh] = useOpWarehouse();
  const wh = warehouses.find((w) => w.code === opWh) || (warehouses.length === 1 ? warehouses[0] : null);
  const vehicles = useCollection('vehicles').rows;
  const drivers = useCollection('drivers').rows;
  const carriers = useCollection('carriers').rows;
  const soldto = useCollection('soldto').rows;
  const shipto = useCollection('shipto').rows;
  const suppliers = useCollection('suppliers').rows;
  const [form, setForm] = useState(emptyForm);
  const [lines, setLines] = useState([emptyLine()]);
  const [errs, setErrs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const parties = form.purpose === 'import' ? suppliers : soldto.filter((c) => c.active !== false);
  const { rows: orders } = useOrders(form.purpose === 'import' ? 'PO' : 'SO', true);
  const orderLeft = (o) => o.lines.reduce((s, l) => s + leftKg(l), 0) / 1000;
  const ordersOf = (code) => orders.filter((o) => o.partyCode === code && (!o.warehouse || o.warehouse === wh?.code));
  // Chọn đơn SO/PO: khối lượng mặc định = phần còn lại của đơn
  const pickOrder = (i, id) => {
    const o = orders.find((x) => x.id === id);
    const s = o?.shipCode && shipto.find((x) => x.shipCode === o.shipCode);
    setLine(i, { orderId: id, ...(o ? { payload: Math.round(orderLeft(o) * 1000) / 1000 } : {}), ...(s ? { shipCode: s.shipCode, address: s.address } : {}) });
  };
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const pickPlate = (v) => {
    const plate = v.toUpperCase();
    const veh = vehicles.find((x) => x.plate === plate);
    const car = veh && carriers.find((c) => c.code === veh.carrier);
    setForm((f) => ({ ...f, plate, ...(veh ? { carrier: veh.carrier || '', carrierName: car?.name || f.carrierName, vehicleType: veh.vehicleType || '' } : {}) }));
  };
  const pickDriver = (v) => {
    const d = drivers.find((x) => x.idCard === v);
    setForm((f) => ({ ...f, idCard: v, ...(d ? { driverName: d.name || '', driverPhone: d.phone || '' } : {}) }));
  };
  const pickCarrier = (v) => {
    const c = carriers.find((x) => x.code === v);
    setForm((f) => ({ ...f, carrier: v, carrierName: c ? c.name : f.carrierName }));
  };
  const pickParty = (i, v) => {
    const p = parties.find((x) => x.code === v);
    const ships = shipto.filter((s) => s.customerCode === v);
    setLine(i, {
      partyCode: v,
      partyName: p ? p.name : lines[i].partyName, orderId: '',
      ...(ships.length === 1 ? { shipCode: ships[0].shipCode, address: ships[0].address } : { shipCode: '', address: '' }),
    });
  };
  const pickShip = (i, v) => {
    const s = shipto.find((x) => x.shipCode === v);
    setLine(i, { shipCode: v, address: s?.address || '' });
  };

  const submit = async (e) => {
    e.preventDefault();
    const er = [];
    if (!wh) er.push('Chọn kho.');
    if (!form.plate.trim()) er.push('Nhập biển số xe.');
    if (!form.driverName.trim()) er.push('Nhập tên tài xế.');
    if (!form.idCard.trim()) er.push('Nhập số CCCD.');
    lines.forEach((l, i) => { if (!l.partyCode.trim() && !l.partyName.trim()) er.push(`Dòng ${i + 1}: chọn ${form.purpose === 'import' ? 'nhà cung cấp' : 'khách hàng'}.`); });
    setErrs(er);
    if (er.length) return;
    setBusy(true);
    try {
      const [gid] = await reserveCodes('GRP', 1);
      const sids = await reserveCodes('SP', lines.length);
      const at = nowISO();
      const status = firstStatus(wh.hasGuard !== false);
      const trip = {
        warehouse: wh.code, warehouseName: wh.name, hasGuard: wh.hasGuard !== false,
        purpose: form.purpose,
        plate: form.plate.trim().toUpperCase(), vehicleType: form.vehicleType,
        carrier: form.carrier.trim(), carrierName: form.carrierName.trim(),
        idCard: form.idCard.trim(), driverName: form.driverName.trim(), driverPhone: form.driverPhone.trim(),
        note: form.note.trim(),
        lines: lines.map((l, i) => ({
          id: sids[i], partyCode: l.partyCode.trim(), partyName: l.partyName.trim(),
          shipCode: l.shipCode, address: l.address, payload: l.payload === '' ? null : Number(l.payload),
          orderId: l.orderId || '', delivered: false, deliveredTime: null,
        })),
        orderIds: [...new Set(lines.map((l) => l.orderId).filter(Boolean))],
        status,
        arrivalTime: at, arrivalDate: vnDate(at),
        // Kho không có bảo vệ: coi như đã xác nhận vào cổng ngay khi đăng ký
        gateConfirmTime: status === 'waiting_gate' ? at : null,
        dock: null, dockAssignTime: null, processDoneTime: null, gateExitTime: null, deliveryCompleteTime: null,
        createdBy: email,
        history: [{ at, by: email, byName: name, action: 'Đăng ký xe', status }],
      };
      await setDoc(doc(db, 'trips', gid), trip);
      setDone({ id: gid, plate: trip.plate, sids, status });
      setForm(emptyForm()); setLines([emptyLine()]);
    } catch (e2) {
      setErrs([e2.code === 'permission-denied' ? 'Bạn không có quyền đăng ký xe cho kho này.' : e2.message]);
    }
    setBusy(false);
  };

  const shipsOf = useMemo(() => (code) => shipto.filter((s) => s.customerCode === code), [shipto]);

  if (done)
    return (
      <div className="success-card">
        <h2>Đăng ký thành công</h2>
        <p>Xe <span className="plate">{done.plate}</span> · chuyến <b className="mono">{done.id}</b></p>
        <p className="small">Trạng thái: {STATUS_META[done.status].label}</p>
        <div className="tags" style={{ justifyContent: 'center' }}>{done.sids.map((s) => <span key={s} className="tag mono">{s}</span>)}</div>
        <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setDone(null)}>Đăng ký xe khác</button>
      </div>
    );

  return (
    <form onSubmit={submit} style={{ maxWidth: 900 }}>
      <div className="page-head"><h1>🚚 Đăng ký xe vào kho</h1></div>
      <ErrorBox error={errs.join(' ')} />
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="form-grid">
          <Field label="Kho" required>
            <select value={wh?.code || ''} onChange={(e) => setOpWh(e.target.value)}>
              <option value="">-- Chọn kho --</option>
              {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}{w.hasGuard === false ? ' (không bảo vệ)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Mục đích" required>
            <div className="seg">
              {PURPOSES.map(([k, l]) => (
                <button type="button" key={k} className={form.purpose === k ? 'on' : ''}
                  onClick={() => { set('purpose', k); setLines([emptyLine()]); }}>{l}</button>
              ))}
            </div>
          </Field>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-head">Xe và tài xế</div>
        <div className="form-grid">
          <Field label="Biển số xe" required help={vehicles.some((v) => v.plate === form.plate) ? 'Đã có trong danh mục Xe' : ''}>
            <input list="dl-plate" value={form.plate} onChange={(e) => pickPlate(e.target.value)} />
          </Field>
          <Field label="Đơn vị vận tải">
            <input list="dl-carrier" value={form.carrier} onChange={(e) => pickCarrier(e.target.value)} placeholder="Mã đơn vị" />
          </Field>
          <Field label="Tên đơn vị vận tải">
            <input value={form.carrierName} onChange={(e) => set('carrierName', e.target.value)} />
          </Field>
          <Field label="Số CCCD" required>
            <input list="dl-driver" value={form.idCard} onChange={(e) => pickDriver(e.target.value)} />
          </Field>
          <Field label="Tên tài xế" required>
            <input value={form.driverName} onChange={(e) => set('driverName', e.target.value)} />
          </Field>
          <Field label="Điện thoại tài xế">
            <input value={form.driverPhone} onChange={(e) => set('driverPhone', e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-head">{form.purpose === 'import' ? 'Nhà cung cấp' : 'Khách hàng'} ({lines.length})</div>
        {lines.map((l, i) => (
          <div key={i} className="line-row">
            <Field label={`${i + 1}. ${form.purpose === 'import' ? 'Nhà cung cấp' : 'Khách hàng'}`} required>
              <input list="dl-party" value={l.partyCode} onChange={(e) => pickParty(i, e.target.value)} placeholder="Mã" />
              <input value={l.partyName} onChange={(e) => setLine(i, { partyName: e.target.value })} placeholder="Tên" style={{ marginTop: 4 }} />
            </Field>
            {form.purpose === 'export' ? (
              <Field label="Giao đến (Shipto)">
                <select value={l.shipCode} onChange={(e) => pickShip(i, e.target.value)}>
                  <option value="">-- Chọn --</option>
                  {shipsOf(l.partyCode).map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
                </select>
                {l.address && <small className="small">{l.address}</small>}
              </Field>
            ) : <div />}
            <Field label={form.purpose === 'import' ? 'Đơn mua (PO)' : 'Đơn bán (SO)'}>
              <select value={l.orderId} onChange={(e) => pickOrder(i, e.target.value)}>
                <option value="">-- Không theo đơn --</option>
                {ordersOf(l.partyCode).map((o) => <option key={o.id} value={o.id}>{o.id}{o.refNo ? ` (${o.refNo})` : ''} · còn {fmtNum(orderLeft(o), 3)} tấn</option>)}
              </select>
            </Field>
            <Field label="Khối lượng (tấn)">
              <input type="number" step="any" value={l.payload} onChange={(e) => setLine(i, { payload: e.target.value })} />
            </Field>
            <button type="button" className="btn ghost" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        {lines.length < 10 && <button type="button" className="btn sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Thêm {form.purpose === 'import' ? 'nhà cung cấp' : 'khách hàng'}</button>}
        <Field label="Ghi chú" full><textarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} /></Field>
      </div>
      {wh && wh.hasGuard === false && <p className="hint">Kho {wh.code} không có bảo vệ: xe vào thẳng bước Chờ vào cửa, không qua bước ra cổng.</p>}
      <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Đăng ký'}</button></div>
      <datalist id="dl-plate">{vehicles.map((v) => <option key={v.plate} value={v.plate}>{v.carrier}</option>)}</datalist>
      <datalist id="dl-carrier">{carriers.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>
      <datalist id="dl-driver">{drivers.map((d) => <option key={d.idCard} value={d.idCard}>{d.name}</option>)}</datalist>
      <datalist id="dl-party">{parties.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
    </form>
  );
}
