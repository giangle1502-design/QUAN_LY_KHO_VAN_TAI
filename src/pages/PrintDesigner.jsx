// Thiết kế mẫu in: danh sách mẫu theo loại phiếu + trang soạn mẫu (nội dung, bảng hàng, chữ ký, khổ giấy) có xem trước
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { useCollection } from '../lib/hooks';
import { deleteOrRequest } from '../lib/deletes';
import { DOC_TYPES, FONTS, MOVE_TYPES_OF, PAPERS, fieldDefs, marginOf, paperSize, starterTemplate } from '../lib/printTemplates';
import { labelLines, loadMovementData, loadReleaseData } from '../lib/printData';
import { TemplateSheets } from '../components/PrintTemplate';
import RichEditor from '../components/RichEditor';
import { Empty, ErrorBox } from '../components/ui';
import { norm, today } from '../lib/utils';

const TOKENS = [
  ['{{BẢNG HÀNG}}', '▦ Bảng hàng', 'Vị trí đặt bảng dòng hàng (cột chỉnh ở mục Bảng hàng)'],
  ['{{BẢNG PALLET}}', '🪵 Bảng pallet', 'Phiếu xuất / nhập hàng Kiện: bảng pallet riêng (mã, loại, số lượng). Không đặt thì tự in ngay dưới bảng hàng'],
  ['{{CHỮ KÝ}}', '✍ Chữ ký', 'Vị trí hàng ô ký tên (chỉnh ở mục Chữ ký)'],
  ['{{#nếu Tên trường}}…{{/nếu}}', '❓ Nếu có', 'Đoạn giữa {{#nếu X}} và {{/nếu}} chỉ in khi trường X có giá trị. Sửa "Tên trường" thành tên trường cần xét.'],
];

function applies(t, coName, partyName) {
  const parts = [];
  if (t.companies?.length) parts.push(`Công ty: ${t.companies.map(coName).join(', ')}`);
  if (t.parties?.length) parts.push(`${t.docType === 'giaichap' ? 'Ngân hàng' : 'Khách hàng / NCC'}: ${t.parties.map(partyName).join(', ')}`);
  if (!parts.length) return t.isDefault ? 'Mặc định cho mọi phiếu' : 'Chỉ khi chọn tay';
  return parts.join(' · ');
}

// ---------- Danh sách mẫu ----------
export default function PrintDesigner() {
  const { id } = useParams();
  if (id) return <TemplateEditor id={id} />;
  return <TemplateList />;
}

function TemplateList() {
  const { email, name, isSuper } = useApp();
  const { rows, loading, error } = useCollection('printTemplates');
  const companies = useCollection('companies').rows;
  const soldto = useCollection('soldto').rows;
  const [err, setErr] = useState('');
  const nav = useNavigate();
  const coName = (c) => companies.find((x) => x.code === c)?.code || c;
  const partyName = (c) => soldto.find((x) => x.code === c)?.name || c;

  const toggle = async (t) => {
    try { await setDoc(doc(db, 'printTemplates', t._id), { active: t.active === false, updatedAt: new Date().toISOString(), updatedBy: email }, { merge: true }); } catch (e) { setErr(e.message); }
  };
  const copy = async (t) => {
    const ref = doc(collection(db, 'printTemplates'));
    const { _id, ...rest } = t;
    try {
      await setDoc(ref, { ...rest, id: ref.id, name: `${t.name} (bản sao)`, isDefault: false, createdAt: new Date().toISOString(), createdBy: email, updatedAt: new Date().toISOString(), updatedBy: email });
      nav(`/mau-in/${ref.id}`);
    } catch (e) { setErr(e.message); }
  };
  const remove = async (t) => {
    if (!window.confirm(`Xóa mẫu "${t.name}"?${isSuper ? '' : ' (gửi yêu cầu xóa cho quản trị gốc duyệt)'}`)) return;
    try {
      const r = await deleteOrRequest({ coll: 'printTemplates', id: t._id, label: t.name, data: t }, { email, name }, isSuper);
      if (r === 'requested') window.alert('Đã gửi yêu cầu xóa. Trong lúc chờ duyệt có thể bấm "Ngừng dùng".');
    } catch (e) { setErr(e.message); }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>🖨️ Mẫu in</h1>
          <p className="small">Tự thiết kế phiếu xuất, phiếu nhập, phiếu soạn hàng, nhãn pallet, đề nghị giải chấp. Mỗi loại có thể có nhiều mẫu.
            Khi in, hệ thống tự chọn: mẫu dành riêng cho khách hàng → mẫu dành riêng cho công ty chủ hàng → mẫu đặt "mặc định" → mẫu gốc của hệ thống.
            Trên trang in vẫn đổi được mẫu bằng ô <b>Mẫu in</b>.</p>
        </div>
      </div>
      <ErrorBox>{error || err}</ErrorBox>
      {loading ? <p>Đang tải…</p> : Object.entries(DOC_TYPES).map(([k, dt]) => {
        const list = rows.filter((t) => t.docType === k).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return (
          <div key={k} className="card" style={{ marginBottom: 12 }}>
            <div className="row-between" style={{ alignItems: 'center', marginBottom: 8 }}>
              <h3>{dt.icon} {dt.label}</h3>
              <Link className="btn sm primary" to={`/mau-in/moi?loai=${k}`}>+ Thêm mẫu</Link>
            </div>
            {!list.length ? <p className="small">Chưa có mẫu riêng: đang dùng mẫu gốc của hệ thống.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Tên mẫu</th><th>Áp dụng</th><th>Trạng thái</th><th>Sửa lần cuối</th><th></th></tr></thead>
                <tbody>{list.map((t) => (
                  <tr key={t._id}>
                    <td><Link to={`/mau-in/${t._id}`}><b>{t.name}</b></Link></td>
                    <td>{applies(t, coName, partyName)}</td>
                    <td>{t.active === false ? <span className="badge">Ngừng dùng</span> : <span className="badge green">Đang dùng</span>}</td>
                    <td className="small">{t.updatedByName || t.updatedBy} {String(t.updatedAt || '').slice(0, 10)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link className="btn sm" to={`/mau-in/${t._id}`}>✎ Sửa</Link>{' '}
                      <button className="btn sm" onClick={() => copy(t)}>⧉ Nhân bản</button>{' '}
                      <button className="btn sm" onClick={() => toggle(t)}>{t.active === false ? 'Dùng lại' : 'Ngừng dùng'}</button>{' '}
                      <button className="btn sm danger" onClick={() => remove(t)}>Xóa</button>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Chọn nhiều mã (công ty / khách hàng) ----------
function CodePicker({ options, value = [], onChange, placeholder }) {
  const [q, setQ] = useState('');
  const listId = useRef(`dl-${Math.random().toString(36).slice(2)}`).current;
  const add = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return;
    const code = s.split(' – ')[0].trim();
    const hit = options.find((o) => o.code === code) || options.find((o) => norm(o.name) === norm(s));
    if (!hit) return;
    if (!value.includes(hit.code)) onChange([...value, hit.code]);
    setQ('');
  };
  return (
    <div className="code-picker">
      {value.map((c) => (
        <span key={c} className="chip on" style={{ cursor: 'default' }}>{c}{options.find((o) => o.code === c)?.name ? ` – ${options.find((o) => o.code === c).name}` : ''}{' '}
          <b style={{ cursor: 'pointer' }} onClick={() => onChange(value.filter((x) => x !== c))}>✕</b></span>
      ))}
      <input list={listId} value={q} placeholder={placeholder} onChange={(e) => { setQ(e.target.value); if (options.some((o) => `${o.code} – ${o.name}` === e.target.value)) add(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(q); } }} />
      <datalist id={listId}>{options.map((o) => <option key={o.code} value={`${o.code} – ${o.name || ''}`} />)}</datalist>
    </div>
  );
}

// ---------- Dữ liệu mẫu để xem trước ----------
function fakeData(docType) {
  const out = docType === 'px' || docType === 'soan';
  const type = out ? 'out' : docType === 'kho' ? 'move' : 'in';
  const lines = [
    { item: 'PP-1102K', itemName: 'Hạt nhựa PP 1102K', lot: 'L240901', location: 'A-01-02', toLocation: 'B-02-01', goodsStatus: 'KTC', kg: 24750, pallets: 18, bags: 990 },
    { item: 'PP-1102K', itemName: 'Hạt nhựa PP 1102K', lot: 'L240902', location: 'A-03-01', toLocation: 'B-02-02', goodsStatus: 'KTC', kg: 1375, pallets: 1, bags: 55 },
    { item: 'HDPE-5502', itemName: 'Hạt nhựa HDPE 5502', lot: 'H2409', location: 'C-01-04', toLocation: 'C-02-01', goodsStatus: 'HTC', pledgee: 'TCB', kg: 16500, pallets: 12, bags: 660 },
  ];
  const m = { id: `${out ? 'PX' : type === 'in' ? 'PN' : 'CV'}000123`, type, date: today(), warehouse: 'K1', company: 'VAP', partyCode: 'KH001', partyName: 'Công ty TNHH Khách Hàng Mẫu',
    shipCode: 'KH001-01', orderId: out ? 'SO000045' : 'PO000012', orderRef: 'EC-1234', plate: '51C-123.45', driverName: 'Nguyễn Văn A', idCard: '079123456789', driverPhone: '0901 234 567',
    carrierName: 'Vận tải Mẫu', note: 'Giao giờ hành chính', reason: '', createdByName: 'Người lập phiếu', lines };
  const co = { code: 'VAP', name: 'CÔNG TY TNHH VIỆT AN PHA', address: '123 Đường Mẫu, TP. Hồ Chí Minh', taxCode: '0312345678', phone: '028 1234 5678', place: 'HCM', representative: 'Nguyễn Văn B', repTitle: 'Giám đốc' };
  if (docType === 'giaichap') {
    const r = { id: 'HSGC24100101', date: today(), company: 'VAP', pledgee: 'TCB', warehouse: 'K1', lines: lines.map((l) => ({ ...l, docNo: 'BCT-01', place: 'Kho K1', unit: 'TẤN' })) };
    return { r, co, bank: { code: 'TCB', name: 'NGÂN HÀNG TMCP KỸ THƯƠNG VIỆT NAM – CN MẪU', shortName: 'Techcombank' }, wh: { code: 'K1', name: 'Kho K1' }, items: new Map(), lines: r.lines };
  }
  const items = new Map([['PP-1102K', { code: 'PP-1102K', name: 'Hạt nhựa PP 1102K', bagWeight: 25, bagsPerLayer: 5, layersPerPallet: 11 }], ['HDPE-5502', { code: 'HDPE-5502', name: 'Hạt nhựa HDPE 5502', bagWeight: 25, bagsPerLayer: 5, layersPerPallet: 11 }]]);
  const d = { m, co, wh: { code: 'K1', name: 'Kho K1', address: 'KCN Mẫu, Bình Dương' }, party: { code: 'KH001', name: m.partyName, taxCode: '0309999999', taxAddress: '456 Đường Khách, Q.1' },
    shipto: { shipCode: 'KH001-01', address: 'Nhà máy khách hàng, KCN Mẫu, Long An', contact: 'Chị C', phone: '0909 000 111' }, order: null, items, lines };
  if (docType === 'nhan') return { ...d, labels: labelLines(m, items).slice(0, 4) };
  return d;
}

async function loadSamples(docType) {
  if (DOC_TYPES[docType].source === 'release') {
    const s = await getDocs(query(collection(db, 'releaseRequests'), orderBy('createdAt', 'desc'), limit(30)));
    return s.docs.map((d) => d.data()).map((r) => ({ id: r.id, label: `${r.id} · ${r.company} · ${r.pledgee} · ${r.date}`, doc: r }));
  }
  const s = await getDocs(query(collection(db, 'movements'), orderBy('createdAt', 'desc'), limit(200)));
  return s.docs.map((d) => d.data()).filter((m) => MOVE_TYPES_OF[docType].includes(m.type)).slice(0, 40)
    .map((m) => ({ id: m.id, label: `${m.id} · ${m.date} · ${m.company || ''} ${m.partyName || m.partyCode || ''}`, doc: m }));
}
async function loadSample(docType, s) {
  if (DOC_TYPES[docType].source === 'release') return loadReleaseData(s.doc);
  const d = await loadMovementData(s.doc);
  return docType === 'nhan' ? { ...d, labels: labelLines(s.doc, d.items) } : d;
}

// ---------- Soạn mẫu ----------
function TemplateEditor({ id }) {
  const { email, name, fieldsOf } = useApp();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const isNew = id === 'moi';
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('noi-dung');
  const companies = useCollection('companies').rows;
  const soldto = useCollection('soldto').rows;
  const suppliers = useCollection('suppliers').rows;
  const pledgees = useCollection('pledgees').rows;

  useEffect(() => {
    if (isNew) {
      const k = DOC_TYPES[sp.get('loai')] ? sp.get('loai') : 'px';
      setT(starterTemplate(k));
      return;
    }
    getDoc(doc(db, 'printTemplates', id)).then((s) => (s.exists() ? setT({ ...starterTemplate(s.data().docType), ...s.data() }) : setErr('Không tìm thấy mẫu.'))).catch((e) => setErr(e.message));
  }, [id, isNew, sp]);

  // Xem trước với phiếu thật (chọn) hoặc dữ liệu mẫu
  const [samples, setSamples] = useState([]);
  const [sample, setSample] = useState('');
  const [data, setData] = useState(null);
  const docType = t?.docType;
  useEffect(() => {
    if (!docType) return;
    setSample(''); setSamples([]);
    loadSamples(docType).then(setSamples).catch(() => setSamples([]));
  }, [docType]);
  useEffect(() => {
    if (!docType) return;
    const s = samples.find((x) => x.id === sample);
    if (!s) { setData(fakeData(docType)); return; }
    let live = true;
    loadSample(docType, s).then((d) => live && setData(d)).catch((e) => { setErr(e.message); setData(fakeData(docType)); });
    return () => { live = false; };
  }, [docType, sample, samples]);

  const defs = useMemo(() => (docType ? fieldDefs(docType, fieldsOf) : { head: [], line: [] }), [docType, fieldsOf]);
  const groups = useMemo(() => {
    const g = new Map();
    for (const f of defs.head) { if (!g.has(f.g)) g.set(f.g, []); g.get(f.g).push(f); }
    if (DOC_TYPES[docType]?.perLabel) g.set('Dòng hàng / pallet', defs.line.filter((f) => !['stt', 'blank', 'checkbox'].includes(f.key)));
    return [...g.entries()];
  }, [defs, docType]);

  if (err && !t) return <ErrorBox>{err}</ErrorBox>;
  if (!t) return <p>Đang tải…</p>;
  const set = (patch) => { setT((x) => ({ ...x, ...patch })); setDirty(true); setMsg(''); };
  const setTable = (patch) => set({ table: { ...(t.table || {}), ...patch } });
  const cols = t.table?.columns || [];
  const setCol = (i, patch) => setTable({ columns: cols.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const moveCol = (i, d) => { const a = [...cols]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); setTable({ columns: a }); };
  const signs = t.signs || [];
  const setSign = (i, patch) => set({ signs: signs.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const dt = DOC_TYPES[t.docType];
  const partyOpts = t.docType === 'giaichap'
    ? pledgees.map((p) => ({ code: p.code, name: p.shortName || p.name }))
    : [...soldto.map((c) => ({ code: c.code, name: c.name })), ...suppliers.map((c) => ({ code: c.code, name: `${c.name} (NCC)` }))];
  const size = JSON.stringify(t).length;

  const save = async () => {
    if (!String(t.name || '').trim()) { setErr('Nhập tên mẫu.'); return; }
    if (size > 900000) { setErr('Mẫu quá lớn (hình ảnh nặng). Xóa bớt hoặc chèn hình nhỏ hơn.'); return; }
    setBusy(true); setErr('');
    try {
      const ref = isNew ? doc(collection(db, 'printTemplates')) : doc(db, 'printTemplates', id);
      const at = new Date().toISOString();
      const data = { ...t, id: ref.id, name: t.name.trim(), updatedAt: at, updatedBy: email, updatedByName: name, ...(isNew ? { createdAt: at, createdBy: email } : {}) };
      const b = writeBatch(db);
      b.set(ref, data);
      // Chỉ 1 mẫu mặc định chung cho mỗi loại phiếu
      if (t.isDefault && !t.companies?.length && !t.parties?.length) {
        const all = await getDocs(collection(db, 'printTemplates'));
        all.docs.filter((d) => d.id !== ref.id && d.data().docType === t.docType && d.data().isDefault && !d.data().companies?.length && !d.data().parties?.length)
          .forEach((d) => b.update(d.ref, { isDefault: false, updatedAt: at, updatedBy: email }));
      }
      await b.commit();
      setDirty(false);
      setMsg('Đã lưu mẫu.');
      if (isNew) nav(`/mau-in/${ref.id}`, { replace: true });
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const [w, h] = paperSize(t);
  const lineOpts = defs.line;

  return (
    <div className="designer">
      <div className="page-head">
        <div>
          <h1>{dt.icon} {isNew ? 'Mẫu in mới' : t.name}</h1>
          <p className="small">{dt.label} · khổ {w}×{h} mm · lề {marginOf(t)} mm</p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <Link className="btn" to="/mau-in" onClick={(e) => { if (dirty && !window.confirm('Chưa lưu thay đổi. Vẫn rời trang?')) e.preventDefault(); }}>← Danh sách mẫu</Link>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : '💾 Lưu mẫu'}</button>
        </div>
      </div>
      <ErrorBox>{err}</ErrorBox>
      {msg && <div className="ok-box">{msg}</div>}

      <div className="designer-grid">
        <div className="designer-left">
          <div className="card designer-info">
            <div className="grid2" style={{ marginBottom: 8 }}>
              <label className="field"><span>Tên mẫu *</span><input value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="VD: Phiếu xuất cho khách ABC" /></label>
              <label className="field"><span>Loại phiếu</span>
                <select value={t.docType} disabled={!isNew} onChange={(e) => setT({ ...starterTemplate(e.target.value), name: t.name })}>
                  {Object.entries(DOC_TYPES).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
                </select>
                {isNew && <small className="small">Đổi loại phiếu sẽ nạp lại nội dung mẫu ban đầu của loại đó.</small>}
              </label>
            </div>
            <div className="field"><span>Áp dụng tự động cho công ty chủ hàng</span>
              <CodePicker options={companies.map((c) => ({ code: c.code, name: c.name }))} value={t.companies || []} onChange={(v) => set({ companies: v })} placeholder="Gõ mã / tên công ty… (để trống = mọi công ty)" />
            </div>
            <div className="field"><span>{t.docType === 'giaichap' ? 'Áp dụng tự động cho ngân hàng' : 'Áp dụng tự động cho khách hàng / nhà cung cấp'}</span>
              <CodePicker options={partyOpts} value={t.parties || []} onChange={(v) => set({ parties: v })} placeholder={t.docType === 'giaichap' ? 'Gõ mã ngân hàng… (để trống = mọi ngân hàng)' : 'Gõ mã / tên khách hàng… (để trống = mọi khách hàng)'} />
            </div>
            <div className="toolbar" style={{ margin: '6px 0 0' }}>
              <label><input type="checkbox" checked={!!t.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} /> Mặc định cho mọi phiếu loại này (thay mẫu gốc)</label>
              <label><input type="checkbox" checked={t.active !== false} onChange={(e) => set({ active: e.target.checked })} /> Đang dùng</label>
            </div>
            <p className="small" style={{ margin: '4px 0 0' }}>
              {!t.companies?.length && !t.parties?.length && !t.isDefault
                ? 'Mẫu này chưa tự áp dụng cho phiếu nào: chỉ dùng khi chọn tay ở ô "Mẫu in" trên trang in.'
                : 'Ưu tiên khi in: mẫu đúng khách hàng → đúng công ty → mẫu mặc định → mẫu gốc.'}
            </p>
          </div>

          <div className="report-tabs" style={{ margin: '12px 0 8px' }}>
            {[['noi-dung', '📝 Nội dung'], ...(dt.perLabel ? [] : [['bang', '▦ Bảng hàng'], ['chu-ky', '✍ Chữ ký']]), ['trang', '📄 Khổ giấy & chữ'], ['nang-cao', '⚙ Nâng cao']].map(([k, l]) => (
              <a key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</a>
            ))}
          </div>

          {tab === 'noi-dung' && (
            <div className="card">
              <p className="small" style={{ marginTop: 0 }}>
                Soạn như Word. Chữ trong <code>{'{{ }}'}</code> sẽ được thay bằng dữ liệu của phiếu: dùng ô <b>Chèn trường dữ liệu</b>.
                {!dt.perLabel && <> Đặt <code>{'{{BẢNG HÀNG}}'}</code> nơi in bảng dòng hàng và <code>{'{{CHỮ KÝ}}'}</code> nơi in các ô ký tên.</>}
                {dt.perLabel && <> Nội dung này là 1 nhãn; mỗi pallet in 1 nhãn.</>}
                {' '}Trường không tồn tại hiện <span className="tpl-unknown">màu đỏ</span> ở khung xem trước.
              </p>
              <RichEditor value={t.body || ''} onChange={(v) => set({ body: v })} fieldGroups={groups} extraTokens={dt.perLabel ? TOKENS.slice(2) : TOKENS} />
            </div>
          )}

          {tab === 'bang' && (
            <div className="card">
              <div className="table-wrap"><table className="cols-edit">
                <thead><tr><th>#</th><th>Dữ liệu cột</th><th>Tiêu đề cột</th><th>Rộng</th><th>Căn</th><th>Số lẻ</th><th>Cộng tổng</th><th></th></tr></thead>
                <tbody>{cols.map((c, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      <select value={c.formula !== undefined ? '__f' : c.field} onChange={(e) => (e.target.value === '__f'
                        ? setCol(i, { field: '', formula: c.formula || '[Số kg] / 1000' })
                        : setCol(i, { field: e.target.value, formula: undefined, header: c.header && c.header !== c.field ? c.header : e.target.value }))}>
                        {!lineOpts.some((f) => f.label === c.field) && c.formula === undefined && <option value={c.field}>{c.field || '— chọn —'} {c.field ? '(không còn)' : ''}</option>}
                        {lineOpts.map((f) => <option key={f.label} value={f.label}>{f.label}</option>)}
                        <option value="__f">ƒ Công thức…</option>
                      </select>
                      {c.formula !== undefined && <input value={c.formula} onChange={(e) => setCol(i, { formula: e.target.value })} placeholder="[Số kg] * [Mã hàng: Trọng lượng bao (kg)]" title="Dùng [Tên cột dữ liệu], + - * / ( ), ROUND, MIN, MAX" />}
                    </td>
                    <td><input value={c.header ?? ''} onChange={(e) => setCol(i, { header: e.target.value })} /></td>
                    <td><input style={{ width: 70 }} value={c.width || ''} placeholder="tự động" onChange={(e) => setCol(i, { width: e.target.value })} title="vd. 10% hoặc 25mm" /></td>
                    <td><select value={c.align || ''} onChange={(e) => setCol(i, { align: e.target.value })}><option value="">Tự động</option><option value="left">Trái</option><option value="center">Giữa</option><option value="right">Phải</option></select></td>
                    <td><input type="number" min="0" max="6" style={{ width: 56 }} value={c.dec ?? ''} placeholder="—" onChange={(e) => setCol(i, { dec: e.target.value === '' ? undefined : Number(e.target.value) })} /></td>
                    <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!c.sum} onChange={(e) => setCol(i, { sum: e.target.checked })} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn sm" disabled={!i} onClick={() => moveCol(i, -1)}>↑</button>
                      <button className="btn sm" disabled={i === cols.length - 1} onClick={() => moveCol(i, 1)}>↓</button>
                      <button className="btn sm danger" onClick={() => setTable({ columns: cols.filter((_, j) => j !== i) })}>✕</button>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setTable({ columns: [...cols, { field: 'Mã hàng', header: 'Mã hàng' }] })}>+ Thêm cột</button>
              <div className="grid2" style={{ marginTop: 12 }}>
                <label className="field"><span>Gộp dòng</span>
                  <select value={t.table?.groupBy || ''} onChange={(e) => setTable({ groupBy: e.target.value })}>
                    <option value="">Không gộp (mỗi dòng phiếu 1 dòng)</option><option value="item">Gộp theo mã hàng (cộng kg, bao, pallet)</option>
                  </select></label>
                <label className="field"><span>Sắp xếp theo</span>
                  <select value={t.table?.sortBy || ''} onChange={(e) => setTable({ sortBy: e.target.value })}>
                    <option value="">Thứ tự trên phiếu</option>{lineOpts.filter((f) => f.key !== 'stt').map((f) => <option key={f.label} value={f.label}>{f.label}</option>)}
                  </select></label>
                <label className="field"><span>Dòng tổng cộng</span>
                  <span className="suffix-input"><input type="checkbox" style={{ flex: 'none' }} checked={!!t.table?.showTotal} onChange={(e) => setTable({ showTotal: e.target.checked })} />
                    <input value={t.table?.totalLabel ?? 'Cộng'} onChange={(e) => setTable({ totalLabel: e.target.value })} placeholder="Chữ ở ô tổng" /></span>
                  <small className="small">Cộng các cột có tích "Cộng tổng".</small></label>
                <label className="field"><span>Số dòng tối thiểu (thêm dòng trống)</span><input type="number" min="0" value={t.table?.minRows || ''} onChange={(e) => setTable({ minRows: Number(e.target.value) || 0 })} /></label>
                <label className="field"><span>Màu nền dòng tiêu đề</span><input type="color" value={t.table?.headBg || '#f2f2f2'} onChange={(e) => setTable({ headBg: e.target.value })} /></label>
                <label className="field"><span>Cỡ chữ trong bảng (px)</span><input type="number" min="7" max="30" value={t.table?.fontSize || ''} placeholder="theo cỡ chữ chung" onChange={(e) => setTable({ fontSize: Number(e.target.value) || '' })} /></label>
                <label><input type="checkbox" checked={!!t.table?.noBorder} onChange={(e) => setTable({ noBorder: e.target.checked })} /> Không kẻ ô dọc (chỉ gạch dưới mỗi dòng)</label>
              </div>
            </div>
          )}

          {tab === 'chu-ky' && (
            <div className="card">
              <p className="small" style={{ marginTop: 0 }}>Mỗi ô 1 người ký, chia đều theo chiều ngang. Dòng "Tên in sẵn" có thể chèn trường, vd. <code>{'{{Người lập}}'}</code>. Để trống tiêu đề = ô trống (đẩy ô ký sang phải).</p>
              <table><thead><tr><th>Tiêu đề</th><th>Ghi chú dưới tiêu đề</th><th>Tên in sẵn</th><th></th></tr></thead>
                <tbody>{signs.map((s, i) => (
                  <tr key={i}>
                    <td><input value={s.title || ''} onChange={(e) => setSign(i, { title: e.target.value })} placeholder="VD: Thủ kho" /></td>
                    <td><input value={s.note || ''} onChange={(e) => setSign(i, { note: e.target.value })} placeholder="(Ký, ghi rõ họ tên)" /></td>
                    <td><input value={s.name || ''} onChange={(e) => setSign(i, { name: e.target.value })} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn sm" disabled={!i} onClick={() => { const a = [...signs]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; set({ signs: a }); }}>←</button>
                      <button className="btn sm" disabled={i === signs.length - 1} onClick={() => { const a = [...signs]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; set({ signs: a }); }}>→</button>
                      <button className="btn sm danger" onClick={() => set({ signs: signs.filter((_, j) => j !== i) })}>✕</button>
                    </td>
                  </tr>
                ))}</tbody></table>
              <div className="toolbar" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={() => set({ signs: [...signs, { title: '', note: '(Ký, ghi rõ họ tên)' }] })}>+ Thêm ô ký</button>
                <label className="small">Khoảng trống để ký <input type="number" min="5" max="80" style={{ width: 70 }} value={t.signSpace || 22} onChange={(e) => set({ signSpace: Number(e.target.value) || 22 })} /> mm</label>
              </div>
            </div>
          )}

          {tab === 'trang' && (
            <div className="card">
              <div className="grid2">
                <label className="field"><span>Khổ giấy</span>
                  <select value={t.paper} onChange={(e) => set({ paper: e.target.value })}>{Object.keys(PAPERS).map((p) => <option key={p} value={p}>{p}{PAPERS[p] ? ` (${PAPERS[p][0]}×${PAPERS[p][1]} mm)` : ''}</option>)}</select></label>
                <label className="field"><span>Hướng giấy</span>
                  <select value={t.orientation || 'portrait'} onChange={(e) => set({ orientation: e.target.value })}><option value="portrait">Dọc</option><option value="landscape">Ngang</option></select></label>
                {!PAPERS[t.paper] && <>
                  <label className="field"><span>Rộng (mm)</span><input type="number" value={t.width || ''} onChange={(e) => set({ width: Number(e.target.value) || '' })} /></label>
                  <label className="field"><span>Cao (mm)</span><input type="number" value={t.height || ''} onChange={(e) => set({ height: Number(e.target.value) || '' })} /></label>
                </>}
                <label className="field"><span>Lề giấy (mm)</span><input type="number" min="0" max="40" value={t.margin ?? 12} onChange={(e) => set({ margin: e.target.value === '' ? '' : Number(e.target.value) })} /></label>
                <label className="field"><span>Phông chữ</span>
                  <select value={t.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>{FONTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label className="field"><span>Cỡ chữ chung (px)</span><input type="number" min="7" max="30" value={t.fontSize || 13} onChange={(e) => set({ fontSize: Number(e.target.value) || 13 })} /></label>
                <label className="field"><span>Giãn dòng</span><input type="number" step="0.05" min="1" max="3" value={t.lineHeight || 1.35} onChange={(e) => set({ lineHeight: Number(e.target.value) || 1.35 })} /></label>
              </div>
              <p className="small">Khi in, chọn đúng khổ giấy và tắt "Đầu trang và chân trang" (Headers and footers) trong hộp thoại in của trình duyệt.</p>
            </div>
          )}

          {tab === 'nang-cao' && (
            <div className="card">
              <label className="field"><span>CSS tùy chỉnh (cho người rành web)</span>
                <textarea className="rte-src" style={{ height: 200 }} value={t.css || ''} onChange={(e) => set({ css: e.target.value })} spellCheck={false} placeholder=".tpl-sheet h2 { letter-spacing: 1px; }" /></label>
              <p className="small">Kích thước mẫu: {(size / 1024).toFixed(0)} KB / tối đa ~900 KB (hình ảnh chiếm nhiều nhất).</p>
              <button className="btn sm" onClick={() => { if (window.confirm('Nạp lại nội dung, bảng hàng, chữ ký theo mẫu gốc của hệ thống? (giữ tên và phạm vi áp dụng)')) { const s = starterTemplate(t.docType); set({ body: s.body, table: s.table, signs: s.signs, signSpace: s.signSpace }); } }}>↺ Nạp lại nội dung mẫu gốc</button>
            </div>
          )}
        </div>

        <div className="designer-right">
          <div className="toolbar" style={{ marginBottom: 6 }}>
            <b>Xem trước</b>
            <select value={sample} onChange={(e) => setSample(e.target.value)} style={{ maxWidth: 340 }}>
              <option value="">Dữ liệu mẫu (giả lập)</option>
              {samples.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <PreviewBox w={w}>
            {data ? <TemplateSheets tpl={t} data={data} preview max={4} /> : <p>Đang tải…</p>}
          </PreviewBox>
        </div>
      </div>
    </div>
  );
}

// Thu nhỏ trang giấy cho vừa khung xem trước
function PreviewBox({ w, children }) {
  const ref = useRef(null);
  const [k, setK] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => setK(Math.min(1, (el.clientWidth - 16) / (w * 3.78)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w]);
  return (
    <div ref={ref} className="tpl-preview">
      <div style={{ zoom: k }}>{children}</div>
    </div>
  );
}
