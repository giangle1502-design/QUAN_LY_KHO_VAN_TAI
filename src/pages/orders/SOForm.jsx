import { notifyOrder } from '../../lib/chat';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useCollection, useCollections, useMyWarehouses, useOpCompany } from '../../lib/hooks';
import { refValue } from '../../catalogs';
import { CompanyPicker } from '../../components/TripBits';
import FieldInput from '../../components/FieldInput';
import { AddFieldButton, ColumnPicker, QuickAdd, WithAdd } from '../../components/FormTools';
import { dragHeadProps, orderCols } from '../../lib/colOrder';
import { ErrorBox, Field, Modal } from '../../components/ui';
import { ItemCode, ItemStockModal } from '../../components/ItemStock';
import { createOrder, isFinished, ORDER_STATUS, saveOrder, summarizeLines } from '../../lib/orders';
import { cleanValue, defaultsOf, fillEmptyLinks, isPrivate, linkPatch, visibleFields } from '../../lib/fields';
import { computeFormulas } from '../../lib/formula';
import { isUSD, moneyUnit, usesFx, withFx } from '../../lib/currency';
import { splitSecrets } from '../../lib/orderSecrets';
import { usePref } from '../../lib/prefs';
import { vnDate } from '../../lib/trips';
import { fmtNum } from '../../lib/utils';
import Select from '../../components/Select';
import { itemAllowed, saleSeesCustomer, saleTypes, salesFor, typesOf } from '../../lib/plasticSales';

// Đơn bán (SO) / đơn mua (PO) gồm 2 phần:
//  - Phần chung cho cả đơn: ngày tạo đơn, công ty xuất, khách hàng (+ trường tự thêm, có thể liên kết theo khách hàng / công ty)
//  - Dòng hàng: ngày giao, kho xuất, mã hàng, số lượng, mã giao, TTHH… riêng từng dòng → 1 mã hàng giao nhiều điểm / nhiều kho
const CFG = {
  SO: { head: 'soHead', line: 'soLine', party: 'soldto', partyLabel: 'khách hàng', title: 'đơn bán (SO)', done: 'Đã giao',
    hint: 'Mỗi dòng có ngày giao, kho xuất, mã giao, TTHH riêng: cùng 1 mã hàng giao nhiều điểm hoặc xuất nhiều kho thì thêm nhiều dòng (⧉ để nhân bản).' },
  PO: { head: 'poHead', line: 'poLine', party: 'suppliers', partyLabel: 'nhà cung cấp', title: 'đơn mua (PO)', done: 'Đã nhận',
    hint: 'Mỗi dòng có ngày hàng về, kho nhập, TTHH riêng: cùng 1 mã hàng về nhiều đợt hoặc nhập nhiều kho thì thêm nhiều dòng (⧉ để nhân bản).' },
  // Lệnh chuyển kho: kho xuất, kho nhập theo từng dòng → 1 lệnh chuyển nhiều tuyến (K1→K2, K1→K3…)
  STO: { head: 'stoHead', line: 'stoLine', party: null, title: 'lệnh chuyển kho (STO)', done: 'Đã xuất', received: 'Đã nhận',
    hint: 'Mỗi dòng có kho xuất, kho nhập, ngày chuyển, TTHH riêng: chuyển cùng 1 mã hàng đi nhiều kho thì thêm nhiều dòng (⧉ để nhân bản).' },
};
const BUILTIN_HEAD = ['date', 'company', 'partyCode', 'sales', 'tolerancePct', 'note'];
const BUILTIN_LINE = ['dueDate', 'warehouse', 'fromWarehouse', 'toWarehouse', 'item', 'itemName', 'qtyKg', 'qtyT', 'shipCode', 'goodsStatus', 'note'];
const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));

// Sửa đơn: liệt kê thay đổi để ghi lịch sử. Trường riêng tư (vd. giá) chỉ ghi "đổi …", không ghi giá trị
const blank = (v) => v === '' || v == null;
const same = (a, b) => (blank(a) && blank(b)) || String(a) === String(b)
  || (!blank(a) && !blank(b) && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && Number(a) === Number(b));
const show = (v) => (blank(v) ? '(trống)' : typeof v === 'number' ? fmtNum(v, 3) : String(v));
const LINE_FALLBACK = ['warehouse', 'shipCode', 'dueDate', 'fromWarehouse', 'toWarehouse'];
function orderChanges(order, head, lines, headFields, lineFields) {
  const out = [];
  const one = (f, a, b, pre = '') => {
    if (!same(a, b)) out.push(isPrivate(f) ? `${pre}đổi ${f.label}` : `${pre}${f.label}: ${show(a)} → ${show(b)}`);
  };
  for (const f of headFields) if (f.type !== 'formula' && f.key in head) one(f, order[f.key], head[f.key]);
  const old = new Map(order.lines.map((l) => [l.no, l]));
  const lf = lineFields.filter((f) => f.type !== 'formula' && !['qtyKg', 'qtyT', 'itemName'].includes(f.key));
  for (const l of lines) {
    const o = l.no != null ? old.get(l.no) : null;
    if (!o) { out.push(`Thêm dòng ${l.item} ${fmtNum(l.qtyKg, 2)} kg`); continue; }
    const pre = `Dòng ${o.no} (${o.item}): `;
    if (!same(o.qtyKg, l.qtyKg)) out.push(`${pre}SL ${fmtNum(n(o.qtyKg), 2)} → ${fmtNum(l.qtyKg, 2)} kg`);
    for (const f of lf) if (f.key in l) one(f, o[f.key] ?? (LINE_FALLBACK.includes(f.key) ? order[f.key] : ''), l[f.key], pre);
  }
  for (const o of order.lines) if (!lines.some((l) => l.no === o.no)) out.push(`Xóa dòng ${o.no} (${o.item})`);
  return out;
}

export default function SOForm({ type = 'SO', order, onClose }) {
  const cfg = CFG[type];
  const sto = type === 'STO';
  const { email, name, fieldsOf, isAdmin, hasRole, role, salesOnly } = useApp();
  // Chỉ các trường người dùng được xem (trường riêng tư, công thức dùng trường riêng tư bị ẩn).
  // Trường "sale phụ trách xem được" (vd. Giá bán): sale chỉ nhập / xem trong đơn của mình
  const me = { isAdmin, email, role, ownSale: order ? order.sales === email : role === 'kinh_doanh' };
  const headFields = visibleFields(fieldsOf(cfg.head), me, fieldsOf(cfg.line)).filter((f) => !f.hidden);
  const lineFields = visibleFields(fieldsOf(cfg.line), me, fieldsOf(cfg.head)).filter((f) => !f.hidden);
  const salesUsers = useCollection(sto || salesOnly ? '' : 'users').rows.filter((u) => u.role === 'kinh_doanh' && u.active !== false);
  // Liên kết được với mọi trường chọn danh mục trên form (có sẵn hoặc tự thêm); dòng hàng còn liên kết được với phần chung (h:…)
  const HEAD_VIAS = headFields.filter((f) => f.type === 'ref' && f.ref).map((f) => ({ key: f.key, label: f.label, ref: f.ref }));
  const LINE_VIAS = [...lineFields.filter((f) => f.type === 'ref' && f.ref).map((f) => ({ key: f.key, label: f.label, ref: f.ref })),
    ...HEAD_VIAS.map((v) => ({ ...v, key: `h:${v.key}`, label: `${v.label} (phần chung)` }))];
  // Danh mục của các trường chọn tự thêm (vd. Đơn vị vận tải) để tự điền trường liên kết
  const extraRows = useCollections([...HEAD_VIAS, ...LINE_VIAS].map((v) => v.ref));
  const parties = useCollection(cfg.party).rows; // STO: không có khách hàng / nhà cung cấp
  const companies = useCollection('companies').rows;
  const items = useCollection('items').rows;
  const shipto = useCollection('shipto').rows;
  const warehouses = useCollection('warehouses').rows.filter((w) => w.active !== false).sort((a, b) => a.code.localeCompare(b.code));
  // Thủ kho chỉ lập lệnh chuyển đi từ kho của mình
  const myWarehouses = useMyWarehouses();
  const fromOpts = hasRole('kinh_doanh', 'ke_toan') ? warehouses : myWarehouses;
  const itemMap = useMemo(() => new Map(items.map((i) => [i.code, i])), [items]);
  const recOf = {
    partyCode: (v) => parties.find((p) => p.code === v), company: (v) => companies.find((c) => c.code === v),
    item: (v) => itemMap.get(v), shipCode: (v) => shipto.find((s) => s.shipCode === v), warehouse: (v) => warehouses.find((w) => w.code === v),
    fromWarehouse: (v) => warehouses.find((w) => w.code === v), toWarehouse: (v) => warehouses.find((w) => w.code === v),
  };
  // Bản ghi đang chọn ở trường k (có sẵn hoặc tự thêm)
  const recAt = (fields, k, v) => {
    if (!v) return null;
    if (recOf[k]) return recOf[k](v) || null;
    const f = fields.find((x) => x.key === k);
    return f?.ref ? (extraRows[f.ref] || []).find((r) => refValue(f.ref, r) === v) || null : null;
  };
  const isVia = (fields, k) => fields.some((f) => f.link?.via === k);
  const [defaultCo] = useOpCompany();
  // Đơn mới: lấy giá trị mặc định đã thiết lập ở Quản lý trường
  const [h, setH] = useState(() => {
    // Đơn cũ chưa có đơn vị tiền tệ = VNĐ
    if (order) return { ...order, tolerancePct: order.tolerancePct || '', ...(sto ? {} : { currency: order.currency || 'VNĐ', fxRate: order.fxRate ?? '' }) };
    const d = defaultsOf(headFields);
    return { partyCode: '', partyName: '', tolerancePct: '', note: '', ...d, company: d.company || defaultCo, date: d.date || vnDate(), sales: d.sales || (role === 'kinh_doanh' ? email : '') };
  });
  const blankLine = () => ({ dueDate: '', warehouse: '', fromWarehouse: '', toWarehouse: '', item: '', itemName: '', qtyKg: '', shipCode: '', goodsStatus: '', note: '', ...defaultsOf(lineFields) });
  // Đơn cũ (kho / mã giao / hạn giao ở đầu đơn): chép xuống từng dòng
  const [lines, setLines] = useState(() => (order
    ? order.lines.map((l) => ({ ...l, warehouse: l.warehouse || order.warehouse || '', shipCode: l.shipCode || order.shipCode || '', dueDate: l.dueDate || order.dueDate || '', goodsStatus: l.goodsStatus || '', note: l.note || '',
      ...(sto ? { fromWarehouse: l.fromWarehouse || order.fromWarehouse || '', toWarehouse: l.toWarehouse || order.toWarehouse || '' } : {}) }))
    : [blankLine()]));
  const [hiddenCols, setHiddenCols] = usePref(`${type}LineHiddenCols`, []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Sửa đơn đã hoàn tất / đã đóng: bắt buộc ghi lý do
  const finished = isFinished(order);
  const [editReason, setEditReason] = useState('');
  // Bấm mã hàng → Xem tồn kho → chọn kho xuất cho dòng (SO: Kho xuất, STO: Kho xuất đi)
  const [stockAt, setStockAt] = useState(null);
  const whKey = sto ? 'fromWarehouse' : 'warehouse';
  const canStock = type === 'SO' || sto;
  const statuses = useCollection(canStock ? 'goodsStatus' : '').rows;

  // Thứ tự cột dòng hàng riêng của từng người (kéo thả tiêu đề hoặc trong ⚙ Cột hiển thị)
  const [lineOrder, setLineOrder] = usePref(`${type}LineOrder`, []);
  const orderedLine = orderCols(lineFields, lineOrder);
  const lineKeys = orderedLine.map((f) => f.key);
  const shownLine = orderedLine.filter((f) => f.required || !hiddenCols.includes(f.key));
  const myShips = shipto.filter((s) => s.customerCode === h.partyCode);
  // Loại hạt nhựa (SO): sale chỉ thấy khách mình được gán, chỉ chọn mã hàng loại mình phụ trách; mỗi SO một loại
  const isSO = type === 'SO';
  const cust = isSO ? recOf.partyCode(h.partyCode) : null;
  const partyOpts = isSO && salesOnly ? parties.filter((p) => saleSeesCustomer(p, email)) : parties;
  const itemOpts = isSO && salesOnly ? items.filter((x) => itemAllowed(x, cust, email)) : items;
  const soTypes = isSO ? typesOf(lines.map((l) => l.item), itemMap) : [];
  // Sale phụ trách SO mới luôn theo thiết lập của khách hàng + loại hạt nhựa (không theo người lập: admin lập hộ vẫn về đúng sale).
  // Đơn đã lập giữ nguyên sale cũ khi khách chuyển sang sale khác (doanh số đã tính cho sale trước)
  const autoSale = isSO && !order && soTypes.length === 1 ? salesFor(cust, soTypes[0]) : '';
  useEffect(() => {
    if (autoSale && h.sales !== autoSale) setH((x) => ({ ...x, sales: autoSale }));
  }, [autoSale]); // eslint-disable-line react-hooks/exhaustive-deps

  const setHead = (k, v, rec) => setH((x) => {
    const p = { [k]: v };
    if (k === 'partyCode') {
      const c = rec || recOf.partyCode(v);
      p.partyName = c ? c.name : x.partyName;
      // Đổi khách hàng: mã giao của khách cũ không còn đúng
      setLines((ls) => ls.map((l) => (l.shipCode && !shipto.some((s) => s.shipCode === l.shipCode && s.customerCode === v) ? { ...l, shipCode: '' } : l)));
    }
    const r = rec || recAt(headFields, k, v);
    if (isVia(headFields, k)) Object.assign(p, linkPatch(headFields, k, r));
    // Trường dòng hàng liên kết với phần chung: cập nhật mọi dòng
    if (isVia(lineFields, `h:${k}`)) setLines((ls) => ls.map((l) => ({ ...l, ...linkPatch(lineFields, `h:${k}`, r) })));
    return { ...x, ...p };
  });
  const setLine = (i, k, v, rec) => setLines((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const p = { [k]: v };
    const r = rec || recAt(lineFields, k, v);
    if (k === 'item') p.itemName = r?.name || '';
    if (isVia(lineFields, k)) Object.assign(p, linkPatch(lineFields, k, r));
    return { ...l, ...p };
  }));
  // Khách chỉ có 1 mã giao: dòng chưa có mã giao tự lấy mã đó
  const oneShip = !sto && myShips.length === 1 ? myShips[0] : null;
  useEffect(() => {
    if (!oneShip || !lines.some((l) => !l.shipCode)) return;
    setLines((ls) => ls.map((l) => (l.shipCode ? l : { ...l, shipCode: oneShip.shipCode, ...(isVia(lineFields, 'shipCode') ? linkPatch(lineFields, 'shipCode', oneShip) : {}) })));
  }, [oneShip?.shipCode, lines.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Dòng mới lấy sẵn ngày giao, kho, mã giao, TTHH của dòng trên cho nhanh
  const addLine = () => setLines((ls) => {
    const last = ls[ls.length - 1] || {};
    const b = blankLine();
    const carry = Object.fromEntries(['dueDate', 'warehouse', 'fromWarehouse', 'toWarehouse', 'shipCode', 'goodsStatus', 'packing'].map((k) => [k, last[k] || b[k]]));
    const nl = { ...b, ...carry };
    return [...ls, { ...nl, ...fillEmptyLinks(lineFields, nl, (via) => (via.startsWith('h:') ? recAt(headFields, via.slice(2), h[via.slice(2)]) : recAt(lineFields, via, nl[via]))) }];
  });
  // Giá trị mặc định là mã danh mục (vd. khách hàng, kho): khi danh mục tải xong thì điền các trường liên kết còn trống
  const loadedKey = [parties.length, companies.length, items.length, shipto.length, warehouses.length, ...Object.values(extraRows).map((r) => r.length)].join(',');
  useEffect(() => {
    if (order) return;
    const headRec = (via) => recAt(headFields, via, h[via]);
    const hp = fillEmptyLinks(headFields, h, headRec);
    if (h.partyCode && !h.partyName && recOf.partyCode(h.partyCode)) hp.partyName = recOf.partyCode(h.partyCode).name;
    if (Object.keys(hp).length) setH((x) => ({ ...x, ...hp }));
    setLines((ls) => {
      let changed = false;
      const out = ls.map((l) => {
        const p = fillEmptyLinks(lineFields, l, (via) => (via.startsWith('h:') ? headRec(via.slice(2)) : recAt(lineFields, via, l[via])));
        if (l.item && !l.itemName && itemMap.get(l.item)) p.itemName = itemMap.get(l.item).name;
        if (!Object.keys(p).length) return l;
        changed = true;
        return { ...l, ...p };
      });
      return changed ? out : ls;
    });
  }, [loadedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const copyLine = (i) => setLines((ls) => {
    const { no, doneKg, receivedKg, ...rest } = ls[i]; // eslint-disable-line no-unused-vars
    return [...ls.slice(0, i + 1), { ...rest }, ...ls.slice(i + 1)];
  });
  const total = lines.reduce((s, l) => s + n(l.qtyKg), 0);
  // Trường công thức: tính lại mỗi lần nhập (dòng hàng trước, phần chung sau để dùng SUM)
  // Số lượng (tấn) = kg / 1000, chỉ để xem và dùng trong công thức
  // Đơn USD: Thành tiền (VNĐ) = số lượng × đơn giá × [Tỷ giá]; đơn VNĐ thì [Tỷ giá] = 1
  const hx = withFx(h);
  const lc = lines.map((l) => computeFormulas(lineFields, { ...l, qtyT: l.qtyKg === '' ? '' : n(l.qtyKg) / 1000 }, { extraFields: headFields, rowExtra: hx }));
  const hc = computeFormulas(headFields, hx, { lines: lc, lineFields });
  const usd = !sto && isUSD(h);
  const lists = [lineFields, headFields];
  const unitOf = (f) => moneyUnit(f, h, lists);
  // Đơn USD mà có giá nhập tay nhưng chưa có công thức nào nhân tỷ giá → nhắc sửa công thức Thành tiền
  const fxLabel = headFields.find((f) => f.key === 'fxRate')?.label || 'Tỷ giá (VNĐ/USD)';
  const fxMissing = usd && lineFields.some((f) => f.type === 'currency') && !lineFields.some((f) => usesFx(f, lists));
  const shownHead = headFields.filter((f) => f.key !== 'fxRate' || usd);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!h.date) return setErr('Nhập ngày tạo đơn.');
    if (!h.company) return setErr(sto ? 'Chọn công ty chủ hàng.' : 'Chọn công ty xuất.');
    if (!sto && !h.partyCode.trim()) return setErr(`Chọn ${cfg.partyLabel}.`);
    if (usd && !(n(h.fxRate) > 0)) return setErr(`Đơn USD: nhập ${fxLabel}.`);
    if (finished && !editReason.trim()) return setErr('Nhập lý do sửa đơn (đơn đã hoàn tất / đã đóng).');
    if (isSO && soTypes.length > 1) return setErr(`Mỗi SO chỉ một loại hạt nhựa: đơn đang có cả ${soTypes.join(' và ')}. Tách thành ${soTypes.length} SO.`);
    if (isSO && salesOnly && cust && !saleSeesCustomer(cust, email)) return setErr(`Bạn không phụ trách khách hàng ${h.partyCode}.`);
    if (isSO && salesOnly && cust) {
      const bad = lines.find((l) => l.item && !itemAllowed(itemMap.get(l.item), cust, email));
      if (bad) return setErr(`Mã hàng ${bad.item} là hạt nhựa ${itemMap.get(bad.item).plasticType}: bạn chỉ phụ trách ${saleTypes(cust, email).join(', ') || 'không loại nào'} của khách ${h.partyCode}.`);
    }
    const headCustom = {};
    for (const f of headFields.filter((x) => !BUILTIN_HEAD.includes(x.key) && x.type !== 'formula')) {
      // Đơn VNĐ không lưu tỷ giá
      const v = f.key === 'fxRate' && !usd ? null : cleanValue(f, h[f.key]);
      if (f.required && (v === '' || v == null) && (f.key !== 'fxRate' || usd)) return setErr(`Nhập ${f.label}.`);
      headCustom[f.key] = v;
    }
    const out = [];
    for (const [i, l] of lines.entries()) {
      const no = `Dòng ${i + 1}: `;
      if (!l.item || !itemMap.has(l.item)) return setErr(no + 'chọn mã hàng có trong danh mục (hoặc bấm + để thêm mã hàng mới).');
      const kg = Math.round(n(l.qtyKg) * 1000) / 1000;
      if (!(kg > 0)) return setErr(no + 'nhập số lượng (kg).');
      if (sto) {
        if (!l.fromWarehouse || !l.toWarehouse) return setErr(no + 'chọn kho xuất và kho nhập.');
        if (l.fromWarehouse === l.toWarehouse) return setErr(no + 'kho nhập phải khác kho xuất.');
        if (!n(l.doneKg) && !fromOpts.some((w) => w.code === l.fromWarehouse)) return setErr(no + `bạn chỉ lập lệnh chuyển đi từ kho mình phụ trách (${fromOpts.map((w) => w.code).join(', ')}).`);
      }
      if (!sto && l.shipCode && !myShips.some((s) => s.shipCode === l.shipCode)) return setErr(no + `mã giao ${l.shipCode} không thuộc khách hàng ${h.partyCode}.`);
      const custom = {};
      for (const f of lineFields.filter((x) => !BUILTIN_LINE.includes(x.key) && x.type !== 'formula')) {
        const v = cleanValue(f, l[f.key]);
        if (f.required && (v === '' || v == null)) return setErr(no + `nhập ${f.label}.`);
        custom[f.key] = v;
      }
      out.push({ ...(l.no != null ? { no: l.no } : {}), item: l.item, itemName: itemMap.get(l.item).name, qtyKg: kg,
        dueDate: l.dueDate || '', ...(sto ? { fromWarehouse: l.fromWarehouse, toWarehouse: l.toWarehouse } : { warehouse: l.warehouse || '', shipCode: l.shipCode || '' }),
        goodsStatus: l.goodsStatus || '', note: String(l.note || '').trim(), ...custom });
    }
    const changes = order ? orderChanges(order, { ...headCustom, company: h.company, date: h.date, partyCode: h.partyCode, note: String(h.note || '').trim(),
      tolerancePct: h.tolerancePct === '' ? 0 : Number(h.tolerancePct), ...(sto ? {} : autoSale ? { sales: autoSale } : salesOnly ? {} : { sales: String(h.sales || '').trim().toLowerCase() }) },
    out, headFields, lineFields) : [];
    if (finished && !changes.length) return setErr('Chưa có thay đổi nào.');
    // Trường riêng tư (chỉ người được chỉ định xem) lưu riêng ở orderSecrets
    const sp = splitSecrets(headFields, lineFields, headCustom, out);
    const sum = summarizeLines(sp.lines, sto);
    const whName = (c) => warehouses.find((w) => w.code === c)?.name || c;
    const data = {
      ...sp.head, type, company: h.company, date: h.date, ...(sto ? {} : { sales: autoSale || (salesOnly ? email : String(h.sales || '').trim().toLowerCase()) }),
      ...(sto ? { partyCode: sum.toWarehouses.join(', '), partyName: `Chuyển đến kho ${sum.toWarehouses.map(whName).join(', ')}` }
        : { partyCode: h.partyCode.trim(), partyName: String(h.partyName || recOf.partyCode(h.partyCode.trim())?.name || '').trim() }),
      refNo: order?.refNo || '', tolerancePct: h.tolerancePct === '' ? 0 : Number(h.tolerancePct), note: String(h.note || '').trim(),
      lines: sp.lines, ...sum,
    };
    setBusy(true);
    try {
      const id = order ? (await saveOrder(order.id, data, { email, name }, sp.secrets, { reason: editReason, changes }), order.id) : await createOrder(data, { email, name }, sp.secrets);
      // Đơn mới: tin nhắn hệ thống theo cấu hình (không chờ, lỗi không ảnh hưởng việc lập đơn)
      if (!order) notifyOrder(id, data, { email, name });
      onClose(id);
    } catch (e2) {
      setErr(e2.code === 'permission-denied' ? 'Bạn không có quyền lập/sửa đơn.' : e2.message);
      setBusy(false);
    }
  };

  const headInput = (f) => {
    if (f.key === 'date') return <input type="date" value={h.date} onChange={(e) => setHead('date', e.target.value)} />;
    if (f.key === 'company') return <CompanyPicker value={h.company} allowAll={false} required onChange={(v) => setHead('company', v)} />;
    if (f.key === 'partyCode') return (
      <>
        <div className="cell-add">
          <input list="dl-so-party" value={h.partyCode} placeholder={`Gõ hoặc chọn mã ${cfg.partyLabel}`} onChange={(e) => setHead('partyCode', e.target.value)} />
          <QuickAdd catKey={cfg.party} onAdded={(id, r) => setHead('partyCode', id, r)} />
        </div>
        {h.partyCode && <small className={recOf.partyCode(h.partyCode) || h.partyName ? 'small' : 'req'}>{recOf.partyCode(h.partyCode)?.name || h.partyName || `Chưa có trong danh mục ${cfg.partyLabel}: bấm + để thêm`}</small>}
      </>
    );
    if (f.key === 'sales' && autoSale) return <div className="readonly-val" title="Theo Sale phụ trách của khách hàng (Danh mục khách hàng)">{autoSale} <small className="small">· theo khách hàng, hạt nhựa {soTypes[0]}</small></div>;
    if (f.key === 'sales') return salesOnly ? <div className="readonly-val">{h.sales || email}</div> : (
      <div>
        <Select value={h.sales || ''} onChange={(e) => setHead('sales', e.target.value)}>
          <option value="">-- Chưa giao sale --</option>
          {h.sales && !salesUsers.some((u) => u.email === h.sales) && <option value={h.sales}>{h.sales}</option>}
          {salesUsers.map((u) => <option key={u.email} value={u.email}>{u.name} ({u.email})</option>)}
        </Select>
      </div>
    );
    return (
      <div className="cell-add">
        <FieldInput field={f} value={f.type === 'formula' ? hc[f.key] : h[f.key]} unit={unitOf(f)} onChange={(v) => setHead(f.key, v)} />
      </div>
    );
  };

  const lineInput = (f, l, i) => {
    const done = n(l.doneKg) > 0;
    const set = (v, rec) => setLine(i, f.key, v, rec);
    switch (f.key) {
      case 'dueDate': return <input type="date" value={l.dueDate} onChange={(e) => set(e.target.value)} />;
      case 'warehouse': return (
        <WithAdd cat="warehouses" onAdded={(id) => set(id)}>
          <Select value={l.warehouse} onChange={(e) => set(e.target.value)}>
            <option value="">-- Kho nào cũng được --</option>
            {warehouses.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
          </Select>
        </WithAdd>
      );
      case 'fromWarehouse': case 'toWarehouse': {
        const opts = f.key === 'fromWarehouse' ? fromOpts : warehouses.filter((w) => w.code !== l.fromWarehouse);
        return (
          <WithAdd cat="warehouses" onAdded={(id) => !done && set(id)}>
            <Select value={l[f.key]} disabled={done} title={done ? 'Dòng đã xuất, không đổi kho được' : ''} onChange={(e) => set(e.target.value)}>
              <option value="">-- Chọn --</option>
              {l[f.key] && !opts.some((w) => w.code === l[f.key]) && <option value={l[f.key]}>{l[f.key]}</option>}
              {opts.map((w) => <option key={w.code} value={w.code}>{w.code} – {w.name}</option>)}
            </Select>
          </WithAdd>
        );
      }
      case 'item': return (
        <div className="cell-add">
          <input list="dl-so-item" value={l.item} disabled={done} title={done ? 'Dòng đã giao, không đổi mã hàng được' : ''} onChange={(e) => set(e.target.value)} />
          {!done && <QuickAdd catKey="items" onAdded={(id, rec) => set(id, rec)} />}
          {canStock && itemMap.has(l.item) && !done && <ItemCode code={l.item} label="📦 Tồn" onStock={() => setStockAt(i)} />}
        </div>
      );
      case 'itemName': return <span className="small">{itemMap.get(l.item)?.name || l.itemName}</span>;
      case 'qtyKg': {
        // Quy đổi: tấn, pallet (theo quy cách mã hàng)
        const it = itemMap.get(l.item);
        const perPl = n(it?.bagsPerLayer) * n(it?.layersPerPallet) * n(it?.bagWeight);
        return <>
          <input type="number" step="any" min="0" value={l.qtyKg} onChange={(e) => set(e.target.value)} />
          {n(l.qtyKg) > 0 && perPl > 0 && <small className="small nowrap">≈ {fmtNum(n(l.qtyKg) / perPl, 2)} pallet</small>}
        </>;
      }
      case 'qtyT': return <span className="readonly-val">{n(l.qtyKg) ? fmtNum(n(l.qtyKg) / 1000, 3) : ''}</span>;
      case 'shipCode': return (
        <div className="cell-add">
          <Select value={l.shipCode} onChange={(e) => set(e.target.value)} title={recOf.shipCode(l.shipCode)?.address || ''}>
            <option value="">{h.partyCode ? '-- Chọn --' : 'Chọn khách hàng trước'}</option>
            {myShips.map((s) => <option key={s.shipCode} value={s.shipCode}>{s.shipCode} – {s.address}</option>)}
          </Select>
          {h.partyCode && <QuickAdd catKey="shipto" preset={{ customerCode: h.partyCode, customerName: h.partyName }} onAdded={(id, rec) => set(id, rec)} />}
        </div>
      );
      case 'goodsStatus': return (
        <Select value={l.goodsStatus} onChange={(e) => set(e.target.value)}>
          <option value="">{type === 'PO' ? '-- Theo thực tế --' : sto ? '-- Loại nào cũng được --' : 'KTC hoặc DGC'}</option>
          {(f.options || ['KTC', 'DGC']).map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      );
      case 'note': return Number(f.height) > 40 ? <textarea value={l.note} onChange={(e) => set(e.target.value)} /> : <input value={l.note} onChange={(e) => set(e.target.value)} />;
      default: return (
        <div className="cell-add">
          <FieldInput field={f} value={f.type === 'formula' ? lc[i][f.key] : l[f.key]} unit={unitOf(f)} onChange={(v) => set(v)} />
        </div>
      );
    }
  };
  const viaLabel = (vias, k) => vias.find((v) => v.key === k)?.label || k;

  return (
    <Modal title={order ? `Sửa ${order.id}` : `Lập ${cfg.title}`} onClose={() => onClose()} wide>
      <form onSubmit={submit}>
        {finished && (
          <div style={{ marginBottom: 10, padding: 10, border: '1px solid var(--amber)', background: 'var(--amber-soft)', borderRadius: 8 }}>
            Đơn đang <b>{ORDER_STATUS[order.status].label.toLowerCase()}</b>: sửa được giá, khách hàng, thông tin dòng hàng… Số lượng không nhỏ hơn phần {cfg.done.toLowerCase()};
            tăng số lượng thì đơn {order.status === 'done' ? 'chuyển lại "Đang thực hiện" để giao/nhận tiếp' : 'vẫn giữ trạng thái đã đóng'}. Mọi thay đổi được ghi vào lịch sử đơn.
            <Field label="Lý do sửa" required><input value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="vd. Sai đơn giá, khách đổi mã giao…" /></Field>
          </div>
        )}
        <div className="so-section">
          <div className="section-head"><span className="grow">Thông tin chung của đơn</span><AddFieldButton formKey={cfg.head} vias={HEAD_VIAS} /></div>
          <div className="form-grid">
            {shownHead.map((f) => (
              <Field key={f.key} label={f.label} required={f.required} size={f} full={f.type === 'textarea' && !f.width}
                help={f.link ? `Tự lấy theo ${viaLabel(HEAD_VIAS, f.link.via)}` : f.help}>
                {headInput(f)}
              </Field>
            ))}
          </div>
        </div>

        <div className="so-section">
          <div className="section-head">
            <span className="grow">Dòng hàng ({lines.length}) · tổng {fmtNum(total, 2)} kg (= {fmtNum(total / 1000, 3)} tấn)</span>
            <ColumnPicker cols={lineFields.map((f) => ({ key: f.key, label: f.label, locked: !!f.required }))} hidden={hiddenCols} setHidden={setHiddenCols} order={lineOrder} setOrder={setLineOrder} />
            <AddFieldButton formKey={cfg.line} vias={LINE_VIAS} />
          </div>
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="so-lines">
              <thead>
                <tr><th>#</th>{shownLine.map((f) => <th key={f.key} className={(['qtyT', 'qtyKg'].includes(f.key) ? 'num ' : '') + 'col-drag'} {...dragHeadProps(f.key, lineKeys, setLineOrder)} title={f.link ? `Tự lấy theo ${viaLabel(LINE_VIAS, f.link.via)}` : f.help || ''}>{f.label}{f.required && <b className="req"> *</b>}{f.link ? ' ↳' : ''}</th>)}
                  {order && <th className="num">{cfg.done}</th>}{order && sto && <th className="num">{cfg.received}</th>}<th></th></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="small">{i + 1}</td>
                    {shownLine.map((f) => <td key={f.key} style={{ ...(f.width ? { minWidth: Math.min(f.width, 600) } : {}), ...(f.height ? { '--fh': `${f.height}px` } : {}) }}
                      className={(f.key === 'item' ? 'w-item' : ['shipCode', 'fromWarehouse', 'toWarehouse'].includes(f.key) ? 'w-ship' : f.key === 'qtyKg' ? 'w-qty' : '') + (f.height ? ' fh' : '')}>{lineInput(f, l, i)}</td>)}
                    {order && <td className="num">{n(l.doneKg) ? fmtNum(n(l.doneKg), 2) : ''}</td>}
                    {order && sto && <td className="num">{n(l.receivedKg) ? fmtNum(n(l.receivedKg), 2) : ''}</td>}
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
          <span className="small" style={{ marginLeft: 8 }}>{cfg.hint}</span>
          {usd && <p className="small" style={{ marginTop: 6 }}>Đơn <b>USD</b>: đơn giá nhập theo USD; Thành tiền (VNĐ) = số lượng × đơn giá × tỷ giá {n(h.fxRate) > 0 ? <b>{fmtNum(n(h.fxRate), 2)}</b> : <b className="req">(chưa nhập tỷ giá)</b>}.</p>}
          {fxMissing && <p className="small req">Công thức Thành tiền chưa nhân tỷ giá nên đang ra USD. Vào ✎ Sửa trường, sửa công thức thành vd. <b>[Số lượng (tấn)] * [Đơn giá] * [{fxLabel}]</b> (đơn VNĐ tỷ giá tự = 1). Báo cáo vẫn tự quy đổi ra VNĐ.</p>}
        </div>
        <ErrorBox error={err} />
        <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Đang lưu…' : order ? 'Lưu' : 'Lập đơn'}</button></div>
        <datalist id="dl-so-party">{partyOpts.filter((p) => p.active !== false).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</datalist>
        {stockAt != null && lines[stockAt] && (() => {
          const l = lines[stockAt];
          // STO chuyển được mọi tình trạng (kể cả HTC); SO không xuất được hàng bị khóa (HTC) và chỉ tính TTHH của dòng nếu có
          return (
            <ItemStockModal item={l.item} itemName={itemMap.get(l.item)?.name || ''} whCode={l[whKey]} warehouses={warehouses} company={h.company}
              pickRows={false} pickLabel="Chọn làm kho xuất" curLabel="Đang chọn"
              blocked={(r) => !sto && ((r.goodsStatus !== 'HTC' && (r.goodsStatus === 'BLK' || statuses.find((x) => x.code === r.goodsStatus)?.allowOutbound === false)) || (l.goodsStatus && r.goodsStatus !== l.goodsStatus && r.goodsStatus !== 'HTC'))}
              allowWh={(c) => (sto ? fromOpts.some((w) => w.code === c) && c !== l.toWarehouse : true)}
              need={n(l.qtyKg)}
              note={<>Dòng {stockAt + 1}: chọn kho đang có hàng làm <b>kho xuất</b>{sto ? ' (kho nhập phải khác kho xuất; thủ kho chỉ chọn được kho mình phụ trách)' : ''}. Bấm vào kho để xem chi tiết lot, vị trí, tình trạng.</>}
              onClose={() => setStockAt(null)} onPick={(c) => { setLine(stockAt, whKey, c); setStockAt(null); }} />
          );
        })()}
        <datalist id="dl-so-item">{itemOpts.filter((x) => x.active !== false).map((x) => <option key={x.code} value={x.code}>{x.name}{x.plasticType ? ` · ${x.plasticType}` : ''}</option>)}</datalist>
      </form>
    </Modal>
  );
}
