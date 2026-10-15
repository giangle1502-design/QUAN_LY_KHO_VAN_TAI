import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { MOVE_TYPES } from '../../lib/stock';
import { fmtDate, fmtNum } from '../../lib/utils';
import { docTypeOfMovement } from '../../lib/printTemplates';
import { loadMovementData } from '../../lib/printData';
import { TemplatePage, TemplateSheets, useTemplateChoice } from '../../components/PrintTemplate';
import PalletChoice from '../../components/PalletChoice';
import { ErrorBox } from '../../components/ui';
import { MODE_LABEL, palletError, palletManaged, palletText, palletToText, setSlipPallets } from '../../lib/pallets';
import Select from '../../components/Select';

// 3 liên phiếu giao hàng: liên kho, liên vận tải (có dòng pallet), liên khách hàng (không có pallet vận tải mượn)
const COPIES = [
  { key: 'kho', label: 'Liên 1: Lưu kho' },
  { key: 'carrier', label: 'Liên 2: Giao đơn vị vận tải' },
  { key: 'customer', label: 'Liên 3: Giao khách hàng' },
];

// Bản in phiếu kho (In → Lưu PDF hoặc in giấy A4)
export default function PrintMovement({ pick = false }) {
  const { id } = useParams();
  const { settings } = useApp();
  const [params, setParams] = useSearchParams();
  const nCopies = Math.min(3, Math.max(1, Number(params.get('lien') || 3)));
  const [ver, setVer] = useState(0);
  const reload = () => setVer((x) => x + 1);
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
  }, [id, ver]);

  // Kho không quản lý pallet: phiếu chỉ ghi Kiện / Xá, không có bảng pallet
  const managed = !!wh && palletManaged(wh) && m?.palletTracked !== false;
  const choice = useTemplateChoice(m ? docTypeOfMovement(m, pick) : null, { company: m?.company || m?.lines?.find((l) => l.company)?.company, party: m?.partyCode });

  if (m === undefined || choice.loading) return <div className="center">Đang tải…</div>;
  if (!m) return <div className="center">Không tìm thấy phiếu {id}.</div>;
  const toolbar = (
    <>
      <Link className="btn" to="/kho/phieu">← Phiếu kho</Link>
      <button className="btn primary" onClick={() => window.print()}>🖨 In / Lưu PDF</button>
      {m.type === 'in' && m.status === 'posted' && <Link className="btn" to={`/kho/phieu/${m.id}/nhan`}>🏷️ In nhãn pallet</Link>}
      {m.type === 'out' && (pick ? <Link className="btn" to={`/kho/phieu/${m.id}/in`}>📄 Phiếu xuất kho</Link> : <Link className="btn" to={`/kho/phieu/${m.id}/soan`}>📋 Phiếu soạn hàng</Link>)}
      {m.type === 'out' && !pick && (
        <label className="small">Số liên <Select value={nCopies} onChange={(e) => { const p = new URLSearchParams(params); p.set('lien', e.target.value); setParams(p, { replace: true }); }}>
          <option value="3">3 liên (mặc định)</option><option value="2">2 liên</option><option value="1">1 liên</option>
        </Select></label>
      )}
      {choice.select}
    </>
  );
  // Mẫu in tự thiết kế: phiếu giao hàng cũng in 3 liên; dòng pallet thêm vào bảng hàng, trường {{Liên}}, {{Pallet xuất kèm}}
  if (choice.tpl && m.type === 'out' && !pick) {
    const pals = (c) => (m.palletMode !== 'pallet' || !managed ? [] : (m.pallets || []).filter((p) => c.key !== 'customer' || p.to !== 'carrier'));
    return (
      <div className="tpl-screen">
        <div className="no-print toolbar label-toolbar">{toolbar}</div>
        <div className="no-print" style={{ padding: '0 16px' }}><SlipPallet m={m} managed={managed} onSaved={reload} /></div>
        <TplCopies key={`${choice.tpl.id}-${ver}`} tpl={choice.tpl} m={m} copies={COPIES.slice(0, nCopies)} pals={pals} />
      </div>
    );
  }
  if (choice.tpl) return <TemplatePage key={choice.tpl.id} tpl={choice.tpl} toolbar={toolbar} load={() => loadMovementData(m)} deps={[m.id]} />;
  const meta = MOVE_TYPES[m.type];
  const tot = (k) => m.lines.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  const pend = m.status === 'pending';
  // Phiếu xuất (giao cho khách/tài xế) chỉ cần mã hàng + số lượng; chi tiết lot, vị trí, TTHH nằm ở phiếu soạn hàng
  const summary = m.type === 'out' && !pick;
  const groups = [];
  if (summary) {
    const g = new Map();
    for (const l of m.lines) {
      const x = g.get(l.item) || { item: l.item, itemName: l.itemName, kg: 0, bags: 0 };
      x.kg += Number(l.kg) || 0; x.bags += Number(l.bags) || 0; g.set(l.item, x);
    }
    groups.push(...g.values());
  }
  const hasDates = (m.lines || []).some((l) => l.mfgDate || l.expDate);
  const pickLines = pick ? [...m.lines].sort((a, b) => String(a.location).localeCompare(String(b.location)) || String(a.item).localeCompare(String(b.item))) : [];
  const signs = pick ? ['Người soạn hàng', 'Thủ kho', 'Người kiểm tra']
    : m.type === 'out'
    ? ['Người lập phiếu', 'Thủ kho', 'Tài xế / Người nhận', 'Bảo vệ']
    : m.type === 'in' ? ['Người lập phiếu', 'Thủ kho', 'Người giao hàng', 'Bảo vệ'] : ['Người lập phiếu', 'Thủ kho', 'Kế toán', 'Người duyệt'];

  // Phiếu giao hàng (phiếu xuất) mặc định in 3 liên; liên khách hàng chỉ có dòng pallet khách giữ
  const copies = summary ? COPIES.slice(0, nCopies) : [null];
  const palRows = (copy) => (!copy || m.palletMode !== 'pallet' || !managed ? [] : (m.pallets || []).filter((p) => copy.key !== 'customer' || p.to !== 'carrier'));
  const Body = ({ copy }) => (
    <>
      <div className="print-head">
        <div><b>{co?.name || settings.companyName}</b>{(co ? co.address : settings.companyAddress) ? <><br /><span className="small">{co ? co.address : settings.companyAddress}</span></> : null}{co?.taxCode ? <><br /><span className="small">MST {co.taxCode}</span></> : null}<br /><span className="small">{wh ? `${wh.name}${wh.address ? ' – ' + wh.address : ''}` : `Kho ${m.warehouse}`}</span></div>
        <div style={{ textAlign: 'right' }}>Số: <b>{m.id}</b><br /><span className="small">Ngày {fmtDate(m.date)}</span></div>
      </div>
      <h2 className="print-title">{pick ? 'PHIẾU SOẠN HÀNG' : `PHIẾU ${meta.label.toUpperCase()}`}</h2>
      {copy && <p className="print-copy-label">{copy.label}</p>}
      {pick && <p className="small" style={{ textAlign: 'center', marginTop: -6 }}>Theo phiếu xuất kho {m.id} · sắp theo vị trí để đi lấy hàng</p>}
      {m.status === 'cancelled' && <div className="error-box">PHIẾU ĐÃ HỦY: {m.cancelReason}</div>}
      {m.status === 'wait_release' && <p className="small" style={{ textAlign: 'center' }}>Phiếu chờ giải chấp hàng HTC: soạn hàng được, chỉ giao hàng khi đã lập lệnh giải chấp.</p>}
      {m.status === 'pending' && <p className="small" style={{ textAlign: 'center' }}>Phiếu chờ nhận hàng: thủ kho ghi số thực nhận, vị trí vào cột trống và xác nhận trên hệ thống.</p>}
      <table className="print-info"><tbody>
        {co && <tr><td>Công ty chủ hàng</td><td>{co.code}{co.name && co.name !== co.code ? ` – ${co.name}` : ''}</td></tr>}
        {(m.partyCode || m.partyName) && <tr><td>{m.type === 'in' && m.source !== 'SO' && m.orderType !== 'SO' ? 'Nhà cung cấp' : m.type === 'in' ? 'Khách hàng trả hàng' : 'Khách hàng'}</td><td>{m.partyCode} {m.partyName}</td></tr>}
        {m.shipCode && <tr><td>Giao đến</td><td>{m.shipCode}</td></tr>}
        {(m.carrier || m.carrierName) && <tr><td>Đơn vị vận tải</td><td>{m.carrierName || m.carrier}</td></tr>}
        {m.plate && <tr><td>Số xe</td><td>{m.plate}</td></tr>}
        {m.driverName && <tr><td>Tài xế</td><td>{m.driverName}{m.idCard ? ` · CCCD ${m.idCard}` : ''}{m.driverPhone ? ` · ĐT ${m.driverPhone}` : ''}</td></tr>}
        {m.orderId && <tr><td>{m.orderType === 'STO' || String(m.orderId).startsWith('STO') ? 'Theo lệnh chuyển kho' : m.type === 'in' && m.orderType === 'SO' ? 'Hàng trả về theo đơn bán' : m.type === 'in' ? (m.source === 'direct' ? 'Nhập trực tiếp, đơn mua' : 'Theo đơn mua') : 'Theo đơn bán'}</td><td>{m.orderId}{m.orderRef ? ` (số ${m.source === 'direct' ? 'chứng từ NCC' : 'Ecount'} ${m.orderRef})` : ''}</td></tr>}
        {trip && <tr><td>Xe</td><td>{trip.plate} · {trip.driverName} · CCCD {trip.idCard}{trip.carrierName ? ` · ${trip.carrierName}` : ''} · chuyến {m.tripId}{trip.dock ? ` · cửa ${trip.dock}` : ''}</td></tr>}
        {m.reason && <tr><td>Lý do</td><td>{m.reason}</td></tr>}
        {m.note && <tr><td>Ghi chú</td><td>{m.note}</td></tr>}
      </tbody></table>
      {summary ? (
      <table className="print-lines">
        <thead><tr><th>STT</th><th>Mã hàng</th><th>Tên hàng</th><th className="num">Số lượng (kg)</th><th className="num">Số bao</th></tr></thead>
        <tbody>{groups.map((g, i) => <tr key={g.item}><td>{i + 1}</td><td>{g.item}</td><td>{g.itemName}</td><td className="num">{fmtNum(g.kg, 2)}</td><td className="num">{fmtNum(g.bags)}</td></tr>)}
          </tbody>
        <tfoot><tr><td colSpan={3}>Cộng</td><td className="num">{fmtNum(tot('kg'), 2)}<div className="small">= {fmtNum(tot('kg') / 1000, 3, 3)} tấn</div></td><td className="num">{fmtNum(tot('bags'))}</td></tr></tfoot>
      </table>
      ) : pick ? (
      <table className="print-lines">
        <thead><tr><th>STT</th><th>Vị trí</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th>{hasDates && <><th>NSX</th><th>HSD</th></>}<th>Tình trạng</th><th className="num">Số kg</th><th className="num">Pallet</th><th className="num">Số bao</th><th>Đã soạn</th></tr></thead>
        <tbody>{pickLines.map((l, i) => (
          <tr key={i}><td>{i + 1}</td><td><b>{l.location}</b></td><td>{l.item}</td><td>{l.itemName}</td><td>{l.lot}</td>{hasDates && <><td>{fmtDate(l.mfgDate)}</td><td>{fmtDate(l.expDate)}</td></>}
            <td>{l.goodsStatus}{l.pledgee ? ` (${l.pledgee})` : ''}</td><td className="num">{fmtNum(l.kg, 2)}</td><td className="num">{fmtNum(l.pallets, 2)}</td><td className="num">{fmtNum(l.bags)}</td><td style={{ textAlign: 'center' }}>☐</td></tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={hasDates ? 8 : 6}>Cộng</td><td className="num">{fmtNum(tot('kg'), 2)}<div className="small">= {fmtNum(tot('kg') / 1000, 3, 3)} tấn</div></td><td className="num">{fmtNum(tot('pallets'), 2)}</td><td className="num">{fmtNum(tot('bags'))}</td><td></td></tr></tfoot>
      </table>
      ) : (
      <table className="print-lines">
        <thead><tr><th>STT</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Vị trí</th>{m.type === 'move' && <th>Đến vị trí</th>}
          <th>Tình trạng</th>{m.type === 'status' && <th>Tình trạng mới</th>}<th className="num">{pend ? 'Dự kiến (kg)' : 'Số kg'}</th><th className="num">Pallet</th><th className="num">Số bao</th>{pend && <><th>Thực nhận (kg)</th><th>Vị trí thực</th></>}</tr></thead>
        <tbody>
          {m.lines.map((l, i) => (
            <tr key={i}><td>{i + 1}</td><td>{l.item}</td><td>{l.itemName}</td><td>{l.lot}</td><td>{l.location}</td>{m.type === 'move' && <td>{l.toLocation}</td>}
              <td>{l.goodsStatus}</td>{m.type === 'status' && <td>{l.toStatus}{l.toPledgee ? ` (${l.toPledgee})` : ''}</td>}
              <td className="num">{fmtNum(l.kg, 2)}</td><td className="num">{fmtNum(l.pallets, 2)}</td><td className="num">{fmtNum(l.bags)}</td>{pend && <><td style={{ minWidth: 90 }}></td><td style={{ minWidth: 70 }}></td></>}</tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={m.type === 'move' || m.type === 'status' ? 7 : 6}>Cộng</td><td className="num">{fmtNum(tot('kg'), 2)}<div className="small">= {fmtNum(tot('kg') / 1000, 3, 3)} tấn</div></td><td className="num">{fmtNum(tot('pallets'), 2)}</td><td className="num">{fmtNum(tot('bags'))}</td>{pend && <><td></td><td></td></>}</tr></tfoot>
      </table>
      )}
      {(summary || m.type === 'in') && <PalletTable m={m} rows={summary ? palRows(copy) : m.palletMode === 'pallet' && managed ? m.pallets || [] : []} />}
      <div className="print-signs">
        {signs.map((s) => <div key={s}><b>{s}</b><br /><span className="small">(Ký, ghi rõ họ tên)</span><div className="sign-space" />{s === 'Người lập phiếu' ? m.createdByName : ''}</div>)}
      </div>
    </>
  );

  return (
    <div className="print-page">
      <div className="no-print toolbar">{toolbar}</div>
      {summary && <SlipPallet m={m} managed={managed} onSaved={reload} />}
      {copies.map((c, i) => <div key={i} className={copies.length > 1 ? 'print-copy' : ''}><Body copy={c} /></div>)}
    </div>
  );
}

// Bảng pallet riêng, tách khỏi bảng hàng (phiếu giao hàng, phiếu nhập)
function PalletTable({ m, rows }) {
  if (m.palletMode === 'xa') return <p className="small" style={{ margin: '4px 0' }}>Hàng: <b>{MODE_LABEL.xa}</b></p>;
  if (!rows.length) return m.palletMode === 'pallet' ? <p className="small" style={{ margin: '4px 0' }}>Hàng: <b>Kiện</b></p> : null;
  return (
    <>
      <p style={{ margin: '8px 0 2px' }}><b>PALLET {m.type === 'in' ? 'NHẬP KÈM HÀNG' : 'XUẤT KÈM HÀNG'}</b> <span className="small">(hàng Kiện)</span></p>
      <table className="print-lines print-pallet-table">
        <thead><tr><th>STT</th><th>Mã pallet</th><th>Loại pallet</th><th className="num">Số lượng (cái)</th>{m.type !== 'in' && <th>Ghi chú</th>}</tr></thead>
        <tbody>{rows.map((p, i) => (
          <tr key={i}><td>{i + 1}</td><td>{p.code}</td><td>{p.name || p.material}{p.name && p.material && !p.name.includes(p.material) ? ` (${p.material})` : ''}</td>
            <td className="num"><b>{fmtNum(p.qty)}</b></td>{m.type !== 'in' && <td>{palletToText(p)}</td>}</tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={3}>Cộng pallet</td><td className="num">{fmtNum(rows.reduce((a, p) => a + (Number(p.qty) || 0), 0))}</td>{m.type !== 'in' && <td></td>}</tr></tfoot>
      </table>
    </>
  );
}

function TplCopies({ tpl, m, copies, pals }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { loadMovementData(m).then(setData).catch((e) => setErr(e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="error-box">{err}</div>;
  if (!data) return <div className="center">Đang tải…</div>;
  return (
    <div className="tpl-pages">
      {copies.map((c) => {
        const ps = pals(c);
        // Dòng pallet không trộn vào bảng hàng: in thành bảng pallet riêng ({{BẢNG PALLET}}, hoặc tự đặt ngay dưới bảng hàng)
        return <TemplateSheets key={c.key} tpl={tpl} data={{ ...data, palletRows: ps, palletModeText: MODE_LABEL[m.palletMode] || '', copyLabel: c.label, palletText: palletText({ palletMode: m.palletMode, pallets: ps }) }} />;
      })}
    </div>
  );
}

// Chọn / đổi hình thức xuất ngay lúc in phiếu giao hàng (không hiện khi in)
function SlipPallet({ m, managed, onSaved }) {
  const { email, name } = useApp();
  const [v, setV] = useState({ palletMode: m.palletMode || '', pallets: (m.pallets || []).map((p) => ({ ...p })) });
  const [open, setOpen] = useState(!m.palletMode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (m.status === 'cancelled') return null;
  const save = async () => {
    const e = palletError(v, m, 'out', { managed });
    if (e) return setErr(e);
    setBusy(true); setErr('');
    try { await setSlipPallets(m.id, v, { email, name }, { managed }); setOpen(false); onSaved(); } catch (x) { setErr(x.code === 'permission-denied' ? 'Bạn không có quyền sửa phiếu này.' : x.message); }
    setBusy(false);
  };
  return (
    <div className="no-print slip-pallet">
      {!open ? (
        <div className="toolbar">
          <span>Hàng: <b>{m.palletMode === 'pallet' ? (managed && m.pallets?.length ? `Kiện, ${palletText(m)}` : 'Kiện') : MODE_LABEL.xa}</b>{!managed && <span className="small"> · kho quản lý theo Kiện</span>}</span>
          <button className="btn sm" onClick={() => setOpen(true)}>Đổi</button>
        </div>
      ) : (
        <>
          <b>{m.palletMode ? 'Đổi Kiện / Xá, loại pallet' : 'Kiểm tra hàng Kiện / Xá, loại pallet trước khi in phiếu giao hàng'}</b>
          <PalletChoice value={v} onChange={setV} carrier={m.carrier} carrierName={m.carrierName} sto={m.orderType === 'STO' || String(m.orderId || '').startsWith('STO')} managed={managed}
            suggestQty={Math.ceil((m.lines || []).reduce((a, l) => a + (Number(l.pallets) || 0), 0)) || ''} />
          <ErrorBox error={err} />
          <div className="toolbar">
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
            {m.palletMode && <button className="btn" onClick={() => setOpen(false)}>Đóng</button>}
          </div>
        </>
      )}
    </div>
  );
}
