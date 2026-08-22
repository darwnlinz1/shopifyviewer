/**
 * Live session test.
 *
 * Drives a real browser through the mock storefront and asserts the things
 * that can only be observed with one running: that browsing happens, that a
 * finished session *keeps its browser open* instead of closing, and that the
 * live view produces frames.
 *
 * Runs on stock Chromium via the fallback path — this exercises the session
 * machinery, not CloakBrowser's patches, and does not need a 1 GB download in
 * CI. Skips cleanly when no Chromium is available.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { startSession } from "../dist/session/manager.js";
import { Screencast } from "../dist/server/screencast.js";
import { startMockStorefront } from "./mockStorefront.mjs";

/** Locate a Chromium the fallback path can use, or null to skip. */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

const executablePath = findChromium();
const skip = executablePath ? false : "no Chromium available";

let shop;
let shopUrl;
let workDir;
let config;

before(async () => {
  if (skip) return;
  workDir = mkdtempSync(join(tmpdir(), "sim-session-"));

  shop = await startMockStorefront(0);
  shopUrl = shop.url;

  config = loadConfig(undefined, {
    storefront: shopUrl,
    seed: 42,
    browser: {
      headless: true,
      allowFallbackBrowser: true,
      executablePath,
      humanize: false,
      profileDir: join(workDir, "profiles"),
    },
    session: {
      // Long enough to visit several pages, short enough for a test.
      durationMs: 12_000,
      durationJitterMs: 0,
      hardTimeoutMs: 60_000,
      navigationTimeoutMs: 15_000,
    },
    logging: { dir: join(workDir, "logs"), console: false, jsonl: false },
  });
});

after(async () => {
  if (skip) return;
  await shop.close();
  rmSync(workDir, { recursive: true, force: true });
});

test("browses the storefront and holds the browser open when the budget runs out", { skip }, async () => {
  const updates = [];
  const handle = await startSession({
    slot: 0,
    sessionId: "test-linger",
    config,
    // -1: keep the browser open until closed. This is the behaviour the
    // dashboard relies on and the bug this test exists for.
    lingerMs: -1,
    onUpdate: (snapshot) => updates.push(snapshot.status),
  });

  // Wait for the timer to run out and the session to settle into linger.
  const deadline = Date.now() + 45_000;
  while (handle.snapshot().status !== "lingering" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }

  const parked = handle.snapshot();
  assert.equal(parked.status, "lingering", "session should be lingering, not finished");
  assert.ok(parked.pagesVisited > 0, "expected at least one page visit");

  // The point of linger: the browser is still alive and still on its page.
  assert.ok(!handle.page.isClosed(), "page should still be open while lingering");
  const title = await handle.page.title();
  assert.ok(title.length > 0, "the lingering page should still be responsive");
  assert.ok(parked.lingeringSince, "linger start time should be recorded");

  // And it only closes when actually asked to. Either ending is legitimate:
  // the timer can run out, or the engine can decide it has seen enough and
  // wind down first. Both linger; which one happened depends on the seed.
  const result = await handle.close();
  assert.ok(
    ["timer", "engine_exit"].includes(result.exitReason),
    `unexpected exit reason ${result.exitReason}`,
  );
  assert.ok(result.pagesVisited > 0);
  assert.ok(updates.includes("running"));
  assert.ok(updates.includes("lingering"));
});

test("pauses and resumes without closing the browser", { skip }, async () => {
  const handle = await startSession({
    slot: 1,
    sessionId: "test-pause",
    config,
    lingerMs: -1,
  });

  // Let it get going before interfering.
  const started = Date.now();
  while (handle.snapshot().status !== "running" && Date.now() - started < 20_000) {
    await new Promise((r) => setTimeout(r, 100));
  }

  handle.pause();
  assert.equal(handle.snapshot().status, "paused");

  const frozen = handle.snapshot().actionsPerformed;
  await new Promise((r) => setTimeout(r, 1500));
  // A paused session finishes the action it was mid-way through, then stops
  // taking new ones; it must not keep browsing indefinitely.
  const after = handle.snapshot().actionsPerformed;
  assert.ok(after - frozen <= 1, `paused session took ${after - frozen} more actions`);
  assert.ok(!handle.page.isClosed());

  handle.resume();
  assert.equal(handle.snapshot().status, "running");

  await handle.close();
});

test("streams live frames from the browser", { skip }, async () => {
  const handle = await startSession({
    slot: 2,
    sessionId: "test-screencast",
    config,
    lingerMs: -1,
  });

  const screencast = new Screencast(handle.page);
  await screencast.start();

  const frames = [];
  const unsubscribe = screencast.subscribe((frame) => frames.push(frame));

  const deadline = Date.now() + 20_000;
  while (frames.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  unsubscribe();
  await screencast.stop();
  await handle.close();

  assert.ok(frames.length > 0, "expected at least one screencast frame");
  // JPEG magic number — the frames must be decodable images, not empty buffers.
  assert.equal(frames[0][0], 0xff);
  assert.equal(frames[0][1], 0xd8);
});

test("closes immediately when linger is off", { skip }, async () => {
  const handle = await startSession({
    slot: 3,
    sessionId: "test-nolinger",
    config: { ...config, session: { ...config.session, durationMs: 3000 } },
    lingerMs: 0,
  });

  const result = await handle.done;
  assert.ok(["timer", "engine_exit"].includes(result.exitReason));
  // Scripted runs must still terminate on their own.
  assert.ok(handle.page.isClosed(), "page should be closed when linger is off");
});
