import { useEffect, useMemo, useRef, useState } from 'react';
import { useCollection, useOrders } from '../lib/hooks';
import { usePref } from '../lib/prefs';
import { vnDate } from '../lib/trips';
import { fmtDate, fmtNum } from '../lib/utils';
import { ducHoaWarehouse, matchCarrier, matchItem, matchParty, matchWarehouse, ocrImage, parseSlip } from '../lib/docScan';
import { ErrorBox, Modal } from './ui';
import { QuickAdd, WithAdd } from './FormTools';
import Select from './Select';

// Lập đơn từ ảnh chụp phiếu Ecount (dùng song song Ecount + hệ thống này ở kho Đức Hòa):
//  - Biên bản giao hàng (PXK…)          → SO  (khách = Công ty mua, công ty xuất = Công ty bán)
//  - Phiếu đề nghị nhập kho (PCK / PNK…) → PO  (công ty = "Đề nghị nhập hàng cho công ty", kho = "Kho nhập")
//                                         hoặc STO nếu hàng chuyển từ một kho khác đang quản lý trên hệ thống
// Dán ảnh (Ctrl+V) / kéo thả / chọn file → đọc ảnh → mở form đơn nháp đã điền sẵn để kiểm tra, sửa rồi mới lưu.
// Vị trí nhập / xuất chọn ở bước lập phiếu nhập / xuất kho, không chọn trên đơn.
export const SCAN_KINDS = { BBGH: 'Biên bản giao hàng', DNNK: 'Phiếu đề nghị nhập kho' };

export function buildDraft(scan, target, cat, prefs, extra = {}) {
  const sell = scan.kind === 'BBGH';
  const coM = matchParty(sell ? scan.seller : { name: scan.toCompany }, cat.companies);
  const company = coM.rec?.code || '';
  const dh = ducHoaWarehouse(cat.warehouses, company)?.code || '';
  const remembered = prefs.wh?.[`${target}|${company}`] || '';
  const whRead = scan.warehouse ? matchWarehouse(scan.warehouse, cat.warehouses) : null;
  // SO: không điền sẵn kho xuất (đến ngày giao mới biết hàng ở kho nào → chọn ở phiếu xuất)
  const wh = target === 'SO' ? '' : whRead?.code || remembered || dh;
  const partyM = target === 'SO' ? matchParty(scan.buyer, cat.soldto) : { rec: cat.suppliers.find((s) => s.code === prefs.supplier?.[company]) || null, how: prefs.supplier?.[company] ? 'last' : '' };
  const car = matchCarrier(scan.carrier, cat.carriers);
  const lines = scan.lines.map((l) => {
    const m = matchItem(l, cat.items);
    return {
      item: m.rec?.code || '', itemName: m.rec?.name || '', qtyKg: l.qtyKg ?? '', dueDate: scan.date || '',
      ...(target === 'STO' ? { fromWarehouse: extra.fromWh || '', toWarehouse: wh } : { warehouse: wh }),
      goodsStatus: target === 'SO' ? '' : l.goodsStatus || '', packing: l.packing || scan.packing || '', note: '',
    };
  });
  const no = scan.slipNo || '';
  return {
    type: target, scan, imageUrl: extra.imageUrl || '', fromText: !!extra.fromText,
    match: { company: coM.how, party: partyM.how, carrier: car ? (car._near ? 'near' : 'exact') : '', warehouse: target === 'SO' ? '' : whRead ? 'read' : remembered ? 'last' : dh ? 'dh' : '' },
    head: {
      date: scan.date || vnDate(), company, partyCode: partyM.rec?.code || '', partyName: partyM.rec?.name || '',
      refNo: (sell ? scan.soNo : '') || no || '',
      note: `Từ ảnh ${SCAN_KINDS[scan.kind] || 'phiếu'} Ecount ${no || ''}${sell && scan.soNo ? ` (đơn Ecount ${scan.soNo})` : ''}`.trim(),
      ecount: {
        doc: scan.kind || '', slipNo: no || '', soNo: scan.soNo || '', date: scan.date || '',
        carrier: car?.code || '', carrierName: car?.name || scan.carrier || '', plate: scan.plate || '',
        driverName: scan.driverName || '', idCard: scan.idCard || '', recipient: scan.recipient || '', warehouseText: scan.warehouse || '',
        scannedAt: new Date().toISOString(),
      },
    },
    lines: lines.length ? lines : undefined,
  };
}

// Nút + hộp dán ảnh. want: loại đơn đang xem (SO / PO / STO) để gợi ý
export function ScanButton({ want = 'SO', onDraft, autoOpen = false, onAutoDone }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (autoOpen) { setOpen(true); onAutoDone?.(); } }, [autoOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <button type="button" className="btn" title="Dán ảnh chụp Biên bản giao hàng (→ SO) hoặc Phiếu đề nghị nhập kho (→ PO) của Ecount" onClick={() => setOpen(true)}>📷 Từ ảnh phiếu Ecount</button>
      {open && <ScanModal want={want} onClose={() => setOpen(false)} onDraft={(d) => { setOpen(false); onDraft(d); }} />}
    </>
  );
}

export function ScanModal({ want = 'SO', onClose, onDraft }) {
  const [img, setImg] = useState(null); // { blob, url }
  const [text, setText] = useState('');
  const [prog, setProg] = useState(null);
  const [scan, setScan] = useState(null);
  const [err, setErr] = useState('');
  const [target, setTarget] = useState('');
  const [fromWh, setFromWh] = useState('');
  const [prefs, setPrefs] = usePref('scan-defaults', {});
  const fileRef = useRef();
  const cat = {
    companies: useCollection('companies').rows, soldto: useCollection('soldto').rows, suppliers: useCollection('suppliers').rows,
    items: useCollection('items').rows, warehouses: useCollection('warehouses').rows.filter((w) => w.active !== false).sort((a, b) => a.code.localeCompare(b.code)),
    carriers: useCollection('carriers').rows,
  };

  const runImage = async (blob) => {
    setErr(''); setScan(null); setText('');
    const url = URL.createObjectURL(blob);
    setImg({ blob, url });
    setProg({ stage: 'Bắt đầu…', pct: 0 });
    try {
      const r = await ocrImage(blob, setProg);
      const s = parseSlip(r);
      if (!s.kind && !s.lines.length) throw new Error('Không nhận ra phiếu Ecount trong ảnh. Chụp rõ cả tiêu đề phiếu và bảng hàng hóa rồi thử lại.');
      setScan(s);
      setTarget(s.kind === 'DNNK' ? (want === 'STO' ? 'STO' : 'PO') : s.kind === 'BBGH' ? 'SO' : want);
    } catch (e) { setErr(e.message || String(e)); }
    setProg(null);
  };
  const runText = (t) => {
    setErr(''); setImg(null);
    const s = parseSlip({ text: t });
    if (!s.kind && !s.lines.length) { setScan(null); return setErr('Không nhận ra nội dung phiếu trong chữ đã dán.'); }
    setScan(s);
    setTarget(s.kind === 'DNNK' ? (want === 'STO' ? 'STO' : 'PO') : s.kind === 'BBGH' ? 'SO' : want);
  };
  // Ctrl+V ở bất kỳ đâu trong hộp: ảnh → đọc ảnh; chữ (copy từ trang in Ecount) → đọc chữ
  useEffect(() => {
    const h = (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const im = items.find((i) => i.type.startsWith('image/'));
      if (im) { e.preventDefault(); runImage(im.getAsFile()); return; }
      if (e.target?.tagName === 'TEXTAREA' || e.target?.tagName === 'INPUT') return;
      const t = e.clipboardData?.getData('text/plain');
      if (t && t.trim()) { e.preventDefault(); setText(t); runText(t); }
    };
    window.addEventListener('paste', h);
    return () => window.removeEventListener('paste', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (img?.url) URL.revokeObjectURL(img.url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onDrop = (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) runImage(f);
  };
  const open = () => {
    if (target === 'STO' && !fromWh) return setErr('Chọn kho xuất (kho hàng chuyển đi) cho lệnh chuyển kho.');
    const d = buildDraft(scan, target, cat, prefs, { fromWh, imageUrl: img?.url || '', fromText: !img });
    onDraft({ ...d, imageBlob: img?.blob || null });
  };
  const totalKg = scan ? scan.lines.reduce((s, l) => s + (Number(l.qtyKg) || 0), 0) : 0;
  const busy = !!prog;
  const party = scan?.kind === 'BBGH' ? scan.buyer?.name : scan?.toCompany;

  return (
    <Modal title="📷 Lập đơn từ ảnh phiếu Ecount" onClose={onClose} wide>
      <div className="scan-drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onClick={() => !busy && fileRef.current?.click()}>
        {img ? <img src={img.url} alt="Ảnh phiếu" /> : (
          <div>
            <div style={{ fontSize: 32 }}>📋</div>
            <b>Dán ảnh chụp phiếu (Ctrl+V)</b>, kéo thả ảnh vào đây, hoặc bấm để chọn file ảnh
            <div className="small" style={{ marginTop: 6 }}>Biên bản giao hàng → <b>SO</b> · Phiếu đề nghị nhập kho → <b>PO</b> (hoặc STO). Chụp đủ tiêu đề, thông tin phiếu và bảng hàng hóa.</div>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) runImage(f); e.target.value = ''; }} />
      </div>
      <details style={{ margin: '8px 0' }}>
        <summary className="small">Hoặc dán chữ copy từ trang in của Ecount (Ctrl+A, Ctrl+C trên trang phiếu)</summary>
        <textarea rows={5} style={{ width: '100%' }} value={text} placeholder="Dán nội dung phiếu vào đây…" onChange={(e) => setText(e.target.value)} />
        <button type="button" className="btn sm" disabled={!text.trim()} onClick={() => runText(text)}>Đọc chữ đã dán</button>
      </details>
      {prog && (
        <div style={{ margin: '10px 0' }}>
          <div className="small">{prog.stage} {prog.pct ? `${prog.pct}%` : ''}</div>
          <div className="meter" style={{ width: '100%' }}><span className="bar" style={{ width: '100%' }}><div style={{ width: `${prog.pct || 3}%` }} /></span></div>
        </div>
      )}
      <ErrorBox error={err} />
      {scan && !busy && (
        <div className="so-section">
          <div className="section-head">Đã đọc: {SCAN_KINDS[scan.kind] || 'Phiếu chưa rõ loại'} {scan.slipNo && <b className="mono">{scan.slipNo}</b>}</div>
          <table className="kv-table">
            <tbody>
              <tr><th>Ngày</th><td>{scan.date ? fmtDate(scan.date) : <span className="req">chưa đọc được</span>}</td></tr>
              {scan.soNo && <tr><th>Số đơn hàng Ecount</th><td className="mono">{scan.soNo}</td></tr>}
              <tr><th>{scan.kind === 'BBGH' ? 'Công ty bán → mua' : 'Nhập cho công ty'}</th><td>{scan.kind === 'BBGH' ? `${scan.seller?.name || '?'} → ${party || '?'}` : party || '?'}</td></tr>
              {scan.warehouse && <tr><th>Kho nhập</th><td>{scan.warehouse}</td></tr>}
              {(scan.carrier || scan.plate) && <tr><th>Vận tải</th><td>{[scan.carrier, scan.plate, scan.driverName, scan.idCard && `CCCD ${scan.idCard}`].filter(Boolean).join(' · ')}</td></tr>}
              <tr><th>Hàng hóa</th><td>{scan.lines.length} dòng · {fmtNum(totalKg, 2)} kg{scan.total?.qty != null && Math.abs(scan.total.qty - totalKg) > 0.001 && <span className="req"> · lệch Tổng cộng {fmtNum(scan.total.qty, 2)} kg</span>}</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            <b>Lập thành:</b>{' '}
            <label className="inline"><input type="radio" checked={target === 'SO'} onChange={() => setTarget('SO')} /> Đơn bán (SO)</label>{' '}
            <label className="inline"><input type="radio" checked={target === 'PO'} onChange={() => setTarget('PO')} /> Đơn mua (PO)</label>{' '}
            <label className="inline"><input type="radio" checked={target === 'STO'} onChange={() => setTarget('STO')} /> Lệnh chuyển kho (STO)</label>
          </div>
          {scan.kind === 'DNNK' && target === 'PO' && <p className="small">Phiếu đề nghị nhập kho của Ecount không ghi kho chuyển đi (thường là hàng từ cảng / nhà cung cấp về) nên lập <b>PO</b>. Nếu hàng chuyển từ một kho khác đang quản lý trên hệ thống này thì chọn <b>STO</b> để kho kia lập phiếu xuất, kho này nhập theo phiếu xuất.</p>}
          {target === 'STO' && (
            <div style={{ maxWidth: 420 }}>
              <span className="small">Kho xuất (hàng chuyển đi từ kho):</span>
              <WithAdd cat="warehouses" onAdded={(id) => setFromWh(id)}>
                <Select value={fromWh} onChange={(e) => setFromWh(e.target.value)}>
                  <option value="">-- Chọn kho xuất --</option>
                  {cat.warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
                </Select>
              </WithAdd>
            </div>
          )}
          {scan.kind === 'BBGH' && target !== 'SO' && <p className="small req">Biên bản giao hàng là hàng xuất đi: thường lập SO.</p>}
          {scan.kind === 'DNNK' && target === 'SO' && <p className="small req">Phiếu đề nghị nhập kho là hàng nhập về: thường lập PO hoặc STO.</p>}
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={open}>Mở {target} nháp để kiểm tra ▶</button>
          </div>
          <p className="small">Đơn chưa lưu: bạn xem lại từng ô trên form (ô đọc chưa chắc có cảnh báo), sửa nếu cần rồi bấm <b>Lập đơn</b>. Vị trí nhập / xuất chọn ở bước lập phiếu nhập / xuất kho.</p>
          <RememberNote prefs={prefs} setPrefs={setPrefs} />
        </div>
      )}
    </Modal>
  );
}
function RememberNote({ prefs, setPrefs }) {
  const n = Object.keys(prefs.wh || {}).length + Object.keys(prefs.supplier || {}).length;
  if (!n) return null;
  return <p className="small">Đang nhớ {n} lựa chọn kho / nhà cung cấp lần trước để điền sẵn. <button type="button" className="btn ghost sm" onClick={() => setPrefs({})}>Quên hết</button></p>;
}

// Bảng đối chiếu trên form đơn nháp: ảnh gốc + từng thông tin đọc được, khớp danh mục chưa, nút (+) thêm nhanh khi chưa có
const HOW = {
  exact: ['green', '✓ khớp'], tax: ['green', '✓ khớp MST'], ocr: ['amber', '≈ đoán (ảnh mờ)'], near: ['amber', '≈ gần đúng, kiểm tra'],
  name: ['amber', '≈ theo tên, kiểm tra'], last: ['blue', 'theo lần trước'], dh: ['blue', 'kho Đức Hòa'], read: ['green', '✓ theo phiếu'], '': ['red', '⚠ chưa khớp'],
};
const Tag = ({ how }) => { const [c, l] = HOW[how] || HOW['']; return <span className={`badge ${c}`}>{l}</span>; };

export function ScanPanel({ draft, type, h, setH, setHead, lines, setLine, party }) {
  const scan = draft.scan;
  const items = useCollection('items').rows;
  const carriers = useCollection('carriers').rows;
  const companies = useCollection('companies').rows;
  const { rows: orders } = useOrders(type);
  const [prefs, setPrefs] = usePref('scan-defaults', {});
  const [show, setShow] = useState(true);
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const e = h.ecount || {};
  const setE = (k, v) => setH((x) => ({ ...x, ecount: { ...(x.ecount || {}), [k]: v } }));
  // Trùng: cùng số phiếu Ecount đã lập đơn (chưa hủy)
  const live = orders.filter((o) => o.status !== 'cancelled');
  const dupSlip = e.slipNo ? live.filter((o) => o.ecount?.slipNo === e.slipNo) : [];
  const sameRef = h.refNo ? live.filter((o) => o.refNo === h.refNo && !dupSlip.includes(o)) : [];
  // Nhớ kho / nhà cung cấp người dùng chọn cho lần sau (theo công ty)
  const wh0 = type === 'STO' ? lines[0]?.toWarehouse : lines[0]?.warehouse;
  useEffect(() => {
    if (!h.company) return;
    const k = `${type}|${h.company}`;
    const next = { ...prefs };
    let ch = false;
    if (wh0 && prefs.wh?.[k] !== wh0) { next.wh = { ...(prefs.wh || {}), [k]: wh0 }; ch = true; }
    if (type === 'PO' && h.partyCode && prefs.supplier?.[h.company] !== h.partyCode) { next.supplier = { ...(prefs.supplier || {}), [h.company]: h.partyCode }; ch = true; }
    if (ch) setPrefs(next);
  }, [h.company, h.partyCode, wh0]); // eslint-disable-line react-hooks/exhaustive-deps

  const sell = scan.kind === 'BBGH';
  const coRead = sell ? scan.seller : { name: scan.toCompany };
  const partyRead = sell ? scan.buyer : null;
  const partyOk = !!party(h.partyCode);
  const coOk = companies.some((c) => c.code === h.company);
  const sumKg = lines.reduce((s, l) => s + (Number(l.qtyKg) || 0), 0);

  return (
    <div className="so-section scan-panel">
      <div className="section-head">
        <span className="grow">📷 Đối chiếu với {SCAN_KINDS[scan.kind] || 'phiếu'} Ecount {e.slipNo && <b className="mono">{e.slipNo}</b>} <span className="small" style={{ fontWeight: 400 }}>· kiểm tra từng ô rồi mới bấm Lập đơn</span></span>
        <button type="button" className="btn ghost sm" onClick={() => setShow(!show)}>{show ? 'Thu gọn' : 'Mở'}</button>
      </div>
      {dupSlip.length > 0 && <div className="warn-box">⚠ Phiếu Ecount <b>{e.slipNo}</b> đã lập đơn {dupSlip.map((o) => o.id).join(', ')}. Lập nữa sẽ bị trùng.</div>}
      {sameRef.length > 0 && <div className="warn-box">Đã có {sameRef.map((o) => `${o.id} (${o.status === 'done' ? 'đã xong' : 'đang mở'})`).join(', ')} cùng số Ecount {h.refNo}. Nếu đây là đợt giao / nhận tiếp của đơn đó thì có thể lập phiếu kho theo đơn cũ thay vì tạo đơn mới.</div>}
      {show && (
        <div className="scan-grid">
          {draft.imageUrl && <a className="scan-thumb" href={draft.imageUrl} target="_blank" rel="noreferrer" title="Mở ảnh lớn"><img src={draft.imageUrl} alt="Ảnh phiếu Ecount" /></a>}
          <table className="kv-table">
            <tbody>
              <tr><th>Số Ecount</th><td><input value={h.refNo || ''} onChange={(ev) => setH((x) => ({ ...x, refNo: ev.target.value }))} style={{ width: 160 }} /> <span className="small">{sell ? `số đơn hàng Ecount; phiếu ${e.slipNo || '?'}` : 'số phiếu Ecount'}</span></td></tr>
              <tr><th>Ngày</th><td>{scan.date ? fmtDate(scan.date) : <span className="req">chưa đọc được: nhập ở ô Ngày</span>}</td></tr>
              <tr><th>Công ty</th><td>{coRead?.name || '?'} {coOk ? <Tag how={draft.match.company || 'exact'} /> : <><Tag how="" /> <span className="small">chọn ở ô Công ty</span></>}</td></tr>
              {type !== 'STO' && (
                <tr><th>{sell ? 'Khách hàng' : 'Nhà cung cấp'}</th><td>
                  {partyRead ? <>{partyRead.name}{partyRead.taxCode && <span className="small"> · MST {partyRead.taxCode}</span>} </> : <span className="small">Phiếu không ghi nhà cung cấp: chọn ở ô Nhà cung cấp (lần sau tự điền theo công ty). </span>}
                  {partyOk ? <Tag how={h.partyCode && draft.head.partyCode === h.partyCode ? draft.match.party || 'exact' : 'exact'} /> : partyRead && (
                    <span className="nowrap"><Tag how="" /> Thêm khách hàng này: <QuickAdd catKey={sell ? 'soldto' : 'suppliers'} preset={{ name: partyRead.name, taxCode: partyRead.taxCode || '', address: partyRead.address || '' }} onAdded={(id, r) => setHead('partyCode', r?.code || id, r)} /></span>
                  )}
                </td></tr>
              )}
              {scan.warehouse && <tr><th>Kho nhập (phiếu)</th><td>{scan.warehouse} <Tag how={draft.match.warehouse === 'read' ? 'read' : draft.match.warehouse} />{draft.match.warehouse !== 'read' && <span className="small"> không có kho tên giống: chọn kho ở dòng hàng</span>}</td></tr>}
              <tr><th>Vận tải <span className="small">(điền sẵn vào phiếu {type === 'SO' ? 'xuất' : 'nhập'} kho)</span></th><td>
                <div className="scan-transport">
                  <WithAdd cat="carriers" preset={{ code: (scan.carrier || '').toUpperCase().replace(/\s+/g, ''), name: scan.carrier || '' }} onAdded={(id, r) => { setE('carrier', r?.code || id); setE('carrierName', r?.name || ''); }}>
                    <Select value={e.carrier || ''} onChange={(ev) => { const c = carriers.find((x) => x.code === ev.target.value); setE('carrier', ev.target.value); setE('carrierName', c?.name || e.carrierName || ''); }}>
                      <option value="">{scan.carrier ? `-- ${scan.carrier} (chưa khớp) --` : '-- Đơn vị vận tải --'}</option>
                      {carriers.filter((c) => c.active !== false).map((c) => <option key={c.code} value={c.code}>{c.code} – {c.name}</option>)}
                    </Select>
                  </WithAdd>
                  {e.carrier && draft.match.carrier === 'near' && draft.head.ecount.carrier === e.carrier && <span className="badge amber" title={`Ảnh đọc được "${scan.carrier}"`}>≈ đọc "{scan.carrier}"</span>}
                  <input value={e.plate || ''} placeholder={sell ? 'Số xe' : 'Số xe / cont'} onChange={(ev) => setE('plate', ev.target.value.toUpperCase())} style={{ width: 130 }} />
                  <input value={e.driverName || ''} placeholder="Tài xế" onChange={(ev) => setE('driverName', ev.target.value)} style={{ width: 160 }} />
                  <input value={e.idCard || ''} placeholder="CCCD" onChange={(ev) => setE('idCard', ev.target.value.replace(/\D/g, ''))} style={{ width: 130 }} />
                </div>
              </td></tr>
            </tbody>
          </table>
        </div>
      )}
      {show && (
        <table className="kv-table scan-lines">
          <thead><tr><th>#</th><th>Mã hàng (ảnh)</th><th>Tên hàng (ảnh)</th><th className="num">Kg (ảnh)</th><th className="num">Số bao (ảnh)</th><th>Khớp mã hàng trên đơn</th><th>Kiểm tra</th></tr></thead>
          <tbody>
            {scan.lines.map((r, i) => {
              const l = lines[i];
              const it = l && itemMap.get(l.item);
              const m = matchItem(r, items);
              const how = !it ? '' : m.rec?.code === l.item ? m.how : 'exact';
              const bw = Number(it?.bagWeight) || 0;
              const bagsCalc = bw && Number(l?.qtyKg) ? Number(l.qtyKg) / bw : null;
              const checks = [];
              if (r.qtyRead !== undefined) checks.push(<span key="q" className="badge amber">Kg ở dòng đọc {r.qtyRead == null ? 'không rõ' : fmtNum(r.qtyRead, 2)}: lấy theo Tổng cộng</span>);
              if (l && r.qtyKg != null && Number(l.qtyKg) !== r.qtyKg) checks.push(<span key="e" className="badge blue">đã sửa kg</span>);
              if (r.bags != null && bagsCalc != null) checks.push(Math.abs(bagsCalc - r.bags) < 0.01 ? <span key="b" className="badge green">✓ {fmtNum(r.bags)} bao × {fmtNum(bw, 2)} kg</span> : <span key="b" className="badge red">⚠ {fmtNum(r.bags)} bao ≠ {fmtNum(bagsCalc, 2)} bao theo quy cách {fmtNum(bw, 2)} kg/bao</span>);
              return (
                <tr key={i}>
                  <td>{i + 1}</td><td className="mono">{r.code || '?'}{r.code2 && r.code2 !== r.code ? <span className="small"> / {r.code2}</span> : ''}</td><td>{r.name}</td>
                  <td className="num">{r.qtyKg == null ? <span className="req">?</span> : fmtNum(r.qtyKg, 2)}</td><td className="num">{r.bags == null ? '' : fmtNum(r.bags)}</td>
                  <td>{!l ? <span className="small">dòng đã xóa</span> : it ? <><b className="mono">{l.item}</b> <Tag how={how} /></> : (
                    <span className="nowrap"><Tag how="" /> Thêm mã hàng: <QuickAdd catKey="items" preset={{ code: (r.code2 || r.code || '').toUpperCase(), name: r.name || '' }} onAdded={(id, rec) => setLine(i, 'item', rec?.code || id, rec)} /></span>
                  )}</td>
                  <td>{checks}</td>
                </tr>
              );
            })}
            {scan.total?.qty != null && (
              <tr><td></td><td colSpan={2}><b>Tổng cộng (ảnh)</b></td><td className="num"><b>{fmtNum(scan.total.qty, 2)}</b></td><td className="num">{scan.total.bags != null ? fmtNum(scan.total.bags) : ''}</td>
                <td colSpan={2}>{Math.abs(scan.total.qty - sumKg) < 0.001 ? <span className="badge green">✓ tổng kg trên đơn khớp phiếu</span> : <span className="badge red">⚠ tổng trên đơn {fmtNum(sumKg, 2)} kg ≠ phiếu</span>}</td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
