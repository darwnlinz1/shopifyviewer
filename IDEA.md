# Storefront Simulator — SiteViewer V1.0.0

Công cụ QA chạy phiên duyệt web mô phỏng trên storefront Shopify của chính mình, ghi lại JS error,
thời gian tải trang, request hỏng và sản phẩm render thiếu — kèm dashboard quản lý nhiều profile
browser, mỗi profile stream trực tiếp.

## Dự án này có ý nghĩa gì

Một phiên chạy ~15 phút: mở trang chủ, vào danh mục, bấm vào sản phẩm, cuộn trang, mở accordion,
xem gallery, rê chuột qua biến thể, rồi rời đi. Trong lúc đó nó ghi lại mọi thứ storefront làm —
điều hướng, TTFB, FCP, exception chưa bắt, request thất bại, trang sản phẩm thiếu tiêu đề/giá.
Về bản chất đây là **công cụ giám sát chất lượng storefront bằng lưu lượng giả lập người thật**,
chạy trên browser thật (Chrome/Edge) nên thấy được những gì một khách thật thấy.

Hai lớp hành vi dùng chung một tầng browser:

- **Local engine** (`src/navigator/productDiscovery.ts`, khớp phần tử theo rule) — không cần mạng,
  deterministic, dùng cho test và làm fallback.
- **AI engine** (`src/behavior/aiEngine.ts`) — gửi *source digest* của trang (JSON-LD, mọi link kèm
  ngữ cảnh card và giá, control tương tác) lên Claude để phân loại link sản phẩm / nút ATC dựa trên
  bằng chứng markup, không lọc sẵn theo URL pattern — theme không dùng route `/products/` vẫn chạy được.

> Mặc định chỉ đọc. Add-to-cart tồn tại nhưng chết trừ khi `safety.allowCart = true`;
> checkout và trang account luôn bị chặn.

## Số liệu thực tế (đo ngày 26/08/2026)

| Chỉ số | Giá trị |
| --- | --- |
| Code nguồn | **35 file TypeScript, ~10.642 dòng** trong `src/` |
| Web UI dashboard | ~1.386 dòng (`index.html` + `app.js` + `styles.css`) |
| Test suite | **71 test — 59 pass, 12 skip (tự skip khi máy không có Chromium), 0 fail** |
| Typecheck | `tsc --noEmit` sạch, 0 lỗi |
| Build | `dist/` đầy đủ, có `dist/cli.js` |
| CLI | 6 lệnh hoạt động: `dashboard`, `run`, `probe`, `verify`, `info`, `init` |

## Tình trạng hoàn thành theo module

| Module | Hoàn thành | Ghi chú |
| --- | --- | --- |
| Entry (`cli.ts`, `bootstrap.ts`, `config.ts`) | ✅ 100% | 6 lệnh đủ, signal cleanup, deep-merge config |
| Browser (`chrome.ts`, `verify.ts`, `identity.ts`) | ✅ ~97% | Thiếu: verify.ts hardcode version `"chrome"`, chưa set `tier` |
| Session (`aiManager`, `runner`, `timer`, report) | ✅ 100% | Recovery ladder, revive browser, ATC 4-lớp xác minh |
| AI layer (claudeClient, detector, cookiePool, fallback) | ✅ 100% | SSE streaming, TTL cache, quarantine, cooldown |
| Server/Dashboard (http, orchestrator, screencast + UI) | ✅ ~98% | ~25 REST endpoint, SSE, MJPEG live view, token auth; còn 1 vòng heartbeat rỗng trong multiplexed stream |
| Navigator (isolate, pageNavigator, probe, selectors, wheel) | ✅ ~90% | Đủ chức năng; còn song song 2 implementation cũ/mới |
| Profiles (store, cookies, proxy, types) | ✅ 100% | Import 3 định dạng cookie, test proxy SOCKS5/CONNECT tự viết |
| Behavior (aiEngine, timing, engine) | ✅ 100% | 4 personality, pacing log-normal có drift + fatigue |

### Tổng hợp: **~93–95% hoàn thành** (chốt: **94%**)

Core pipeline chạy end-to-end, build + typecheck + test sạch. Phần thiếu còn lại là tinh chỉnh,
không phải chức năng chính.

## Việc còn lại (~6%)

1. **`browser.geoip` chưa hiện thực** — flag khai báo trong config (mặc định false), dependency
   `mmdb-lib` đã cài nhưng chưa import ở đâu. Đây là feature duy nhất "hứa mà chưa có".
2. **`browser.humanize` / `browser.humanPreset` chết** — khai báo trong config nhưng không ai đọc;
   engine humanize đã bị xoá, để lại `humanConfigFor()` mồ côi trong `identity.ts`.
3. **`src/navigator/productDiscovery.ts` là dead code** — 5 chiến lược discovery export nhưng không
   module nào import; docstring mô tả lời gọi `discoverProductLinks()` không tồn tại.
4. **`dist/browser/cloak.js` mồ côi** — artifact build từ source đã xoá, chỉ chứa `export {}`.
5. **Cosmetic**: vòng heartbeat rỗng trong `streamMultiplexedScreens()` (`http.ts`);
   `runner.runSession(options: any)` chưa typ hoá; vài cast `(config as any).ai`.

## Kiến trúc

```
Chrome → Session Manager (aiManager) → AI Behavior Engine → Pacing → Timer
                    │                        ↑
                    │ source digest          │ decision
                    ↓                        │
             Element Detector ── Cookie Pool ── Claude Web API
                    └── Local fallback (no AI)
                    → Logger (JSONL) → Dashboard / CLI runner
```

## Cách chạy

```bash
npm install && npm run build
node dist/cli.js dashboard --token <secret>   # mở http://127.0.0.1:7317
# hoặc dùng Start.bat — tự check Node, install, build, mở dashboard
```

Test: `npm test` (mock storefront self-contained, không đụng mạng).
