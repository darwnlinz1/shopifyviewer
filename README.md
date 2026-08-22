# Shopify Storefront Behaviour Simulator

Synthetic user-flow testing for a Shopify storefront. The tool drives a real
browser through a realistic ~15 minute browsing session — homepage, collection,
products, scrolling, imagery, back/forward — and records what the storefront did:
navigation, rendering, page-load timings, JavaScript errors and failed requests.

The browser layer is [CloakBrowser](https://github.com/CloakHQ/cloakbrowser)'s
patched Chromium, driven through Playwright.

Sessions run from the CLI, or from a **dashboard** that manages many browser
profiles at once and streams each one live.

> This is a **read-only** testing tool. It never adds to cart, never touches
> checkout or account pages, and stays pinned to the host you point it at.

---

## Architecture

```
CloakBrowser → Session Manager → Playwright → Page Navigator
             → Behaviour Engine → Timer → Logger
```

| Layer | File | Responsibility |
| --- | --- | --- |
| **CloakBrowser adapter** | `src/browser/cloak.ts` | Launches the patched Chromium with a persistent profile, proxy, viewport and the human-input layer. Returns a plain Playwright `BrowserContext`. |
| **Session Manager** | `src/session/manager.ts` | Runs one session's loop: observe → decide → execute → pause. Owns setup and teardown. |
| **Page Navigator** | `src/navigator/pageNavigator.ts` | The only layer that touches Playwright. Navigates, measures page load, classifies the page, observes its content, and performs browsing gestures. |
| **Behaviour Engine** | `src/behavior/engine.ts` | The state machine. Decides the next action from the live page observation plus session state. |
| **Session Timer** | `src/session/timer.ts` | Owns the ~15 minute budget and exposes phase/remaining so the engine can wind down. |
| **Logger** | `src/logging/logger.ts` | Structured JSONL + console output: URL, action, timestamp, page load, errors. |
| **Runner** | `src/session/runner.ts` | Runs N independent sessions with bounded concurrency and writes the run summary. |
| **Profile store** | `src/profiles/` | The profile registry, cookie import and proxy handling. |
| **Orchestrator** | `src/server/orchestrator.ts` | Profiles on one side, live sessions and their screencast taps on the other. |
| **Dashboard** | `src/server/` | HTTP API, SSE state channel, MJPEG live views, and the UI. |

### Behaviour Engine

The engine is a **state machine, not a fixed script**. Every step it receives a
fresh `PageObservation` — what is actually on the page right now — and picks
from the options that page genuinely offers, weighted by session state:

```
START ──▶ HOME ──▶ COLLECTION ──▶ PRODUCT ──▶ BROWSE ──▶ PRODUCT ──▶ … ──▶ EXIT
             ▲          │  ▲          │  │                 │
             └──────────┘  └──────────┘  └── back/forward ──┘
```

States: `START · HOME · COLLECTION · PRODUCT · BROWSE · EXIT`

Two things keep sessions from looking identical:

1. **Content-driven transitions.** `syncState()` re-anchors the machine to the
   page actually loaded, so after a Back, a redirect, or a theme quirk the state
   follows reality rather than what the last decision assumed.
2. **Weighted choice.** Both on-page actions (scroll, view media, read section,
   inspect details, hover variants, dwell) and navigations are drawn by weight
   from what the observation reports as available. A product page with no
   gallery never gets a `view_media`; a page with three accordions can get
   several `read_section`s.

Every random draw goes through one seeded RNG, so `--seed 42` replays a session
exactly — which matters when a run surfaces a bug you need to reproduce.

---

## Install

```bash
npm install
npx cloakbrowser install    # fetch the patched Chromium binary (~1 GB, first run only)
npm run build
```

Node 20+ required.

---

## Usage

```bash
# 0. Manage many profiles from a browser, each with a live view
npx tsx src/cli.ts dashboard

# 1. Check the tool can see your theme's elements
npx tsx src/cli.ts probe --storefront https://your-shop.com

# 2. Run a single 15-minute session
npx tsx src/cli.ts run --storefront https://your-shop.com

# 3. Run three independent sessions in parallel
npx tsx src/cli.ts run --storefront https://your-shop.com --sessions 3 --concurrency 3

# 4. Reproduce a specific session
npx tsx src/cli.ts run --seed 42 --headed
```

After `npm run build`, use `node dist/cli.js …` instead of `npx tsx src/cli.ts …`.

### Commands

| Command | What it does |
| --- | --- |
| `dashboard` | Manages many browser profiles from a live web UI. |
| `run` | Runs simulated browsing sessions (default). |
| `probe` | Loads home / collection / product and reports which selectors matched. Run this first against a new shop. |
| `verify` | Reports what the browser exposes to a page, and flags contradictions. |
| `info` | Reports CloakBrowser binary status. |
| `init` | Writes a starter `storefront-sim.config.json`. |

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--storefront <url>` | — | Storefront base URL |
| `--sessions <n>` | `1` | Number of sessions |
| `--concurrency <n>` | `1` | Sessions in parallel |
| `--duration <min>` | `15` | Session length in minutes |
| `--seed <n>` | random | Deterministic seed |
| `--config <path>` | `storefront-sim.config.json` | Config file |
| `--profile-dir <path>` | `./profiles` | Persistent profile directory |
| `--log-dir <path>` | `./logs` | Log output directory |
| `--log-level <level>` | `info` | `debug` / `info` / `warn` / `error` |
| `--proxy <url>` | — | Proxy URL, repeatable (one per session slot) |
| `--headed` | off | Visible browser window |
| `--fresh-profiles` | off | Don't reuse profiles between runs |
| `--allow-fallback` | off | Allow stock Chromium if CloakBrowser is unavailable |
| `--headed` | off | Open real OS windows too. The live view works without it. |
| `--linger <min>` | `0` | Hold the browser open after the budget is spent (`-1` = until closed) |
| `--port <n>` | `7317` | Dashboard port |
| `--host <addr>` | `127.0.0.1` | Dashboard bind address |
| `--quiet` | off | No console logging |

---

## Dashboard

```bash
npx tsx src/cli.ts dashboard      # http://127.0.0.1:7317
```

### It runs in the background

Browsers are **headless by default**: no Chromium windows open on your desktop,
nothing to keep in the foreground, nothing that breaks when you switch
applications. The live view does not depend on visible windows — CDP captures
what the browser renders either way — so the dashboard shows the same picture
whether or not anything is on screen.

`--headed` additionally opens real OS windows, which is useful for debugging a
single profile by hand. It is not how you would run a wall of them: a dozen
visible Chromium windows fight over focus and the taskbar.

One tile per profile, and **every tile streams its browser live without being
clicked**. Tiles are small and coarse on purpose — a 320x200 JPEG at a couple
of frames a second, enough to see a page scrolling, cheap enough to run a wall
of them. Click one to enlarge it to a full-quality stream; the rest keep
running behind it.

Frames come from CDP `Page.startScreencast` and are served as
`multipart/x-mixed-replace`, so a tile is a plain `<img>` — no WebSocket, no
client-side decoding, and nothing added to the dependency tree. This works in
headless mode too: `--headed` also gives you real OS windows, but the live view
does not depend on them.

### Tiles hold their position

A dashboard whose cards move while you are trying to click one is unusable, so
three things are fixed by construction:

- **Order** comes from each profile's creation ordinal, assigned once. Nothing
  is ever sorted on status, last-run time, or the order sessions finish in.
- **Geometry** is fixed. The live view has a locked aspect ratio and every
  variable-length field — URL, status text, error counts — is fixed-height and
  clipped, so no content can change a tile's footprint.
- **Updates patch in place.** Tiles are created once; a state push updates
  their fields and never rebuilds the grid. This is also what keeps a state
  push from interrupting a running stream.

### Per profile

| | |
| --- | --- |
| **Continue** | Starts an idle profile, resumes a paused one, or gives a spent one more time. |
| **Pause** | Suspends browsing; the browser stays open. |
| **Close** | Closes the browser. The profile, its cookies and its directory remain. |
| **Delete** | Removes the profile, its cookie jar and its user-data directory. |
| **Proxy** | A field with a Save button, plus Test, which opens a real connection and reports the exit IP. |
| **Cookies** | A file picker. Browse to an export and it is parsed and attached. |

### The browser stays open when the timer ends

A session that runs out of budget stops browsing but **does not close its
browser**. It goes to `lingering` and holds its last page until you close it,
so the final state is there to look at. Scripted runs keep the old behaviour:
`--linger` defaults to `0`, and the dashboard sets `-1`.

### Proxies and cookies

Proxies accept either form operators actually have:

```
http://user:pass@gate.example:8080     socks5://gate.example:1080
gate.example:8080:user:pass            gate.example:3128
```

Credentials are split out of the URL, because the stock-Playwright path cannot
authenticate from an inline `user:pass`. They are redacted in every log line.
When a proxy is set and no timezone is pinned, `geoip` turns on automatically
so the browser clock cannot contradict where the traffic exits.

Cookie files are detected by content rather than extension, since exports are
routinely saved under the wrong name:

- Playwright `storageState` — `{ "cookies": [...] }`
- A bare JSON array — EditThisCookie, Cookie-Editor
- Netscape `cookies.txt` — curl, wget, yt-dlp

Expiry and `sameSite` spellings differ between all of these and are normalised.
A file that cannot be parsed is rejected with the reason rather than silently
importing nothing — an empty cookie jar looks exactly like a logged-out
session, which is a miserable thing to debug at run time.

---

## Checking the browser: `verify`

```bash
npx tsx src/cli.ts verify --headed
```

Reports what the browser actually exposes to a page — user agent, platform,
languages, timezone, screen and viewport, WebGL strings, `navigator.webdriver`,
plugin count — and then cross-checks those readings for contradictions:

- a viewport larger than the screen it claims to be on
- a resolved timezone that disagrees with the configured one
- `Intl` locale and `navigator.languages` disagreeing
- a proxy with neither `geoip` nor a pinned timezone, so the clock reports this
  machine's zone regardless of where traffic exits

It reports inconsistencies; it does not score anything or predict what any
particular shop will make of a run. Whether a storefront is satisfied depends
on that shop's own protection settings and changes constantly. A browser
contradicting itself, on the other hand, is a configuration bug whoever is
looking — and that is the part worth fixing.

---

## Persistent profiles

Each session slot gets its own Chromium user-data directory under
`--profile-dir`, so cookies, `localStorage` and cache persist across runs.
Session `N` always reuses `slot-N`, which means a repeat run looks like a
returning visitor rather than a first-time one. `--fresh-profiles` gives every
run a cold profile instead.

Because each session has its own profile and its own browser instance, sessions
never share state — that's what makes them independent samples.

> CloakBrowser's free tier permits **one concurrent session**. Running
> `--concurrency > 1` needs a Pro licence (`CLOAKBROWSER_LICENSE_KEY`).

---

## Output

Console output is one line per event. The full record is JSONL, one file per
session, in `--log-dir`:

```json
{"ts":"2026-08-21T14:26:10.482Z","sessionId":"mt31jxih-0","level":"info","event":"decide",
 "url":"https://shop/collections/all","state":"COLLECTION",
 "msg":"collection → product \"Produit 8\"",
 "data":{"action":"goto_product","remaining":"9m14s","productsViewed":3,"productTarget":6}}
{"ts":"2026-08-21T14:26:10.998Z","sessionId":"mt31jxih-0","level":"info","event":"page_load",
 "url":"https://shop/products/produit-8","msg":"200 in 575ms",
 "data":{"status":200,"elapsedMs":575,"ttfbMs":21,"domContentLoadedMs":57,
         "loadEventMs":60,"firstContentfulPaintMs":112,"jsErrors":0,"failedRequests":0}}
```

Key events: `session_start` · `browser_launch` · `page_load` · `observe` ·
`decide` · `scroll` · `view_media` · `read_section` · `inspect_details` ·
`hover_variants` · `state_change` · `js_error` · `request_failed` ·
`product_incomplete` · `navigation_error` · `session_end`.

A run summary lands in `logs/run-<timestamp>.json` with per-session and
aggregate totals.

### What to look for

| Signal | Meaning |
| --- | --- |
| `js_error` | Uncaught exception — a genuine storefront bug. |
| `console_error` | Console noise (404 favicon, blocked pixel). Tracked separately. |
| `product_incomplete` | A product page rendered without a title, price or description. |
| `http_5xx` | Server error during browsing. |
| `page_load` timings | `ttfbMs`, `firstContentfulPaintMs`, `loadEventMs` per page. |
| `navigation_error` | A navigation timed out or failed. |

---

## What a session actually does

Within its budget the session behaves like a visitor rather than a script:

- **Navigates by clicking.** It finds the anchor for its target on the current
  page, scrolls it into view and clicks it, so the page change carries a
  Referer and arrives through a real cursor movement. `page.goto()` — the
  address bar — is only the fallback for destinations the current page does
  not link to.
- **Scrolls with the wheel**, as a burst of small ticks that ease in and out,
  sometimes overshooting and correcting. Not a jump, and not a scripted
  viewport move: every pixel arrives as real wheel input.
- **Clicks into the page**: gallery thumbnails, accordion sections. Hovers
  variant swatches without selecting one, so the theme's variant JS runs
  without touching cart state.
- **Reads for as long as there is to read.** Dwell time is derived from the
  text actually in the block, not drawn from a fixed range.
- **Paces itself.** Delays are log-normal rather than uniform, with a
  random-walking tempo so consecutive pauses correlate, and a fatigue drift so
  the end of a session is paced differently from the start.
- **Keeps the cursor alive.** It drifts a few pixels while reading instead of
  freezing for the entire session.
- **Winds down.** Once it has seen the products it meant to see and the budget
  is nearly spent, it becomes progressively more likely to leave — so a session
  ends by choosing to, not by being killed mid-action.

Everything above still flows through one seeded RNG, so `--seed 42` replays a
session exactly.

---

## Theme compatibility

Nothing is a single hard-coded selector. Each concept in
`src/navigator/selectors.ts` is a *candidate list*, tried most-specific
(Dawn / Online Store 2.0) to most-generic; the navigator uses the first that
matches. Page type comes from Shopify's own
`ShopifyAnalytics.meta.page.pageType`, falling back to URL shape and then DOM
markers.

If `probe` reports a concept as unmatched, add a selector for it:

```json
{
  "storefront": "https://your-shop.com",
  "selectorOverrides": {
    "productMedia": [".my-theme__gallery-item"]
  }
}
```

Overrides are prepended to the built-in candidates, never replace them.

---

## Configuration

`npx tsx src/cli.ts init` writes a full config with every default. Resolution
order is defaults → config file → CLI flags. Notable sections:

- `session` — `durationMs` (default 15 min), `durationJitterMs`, `count`,
  `concurrency`, `hardTimeoutMs`, `navigationTimeoutMs`.
- `behavior` — pause/scroll/dwell ranges, `targetProducts`, `backProbability`,
  `returnToCollectionProbability`, `maxActionsPerPage`.
- `browser` — `headless`, `profileDir`, `persistProfiles`, `proxies`, `geoip`,
  `humanize`, `humanPreset`, `viewports`, `licenseKey`.
- `safety` — `allowedHosts` (derived from the storefront URL when empty),
  `allowCart` (default `false`), `blockedPathFragments`.

---

## Testing

`test/mockStorefront.mjs` is a self-contained mock Shopify storefront with
Dawn-shaped markup (`/`, `/collections/<handle>`, `/products/<handle>`), used to
exercise the full pipeline without touching a real shop:

```bash
node test/mockStorefront.mjs 4321 &
npx tsx src/cli.ts probe --storefront http://127.0.0.1:4321
npx tsx src/cli.ts run   --storefront http://127.0.0.1:4321 --duration 2
```

The automated suite runs against it:

```bash
npm test
```

`test/session.test.mjs` drives a real browser and covers the parts that only
exist at run time: that a spent session keeps its browser open, that pause and
resume do not close it, and that the screencast produces decodable JPEG frames.
It runs on stock Chromium through the fallback path, so CI does not need the
1 GB CloakBrowser binary, and skips itself when no Chromium is present.
