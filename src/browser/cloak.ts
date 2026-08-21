/**
 * CloakBrowser adapter — the browser foundation for the simulator.
 *
 * The whole browser layer is built on CloakBrowser's patched Chromium
 * (`launchPersistentContext`), which hands back a standard Playwright
 * `BrowserContext`. Everything above this file therefore talks plain
 * Playwright, while the binary, fingerprint patches, persistent profile and
 * human-input layer come from CloakBrowser.
 *
 * A stock playwright-core fallback exists only for environments where the
 * CloakBrowser binary cannot be provisioned (CI smoke tests). It is opt-in via
 * `browser.allowFallbackBrowser`, so a normal run fails loudly rather than
 * silently dropping the CloakBrowser layer.
 */
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { BrowserContext } from "playwright-core";
import type { LaunchPersistentContextOptions as CloakLaunchOptions } from "cloakbrowser";
import type { BrowserConfig, SimulatorConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Profile } from "../profiles/types.js";
import { liveCookies } from "../profiles/cookies.js";
import { parseProxy, redactProxy } from "../profiles/proxy.js";
import { resolveIdentity, humanConfigFor } from "./identity.js";
import { Rng } from "../util/random.js";

/** Which engine actually backed a launch. */
export type BrowserEngine = "cloakbrowser" | "playwright-fallback";

export interface LaunchedBrowser {
  context: BrowserContext;
  engine: BrowserEngine;
  profilePath: string;
  /** Cookies injected into the context at launch, for the log. */
  cookiesInjected: number;
  close(): Promise<void>;
}

export interface LaunchRequest {
  /** Stable per-session slot; decides which persistent profile is reused. */
  slot: number;
  sessionId: string;
  config: SimulatorConfig;
  logger: Logger;
  rng: Rng;
  /**
   * Managed profile driving this launch. When present its pinned identity,
   * proxy and cookies win over the global browser config — the dashboard owns
   * per-profile settings, the config file only supplies defaults.
   */
  profile?: Profile;
  /** Override the user-data directory (the dashboard keys these by profile). */
  userDataDir?: string;
}

/**
 * Resolve the persistent profile directory for a session slot.
 *
 * With `persistProfiles` the directory is keyed by slot so repeat runs reuse
 * cookies/localStorage/cache; otherwise it is keyed by session id, giving each
 * run a cold profile.
 */
export function profilePathFor(
  browser: BrowserConfig,
  slot: number,
  sessionId: string,
): string {
  const base = resolve(process.cwd(), browser.profileDir);
  const name = browser.persistProfiles ? `slot-${slot}` : `session-${sessionId}`;
  const path = join(base, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Chromium flags that keep a long automated session stable and quiet. */
function stabilityArgs(): string[] {
  return [
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,OptimizationHints",
  ];
}

/**
 * Provision the binary and check the licence *before* any session starts.
 *
 * Both failures used to surface from deep inside the first launch: N parallel
 * sessions would each race to download the ~1 GB binary, and a free-tier key
 * with `--concurrency 3` died with a generic launch error rather than the
 * actual reason. Doing it once up front turns both into a clear message.
 */
export async function preflight(
  config: SimulatorConfig,
  logger: Logger,
): Promise<{ ok: true; tier?: string } | { ok: false; reason: string }> {
  if (config.browser.allowFallbackBrowser) {
    // The caller has already accepted stock Chromium, so a missing binary is
    // not fatal and preflight should not block on it.
    return { ok: true };
  }

  let cloak: typeof import("cloakbrowser");
  try {
    cloak = await import("cloakbrowser");
  } catch (err) {
    return {
      ok: false,
      reason: `cloakbrowser module unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    await cloak.ensureBinary();
  } catch (err) {
    return {
      ok: false,
      reason:
        `CloakBrowser binary could not be provisioned: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `Run "npx cloakbrowser install" to fetch it.`,
    };
  }

  const info = cloak.binaryInfo();
  const tier = info.tier;

  // The free tier allows a single concurrent session. Say so now rather than
  // letting session 2 fail halfway through a run.
  if (config.session.concurrency > 1 && tier !== "pro") {
    const key = config.browser.licenseKey;
    if (!key) {
      return {
        ok: false,
        reason:
          `concurrency=${config.session.concurrency} needs a CloakBrowser Pro licence ` +
          `(free tier allows 1 concurrent session). Set browser.licenseKey or ` +
          `CLOAKBROWSER_LICENSE_KEY, or run with --concurrency 1.`,
      };
    }
    try {
      await cloak.validateLicense(key);
    } catch (err) {
      return {
        ok: false,
        reason: `CloakBrowser licence rejected: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  logger.debug("preflight_ok", `CloakBrowser ${info.version} (${tier})`, {
    data: { version: info.version, tier, binaryPath: info.binaryPath },
  });
  return { ok: true, tier };
}

/** Launch a browsing session on CloakBrowser's patched Chromium. */
export async function launchBrowser(req: LaunchRequest): Promise<LaunchedBrowser> {
  const { config, logger, rng, slot, sessionId, profile } = req;
  const browserCfg = config.browser;
  const profilePath =
    req.userDataDir ?? profilePathFor(browserCfg, slot, sessionId);
  mkdirSync(profilePath, { recursive: true });

  // A managed profile's identity is pinned at creation; without one, fall back
  // to drawing a viewport from the pool for this run.
  const identity = profile
    ? resolveIdentity(profile.identity)
    : {
        viewport: rng.pick(browserCfg.viewports) ?? { width: 1440, height: 900 },
        ...(browserCfg.timezone ? { timezone: browserCfg.timezone } : {}),
        ...(browserCfg.locale ? { locale: browserCfg.locale } : {}),
        colorScheme: "light" as const,
      };

  const proxyInput =
    profile?.proxy ||
    (browserCfg.proxies.length > 0
      ? browserCfg.proxies[slot % browserCfg.proxies.length]
      : undefined);

  // Parse once here so both launch paths get a consistent shape. CloakBrowser
  // accepts the credential-bearing URL directly, but stock Playwright needs
  // username/password split out of it or it will not authenticate.
  const proxy = proxyInput ? parseProxy(proxyInput) : undefined;

  // When traffic exits through a proxy, let CloakBrowser derive timezone and
  // locale from the exit IP unless they were pinned explicitly. A hardcoded
  // Europe/Paris behind an IP that geolocates elsewhere is a contradiction the
  // page can read directly.
  const geoip = browserCfg.geoip || (!!proxy && !identity.timezone);

  const options: CloakLaunchOptions = {
    userDataDir: profilePath,
    headless: browserCfg.headless,
    viewport: identity.viewport,
    colorScheme: identity.colorScheme,
    humanize: browserCfg.humanize,
    humanPreset: browserCfg.humanPreset,
    ...(profile ? { humanConfig: humanConfigFor(profile.identity) } : {}),
    args: stabilityArgs(),
    ...(proxy
      ? {
          proxy: {
            server: proxy.server,
            ...(proxy.username ? { username: proxy.username } : {}),
            ...(proxy.password ? { password: proxy.password } : {}),
          },
        }
      : {}),
    ...(geoip ? { geoip: true } : {}),
    // Top-level timezone/locale route to binary fingerprint flags; the same
    // values passed through contextOptions would be CDP emulation, which is
    // detectable, so they deliberately do not go there.
    ...(identity.timezone ? { timezone: identity.timezone } : {}),
    ...(identity.locale ? { locale: identity.locale } : {}),
    ...(browserCfg.licenseKey ? { licenseKey: browserCfg.licenseKey } : {}),
  };

  logger.info("browser_launch", "starting CloakBrowser", {
    data: {
      profilePath,
      viewport: identity.viewport,
      headless: browserCfg.headless,
      humanize: browserCfg.humanize,
      geoip,
      timezone: identity.timezone ?? (geoip ? "<from proxy>" : null),
      proxy: proxy ? redactProxy(proxy.raw) : null,
    },
  });

  let context: BrowserContext;
  let engine: BrowserEngine;

  try {
    const cloak = await import("cloakbrowser");
    context = await cloak.launchPersistentContext(options);
    engine = "cloakbrowser";
    logger.info("browser_ready", "CloakBrowser context ready", {
      data: { engine },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (!browserCfg.allowFallbackBrowser) {
      throw new Error(
        `CloakBrowser failed to launch: ${detail}\n` +
          `Run "npx cloakbrowser install" to fetch the patched Chromium binary, ` +
          `or set browser.allowFallbackBrowser=true to run on stock Chromium.`,
      );
    }
    logger.warn(
      "browser_fallback",
      `CloakBrowser unavailable (${detail}); falling back to stock Chromium`,
    );
    const { chromium } = await import("playwright-core");
    context = await chromium.launchPersistentContext(profilePath, {
      headless: browserCfg.headless,
      viewport: identity.viewport,
      colorScheme: identity.colorScheme,
      args: stabilityArgs(),
      ...(proxy
        ? {
            proxy: {
              server: proxy.server,
              ...(proxy.username ? { username: proxy.username } : {}),
              ...(proxy.password ? { password: proxy.password } : {}),
            },
          }
        : {}),
      ...(identity.locale ? { locale: identity.locale } : {}),
      ...(identity.timezone ? { timezoneId: identity.timezone } : {}),
    });
    engine = "playwright-fallback";
  }

  const cookiesInjected = await injectCookies(context, profile, logger);

  return {
    context,
    engine,
    profilePath,
    cookiesInjected,
    close: () => context.close(),
  };
}

/**
 * Seed the context with the profile's imported cookies.
 *
 * These go through `addCookies` rather than `contextOptions.storageState`:
 * `storageState` is a `newContext()` option and is ignored by
 * `launchPersistentContext`, which is what a profile always uses.
 *
 * Already-expired cookies are dropped first — the browser would reject them
 * anyway, and counting them would overstate what was actually loaded.
 */
async function injectCookies(
  context: BrowserContext,
  profile: Profile | undefined,
  logger: Logger,
): Promise<number> {
  const stored = profile?.cookies?.cookies;
  if (!stored || stored.length === 0) return 0;

  const usable = liveCookies(stored);
  const expired = stored.length - usable.length;
  if (usable.length === 0) {
    logger.warn("cookies_all_expired", `all ${stored.length} stored cookies have expired`, {
      data: { source: profile?.cookies?.sourceName },
    });
    return 0;
  }

  try {
    await context.addCookies(usable);
    logger.info("cookies_loaded", `injected ${usable.length} cookie(s)`, {
      data: {
        source: profile?.cookies?.sourceName,
        injected: usable.length,
        expiredSkipped: expired,
        domains: profile?.cookies?.domains.slice(0, 5),
      },
    });
    return usable.length;
  } catch (err) {
    // A malformed cookie should not take the whole session down; the run is
    // still useful, just as a logged-out visitor.
    logger.warn(
      "cookies_rejected",
      `browser rejected the cookie jar: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

export { redactProxy };

/** Report whether the CloakBrowser binary is already installed locally. */
export async function cloakBinaryStatus(): Promise<{
  installed: boolean;
  version?: string;
  tier?: string;
  binaryPath?: string;
  error?: string;
}> {
  try {
    const cloak = await import("cloakbrowser");
    const info = cloak.binaryInfo();
    return {
      installed: info.installed,
      version: info.version,
      tier: info.tier,
      binaryPath: info.binaryPath,
    };
  } catch (err) {
    return {
      installed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
