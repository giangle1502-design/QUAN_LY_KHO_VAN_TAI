import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useCollections, useOpCompany, useOrders } from '../../lib/hooks';
import { CompanyPicker } from '../../components/TripBits';
import { Empty, ErrorBox, Modal } from '../../components/ui';
import { exportSheets } from '../../lib/excel';
import { fmtDate, fmtNum, norm, today } from '../../lib/utils';
import { OPEN_STATUSES, leftKg, lineShip, lineWh } from '../../lib/orders';
import { deleteOrRequest } from '../../lib/deletes';
import {
  ALLOC_STATUS, DEST_TYPES, addAllocations, allocStatus, allocatedByPoLine, attachToOrder, cancelAllocation, createOrderFromGroup,
  detachFromOrder, groupForOrders, missingForOrder, poKey, updateAllocation,
} from '../../lib/allocations';

const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const kg = (v) => fmtNum(n(v), 2);
const tn = (v) => `= ${fmtNum(n(v) / 1000, 3)} tấn`;

// Trang Kế hoạch phân bổ hàng mua: tab Kế hoạch (các dòng phân bổ) và Hàng mua chưa phân bổ (dòng PO còn phần chưa chia)
export default function Allocation() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'chua' ? 'chua' : 'ke-hoach';
  const { hasRole, email, name } = useApp();
  const canManage = hasRole('kinh_doanh', 'ke_toan');
  const allocState = useCollection('allocations');
  const { rows: orders, error: oErr } = useOrders('');
  const cats = useCollections(['soldto', 'shipto', 'warehouses', 'carriers']);
  const [co, setCo] = useOpCompany();
  const user = { email, name };
  const orderMap = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const allocs = allocState.rows;
  const allocated = useMemo(() => allocatedByPoLine(allocs), [allocs]);
  const pos = useMemo(() => orders.filter((o) => o.type === 'PO' && o.status !== 'cancelled' && !o.direct), [orders]);
  const ctx = { canManage, user, cats, orderMap, orders, allocs, allocated, co };
  const nOpenPo = useMemo(() => pos.filter((o) => !co || o.company === co).flatMap((o) => o.lines.filter((l) => n(l.qtyKg) - (allocated.get(poKey(o.id, l.no)) || 0) > 0.001)).length, [pos, allocated, co]);

  return (
    <div>
      <div className="page-head">
        <h1>📋 Kế hoạch phân bổ hàng mua</h1>
        <div className="seg">
          <button type="button" className={tab === 'ke-hoach' ? 'on' : ''} onClick={() => setParams({ tab: 'ke-hoach' })}>Kế hoạch phân bổ</button>
          <button type="button" className={tab === 'chua' ? 'on' : ''} onClick={() => setParams({ tab: 'chua' })}>Hàng mua chưa phân bổ{nOpenPo ? ` (${nOpenPo})` : ''}</button>
        </div>
      </div>
      <p className="hint">Mỗi dòng PO được chia thành các dòng kế hoạch (thường 1 dòng = 1 cont). Dòng <b>giao khách</b> sẽ thành đơn bán (SO) xuất từ nơi nhận hàng, dòng <b>về kho mình</b> thành lệnh chuyển kho (STO) từ nơi nhận hàng tới kho đó. Nơi nhận = kho nhập trên dòng PO (kho cảng / KNQ).</p>
      <ErrorBox error={allocState.error || oErr} />
      {tab === 'chua' ? <OpenPoLines {...ctx} pos={pos} setCo={setCo} /> : <Plan {...ctx} setCo={setCo} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dòng PO còn phần chưa phân bổ
function OpenPoLines({ pos, allocated, co, setCo, canManage, user }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [split, setSplit] = useState(null);
  const rows = useMemo(() => {
    const f = norm(q);
    return pos.filter((o) => !co || o.company === co).flatMap((o) => o.lines.map((l) => {
      const done = allocated.get(poKey(o.id, l.no)) || 0;
      return { o, l, done, left: Math.max(0, n(l.qtyKg) - done) };
    }))
      .filter((r) => all || r.left > 0.001)
      .filter((r) => !f || norm([r.o.id, r.o.refNo, r.o.partyCode, r.o.partyName, r.l.item, r.l.itemName, lineWh(r.o, r.l, 'in')].join(' ')).includes(f))
      .sort((a, b) => String(a.l.dueDate || a.o.dueDate || '9999').localeCompare(String(b.l.dueDate || b.o.dueDate || '9999')));
  }, [pos, allocated, co, q, all]);
  const sum = rows.reduce((s, r) => s + r.left, 0);
  return (
    <div>
      <div className="filters">
        <CompanyPicker value={co} onChange={setCo} />
        <input type="search" placeholder="Tìm số PO, BCT, nhà cung cấp, mã hàng, kho…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Hiện cả dòng đã phân bổ hết</label>
        <span className="small" style={{ marginLeft: 'auto' }}>Còn chưa phân bổ: <b>{kg(sum)} kg</b> ({tn(sum)})</span>
      </div>
      <div className="table-wrap">
        {!rows.length ? <Empty text="Không có dòng PO nào còn chưa phân bổ." /> : (
          <table>
            <thead><tr><th>Số PO</th><th>Số Ecount / BCT</th><th>Công ty</th><th>Nhà cung cấp</th><th>ETA</th><th>Nơi nhận (kho nhập)</th><th>Mã hàng</th><th>Tên hàng</th>
              <th className="num">Đặt (kg)</th><th className="num">Đã nhận (kg)</th><th className="num">Đã phân bổ (kg)</th><th className="num">Chưa phân bổ (kg)</th><th></th></tr></thead>
            <tbody>{rows.map(({ o, l, done, left }) => (
              <tr key={poKey(o.id, l.no)}>
                <td className="mono nowrap">{o.id}</td><td className="mono">{o.refNo}</td><td><b>{o.company}</b></td><td>{o.partyName || o.partyCode}</td>
                <td className="nowrap">{fmtDate(l.dueDate || o.dueDate)}</td><td>{lineWh(o, l, 'in') || <span className="req">chưa ghi kho nhập</span>}</td>
                <td>{l.item}</td><td>{l.itemName}</td><td className="num">{kg(l.qtyKg)}</td><td className="num">{kg(l.doneKg)}</td>
                <td className="num">{kg(done)}</td><td className="num"><b>{kg(left)}</b><div className="small">{tn(left)}</div></td>
                <td>{canManage && left > 0.001 && <button className="btn sm primary" onClick={() => setSplit({ o, l, left })}>Phân bổ</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {split && <SplitModal {...split} user={user} onClose={() => setSplit(null)} />}
    </div>
  );
}

// Chia 1 dòng PO thành N dòng kế hoạch (mặc định chia đều theo số cont)
function SplitModal({ o, l, left, user, onClose }) {
  const [count, setCount] = useState(1);
  const [per, setPer] = useState(String(Math.round(left * 1000) / 1000));
  const [conts, setConts] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setN = (v) => { const c = Math.max(1, Math.min(200, Math.floor(n(v)) || 1)); setCount(c); setPer(String(Math.round((left / c) * 1000) / 1000)); };
  const contList = conts.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const total = count * n(per);
  const go = async () => {
    setErr('');
    if (!(n(per) > 0)) return setErr('Nhập số kg mỗi dòng.');
    if (total > left + 0.001) return setErr(`Tổng ${kg(total)} kg vượt phần chưa phân bổ ${kg(left)} kg.`);
    if (contList.length && contList.length !== count) return setErr(`Đã nhập ${contList.length} số cont, cần ${count} số (hoặc để trống).`);
    setBusy(true);
    try {
      await addAllocations(o, l, Array.from({ length: count }, (_, i) => ({ qtyKg: n(per), contNo: contList[i] || '' })), user);
      onClose();
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập kế hoạch phân bổ.' : e.message); setBusy(false); }
  };
  return (
    <Modal title={`Phân bổ ${o.id} – ${l.item}`} onClose={onClose}>
      <p>{o.company} · {o.partyName || o.partyCode}{o.refNo ? <> · BCT <b>{o.refNo}</b></> : null} · Nơi nhận <b>{lineWh(o, l, 'in') || '–'}</b> · ETA {fmtDate(l.dueDate || o.dueDate)}</p>
      <p>Chưa phân bổ: <b>{kg(left)} kg</b> ({tn(left)})</p>
      <div className="form-grid">
        <label className="field"><span>Số dòng (số cont)</span><input type="number" min="1" value={count} onChange={(e) => setN(e.target.value)} /></label>
        <label className="field"><span>Số kg mỗi dòng</span><input type="number" step="any" value={per} onChange={(e) => setPer(e.target.value)} /><small className="small">{tn(per)}</small></label>
        <label className="field full"><span>Số cont (không bắt buộc, mỗi số cách nhau dấu phẩy hoặc xuống dòng)</span><textarea rows={2} value={conts} onChange={(e) => setConts(e.target.value)} /></label>
      </div>
      <p className="small">Tạo {count} dòng × {kg(per)} kg = <b>{kg(total)} kg</b>. Điểm giao để "Chưa chốt", chọn khách hoặc kho đến ở bảng kế hoạch.</p>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="btn" onClick={onClose}>Đóng</button><button className="btn primary" disabled={busy} onClick={go}>Tạo dòng kế hoạch</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bảng kế hoạch phân bổ: sửa trực tiếp dòng nháp, chọn dòng → tạo SO / STO
const FILTERS = {
  draft: 'Chưa tạo đơn',
  tracking: 'Đã tạo đơn, chưa giao xong',
  done: 'Đã giao',
  '': 'Tất cả (trừ dòng đã hủy)',
  cancelled: 'Dòng đã hủy',
};
function Plan({ allocs, orderMap, orders, allocated, cats, co, setCo, canManage, user }) {
  const { isSuper } = useApp();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('draft');
  const [dest, setDest] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [creating, setCreating] = useState(false);
  const [attach, setAttach] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const rows = useMemo(() => {
    const f = norm(q);
    return allocs.map((a) => ({ ...a, st: allocStatus(a, orderMap) }))
      .filter((a) => !co || a.company === co)
      .filter((a) => !dest || a.destType === dest)
      .filter((a) => (filter === 'draft' ? a.st === 'draft' : filter === 'tracking' ? ['ordered', 'partial', 'orderGone'].includes(a.st)
        : filter === 'done' ? a.st === 'done' : filter === 'cancelled' ? a.st === 'cancelled' : a.st !== 'cancelled'))
      .filter((a) => !f || norm([a.poId, a.bct, a.item, a.itemName, a.contNo, a.fromWarehouse, a.partyCode, a.partyName, a.shipCode, a.toWarehouse, a.orderId, a.carrier, a.note].join(' ')).includes(f))
      .sort((x, y) => String(x.date || '9999').localeCompare(String(y.date || '9999')) || String(x.poId).localeCompare(String(y.poId)) || String(x.createdAt).localeCompare(String(y.createdAt)));
  }, [allocs, orderMap, co, dest, filter, q]);
  const picked = rows.filter((a) => sel.has(a._id) && !missingForOrder(a));
  const toggle = (id) => setSel((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const ready = rows.filter((a) => !missingForOrder(a));
  const allOn = ready.length > 0 && ready.every((a) => sel.has(a._id));
  const sum = rows.reduce((s, a) => s + n(a.qtyKg), 0);
  const save = async (a, patch) => {
    setErr('');
    try { await updateAllocation(a._id, patch, user); } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền sửa kế hoạch phân bổ.' : e.message); }
  };
  const setQty = (a, v) => {
    const po = orderMap.get(a.poId);
    const pl = po?.lines.find((l) => l.no === a.poLine);
    const others = allocatedByPoLine(allocs, a._id).get(poKey(a.poId, a.poLine)) || 0;
    const max = pl ? n(pl.qtyKg) * (1 + n(po.tolerancePct) / 100) - others : Infinity;
    if (!(n(v) > 0)) { setErr('Số lượng phải lớn hơn 0.'); return false; }
    if (n(v) > max + 0.001) { setErr(`Dòng ${a.item} của ${a.poId}: tối đa ${kg(max)} kg (PO đặt ${kg(pl.qtyKg)} kg, các dòng kế hoạch khác đã chia ${kg(others)} kg).`); return false; }
    save(a, { qtyKg: Math.round(n(v) * 1000) / 1000 });
    return true;
  };
  const cancel = async (a) => {
    setErr('');
    if (!window.confirm(`Hủy dòng kế hoạch ${a.item} ${kg(a.qtyKg)} kg${a.contNo ? ` (cont ${a.contNo})` : ''}? Phần này quay lại "Hàng mua chưa phân bổ".`)) return;
    try { await cancelAllocation(a, user); } catch (e) { setErr(e.message); }
  };
  const remove = async (a) => {
    if (!window.confirm('Xóa hẳn dòng kế hoạch đã hủy?')) return;
    try { await deleteOrRequest({ coll: 'allocations', id: a._id, label: `Phân bổ ${a.poId} ${a.item} ${kg(a.qtyKg)} kg`, data: a }, user, isSuper); } catch (e) { setErr(e.message); }
  };
  const exportExcel = () => exportSheets(`Ke_hoach_phan_bo_${today()}`, {
    'Kế hoạch phân bổ': (rows.length ? rows : [{}]).map((a) => ({
      'Ngày giao dự kiến': a.date || '', 'Số PO': a.poId || '', 'BCT / Số Ecount': a.bct || '', 'Công ty': a.company || '', 'Nhà cung cấp': a.supplierName || a.supplier || '',
      'Mã hàng': a.item || '', 'Tên hàng': a.itemName || '', 'Số lượng (kg)': n(a.qtyKg), 'Số cont': a.contNo || '', 'Nơi nhận': a.fromWarehouse || '',
      'Điểm giao': DEST_TYPES[a.destType] || '', 'Khách hàng': a.partyName || a.partyCode || '', 'Mã giao': a.shipCode || '', 'Kho đến': a.toWarehouse || '',
      'Nhà vận chuyển': a.carrier || '', 'Số đơn': a.orderId || '', 'Trạng thái': ALLOC_STATUS[a.st]?.label || '', 'Ghi chú': a.note || '',
    })),
  });
  const whs = (cats.warehouses || []).filter((w) => w.active !== false);
  return (
    <div>
      <div className="stats">
        <div className="stat"><div className="stat-label">Số dòng đang hiển thị</div><div className="stat-value">{rows.length}</div></div>
        <div className="stat"><div className="stat-label">Tổng số lượng</div><div className="stat-value">{kg(sum)} kg</div><div className="stat-sub">{tn(sum)}</div></div>
        <div className="stat amber"><div className="stat-label">Dòng nháp chưa chốt điểm giao</div><div className="stat-value">{allocs.filter((a) => a.status === 'draft' && !a.orderId && a.destType === 'pending' && (!co || a.company === co)).length}</div></div>
      </div>
      <div className="filters">
        <CompanyPicker value={co} onChange={setCo} />
        <select value={filter} onChange={(e) => { setFilter(e.target.value); setSel(new Set()); }}>
          {Object.entries(FILTERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={dest} onChange={(e) => setDest(e.target.value)}>
          <option value="">Mọi điểm giao</option>
          {Object.entries(DEST_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input type="search" placeholder="Tìm PO, BCT, mã hàng, số cont, khách, kho, số đơn…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="actions" style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={exportExcel}>⬇ Excel</button>
          {canManage && <button className="btn primary" disabled={!picked.length} onClick={() => setCreating(true)}>Tạo đơn từ {picked.length} dòng đã chọn</button>}
        </div>
      </div>
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      <ErrorBox error={err} />
      <datalist id="dl-alloc-soldto">{(cats.soldto || []).filter((c) => c.active !== false).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>
      <div className="table-wrap">
        {!rows.length ? <Empty text={filter === 'draft' ? 'Chưa có dòng kế hoạch nháp. Vào tab "Hàng mua chưa phân bổ" để chia dòng PO.' : 'Không có dòng nào.'} /> : (
          <table className="alloc-table">
            <thead><tr>
              <th>{canManage && ready.length > 0 && <input type="checkbox" checked={allOn} title="Chọn mọi dòng đủ thông tin" onChange={() => setSel(allOn ? new Set() : new Set(ready.map((a) => a._id)))} />}</th>
              <th>Ngày giao</th><th>PO / BCT</th><th>Công ty</th><th>Mã hàng</th><th className="num">Số lượng (kg)</th><th>Số cont</th><th>Nơi nhận</th>
              <th>Điểm giao</th><th>Khách hàng / Kho đến</th><th>Mã giao</th><th>Nhà vận chuyển</th><th>Ghi chú</th><th>Trạng thái</th><th></th>
            </tr></thead>
            <tbody>{rows.map((a) => (
              <AllocRow key={a._id} a={a} edit={canManage && a.st === 'draft'} canManage={canManage} cats={cats} whs={whs}
                checked={sel.has(a._id)} onCheck={() => toggle(a._id)} save={(p) => save(a, p)} setQty={(v) => setQty(a, v)}
                onCancel={() => cancel(a)} onRemove={() => remove(a)} onAttach={() => setAttach(a)}
                onDetach={() => detachFromOrder(a, user).catch((e) => setErr(e.message))} />
            ))}</tbody>
          </table>
        )}
      </div>
      {creating && <CreateOrders rows={picked} cats={cats} user={user} onClose={(m) => { setCreating(false); if (m) { setMsg(m); setSel(new Set()); } }} />}
      {attach && <AttachModal a={attach} orders={orders} allocs={allocs} user={user} onClose={() => setAttach(null)} />}
    </div>
  );
}

// 1 dòng kế hoạch. Dòng nháp: sửa trực tiếp (ghi ngay khi rời ô / đổi lựa chọn)
function AllocRow({ a, edit, canManage, cats, whs, checked, onCheck, save, setQty, onCancel, onRemove, onAttach, onDetach }) {
  const miss = missingForOrder(a);
  const st = ALLOC_STATUS[a.st];
  const blur = (k, conv = (v) => v.trim()) => (e) => { const v = conv(e.target.value); if (v !== (a[k] ?? '')) save({ [k]: v }); };
  const ships = (cats.shipto || []).filter((s) => s.customerCode === a.partyCode);
  const pickCustomer = (e) => {
    const v = e.target.value.trim();
    if (v === (a.partyCode || '')) return;
    const c = (cats.soldto || []).find((x) => x.code === v);
    if (v && !c) { e.target.value = a.partyCode || ''; window.alert(`Mã khách ${v} không có trong danh mục Soldto.`); return; }
    const sh = (cats.shipto || []).filter((s) => s.customerCode === v);
    save({ partyCode: v, partyName: c?.name || '', shipCode: sh.length === 1 ? sh[0].shipCode : '' });
  };
  const orderCell = a.orderId ? <Link to={`/don-hang?tab=${a.orderType || 'SO'}`} className="mono" title={`Dòng ${a.orderLine} của ${a.orderId}`}>{a.orderId}</Link> : null;
  return (
    <tr style={{ opacity: a.st === 'cancelled' ? 0.55 : 1 }}>
      <td>{canManage && !miss && <input type="checkbox" checked={checked} onChange={onCheck} />}</td>
      <td>{edit ? <input type="date" style={{ width: 140 }} defaultValue={a.date} key={'d' + a.date} onBlur={blur('date')} /> : <span className="nowrap">{fmtDate(a.date)}</span>}</td>
      <td className="mono nowrap">{a.poId}{a.bct ? <div className="small">BCT {a.bct}</div> : null}</td>
      <td><b>{a.company}</b></td>
      <td>{a.item}<div className="small">{a.itemName}</div></td>
      <td className="num">{edit ? <input type="number" step="any" style={{ width: 100, textAlign: 'right' }} defaultValue={a.qtyKg} key={'q' + a.qtyKg} onBlur={(e) => { if (n(e.target.value) !== n(a.qtyKg) && !setQty(e.target.value)) e.target.value = a.qtyKg; }} /> : kg(a.qtyKg)}<div className="small">{tn(a.qtyKg)}</div></td>
      <td>{edit ? <input style={{ width: 120 }} defaultValue={a.contNo} key={'c' + a.contNo} onBlur={blur('contNo', (v) => v.trim().toUpperCase())} /> : <span className="mono">{a.contNo}</span>}</td>
      <td>{edit ? (
        <select value={a.fromWarehouse || ''} onChange={(e) => save({ fromWarehouse: e.target.value })}>
          <option value="">-- Kho --</option>{whs.map((w) => <option key={w.code} value={w.code}>{w.code}</option>)}
        </select>) : a.fromWarehouse}</td>
      <td>{edit ? (
        <select value={a.destType || 'pending'} onChange={(e) => save({ destType: e.target.value })}>
          {Object.entries(DEST_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>) : DEST_TYPES[a.destType]}</td>
      <td>{edit && a.destType === 'customer' ? (
        <><input list="dl-alloc-soldto" style={{ width: 130 }} placeholder="Mã khách" defaultValue={a.partyCode} key={'p' + a.partyCode} onBlur={pickCustomer} />
          {a.partyName && <div className="small">{a.partyName}</div>}</>
      ) : edit && a.destType === 'warehouse' ? (
        <select value={a.toWarehouse || ''} onChange={(e) => save({ toWarehouse: e.target.value })}>
          <option value="">-- Kho đến --</option>{whs.filter((w) => w.code !== a.fromWarehouse).map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
        </select>
      ) : a.destType === 'customer' ? <>{a.partyCode}{a.partyName ? <div className="small">{a.partyName}</div> : null}</> : a.destType === 'warehouse' ? a.toWarehouse : <span className="small">–</span>}</td>
      <td>{edit && a.destType === 'customer' && a.partyCode ? (
        <select value={a.shipCode || ''} onChange={(e) => save({ shipCode: e.target.value })}>
          <option value="">-- Mã giao --</option>{ships.map((s) => <option key={s.shipCode} value={s.shipCode} title={s.address}>{s.shipCode}</option>)}
        </select>) : a.destType === 'customer' ? a.shipCode : ''}</td>
      <td>{edit ? (
        <select value={a.carrier || ''} onChange={(e) => save({ carrier: e.target.value })}>
          <option value="">--</option>{(cats.carriers || []).filter((c) => c.active !== false).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </select>) : a.carrier}</td>
      <td>{edit ? <input style={{ width: 140 }} defaultValue={a.note} key={'n' + a.note} onBlur={blur('note')} /> : <span className="small">{a.note}</span>}</td>
      <td>
        <span className={'badge ' + (st?.tone || '')}>{st?.label}</span>
        {a.st === 'draft' && miss && <div className="small" style={{ color: 'var(--amber)' }}>{miss}</div>}
        {orderCell && <div>{orderCell}{a.attached ? <span className="small"> (gắn vào)</span> : null}</div>}
      </td>
      <td className="nowrap">
        {canManage && a.st === 'draft' && a.destType !== 'warehouse' && <button className="btn sm" title="Gắn vào dòng đơn bán sale đã lập" onClick={onAttach}>Gắn SO</button>}
        {canManage && a.st === 'draft' && <button className="btn sm ghost" title="Hủy dòng kế hoạch" onClick={onCancel}>✕</button>}
        {canManage && a.attached && a.st === 'ordered' && <button className="btn sm ghost" title="Bỏ gắn khỏi đơn bán" onClick={onDetach}>Bỏ gắn</button>}
        {canManage && a.st === 'cancelled' && <button className="btn sm ghost" onClick={onRemove}>🗑</button>}
      </td>
    </tr>
  );
}

// Xem trước các đơn sẽ tạo (SO theo công ty + khách, STO theo công ty) rồi tạo
function CreateOrders({ rows, cats, user, onClose }) {
  const { salesOnly, email } = useApp();
  const users = useCollection(salesOnly ? '' : 'users').rows.filter((u) => u.role === 'kinh_doanh' && u.active !== false);
  const groups = useMemo(() => groupForOrders(rows), [rows]);
  const [sales, setSales] = useState(() => Object.fromEntries(groups.map((g) => [g.key, salesOnly ? email : ''])));
  const [done, setDone] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const whName = (c) => (cats.warehouses || []).find((w) => w.code === c)?.name || c;
  const go = async () => {
    setErr(''); setBusy(true);
    const made = { ...done };
    for (const g of groups) {
      if (made[g.key]) continue;
      try { made[g.key] = await createOrderFromGroup(g, { sales: sales[g.key], whName }, user); setDone({ ...made }); } catch (e) {
        setErr(`${g.type} ${g.partyName || g.company}: ${e.code === 'permission-denied' ? 'bạn không có quyền lập đơn này.' : e.message}`);
        setBusy(false); return;
      }
    }
    setBusy(false);
    onClose(`Đã tạo ${Object.values(made).join(', ')} từ ${rows.length} dòng kế hoạch.`);
  };
  return (
    <Modal title="Tạo đơn từ kế hoạch phân bổ" onClose={() => onClose(Object.keys(done).length ? `Đã tạo ${Object.values(done).join(', ')}.` : '')} wide>
      <p className="small">Mỗi dòng kế hoạch thành 1 dòng đơn. Kho xuất của SO / kho đi của STO là nơi nhận hàng; số cont, số PO ghi vào ghi chú dòng đơn.</p>
      {groups.map((g) => (
        <div key={g.key} className="card" style={{ marginBottom: 10 }}>
          <div className="section-head">
            <span className={'badge ' + (g.type === 'SO' ? 'blue' : 'teal')}>{g.type === 'SO' ? 'Đơn bán (SO)' : 'Chuyển kho (STO)'}</span>
            <b>{g.company}</b>{g.type === 'SO' ? <> · {g.partyCode} {g.partyName}</> : null}
            <span className="small">· {g.rows.length} dòng · {kg(g.rows.reduce((s, a) => s + n(a.qtyKg), 0))} kg</span>
            {done[g.key] && <span className="badge green">Đã tạo {done[g.key]}</span>}
          </div>
          {g.type === 'SO' && !done[g.key] && (
            <label className="small">Sale phụ trách:{' '}
              {salesOnly ? <b>{email}</b> : (
                <select value={sales[g.key] || ''} onChange={(e) => setSales((s) => ({ ...s, [g.key]: e.target.value }))}>
                  <option value="">-- Không ghi --</option>{users.map((u) => <option key={u.email} value={u.email}>{u.name} ({u.email})</option>)}
                </select>)}
            </label>
          )}
          <table><thead><tr><th>Ngày giao</th><th>Mã hàng</th><th className="num">Số lượng (kg)</th><th>Cont</th>{g.type === 'SO' ? <><th>Kho xuất</th><th>Mã giao</th></> : <><th>Kho đi</th><th>Kho đến</th></>}<th>PO</th><th>Nhà vận chuyển</th></tr></thead>
            <tbody>{g.rows.map((a) => (
              <tr key={a._id}><td>{fmtDate(a.date)}</td><td>{a.item}</td><td className="num">{kg(a.qtyKg)}</td><td className="mono">{a.contNo}</td>
                <td>{a.fromWarehouse}</td><td>{g.type === 'SO' ? a.shipCode : a.toWarehouse}</td><td className="mono">{a.poId}</td><td>{a.carrier}</td></tr>
            ))}</tbody></table>
        </div>
      ))}
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={() => onClose('')}>Đóng</button>
        <button className="btn primary" disabled={busy || groups.every((g) => done[g.key])} onClick={go}>Tạo {groups.filter((g) => !done[g.key]).length} đơn</button>
      </div>
    </Modal>
  );
}

// Gắn dòng kế hoạch vào dòng SO đang mở cùng công ty + mã hàng (cùng khách nếu đã chọn khách)
function AttachModal({ a, orders, allocs, user, onClose }) {
  const [err, setErr] = useState('');
  const used = useMemo(() => {
    const m = new Map();
    for (const x of allocs) if (x.orderId && x.status !== 'cancelled') m.set(`${x.orderId}__${x.orderLine}`, (m.get(`${x.orderId}__${x.orderLine}`) || 0) + n(x.qtyKg));
    return m;
  }, [allocs]);
  const cand = orders.filter((o) => o.type === 'SO' && OPEN_STATUSES.includes(o.status) && o.company === a.company && (!a.partyCode || o.partyCode === a.partyCode))
    .flatMap((o) => o.lines.filter((l) => l.item === a.item).map((l) => ({ o, l, planned: used.get(`${o.id}__${l.no}`) || 0 })))
    .sort((x, y) => String(x.l.dueDate || x.o.dueDate || '9999').localeCompare(String(y.l.dueDate || y.o.dueDate || '9999')));
  const pick = async (o, l) => {
    setErr('');
    try { await attachToOrder(a, o, l, user); onClose(); } catch (e) { setErr(e.message); }
  };
  return (
    <Modal title={`Gắn ${a.item} ${kg(a.qtyKg)} kg vào đơn bán có sẵn`} onClose={onClose} wide>
      <p className="small">Đơn bán đang mở của công ty <b>{a.company}</b>, mã hàng <b>{a.item}</b>{a.partyCode ? <>, khách <b>{a.partyCode}</b></> : ''}. Dòng đơn không thay đổi; dòng kế hoạch chỉ ghi nhớ là hàng cho đơn này.</p>
      {!cand.length ? <Empty text="Không có dòng đơn bán phù hợp." /> : (
        <table><thead><tr><th>Số SO</th><th>Khách hàng</th><th>Ngày giao</th><th>Kho xuất</th><th>Mã giao</th><th className="num">Còn phải giao (kg)</th><th className="num">Đã có kế hoạch (kg)</th><th></th></tr></thead>
          <tbody>{cand.map(({ o, l, planned }) => (
            <tr key={`${o.id}-${l.no}`}><td className="mono">{o.id}</td><td>{o.partyName || o.partyCode}</td><td>{fmtDate(l.dueDate || o.dueDate)}</td><td>{lineWh(o, l) || 'Kho nào cũng được'}</td>
              <td>{lineShip(o, l)}</td><td className="num">{kg(leftKg(l))}</td><td className="num">{kg(planned)}</td>
              <td><button className="btn sm primary" onClick={() => pick(o, l)}>Gắn</button>
                {lineWh(o, l) && lineWh(o, l) !== a.fromWarehouse && <div className="small" style={{ color: 'var(--amber)' }}>Kho xuất khác nơi nhận {a.fromWarehouse}</div>}</td></tr>
          ))}</tbody></table>
      )}
      <ErrorBox error={err} />
    </Modal>
  );
}
