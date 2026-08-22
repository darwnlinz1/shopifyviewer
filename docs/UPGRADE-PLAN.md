# Upgrade plan — profile dashboard

Working notes for the multi-profile upgrade. Written mid-build so the design
decisions and the audit findings survive the session.

---

## Dashboard specification

The dashboard manages **many** profiles at once, so the grid is the primary
view and a tile is a *monitor*, not a control panel.

- **Every tile streams live, always.** No click required. A tile is a small,
  low-resolution, low-frame-rate view of that profile's browser — legible
  enough to see the page moving and scrolling, cheap enough to run dozens at
  once. The reference point is a cloud-phone console (Redfinger and similar):
  a wall of small live screens.
- **Clicking a tile enlarges it** into a full-size live view. Un-clicked tiles
  keep streaming at thumbnail quality; they never freeze.
- **Tiles never move.** Position is fixed by `Profile.ordinal`, assigned once
  at creation and never sorted on again. This is the layout half of the
  card-jumping bug.
- **Fixed tile geometry.** Every tile is the same size regardless of status,
  proxy length or error text; overflowing content scrolls inside the tile
  rather than growing it. This is the sizing half of the same bug.
- **In-place DOM updates.** State changes patch the existing tile's fields;
  tiles are never destroyed and re-created on a state push. This is the
  rendering half of the same bug.

### Streaming design

Frames come from CDP `Page.startScreencast` on each session's page, which
works headless and headed alike:

| | Thumbnail (grid) | Enlarged (focused tile) |
| --- | --- | --- |
| Format | JPEG | JPEG |
| Quality | ~30 | ~70 |
| Max size | 320×200 | 1280×800 |
| Frame rate | ~2 fps | ~10 fps |

Delivered as `multipart/x-mixed-replace` (MJPEG) on
`GET /api/sessions/:id/stream.mjpg?mode=thumb|full`, consumed by a plain
`<img src=…>`. No client-side decoding, no WebSocket, no dependency.

Per-profile status/metrics ride a separate SSE channel so text updates do not
wait on frames.

---

## Findings: behaviour timing

Audited against `src/behavior/engine.ts`, `src/navigator/pageNavigator.ts` and
`src/util/random.ts`.

Delays **do** exist and are structurally sound — `actionPause` 800–3500 ms,
`pageSettle` 1200–4000 ms, `scrollPause` 400–2200 ms, `mediaDwell` 900–3200 ms,
`sectionDwell` 1500–5000 ms — and every draw is seeded, so runs replay. The
gaps are in *shape*, not presence:

1. **Every delay is uniform.** `Rng.float(min,max)` gives a flat histogram.
   Human inter-action gaps are heavy-tailed (log-normal): mostly short, with
   occasional long pauses. A flat distribution over 800–3500 ms is itself a
   distinguishing feature.
2. **Reading time ignores content.** `sectionDwell` is drawn from the same
   range for a two-line shipping blurb and a thousand-word description. Real
   dwell scales with how much text is there.
3. **No autocorrelation, no session arc.** Draws are i.i.d.; minute 14 is paced
   exactly like minute 1. Real sessions drift — settling in, then tiring.
4. **The cursor never moves.** `dwell()` is a bare `sleep()`. Across a 15-minute
   session the pointer is motionless except during `hover_variants`.
5. **`noteAction` counts failed actions** (`manager.ts:136`) — it runs after
   `executeDecision` regardless of outcome, so a failed navigation still
   inflates `pageActions` and pushes the engine off the page early.

## Findings: CloakBrowser integration

Audited against the installed `cloakbrowser@0.5.8` type definitions
(`LaunchPersistentContextOptions`, `human/config.d.ts`, `human/index.d.ts`).

The humanize layer patches interaction methods — `click`, `hover`, `type`,
`fill`, `press`, `selectOption`, `tap`, `dragTo`, `scrollIntoViewIfNeeded` and
the ElementHandle equivalents. It does **not** patch anything reached through
`page.evaluate`.

1. **Scrolling bypasses the human layer entirely.** `pageNavigator.scroll()`
   calls `page.evaluate(() => window.scrollBy({behavior:"smooth"}))`. That
   dispatches **zero** `wheel` events and never enters CloakBrowser's
   accelerate → cruise → decelerate → overshoot scroll model. Scrolling is the
   most frequent action in the entire session, `humanize: true` is set, and
   none of it applies. Fix: drive `page.mouse.wheel()`.
2. **Observation leans on `page.evaluate`.** `detectPageType`, `readGeometry`,
   `collectLinks` and `collectMetrics` run 4+ evaluates per step. The package
   ships an isolated-world reader (`Page.createIsolatedWorld`, exposed as
   `page._stealth`) precisely because `page.evaluate` is the detectable path —
   its own keyboard module notes "falls back to page.evaluate (detectable)".
3. **`humanConfig` is never passed.** `HumanConfig` exposes the full timing
   model — `idle_between_actions`, `idle_between_duration`, `scroll_delta_base`,
   `scroll_accel_steps`, `scroll_overshoot_chance`, `scroll_settle_delay`,
   `idle_drift_px`, `idle_pause_range`. The project reimplements a parallel
   timing model in `behavior` config and leaves the browser's own unused.
4. **`humanIdle` is never called** — exported for exactly the idle-drift gap
   above.
5. **`contextOptions` is never used** — it is the documented route for
   `storageState` (cookies), `httpCredentials`, `geolocation` and
   `permissions`. Note its documented caveat: `locale`/`timezoneId` are
   stripped there on purpose and must go through the top-level fields, which
   route to undetectable binary flags rather than CDP emulation.
6. **The fingerprint is not stable per profile.** `cloak.ts:78` re-draws the
   viewport from the pool on every launch, so `slot-0` keeps its cookies but
   arrives with a different screen size each run — a returning visitor whose
   monitor changes.
7. **Proxy credentials break on the fallback path.** CloakBrowser accepts
   `http://user:pass@host:port` and extracts credentials itself; the
   playwright-core fallback is handed `{ server: proxy }` with the credentials
   still inline, which Playwright will not authenticate with.
8. **`validateLicense` is never called.** Free tier allows one concurrent
   session; `--concurrency 3` currently fails deep inside a launch with a
   generic error instead of being reported up front.
9. **`ensureBinary` is never called.** N parallel sessions each race to
   provision the ~1 GB binary on first run.
10. **Timezone/locale can contradict the proxy.** Config pins `Europe/Paris` +
    `fr-FR` with `geoip: false`; a proxy exiting elsewhere leaves JS timezone
    and IP geolocation disagreeing.
11. **`headless: true` is the default** — and is also incompatible with the
    requirement to watch the browsers work.

**Not answered here:** whether a given storefront's bot mitigation flags a
given run. That depends on the shop's own protection settings and changes
week to week; the tool's job is to be measurable and honest about what it
sends, and the `verify` command below reports what the browser actually
exposes so the operator can check rather than guess.

---

## Status

All items in this plan are implemented. `npm run build` and `npm test` pass
(48 tests, four of which drive a real browser).

### Delivered

| Area | Where |
| --- | --- |
| Profile registry, stable ordering, pinned identity | `src/profiles/store.ts`, `types.ts` |
| Cookie import (storageState / JSON array / Netscape) | `src/profiles/cookies.ts` |
| Proxy parse, validate, redact, live test | `src/profiles/proxy.ts` |
| Log-normal delays, tempo, fatigue, reading time | `src/behavior/timing.ts` |
| Per-profile fingerprint and humanConfig | `src/browser/identity.ts` |
| Cookie injection, proxy credentials, preflight, geoip | `src/browser/cloak.ts` |
| Wheel scrolling, cursor drift, content-scaled reads | `src/navigator/pageNavigator.ts` |
| Linger, pause/resume/extend/park, responsive close | `src/session/manager.ts` |
| CDP screencast, dual quality | `src/server/screencast.ts` |
| Orchestration, REST, SSE, MJPEG | `src/server/orchestrator.ts`, `http.ts` |
| Dashboard grid | `src/server/public/` |
| Fingerprint self-check | `src/browser/verify.ts` |

### Bugs found and fixed along the way

1. **Session cookies from `cookies.txt` were being discarded.** Netscape uses
   expiry `0` for a session cookie; `Date.parse("0")` yields the year 2000, so
   every one of them was then dropped as expired. Caught by a test.
2. **Garbage passed proxy validation.** `new URL()` accepts `http://!!!` with a
   hostname of `!!!`, so an unusable proxy saved cleanly and only failed once a
   session tried to use it. Now host-validated.
3. **`.gitignore` swallowed `src/profiles/`.** The unanchored `profiles/`
   pattern matched at any depth, so the whole new module was silently
   untracked on its first commit.
4. **Failed actions counted toward the page budget.** A run of failed
   navigations pushed the engine off a page it had barely looked at.
5. **Close was unresponsive.** The loop only checks for a close request between
   turns, and a turn can sit in a 45-second navigation, so the dashboard's
   Close button appeared dead. It now force-closes after a short grace period.

### Not done

- No isolated-world migration for the observation reads. `observe()` still uses
  `page.evaluate` for geometry, link collection and page-type detection.
  Finding 2 in the audit above stands: the package exposes an isolated-world
  reader internally (`page._stealth`), but it is not part of its public API, so
  using it would mean reaching into internals that can change between releases.
  The per-step scroll evaluates are gone, which was the high-frequency case.
- No `--headed` window tiling. Headed mode opens windows wherever the OS puts
  them; the dashboard's live view is the intended way to watch many at once.

---

## Round 2 — operational fixes

Three problems reported from real use, all real, all fixed.

### 1. Scrolling teleported to the bottom, then froze

`mouse.wheel(0, 450)` is **one** wheel event carrying a 450-pixel delta, and
the browser applies all of it at once. Round 1 swapped `window.scrollBy` for
`mouse.wheel` to get genuine input events and, without meaning to, traded
smooth-but-invisible motion for real-but-instant motion.

Gestures are now emitted the way a hand produces them: a burst of small ticks,
roughly a notch each, tens of milliseconds apart, easing in and out across the
gesture, with an occasional overshoot and correction. Measured on a 2466px
page: **24 distinct scroll positions, no 25ms window moving more than 185px.**

The freeze afterwards was separate: scrolling down at the bottom of a page does
nothing at all, so the tile looked dead. A gesture that would be a no-op now
turns around instead.

### 2. Navigation never clicked anything

Every page change went through `page.goto(url)` — the address bar. A visitor on
a collection page clicks the product card; they do not type its URL. The
difference is visible from the server: a click sends a `Referer`, `goto` sends
nothing.

`navigateTo()` now locates the anchor on the current page, scrolls it into view
and clicks it, falling back to `goto()` only where the page genuinely offers no
link. This also routes navigation through CloakBrowser's human layer, since
`click` and `scrollIntoViewIfNeeded` are among the methods it patches.

Verified: the destination reports `document.referrer` = the previous page, the
click lands on the intended anchor, and the event reports `isTrusted: true` —
real input, not a synthesised event.

Clicking *within* a page (gallery thumbnails, accordions) was already there and
still is; a test now guards it.

### 3. Live tiles rendered blank

Frames were arriving and decoding — the failure was on the wire. Chromium only
emits a screencast frame when the page repaints, and a browser rendering
`multipart/x-mixed-replace` only paints a part once the **next** boundary
arrives. A session resting on a static product page therefore left its tile
blank while the server held a perfectly good frame.

The stream now re-sends the last frame on a slow cadence, flushing the pending
part and keeping the connection warm. Also: the tile `<img>` is no longer
`loading="lazy"`, and the view uses `object-fit: contain` — the capture's
aspect ratio follows the browser window, and on a monitoring wall a cropped
edge hides exactly what you were watching for.

### Also in round 2

- Dashboard redesign: fleet counters, text and status filters, bulk
  start/pause/close, per-tile progress bars, toasts, a real empty state.
- Documented that browsers are **headless by default** — the wall runs in the
  background and the live view does not depend on visible windows.
- Fixed a launch failure introduced in round 1: auto-geoip needs the optional
  `mmdb-lib` peer dependency, so adding a proxy to a profile stopped it opening
  at all. It is now a direct dependency, and the launcher degrades to the
  configured timezone rather than refusing to start.

**59 tests, all passing.** `npm run build` and typecheck clean.

## Still open

- The observation reads (`observe()`, page-type detection, link collection)
  still use `page.evaluate`. The package exposes an isolated-world reader
  internally but not as public API. The per-scroll-step evaluates — the
  high-frequency case — are gone.
- No real-storefront or real-CloakBrowser-binary run: this environment cannot
  fetch the 1 GB patched Chromium, so all browser tests run stock Chromium
  through the fallback path.
- Operational/reporting upgrade ideas: not written yet.
