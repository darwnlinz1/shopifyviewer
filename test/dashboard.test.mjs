/**
 * Dashboard integration test.
 *
 * Exercises the profile store and the HTTP surface without launching a
 * browser: profile creation, the proxy save/validate path, cookie import
 * through the same endpoint the file picker posts to, and deletion. The parts
 * that need a real Chromium are covered by `test/session.test.mjs`, which is
 * skipped when the binary is unavailable.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../dist/config.js";
import { Orchestrator } from "../dist/server/orchestrator.js";
import { startDashboard } from "../dist/server/http.js";

let dashboard;
let orchestrator;
let workDir;
let base;

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "sim-dash-"));
  const config = loadConfig(undefined, {
    storefront: "https://shop.example",
    browser: { profileDir: join(workDir, "profiles") },
    logging: { dir: join(workDir, "logs"), console: false, jsonl: false },
  });
  orchestrator = new Orchestrator(config);
  // Port 0 lets the OS pick a free one, so the test cannot collide with a
  // dashboard the developer already has running.
  dashboard = await startDashboard(orchestrator, 0, "127.0.0.1");
  base = dashboard.url;
});

after(async () => {
  await orchestrator?.shutdown();
  await dashboard?.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function api(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

test("serves the dashboard page", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /tile-template/);
});

test("reports storefront context", async () => {
  const { body } = await api("/api/meta");
  assert.equal(body.storefront, "https://shop.example");
});

test("creates profiles and keeps them in stable order", async () => {
  const names = ["alpha", "beta", "gamma"];
  for (const name of names) {
    const { status } = await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    assert.equal(status, 201);
  }

  const { body } = await api("/api/state");
  assert.deepEqual(body.map((v) => v.profile.name), names);

  // Ordinals are what the grid sorts on, so they must be dense and ascending.
  assert.deepEqual(body.map((v) => v.profile.ordinal), [1, 2, 3]);
});

test("pins a fingerprint that does not change between reads", async () => {
  const first = (await api("/api/state")).body[0];
  const second = (await api("/api/state")).body[0];
  assert.deepEqual(first.profile.identity, second.profile.identity);
  assert.ok(first.identity.includes("x"), `expected a viewport in ${first.identity}`);
});

test("saves a valid proxy and rejects an invalid one", async () => {
  const { body: state } = await api("/api/state");
  const id = state[0].profile.id;

  const saved = await api(`/api/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ proxy: "http://user:pass@gate.example:8080" }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.proxy, "http://user:pass@gate.example:8080");

  const rejected = await api(`/api/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ proxy: "ftp://nope:21" }),
  });
  assert.equal(rejected.status, 500);
  assert.match(rejected.body.error, /Invalid proxy/);

  // The rejected value must not have overwritten the good one.
  const { body: after } = await api("/api/state");
  assert.equal(after[0].profile.proxy, "http://user:pass@gate.example:8080");
});

test("changing the proxy clears the stale check result", async () => {
  const { body: state } = await api("/api/state");
  const id = state[0].profile.id;

  orchestrator.store.recordProxyCheck(id, {
    ok: true,
    checkedAt: new Date().toISOString(),
    ip: "203.0.113.7",
  });
  assert.ok(orchestrator.store.require(id).proxyCheck);

  await api(`/api/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ proxy: "http://other.example:3128" }),
  });
  // A green tick next to an endpoint that was never tested is worse than none.
  assert.equal(orchestrator.store.require(id).proxyCheck, undefined);
});

test("sets a per-profile storefront, normalised, and clears it back to global", async () => {
  const { body: state } = await api("/api/state");
  const id = state[2].profile.id;

  // A bare host is accepted and normalised to an https URL without a slash.
  const saved = await api(`/api/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ storefront: "other-shop.example" }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.storefront, "https://other-shop.example");

  // A full URL keeps its scheme and drops the trailing slash.
  await api(`/api/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ storefront: "http://third-shop.example/" }),
  });
  assert.equal(orchestrator.store.require(id).storefront, "http://third-shop.example");

  // Garbage is rejected without disturbing the stored value.
  const rejected = await api(`/api/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ storefront: "not a url ???" }),
  });
  assert.equal(rejected.status, 500);
  assert.match(rejected.body.error, /Invalid storefront/);
  assert.equal(orchestrator.store.require(id).storefront, "http://third-shop.example");

  // null / empty clears the override — the profile follows the global shop again.
  await api(`/api/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ storefront: null }),
  });
  assert.equal(orchestrator.store.require(id).storefront, undefined);
});

test("starting a profile refuses a storefront outside the allowlist", async () => {
  const { body: state } = await api("/api/state");
  const id = state[2].profile.id;

  orchestrator.store.update(id, { storefront: "https://stranger.example" });
  await assert.rejects(
    () => orchestrator.startProfile(id),
    /not in safety\.allowedHosts/,
  );
  // Nothing half-started: the profile has no browser open after the refusal.
  assert.equal(orchestrator.isRunning(id), false);
});

test("imports cookies through the endpoint the file picker posts to", async () => {
  const { body: state } = await api("/api/state");
  const id = state[1].profile.id;

  const contents = JSON.stringify([
    { name: "cart", value: "abc", domain: ".shop.example", expirationDate: 4102444800 },
    { name: "pref", value: "fr", domain: ".shop.example", expirationDate: 4102444800 },
  ]);

  const { status, body } = await api(`/api/profiles/${id}/cookies`, {
    method: "POST",
    body: JSON.stringify({ filename: "cookies.json", contents }),
  });
  assert.equal(status, 200);
  assert.equal(body.imported, 2);
  assert.equal(body.format, "json-array");

  const stored = orchestrator.store.require(id).cookies;
  assert.equal(stored.count, 2);
  assert.equal(stored.sourceName, "cookies.json");
  assert.deepEqual(stored.domains, ["shop.example"]);
});

test("rejects a cookie file it cannot understand", async () => {
  const { body: state } = await api("/api/state");
  const id = state[1].profile.id;
  const { status, body } = await api(`/api/profiles/${id}/cookies`, {
    method: "POST",
    body: JSON.stringify({ filename: "junk.json", contents: "not a cookie file" }),
  });
  assert.equal(status, 500);
  assert.match(body.error, /no usable cookies|not valid JSON/);
});

test("clears cookies", async () => {
  const { body: state } = await api("/api/state");
  const id = state[1].profile.id;
  await api(`/api/profiles/${id}/cookies`, { method: "DELETE" });
  assert.equal(orchestrator.store.require(id).cookies, undefined);
});

test("pushes state over SSE", async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();

  // The first frame is the current state, sent immediately on connect so a
  // freshly opened dashboard is not blank until something changes.
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^event: state/);

  await api("/api/profiles", { method: "POST", body: JSON.stringify({ name: "delta" }) });

  let sawUpdate = false;
  for (let i = 0; i < 5 && !sawUpdate; i++) {
    const chunk = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
    if (chunk.includes("delta")) sawUpdate = true;
  }
  controller.abort();
  assert.ok(sawUpdate, "expected the new profile to arrive over SSE");
});

test("refuses to stream a profile with no browser open", async () => {
  const { body: state } = await api("/api/state");
  const res = await fetch(`${base}/api/profiles/${state[0].profile.id}/stream.mjpg`);
  assert.equal(res.status, 404);
  await res.body?.cancel();
});

test("deletes a profile and its directory", async () => {
  const { body: before } = await api("/api/state");
  const target = before.at(-1).profile;
  const dir = orchestrator.store.userDataDir(target);

  const { status } = await api(`/api/profiles/${target.id}`, { method: "DELETE" });
  assert.equal(status, 200);

  const { body: after } = await api("/api/state");
  assert.ok(!after.some((v) => v.profile.id === target.id));

  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(dir), false);
});

test("surviving profiles keep their ordinals after a deletion", async () => {
  // Positions must not shuffle when a neighbour is removed — that is exactly
  // the reordering the grid is built to avoid.
  const { body } = await api("/api/state");
  const ordinals = body.map((v) => v.profile.ordinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
  assert.deepEqual(ordinals, [1, 2, 3]);
});

test("returns a useful error for an unknown endpoint", async () => {
  const { status, body } = await api("/api/nope");
  assert.equal(status, 404);
  assert.match(body.error, /No such endpoint/);
});

test("does not serve files outside the public directory", async () => {
  const res = await fetch(`${base}/../../package.json`, { redirect: "manual" });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  await res.body?.cancel();
});
