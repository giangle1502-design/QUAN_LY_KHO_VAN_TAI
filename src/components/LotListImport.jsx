import { useState } from 'react';
import { Modal } from './ui';
import Select from './Select';
import { exportTemplate, readFirstSheet } from '../lib/excel';
import { LOT_LIST_HEADERS, LOT_LIST_NOTES, applyLotList, parseLotRows, splitPasted } from '../lib/lots';
import { fmtNum } from '../lib/utils';

// Danh sách lot NCC gửi trước (packing list): dán từ Excel hoặc nhập file → mỗi lot 1 dòng trên phiếu,
// giữ vị trí / tình trạng của dòng đang chọn. Nhập xong in nhãn pallet trước khi hàng về,
// dỡ pallet nào dán nhãn, đưa vào vị trí ngay.
export default function LotListImport({ lines, setLines, itemMap, maxLines = 0 }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null); // ô từ file Excel
  const [fileName, setFileName] = useState('');
  const [msg, setMsg] = useState('');
  const opts = lines.map((l, i) => ({ i, l })).filter(({ l }) => l.item);
  const target = lines[at]?.item ? at : (opts[0]?.i ?? 0);
  const item = itemMap.get(lines[target]?.item);
  const parsed = item ? parseLotRows(rows || splitPasted(text), item) : { lots: [], errors: [] };
  const sameCount = lines.filter((l) => l.item === lines[target]?.item && (l._mv || '') === (lines[target]?._mv || '') && (l.orderId || '') === (lines[target]?.orderId || '')).length;
  const tooMany = maxLines && lines.length - sameCount + parsed.lots.length > maxLines;
  const reset = () => { setText(''); setRows(null); setFileName(''); setMsg(''); };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try { setRows(await readFirstSheet(f)); setFileName(f.name); setText(''); setMsg(''); } catch (er) { setMsg('Không đọc được file: ' + er.message); }
  };
  const apply = () => {
    if (!item) return setMsg('Chọn dòng mã hàng cần nhập lot.');
    if (!parsed.lots.length) return setMsg('Chưa có lot nào. Dán danh sách từ Excel hoặc chọn file.');
    if (tooMany) return setMsg(`Phiếu tối đa ${maxLines} dòng.`);
    setLines(applyLotList(lines, target, parsed.lots));
    setOpen(false); reset();
  };
  const tot = parsed.lots.reduce((a, x) => ({ kg: a.kg + (Number(x.kg) || 0), pallets: a.pallets + (Number(x.pallets) || 0) }), { kg: 0, pallets: 0 });

  return (<>
    <button type="button" className="btn sm" onClick={() => { setOpen(true); setAt(target); }} title="Lot NCC gửi trước: dán / nhập Excel để có sẵn các dòng lot, in nhãn pallet trước khi hàng về">📋 Nhập danh sách lot NCC</button>
    {open && (
      <Modal title="📋 Nhập danh sách lot NCC gửi trước" onClose={() => { setOpen(false); reset(); }} wide>
        <p className="small" style={{ marginTop: 0 }}>Mỗi lot thành 1 dòng trên phiếu, giữ <b>vị trí, tình trạng</b> của dòng đang chọn. Dòng xếp <b>lot nhiều trước</b> (in nhãn trước, đưa vào trong cùng vị trí), <b>lot ít sau</b> (nằm phía ngoài, khi xuất hệ thống tự lấy trước). Nhập xong bấm <b>🏷️ In nhãn pallet</b> để in trước khi hàng về.</p>
        <label className="small">Dòng mã hàng</label>
        <Select value={String(target)} onChange={(e) => setAt(Number(e.target.value))}>
          {opts.map(({ i, l }) => <option key={i} value={String(i)}>{`Dòng ${i + 1}: ${l.item} ${itemMap.get(l.item)?.name || ''}${l._oid || l.orderId ? ` · đơn ${l._oid || l.orderId}` : ''}${l.location ? ` · vị trí ${l.location}` : ''}`}</option>)}
        </Select>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 6px', alignItems: 'center' }}>
          <button type="button" className="btn sm" onClick={() => exportTemplate('Mau_danh_sach_lot_NCC', LOT_LIST_HEADERS, LOT_LIST_NOTES)}>⬇ Tải file mẫu</button>
          <label className="btn sm">📂 Nhập file Excel<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={onFile} /></label>
          {fileName && <span className="small">Đã đọc <b>{fileName}</b> <button type="button" className="btn sm ghost" onClick={() => { setRows(null); setFileName(''); }}>✕</button></span>}
        </div>
        {!rows && <textarea rows={7} style={{ width: '100%', fontFamily: 'monospace' }} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'Hoặc dán từ Excel (cột theo thứ tự): Lot | Số kg | Số bao | Số pallet | NSX | HSD\nVí dụ:\nL240115A\t24750\t990\t18\nL240115B\t8250\t330\t6'} />}
        {parsed.errors.length > 0 && <div className="error-box">{parsed.errors.slice(0, 8).map((x) => <div key={x}>{x}</div>)}{parsed.errors.length > 8 && <div>… và {parsed.errors.length - 8} lỗi khác</div>}</div>}
        {parsed.lots.length > 0 && (
          <div className="table-wrap" style={{ maxHeight: 260, overflow: 'auto', marginTop: 6 }}>
            <table>
              <thead><tr><th>#</th><th>Lot</th><th className="num">Số kg</th><th className="num">Số bao</th><th className="num">Pallet</th></tr></thead>
              <tbody>{[...parsed.lots].sort((a, b) => (Number(b.kg) || 0) - (Number(a.kg) || 0)).map((x, k) => (
                <tr key={k}><td>{k + 1}</td><td>{x.lot}</td><td className="num">{fmtNum(x.kg, 2)}</td><td className="num">{fmtNum(x.bags)}</td><td className="num">{fmtNum(x.pallets, 2)}</td></tr>))}</tbody>
              <tfoot><tr><td colSpan={2}>{parsed.lots.length} lot</td><td className="num">{fmtNum(tot.kg, 2)}</td><td></td><td className="num">{fmtNum(tot.pallets, 2)}</td></tr></tfoot>
            </table>
          </div>
        )}
        {tooMany && <div className="error-box">Phiếu tối đa {maxLines} dòng: bớt lot hoặc tách phiếu.</div>}
        {msg && <div className="error-box">{msg}</div>}
        <div className="form-actions">
          <button type="button" className="btn primary" disabled={!parsed.lots.length || !!tooMany} onClick={apply}>Thay {sameCount} dòng {lines[target]?.item} bằng {parsed.lots.length} dòng lot</button>
          <button type="button" className="btn" onClick={() => { setOpen(false); reset(); }}>Hủy</button>
        </div>
      </Modal>
    )}
  </>);
}
