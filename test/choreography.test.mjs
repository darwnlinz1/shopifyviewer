/**
 * Elastic pre-checkout choreography.
 *
 *   1. The time plan scales to the add-to-cart mark (pure).
 *   2. The behaviour engine walks the plan in order — discovery, compare
 *      with Back, deep product page, variants inside the lead window, the add
 *      on its mark, the cart review, parking on the cart (fake clock, no browser).
 *   3. A real session on the mock storefront leaves that trail on the wire:
 *      clicked links with a Referer, gallery/details/variant interaction, a
 *      verified add of an in-stock variant, the cart left ready for checkout.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planChoreography } from "../dist/behavior/choreography.js";
import { AiBehaviorEngine } from "../dist/behavior/aiEngine.js";
import { loadConfig } from "../dist/config.js";
import { startSession } from "../dist/session/aiManager.js";
import { Logger } from "../dist/logging/logger.js";
import { Rng } from "../dist/util/random.js";
import { startMockStorefront } from "./mockStorefront.mjs";

function findChromium() {
  return [
    process.env.CHROMIUM_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean).find((p) => existsSync(p)) ?? null;
}
const executablePath = findChromium();
const skip = executablePath ? false : "no Chromium available";

let workDir;
let shop;
before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "sim-choreo-"));
  if (!skip) shop = await startMockStorefront(0);
});
after(async () => {
  await shop?.close();
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
});

const quiet = () => new Logger("choreo-test", { dir: join(workDir, "logs"), level: "error", jsonl: false, console: false });

// ───────────────────────────── 1. plan ─────────────────────────────

test("the plan scales every phase to the add-to-cart mark", () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const atc of [24_000, 90_000, 150_000, 360_000, 600_000]) {
      const p = planChoreography({ targetAtcMs: atc, rng: new Rng(seed) });
      assert.equal(p.enabled, true);
      assert.ok(p.discoveryEndMs > 0 && p.discoveryEndMs <= p.deepStartMs && p.deepStartMs < p.targetAtcMs, `phases out of order for ${atc}`);
      assert.equal(p.discoveryEndMs, Math.round(atc * 0.2), "discovery is the first 20%");
      assert.ok(p.deepPhaseMs <= 180_000 && p.deepPhaseMs <= Math.round(atc * 0.45) + 1, "deep phase is the last 45%, capped");
      assert.ok(p.exploreLeadMs <= 40_000 && p.exploreLeadMs < p.deepPhaseMs, "variant exploration fits inside the deep phase");
      assert.ok(p.inspectCartMs >= 5_000 && p.inspectCartMs <= 12_000);
      assert.ok(p.mediaTarget >= 2 && p.mediaTarget <= 5);
      assert.equal(p.compareEnabled, atc >= 120_000, "compare only when the mark is at least 2 minutes in");
      if (p.compareEnabled) {
        assert.ok(p.compareTarget >= 1 && p.compareTarget <= 3);
        assert.ok(p.compareDwellMs >= 6_000 && p.compareDwellMs <= 25_000);
      }
      if (atc >= 120_000) assert.ok(p.exploreLeadMs >= 15_000, "a long deep phase keeps the full 15–40 s lead");
    }
  }
  const tenMinutes = planChoreography({ targetAtcMs: 600_000, rng: new Rng(5) });
  assert.equal(tenMinutes.deepStartMs, 420_000, "a 10-minute mark caps the deep phase at 3 minutes");
  assert.equal(tenMinutes.compareTarget, 3);
  assert.equal(planChoreography({ targetAtcMs: Number.MAX_SAFE_INTEGER, rng: new Rng(1) }).enabled, false);
});

// ───────────────────────────── 2. engine (fake clock) ─────────────────────────────

const SHOP = "https://shop.example";
const PRODUCTS = Array.from({ length: 8 }, (_, i) => `/products/p${i + 1}`);
const digestFor = (path) => {
  if (path === "/") return ["TITLE=Home", "LINKS:", "/collections/all | All", "/collections/new | New", ...PRODUCTS.slice(0, 3).map((p) => `${p} | ${p}`)].join("\n");
  if (path.startsWith("/collections")) return ["TITLE=All", "LINKS:", ...PRODUCTS.map((p) => `${p} | ${p} | ctx:card`), "/collections/new | New"].join("\n");
  if (path.startsWith("/products/")) {
    return [`TITLE=${path}`, "LINKS:", ...PRODUCTS.filter((p) => p !== path).slice(0, 4).map((p) => `${p} | ${p}`), "CONTROLS:", "button | Add to cart | name=add form:/cart/add"].join("\n");
  }
  return ["TITLE=Cart", "LINKS:", "/collections/all | All"].join("\n");
};
const fakeDetector = {
  async detect(url) {
    const path = new URL(url).pathname;
    const listed = digestFor(path).split("\n").filter((l) => l.startsWith("/products/")).map((l) => l.split(" | ")[0]);
    return {
      url,
      products: listed.map((u) => ({ url: u, text: u, selector: "" })),
      addToCart: path.startsWith("/products/") ? { selector: 'button[name="add"]', text: "Add to cart" } : null,
      accountSource: "fake",
      elapsedMs: 1,
      cached: false,
    };
  },
};
const featuresFor = (path) =>
  path.startsWith("/products/")
    ? { pageType: "product", galleryCount: 4, sectionCount: 3, variantGroupCount: 2, productCardCount: 4, soldOut: false, inStockVariants: 4, tier: 1, confidence: 0.95 }
    : { pageType: path === "/" ? "home" : "collection", galleryCount: 0, sectionCount: 0, variantGroupCount: 0, productCardCount: 8, soldOut: false, inStockVariants: -1, tier: 1, confidence: 0.3 };

function fakeTimer(plannedDurationMs) {
  return {
    now: 0,
    plannedDurationMs,
    elapsedMs() { return this.now; },
    remainingMs() { return Math.max(0, this.plannedDurationMs - this.now); },
    isExpired() { return this.now >= this.plannedDurationMs; },
    isHardExpired() { return this.now >= this.plannedDurationMs + 60_000; },
    progress() { return this.now / this.plannedDurationMs; },
  };
}

async function simulate({ atcMs, durationMs, seed, allowCart = true }) {
  const base = loadConfig(undefined, {
    storefront: SHOP,
    safety: { allowedHosts: ["shop.example"], allowCart, blockedPathFragments: [] },
    behavior: { ...loadConfig().behavior, pageEngagementMs: { min: 6_000, max: 9_000 } },
  });
  const engine = new AiBehaviorEngine({ ...base, ai: { advanceActionTimeMs: allowCart ? atcMs : Number.MAX_SAFE_INTEGER } }, new Rng(seed), quiet(), "browser");
  const timer = fakeTimer(durationMs);
  let url = `${SHOP}/`;
  const history = [];
  const trace = [];
  for (let i = 0; i < 600; i++) {
    const path = new URL(url).pathname;
    engine.notePageFeatures(url, featuresFor(path));
    const d = await engine.decide(fakeDetector, url, digestFor(path), timer);
    trace.push({ t: timer.now, remaining: timer.remainingMs(), action: d.action, phase: d.phase, state: engine.state.currentState, path, target: d.url, maxMs: d.maxMs, park: d.park, count: d.count });
    if (d.action === "exit") break;
    let performed = 1;
    let variantId = null;
    let cost = 2_000;
    switch (d.action) {
      case "goto_product":
      case "goto_collection":
      case "goto_home":
        history.push(url);
        url = d.url.startsWith("http") ? d.url : SHOP + d.url;
        cost = 2_500;
        break;
      case "go_back":
        url = history.pop() ?? `${SHOP}/collections/all`;
        break;
      case "view_media":
        performed = d.count ?? 2;
        cost = Math.min(d.maxMs ?? 9_000, performed * 1_800);
        break;
      case "read_section":
        cost = Math.min(d.maxMs ?? 9_000, 5_000);
        break;
      case "select_text":
        cost = 1_500;
        break;
      case "explore_variants":
        variantId = `v${i}`;
        cost = Math.min(d.maxMs ?? 9_000, 4_000);
        break;
      case "hover_card":
        performed = d.count ?? 1;
        break;
      case "inspect_cart":
        cost = d.maxMs ?? 8_000;
        if (d.park) { history.push(url); url = `${SHOP}/cart`; }
        break;
      case "add_to_cart":
        cost = 6_000;
        break;
      case "scroll":
        cost = Math.min(d.maxMs ?? 3_500, 3_500);
        break;
      case "dwell":
        cost = Math.min(d.maxMs ?? 2_500, 2_500);
        break;
    }
    engine.noteActionResult(d, { performed, variantId });
    if (d.action === "add_to_cart") engine.notifyAtcResult(true, { url });
    timer.now += cost + 800;
    if (timer.isExpired()) break;
  }
  return { trace, engine, plan: engine.choreographyPlan, finalUrl: url };
}

test("engine walks discovery → compare (Back) → deep PDP → add on the mark → cart review → checkout-ready", async () => {
  for (const seed of [3, 11, 29]) {
    const { trace, plan, finalUrl } = await simulate({ atcMs: 150_000, durationMs: 240_000, seed });
    assert.equal(plan.compareEnabled, true);

    const firstNav = trace.find((s) => s.action.startsWith("goto_"));
    assert.equal(firstNav.action, "goto_collection", "home → category first");
    assert.equal(firstNav.path, "/");

    const compareSteps = trace.filter((s) => s.state === "COMPARE_PRODUCTS");
    assert.ok(compareSteps.length > 0, "a compare phase must happen when the mark is ≥ 2 min");
    assert.ok(compareSteps[0].t >= plan.discoveryEndMs, "compare starts after discovery");
    const backIdx = trace.findIndex((s) => s.action === "go_back" && s.phase === "compare");
    assert.ok(backIdx > 0, "product A is left with Back");
    assert.ok(trace[backIdx].t < plan.deepStartMs + 15_000, "Back happens in the compare window");
    const productA = trace[backIdx].path;
    assert.ok(trace.some((s, i) => i < backIdx && s.path === productA && s.action === "view_media"), "product A's gallery is looked at before Back");

    const addIdx = trace.findIndex((s) => s.action === "add_to_cart");
    assert.ok(addIdx > backIdx, "the add comes after the comparison");
    const add = trace[addIdx];
    assert.ok(add.t >= plan.targetAtcMs, "the add never fires early");
    assert.ok(add.t - plan.targetAtcMs < 15_000, `the add lands near its mark (${add.t - plan.targetAtcMs}ms late)`);

    const onBuyPage = trace.filter((s, i) => i < addIdx && s.path === add.path && s.state === "ENGAGE_PRODUCT");
    assert.ok(onBuyPage.some((s) => s.action === "view_media"), "deep PDP: gallery");
    assert.ok(onBuyPage.some((s) => s.action === "read_section"), "deep PDP: details");
    const explore = onBuyPage.filter((s) => s.action === "explore_variants");
    assert.ok(explore.length >= 1, "deep PDP: variants tried before deciding");
    for (const e of explore) assert.ok(e.t >= plan.targetAtcMs - plan.exploreLeadMs - 1, "variants are tried inside the lead window, not earlier");

    const review = trace[addIdx + 1];
    assert.equal(review.action, "inspect_cart", "the cart is reviewed right after the add");
    assert.ok(review.maxMs >= 5_000 && review.maxMs <= 12_000);

    const park = trace.find((s) => s.action === "inspect_cart" && s.park);
    assert.ok(park, "the visit parks on the cart before it ends");
    assert.ok(park.remaining <= 20_000);
    const afterPark = trace.filter((s) => s.t > park.t && s.path === "/cart");
    assert.ok(afterPark.length > 0 && afterPark.every((s) => s.action === "dwell" && s.phase === "checkout_ready"), "parked: the cart stays put");
    assert.equal(new URL(finalUrl).pathname, "/cart", "the visit ends on the cart, ready for checkout");
  }
});

test("a short mark skips comparison but keeps the order, and no cart means plain browsing", async () => {
  const short = await simulate({ atcMs: 24_000, durationMs: 90_000, seed: 7 });
  assert.equal(short.plan.compareEnabled, false);
  assert.ok(!short.trace.some((s) => s.state === "COMPARE_PRODUCTS"));
  const addIdx = short.trace.findIndex((s) => s.action === "add_to_cart");
  assert.ok(addIdx > 0 && short.trace[addIdx].t >= short.plan.targetAtcMs);
  assert.equal(short.trace[addIdx + 1].action, "inspect_cart");

  const browseOnly = await simulate({ atcMs: 24_000, durationMs: 60_000, seed: 7, allowCart: false });
  assert.equal(browseOnly.plan.enabled, false);
  assert.ok(!browseOnly.trace.some((s) => s.action === "add_to_cart" || s.action === "inspect_cart"));
  assert.ok(browseOnly.trace.some((s) => s.action.startsWith("goto_")), "it still browses");
});

// ───────────────────────────── 3. live session on the mock store ─────────────────────────────

test("a real session leaves the full pre-checkout trail and a verified, in-stock cart", { skip, timeout: 200_000 }, async () => {
  const recipePath = join(workDir, "recipes.json");
  const config = loadConfig(undefined, {
    storefront: shop.url,
    seed: 4242,
    browser: { headless: true, executablePath, profileDir: join(workDir, "profiles") },
    // The deep window must hold a photo look, a read and two size/colour tries
    // even when the suite's other browsers slow every step down.
    session: { durationMs: 100_000, durationJitterMs: 0, hardTimeoutMs: 180_000, navigationTimeoutMs: 15_000 },
    logging: { dir: join(workDir, "logs"), console: false, jsonl: false },
    ai: { cookiesDir: join(workDir, "no-cookies"), advanceActionTimeMs: 62_000, recipeCachePath: recipePath },
    behavior: {
      ...loadConfig().behavior,
      pageEngagementMs: { min: 3_000, max: 5_000 },
      actionPause: { min: 300, max: 700 },
      choreography: {
        compareMinAtcMs: 30_000,
        deepPhaseMaxMs: 30_000,
        exploreVariantsLeadMs: { min: 6_000, max: 9_000 },
        mediaDwellMs: { min: 600, max: 1_000 },
        inspectCartMs: { min: 5_000, max: 6_000 },
        checkoutReadyLeadMs: 14_000,
      },
    },
  });
  const requestsBefore = shop.requests.length;
  const handle = await startSession({ slot: 7, sessionId: "choreo-live", config, lingerMs: -1 });
  try {
    const deadline = Date.now() + 160_000;
    while (handle.snapshot().status !== "lingering" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const snap = handle.snapshot();
    const stats = snap.viewStats ?? {};
    const names = (snap.viewTimeline ?? []).map((e) => e.action);
    const story = (snap.viewTimeline ?? []).map((e) => `${Math.round(e.atMs / 1000)}s ${e.phase}:${e.action}`).join(" | ");

    assert.equal(snap.status, "lingering", `session should finish and hold the browser (${snap.status})`);
    assert.equal(snap.atcVerified, true, `add-to-cart must be verified. trail: ${story}`);
    assert.ok(snap.atcTier === 0 || snap.atcTier === 1, `the add must come from Tier 0/1, not the AI (tier ${snap.atcTier})`);
    assert.equal(snap.detectionTiers.tier2, 0, "no AI escalation needed on a well-formed shop");

    assert.ok((stats.click_through ?? 0) >= 2, `links are clicked, not typed (${JSON.stringify(stats)})`);
    assert.ok((stats.view_media ?? 0) >= 2, `gallery viewed (${JSON.stringify(stats)})`);
    assert.ok((stats.read_section ?? 0) >= 1, `details read (${JSON.stringify(stats)})`);
    assert.ok((stats.explore_variants ?? 0) >= 1, `variants explored (${JSON.stringify(stats)})`);
    assert.ok((stats.go_back ?? 0) >= 1, `compare used Back (${JSON.stringify(stats)})`);
    assert.ok((stats.inspect_cart ?? 0) >= 1, `cart reviewed (${JSON.stringify(stats)})`);

    const addAt = names.indexOf("add_to_cart");
    assert.ok(addAt > 0, story);
    assert.ok(names.indexOf("go_back") < addAt, `compare happens before the add: ${story}`);
    assert.ok(names.lastIndexOf("explore_variants") < addAt && names.lastIndexOf("explore_variants") >= 0, `variants before the add: ${story}`);
    assert.ok(names.indexOf("inspect_cart", addAt) > addAt, `cart review after the add: ${story}`);

    // What the server saw: product pages opened by clicking a link on the shop
    // (page.goto sends no Referer), and a real cart add.
    const seen = shop.requests.slice(requestsBefore);
    const pdpViews = seen.filter((r) => r.method === "GET" && r.path.startsWith("/products/") && !r.path.endsWith(".js"));
    assert.ok(pdpViews.length >= 2, "several product pages should be opened");
    assert.ok(pdpViews.some((r) => (r.referer ?? "").startsWith(shop.url)), "product pages must be reached by a click that carries the shop as Referer");
    assert.ok(seen.some((r) => r.method === "POST" && r.path.startsWith("/cart/add")), "a /cart/add POST must reach the shop");

    // The cart holds an in-stock variant and is left intact for checkout.
    const cart = await handle.page.evaluate(() => fetch("/cart.js").then((r) => r.json()));
    assert.ok(cart.item_count >= 1, "the cart must not be emptied");
    for (const line of cart.items) {
      const product = shop.products.find((p) => p.variants.some((v) => v.id === line.variant_id));
      const variant = product.variants.find((v) => v.id === line.variant_id);
      assert.equal(variant.available, true, `only in-stock variants may be added (${line.variant_title})`);
    }
    if (snap.personality === "browser" || snap.personality === "browser_fast") {
      assert.match(new URL(handle.page.url()).pathname, /\/cart$/, "the visit ends parked on the cart");
    }

    // Tier 0 learned the shop for its next ten thousand product pages.
    const recipes = JSON.parse(readFileSync(recipePath, "utf8")).recipes;
    const pdpRecipe = recipes.find((r) => r.hostname === "127.0.0.1" && r.pageType === "product");
    assert.ok(pdpRecipe?.addToCart, "the verified buy-box selector is stored for the domain");
    assert.ok(pdpRecipe.hits >= 1);
  } finally {
    await handle.close();
  }
});
