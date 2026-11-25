import { useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { lineDue, lineShip, openKg, orderLineChoices } from '../lib/orders';
import { useOrderMoney } from '../lib/orderMoney';
import { fmtDate, fmtNum } from '../lib/utils';
import Select from './Select';

// Đơn giá từng dòng của 1 đơn (trường giá có thể là riêng tư: chỉ người được xem mới đọc được, lỗi quyền thì bỏ qua)
function useLinePrices(order, priceKey) {
  const [sec, setSec] = useState({});
  useEffect(() => {
    if (!order?.id || !priceKey) return undefined;
    let live = true;
    getDocs(query(collection(db, 'orderSecrets'), where('orderId', '==', order.id), where('field', '==', priceKey)))
      .then((s) => { if (live) setSec(Object.assign({}, ...s.docs.map((d) => d.data().lines || {}))); })
      .catch(() => {});
    return () => { live = false; };
  }, [order?.id, priceKey]);
  return (l) => sec[String(l.no)] ?? l[priceKey] ?? '';
}

// 1 mã hàng có từ 2 dòng đơn trở lên (vd. cùng mã, 2 đơn giá): dòng phiếu chọn rõ trừ vào dòng đơn nào.
// Phiếu lập từ đơn / DO đã tự gắn đúng dòng; dòng thêm tay chưa gắn thì bắt buộc chọn trước khi lưu.
export default function OrderLinePick({ order, item, moveType, wh, value, onChange }) {
  const { priceKey } = useOrderMoney(order?.type === 'PO' ? 'PO' : 'SO');
  const priceOf = useLinePrices(order, priceKey);
  if (!order || !item || order.type === 'STO') return null;
  const choices = orderLineChoices(order, item, moveType, { warehouse: wh });
  if (choices.length < 2) return null;
  const cur = choices.find((l) => l.no === value);
  const label = (l) => {
    const p = priceOf(l);
    return [`Dòng ${l.no}`, p !== '' && p != null ? `giá ${typeof p === 'number' ? fmtNum(p, 0) : p}` : '', lineShip(order, l) ? `giao ${lineShip(order, l)}` : '',
      lineDue(order, l) ? fmtDate(lineDue(order, l)) : '', `còn ${fmtNum(openKg(order, l, moveType), 2)} kg`].filter(Boolean).join(' · ');
  };
  return (
    <label className={'ol-pick' + (cur ? '' : ' need')} title="Mã hàng này có nhiều dòng trong đơn: chọn dòng để trừ đúng số lượng, đúng đơn giá">
      <span className="small">Trừ vào dòng {order.type}</span>
      <Select value={cur ? String(cur.no) : ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">-- Chọn dòng đơn --</option>
        {choices.map((l) => <option key={l.no} value={l.no} disabled={openKg(order, l, moveType) <= 0.001 && l.no !== value}>{label(l)}</option>)}
      </Select>
    </label>
  );
}
