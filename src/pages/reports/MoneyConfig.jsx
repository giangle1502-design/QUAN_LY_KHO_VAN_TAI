import { describeMoney, n } from '../../lib/orderMoney';
import Select from '../../components/Select';

// Chọn trường dùng để tính tiền (doanh thu / tiền mua) — lưu trên trình duyệt của người dùng
export default function MoneyConfig({ m, what }) {
  const { moneyFields, amountKey, priceKey, unit, cfg, setCfg } = m;
  return (
    <div className="card no-print" style={{ marginBottom: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
      <label className="field"><span>{what[0].toUpperCase() + what.slice(1)} lấy từ trường</span>
        <Select value={amountKey} onChange={(e) => setCfg({ ...cfg, amount: e.target.value })}>
          <option value="">(không — tính Đơn giá × số lượng)</option>
          {moneyFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </Select>
      </label>
      <label className="field"><span>Đơn giá</span>
        <Select value={priceKey} onChange={(e) => setCfg({ ...cfg, price: e.target.value })}>
          <option value="">(không có)</option>
          {moneyFields.filter((f) => f.type !== 'formula').map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </Select>
      </label>
      <label className="field"><span>Đơn giá tính theo</span>
        <Select value={unit} onChange={(e) => setCfg({ ...cfg, unit: e.target.value })}>
          <option value="tan">đ / tấn</option>
          <option value="kg">đ / kg</option>
        </Select>
      </label>
      <button className="btn ghost" onClick={() => setCfg({ amount: null, price: null, unit: 'tan' })}>Tự nhận lại</button>
      {!moneyFields.length && <div className="small">Dòng đơn chưa có trường tiền nào bạn được xem.</div>}
    </div>
  );
}

// Giải thích vì sao chưa có tiền: chưa có trường giá, trường chưa có dữ liệu, hay đang chọn sai trường
// rows: dòng báo cáo có _l = dòng đơn đã gộp giá riêng tư + công thức
export function NoMoneyNote({ m, rows, what, onConfig }) {
  const { moneyFields } = m;
  const counts = moneyFields.map((f) => ({ f, c: rows.filter((r) => n(r._l?.[f.key])).length }));
  const withData = counts.filter((x) => x.c > 0);
  const using = describeMoney(m);
  let msg;
  if (!moneyFields.length) {
    msg = <>Dòng đơn chưa có trường giá nào bạn được xem (vd. <b>Đơn giá</b>, <b>Thành tiền</b>), nên báo cáo chỉ tính sản lượng.
      Quản trị thêm trường ở <i>Quản lý trường (hạng mục)</i> → dòng hàng của đơn, hoặc cho bạn quyền xem trường giá.</>;
  } else if (!withData.length) {
    msg = <>Có trường {counts.map((x) => <b key={x.f.key}>"{x.f.label}" </b>)} nhưng chưa dòng đơn nào trong {rows.length} dòng được nhập giá
      (hoặc bạn không được xem giá các đơn này). Nhập Đơn giá vào đơn thì {what} sẽ hiện.</>;
  } else {
    msg = <>{what[0].toUpperCase() + what.slice(1)} đang tính từ {using || '(chưa chọn trường)'} nhưng chưa ra số. Trường đang có dữ liệu:{' '}
      {withData.map((x) => <b key={x.f.key}>"{x.f.label}" ({x.c} dòng) </b>)}. <a onClick={onConfig}>Chọn lại trường</a>.</>;
  }
  return <div className="ok-box" style={{ background: 'var(--amber-soft)', color: 'var(--amber)', marginBottom: 12 }}>ℹ {msg}</div>;
}
