/**
 * Navigation behaviour test.
 *
 * A visitor on a collection page does not type a product URL into the address
 * bar — they click the card. The difference is observable from the server:
 * a click carries a Referer, `page.goto()` does not. That is what these assert.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { chromium } from "playwright-core";
import { loadConfig } from "../dist/config.js";
import { PageNavigator } from "../dist/navigator/pageNavigator.js";
import { Pacing } from "../dist/behavior/timing.js";
import { Logger } from "../dist/logging/logger.js";
import { Rng } from "../dist/util/random.js";
import { startMockStorefront } from "./mockStorefront.mjs";

function findChromium() {
  return [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean).find((p) => existsSync(p)) ?? null;
}

const executablePath = findChromium();
const skip = executablePath ? false : "no Chromium available";

let shop, browser, config;

before(async () => {
  if (skip) return;
  shop = await startMockStorefront(0);
  browser = await chromium.launch({ headless: true, executablePath });
  config = loadConfig(undefined, {
    storefront: shop.url,
    logging: { console: false, jsonl: false, dir: "/tmp/nav-test-logs" },
  });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  await shop?.close();
});

async function open(seed, path = "/collections/all") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${shop.url}${path}`, { waitUntil: "load" });
  const rng = new Rng(seed);
  const logger = new Logger("nav-test", config.logging, "t");
  const navigator = new PageNavigator(page, config, logger, rng, new Pacing(rng, config.behavior));
  return { page, navigator };
}

test("navigates by clicking the link, carrying a referer", { skip }, async () => {
  const { page, navigator } = await open(5);
  const observation = await navigator.observe();
  const target = observation.productLinks[2].url;

  const metrics = await navigator.navigateTo(target);

  assert.equal(metrics.status, 200);
  assert.ok(page.url().endsWith(new URL(target).pathname), `landed on ${page.url()}`);

  // The decisive check: a click sends the page it came from. Typing the URL
  // into the address bar - which is what page.goto() is - sends nothing.
  const referrer = await page.evaluate(() => document.referrer);
  assert.ok(referrer.endsWith("/collections/all"), `expected a referer, got "${referrer}"`);

  await page.close();
});

test("the click lands on the anchor, not just anywhere", { skip }, async () => {
  const { page, navigator } = await open(9);
  const observation = await navigator.observe();
  const target = observation.productLinks[0].url;

  // Record what was clicked into sessionStorage, which survives the navigation
  // the click causes. Cancelling the click instead would prove nothing: the
  // code would correctly fall back to direct navigation, and the replaced
  // document would take the evidence with it.
  await page.evaluate(() => {
    addEventListener(
      "click",
      (event) => {
        const anchor = event.target.closest("a");
        sessionStorage.setItem(
          "__hit",
          JSON.stringify({ href: anchor?.getAttribute("href") ?? null, trusted: event.isTrusted }),
        );
      },
      { capture: true },
    );
  });

  await navigator.navigateTo(target);

  const hit = JSON.parse((await page.evaluate(() => sessionStorage.getItem("__hit"))) ?? "null");
  assert.ok(hit, "no click reached the page");
  assert.ok(hit.href, "the click did not land on an anchor");
  assert.ok(
    new URL(target).pathname.endsWith(hit.href.replace(/^\./, "")),
    `clicked ${hit.href}, expected the link to ${new URL(target).pathname}`,
  );
  // Synthesised events have isTrusted false; a real input-driven one does not.
  assert.equal(hit.trusted, true, "the click was synthesised, not real input");

  await page.close();
});

test("falls back to direct navigation when nothing links there", { skip }, async () => {
  // The engine sometimes returns to a collection the current page has no link
  // to. That still has to work; it just cannot be a click.
  const { page, navigator } = await open(3, "/products/produit-1");
  const target = `${shop.url}/collections/maquillage`;

  const metrics = await navigator.navigateTo(target);
  assert.equal(metrics.status, 200);
  assert.ok(page.url().includes("/collections/maquillage"));

  await page.close();
});

test("still moves the mouse and clicks within a page", { skip }, async () => {
  // Gallery thumbnails and accordions were always clicked; this guards against
  // the navigation work having broken them.
  const { page, navigator } = await open(13, "/products/produit-1");
  await navigator.observe();

  await page.evaluate(() => {
    window.__counts = { click: 0, mousemove: 0, wheel: 0 };
    for (const type of ["click", "mousemove", "wheel"]) {
      addEventListener(type, () => { window.__counts[type]++; }, { capture: true, passive: true });
    }
  });

  await navigator.scroll("down");
  await navigator.readSection();
  await navigator.viewMedia();
  await navigator.hoverVariants();

  const counts = await page.evaluate(() => window.__counts);
  assert.ok(counts.wheel > 5, `expected wheel input, got ${counts.wheel}`);
  assert.ok(counts.mousemove > 0, `expected mouse movement, got ${counts.mousemove}`);
  assert.ok(counts.click > 0, `expected clicks on the page, got ${counts.click}`);

  await page.close();
});
