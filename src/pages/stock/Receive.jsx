import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { collection, doc, getDoc, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { IN_SOURCES } from '../../lib/orders';
import { confirmIn } from '../../lib/stock';
import { fmtDate, fmtNum } from '../../lib/utils';
import { Empty, ErrorBox } from '../../components/ui';
import { InLine, newLine } from './MovementForm';

// Nhận hàng: quản trị lập và in phiếu nhập trước; thủ kho nhận hàng ngoài hiện trường,
// nhập số thực nhận, lot, vị trí rồi xác nhận → tồn kho cập nhật (nhập trực tiếp: lập PO theo số thực nhận)
const num = (v) => (v === '' || v == null ? 0 : Number(v));
const t = (kg) => fmtNum(num(kg) / 1000, 3);

export default function Receive() {
  const { id } = useParams();
  return id ? <ReceiveForm key={id} id={id} /> : <ReceiveList />;
}

function ReceiveList() {
  const { inMyWarehouses } = useApp();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => onSnapshot(query(collection(db, 'movements'), where('status', '==', 'pending')),
    (s) => setRows(s.docs.map((d) => d.data()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))),
    (e) => setError(e.message)), []);
  const list = rows.filter((m) => m.type === 'in' && inMyWarehouses(m.warehouse));
  return (
    <div>
      <div className="page-head"><h1>📥 Nhận hàng (phiếu nhập chờ nhận)</h1><Link className="btn" to="/kho/phieu">Danh sách phiếu</Link></div>
      <p className="hint">Phiếu nhập do quản trị lập và in. Khi hàng về, bấm <b>Nhận hàng</b> để nhập số thực nhận, lot, vị trí rồi xác nhận: tồn kho cập nhật và in được nhãn pallet.</p>
      <ErrorBox error={error} />
      <div className="table-wrap">
        {!list.length ? <Empty text="Không có phiếu nhập nào đang chờ nhận hàng." /> : (
          <table>
            <thead><tr><th>Số phiếu</th><th>Ngày</th><th>Kho</th><th>Nguồn nhập</th><th>Nhà cung cấp / khách</th><th>Đơn</th><th>Mặt hàng</th><th className="num">Dự kiến (tấn)</th><th>Người lập</th><th></th></tr></thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.id}</td><td className="nowrap">{fmtDate(m.date)}</td><td>{m.warehouse}</td>
                  <td>{IN_SOURCES[m.source]?.short || ''}</td><td>{m.partyName || m.partyCode}</td><td className="mono">{m.orderId}</td>
                  <td>{[...new Set((m.lines || []).map((l) => l.item))].join(', ')}</td>
                  <td className="num">{t((m.lines || []).reduce((s, l) => s + num(l.kg), 0))}</td>
                  <td className="small">{m.createdByName || m.createdBy}</td>
                  <td className="nowrap">
                    <Link className="btn primary sm" to={`/kho/nhan-hang/${m.id}`}>📥 Nhận hàng</Link>{' '}
                    <Link className="btn sm" to={`/kho/phieu/${m.id}/in`} target="_blank">🖨 In</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ReceiveForm({ id }) {
  const { email, name, inMyWarehouses } = useApp();
  const nav = useNavigate();
  const [mv, setMv] = useState(undefined);
  const [lines, setLines] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const items = useCollection('items').rows;
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const allLocations = useCollection('locations').rows;
  const statuses = useCollection('goodsStatus').rows;
  const pledgees = useCollection('pledgees').rows;
  useEffect(() => {
    getDoc(doc(db, 'movements', id)).then((s) => {
      const m = s.exists() ? s.data() : null;
      setMv(m);
      if (m) setLines(m.lines.map((l) => ({ ...newLine(), ...l, plannedKg: l.kg })));
    }).catch((e) => { setErr(e.message); setMv(null); });
  }, [id]);
  if (mv === undefined) return <p>Đang tải…</p>;
  if (!mv) return <Empty text={`Không tìm thấy phiếu ${id}.`} />;
  const locations = allLocations.filter((l) => l.warehouse === mv.warehouse);
  const setLine = (i, p) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const submit = async (e) => {
    e.preventDefault(); setErr('');
    if (!inMyWarehouses(mv.warehouse)) return setErr(`Bạn không phụ trách kho ${mv.warehouse}.`);
    const out = [];
    for (const [i, l] of lines.entries()) {
      const no = `Dòng ${i + 1}: `;
      if (!num(l.kg) && !num(l.bags) && !num(l.pallets)) continue; // không nhận dòng này
      if (!l.item || !itemMap.has(l.item)) return setErr(no + 'chọn mã hàng có trong danh mục.');
      if (!l.location) return setErr(no + 'chọn vị trí nhận hàng.');
      if (l.goodsStatus === 'HTC' && !l.pledgee) return setErr(no + 'hàng HTC cần chọn bên nhận thế chấp.');
      // Dòng thêm mới (khác lot…) lấy dòng đơn của dòng cùng mã hàng trên phiếu
      const ol = l.orderLine ?? mv.lines.find((x) => x.item === l.item)?.orderLine;
      if (mv.orderId && ol == null) return setErr(no + `mã hàng ${l.item} không có trong phiếu / đơn ${mv.orderId}.`);
      out.push({ ...(ol != null ? { orderLine: ol } : {}), item: l.item, itemName: itemMap.get(l.item).name, lot: String(l.lot || '').trim(), mfgDate: l.mfgDate || '', expDate: l.expDate || '',
        location: l.location, goodsStatus: l.goodsStatus, pledgee: l.goodsStatus === 'HTC' ? l.pledgee : '', company: l.company || mv.company || '',
        bags: num(l.bags), pallets: num(l.pallets), kg: num(l.kg) });
    }
    if (!out.length) return setErr('Nhập số thực nhận cho ít nhất 1 dòng (hàng không về thì báo quản trị hủy phiếu).');
    setBusy(true);
    try {
      const res = await confirmIn(id, out, { email, name });
      setDone(typeof res === 'string' ? { id: res } : res);
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền nhận hàng cho kho này.' : e2.message);
    }
    setBusy(false);
  };

  if (done) return (
    <div>
      <div className="page-head"><h1>📥 Nhận hàng {id}</h1></div>
      <div className="ok-box">Đã xác nhận nhận hàng phiếu <b className="mono">{done.id}</b>{done.orderId ? <> và lập đơn mua <b className="mono">{done.orderId}</b> theo số thực nhận</> : null}. Tồn kho đã cập nhật.{' '}
        <Link to={`/kho/phieu/${done.id}/in`} target="_blank">🖨 In phiếu</Link> · <Link className="btn primary" to={`/kho/phieu/${done.id}/nhan`} target="_blank">🏷️ In nhãn pallet</Link> · <Link to="/kho/nhan-hang">← Phiếu chờ nhận khác</Link></div>
    </div>
  );
  const pending = mv.status === 'pending';
  return (
    <form onSubmit={submit}>
      <div className="page-head"><h1>📥 Nhận hàng {id}</h1><button type="button" className="btn" onClick={() => nav('/kho/nhan-hang')}>← Danh sách chờ nhận</button></div>
      <div className="card" style={{ marginBottom: 12 }}>
        <p style={{ margin: 0 }}>
          Kho <b>{mv.warehouse}</b> · Ngày {fmtDate(mv.date)} · {IN_SOURCES[mv.source]?.label || 'Phiếu nhập'}
          {mv.partyCode || mv.partyName ? <> · {mv.source === 'SO' ? 'Khách trả hàng' : 'Nhà cung cấp'}: <b>{mv.partyCode} {mv.partyName}</b></> : null}
          {mv.orderId ? <> · Đơn <b className="mono">{mv.orderId}</b></> : null}{mv.directPO?.refNo ? <> · Chứng từ NCC {mv.directPO.refNo}</> : null}
          {' · '}Công ty {mv.company} · Lập bởi {mv.createdByName || mv.createdBy}
        </p>
        {mv.note && <p className="small" style={{ margin: '6px 0 0' }}>Ghi chú: {mv.note}</p>}
        {!pending && <div className="error-box" style={{ marginTop: 8 }}>Phiếu này {mv.status === 'cancelled' ? 'đã bị hủy' : 'đã được xác nhận nhận hàng'}.</div>}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="section-head">Hàng thực nhận ({lines.length})</div>
        <p className="small">Sửa số tấn / pallet / bao theo thực tế, lot, NSX, HSD và chọn vị trí. Dòng để trống số lượng = không nhận. Hàng về nhiều lot thì thêm dòng.</p>
        {lines.map((l, i) => (
          <div key={i} className="mv-line">
            <div style={{ flex: 1 }}>
              {l.plannedKg != null && <div className="small">Dự kiến trên phiếu: <b>{t(l.plannedKg)} tấn</b></div>}
              <InLine l={l} set={(p) => setLine(i, p)} itemMap={itemMap} locations={locations} statuses={statuses} pledgees={pledgees} />
            </div>
            <button type="button" className="btn ghost" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="btn sm" onClick={() => setLines((ls) => [...ls, { ...newLine(), item: ls[ls.length - 1]?.item || '', goodsStatus: ls[ls.length - 1]?.goodsStatus || 'KTC', pledgee: ls[ls.length - 1]?.pledgee || '' }])}>+ Thêm dòng (lot khác)</button>
      </div>
      <ErrorBox error={err} />
      {pending && <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang ghi…' : '✅ Xác nhận đã nhận hàng'}</button></div>}
      <datalist id="dl-mv-item">{items.filter((x) => x.active !== false).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</datalist>
    </form>
  );
}
