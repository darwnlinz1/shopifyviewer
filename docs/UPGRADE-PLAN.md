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

### Done

- Baseline imported onto `claude/profile-dashboard-upgrades-7cn0kn`.
- `src/profiles/types.ts` — profile/session domain model, `ordinal` ordering key.
- `src/profiles/cookies.ts` — cookie import for Playwright `storageState`,
  EditThisCookie/Cookie-Editor JSON arrays and Netscape `cookies.txt`;
  format detected from content, expiry/sameSite normalised across exporters.
- `src/profiles/proxy.ts` — proxy parsing (URL form and vendor
  `host:port:user:pass` form), validation, redaction, and a real connectivity
  test that reports the exit IP.
- `src/profiles/store.ts` — persisted registry, atomic writes, stable
  `ordinal` ordering, pinned per-profile identity, lifetime stats.

### Remaining

1. `src/browser/identity.ts` + `cloak.ts` rewrite — pinned fingerprint,
   cookie injection via `contextOptions.storageState`, proxy credential split,
   `validateLicense` / `ensureBinary` preflight, `humanConfig` wiring.
2. `src/session/manager.ts` — **linger**: stop closing the browser when the
   timer expires; hold it open in `lingering` until the operator says
   otherwise. Plus pause / resume / stop / extend.
3. `src/server/screencast.ts` — CDP screencast, dual-quality frame taps.
4. `src/server/orchestrator.ts` — profiles ↔ live sessions, event bus.
5. `src/server/http.ts` — REST + SSE + MJPEG + static.
6. `src/server/public/*` — the grid described above.
7. `pageNavigator.ts` — wheel scrolling, cursor idle drift, content-scaled
   reading time; `src/behavior/timing.ts` for log-normal delays.
8. `cli.ts` — `dashboard` and `verify` commands.
9. Tests + README.
