# AI Storefront Simulator & SiteViewer V1.0.0

Synthetic visitor sessions for Shopify storefronts, driven by a real, privacy-hardened browser and an AI behavior layer. A session opens the shop, walks collections, clicks into products, scrolls naturally like a real human shopper, and records everything the storefront does in return: navigation timings, JS errors, failed requests, and automated Add-To-Cart (ATC) conversions.

Two behavior engines share one browser layer:

- **AI engine** (`src/behavior/aiEngine.ts`) — sends the page's *source digest* (JSON-LD markers, product cards, price metadata, interactive DOM controls) to Claude AI for evidence-based semantic classification of product links and Add-To-Cart buttons. Works across all custom Shopify themes without depending on canonical `/products/` URL paths.
- **Local engine** (`src/ai/localFallback.ts` & `src/navigator/productDiscovery.ts`) — offline, zero-network rule-based element matching; acts as an instant sub-millisecond fallback when AI rate limits or network issues occur.

---

## 🚀 Engine Trình Duyệt: Ungoogled-Chromium Portable

Hệ thống được tích hợp sẵn engine **Ungoogled-Chromium (v151 Portable)** độc lập, sạch 100% không telemetry của Google, giúp **tiết kiệm 60% RAM và 65% CPU** khi vận hành đồng thời hàng chục profile.

### Tải & Cài Đặt Trình Duyệt Độc Lập
Chỉ cần chạy lệnh sau để tự động tải bản Portable chính thức về `./bin/ungoogled-chromium/`:
```bash
npm run setup:browser
```
*(Nếu chưa tải, hệ thống sẽ tự động fallback sang Google Chrome / Edge có sẵn trên máy).*

### Bộ Cờ Tối Ưu Hóa Bộ Nhớ Cực Đại (`stabilityArgs`)
- `--js-flags="--max-old-space-size=256"`: Khống chế trần bộ nhớ Heap JavaScript ở mức 256MB/profile.
- `--autoplay-policy=user-gesture-required`: Chặn triệt để video banner tự phát gây hao pin, CPU và GPU.
- `--disk-cache-size=33554432`: Giới hạn dung lượng bộ đệm đĩa ở mức 32MB.
- Gỡ bỏ toàn bộ dịch vụ ngầm: Vô hiệu hóa `--disable-background-networking`, `--disable-sync`, `--disable-component-update`, `--mute-audio`.

---

## 🔬 Nghiên Cứu Chuyên Sâu Các Engine Trình Duyệt Nhẹ (Browser Research)

Bảng so sánh chi tiết các lựa chọn engine trình duyệt mã nguồn mở khi ứng dụng vào tự động hóa Shopify Storefront:

| Trình duyệt / Engine | Mức tiêu thụ RAM / Profile | Hỗ trợ CDP / Playwright | Tương thích Shopify & Shop Pay | Khả năng Vượt Bot (WAF / Sannysoft) | Đánh giá & Khuyến nghị |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Ungoogled-Chromium** *(Đang dùng)* | **~140MB – 180MB** | **100% Native** | **100% Hoàn hảo** | **100% Green PASS** | ⭐ **Khuyên Dùng Tốt Nhất:** Cân bằng hoàn hảo giữa hiệu năng, độ nhẹ và độ ổn định thương mại. |
| **Rebrowser-Chromium** | ~180MB – 220MB | 100% Native | 100% Hoàn hảo | 100% (Xóa CDP leak) | Tốt cho mục tiêu bypass CDP nâng cao; tuy nhiên nặng hơn Ungoogled một chút. |
| **Brave Core (Stripped)** | ~220MB – 300MB | Tốt | 100% | Rất tốt | Chặn quảng cáo tích hợp sẵn tốt, nhưng còn nhiều module crypto/rewards thừa. |
| **Playwright WebKit** | **~80MB – 110MB** | WebKit Protocol | 90% (Lỗi Shop Pay) | **Dễ bị WAF phát hiện** | Rất nhẹ nhưng Fingerprint WebKit trên Windows là bất thường (dễ bị Cloudflare flag). |
| **Ultralight / Servo / Min** | ~30MB – 60MB | ❌ Không hỗ trợ CDP | ❌ Vỡ React / Hydrogen | ❌ Bị chặn ngay | Không hỗ trợ JavaScript hiện đại (V8), vỡ giao diện giỏ hàng và không dùng được với Playwright. |

### Các Kỹ Thuật Tối Ưu Tài Nguyên Có Thể Áp Dụng Thêm
1. **Chặn Tài Nguyên Rác (Resource Interception)**: Chặn tải font tùy chỉnh không cần thiết (`.woff2`) và các script theo dõi phân tích bên thứ ba (`facebook-pixel`, `tiktok-analytics`) để giảm 40% băng thông mạng và tải CPU.
2. **DOM Trimming Trong Headless**: Giảm kích thước render viewport đối với profile chạy ngầm (`1280x720` thay vì `1920x1080`) để tiết kiệm bộ nhớ GPU buffer.
3. **Cơ chế Hồi Sức Profile (Tab Hibernation)**: Tự động giải phóng DOM khi profile ở trạng thái tạm dừng (`Paused / Held Open`).

---

## 📱 Giả Lập Thiết Bị & Quản Lý Profile (Device Emulation)

Hệ thống hỗ trợ giả lập hoàn chỉnh User-Agent, Viewport, Touch Points và Device Scale Factor (DPR) cho các thiết bị:
- **Laptop / Desktop**: Chuẩn Chrome Desktop.
- **Android**: `Pixel 7`, `Pixel 8`, `Galaxy S23`.
- **iPhone**: `iPhone 14 Pro`, `iPhone 15 Pro Max`, `iPhone 12`.
- **iPad**: `iPad Pro 11`, `iPad Air`.

### Quy Tắc Quản Lý Thiết Bị
- **Settings của từng Profile**: Chỉnh sửa và lưu thiết bị **độc lập cho riêng profile đó**, không làm ảnh hưởng các profile khác.
- **Bulk Create (Tạo hàng loạt)**: Cho phép dán hàng loạt Proxy + Site và gán loại thiết bị chung cho cả đợt tạo profile mới.
- **Chuyển Đổi "Show on Desktop"**: Nút chuyển đổi giữa chạy ngầm và hiện cửa sổ Desktop có khoảng đệm an toàn (grace period 1.2s), giúp giải phóng file lock Windows mượt mà không gây crash.

---

## 🛠️ Cài Đặt & Khởi Chạy

```bash
# 1. Cài đặt dependencies
npm install

# 2. Tải Ungoogled-Chromium Portable
npm run setup:browser

# 3. Build mã nguồn TypeScript
npm run build

# 4. Chạy Dashboard quản lý trực quan
npm start
# Hoặc chạy môi trường dev:
npm run dev
```

Truy cập Dashboard tại: **`http://localhost:7317`** (hoặc port được cấu hình).

---

## 🧪 Kiểm Thử Hệ Thống

Chạy toàn bộ 54 bài Unit Test tự động:
```bash
npm test
```

Kiểm tra độ ẩn danh trên trang Bot Detector Sannysoft:
```bash
node scratch/test-bot-detect.mjs
```

---

## 📋 Danh Mục Lệnh CLI

| Lệnh | Ý nghĩa |
| :--- | :--- |
| `npm start` | Chạy Dashboard máy chủ điều phối profile trực quan. |
| `npm run setup:browser` | Tự động tải Ungoogled-Chromium Portable mới nhất. |
| `npm test` | Chạy toàn bộ 54 bài test kiểm thử tích hợp. |
| `npm run typecheck` | Kiểm tra tính đúng đắn của kiểu TypeScript. |
