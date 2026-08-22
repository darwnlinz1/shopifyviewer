/**
 * Scroll behaviour test.
 *
 * A wheel event carries a delta and the browser applies all of it at once, so
 * `mouse.wheel(0, 600)` is a 600-pixel jump rather than a scroll. This asserts
 * the gesture is emitted as a burst of small ticks instead: the page has to
 * pass through many intermediate positions, and no single moment may move it a
 * large fraction of the viewport.
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
const VIEWPORT = { width: 1440, height: 900 };

let shop, browser, config;

before(async () => {
  if (skip) return;
  shop = await startMockStorefront(0);
  browser = await chromium.launch({ headless: true, executablePath });
  config = loadConfig(undefined, {
    storefront: shop.url,
    logging: { console: false, jsonl: false, dir: "/tmp/scroll-test-logs" },
  });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  await shop?.close();
});

/** Open a page and a navigator wired to a fixed seed. */
async function openPage(seed) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(`${shop.url}/collections/all`, { waitUntil: "load" });
  const rng = new Rng(seed);
  const logger = new Logger("scroll-test", config.logging, "t");
  const navigator = new PageNavigator(page, config, logger, rng, new Pacing(rng, config.behavior));
  await navigator.observe(); // prime the geometry the gesture works from
  return { page, navigator };
}

/** Sample window.scrollY while `run()` executes. */
async function trace(page, run) {
  const samples = [];
  const timer = setInterval(() => {
    page.evaluate(() => window.scrollY).then(
      (y) => samples.push(y),
      () => undefined,
    );
  }, 25);
  await run();
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 60));
  return samples;
}

test("scrolls progressively instead of teleporting", { skip }, async () => {
  const { page, navigator } = await openPage(42);
  const samples = await trace(page, () => navigator.scroll("down"));
  const distinct = [...new Set(samples)];

  assert.ok(samples.at(-1) > 200, `page barely moved: ended at ${samples.at(-1)}`);

  // The core assertion. A single wheel event of the whole distance would show
  // up as two positions: 0, then the destination.
  assert.ok(
    distinct.length >= 8,
    `expected many intermediate positions, saw ${distinct.length}: ${distinct.join(" ")}`,
  );

  // And no instant should carry the page most of a screen.
  let maxJump = 0;
  for (let i = 1; i < samples.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(samples[i] - samples[i - 1]));
  }
  assert.ok(
    maxJump < VIEWPORT.height * 0.6,
    `single jump of ${maxJump}px is a teleport, not a scroll`,
  );

  await page.close();
});

test("dispatches real wheel events the page can observe", { skip }, async () => {
  // The whole reason for driving the mouse rather than window.scrollBy: the
  // page must be able to see the input that caused the movement.
  const { page, navigator } = await openPage(7);
  await page.evaluate(() => {
    window.__wheel = 0;
    addEventListener("wheel", () => { window.__wheel++; }, { passive: true });
  });

  await navigator.scroll("down");
  const events = await page.evaluate(() => window.__wheel);

  assert.ok(events > 5, `expected a burst of wheel events, got ${events}`);
  await page.close();
});

test("turns around at the bottom rather than stalling", { skip }, async () => {
  const { page, navigator } = await openPage(11);

  // Park at the bottom, then let the navigator choose for itself.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await new Promise((r) => setTimeout(r, 150));
  await navigator.observe();

  const before = await page.evaluate(() => window.scrollY);
  const travelled = await navigator.scroll();
  const after = await page.evaluate(() => window.scrollY);

  // Scrolling down at the bottom does nothing at all, which on screen reads as
  // the browser having frozen.
  assert.ok(travelled > 0, "gesture at the bottom of the page did nothing");
  assert.ok(after < before, `expected to scroll back up, went ${before} → ${after}`);

  await page.close();
});
