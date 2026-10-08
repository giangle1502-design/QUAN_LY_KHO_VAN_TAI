import { useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useCollection, useOpCompany } from '../../lib/hooks';
import { CompanyPicker } from '../../components/TripBits';
import FieldInput from '../../components/FieldInput';
import { AddFieldButton, ColumnPicker, QuickAdd } from '../../components/FormTools';
import { ErrorBox, Field, Modal } from '../../components/ui';
import { createOrder, saveOrder, summarizeLines } from '../../lib/orders';
import { cleanValue, linkPatch } from '../../lib/fields';
import { usePref } from '../../lib/prefs';
import { vnDate } from '../../lib/trips';
import { fmtNum } from '../../lib/utils';

// Đơn bán (SO) gồm 2 phần:
//  - Phần chung cho cả đơn: ngày tạo đơn, công ty xuất, khách hàng (+ trường tự thêm, có thể liên kết theo khách hàng / công ty)
//  - Dòng hàng: ngày giao, kho xuất, mã hàng, số lượng, mã giao, TTHH… riêng từng dòng → 1 mã hàng giao nhiều điểm / nhiều kho
const HEAD_VIAS = [{ key: 'partyCode', label: 'Khách hàng', ref: 'soldto' }, { key: 'company', label: 'Công ty xuất', ref: 'companies' }];
const LINE_VIAS = [{ key: 'item', label: 'Mã hàng', ref: 'items' }, { key: 'shipCode', label: 'Mã giao', ref: 'shipto' }, { key: 'warehouse', label: 'Kho xuất', ref: 'warehouses' }];
const BUILTIN_HEAD = ['date', 'company', 'partyCode', 'tolerancePct', 'note'];
const BUILTIN_LINE = ['dueDate', 'warehouse', 'item', 'itemName', 'qtyT', 'shipCode', 'goodsStatus', 'note'];
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));

export default function SOForm({ order, onClose }) {
  const { email, name, fieldsOf } = useApp();
  const headFields = fieldsOf('soHead').filter((f) => !f.hidden);
  const lineFields = fieldsOf('soLine').filter((f) => !f.hidden);
  const parties = useCollection('soldto').rows;
  const companies = useCollection('companies').rows;
  const items = useCollection('items').rows;
  const shipto = useCollection('shipto').rows;
  const warehouses = useCollection('warehouses').rows.filter((w) => w.active !== false).sort((a, b) => a.code.localeCompare(b.code));
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const recOf = {
    partyCode: (v) => parties.find((p) => p.code === v), company: (v) => companies.find((c) => c.code === v),
    item: (v) => itemMap.get(v), shipCode: (v) => shipto.find((s) => s.shipCode === v), warehouse: (v) => warehouses.find((w) => w.code === v),
  };
  const [defaultCo] = useOpCompany();
  const [h, setH] = useState(() => (order ? { ...order, tolerancePct: order.tolerancePct || '' }
    : { company: defaultCo, date: vnDate(), partyCode: '', partyName: '', tolerancePct: '', note: '' }));
  // Đơn cũ (kho / mã giao / hạn giao ở đầu đơn): chép xuống từng dòng
  const [lines, setLines] = useState(() => (order
    ? order.lines.map((l) => ({ ...l, qtyT: n(l.qtyKg) / 1000, warehouse: l.warehouse || order.warehouse || '', shipCode: l.shipCode || order.shipCode || '', dueDate: l.dueDate || order.dueDate || '', goodsStatus: l.goodsStatus || '', note: l.note || '' }))
    : [{ dueDate: '', warehouse: '', item: '', itemName: '', qtyT: '', shipCode: '', goodsStatus: '', note: '' }]));
  const [hiddenCols, setHiddenCols] = usePref('soLineHiddenCols', []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const shownLine = lineFields.filter((f) => f.required || !hiddenCols.includes(f.key));
  const myShips = shipto.filter((s) => s.customerCode === h.partyCode);

  const setHead = (k, v, rec) => setH((x) => {
    const p = { [k]: v };
    if (k === 'partyCode') {
      const c = rec || recOf.partyCode(v);
      p.partyName = c ? c.name : x.partyName;
      // Đổi khách hàng: mã giao của khách cũ không còn đúng
      setLines((ls) => ls.map((l) => (l.shipCode && !shipto.some((s) => s.shipCode === l.shipCode && s.customerCode === v) ? { ...l, shipCode: '' } : l)));
    }
    if (recOf[k]) Object.assign(p, linkPatch(headFields, k, rec || recOf[k](v)));
    return { ...x, ...p };
  });
  const setLine = (i, k, v, rec) => setLines((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const p = { [k]: v };
    const r = rec || recOf[k]?.(v);
    if (k === 'item') p.itemName = r?.name || '';
    if (recOf[k]) Object.assign(p, linkPatch(lineFields, k, r));
    return { ...l, ...p };
  }));
  // Dòng mới lấy sẵn ngày giao, kho, mã giao, TTHH của dòng trên cho nhanh
  const addLine = () => setLines((ls) => {
    const last = ls[ls.length - 1] || {};
    return [...ls, { dueDate: last.dueDate || '', warehouse: last.warehouse || '', item: '', itemName: '', qtyT: '', shipCode: last.shipCode || '', goodsStatus: last.goodsStatus || '', note: '' }];
  });
  const copyLine = (i) => setLines((ls) => {
    const { no, doneKg, qtyKg, ...rest } = ls[i]; // eslint-disable-line no-unused-vars
    return [...ls.slice(0, i + 1), { ...rest }, ...ls.slice(i + 1)];
  });
  const total = lines.reduce((s, l) => s + n(l.qtyT), 0);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!h.date) return setErr('Nhập ngày tạo đơn.');
    if (!h.company) return setErr('Chọn công ty xuất.');
    if (!h.partyCode.trim()) return setErr('Chọn khách hàng.');
    const headCustom = {};
    for (const f of headFields.filter((x) => !BUILTIN_HEAD.includes(x.key))) {
      const v = cleanValue(f, h[f.key]);
      if (f.required && (v === '' || v == null)) return setErr(`Nhập ${f.label}.`);
      headCustom[f.key] = v;
    }
    const out = [];
    for (const [i, l] of lines.entries()) {
      const no = `Dòng ${i + 1}: `;
      if (!l.item || !itemMap.has(l.item)) return setErr(no + 'chọn mã hàng có trong danh mục (hoặc bấm + để thêm mã hàng mới).');
      const kg = Math.round(n(l.qtyT) * 1000 * 1000) / 1000;
      if (!(kg > 0)) return setErr(no + 'nhập số lượng (tấn).');
      if (l.shipCode && !myShips.some((s) => s.shipCode === l.shipCode)) return setErr(no + `mã giao ${l.shipCode} không thuộc khách hàng ${h.partyCode}.`);
      const custom = {};
      for (const f of lineFields.filter((x) => !BUILTIN_LINE.includes(x.key))) {
        const v = cleanValue(f, l[f.key]);
        if (f.required && (v === '' || v == null)) return setErr(no + `nhập ${f.label}.`);
        custom[f.key] = v;
      }
      out.push({ ...(l.no != null ? { no: l.no } : {}), item: l.item, itemName: itemMap.get(l.item).name, qtyKg: kg,
        dueDate: l.dueDate || '', warehouse: l.warehouse || '', shipCode: l.shipCode || '', goodsStatus: l.goodsStatus || '', note: String(l.note || '').trim(), ...custom });
    }
    const data = {
      ...headCustom, type: 'SO', company: h.company, date: h.date, partyCode: h.partyCode.trim(), partyName: String(h.partyName || '').trim(),
      refNo: order?.refNo || '', tolerancePct: h.tolerancePct === '' ? 0 : Number(h.tolerancePct), note: String(h.note || '').trim(),
      lines: out, ...summarizeLines(out),
    };
    setBusy(true);
    try {
      const id = order ? (await saveOrder(order.id, data, { email, name }), order.id) : await createOrder(data, { email, name });
      onClose(id);
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền lập/sửa đơn.' : e2.message);
      setBusy(false);
    }
  };

  const headInput = (f) => {
    if (f.key === 'date') return <input type="date" value={h.date} onChange={(e) => setHead('date', e.target.value)} />;
    if (f.key === 'company') return <div className="cell-add"><CompanyPicker value={h.company} allowAll={false} required onChange={(v) => setHead('company', v)} /><QuickAdd catKey="companies" onAdded={(id, r) => setHead('company', id, r)} /></div>;
    if (f.key === 'partyCode') return (
      <>
        <div className="cell-add">
          <input list="dl-so-party" value={h.partyCode} placeholder="Gõ hoặc chọn mã khách hàng" onChange={(e) => setHead('partyCode', e.target.value)} />
          <QuickAdd catKey="soldto" onAdded={(id, r) => setHead('partyCode', id, r)} />
        </div>
        {h.partyCode && <small className={recOf.partyCode(h.partyCode) || h.partyName ? 'small' : 'req'}>{recOf.partyCode(h.partyCode)?.name || h.partyName || 'Chưa có trong danh mục khách hàng: bấm + để thêm'}</small>}
      </>
    );
    return (
      <div className="cell-add">
        <FieldInput field={f} value={h[f.key]} onChange={(v) => setHead(f.key, v)} />
        {f.type === 'ref' && <QuickAdd catKey={f.ref} onAdded={(id) => setHead(f.key, id)} />}
      </div>
    );
  };

  const lineInput = (f, l, i) => {
    const done = n(l.doneKg) > 0;
    const set = (v, rec) => setLine(i, f.key, v, rec);
    switch (f.key) {
      case 'dueDate': return <input type="date" value={l.dueDate} onChange={(e) => set(e.target.value)} />;
      case 'warehouse': return (
        <select value={l.warehouse} onChange={(e) => set(e.target.value)}>
          <option value="">-- Kho nào cũng được --</option>
          {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
        </select>
      );
      case 'item': return (
        <div className="cell-add">
          <input list="dl-so-item" value={l.item} disabled={done} title={done ? 'Dòng đã giao, không đổi mã hàng được' : ''} onChange={(e) => set(e.target.value)} />
          {!done && <QuickAdd catKey="items" onAdded={(id, rec) => set(id, rec)} />}
        </div>
      );
      case 'itemName': return <span className="small">{itemMap.get(l.item)?.name || l.itemName}</span>;
      case 'qtyT': return <input type="number" step="any" min="0" value={l.qtyT} onChange={(e) => set(e.target.value)} />;
      case 'shipCode': return (
        <div className="cell-add">
          <select value={l.shipCode} onChange={(e) => set(e.target.value)} title={recOf.shipCode(l.shipCode)?.address || ''}>
            <option value="">{h.partyCode ? '-- Chọn --' : 'Chọn khách hàng trước'}</option>
            {myShips.map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
          </select>
          {h.partyCode && <QuickAdd catKey="shipto" preset={{ customerCode: h.partyCode, customerName: h.partyName }} onAdded={(id, rec) => set(id, rec)} />}
        </div>
      );
      case 'goodsStatus': return (
        <select value={l.goodsStatus} onChange={(e) => set(e.target.value)}>
          <option value="">KTC hoặc DGC</option>
          {(f.options || ['KTC', 'DGC']).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      case 'note': return <input value={l.note} onChange={(e) => set(e.target.value)} />;
      default: return (
        <div className="cell-add">
          <FieldInput field={f} value={l[f.key]} onChange={(v) => set(v)} />
          {f.type === 'ref' && <QuickAdd catKey={f.ref} onAdded={(id) => set(id)} />}
        </div>
      );
    }
  };
  const viaLabel = (vias, k) => vias.find((v) => v.key === k)?.label || k;

  return (
    <Modal title={order ? `Sửa ${order.id}` : 'Lập đơn bán (SO)'} onClose={() => onClose()} wide>
      <form onSubmit={submit}>
        <div className="so-section">
          <div className="section-head"><span className="grow">Thông tin chung của đơn</span><AddFieldButton formKey="soHead" vias={HEAD_VIAS} /></div>
          <div className="form-grid">
            {headFields.map((f) => (
              <Field key={f.key} label={f.label} required={f.required} full={f.type === 'textarea'}
                help={f.link ? `Tự lấy theo ${viaLabel(HEAD_VIAS, f.link.via)}` : f.help}>
                {headInput(f)}
              </Field>
            ))}
          </div>
        </div>

        <div className="so-section">
          <div className="section-head">
            <span className="grow">Dòng hàng ({lines.length}) · tổng {fmtNum(total, 3, 3)} tấn</span>
            <ColumnPicker cols={lineFields.map((f) => ({ key: f.key, label: f.label, locked: !!f.required }))} hidden={hiddenCols} setHidden={setHiddenCols} />
            <AddFieldButton formKey="soLine" vias={LINE_VIAS} />
          </div>
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="so-lines">
              <thead>
                <tr><th>#</th>{shownLine.map((f) => <th key={f.key} className={f.key === 'qtyT' ? 'num' : ''} title={f.link ? `Tự lấy theo ${viaLabel(LINE_VIAS, f.link.via)}` : f.help || ''}>{f.label}{f.required && <b className="req"> *</b>}{f.link ? ' ↳' : ''}</th>)}
                  {order && <th className="num">Đã giao</th>}<th></th></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="small">{i + 1}</td>
                    {shownLine.map((f) => <td key={f.key} className={f.key === 'item' ? 'w-item' : f.key === 'shipCode' ? 'w-ship' : f.key === 'qtyT' ? 'w-qty' : ''}>{lineInput(f, l, i)}</td>)}
                    {order && <td className="num">{n(l.doneKg) ? fmtNum(n(l.doneKg) / 1000, 3) : ''}</td>}
                    <td className="nowrap">
                      <button type="button" className="btn ghost sm" title="Nhân bản dòng (vd. cùng mã hàng giao điểm khác / kho khác)" onClick={() => copyLine(i)}>⧉</button>
                      <button type="button" className="btn ghost sm" disabled={lines.length === 1 || n(l.doneKg) > 0} title={n(l.doneKg) > 0 ? 'Dòng đã giao, không xóa được' : 'Xóa dòng'}
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn sm" style={{ marginTop: 6 }} onClick={addLine}>+ Thêm dòng</button>
          <span className="small" style={{ marginLeft: 8 }}>Mỗi dòng có ngày giao, kho xuất, mã giao, TTHH riêng: cùng 1 mã hàng giao nhiều điểm hoặc xuất nhiều kho thì thêm nhiều dòng (⧉ để nhân bản).</span>
        </div>
        <ErrorBox error={err} />
        <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : order ? 'Lưu' : 'Lập đơn'}</button></div>
        <datalist id="dl-so-party">{parties.filter((p) => p.active !== false).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
        <datalist id="dl-so-item">{items.filter((x) => x.active !== false).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</datalist>
      </form>
    </Modal>
  );
}
