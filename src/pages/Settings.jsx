import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { usePref } from '../lib/prefs';
import Select from '../components/Select';
import {
  DATE_FORMATS, DEC_SEPS, DEFAULT_FORMAT, GROUP_SEPS, TIME_FORMATS, fmtDate, fmtDateTime, fmtNum, getFormat, setFormat, today,
} from '../lib/utils';

// ============================================================================
// ⚙ Cài đặt hiển thị của từng người dùng: kiểu ngày, giờ, dấu thập phân, dấu hàng nghìn.
// Lưu theo tài khoản (máy nào đăng nhập cũng giống nhau). Chỉ đổi cách hiển thị trên màn hình / bản in,
// dữ liệu lưu và file Excel xuất ra (số dạng số) không đổi.
// ============================================================================
export default function Settings() {
  const { bumpFormat, name } = useApp();
  const [saved, setSaved] = usePref('fmt', null);
  const [f, setF] = useState(() => ({ ...DEFAULT_FORMAT, ...(saved || {}) }));
  const [msg, setMsg] = useState('');
  const set = (k, v) => {
    setMsg('');
    setF((p) => {
      const nx = { ...p, [k]: v };
      // Dấu thập phân và hàng nghìn không được trùng nhau
      if (k === 'dec' && nx.group === v) nx.group = v === ',' ? '.' : ',';
      if (k === 'group' && nx.dec === v) nx.dec = v === ',' ? '.' : ',';
      return nx;
    });
  };
  // Xem trước với cấu hình đang chọn
  const preview = (fn) => { const old = getFormat(); setFormat(f); const out = fn(); setFormat(old); return out; };
  const save = (val) => { setSaved(val); setFormat(val); bumpFormat(); setMsg('Đã lưu. Mọi màn hình hiển thị theo cài đặt mới.'); };
  const sample = new Date();
  const same = JSON.stringify({ ...DEFAULT_FORMAT, ...(saved || {}) }) === JSON.stringify(f);
  return (
    <div style={{ maxWidth: 760 }}>
      <div className="page-head"><h1>⚙ Cài đặt hiển thị</h1></div>
      <p className="hint">Cài đặt riêng của <b>{name}</b>, lưu theo tài khoản: đăng nhập máy khác hay điện thoại vẫn giữ nguyên. Chỉ đổi cách hiển thị, không đổi dữ liệu.</p>
      <div className="card">
        <div className="grid2">
          <label className="field"><span>Kiểu ngày</span>
            <Select value={f.date} onChange={(e) => set('date', e.target.value)}>
              {DATE_FORMATS.map((d) => <option key={d} value={d}>{d} → {preview(() => { setFormat({ ...f, date: d }); return fmtDate(today()); })}</option>)}
            </Select>
          </label>
          <label className="field"><span>Kiểu giờ</span>
            <Select value={f.time} onChange={(e) => set('time', e.target.value)}>
              {TIME_FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </label>
          <label className="field"><span>Dấu thập phân</span>
            <Select value={f.dec} onChange={(e) => set('dec', e.target.value)}>
              {DEC_SEPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </label>
          <label className="field"><span>Dấu phân cách hàng nghìn</span>
            <Select value={f.group} onChange={(e) => set('group', e.target.value)}>
              {GROUP_SEPS.filter(([k]) => k !== f.dec).map(([k, l]) => <option key={k || 'none'} value={k}>{l}</option>)}
            </Select>
          </label>
        </div>
        <div className="card" style={{ background: 'var(--primary-soft)', marginTop: 12 }}>
          <div className="small"><b>Xem trước</b></div>
          <div>Ngày: <b>{preview(() => fmtDate(today()))}</b> · Ngày giờ: <b>{preview(() => fmtDateTime(sample))}</b></div>
          <div>Số lượng: <b>{preview(() => fmtNum(1234567.891, 3))}</b> kg · Tiền: <b>{preview(() => fmtNum(25500000))}</b> đ · Tỷ lệ: <b>{preview(() => fmtNum(12.5, 2))}</b>%</div>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={same} onClick={() => save(f)}>Lưu cài đặt</button>
          <button className="btn ghost" onClick={() => { setF(DEFAULT_FORMAT); save(DEFAULT_FORMAT); }}>↺ Về mặc định công ty</button>
          {msg && <span className="small" style={{ color: 'var(--green)' }}>{msg}</span>}
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-head">Tùy chỉnh bảng danh sách và báo cáo</div>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li><b>⚙ Cột hiển thị</b>: chọn cột muốn xem, kéo ☰ hoặc ▲▼ để đổi thứ tự (kéo trực tiếp tiêu đề cột trên bảng cũng được).</li>
          <li><b>Bấm tiêu đề cột</b> để sắp xếp tăng / giảm; giữ <b>Shift</b> khi bấm để thêm cấp sắp xếp (vd. Kho → Vị trí).</li>
          <li><b>↕ Sắp xếp</b>: đặt nhiều cấp sắp xếp, mỗi cấp chọn cột và tăng / giảm.</li>
          <li><b>▾ trên tiêu đề cột</b>: lọc kiểu Excel — tích chọn giá trị, hoặc điều kiện chứa / bằng / lớn hơn / trong khoảng….</li>
          <li><b>🔎 Lọc nâng cao</b>: nhiều điều kiện VÀ / HOẶC, lưu bộ lọc hay dùng.</li>
          <li><b>💾 Mẫu hiển thị</b>: lưu cả bộ cột + sắp xếp + lọc thành mẫu có tên, lần sau chọn lại một chạm.</li>
        </ul>
      </div>
    </div>
  );
}
