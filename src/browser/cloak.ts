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
import { Rng } from "../util/random.js";

/** Which engine actually backed a launch. */
export type BrowserEngine = "cloakbrowser" | "playwright-fallback";

export interface LaunchedBrowser {
  context: BrowserContext;
  engine: BrowserEngine;
  profilePath: string;
  close(): Promise<void>;
}

export interface LaunchRequest {
  /** Stable per-session slot; decides which persistent profile is reused. */
  slot: number;
  sessionId: string;
  config: SimulatorConfig;
  logger: Logger;
  rng: Rng;
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

/** Launch a browsing session on CloakBrowser's patched Chromium. */
export async function launchBrowser(req: LaunchRequest): Promise<LaunchedBrowser> {
  const { config, logger, rng, slot, sessionId } = req;
  const browserCfg = config.browser;
  const profilePath = profilePathFor(browserCfg, slot, sessionId);
  const viewport =
    rng.pick(browserCfg.viewports) ?? { width: 1440, height: 900 };
  const proxy =
    browserCfg.proxies.length > 0
      ? browserCfg.proxies[slot % browserCfg.proxies.length]
      : undefined;

  const options: CloakLaunchOptions = {
    userDataDir: profilePath,
    headless: browserCfg.headless,
    viewport,
    humanize: browserCfg.humanize,
    humanPreset: browserCfg.humanPreset,
    args: stabilityArgs(),
    ...(proxy ? { proxy } : {}),
    ...(browserCfg.geoip ? { geoip: true } : {}),
    ...(browserCfg.timezone ? { timezone: browserCfg.timezone } : {}),
    ...(browserCfg.locale ? { locale: browserCfg.locale } : {}),
    ...(browserCfg.licenseKey ? { licenseKey: browserCfg.licenseKey } : {}),
  };

  logger.info("browser_launch", "starting CloakBrowser", {
    data: {
      profilePath,
      viewport,
      headless: browserCfg.headless,
      humanize: browserCfg.humanize,
      proxy: proxy ? redactProxy(proxy) : null,
    },
  });

  try {
    const cloak = await import("cloakbrowser");
    const context = await cloak.launchPersistentContext(options);
    logger.info("browser_ready", "CloakBrowser context ready", {
      data: { engine: "cloakbrowser" },
    });
    return {
      context,
      engine: "cloakbrowser",
      profilePath,
      close: () => context.close(),
    };
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
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: browserCfg.headless,
      viewport,
      args: stabilityArgs(),
      ...(proxy ? { proxy: { server: proxy } } : {}),
      ...(browserCfg.locale ? { locale: browserCfg.locale } : {}),
      ...(browserCfg.timezone ? { timezoneId: browserCfg.timezone } : {}),
    });
    return {
      context,
      engine: "playwright-fallback",
      profilePath,
      close: () => context.close(),
    };
  }
}

/** Strip credentials from a proxy URL before it reaches a log line. */
export function redactProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return "<proxy>";
  }
}

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
