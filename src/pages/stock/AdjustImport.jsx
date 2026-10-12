import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection, useMyWarehouses, useOpWarehouse, useStock } from '../../lib/hooks';
import { exportTemplate, readFirstSheet, toNumber, toYmd } from '../../lib/excel';
import { kgOf, postMovement, stockId, suggestPallets } from '../../lib/stock';
import { vnDate } from '../../lib/trips';
import { fmtNum, norm } from '../../lib/utils';
import { ErrorBox } from '../../components/ui';
import { QuickAdd } from '../../components/FormTools';
import { WithAdd } from '../../components/FormTools';

// Cột file Excel điều chỉnh tồn: [khóa, tiêu đề, các tên cột chấp nhận]
const COLS = [
  ['company', 'Công ty', ['cong ty', 'chu hang', 'cong ty chu hang', 'company']],
  ['location', 'Vị trí', ['vi tri', 'location', 'bin']],
  ['item', 'Mã hàng', ['ma hang', 'ma mat hang', 'item']],
  ['lot', 'Lot', ['lot', 'batch', 'batch/lot', 'so lo']],
  ['goodsStatus', 'Tình trạng', ['tinh trang', 'tinh trang hang hoa', 'tthh', 'status']],
  ['pledgee', 'Bên nhận thế chấp', ['ben nhan the chap', 'ngan hang']],
  ['sign', 'Tăng/Giảm', ['tang/giam', 'tang giam', 'tang / giam', '+/-', 'loai']],
  ['bags', 'Số bao', ['so bao', 'bao']],
  ['pallets', 'Pallet', ['pallet', 'so pallet']],
  ['kg', 'Kg', ['kg', 'so kg', 'so luong (kg)', 'trong luong']],
  ['inDate', 'Ngày nhập', ['ngay nhap', 'ngay nhap kho']],
  ['note', 'Ghi chú', ['ghi chu', 'note']],
];
const CHUNK = 150;
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));

export default function AdjustImport() {
  const { email, name } = useApp();
  const warehouses = useMyWarehouses();
  const [opWh, setOpWh] = useOpWarehouse();
  const wh = warehouses.find((w) => w.code === opWh) || (warehouses.length === 1 ? warehouses[0] : null);
  const items = useCollection('items').rows;
  const locations = useCollection('locations').rows;
  const statuses = useCollection('goodsStatus').rows;
  const reasons = useCollection('reasons').rows.filter((r) => ['Điều chỉnh tồn', 'Hàng lỗi'].includes(r.appliesTo));
  const coSet = new Set(useCollection('companies').rows.map((c) => c.code));
  const { rows: stock } = useStock(wh?.code || '__none__');
  const [rows, setRows] = useState([]);
  const [date, setDate] = useState(vnDate());
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();

  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const locMap = useMemo(() => new Map(locations.filter((l) => l.warehouse === wh?.code).map((l) => [l.code, l])), [locations, wh]);
  const stockMap = useMemo(() => new Map(stock.map((r) => [r._id, r])), [stock]);
  const stSet = useMemo(() => new Set(statuses.map((s) => s.code)), [statuses]);

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
        const s = norm(g('sign'));
        const bags = toNumber(g('bags')), pallets = toNumber(g('pallets')), kg = toNumber(g('kg'));
        // Giảm: cột Tăng/Giảm ghi "-", "giảm", hoặc số âm
        const minus = ['-', 'giam', 'g', 'tru'].includes(s) || [bags, pallets, kg].some((x) => x < 0);
        out.push({
          line: i + 2, company: String(g('company')).trim().toUpperCase(), location: String(g('location')).trim(), item: String(g('item')).trim(),
          lot: String(g('lot')).trim(), goodsStatus: String(g('goodsStatus')).trim().toUpperCase() || 'KTC', pledgee: String(g('pledgee')).trim(),
          sign: minus ? -1 : 1, bags: bags == null ? null : Math.abs(bags), pallets: pallets == null ? null : Math.abs(pallets), kg: kg == null ? null : Math.abs(kg),
          inDate: toYmd(g('inDate')), note: String(g('note')).trim(),
        });
      });
      setRows(out);
    } catch (e) {
      setErr(e.message);
    }
    fileRef.current.value = '';
  };

  // Kiểm tra từng dòng, tự tính pallet / kg theo quy cách, đối chiếu tồn hiện tại
  const checked = useMemo(() => rows.map((r) => {
    const it = itemMap.get(r.item);
    const loc = locMap.get(r.location);
    const errs = [];
    if (r.company && !coSet.has(r.company)) errs.push(`công ty ${r.company} chưa có trong danh mục`);
    if (!it) errs.push('mã hàng chưa có trong danh mục');
    if (!loc) errs.push(`vị trí chưa có trong kho ${wh?.code || ''}`);
    if (stSet.size && !stSet.has(r.goodsStatus)) errs.push(`tình trạng ${r.goodsStatus} không có`);
    if (r.goodsStatus === 'HTC' && !r.pledgee) errs.push('HTC cần bên nhận thế chấp');
    const bags = r.bags ?? 0;
    const pallets = r.pallets ?? (r.kg != null && !bags ? 0 : n(suggestPallets(it, bags)));
    const kg = r.kg ?? n(kgOf(it, bags));
    if (!bags && !pallets && !kg) errs.push('thiếu số lượng');
    // Dòng tồn khớp: đủ công ty thì theo khóa; thiếu công ty thì lấy dòng duy nhất cùng vị trí, mã, lot, TTHH
    const key = { warehouse: wh?.code, location: r.location, item: r.item, lot: r.lot, goodsStatus: r.goodsStatus, pledgee: r.pledgee, company: r.company };
    const same = r.company ? [] : stock.filter((x) => x.location === r.location && x.item === r.item && (x.lot || '') === r.lot && x.goodsStatus === r.goodsStatus
      && (r.goodsStatus !== 'HTC' || (x.pledgee || '') === r.pledgee));
    if (same.length > 1) errs.push(`có ${same.length} dòng tồn khác công ty, ghi rõ cột Công ty`);
    const cur = r.company ? stockMap.get(stockId(key)) : same.length === 1 ? same[0] : null;
    if (r.sign < 0) {
      if (!cur) errs.push('không có dòng tồn này để giảm (kiểm tra công ty, lot, TTHH)');
      else if (bags > n(cur.bags) + 1e-6 || pallets > n(cur.pallets) + 1e-6) errs.push(`chỉ còn ${fmtNum(cur.bags)} bao / ${fmtNum(cur.pallets, 2)} pl`);
    }
    if (r.sign > 0 && !cur && !r.company) errs.push('dòng tồn mới cần cột Công ty');
    return { ...r, itemName: it?.name || '', bags, pallets, kg, cur, errs };
  }), [rows, itemMap, locMap, stSet, stockMap, stock, wh, coSet.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = checked.filter((r) => r.errs.length);
  const sum = (s) => checked.filter((r) => r.sign === s).reduce((a, r) => a + r.kg, 0);

  const post = async () => {
    setErr(''); setMsg('');
    if (!reason) return setErr('Chọn lý do điều chỉnh.');
    setBusy(true);
    const ids = [];
    try {
      for (let i = 0; i < checked.length; i += CHUNK) {
        const part = checked.slice(i, i + CHUNK);
        ids.push(await postMovement({
          type: 'adjust', warehouse: wh.code, company: '', date, tripId: '', orderId: '', partyCode: '', partyName: '', shipCode: '',
          reason, note: `Điều chỉnh tồn từ Excel (dòng ${part[0].line}–${part[part.length - 1].line})`,
          lines: part.map((r) => ({
            item: r.item, itemName: r.itemName, lot: r.lot, mfgDate: r.cur?.mfgDate || '', expDate: r.cur?.expDate || '', inDate: r.cur?.inDate || r.inDate || date,
            location: r.location, goodsStatus: r.goodsStatus, pledgee: r.goodsStatus === 'HTC' ? r.pledgee : '', company: r.company || r.cur?.company || '',
            bags: r.sign * r.bags, pallets: r.sign * r.pallets, kg: r.sign * r.kg, ...(r.note ? { note: r.note } : {}),
          })),
        }, { email, name }));
      }
      setMsg(`Đã điều chỉnh ${checked.length} dòng tồn bằng ${ids.length} phiếu: ${ids.join(', ')}.`);
      setRows([]);
    } catch (e) {
      setErr((ids.length ? `Đã ghi ${ids.join(', ')}. ` : '') + 'Lỗi: ' + (e.code === 'permission-denied' ? 'không có quyền.' : e.message));
    }
    setBusy(false);
  };

  return (
    <div>
      <div className="page-head">
        <h1>⚖️ Điều chỉnh tồn từ Excel</h1>
        <div className="actions">
          <Link className="btn" to="/kho/adjust">Điều chỉnh từng dòng</Link>
          <button className="btn ghost" onClick={() => exportTemplate('Mau_dieu_chinh_ton', COLS.map((c) => c[1]))}>File mẫu</button>
        </div>
      </div>
      <p className="hint">
        Mỗi dòng: công ty, vị trí, mã hàng, lot, tình trạng, cột <b>Tăng/Giảm</b> ghi <b>+</b> hoặc <b>−</b> (hoặc nhập số âm để giảm), số bao / pallet / kg.
        Pallet và kg để trống sẽ tự tính theo quy cách mã hàng. Dòng giảm phải khớp đúng 1 dòng tồn (công ty, vị trí, mã, lot, TTHH).
        Hệ thống lập phiếu điều chỉnh (DC), hủy phiếu được nếu nhập sai.
      </p>
      <div className="toolbar">
        <WithAdd cat="warehouses" onAdded={(id) => setOpWh(id)}>
          <select value={wh?.code || ''} onChange={(e) => setOpWh(e.target.value)}>
            <option value="">-- Chọn kho --</option>
            {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
          </select>
        </WithAdd>
        <label className="small">Ngày chứng từ <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <span className="cell-add">
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">-- Lý do điều chỉnh --</option>
            {reasons.map((r) => <option key={r.code} value={`${r.code} – ${r.name}`}>{r.name}</option>)}
          </select>
          <QuickAdd catKey="reasons" preset={{ appliesTo: 'Điều chỉnh tồn' }} onAdded={(id, r) => setReason(`${id} – ${r?.name || ''}`)} />
        </span>
        <button className="btn" disabled={!wh} onClick={() => fileRef.current.click()}>⬆ Chọn file Excel</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files[0] && read(e.target.files[0])} />
      </div>
      <ErrorBox error={err} />
      {msg && <div className="ok-box" style={{ marginBottom: 10 }}>{msg}</div>}
      {checked.length > 0 && (
        <>
          <div className="toolbar">
            <b>{checked.length} dòng · tăng {fmtNum(sum(1), 2)} kg · giảm {fmtNum(sum(-1), 2)} kg</b>
            {bad.length ? <span className="badge red">{bad.length} dòng lỗi, sửa file rồi chọn lại</span> : <span className="badge green">Hợp lệ</span>}
            <button className="btn primary" disabled={!!bad.length || busy || !wh} onClick={post}>{busy ? 'Đang ghi…' : 'Ghi điều chỉnh tồn'}</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="stt">Dòng</th><th>Công ty</th><th>Vị trí</th><th>Mã hàng</th><th>Tên hàng</th><th>Lot</th><th>Tình trạng</th><th>Tăng/Giảm</th>
                <th className="num">Số bao</th><th className="num">Pallet</th><th className="num">Kg</th><th className="num">Tồn hiện tại (kg)</th><th className="num">Sau điều chỉnh (kg)</th><th>Lỗi</th></tr></thead>
              <tbody>
                {checked.map((r) => (
                  <tr key={r.line} style={r.errs.length ? { background: 'var(--red-soft)' } : undefined}>
                    <td className="stt">{r.line}</td><td>{r.company || r.cur?.company}</td><td>{r.location}</td><td>{r.item}</td><td>{r.itemName}</td><td>{r.lot}</td>
                    <td>{r.goodsStatus}{r.pledgee ? ` · ${r.pledgee}` : ''}</td>
                    <td><span className={`badge ${r.sign < 0 ? 'red' : 'green'}`}>{r.sign < 0 ? 'Giảm' : 'Tăng'}</span></td>
                    <td className="num">{fmtNum(r.bags)}</td><td className="num">{fmtNum(r.pallets, 2)}</td><td className="num">{fmtNum(r.kg, 2)}</td>
                    <td className="num">{r.cur ? fmtNum(r.cur.kg, 2) : '–'}</td><td className="num">{fmtNum(n(r.cur?.kg) + r.sign * r.kg, 2)}</td>
                    <td className="small" style={{ color: 'var(--red)' }}>{r.errs.join('; ')}</td>
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
