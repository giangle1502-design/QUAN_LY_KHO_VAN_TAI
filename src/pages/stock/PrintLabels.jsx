import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { fmtDate, fmtNum } from '../../lib/utils';
import { fmtTime } from '../../lib/trips';

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const r3 = (x) => Math.round(x * 1000) / 1000;


// Kg của 1 pallet full theo quy cách mã hàng
export function fullPalletKg(item) {
  if (!item) return 0;
  return num(item.palletWeight) || num(item.bagsPerLayer) * num(item.layersPerPallet) * num(item.bagWeight);
}

// Chia 1 dòng phiếu nhập thành các pallet: mỗi pallet full 1 nhãn, phần lẻ 1 nhãn riêng
export function splitPallets(line, item) {
  const kg = Math.abs(num(line.kg));
  const bags = Math.abs(num(line.bags));
  const per = fullPalletKg(item);
  const bagW = num(item?.bagWeight) || (bags ? kg / bags : 0);
  if (per > 0 && kg > 0) {
    const out = [];
    let left = kg;
    while (left > 0.001) {
      const k = Math.min(per, left);
      out.push({ kg: r3(k), bags: bagW ? Math.round(k / bagW) : '', full: k >= per - 0.001 });
      left -= k;
    }
    return out;
  }
  // Mã hàng chưa khai quy cách pallet: chia đều theo số pallet trên phiếu
  const n = Math.max(1, Math.ceil(Math.abs(num(line.pallets)) - 1e-9));
  return Array.from({ length: n }, () => ({ kg: r3(kg / n), bags: bags ? r3(bags / n) : '', full: true }));
}

// In nhãn nhập kho theo mẫu "In nhãn pallet": nhãn nhiệt 10,2 × 15 cm, mỗi pallet 1 nhãn
export default function PrintLabels() {
  const { id } = useParams();
  const { settings } = useApp();
  const [m, setM] = useState(undefined);
  const [items, setItems] = useState(null);
  const [company, setCompany] = useState(() => { try { return localStorage.getItem('label-company') || ''; } catch { return ''; } });
  const [pick, setPick] = useState(null); // dòng phiếu được chọn in

  useEffect(() => {
    getDoc(doc(db, 'movements', id)).then((s) => setM(s.exists() ? s.data() : null)).catch(() => setM(null));
    getDocs(collection(db, 'items')).then((s) => setItems(new Map(s.docs.map((d) => [d.data().code, d.data()])))).catch(() => setItems(new Map()));
  }, [id]);

  const labels = useMemo(() => {
    if (!m || !items) return [];
    const out = [];
    m.lines.forEach((l, li) => {
      const it = items.get(l.item);
      const parts = splitPallets(l, it);
      parts.forEach((p, pi) => out.push({
        ...p, line: li, no: pi + 1, of: parts.length, key: `${li}-${pi}`,
        item: l.item, itemName: l.itemName || it?.name || '', lot: l.lot, location: l.location,
        goodsStatus: l.goodsStatus, pledgee: l.pledgee, layers: num(it?.layersPerPallet) || '',
      }));
    });
    return out;
  }, [m, items]);
  const chosen = labels.filter((x) => !pick || pick.includes(x.line));
  const setCo = (v) => { setCompany(v); try { localStorage.setItem('label-company', v); } catch { /* bỏ qua */ } };

  if (m === undefined || !items) return <div className="center">Đang tải…</div>;
  if (!m) return <div className="center">Không tìm thấy phiếu {id}.</div>;
  if (m.type !== 'in') return <div className="center">Chỉ in nhãn pallet cho phiếu nhập kho.</div>;
  const printedAt = fmtTime(new Date().toISOString());
  const co = company || settings.companyName;

  return (
    <div className="label-screen">
      <style>{'@page { size: 10.2cm 15cm; margin: 0; }'}</style>
      <div className="no-print toolbar label-toolbar">
        <Link className="btn" to="/kho/phieu">← Phiếu kho</Link>
        <b>Nhãn nhập kho phiếu {m.id}: {chosen.length} nhãn (10,2 × 15 cm)</b>
        <label className="small">Công ty trên nhãn <input value={company} placeholder={settings.companyName} onChange={(e) => setCo(e.target.value)} /></label>
        <button className="btn primary" disabled={!chosen.length} onClick={() => window.print()}>🖨️ In nhãn</button>
        <div className="small" style={{ width: '100%' }}>
          Số nhãn = Số lượng nhập ÷ SL 1 pallet chẵn (làm tròn lên). Chọn dòng cần in:{' '}
          {m.lines.map((l, i) => {
            const on = !pick || pick.includes(i);
            const n = labels.filter((x) => x.line === i).length;
            return (
              <label key={i} style={{ marginRight: 12 }}>
                <input type="checkbox" checked={on} onChange={() => {
                  const cur = pick || m.lines.map((_, j) => j);
                  setPick(on ? cur.filter((j) => j !== i) : [...cur, i]);
                }} /> {i + 1}. {l.item} lot {l.lot || '-'} · {fmtNum(l.kg)} kg → {n} nhãn
              </label>
            );
          })}
          {labels.some((x) => !x.full) && <span> · Pallet lẻ (không đủ pallet chẵn) ghi đúng số kg thực trên nhãn.</span>}
        </div>
      </div>
      <div className="label-list">
        {chosen.map((x) => (
          <div key={x.key} className="ptag">
            <div className="tag-hole" />
            <div className="tag-header">NHÃN NHẬP KHO</div>
            <div className="tag-row">
              <div><span className="lbl">Ngày nhập</span><span className="val">{fmtDate(m.date)}</span></div>
              <div style={{ textAlign: 'right' }}><span className="lbl">Công ty</span><span className="val">{co}</span></div>
            </div>
            <div className="tag-field"><span className="lbl">Mã hàng</span><span className="val val-lg">{x.item}</span></div>
            <div className="tag-field"><span className="lbl">Tên hàng</span><span className="val val-lg">{x.itemName}</span></div>
            <div className="tag-line" />
            <div className="tag-row">
              <div><span className="lbl">Số lot</span><span className="val">{x.lot || '—'}</span></div>
              <div style={{ textAlign: 'right' }}><span className="lbl">TTHH</span><span className="val">{x.goodsStatus}{x.pledgee ? ` · ${x.pledgee}` : ''}</span></div>
            </div>
            <div className="tag-boxes">
              <div className="tag-box"><div className="lbl">SL/pallet(kg)</div><div className="val">{fmtNum(x.kg)}</div></div>
              <div className="tag-box"><div className="lbl">Số bao</div><div className="val">{x.bags === '' ? '—' : fmtNum(x.bags)}</div></div>
              <div className="tag-box"><div className="lbl">Lớp/pallet</div><div className="val">{x.layers || '—'}</div></div>
            </div>
            <div className="tag-loc">
              <div className="tag-loc-label">Vị trí nhập</div>
              <div className="tag-loc-value">{String(x.location || '—').toUpperCase()}</div>
            </div>
            <div className="tag-foot">{m.id} · Pallet {x.no}/{x.of}{!x.full ? ' (lẻ)' : ''} · In lúc {printedAt}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
