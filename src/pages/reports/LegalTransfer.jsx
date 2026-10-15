import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useMovesRange } from '../../lib/slips';
import { crossLines, markMovementDone, setNoticeDone, useLegalNotices } from '../../lib/legalTransfer';
import { exportSheets } from '../../lib/excel';
import { vnDate } from '../../lib/trips';
import { fmtDate, fmtNum, norm } from '../../lib/utils';
import { ErrorBox } from '../../components/ui';
import { ReportTable, toSheet } from './Reports';

const n = (v) => Number(v) || 0;

// Báo cáo chuyển pháp nhân: dòng phiếu xuất có công ty xuất (tên trên phiếu giao) khác công ty của tồn bị trừ.
// Kế toán dựa vào đây để làm chuyển đổi tồn giữa VAP / PLA / DAM trên phần mềm kế toán.
export default function LegalTransfer({ wh, co, q }) {
  const { inMyWarehouses, hasRole, isAdmin, email, name } = useApp();
  const canMark = isAdmin || hasRole('ke_toan');
  const today = vnDate();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [state, setState] = useState('');
  const [err, setErr] = useState('');
  const { rows: moves, error } = useMovesRange(from, to);
  const notices = useLegalNotices();

  const rows = useMemo(() => {
    const out = [];
    for (const m of moves) {
      if (m.type !== 'out' || m.status === 'cancelled') continue;
      if (wh ? m.warehouse !== wh : !inMyWarehouses(m.warehouse)) continue;
      const nt = notices.get(m.id);
      const done = nt?.status === 'done';
      if (state === 'open' && done) continue;
      if (state === 'done' && !done) continue;
      crossLines(m).forEach((l, i) => {
        if (co && l.company !== co && m.company !== co) return;
        if (q && !norm([m.id, m.orderId, m.partyCode, m.partyName, l.item, l.itemName, l.lot].join(' ')).includes(q)) return;
        out.push({
          _k: `${m.id}|${i}`, m, first: i === 0, date: m.date, id: m.id, status: m.status === 'wait_release' ? 'Chờ giải chấp' : 'Đã xuất',
          orderId: m.orderId || '', party: m.partyName || m.partyCode || '', warehouse: m.warehouse, item: l.item, itemName: l.itemName || '',
          lot: l.lot || '', goodsStatus: l.goodsStatus || '', kg: Math.abs(n(l.kg)), from: l.company, to: m.company,
          done: done ? `✓ ${nt.doneByName || nt.doneBy}${nt.doneAt?.seconds ? ` ${new Date(nt.doneAt.seconds * 1000).toLocaleDateString('vi-VN')}` : ''}` : 'Chưa',
          isDone: done, notice: nt,
        });
      });
    }
    return out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id));
  }, [moves, notices, wh, co, q, state, inMyWarehouses]);

  // Tổng hợp theo cặp công ty và mã hàng (để làm phiếu chuyển trên phần mềm kế toán)
  const sum = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r.from}|${r.to}|${r.item}`;
      const x = m.get(k) || { _k: k, pair: `${r.from} → ${r.to}`, from: r.from, to: r.to, item: r.item, itemName: r.itemName, kg: 0, open: 0, slips: new Set() };
      x.kg += r.kg;
      if (!r.isDone) x.open += r.kg;
      x.slips.add(r.id);
      m.set(k, x);
    }
    return [...m.values()].map((x) => ({ ...x, slips: [...x.slips].join(', ') })).sort((a, b) => a.pair.localeCompare(b.pair) || a.item.localeCompare(b.item));
  }, [rows]);

  const mark = async (r) => {
    setErr('');
    try {
      if (r.isDone) await setNoticeDone(r.notice.id, false, { email, name });
      else if (r.notice) await setNoticeDone(r.notice.id, true, { email, name });
      else await markMovementDone(r.m, { email, name });
    } catch (e) { setErr(e.message); }
  };

  const cols = [
    { key: 'date', label: 'Ngày', render: (r) => fmtDate(r.date), nowrap: true },
    { key: 'id', label: 'Số phiếu xuất', render: (r) => <Link className="mono" to={`/kho/phieu/${r.id}/in`} target="_blank">{r.id}</Link>, excel: (r) => r.id, nowrap: true },
    { key: 'orderId', label: 'SO', nowrap: true },
    { key: 'party', label: 'Khách hàng' },
    { key: 'warehouse', label: 'Kho xuất' },
    { key: 'from', label: 'Từ công ty (chủ tồn)', render: (r) => <b>{r.from}</b>, excel: (r) => r.from },
    { key: 'to', label: 'Sang công ty (công ty xuất)', render: (r) => <b>{r.to}</b>, excel: (r) => r.to },
    { key: 'item', label: 'Mã hàng', nowrap: true },
    { key: 'itemName', label: 'Tên hàng' },
    { key: 'lot', label: 'Lot' },
    { key: 'kg', label: 'Số lượng (kg)', num: true, digits: 2, sum: true },
    { key: 'done', label: 'Kế toán đã chuyển', style: (r) => ({ color: r.isDone ? 'var(--green)' : 'var(--red)' }),
      render: (r) => <>{r.done}{canMark && r.first && <> <button type="button" className="btn sm no-print" onClick={() => mark(r)}>{r.isDone ? 'Mở lại' : '✓ Đã chuyển'}</button></>}</>,
      excel: (r) => r.done },
    { key: 'status', label: 'Tình trạng phiếu' },
    { key: 'goodsStatus', label: 'TTHH' },
  ];
  const sumCols = [
    { key: 'pair', label: 'Chuyển', nowrap: true },
    { key: 'item', label: 'Mã hàng', nowrap: true },
    { key: 'itemName', label: 'Tên hàng' },
    { key: 'kg', label: 'Tổng (kg)', num: true, digits: 2, sum: true },
    { key: 'open', label: 'Chưa chuyển (kg)', num: true, digits: 2, sum: true },
    { key: 'slips', label: 'Phiếu xuất' },
  ];
  const excel = () => exportSheets(`BC_chuyen_phap_nhan_${from}_${to}`, { 'Chi tiết': toSheet(cols, rows), 'Tổng hợp': toSheet(sumCols, sum) });

  return (
    <>
      <ErrorBox error={error || err} />
      <div className="filters no-print" style={{ alignItems: 'center' }}>
        <label className="small">Từ ngày <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">Đến ngày <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Tất cả</option><option value="open">Kế toán chưa chuyển</option><option value="done">Kế toán đã chuyển</option>
        </select>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={excel}>⬇ Excel</button>
        <button className="btn" onClick={() => window.print()}>🖨 In</button>
      </div>
      <p className="hint no-print">Phiếu xuất mang tên <b>công ty xuất</b> (công ty của SO, in trên phiếu giao hàng) nhưng lấy hàng từ tồn của công ty khác cùng chủ.
        Hệ thống trừ tồn đúng công ty đã chọn ở bước chọn vị trí xuất; kế toán làm chuyển pháp nhân trên phần mềm kế toán rồi bấm <b>✓ Đã chuyển</b>.</p>
      <p className="print-only small">Từ {fmtDate(from)} đến {fmtDate(to)}</p>
      <div className="section-head">Tổng hợp theo công ty và mã hàng</div>
      <ReportTable cols={sumCols} rows={sum} empty="Không có chuyển pháp nhân trong khoảng ngày này." />
      <div className="section-head" style={{ marginTop: 16 }}>Chi tiết từng dòng phiếu xuất ({rows.length})</div>
      <ReportTable cols={cols} rows={rows} empty="Không có dòng nào." />
      {rows.length > 0 && <p className="small">Cộng {fmtNum(rows.reduce((a, r) => a + r.kg, 0), 2)} kg.</p>}
    </>
  );
}
