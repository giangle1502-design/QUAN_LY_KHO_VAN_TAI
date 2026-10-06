import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getCountFromServer, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useApp } from '../context/AppContext';
import { CATALOGS, GROUPS, ROLES, roleLabel } from '../catalogs';

export default function Home() {
  const { name, role, isAdmin, settings } = useApp();
  const [co, setCo] = useState(null);
  const [saved, setSaved] = useState('');
  const [counts, setCounts] = useState({});
  const cats = CATALOGS.filter((c) => isAdmin || !c.adminOnly);

  useEffect(() => {
    cats.forEach((c) =>
      getCountFromServer(collection(db, c.key))
        .then((s) => setCounts((p) => ({ ...p, [c.key]: s.data().count })))
        .catch(() => {})
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  return (
    <div>
      <div className="page-head">
        <h1>Thiết lập danh mục</h1>
        <span className="small">Xin chào {name} · {roleLabel(role)}</span>
      </div>
      <p className="hint">Bước 1 của hệ thống: khai báo danh mục dùng chung. Các bước nhập kho, xuất kho và luồng xe vận tải sẽ chọn dữ liệu từ đây.</p>
      {GROUPS.map((g) => {
        const list = cats.filter((c) => c.group === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <div className="section-title">{g}</div>
            <div className="cards">
              {list.map((c) => (
                <Link key={c.key} to={`/dm/${c.key}`} className="cat-card">
                  <span>{c.icon} {c.title}</span>
                  <span className="n">{counts[c.key] ?? '…'}</span>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
      {isAdmin && (
        <>
          <div className="section-title">Thông tin công ty (hiện trên phiếu in)</div>
          <div className="card inline-add" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <input placeholder="Tên công ty" value={co?.companyName ?? settings.companyName ?? ''} onChange={(e) => setCo({ ...(co || settings), companyName: e.target.value })} />
            <input placeholder="Địa chỉ" value={co?.companyAddress ?? settings.companyAddress ?? ''} onChange={(e) => setCo({ ...(co || settings), companyAddress: e.target.value })} />
            <button className="btn primary" disabled={!co} onClick={async () => {
              await setDoc(doc(db, 'settings', 'general'), { companyName: co.companyName || '', companyAddress: co.companyAddress || '' }, { merge: true });
              setCo(null); setSaved('Đã lưu.');
            }}>Lưu</button>
            {saved && <span className="small">{saved}</span>}
          </div>
          <div className="section-title">Vai trò</div>
          <div className="table-wrap">
            <table>
              <tbody>
                {ROLES.map(([k, l, d]) => <tr key={k}><td><b>{l}</b></td><td>{d}</td></tr>)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
