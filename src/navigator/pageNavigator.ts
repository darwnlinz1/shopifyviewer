/**
 * Page Navigator — everything that touches Playwright directly.
 *
 * Responsibilities:
 *   - navigate (goto / back / forward) and measure page load
 *   - classify what kind of Shopify page we landed on
 *   - observe the page's real content into a PageObservation
 *   - run the low-level browsing gestures (scroll, view media, open sections)
 *
 * The Behaviour Engine consumes observations from here and never queries the
 * DOM itself, which keeps the state machine testable and theme-agnostic.
 */
import type { BrowserContext, Locator, Page, Response } from "playwright-core";
import type { SimulatorConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { Rng, sleep } from "../util/random.js";
import type { Pacing } from "../behavior/timing.js";
import { buildSelectors, type SelectorSet } from "./selectors.js";
import type {
  DiscoveredLink,
  NavigationMetrics,
  PageObservation,
  PageType,
} from "../types.js";

/** Maps Shopify's own analytics pageType values onto our PageType. */
const SHOPIFY_PAGE_TYPES: Record<string, PageType> = {
  index: "home",
  home: "home",
  collection: "collection",
  list_collections: "collection_list",
  collections: "collection_list",
  product: "product",
  search: "search",
  cart: "cart",
  article: "article",
  blog: "blog",
  page: "page",
  "404": "not_found",
};

export class PageNavigator {
  private readonly selectors: SelectorSet;
  /** Session-wide diagnostic counters. */
  private jsErrors = 0;
  private consoleErrors = 0;
  private failedRequests = 0;

  /**
   * Last geometry read by `observe()`. Scroll gestures estimate their position
   * from this plus how far they have wheeled, instead of running a
   * `page.evaluate` after every single step.
   */
  private geometry = { scrollHeight: 0, viewportHeight: 0, scrollY: 0 };

  /** Where the virtual cursor currently is, in viewport coordinates. */
  private cursor: { x: number; y: number } | null = null;

  constructor(
    private readonly page: Page,
    private readonly config: SimulatorConfig,
    private readonly logger: Logger,
    private readonly rng: Rng,
    private readonly pacing: Pacing,
  ) {
    this.selectors = buildSelectors(config.selectorOverrides);
    this.attachDiagnostics();
  }

  /** Wire up JS-error and failed-request capture for the whole session. */
  private attachDiagnostics(): void {
    this.page.on("pageerror", (err) => {
      this.jsErrors++;
      this.logger.warn("js_error", err.message, {
        url: this.safeUrl(),
        data: { stack: err.stack?.slice(0, 600) },
      });
    });
    // Console errors are tracked separately from `pageerror`: a 404 favicon or
    // a blocked third-party pixel logs a console error but is not a broken
    // storefront, whereas an uncaught exception is.
    this.page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      this.consoleErrors++;
      this.logger.debug("console_error", msg.text().slice(0, 400), {
        url: this.safeUrl(),
      });
    });
    this.page.on("requestfailed", (req) => {
      // Aborted requests are normal when navigating away mid-load.
      const failure = req.failure()?.errorText ?? "";
      if (failure.includes("ERR_ABORTED")) return;
      this.failedRequests++;
      this.logger.debug("request_failed", `${failure} ${req.url()}`, {
        url: this.safeUrl(),
        data: { resourceType: req.resourceType() },
      });
    });
    this.page.on("response", (res) => {
      if (res.status() >= 500) {
        this.logger.warn("http_5xx", `${res.status()} ${res.url()}`, {
          url: this.safeUrl(),
        });
      }
    });
  }

  private safeUrl(): string {
    try {
      return this.page.url();
    } catch {
      return "about:blank";
    }
  }

  get currentUrl(): string {
    return this.safeUrl();
  }

  get errorCounts(): {
    jsErrors: number;
    consoleErrors: number;
    failedRequests: number;
  } {
    return {
      jsErrors: this.jsErrors,
      consoleErrors: this.consoleErrors,
      failedRequests: this.failedRequests,
    };
  }

  /** Navigate to a URL and wait for the page to be genuinely usable. */
  async goto(url: string): Promise<NavigationMetrics> {
    const started = Date.now();
    let response: Response | null = null;
    try {
      response = await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.config.session.navigationTimeoutMs,
      });
      await this.settle();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("navigation_error", message, { url });
      throw err;
    }
    return this.collectMetrics(url, response?.status() ?? null, started);
  }

  /**
   * Go to `url` the way a visitor would: by clicking the link that leads there.
   *
   * `page.goto()` is the address bar. A person on a collection page does not
   * type a product URL — they click the card, which fires pointer and click
   * events on the anchor, carries a Referer, and (because click is one of the
   * methods CloakBrowser's human layer patches) arrives via a real cursor
   * movement rather than instantaneously.
   *
   * Not every destination is reachable that way: the engine sometimes returns
   * to a collection it remembers but which the current page does not link to.
   * Those still go through `goto()`, and the log records which path was taken
   * so the click-through ratio is visible.
   */
  async navigateTo(url: string): Promise<NavigationMetrics> {
    const link = await this.findLinkTo(url);
    if (link) {
      const metrics = await this.clickThrough(link, url);
      if (metrics) return metrics;
      this.logger.debug("click_nav_failed", "falling back to direct navigation", { url });
    }
    return this.goto(url);
  }

  /**
   * Find a visible, clickable anchor pointing at `url`.
   *
   * Themes write hrefs inconsistently — absolute, root-relative, with tracking
   * parameters — so matching is on the path, most-specific first.
   */
  private async findLinkTo(url: string): Promise<Locator | null> {
    let path: string;
    try {
      path = new URL(url).pathname.replace(/\/+$/, "");
    } catch {
      return null;
    }
    if (!path) return null;

    const escaped = path.replace(/["\\]/g, "\\$&");
    const candidates = [
      `a[href="${escaped}"]`,
      `a[href$="${escaped}"]`,
      `a[href*="${escaped}"]`,
    ];

    for (const selector of candidates) {
      const locator = this.page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      // An anchor scrolled off-screen or hidden behind a mega-menu cannot be
      // clicked; better to fall back than to time out on it.
      const visible = await locator.isVisible().catch(() => false);
      if (visible) return locator;
    }
    return null;
  }

  /** Click a link and wait for the page it leads to. */
  private async clickThrough(link: Locator, url: string): Promise<NavigationMetrics | null> {
    const started = Date.now();
    // Deliberately short, and *not* navigationTimeoutMs. A click can be
    // swallowed — a cookie banner over the card, a theme opening a quick-view
    // instead, an overlay eating the event — and when that happens there is
    // nothing to wait for. Waiting the full navigation budget before falling
    // back to goto() turned one blocked click into a minute of dead air.
    const timeout = Math.min(12_000, this.config.session.navigationTimeoutMs);

    try {
      // scrollIntoViewIfNeeded and click are both patched by the human layer,
      // so this is where the mouse actually travels to the card.
      await link.scrollIntoViewIfNeeded({ timeout: 3_000 });
      // People look at a thing before they click it.
      await sleep(this.rng.int(120, 380));

      const responsePromise = this.page
        .waitForResponse(
          (response) =>
            response.request().isNavigationRequest() &&
            response.request().frame() === this.page.mainFrame(),
          { timeout },
        )
        .catch(() => null);

      const navigationPromise = this.page
        .waitForURL(() => true, { timeout, waitUntil: "domcontentloaded" })
        .catch(() => undefined);

      await link.click({ timeout: 5_000 });
      const [response] = await Promise.all([responsePromise, navigationPromise]);

      // The click may have gone somewhere else entirely — a theme intercepting
      // it, a quick-view modal, an overlay swallowing the event. Only treat it
      // as success if we actually arrived.
      const landed = this.safeUrl();
      if (!this.samePath(landed, url)) {
        this.logger.debug("click_nav_diverted", `expected ${url}, landed on ${landed}`);
        return null;
      }

      await this.settle();
      // The cursor moved to the link on the page we just left.
      this.cursor = null;
      const metrics = await this.collectMetrics(landed, response?.status() ?? null, started);
      this.logger.debug("click_nav", "navigated by clicking the link", { url: landed });
      return metrics;
    } catch {
      return null;
    }
  }

  /** Whether two URLs point at the same path, ignoring query and hash. */
  private samePath(a: string, b: string): boolean {
    try {
      const left = new URL(a);
      const right = new URL(b);
      return (
        left.host === right.host &&
        left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "")
      );
    } catch {
      return false;
    }
  }

  /** Browser Back. Returns null when there is no history entry to go back to. */
  async back(): Promise<NavigationMetrics | null> {
    const started = Date.now();
    const response = await this.page.goBack({
      waitUntil: "domcontentloaded",
      timeout: this.config.session.navigationTimeoutMs,
    });
    if (!response) return null;
    await this.settle();
    return this.collectMetrics(this.safeUrl(), response.status(), started);
  }

  /** Browser Forward. Returns null when there is nothing forward in history. */
  async forward(): Promise<NavigationMetrics | null> {
    const started = Date.now();
    const response = await this.page.goForward({
      waitUntil: "domcontentloaded",
      timeout: this.config.session.navigationTimeoutMs,
    });
    if (!response) return null;
    await this.settle();
    return this.collectMetrics(this.safeUrl(), response.status(), started);
  }

  /**
   * Wait for the page to stop working. `networkidle` is unreliable on Shopify
   * (analytics beacons, chat widgets and lazy sections keep sockets warm), so
   * we wait for `load` and then give the theme a bounded settle window.
   */
  private async settle(): Promise<void> {
    try {
      await this.page.waitForLoadState("load", { timeout: 10_000 });
    } catch {
      this.logger.debug("settle_timeout", "load state not reached in 10s", {
        url: this.safeUrl(),
      });
    }
    try {
      // Shopify storefronts essentially never go idle — analytics beacons,
      // chat widgets and lazy sections keep sockets warm — so this almost
      // always times out. Keep the window short: it is a nice-to-have, and at
      // five seconds it was pure tax on every single navigation.
      await this.page.waitForLoadState("networkidle", { timeout: 1_500 });
    } catch {
      /* expected on storefronts with persistent connections */
    }
    // Give the main content region a chance to appear before observing.
    const main = this.selectors.mainContent.join(", ");
    await this.page
      .waitForSelector(main, { timeout: 2_500, state: "attached" })
      .catch(() => undefined);
  }

  /** Read Navigation Timing / paint metrics out of the page. */
  private async collectMetrics(
    url: string,
    status: number | null,
    started: number,
  ): Promise<NavigationMetrics> {
    const elapsedMs = Date.now() - started;
    const timing = await this.page
      .evaluate(() => {
        const nav = performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming | undefined;
        const fcp = performance
          .getEntriesByType("paint")
          .find((entry) => entry.name === "first-contentful-paint");
        return {
          ttfb: nav ? nav.responseStart - nav.startTime : null,
          dcl: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
          load: nav ? nav.loadEventEnd - nav.startTime : null,
          fcp: fcp ? fcp.startTime : null,
        };
      })
      .catch(() => ({ ttfb: null, dcl: null, load: null, fcp: null }));

    const metrics: NavigationMetrics = {
      url,
      status,
      elapsedMs,
      ttfbMs: round(timing.ttfb),
      domContentLoadedMs: round(timing.dcl),
      loadEventMs: round(timing.load),
      firstContentfulPaintMs: round(timing.fcp),
      jsErrors: this.jsErrors,
      consoleErrors: this.consoleErrors,
      failedRequests: this.failedRequests,
    };

    const level = status && status >= 400 ? "warn" : "info";
    this.logger.log(level, "page_load", `${status ?? "?"} in ${elapsedMs}ms`, {
      url,
      data: { ...metrics },
    });
    return metrics;
  }

  // ---------------------------------------------------------------------
  // Observation
  // ---------------------------------------------------------------------

  /**
   * Classify the page. Shopify's own globals are authoritative when present;
   * URL shape and DOM markers are the fallback for themes that strip them.
   */
  async detectPageType(): Promise<PageType> {
    const fromShopify = await this.page
      .evaluate(() => {
        const w = window as unknown as Record<string, any>;
        const analytics = w.ShopifyAnalytics?.meta?.page?.pageType;
        if (typeof analytics === "string") return analytics;
        const st = w.__st?.p;
        if (typeof st === "string") return st;
        return null;
      })
      .catch(() => null);

    if (fromShopify) {
      const mapped = SHOPIFY_PAGE_TYPES[fromShopify.toLowerCase()];
      if (mapped) return mapped;
    }

    // URL-shape fallback — Shopify's routes are stable even on custom themes.
    const path = new URL(this.safeUrl()).pathname.replace(/\/+$/, "");
    if (path === "" || path === "/") return "home";
    if (/\/products\//.test(path)) return "product";
    if (/^\/collections$/.test(path)) return "collection_list";
    if (/\/collections\//.test(path)) return "collection";
    if (path.startsWith("/search")) return "search";
    if (path.startsWith("/cart")) return "cart";
    if (path.startsWith("/blogs/")) return path.split("/").length > 3 ? "article" : "blog";
    if (path.startsWith("/pages/")) return "page";

    // DOM fallback: a product form is the strongest product-page signal.
    const hasProductForm = await this.page
      .locator("form[action*='/cart/add']")
      .count()
      .catch(() => 0);
    if (hasProductForm > 0) return "product";
    return "unknown";
  }

  /** Take a full snapshot of what the current page offers. */
  async observe(): Promise<PageObservation> {
    const pageType = await this.detectPageType();
    const url = this.safeUrl();

    const [geometry, productLinks, collectionLinks, counts, title] = await Promise.all([
      this.readGeometry(),
      this.collectLinks(this.selectors.productLink, "product"),
      this.collectLinks(this.selectors.collectionLink, "collection"),
      // Every concept the observation needs, in one trip into the page.
      this.countConcepts({
        media: this.selectors.productMedia,
        collapsible: this.selectors.collapsibleSection,
        content: this.selectors.contentSection,
        variants: this.selectors.variantPicker,
        price: this.selectors.productPrice,
        main: this.selectors.mainContent,
      }),
      this.page.title().catch(() => ""),
    ]);

    const mediaCount = counts.media ?? 0;
    // Accordions when the theme has them, content sections otherwise — and on
    // a product page, no accordions means nothing worth counting.
    const sectionCount =
      (counts.collapsible ?? 0) > 0
        ? (counts.collapsible ?? 0)
        : pageType === "product"
          ? 0
          : (counts.content ?? 0);
    const hasVariants = (counts.variants ?? 0) > 0;
    const hasPrice = (counts.price ?? 0) > 0;
    const hasMain = (counts.main ?? 0) > 0;

    const observation: PageObservation = {
      url,
      title,
      pageType,
      scrollHeight: geometry.scrollHeight,
      viewportHeight: geometry.viewportHeight,
      scrollY: geometry.scrollY,
      productLinks,
      collectionLinks,
      mediaCount,
      sectionCount,
      hasVariants,
      hasPrice,
      hasMainContent: hasMain,
    };

    this.geometry = geometry;

    this.logger.debug("observe", `${pageType} · ${title.slice(0, 60)}`, {
      url,
      data: {
        pageType,
        productLinks: productLinks.length,
        collectionLinks: collectionLinks.length,
        mediaCount,
        sectionCount,
        scrollHeight: geometry.scrollHeight,
      },
    });
    return observation;
  }

  private async readGeometry(): Promise<{
    scrollHeight: number;
    viewportHeight: number;
    scrollY: number;
  }> {
    return this.page
      .evaluate(() => ({
        scrollHeight: Math.max(
          document.body?.scrollHeight ?? 0,
          document.documentElement?.scrollHeight ?? 0,
        ),
        viewportHeight: window.innerHeight,
        scrollY: window.scrollY,
      }))
      .catch(() => ({ scrollHeight: 0, viewportHeight: 0, scrollY: 0 }));
  }

  /**
   * Collect same-shop links matching the first candidate selector that hits.
   * Results are de-duplicated, safety-filtered, and capped.
   */
  private async collectLinks(
    candidates: string[],
    kind: PageType,
    limit = 60,
  ): Promise<DiscoveredLink[]> {
    for (const selector of candidates) {
      const found = await this.page
        .evaluate(
          ({ sel, max }) =>
            Array.from(document.querySelectorAll<HTMLAnchorElement>(sel))
              .slice(0, max)
              .map((a) => ({ url: a.href, text: (a.textContent ?? "").trim().slice(0, 120) })),
          { sel: selector, max: limit * 3 },
        )
        .catch(() => [] as Array<{ url: string; text: string }>);

      if (found.length === 0) continue;

      const seen = new Set<string>();
      const links: DiscoveredLink[] = [];
      for (const item of found) {
        const normalised = this.normaliseUrl(item.url);
        if (!normalised || seen.has(normalised)) continue;
        if (!this.isAllowed(normalised)) continue;
        seen.add(normalised);
        links.push({ url: normalised, text: item.text, kind });
        if (links.length >= limit) break;
      }
      if (links.length > 0) return links;
    }
    return [];
  }

  private async countFirstMatching(candidates: string[]): Promise<number> {
    const counts = await this.countConcepts({ only: candidates });
    return counts.only ?? 0;
  }

  /**
   * Count several selector concepts in a single round trip.
   *
   * Each concept is a candidate list tried most-specific first, and the old
   * implementation did one `locator.count()` per candidate — so a page with
   * six concepts of nine candidates each could cost fifty round trips before
   * the engine got to decide anything. Against a real storefront that was
   * seconds of latency per turn, every turn. The whole sweep now happens
   * inside the page and comes back as one object.
   */
  private async countConcepts(
    concepts: Record<string, string[]>,
  ): Promise<Record<string, number>> {
    const empty = Object.fromEntries(Object.keys(concepts).map((key) => [key, 0]));
    const counts = await this.page
      .evaluate((groups: Record<string, string[]>) => {
        const out: Record<string, number> = {};
        for (const [name, candidates] of Object.entries(groups)) {
          out[name] = 0;
          for (const selector of candidates) {
            let found = 0;
            try {
              found = document.querySelectorAll(selector).length;
            } catch {
              // A selector Playwright accepts but querySelectorAll does not.
              continue;
            }
            if (found > 0) {
              out[name] = found;
              break;
            }
          }
        }
        return out;
      }, concepts)
      .catch(() => empty);
    return counts;
  }

  private async existsAny(candidates: string[]): Promise<boolean> {
    return (await this.countFirstMatching(candidates)) > 0;
  }

  /** Strip query/hash noise and reject anything off-shop. */
  private normaliseUrl(raw: string): string | null {
    try {
      const url = new URL(raw, this.safeUrl());
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      url.hash = "";
      // Keep variant selection out of the URL so products de-duplicate cleanly.
      url.searchParams.delete("variant");
      return url.toString();
    } catch {
      return null;
    }
  }

  /** Enforce the host allowlist and the blocked-path list. */
  isAllowed(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!this.config.safety.allowedHosts.includes(parsed.host)) return false;
    const path = parsed.pathname.toLowerCase();
    for (const fragment of this.config.safety.blockedPathFragments) {
      if (path.includes(fragment)) return false;
    }
    if (!this.config.safety.allowCart && /\/cart(\/|$)/.test(path)) return false;
    return true;
  }

  // ---------------------------------------------------------------------
  // Browsing gestures
  // ---------------------------------------------------------------------

  /**
   * Scroll the page in a few uneven steps with varying pauses, the way a
   * person skims rather than a script jumping to the bottom.
   *
   * This drives `mouse.wheel`, not `window.scrollBy`. The distinction matters:
   * `page.evaluate(() => window.scrollBy(...))` moves the viewport without
   * dispatching a single `wheel` event, so nothing on the page can observe the
   * input that supposedly caused it — and CloakBrowser's human-input layer,
   * which patches interaction methods rather than anything reached through
   * `evaluate`, never sees the gesture at all. Since scrolling is by far the
   * most frequent action in a session, routing it through the real input path
   * is the single highest-value correction in this file.
   */
  async scroll(direction?: "down" | "up"): Promise<number> {
    const behavior = this.config.behavior;
    await this.ensureCursor();

    const viewportHeight =
      this.geometry.viewportHeight || this.page.viewportSize()?.height || 900;
    const maxScroll = Math.max(0, this.geometry.scrollHeight - viewportHeight);
    let position = this.geometry.scrollY;

    // Mostly downward, with the occasional scroll back up to re-read
    // something — drawn from the seeded RNG so sessions stay reproducible.
    // Real browsing is not a one-way trip down the page: people scroll back to
    // re-read a price, check a photo again, glance at the header.
    let dir = direction ?? (this.rng.chance(0.32) ? "up" : "down");

    // Asking to scroll down at the bottom of the page (or up at the top) does
    // nothing at all, which reads as the browser freezing. Turn around instead.
    if (!direction && maxScroll > 0) {
      if (dir === "down" && position >= maxScroll - 8) dir = "up";
      else if (dir === "up" && position <= 8) dir = "down";
    }

    const steps = this.rng.range(behavior.scrollSteps);
    let travelled = 0;

    for (let i = 0; i < steps; i++) {
      const fraction = this.rng.rangeFloat(behavior.scrollFraction);
      const distance = Math.round(viewportHeight * fraction) * (dir === "up" ? -1 : 1);

      const moved = await this.wheelBy(distance);
      if (moved === null) break; // page went away mid-gesture

      travelled += Math.abs(moved);
      position = Math.min(maxScroll, Math.max(0, position + moved));

      // Position is estimated between observations rather than re-read: one
      // `evaluate` per step, several steps per gesture, hundreds of gestures a
      // session is a lot of instrumentation for a value `observe()` refreshes
      // on the next turn anyway.
      if (dir === "down" && maxScroll > 0 && position >= maxScroll - 4) break;
      if (dir === "up" && position <= 0) break;

      await sleep(this.pacing.scrollPause());
    }

    this.geometry.scrollY = position;

    this.logger.info("scroll", `${dir} ~${travelled}px in ${steps} steps`, {
      url: this.safeUrl(),
      data: { direction: dir, steps, travelledPx: travelled, scrollY: position },
    });
    return travelled;
  }

  /**
   * Scroll by `distance` px using real wheel input.
   *
   * A wheel event carries a delta, and the browser applies all of it at once:
   * `mouse.wheel(0, 600)` is a single 600-pixel jump, not a scroll. Nothing
   * about that looks like a person, and on screen it reads as the page
   * teleporting.
   *
   * A hand on a wheel or trackpad produces a *burst* of small deltas instead —
   * roughly one notch each, tens of milliseconds apart, starting slowly,
   * running fastest in the middle and easing to a stop. That is what this
   * emits, so the motion is smooth and every pixel of it still arrives as
   * genuine wheel input rather than a scripted viewport move.
   *
   * Returns the signed distance travelled, or null if the page went away.
   */
  private async wheelBy(distance: number): Promise<number | null> {
    const direction = Math.sign(distance);
    const total = Math.abs(distance);
    if (total < 8) return 0;

    // One notch of a physical wheel is around 100px; a trackpad flick is a
    // burst of much smaller deltas. Draw somewhere in that band per gesture,
    // so different gestures feel like different input devices.
    const notch = this.rng.int(34, 92);
    const ticks = Math.max(4, Math.round(total / notch));
    let moved = 0;

    for (let i = 0; i < ticks; i++) {
      // Ease in and out across the gesture: 0 at the edges, 1 in the middle.
      // A constant-rate scroll is the giveaway of a scripted one.
      const ease = Math.sin(Math.PI * ((i + 0.5) / ticks));
      const step = Math.max(
        6,
        Math.round(notch * (0.4 + ease) * this.rng.float(0.85, 1.15)),
      );

      try {
        await this.page.mouse.wheel(0, step * direction);
      } catch {
        // A navigation mid-gesture detaches the page; the session loop will
        // re-observe and carry on.
        return null;
      }
      moved += step;

      // Faster in the middle of the gesture, slower at either end — the same
      // easing applied to the gaps rather than the deltas.
      await sleep(Math.round(this.rng.int(9, 24) / (0.45 + ease)));
    }

    // People overshoot what they were aiming at and correct back. Doing it
    // here rather than in the caller keeps the correction part of the same
    // continuous gesture.
    if (this.rng.chance(0.18)) {
      const overshoot = this.rng.int(30, 110);
      try {
        await this.page.mouse.wheel(0, overshoot * direction);
        await sleep(this.rng.int(90, 260));
        await this.page.mouse.wheel(0, -overshoot * direction);
      } catch {
        return moved * direction;
      }
    }

    return moved * direction;
  }

  /**
   * Put the virtual cursor somewhere sensible in the content area if it has
   * not moved yet, so wheel events and hovers land on the page rather than at
   * the viewport origin.
   */
  private async ensureCursor(): Promise<void> {
    if (this.cursor) return;
    const size = this.page.viewportSize() ?? { width: 1440, height: 900 };
    const target = {
      x: Math.round(size.width * this.rng.float(0.3, 0.7)),
      y: Math.round(size.height * this.rng.float(0.35, 0.65)),
    };
    await this.page.mouse.move(target.x, target.y).catch(() => undefined);
    this.cursor = target;
  }

  /**
   * Wait, but not perfectly still.
   *
   * A real pointer drifts by a few pixels while its owner reads; a frozen
   * cursor for fifteen minutes is not something a hand does. The drift is
   * small and infrequent — this is idling, not fidgeting.
   */
  private async idle(totalMs: number): Promise<void> {
    await this.ensureCursor();
    const cursor = this.cursor;
    if (!cursor) {
      await sleep(totalMs);
      return;
    }

    const size = this.page.viewportSize() ?? { width: 1440, height: 900 };
    let remaining = totalMs;

    while (remaining > 0) {
      // Drift roughly every 0.4–1.4s, so a short dwell may not drift at all.
      const slice = Math.min(remaining, this.rng.int(400, 1400));
      await sleep(slice);
      remaining -= slice;

      if (remaining <= 0 || !this.rng.chance(0.6)) continue;

      const next = {
        x: clamp(cursor.x + this.rng.int(-9, 9), 2, size.width - 2),
        y: clamp(cursor.y + this.rng.int(-7, 7), 2, size.height - 2),
      };
      await this.page.mouse.move(next.x, next.y).catch(() => undefined);
      cursor.x = next.x;
      cursor.y = next.y;
    }
  }

  /**
   * Look at product imagery: scroll the gallery into view, then click through
   * a couple of thumbnails, dwelling on each.
   */
  async viewMedia(): Promise<number> {
    const gallery = await this.firstMatchingLocator(this.selectors.productMedia);
    if (!gallery) {
      this.logger.debug("view_media_skip", "no gallery found", { url: this.safeUrl() });
      return 0;
    }

    await gallery.first().scrollIntoViewIfNeeded({ timeout: 2_500 }).catch(() => undefined);
    await this.idle(this.pacing.mediaDwell());
    let viewed = 1;

    const thumbs = await this.firstMatchingLocator(this.selectors.productMediaThumb);
    if (thumbs) {
      const total = await thumbs.count().catch(() => 0);
      // Each thumbnail costs a full dwell, so four of them turned one
      // "look at the gallery" action into eight seconds.
      const toView = Math.min(total, this.rng.int(1, 2));
      for (let i = 0; i < toView; i++) {
        const thumb = thumbs.nth(i);
        const visible = await thumb.isVisible().catch(() => false);
        if (!visible) continue;
        await thumb.click({ timeout: 2_500 }).catch(() => undefined);
        await this.idle(this.pacing.mediaDwell());
        viewed++;
      }
    }

    this.logger.info("view_media", `viewed ${viewed} media item(s)`, {
      url: this.safeUrl(),
      data: { viewed },
    });
    return viewed;
  }

  /**
   * Open a collapsible section (description, ingredients, shipping…) and read
   * it. Falls back to dwelling on a static content section when the theme has
   * no accordions.
   */
  async readSection(): Promise<boolean> {
    const sections = await this.firstMatchingLocator(this.selectors.collapsibleSection);

    if (sections) {
      const total = await sections.count().catch(() => 0);
      if (total > 0) {
        const index = this.rng.int(0, total - 1);
        const section = sections.nth(index);
        await section.scrollIntoViewIfNeeded({ timeout: 2_500 }).catch(() => undefined);
        const summary = section.locator("summary").first();
        const target = (await summary.count().catch(() => 0)) > 0 ? summary : section;
        await target.click({ timeout: 2_500 }).catch(() => undefined);
        // Time the read against the section that was actually opened, not a
        // fixed range: a shipping blurb and an ingredient list are not the
        // same amount of reading.
        const readMs = await this.readingTimeFor(section);
        await this.idle(readMs);
        this.logger.info("read_section", `opened section #${index + 1}/${total}`, {
          url: this.safeUrl(),
          data: { index, total, readMs },
        });
        return true;
      }
    }

    // No accordions — dwell on the description instead.
    const description = await this.firstMatchingLocator(this.selectors.productDescription);
    if (description) {
      const block = description.first();
      await block.scrollIntoViewIfNeeded({ timeout: 2_500 }).catch(() => undefined);
      const readMs = await this.readingTimeFor(block);
      await this.idle(readMs);
      this.logger.info("read_section", "read description block", {
        url: this.safeUrl(),
        data: { readMs },
      });
      return true;
    }

    // Neither: on home/collection pages, dwell on one of the theme's content
    // sections (hero, featured collection, testimonials…) instead.
    const content = await this.firstMatchingLocator(this.selectors.contentSection);
    if (content) {
      const total = await content.count().catch(() => 0);
      if (total > 0) {
        const index = this.rng.int(0, total - 1);
        const block = content.nth(index);
        await block.scrollIntoViewIfNeeded({ timeout: 2_500 }).catch(() => undefined);
        const readMs = await this.readingTimeFor(block);
        await this.idle(readMs);
        this.logger.info("read_section", `viewed content section #${index + 1}/${total}`, {
          url: this.safeUrl(),
          data: { index, total, readMs },
        });
        return true;
      }
    }

    this.logger.debug("read_section_skip", "no readable section", { url: this.safeUrl() });
    return false;
  }

  /**
   * Read the product's headline details — title, price, description presence.
   * This is the check that the product template actually rendered its data.
   */
  async inspectDetails(): Promise<{
    title: string | null;
    price: string | null;
    hasDescription: boolean;
  }> {
    const title = await this.firstText(this.selectors.productTitle);
    const price = await this.firstText(this.selectors.productPrice);
    const hasDescription = await this.existsAny(this.selectors.productDescription);

    const missing: string[] = [];
    if (!title) missing.push("title");
    if (!price) missing.push("price");
    if (!hasDescription) missing.push("description");

    if (missing.length > 0) {
      this.logger.warn("product_incomplete", `missing: ${missing.join(", ")}`, {
        url: this.safeUrl(),
        data: { missing },
      });
    } else {
      this.logger.info("inspect_details", `${title?.slice(0, 50)} · ${price}`, {
        url: this.safeUrl(),
        data: { title, price, hasDescription },
      });
    }

    await this.idle(this.pacing.sectionDwell());
    return { title, price, hasDescription };
  }

  /**
   * Hover the variant swatches without selecting one — enough to exercise the
   * theme's variant JS, without mutating cart or URL state.
   */
  async hoverVariants(): Promise<number> {
    const picker = await this.firstMatchingLocator(this.selectors.variantPicker);
    if (!picker) return 0;

    const options = picker.first().locator("label, option, .swatch, button");
    const total = await options.count().catch(() => 0);
    if (total === 0) return 0;

    const toHover = Math.min(total, this.rng.int(1, 3));
    let hovered = 0;
    for (let i = 0; i < toHover; i++) {
      const option = options.nth(this.rng.int(0, total - 1));
      const visible = await option.isVisible().catch(() => false);
      if (!visible) continue;
      await option.hover({ timeout: 2_000 }).catch(() => undefined);
      // A hover moves the real cursor, so keep our idea of where it is honest.
      this.cursor = null;
      await sleep(this.rng.int(400, 1400));
      hovered++;
    }

    this.logger.info("hover_variants", `hovered ${hovered} option(s)`, {
      url: this.safeUrl(),
      data: { hovered, total },
    });
    return hovered;
  }

  /** An idle pause — a real visitor reading, not a script firing. */
  async dwell(ms?: number): Promise<void> {
    const duration = ms ?? this.pacing.sectionDwell();
    this.logger.debug("dwell", `${duration}ms`, {
      url: this.safeUrl(),
      data: { tempo: this.pacing.currentTempo },
    });
    await this.idle(duration);
  }

  /** Pause between two actions. */
  async actionPause(): Promise<void> {
    await sleep(this.pacing.actionPause());
  }

  /** Settle pause after arriving on a new page. */
  async pageSettlePause(): Promise<void> {
    // The cursor belongs to the page that just unloaded; drop it so the next
    // gesture re-seats it inside the new document.
    this.cursor = null;
    await sleep(this.pacing.pageSettle());
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** Return a locator for the first candidate selector that matches anything. */
  private async firstMatchingLocator(candidates: string[]) {
    for (const selector of candidates) {
      const locator = this.page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count > 0) return locator;
    }
    return null;
  }

  /**
   * How long this block would take to read. Falls back to the configured dwell
   * range when the text cannot be measured.
   */
  private async readingTimeFor(locator: Locator): Promise<number> {
    const text = await locator.textContent().catch(() => null);
    if (!text) return this.pacing.sectionDwell();
    return this.pacing.readingTime(text.replace(/\s+/g, " ").trim().length);
  }

  private async firstText(candidates: string[]): Promise<string | null> {
    for (const selector of candidates) {
      const locator = this.page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const text = (await locator.textContent().catch(() => null))?.trim();
      if (text) return text.replace(/\s+/g, " ").slice(0, 200);
    }
    return null;
  }
}

/** Constrain a value to an inclusive range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round a possibly-null millisecond reading to whole ms. */
function round(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

/** Open the working page for a session, reusing the profile's initial tab. */
export async function openSessionPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  const page = existing ?? (await context.newPage());
  return page;
}
