# Shopify Storefront Behaviour Simulator

Synthetic user-flow testing for a Shopify storefront. The tool drives a real
browser through a realistic ~15 minute browsing session — homepage, collection,
products, scrolling, imagery, back/forward — and records what the storefront did:
navigation, rendering, page-load timings, JavaScript errors and failed requests.

The browser layer is [CloakBrowser](https://github.com/CloakHQ/cloakbrowser)'s
patched Chromium, driven through Playwright.

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
| `run` | Runs simulated browsing sessions (default). |
| `probe` | Loads home / collection / product and reports which selectors matched. Run this first against a new shop. |
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
| `--quiet` | off | No console logging |

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
