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

/**
 * Which browser kernel drives a session.
 *
 *   builtin     the local Chrome/Edge/Ungoogled-Chromium, fingerprint shaped by
 *               our own init scripts
 *   bitbrowser  a BitBrowser profile opened through its Local API; the C++
 *               kernel owns the fingerprint and no JS patches are injected
 */
export type BrowserProvider = "builtin" | "bitbrowser";

export interface BitBrowserConfig {
  /** BitBrowser Local API base URL (Settings → Local API). */
  apiUrl: string;
  /** Chromium kernel for profiles SiteViewer creates. */
  coreVersion?: string;
  /** Group new profiles are filed under; required when signed in as a sub-account. */
  groupId?: string;
  /** Create a BitBrowser profile on first launch when a profile has no bitBrowserId. */
  autoCreateProfile?: boolean;
  /** Local API token, only when "Authentication Control" is on (sent as x-api-key). */
  apiKey?: string;
  /** Minimum gap between two Local API calls; the app rejects bursts. */
  minRequestIntervalMs?: number;
  /** Existing BitBrowser profile IDs for CLI runs (slot N uses profileIds[N % length]). */
  profileIds?: string[];
}

export interface BrowserConfig {
  /** Run Chromium headless. Headed is closer to a real browsing session. */
  headless: boolean;
  /** Default kernel for profiles that do not pick one themselves. */
  provider?: BrowserProvider;
  /** BitBrowser Local API settings, used by provider "bitbrowser". */
  bitbrowser?: BitBrowserConfig;
  /** Directory holding one persistent Chromium profile per session slot. */
  profileDir: string;
  /**
   * Reuse the same profile directory across runs so cookies, localStorage and
   * cache persist — the point of persistent profiles.
   */
  persistProfiles: boolean;
  /** Proxy URLs; session N uses proxies[N % proxies.length]. Empty = direct. */
  proxies: string[];
  /** Auto-derive timezone/locale from the proxy IP. */
  geoip: boolean;
  /** Enable human-like mouse/scroll/typing layer. */
  humanize: boolean;
  /** Human behaviour preset. */
  humanPreset: "default" | "careful";
  /** IANA timezone override, e.g. "Europe/Paris". */
  timezone?: string;
  /** BCP 47 locale override, e.g. "fr-FR". */
  locale?: string;
  /** Viewport pool; one is picked per session. */
  viewports: Array<{ width: number; height: number }>;
  /**
   * Legacy switch kept so old config files parse. Chrome is the engine;
   * binary cannot be found. Useful in CI; off by default so that a
   * misconfigured run fails loudly instead of silently losing the stealth layer.
   */
  allowFallbackBrowser: boolean;
  /**
   * Chromium binary for the fallback path only.
   *
   * The engine binary lives outside npm, so this never
   * applies to a normal run. It exists for CI, where a stock Chromium is
   * already on disk at a known path and downloading another one is pure
   * overhead.
   */
  executablePath?: string;
  /** Privacy hardening toggles applied at browser launch. */
  privacy?: PrivacyConfig;
}

export interface PrivacyConfig {
  /** Disable WebRTC (prevents IP leak via ICE candidates). */
  disableWebRTC: boolean;
  /** Deny geolocation permission. */
  disableGeolocation: boolean;
  /** Send Do Not Track header. */
  enableDoNotTrack: boolean;
  /** Disable WebGL (image fingerprint). */
  disableWebGL: boolean;
  /** Disable Canvas (fingerprint). */
  disableCanvas: boolean;
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
  /**
   * How long the engine keeps working one page before navigating on.
   *
   * Drawn per page, so different pages get different looks. Time-based rather
   * than action-count-based on purpose: with a count ceiling, a page whose
   * interesting actions were exhausted early went visibly idle for its
   * remaining budget — at the bottom of a listing there was nothing left but
   * dwell — which read as the browser hanging.
   */
  pageEngagementMs: Range;
  /**
   * Legacy per-page action cap, kept so existing config files still parse.
   * No longer consulted by the engine; `pageEngagementMs` governs instead.
   */
  maxActionsPerPage: number;
  /**
   * Global pace multiplier applied to every delay.
   *
   * The ranges above describe an unhurried visitor. Raising this divides them
   * all at once — 2 is about twice as brisk — which is easier to reason about
   * than editing six ranges and hoping they stay in proportion.
   */
  speedFactor: number;
  /** Pre-checkout choreography timing; see src/behavior/choreography.ts. */
  choreography?: ChoreographyConfig;
}

/**
 * Timing of the pre-checkout visit, scaled to the add-to-cart mark.
 *
 * The visit before the mark is split into discovery (first 20%), product
 * comparison (only when the mark leaves room for it) and a deep look at the
 * product that gets bought (last 45%, capped).
 */
export interface ChoreographyConfig {
  /** Open A → back → open B only when the ATC mark is at least this far in. */
  compareMinAtcMs: number;
  /** Ceiling on the deep product-page phase before the ATC mark. */
  deepPhaseMaxMs: number;
  /** Variant exploration starts this long before the ATC mark. */
  exploreVariantsLeadMs: Range;
  /** Dwell on each gallery image while flipping through media. */
  mediaDwellMs: Range;
  /** Time spent reviewing the cart after a verified add-to-cart. */
  inspectCartMs: Range;
  /** With every target ATC done, park on the cart this long before the end. */
  checkoutReadyLeadMs: number;
}

export const DEFAULT_CHOREOGRAPHY: ChoreographyConfig = {
  compareMinAtcMs: 120_000,
  deepPhaseMaxMs: 180_000,
  exploreVariantsLeadMs: { min: 15_000, max: 40_000 },
  mediaDwellMs: { min: 800, max: 2_200 },
  inspectCartMs: { min: 5_000, max: 12_000 },
  checkoutReadyLeadMs: 20_000,
};

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

export interface StorageConfig {
  /**
   * SQLite database holding profiles, selector recipes, cookie-pool health and
   * the audit trail. Empty string disables it and falls back to the legacy
   * JSON side files.
   */
  dbPath: string;
}

export interface SimulatorConfig {
  /** Storefront under test, e.g. "https://your-shop.com". Empty = per-profile only. */
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
  ai?: AiConfig;
  storage?: StorageConfig;
  /** Realtime health alerts (Telegram / Discord / generic webhook). */
  alerts?: AlertsConfig;
}

export const DEFAULT_CONFIG: SimulatorConfig = {
  // No global default shop: the operator sets a storefront per profile in the
  // dashboard (or via --storefront / the config file for CLI runs).
  storefront: "",
  seedCollections: ["/collections/all"],
  browser: {
    headless: true,
    provider: "builtin",
    bitbrowser: {
      apiUrl: "http://127.0.0.1:54345",
      coreVersion: "136",
      autoCreateProfile: true,
      minRequestIntervalMs: 350,
    },
    profileDir: "./tempprofolio",
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
    privacy: {
      disableWebRTC: false,
      disableGeolocation: false,
      enableDoNotTrack: false,
      disableWebGL: false,
      disableCanvas: false,
    },
  },
  session: {
    durationMs: 15 * 60 * 1000,
    // Operator wants a fixed 15-minute session: no randomised length.
    durationJitterMs: 0,
    count: 1,
    concurrency: 1,
    hardTimeoutMs: 20 * 60 * 1000,
    navigationTimeoutMs: 45_000,
    lingerMs: 0,
  },
  behavior: {
    // The gap between one action and the next. Unlike the other ranges this
    // one is honoured as a hard band (see Pacing.actionPause), because it is
    // the rhythm an operator actually watches and wants to set. Humans fire
    // in short bursts — sub-second taps with the occasional longer think.
    actionPause: { min: 300, max: 900 },
    pageSettle: { min: 250, max: 800 },
    scrollPause: { min: 220, max: 700 },
    // One gesture now covers at most about half a screen per step. The old
    // 0.9 ceiling meant a single three-step action could sweep nearly three
    // viewports, which on screen read as the page being dragged to the bottom
    // in one motion rather than skimmed.
    scrollFraction: { min: 0.25, max: 0.55 },
    // One to three gestures per scroll action. Six turned a single "scroll"
    // into five seconds, which read as the browser stuck on one page.
    scrollSteps: { min: 1, max: 3 },
    mediaDwell: { min: 300, max: 800 },
    sectionDwell: { min: 400, max: 1000 },
    // How many products before the engine stops actively seeking new ones.
    // Not a stopping point — the session keeps browsing either way; it just
    // stops steering so hard toward unseen products.
    targetProducts: { min: 8, max: 20 },
    backProbability: 0.28,
    returnToCollectionProbability: 0.35,
    idleProbability: 0.18,
    // Every page gets fresh engagement before the engine navigates on —
    // scrolling, dwelling on sections. Below the floor a visitor does not
    // leave the page; past the ceiling it must.
    pageEngagementMs: { min: 20_000, max: 35_000 },
    /**
      * Legacy: no longer consulted by the engine (see pageEngagementMs).
      * Kept only so older config files continue to load.
      */
    maxActionsPerPage: 8,
    speedFactor: 1,
    choreography: DEFAULT_CHOREOGRAPHY,
  },
  safety: {
    allowedHosts: [],
    allowCart: true,
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
  storage: { dbPath: "./data/siteviewer.db" },
  alerts: { enabled: false, sinks: [] },
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

/** Reject cloud metadata endpoints and invalid 0.0.0.0 targets (SSRF guard). */
export function isRestrictedStorefrontUrl(rawUrl: string): { restricted: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { restricted: true, reason: "Invalid URL" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "169.254.169.254" ||
    host === "metadata.google.internal" ||
    host === "metadata.goog" ||
    host === "100.100.100.200" ||
    host === "0.0.0.0" ||
    host.startsWith("169.254.") ||
    host.startsWith("fe80:")
  ) {
    return { restricted: true, reason: `Restricted internal/metadata host "${host}" is not allowed` };
  }
  return { restricted: false };
}

/** Normalise the storefront URL and derive the host allowlist when unset. */
function finalise(config: SimulatorConfig): SimulatorConfig {
  const storefront = config.storefront.trim().replace(/\/+$/, "");
  // An empty global storefront is legal: each profile then browses the shop
  // set on that profile, and the session allowlist is widened per session
  // (see Orchestrator.startProfile). Nothing to derive here.
  if (!storefront) {
    return { ...config, storefront: "" };
  }
  let host: string;
  try {
    host = new URL(storefront).host;
  } catch {
    throw new Error(
      `Invalid storefront URL: ${config.storefront}. Expected e.g. https://example.com`,
    );
  }
  const check = isRestrictedStorefrontUrl(storefront);
  if (check.restricted) {
    throw new Error(`Invalid storefront URL: ${check.reason}`);
  }
  const allowedHosts =
    config.safety.allowedHosts.length > 0
      ? config.safety.allowedHosts
      : [host, host.startsWith("www.") ? host.slice(4) : `www.${host}`];
  // The session's own storefront is always allowed, whatever the allowlist
  // says: a per-profile override must be able to browse the shop it was
  // pointed at without a config edit.
  for (const extra of [storefront]) {
    let h: string;
    try {
      h = new URL(extra).host;
    } catch {
      continue;
    }
    if (!allowedHosts.includes(h)) allowedHosts.push(h);
    const bare = h.startsWith("www.") ? h.slice(4) : `www.${h}`;
    if (!allowedHosts.includes(bare)) allowedHosts.push(bare);
  }

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

  return finalise(config);
}


// ═══════════════════════════════════════════════════════════════════════
// AI-DRIVEN CONFIG (v2)
// ═══════════════════════════════════════════════════════════════════════

/** The one place the Claude model name is written down. */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";

/** Default AI configuration for element detection. */
export type AiProvider = "cookie_pool" | "anthropic_api" | "hybrid";

export interface AnthropicApiConfig {
  /** Environment variable holding the key. The key itself is never read from a file by default. */
  apiKeyEnv?: string;
  /** Literal key; discouraged — prefer the environment variable so it stays out of config files and git. */
  apiKey?: string;
  baseUrl?: string;
  /** Model for the official API (default: the small, fast tier). */
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AiConfig {
  /**
   * Which transport answers Tier-2 detection.
   *   cookie_pool    the claude.ai session-cookie pool only
   *   anthropic_api  the official API only (needs ANTHROPIC_API_KEY)
   *   hybrid         cookie pool first, official API when it fails or is empty
   * Unset: hybrid when an API key is available, otherwise cookie_pool.
   */
  provider?: AiProvider;
  anthropic?: AnthropicApiConfig;
  cookiesDir: string;
  claudeBaseUrl?: string;
  model?: string;
  maxHtmlChars: number;
  maxRetries: number;
  advanceActionTimeMs: number;
  detectionCooldownMs: number;
  /**
   * Tier 0 selector memory, keyed by hostname + page type. Unset = the storage
   * database; a path ending in .json keeps the legacy single-file cache.
   */
  recipeCachePath?: string;
  /** Tier 1 buy-box confidence below which the AI tier is consulted. */
  tier1ConfidenceThreshold?: number;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  cookiesDir: "./Cookies",
  model: DEFAULT_CLAUDE_MODEL,
  maxHtmlChars: 40000,
  maxRetries: 3,
  advanceActionTimeMs: 6 * 60 * 1000,  // 6 minutes (base ATC mark)
  detectionCooldownMs: 500,               // 500ms between AI calls
  // Unset: Tier 0 recipes live in the storage database (config.storage.dbPath).
  tier1ConfidenceThreshold: 0.8,
};

/** Extended config with AI layer support. */
export interface AiDrivenConfig extends SimulatorConfig {
  /** AI detection layer configuration */
  ai: AiConfig;
}

/** Default AI-driven config. */
export const DEFAULT_AI_DRIVEN_CONFIG: AiDrivenConfig = {
  ...DEFAULT_CONFIG,
  ai: DEFAULT_AI_CONFIG,
};


// ═══════════════════════════════════════════════════════════════════════
// ALERTS (realtime health notifications)
// ═══════════════════════════════════════════════════════════════════════

export type AlertSinkConfig =
  | { type: "telegram"; botTokenEnv?: string; botToken?: string; chatId: string }
  | { type: "discord"; webhookUrlEnv?: string; webhookUrl?: string }
  | { type: "webhook"; url?: string; urlEnv?: string; headers?: Record<string, string> };

export interface AlertsConfig {
  enabled: boolean;
  sinks: AlertSinkConfig[];
  /** Same alert key is delivered at most once per this window. Default 10 min. */
  cooldownMs?: number;
  /** ATC success-rate alert: needs this many attempts on a host in the window. */
  atcMinAttempts?: number;
  /** Alert when a host's ATC success rate over the window drops below this (0-1). */
  atcMinSuccessRate?: number;
  /** Rolling window for ATC / challenge rates. Default 30 min. */
  windowMs?: number;
  /** Alert after this many WAF challenges on one proxy within the window. */
  challengeThreshold?: number;
}
