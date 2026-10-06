# Hệ thống quản lý kho & vận tải

- Bước 1: **Thiết lập danh mục** dùng chung cho kho và vận tải.
- Bước 2: **Luồng xe vận tải** như app QLVT, chọn xe, tài xế, khách từ danh mục.
- Bước tiếp theo: nhập kho, xuất kho, tồn theo vị trí, lô và tình trạng thế chấp.

**Công nghệ:** React + Vite · Firebase (Auth + Firestore, realtime) · Vercel. Giống app Sale_control: đăng nhập thật, mỗi danh mục là một collection riêng, phân quyền kiểm tra cả trên máy chủ (Firestore rules).

## Danh mục

| Nhóm | Danh mục | Mã bản ghi (khóa) | Ghi chú |
|---|---|---|---|
| Khách hàng | Soldto | Mã khách hàng | Nên trùng mã Ecount |
| | Shipto | Mã giao hàng | Chọn Mã KH từ Soldto → tự điền Tên KH, MST |
| Hàng hóa | Mã hàng | Mã hàng | Tự tính Số bao/pallet, Trọng lượng pallet = bao/lớp × lớp/pallet × kg/bao |
| | Tình trạng hàng hóa | Mã | Mặc định KTC, HTC, DGC. HTC bỏ tích "Được xuất kho" → khóa xuất cho tới khi DGC |
| | Bên nhận thế chấp | Mã | Ngân hàng, số hợp đồng, hiệu lực |
| | Nhà cung cấp | Mã NCC | |
| Kho | Danh sách kho | Mã kho | "Có bảo vệ": kho không bảo vệ sẽ bỏ qua bước cổng trong luồng xe |
| | Vị trí lưu trữ | Kho + Vị trí | Tồn hiện tại do hệ thống cập nhật; % lưu trữ và Empty bin tự tính; có Khóa vị trí |
| | Cửa xuất/nhập (dock) | Kho + Mã cửa | |
| | Lý do | Mã lý do | Điều chỉnh tồn, trả hàng, hàng lỗi, hủy chuyến |
| Vận tải | Đơn vị vận tải, Xe, Tài xế | Mã / Biển số / CCCD | Đăng ký cổng sẽ chọn từ đây, không gõ lại |
| | Danh sách 3-PL | Mã 3-PL | |
| Hệ thống | Quy tắc mã tự sinh | Loại chứng từ | PN, PX, GRP, SP, KH, LOT |
| | Phân quyền | Email | Vai trò + kho được thao tác |

Mỗi danh mục có: STT, tìm kiếm, thêm/sửa, xuất Excel, **nhập Excel** (dòng trùng mã sẽ cập nhật), File mẫu. Không xóa được bản ghi đang được danh mục khác dùng.

**Quản lý hạng mục** (chỉ quản trị): với mọi danh mục, đổi tên trường, sắp xếp, ẩn, bắt buộc, sửa danh sách chọn và **thêm trường mới** (chữ, đoạn văn, số, ngày, có/không, danh sách chọn, email). Trường mới tự hiện trong form, bảng và Excel.

## Luồng xe vận tải

Xe đến kho → Chờ vào cửa → Đang xuất/nhập → Chờ ra cổng → Chờ giao hàng → Hoàn thành

| Màn hình | Ai dùng | Làm gì |
|---|---|---|
| Đăng ký xe | Bảo vệ, Thủ kho, Quản trị | Chọn kho, mục đích, biển số (tự điền đơn vị vận tải), CCCD (tự điền tài xế), 1–10 khách hàng kèm Shipto, hoặc nhà cung cấp nếu xe nhập hàng. Cấp mã chuyến GRP và mã lô SP theo Quy tắc mã tự sinh |
| Bảo vệ cổng | Bảo vệ | Cho vào cổng, cho ra cổng |
| Thủ kho điều phối | Thủ kho | Chọn cửa (dock) của kho, chỉ hiện cửa đúng loại nhập/xuất và báo cửa đang có xe; bấm Xuất/nhập xong |
| Xác nhận giao hàng | Quản trị | Xác nhận giao từng khách hoặc tất cả |
| Tổng quan chuyến xe | Mọi người | Lọc theo ngày, kho, trạng thái; thời gian chờ vào cửa và thời gian xuất/nhập; xuất Excel từng lô; xem lịch sử thao tác; quản trị sửa, hủy (chọn lý do), xóa |

- **Kho không có bảo vệ**: xe vào thẳng Chờ vào cửa và bỏ bước Chờ ra cổng.
- **Xe nhập hàng**: hoàn thành khi ra cổng, không có bước giao hàng.
- Mỗi người chỉ thấy và thao tác chuyến xe thuộc kho được giao. Firestore rules chỉ cho mỗi vai trò làm đúng bước của mình.

## Vai trò

| Vai trò | Quyền |
|---|---|
| Quản trị | Toàn quyền, sửa mọi danh mục, phân quyền, quản lý hạng mục |
| Thủ kho | Xem danh mục; thêm/sửa Vị trí lưu trữ và Cửa xuất/nhập; đăng ký xe, gán cửa, xác nhận xuất/nhập xong ở kho được giao |
| Bảo vệ | Xem danh mục; đăng ký xe, cho vào/ra cổng ở kho được giao |
| Kế toán, Chỉ xem | Xem danh mục và tổng quan chuyến xe |

"Kho được thao tác" để trống = tất cả kho. Người không phải quản trị chỉ thấy vị trí và cửa của kho được giao.

## Triển khai

### 1. Tạo project Firebase
1. https://console.firebase.google.com → **Add project** (project mới, tách khỏi QLVT và Sale_control). Firestore region `asia-southeast1`.
2. **Authentication → Get started**, bật **Google** và **Email/Password**.
3. **Firestore Database → Create database** (production mode).
4. **Project settings → Your apps → Web (</>)** → copy `firebaseConfig`.

### 2. Chạy trên máy (tùy chọn)
```bash
npm install
cp .env.example .env.local   # điền các biến VITE_FIREBASE_* vừa copy
npm run dev
```

### 3. Đẩy rules lên Firebase
Sửa `superAdmins()` trong `firestore.rules` nếu cần (phải khớp `VITE_SUPER_ADMINS`), rồi:
```bash
npm i -g firebase-tools
firebase login
firebase use --add
firebase deploy --only firestore:rules
```
Hoặc copy nội dung `firestore.rules` dán vào **Firestore → Rules → Publish**.

### 4. Deploy Vercel
Vercel → **Add New Project** → import repo (Framework: Vite) → **Settings → Environment Variables** khai báo đủ các biến trong `.env.example` → Deploy. Vào Firebase **Authentication → Settings → Authorized domains** thêm domain `*.vercel.app` của bạn.

### 5. Bắt đầu dùng
Đăng nhập bằng email quản trị gốc → **Phân quyền** thêm email nhân viên → vào **Tình trạng hàng**, **Lý do**, **Mã tự sinh** bấm "Tạo dữ liệu mặc định" → nhập các danh mục còn lại (có thể bằng Excel theo File mẫu).

## Chạy thử với Firebase Emulator
```bash
firebase emulators:start --only auth,firestore --project demo-kho
# .env.local: VITE_FIREBASE_PROJECT_ID=demo-kho, VITE_FIREBASE_API_KEY=fake, VITE_USE_EMULATOR=1
npm run dev
```

## Cấu trúc
```
src/
├── catalogs.js            # Định nghĩa tất cả danh mục và trường có sẵn
├── context/AppContext.jsx # Đăng nhập, vai trò, kho được giao, cấu hình hạng mục
├── pages/CatalogPage.jsx  # Trang danh mục dùng chung (bảng, form, Excel)
├── pages/FieldManager.jsx # Quản lý hạng mục
├── pages/transport/       # Đăng ký xe, Bảo vệ, Thủ kho, Giao hàng, Tổng quan
├── lib/trips.js           # Trạng thái và quy tắc luồng xe, cấp mã GRP/SP
├── components/            # Layout, ô nhập theo kiểu dữ liệu
└── lib/                   # Gộp trường, Excel, tiện ích
firestore.rules            # Phân quyền trên máy chủ
```
