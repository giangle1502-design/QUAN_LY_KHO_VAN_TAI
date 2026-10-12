// Tiền của dòng đơn (doanh thu SO, tiền mua PO) cho báo cáo: lấy từ trường tự thêm của dòng đơn
// (vd. Thành tiền = [Số lượng (tấn)] * [Đơn giá], hoặc Đơn giá / Giá mua × số lượng).
// Tự nhận trường theo tên; người dùng chỉnh được (lưu trên trình duyệt).
import { useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { usePref } from './prefs';
import { norm } from './utils';
import { fxOf, isUSD, usesFx } from './currency';

// Số có thể là chuỗi "29,500,000" (trường văn bản)
export const n = (v) => Number(typeof v === 'string' ? v.replace(/,/g, '') : v) || 0;
// Trường có thể chứa tiền: kiểu Tiền, công thức, hoặc số có tên chứa "giá" / "tiền"
export const isMoneyField = (f) => f.custom && (f.type === 'currency' || f.type === 'formula'
  || (['number', 'text'].includes(f.type) && /\b(gia|tien)\b/.test(norm(f.label))));
const has = (f, ...words) => words.some((w) => norm(f.label).includes(w));

export function guessMoneyFields(fields, priceWords) {
  const m = fields.filter(isMoneyField);
  const amount = m.find((f) => has(f, 'thanh tien', 'tong tien', 'gia tri')) || m.find((f) => f.type === 'formula' && f.resultType === 'currency');
  const price = m.find((f) => f.type !== 'formula' && has(f, ...priceWords))
    || m.find((f) => f.type !== 'formula' && has(f, 'don gia'))
    || m.find((f) => f.type !== 'formula' && has(f, 'gia'));
  return { amount: amount?.key || '', price: price?.key || '' };
}

// type: 'SO' | 'PO'. Trả về trường dòng được xem, cấu hình và hàm tính tiền 1 dòng
export function useOrderMoney(type) {
  const { seenFieldsOf, fieldsOf } = useApp();
  const fk = type.toLowerCase();
  const headSeen = useMemo(() => seenFieldsOf(`${fk}Head`, fieldsOf(`${fk}Line`)), [seenFieldsOf, fieldsOf, fk]);
  const lineSeen = useMemo(() => seenFieldsOf(`${fk}Line`, fieldsOf(`${fk}Head`)), [seenFieldsOf, fieldsOf, fk]);
  const moneyFields = useMemo(() => lineSeen.filter(isMoneyField), [lineSeen]);
  const guess = useMemo(() => guessMoneyFields(lineSeen, type === 'PO' ? ['gia mua', 'gia nhap'] : ['gia ban']), [lineSeen, type]);
  const [cfg, setCfg] = usePref(`orderMoney:${type}`, { amount: null, price: null, unit: 'tan' });
  const amountKey = cfg.amount ?? guess.amount;
  const priceKey = cfg.price ?? guess.price;
  const unit = cfg.unit || 'tan';
  const perUnit = unit === 'tan' ? 1000 : 1;
  // Đơn USD: tiền trường nào chưa nhân tỷ giá thì nhân để báo cáo luôn ra VNĐ
  const lists = [lineSeen, headSeen];
  const fxAmount = useMemo(() => !usesFx(lineSeen.find((f) => f.key === amountKey), lists), [lineSeen, headSeen, amountKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const fxPrice = useMemo(() => !usesFx(lineSeen.find((f) => f.key === priceKey), lists), [lineSeen, headSeen, priceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tiền cả dòng (theo số lượng đặt, VNĐ) và đơn giá VNĐ theo đơn vị giá; o = đơn (lấy đơn vị tiền tệ, tỷ giá)
  const lineMoney = (l, o) => {
    const usd = isUSD(o);
    const fx = fxOf(o);
    const ordered = n(l.qtyKg);
    const price = priceKey ? n(l[priceKey]) * (usd && fxPrice ? fx : 1) : 0;
    const full = amountKey && n(l[amountKey]) ? n(l[amountKey]) * (usd && fxAmount ? fx : 1) : (price * ordered) / perUnit;
    return { full, price: price || (ordered ? (full / ordered) * perUnit : 0) };
  };
  return { headSeen, lineSeen, moneyFields, amountKey, priceKey, unit, perUnit, unitLabel: unit === 'tan' ? 'đ/tấn' : 'đ/kg', cfg, setCfg, lineMoney };
}

// Hộp chỉnh cách tính tiền (dùng chung các báo cáo)
export function describeMoney(m) {
  const lbl = (k) => m.lineSeen.find((f) => f.key === k)?.label;
  return m.amountKey ? `trường "${lbl(m.amountKey)}"` : m.priceKey ? `"${lbl(m.priceKey)}" × số lượng (${m.unitLabel})` : '';
}
