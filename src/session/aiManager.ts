/**
 * AI-Driven Session Manager - manages one browsing session.
 *
 * Core loop:
 *   1. Extract a source digest from the page (isolated world)
 *   2. On a new page, scan it with the detection waterfall (Tier 0 recipe /
 *      Tier 1 multi-signal); the AI tier is only prefetched where they fall short
 *   3. The behaviour engine decides the next step of the pre-checkout choreography
 *   4. The executor performs it with human input; results feed back to the engine
 *
 * Modules: digestExtractor.ts (page digest), actionExecutor.ts (decision →
 * input), atcVerifier.ts (add-to-cart + verification), this file (lifecycle,
 * revive, drive loop).
 *
 * Bot walls are detected from the page title and handled with a bounded
 * back-off (see the drive loop).
 *
 * Advance action: at ai.advanceActionTimeMs the engine clicks add-to-cart —
 * gated by safety.allowCart — reviews the cart, then resumes browsing.
 */
import type { BrowserContext, Page } from "rebrowser-playwright";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { Rng, randomSeed, sleep } from "../util/random.js";
import { launchBrowser, type BrowserEngine, type LaunchHooks } from "../browser/chrome.js";
import { measureViewport } from "../browser/viewport.js";
import { evaluateIsolated } from "../navigator/isolate.js";
import { openSessionPage } from "../navigator/pageNavigator.js";
import { Pacing } from "../behavior/timing.js";
import { SessionTimer } from "./timer.js";
import { CookiePool } from "../ai/cookiePool.js";
import { ElementDetector } from "../ai/elementDetector.js";
import { DomainRecipeCache, sharedRecipeCache } from "../ai/domainRecipeCache.js";
import { resolveAiProvider } from "../ai/provider.js";
import { storageFor } from "../storage/db.js";
import type { AlertManager } from "../alerts/alertManager.js";
import { DetectionWaterfall, featuresOf, type BuyBoxResolution } from "../ai/detectionWaterfall.js";
import { AiBehaviorEngine, type Personality, type ShopperState, type VisitStateSnapshot } from "../behavior/aiEngine.js";
import type { Profile } from "../profiles/types.js";
import type { AiDecision, NavigationMetrics, SessionBlocker, SessionResult } from "../types.js";
import { saveSessionReport } from "./sessionReport.js";
import { DEFAULT_AI_CONFIG } from "../config.js";
import { WafChallengeDetector } from "../security/wafDetector.js";
import { readDigest, digestPrice, digestProductTitle } from "./digestExtractor.js";
import { executeDecision, smartNav, type ExecOutcome } from "./actionExecutor.js";

export { extractSourceDigest } from "./digestExtractor.js";

// ── Session status ──

export type SessionStatus =
  | "starting" | "running" | "paused" | "blocked"
  | "lingering" | "stopping" | "finished" | "error";

/** One step of the visible pre-checkout trail. */
export interface ViewEvent {
  /** Session clock when the step finished. */
  atMs: number;
  /** How long the step itself ran. */
  tookMs: number;
  phase: string;
  action: string;
  detail?: string;
}

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
  /** Detection tier whose selector produced the verified add (0 recipe, 1 multi-signal, 2 AI). */
  atcTier?: number;
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
  /** Pre-checkout choreography phase (discovery, compare, deep_pdp, …). */
  choreographyPhase?: string;
  shopperState?: ShopperState;
  /** The visit's view behaviours in order (latest last, capped). */
  viewTimeline?: ViewEvent[];
  /** Counters per view behaviour for the whole visit. */
  viewStats?: Record<string, number>;
  /** How often each detection tier answered. */
  detectionTiers?: { tier0: number; tier1: number; tier2: number; local: number };
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
  /** Health alerts (ATC collapse, challenge storms, AI provider failures). */
  alerts?: AlertManager;
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
  /** Persist what the launcher learns (BitBrowser link, written cookie jar). */
  launchHooks?: LaunchHooks;
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
  private wakeSet = new Set<() => void>();
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.notify(); }
  park(): void { this.parkRequested = true; this.paused = false; this.notify(); }
  requestClose(): void { this.closeRequested = true; this.paused = false; this.notify(); }
  get isPaused() { return this.paused; }
  get shouldPark() { return this.parkRequested; }
  get shouldClose() { return this.closeRequested; }
  private notify(): void {
    for (const w of this.wakeSet) w();
    this.wakeSet.clear();
  }
  async gate(): Promise<void> {
    while (this.paused && !this.closeRequested && !this.parkRequested) {
      await new Promise<void>(r => {
        const fn = () => { clearTimeout(t); this.wakeSet.delete(fn); r(); };
        const t = setTimeout(fn, 500);
        this.wakeSet.add(fn);
      });
    }
  }
  async waitForClose(timeoutMs: number): Promise<void> {
    if (this.closeRequested) return;
    const d = timeoutMs >= 0 ? Date.now() + timeoutMs : Infinity;
    while (!this.closeRequested && Date.now() < d) {
      const s = Math.min(500, Math.max(0, d - Date.now()));
      await new Promise<void>(r => {
        const fn = () => { clearTimeout(t); this.wakeSet.delete(fn); r(); };
        const t = setTimeout(fn, Number.isFinite(s) ? s : 500);
        this.wakeSet.add(fn);
      });
    }
  }
  waitForStopSignal(): { promise: Promise<"break">; cancel: () => void } {
    if (this.closeRequested || this.parkRequested) {
      return { promise: Promise.resolve("break"), cancel: () => {} };
    }
    let checkFn: (() => void) | null = null;
    const promise = new Promise<"break">(r => {
      checkFn = () => {
        if (this.closeRequested || this.parkRequested) {
          if (checkFn) this.wakeSet.delete(checkFn);
          r("break");
        }
      };
      this.wakeSet.add(checkFn);
    });
    return {
      promise,
      cancel: () => {
        if (checkFn) this.wakeSet.delete(checkFn);
      },
    };
  }
}

/** Resolve with the promise's value, or null once `ms` passes (timer always cleared). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Dashboard line for the step the visitor is on. */
const LIVE_TEXT: Partial<Record<AiDecision["action"], string>> = {
  hover_card: "👀 Rê chuột ngắm thẻ sản phẩm",
  view_media: "🖼️ Lướt xem ảnh sản phẩm",
  read_section: "📖 Đọc chi tiết / vận chuyển",
  select_text: "🖍️ Bôi đen một dòng mô tả",
  explore_variants: "🎨 Bấm thử Size / Màu",
  inspect_cart: "🛍️ Kiểm tra giỏ hàng trước checkout",
  go_back: "↩️ Quay lại danh mục để so sánh",
};

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
  /** Await `p` unless close/park arrives first (then undefined); the loser runs on harmlessly. */
  const untilStop = async <T>(p: Promise<T>): Promise<T | undefined> => {
    p.catch(() => undefined);
    const stop = control.waitForStopSignal();
    try {
      return await Promise.race([p, stop.promise.then(() => undefined)]);
    } finally {
      stop.cancel();
    }
  };

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
    ...(options.launchHooks ? { hooks: options.launchHooks } : {}),
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
      const hasImportedCookies = (profile?.cookies?.cookies?.length ?? 0) > 0 || browser.cookiesInjected > 0;
      if (options.accountTabUrl === null || (!options.accountTabUrl && !hasImportedCookies)) return;
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
          ...(options.launchHooks ? { hooks: options.launchHooks } : {}),
        });
        if (control.shouldClose) {
          // Closed while relaunching: the session already shut the old browser down.
          await fresh.close().catch(() => undefined);
          return false;
        }
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
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("browser_revive_failed", msg);
        const rateLimited = /request frequency|administrator mode/i.test(msg);
        await sleep((rateLimited ? 8_000 : 2_000) * attempt);
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
  const storageDb = storageFor(config);
  const cookiePool = options.cookiePool ?? new CookiePool(aiConfig.cookiesDir, storageDb ? { db: storageDb } : {});
  const aiProvider = resolveAiProvider(aiConfig);
  logger.info("ai_provider", `mode=${aiProvider.mode} (${aiProvider.reason})`);
  const poolStats = cookiePool.stats();
  logger.info("cookie_pool", `loaded=` + poolStats.totalLoaded + ` active=` + poolStats.active + ` quarantined=` + poolStats.quarantined, {
    data: { ...poolStats },
  });

  const detector = new ElementDetector(cookiePool, logger, {
    maxRetries: aiConfig.maxRetries,
    maxHtmlChars: aiConfig.maxHtmlChars,
    detectionCooldownMs: aiConfig.detectionCooldownMs,
    model: aiConfig.model,
    ...(aiConfig.claudeBaseUrl ? { baseUrl: aiConfig.claudeBaseUrl } : {}),
    provider: aiProvider.mode,
    ...(aiProvider.api ? { api: aiProvider.api } : {}),
    onProviderEvent: (e) => {
      logger.warn("ai_provider_event", `${e.kind}: ${e.detail}`);
      options.alerts?.providerEvent(e);
    },
  });
  // Tier 0 recipes are shared by every session in the process (and on disk);
  // Tier 2 (the detector above) is only consulted where Tiers 0/1 fall short.
  const waterfall = new DetectionWaterfall(
    detector,
    // Unset → the storage database; an explicit .json path keeps the legacy file.
    sharedRecipeCache(aiConfig.recipeCachePath || (storageDb ? storageDb.path : undefined)),
    logger,
    { threshold: aiConfig.tier1ConfidenceThreshold ?? 0.8, maxHtmlChars: aiConfig.maxHtmlChars },
  );
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
  let atcTier: number | undefined;
  const recentNavs: NavigationMetrics[] = [];
  const RECENT_CAP = 30;
  // Real counters — the snapshot used to report aiCallsCount here, which
  // counted model calls, not things the visitor actually did.
  let actionsCount = 0;
  const visitedCollections = new Set<string>();

  // The pre-checkout trail as it actually happened, for the dashboard and reports.
  const viewTimeline: ViewEvent[] = [];
  const VIEW_CAP = 60;
  const viewStats: Record<string, number> = {};
  const bump = (key: string, by = 1): void => { viewStats[key] = (viewStats[key] ?? 0) + by; };
  const recordView = (decision: AiDecision, outcome: ExecOutcome, tookMs: number): void => {
    const phase = decision.phase ?? engine.currentPhase;
    const push = (action: string, detail?: string): void => {
      viewTimeline.push({ atMs: timer.elapsedMs(), tookMs, phase, action, ...(detail ? { detail } : {}) });
      if (viewTimeline.length > VIEW_CAP) viewTimeline.shift();
    };
    const performed = outcome.performed ?? 0;
    switch (decision.action) {
      case "goto_home":
      case "goto_collection":
      case "goto_product": {
        if (performed > 0) { bump("hover_card", performed); push("hover_card", outcome.detail); }
        if (!outcome.navigated) return;
        const kind = outcome.clickThrough ? "click_through" : "goto_direct";
        bump(kind);
        let path = "";
        try { path = new URL(page.url()).pathname; } catch { /* keep empty */ }
        push(kind, `${decision.action.replace("goto_", "")} ${path}`);
        return;
      }
      case "go_back":
        if (outcome.navigated) { bump("go_back"); push("go_back", decision.reason); }
        return;
      case "hover_card":
      case "view_media":
      case "select_text":
      case "explore_variants":
      case "inspect_cart":
        if (performed > 0) {
          bump(decision.action, decision.action === "view_media" ? performed : 1);
          push(decision.action, outcome.detail);
        }
        return;
      case "read_section":
        if (performed > 0) {
          bump("read_section");
          if (performed > 1) bump("select_text");
          push("read_section", outcome.detail);
        }
        return;
      case "add_to_cart":
        bump(outcome.atcVerified ? "add_to_cart_verified" : "add_to_cart_unverified");
        push("add_to_cart", outcome.detail);
        return;
      default:
        bump(decision.action);
    }
  };

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
    ...(atcTier !== undefined ? { atcTier } : {}),
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
    choreographyPhase: engine.currentPhase,
    shopperState: engine.state.currentState,
    viewTimeline: [...viewTimeline],
    viewStats: { ...viewStats },
    detectionTiers: { ...waterfall.stats },
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
      const ok = await untilStop(smartNav(page, entryUrl, 30_000));
      if (ok === undefined) return;
      if (!ok) logger.warn("initial_nav_failed", "page did not confirm load: " + entryUrl);
      await untilStop(sleep(pacing.pageSettle()));
      if (options.resumeUrl) {
        logger.info("session_resumed", `reopened on ${options.resumeUrl}`, {
          data: { resumeUrl: options.resumeUrl, elapsedOffsetMs: elapsedOffsetMs },
        });
      }
    } catch (err) {
      logger.warn("initial_nav_failed", err instanceof Error ? err.message : String(err));
    }

    let lastUrl = "";
    let lastDigest = "";
    let loopCount = 0;
    let emptyHtmlCount = 0;
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
        lastTitle = (await evaluateIsolated(page, function pageTitleInPage(): string { return document.title || ""; })) ?? "";
        lastUrl = currentUrl;
      }

      // Step 1: Build the source digest the AI reads (reuse cached digest when URL is unchanged).
      let htmlSource = !urlChanged && lastDigest.length >= 20 ? lastDigest : "";
      if (!htmlSource) {
        try {
          await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
          htmlSource = await readDigest(page);
          if (htmlSource && htmlSource.length >= 20) {
            lastDigest = htmlSource;
          }
        } catch {
          htmlSource = "";
        }
      }

      // ── WAF & Bot Challenge Detection Ladder (only inspect on URL change or suspicious title) ──
      if (urlChanged || /moment|challenge|attention|denied|captcha|429/i.test(lastTitle)) {
        const wafState = await WafChallengeDetector.inspectPage(page, logger);
        if (wafState.engine !== "none") {
          logger.warn("waf_challenge_detected", `WAF challenge encountered: ${wafState.engine}`, { data: { url: currentUrl } });
          options.alerts?.recordChallenge(profile?.proxy ?? "", DomainRecipeCache.hostOf(currentUrl));
          const solveRes = await WafChallengeDetector.resolveChallenge(page, wafState, logger);
          if (solveRes.resolved) {
            logger.info("waf_challenge_cleared", `WAF challenge ${wafState.engine} cleared successfully via ${solveRes.actionTaken}`);
            consecutiveChallenges = 0;
            lastUrl = "";
            lastDigest = "";
            return "continue";
          }

          consecutiveChallenges++;
          if (pagesVisited > 0 && consecutiveChallenges <= 2) {
            logger.warn("challenge_backoff", `Bot wall on ${currentUrl} — going back (${consecutiveChallenges}/2)`, { data: { url: currentUrl } });
            await page.goBack({ timeout: 15_000 }).catch(() => undefined);
            lastUrl = "";
            lastDigest = "";
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
      }

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

      // ── Step 2: Tier 0/1 scan of the new page; the AI tier only where it falls short ──
      if (urlChanged) {
        if (page.viewportSize() === null) await measureViewport(page).catch(() => undefined);
        const scanned: BuyBoxResolution | null = await withTimeout(waterfall.scan(page, currentUrl), 8_000).catch(() => null);
        if (scanned) engine.notePageFeatures(currentUrl, featuresOf(scanned));
        waterfall.prefetch(currentUrl, htmlSource, {
          intent: currentUrl.includes("/products/") ? "interact" : "discover",
        });
      }

      // ── Step 3: Decide ──
      let decision: AiDecision;
      try {
        decision = await engine.decide(waterfall, currentUrl, htmlSource, timer);
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
        const title = digestProductTitle(htmlSource);
        if (title) activeProductTitle = title;
        const price = digestPrice(htmlSource);
        if (price) activeProductPrice = price;
      }

      if (decision.action === "add_to_cart") {
        liveActionText = `🛒 Chọn Size & Click Add-To-Cart...`;
      } else if (LIVE_TEXT[decision.action]) {
        liveActionText = LIVE_TEXT[decision.action]!;
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

      // ── Step 4: Execute with human-like input ──
      const atcProductUrl = decision.url ?? currentUrl;
      const actionStartedAt = Date.now();
      const outcome = await executeDecision(decision, {
        page,
        logger,
        rng,
        pacing,
        ...(config.behavior.choreography ? { choreography: config.behavior.choreography } : {}),
        waterfall,
        triedVariants: engine.triedVariantsFor(currentUrl),
      });
      actionsCount++;
      logger.debug(
        "action_result",
        `${decision.action} [${decision.phase ?? engine.currentPhase}] in ${Date.now() - actionStartedAt}ms` +
          (outcome.performed !== undefined ? ` performed=${outcome.performed}` : "") +
          (outcome.detail ? ` — ${outcome.detail}` : "") +
          ` | ${decision.reason}`,
        { url: currentUrl },
      );
      engine.noteActionResult(decision, outcome);
      recordView(decision, outcome, Date.now() - actionStartedAt);
      if (decision.action === "add_to_cart") {
        engine.notifyAtcResult(outcome.atcVerified === true, { url: atcProductUrl });
        options.alerts?.recordAtc(DomainRecipeCache.hostOf(currentUrl), outcome.atcVerified === true);
      }
      if (outcome.atcVerified) {
        atcVerified = true;
        if (outcome.atcTier !== undefined) atcTier = outcome.atcTier;
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

      // Human-like pause between actions (honours configured actionPause & speedFactor)
      await sleep(Math.max(600, pacing.actionPause()));
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
        // A close requested mid-revive must not wait out a relaunch and a 30 s navigation.
        const ok = await untilStop(reviveBrowser());
        if (ok === undefined) continue;
        if (!ok) {
          exitReason = "error";
          errorMessage = "Browser was closed and could not be revived";
          break;
        }
        logger.info("browser_revived", "continuing visit in background", { data: { resumeUrl } });
        await untilStop(
          page.goto(resumeUrl && resumeUrl !== "about:blank" ? resumeUrl : storefrontUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }).catch((err) => logger.warn("revive_nav_failed", err instanceof Error ? err.message : String(err))),
        );
        lastUrl = ""; // force re-detection
        await untilStop(sleep(pacing.pageSettle()));
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
      let turnTimer: ReturnType<typeof setTimeout> | undefined;
      const stopPromise = control.waitForStopSignal();
      try {
        verdict = await Promise.race([
          turnPromise,
          stopPromise.promise,
          new Promise<"timeout">((r) => {
            turnTimer = setTimeout(() => r("timeout"), TURN_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        // A context that died mid-turn surfaces here as a thrown protocol
        // error; route it into the revive path instead of crashing the visit.
        if (/closed|disconnected|destroyed/i.test(String(err))) {
          contextClosed = true;
          continue;
        }
        throw err;
      } finally {
        if (turnTimer) clearTimeout(turnTimer);
        stopPromise.cancel();
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
        await untilStop(page.reload({ timeout: 20_000 }).catch(() => undefined));
        continue;
      }
      turnTimeouts = 0;
      if (verdict === "break") {
        if (control.shouldClose) exitReason = "aborted";
        else if (control.shouldPark) exitReason = "engine_exit";
        break;
      }
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
    try { waterfall.recipes.flush(); } catch {}
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
        " | cookies: " + stats.active + " active, " + stats.quarantined + " quarantined" +
        " | tiers: " + JSON.stringify(waterfall.stats),
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

export { sleep };
