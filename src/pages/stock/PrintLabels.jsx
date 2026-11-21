import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { useApp } from '../../context/AppContext';
import { fmtDate, fmtNum } from '../../lib/utils';
import { fmtTime } from '../../lib/trips';
import { fullPalletKg, labelLines, loadMovementData, splitPallets } from '../../lib/printData';
import { TemplatePage, useTemplateChoice } from '../../components/PrintTemplate';
import { markLabelsPrinted, readLabelDraft } from '../../lib/labelDraft';

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
export { fullPalletKg, splitPallets };

// In nhãn nhập kho theo mẫu "In nhãn pallet": nhãn nhiệt 10,2 × 15 cm, mỗi pallet 1 nhãn
export default function PrintLabels() {
  const { id } = useParams();
  const { settings, email } = useApp();
  const [sp] = useSearchParams();
  const [m, setM] = useState(undefined);
  // ?nhap=1: in từ số liệu thủ kho đang nhập ở màn Nhận hàng (phiếu còn chờ nhận, chưa ghi tồn)
  const [draft, setDraft] = useState(null);
  const [printed, setPrinted] = useState('');
  const [items, setItems] = useState(null);
  const [company, setCompany] = useState(''); // sửa tay tên công ty trên nhãn (nếu cần)
  const [pick, setPick] = useState(null); // dòng phiếu được chọn in
  const [owner, setOwner] = useState(''); // tên công ty chủ hàng của phiếu

  useEffect(() => {
    getDoc(doc(db, 'movements', id)).then((s) => {
      const saved = s.exists() ? s.data() : null;
      const d = sp.get('nhap') ? readLabelDraft(id) : null;
      if (saved && saved.status === 'pending' && d?.movement) { setDraft(d); setM({ ...saved, ...d.movement }); }
      else setM(saved);
    }).catch(() => setM(null));
    getDoc(doc(db, 'movements', id)).then(async (s) => {
      const c = s.exists() && (s.data().company || s.data().lines?.find((l) => l.company)?.company);
      if (!c) return;
      const x = await getDoc(doc(db, 'companies', c));
      setOwner(x.exists() ? x.data().name || c : c);
    }).catch(() => {});
    getDocs(collection(db, 'items')).then((s) => setItems(new Map(s.docs.map((d) => [d.data().code, d.data()])))).catch(() => setItems(new Map()));
  }, [id, sp]);

  const labels = useMemo(() => {
    if (!m || !items) return [];
    const out = [];
    m.lines.forEach((l, li) => {
      const it = items.get(l.item);
      const parts = splitPallets(l, it);
      parts.forEach((p, pi) => out.push({
        ...p, line: li, no: pi + 1, of: parts.length, key: `${li}-${pi}`,
        mv: l._mv || m.id, item: l.item, itemName: l.itemName || it?.name || '', lot: l.lot, location: l.location,
        goodsStatus: l.goodsStatus, pledgee: l.pledgee, layers: num(it?.layersPerPallet) || '',
      }));
    });
    return out;
  }, [m, items]);
  const chosen = labels.filter((x) => !pick || pick.includes(x.line));

  const choice = useTemplateChoice(m?.type === 'in' ? 'nhan' : null, { company: m?.company || m?.lines?.find((l) => l.company)?.company, party: m?.partyCode });

  if (m === undefined || !items || choice.loading) return <div className="center">Đang tải…</div>;
  if (!m) return <div className="center">Không tìm thấy phiếu {id}.</div>;
  if (m.type !== 'in') return <div className="center">Chỉ in nhãn pallet cho phiếu nhập kho.</div>;
  const printedAt = fmtTime(new Date().toISOString());
  const doPrint = () => {
    window.print();
    // Ghi "đã in" cho màn Nhận hàng (chỉ khi in đủ mọi dòng của số liệu đang nhập)
    const all = !pick || m.lines.every((_, i) => pick.includes(i));
    if (draft && all) { markLabelsPrinted(id, draft.sig, email); setPrinted(new Date().toISOString()); }
  };
  // Ưu tiên: tên gõ tay > công ty chủ hàng của phiếu > tên công ty trong Cài đặt
  const co = company || owner || settings.companyName;

  const toolbar = (
    <>
        <Link className="btn" to="/kho/phieu">← Phiếu kho</Link>
        <b>Nhãn nhập kho phiếu {m.id}: {chosen.length} nhãn (10,2 × 15 cm)</b>
        <label className="small">Công ty trên nhãn <input value={company} placeholder={owner || settings.companyName} onChange={(e) => setCompany(e.target.value)} /></label>
        <button className="btn primary" disabled={!chosen.length} onClick={doPrint}>🖨️ In nhãn</button>
        {draft && <div className={printed ? 'ok-box' : 'hint'} style={{ width: '100%', margin: 0 }}>
          {printed ? <>✅ Đã in nhãn lúc {fmtTime(printed)}. Quay lại tab <b>Nhận hàng</b> để thủ kho bấm <b>Xác nhận đã nhận hàng</b>.</>
            : pick && !m.lines.every((_, i) => pick.includes(i)) ? <>⚠ Đang bỏ chọn một số dòng: in đủ nhãn cho <b>mọi dòng</b> thì mới xác nhận nhận hàng được.</>
            : <>🏷️ Nhãn in theo số liệu thủ kho đang nhập (phiếu <b>chưa xác nhận</b>, tồn kho chưa cập nhật). In và dán nhãn lên pallet trước, sau đó mới xác nhận nhận hàng.</>}
        </div>}
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
        {choice.select}
    </>
  );
  if (choice.tpl) {
    const map = (d) => ({ ...d, labelCompany: co, labels: labelLines(m, d.items).filter((x) => !pick || pick.includes(x._line)) });
    return <TemplatePage key={choice.tpl.id} tpl={choice.tpl} toolbar={toolbar} load={() => loadMovementData(m)} map={map} deps={[m.id]} />;
  }

  return (
    <div className="label-screen">
      <style>{'@page { size: 10.2cm 15cm; margin: 0; }'}</style>
      <div className="no-print toolbar label-toolbar">{toolbar}</div>
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
            <div className="tag-foot">{x.mv} · Pallet {x.no}/{x.of}{!x.full ? ' (lẻ)' : ''} · In lúc {printedAt}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
