/**
 * AI-Driven Session Manager - manages one browsing session.
 *
 * Core loop:
 *   1. Extract a source digest from the page (isolated world when possible)
 *   2. AI decides next action (click, scroll, add-to-cart, ...)
 *   3. Backend executes with random human-like delays
 *   4. On new page → repeat from step 1
 *
 * Bot walls are detected from the page title and handled with a bounded
 * back-off (see the drive loop). There is no popup-dismissal layer: overlays
 * are navigated around, not clicked away.
 *
 * Advance action: at ai.advanceActionTimeMs (default 10 minutes) the engine
 * clicks add-to-cart once — gated by safety.allowCart — then resumes browsing.
 */
import type { BrowserContext, Page } from "rebrowser-playwright";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { Rng, randomSeed, sleep } from "../util/random.js";
import { launchBrowser, type BrowserEngine } from "../browser/chrome.js";
import { openSessionPage } from "../navigator/pageNavigator.js";
import { Pacing } from "../behavior/timing.js";
import { SessionTimer } from "./timer.js";
import { CookiePool } from "../ai/cookiePool.js";
import { ElementDetector } from "../ai/elementDetector.js";
import { AiBehaviorEngine, type Personality, type VisitStateSnapshot } from "../behavior/aiEngine.js";
import { preprocessHtml } from "../ai/promptTemplates.js";
import type { Profile } from "../profiles/types.js";
import { evaluateIsolated } from "../navigator/isolate.js";
import { wheelBy, seatCursor } from "../navigator/wheel.js";
import type { AiDecision, NavigationMetrics, SessionBlocker, SessionResult } from "../types.js";
import { saveSessionReport } from "./sessionReport.js";
import { DEFAULT_AI_CONFIG } from "../config.js";
import { HumanCursor } from "../behavior/humanCursor.js";
import { WafChallengeDetector } from "../security/wafDetector.js";

/**
 * Build the SOURCE DIGEST the AI reads. Runs inside an isolated world via
 * CDP when possible (invisible to page scripts), falling back to
 * page.evaluate. Self-contained on purpose: no closures, so it can be
 * serialized into either world unchanged.
 *
 * Layout:
 *   JSON-LD:{...}            authoritative product markers
 *   OG:TYPE=product          secondary confirmation
 *   LINKS:                   every unique same-origin path + text + card ctx + price
 *   CONTROLS:                buttons/submits — where an add-to-cart lives
 */
export function extractSourceDigest(): string {
  const out: string[] = [];
  const push = (line: string): void => { if (out.length < 280) out.push(line); };

  // The title carries bot-wall fingerprints ("Just a moment...", etc.) that
  // survive even when nothing else renders.
  push("TITLE=" + (document.title || "").slice(0, 120));
  // Rendered-text size: a hydrated-but-blank SPA (failed XHRs, throttled
  // APIs) keeps hidden template anchors while showing a white screen.
  const bodyTextLen = ((document.body?.innerText || "").replace(/\s+/g, " ").trim()).length;
  push("BODYTEXT=" + bodyTextLen);

  const ld: string[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    const t = (s.textContent || "").trim();
    if (t && t.length <= 1500 && /"@type"\s*:\s*"?product/i.test(t)) ld.push(t);
  });
  if (ld.length) push("JSON-LD:\n" + ld.join("\n---\n"));
  const og = document.querySelector('meta[property="og:type"]');
  const ogType = og ? og.getAttribute("content") : null;
  if (ogType) push("OG:TYPE=" + ogType);

  // Variant controls: option selects and radio groups. Placed early — a PDP's
  // size/colour pickers are exactly what the ATC plan needs and must not be
  // crowded out of the line budget by navigation links.
  push("VARIANTS:");
  const seenVariant = new Set<string>();
  document.querySelectorAll("select").forEach((s) => {
    const el = s as HTMLSelectElement;
    const key = "select" + (el.id || el.name || "");
    if (!el.options.length || seenVariant.has(key)) return;
    seenVariant.add(key);
    const label = (el.closest("label")?.textContent || el.getAttribute("aria-label") || "options").trim().slice(0, 30);
    const opts = Array.from(el.options).map((o) => o.text.trim()).filter(Boolean).slice(0, 12).join("|");
    if (opts) push(`select${el.id ? "#" + el.id : ""}${el.name ? "[name=" + el.name + "]" : ""} | ${label} | opts:${opts}`);
  });
  const radioGroups = new Map<string, string[]>();
  document.querySelectorAll('input[type=radio]').forEach((r) => {
    const el = r as HTMLInputElement;
    if (!el.name) return;
    const lbl = ((el.closest("label")?.textContent || "") || el.value || "").trim().slice(0, 24);
    if (!radioGroups.has(el.name)) radioGroups.set(el.name, []);
    const arr = radioGroups.get(el.name) as string[];
    if (arr.length < 12 && lbl) arr.push(lbl);
  });
  for (const [nm, opts] of radioGroups) {
    if (opts.length >= 2) {
      push(`radio[name=${nm}] | group | opts:${opts.join("|")}`);
      if (out.length > 250) break;
    }
  }

  push("LINKS:");
  const seen = new Set<string>();
  const productLines: string[] = [];
    const otherLines: string[] = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const el = a as HTMLAnchorElement;
      const href = el.href || "";
      if (!href || href.startsWith("javascript:") || href.endsWith("#")) return;
      let u: URL;
      try { u = new URL(href, location.origin); } catch { return; }
      if (seen.has(u.pathname)) return;
      seen.add(u.pathname);
      // Flatten whitespace: multi-line link text would otherwise tear one
      // entry into two digest lines.
      const text = ((el as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const card = el.closest('[class*="card"], [class*="product"], article, li');
      const cls = card ? String(card.className).slice(0, 90) : "";
      const priceEl = card?.querySelector("[class*='price'], [data-price]");
      const price = priceEl ? ((priceEl as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 30) : "";
      const line = u.pathname + (u.search || "") + " | " + text + (cls ? " | ctx:" + cls : "") + (price ? " | price:" + price : "");
      // Product links go first: header/footer nav must not crowd them out of
      // the line budget (a 280-line cap fills with ~100 nav links easily).
      if (/\/products?\//.test(u.pathname)) productLines.push(line);
      else otherLines.push(line);
    });
    [...productLines, ...otherLines].forEach(push);

  // Buttons/submits — where an add-to-cart lives. ATC-shaped labels go
  // first: upsell/gift widgets can fill the whole line budget otherwise.
  push("CONTROLS:");
  const atcControls: string[] = [];
  const otherControls: string[] = [];
  document.querySelectorAll('button, input[type=submit], [role="button"]').forEach((b) => {
    const el = b as HTMLButtonElement;
    const rawLabel = (el.innerText || el.value || el.getAttribute("aria-label") || "") as string;
    // Flatten newlines: a two-line label ("Ajouter au panier\nAjouté") must
    // stay one digest line or the parsers below tear it apart.
    const label = rawLabel.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!label) return;
    const form = el.closest("form");
    const action = form ? (form.getAttribute("action") || "") : "";
    const bits = [
      el.name ? "name=" + el.name : "",
      action.includes("cart") ? "form:" + action.slice(0, 60) : "",
    ].filter(Boolean);
    const line = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + " | " + label + (bits.length ? " | " + bits.join(" ") : "");
    if (/add\s|buy|cart|bag|mua|giỏ/i.test(label)) atcControls.push(line);
    else otherControls.push(line);
  });
  [...atcControls, ...otherControls].forEach(push);

  return out.join("\n");
}

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
  /** Add-to-cart CONFIRMED by the shop (network/drawer/cart/count), not merely
   * clicked. atcPerformed can be true while this is false = "clicked, unconfirmed". */
  atcVerified: boolean;
  /** Effective timed-ATC schedule in minutes; null = timed ATC off. */
  atcMinutes?: number | null;
  /** Whether the account tab (shop.app/account) shows a logged-in visitor. */
  accountLoggedIn: boolean;
  /** Email detected on the account page, when logged in. */
  accountEmail: string | null;
  cookiePoolHealthy: number;
  cookiePoolDegraded: number;
  recentNavigations: NavigationMetrics[];
  liveActionText?: string;
  activeProductTitle?: string;
  activeProductPrice?: string;
  wafStatus?: "clean" | "turnstile_bypassing" | "solved" | "blocked";
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
  /**
   * Visit identity carried across a desktop/background switch: personality,
   * seen products, cart history. Without it a relaunch would be a different
   * visitor wearing the same cookies.
   */
  inherited?: VisitStateSnapshot;
  /**
   * Share ONE cookie pool across every session in this process: a rate limit
   * hit by one session immediately hides that cookie from all the others.
   * Omitted, each session builds its own and learns limits the hard way.
   */
  cookiePool?: CookiePool;
  /**
   * A second tab opened alongside the storefront on launch, showing an account
   * page for the imported cookies (default https://shop.app/account). The
   * driving loop never touches it — it is a live "am I logged in?" view. Pass
   * null to open no second tab.
   */
  accountTabUrl?: string | null;
  /** Expected account email (from the imported cookie's filename) so the
   * account-tab login check confirms the RIGHT account, not just any email. */
  accountEmailHint?: string;
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
  /** Operator-requested add-to-cart on the next viable product page. */
  forceAtc(): void;
  /** Capture the visit's identity for a desktop/background handoff. */
  exportVisitState(): VisitStateSnapshot;
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

  // Duration override from profile (only on fresh visit when session is not resumed)
  const durOverride = (options.inherited || (options.elapsedOffsetMs && options.elapsedOffsetMs > 0)) ? undefined : profile?.durationMinutes;
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
    data: {
      seed, slot, profile: profile?.name, storefront: config.storefront,
      atcMinutes: (config as any).ai?.advanceActionTimeMs >= Number.MAX_SAFE_INTEGER
        ? null
        : Math.round(((config as any).ai?.advanceActionTimeMs ?? 600_000) / 60_000),
    },
  });

  // Account-tab login state — written once by openAccountTab, read in snapshot().
  let accountLoggedIn = false;
  let accountEmail: string | null = null;

  // ── Launch browser (revivable) ──
  // The browser is a mutable handle: when the operator closes the desktop
  // window out from under a running session, the context dies but the visit
  // should not — the session relaunches it in the background on the same
  // persistent profile and carries on. Desktop ↔ background switching must
  // never end the visit.
  let browser = await launchBrowser({
    slot, sessionId, config, logger, rng,
    ...(profile ? { profile } : {}),
    ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
  });
  // Everything from here to the end of setup runs against a live Chrome
  // process. If any step throws, the process is orphaned — the orchestrator's
  // launch-timeout cleanup only closes on RESOLVE, not on reject. So close the
  // context ourselves on any setup failure before rethrowing.
  let page: Page;
  try {
    page = await openSessionPage(browser.context);
    page.setDefaultTimeout(10_000);
    await options.onPage?.(page, browser.context);

    // Second tab: shop.app/account. Cookies live at the CONTEXT level, so the
    // shop.app jar injected at launch is already available here — opening the
    // account page lets the operator confirm the imported login landed. The
    // driving loop never touches this tab; it exists purely as a live account
    // view alongside the storefront the session actually browses.
    const openAccountTab = async (): Promise<void> => {
      if (options.accountTabUrl === null) return; // explicitly disabled
      const url = options.accountTabUrl ?? "https://shop.app/account";
      try {
        const acct = await browser.context.newPage();
        acct.setDefaultTimeout(10_000);
        await acct.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        // Give the account SPA a moment to hydrate, then read the page text to
        // confirm the imported cookie actually logged the visitor in. If an
        // expected email was provided (from the cookie filename), require THAT
        // email; otherwise any email on the page counts as logged-in.
        await sleep(4000);
        const bodyText = await acct.evaluate(() => (document.body?.innerText || "").slice(0, 4000)).catch(() => "");
        const hint = options.accountEmailHint?.toLowerCase();
        if (hint && bodyText.toLowerCase().includes(hint)) {
          accountLoggedIn = true;
          accountEmail = options.accountEmailHint ?? null;
        } else {
          const m = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(bodyText);
          if (m) { accountLoggedIn = true; accountEmail = m[0]; }
        }
        logger.info("account_tab", "opened account tab", { data: { url, loggedIn: accountLoggedIn, email: accountEmail } });
        // Close the account verification tab immediately so it does not consume RAM/CPU in background
        await acct.close().catch(() => undefined);
        await page.bringToFront().catch(() => undefined);
      } catch (err) {
        logger.warn("account_tab_failed", err instanceof Error ? err.message : String(err));
      }
    };
    await openAccountTab();
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }

  /** Set the moment the context goes away (window closed, process killed). */
  let contextClosed = false;
  const watchContext = (): void => {
    browser.context.once("close", () => {
      if (control.shouldClose) return;
      contextClosed = true;
      logger.warn("browser_lost", "browser context closed - will revive in background");
    });
  };
  watchContext();

  /**
   * Relaunch the browser in the background (always headless: an operator who
   * closed the window asked for background, not for another window). Reopens
   * the page the visitor was on; the session clock never stops.
   */
  const reviveBrowser = async (): Promise<boolean> => {
    const MAX_REVIVES = 3;
    for (let attempt = 1; attempt <= MAX_REVIVES; attempt++) {
      logger.info("browser_revive", "attempt " + attempt + "/" + MAX_REVIVES + " (background)");
      try {
        // Free the persistent profile directory BEFORE relaunching: Chromium
        // single-locks a user-data dir, so launching first would collide
        // with the dying process on every attempt.
        try { await browser.close().catch(() => undefined); } catch {}
        await sleep(600);
        const bgConfig: SimulatorConfig = {
          ...config,
          browser: { ...config.browser, headless: true },
        };
        const fresh = await launchBrowser({
          slot, sessionId, config: bgConfig, logger, rng,
          ...(profile ? { profile } : {}),
          ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
        });
        browser = fresh;
        page = await openSessionPage(browser.context);
        page.setDefaultTimeout(10_000);
        attachPageTelemetry(page);
        watchContext();
        contextClosed = false;
        await options.onPage?.(page, browser.context);
        publish();
        return true;
      } catch (err) {
        logger.warn("browser_revive_failed", err instanceof Error ? err.message : String(err));
        await sleep(2000 * attempt);
      }
    }
    return false;
  };

  // ── AI layer ──
  // Config file values win; profile-level atcMinutes overrides advanceActionTimeMs.
  const profileAtcMs = profile?.atcMinutes !== undefined && profile?.atcMinutes !== null
    ? (profile.atcMinutes === 0 ? Number.MAX_SAFE_INTEGER : profile.atcMinutes * 60_000)
    : undefined;

  const aiConfig = {
    ...DEFAULT_AI_CONFIG,
    ...(((config as any).ai ?? {}) as Partial<typeof DEFAULT_AI_CONFIG>),
    ...(profileAtcMs !== undefined ? { advanceActionTimeMs: profileAtcMs } : {}),
  };
  const cookiePool = options.cookiePool ?? new CookiePool(aiConfig.cookiesDir);
  const poolStats = cookiePool.stats();
  logger.info("cookie_pool", `loaded=` + poolStats.totalLoaded + ` active=` + poolStats.active + ` quarantined=` + poolStats.quarantined, {
    data: { ...poolStats },
  });

  const detector = new ElementDetector(cookiePool, logger, {
    maxRetries: aiConfig.maxRetries,
    maxHtmlChars: aiConfig.maxHtmlChars,
    model: aiConfig.model,
    ...(aiConfig.claudeBaseUrl ? { baseUrl: aiConfig.claudeBaseUrl } : {}),
  });
  // Random personality per session (behavioral fingerprinting)
  const personalities: Personality[] = ["browser", "browser_fast", "shopper", "researcher"];
  const engine = new AiBehaviorEngine({ ...config, ai: aiConfig } as any, rng, logger, rng.pick(personalities));
  // A desktop/background handoff keeps the SAME visitor: identity first,
  // then everything the visit had already seen and done.
  if (options.inherited) {
    engine.inheritVisitState(options.inherited);
    logger.info("visit_inherited", "continuing as the same visitor", {
      data: {
        personality: options.inherited.personality,
        seenProducts: options.inherited.visitedProducts.length,
        atcPerformed: options.inherited.advanceActionPerformed,
      },
    });
  }
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
  // Add-to-cart CONFIRMED (not merely clicked). atcPerformed says the engine
  // decided to click; atcVerified says the shop acknowledged the item.
  let atcVerified = false;
  const recentNavs: NavigationMetrics[] = [];
  const RECENT_CAP = 30;
  // Real counters — the snapshot used to report aiCallsCount here, which
  // counted model calls, not things the visitor actually did.
  let actionsCount = 0;
  const visitedCollections = new Set<string>();

  // JS error tracking. The count alone is useless for debugging — each
  // distinct uncaught exception gets logged once, up to a cap so a page that
  // throws in a loop cannot flood the JSONL. Re-attached to every revived
  // page, since a browser relaunch brings a fresh document.
  let jsErrors = 0;
  let consoleErrors = 0;
  let failedRequests = 0;
  const loggedJsErrors = new Set<string>();
  const MAX_LOGGED_JS_ERRORS = 20;

  let liveActionText = "Đang khởi tạo...";
  let activeProductTitle = "";
  let activeProductPrice = "";
  let wafStatus: "clean" | "turnstile_bypassing" | "solved" | "blocked" = "clean";

  const attachPageTelemetry = (p: Page): void => {
    p.on("pageerror", (err) => {
      jsErrors++;
      const msg = String(err instanceof Error ? err.message : err).replace(/\s+/g, " ").trim().slice(0, 200);
      if (msg && loggedJsErrors.size < MAX_LOGGED_JS_ERRORS && !loggedJsErrors.has(msg)) {
        loggedJsErrors.add(msg);
        logger.warn("js_error", msg, { url: p.url() });
      }
    });
    p.on("console", (msg) => { if (msg.type() === "error") consoleErrors++; });
    p.on("requestfailed", () => { failedRequests++; });
  };
  attachPageTelemetry(page);

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
    collectionsViewed: visitedCollections.size,
    actionsPerformed: actionsCount,
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
    atcVerified,
    /** Effective timed-ATC mark for this session, in minutes (null = off). */
    atcMinutes: aiConfig.advanceActionTimeMs >= Number.MAX_SAFE_INTEGER ? null : Math.round(aiConfig.advanceActionTimeMs / 60_000),
    accountLoggedIn,
    accountEmail,
    cookiePoolHealthy: cookiePool.stats().healthy,
    cookiePoolDegraded: cookiePool.stats().degraded,
    recentNavigations: recentNavs,
    liveActionText,
    activeProductTitle,
    activeProductPrice,
    wafStatus,
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
      const ok = await smartNav(page, entryUrl, 30_000);
      if (!ok) logger.warn("initial_nav_failed", "page did not confirm load: " + entryUrl);
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
    // Recovery ladder state: consecutive empty-digest recoveries, and the URL
    // the last recovery ran on (a healthy page elsewhere resets the count).
    let emptyRecoveries = 0;
    const MAX_EMPTY_RECOVERIES = 4;
    let recoveredFromUrl = "";
    // Consecutive bot-wall pages; a clean page in between resets it.
    let consecutiveChallenges = 0;

    // One browsing turn: extract → decide → execute. Returns "continue" to
    // skip ahead, "break" to stop, "ok" when the turn ran through.
    const doTurn = async (): Promise<"continue" | "break" | "ok"> => {
      const currentUrl = page.url();
      const urlChanged = currentUrl !== lastUrl;

      // Update title
      if (urlChanged || loopCount % 10 === 0) {
        lastTitle = await page.title().catch(() => "");
        lastUrl = currentUrl;
      }

      // Step 1: Build the source digest the AI reads.
      let htmlSource = "";
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
        htmlSource =
          (await evaluateIsolated(page, extractSourceDigest)) ??
          (await page.evaluate(extractSourceDigest).catch(() => ""));
      } catch {
        htmlSource = "";
      }

      // ── WAF & Bot Challenge Detection Ladder ──
      const wafState = await WafChallengeDetector.inspectPage(page, logger);
      if (wafState.engine !== "none") {
        logger.warn("waf_challenge_detected", `WAF challenge encountered: ${wafState.engine}`, { data: { url: currentUrl } });
        const solveRes = await WafChallengeDetector.resolveChallenge(page, wafState, logger);
        if (solveRes.resolved) {
          logger.info("waf_challenge_cleared", `WAF challenge ${wafState.engine} cleared successfully via ${solveRes.actionTaken}`);
          consecutiveChallenges = 0;
          lastUrl = "";
          return "continue";
        }

        consecutiveChallenges++;
        if (pagesVisited > 0 && consecutiveChallenges <= 2) {
          logger.warn("challenge_backoff", `Bot wall on ${currentUrl} — going back (${consecutiveChallenges}/2)`, { data: { url: currentUrl } });
          await page.goBack({ timeout: 15_000 }).catch(() => undefined);
          lastUrl = "";
          return "continue";
        }
        const title = /^TITLE=(.*)$/m.exec(htmlSource)?.[1] ?? wafState.pageTitle ?? "(untitled)";
        blocker = { kind: "challenge", message: `Bot challenge (${wafState.engine}): ${title}`, url: currentUrl };
        lastReason = blocker.message;
        logger.error("session_blocked", blocker.message, { data: { url: currentUrl } });
        exitReason = "engine_exit";
        return "break";
      }
      consecutiveChallenges = 0;

      // Check for truly blank pages (less than 10 chars AND no links or controls)
      const bodyTextLen = Number(/^BODYTEXT=(\d+)$/m.exec(htmlSource)?.[1] ?? 9999);
      const hasLinksOrControls = /LINKS:\s*\S|CONTROLS:\s*\S/m.test(htmlSource);
      if (bodyTextLen < 10 && !hasLinksOrControls && htmlSource.length >= 20) {
        logger.warn("blank_page", `rendered text only ${bodyTextLen} chars and no links — treating as empty`, { url: currentUrl });
        htmlSource = ""; // fall through to the empty-digest recovery below
      }

      if (!htmlSource || htmlSource.length < 20) {
        emptyHtmlCount++;
        logger.warn("empty_links", "No links extracted (" + emptyHtmlCount + "/5)", { url: currentUrl });
        if (emptyHtmlCount >= 2) {
          // Escalate one step per failure instead of goBack-ping-ponging:
          //   1. reload this page   2. go back
          //   3+. restart from the storefront root, with growing patience.
          // If the root is also empty the page itself is the problem — stop.
          emptyRecoveries++;
          if (emptyRecoveries > MAX_EMPTY_RECOVERIES) {
            blocker = { kind: "empty_shell", message: "Page renders no links after " + MAX_EMPTY_RECOVERIES + " recovery attempts", url: currentUrl };
            lastReason = blocker.message;
            logger.error("session_blocked", blocker.message, { url: currentUrl });
            exitReason = "engine_exit";
            return "break";
          }
          const waitMs = 2000 * emptyRecoveries;
          logger.info("recovery", "empty links, recovery #" + emptyRecoveries + " (wait " + waitMs + "ms)", { url: currentUrl });
          recoveredFromUrl = currentUrl;
          await sleep(waitMs);
          try {
            if (emptyRecoveries === 1) await page.reload({ timeout: 20_000 });
            else if (emptyRecoveries === 2) await page.goBack({ timeout: 15_000 });
            else await smartNav(page, storefrontUrl, 30_000);
          } catch (err) {
            logger.warn("recovery_nav_failed", err instanceof Error ? err.message : String(err));
          }
          lastUrl = ""; // Force re-detection wherever we land
          emptyHtmlCount = 0;
          return "continue";
        }
        await sleep(2000);
        return "continue";
      }
      emptyHtmlCount = 0;
      // A different page rendering fine clears the recovery ladder; only a
      // run of failures counts against it.
      if (currentUrl !== recoveredFromUrl) emptyRecoveries = 0;

      // ── Step 2: Fire the AI analysis in the BACKGROUND. ──
      // Its latency now overlaps with this page's engagement time; when the
      // engine needs results after the floor, they are already waiting.
      detector.prefetch(currentUrl, htmlSource, {
        intent: currentUrl.includes("/products/") ? "interact" : "discover",
      });

      // ── Step 3: Get AI decision ──
      let decision: AiDecision;
      try {
        decision = await engine.decide(detector, currentUrl, htmlSource, timer);
      } catch (err) {
        logger.error("engine_error", err instanceof Error ? err.message : String(err), { url: currentUrl });
        exitReason = "error";
        errorMessage = err instanceof Error ? err.message : String(err);
        return "break";
      }

      lastReason = decision.reason;

      if (decision.action === "exit") {
        exitReason = timer.isExpired() ? "timer" : "engine_exit";
        return "break";
      }

      // Attach the prepared ATC plan (if this product page has one) so the
      // executor can random-pick variants and press the right control.
      if (decision.action === "add_to_cart" && !decision.plan) {
        const p = engine.getAtcPlanFor(currentUrl);
        if (p) decision.plan = p;
      }

      lastAction = decision.action;

      if (currentUrl.includes("/products/")) {
        const prodMatch = /^OG:TITLE=(.*)$/m.exec(htmlSource) || /^TITLE=(.*)$/m.exec(htmlSource);
        if (prodMatch && prodMatch[1]) activeProductTitle = prodMatch[1].replace(/—.*$/i, "").trim().slice(0, 45);
        const priceMatch = /price:([^\n|]+)/i.exec(htmlSource);
        if (priceMatch && priceMatch[1]) activeProductPrice = priceMatch[1].trim();
      }

      if (decision.action === "add_to_cart") {
        liveActionText = `🛒 Chọn Size & Click Add-To-Cart...`;
      } else if (currentUrl.includes("/products/")) {
        liveActionText = `🔍 Xem SP: ${activeProductTitle || "Chi tiết SP"} ${activeProductPrice ? "(" + activeProductPrice + ")" : ""}`;
      } else if (currentUrl.includes("/collections/")) {
        liveActionText = `📂 Lướt danh mục sản phẩm`;
      } else if (currentUrl.includes("/cart")) {
        liveActionText = `🛍️ Xem giỏ hàng`;
      } else {
        const uPath = new URL(currentUrl).pathname;
        liveActionText = `🌐 Duyệt: ${uPath === "/" ? "Trang chủ" : uPath.slice(0, 30)}`;
      }

      publish();

      // ── Step 4: Execute with human-like delays ──
      const outcome = await executeDecision(decision, page, logger, rng, pacing);
      actionsCount++;
      if (decision.action === "add_to_cart") {
        engine.notifyAtcResult(outcome.atcVerified === true, { url: page.url() });
      }
      if (outcome.atcVerified) {
        atcVerified = true;
        liveActionText = `💎 Add-To-Cart #${engine.state.addToCartCount} thành công!`;
        publish();
      }

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
            if (collClean) visitedCollections.add(collClean);
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
      return "ok";
    };

    // Watchdog: a wedged renderer blocks Playwright calls indefinitely —
    // without this the session would hang forever between turns (seen on
    // rothys.com). Two consecutive dead turns end the visit as an error.
    const TURN_TIMEOUT_MS = 150_000;
    let turnTimeouts = 0;
    // Cap the post-deadline grace turns: a product page that never lets the
    // click verify (gymshark-class buy box that stays inert) would otherwise
    // loop atc_final_turn forever, burning budget until the HARD deadline.
    let finalAtcTurns = 0;
    const MAX_FINAL_ATC_TURNS = 6;

    while (true) {
      await control.gate();
      if (control.shouldClose || control.shouldPark) {
        exitReason = control.shouldClose ? "aborted" : "engine_exit";
        break;
      }
      if (signal?.aborted) { exitReason = "aborted"; break; }
      if (timer.isHardExpired()) { exitReason = "timer"; break; }
      if (timer.isExpired()) {
        // A scheduled add-to-cart armed and due outranks the soft deadline:
        // grant a few final turns so the click lands instead of dying with the
        // clock. Bounded — an inert buy box must not loop here indefinitely.
        if (engine.wantsFinalAtcTurn(timer) && finalAtcTurns < MAX_FINAL_ATC_TURNS) {
          finalAtcTurns++;
          logger.info("atc_final_turn", `budget spent — final turn for the scheduled add-to-cart (${finalAtcTurns}/${MAX_FINAL_ATC_TURNS})`);
        } else {
          exitReason = "timer";
          break;
        }
      }

      // ── Browser death check: the operator closed the desktop window. ──
      // Revive in the background on the same profile, reopen the page the
      // visitor was on, and keep the same visit running.
      if (contextClosed) {
        const resumeUrl = page.url();
        const ok = await reviveBrowser();
        if (!ok) {
          exitReason = "error";
          errorMessage = "Browser was closed and could not be revived";
          break;
        }
        logger.info("browser_revived", "continuing visit in background", { data: { resumeUrl } });
        try {
          await page.goto(resumeUrl && resumeUrl !== "about:blank" ? resumeUrl : storefrontUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
        } catch (err) {
          logger.warn("revive_nav_failed", err instanceof Error ? err.message : String(err));
        }
        lastUrl = ""; // force re-detection
        await sleep(pacing.pageSettle());
        continue;
      }

      loopCount++;
      let verdict: "continue" | "break" | "ok" | "timeout";
      // Capture the turn promise so the timeout branch can attach a catch to
      // the LOSER. Promise.race abandons the slow side but it keeps running
      // against `page`; without this catch its eventual rejection (the loop
      // reloads the page out from under it) becomes an unhandledRejection that
      // can crash the whole process.
      const turnPromise = doTurn();
      turnPromise.catch(() => undefined);
      try {
        verdict = await Promise.race([
          turnPromise,
          sleep(TURN_TIMEOUT_MS).then(() => "timeout" as const),
        ]);
      } catch (err) {
        // A context that died mid-turn surfaces here as a thrown protocol
        // error; route it into the revive path instead of crashing the visit.
        if (/closed|disconnected|destroyed/i.test(String(err))) {
          contextClosed = true;
          continue;
        }
        throw err;
      }

      if (verdict === "timeout") {
        turnTimeouts++;
        logger.error("turn_timeout", "turn exceeded " + Math.round(TURN_TIMEOUT_MS / 1000) + "s - page likely wedged (" + turnTimeouts + "/2)", { url: page.url() });
        if (turnTimeouts >= 2) {
          exitReason = "error";
          errorMessage = "Page stopped responding for " + turnTimeouts + " consecutive turns";
          break;
        }
        lastUrl = "";
        try { await Promise.race([page.reload({ timeout: 20_000 }), sleep(25_000)]); } catch {}
        continue;
      }
      turnTimeouts = 0;
      if (verdict === "break") break;
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
      actionsPerformed: actionsCount,
      pagesVisited,
      productsViewed: engine.state.visitedProducts.size,
      collectionsViewed: visitedCollections.size,
      jsErrors,
      consoleErrors,
      failedRequests,
      navigationErrors,
      slowestNavigation: slowestNav,
      ...(blocker ? { blocker } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    };

    const stats = cookiePool.stats();
    // Close out the cookie audit trail for this run.
    try { cookiePool.auditSummary("session_end"); } catch {}
    try { cookiePool.flushHealth(); } catch {}
    // Save detailed session report — only fields the run actually measured.
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
        aiCalls: { total: engine.state.aiCallsCount, avgMs: engine.state.aiCallsCount > 0 ? Math.round(engine.state.aiCallsTotalMs / engine.state.aiCallsCount) : 0 },
        cookiesPool: stats,
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
    // Live bindings: a browser revive swaps the page/context, and consumers
    // (tests, orchestrator) must see the new instance, not the dead one.
    get page() { return page; },
    get context() { return browser.context; },
    snapshot,
    pause: () => {
      if (status === "running") { control.pause(); publish("paused"); }
    },
    resume: () => {
      if (status === "paused") { control.resume(); publish("running"); }
    },
    extend: (ms: number) => { timer.extend(ms); publish(); },
    park: () => control.park(),
    forceAtc: () => engine.requestForceAtc(),
    exportVisitState: () => engine.exportVisitState(),
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
// A cubic Bézier path with per-step wobble and an occasional overshoot, rather
// than a straight linear interpolation — real cursors curve, jitter, and
// slightly overshoot a target before settling. Step count and wobble come from
// the rng so no two moves are byte-identical.
async function humanMouse(page: Page, rng: Rng): Promise<void> {
  try {
    const vp = page.viewportSize() ?? { width: 1440, height: 900 };
    const targetX = Math.round(vp.width * rng.float(0.15, 0.85));
    const targetY = Math.round(vp.height * rng.float(0.15, 0.80));
    const cursor = new HumanCursor(page, rng);
    await cursor.moveTo({ x: targetX, y: targetY });
  } catch {}
}

// Hover near an element before clicking using biological Minimum-Jerk trajectory
async function hoverBeforeClick(page: Page, selector: string | undefined, rng: Rng): Promise<void> {
  if (!selector) { await humanMouse(page, rng); return; }
  try {
    const loc = page.locator(selector).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        const cursor = new HumanCursor(page, rng);
        const targetX = box.x + box.width * rng.float(0.3, 0.7);
        const targetY = box.y + box.height * rng.float(0.3, 0.7);
        await cursor.moveTo({ x: targetX, y: targetY }, box);
        await sleep(rng.int(120, 300));
        return;
      }
    }
  } catch {}
  await humanMouse(page, rng);
}

interface ExecOutcome {
  navigated: boolean;
  failed: boolean;
  metrics: NavigationMetrics | null;
  /** True only when an add-to-cart was CONFIRMED (network/drawer/cart/count),
   * not merely clicked. Distinguishes "đã thêm giỏ" from "đã click chưa xác nhận". */
  atcVerified?: boolean;
}

/**
 * Dismiss newsletter/geo/consent/REGION overlays that hide or cover buy
 * controls. Escape first, then the usual close affordances, then region/
 * country redirect dialogs (gymshark-class "ARE YOU IN THE RIGHT PLACE?" —
 * the buy box never renders until a region is picked — and MyShopify's
 * auto-redirect banner). Bounded — this is a courtesy pass, not a guarantee.
 */
async function dismissPopups(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);

  // Age verification acceptance (18+, 21+)
  await page.evaluate(() => {
    const ageButtons = Array.from(document.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], input[type="button"], input[type="submit"]'
    ));
    for (const btn of ageButtons) {
      const text = (btn.innerText || btn.textContent || "").toLowerCase().trim();
      if (/^(i am 21\+|i am 18\+|enter|yes, i am|yes|i agree|agree & enter|over 21|over 18|confirm age)$/i.test(text)) {
        if (btn.offsetParent !== null) { btn.click(); return; }
      }
    }
  }).catch(() => undefined);

  // Cookie consent
  await page.evaluate(() => {
    const consentSels = [
      '#onetrust-accept-btn-handler',
      '#accept-cookies',
      '.cc-btn.cc-allow',
      '[data-testid*="cookie-accept" i]',
      'button[id*="cookie-accept" i]',
      'button[class*="cookie-accept" i]',
      'button:has-text("Accept All")',
      'button:has-text("Allow all")',
    ];
    for (const sel of consentSels) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent !== null) { el.click(); break; }
    }
  }).catch(() => undefined);

  const closeSels = [
    '[aria-label*="lose" i]',
    '[aria-label*="close" i]',
    'button[class*="close" i]',
    '[class*="popup"] button',
    '[class*="modal"] button[class*="close" i]',
    '[class*="banner"] [class*="accept"]',
    'div.klaviyo-close-form',
  ];
  for (const sel of closeSels) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        await loc.click({ timeout: 900 }).catch(() => undefined);
        await sleep(250);
      }
    } catch { /* next */ }
  }
  // Region / country pickers: a visible "United States / ROW / Continue"
  // choice blocks the whole storefront. Click the first viable country link.
  try {
    const regionSels = [
      'a[href*="ROW" i]',
      'a[href*="country" i], a[href*="region" i], button[href*="country" i]',
      '[class*="country" i] a, [class*="region" i] a, [class*="country" i] button, [class*="region" i] button',
      'a[href*="us" i], a[href*="en-us" i], a[href*="en_us" i]',
    ];
    for (const sel of regionSels) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        await loc.click({ timeout: 900 }).catch(() => undefined);
        await sleep(500);
      }
    }
  } catch { /* no region dialog */ }
}

/** Click a selector if a visible match exists with biological trajectory. */
async function clickBySelector(page: Page, selector: string, rng?: Rng): Promise<boolean> {
  const loc = page.locator(selector);
  const count = Math.min(await loc.count().catch(() => 0), 5);
  for (let i = 0; i < count; i++) {
    const candidate = loc.nth(i);
    const visible = await candidate.isVisible({ timeout: 1500 }).catch(() => false);
    if (!visible) continue;
    await candidate.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await sleep(150);

    // Biological mouse trajectory click first if rng is provided
    if (rng) {
      const cursor = new HumanCursor(page, rng);
      const ok = await cursor.clickElement(selector);
      if (ok) return true;
    }

    const clicked = await candidate.click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!clicked) {
      // Graceful force-click fallback without fake DOM evaluate
      const forceClicked = await candidate.click({ force: true, timeout: 2000 }).then(() => true).catch(() => false);
      if (forceClicked) return true;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Navigate, tolerating engines that never emit CDP lifecycle events.
 *
 * Some engines never answer `domcontentloaded` on schedule,
 * so every goto "times out" even though the document is fully there. On a
 * timeout, confirm reality directly — a non-empty title on a real URL means
 * the page arrived; only then report failure honestly.
 */
async function smartNav(
  page: Page,
  url: string,
  timeoutMs: number,
  waitUntil: "domcontentloaded" = "domcontentloaded",
): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil, timeout: timeoutMs });
    return true;
  } catch {
    await sleep(2500);
    const title = await page.title().catch(() => "");
    const current = page.url();
    if (title && !current.startsWith("about:") && !/just a moment|checking your browser/i.test(title)) {
      return true;
    }
    return false;
  }
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
          const ok = await smartNav(page, url, 45_000);
          return {
            navigated: true,
            failed: !ok,
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
      // ── Click element (links, buttons, popups, etc.) ──
      // Prioritize real DOM element clicks; direct URL navigation is fallback only
      case "click_element": {
        const targetEl = decision.targetElement;
        if (!targetEl) return noNav;
        const targetUrl = targetEl.url;
        const sel = targetEl.selector || "";
        await hoverBeforeClick(page, sel || undefined, rng);

        // STRATEGY 1: Try CSS selector from AI
        if (sel && !sel.startsWith("text=")) {
          try {
            const loc = page.locator(sel).first();
            const vis = await loc.isVisible({ timeout: 2000 }).catch(() => false);
            if (vis) {
              await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await sleep(rng.int(150, 400));
              const navStart = Date.now();
              const prevUrl = page.url();
              await loc.click({ timeout: 5000 }).catch(() => {});
              await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
              logger.debug("click_selector_ok", "clicked: " + sel);
              if (page.url() !== prevUrl) {
                return {
                  navigated: true, failed: false,
                  metrics: { url: page.url(), status: null, elapsedMs: Date.now() - navStart, ttfbMs: null, domContentLoadedMs: null, loadEventMs: null, firstContentfulPaintMs: null, jsErrors: 0, consoleErrors: 0, failedRequests: 0 },
                };
              }
              return noNav;
            }
          } catch {}
        }

        // STRATEGY 2: Try text-based matching
        if (targetEl.text) {
          try {
            const textLoc = page.getByText(targetEl.text, { exact: false }).first();
            const visT = await textLoc.isVisible({ timeout: 2000 }).catch(() => false);
            if (visT) {
              await textLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await sleep(rng.int(150, 400));
              const navStart = Date.now();
              const prevUrl = page.url();
              await textLoc.click({ timeout: 5000 }).catch(() => {});
              await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
              logger.debug("click_text_ok", "clicked by text: " + targetEl.text.slice(0, 50));
              if (page.url() !== prevUrl) {
                return {
                  navigated: true, failed: false,
                  metrics: { url: page.url(), status: null, elapsedMs: Date.now() - navStart, ttfbMs: null, domContentLoadedMs: null, loadEventMs: null, firstContentfulPaintMs: null, jsErrors: 0, consoleErrors: 0, failedRequests: 0 },
                };
              }
              return noNav;
            }
          } catch {}
        }

        // STRATEGY 3: Try href DOM element locator
        if (targetUrl) {
          try {
            const urlPath = new URL(targetUrl, page.url()).pathname;
            const hrefLoc = page.locator("a[href*=\"" + urlPath + "\"]").first();
            const visH = await hrefLoc.isVisible({ timeout: 2000 }).catch(() => false);
            if (visH) {
              await hrefLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await sleep(rng.int(150, 400));
              const navStart = Date.now();
              const prevUrl = page.url();
              await hrefLoc.click({ timeout: 5000 }).catch(() => {});
              await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
              logger.debug("click_href_ok", "clicked href anchor: " + urlPath);
              if (page.url() !== prevUrl) {
                return {
                  navigated: true, failed: false,
                  metrics: { url: page.url(), status: null, elapsedMs: Date.now() - navStart, ttfbMs: null, domContentLoadedMs: null, loadEventMs: null, firstContentfulPaintMs: null, jsErrors: 0, consoleErrors: 0, failedRequests: 0 },
                };
              }
              return noNav;
            }
          } catch {}
        }

        // STRATEGY 4 (Fallback only): Direct URL navigation when DOM clicking fails
        if (targetUrl) {
          try {
            const fullUrl = targetUrl.startsWith("/") 
              ? new URL(targetUrl, page.url()).href 
              : targetUrl;
            if (fullUrl.startsWith("http")) {
              const navStart = Date.now();
              logger.info("click_url_nav_fallback", "DOM click unavailable, falling back to direct nav: " + fullUrl.slice(0, 80));
              await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
              return {
                navigated: true, failed: false,
                metrics: { url: fullUrl, status: null, elapsedMs: Date.now() - navStart, ttfbMs: null, domContentLoadedMs: null, loadEventMs: null, firstContentfulPaintMs: null, jsErrors: 0, consoleErrors: 0, failedRequests: 0 },
              };
            }
          } catch {
            logger.debug("url_nav_failed", "Fallback URL nav failed for: " + (targetUrl || "").slice(0, 60));
          }
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

      // ── Scroll (natural eased wheel bursts) ──
      case "scroll": {
        // Sometimes move the mouse before scrolling, like a person reaching
        // for the wheel; wheel deltas land where the cursor sits.
        if (rng.chance(0.3)) await humanMouse(page, rng);
        await seatCursor(page, rng);

        // Đọc toạ độ và trạng thái phase cuộn trên trang hiện tại
        const pageMetrics = await page.evaluate(() => {
          const w = window as any;
          if (!w.__scrollPhase) w.__scrollPhase = "down";
          const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
          const vh = window.innerHeight;
          const scrollHeight = Math.max(
            document.body?.scrollHeight ?? 0,
            document.documentElement?.scrollHeight ?? 0,
            vh
          );
          // Nếu chạm hoặc gần sát đáy (còn cách < 150px) => chuyển sang phase up
          if (w.__scrollPhase === "down" && scrollY + vh >= scrollHeight - 150) {
            w.__scrollPhase = "up";
          }
          // Nếu đã cuộn ngược lại gần đỉnh (còn cách < 100px) => lại chuyển sang down
          else if (w.__scrollPhase === "up" && scrollY <= 100) {
            w.__scrollPhase = "down";
          }
          return { vh, scrollY, scrollHeight, phase: w.__scrollPhase as "down" | "up" };
        }).catch(() => ({ vh: 800, scrollY: 0, scrollHeight: 2000, phase: "down" as const }));

        const { vh, phase } = pageMetrics;
        const steps = rng.int(2, 4);

        // Hướng cuộn cơ bản: theo phase (down: 1, up: -1)
        // Kèm sai số / nhịp lên xuống ngẫu nhiên (18% cơ hội đảo hướng tạm thời)
        const mainDir = phase === "down" ? 1 : -1;
        const capMs = decision.maxMs;
        const startedAt = Date.now();

        for (let i = 0; i < steps; i++) {
          // Nhịp phụ có thể ngẫu nhiên lùi lại chút ít như người đang dừng xem lại
          let stepDir = mainDir;
          if (rng.chance(0.18)) {
            stepDir = -mainDir;
          }

          // Độ dài mỗi nhịp cuộn tự nhiên: 30% - 70% chiều cao màn hình
          const distance = Math.round(vh * rng.float(0.3, 0.7) * stepDir);
          const moved = await wheelBy(page, rng, distance);
          if (moved === null) break; // page went away mid-gesture

          // Người dùng dừng lại đọc: lần nghỉ đầu thỉnh thoảng kéo dài
          let pause = i === 0 && rng.chance(0.35) ? rng.int(800, 2000) : pacing.scrollPause();
          if (capMs !== undefined) {
            // A scheduled add-to-cart is close: trim the pause so the next
            // decision lands at the mark instead of past it.
            pause = Math.max(300, Math.min(pause, capMs - (Date.now() - startedAt)));
            if (Date.now() - startedAt >= capMs) break;
          }
          await sleep(pause);
        }
        return noNav;
      }

      // ── Dwell (reading / looking) ──
      case "dwell": {
        const dwell = rng.int(1500, 4000);
        await sleep(decision.maxMs !== undefined ? Math.min(dwell, decision.maxMs) : dwell);
        return noNav;
      }

      // ── Add to cart (scheduled advance action) ──
      // The AI prepared a plan for THIS product page while the visitor was
      // still scrolling (see the prefetch on page arrival). Executing it is
      // pure clicking: random-pick one option per variant group, then press
      // the add-to-cart control. A failure here is silent by design — the
      // visit continues scrolling exactly as if no cart was ever touched.
      case "add_to_cart": {
        // The plan was prepared for a specific product page; the visitor may
        // have wandered since. Go back to that page before pressing anything.
        if (decision.url) {
          try {
            const target = new URL(decision.url);
            if (target.pathname !== new URL(page.url()).pathname) {
              logger.info("atc_return", "returning to planned product page", { data: { url: decision.url } });
              await page.goto(decision.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
              await sleep(rng.int(1800, 2800));
            }
          } catch { /* malformed target — click where we are */ }
        }

        const plan = decision.plan;
        const atcSelector = plan?.addToCart?.selector ?? decision.targetElement?.selector;
        // No early return when the plan is empty: the generic fallback chain
        // below (form[action*=/cart/add], data-add-to-cart, text match) still
        // finds the button on themes whose plan came back bare (liquiddeath-
        // class React buy boxes). Bailing here was a silent atc_noop.

        const readCartCount = (): Promise<number> =>
          page.evaluate(() =>
            fetch("/cart.js", { headers: { accept: "application/json" } })
              .then((r) => r.json())
              .then((c) => Number(c?.item_count ?? -1))
              .catch(() => -1),
          ) as Promise<number>;

        // Golden evidence, four layers: (1) POST /cart/add(.js) — the Shopify
        // standard; (2) any POST whose URL mentions "cart" — custom stacks;
        // (3) POST-body sniff — headless/GraphQL stacks hide cart mutations
        // behind opaque URLs, so we read small POST bodies looking for cart
        let addHit = false;
        const bodyChecks: Array<Promise<void>> = [];
        const onResponse = (resp: { url(): string; status(): number; request(): { method(): string; headers(): Record<string, string> }; text(): Promise<string> }): void => {
          try {
            const u = resp.url();
            if (resp.status() >= 400) return;
            const method = resp.request().method().toUpperCase();
            if (/\/cart\/add(\.js)?|cart[_-]?add|add[_-]?to[_-]?cart|add[_-]?item|\/api\/.*\/cart/i.test(u) && (method === "POST" || method === "PUT")) {
              addHit = true;
              return;
            }
            if (method !== "POST" && method !== "PUT") return;
            if (!/cart|graphql|api|checkout|storefront|lines|items/i.test(u)) return;
            const lenStr = resp.request().headers()["content-length"] ?? "0";
            if (Number(lenStr) > 40_000) return;
            bodyChecks.push(
              resp.text().then((t) => {
                if (/cart(id|line|_count)|"item_count"|CartLine|AddedToCart|merchandiseId|cartLinesAdd|cartCreate|checkoutCreate|"quantity"\s*:\s*[1-9]|"totalQuantity"\s*:\s*[1-9]|"subtotalPrice"/i.test(t)) {
                  addHit = true;
                }
              }).catch(() => undefined),
            );
          } catch { /* response may be gone */ }
        };

        page.on("response", onResponse);
        let before = -1;
        let clicks = 0;
        let drawerOpened = false;
        let after = -1;
        let badgeCount = 0;
        let groups: Array<{ group: string; options: string[] }> = [];

        try {
          before = await readCartCount().catch(() => -1);

          // Overlays first — a newsletter modal above the buy box eats clicks.
          await dismissPopups(page);

          if (before === -1) {
            logger.warn("atc_cart_unreadable", "/cart.js unreadable — verification will rely on network signals", { data: { url: page.url() } });
          }

          // 1. Variant groups from AI plan (if available)
          groups = plan?.variants?.length ? [...plan.variants].slice(0, 2) : [];
          for (const g of groups) {
            if (!g.options.length) continue;
            const idx = Math.floor(rng.float(0, g.options.length)) % g.options.length;
            const pick = g.options[idx];
            if (!pick) continue;
            const ok = await clickBySelector(page, pick, rng);
            logger.debug(ok ? "atc_variant_picked" : "atc_variant_missed", g.group + ": " + pick);
            if (ok) clicks++;
            await sleep(rng.int(350, 850));
          }

          // 2. Smart Variant / Size Auto-Selector (Apparel, Shoes, Colors, Options)
          const smartVariantPicked = await page.evaluate(() => {
            const isItemInStock = (el: HTMLElement): boolean => {
              if (el.hasAttribute("disabled")) return false;
              if (el.getAttribute("aria-disabled") === "true") return false;
              if (el.getAttribute("data-available") === "false") return false;
              if (el.getAttribute("data-in-stock") === "false") return false;
              const cl = (el.className || "").toLowerCase();
              if (/sold[-_]?out|disabled|unavailable|out[-_]?of[-_]?stock/i.test(cl)) return false;
              const txt = (el.innerText || el.textContent || "").toLowerCase();
              if (/sold\s*out|out\s*of\s*stock|hết\s*hàng|unavailable/i.test(txt)) return false;
              return true;
            };

            let count = 0;
            const radios = Array.from(document.querySelectorAll('input[type="radio"]:not([disabled])')) as HTMLInputElement[];
            const radioGroups = new Map<string, HTMLInputElement[]>();
            radios.forEach((r) => {
              if (r.name && !/selling_plan|payment|shipping|rating|frequency|quantity/i.test(r.name)) {
                radioGroups.set(r.name, [...(radioGroups.get(r.name) || []), r]);
              }
            });
            radioGroups.forEach((group) => {
              const inStock = group.filter(r => isItemInStock(r));
              const already = inStock.find((r) => r.checked);
              if (!already && inStock.length > 0) {
                const target = inStock[0];
                target.click();
                target.dispatchEvent(new Event("change", { bubbles: true }));
                count++;
              }
            });

            const swatchContainers = Array.from(document.querySelectorAll('fieldset, [class*="swatch" i], [class*="variant" i], [class*="size" i], [data-option-name], [class*="option-select" i]'));
            for (const container of swatchContainers) {
              const items = Array.from(container.querySelectorAll('button, label, [data-option-value], [role="radio"]')).filter((el) => {
                const htmlEl = el as HTMLElement;
                if (!isItemInStock(htmlEl)) return false;
                if (!htmlEl.offsetParent && getComputedStyle(htmlEl).display === "none") return false;
                const txt = (htmlEl.textContent || "").trim();
                return txt.length > 0 && txt.length <= 15 && !/add|cart|bag|buy|checkout|close|\$/i.test(txt);
              });
              if (items.length > 1) {
                const isAnySelected = items.some((item) => item.getAttribute("aria-checked") === "true" || item.classList.contains("selected") || item.classList.contains("active"));
                if (!isAnySelected) {
                  const pick = items[Math.min(1, items.length - 1)] as HTMLElement;
                  pick.click();
                  count++;
                }
              }
            }

            document.querySelectorAll("select[name*='options'], select[name='id'], select[id*='option']").forEach((sel) => {
              const s = sel as HTMLSelectElement;
              if (s.options.length > 1) {
                const validOptions = Array.from(s.options).filter((o, idx) => idx > 0 && !o.disabled && !/sold\s*out|hết\s*hàng/i.test(o.text));
                if (validOptions.length > 0 && (s.selectedIndex <= 0 || s.options[s.selectedIndex].disabled)) {
                  s.value = validOptions[0].value;
                  s.dispatchEvent(new Event("change", { bubbles: true }));
                  count++;
                }
              }
            });

            return count;
          }).catch(() => 0);

          if (smartVariantPicked > 0) {
            logger.debug("atc_smart_variants", `Pre-selected ${smartVariantPicked} variant option(s)`);
            clicks += smartVariantPicked;
            await sleep(rng.int(500, 1100));
          }

          // 3. Main Add-To-Cart Control Click (AI selector -> AI form fallback -> Rich generic handles -> form.requestSubmit)
          if (atcSelector) {
            await page.waitForSelector(atcSelector, { timeout: 8_000 }).catch(() => undefined);
          }
          let clickedMain = atcSelector ? await clickBySelector(page, atcSelector, rng) : false;
          if (clickedMain) clicks++;
          else logger.debug("add_to_cart_invisible", "Add-to-cart control not visible", { data: { url: page.url(), selector: atcSelector ?? "" } });

          if (!clickedMain && plan?.formSelector) {
            await page.waitForSelector(plan.formSelector, { timeout: 4000 }).catch(() => undefined);
            if (await clickBySelector(page, plan.formSelector, rng)) { clickedMain = true; clicks++; logger.debug("atc_form_click", "AI form fallback: " + plan.formSelector); }
          }

          if (!clickedMain) {
            const generic = [
              'form[action*="/cart/add"] [type="submit"]',
              'form[action*="/cart/add"] [name="add"]',
              'form[action*="/cart/add"] button',
              'product-form form [type="submit"]',
              'product-form form button[name="add"]',
              'product-form button[type="submit"]',
              'form#AddToCartForm [type="submit"]',
              '[data-action="add-to-cart"]',
              '[data-add-to-cart]',
              '[data-testid*="add-to-cart" i]',
              '[data-test*="add-to-cart" i]',
              'button[class*="add-to-cart" i]',
              'button[class*="AddToCart" i]',
              'button[id*="add-to-cart" i]',
              '[id*="AddToCart" i]',
              ".product-form__submit",
              ".shopify-payment-button__button--unbranded",
              '[class*="sticky-atc" i] button',
              '[class*="sticky-cart" i] button',
              '[data-sticky-add-to-cart] button',
              '[name="add"]',
              'button[name="add"]',
              'input[name="add"]',
              'button[aria-label*="Add to cart" i]',
              'button[aria-label*="Add to bag" i]',
            ];
            for (let pass = 0; pass < 2 && !clickedMain; pass++) {
              if (pass === 1) await sleep(2500);
              await dismissPopups(page);
              for (const sel of generic) {
                const loc = page.locator(sel).first();
                if (!(await loc.isVisible({ timeout: 1000 }).catch(() => false))) continue;
                if (await loc.isDisabled({ timeout: 600 }).catch(() => true)) continue;
                await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
                await clickBySelector(page, sel, rng);
                clickedMain = true;
                clicks++;
                logger.debug("atc_generic_click", "fallback clicked: " + sel);
                break;
              }
              if (!clickedMain) {
                const byText = page.getByRole("button", { name: /add to cart|add to bag|buy now|thêm vào giỏ|ajouter au panier|in den warenkorb/i }).first();
                if (await byText.isVisible({ timeout: 1000 }).catch(() => false)) {
                  await byText.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
                  await byText.click({ timeout: 4000 }).catch(() => {});
                  clickedMain = true;
                  clicks++;
                  logger.debug("atc_text_click", "fallback clicked by text");
                }
              }
            }

            // Layer 4 Fallback: Native form.requestSubmit()
            if (!clickedMain) {
              const formSubmitted = await page.evaluate(() => {
                const form = document.querySelector<HTMLFormElement>('form[action*="/cart/add"], product-form form, form#AddToCartForm');
                if (form) {
                  const submitBtn = form.querySelector<HTMLElement>('button[type="submit"], [name="add"], button');
                  if (typeof form.requestSubmit === "function") {
                    form.requestSubmit(submitBtn as HTMLButtonElement);
                    return true;
                  } else if (submitBtn) {
                    submitBtn.click();
                    return true;
                  }
                }
                return false;
              }).catch(() => false);

              if (formSubmitted) {
                clickedMain = true;
                clicks++;
                logger.debug("atc_form_request_submit", "Fallback triggered via form.requestSubmit()");
              }
            }
          }

          // 4. Quick-Add / Modal Size Selection Handshake
          await sleep(rng.int(1000, 1800));
          const modalHandled = await page.evaluate(() => {
            const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="drawer" i], [class*="modal" i], [class*="quick-add" i], [id*="quick-add" i], [class*="popover" i]')).filter((el) => {
              const h = el as HTMLElement;
              return h.offsetParent !== null && getComputedStyle(h).display !== "none";
            });
            if (modals.length === 0) return false;
            let handled = false;
            for (const m of modals) {
              const options = Array.from(m.querySelectorAll('button:not([disabled]), label:not([class*="disabled"]), [role="radio"]')).filter((el) => {
                const t = (el.textContent || "").trim();
                return t.length >= 1 && t.length <= 10 && !/add|close|cancel|cart|bag|view/i.test(t);
              });
              if (options.length > 0) {
                (options[0] as HTMLElement).click();
                handled = true;
              }
              const confirmBtn = m.querySelector('button[type="submit"], [name="add"], button:has-text("Add"), button:has-text("Bag"), button:has-text("Cart")') as HTMLElement;
              if (confirmBtn) {
                confirmBtn.click();
                handled = true;
              }
            }
            return handled;
          }).catch(() => false);

          if (modalHandled) {
            logger.debug("atc_modal_handled", "Handled quick-add/size drawer selection");
            clicks++;
            await sleep(rng.int(1800, 2600));
          }

          // Drain in-flight network bodies
          await sleep(rng.int(2200, 3400));
          if (bodyChecks.length) await Promise.race([Promise.all(bodyChecks), sleep(1500)]);

          drawerOpened = clicks > 0 ? await page.evaluate(() => {
            const d = document.querySelector('cart-drawer, #CartDrawer, .cart-drawer, cart-notification, #CartNotification, .cart-notification, [class*="cart-drawer" i], [class*="CartDrawer"], [class*="mini-cart" i], [class*="MiniCart"], [id*="cart-drawer" i], [class*="cart-flyout" i], [class*="drawer--cart" i], [aria-label*="cart" i][role="dialog"]');
            if (!d) return false;
            const st = getComputedStyle(d);
            return (d as HTMLElement).offsetParent !== null || st.display !== "none" || st.transform !== "none";
          }).catch(() => false) : false;
          after = clicks > 0 ? await readCartCount().catch(() => -1) : before;

          badgeCount = clicks > 0 ? await page.evaluate(() => {
            const sels = ['[class*="cart-count" i]','[class*="cart_count" i]','[class*="CartCount"]','[data-cart-count]','[class*="cart" i] [class*="count" i]','[class*="bag" i] [class*="count" i]','[aria-label*="cart" i] [class*="count" i]','header [class*="badge" i]'];
            let best = 0;
            for (const sel of sels) {
              for (const el of Array.from(document.querySelectorAll(sel))) {
                const t = (el.textContent || "").trim();
                const n = parseInt(t.replace(/[^\d]/g, ""), 10);
                if (Number.isFinite(n) && n > best && n < 100) best = n;
              }
            }
            return best;
          }).catch(() => 0) : 0;
        } finally {
          page.off("response", onResponse);
        }

        if (!clicks) {
          logger.debug("atc_noop", "nothing clickable — visit continues", { url: page.url() });
          return noNav;
        }

        const landedOnCart = /\/cart(\?|$)/.test(page.url());
        const verified = addHit || landedOnCart || after > before || drawerOpened || badgeCount > 0;
        if (verified) {
          const how = addHit ? "network" : drawerOpened ? "cart drawer" : landedOnCart ? "cart page" : badgeCount > 0 ? "cart badge" : "cart";
          logger.info("atc_success", `add-to-cart verified via ${how}: ${before} -> ${after} items`, {
            url: page.url(),
            data: { selector: atcSelector ?? "", variants: groups.map((g) => g.group).join("+") },
          });
        } else {
          // Silent failure: log and keep browsing — never derail the visit.
          logger.warn("atc_unverified", `clicked but unconfirmed (net=${addHit}, cart ${before} -> ${after}) — continuing browse`, {
            url: page.url(),
            data: { selector: atcSelector ?? "" },
          });
          return noNav;
        }

        // Cart abandonment: sometimes look at what we just added, then leave.
        await sleep(rng.int(1500, 3000));
        if (rng.chance(0.35)) {
          try {
            const origin = new URL(page.url()).origin;
            await page.goto(origin + "/cart", { waitUntil: "domcontentloaded", timeout: 15000 });
            logger.info("cart_view", "Viewed cart page (abandonment)");
            await sleep(rng.int(3000, 8000));
            await page.goBack({ timeout: 15_000 }).catch(() => null);
          } catch {}
        }
        return { navigated: false, failed: false, metrics: null, atcVerified: true };
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