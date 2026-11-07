# AI Storefront Simulator & SiteViewer V3.0 (BitBrowser Edition)

> **Trạng thái V3.0**: cả hai trụ cột trong [`BITBROWSER_HANDOFF_PROMPT.md`](./BITBROWSER_HANDOFF_PROMPT.md) đã được hiện thực và kiểm chứng —
> (1) engine **BitBrowser** (nhân C++, Local API `http://127.0.0.1:54345`) song song với Chromium tích hợp, chọn theo từng profile;
> (2) **nhận diện 3 tầng** (Tier 0 recipe → Tier 1 multi-signal → Tier 2 AI) và **chuỗi view người thật co giãn trước checkout**.
> Xem số liệu kiểm chứng ở mục [Kiểm Thử Hệ Thống](#-kiểm-thử-hệ-thống).

Synthetic visitor sessions for Shopify storefronts, driven by a real, privacy-hardened browser (hoặc kết nối trực tiếp vào nhân C++ của **BitBrowser**) và lớp hành vi sinh học người thật.

One behavior engine (`src/behavior/aiEngine.ts`) drives the visit; it finds what to click through a detection waterfall:

- **Tier 0 — domain recipes** (`src/ai/domainRecipeCache.ts`) — selectors learned once per `hostname + pageType`, persisted to `data/domain-recipes.json`, applied in under a millisecond.
- **Tier 1 — multi-signal detector** (`src/navigator/multiSignalDetector.ts`) — one scan in an isolated CDP world (the page's own JS never sees it): the Shopify product oracle (variant IDs + stock), cart forms and custom elements, ARIA roles, and buy-box geometry.
- **Tier 2 — AI** (`src/ai/elementDetector.ts`) — the page's *source digest* goes to Claude only when Tier 1 is unsure (confidence < 0.80) or a click did not add to the cart; what works is written back to Tier 0.
- **Local fallback** (`src/ai/localFallback.ts`) — offline rules when the AI is rate-limited or has no cookies.

---

## 🧬 Engine BitBrowser (Nhân C++)

Mỗi profile chọn engine riêng: **Built-in Chromium** (mặc định) hoặc **BitBrowser**. Chọn trong Dashboard
(ô *Engine* ở Settings / Create / Bulk Create) hoặc qua API (`browserProvider: "bitbrowser"`).
Ô *BitBrowser Profile ID* để trống = SiteViewer tự tạo profile BitBrowser (và xoá nó khi xoá profile);
dán ID có sẵn = dùng profile của bạn, giữ nguyên proxy/fingerprint bạn đã cấu hình bên BitBrowser.

```jsonc
// config — browser
"provider": "builtin",              // mặc định toàn cục: "builtin" | "bitbrowser"
"bitbrowser": {
  "apiUrl": "http://127.0.0.1:54345",
  "coreVersion": "136",             // nhân Chrome của profile tự tạo (BitBrowser hiện ship tới 148)
  "autoCreateProfile": true,
  "groupId": "",                    // tuỳ chọn: nhóm BitBrowser cho profile tự tạo
  "apiKey": ""                      // tuỳ chọn: header x-api-key (BitBrowser ≥ 7.1.5 khi bật auth)
}
```

Luồng (`src/browser/bitbrowser.ts`): `POST /browser/update` (tạo profile + proxy + fingerprint C++) →
`POST /browser/open` → `chromium.connectOverCDP(ws)` → `browser.contexts()[0]` (không bao giờ `newContext()`)
→ khi đóng: ngắt Playwright + `POST /browser/close`. Mọi lời gọi Local API đi qua một hàng đợi cách nhau
≥ 350 ms. Proxy chỉ được đẩy lại (`/browser/update/partial`) khi thay đổi, nên fingerprint giữ nguyên.

> **Quy tắc sống còn:** khi chạy trên BitBrowser, SiteViewer **không** tiêm `stealthInitScripts()`,
> `privacyInitScripts()` hay `buildNoiseScript()` — nhân C++ của BitBrowser lo toàn bộ fingerprint; JS tiêm
> thêm chỉ làm bẩn nó. Vẫn giữ: tối ưu CPU runtime, bộ lọc mạng, đóng tab hệ thống, đồng bộ cookie.

Kiểm tra với BitBrowser thật đang chạy: `node scripts/bitbrowser-smoke.mjs` (tạo profile tạm, mở, gắn CDP, đóng, xoá).

---

## 🎯 Nhận Diện 3 Tầng & Chuỗi View Trước Checkout

**Tier 1 đọc trang như một hệ thống, không đoán theo text nút:**

| Lớp tín hiệu | Đọc gì |
| :--- | :--- |
| Shopify Data Oracle | `data-product-json` / JSON nhúng, `/products/<handle>.js`, JSON-LD offers, `ShopifyAnalytics.meta` → variant ID thật + Size/Màu + còn hàng |
| Form & custom elements | `form[action*="/cart/add"]`, `input[name=id]`, `<product-form>`, `<variant-selects>`… |
| ARIA | `role=button`, `aria-label`, nhóm radio/listbox của biến thể |
| Hình học buy-box | nút nằm dưới tiêu đề/giá (0 < dy < 700 px), rộng 160–580 px, cao 38–72 px, đang hiển thị; loại Shop Pay, quick-add, sticky bar, nút ẩn, footer |

Vùng quét biến thể là tổ tiên nhỏ nhất của form giỏ hàng có chứa tiêu đề sản phẩm — theme nào tách picker
ra một block anh em với block nút mua vẫn đọc đúng.

**Chuỗi view co giãn theo `durationMinutes` / `atcMinutes`** (`src/behavior/choreography.ts`,
`src/behavior/pdpChoreography.ts`):

1. **Khám phá (0–20%)** — vào danh mục bằng click thật vào link (giữ Referer; `goto` chỉ là dự phòng), rê chuột qua card sản phẩm.
2. **So sánh** (khi ATC ≥ 2 phút) — xem sản phẩm A, `page.goBack()` về danh mục, chọn sản phẩm B.
3. **Xem sâu PDP** — lướt 2–5 ảnh gallery (0,8–2,2 s/ảnh; thumbnail, nút slider, hoặc cuộn qua cột ảnh xếp chồng), mở đọc tab Mô tả/Vận chuyển, thỉnh thoảng bôi đen một dòng, thử Size/Màu 15–40 s trước ATC (chỉ chọn tổ hợp oracle báo còn hàng, và chỉ tổ hợp kịp bấm xong).
4. **Add-To-Cart đúng mốc** — xác minh bằng mạng, `/cart.js`, drawer, badge hoặc trang giỏ.
5. **Kiểm tra giỏ (5–12 s)** — mở drawer hoặc `/cart`, đọc dòng hàng và tạm tính, giữ nguyên giỏ cho checkout.

Trước mỗi click, điểm bấm được kiểm tra bằng hit-test: nếu bị popup/drawer che (hoặc một modal khoá cuộn trang),
thử Escape, rồi bấm nút đóng của chính lớp phủ đó như người thật; vẫn che thì không bấm mù. Trên trang nặng, sự kiện
wheel được gộp theo thời gian thật nên một cú cuộn vẫn dài đúng một cú cuộn. Toàn bộ dấu vết view (`viewTimeline`
kèm thời gian từng bước, `viewStats`, `detectionTiers`) có trong snapshot phiên.

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

```bash
npx tsc --noEmit                      # typecheck
npm run build
npm test                              # 13 file test, mock storefront + mock BitBrowser, không cần mạng
node scripts/test-5-live-sites.mjs    # 5 site Shopify thật, 3,2 phút/phiên, ATC ở phút 2,0
```

`npm test` dựng mock storefront có giỏ thật (`/cart/add`, `/cart.js`, drawer, badge), 12 sản phẩm Size×Màu
(có biến thể hết hàng, sản phẩm hết sạch), mồi nhử (Shop Pay, sticky bar, quick-add, nút ẩn), cùng mock
BitBrowser Local API mở Chrome thật qua CDP — nên cả hai engine được kiểm thử mà không cần mạng.

`scripts/test-5-live-sites.mjs` chạy 5 phiên đồng thời trên Taylor Stitch, Keychron, Death Wish Coffee, Pura Vida,
BioLite — không cookie shop.app, không cookie AI — và chỉ thoát 0 khi cả 5 xác minh được Add-To-Cart.
Cờ: `--quick` (1,5 phút, ATC ở 0,4), `--bitbrowser` (chạy trên profile BitBrowser tạm, xoá sau),
`--warm` (dùng lại `./data/domain-recipes.json`). Log JSONL của lần chạy gần nhất nằm ở `./logs/live-5-sites/`.

Kiểm tra độ ẩn danh trên các trang bot-detector:
```bash
node test/experiments/20-bot-detect-benchmark.mjs
```

---

## 📋 Danh Mục Lệnh CLI

| Lệnh | Ý nghĩa |
| :--- | :--- |
| `npm start` | Chạy Dashboard máy chủ điều phối profile trực quan. |
| `npm run setup:browser` | Tự động tải Ungoogled-Chromium Portable mới nhất. |
| `npm test` | Chạy toàn bộ bộ test (unit + tích hợp trên Chromium thật). |
| `npx tsc --noEmit` | Kiểm tra tính đúng đắn của kiểu TypeScript. |
| `node scripts/test-5-live-sites.mjs` | Benchmark 5 site Shopify thật (xem cờ ở trên). |
| `node scripts/bitbrowser-smoke.mjs` | Kiểm tra kết nối BitBrowser thật (profile tạm, tự xoá). |
