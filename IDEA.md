# Storefront Simulator — SiteViewer V3.0 (BitBrowser Edition)

> **Trạng thái V3.0 (16/10/2026)**: hai trụ cột trong [`BITBROWSER_HANDOFF_PROMPT.md`](./BITBROWSER_HANDOFF_PROMPT.md)
> đã được hiện thực và kiểm chứng:
> 1. **Engine BitBrowser** (`src/browser/bitbrowser.ts`) — Local API `:54345` + `connectOverCDP`, chọn theo từng profile
>    song song với Chromium tích hợp; không tiêm bất kỳ script stealth/noise JS nào khi chạy trên BitBrowser.
> 2. **Nhận diện 3 tầng + chuỗi view người thật trước checkout** — Tier 0 recipe theo tên miền, Tier 1 multi-signal
>    (oracle Shopify + form + ARIA + hình học buy-box) trong isolated world, Tier 2 AI chỉ khi cần; khám phá → so sánh
>    (Back) → xem sâu PDP (gallery, mô tả, size/màu) → ATC đúng mốc → kiểm tra giỏ.

Công cụ QA & mô phỏng hành vi người mua hàng thật trên storefront Shopify, ghi lại JS error,
thời gian tải trang, request hỏng và tương tác giỏ hàng (Add-To-Cart) — kèm dashboard quản lý nhiều profile
browser, mỗi profile stream trực tiếp.

## Dự án này có ý nghĩa gì

Một phiên chạy ~15 phút: mở trang chủ, vào danh mục, bấm vào sản phẩm, cuộn trang, mở accordion,
xem gallery, rê chuột qua biến thể, rồi rời đi. Trong lúc đó nó ghi lại mọi thứ storefront làm —
điều hướng, TTFB, FCP, exception chưa bắt, request thất bại, trang sản phẩm thiếu tiêu đề/giá.
Về bản chất đây là **công cụ giám sát chất lượng storefront bằng lưu lượng giả lập người thật**,
chạy trên browser thật (Chrome/Edge) nên thấy được những gì một khách thật thấy.

Một engine hành vi (`src/behavior/aiEngine.ts`) lái phiên; nó biết bấm vào đâu nhờ thác nhận diện 3 tầng:

- **Tier 0** (`src/ai/domainRecipeCache.ts`) — selector đã học theo `hostname + pageType`, lưu ở `data/domain-recipes.json`.
- **Tier 1** (`src/navigator/multiSignalDetector.ts`) — quét buy-box trong isolated world: oracle sản phẩm Shopify
  (variant + tồn kho), form/custom element, ARIA, hình học.
- **Tier 2** (`src/ai/elementDetector.ts`) — gửi *source digest* lên Claude khi Tier 1 không chắc (< 0,80) hoặc một cú
  bấm ATC không làm giỏ tăng; kết quả đúng được ghi ngược về Tier 0. `src/ai/localFallback.ts` là rule offline khi AI vắng.

> Mặc định chỉ đọc. Add-to-cart tồn tại nhưng chết trừ khi `safety.allowCart = true`;
> checkout và trang account luôn bị chặn.

## Số liệu đã kiểm chứng V3.0 (16/10/2026)

| Chỉ số | Giá trị |
| --- | --- |
| Code nguồn | 60 file trong `src/` |
| Test suite (`npm test`) | **109 / 109 pass** (13 file; gồm mock BitBrowser Local API mở Chrome thật qua CDP, nhận diện 3 tầng, chuỗi view trên mock storefront có giỏ thật, fleet 10 & 20 trình duyệt — 20 trình duyệt đóng trong ~2 s) |
| Benchmark 5 site Shopify thật (`scripts/test-5-live-sites.mjs`) | **5 / 5 Verified Add-To-Cart** ở cả 8 lần chạy V3.0, không cookie shop.app / AI; phiên 3,2 phút, ATC ở phút 2,0. Ở 5/8 lần (gồm 3 lần cuối trên code cuối) lần bấm ATC đầu tiên đều được xác minh trên cả 5 site; các lần còn lại, lần bấm đầu hụt được cứu ở sản phẩm kế tiếp |
| BitBrowser thật | `scripts/bitbrowser-smoke.mjs` PASS: tạo profile tạm → mở → `connectOverCDP` → `contexts()[0]` (mở trong ~3,5 s, mở lại ~2,3 s) → không có dấu vết script SiteViewer trong trang → đóng → xoá |
| Typecheck & Build | `npx tsc --noEmit` = 0, `npm run build` = 0 |

## Tình trạng theo module

| Module | Trạng thái | Ghi chú |
| --- | --- | --- |
| Entry (`cli.ts`, `bootstrap.ts`, `config.ts`) | Xong | `provider`, `bitbrowser`, `choreography`, `recipeCachePath` trong config |
| Browser (`chrome.ts`, `bitbrowser.ts`, `viewport.ts`, `verify.ts`, `identity.ts`) | Xong | Hai engine; BitBrowser: hàng đợi ≥ 350 ms, proxy chỉ đẩy khi đổi, tự tạo lại profile bị xoá phía BitBrowser |
| Nhận diện (`domainRecipeCache.ts`, `multiSignalDetector.ts`, `detectionWaterfall.ts`, `isolate.ts`) | Xong | Isolated world qua CDP thô (`Page.createIsolatedWorld`), không `Runtime.enable` |
| Hành vi (`aiEngine.ts`, `choreography.ts`, `pdpChoreography.ts`, `humanActions.ts`, `humanCursor.ts`) | Xong | Khám phá → so sánh → xem sâu → ATC → kiểm tra giỏ; hit-test trước mỗi click |
| Session (`aiManager.ts`, `actionExecutor.ts`, `atcVerifier.ts`, `digestExtractor.ts`) | Xong | Tách từ `aiManager.ts` ~2150 dòng; `viewTimeline` / `viewStats` / `detectionTiers` trong snapshot |
| Server/Dashboard (http, orchestrator, screencast + UI) | Xong | Ô Engine + BitBrowser Profile ID; `/api/bitbrowser/status`, `/api/bitbrowser/profiles` |
| Profiles (store, cookies, proxy, types) | Xong | `browserProvider`, `bitBrowserId`, profile tự tạo bị xoá cùng profile SiteViewer |

## Việc còn lại

1. **`browser.geoip` chưa hiện thực** — flag khai báo trong config (mặc định false), dependency
   `mmdb-lib` đã cài nhưng chưa import ở đâu. Đây là feature duy nhất "hứa mà chưa có".
2. **`browser.humanize` / `browser.humanPreset` chết** — khai báo trong config nhưng không ai đọc;
   engine humanize đã bị xoá, để lại `humanConfigFor()` mồ côi trong `identity.ts`.
3. **`src/navigator/productDiscovery.ts` là dead code** — 5 chiến lược discovery export nhưng không
   module nào import; docstring mô tả lời gọi `discoverProductLinks()` không tồn tại.
4. **`dist/browser/cloak.js` mồ côi** — artifact build từ source đã xoá, chỉ chứa `export {}`.
5. **Cosmetic**: vòng heartbeat rỗng trong `streamMultiplexedScreens()` (`http.ts`);
   `runner.runSession(options: any)` chưa typ hoá; vài cast `(config as any).ai`.
6. **Thời gian quét Tier 1 trên trang thật**: ~2–4 ms trên mock, nhưng 15–80 ms trên theme thật nặng
   (Keychron ~66 ms) — vẫn nhỏ so với một lượt hành vi, nhưng chưa đạt mục tiêu < 4 ms của đặc tả.
7. **Benchmark live trên BitBrowser** (`node scripts/test-5-live-sites.mjs --bitbrowser`) cần app BitBrowser đang
   chạy; luồng BitBrowser đã được kiểm bằng smoke test thật và mock Local API trong `npm test`.

## Kiến trúc

```
Built-in Chromium ─┐
                   ├─ launchBrowser(provider) → Session (aiManager) → Behavior engine (aiEngine + choreography)
BitBrowser :54345 ─┘     (BitBrowser: connectOverCDP,        │ decision            ↑ page features
                          contexts()[0], no JS stealth)      ↓                     │
                                                   actionExecutor / atcVerifier → Detection waterfall
                                                                                   Tier 0 recipes (data/domain-recipes.json)
                                                                                   Tier 1 multi-signal (isolated world)
                                                                                   Tier 2 Claude (cookie pool) → local fallback
                    → Logger (JSONL) → Dashboard / CLI runner
```

## Cách chạy

```bash
npm install && npm run build
node dist/cli.js dashboard --token <secret>   # mở http://127.0.0.1:7317
# hoặc dùng Start.bat — tự check Node, install, build, mở dashboard
```

Test: `npm test` (mock storefront + mock BitBrowser, không đụng mạng);
benchmark thật: `node scripts/test-5-live-sites.mjs` (cờ `--quick`, `--bitbrowser`, `--warm`).
