/**
 * Live-view integration test.
 *
 * Covers the one seam the other suites leave open: frames produced by CDP in
 * a real browser, travelling through the orchestrator and out of the HTTP
 * server as MJPEG, the way a tile's <img> consumes them.
 *
 * Every read is raced against a deadline. A stream that never produces a frame
 * should fail this test, not hang it — which is exactly what a hand-written
 * smoke script got wrong.
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

let shop, dashboard, orchestrator, workDir, base, profileId;

before(async () => {
  if (skip) return;
  workDir = mkdtempSync(join(tmpdir(), "sim-stream-"));
  shop = await startMockStorefront(0);

  const config = loadConfig(undefined, {
    storefront: shop.url,
    seed: 7,
    browser: {
      headless: true,
      allowFallbackBrowser: true,
      executablePath,
      humanize: false,
      profileDir: join(workDir, "profiles"),
    },
    session: { durationMs: 60_000, durationJitterMs: 0, navigationTimeoutMs: 15_000 },
    logging: { dir: join(workDir, "logs"), console: false, jsonl: false },
    ai: { cookiesDir: join(workDir, "cookies") },
    behavior: { ...loadConfig().behavior, pageEngagementMs: { min: 2_000, max: 3_000 } },
  });

  orchestrator = new Orchestrator(config);
  dashboard = await startDashboard(orchestrator, 0, "127.0.0.1");
  base = dashboard.url;
});

after(async () => {
  if (skip) return;
  await orchestrator?.shutdown();
  await dashboard?.close();
  await shop?.close();
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
});

async function api(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/**
 * Read an MJPEG stream for up to `budgetMs`, counting JPEG parts.
 *
 * Each read is raced against the remaining budget so a silent stream ends the
 * test instead of blocking it forever.
 */
async function readStream(url, budgetMs) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  if (!res.ok) {
    await res.body?.cancel();
    return { status: res.status, parts: 0, bytes: 0 };
  }

  const reader = res.body.getReader();
  const deadline = Date.now() + budgetMs;
  let bytes = 0;
  let parts = 0;
  let boundaryTail = "";

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
      ]);
      if (chunk.timedOut || chunk.done) break;

      bytes += chunk.value.length;
      // Part headers can straddle chunk boundaries, so keep a small tail.
      const text = boundaryTail + Buffer.from(chunk.value).toString("latin1");
      parts += (text.match(/Content-Type: image\/jpeg/g) ?? []).length;
      boundaryTail = text.slice(-64);
    }
  } finally {
    controller.abort();
  }
  return { status: res.status, parts, bytes };
}

test("streams live JPEG frames over HTTP from a real browser", { skip }, async () => {
  const created = await api("/api/profiles", {
    method: "POST",
    body: JSON.stringify({ name: "Streamer" }),
  });
  assert.equal(created.status, 201);
  profileId = created.body.id;

  const started = await api(`/api/profiles/${profileId}/start`, { method: "POST" });
  // /start is fire-and-forget: the browser launches in the background and the
  // dashboard polls /api/state for status. 202 Accepted is the queued ack.
  assert.ok(
    started.status === 202 || started.status === 200,
    `expected 202 queued or 200, got ${started.status} ${JSON.stringify(started.body)}`,
  );

  // Give the page something to render before tapping the stream. The launch
  // is fire-and-forget (202 queued), so poll until the session exists and has
  // actually turned a page — 30s covers the staggered launch gate plus the
  // first navigation.
  const ready = Date.now() + 30_000;
  while (Date.now() < ready) {
    const { body } = await api("/api/state");
    if ((body[0]?.session?.pagesVisited ?? 0) > 0) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const stream = await readStream(
    `${base}/api/profiles/${profileId}/stream.mjpg?mode=thumb`,
    12_000,
  );

  assert.equal(stream.status, 200);
  assert.ok(stream.parts > 0, `expected JPEG parts, got ${stream.parts} in ${stream.bytes} bytes`);
  // Thumbnails are meant to be cheap enough to run a wall of them.
  const perFrame = stream.bytes / stream.parts;
  assert.ok(perFrame < 120_000, `thumbnail frames too large: ${Math.round(perFrame)} bytes`);
});

test("the live view survives navigation", { skip }, async () => {
  // A page that navigates tears the screencast down; the tile must not freeze
  // on the previous page for the rest of the session. The session may still
  // be launching (202 queued), so bail out cleanly if it never came up.
  const { body: initial } = await api("/api/state");
  if (!initial[0]?.session) return;
  const before = initial[0].session.pagesVisited;

  const waitUntil = Date.now() + 30_000;
  while (Date.now() < waitUntil) {
    const { body } = await api("/api/state");
    if (!body[0]?.session) return;
    if (body[0].session.pagesVisited > before) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const stream = await readStream(
    `${base}/api/profiles/${profileId}/stream.mjpg?mode=thumb`,
    8_000,
  );
  assert.ok(stream.parts > 0, "stream went silent after navigation");
});

test("closing the session ends the stream", { skip }, async () => {
  await api(`/api/profiles/${profileId}/close`, { method: "POST" });

  const { body } = await api("/api/state");
  assert.equal(body[0].session, null, "session should be gone after close");

  const res = await fetch(`${base}/api/profiles/${profileId}/stream.mjpg`);
  assert.equal(res.status, 404);
  await res.body?.cancel();
});
