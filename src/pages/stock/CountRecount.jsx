import { useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { ErrorBox, Field, Modal } from '../../components/ui';
import MultiPick from '../../components/MultiPick';
import { vnDate } from '../../lib/trips';
import { fmtNum } from '../../lib/utils';
import { createRecount, lineResult } from '../../lib/counts';
import { siblingsOf, whLabel } from '../../lib/whGroups';

// Thủ kho (vai trò thu_kho, còn hoạt động) phụ trách ít nhất 1 trong các kho (hoặc được giao mọi kho)
export function useKeepers(whs) {
  const { rows } = useCollection('users');
  const key = (whs || []).join(',');
  return useMemo(() => {
    const want = new Set((whs || []).flatMap((w) => siblingsOf(w)));
    return rows.filter((u) => u.active !== false && u.role === 'thu_kho'
      && (!want.size || !(u.warehouses || []).length || u.warehouses.some((w) => want.has(w))))
      .map((u) => ({ email: String(u.email || u._id).toLowerCase(), name: u.name || u.displayName || u.email || u._id }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }, [rows, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function KeeperPick({ whs, value, onChange }) {
  const keepers = useKeepers(whs);
  const opts = keepers.map((k) => ({ value: k.email, label: `${k.name} (${k.email})`, short: k.name }));
  return (
    <>
      <MultiPick value={value.map((a) => a.email)} opts={opts} allLabel="-- Chưa giao ai --" unit="thủ kho"
        onChange={(v) => onChange(v.map((e) => keepers.find((k) => k.email === e) || { email: e, name: e }))} />
      {!keepers.length && <div className="small">Chưa có tài khoản vai trò Thủ kho cho kho này (Hệ thống → Phân quyền).</div>}
    </>
  );
}

// Lệnh đếm lại: nhận các dòng lệch (đã gắn warehouse, countId), chọn thủ kho → phiếu cycle count mới
export function RecountModal({ lines, onClose }) {
  const { email, name } = useApp();
  const whs = [...new Set(lines.map((l) => l.warehouse).filter(Boolean))];
  const [assignees, setAssignees] = useState([]);
  const [date, setDate] = useState(vnDate());
  const [showSys, setShowSys] = useState(true);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const diffKg = lines.reduce((s, l) => s + (lineResult(l).diffKg || 0), 0);
  const go = async () => {
    if (!assignees.length) return setErr('Chọn thủ kho đi đếm lại.');
    setBusy(true); setErr('');
    try {
      const id = await createRecount(lines, { assignees, date, blind: !showSys, note: note.trim() }, { email, name });
      onClose(id);
    } catch (e) { setErr(e.code === 'permission-denied' ? 'Bạn không có quyền lập lệnh đếm lại cho kho này.' : e.message); setBusy(false); }
  };
  return (
    <Modal title={`🔁 Tạo lệnh đếm lại ${lines.length} dòng lệch`} onClose={() => onClose('')}>
      <p className="small">
        Kho: <b>{whs.map(whLabel).join(', ')}</b> · {new Set(lines.map((l) => l.location)).size} vị trí · tổng lệch lần trước {fmtNum(diffKg, 3)} kg.
        Số hệ thống được chụp lại theo tồn <b>hiện tại</b>; thủ kho thấy cả số đếm lần trước để đối chiếu.
      </p>
      <div className="form-grid">
        <Field label="Thủ kho đi đếm" required><KeeperPick whs={whs} value={assignees} onChange={setAssignees} /></Field>
        <Field label="Ngày đếm lại" required><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Số hệ thống">
          <label className="small"><input type="checkbox" checked={showSys} onChange={(e) => setShowSys(e.target.checked)} /> Thủ kho thấy SL hệ thống khi đếm</label>
        </Field>
        <Field label="Ghi chú" full><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vd. đếm kỹ lại từng bao" /></Field>
      </div>
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="btn" onClick={() => onClose('')}>Đóng</button>
        <button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Đang tạo…' : 'Tạo lệnh đếm lại'}</button>
      </div>
    </Modal>
  );
}
