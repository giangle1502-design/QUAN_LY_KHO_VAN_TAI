# Hệ thống quản lý kho & vận tải

- Bước 1: **Thiết lập danh mục** dùng chung cho kho và vận tải.
- Bước 2: **Luồng xe vận tải** như app QLVT, chọn xe, tài xế, khách từ danh mục.
- Bước 3: **Nhập kho, xuất kho, tồn kho** theo vị trí, lô và tình trạng thế chấp.
- Bước 4: **Sẵn sàng chạy thật**: nhập tồn đầu kỳ từ Excel, in phiếu, trang Tổng quan.
- Bước 5: **Đơn bán (SO) và đơn mua (PO)**: theo dõi đặt, đã giao/nhận, còn lại; phiếu nhập/xuất và chuyến xe gắn vào đơn.
- Bước 6: **Lệnh chuyển kho (STO)** và **lập phiếu nhập/xuất ngay từ đơn**.

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

## Kho hàng

Mọi thay đổi tồn đi qua 1 phiếu, ghi trong cùng 1 giao dịch: phiếu + dòng tồn + số pallet ở Vị trí lưu trữ (% lưu trữ, Empty bin tự cập nhật).

| Phiếu | Ai lập | Ghi chú |
|---|---|---|
| Nhập kho (PN) | Thủ kho | Gắn chuyến xe nhập đang ở cửa (tự điền nhà cung cấp). Mỗi dòng: mã hàng, lot, NSX, HSD, vị trí, tình trạng (HTC phải chọn bên nhận thế chấp), số bao → tự gợi ý pallet và kg theo quy cách mã hàng. Vị trí đang khóa không chọn được |
| Xuất kho (PX) | Thủ kho | Gắn chuyến xe lấy hàng (tự điền khách, Shipto). Chọn dòng tồn theo FIFO (nhập trước hiện trước). **Hàng HTC bị khóa xuất**; không xuất quá tồn |
| Chuyển vị trí (CV) | Thủ kho | Giữ nguyên lot, ngày nhập, tình trạng |
| Đổi tình trạng thế chấp (TC) | Kế toán | KTC → HTC (chọn bên nhận thế chấp), HTC → DGC… |
| Điều chỉnh tồn (DC) | Thủ kho | Tăng/giảm, bắt buộc chọn lý do |

- Màn hình **Thủ kho điều phối** có nút *Lập phiếu nhập/xuất* cho xe đang ở cửa.
- **Tồn kho**: xem theo vị trí và lô, hoặc theo mã hàng; tổng tấn theo KTC/HTC/DGC; tuổi tồn; Excel 3 sheet (chi tiết, theo mã hàng, tuổi tồn).
- **Phiếu kho**: lọc theo ngày, kho, loại; Excel từng dòng; quản trị **hủy phiếu** (đảo lại tồn, giữ lịch sử).
- Firestore rules: thủ kho/kế toán chỉ sửa được tồn và pallet vị trí khi kèm 1 phiếu mới do chính họ lập trong cùng giao dịch, đúng kho được giao.

## Đơn hàng (SO / PO)

Đơn là kế hoạch, phiếu kho là thực hiện. Ví dụ: SO 100 tấn, xuất 20 tấn → đơn hiện *Đã giao 20, Còn phải giao 80*. PO 100 tấn, về 20 tấn → *Đã nhận 20, Còn chưa về 80*.

- **Lập đơn** (Kinh doanh, Kế toán, Quản trị): số Ecount, ngày, khách hàng/Shipto (SO) hoặc nhà cung cấp (PO), kho (bỏ trống = kho nào cũng được), hạn giao / ngày hàng về, dung sai %, các mặt hàng nhập theo **tấn** (lưu kg). Số đơn tự cấp SO000001, PO000001 theo Quy tắc mã.
- **Nhập Excel** từ Ecount: mỗi dòng 1 mặt hàng, gộp theo Số đơn Ecount; đơn trùng số Ecount bị bỏ qua.
- **Phiếu nhập** chọn PO: tự điền khách và các mặt hàng còn chưa về; thủ kho chọn vị trí, sửa số thực nhận. **Phiếu xuất** chọn SO: dòng tồn tự gắn vào dòng đơn cùng mã hàng. Ô "Còn lại sau phiếu" hiện ngay khi nhập số.
- Ghi phiếu cộng "đã giao/nhận" của đơn **trong cùng giao dịch**; vượt số đặt + dung sai thì bị chặn; quản trị hủy phiếu thì đơn được trừ lại.
- Trạng thái đơn tự tính: Chưa thực hiện → Đang thực hiện → Hoàn tất. **Đóng đơn** (có lý do) khi không giao/nhận tiếp phần còn lại; **Hủy đơn** chỉ khi chưa giao/nhận gì; mở lại được.
- Sửa đơn: không được đặt ít hơn phần đã làm, không xóa/đổi mã hàng của dòng đã giao/nhận.
- **Đăng ký xe** chọn SO/PO cho từng khách, khối lượng mặc định = phần còn lại của đơn; chọn chuyến xe trên phiếu nhập/xuất sẽ tự chọn đơn.
- **Cân đối theo mã hàng**: tồn được xuất (không tính HTC), SO còn phải giao, PO còn chưa về, *Thiếu/dư ngay* = tồn − SO, *Dự kiến* = tồn + PO − SO; mã hàng thiếu tô đỏ.
- Trang Tổng quan có số tấn SO còn phải giao, PO còn chưa về và số đơn quá hạn.
- Firestore rules: thủ kho chỉ cập nhật "đã giao/nhận" của đơn khi kèm 1 phiếu mới do chính họ lập gắn đúng đơn đó.

### Lập phiếu từ đơn và lệnh chuyển kho (STO)

Mọi lần hàng ra khỏi kho đều đi qua **phiếu xuất kho**, mọi lần hàng vào kho đều đi qua **phiếu nhập kho**; đơn chỉ quyết định phiếu trừ vào đâu:

| Đơn | Kho đi | Kho đến |
|---|---|---|
| SO (bán) | Phiếu xuất kho → trừ "Còn phải giao" | – |
| PO (mua) | – | Phiếu nhập kho → trừ "Còn chưa về" |
| STO (chuyển kho) | Phiếu xuất kho → "Đã xuất", hàng thành **Đang đi đường** | Phiếu nhập kho → "Đã nhận", trừ "Đang đi đường" |

- Trên danh sách và chi tiết đơn, thủ kho có nút **📤 Lập phiếu xuất kho** (SO, STO) và **📥 Lập phiếu nhập kho** (PO, STO).
- Phiếu xuất theo SO/STO tự chọn sẵn tồn theo FIFO cho đủ phần còn lại (bỏ qua hàng HTC), báo mã hàng nào thiếu tồn.
- Phiếu nhập theo STO tự điền đúng lot, NSX, HSD, tình trạng thế chấp của hàng đang đi đường; thủ kho kho đến chỉ chọn vị trí và sửa số thực nhận. Không nhận được nhiều hơn số đã xuất.
- STO hoàn tất khi kho đến nhận đủ. Đóng STO thì không xuất thêm nhưng kho đến vẫn nhận nốt hàng đang đi đường. Hủy phiếu xuất của STO bị chặn nếu kho đến đã nhận (hủy phiếu nhập trước).
- STO do kinh doanh, kế toán hoặc thủ kho kho đi lập. Đăng ký xe chọn được STO; Cân đối theo mã hàng tính STO (kho đi như SO, kho đến như PO, xem tất cả kho thì cộng hàng đang đi đường).

## Chạy thật

- **Tổng quan** (trang đầu): số xe theo từng bước, xe đang trong kho kèm thời gian chờ, tồn theo KTC/HTC/DGC, vị trí ≥ 85%, hàng hết hạn trong 30 ngày, phiếu kho hôm nay.
- **Nhập tồn đầu kỳ** (thủ kho): tải File mẫu, điền vị trí, mã hàng, lot, NSX, HSD, tình trạng, bên nhận thế chấp, số bao, ngày nhập (pallet và kg tự tính nếu để trống). Hệ thống kiểm tra từng dòng (mã hàng, vị trí, vị trí khóa, HTC thiếu bên nhận thế chấp) và chỉ cho ghi khi file sạch lỗi; ghi thành phiếu nhập lý do "Tồn đầu kỳ", mỗi phiếu tối đa 150 dòng, hủy được nếu sai.
- **In nhãn pallet** (phiếu nhập kho): theo mẫu *In nhãn pallet*, nhãn nhiệt 10,2 × 15 cm. Số nhãn = số kg nhập ÷ kg 1 pallet chẵn (trọng lượng pallet của mã hàng, hoặc số bao/lớp × số lớp × kg/bao), làm tròn lên; pallet lẻ ghi đúng số kg thực. Nhãn có ngày nhập, công ty, mã/tên hàng, lot, TTHH, SL/pallet, số bao, lớp/pallet, vị trí nhập chữ lớn. Nút *In nhãn pallet* hiện ngay sau khi lập phiếu nhập, trong chi tiết phiếu và trên bản in phiếu.
- **In phiếu**: mọi phiếu kho có bản in A4 (In → Lưu PDF) với thông tin xe, khách, chữ ký. Tên và địa chỉ công ty nhập ở Tổng quan danh mục.

## Vai trò

| Vai trò | Quyền |
|---|---|
| Quản trị | Toàn quyền, sửa mọi danh mục, phân quyền, quản lý hạng mục |
| Thủ kho | Thêm/sửa Vị trí lưu trữ và Cửa xuất/nhập; đăng ký xe, gán cửa, xác nhận xuất/nhập xong; lập phiếu nhập, xuất, chuyển vị trí, điều chỉnh ở kho được giao |
| Bảo vệ | Xem danh mục; đăng ký xe, cho vào/ra cổng ở kho được giao |
| Kế toán | Xem mọi thứ; lập phiếu đổi tình trạng thế chấp; lập, sửa, đóng đơn SO/PO |
| Kinh doanh / Mua hàng | Lập, sửa, đóng đơn SO/PO, nhập đơn từ Excel; xem tồn kho, chuyến xe, cân đối |
| Chỉ xem | Xem danh mục, chuyến xe, tồn kho |

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
├── pages/stock/           # Tồn kho, Phiếu kho, form lập phiếu
├── lib/stock.js           # Ghi phiếu và cập nhật tồn trong 1 giao dịch
├── lib/trips.js           # Trạng thái và quy tắc luồng xe, cấp mã GRP/SP
├── components/            # Layout, ô nhập theo kiểu dữ liệu
└── lib/                   # Gộp trường, Excel, tiện ích
firestore.rules            # Phân quyền trên máy chủ
```
