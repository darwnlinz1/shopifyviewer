/**
 * scripts/test-5-live-sites.mjs
 *
 * Live 5-thread benchmark across 5 real Shopify storefronts WITHOUT shop.app
 * cookies and WITHOUT AI cookies (the AI tier falls back to local rules), so it
 * measures the detection waterfall (Tier 0 recipes / Tier 1 multi-signal) and
 * the pre-checkout choreography on real themes.
 *
 *   node scripts/test-5-live-sites.mjs              # choreography run: 3.2 min, ATC at 2.0 min (compare on)
 *   node scripts/test-5-live-sites.mjs --quick      # speed run: 1.5 min, ATC at 0.4 min
 *   node scripts/test-5-live-sites.mjs --bitbrowser # same, on temporary BitBrowser profiles (deleted after)
 *   node scripts/test-5-live-sites.mjs --warm       # reuse ./data/domain-recipes.json instead of a fresh one
 *
 * Exit code 0 only when all 5 sites verify an add-to-cart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../dist/server/orchestrator.js";
import { loadConfig, DEFAULT_CONFIG } from "../dist/config.js";
import { sleep } from "../dist/util/random.js";

const FIVE_SITES = [
  { name: "TaylorStitch", url: "https://www.taylorstitch.com" },
  { name: "Keychron", url: "https://www.keychron.com" },
  { name: "DeathWishCoffee", url: "https://www.deathwishcoffee.com" },
  { name: "PuraVida", url: "https://www.puravidabracelets.com" },
  { name: "BioLite", url: "https://www.bioliteenergy.com" },
];

const quick = process.argv.includes("--quick");
const useBitBrowser = process.argv.includes("--bitbrowser");
const warm = process.argv.includes("--warm");
const durationMinutes = quick ? 1.5 : 3.2;
const atcMinutes = quick ? 0.4 : 2.0;
const workDir = mkdtempSync(join(tmpdir(), "sim-5sites-"));
const logDir = "./logs/live-5-sites";
rmSync(logDir, { recursive: true, force: true });

const fmt = (ms) => `${(ms / 1000).toFixed(0)}s`;

async function main() {
  console.log("================================================================================");
  console.log(`🚀 LIVE 5-SITE ${quick ? "SPEED" : "PRE-CHECKOUT CHOREOGRAPHY"} BENCHMARK — ${durationMinutes} min visits, ATC at ${atcMinutes} min${useBitBrowser ? " — BitBrowser kernel" : ""}`);
  console.log("   (no shop.app cookies, no AI cookies: Tier 0/1 detection + local fallback only)");
  console.log("================================================================================");

  const config = loadConfig(undefined, {
    storefront: "",
    browser: {
      ...DEFAULT_CONFIG.browser,
      headless: true,
      profileDir: join(workDir, "profiles"),
      ...(useBitBrowser ? { bitbrowser: { ...DEFAULT_CONFIG.browser.bitbrowser, coreVersion: process.env.BITBROWSER_CORE ?? "148" } } : {}),
    },
    ai: {
      cookiesDir: join(workDir, "empty-cookies"),
      recipeCachePath: warm ? "./data/domain-recipes.json" : join(workDir, "domain-recipes.json"),
    },
    safety: { ...DEFAULT_CONFIG.safety, allowCart: true },
    behavior: {
      ...DEFAULT_CONFIG.behavior,
      pageEngagementMs: quick ? { min: 4_000, max: 7_000 } : { min: 6_000, max: 10_000 },
      actionPause: { min: 400, max: 900 },
    },
    // The last run's per-session JSONL stays in ./logs/live-5-sites for post-mortems.
    logging: { dir: logDir, level: "debug", jsonl: true, console: process.argv.includes("--verbose") },
  });

  const orchestrator = new Orchestrator(config);
  const profiles = FIVE_SITES.map((s) =>
    orchestrator.store.create({
      name: s.name,
      storefront: s.url,
      durationMinutes,
      atcMinutes,
      ...(useBitBrowser ? { browserProvider: "bitbrowser" } : {}),
    }),
  );

  const t0 = Date.now();
  console.log(`\n[+] Launching 5 concurrent sessions...`);
  await Promise.all(
    profiles.map((p) => orchestrator.startProfile(p.id).catch((err) => console.error(`[!] Failed to start ${p.name}: ${err.message}`))),
  );
  console.log(`[+] All 5 launched in ${((Date.now() - t0) / 1000).toFixed(2)}s\n`);

  const firstVerifiedAt = new Map();
  const hardStop = t0 + durationMinutes * 60_000 + 120_000;
  while (Date.now() < hardStop) {
    await sleep(10_000);
    const snap = orchestrator.snapshot();
    console.log(`--- [T+${fmt(Date.now() - t0)}] ---`);
    for (const v of snap) {
      const s = v.session;
      if (!s) { console.log(`  [${v.profile.name.padEnd(15)}] IDLE`); continue; }
      if (s.atcVerified && !firstVerifiedAt.has(v.profile.name)) firstVerifiedAt.set(v.profile.name, s.elapsedMs);
      const path = s.url ? (() => { try { return new URL(s.url).pathname.slice(0, 40); } catch { return s.url.slice(0, 40); } })() : "-";
      console.log(
        `  [${v.profile.name.padEnd(15)}] ${s.status.padEnd(9)} ${String(s.choreographyPhase ?? "-").padEnd(14)} pages=${String(s.pagesVisited).padStart(2)} prods=${String(s.productsViewed).padStart(2)} last=${String(s.lastAction ?? "-").padEnd(16)} atc=${s.atcVerified ? "✅" : s.atcPerformed ? "…" : "❌"} ${path}`,
      );
    }
    if (snap.every((v) => !v.session || ["lingering", "finished", "error", "blocked"].includes(v.session.status))) break;
  }

  console.log("\n================================================================================");
  console.log("📊 FINAL SUMMARY");
  console.log("================================================================================");
  let verified = 0;
  for (const v of orchestrator.snapshot()) {
    const s = v.session;
    if (!s) { console.log(`  • ${v.profile.name}: no session`); continue; }
    if (s.atcVerified) verified++;
    const stats = s.viewStats ?? {};
    const tiers = s.detectionTiers ?? {};
    let finalPath = "-";
    try { finalPath = new URL(s.url).pathname; } catch {}
    console.log(
      `  • ${v.profile.name.padEnd(16)} ATC ${s.atcVerified ? "VERIFIED" : "missing "} (tier${s.atcTier ?? "-"}, at ${firstVerifiedAt.has(v.profile.name) ? fmt(firstVerifiedAt.get(v.profile.name)) : "-"}) | pages ${s.pagesVisited} | products ${s.productsViewed} | engine ${s.engine} | ends on ${finalPath}`,
    );
    console.log(
      `      view: click_through=${stats.click_through ?? 0} goto_direct=${stats.goto_direct ?? 0} hover_card=${stats.hover_card ?? 0} view_media=${stats.view_media ?? 0} read_section=${stats.read_section ?? 0} select_text=${stats.select_text ?? 0} explore_variants=${stats.explore_variants ?? 0} go_back=${stats.go_back ?? 0} inspect_cart=${stats.inspect_cart ?? 0} | tiers t0=${tiers.tier0 ?? 0} t1=${tiers.tier1 ?? 0} t2=${tiers.tier2 ?? 0} local=${tiers.local ?? 0}`,
    );
    // Steps that ran long are marked [took Ns] so stalls show up without opening the logs.
    const trail = (s.viewTimeline ?? [])
      .map((e) => `${fmt(e.atMs)} ${e.action}${e.detail ? `(${e.detail})` : ""}${e.tookMs > 15_000 ? ` [took ${fmt(e.tookMs)}]` : ""}`)
      .join(" → ");
    console.log(`      trail: ${trail}`);
  }
  console.log(`\n  RESULT: ${verified}/5 verified add-to-cart`);

  const closeStart = Date.now();
  // Deleting the profiles also removes any BitBrowser profiles this run created.
  for (const p of profiles) await orchestrator.deleteProfile(p.id).catch(() => undefined);
  await orchestrator.shutdown();
  console.log(`[+] Closed all 5 browsers in ${((Date.now() - closeStart) / 1000).toFixed(2)}s`);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  process.exit(verified === 5 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
