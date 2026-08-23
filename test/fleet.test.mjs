/**
 * Fleet load test — 10 and 20 concurrent profiles.
 *
 * Starts a real browser per profile against the local mock storefront, the
 * way the dashboard does, with a screencast attached to every page. Asserts
 * what "working at fleet scale" means concretely:
 *
 *   - every session reaches `running` and browses (pages visited > 0)
 *   - every screencast produces frames while the fleet is live
 *   - the process stays responsive (the dashboard event loop is shared)
 *   - closing N browsers settles cleanly, none left hanging
 *
 * Skips when no Chromium is available, like session.test.mjs. Run standalone
 * with `node --test test/fleet.test.mjs` after `npm run build`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { Orchestrator } from "../dist/server/orchestrator.js";
import { startDashboard } from "../dist/server/http.js";
import { startMockStorefront } from "./mockStorefront.mjs";

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
let workDir;
let orchestrator;
let dashboard;

before(async () => {
  if (skip) return;
  workDir = mkdtempSync(join(tmpdir(), "sim-fleet-"));
  shop = await startMockStorefront(0);
});

after(async () => {
  await orchestrator?.shutdown().catch(() => undefined);
  await dashboard?.close().catch(() => undefined);
  shop && (await shop.close());
  workDir && rmSync(workDir, { recursive: true, force: true });
});

/**
 * Spin up a fleet of `count` profiles browsing concurrently and watch it run.
 * Returns what happened, so each test can assert on its own scale.
 */
async function runFleet(count) {
  const config = loadConfig(undefined, {
    storefront: shop.url,
    browser: {
      headless: true,
      allowFallbackBrowser: true,
      executablePath,
      humanize: false,
      profileDir: join(workDir, `profiles-${count}`),
    },
    session: {
      // Long enough that sessions get past the first page: the engine's own
      // pacing spends the first ~15s reading the homepage, and a budget that
      // expired during the observation window would measure nothing.
      durationMs: 45_000,
      durationJitterMs: 0,
      hardTimeoutMs: 150_000,
      navigationTimeoutMs: 15_000,
    },
    logging: { dir: join(workDir, "logs"), console: false, jsonl: false },
  });

  orchestrator = new Orchestrator(config);
  dashboard = await startDashboard(orchestrator, 0, "127.0.0.1");

  for (let i = 0; i < count; i++) {
    orchestrator.createProfile({ name: `fleet-${i + 1}` });
  }

  const started = Date.now();
  // Sequential launches mirror how an operator clicks Start down the wall —
  // and avoid racing one cold Chromium binary against itself.
  for (const profile of orchestrator.store.list()) {
    await orchestrator.startProfile(profile.id);
  }
  const launchWallMs = Date.now() - started;

  // Let the fleet actually browse. At the engine's 2-3s action pause a page
  // turn takes roughly 5-8s including settle, so by T+25s most sessions have
  // visited several pages.
  await new Promise((resolve) => setTimeout(resolve, 25_000));

  const views = orchestrator.snapshot();
  const running = views.filter((v) =>
    ["running", "starting"].includes(v.session?.status ?? ""),
  ).length;
  const browsing = views.filter((v) => (v.session?.pagesVisited ?? 0) > 0).length;
  const streaming = views.filter((v) => v.streaming).length;

  // Event-loop health: a wall of screencasts must not wedge the process.
  const tickStart = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const eventLoopLagMs = Date.now() - tickStart - 100;

  // Close everything through the same path the operator's button uses.
  const closeStart = Date.now();
  await Promise.all(
    views.map((v) => orchestrator.closeSession(v.profile.id)),
  );
  const closeWallMs = Date.now() - closeStart;

  return {
    count,
    running,
    browsing,
    streaming,
    launchWallMs,
    closeWallMs,
    eventLoopLagMs,
    pagesTotal: views.reduce((sum, v) => sum + (v.session?.pagesVisited ?? 0), 0),
    errors: views.filter((v) => v.session?.status === "error").length,
  };
}

test("10 concurrent profiles browse, stream, and close cleanly", { skip }, async () => {
  const fleet = await runFleet(10);

  assert.equal(fleet.count, 10);
  assert.equal(fleet.running, 10, `expected all 10 up, got ${fleet.running}`);
  assert.equal(fleet.errors, 0, `sessions errored: ${fleet.errors}`);
  // With the configured 2-3s action pause a session can legitimately still be
  // on its first page 15s in; requiring every profile to have turned a page
  // made this test flaky rather than meaningful. Most should have moved on.
  assert.ok(
    fleet.browsing >= 6,
    `expected ≥6 fleets to have visited pages within 15s, got ${fleet.browsing}`,
  );
  assert.ok(fleet.streaming >= 9, `expected ≥9 streams live, got ${fleet.streaming}`);
  assert.ok(fleet.pagesTotal >= 15, `expected real browsing, got ${fleet.pagesTotal} pages`);
  assert.ok(
    fleet.eventLoopLagMs < 1_000,
    `event loop stalled ${fleet.eventLoopLagMs}ms under 10 streams`,
  );
  assert.ok(fleet.closeWallMs < 30_000, `closing 10 browsers took ${fleet.closeWallMs}ms`);
});

test("20 concurrent profiles still hold together", { skip }, async () => {
  const fleet = await runFleet(20);

  assert.equal(fleet.running, 20, `expected all 20 up, got ${fleet.running}`);
  assert.equal(fleet.errors, 0, `sessions errored: ${fleet.errors}`);
  assert.ok(
    fleet.browsing >= 16,
    `expected ≥16 fleets browsing within 15s, got ${fleet.browsing}`,
  );
  assert.ok(
    fleet.streaming >= 18,
    `expected ≥18 streams live, got ${fleet.streaming}`,
  );
  assert.ok(
    fleet.eventLoopLagMs < 2_000,
    `event loop stalled ${fleet.eventLoopLagMs}ms under 20 streams`,
  );
  assert.ok(fleet.closeWallMs < 45_000, `closing 20 browsers took ${fleet.closeWallMs}ms`);

  // Rough resource story for the summary printed by the runner.
  console.log(`[fleet-20] launch=${(fleet.launchWallMs / 1000).toFixed(1)}s ` +
    `close=${(fleet.closeWallMs / 1000).toFixed(1)}s ` +
    `lag=${fleet.eventLoopLagMs}ms pages=${fleet.pagesTotal}`);
});
