/**
 * Fingerprint self-check.
 *
 * Reports what the browser actually exposes to a page, so the operator can
 * confirm the stack is configured the way they think it is instead of assuming
 * it. This is diagnostics for our own tool: every value here is one the page
 * under test could read for itself.
 *
 * It deliberately does not score anything or claim a given site will or will
 * not be satisfied — that depends on the shop's own protection settings and
 * changes constantly. What it does is make the *inconsistencies* visible,
 * which is the actionable part: a browser claiming one timezone while its exit
 * IP is somewhere else is a configuration bug regardless of who is looking.
 */
import type { Page } from "playwright-core";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { Rng, randomSeed } from "../util/random.js";
import { launchBrowser, cloakBinaryStatus } from "./cloak.js";
import { openSessionPage } from "../navigator/pageNavigator.js";
import type { Profile } from "../profiles/types.js";

/** What the page can observe about the browser. */
export interface FingerprintReport {
  engine: string;
  binary: { installed: boolean; version?: string; tier?: string };
  navigator: {
    userAgent: string;
    platform: string;
    languages: string[];
    hardwareConcurrency: number;
    deviceMemory: number | null;
    /** The classic automation flag. */
    webdriver: unknown;
    pluginCount: number;
    maxTouchPoints: number;
  };
  screen: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number };
  viewport: { width: number; height: number; devicePixelRatio: number };
  timezone: { intl: string; offsetMinutes: number };
  locale: string;
  webgl: { vendor: string | null; renderer: string | null };
  /** Properties headless builds historically leak. */
  headlessMarkers: Record<string, unknown>;
  /** Contradictions worth fixing, in plain language. */
  inconsistencies: string[];
}

/** Read the fingerprint surface from a live page. */
export async function readFingerprint(page: Page): Promise<Omit<FingerprintReport, "engine" | "binary" | "inconsistencies">> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { deviceMemory?: number; webdriver?: unknown };

    let vendor: string | null = null;
    let renderer: string | null = null;
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      if (gl && info) {
        vendor = String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL));
        renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
      }
    } catch {
      /* WebGL unavailable — reported as nulls. */
    }

    return {
      navigator: {
        userAgent: nav.userAgent,
        platform: nav.platform,
        languages: [...nav.languages],
        hardwareConcurrency: nav.hardwareConcurrency,
        deviceMemory: nav.deviceMemory ?? null,
        webdriver: nav.webdriver,
        pluginCount: nav.plugins?.length ?? 0,
        maxTouchPoints: nav.maxTouchPoints,
      },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      timezone: {
        intl: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMinutes: -new Date().getTimezoneOffset(),
      },
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      webgl: { vendor, renderer },
      headlessMarkers: {
        // "HeadlessChrome" in the UA is the oldest and bluntest tell.
        uaSaysHeadless: /headless/i.test(nav.userAgent),
        // A real Chrome exposes window.chrome; many headless setups do not.
        hasWindowChrome: "chrome" in window,
        // Zero plugins and zero languages are both classic automation shapes.
        zeroPlugins: (nav.plugins?.length ?? 0) === 0,
        zeroLanguages: nav.languages.length === 0,
        // Playwright/Puppeteer set this unless it is patched out.
        webdriverFlag: nav.webdriver === true,
      },
    };
  });
}

/** Cross-check the readings against each other and against the config. */
function findInconsistencies(
  report: Omit<FingerprintReport, "engine" | "binary" | "inconsistencies">,
  config: SimulatorConfig,
  profile?: Profile,
): string[] {
  const problems: string[] = [];
  const markers = report.headlessMarkers;

  if (markers.uaSaysHeadless) {
    problems.push('User-Agent contains "HeadlessChrome" — the stealth binary is not in use.');
  }
  if (markers.webdriverFlag) {
    problems.push("navigator.webdriver is true — the automation flag is not patched.");
  }
  if (markers.zeroPlugins) {
    problems.push("navigator.plugins is empty, which a desktop Chrome never is.");
  }
  if (markers.zeroLanguages) {
    problems.push("navigator.languages is empty.");
  }
  if (!markers.hasWindowChrome) {
    problems.push("window.chrome is missing, which desktop Chrome always defines.");
  }

  // The viewport the profile asked for should be the viewport it got.
  const wanted = profile?.identity.viewport;
  if (wanted && (wanted.width !== report.viewport.width || wanted.height !== report.viewport.height)) {
    problems.push(
      `Viewport is ${report.viewport.width}x${report.viewport.height} but the profile pins ` +
        `${wanted.width}x${wanted.height}.`,
    );
  }

  // A window larger than the screen it claims to be on is impossible.
  if (report.viewport.width > report.screen.width || report.viewport.height > report.screen.height) {
    problems.push(
      `Viewport (${report.viewport.width}x${report.viewport.height}) is larger than the reported ` +
        `screen (${report.screen.width}x${report.screen.height}).`,
    );
  }

  // Configured timezone versus what the page actually resolves.
  const wantedTz = profile?.identity.timezone ?? config.browser.timezone;
  if (wantedTz && report.timezone.intl !== wantedTz) {
    problems.push(`Timezone resolves to ${report.timezone.intl} but ${wantedTz} was configured.`);
  }

  // Language and locale should agree with each other.
  const primaryLanguage = report.navigator.languages[0];
  if (primaryLanguage && report.locale && !report.locale.startsWith(primaryLanguage.split("-")[0] ?? "")) {
    problems.push(
      `Intl locale (${report.locale}) and navigator.languages (${primaryLanguage}) disagree.`,
    );
  }

  // A proxy with no geo derivation and no pinned timezone is the setup most
  // likely to put the IP in one country and the clock in another.
  const proxy = profile?.proxy || config.browser.proxies[0];
  if (proxy && !wantedTz && !config.browser.geoip) {
    problems.push(
      "A proxy is configured but neither geoip nor an explicit timezone is set — " +
        "the clock will report this machine's timezone regardless of where the traffic exits.",
    );
  }

  return problems;
}

/** Launch a browser, read its fingerprint surface, and report. */
export async function verifyBrowser(
  config: SimulatorConfig,
  profile?: Profile,
): Promise<FingerprintReport> {
  const logger = new Logger("verify", { ...config.logging, jsonl: false }, "verify");
  const rng = new Rng(config.seed ?? randomSeed());
  const binary = await cloakBinaryStatus();

  const browser = await launchBrowser({
    slot: 0,
    sessionId: "verify",
    config,
    logger,
    rng,
    ...(profile ? { profile } : {}),
  });

  try {
    const page = await openSessionPage(browser.context);
    // about:blank exposes the same navigator surface without involving a
    // third-party page in a diagnostic run.
    await page.goto("about:blank").catch(() => undefined);
    const readings = await readFingerprint(page);

    return {
      engine: browser.engine,
      binary: {
        installed: binary.installed,
        ...(binary.version ? { version: binary.version } : {}),
        ...(binary.tier ? { tier: binary.tier } : {}),
      },
      ...readings,
      inconsistencies: findInconsistencies(readings, config, profile),
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Format a fingerprint report for the terminal. */
export function formatFingerprintReport(report: FingerprintReport): string {
  const lines: string[] = [];
  const nav = report.navigator;

  lines.push(`Engine            ${report.engine}`);
  lines.push(
    `Binary            ${report.binary.installed ? `${report.binary.version ?? "?"} (${report.binary.tier ?? "?"})` : "not installed"}`,
  );
  lines.push("");
  lines.push(`User-Agent        ${nav.userAgent}`);
  lines.push(`Platform          ${nav.platform}`);
  lines.push(`Languages         ${nav.languages.join(", ") || "(none)"}`);
  lines.push(`Locale            ${report.locale}`);
  lines.push(
    `Timezone          ${report.timezone.intl} (UTC${report.timezone.offsetMinutes >= 0 ? "+" : ""}${report.timezone.offsetMinutes / 60})`,
  );
  lines.push(`Cores / memory    ${nav.hardwareConcurrency} / ${nav.deviceMemory ?? "?"}GB`);
  lines.push(`Plugins           ${nav.pluginCount}`);
  lines.push(`Touch points      ${nav.maxTouchPoints}`);
  lines.push(`navigator.webdriver ${String(nav.webdriver)}`);
  lines.push(
    `Screen            ${report.screen.width}x${report.screen.height} (avail ${report.screen.availWidth}x${report.screen.availHeight}, ${report.screen.colorDepth}-bit)`,
  );
  lines.push(
    `Viewport          ${report.viewport.width}x${report.viewport.height} @${report.viewport.devicePixelRatio}x`,
  );
  lines.push(`WebGL             ${report.webgl.vendor ?? "?"} / ${report.webgl.renderer ?? "?"}`);
  lines.push("");

  if (report.inconsistencies.length === 0) {
    lines.push("No inconsistencies found between the configured identity and what the page sees.");
  } else {
    lines.push(`${report.inconsistencies.length} inconsistency/ies:`);
    for (const problem of report.inconsistencies) lines.push(`  - ${problem}`);
  }

  return lines.join("\n");
}
