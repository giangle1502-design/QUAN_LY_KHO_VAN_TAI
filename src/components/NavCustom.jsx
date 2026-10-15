import { useMemo, useState } from 'react';
import { usePref } from '../lib/prefs';
import { Modal } from './ui';

// ============================================================================
// Menu tự sắp xếp theo từng người dùng (lưu trên trình duyệt, không đọc / ghi Firestore):
// ⭐ Yêu thích (lối tắt lên đầu menu), thư mục tự tạo, đổi tên / thứ tự nhóm, chuyển mục sang nhóm khác, ẩn mục.
// ============================================================================

const EMPTY = { fav: [], folders: [], place: {}, secOrder: [], itemOrder: {}, hidden: [], titles: {} };
export const FAV_KEY = 'fav';
export const itemId = (x) => x.to;

const byOrder = (order) => (a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9);

// sections: [{ key, title, items: [{ to, ico, label, … }] }] (đã lọc theo quyền)
// → các nhóm đã sắp theo ý người dùng + các hàm sửa
// defaultFav: các mục yêu thích khi người dùng chưa tự chọn (chưa từng bấm ☆)
export function useNavLayout(sections, defaultFav = []) {
  const [raw, setRaw] = usePref('nav-layout', null);
  const lay = { ...EMPTY, ...(raw || {}), fav: raw?.fav ?? defaultFav };
  const set = (patch) => setRaw({ ...lay, ...patch });

  const view = useMemo(() => {
    const all = new Map();
    for (const s of sections) for (const x of s.items) if (!all.has(itemId(x))) all.set(itemId(x), { ...x, home: s.key });
    const secs = [
      ...sections.map((s) => ({ key: s.key, title: lay.titles[s.key] || s.title, defTitle: s.title, folder: false })),
      ...lay.folders.map((f) => ({ key: f.key, title: f.title, folder: true })),
    ];
    const keys = new Set(secs.map((s) => s.key));
    const where = (id) => (keys.has(lay.place[id]) ? lay.place[id] : all.get(id).home);
    const defaultIdx = [...all.keys()];
    for (const s of secs) {
      const ids = defaultIdx.filter((id) => where(id) === s.key);
      const ord = lay.itemOrder[s.key] || [];
      ids.sort((a, b) => byOrder(ord)(a, b) || defaultIdx.indexOf(a) - defaultIdx.indexOf(b));
      s.allItems = ids.map((id) => ({ ...all.get(id), hidden: lay.hidden.includes(id), fav: lay.fav.includes(id) }));
      s.items = s.allItems.filter((x) => !x.hidden);
    }
    const defOrder = secs.map((s) => s.key);
    secs.sort((a, b) => byOrder(lay.secOrder)(a.key, b.key) || defOrder.indexOf(a.key) - defOrder.indexOf(b.key));
    const fav = lay.fav.filter((id) => all.has(id)).map((id) => ({ ...all.get(id), fav: true }));
    return { secs, fav, all };
  }, [sections, raw, defaultFav.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const api = {
    toggleFav: (id) => set({ fav: lay.fav.includes(id) ? lay.fav.filter((x) => x !== id) : [...lay.fav, id] }),
    moveFav: (id, d) => {
      const f = view.fav.map(itemId);
      const i = f.indexOf(id);
      if (i < 0 || i + d < 0 || i + d >= f.length) return;
      [f[i], f[i + d]] = [f[i + d], f[i]];
      set({ fav: f });
    },
    moveSec: (key, d) => {
      const ks = view.secs.map((s) => s.key);
      const i = ks.indexOf(key);
      if (i + d < 0 || i + d >= ks.length) return;
      [ks[i], ks[i + d]] = [ks[i + d], ks[i]];
      set({ secOrder: ks });
    },
    moveItem: (secKey, id, d) => {
      const s = view.secs.find((x) => x.key === secKey);
      const ids = s.allItems.map(itemId);
      const i = ids.indexOf(id);
      if (i + d < 0 || i + d >= ids.length) return;
      [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
      set({ itemOrder: { ...lay.itemOrder, [secKey]: ids } });
    },
    placeItem: (id, secKey) => {
      const home = view.all.get(id)?.home;
      const place = { ...lay.place };
      if (secKey === home) delete place[id]; else place[id] = secKey;
      set({ place });
    },
    toggleHidden: (id) => set({ hidden: lay.hidden.includes(id) ? lay.hidden.filter((x) => x !== id) : [...lay.hidden, id] }),
    rename: (key, title) => {
      if (key.startsWith('f:')) return set({ folders: lay.folders.map((f) => (f.key === key ? { ...f, title } : f)) });
      const titles = { ...lay.titles };
      if (title.trim()) titles[key] = title; else delete titles[key];
      set({ titles });
    },
    addFolder: (title) => {
      const key = `f:${Date.now().toString(36)}`;
      set({ folders: [...lay.folders, { key, title: title.trim() || '📁 Thư mục mới' }], secOrder: [key, ...view.secs.map((s) => s.key)] });
      return key;
    },
    removeFolder: (key) => {
      const place = Object.fromEntries(Object.entries(lay.place).filter(([, v]) => v !== key));
      set({ folders: lay.folders.filter((f) => f.key !== key), place, secOrder: lay.secOrder.filter((k) => k !== key) });
    },
    reset: () => setRaw(null),
    changed: raw !== null,
  };
  return [view, api];
}

// Hộp thoại Tùy chỉnh menu
export function MenuEditor({ view, api, multi, setMulti, onClose }) {
  const [name, setName] = useState('');
  const [onlyFolder, setOnlyFolder] = useState('');
  const targets = view.secs.map((s) => ({ key: s.key, title: s.title }));
  const addFolder = () => { const k = api.addFolder(name ? `📁 ${name.replace(/^📁\s*/, '')}` : ''); setName(''); setOnlyFolder(k); };
  return (
    <Modal title="⚙ Tùy chỉnh menu của tôi" onClose={onClose} wide>
      <p className="small" style={{ marginTop: 0 }}>Sắp xếp menu theo cách bạn làm việc: bấm ☆ để ghim mục lên <b>⭐ Yêu thích</b>, tạo thư mục rồi chọn “Chuyển vào” để gom các mục hay dùng (VD: SO, DO, PO, STO), ▲▼ để đổi thứ tự, 👁 để ẩn mục không dùng. Chỉ áp dụng cho tài khoản của bạn trên trình duyệt này.</p>
      <label className="nav-mode">
        <input type="checkbox" checked={!multi} onChange={(e) => setMulti(!e.target.checked)} />
        <span><b>Menu gọn (vừa màn hình)</b> — mỗi lúc chỉ mở 1 nhóm, bấm nhóm khác thì nhóm cũ tự đóng; tự mở nhóm của trang đang xem. Bỏ chọn để mở nhiều nhóm cùng lúc.</span>
      </label>
      <div className="filters">
        <input placeholder="Tên thư mục mới, VD: Việc hằng ngày" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addFolder()} />
        <button type="button" className="btn primary" onClick={addFolder}>📁 + Thư mục mới</button>
        <div className="actions" style={{ marginLeft: 'auto' }}>
          {api.changed && <button type="button" className="btn" onClick={() => window.confirm('Đưa menu về như mặc định (bỏ yêu thích, thư mục, thứ tự, mục ẩn)?') && api.reset()}>↺ Khôi phục mặc định</button>}
          <button type="button" className="btn" onClick={onClose}>Xong</button>
        </div>
      </div>
      <div className="nav-edit">
        <div className="nav-edit-sec fav">
          <div className="nav-edit-head"><b>⭐ Yêu thích</b><span className="small">{view.fav.length ? 'luôn ở đầu menu' : 'chưa có — bấm ☆ ở mục bất kỳ'}</span></div>
          {view.fav.map((x, i) => (
            <div key={itemId(x)} className="nav-edit-item">
              <span className="nav-edit-btns"><button type="button" className="btn ghost sm" disabled={!i} onClick={() => api.moveFav(itemId(x), -1)}>▲</button><button type="button" className="btn ghost sm" disabled={i === view.fav.length - 1} onClick={() => api.moveFav(itemId(x), 1)}>▼</button></span>
              <span className="grow">{x.ico} {x.label}</span>
              <button type="button" className="btn ghost sm" title="Bỏ khỏi yêu thích" onClick={() => api.toggleFav(itemId(x))}>★ Bỏ</button>
            </div>
          ))}
        </div>
        {view.secs.map((s, si) => (
          <div key={s.key} className={'nav-edit-sec' + (s.folder ? ' folder' : '') + (onlyFolder === s.key ? ' hl' : '')}>
            <div className="nav-edit-head">
              <span className="nav-edit-btns"><button type="button" className="btn ghost sm" disabled={!si} onClick={() => api.moveSec(s.key, -1)} title="Đưa nhóm lên">▲</button><button type="button" className="btn ghost sm" disabled={si === view.secs.length - 1} onClick={() => api.moveSec(s.key, 1)} title="Đưa nhóm xuống">▼</button></span>
              <input className="grow" value={s.title} placeholder={s.defTitle} onChange={(e) => api.rename(s.key, e.target.value)} title="Đổi tên nhóm" />
              <span className="small nowrap">{s.items.length} mục{s.allItems.length > s.items.length ? ` · ${s.allItems.length - s.items.length} ẩn` : ''}</span>
              {s.folder && <button type="button" className="btn ghost sm" title="Xóa thư mục (các mục trở về nhóm gốc)" onClick={() => api.removeFolder(s.key)}>🗑</button>}
            </div>
            {!s.allItems.length && <div className="small" style={{ padding: '4px 8px' }}>Thư mục trống — ở các nhóm bên dưới, chọn “Chuyển vào” → {s.title}.</div>}
            {s.allItems.map((x, i) => (
              <div key={itemId(x)} className={'nav-edit-item' + (x.hidden ? ' off' : '')}>
                <span className="nav-edit-btns"><button type="button" className="btn ghost sm" disabled={!i} onClick={() => api.moveItem(s.key, itemId(x), -1)}>▲</button><button type="button" className="btn ghost sm" disabled={i === s.allItems.length - 1} onClick={() => api.moveItem(s.key, itemId(x), 1)}>▼</button></span>
                <button type="button" className="btn ghost sm star" title={x.fav ? 'Bỏ khỏi yêu thích' : 'Ghim vào Yêu thích'} onClick={() => api.toggleFav(itemId(x))}>{x.fav ? '★' : '☆'}</button>
                <span className="grow">{x.ico} {x.label}</span>
                <select value={s.key} onChange={(e) => api.placeItem(itemId(x), e.target.value)} title="Chuyển mục này sang nhóm / thư mục khác">
                  {targets.map((tg) => <option key={tg.key} value={tg.key}>{tg.key === s.key ? `Ở: ${tg.title}` : `Chuyển vào: ${tg.title}`}</option>)}
                </select>
                <button type="button" className="btn ghost sm" title={x.hidden ? 'Hiện lại trên menu' : 'Ẩn khỏi menu'} onClick={() => api.toggleHidden(itemId(x))}>{x.hidden ? '🙈 Hiện lại' : '👁'}</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
