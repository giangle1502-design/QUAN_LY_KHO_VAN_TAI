import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useCollection } from '../../lib/hooks';
import { ROLES, roleLabel } from '../../catalogs';
import { EVENTS, VARS, fillText, ruleOf, saveChatRules, sysNotify, useChatRules, useGroups } from '../../lib/chat';
import { ErrorBox } from '../../components/ui';
import { MultiPick } from '../Chat';

// Quản trị: mỗi loại công việc (lập SO, dự kiến xuất / DO, phiếu xuất, chuyển pháp nhân…) gửi tin nhắn hệ thống cho ai
const SAMPLE = { id: 'SO000123', orderId: 'SO000123', partyName: 'Công ty ABC', warehouse: 'KBD', date: '2026-10-15', company: 'VAP', from: 'PLA',
  pledgee: 'VCB', lines: [{ item: 'PP-1102K', kg: 25000 }, { item: 'HDPE-7000F', kg: 12500 }] };

export default function ChatRules() {
  const { email, name } = useApp();
  const { rules, loading } = useChatRules();
  const { rows: users } = useCollection('users');
  const groups = useGroups(true);
  const [ev, setEv] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState('');
  useEffect(() => {
    if (loading || ev) return;
    setEv(Object.fromEntries(EVENTS.map((e) => [e.key, ruleOf(rules, e.key)])));
  }, [loading, rules]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ev) return <div className="card">Đang tải…</div>;

  const set = (k, patch) => { setEv({ ...ev, [k]: { ...ev[k], ...patch } }); setMsg(''); };
  const userOpts = users.filter((u) => u.active !== false).map((u) => ({ value: u._id, label: u.name || u._id, sub: `${roleLabel(u.role)} · ${u._id}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const groupOpts = groups.map((g) => ({ value: g.id, label: g.name, sub: `${g.members.length} người` }));
  const roleOpts = ROLES.map(([v, l]) => ({ value: v, label: l }));
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { await saveChatRules(ev, { email, name }); setMsg('Đã lưu cấu hình. Tin nhắn hệ thống gửi theo cấu hình mới từ bây giờ.'); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const test = async (k) => {
    setErr(''); setMsg('');
    try {
      const nSent = await sysNotify(k, { ...SAMPLE, sales: email }, { email, name }, { rules: ev, test: true });
      setMsg(nSent ? `Đã gửi thử "${EVENTS.find((e) => e.key === k).label}" tới ${nSent} nơi nhận. Xem ở 💬 Trò chuyện.` : 'Chưa chọn người nhận nào.');
    } catch (e) { setErr(e.message); }
  };
  const who = (r) => [
    r.all && 'Tất cả mọi người',
    ...(r.roles || []).map((x) => `vai trò ${roleLabel(x)}`),
    ...(r.groups || []).map((g) => `nhóm ${groups.find((x) => x.id === g)?.name || g}`),
    ...(r.users || []).map((u) => users.find((x) => x._id === u)?.name || u),
    r.sales && 'sale phụ trách đơn', r.keepers && 'thủ kho của kho',
  ].filter(Boolean);

  return (
    <div>
      <div className="page-head">
        <h1>💬 Cấu hình tin nhắn hệ thống</h1>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : '💾 Lưu cấu hình'}</button>
      </div>
      <p className="hint">
        Mỗi khi có người làm công việc bên dưới, hệ thống tự gửi tin vào <Link to="/tro-chuyen">💬 Trò chuyện</Link>:
        <b> Tất cả</b> → kênh “📢 Thông báo chung”; <b>Nhóm</b> → tin vào nhóm trò chuyện đó; <b>Vai trò / người / sale phụ trách / thủ kho</b> → hộp “🔔 Thông báo hệ thống” riêng của từng người.
        Người làm việc đó không nhận lại tin của chính mình. Nhóm tạo ở trang Trò chuyện (nút + Nhóm).
      </p>
      <ErrorBox error={err} />
      {msg && <div className="ok-box">{msg}</div>}
      <div className="rules-list">
        {EVENTS.map((e) => {
          const r = ev[e.key];
          const isOpen = open === e.key;
          const w = who(r);
          return (
            <div key={e.key} className={'card rule-card' + (r.on ? ' on' : '')}>
              <div className="rule-head">
                <label className="rule-on"><input type="checkbox" checked={r.on} onChange={(x) => set(e.key, { on: x.target.checked })} /> <b>{e.icon} {e.label}</b></label>
                <span className="small rule-who">{r.on ? (w.length ? `→ ${w.join(', ')}` : '⚠ Chưa chọn người nhận') : 'Tắt'}</span>
                <button type="button" className="btn sm" onClick={() => setOpen(isOpen ? '' : e.key)}>{isOpen ? 'Thu gọn ▴' : 'Người nhận, nội dung ▾'}</button>
              </div>
              {isOpen && (
                <div className="rule-body">
                  <div className="rule-cols">
                    <div>
                      <div className="rule-label">Gửi chung</div>
                      <label className="rule-chk"><input type="checkbox" checked={r.all} onChange={(x) => set(e.key, { all: x.target.checked })} /> 📢 Tất cả mọi người (kênh Thông báo chung)</label>
                      <label className="rule-chk"><input type="checkbox" checked={r.sales} onChange={(x) => set(e.key, { sales: x.target.checked })} /> Sale phụ trách đơn</label>
                      <label className="rule-chk"><input type="checkbox" checked={r.keepers} onChange={(x) => set(e.key, { keepers: x.target.checked })} /> Thủ kho của kho liên quan</label>
                      <div className="rule-label">Theo vai trò</div>
                      <MultiPick options={roleOpts} value={r.roles} onChange={(roles) => set(e.key, { roles })} />
                    </div>
                    <div>
                      <div className="rule-label">Nhóm trò chuyện</div>
                      {groupOpts.length ? <MultiPick options={groupOpts} value={r.groups} onChange={(gs) => set(e.key, { groups: gs })} placeholder="Tìm nhóm…" />
                        : <div className="small">Chưa có nhóm. Tạo nhóm ở <Link to="/tro-chuyen">Trò chuyện</Link> → + Nhóm.</div>}
                    </div>
                    <div>
                      <div className="rule-label">Người cụ thể</div>
                      <MultiPick options={userOpts} value={r.users} onChange={(us) => set(e.key, { users: us })} placeholder="Tìm người…" />
                    </div>
                  </div>
                  <label className="field full" style={{ marginTop: 10 }}><span>Nội dung tin (để trống = mẫu mặc định)</span>
                    <textarea rows={2} value={r.text} placeholder={e.text} onChange={(x) => set(e.key, { text: x.target.value })} /></label>
                  <div className="small">Biến: {VARS.map(([k, l]) => <code key={k} title={l} className="rule-var" onClick={() => set(e.key, { text: `${r.text || e.text} {${k}}` })}>{`{${k}}`}</code>)}</div>
                  <div className="rule-preview"><span className="small">Xem trước:</span> {fillText(r.text || e.text, { ...SAMPLE, by: name })}</div>
                  <button type="button" className="btn sm" onClick={() => test(e.key)}>🧪 Gửi thử</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="hint">Chưa gửi ra Zalo / email: tin chỉ hiện trong app (nút 💬 trên đầu trang có số tin chưa đọc và thông báo nhỏ khi có tin mới).</p>
    </div>
  );
}
