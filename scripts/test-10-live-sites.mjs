/**
 * 10 concurrent BitBrowser sessions on 10 Shopify shops, each with its own
 * visit length and add-to-cart mark.
 *
 *   node scripts/test-10-live-sites.mjs
 *
 * Opens are started one after another so BitBrowser's Local API is not burst.
 * Temporary BitBrowser profiles are deleted with the SiteViewer profiles.
 * Exit 0 when every shop that stayed up verified an add-to-cart is reported;
 * the summary is the deliverable either way.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../dist/server/orchestrator.js";
import { loadConfig, DEFAULT_CONFIG } from "../dist/config.js";
import { checkBitBrowserHealth } from "../dist/browser/bitbrowser.js";
import { sleep } from "../dist/util/random.js";

const retry4 = process.argv.includes("--retry4");
const cartjs = process.argv.includes("--cartjs");
const headless4 = process.argv.includes("--headless4");
const mixed4 = process.argv.includes("--mixed4");
const path4 = process.argv.includes("--path4");
const size4 = process.argv.includes("--size4");
const wave5 = process.argv.includes("--wave5");
const wave6 = process.argv.includes("--wave6");
const wave7 = process.argv.includes("--wave7");
const SHOPS = wave7
  ? [
      { name: "Thursday", url: "https://thursdayboots.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Kith", url: "https://kith.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Cluse", url: "https://cluse.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Keychron", url: "https://www.keychron.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : wave6
  ? [
      { name: "DeathWish", url: "https://www.deathwishcoffee.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "PuraVida", url: "https://www.puravidabracelets.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Olaplex", url: "https://olaplex.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Chamberlain", url: "https://chamberlaincoffee.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : wave5
  ? [
      { name: "BlueBottle", url: "https://bluebottlecoffee.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "QuadLock", url: "https://www.quadlockcase.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Nomad", url: "https://nomadgoods.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Thursday", url: "https://thursdayboots.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : size4
  ? [
      { name: "FashionNova", url: "https://www.fashionnova.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "DrunkElephant", url: "https://www.drunkelephant.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "BlueBottle", url: "https://bluebottlecoffee.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Vessi", url: "https://vessi.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : path4
  ? [
      { name: "DrunkElephant", url: "https://www.drunkelephant.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "BlueBottle", url: "https://bluebottlecoffee.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "FashionNova", url: "https://www.fashionnova.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "OurPlace", url: "https://fromourplace.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : mixed4
  ? [
      { name: "Alo", url: "https://www.aloyoga.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "DrunkElephant", url: "https://www.drunkelephant.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Huel", url: "https://huel.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "BlueBottle", url: "https://bluebottlecoffee.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : headless4
  ? [
      { name: "Mejuri", url: "https://mejuri.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Gymshark", url: "https://www.gymshark.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Vuori", url: "https://vuoriclothing.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Glossier", url: "https://www.glossier.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : cartjs
  ? [
      { name: "Rumpl", url: "https://www.rumpl.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Fenty", url: "https://fentybeauty.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Ritual", url: "https://ritual.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Ridge", url: "https://ridge.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : retry4
  ? [
      { name: "Mejuri", url: "https://mejuri.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Chubbies", url: "https://www.chubbiesshorts.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "Brooklinen", url: "https://www.brooklinen.com", durationMinutes: 3.2, atcMinutes: 2 },
      { name: "OutdoorVoices", url: "https://www.outdoorvoices.com", durationMinutes: 3.2, atcMinutes: 2 },
    ]
  : [
  { name: "Allbirds", url: "https://www.allbirds.com", durationMinutes: 1.5, atcMinutes: 0.6 },
  { name: "ColourPop", url: "https://colourpop.com", durationMinutes: 2, atcMinutes: 0.8 },
  { name: "MVMT", url: "https://www.mvmt.com", durationMinutes: 2.5, atcMinutes: 1.0 },
  { name: "Mejuri", url: "https://mejuri.com", durationMinutes: 3, atcMinutes: 1.4 },
  { name: "Cotopaxi", url: "https://www.cotopaxi.com", durationMinutes: 3.5, atcMinutes: 2.0 },
  { name: "Chubbies", url: "https://www.chubbiesshorts.com", durationMinutes: 4, atcMinutes: 2.2 },
  { name: "MagicSpoon", url: "https://magicspoon.com", durationMinutes: 5, atcMinutes: 2.5 },
  { name: "Olipop", url: "https://drinkolipop.com", durationMinutes: 6, atcMinutes: 3.0 },
  { name: "Brooklinen", url: "https://www.brooklinen.com", durationMinutes: 7, atcMinutes: 3.5 },
  { name: "OutdoorVoices", url: "https://www.outdoorvoices.com", durationMinutes: 8, atcMinutes: 4.0 },
];

const workDir = mkdtempSync(join(tmpdir(), "sim-10sites-"));
const logDir = wave7 ? "./logs/live-4-wave7" : wave6 ? "./logs/live-4-wave6" : wave5 ? "./logs/live-4-wave5" : size4 ? "./logs/live-4-size" : path4 ? "./logs/live-4-path" : mixed4 ? "./logs/live-4-mixed" : headless4 ? "./logs/live-4-headless" : cartjs ? "./logs/live-4-cartjs" : retry4 ? "./logs/live-4-sites" : "./logs/live-10-sites";
rmSync(logDir, { recursive: true, force: true });
const maxDuration = Math.max(...SHOPS.map((s) => s.durationMinutes));
const fmt = (ms) => `${(ms / 1000).toFixed(0)}s`;

function plansFromLogs() {
  const plans = new Map();
  let files = [];
  try { files = readdirSync(logDir); } catch { return plans; }
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const text = readFileSync(join(logDir, file), "utf8");
    let name = "";
    let plan = "";
    for (const line of text.split(/\n/)) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.event === "session_start" && row.data?.profile) name = row.data.profile;
      if (row.event === "choreography_plan") plan = row.msg;
      if (row.event === "session_end" && name) plans.set(name, { plan, end: row.msg });
    }
    if (name && !plans.has(name)) plans.set(name, { plan, end: "" });
  }
  return plans;
}

async function main() {
  console.log("================================================================================");
  console.log("LIVE 10-SHOP BITBROWSER WORKFLOW — distinct durations, core 148");
  console.log("   no shop.app cookies, no AI cookies");
  for (const s of SHOPS) {
    console.log(`   ${s.name.padEnd(16)} ${s.durationMinutes} min visit, ATC at ${s.atcMinutes} min (${s.atcMinutes >= 2 ? "compare on" : "compare off"})`);
  }
  console.log("================================================================================");

  const config = loadConfig(undefined, {
    storefront: "",
    browser: {
      ...DEFAULT_CONFIG.browser,
      headless: true,
      profileDir: join(workDir, "profiles"),
      bitbrowser: { ...DEFAULT_CONFIG.browser.bitbrowser, coreVersion: process.env.BITBROWSER_CORE ?? "148" },
    },
    ai: {
      cookiesDir: join(workDir, "empty-cookies"),
      recipeCachePath: join(workDir, "domain-recipes.json"),
    },
    safety: { ...DEFAULT_CONFIG.safety, allowCart: true },
    behavior: {
      ...DEFAULT_CONFIG.behavior,
      pageEngagementMs: { min: 4_000, max: 8_000 },
      actionPause: { min: 400, max: 900 },
    },
    logging: { dir: logDir, level: "debug", jsonl: true, console: false },
  });

  const orchestrator = new Orchestrator(config);
  const bitHealth = await checkBitBrowserHealth(config.browser.bitbrowser);
  if (!bitHealth.ok) {
    console.error(`[!] BitBrowser not ready: ${bitHealth.error}`);
    console.error("    Sign in to the BitBrowser client, then run this batch again.");
    process.exit(1);
  }
  const profiles = SHOPS.map((s) =>
    orchestrator.store.create({
      name: s.name,
      storefront: s.url,
      durationMinutes: s.durationMinutes,
      atcMinutes: s.atcMinutes,
      browserProvider: "bitbrowser",
    }),
  );

  const t0 = Date.now();
  const maxOpen = Math.max(1, Number(process.env.BITBROWSER_MAX_OPEN || 2));
  const pending = [...profiles];
  const remembered = new Map();
  const released = new Set();
  console.log(`\n[+] Opening at most ${maxOpen} BitBrowser windows at a time...`);

  async function releaseFinished() {
    for (const v of orchestrator.snapshot()) {
      if (v.session) remembered.set(v.profile.id, v);
      const status = v.session?.status;
      if (!status || released.has(v.profile.id)) continue;
      if (!["lingering", "finished", "error", "blocked"].includes(status)) continue;
      released.add(v.profile.id);
      await orchestrator.closeSession(v.profile.id).catch((err) => {
        console.error(`[!] Close ${v.profile.name}: ${err instanceof Error ? err.message : err}`);
      });
      console.log(`[+] ${v.profile.name} window closed (${status})`);
    }
  }

  async function openNext() {
    const snap = orchestrator.snapshot();
    let running = snap.filter((v) => v.session && !released.has(v.profile.id) && !["lingering", "finished", "error", "blocked"].includes(v.session.status)).length;
    while (pending.length && running < maxOpen) {
      const p = pending.shift();
      const started = Date.now();
      try {
        await orchestrator.startProfile(p.id);
        running++;
        console.log(`[+] ${p.name} up in ${((Date.now() - started) / 1000).toFixed(1)}s (${running}/${maxOpen} windows)`);
      } catch (err) {
        console.error(`[!] Failed to start ${p.name}: ${err instanceof Error ? err.message : err}`);
        released.add(p.id);
      }
    }
  }

  await openNext();
  console.log(`[+] First windows opened in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const firstVerifiedAt = new Map();
  const waves = Math.ceil(SHOPS.length / maxOpen);
  const hardStop = Date.now() + waves * maxDuration * 60_000 + 180_000;
  while (Date.now() < hardStop) {
    await sleep(15_000);
    await releaseFinished();
    await openNext();
    const snap = orchestrator.snapshot();
    console.log(`--- [T+${fmt(Date.now() - t0)}] ---`);
    for (const v of snap) {
      const s = v.session;
      const spec = SHOPS.find((x) => x.name === v.profile.name);
      if (v.session) remembered.set(v.profile.id, v);
    if (!s) { console.log(`  [${v.profile.name.padEnd(16)}] ${released.has(v.profile.id) ? "CLOSED" : "IDLE"}`); continue; }
      if (s.atcVerified && !firstVerifiedAt.has(v.profile.name)) firstVerifiedAt.set(v.profile.name, s.elapsedMs);
      const path = s.url ? (() => { try { return new URL(s.url).pathname.slice(0, 42); } catch { return s.url.slice(0, 42); } })() : "-";
      console.log(
        `  [${v.profile.name.padEnd(16)}] ${s.status.padEnd(9)} ${String(s.choreographyPhase ?? "-").padEnd(14)} ${spec ? spec.durationMinutes + "m" : ""} pages=${String(s.pagesVisited).padStart(2)} last=${String(s.lastAction ?? "-").padEnd(16)} atc=${s.atcVerified ? "YES" : "no"} engine=${s.engine ?? "-"} ${path}`,
      );
    }
    const live = snap.filter((v) => v.session && !["lingering", "finished", "error", "blocked"].includes(v.session.status));
    if (pending.length === 0 && live.length === 0) break;
  }

  const plans = plansFromLogs();
  console.log("\n================================================================================");
  console.log("FINAL SUMMARY");
  console.log("================================================================================");
  let verified = 0;
  let up = 0;
  for (const p of profiles) {
    const v = remembered.get(p.id) ?? orchestrator.snapshot().find((row) => row.profile.id === p.id);
    const s = v?.session;
    const spec = SHOPS.find((x) => x.name === p.name);
    const meta = plans.get(p.name);
    if (!s) {
      console.log(`  • ${p.name}: no session | configured ${spec?.durationMinutes}m ATC ${spec?.atcMinutes}m`);
      if (meta?.plan) console.log(`      plan: ${meta.plan}`);
      if (meta?.end) console.log(`      end: ${meta.end}`);
      continue;
    }
    up++;
    if (s.atcVerified) verified++;
    const stats = s.viewStats ?? {};
    let finalPath = "-";
    try { finalPath = new URL(s.url).pathname; } catch {}
    console.log(
      `  • ${p.name.padEnd(16)} ${spec?.durationMinutes}m visit, ATC mark ${spec?.atcMinutes}m | ATC ${s.atcVerified ? "VERIFIED" : "missing"} (tier${s.atcTier ?? "-"}, at ${firstVerifiedAt.has(p.name) ? fmt(firstVerifiedAt.get(p.name)) : "-"}) | pages ${s.pagesVisited} | products ${s.productsViewed} | engine ${s.engine} | ends ${finalPath}`,
    );
    if (meta?.plan) console.log(`      plan: ${meta.plan}`);
    console.log(
      `      view: click_through=${stats.click_through ?? 0} goto_direct=${stats.goto_direct ?? 0} hover_card=${stats.hover_card ?? 0} view_media=${stats.view_media ?? 0} read_section=${stats.read_section ?? 0} select_text=${stats.select_text ?? 0} explore_variants=${stats.explore_variants ?? 0} go_back=${stats.go_back ?? 0} inspect_cart=${stats.inspect_cart ?? 0}`,
    );
    const trail = (s.viewTimeline ?? [])
      .map((e) => `${fmt(e.atMs)} ${e.action}${e.detail ? `(${e.detail})` : ""}`)
      .join(" → ");
    console.log(`      trail: ${trail}`);
  }
  console.log(`\n  RESULT: ${verified}/${SHOPS.length} verified add-to-cart (${up} sessions still attached at summary)`);

  const closeStart = Date.now();
  for (const p of profiles) await orchestrator.deleteProfile(p.id).catch(() => undefined);
  await orchestrator.shutdown();
  console.log(`[+] Closed browsers and deleted temporary profiles in ${((Date.now() - closeStart) / 1000).toFixed(2)}s`);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
