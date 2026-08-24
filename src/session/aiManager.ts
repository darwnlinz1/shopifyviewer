/**
 * AI-Driven Session Manager - manages one browsing session.
 *
 * Core loop:
 *   1. Extract structured HTML from the page via buildExtractionScript()
 *   2. preprocessHtml() to strip noise before sending to Claude
 *   3. AI decides next action (click, scroll, add-to-cart, dismiss popup...)
 *   4. Backend executes with random human-like delays
 *   5. On new page → repeat from step 1 (AI is "blind" again)
 *
 * Popup dismissal: on every new URL, detect popups first (highest priority
 * first). Cookie consent, newsletter modals, overlays all get clicked before
 * any browsing action.
 *
 * Advance action: at the 10-minute mark, re-detect add-to-cart and click it,
 * then resume normal browsing like a real user.
 */
import type { BrowserContext, Page } from "playwright-core";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { Rng, randomSeed, sleep } from "../util/random.js";
import { launchBrowser, type BrowserEngine } from "../browser/obscura.js";
import { openSessionPage } from "../navigator/pageNavigator.js";
import { Pacing } from "../behavior/timing.js";
import { SessionTimer } from "./timer.js";
import { CookiePool } from "../ai/cookiePool.js";
import { ElementDetector } from "../ai/elementDetector.js";
import { AiBehaviorEngine, type Personality } from "../behavior/aiEngine.js";
import { preprocessHtml } from "../ai/promptTemplates.js";
import type { Profile } from "../profiles/types.js";
import type { AiDecision, NavigationMetrics, SessionBlocker, SessionResult } from "../types.js";
import { saveSessionReport } from "./sessionReport.js";

// ── Session status ──

export type SessionStatus =
  | "starting" | "running" | "paused" | "blocked"
  | "lingering" | "stopping" | "finished" | "error";

export interface SessionSnapshot {
  sessionId: string;
  profileId?: string;
  status: SessionStatus;
  url: string;
  title: string;
  lastAction: string | null;
  lastReason: string;
  startedAt: string;
  plannedDurationMs: number;
  elapsedMs: number;
  remainingMs: number;
  lingeringSince?: string;
  pagesVisited: number;
  productsViewed: number;
  collectionsViewed: number;
  actionsPerformed: number;
  jsErrors: number;
  consoleErrors: number;
  failedRequests: number;
  navigationErrors: number;
  engine: BrowserEngine;
  cookiesInjected: number;
  aiCallsCount: number;
  aiCallsTotalMs: number;
  personality?: string;
  atcPerformed: boolean;
  cookiePoolHealthy: number;
  cookiePoolDegraded: number;
  recentNavigations: NavigationMetrics[];
  blocker?: SessionBlocker;
  error?: string;
}

export interface SessionOptions {
  slot: number;
  sessionId: string;
  config: SimulatorConfig;
  seed?: number;
  signal?: AbortSignal;
  profile?: Profile;
  userDataDir?: string;
  lingerMs?: number;
  /**
   * Time already spent by the session this launch continues. Back-dates the
   * timer so a relaunch onto the desktop resumes the original clock — elapsed
   * keeps its head start, only the unspent remainder is granted.
   */
  elapsedOffsetMs?: number;
  /** Page to reopen on launch (a relaunch continues where the visitor was). */
  resumeUrl?: string;
  onUpdate?: (snapshot: SessionSnapshot) => void;
  onPage?: (page: Page, context: BrowserContext) => void | Promise<void>;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly profileId: string | undefined;
  readonly page: Page;
  readonly context: BrowserContext;
  snapshot(): SessionSnapshot;
  pause(): void;
  resume(): void;
  extend(ms: number): void;
  park(): void;
  close(): Promise<SessionResult>;
  readonly done: Promise<SessionResult>;
}

// ── Pause / close gate ──

class Control {
  private paused = false;
  private parkRequested = false;
  private closeRequested = false;
  private wake: (() => void) | null = null;
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.notify(); }
  park(): void { this.parkRequested = true; this.paused = false; this.notify(); }
  requestClose(): void { this.closeRequested = true; this.paused = false; this.notify(); }
  get isPaused() { return this.paused; }
  get shouldPark() { return this.parkRequested; }
  get shouldClose() { return this.closeRequested; }
  private notify(): void { const w = this.wake; this.wake = null; w?.(); }
  async gate(): Promise<void> {
    while (this.paused && !this.closeRequested && !this.parkRequested) {
      await new Promise<void>(r => { this.wake = r; setTimeout(r, 500); });
    }
  }
  async waitForClose(timeoutMs: number): Promise<void> {
    if (this.closeRequested) return;
    const d = timeoutMs >= 0 ? Date.now() + timeoutMs : Infinity;
    while (!this.closeRequested && Date.now() < d) {
      const s = Math.min(500, Math.max(0, d - Date.now()));
      await new Promise<void>(r => { this.wake = r; setTimeout(r, Number.isFinite(s) ? s : 500); });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// START SESSION
// ═══════════════════════════════════════════════════════════════════════

export async function startSession(options: SessionOptions): Promise<SessionHandle> {
  const { config, sessionId, slot, signal, profile } = options;
  const seed = options.seed ?? config.seed ?? randomSeed();
  const rng = new Rng(seed);
  // A relaunch continues the original visit: the clock back-dates by the time
  // already spent, and the reported start time is the ORIGINAL one.
  const elapsedOffsetMs = Math.max(0, options.elapsedOffsetMs ?? 0);
  const startedAt = new Date(Date.now() - elapsedOffsetMs).toISOString();

  // Duration override from profile
  const durOverride = profile?.durationMinutes;
  const sessionCfg = durOverride
    ? {
        ...config.session,
        durationMs: Math.round(durOverride * 60_000),
        // Fixed length: never add jitter on top of a per-profile duration.
        durationJitterMs: 0,
        hardTimeoutMs: Math.max(
          config.session.hardTimeoutMs,
          Math.round(durOverride * 60_000 * 1.4) + 60_000,
        ),
      }
    : config.session;

  const timer = new SessionTimer(sessionCfg, rng, elapsedOffsetMs);
  
  // Recreate logger with profile name + live countdown timer
  const profileName = profile?.name ?? `Profile-${slot}`;
  const fmtClock = (ms: number): string => {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  const logger = new Logger(sessionId, config.logging, profileName, () =>
    `${fmtClock(timer.elapsedMs())}/${fmtClock(timer.plannedDurationMs)}`
  );
  const control = new Control();

  logger.info("session_start", "seed=" + seed + " budget=" + Math.round(timer.plannedDurationMs / 1000) + "s", {
    data: { seed, slot, profile: profile?.name, storefront: config.storefront },
  });

  // ── Launch browser ──
  const browser = await launchBrowser({
    slot, sessionId, config, logger, rng,
    ...(profile ? { profile } : {}),
    ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
  });
  const page: Page = await openSessionPage(browser.context);
  page.setDefaultTimeout(10_000);
  await options.onPage?.(page, browser.context);

  // ── AI layer ──
  const aiConfig = (config as any).ai ?? {
    cookiesDir: "./Cookies",
    maxHtmlChars: 60_000,
    maxRetries: 3,
    model: "claude-sonnet-5",
  };
  const cookiePool = new CookiePool(aiConfig.cookiesDir);
  const poolStats = cookiePool.stats();
  logger.info("cookie_pool", `loaded=` + poolStats.totalLoaded + ` active=` + poolStats.active + ` quarantined=` + poolStats.quarantined, {
    data: { ...poolStats },
  });

  const detector = new ElementDetector(cookiePool, logger, {
    maxRetries: aiConfig.maxRetries,
    maxHtmlChars: aiConfig.maxHtmlChars,
    model: aiConfig.model ?? "claude-sonnet-5",
  });
  // Random personality per session (behavioral fingerprinting)
  const personalities: Personality[] = ["browser", "browser_fast", "shopper", "researcher"];
  const engine = new AiBehaviorEngine(config, rng, logger, rng.pick(personalities));
  const pacing = new Pacing(rng, config.behavior, () => timer.progress());

  // ── Session state ──
  let status: SessionStatus = "starting";
  let lingeringSince: string | undefined;
  let pagesVisited = 0;
  let navigationErrors = 0;
  let lastAction: string | null = null;
  let lastReason = "";
  let lastTitle = "";
  let slowestNav: NavigationMetrics | null = null;
  let exitReason: SessionResult["exitReason"] = "engine_exit";
  let errorMessage: string | undefined;
  let blocker: SessionBlocker | undefined;
  const recentNavs: NavigationMetrics[] = [];
  const RECENT_CAP = 30;

  // JS error tracking
  let jsErrors = 0;
  let consoleErrors = 0;
  let failedRequests = 0;
  page.on("pageerror", () => { jsErrors++; });
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors++; });
  page.on("requestfailed", () => { failedRequests++; });

  const snapshot = (): SessionSnapshot => ({
    sessionId,
    ...(profile ? { profileId: profile.id } : {}),
    status,
    url: page.url(),
    title: lastTitle,
    lastAction,
    lastReason,
    startedAt,
    plannedDurationMs: timer.plannedDurationMs,
    elapsedMs: timer.elapsedMs(),
    remainingMs: timer.remainingMs(),
    ...(lingeringSince ? { lingeringSince } : {}),
    pagesVisited,
    productsViewed: engine.state.visitedProducts.size,
    collectionsViewed: engine.state.visitedProducts.size,
    actionsPerformed: engine.state.aiCallsCount,
    jsErrors,
    consoleErrors,
    failedRequests,
    navigationErrors,
    engine: browser.engine,
    cookiesInjected: browser.cookiesInjected,
    aiCallsCount: engine.state.aiCallsCount,
    aiCallsTotalMs: engine.state.aiCallsTotalMs,
    personality: (engine as any).personality ?? "unknown",
    atcPerformed: engine.state.advanceActionPerformed,
    cookiePoolHealthy: cookiePool.stats().healthy,
    cookiePoolDegraded: cookiePool.stats().degraded,
    recentNavigations: recentNavs,
    ...(blocker ? { blocker } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
  });

  const publish = (next?: SessionStatus): void => {
    if (next) status = next;
    options.onUpdate?.(snapshot());
  };

  // ═══════════════════════════════════════════════════════════════════
  // MAIN DRIVE LOOP
  // ═══════════════════════════════════════════════════════════════════
  // Declared before `drive` so the session report (built after the loop
  // exits) can still name the site this session browsed.
  const storefrontUrl: string = profile?.storefront ?? config.storefront;

  const drive = async (): Promise<void> => {
    publish("running");

    // Navigate to storefront (profile's own shop wins over the global config).
    // A relaunch resumes the page the visitor was actually on, not the shop
    // root — the desktop window continues the visit the tile was showing.
    if (!storefrontUrl) {
      throw new Error("No storefront configured for this session");
    }
    const entryUrl = options.resumeUrl || storefrontUrl;
    try {
      await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(pacing.pageSettle());
      if (options.resumeUrl) {
        logger.info("session_resumed", `reopened on ${options.resumeUrl}`, {
          data: { resumeUrl: options.resumeUrl, elapsedOffsetMs: elapsedOffsetMs },
        });
      }
    } catch (err) {
      logger.warn("initial_nav_failed", err instanceof Error ? err.message : String(err));
    }

    let lastUrl = page.url();
    let loopCount = 0;
    let emptyHtmlCount = 0;
    const MAX_EMPTY_HTML = 5;

    while (true) {
      await control.gate();
      if (control.shouldClose || control.shouldPark) {
        exitReason = control.shouldClose ? "aborted" : "engine_exit";
        break;
      }
      if (signal?.aborted) { exitReason = "aborted"; break; }
      if (timer.isHardExpired()) { exitReason = "timer"; break; }
      if (timer.isExpired()) { exitReason = "timer"; break; }

      loopCount++;
      const currentUrl = page.url();
      const urlChanged = currentUrl !== lastUrl;

      // Update title
      if (urlChanged || loopCount % 10 === 0) {
        lastTitle = await page.title().catch(() => "");
        lastUrl = currentUrl;
      }

      // Step 1: Extract all anchor tags via Playwright (much faster than raw HTML)
      let htmlSource = "";
      try {
        // Wait for page to have content
        await sleep(rng.int(3000, 6000));
        await page.waitForFunction(
          () => document.readyState === "complete" && document.querySelectorAll("a[href]").length > 5,
          { timeout: 20000 },
        ).catch(() => {});

        htmlSource = await page.evaluate(() => {
          const anchors = document.querySelectorAll('a[href*="/products/"], a[href]');
          const seen = new Set<string>();
          const results: string[] = [];
          for (const a of Array.from(anchors)) {
            const href = (a as HTMLAnchorElement).href || "";
            const text = ((a as HTMLElement).innerText || "").trim().slice(0, 80);
            if (!href || href.startsWith("javascript:") || href === "#") continue;
            try {
              const u = new URL(href, location.origin);
              const path = u.pathname;
              if (seen.has(path)) continue;
              seen.add(path);
              // Include ALL links - Claude will classify
              results.push(path + " | " + text);
            } catch {}
            if (results.length >= 200) break;
          }
          return results.join("\n");
        });
      } catch {
        htmlSource = "";
      }

      if (!htmlSource || htmlSource.length < 20) {
        emptyHtmlCount++;
        logger.warn("empty_links", "No links extracted (" + emptyHtmlCount + "/5)", { url: currentUrl });
        if (emptyHtmlCount >= 2) {
          // Go back to previous page and let engine pick another product
          logger.info("recovery", "Empty links, going back to find another product");
          await page.goBack({ timeout: 15000 }).catch(() => {});
          lastUrl = ""; // Force re-detection on new URL
          emptyHtmlCount = 0;
          await sleep(2000);
          continue;
        }
        await sleep(2000);
        continue;
      }
      emptyHtmlCount = 0;
      // ── Step 3: Get AI decision ──
      let decision: AiDecision;
      try {
        decision = await engine.decide(detector, currentUrl, htmlSource, timer);
      } catch (err) {
        logger.error("engine_error", err instanceof Error ? err.message : String(err), { url: currentUrl });
        exitReason = "error";
        errorMessage = err instanceof Error ? err.message : String(err);
        break;
      }

      lastReason = decision.reason;

      if (decision.action === "exit") {
        exitReason = timer.isExpired() ? "timer" : "engine_exit";
        break;
      }

      lastAction = decision.action;
      publish();

      // ── Step 4: Execute with human-like delays ──
      const outcome = await executeDecision(decision, page, logger, rng, pacing);

      if (outcome.navigated) {
        pagesVisited++;
        // Track product/collection visits from URL pattern
        const navUrl = page.url();
        try {
          const parsedNav = new URL(navUrl);
          const navPath = parsedNav.pathname ?? "";
          if (navPath.includes("/products/")) {
            const prodClean = navPath.split("?")[0]?.split("#")[0];
            if (prodClean) engine.state.visitedProducts.add(prodClean);
          }
          if (navPath.includes("/collections/")) {
            const collClean = navPath.split("?")[0]?.split("#")[0];
            if (collClean) engine.state.visitedProducts.add(collClean);
          }
        } catch {}
        if (outcome.metrics) {
          if (!slowestNav || outcome.metrics.elapsedMs > slowestNav.elapsedMs) {
            slowestNav = outcome.metrics;
          }
          recentNavs.push(outcome.metrics);
          if (recentNavs.length > RECENT_CAP) recentNavs.shift();
        }
        // Wait for new page to settle
        await sleep(pacing.pageSettle());
        // Force re-detection on next iteration
        lastUrl = "";
      }

      if (outcome.failed) navigationErrors++;

      publish();

      // Human-like pause between actions: 2-6s base + random
      await sleep(rng.int(2000, 6000));
    }
  };

  // ── Session lifecycle ──
  const done = (async (): Promise<SessionResult> => {
    try {
      await drive();
    } catch (err) {
      exitReason = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("session_error", errorMessage);
    }

    const lingerMs = options.lingerMs ?? 0;
    if (lingerMs !== 0 && !control.shouldClose && exitReason !== "error") {
      lingeringSince = new Date().toISOString();
      publish(blocker ? "blocked" : "lingering");
      await control.waitForClose(lingerMs);
    }

    publish("stopping");
    await browser.close().catch(() => {});

    const result: SessionResult = {
      sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: timer.elapsedMs(),
      exitReason,
      actionsPerformed: engine.state.aiCallsCount,
      pagesVisited,
      productsViewed: engine.state.visitedProducts.size,
      collectionsViewed: engine.state.visitedProducts.size,
      jsErrors,
      consoleErrors,
      failedRequests,
      navigationErrors,
      slowestNavigation: slowestNav,
      ...(blocker ? { blocker } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    };

    const stats = cookiePool.stats();
    // Save detailed session report
    try {
      saveSessionReport({
        sessionId,
        profileName: profile?.name ?? "unknown",
        site: storefrontUrl || "(unset)",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMinutes: Math.round(timer.elapsedMs() / 60000),
        personality: (engine as any).personality ?? "unknown",
        pagesVisited,
        productsClicked: [...(engine.state.visitedProducts ?? [])],
        addToCartPerformed: engine.state.advanceActionPerformed,
        cartAbandoned: false,
        popupsDismissed: 0,
        aiCalls: { total: engine.state.aiCallsCount, avgMs: engine.state.aiCallsCount > 0 ? Math.round(engine.state.aiCallsTotalMs / engine.state.aiCallsCount) : 0, cached: 0 },
        cookiesUsed: [],
        errors: jsErrors + consoleErrors + navigationErrors,
      }, "./reports");
    } catch {}

    logger.info(
      "session_end",
      exitReason +
        " | " + result.pagesVisited + " pages" +
        " | " + result.productsViewed + " products" +
        " | " + result.actionsPerformed + " ai_calls" +
        " | cookies: " + stats.active + " active, " + stats.quarantined + " quarantined",
    );
    await logger.close();
    publish(errorMessage ? "error" : "finished");
    return result;
  })();

  done.catch(() => undefined);

  return {
    sessionId,
    profileId: profile?.id,
    page,
    context: browser.context,
    snapshot,
    pause: () => {
      if (status === "running") { control.pause(); publish("paused"); }
    },
    resume: () => {
      if (status === "paused") { control.resume(); publish("running"); }
    },
    extend: (ms: number) => { timer.extend(ms); publish(); },
    park: () => control.park(),
    close: async () => {
      control.requestClose();
      const settled = await Promise.race([
        done.then(() => true),
        new Promise<boolean>(r => setTimeout(() => r(false), 3000)),
      ]);
      if (!settled) await browser.context.close().catch(() => {});
      return done;
    },
    done,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// DECISION EXECUTION
// ═══════════════════════════════════════════════════════════════════════


// ── Human-like mouse simulation ──
async function humanMouse(page: any, rng: Rng): Promise<void> {
  try {
    const vp = page.viewportSize() ?? { width: 1440, height: 900 };
    // Move mouse to random position with small steps (like a real hand)
    const targetX = Math.round(vp.width * rng.float(0.1, 0.9));
    const targetY = Math.round(vp.height * rng.float(0.1, 0.8));
    const steps = rng.int(3, 6);
    let curX = Math.round(vp.width * rng.float(0.2, 0.8));
    let curY = Math.round(vp.height * rng.float(0.2, 0.7));
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps;
      const x = Math.round(curX + (targetX - curX) * t + rng.int(-5, 5));
      const y = Math.round(curY + (targetY - curY) * t + rng.int(-3, 3));
      await page.mouse.move(x, y).catch(() => {});
      await sleep(rng.int(30, 80));
    }
    curX = targetX; curY = targetY;
  } catch {}
}

// Hover near an element before clicking (human behavior)
async function hoverBeforeClick(page: any, selector: string | undefined, rng: Rng): Promise<void> {
  if (!selector) { await humanMouse(page, rng); return; }
  try {
    const loc = page.locator(selector).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        // Move toward element in a curve
        const cx = box.x + box.width * rng.float(0.3, 0.7);
        const cy = box.y + box.height * rng.float(0.3, 0.7);
        await page.mouse.move(cx, cy, { steps: rng.int(4, 8) }).catch(() => {});
        await sleep(rng.int(200, 500));
        return;
      }
    }
  } catch {}
  // Fallback: random mouse movement
  await humanMouse(page, rng);
}


interface ExecOutcome {
  navigated: boolean;
  failed: boolean;
  metrics: NavigationMetrics | null;
}

async function executeDecision(
  decision: AiDecision,
  page: Page,
  logger: Logger,
  rng: Rng,
  pacing: Pacing,
): Promise<ExecOutcome> {
  const noNav: ExecOutcome = { navigated: false, failed: false, metrics: null };

  try {
    switch (decision.action) {
      // ── Navigation ──
      case "goto_home":
      case "goto_collection":
      case "goto_product": {
        const url = decision.url || decision.targetElement?.url;
        if (!url) return noNav;
        const started = Date.now();
        try {
          const resp = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          return {
            navigated: true,
            failed: false,
            metrics: {
              url,
              status: resp?.status() ?? null,
              elapsedMs: Date.now() - started,
              ttfbMs: null,
              domContentLoadedMs: null,
              loadEventMs: null,
              firstContentfulPaintMs: null,
              jsErrors: 0,
              consoleErrors: 0,
              failedRequests: 0,
            },
          };
        } catch {
          return {
            navigated: true,
            failed: true,
            metrics: {
              url,
              status: null,
              elapsedMs: Date.now() - started,
              ttfbMs: null,
              domContentLoadedMs: null,
              loadEventMs: null,
              firstContentfulPaintMs: null,
              jsErrors: 0,
              consoleErrors: 0,
              failedRequests: 0,
            },
          };
        }
      }

      // ── Go back ──
      case "go_back": {
        await page.goBack({ timeout: 15_000 }).catch(() => null);
        return noNav;
      }

      // ── Click element (links, buttons, popups, etc.) ──
      // Click element: URL navigation first, CSS selector as fallback
      case "click_element": {
        const targetEl = decision.targetElement;
        if (!targetEl) return noNav;
        const targetUrl = targetEl.url;
        const sel = targetEl.selector || "";
        await hoverBeforeClick(page, sel || undefined, rng);

        // STRATEGY 1: Navigate directly via URL (most reliable)
        if (targetUrl) {
          try {
            const fullUrl = targetUrl.startsWith("/") 
              ? new URL(targetUrl, page.url()).href 
              : targetUrl;
            if (fullUrl.startsWith("http")) {
              const navStart = Date.now();
              logger.info("click_url_nav", "navigating to: " + fullUrl.slice(0,80));
              await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
              return {
                navigated: true, failed: false,
                metrics: { url: fullUrl, status: null, elapsedMs: Date.now() - navStart, ttfbMs: null, domContentLoadedMs: null, loadEventMs: null, firstContentfulPaintMs: null, jsErrors: 0, consoleErrors: 0, failedRequests: 0 },
              };
            }
          } catch {
            logger.debug("url_nav_failed", "URL nav failed for: " + (targetUrl||"").slice(0,60));
          }
        }

        // STRATEGY 2: Try CSS selector from AI
        if (sel && !sel.startsWith("text=")) {
          try {
            const loc = page.locator(sel).first();
            const vis = await loc.isVisible({ timeout: 2000 }).catch(() => false);
            if (vis) {
              await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await sleep(rng.int(150, 400));
              await loc.click({ timeout: 5000 }).catch(() => {});
              // Wait briefly to see if page changes
              await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
              logger.debug("click_selector_ok", "clicked: " + sel);
              return noNav;
            }
          } catch {}
        }

        // STRATEGY 3: Try text-based matching
        if (targetEl.text) {
          try {
            const textLoc = page.getByText(targetEl.text, { exact: false }).first();
            const visT = await textLoc.isVisible({ timeout: 2000 }).catch(() => false);
            if (visT) {
              await textLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await textLoc.click({ timeout: 5000 }).catch(() => {});
              await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
              logger.debug("click_text_ok", "clicked by text: " + targetEl.text.slice(0,50));
              return noNav;
            }
          } catch {}
        }

        // STRATEGY 4: Try href partial match
        if (targetUrl) {
          try {
            const urlPath = new URL(targetUrl, page.url()).pathname;
            const hrefLoc = page.locator("a[href*=\"" + urlPath + "\"]").first();
            const visH = await hrefLoc.isVisible({ timeout: 2000 }).catch(() => false);
            if (visH) {
              await hrefLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await hrefLoc.click({ timeout: 5000 }).catch(() => {});
              await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
              const navStart2 = Date.now();
              return {
                navigated: true, failed: false,
                metrics: { url: page.url(), status: null, elapsedMs: Date.now() - navStart2, ttfbMs: null, domContentLoadedMs: null, loadEventMs: null, firstContentfulPaintMs: null, jsErrors: 0, consoleErrors: 0, failedRequests: 0 },
              };
            }
          } catch {}
        }

        logger.debug("click_all_failed", "all strategies exhausted");
        return noNav;
      }

      // ── Hover ──
      case "hover_element": {
        if (!decision.targetElement?.selector) return noNav;
        const h = page.locator(decision.targetElement.selector).first();
        if (await h.isVisible({ timeout: 3000 }).catch(() => false)) {
          await h.hover({ timeout: 5000 }).catch(() => {});
        }
        return noNav;
      }

      // ── Scroll (human-like wheel input) ──
      case "scroll": {
        // Sometimes move mouse before scrolling (like a real person)
        if (rng.chance(0.3)) await humanMouse(page, rng);
        const vh = await page.evaluate(() => window.innerHeight);
        const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
        const steps = rng.int(2, 4);
        const direction = rng.chance(0.8) ? 1 : -1; // 80% scroll down

        for (let i = 0; i < steps; i++) {
          const distance = Math.round(vh * rng.float(0.25, 0.55) * direction);
          try {
            await page.mouse.wheel(0, distance);
          } catch { break; }
          await sleep(rng.int(300, 800));
        }

        // 20% chance of scrolling back up a bit
        if (direction === 1 && rng.chance(0.2)) {
          await sleep(rng.int(400, 900));
          const backDistance = Math.round(vh * rng.float(0.15, 0.35));
          try { await page.mouse.wheel(0, -backDistance); } catch {}
          await sleep(rng.int(300, 600));
        }

        void maxScroll; // used for bounds checking if needed
        return noNav;
      }

      // ── Dwell (reading / looking) ──
      case "dwell": {
        await sleep(rng.int(1500, 4000));
        return noNav;
      }

      // ── Add to cart (advance action) ──
      case "add_to_cart": {
        if (!decision.targetElement?.selector) return noNav;
        await hoverBeforeClick(page, decision.targetElement.selector, rng);
        const btn = page.locator(decision.targetElement.selector).first();
        const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
        if (visible) {
          await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await sleep(rng.int(200, 500));
          await btn.click({ timeout: 5_000 }).catch(() => {});
          logger.info("add_to_cart", "clicked add-to-cart button", {
            url: page.url(),
            data: { selector: decision.targetElement.selector },
          });
        } else {
          logger.debug("add_to_cart_invisible", "Add-to-cart button not visible", {
            url: page.url(),
          });
        }
        // Wait like a real user seeing cart update
        await sleep(rng.int(2000, 4000));
        
        // Cart abandonment: sometimes navigate to /cart then leave
        if (rng.chance(0.35)) {
          try {
            const baseUrl = new URL(page.url());
            await page.goto(baseUrl.origin + "/cart", { waitUntil: "domcontentloaded", timeout: 15000 });
            logger.info("cart_view", "Viewed cart page (abandonment)");
            await sleep(rng.int(3000, 8000));
          } catch {}
        }
        
        // Go back to continue browsing
        await page.goBack({ timeout: 15_000 }).catch(() => null);
        return noNav;
      }

      // ── Exit ──
      case "exit":
        return noNav;
    }
  } catch (err) {
    logger.error(
      "action_failed",
      decision.action + ": " + (err instanceof Error ? err.message : String(err)),
    );
    return { navigated: false, failed: true, metrics: null };
  }

  return noNav;
}

export { sleep };