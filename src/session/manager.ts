/**
 * Session Manager — owns one simulated browsing session end to end.
 *
 * Pipeline:
 *   CloakBrowser → Session Manager → Playwright → Page Navigator
 *                → Behaviour Engine → Timer → Logger
 *
 * The manager runs the loop; it does not decide anything. Each turn it asks
 * the navigator what the page looks like, hands that to the engine, and
 * executes whatever the engine chose, until the engine exits or the timer runs
 * out.
 *
 * A session is *controllable*: it can be paused, resumed, extended and
 * stopped while it runs, and — the point of `linger` — reaching the end of the
 * budget stops the driving without closing the browser. The window stays on
 * screen, holding the last page the visitor was on, until the operator decides
 * what to do with it. Closing a browser the instant the timer fires throws
 * away the state you most want to look at.
 */
import type { BrowserContext, Page } from "playwright-core";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { Rng, randomSeed, sleep } from "../util/random.js";
import { launchBrowser, type BrowserEngine } from "../browser/cloak.js";
import { PageNavigator, openSessionPage } from "../navigator/pageNavigator.js";
import { BehaviorEngine } from "../behavior/engine.js";
import { Pacing } from "../behavior/timing.js";
import { SessionTimer } from "./timer.js";
import type { Profile } from "../profiles/types.js";
import type {
  ActionKind,
  BehaviorState,
  Decision,
  NavigationMetrics,
  PageObservation,
  SessionResult,
} from "../types.js";

/** Lifecycle of a live session. */
export type SessionStatus =
  | "starting"
  | "running"
  | "paused"
  /** Budget spent; browser deliberately still open, nothing driving it. */
  | "lingering"
  | "stopping"
  | "finished"
  | "error";

/** A point-in-time view of a live session, for the dashboard. */
export interface SessionSnapshot {
  sessionId: string;
  profileId?: string;
  status: SessionStatus;
  url: string;
  title: string;
  state: BehaviorState;
  lastAction: ActionKind | null;
  lastReason: string;
  startedAt: string;
  plannedDurationMs: number;
  elapsedMs: number;
  remainingMs: number;
  /** When the session entered `lingering`. */
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
  error?: string;
}

export interface SessionOptions {
  /** Stable index; picks the persistent profile and the proxy. */
  slot: number;
  sessionId: string;
  config: SimulatorConfig;
  /** Explicit seed for reproducibility; random when omitted. */
  seed?: number;
  /** Aborts the session early (Ctrl-C, runner shutdown). */
  signal?: AbortSignal;
  /** Managed profile supplying identity, proxy and cookies. */
  profile?: Profile;
  /** Override the Chromium user-data directory. */
  userDataDir?: string;
  /**
   * How long to hold the browser open after the budget is spent.
   *   0   close immediately (scripted runs)
   *  -1   hold until the operator closes it (the dashboard default)
   *  >0   hold for this many ms, then close
   */
  lingerMs?: number;
  /** Called whenever the snapshot meaningfully changes. */
  onUpdate?: (snapshot: SessionSnapshot) => void;
  /** Called once the page exists, before browsing starts. */
  onPage?: (page: Page, context: BrowserContext) => void | Promise<void>;
}

/** Controls for a session that is already running. */
export interface SessionHandle {
  readonly sessionId: string;
  readonly profileId: string | undefined;
  readonly page: Page;
  readonly context: BrowserContext;
  snapshot(): SessionSnapshot;
  pause(): void;
  resume(): void;
  /** Add time to the budget; also revives a lingering session. */
  extend(ms: number): void;
  /** Stop driving the page but leave the browser open (→ `lingering`). */
  park(): void;
  /** Close the browser and settle the result. */
  close(): Promise<SessionResult>;
  /** Resolves when the session has fully finished and closed. */
  readonly done: Promise<SessionResult>;
}

/**
 * Pause/stop coordination between the operator and the loop.
 *
 * The loop calls `gate()` once per turn; everything else just flips flags and
 * wakes any waiter. Keeping the state in one small object means the loop never
 * has to reason about who asked for what.
 */
class Control {
  private paused = false;
  private parkRequested = false;
  private closeRequested = false;
  private wake: (() => void) | null = null;

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.notify();
  }

  park(): void {
    this.parkRequested = true;
    this.paused = false;
    this.notify();
  }

  requestClose(): void {
    this.closeRequested = true;
    this.paused = false;
    this.notify();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get shouldPark(): boolean {
    return this.parkRequested;
  }

  get shouldClose(): boolean {
    return this.closeRequested;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** Block while paused. Returns as soon as the session resumes or stops. */
  async gate(): Promise<void> {
    while (this.paused && !this.closeRequested && !this.parkRequested) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        // Poll as a backstop so a lost notify cannot wedge the session.
        setTimeout(resolve, 500);
      });
    }
  }

  /** Wait until close is requested, or `timeoutMs` elapses (-1 = forever). */
  async waitForClose(timeoutMs: number): Promise<void> {
    if (this.closeRequested) return;
    const deadline = timeoutMs >= 0 ? Date.now() + timeoutMs : Infinity;
    while (!this.closeRequested && Date.now() < deadline) {
      const slice = Math.min(500, Math.max(0, deadline - Date.now()));
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, Number.isFinite(slice) ? slice : 500);
      });
    }
  }
}

/**
 * Launch a session and start driving it.
 *
 * Returns as soon as the browser is up and the loop has been kicked off, so
 * the caller holds a live handle while browsing happens in the background.
 */
export async function startSession(options: SessionOptions): Promise<SessionHandle> {
  const { config, sessionId, slot, signal, profile } = options;
  const seed = options.seed ?? config.seed ?? randomSeed();
  const rng = new Rng(seed);
  const logger = new Logger(sessionId, config.logging, `s${slot}`);
  const startedAt = new Date().toISOString();

  const durationOverride = profile?.durationMinutes;
  const sessionConfig = durationOverride
    ? {
        ...config.session,
        durationMs: Math.round(durationOverride * 60_000),
        hardTimeoutMs: Math.max(
          config.session.hardTimeoutMs,
          Math.round(durationOverride * 60_000 * 1.4) + 60_000,
        ),
      }
    : config.session;

  const timer = new SessionTimer(sessionConfig, rng);
  const control = new Control();

  logger.info(
    "session_start",
    `seed=${seed} budget=${Math.round(timer.plannedDurationMs / 1000)}s`,
    {
      data: {
        seed,
        slot,
        profile: profile?.name,
        storefront: config.storefront,
        plannedDurationMs: timer.plannedDurationMs,
      },
    },
  );

  const browser = await launchBrowser({
    slot,
    sessionId,
    config,
    logger,
    rng,
    ...(profile ? { profile } : {}),
    ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
  });

  const page: Page = await openSessionPage(browser.context);
  page.setDefaultTimeout(config.session.navigationTimeoutMs);
  await options.onPage?.(page, browser.context);

  const pacing = new Pacing(rng, config.behavior, () => timer.progress());
  const navigator = new PageNavigator(page, config, logger, rng, pacing);
  const behavior = new BehaviorEngine(config, rng, logger);

  // ---- mutable session state --------------------------------------------
  let status: SessionStatus = "starting";
  let lingeringSince: string | undefined;
  let pagesVisited = 0;
  let navigationErrors = 0;
  let lastAction: ActionKind | null = null;
  let lastReason = "";
  let lastTitle = "";
  let slowestNavigation: NavigationMetrics | null = null;
  let exitReason: SessionResult["exitReason"] = "engine_exit";
  let errorMessage: string | undefined;

  const snapshot = (): SessionSnapshot => {
    const counts = navigator.errorCounts;
    return {
      sessionId,
      ...(profile ? { profileId: profile.id } : {}),
      status,
      url: navigator.currentUrl,
      title: lastTitle,
      state: behavior.state,
      lastAction,
      lastReason,
      startedAt,
      plannedDurationMs: timer.plannedDurationMs,
      elapsedMs: timer.elapsedMs(),
      remainingMs: timer.remainingMs(),
      ...(lingeringSince ? { lingeringSince } : {}),
      pagesVisited,
      productsViewed: behavior.memory.visitedProducts.size,
      collectionsViewed: behavior.memory.visitedCollections.size,
      actionsPerformed: behavior.memory.totalActions,
      jsErrors: counts.jsErrors,
      consoleErrors: counts.consoleErrors,
      failedRequests: counts.failedRequests,
      navigationErrors,
      engine: browser.engine,
      cookiesInjected: browser.cookiesInjected,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  };

  const publish = (next?: SessionStatus): void => {
    if (next) status = next;
    options.onUpdate?.(snapshot());
  };

  // ---- the browsing loop -------------------------------------------------
  const drive = async (): Promise<void> => {
    publish("running");

    while (true) {
      await control.gate();

      if (control.shouldClose || control.shouldPark) {
        exitReason = control.shouldClose ? "aborted" : "engine_exit";
        logger.info("session_parked", control.shouldClose ? "close requested" : "parked by operator");
        break;
      }
      if (signal?.aborted) {
        exitReason = "aborted";
        logger.warn("session_abort", "abort signal received");
        break;
      }
      if (timer.isHardExpired()) {
        exitReason = "timer";
        logger.warn("session_hard_timeout", "hard timeout reached");
        break;
      }

      // Observe the live page before deciding anything. On the very first
      // turn nothing is loaded yet, so the engine runs off a placeholder and
      // the state stays START until the homepage is open.
      const first = behavior.state === "START";
      const observation = first
        ? emptyObservation(config.storefront)
        : await navigator.observe();
      if (!first) lastTitle = observation.title;

      if (!first) behavior.syncState(observation);
      const decision = behavior.decide(observation, timer);
      lastReason = decision.reason;

      logger.info("decide", decision.reason, {
        url: observation.url,
        state: behavior.state,
        data: {
          action: decision.action,
          target: decision.url ?? null,
          remaining: timer.formatRemaining(),
          productsViewed: behavior.memory.visitedProducts.size,
          productTarget: behavior.memory.productTarget,
        },
      });

      if (decision.action === "exit") {
        exitReason = timer.isExpired() ? "timer" : "engine_exit";
        break;
      }

      lastAction = decision.action;
      publish();

      const outcome = await executeDecision(decision, navigator, behavior, logger, timer);
      if (outcome.navigated) {
        if (outcome.metrics) {
          pagesVisited++;
          if (!slowestNavigation || outcome.metrics.elapsedMs > slowestNavigation.elapsedMs) {
            slowestNavigation = outcome.metrics;
          }
        }
        behavior.resetPageActions();
        behavior.state = decision.nextState;
        await navigator.pageSettlePause();
      }
      if (outcome.failed) navigationErrors++;

      // Only successful actions count toward "what has been done on this
      // page". Counting failures too used to let a run of failed navigations
      // exhaust the page's action budget and push the engine off a page it had
      // barely looked at.
      if (!outcome.failed) behavior.noteAction(decision.action);

      publish();
      await navigator.actionPause();
    }
  };

  // ---- run, linger, close ------------------------------------------------
  const done = (async (): Promise<SessionResult> => {
    try {
      await drive();
    } catch (err) {
      exitReason = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("session_error", errorMessage, {
        data: { stack: err instanceof Error ? err.stack?.slice(0, 1200) : undefined },
      });
    }

    // The budget is spent, but the browser stays up: this is the whole point
    // of linger. Nothing drives the page from here — the operator gets the
    // final state to look at, and decides when it goes away.
    const lingerMs = options.lingerMs ?? 0;
    if (lingerMs !== 0 && !control.shouldClose && exitReason !== "error") {
      lingeringSince = new Date().toISOString();
      logger.info(
        "session_linger",
        lingerMs < 0
          ? "budget spent — holding the browser open until closed"
          : `budget spent — holding the browser open for ${Math.round(lingerMs / 1000)}s`,
        { url: navigator.currentUrl },
      );
      publish("lingering");
      await control.waitForClose(lingerMs);
    }

    publish("stopping");
    await browser.close().catch((err) =>
      logger.warn("browser_close_error", err instanceof Error ? err.message : String(err)),
    );

    const counts = navigator.errorCounts;
    const result: SessionResult = {
      sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: timer.elapsedMs(),
      exitReason,
      actionsPerformed: behavior.memory.totalActions,
      pagesVisited,
      productsViewed: behavior.memory.visitedProducts.size,
      collectionsViewed: behavior.memory.visitedCollections.size,
      jsErrors: counts.jsErrors,
      consoleErrors: counts.consoleErrors,
      failedRequests: counts.failedRequests,
      navigationErrors,
      slowestNavigation,
      ...(errorMessage ? { error: errorMessage } : {}),
    };

    logger.info(
      "session_end",
      `${exitReason} · ${result.pagesVisited} pages · ${result.productsViewed} products · ` +
        `${Math.round(result.durationMs / 1000)}s`,
      { data: { ...result, engine: browser.engine } },
    );
    await logger.close();

    publish(errorMessage ? "error" : "finished");
    return result;
  })();

  // A rejection here would be an unhandled rejection until someone awaits
  // `done`; the IIFE already converts failures into a result, so this is just
  // belt and braces.
  done.catch(() => undefined);

  return {
    sessionId,
    profileId: profile?.id,
    page,
    context: browser.context,
    snapshot,
    pause: () => {
      if (status === "running") {
        control.pause();
        publish("paused");
      }
    },
    resume: () => {
      if (status === "paused") {
        control.resume();
        publish("running");
      }
    },
    extend: (ms: number) => {
      timer.extend(ms);
      // Extending a parked session brings it back to life rather than just
      // moving a deadline nothing is watching.
      if (status === "lingering") {
        logger.info("session_extend", `+${Math.round(ms / 1000)}s — resuming from linger`);
      }
      publish();
    },
    park: () => control.park(),
    close: async () => {
      control.requestClose();
      return done;
    },
    done,
  };
}

/**
 * Run a session to completion and close it.
 *
 * The scripted entry point used by the multi-session runner: no operator is
 * watching, so it does not linger unless explicitly told to.
 */
export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const handle = await startSession(options);
  return handle.done;
}

interface ExecutionOutcome {
  navigated: boolean;
  failed: boolean;
  metrics: NavigationMetrics | null;
}

/** Carry out a single decision. Navigation failures are recoverable. */
async function executeDecision(
  decision: Decision,
  navigator: PageNavigator,
  behavior: BehaviorEngine,
  logger: Logger,
  timer: SessionTimer,
): Promise<ExecutionOutcome> {
  const noNav: ExecutionOutcome = { navigated: false, failed: false, metrics: null };

  try {
    switch (decision.action) {
      case "goto_home":
      case "goto_collection":
      case "goto_product": {
        if (!decision.url) return noNav;
        if (!navigator.isAllowed(decision.url)) {
          logger.warn("navigation_blocked", "target outside allowlist", {
            url: decision.url,
          });
          behavior.noteFailure();
          return { navigated: false, failed: true, metrics: null };
        }
        const metrics = await navigator.goto(decision.url);
        behavior.noteSuccess();
        return { navigated: true, failed: false, metrics };
      }

      case "go_back": {
        const metrics = await navigator.back();
        if (!metrics) {
          logger.debug("go_back_noop", "no history entry to return to");
          return noNav;
        }
        behavior.noteSuccess();
        return { navigated: true, failed: false, metrics };
      }

      case "go_forward": {
        const metrics = await navigator.forward();
        if (!metrics) {
          logger.debug("go_forward_noop", "nothing forward in history");
          return noNav;
        }
        behavior.noteSuccess();
        return { navigated: true, failed: false, metrics };
      }

      case "scroll":
        // Direction is drawn from the navigator's seeded RNG so a session
        // replays identically from its seed.
        await navigator.scroll();
        return noNav;

      case "view_media":
        await navigator.viewMedia();
        return noNav;

      case "read_section":
        await navigator.readSection();
        return noNav;

      case "inspect_details":
        await navigator.inspectDetails();
        return noNav;

      case "hover_variants":
        await navigator.hoverVariants();
        return noNav;

      case "dwell":
        await navigator.dwell();
        return noNav;

      case "exit":
        return noNav;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("action_failed", `${decision.action}: ${message}`, {
      url: decision.url ?? navigator.currentUrl,
      state: behavior.state,
      data: { action: decision.action, remaining: timer.formatRemaining() },
    });
    behavior.noteFailure();
    return { navigated: false, failed: true, metrics: null };
  }
  return noNav;
}

/** Placeholder observation used before the first page is loaded. */
function emptyObservation(storefront: string): PageObservation {
  return {
    url: storefront,
    title: "",
    pageType: "unknown",
    scrollHeight: 0,
    viewportHeight: 0,
    scrollY: 0,
    productLinks: [],
    collectionLinks: [],
    mediaCount: 0,
    sectionCount: 0,
    hasVariants: false,
    hasPrice: false,
    hasMainContent: false,
  };
}

export { sleep };
