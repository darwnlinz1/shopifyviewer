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
 */
import type { Page } from "playwright-core";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { Rng, randomSeed } from "../util/random.js";
import { launchBrowser, type BrowserEngine } from "../browser/cloak.js";
import { PageNavigator, openSessionPage } from "../navigator/pageNavigator.js";
import { BehaviorEngine } from "../behavior/engine.js";
import { SessionTimer } from "./timer.js";
import type {
  Decision,
  NavigationMetrics,
  PageObservation,
  SessionResult,
} from "../types.js";

export interface SessionOptions {
  /** Stable index; picks the persistent profile and the proxy. */
  slot: number;
  sessionId: string;
  config: SimulatorConfig;
  /** Explicit seed for reproducibility; random when omitted. */
  seed?: number;
  /** Aborts the session early (Ctrl-C, runner shutdown). */
  signal?: AbortSignal;
}

export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const { config, sessionId, slot, signal } = options;
  const seed = options.seed ?? config.seed ?? randomSeed();
  const rng = new Rng(seed);
  const logger = new Logger(sessionId, config.logging, `s${slot}`);
  const timer = new SessionTimer(config.session, rng);
  const startedAt = new Date().toISOString();

  let exitReason: SessionResult["exitReason"] = "engine_exit";
  let errorMessage: string | undefined;
  let engine: BrowserEngine = "cloakbrowser";
  let navigator: PageNavigator | null = null;
  let behavior: BehaviorEngine | null = null;
  let pagesVisited = 0;
  let navigationErrors = 0;
  let slowestNavigation: NavigationMetrics | null = null;
  let close: (() => Promise<void>) | null = null;

  logger.info("session_start", `seed=${seed} budget=${Math.round(timer.plannedDurationMs / 1000)}s`, {
    data: {
      seed,
      slot,
      storefront: config.storefront,
      plannedDurationMs: timer.plannedDurationMs,
    },
  });

  try {
    const browser = await launchBrowser({ slot, sessionId, config, logger, rng });
    engine = browser.engine;
    close = browser.close;

    const page: Page = await openSessionPage(browser.context);
    page.setDefaultTimeout(config.session.navigationTimeoutMs);

    navigator = new PageNavigator(page, config, logger, rng);
    behavior = new BehaviorEngine(config, rng, logger);

    /** Track the slowest navigation for the performance summary. */
    const recordNavigation = (metrics: NavigationMetrics | null): void => {
      if (!metrics) return;
      pagesVisited++;
      if (!slowestNavigation || metrics.elapsedMs > slowestNavigation.elapsedMs) {
        slowestNavigation = metrics;
      }
    };

    // ---- main loop -------------------------------------------------------
    while (true) {
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

      if (!first) behavior.syncState(observation);
      const decision = behavior.decide(observation, timer);

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

      const outcome = await executeDecision(decision, navigator, behavior, logger, timer);
      if (outcome.navigated) {
        recordNavigation(outcome.metrics);
        behavior.resetPageActions();
        behavior.state = decision.nextState;
        await navigator.pageSettlePause();
      }
      if (outcome.failed) navigationErrors++;

      behavior.noteAction(decision.action);
      await navigator.actionPause();
    }
  } catch (err) {
    exitReason = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("session_error", errorMessage, {
      data: { stack: err instanceof Error ? err.stack?.slice(0, 1200) : undefined },
    });
  } finally {
    if (close) {
      await close().catch((err) =>
        logger.warn("browser_close_error", err instanceof Error ? err.message : String(err)),
      );
    }
  }

  const counts = navigator?.errorCounts ?? {
    jsErrors: 0,
    consoleErrors: 0,
    failedRequests: 0,
  };
  const result: SessionResult = {
    sessionId,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: timer.elapsedMs(),
    exitReason,
    actionsPerformed: behavior?.memory.totalActions ?? 0,
    pagesVisited,
    productsViewed: behavior?.memory.visitedProducts.size ?? 0,
    collectionsViewed: behavior?.memory.visitedCollections.size ?? 0,
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
    { data: { ...result, engine } },
  );
  await logger.close();
  return result;
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
