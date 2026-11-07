#!/usr/bin/env node
/**
 * CLI for the Shopify storefront behaviour simulator.
 *
 *   storefront-sim run    [flags]   run one or more ~15 minute sessions
 *   storefront-sim probe  [flags]   check which selectors match this theme
 *   storefront-sim info             report browser binary status
 *   storefront-sim init             write a starter config file
 */
import { writeFileSync, existsSync } from "node:fs";
import { ensureDependencies } from "./bootstrap.js";
import { loadConfig, DEFAULT_CONFIG, type SimulatorConfig } from "./config.js";
import { runAll } from "./session/runner.js";
import { probeStorefront, formatProbeReport } from "./navigator/probe.js";
import { browserBinaryStatus } from "./browser/chrome.js";
import { verifyBrowser, formatFingerprintReport } from "./browser/verify.js";
import { Orchestrator } from "./server/orchestrator.js";
import { startDashboard } from "./server/http.js";

const USAGE = `
AI Storefront Simulator — Chrome + Playwright + Claude element detection

Usage
  storefront-sim <command> [options]

Commands
  dashboard Manage many browser profiles from a live web UI
  run       Run simulated browsing sessions against a storefront
  probe     Load home/collection/product and report which selectors match
  verify    Report what the browser exposes to a page, and any inconsistencies
  info      Show browser binary status
  init      Write a starter storefront-sim.config.json

Options
  --storefront <url>     Storefront base URL            (default: none, set per profile)
  --sessions <n>         Number of sessions to run      (default 1)
  --concurrency <n>      Sessions running in parallel   (default 1)
  --duration <minutes>   Session length                 (default 15)
  --seed <n>             Deterministic seed (reproduces a session)
  --config <path>        Config file to load
  --profile-dir <path>   Persistent profile directory   (default ./tempprofolio)
  --log-dir <path>       Log output directory           (default ./logs)
  --log-level <level>    debug | info | warn | error    (default info)
  --proxy <url>          Proxy URL (repeatable, one per session slot)
  --headed               Run with a visible browser window
  --headless             Force headless (default)
  --fresh-profiles       Do not reuse profiles between runs
  --allow-fallback       Legacy flag, accepted and ignored (Chrome is the engine)
  --pace <factor>        Speed multiplier for every delay
                         (1 = default, 2 = twice as brisk, 0.5 = half speed)
  --atc-min <minutes>    Timed add-to-cart schedule; needs safety.allowCart
                         (0 = disable timed ATC)
  --linger <minutes>     Hold the browser open after the budget is spent
                         (0 = close immediately, -1 = until closed)
  --port <n>             Dashboard port                 (default 7317)
  --host <addr>          Dashboard bind address         (default 127.0.0.1)
  --token <secret>       Require this token on every dashboard API call
  --quiet                Suppress console logging
  -h, --help             Show this help

Examples
  storefront-sim dashboard --headed
  storefront-sim probe --storefront https://your-shop.com
  storefront-sim run --storefront https://your-shop.com --sessions 3 --concurrency 3
  storefront-sim run --duration 15 --seed 42 --headed
  storefront-sim verify --headed
`;

interface ParsedArgs {
  command: string;
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "run";
  const flags = new Map<string, string[]>();
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token || !token.startsWith("--")) {
      if (token === "-h") flags.set("help", ["true"]);
      continue;
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    const takesValue = next !== undefined && !next.startsWith("--");
    const value = takesValue ? next : "true";
    if (takesValue) i++;
    const existing = flags.get(name);
    if (existing) existing.push(value);
    else flags.set(name, [value]);
  }
  return { command, flags };
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

function has(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}

function num(flags: Map<string, string[]>, name: string): number | undefined {
  const raw = one(flags, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} expects a number, got "${raw}"`);
  }
  return parsed;
}

/** Turn CLI flags into a config patch. */
function overridesFrom(flags: Map<string, string[]>): Partial<SimulatorConfig> {
  const patch: Record<string, unknown> = {};
  const browser: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const logging: Record<string, unknown> = {};
  const behavior: Record<string, unknown> = {};

  const storefront = one(flags, "storefront");
  if (storefront) patch.storefront = storefront;

  const seed = num(flags, "seed");
  if (seed !== undefined) patch.seed = seed;

  const sessions = num(flags, "sessions");
  if (sessions !== undefined) session.count = sessions;

  const concurrency = num(flags, "concurrency");
  if (concurrency !== undefined) session.concurrency = concurrency;

  const duration = num(flags, "duration");
  if (duration !== undefined) {
    session.durationMs = Math.round(duration * 60_000);
    // Keep the hard ceiling comfortably above the planned budget.
    session.hardTimeoutMs = Math.round(duration * 60_000 * 1.4) + 60_000;
  }

  if (has(flags, "headed")) browser.headless = false;
  if (has(flags, "headless")) browser.headless = true;
  if (has(flags, "fresh-profiles")) browser.persistProfiles = false;
  if (has(flags, "allow-fallback")) browser.allowFallbackBrowser = true;

  const profileDir = one(flags, "profile-dir");
  if (profileDir) browser.profileDir = profileDir;

  const proxies = flags.get("proxy");
  if (proxies) browser.proxies = proxies;

  const logDir = one(flags, "log-dir");
  if (logDir) logging.dir = logDir;

  const logLevel = one(flags, "log-level");
  if (logLevel) logging.level = logLevel;

  const pace = num(flags, "pace");
  if (pace !== undefined) {
    if (!(pace > 0)) throw new Error("--pace expects a number greater than zero");
    behavior.speedFactor = pace;
  }

  // Timed add-to-cart: minutes from session start; 0 disables it entirely.
  // Only meaningful together with safety.allowCart.
  const atc = num(flags, "atc-min");
  if (atc !== undefined) {
    if (atc < 0) throw new Error("--atc-min expects 0 (off) or a positive number of minutes");
    const ai: Record<string, unknown> = {
      advanceActionTimeMs: atc === 0 ? Number.MAX_SAFE_INTEGER : Math.round(atc * 60_000),
    };
    patch.ai = ai;
  }

  const linger = num(flags, "linger");
  if (linger !== undefined) session.lingerMs = Math.round(linger * 60_000);

  if (has(flags, "quiet")) logging.console = false;

  if (Object.keys(behavior).length) patch.behavior = behavior;
  if (Object.keys(browser).length) patch.browser = browser;
  if (Object.keys(session).length) patch.session = session;
  if (Object.keys(logging).length) patch.logging = logging;
  return patch as Partial<SimulatorConfig>;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (has(flags, "help") || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  // Install anything missing before a command tries to import it. A no-op
  // once dependencies are present, so this costs one resolve per run.
  if (!ensureDependencies({ quiet: has(flags, "quiet") })) return 1;

  if (command === "init") {
    const path = one(flags, "config") ?? "storefront-sim.config.json";
    if (existsSync(path) && !has(flags, "force")) {
      process.stderr.write(`${path} already exists. Use --force to overwrite.\n`);
      return 1;
    }
    const storefront = one(flags, "storefront") ?? DEFAULT_CONFIG.storefront;
    writeFileSync(
      path,
      `${JSON.stringify({ ...DEFAULT_CONFIG, storefront }, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`Wrote ${path}\n`);
    return 0;
  }

  if (command === "info") {
    const status = await browserBinaryStatus();
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    if (status.engine === "none") {
      process.stdout.write(
        `\nKhong tim thay Google Chrome / Microsoft Edge. Cai Chrome hoac dat\n` +
          `browser.executablePath trong storefront-sim.config.json.\n`,
      );
    }
    return status.engine === "none" ? 1 : 0;
  }

  const config = loadConfig(one(flags, "config"), overridesFrom(flags));

  // Commands that browse need a shop to aim at. The dashboard does not: it
  // only starts sessions for profiles that carry their own storefront.
  if (["run", "probe"].includes(command) && !config.storefront) {
    process.stderr.write(
      `No storefront configured. Set one with --storefront <url>, in the\n` +
        `config file, or on each profile via the dashboard.\n`,
    );
    return 1;
  }

  if (command === "dashboard") {
    const port = num(flags, "port") ?? 7317;
    const host = one(flags, "host") ?? "127.0.0.1";
    const token = one(flags, "token");

    const orchestrator = new Orchestrator(config);
    const dashboard = await startDashboard(orchestrator, port, host, token);

    process.stdout.write(
      [
        "",
        `Dashboard  ${dashboard.url}${token ? "/?token=" + encodeURIComponent(token) : ""}`,
        `Storefront ${config.storefront || "(per-profile)"}`,
        `Profiles   ${config.browser.profileDir}`,
        `Browsers   ${config.browser.headless ? "headless (live view still streams)" : "headed"}`,
        "",
        token
          ? "API calls require the token. Every tile streams its browser live. Ctrl-C to stop."
          : "Every tile streams its browser live. Ctrl-C to stop.",
        "",
      ].join("\n"),
    );

    // Sessions own real browser processes and a profile directory each, so a
    // clean shutdown matters more here than in a one-shot run.
    await new Promise<void>((resolve) => {
      let closing = false;
      const shutdown = (): void => {
        if (closing) process.exit(130);
        closing = true;
        process.stderr.write("\nClosing browsers...\n");
        void (async () => {
          await orchestrator.shutdown().catch(() => undefined);
          await dashboard.close().catch(() => undefined);
          resolve();
        })();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
    return 0;
  }

  if (command === "verify") {
    const report = await verifyBrowser(config);
    process.stdout.write(`${formatFingerprintReport(report)}\n`);
    return report.inconsistencies.length > 0 ? 1 : 0;
  }

  if (command === "probe") {
    const report = await probeStorefront(config);
    process.stdout.write(`${formatProbeReport(report)}\n`);
    const broken = report.pages.filter((p) => p.status === null || p.status >= 400);
    return broken.length > 0 ? 1 : 0;
  }

  if (command !== "run") {
    process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
    return 1;
  }

  // Ctrl-C ends sessions cleanly so profiles and logs are flushed.
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write("\nShutting down sessions... (Ctrl-C again to force)\n");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const summary = await runAll({ config, signal: controller.signal });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  const t = summary.totals;
  process.stdout.write(
    [
      "",
      `Run complete — ${summary.storefront}`,
      `  sessions        ${t.succeeded}/${t.sessions} ok` + (t.blocked > 0 ? ` (${t.blocked} blocked by walls)` : ""),
      `  pages visited   ${t.pagesVisited}`,
      `  products viewed ${t.productsViewed}`,
      `  collections     ${t.collectionsViewed}`,
      `  js errors       ${t.jsErrors} (uncaught exceptions)`,
      `  console errors  ${t.consoleErrors}`,
      `  failed requests ${t.failedRequests}`,
      `  nav errors      ${t.navigationErrors}`,
      `  slowest load    ${t.slowestNavigationMs ?? "n/a"}ms (avg of per-session worst)`,
      `  logs            ${config.logging.dir}/`,
      "",
    ].join("\n"),
  );

  return t.failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

