import { useMemo, useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpWarehouse } from '../../lib/hooks';
import { exportTemplate, readFirstSheet, toNumber, toYmd } from '../../lib/excel';
import { kgOf, postMovement, suggestPallets } from '../../lib/stock';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { ErrorBox } from '../../components/ui';

// Cột file Excel tồn đầu kỳ: [khóa, tiêu đề, các tên cột chấp nhận]
const COLS = [
  ['company', 'Công ty', ['cong ty', 'chu hang', 'cong ty chu hang', 'company']],
  ['location', 'Vị trí', ['vi tri', 'location', 'bin']],
  ['item', 'Mã hàng', ['ma hang', 'ma mat hang', 'item']],
  ['lot', 'Lot', ['lot', 'batch', 'batch/lot', 'so lo']],
  ['mfgDate', 'NSX', ['nsx', 'ngay san xuat']],
  ['expDate', 'HSD', ['hsd', 'han su dung']],
  ['goodsStatus', 'Tình trạng', ['tinh trang', 'tinh trang hang hoa', 'status']],
  ['pledgee', 'Bên nhận thế chấp', ['ben nhan the chap', 'ngan hang']],
  ['bags', 'Số bao', ['so bao', 'bao']],
  ['pallets', 'Pallet', ['pallet', 'so pallet']],
  ['kg', 'Kg', ['kg', 'so luong (kg)', 'trong luong']],
  ['inDate', 'Ngày nhập', ['ngay nhap', 'ngay nhap kho']],
];
const CHUNK = 150; // số dòng mỗi phiếu (giới hạn 1 giao dịch Firestore)

export default function OpeningImport() {
  const { email, name } = useApp();
  const warehouses = useMyWarehouses();
  const [opWh, setOpWh] = useOpWarehouse();
  const wh = warehouses.find((w) => w.code === opWh) || (warehouses.length === 1 ? warehouses[0] : null);
  const items = useCollection('items').rows;
  const locations = useCollection('locations').rows;
  const statuses = useCollection('goodsStatus').rows;
  const pledgees = useCollection('pledgees').rows;
  const [rows, setRows] = useState([]);
  const [date, setDate] = useState(vnDate());
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();

  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const locMap = useMemo(() => new Map(locations.filter((l) => l.warehouse === wh?.code).map((l) => [l.code, l])), [locations, wh]);
  const stSet = useMemo(() => new Set(statuses.map((s) => s.code)), [statuses]);
  const plSet = useMemo(() => new Set(pledgees.map((p) => p.code)), [pledgees]);
  const coSet = new Set(useCollection('companies').rows.map((c) => c.code));

  const read = async (file) => {
    setErr(''); setMsg('');
    try {
      const sheet = await readFirstSheet(file);
      const header = (sheet[0] || []).map(norm);
      const col = Object.fromEntries(COLS.map(([k, , al]) => [k, header.findIndex((h) => al.includes(h))]));
      if (col.location < 0 || col.item < 0) throw new Error('File cần có cột "Vị trí" và "Mã hàng". Hãy dùng File mẫu.');
      const out = [];
      sheet.slice(1).forEach((c, i) => {
        if (c.every((x) => String(x ?? '').trim() === '')) return;
        const g = (k) => (col[k] >= 0 ? c[col[k]] : '');
        const r = {
          line: i + 2, company: String(g('company')).trim().toUpperCase(), location: String(g('location')).trim(), item: String(g('item')).trim(), lot: String(g('lot')).trim(),
          mfgDate: toYmd(g('mfgDate')), expDate: toYmd(g('expDate')), goodsStatus: String(g('goodsStatus')).trim().toUpperCase() || 'KTC',
          pledgee: String(g('pledgee')).trim(), bags: toNumber(g('bags')) || 0, pallets: toNumber(g('pallets')), kg: toNumber(g('kg')),
          inDate: toYmd(g('inDate')),
        };
        out.push(r);
      });
      setRows(out);
    } catch (e) {
      setErr(e.message);
    }
    fileRef.current.value = '';
  };

  // Kiểm tra từng dòng và tự tính pallet / kg nếu để trống
  const checked = useMemo(() => rows.map((r) => {
    const it = itemMap.get(r.item);
    const loc = locMap.get(r.location);
    const errs = [];
    if (!r.company) errs.push('thiếu công ty');
    else if (!coSet.has(r.company)) errs.push(`công ty ${r.company} chưa có trong danh mục`);
    if (!it) errs.push('mã hàng chưa có trong danh mục');
    if (!loc) errs.push(`vị trí chưa có trong kho ${wh?.code || ''}`);
    else if (loc.locked) errs.push('vị trí đang khóa');
    if (stSet.size && !stSet.has(r.goodsStatus)) errs.push(`tình trạng ${r.goodsStatus} không có`);
    if (r.goodsStatus === 'HTC' && !plSet.has(r.pledgee)) errs.push('HTC cần bên nhận thế chấp có trong danh mục');
    if (!(r.bags > 0) && !(r.pallets > 0)) errs.push('thiếu số lượng');
    return {
      ...r, itemName: it?.name || '', errs,
      pallets: r.pallets ?? (suggestPallets(it, r.bags) || 0),
      kg: r.kg ?? (kgOf(it, r.bags) || 0),
    };
  }), [rows, itemMap, locMap, stSet, plSet, wh, coSet.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = checked.filter((r) => r.errs.length);

  const post = async () => {
    setErr(''); setMsg(''); setBusy(true);
    const ids = [];
    try {
      for (let i = 0; i < checked.length; i += CHUNK) {
        const part = checked.slice(i, i + CHUNK);
        ids.push(await postMovement({
          type: 'in', warehouse: wh.code, date, tripId: '', partyCode: '', partyName: '', shipCode: '',
          reason: 'Tồn đầu kỳ', note: `Nhập tồn đầu kỳ từ Excel (dòng ${part[0].line}–${part[part.length - 1].line})`,
          lines: part.map((r) => ({
            item: r.item, itemName: r.itemName, lot: r.lot, mfgDate: r.mfgDate, expDate: r.expDate, inDate: r.inDate || date,
            location: r.location, goodsStatus: r.goodsStatus, pledgee: r.goodsStatus === 'HTC' ? r.pledgee : '', company: r.company,
            bags: r.bags, pallets: r.pallets, kg: r.kg,
          })),
        }, { email, name }));
      }
      setMsg(`Đã ghi ${checked.length} dòng tồn vào ${ids.length} phiếu: ${ids.join(', ')}.`);
      setRows([]);
    } catch (e) {
      setErr((ids.length ? `Đã ghi ${ids.join(', ')}. ` : '') + 'Lỗi: ' + (e.code === 'permission-denied' ? 'không có quyền.' : e.message));
    }
    setBusy(false);
  };

  return (
    <div>
      <div className="page-head">
        <h1>📋 Nhập tồn đầu kỳ</h1>
        <div className="actions">
          <button className="btn ghost" onClick={() => exportTemplate('Mau_ton_dau_ky', COLS.map((c) => c[1]))}>File mẫu</button>
        </div>
      </div>
      <p className="hint">
        Dùng một lần khi bắt đầu chạy hệ thống, hoặc khi thêm kho mới. Mỗi dòng: vị trí, mã hàng, lot, tình trạng (KTC/HTC/DGC), số bao…
        Pallet và kg để trống sẽ tự tính theo quy cách mã hàng. Hệ thống tạo phiếu nhập với lý do "Tồn đầu kỳ", hủy được nếu nhập sai.
      </p>
      <div className="toolbar">
        <select value={wh?.code || ''} onChange={(e) => { setOpWh(e.target.value); }}>
          <option value="">-- Chọn kho --</option>
          {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
        </select>
        <label className="small">Ngày chứng từ <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <button className="btn" disabled={!wh} onClick={() => fileRef.current.click()}>⬆ Chọn file Excel</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files[0] && read(e.target.files[0])} />
      </div>
      <ErrorBox error={err} />
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      {checked.length > 0 && (
        <>
          <div className="toolbar">
            <b>{checked.length} dòng · {fmtNum(checked.reduce((s, r) => s + r.kg, 0), 2)} kg</b>
            {bad.length ? <span className="badge red">{bad.length} dòng lỗi, sửa file rồi chọn lại</span> : <span className="badge green">Hợp lệ</span>}
            <button className="btn primary" disabled={!!bad.length || busy || !wh} onClick={post}>{busy ? 'Đang ghi…' : 'Ghi tồn đầu kỳ'}</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="stt">Dòng</th><th>Công ty</th><th>Vị trí</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Tình trạng</th>
                <th className="num">Số bao</th><th className="num">Pallet</th><th className="num">Kg</th><th>Ngày nhập</th><th>Lỗi</th></tr></thead>
              <tbody>
                {checked.map((r) => (
                  <tr key={r.line} style={r.errs.length ? { background: 'var(--red-soft)' } : undefined}>
                    <td className="stt">{r.line}</td><td>{r.company}</td><td>{r.location}</td><td>{r.item}</td><td>{r.itemName}</td><td>{r.lot}</td>
                    <td>{r.goodsStatus}{r.pledgee ? ` · ${r.pledgee}` : ''}</td>
                    <td className="num">{fmtNum(r.bags)}</td><td className="num">{fmtNum(r.pallets, 2)}</td><td className="num">{fmtNum(r.kg)}</td>
                    <td>{fmtDate(r.inDate || date)}</td><td className="small" style={{ color: 'var(--red)' }}>{r.errs.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
