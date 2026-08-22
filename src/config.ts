/**
 * Configuration schema, defaults, and loading for the simulator.
 *
 * Config resolution order (later wins):
 *   defaults  →  config file (--config / storefront-sim.config.json)  →  CLI flags
 */
import { readFileSync, existsSync } from "node:fs";
import type { SelectorSet } from "./navigator/selectors.js";
import { resolve } from "node:path";

/** Inclusive numeric range, in milliseconds unless stated otherwise. */
export interface Range {
  min: number;
  max: number;
}

export interface BrowserConfig {
  /** Run Chromium headless. Headed is closer to a real browsing session. */
  headless: boolean;
  /** Directory holding one persistent Chromium profile per session slot. */
  profileDir: string;
  /**
   * Reuse the same profile directory across runs so cookies, localStorage and
   * cache persist — the point of persistent profiles.
   */
  persistProfiles: boolean;
  /** Proxy URLs; session N uses proxies[N % proxies.length]. Empty = direct. */
  proxies: string[];
  /** Ask CloakBrowser to auto-derive timezone/locale from the proxy IP. */
  geoip: boolean;
  /** Enable CloakBrowser's human-like mouse/scroll/typing layer. */
  humanize: boolean;
  /** CloakBrowser human preset. */
  humanPreset: "default" | "careful";
  /** IANA timezone override, e.g. "Europe/Paris". */
  timezone?: string;
  /** BCP 47 locale override, e.g. "fr-FR". */
  locale?: string;
  /** Viewport pool; one is picked per session. */
  viewports: Array<{ width: number; height: number }>;
  /** CloakBrowser Pro license key (or CLOAKBROWSER_LICENSE_KEY env var). */
  licenseKey?: string;
  /**
   * Allow falling back to stock playwright-core Chromium when the CloakBrowser
   * binary cannot be provisioned. Useful in CI; off by default so that a
   * misconfigured run fails loudly instead of silently losing the stealth layer.
   */
  allowFallbackBrowser: boolean;
  /**
   * Chromium binary for the fallback path only.
   *
   * CloakBrowser provisions and pins its own patched binary, so this never
   * applies to a normal run. It exists for CI, where a stock Chromium is
   * already on disk at a known path and downloading another one is pure
   * overhead.
   */
  executablePath?: string;
}

export interface SessionConfig {
  /** Target session length. The spec calls for ~15 minutes. */
  durationMs: number;
  /** Random +/- jitter applied to durationMs so sessions are not identical. */
  durationJitterMs: number;
  /** Number of independent sessions to run. */
  count: number;
  /** How many sessions run at the same time. */
  concurrency: number;
  /** Hard ceiling per session; guards against a hung page. */
  hardTimeoutMs: number;
  /** Per-navigation timeout. */
  navigationTimeoutMs: number;
  /**
   * How long to hold the browser open after the budget is spent.
   *
   *   0   close immediately — the right default for scripted runs
   *  -1   hold until the operator closes it
   *  >0   hold for this many ms
   *
   * The dashboard overrides this to -1: its whole purpose is to be watched,
   * and closing a browser the instant its timer fires throws away the final
   * state the operator most wants to see.
   */
  lingerMs: number;
}

export interface BehaviorConfig {
  /** Pause between two consecutive actions. */
  actionPause: Range;
  /** Extra dwell after arriving on a page, before acting. */
  pageSettle: Range;
  /** How long a single scroll gesture's pause lasts. */
  scrollPause: Range;
  /** Scroll distance as a fraction of viewport height. */
  scrollFraction: Range;
  /** Consecutive scroll steps in one scroll action. */
  scrollSteps: Range;
  /** Time spent looking at one gallery image. */
  mediaDwell: Range;
  /** Time spent reading one expanded section. */
  sectionDwell: Range;
  /** Products to open before the engine starts favouring exit. */
  targetProducts: Range;
  /** Probability of using browser Back rather than a fresh link. */
  backProbability: number;
  /** Probability of returning to a collection instead of jumping product→product. */
  returnToCollectionProbability: number;
  /** Probability of an idle "reading" pause between actions. */
  idleProbability: number;
  /** Max consecutive actions on one page before the engine forces a move. */
  maxActionsPerPage: number;
  /**
   * Global pace multiplier applied to every delay.
   *
   * The ranges above describe an unhurried visitor. Raising this divides them
   * all at once — 2 is about twice as brisk — which is easier to reason about
   * than editing six ranges and hoping they stay in proportion.
   */
  speedFactor: number;
}

export interface SafetyConfig {
  /**
   * Only navigate to these hosts. Populated from the storefront URL when empty.
   * Keeps a session pinned to the storefront under test.
   */
  allowedHosts: string[];
  /** Never click add-to-cart / never touch checkout. This is a read-only test tool. */
  allowCart: boolean;
  /** URL path fragments that are never navigated to. */
  blockedPathFragments: string[];
}

export interface LoggingConfig {
  /** Directory for per-session JSONL logs and the run summary. */
  dir: string;
  /** Console verbosity. */
  level: "debug" | "info" | "warn" | "error";
  /** Write structured JSONL event logs to disk. */
  jsonl: boolean;
  /** Mirror events to the console. */
  console: boolean;
}

export interface SimulatorConfig {
  /** Storefront under test, e.g. "https://aiju-cosmetique.fr". */
  storefront: string;
  /** Collection URLs to seed browsing from. Empty = discover from the site. */
  seedCollections: string[];
  /** Deterministic seed; same seed + same site reproduces a session. */
  seed?: number;
  /**
   * Shop-specific selector candidates, prepended to the built-in Shopify
   * candidates. Only needed for heavily customised themes.
   */
  selectorOverrides?: Partial<Record<keyof SelectorSet, string[]>>;
  browser: BrowserConfig;
  session: SessionConfig;
  behavior: BehaviorConfig;
  safety: SafetyConfig;
  logging: LoggingConfig;
}

export const DEFAULT_CONFIG: SimulatorConfig = {
  storefront: "https://aiju-cosmetique.fr",
  seedCollections: ["/collections/all"],
  browser: {
    headless: true,
    profileDir: "./profiles",
    persistProfiles: true,
    proxies: [],
    geoip: false,
    humanize: true,
    humanPreset: "default",
    viewports: [
      { width: 1440, height: 900 },
      { width: 1536, height: 864 },
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
    ],
    allowFallbackBrowser: false,
  },
  session: {
    durationMs: 15 * 60 * 1000,
    durationJitterMs: 60 * 1000,
    count: 1,
    concurrency: 1,
    hardTimeoutMs: 20 * 60 * 1000,
    navigationTimeoutMs: 45_000,
    lingerMs: 0,
  },
  behavior: {
    // The gap between one action and the next. Unlike the other ranges this
    // one is honoured as a hard band (see Pacing.actionPause), because it is
    // the rhythm an operator actually watches and wants to set.
    actionPause: { min: 2000, max: 3000 },
    pageSettle: { min: 700, max: 2200 },
    scrollPause: { min: 200, max: 900 },
    scrollFraction: { min: 0.25, max: 0.9 },
    // One to three gestures per scroll action. Six turned a single "scroll"
    // into five seconds, which read as the browser stuck on one page.
    scrollSteps: { min: 1, max: 3 },
    mediaDwell: { min: 400, max: 1300 },
    sectionDwell: { min: 600, max: 1800 },
    // How many products before the engine stops actively seeking new ones.
    // Not a stopping point — the session keeps browsing either way; it just
    // stops steering so hard toward unseen products.
    targetProducts: { min: 8, max: 20 },
    backProbability: 0.28,
    returnToCollectionProbability: 0.35,
    idleProbability: 0.18,
    /**
      * Actions on one page before the session moves on.
      *
      * Hitting this is not a pause — the engine navigates on the very next
      * turn, so the ceiling reads as "seen enough here, next page" rather than
      * as the session running out of things to do and idling.
      */
    maxActionsPerPage: 8,
    speedFactor: 1,
  },
  safety: {
    allowedHosts: [],
    allowCart: false,
    blockedPathFragments: [
      "/checkout",
      "/cart/checkout",
      "/account",
      "/admin",
      "/orders",
      "/apps/",
      "/tools/",
    ],
  },
  logging: {
    dir: "./logs",
    level: "info",
    jsonl: true,
    console: true,
  },
};

/** Deep-merge a partial config over a base, arrays replaced wholesale. */
function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch) || typeof patch !== "object") return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key];
    out[key] =
      current && typeof current === "object" && !Array.isArray(current)
        ? merge(current, value)
        : value;
  }
  return out as T;
}

/** Normalise the storefront URL and derive the host allowlist when unset. */
function finalise(config: SimulatorConfig): SimulatorConfig {
  const storefront = config.storefront.replace(/\/+$/, "");
  let host: string;
  try {
    host = new URL(storefront).host;
  } catch {
    throw new Error(
      `Invalid storefront URL: ${config.storefront}. Expected e.g. https://example.com`,
    );
  }
  const allowedHosts =
    config.safety.allowedHosts.length > 0
      ? config.safety.allowedHosts
      : [host, host.startsWith("www.") ? host.slice(4) : `www.${host}`];

  if (config.session.concurrency < 1) config.session.concurrency = 1;
  if (config.session.count < 1) config.session.count = 1;

  return {
    ...config,
    storefront,
    safety: { ...config.safety, allowedHosts },
  };
}

/** Load config from disk (if present) and merge over the defaults. */
export function loadConfig(
  configPath?: string,
  overrides?: Partial<SimulatorConfig>,
): SimulatorConfig {
  let fileConfig: unknown = {};
  const candidate = configPath ?? "storefront-sim.config.json";
  const abs = resolve(process.cwd(), candidate);
  if (existsSync(abs)) {
    try {
      fileConfig = JSON.parse(readFileSync(abs, "utf8"));
    } catch (err) {
      throw new Error(`Failed to parse config file ${abs}: ${String(err)}`);
    }
  } else if (configPath) {
    throw new Error(`Config file not found: ${abs}`);
  }

  let config = merge(DEFAULT_CONFIG, fileConfig);
  if (overrides) config = merge(config, overrides);

  const envKey = process.env.CLOAKBROWSER_LICENSE_KEY;
  if (envKey && !config.browser.licenseKey) {
    config.browser = { ...config.browser, licenseKey: envKey };
  }
  return finalise(config);
}
