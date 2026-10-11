import { useEffect, useRef, useState } from 'react';
import { useItemStock } from '../lib/hooks';
import { ageDays } from '../lib/stock';
import { fmtDate, fmtNum } from '../lib/utils';
import { Modal } from './ui';

const num = (v) => (v === '' || v == null ? 0 : Number(v));
const STATUS_COLS = ['HTC', 'KTC', 'DGC'];

// Mã hàng bấm được: mở menu → "Xem tồn kho" (tồn của mã này ở mọi kho)
export function ItemCode({ code, onStock, label }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const c = () => setOpen(false);
    document.addEventListener('mousedown', h);
    window.addEventListener('scroll', c, true);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('scroll', c, true); };
  }, [open]);
  return (
    <span ref={ref} className="item-code">
      <button type="button" className="link-btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setOpen((o) => (o ? false : { top: r.bottom + 4, left: r.left })); }} title="Bấm để xem tồn kho của mã hàng này">{label || code} ▾</button>
      {open && <div className="item-menu" style={{ position: 'fixed', top: open.top, left: open.left }}><button type="button" onClick={() => { setOpen(false); onStock(code); }}>📦 Xem tồn kho</button></div>}
    </span>
  );
}

// Tồn của một mã hàng theo từng kho → mở kho xem chi tiết lot / vị trí / tình trạng → chọn kho (và tick dòng tồn) để điền vào phiếu
// pickRows=false (lập đơn SO/STO): chỉ chọn kho, không tick dòng tồn; allowWh: kho nào được chọn
export function ItemStockModal({ item, itemName, whCode, warehouses, company, blocked = () => false, chosen = new Set(), need = 0, onClose, onPick,
  pickRows = true, allowWh, pickLabel = 'Chọn kho này', curLabel = 'Giữ kho này', note }) {
  const { rows, loading } = useItemStock(item);
  const [onlyCo, setOnlyCo] = useState(!!company);
  const [openWh, setOpenWh] = useState(whCode);
  const [sel, setSel] = useState(() => new Set());
  const list = rows.filter((r) => !onlyCo || !company || (r.company || '') === company);
  const others = [...new Set(list.map((r) => r.goodsStatus))].filter((c) => !STATUS_COLS.includes(c));
  const cols = [...STATUS_COLS, ...others];
  const whName = new Map(warehouses.map((w) => [w.code, w.name]));
  const groups = [...list.reduce((m, r) => { (m.get(r.warehouse) || m.set(r.warehouse, []).get(r.warehouse)).push(r); return m; }, new Map())]
    .map(([code, rs]) => {
      rs.sort((a, b) => String(a.inDate).localeCompare(String(b.inDate)) || String(a.location).localeCompare(String(b.location)));
      const by = {};
      for (const r of rs) by[r.goodsStatus] = (by[r.goodsStatus] || 0) + num(r.kg);
      const free = rs.filter((r) => !blocked(r)).reduce((a, r) => a + num(r.kg), 0);
      return { code, rs, by, free, total: rs.reduce((a, r) => a + num(r.kg), 0), ok: whName.has(code) && (!allowWh || allowWh(code)) };
    })
    .sort((a, b) => b.free - a.free || a.code.localeCompare(b.code));
  const selWh = list.find((r) => sel.has(r._id))?.warehouse || '';
  const toggle = (r) => setSel((s) => {
    const n = new Set(r.warehouse === selWh ? s : []);
    n.has(r._id) ? n.delete(r._id) : n.add(r._id);
    return n;
  });
  const selKg = list.filter((r) => sel.has(r._id)).reduce((a, r) => a + num(r.kg), 0);
  const sum = (k) => groups.reduce((a, g) => a + (k === 'free' ? g.free : k === 'total' ? g.total : g.by[k] || 0), 0);
  const otherCo = company ? rows.filter((r) => (r.company || '') !== company).length : 0;
  return (
    <Modal title={`Tồn kho mã ${item}${itemName ? ` – ${itemName}` : ''}`} onClose={onClose} wide>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="small">{note || <>Bấm vào một kho để xem chi tiết lot, vị trí, tình trạng. <b>{pickLabel}</b> để xuất từ kho đó{pickRows ? ', hoặc tick dòng tồn rồi thêm vào phiếu' : ''}.</>}</span>
        {need > 0 && <span className="small" style={{ marginLeft: 'auto' }}>{pickRows ? 'Đơn còn cần xuất' : 'Số lượng dòng'}: <b>{fmtNum(need, 2)} kg</b></span>}
        {company && <label className="small" style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={onlyCo} onChange={(e) => { setOnlyCo(e.target.checked); setSel(new Set()); }} /> Chỉ công ty {company}{otherCo ? ` (ẩn ${otherCo} dòng công ty khác)` : ''}</label>}
      </div>
      <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
        <table className="picker">
          <thead><tr><th></th><th>Kho</th><th>Lot</th><th>Vị trí</th><th>Ngày nhập</th><th>Công ty</th>
            {cols.map((c) => <th key={c} className="num">{c} (kg)</th>)}<th className="num">Tổng (kg)</th><th className="num">Xuất được (kg)</th><th className="num">Pallet</th><th className="num">Số bao</th><th></th></tr></thead>
          <tbody>
            {groups.map((g) => {
              const isOpen = openWh === g.code;
              return [
                <tr key={g.code} className={'wh-row' + (g.code === whCode ? ' cur' : '')} onClick={() => setOpenWh(isOpen ? '' : g.code)} style={{ cursor: 'pointer' }}>
                  <td>{isOpen ? '▾' : '▸'}</td>
                  <td colSpan={5}><b>{g.code}</b> {whName.get(g.code) || ''} <small className="small">· {g.rs.length} dòng tồn{g.code === whCode ? ' · kho đang chọn' : ''}</small></td>
                  {cols.map((c) => <td key={c} className="num">{g.by[c] ? fmtNum(g.by[c], 2) : ''}</td>)}
                  <td className="num"><b>{fmtNum(g.total, 2)}</b></td>
                  <td className="num" style={{ color: g.free > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{fmtNum(g.free, 2)}</td>
                  <td className="num">{fmtNum(g.rs.reduce((a, r) => a + num(r.pallets), 0), 2)}</td><td className="num">{fmtNum(g.rs.reduce((a, r) => a + num(r.bags), 0))}</td>
                  <td>{g.ok
                    ? <button type="button" className="btn sm primary" onClick={(e) => { e.stopPropagation(); onPick(g.code, []); }}>{g.code === whCode ? curLabel : pickLabel}</button>
                    : <small className="small">{whName.has(g.code) ? 'không chọn được' : 'không có quyền'}</small>}</td>
                </tr>,
                ...(isOpen ? g.rs.map((r) => {
                  const lock = blocked(r); const had = g.code === whCode && chosen.has(r._id);
                  const can = pickRows && g.ok && !lock && !had;
                  return (
                    <tr key={r._id} className={'sub' + (lock ? ' locked' : sel.has(r._id) ? ' picked' : '')} onClick={() => can && toggle(r)} style={{ cursor: can ? 'pointer' : pickRows ? 'not-allowed' : 'default' }}>
                      <td></td>
                      <td>{lock ? '🔒' : !pickRows ? '' : <input type="checkbox" checked={had || sel.has(r._id)} disabled={!can} onChange={() => toggle(r)} onClick={(e) => e.stopPropagation()} />}</td>
                      <td>{r.lot || '-'}</td><td>{r.location}</td><td>{fmtDate(r.inDate)} <small className="small">({ageDays(r.inDate)} ngày)</small></td><td>{r.company || ''}</td>
                      {cols.map((c) => <td key={c} className="num">{r.goodsStatus === c ? fmtNum(num(r.kg), 2) : ''}{r.goodsStatus === c && r.pledgee ? <small className="small"> {r.pledgee}</small> : ''}</td>)}
                      <td className="num">{fmtNum(num(r.kg), 2)}</td><td className="num">{lock ? '' : fmtNum(num(r.kg), 2)}</td>
                      <td className="num">{fmtNum(r.pallets, 2)}</td><td className="num">{fmtNum(r.bags)}</td><td>{had ? <small className="small">đã có trong phiếu</small> : ''}</td>
                    </tr>
                  );
                }) : []),
              ];
            })}
            {!groups.length && <tr><td colSpan={11 + cols.length} className="small">
              {loading ? 'Đang tải tồn kho…' : otherCo && onlyCo ? <>Mã {item} có tồn nhưng không thuộc công ty <b>{company}</b>. <button type="button" className="btn sm" onClick={() => setOnlyCo(false)}>Xem tồn của mọi công ty</button></> : `Mã ${item} không còn tồn ở kho nào bạn được xem.`}
            </td></tr>}
          </tbody>
          {groups.length > 1 && <tfoot><tr><td colSpan={6}>Cộng {groups.length} kho</td>{cols.map((c) => <td key={c} className="num">{fmtNum(sum(c), 2)}</td>)}
            <td className="num">{fmtNum(sum('total'), 2)}</td><td className="num">{fmtNum(sum('free'), 2)}</td><td colSpan={3}></td></tr></tfoot>}
        </table>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
        <small className="small">🔒 = hàng bị khóa xuất. Xuất được = tồn trừ hàng bị khóa; hàng HTC xuất bán được, khi lập phiếu tự vào đề nghị giải chấp và đổi tình trạng.{pickRows ? ' Mỗi phiếu xuất từ một kho, nên chỉ tick được dòng của cùng một kho.' : ''}</small>
        {pickRows && <button type="button" className="btn primary" disabled={!sel.size} onClick={() => onPick(selWh, list.filter((r) => sel.has(r._id)))}>
          {sel.size ? `Chọn kho ${selWh} & thêm ${sel.size} dòng (${fmtNum(selKg, 2)} kg)` : 'Tick dòng tồn để thêm vào phiếu'}</button>}
      </div>
    </Modal>
  );
}

