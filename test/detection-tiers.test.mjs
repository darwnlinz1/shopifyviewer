/**
 * Detection waterfall tiers.
 *
 *   Tier 0 — DomainRecipeCache: selectors per hostname + page type on disk.
 *   Tier 1 — multiSignalDetector: oracle + form contract + ARIA + geometry,
 *            scored in Node from a scan taken in the isolated utility world.
 *
 * Pure parts run everywhere; the live-page parts need Chromium and the mock
 * storefront, and skip without a binary.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "rebrowser-playwright";

import { DomainRecipeCache } from "../dist/ai/domainRecipeCache.js";
import {
  scoreBuyBox,
  parseProductOracle,
  planVariantSelection,
  detectMultiSignal,
  operableGroups,
  productJsPath,
} from "../dist/navigator/multiSignalDetector.js";
import { clickTarget, findTargets } from "../dist/behavior/humanActions.js";
import { readSection, viewMedia } from "../dist/behavior/pdpChoreography.js";
import { Pacing } from "../dist/behavior/timing.js";
import { DEFAULT_CHOREOGRAPHY, loadConfig } from "../dist/config.js";
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
let browser;

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "sim-tiers-"));
  if (skip) return;
  shop = await startMockStorefront(0);
  browser = await chromium.launch({ headless: true, executablePath });
});

after(async () => {
  await browser?.close();
  await shop?.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ───────────────────────────── Tier 0 ─────────────────────────────

test("Tier 0 keys recipes by hostname + page type, shared by www and bare host", () => {
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/"), "home");
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/collections/all"), "collection");
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/collections"), "collection");
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/products/tee"), "product");
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/collections/men/products/tee?variant=1"), "product");
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/en-us/products/tee"), "product");
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/cart"), "cart");
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/search?q=x"), "search");
  assert.equal(DomainRecipeCache.pageTypeOf("https://shop.example/pages/about"), "other");
  assert.equal(DomainRecipeCache.hostOf("https://WWW.Shop.Example/x"), "shop.example");

  const cache = new DomainRecipeCache(join(workDir, "keys.json"), { flushDelayMs: 10_000 });
  cache.learn("https://www.shop.example/products/first", "product", { addToCart: 'form[action*="/cart/add"] button[name="add"]' }, "tier1", 0.95);
  const hit = cache.get("https://shop.example/products/ten-thousandth");
  assert.equal(hit?.addToCart, 'form[action*="/cart/add"] button[name="add"]', "one learned PDP serves every PDP of the shop");
  assert.equal(cache.get("https://shop.example/collections/all"), undefined, "a product recipe is not a listing recipe");
  assert.equal(cache.get("https://other.example/products/first"), undefined);

  const started = performance.now();
  for (let i = 0; i < 10_000; i++) cache.get(`https://shop.example/products/p-${i}`);
  const perLookupMs = (performance.now() - started) / 10_000;
  assert.ok(perLookupMs < 1, `Tier 0 lookup must be < 1ms, got ${perLookupMs.toFixed(4)}ms`);
});

test("Tier 0 persists to JSON atomically and reloads on start", () => {
  const file = join(workDir, "data", "domain-recipes.json");
  const a = new DomainRecipeCache(file, { flushDelayMs: 10_000 });
  a.learn("https://shop.example/collections/all", "collection", { productCard: '.card-wrapper a[href*="/products/"]' }, "tier1", 0.9);
  a.learn("https://shop.example/products/x", "product", { addToCart: "#AddToCart", variantGroups: ["variant-radios fieldset"], cartDrawer: "cart-drawer" }, "ai", 0.85);
  a.flush();
  assert.ok(existsSync(file));
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.recipes.length, 2);

  const b = new DomainRecipeCache(file);
  assert.equal(b.get("https://shop.example/collections/sale")?.productCard, '.card-wrapper a[href*="/products/"]');
  const pdp = b.get("https://shop.example/products/y");
  assert.equal(pdp?.addToCart, "#AddToCart");
  assert.deepEqual(pdp?.variantGroups, ["variant-radios fieldset"]);
  assert.equal(pdp?.cartDrawer, "cart-drawer");
  assert.equal(pdp?.source, "ai");
});

test("Tier 0 self-heals: failing selectors are dropped, AI corrections win, proven selectors are not thrashed", () => {
  const cache = new DomainRecipeCache(join(workDir, "heal.json"), { flushDelayMs: 10_000, maxFieldFailures: 2 });
  const url = "https://heal.example/products/a";
  cache.learn(url, "product", { addToCart: "button.atc-old" }, "tier1", 0.9);
  cache.recordHit(url, "product", "addToCart");
  assert.equal(cache.get(url)?.hits, 1);

  cache.learn(url, "product", { addToCart: "button.weaker" }, "tier1", 0.82);
  assert.equal(cache.get(url)?.addToCart, "button.atc-old", "a weaker Tier 1 guess must not replace a proven selector");

  assert.equal(cache.recordFailure(url, "product", "addToCart"), false);
  cache.recordHit(url, "product", "addToCart");
  assert.equal(cache.recordFailure(url, "product", "addToCart"), false, "a success in between resets the streak");
  assert.equal(cache.recordFailure(url, "product", "addToCart"), true, "two failures in a row drop the field");
  assert.equal(cache.get(url)?.addToCart, undefined);

  cache.learn(url, "product", { addToCart: "button.tier1" }, "tier1", 0.9);
  cache.learn(url, "product", { addToCart: "button.ai-fix" }, "ai", 0.7);
  assert.equal(cache.get(url)?.addToCart, "button.ai-fix", "an AI correction replaces a Tier 1 selector");
  assert.equal(cache.get(url)?.source, "ai");
});

// ───────────────────────────── Tier 1 (pure) ─────────────────────────────

const baseControl = {
  general: null, tag: "button", type: "button", name: "", role: "", vis: true, disabled: false,
  inCartForm: false, formAttrCart: false, formHasIdInput: false, inProductForm: false, dataAtc: false, classHint: false,
  textAtc: false, textBuyNow: false, textPreorder: false, textSoldOut: false, checkoutish: false, isExpress: false,
  inHeader: false, inFooter: false, inRelated: false, inQuickAdd: false, inForeignCard: false, inDrawer: false,
  inSticky: false, inDialog: false, matchesRecipe: false,
};
const rawScan = (controls, extra = {}) => ({
  url: "https://shop.example/products/tee",
  path: "/products/tee",
  title: "Tee",
  viewport: { w: 1440, h: 900 },
  scrollY: 0,
  h1: { x: 800, y: 120, w: 420, h: 40, text: "Tee" },
  price: { x: 800, y: 175, w: 90, h: 22, text: "$29" },
  controls,
  variantGroups: [],
  selectedVariantId: null,
  oracle: { productJson: [], ldJson: [], analyticsMeta: null },
  productCards: { selector: null, count: 0, linkCount: 0 },
  gallery: null,
  sections: null,
  cartDrawer: null,
  scanMs: 1.2,
  ...extra,
});

test("Tier 1 scores the buy-box add-to-cart above sticky, quick-add, express, hidden and footer decoys", () => {
  const main = { ...baseControl, path: "#main-atc", general: 'form[action*="/cart/add"] button[name="add"]', text: "Add to cart", type: "submit", name: "add", inCartForm: true, inProductForm: true, formHasIdInput: true, textAtc: true, x: 800, y: 520, w: 440, h: 46 };
  const decoys = [
    { ...baseControl, path: "#sticky", text: "Add to cart", textAtc: true, inSticky: true, x: 1100, y: 1800, w: 200, h: 44 },
    { ...baseControl, path: "#quick", text: "Add to cart", textAtc: true, inRelated: true, inForeignCard: true, x: 100, y: 1500, w: 220, h: 44 },
    { ...baseControl, path: "#shoppay", text: "Buy with Shop Pay", textBuyNow: true, isExpress: true, inCartForm: true, x: 800, y: 575, w: 440, h: 46 },
    { ...baseControl, path: "#mobile", text: "Add to cart", textAtc: true, vis: false, x: 0, y: 0, w: 0, h: 0 },
    { ...baseControl, path: "#footer", text: "Add to bag", textAtc: true, inFooter: true, x: 20, y: 2600, w: 200, h: 40 },
  ];
  const result = scoreBuyBox(rawScan([...decoys, main]));
  assert.equal(result.pageType, "product");
  assert.equal(result.atc?.path, "#main-atc");
  assert.equal(result.atc?.selector, 'form[action*="/cart/add"] button[name="add"]', "the generalisable selector is preferred for Tier 0");
  assert.ok(result.confidence >= 0.8, `expected confident buy box, got ${result.confidence}`);
  assert.ok(!result.candidates.some((c) => ["#shoppay", "#mobile"].includes(c.path)), "express pay and hidden controls are excluded outright");

  const headless = scoreBuyBox(rawScan([{ ...baseControl, path: "#bag", text: "Add to bag", textAtc: true, classHint: true, x: 800, y: 400, w: 380, h: 52 }]));
  assert.ok(headless.confidence >= 0.8, `label + class + geometry should clear the bar, got ${headless.confidence}`);

  const weak = scoreBuyBox(rawScan([{ ...baseControl, path: "#maybe", text: "Buy now", textBuyNow: true, x: 40, y: 2000, w: 90, h: 24 }]));
  assert.ok(weak.confidence < 0.8, "a lone small 'buy now' far from the title must escalate to Tier 2");
});

const VARIANTS = [
  { id: 11, title: "S / Red", option1: "S", option2: "Red", available: true, price: 2900 },
  { id: 12, title: "S / Blue", option1: "S", option2: "Blue", available: false, price: 2900 },
  { id: 13, title: "M / Red", option1: "M", option2: "Red", available: false, price: 2900 },
  { id: 14, title: "M / Blue", option1: "M", option2: "Blue", available: true, price: 2900 },
];

test("Tier 1 oracle parses theme JSON, the .js endpoint, JSON-LD offers and the ShopifyAnalytics meta", () => {
  const fromArray = parseProductOracle({ productJson: [JSON.stringify(VARIANTS)], ldJson: [], analyticsMeta: null });
  assert.equal(fromArray.source, "product-json");
  assert.equal(fromArray.variants.length, 4);
  assert.deepEqual(fromArray.variants[1].options, ["S", "Blue"]);
  assert.equal(fromArray.hasAvailability, true);

  const productJs = JSON.stringify({ id: 1, title: "Tee", options: ["Size", "Color"], variants: VARIANTS });
  const fromJs = parseProductOracle({ productJson: [], ldJson: [], analyticsMeta: null }, productJs);
  assert.equal(fromJs.source, "products.js");
  assert.deepEqual(fromJs.optionNames, ["Size", "Color"]);

  const meta = JSON.stringify({ product: { id: 1, variants: VARIANTS.map((v) => ({ id: v.id, price: v.price, name: `Tee - ${v.title}`, public_title: v.title })) } });
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Tee",
    offers: VARIANTS.map((v) => ({ "@type": "Offer", availability: v.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", url: `/products/tee?variant=${v.id}` })),
  });
  const metaOnly = parseProductOracle({ productJson: [], ldJson: [], analyticsMeta: meta });
  assert.equal(metaOnly.source, "analytics-meta");
  assert.equal(metaOnly.hasAvailability, false, "ShopifyAnalytics carries no stock");
  assert.deepEqual(metaOnly.variants[3].options, ["M", "Blue"]);

  const ldOnly = parseProductOracle({ productJson: [], ldJson: [ld], analyticsMeta: meta });
  assert.equal(ldOnly.source, "ld+json");
  assert.deepEqual(ldOnly.variants.map((v) => v.available), [true, false, false, true]);

  assert.equal(productJsPath("/products/tee/"), "/products/tee.js");
  assert.equal(productJsPath("/collections/men/products/tee"), "/collections/men/products/tee.js");
});

test("Tier 1 variant planning only picks in-stock combinations and can keep the current one", () => {
  const option = (value, path, checked = false) => ({ value, label: value, path, available: true, checked });
  const raw = rawScan([], {
    selectedVariantId: "14",
    variantGroups: [
      { kind: "radio", name: "Size", path: "#size", general: null, isVariantId: false, visible: true, options: [option("S", "#s", false), option("M", "#m", true)] },
      { kind: "radio", name: "Color", path: "#color", general: null, isVariantId: false, visible: true, options: [option("Red", "#red"), option("Blue", "#blue", true)] },
    ],
    oracle: { productJson: [JSON.stringify({ options: ["Size", "Color"], variants: VARIANTS })], ldJson: [], analyticsMeta: null },
  });
  const result = scoreBuyBox(raw);
  assert.deepEqual(result.variantGroups.map((g) => g.oracleIndex), [0, 1]);

  const rng = new Rng(3);
  for (let i = 0; i < 25; i++) {
    const plan = planVariantSelection(result, rng);
    assert.equal(plan.source, "oracle");
    assert.ok(["11", "14"].includes(plan.variantId), `picked sold-out variant ${plan.variantId}`);
    const clicks = plan.steps.map((s) => s.option.path).join(" ");
    assert.ok(clicks === "#s #red" || clicks === "#m #blue", `steps must select the variant's options, got ${clicks}`);
  }
  const keep = planVariantSelection(result, rng, { preferCurrent: true });
  assert.equal(keep.variantId, "14", "the in-stock current selection is kept for the final add");
  const explore = planVariantSelection(result, rng, { exclude: new Set(["14"]) });
  assert.equal(explore.variantId, "11", "exploration moves to a variant not tried yet");
  // S/Red is two clicks away (size and colour); with time for one it is not started.
  const tight = planVariantSelection(result, rng, { exclude: new Set(["14"]), maxChanges: 1 });
  assert.ok(tight.steps.filter((s) => !s.option.checked).length <= 1, "a one-click budget never starts a two-click combination");
  assert.equal(planVariantSelection(result, rng, { exclude: new Set(["14"]), maxChanges: 2 }).variantId, "11");

  const domOnly = planVariantSelection(scoreBuyBox(rawScan([], { variantGroups: raw.variantGroups })), rng);
  assert.equal(domOnly.source, "dom");
  assert.equal(domOnly.steps.length, 2);
});

// ───────────────────────────── Tier 1 (live page) ─────────────────────────────

async function openPage(path) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${shop.url}${path}`, { waitUntil: "load" });
  return page;
}

test("Tier 1 finds the mock buy box from the utility world without touching the page's JS realm", { skip }, async () => {
  const page = await openPage("/products/produit-1");
  try {
    await page.evaluate(() => {
      const orig = Document.prototype.querySelectorAll;
      window.__mainWorldQsa = 0;
      Document.prototype.querySelectorAll = function (...args) {
        window.__mainWorldQsa++;
        return orig.apply(this, args);
      };
    });
    const result = await detectMultiSignal(page);
    assert.ok(result, "scan should succeed");
    assert.equal(await page.evaluate(() => window.__mainWorldQsa), 0, "the scan must run in the isolated world, not the page's realm");

    assert.equal(result.pageType, "product");
    assert.ok(result.confidence >= 0.8, `confidence ${result.confidence}`);
    assert.equal(result.atc.text, "Ajouter au panier");
    assert.match(result.atc.selector, /button\[name="add"\]|product-form__submit/);
    const target = await page.locator(result.atc.selector).first().evaluate((el) => el.closest("form")?.getAttribute("id"));
    assert.equal(target, "product-form-main", "the selector must resolve to the main product form's button");
    assert.ok(!result.candidates.some((c) => /payment|quick-add|sticky|mobile/.test(c.path + " " + c.text.toLowerCase()) && c.score >= result.atc.score));

    assert.equal(result.oracle.source, "product-json");
    assert.equal(result.oracle.hasAvailability, true);
    assert.equal(result.oracle.variants.length, 6);
    const radioGroups = result.variantGroups.filter((g) => g.kind === "radio");
    assert.deepEqual(radioGroups.map((g) => g.name), ["Taille", "Couleur"]);
    for (const g of radioGroups) {
      assert.deepEqual(g.options.map((o) => o.label), g.name === "Taille" ? ["30ml", "50ml", "100ml"] : ["Rose", "Noir"], "labels are the text a shopper sees");
      assert.ok(g.options.some((o) => o.available), `${g.name}: screen-reader "sold out" text must not mark every option dead`);
    }
    assert.ok(result.gallery && result.gallery.count >= 2, "gallery thumbnails detected");
    assert.ok(result.sections && result.sections.count >= 3, "accordions detected");
    assert.equal(result.cartDrawer, "cart-drawer");
    assert.ok(result.scanMs < 40, `scan took ${result.scanMs}ms`);

    const plan = planVariantSelection(result, new Rng(9));
    const chosen = result.oracle.variants.find((v) => v.id === plan.variantId);
    assert.equal(chosen.available, true, "variant planning must use oracle stock");
  } finally {
    await page.close();
  }
});

test("Tier 1 falls back to /products/<handle>.js for stock and flags fully sold-out products", { skip }, async () => {
  const noJson = await openPage("/products/produit-2");
  try {
    const r = await detectMultiSignal(noJson);
    assert.equal(r.oracle.source, "products.js", "stock must come from the .js endpoint when the page embeds none");
    assert.equal(r.oracle.hasAvailability, true);
    assert.equal(r.soldOut, false);
  } finally {
    await noJson.close();
  }
  const soldOut = await openPage("/products/produit-12");
  try {
    const r = await detectMultiSignal(soldOut);
    assert.equal(r.soldOut, true, "every variant unavailable = sold out");
  } finally {
    await soldOut.close();
  }
});

test("Tier 1 keeps the main button once the sticky bar shows, and learns listing cards", { skip }, async () => {
  const page = await openPage("/products/produit-3");
  try {
    await page.mouse.wheel(0, 1400);
    await page.waitForFunction(() => !document.querySelector(".sticky-atc").hidden);
    const r = await detectMultiSignal(page);
    const formId = await page.locator(r.atc.selector).first().evaluate((el) => el.closest("form")?.getAttribute("id") ?? null);
    assert.equal(formId, "product-form-main", "a visible sticky bar must not outrank the buy box");
  } finally {
    await page.close();
  }
  const listing = await openPage("/collections/all");
  try {
    const r = await detectMultiSignal(listing);
    assert.equal(r.pageType, "collection");
    assert.ok(r.productCards.selector, "a product-card selector should be derived");
    assert.ok(r.productCards.count >= 8, `expected the grid's cards, got ${r.productCards.count}`);
  } finally {
    await listing.close();
  }
});

test("Tier 1 reads option pickers beside the buy-button block and cards behind a mega-menu", { skip }, async () => {
  const pdp = await openPage("/products/produit-5?theme=blocks");
  try {
    const r = await detectMultiSignal(pdp);
    assert.ok(r.confidence >= 0.8, `confidence ${r.confidence}`);
    const names = operableGroups(r).map((g) => g.name);
    assert.deepEqual(names, ["Taille", "Couleur"], "pickers in a sibling block are still the buy box's options");
    const plan = planVariantSelection(r, new Rng(5));
    assert.equal(r.oracle.variants.find((v) => v.id === plan.variantId)?.available, true);
  } finally {
    await pdp.close();
  }
  const listing = await openPage("/collections/all?theme=mega");
  try {
    const r = await detectMultiSignal(listing);
    assert.ok(r.productCards.count >= 8, `450 header links must not hide the grid, got ${r.productCards.count}`);
    assert.doesNotMatch(r.productCards.selector ?? "", /mega/);
  } finally {
    await listing.close();
  }
});

test("a gallery of stacked photos is found and viewed by scrolling down it, without clicking into zoom", { skip }, async () => {
  const page = await openPage("/products/produit-4?theme=stack");
  try {
    const r = await detectMultiSignal(page);
    assert.equal(r.gallery?.kind, "stack");
    assert.equal(r.gallery?.count, 4);
    const before = await page.evaluate(() => scrollY);
    const ctx = { page, rng: new Rng(4), cfg: DEFAULT_CHOREOGRAPHY, deadline: Date.now() + 15_000 };
    const res = await viewMedia(ctx, { count: 3, selector: r.gallery.selector, kind: "stack" });
    assert.ok(res.performed >= 2, `looked at ${res.performed} photo(s): ${res.detail}`);
    assert.ok((await page.evaluate(() => scrollY)) > before + 300, "viewing a stack scrolls down through it");
    assert.equal(await page.evaluate(() => window.__zoomClicks ?? 0), 0, "looking is not clicking");

    // The accordions sit at the foot of a sticky column taller than the
    // screen: they only come into view once the page scrolls past the pin.
    await page.evaluate(() => scrollTo(0, 0));
    const rng = new Rng(6);
    const read = await readSection({ ...ctx, rng, pacing: new Pacing(rng, loadConfig().behavior), deadline: Date.now() + 15_000 });
    assert.equal(read.performed >= 1, true, `a section below the sticky pin is opened and read: ${read.detail}`);
    assert.ok(await page.evaluate(() => document.querySelectorAll("details[open]").length >= 1));
  } finally {
    await page.close();
  }
});

test("a click never lands on an overlay: Escape or the overlay's own close button clears it, a stuck one is refused", { skip }, async () => {
  const cardLinks = { selectors: ['.card__heading a[href*="/products/"]'], skip: "header, footer", max: 4 };
  for (const theme of ["overlay", "overlay-close"]) {
    const open = await openPage(`/collections/all?theme=${theme}`);
    try {
      const [target] = await findTargets(open, cardLinks);
      assert.ok(target, "the grid's links are found under the overlay");
      assert.equal(await clickTarget(open, new Rng(3), target), true, `${theme}: the overlay is closed, then the link clicked`);
      await open.waitForURL(/\/products\//, { timeout: 10_000 });
      assert.equal(await open.locator(".country-selector-drawer").count(), 0);
    } finally {
      await open.close();
    }
  }
  const stuck = await openPage("/collections/all?theme=overlay-stuck");
  try {
    const [target] = await findTargets(stuck, cardLinks);
    assert.equal(await clickTarget(stuck, new Rng(3), target), false, "clicking into a covering drawer must be refused");
    assert.match(stuck.url(), /\/collections\/all/);
  } finally {
    await stuck.close();
  }
});
