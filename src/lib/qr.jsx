import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

// Mã QR trên phiếu giao hàng / phiếu nhập kho / phiếu giao gộp: bảo vệ quét để xác nhận xe ra cổng.
// Nội dung: KVT-<số phiếu>-<số chuyến> (chỉ chữ, số, gạch nối để máy quét gõ đúng ở mọi bàn phím)
export const slipQrText = (id, tripId = '') => ['KVT', id, tripId].filter(Boolean).join('-');
export const qrDataUrl = (text) => QRCode.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
// Tách các mã trong chuỗi quét (KVT-PX000123-GRP00011, link, hay gõ tay số phiếu / số chuyến)
export function parseScan(raw) {
  return [...new Set(String(raw || '').toUpperCase().split(/[^A-Z0-9]+/).filter((x) => x && x !== 'KVT' && /\d/.test(x)))];
}

export function useQr(text) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    if (!text) { setUrl(''); return undefined; }
    qrDataUrl(text).then((u) => live && setUrl(u)).catch(() => {});
    return () => { live = false; };
  }, [text]);
  return url;
}

// Ô QR in trên phiếu (kèm chữ nhỏ dưới mã để đọc tay khi không quét được)
export function SlipQr({ id, tripId, size = 22 }) {
  const text = slipQrText(id, tripId);
  const url = useQr(id ? text : '');
  if (!url) return null;
  return (
    <div className="slip-qr" style={{ width: `${size}mm` }}>
      <img src={url} alt={text} style={{ width: `${size}mm`, height: `${size}mm` }} />
      <div className="slip-qr-text">{id}</div>
    </div>
  );
}

// ---- QR chuyến xe trên điện thoại tài xế: tự đổi mỗi 30 giây, bảo vệ quét để đăng ký / cho ra cổng ----
// Nội dung KVT-T-<số chuyến>-<khung giờ>-<mã kiểm tra>; mã kiểm tra tính từ chuyến + khung giờ,
// ảnh chụp màn hình cũ quá ~1 phút là hết hạn.
const SLOT_MS = 30000;
const slotNow = () => Math.floor(Date.now() / SLOT_MS);
async function tripSig(t, slot) {
  const data = new TextEncoder().encode(`${t.id}|${slot}|${t.createdAt || ''}|kvt`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...h.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
export async function tripQrText(t, slot = slotNow()) { return `KVT-T-${t.id}-${slot}-${await tripSig(t, slot)}`; }
export function parseTripQr(raw) {
  const m = String(raw || '').toUpperCase().match(/KVT-T-([A-Z0-9]+)-(\d+)-([0-9A-F]{8})/);
  return m ? { id: m[1], slot: Number(m[2]), sig: m[3] } : null;
}
// 'ok' | 'expired' | 'bad'
export async function verifyTripQr(p, t) {
  if (Math.abs(slotNow() - p.slot) > 2) return 'expired';
  return (await tripSig(t, p.slot)) === p.sig ? 'ok' : 'bad';
}

// Nút + màn hình QR cho tài xế (link tài xế, trang Tài xế)
export function TripQrButton({ trip, style }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" style={{ width: '100%', padding: 12, fontSize: 16, marginTop: 6, ...style }} onClick={() => setOpen(true)}>🔳 Hiện mã QR cho bảo vệ</button>
      {open && <TripQrScreen trip={trip} onClose={() => setOpen(false)} />}
    </>
  );
}
function TripQrScreen({ trip, onClose }) {
  const [url, setUrl] = useState('');
  const [left, setLeft] = useState(30);
  useEffect(() => {
    let live = true; let last = -1;
    const tick = async () => {
      const s = slotNow();
      setLeft(Math.ceil(((s + 1) * SLOT_MS - Date.now()) / 1000));
      if (s !== last) { last = s; const u = await qrDataUrl(await tripQrText(trip, s)); if (live) setUrl(u); }
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => { live = false; clearInterval(iv); };
  }, [trip]);
  return (
    <div className="trip-qr-screen" onClick={onClose}>
      <div className="trip-qr-box" onClick={(e) => e.stopPropagation()}>
        <div className="trip-qr-plate">{trip.plate || trip.id}</div>
        {url ? <img src={url} alt="QR chuyến" /> : <div style={{ padding: 60 }}>Đang tạo mã…</div>}
        <div>Chuyến <b>{trip.id}</b> · mã đổi sau {left}s</div>
        <div className="small">Đưa màn hình này cho bảo vệ quét. Tăng độ sáng màn hình nếu khó quét.</div>
        <button className="btn primary" style={{ width: '100%', padding: 12, marginTop: 10 }} onClick={onClose}>Đóng</button>
      </div>
    </div>
  );
}
