// Hiển thị trang in theo mẫu tự thiết kế + ô chọn mẫu trên thanh công cụ các trang in
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { DOC_TYPES, pageCss, pickTemplate, renderBody } from '../lib/printTemplates';
import { usePrintTemplates } from '../lib/printData';
import Select from './Select';

// Các trang (hoặc các nhãn) của 1 phiếu theo mẫu
export function TemplateSheets({ tpl, data, preview = false, max = 0 }) {
  const { fieldsOf } = useApp();
  const pages = useMemo(() => {
    if (!tpl || !data) return [];
    const now = data.now || new Date();
    if (DOC_TYPES[tpl.docType]?.perLabel) {
      const lbs = max ? (data.labels || []).slice(0, max) : data.labels || [];
      return lbs.map((line) => renderBody(tpl, { ...data, docType: tpl.docType, now, line }, fieldsOf, { preview }));
    }
    return [renderBody(tpl, { ...data, docType: tpl.docType, now }, fieldsOf, { preview })];
  }, [tpl, data, fieldsOf, preview, max]);
  const label = DOC_TYPES[tpl?.docType]?.perLabel;
  return (
    <>
      <style>{pageCss(tpl || {})}</style>
      {pages.map((html, i) => <div key={i} className={'tpl-sheet' + (label ? ' tpl-label' : '')} dangerouslySetInnerHTML={{ __html: html }} />)}
      {!pages.length && <p className="small" style={{ textAlign: 'center' }}>Không có gì để in.</p>}
    </>
  );
}

// Chọn mẫu: tự động theo công ty chủ hàng / khách hàng, hoặc chọn tay (Mẫu gốc = bản in có sẵn của hệ thống)
export function useTemplateChoice(docType, { company = '', party = '' } = {}) {
  const { canDesign } = useApp();
  const list = usePrintTemplates();
  const [sel, setSel] = useState(() => new URLSearchParams(window.location.search).get('mau') ?? undefined);
  const mine = (list || []).filter((t) => t.docType === docType && t.active !== false);
  const auto = docType && list ? pickTemplate(list, docType, { company, party }) : null;
  const tpl = sel === undefined ? auto : sel ? (list || []).find((t) => t.id === sel) || null : null;
  const select = docType && (mine.length > 0 || canDesign) ? (
    <span className="tpl-choice">
      <label className="small">Mẫu in{' '}
        <Select value={sel === undefined ? '__auto' : sel} onChange={(e) => setSel(e.target.value === '__auto' ? undefined : e.target.value)}>
          <option value="__auto">Tự động: {auto ? auto.name : 'Mẫu gốc'}</option>
          <option value="">Mẫu gốc của hệ thống</option>
          {mine.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </label>
      {canDesign && <Link className="btn ghost" to={tpl ? `/mau-in/${tpl.id}` : `/mau-in?loai=${docType}`}>✎ {tpl ? 'Sửa mẫu' : 'Thiết kế mẫu'}</Link>}
    </span>
  ) : null;
  return { list, tpl, select, loading: list === null };
}

// Trang in theo mẫu: nạp dữ liệu phiếu rồi hiển thị
export function TemplatePage({ tpl, load, map, toolbar, deps = [] }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setData(null);
    load().then((d) => live && setData(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return (
    <div className="tpl-screen">
      <div className="no-print toolbar label-toolbar">{toolbar}</div>
      {err && <div className="error-box">{err}</div>}
      {data ? <div className="tpl-pages"><TemplateSheets tpl={tpl} data={map ? map(data) : data} /></div> : !err && <div className="center">Đang tải…</div>}
    </div>
  );
}
