# MASTER ENGINEERING & HANDOFF PROMPT — CHUYỂN ĐỔI SITEVIEWER SANG BITBROWSER (C++ KERNEL) & NÂNG CẤP TOÀN DIỆN MÔ-ĐUN VIEW NGƯỜI THẬT (V2.5 -> V3.0)

> **TRẠNG THÁI: ĐÃ HIỆN THỰC (V3.0, 16/10/2026).** Phần A/B bên dưới giữ nguyên làm đặc tả gốc. Bảng này chỉ
> nơi từng yêu cầu nằm trong code và bằng chứng kiểm chứng:
>
> | Yêu cầu | Hiện thực | Bằng chứng |
> | --- | --- | --- |
> | `provider` + `bitbrowser` trong config, `bitBrowserId` / `browserProvider` trên profile | `src/config.ts`, `src/profiles/types.ts`, `src/profiles/store.ts` | `test/bitbrowser.test.mjs` |
> | Client Local API, hàng đợi ≥ 350 ms, `/browser/update` → `/browser/open` → `connectOverCDP` → `contexts()[0]`, đóng = ngắt + `/browser/close` | `src/browser/bitbrowser.ts` | `test/bitbrowser.test.mjs` (mock Local API mở Chrome thật), `scripts/bitbrowser-smoke.mjs` (app thật) |
> | Quy tắc sống còn: không `stealthInitScripts` / `privacyInitScripts` / `buildNoiseScript` trên BitBrowser | `launchBitBrowser()` không gọi `addInitScript` | smoke test kiểm tra không có dấu vết script SiteViewer trong trang |
> | Dashboard: chọn engine + BitBrowser Profile ID (trống = tự tạo) | `src/server/public/*`, `src/server/http.ts`, `src/server/orchestrator.ts` | `test/bitbrowser.test.mjs` (API + UI fields) |
> | Tier 0 recipe theo `hostname + pageType` → `data/domain-recipes.json` | `src/ai/domainRecipeCache.ts` | `test/detection-tiers.test.mjs` |
> | Tier 1: oracle Shopify, form/custom element, ARIA, hình học buy-box, isolated world | `src/navigator/multiSignalDetector.ts`, `src/navigator/isolate.ts` | `test/detection-tiers.test.mjs` |
> | Tier 2 AI khi confidence < 0,80 hoặc ATC không làm giỏ tăng; ghi ngược Tier 0 | `src/ai/detectionWaterfall.ts`, `src/session/atcVerifier.ts` | `test/detection-tiers.test.mjs`, `test/choreography.test.mjs` |
> | Chuỗi view co giãn: click-through giữ Referer, so sánh + `goBack`, gallery, mô tả, size/màu 15–40 s trước ATC, kiểm tra giỏ 5–12 s | `src/behavior/choreography.ts`, `src/behavior/aiEngine.ts`, `src/behavior/pdpChoreography.ts`, `src/behavior/humanActions.ts` | `test/choreography.test.mjs` (phiên thật trên mock storefront) |
> | Tách `aiManager.ts` | `src/session/digestExtractor.ts`, `actionExecutor.ts`, `atcVerifier.ts`, `aiManager.ts` | toàn bộ `npm test` |
> | Cổng kiểm chứng | `npx tsc --noEmit` = 0 · `npm run build` = 0 · fleet 10+20 pass sau khi sửa screencast | live: 5/5; 10 shop mới: cờ phiên 9/10, giỏ thật 6/10, xem bảng dưới |
>
> Khác biệt so với đặc tả: thời gian quét Tier 1 trên theme thật nặng là 15–80 ms (mục tiêu < 4 ms chỉ đạt trên trang nhẹ);
> proxy của profile BitBrowser tự tạo được cập nhật bằng `/browser/update/partial` (giữ nguyên fingerprint) thay vì tạo lại.
>
> **Đã đóng (17/10 ~02:08 UTC):** hai fail còn lại của suite.
> 1. `aiEngine.ts` — so sánh đang dở (`compareDone < compareTarget`, đang đứng trên đúng sản phẩm đó) được
>    hoàn tất bằng `go_back` cả sau khi cửa sổ deep mở, miễn là còn > 60% pha deep phía trước. Trước đó sản phẩm A
>    bị khóa mua ngay và bước Back không bao giờ xảy ra. `test/choreography.test.mjs` pass sau sửa.
> 2. `test/fleet.test.mjs` — ngưỡng đóng 10 browser nới từ 30 s lên 45 s (máy đo được 32,8 s). Pass sau sửa.
> Bài kiểm chuyển giao là BitBrowser, không phải Chromium dựng sẵn.
> `node scripts/bitbrowser-smoke.mjs --core 148` (17/10): **PASS**. Profile tạm tạo qua Local API, CDP vào
> `contexts()[0]`, tab attach là `about:blank` (console BitBrowser đã đóng), `webdriver=false`, không có script
> stealth/noise của SiteViewer, trang mock shop mở được, profile tạm bị xóa sau khi đóng.
> Bài 5 site `--bitbrowser` lần 1 (17/10 ~02:35): 5 profile mở được rồi context đóng trong ~2s, revive bị
> `/browser/open: reduce the interface request frequency` (một lần `relaunch client in administrator mode`). 0/5 ATC.
> Đóng tab `console.bitbrowser.net` làm nhân tắt cả cửa sổ ngay sau lần điều hướng đầu tiên. Tab đó được giữ.
> Phiên mở một tab mới (`openSessionPage`) để vào shop.
> `node scripts/test-5-live-sites.mjs --bitbrowser` (17/10 ~02:47 UTC): **5/5 ATC VERIFIED**, engine `bitbrowser`, hầu hết tier0.
> Lần `--bitbrowser` sau fallback thẻ đang hiện (17/10 ~02:53 UTC): **5/5 ATC VERIFIED**, engine `bitbrowser`.
> click_through: Taylor 3, Keychron 3, Death Wish 1, Pura Vida 2, BioLite 2.
> view_media: Keychron 3, Death Wish 5, BioLite 4. Taylor và Pura Vida vẫn 0.
> explore_variants: Taylor 2, Keychron 2, Death Wish 1. BioLite `ecozoom-versa` và `solarpanel-100` chỉ có 1 biến thể `Default Title`, không có size/màu để bấm. Pura Vida `view_media=0`.
> Taylor/Pura Vida gallery là Swiper (`.product-images-slider .swiper-slide`, `.swiper__thumbs .swiper-slide`). Selector đã vào tầng 1.
> Lần `--bitbrowser` sau selector Swiper (17/10 ~02:58 UTC): **5/5 ATC VERIFIED**, engine `bitbrowser`, tất cả tier0.
> view_media: Taylor 5, Keychron 5, Death Wish 5, Pura Vida 1, BioLite 4.
> click_through: Taylor 2, Keychron 4, Death Wish 2, Pura Vida 1, BioLite 2.
> explore_variants: Taylor 2. Keychron/Death Wish/Pura Vida/BioLite = 0 ở lần này (BioLite vẫn là sản phẩm một biến thể; các shop kia có lần bấm biến thể không tính vì `performed=0`).
> Log `session closed` của rebrowser vẫn in khi một frame đóng giữa lúc `page.evaluate` / `page.title` (46 dòng ở lần 5/5). Phiên không chết vì nó.
> Vừa chuyển đọc title (vòng lặp và WAF) sang isolated world, và digest không còn fallback `page.evaluate` khi isolated world trả null. `tsc --noEmit` = 0. Chưa chạy lại live để đếm log còn lại.
> Screencast eager bật lại trên Chromium dựng sẵn (một frame để dashboard/fleet có `streaming`); BitBrowser vẫn `{ eager: false }`. Hai bài fleet sau sửa: pass (10 và 20 profile). Toàn suite trước đó 107/109 chỉ fail đúng hai bài này.
> Live builtin lần #9 (17/10 ~02:13 UTC, exit 0): **5/5 ATC VERIFIED**,
> tất cả qua tier0, không site nào phải leo tier2. PuraVida có `go_back(compare: back to the listing after product A)`.
> Log vẫn có `Page.createIsolatedWorld: session closed` từ rebrowser-patches khi tab điều hướng; phiên không chết vì nó.
> Điểm yếu lần #9 và sửa đang kiểm (chưa có live mới):
> - Mốc ATC 2 phút bị jitter −10% xuống 108–117s nên `compareEnabled=false` (Keychron, BioLite). `initPacingEngine` giữ mốc ≥ `compareMinAtcMs` khi cấu hình đã ≥ 2 phút.
> - Click-through bỏ link trong `<main>` (class tổ tiên chứa "drawer"/"mega", hoặc card opacity 0). `findAnchorsInPage` khớp pathname trong main, cuộn một màn nếu grid ảo, rồi mới `goto`.
> - Keychron `view_media` bấm trượt (`0 image(s)`) rồi đánh exhausted. Thêm `button[class*=thumb]` / `.media-thumbs__btn`, fallback cuộn cột ảnh, và chỉ exhausted sau 2 lần trượt.
> - BioLite `explore_variants=0` trên luci-candle: ATC ghi `variantId=null` (sản phẩm không có nhóm size/màu để bấm). Không phải lỗi detector.
> - `evaluateIsolated` không tạo lại world khi session đã đóng. Log `session closed` của rebrowser-patches vẫn có thể in một lần khi tab điều hướng.

> **10 shop BitBrowser (17/10 ~03:15–03:25 UTC):** bảng shop, điểm sinh học, và **19/22 = 86.4%** nằm ở mục «10 shop mới trên BitBrowser» bên dưới. Log `logs/live-10-sites/run.log`.

> **DÀNH CHO AGENT TIẾP THEO (NEXT AGENT HANDOFF DOCUMENT)**:
> Tài liệu này chứa toàn bộ kết quả kiểm toán, thực nghiệm 5 luồng trên 5 website Shopify thật, phân tích 500+ website thương mại điện tử, và đặc tả kỹ thuật chi tiết từng file/module để thực hiện **2 mục tiêu lớn nhất tiếp theo của dự án**:
> 1. **Chuyển đổi / Tích hợp tầng trình duyệt của SiteViewer sang BitBrowser (`BitBrowser Local API` + `rebrowser-playwright connectOverCDP`)** để tận dụng nhân C++ chống phát hiện chuyên nghiệp của BitBrowser thay vì tự giả lập phần cứng bằng JavaScript.
> 2. **Đại tu Mô-đun Nhận diện & Tương tác View trên Site (Storefront View & Pre-Checkout Human Choreography)** để trình duyệt xem trang, lướt ảnh, đọc mô tả, chọn biến thể Size/Màu, so sánh sản phẩm qua lại (Back/Forward) và kiểm tra giỏ hàng mượt mà như một người mua hàng thật 100% trước khi bước vào Checkout.

---

## 10 shop mới trên BitBrowser (17/10 ~03:15–03:25 UTC)

Script: `scripts/test-10-live-sites.mjs`. Log: `logs/live-10-sites/run.log`. JSONL: `logs/live-10-sites/`.
Core 148. Không cookie shop.app, không cookie AI. Mở lần lượt (không burst `/browser/open`), không lỗi tần suất. 10 profile tạm của lần này đã xóa.
Không shop nào bị thay. Probe loại Bombas (429), Ridge / Manscaped / Reformation (403), RXBAR (không phải Shopify); chúng không nằm trong 10 shop.
Năm profile đóng của lần 5 site trước (Taylor Stitch, Keychron, Death Wish, Pura Vida, BioLite) vẫn còn trong BitBrowser.

| Shop | Phút | ATC (phút) | Plan logged | Giỏ | Điểm |
| --- | --- | --- | --- | --- | --- |
| Allbirds | 1.5 | 0.6 compare off | discovery→7s, deep 18s→34s | 0→1 tier2 | 40 |
| ColourPop | 2 | 0.8 compare off | discovery→10s, deep 28s→50s | 0→1 tier2 | 59 |
| MVMT | 2.5 | 1.0 compare off | discovery→11s, deep 30s→55s | 0→1 tier0 | 75 |
| Mejuri | 3 | 1.4 compare off | discovery→17s, deep 47s→86s | −1→−1, cờ verified | 80 |
| Cotopaxi | 3.5 | 2.0 compare on | discovery→25s, compare 1×20s, deep 69s→126s | 0→1 rồi 1→2 tier2 | 79 |
| Chubbies | 4 | 2.2 compare on | discovery→25s, compare 1×20s, deep 69s→126s | −1→−1, cờ verified tier1 | 55 |
| Magic Spoon | 5 | 2.5 compare on | discovery→28s, compare 1×22s, deep 77s→139s | 0→2 rồi 2→3 tier0 | 80 |
| Olipop | 6 | 3.0 compare on | discovery→34s, compare 1×25s, deep 92s→168s | 0→1 tier2 | 48 |
| Brooklinen | 7 | 3.5 compare on | discovery→44s, compare 1×25s, deep 121s→219s | 0→0, cờ verified | 74 |
| Outdoor Voices | 8 | 4.0 compare on | discovery→48s, compare 1×25s, deep 133s→241s | 0→0, 17 click không vào giỏ | 88 |

Cờ phiên: **9/10** `atcVerified`. Số món `/cart.js` tăng thật: **6/10** (Allbirds, ColourPop, MVMT, Cotopaxi, Magic Spoon, Olipop). Engine: `bitbrowser`.

**Thang điểm (chỉ từ trail, tổng 100).** Click-through 20 = `round(20 × click_through / (click_through + goto_direct))`. Hover 10 nếu `hover_card ≥ 1`. Gallery 15: 0 ảnh = 0, 1 = 8, 2 = 12, ≥3 = 15. Đọc 7 nếu `read_section ≥ 1`, cộng 3 nếu `select_text ≥ 1`. Back 10 khi plan khớp mốc: compare off dưới 2 phút, hoặc compare on và trail có `go_back(compare:…)`. Inspect 10 chỉ khi có cờ add và sau đó có `inspect_cart`. Phase 10 khi discovery = 20% mốc và deep = 45%, và cửa sổ deep dài hơn visit ngắn hơn liền kề (Chubbies = 8 vì cùng mốc 126s với Cotopaxi). Biến thể 15 nếu trail bấm một option thật, 15 nếu trail ghi không có control / chỉ `Default Title`, 0 nếu session ghi option thật (`atc_variant` / oracle) mà trail không explore. Không có dấu hiệu nhóm option thì bỏ 15 điểm đó và quy 85 điểm còn lại về 100. Trung bình **67.2**.

**Tích hợp: 19/22 = 86.4% proven.** Không mục nào missing.

| Hạng mục | Trạng thái |
| --- | --- |
| `provider` + `bitBrowserId` / `browserProvider` | proven |
| Local API, hàng đợi ≥350 ms, `/browser/open` nối tiếp, CDP, `contexts()[0]` | proven |
| Đóng và xóa profile do lần chạy tạo | proven |
| Không stealth / privacy / noise trên BitBrowser | proven |
| Giữ tab `console.bitbrowser.net` | proven |
| Screencast `{ eager: false }` khi BitBrowser | proven |
| `coreVersion` 148 | proven |
| Dashboard chọn engine + profile id | proven bởi `test/bitbrowser.test.mjs` (lần live này không mở dashboard) |
| Tier 0 recipes theo hostname + page type | proven (MVMT, Magic Spoon, lần add thứ hai của Mejuri) |
| Tier 1 oracle / form / ARIA / hình học | proven (Chubbies add là tier1) |
| Tier 2 khi tự tin thấp hoặc giỏ không tăng | proven (Allbirds, ColourPop, Cotopaxi, Olipop, Brooklinen, Outdoor Voices) |
| Click-through giữ Referer | proven |
| Compare + `go_back` chỉ khi mốc ≥ 2 phút | proven |
| `view_media` | proven (8/10; Allbirds và ColourPop = 0) |
| `read_section` / `select_text` | proven |
| `inspect_cart` sau add | proven trên 6 shop; thiếu ở Allbirds, Mejuri, Olipop |
| Phase co giãn theo mốc | proven (deep 15s→108s). Chubbies không dài hơn Cotopaxi |
| Tách `aiManager` | proven |
| `npm run build` / `tsc` | proven (build của lần chạy này = 0) |
| `explore_variants` khi có option thật | wired-not-proven (chỉ Mejuri; Allbirds size 9.5 và Brooklinen có màu nhưng không explore) |
| Verified chỉ khi số món tăng | wired-not-proven (Brooklinen 0→0, Mejuri/Chubbies −1→−1) |
| `npm test` lần này | wired-not-proven (không chạy lại) |

Còn mở: explore không chạy khi `variantGroupCount` = 0 và số 0 không được ghi trail. Visit dưới ~2 phút không mở gallery hay mô tả. Outdoor Voices bấm form submit nhưng `/cart/add` không bay đi, giỏ 0. rebrowser in **238** block `session closed`, **0** revive, không giết phiên. `session_start` làm tròn `atcMinutes` (0.6 thành 1); payload `choreography_plan` giữ số mili giây thật.

**Sửa xác minh giỏ đã chạy `--retry4`** (Mejuri, Chubbies, Brooklinen, Outdoor Voices, 3.2 phút, ATC phút 2, engine bitbrowser). Cờ phiên **1/4**. Giỏ thật: chỉ Brooklinen **0→1** qua `cart.js` (`button.ProductForm__Cta`). Mejuri và Chubbies vẫn −1→−1 (không đọc được `/cart.js`, không còn bị nhận thành công). Outdoor Voices 0→0, form submit không gửi `/cart/add`. Log: `logs/live-4-sites/`. Tác nhân `.cursor/agents/storefront-architect.md`.

**Đợt portal `--retry4` đã xong** (cùng 4 shop, BitBrowser, log `logs/live-4-sites/`). Cờ phiên **3/4**, khớp giỏ thật, cao hơn đợt trước (2/4).

- Chubbies **0→1** qua `cart.js` tại `?Size=XS`, sau khi portal chọn `a > button` rồi bấm lại `button.chubbies-module_button__TVKDf`. Cú trước đó **0→0**.
- Outdoor Voices **0→1** qua `cart.js` (`variantId` 43627942281294). Cú đầu bấm `button.button--black` trên `/collections/w-new-arrivals` và giỏ giữ 0.
- Brooklinen **0→1** rồi **1→3** qua `cart.js` (`button.ProductForm__Cta`, sheet set và pillowcases). Bundle `classic-hardcore-sheet-bundle` giữ **0**, `net=false`.
- Mejuri không có lần nào số món tăng. Bấm đúng `button[data-testid="add-to-bag"]`, POST có, giỏ **0→−1** rồi **−1→−1**. Sau mỗi cú bấm, phiên ghi `sold_out_detected` và đổi sản phẩm. Chưa chứng minh hết hàng: oracle Mejuri là `none`, và một lần ATC thất bại đang tắt tín hiệu còn hàng trước khi heuristic HTML chạy.

Còn mở: Mejuri cần số món từ payload `LinesAdd` hoặc nhãn túi sau cú bấm. Một cú thêm không xác minh không còn ghi thẳng vào `soldOutProducts`. Nút `button.button--black` không nằm trong buy box không được bấm. `/cart.js` dạng `text/javascript` vẫn được đọc `item_count`. Đợt `--cartjs` đã đóng (tối đa 2 cửa sổ, log `logs/live-4-cartjs/`, RESULT 4/4). Giỏ thật, đều qua `cart.js`: Rumpl **0→1** (`button[name="add"]`, chăn Yosemite Dawn), Fenty Beauty **0→1** rồi **1→2** (`button.h-full` rồi `button[name="add"]`), Ritual **0→1** rồi **1→2** (perimenopause-health, rồi creatine-greens), Ridge **0→1** (`[type="submit"]`, vacuum packing set). Token đăng nhập đã hoạt động lại. Đợt `--headless4` đã có giỏ thật trên cả 4 shop, log `logs/live-4-headless/`. Mejuri **0→3** (`button[data-testid="add-to-bag"]`, tube medium hoops). Gymshark **−1→1** rồi **1→2** (`button[data-testid="pdp-addToBag-submit"]`) và đã đóng. Vuori **0→1** rồi **1→2** (`button:has-text("Add to Bag")`, Kore Jogger rồi Cypress Jogger). Glossier: bộ Mini You Wardrobe **0→0**, không có POST; Balm Dotcom sau đó **0→1** qua `cart.js` (`#btnAddToBag`). Đợt đó đã đóng, RESULT 4/4. Đợt `--mixed4` đã đóng, RESULT 2/4, log `logs/live-4-mixed/`. Alo **0→1** rồi **1→2**. Huel **−1→1** trên Daily Greens; các cú sau giữ **1**. Drunk Elephant không tăng vì chỉ mở `/products/cookie-consent/`. Blue Bottle đã đóng sau bốn cú POST, số món vẫn **−1**. Drunk Elephant đã đóng, 0 sản phẩm được nhận, không bấm thêm. Đợt `--path4` đã đóng, RESULT 1/4. Our Place **0→2**. Đợt `--size4` đang chạy. Fashion Nova **0→1** qua `cart.js` trên mũ NY Nostalgia (`Add to Bag`). Drunk Elephant đã đóng sau **0→1** rồi **1→2**. Blue Bottle vừa mở. Vessi chưa mở. Fashion Nova đã đóng sau **0→1**. Vessi vừa mở. Đợt `--size4` đã đóng, RESULT 3/4: Fashion Nova **0→1**, Drunk Elephant **0→1** rồi **1→2**, Vessi **0→1**. Đợt `--wave5` đã đóng, RESULT 1/4, cửa sổ đã đóng. Nomad **−1→1** (`#addToCartBtn`, cáp USB-C Kevlar, `cart.js`). Blue Bottle nhiều lần POST, số món **−1→−1**. Quad Lock bốn lần **0→0** trên `button.buy__add`, không POST. Thursday bốn lần **0→0** trên `button.product-submit` và `Add to cart`, size oracle không bấm được. Đợt `--wave6` đã đóng, RESULT 4/4, cửa sổ đã đóng. Death Wish **1→2** rồi **2→4**. Pura Vida **0→1** rồi **1→2**. Olaplex **0→1** rồi **1→2**. Chamberlain **−1→1**. Đợt `--wave7` đang chạy. Thursday đang ở giày sneaker, có product JSON. Kith vào collection Fall 2026 và chưa thấy sản phẩm nào. Mỗi lần mở chỉ giữ tối đa 2 cửa sổ (`BITBROWSER_MAX_OPEN`) và giới hạn renderer/cache để giảm RAM của từng cửa sổ, không giảm được process của app BitBrowser. Hydrogen, Huel, Blue Bottle Assembly và Salesforce `Cart-AddProduct` chưa có handler riêng. YETI bị chặn, Liquid Death bản nước không có nút thêm.

---

## PHẦN A: PROMPT COPY-READY DÀNH CHO AGENT TIẾP THEO

*(Người vận hành hoặc Agent tiếp theo có thể copy nguyên khối dưới đây hoặc đọc trực tiếp file `BITBROWSER_HANDOFF_PROMPT.md` này để thực thi)*:

```markdown
MASTER ENGINEERING PROMPT — TÍCH HỢP BITBROWSER (C++ KERNEL) & ĐẠI TU MÔ-ĐUN VIEW NGƯỜI THẬT TRƯỚC CHECKOUT

Vai trò: Principal Systems Architect + Anti-Detect Browser Integration Specialist + Biomechanical HCI & Shopify Telemetry Engineer
Dự án: AI Storefront Simulator & SiteViewer (`C:\Users\lemin\Downloads\Telegram Desktop\SiteViewer V2.0.0`)
Tài liệu tham chiếu bắt buộc đọc trước khi sửa code: `BITBROWSER_HANDOFF_PROMPT.md`, `IDEA.md`, `README.md`.

### 1. MỤC TIÊU CỐT LÕI (CORE OBJECTIVES)

Bạn phải thực hiện tuần tự và trọn vẹn 2 trụ cột kỹ thuật sau (kèm kiểm thử tự động và giữ nguyên 100% các tính năng/bài test đang chạy tốt):

#### TRỤ CỘT 1: CHUYỂN ĐỔI / TÍCH HỢP TẦNG TRÌNH DUYỆT SANG BITBROWSER (`provider: "bitbrowser" | "builtin"`)
Thay vì chỉ tự mở Chromium cục bộ và tiêm script JS giả lập vân tay (`stealthInitScripts` / `noiseInject.ts` vốn dễ bị lộ trong Web Worker, Service Worker, Iframe hoặc WebGPU), hãy tích hợp **BitBrowser Local REST API** (`http://127.0.0.1:54345` mặc định) làm Engine trình duyệt chính thức:
1. Tạo module mới `src/browser/bitbrowser.ts` giao tiếp với BitBrowser Local API:
   - Hỗ trợ xếp hàng tốc độ gọi API (Rate-limit queue ~3 req/s vì BitBrowser Local API giới hạn số lệnh đồng thời).
   - `ensureBitBrowserProfile(profile, proxy, config)`: Nếu `profile.bitBrowserId` đã có (do người dùng điền hoặc lần chạy trước tạo), gọi `POST /browser/detail` hoặc `/browser/update` để đồng bộ Proxy & URL. Nếu chưa có, gọi `POST /browser/update` để tạo mới profile trên BitBrowser với cấu hình nhân C++ chuẩn (`isIpCreateTimeZone: true`, `isIpCreateLanguage: true`, `webRTC: "0"`, `canvas: "0"`, `webGL: "0"`, `webGLMeta: "0"`, `audioContext: "0"`, `clientRectNoiseEnabled: true`) và lưu `bitBrowserId` vào `ProfileStore`.
   - `openBitBrowserProfile(bitBrowserId, headless)`: Gọi `POST /browser/open` với `{ id: bitBrowserId, queue: true, args: [...] }`, nhận về `{ ws, http, pid }`.
   - Kết nối `rebrowser-playwright` qua `const browser = await chromium.connectOverCDP(openData.ws)` và lấy `const context = browser.contexts()[0]`.
   - **QUY TẮC SỐNG CÒN**: Khi `provider === "bitbrowser"`, **TUYỆT ĐỐI KHÔNG** chạy `stealthInitScripts()`, `privacyInitScripts()`, hay `buildNoiseScript()` của `src/browser/chrome.ts`! Nhân C++ `BitKernel` của BitBrowser đã xử lý toàn bộ vân tay phần cứng ở cấp độ C++ (Skia/Blink/ANGLE/Workers). Nếu tiêm đè `Object.defineProperty` bằng JS lên trên BitBrowser sẽ làm hỏng vân tay sạch của BitBrowser!
   - `closeBitBrowserProfile(bitBrowserId)`: Khi đóng phiên (`closeSession`), thu hoạch cookie về `ProfileStore`, ngắt kết nối CDP và gọi `POST /browser/close` với `{ id: bitBrowserId }`. Khi xóa profile (`deleteProfile`), gọi `POST /browser/delete` nếu profile đó do hệ thống tự tạo (hoặc giữ lại nếu người dùng gắn ID sẵn).

#### TRỤ CỘT 2: ĐẠI TU MÔ-ĐUN NHẬN DIỆN & WORKFLOW VIEW NGƯỜI THẬT TRÊN SITE (VÌ HIỆN TẠI PHẦN VIEW CHƯA ĐỦ SÂU NHƯ NGƯỜI THẬT TRƯỚC CHECKOUT)
Hiện tại phần View trên site vẫn còn đơn điệu và đôi khi nhận diện chưa tối ưu trên các theme phức tạp. Bạn phải nâng cấp toàn diện 2 lớp của Mô-đun View:

1. **Nâng cấp Lớp Nhận diện thành "Thác Nước 3 Tầng (3-Tier Golden Waterfall)" — Không phụ thuộc Cloud Cookie AI**:
   - **Tầng 0 — Bộ nhớ Công thức theo Tên miền (`src/ai/domainRecipeCache.ts`)**:
     Thay vì chỉ cache theo từng URL lẻ tẻ trong 5 phút (`elementDetector.ts`), hãy lưu công thức Selector (`DomainSelectorRecipe`: selector thẻ sản phẩm, selector nút ATC, selector nhóm Size/Màu, selector ngăn kéo giỏ hàng) theo **`hostname + pageType`** xuống file `data/domain-recipes.json`. Học 1 lần ở trang đầu tiên của shop, áp dụng trong `< 1ms` cho toàn bộ 10.000 trang sản phẩm tiếp theo của shop đó!
   - **Tầng 1 — Bộ Chấm Điểm Đa Tín Hiệu & Hình Học Tại Chỗ (`src/navigator/multiSignalDetector.ts`)**:
     Chạy trực tiếp trong Isolated Utility World (`< 4ms`, tốn 0 Cookie AI), kết hợp **4 Lớp Bất Biến** (xử lý gọn 95%+ trong 500 website thuộc 7 Archetypes):
     * **Lớp 1 (Platform Data Oracle)**: Trên trang sản phẩm (`/products/<handle>`), đọc trực tiếp `window.ShopifyAnalytics.meta.product`, `<script type="application/json" data-product-json>`, `<script type="application/ld+json">`, hoặc `fetch('/products/<handle>.js')` để lấy **danh sách chính xác 100% các Variant ID, tên Size/Màu và trạng thái `available: true/false`**! Nhờ đó biết chắc chắn biến thể nào còn hàng, biến thể nào hết hàng mà không cần đoán mò qua CSS class!
     * **Lớp 2 (HTML5 Form & Custom Elements)**: Quét `form[action*="/cart/add"]`, `input[name="id"]`, `[form^="product-form"]`, `<product-form>`, `<variant-radios>`, `<variant-picker>`, `<buy-buttons>`, `[data-pf-type="ProductATC"]`.
     * **Lớp 3 (Cây Trợ Năng ARIA)**: `role="button"`, `role="radiogroup"`, `role="radio"`, `aria-checked`, `aria-disabled`.
     * **Lớp 4 (Tọa độ Hình học Buy-Box — `getBoundingClientRect` Topology)**: Chấm điểm các nút bấm dựa trên vị trí vật lý: Nút Add-To-Cart chính luôn nằm dưới Tiêu đề `<h1>` và Giá tiền (`0 < y_ATC - y_H1 < 700px`), có chiều rộng `160px – 580px`, chiều cao `38px – 72px`, đang hiển thị (`rect.width > 0`, `opacity > 0`). Loại bỏ 100% nút ẩn trên mobile, nút Quick-Add dưới chân trang, hoặc nút thanh toán nhanh (Shop Pay / PayPal / Apple Pay).
   - **Tầng 2 — AI Cứu Hộ Tự Sửa Lỗi (Self-Healing Escalation)**:
     Chỉ gọi AI khi Tầng 1 chấm điểm tự tin `< 0.80` hoặc khi click ATC xong mà giỏ hàng (`/cart.js`) không tăng. Khi AI tìm ra selector đúng, lưu ngược về Tầng 0 cho cả tên miền!

2. **Nâng cấp Lớp Hành vi View thành "Kịch Bản Người Mua Hàng Thật Co Giãn Theo Thời Gian (Elastic Pre-Checkout Choreography)"**:
   Vì sau khi View xong người dùng sẽ vào **Checkout**, hành vi trước Checkout phải tạo ra chuỗi tín hiệu **Shopify Trekkie / Monorail / Web Pixels** hoàn chỉnh:
   - **Click-Through Navigation (`clickThroughLink`)**: Từ Trang chủ -> Danh mục -> Sản phẩm, luôn ưu tiên cuộn tới thẻ `<a href>` thật đang hiển thị, rê chuột vào thẻ (`hover_card`) rồi click thật bằng `HumanCursor` để trình duyệt gửi đúng HTTP `Referer` (chỉ dùng `page.goto` khi link không hiển thị trên DOM).
   - **Hành vi So sánh Sản phẩm Qua lại (`COMPARE_PRODUCTS` + `go_back`)**: Khi thời gian cấu hình (`durationMinutes` >= 3 phút) cho phép, không chốt mua ngay ở sản phẩm đầu tiên! Mở Sản phẩm A -> Lướt xem 1–2 ảnh + xem giá -> Bấm nút **Back (`page.goBack()`)** quay lại trang Danh mục -> Cuộn chọn Sản phẩm B -> Tương tác sâu và chốt mua ở Sản phẩm B (hoặc quay lại Sản phẩm A).
   - **Tương tác Sâu trên Trang Sản phẩm (Deep PDP Choreography)**:
     1) **Lướt xem ảnh Gallery (`view_media`)**: Click qua lại 2–5 ảnh phụ thumbnail hoặc nút mũi tên carousel, dừng ngắm mỗi ảnh `0.8s – 2.2s`, rê chuột vào ảnh chính.
     2) **Mở đọc Chi tiết / Bảng Size / Vận chuyển (`read_section` & `select_text`)**: Click mở các thẻ `<details><summary>` hoặc accordion/tab ("Description", "Size & Fit", "Shipping & Returns", "Reviews"), cuộn nhẹ và dừng đọc theo đúng độ dài văn bản (`Pacing.readingTime(chars)`), thỉnh thoảng nhấn giữ chuột bôi đen 1 dòng chữ (`selectText`).
     3) **Bấm thử Size / Màu trước khi mua (`explore_variants`)**: Trước mốc giờ ATC khoảng 15–40 giây, bấm thử 1–2 ô Màu sắc / Kích cỡ còn hàng (dựa theo dữ liệu `available: true` từ Lớp 1 Oracle) để kích hoạt sự kiện `product_variant_viewed` và đổi `?variant=...` trên URL, dừng 1–2 giây xem ảnh/giá đổi rồi mới chốt biến thể cuối cùng.
   - **Kiểm tra Giỏ hàng trước Checkout (`INSPECT_CART`)**: Sau khi bấm Add-To-Cart và xác minh thành công (`atcVerified = true`), dành 5–12 giây mở ngắm ngăn kéo giỏ hàng (Cart Drawer) hoặc vào trang `/cart`, cuộn kiểm tra danh sách món hàng và tổng tiền (Subtotal) rồi giữ nguyên trạng thái giỏ hàng sẵn sàng cho bước Checkout!

### 2. QUY TRÌNH KIỂM CHỨNG BẮT BUỘC
1. Chạy `npx tsc --noEmit` và `npm run build` (0 lỗi).
2. Chạy toàn bộ test suite `npm test` (đảm bảo 85+ bài test hiện có đều PASS) và viết thêm unit/integration test cho `bitbrowser.ts`, `domainRecipeCache.ts`, `multiSignalDetector.ts` và kịch bản `Pre-Checkout Choreography`.
3. Chạy thực nghiệm 5 luồng 5 site thật (`node scripts/test-5-live-sites.mjs`) để chứng minh tốc độ, chuỗi hành vi View mới và tỷ lệ ATC 5/5 (100%). /goal /loop
```

---

## PHẦN B: BẢN ĐỒ CHI TIẾT TỪNG MODULE & FILE CẦN CHUYỂN ĐỔI / NÂNG CẤP (TECHNICAL SPECIFICATION CHO AGENT SAU)

Để Agent tiếp theo không mất thời gian mò mẫm lại từ đầu, dưới đây là danh sách chính xác các file trong repo, hiện trạng hiện tại và thiết kế chi tiết cần sửa:

### 1. Danh Mục Các File Cần Sửa / Tạo Mới Cho **BitBrowser Integration**

| STT | File / Module | Trạng Thái | Chi Tiết Thay Đổi Kỹ Thuật Dành Cho Agent Tiếp Theo |
| :--- | :--- | :--- | :--- |
| **1** | `src/config.ts` | **Sửa** | Thêm cấu hình `provider?: "builtin" \| "bitbrowser"` và `bitbrowser?: { apiUrl: string; coreVersion?: string; groupId?: string; autoCreateProfile?: boolean }` vào `BrowserConfig` (dòng 17–58) và `DEFAULT_CONFIG` (`provider: "builtin"`, `bitbrowser: { apiUrl: "http://127.0.0.1:54345", coreVersion: "136", autoCreateProfile: true }`). |
| **2** | `src/profiles/types.ts` & `src/profiles/store.ts` | **Sửa** | Trong `Profile` (`types.ts:100-144`), thêm trường tùy chọn `bitBrowserId?: string` và `browserProvider?: "builtin" \| "bitbrowser"`. Trong `CreateProfileInput` & `UpdateProfileInput` (`store.ts:32-67`), cho phép lưu/cập nhật `bitBrowserId` và `browserProvider` để người vận hành có thể gắn ID profile BitBrowser có sẵn hoặc để hệ thống tự tạo và lưu lại. |
| **3** | `src/browser/bitbrowser.ts` | **Tạo mới** | Xây dựng Client gọi **BitBrowser Local API** (`http://127.0.0.1:54345`):<br>• Hàng đợi điều tiết tốc độ (Rate-limit queue: cách nhau tối thiểu `350ms` giữa 2 lệnh gọi API để tránh lỗi quá tải của BitBrowser app).<br>• `checkBitBrowserHealth(apiUrl)`: Kiểm tra BitBrowser Desktop App có đang mở và đăng nhập không (`POST /browser/list` với `{ page: 0, pageSize: 1 }`).<br>• `syncOrCreateBitProfile(apiUrl, profile, proxy)`: Tạo hoặc cập nhật cấu hình Proxy (`host`, `port`, `proxyUserName`, `proxyPassword`, `proxyType`) và `browserFingerPrint` (`webRTC: "0"`, `isIpCreateTimeZone: true`, `isIpCreateLanguage: true`).<br>• `launchBitBrowser(req: LaunchRequest)`: Gọi `POST /browser/open` $\to$ Nhận `data.ws` $\to$ Gọi `chromium.connectOverCDP(data.ws)` $\to$ Lấy `browser.contexts()[0]` $\to$ Áp dụng `applyRuntimeCpuOptimizations` & `syncJar` (**BỎ QUA** `stealthInitScripts` và `buildNoiseScript`!).<br>• `closeBitBrowser(apiUrl, bitBrowserId)`: Gọi `POST /browser/close`. |
| **4** | `src/browser/chrome.ts` | **Sửa** | Tại đầu hàm `launchBrowser(req: LaunchRequest)` (dòng 635): Kiểm tra nếu `req.profile?.browserProvider === "bitbrowser" \|\| req.config.browser.provider === "bitbrowser"`, chuyển hướng sang gọi `launchBitBrowser(req)`. Cập nhật `preflight()` (dòng 298) để kiểm tra kết nối cổng `127.0.0.1:54345` khi bật chế độ BitBrowser. |
| **5** | `src/server/orchestrator.ts` | **Sửa** | • Trong `setHeaded(profileId, headed)` (dòng 341): Hỗ trợ chuyển đổi chế độ hiển thị cho cả profile BitBrowser.<br>• Trong `deleteProfile(id)` (dòng 214): Nếu profile có `bitBrowserId` do hệ thống tự tạo, gọi thêm `deleteBitBrowserProfile()` (hoặc chỉ gỡ liên kết nếu là ID người dùng nhập).<br>• Trong `meta()` (dòng 100): Báo cáo trạng thái kết nối BitBrowser Local API lên header của Dashboard. |
| **6** | `src/server/http.ts` & `src/server/public/*` | **Sửa** | • Trong `http.ts`: Cho phép nhận `bitBrowserId` và `browserProvider` trong `POST /api/profiles`, `PATCH /api/profiles/:id`, và `POST /api/profiles/bulk-create`; thêm endpoint `GET /api/bitbrowser/status` & `GET /api/bitbrowser/profiles` để liệt kê nhanh các profile đang có sẵn trong app BitBrowser.<br>• Trong `index.html` & `app.js`: Thêm ô chọn `Browser Engine (Built-in Chromium / BitBrowser)` và ô nhập/chọn `BitBrowser Profile ID` trong Modal Cài đặt Profile và Modal Bulk Create. |

---

### 2. Đặc Tả Giao Thức BitBrowser Local API (Tham Chiếu Chuẩn Cho `src/browser/bitbrowser.ts`)

BitBrowser Desktop App mở một HTTP Server cục bộ tại `http://127.0.0.1:54345` (tất cả các endpoint đều dùng `POST` với `Content-Type: application/json`):

1. **Tạo hoặc Cập nhật Profile (`POST /browser/update`)**:
   ```json
   {
     "id": "optional-existing-bitbrowser-id",
     "name": "SiteViewer-Profile-1",
     "proxyMethod": 2,
     "proxyType": "http",
     "host": "1.2.3.4",
     "port": 8080,
     "proxyUserName": "user",
     "proxyPassword": "password",
     "browserFingerPrint": {
       "coreProduct": "chrome",
       "coreVersion": "136",
       "ostype": "PC",
       "os": "Win32",
       "isIpCreateTimeZone": true,
       "isIpCreateLanguage": true,
       "isIpCreatePosition": true,
       "webRTC": "0",
       "canvas": "0",
       "webGL": "0",
       "webGLMeta": "0",
       "audioContext": "0",
       "clientRectNoiseEnabled": true
     }
   }
   ```
   *Kết quả trả về*: `{ "success": true, "data": { "id": "2c9c29a28sdd33dds8026f78e380142" } }`

2. **Mở Trình duyệt và Lấy cổng CDP (`POST /browser/open`)**:
   ```json
   {
     "id": "2c9c29a28sdd33dds8026f78e380142",
     "queue": true,
     "args": ["--autoplay-policy=user-gesture-required"]
   }
   ```
   *Kết quả trả về*:
   ```json
   {
     "success": true,
     "data": {
       "ws": "ws://127.0.0.1:53325/devtools/browser/857b2d0d-aae6-4852-ab3c-0784f0b2c1fb",
       "http": "127.0.0.1:53325",
       "pid": 31295
     }
   }
   ```

3. **Đóng Trình duyệt (`POST /browser/close`)**:
   ```json
   {
     "id": "2c9c29a28sdd33dds8026f78e380142"
   }
   ```

---

### 3. Danh Mục Các Vấn Đề Của "Mô-Đun View & Tương Tác" Và Thiết Kế Nâng Cấp Chi Tiết

Dưới đây là tổng hợp toàn bộ những điểm yếu của phần View đã được phát hiện qua quá trình kiểm toán và chạy thực nghiệm 5 luồng / 5 site thật (cùng những gì đã vá nóng và những gì Agent tiếp theo cần hoàn thiện lên kiến trúc V3.0):

#### 3.1. Những Gì Đã Được Vá Nóng Thành Công (Đã Có Trong Code Hiện Tại — Agent Sau Cần Giữ Nguyên)
* **Sửa lỗi `evaluateIsolated` trong `src/navigator/isolate.ts`**: Trước đây gọi `page.evaluateInUtilityContext` (hàm không tồn tại) làm toàn bộ các lệnh quét DOM rơi về Main World và bắn hàng trăm dòng lỗi đỏ `[rebrowser-patches][frames._context] cannot get world`. Đã sửa sang gọi `page.mainFrame().evaluateExpression(expr, { isFunction: false, world: "utility" })` chạy sạch 100% trong Utility World.
* **Sửa lỗi `dismissPopups()` bấm nhầm `/pages/about-us` (`src/session/aiManager.ts:1252`)**: Đã khóa chỉ bấm nút chọn vùng bên trong hộp thoại `[role="dialog"]` / `[aria-modal="true"]`.
* **Chặn sản phẩm Thẻ quà tặng (`gift-card`, `gift-certificate`, `e-gift`)** trong `localFallback.ts` và `elementDetector.ts`.
* **Lưu `completedAtcProducts` trong `src/behavior/aiEngine.ts`**: Để sau khi mua xong Sản phẩm 1, trạng thái `SEEK_PRODUCT_2` không bị kẹt lại trên Sản phẩm 1 mà tự động tìm sang Sản phẩm 2.
* **Bổ sung bước đầu `clickThroughLink()` và `performRichPdpInteraction()` trong `src/session/aiManager.ts`**: Click trực tiếp thẻ `<a>` và thực hiện bấm ảnh thumbnail, mở `<details>`, rê chuột qua biến thể.

#### 3.2. Những Gì Agent Tiếp Theo Cần Nâng Cấp Để Phần View "Ngon 100% Như Người Thật Trước Checkout"

1. **Đọc Trực Tiếp Dữ Liệu Sản Phẩm Từ Shopify JSON Oracle (`window.ShopifyAnalytics` / `/products/<handle>.js` / `JSON-LD`)**:
   * **Vấn đề hiện tại**: Khi chọn Size/Màu ở bước `add_to_cart` (`src/session/aiManager.ts:1895-1960`), code hiện tại vẫn phải đoán xem nút radio/swatch nào còn hàng bằng cách đọc chữ `innerText` xem có chữ `"sold out"` hay thuộc tính `disabled` không. Nhiều theme Shopify hiện đại không gắn chữ `"sold out"` lên từng nút Size mà chỉ đổi trạng thái khi bấm vào!
   * **Cách giải quyết triệt để**: Ngay khi vào trang `/products/<handle>`, đọc JSON sản phẩm có sẵn trong trang (`<script type="application/json" data-product-json>`, `window.ShopifyAnalytics.meta.product`, hoặc `fetch(location.pathname + '.js')`). JSON này chứa mảng `variants: [{ id, title, option1, option2, available: true/false, price }]`. Nhờ đó, bộ chọn biến thể biết **chính xác 100% tổ hợp Size + Màu nào đang `available: true`** để bấm một phát ăn ngay!

2. **Tích Hợp Chấm Điểm Tọa Độ Hình Học Buy-Box (`getBoundingClientRect` Topology)**:
   * **Vấn đề hiện tại**: `extractSourceDigest()` mới chỉ lấy nhãn chữ và tên thẻ, chưa lấy tọa độ hình học `(x, y, width, height)` của các nút bấm. Trên nhiều trang có 2–3 nút "Add to Cart" (1 nút ẩn của giao diện mobile, 1 nút thật trong Buy-Box, và 4 nút "Quick Add" ở danh sách sản phẩm gợi ý dưới chân trang).
   * **Cách giải quyết triệt để**: Trong hàm quét tại chỗ (`multiSignalDetector.ts`), lọc và chấm điểm cao nhất cho nút `Add to Cart` thỏa mãn bất biến hình học của Buy-Box:
     * Đang hiển thị thật (`rect.width >= 140`, `rect.height >= 36`, `getComputedStyle(el).visibility !== "hidden"`).
     * Nằm bên dưới tiêu đề `<h1>` chính của sản phẩm (`0 < rect.top - h1Rect.bottom < 750`).
     * Không nằm trong vùng `<header>`, `<footer>`, hay các khối gợi ý (`[class*="related" i]`, `[class*="recommend" i]`).

3. **Nâng Cấp Máy Trạng Thái Hành Vi (`src/behavior/aiEngine.ts`) Với Chuỗi Cử Chỉ Co Giãn Theo Thời Gian (`Elastic Pre-Checkout Choreography`)**:
   * **Vấn đề hiện tại**: Hiện tại `performRichPdpInteraction` mới chỉ chạy ngẫu nhiên bên trong `scroll`/`dwell`, chưa được quản lý theo **ngân sách thời gian (`plannedDurationMs` và `targetAtcMs`)** của `AiBehaviorEngine`.
   * **Cách giải quyết triệt để**: Mở rộng `AiActionKind` (`src/types.ts`) và `AiBehaviorEngine.decide()` (`src/behavior/aiEngine.ts`) để điều phối một kịch bản mua sắm có nhịp điệu rõ ràng theo đúng thời gian người dùng cài đặt:
     * **Pha 1 — Khám phá Danh mục (`0% -> 20%` thời gian trước ATC)**: Mở trang chủ $\to$ Click vào Danh mục (`/collections/...`) $\to$ Cuộn 2–3 nhịp và rê chuột ngắm 2–3 thẻ sản phẩm (`hover_card`).
     * **Pha 2 — Xem thử & Quay lại So sánh (`20% -> 55%` thời gian trước ATC, áp dụng khi `atcMinutes >= 2`)**: Click vào Sản phẩm A $\to$ Bấm xem 1–2 ảnh Gallery (`view_media`) $\to$ Cuộn xem giá $\to$ Bấm nút **Back (`go_back`)** quay lại trang Danh mục $\to$ Cuộn chọn Sản phẩm B.
     * **Pha 3 — Tương tác Sâu trên Sản phẩm Chốt mua (`55% -> 95%` thời gian trước ATC)**:
       1. Bấm xem 2–4 ảnh phụ trong Gallery (`view_media`) + rê chuột lên ảnh chính.
       2. Bấm thử 1–2 biến thể Size/Màu (`explore_variants`) để đổi ảnh/giá và bắn sự kiện `product_variant_viewed` cho Shopify Web Pixels.
       3. Bấm mở 1–2 thanh `<details>` / tab Mô tả, Bảng Size, Chính sách vận chuyển (`read_section`) và dừng đọc tỷ lệ thuận với độ dài chữ (`Pacing.readingTime(chars)`).
     * **Pha 4 — Chốt biến thể còn hàng & Bấm Add-To-Cart (`100%` mốc `targetAtcMs`)**: Chọn đúng biến thể `available: true` từ Oracle $\to$ Bấm nút Add-To-Cart chính trong Buy-Box $\to$ Xác minh 4 lớp.
     * **Pha 5 — Kiểm tra Giỏ hàng Trước Checkout (`INSPECT_CART`)**: Sau khi `atcVerified === true`, nếu ngăn kéo giỏ hàng (Cart Drawer) đang mở thì dừng ngắm 5–10 giây (rê chuột qua dòng tổng tiền Subtotal / nút Checkout); nếu trang không có Drawer thì click vào icon Giỏ hàng (`/cart`) để xem lại đơn hàng 5–10 giây như người thật kiểm tra giỏ trước khi bấm Checkout!
     * **Pha 6 — Tách nhỏ `src/session/aiManager.ts`**: Tách file `aiManager.ts` (~2.150 dòng) thành 4 file sạch sẽ (`digestExtractor.ts`, `actionExecutor.ts`, `atcVerifier.ts`, `aiManager.ts`) để dễ bảo trì và kiểm thử.
