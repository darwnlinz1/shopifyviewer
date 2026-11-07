/**
 * scripts/bitbrowser-smoke.mjs
 *
 * Real-app smoke test for the BitBrowser provider. Creates ONE temporary
 * BitBrowser profile ("SiteViewer-Smoke-<time>"), opens it through the Local
 * API, attaches over CDP, browses a local mock storefront, prints what the
 * kernel reports for the usual fingerprint surfaces, then closes and deletes
 * that temporary profile. Existing BitBrowser profiles are never touched.
 *
 *   node scripts/bitbrowser-smoke.mjs [--core 148] [--headed] [--api http://127.0.0.1:54345]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { launchBrowser } from "../dist/browser/chrome.js";
import { bitBrowserClientFor, checkBitBrowserHealth } from "../dist/browser/bitbrowser.js";
import { Logger } from "../dist/logging/logger.js";
import { Rng } from "../dist/util/random.js";
import { startMockStorefront } from "../test/mockStorefront.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const apiUrl = arg("--api", "http://127.0.0.1:54345");
const coreVersion = arg("--core", "148");
const headless = !process.argv.includes("--headed");

const workDir = mkdtempSync(join(tmpdir(), "bb-smoke-"));
const shop = await startMockStorefront(0);
const config = loadConfig(undefined, {
  storefront: shop.url,
  browser: { headless, provider: "bitbrowser", bitbrowser: { apiUrl, coreVersion }, profileDir: join(workDir, "p") },
  logging: { dir: join(workDir, "logs"), console: true, jsonl: false, level: "info" },
});
const logger = new Logger("bb-smoke", config.logging, "bb-smoke");

const health = await checkBitBrowserHealth(config.browser.bitbrowser);
console.log("health:", health);
if (!health.ok) process.exit(2);

const profile = {
  id: `smoke-${Date.now()}`,
  name: `SiteViewer-Smoke-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`,
  ordinal: 1,
  createdAt: new Date().toISOString(),
  proxy: "",
  identity: { seed: 11, viewport: { width: 1440, height: 900 } },
  stats: { runs: 0, pagesVisited: 0, productsViewed: 0, jsErrors: 0 },
};

let launched;
let exitCode = 0;
const t0 = Date.now();
try {
  launched = await launchBrowser({ slot: 1, sessionId: "bb-smoke", config, logger, rng: new Rng(11), profile });
  console.log(`launched in ${Date.now() - t0}ms · engine=${launched.engine} · ${launched.profilePath}`);
  const ctx = launched.context;
  const tabs = ctx.pages().map((p) => p.url());
  console.log("tabs at attach:", tabs);
  console.log("default context is contexts()[0]:", ctx.browser()?.contexts()[0] === ctx);
  const shopTab = ctx.pages().find((p) => !/console\.bitbrowser\.net/i.test(p.url())) ?? (await ctx.newPage());
  if (/console\.bitbrowser\.net/i.test(shopTab.url()) ) {
    console.error("FAIL: no shop tab besides the BitBrowser console");
    exitCode = 1;
  }

  const page = shopTab;
  await page.goto(`${shop.url}/products/produit-2`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const fp = await page.evaluate(async () => {
    const gl = document.createElement("canvas").getContext("webgl");
    const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
    const c = document.createElement("canvas");
    c.width = 220; c.height = 40;
    const g = c.getContext("2d");
    g.font = "16px Arial"; g.fillStyle = "#f60"; g.fillRect(10, 5, 90, 20); g.fillStyle = "#069"; g.fillText("SiteViewer 🛒", 4, 30);
    const data = c.toDataURL();
    let h = 0;
    for (let i = 0; i < data.length; i++) h = (h * 31 + data.charCodeAt(i)) | 0;
    return {
      ua: navigator.userAgent,
      platform: navigator.platform,
      webdriver: navigator.webdriver,
      languages: navigator.languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: `${screen.width}x${screen.height}`,
      inner: `${innerWidth}x${innerHeight}`,
      webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      canvasHash: h,
      siteViewerStealth: typeof window[Symbol.for("__v8_native_reg__")] !== "undefined",
      siteViewerNoise: window.__noise_injected_v2__ === true,
      title: document.title,
    };
  });
  console.log("kernel fingerprint:", JSON.stringify(fp, null, 2));
  if (fp.siteViewerStealth || fp.siteViewerNoise) {
    console.error("FAIL: SiteViewer init scripts leaked into the BitBrowser kernel");
    exitCode = 1;
  }
  if (!/Mock Shop/.test(fp.title)) {
    console.error("FAIL: page did not load the storefront");
    exitCode = 1;
  }

  // Warm reopen of the same profile: what every launch after the first costs.
  await launched.close();
  const t1 = Date.now();
  launched = await launchBrowser({ slot: 1, sessionId: "bb-smoke-2", config, logger, rng: new Rng(12), profile });
  const page2 = launched.context.pages().find((p) => !/console\.bitbrowser\.net/i.test(p.url())) ?? (await launched.context.newPage());
  await page2.goto(`${shop.url}/collections/all`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  console.log(`warm reopen + first page in ${Date.now() - t1}ms (${await page2.title()})`);
} catch (err) {
  console.error("smoke failed:", err);
  exitCode = 1;
} finally {
  if (launched) await launched.close().catch((e) => console.error("close failed:", e.message));
  if (profile.bitBrowserId) {
    try {
      await bitBrowserClientFor(config.browser.bitbrowser).delete(profile.bitBrowserId);
      console.log(`deleted temporary BitBrowser profile ${profile.bitBrowserId}`);
    } catch (err) {
      console.error(`could not delete temporary profile ${profile.bitBrowserId}:`, err.message);
      exitCode = exitCode || 3;
    }
  }
  await shop.close();
  rmSync(workDir, { recursive: true, force: true });
}
console.log(exitCode === 0 ? "BITBROWSER SMOKE: PASS" : "BITBROWSER SMOKE: FAIL");
process.exit(exitCode);
