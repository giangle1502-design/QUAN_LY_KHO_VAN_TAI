import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { catalogByKey, refValue } from '../catalogs';
import { applyComputed, cleanValue, defaultsOf } from '../lib/fields';
import FieldInput, { displayValue } from './FieldInput';
import { AddFieldButton } from './FormTools';
import { Field } from './ui';

// Trường bổ sung của biểu mẫu nghiệp vụ (phiếu kho, chuyến xe, dự kiến xuất…):
// người thiết kế biểu mẫu bấm "+ Thêm trường" ngay trên form, giá trị lưu thẳng vào bản ghi (khóa c_…).
//   const ex = useExtraFields('mvOut', recordĐangSửa);
//   <ExtraFields ex={ex} />             → ô nhập + nút "+ Thêm trường", "✎ Sửa trường"
//   ex.missing()                        → tên trường bắt buộc còn trống ('' nếu đủ)
//   { ...payload, ...ex.values() }      → giá trị đã chuẩn hóa để lưu
export function useExtraFields(formKey, init) {
  const { fieldsOf } = useApp();
  const fields = useMemo(() => fieldsOf(formKey).filter((f) => !f.hidden), [fieldsOf, formKey]);
  const [extra, setExtra] = useState(() => (init ? Object.fromEntries(Object.entries(init).filter(([k]) => k.startsWith('c_'))) : {}));
  // Mặc định (vd. ngày = hôm nay) điền khi tạo mới, kể cả khi cấu hình trường tải xong sau form
  useEffect(() => {
    if (init) return;
    const d = defaultsOf(fields);
    if (Object.keys(d).some((k) => extra[k] === undefined)) setExtra((x) => ({ ...d, ...x }));
  }, [fields]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = applyComputed(fields, extra);
  return {
    formKey, fields, extra, setExtra, data,
    missing: () => fields.filter((f) => f.required && f.type !== 'formula' && (extra[f.key] === '' || extra[f.key] == null)).map((f) => f.label).join(', '),
    values: () => Object.fromEntries(fields.map((f) => [f.key, f.type === 'formula' ? cleanValue(f, data[f.key]) : cleanValue(f, extra[f.key])])),
    reset: () => setExtra({ ...defaultsOf(fields) }),
  };
}

// title: tiêu đề nhóm; inline: chỉ các ô (đặt trong form-grid sẵn có), nút thêm trường đặt ở tiêu đề form
export function ExtraFields({ ex, title = 'Thông tin bổ sung', disabled, unit }) {
  const { canDesign } = useApp();
  if (!ex.fields.length && !canDesign) return null;
  const set = (k, v) => ex.setExtra((x) => ({ ...x, [k]: v }));
  // Trường liên kết: chọn bản ghi ở ô danh mục thì tự điền các trường lấy giá trị từ bản ghi đó
  const onPick = (f, row) => {
    const linked = ex.fields.filter((x) => x.link?.via === f.key);
    if (!linked.length || !row) return;
    ex.setExtra((x) => ({ ...x, [f.key]: refValue(f.ref, row) ?? x[f.key], ...Object.fromEntries(linked.map((l) => [l.key, row[l.link.field] ?? ''])) }));
  };
  const vias = ex.fields.filter((f) => f.type === 'ref' && catalogByKey(f.ref)).map((f) => ({ key: f.key, label: f.label, ref: f.ref }));
  return (
    <div className="extra-fields" style={{ marginTop: 8 }}>
      <div className="section-head"><span className="grow">{title}</span><AddFieldButton formKey={ex.formKey} vias={vias} /></div>
      {ex.fields.length ? (
        <div className="form-grid">
          {ex.fields.map((f) => (
            <Field key={f.key} label={f.label} required={f.required && f.type !== 'formula'} help={f.help} full={f.type === 'multiref' || (f.type === 'textarea' && !f.width)} size={f}>
              <FieldInput field={f} value={f.type === 'formula' ? ex.data[f.key] : ex.extra[f.key]} onChange={(v) => set(f.key, v)} disabled={disabled} onPickRef={onPick} unit={unit} />
            </Field>
          ))}
        </div>
      ) : <p className="small" style={{ margin: '2px 0 6px' }}>Chưa có trường bổ sung. Bấm “+ Thêm trường” để thêm (vd. Số container, Số seal, Người duyệt…).</p>}
    </div>
  );
}

// Xem giá trị trường bổ sung của bản ghi đã lưu (chi tiết phiếu, chuyến…)
export function ExtraView({ formKey, rec }) {
  const { fieldsOf } = useApp();
  if (!formKey || !catalogByKey(formKey)) return null;
  const shown = fieldsOf(formKey).filter((f) => !f.hidden && rec?.[f.key] !== undefined && rec[f.key] !== '' && rec[f.key] !== null && !(Array.isArray(rec[f.key]) && !rec[f.key].length));
  if (!shown.length) return null;
  return (
    <div className="small" style={{ margin: '4px 0' }}>
      {shown.map((f) => <span key={f.key} style={{ marginRight: 14 }}>{f.label}: <b>{f.type === 'checkbox' ? (rec[f.key] ? '✓' : '—') : Array.isArray(rec[f.key]) ? rec[f.key].join(', ') : String(displayValue(f, rec[f.key]))}</b></span>)}
    </div>
  );
}
