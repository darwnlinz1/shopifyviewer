/**
 * Dashboard hardening: the token must not be obtainable from the open shell,
 * comparisons are constant-time, and a web page the operator happens to have
 * open (cross-site request, DNS rebinding) cannot drive the loopback dashboard.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../dist/config.js";
import { Orchestrator } from "../dist/server/orchestrator.js";
import { startDashboard } from "../dist/server/http.js";

const TOKEN = "s3cret-token-value";
let work, orchestrator, open, locked;

before(async () => {
  work = mkdtempSync(join(tmpdir(), "sim-dashsec-"));
  orchestrator = new Orchestrator(loadConfig(undefined, {
    storefront: "https://shop.example",
    browser: { profileDir: join(work, "profiles") },
    logging: { dir: join(work, "logs"), console: false, jsonl: false },
  }));
  open = await startDashboard(orchestrator, 0, "127.0.0.1");
  locked = await startDashboard(orchestrator, 0, "127.0.0.1", TOKEN);
});

after(async () => {
  await orchestrator?.shutdown();
  await open?.close();
  await locked?.close();
  rmSync(work, { recursive: true, force: true });
});

/** fetch cannot override Host; use raw http for rebinding probes. */
function raw(dash, { path = "/api/state", method = "GET", headers = {} } = {}) {
  const u = new URL(dash.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the open shell never hands out the token", async () => {
  const anonymous = await (await fetch(`${locked.url}/`)).text();
  assert.ok(!anonymous.includes(TOKEN), "token leaked to an unauthenticated visitor");
  assert.ok(!anonymous.includes("__DASH_TOKEN__"));
});

test("a visitor who already holds the token gets it injected for the page's own API calls", async () => {
  const html = await (await fetch(`${locked.url}/?token=${TOKEN}`)).text();
  assert.ok(html.includes("window.__DASH_TOKEN__"));
  assert.ok(html.includes(TOKEN));
  const wrong = await (await fetch(`${locked.url}/?token=nope`)).text();
  assert.ok(!wrong.includes(TOKEN));
});

test("API still rejects missing/wrong tokens, including different-length ones", async () => {
  for (const q of ["", "?token=", "?token=x", `?token=${TOKEN}x`, `?token=${TOKEN.slice(0, -1)}`]) {
    assert.equal((await fetch(`${locked.url}/api/state${q}`)).status, 401, `query "${q}"`);
  }
  assert.equal((await fetch(`${locked.url}/api/state?token=${TOKEN}`)).status, 200);
  assert.equal((await fetch(`${locked.url}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
});

test("DNS rebinding: a foreign Host header is refused on a loopback dashboard", async () => {
  const bad = await raw(open, { headers: { host: "evil.example.com" } });
  assert.equal(bad.status, 403);
  const alsoBad = await raw(open, { headers: { host: "evil.example.com:7317" } });
  assert.equal(alsoBad.status, 403);
  const u = new URL(open.url);
  const good = await raw(open, { headers: { host: `localhost:${u.port}` } });
  assert.equal(good.status, 200);
  assert.equal((await raw(open)).status, 200, "the normal 127.0.0.1 Host still works");
});

test("cross-site writes are refused; same-origin and Origin-less (curl, CLI) writes pass the guard", async () => {
  const u = new URL(open.url);
  const cross = await raw(open, { path: "/api/profiles", method: "POST", headers: { origin: "https://evil.example.com", host: u.host } });
  assert.equal(cross.status, 403);
  assert.match(cross.body, /Cross-site/);

  const same = await raw(open, { path: "/api/profiles/does-not-exist/stop", method: "POST", headers: { origin: open.url, host: u.host } });
  assert.notEqual(same.status, 403, "same-origin must reach the handler");

  const noOrigin = await raw(open, { path: "/api/profiles/does-not-exist/stop", method: "POST", headers: { host: u.host } });
  assert.notEqual(noOrigin.status, 403);

  // Reads from another origin are not blocked by the guard (the browser's own CORS
  // policy withholds the response; no CORS headers are ever sent).
  const read = await raw(open, { headers: { origin: "https://evil.example.com", host: u.host } });
  assert.equal(read.status, 200);
  assert.ok(!("access-control-allow-origin" in (await fetch(`${open.url}/api/state`)).headers), "no CORS opt-in");
});

test("/api/alerts exposes status and history", async () => {
  await orchestrator.alerts.notify({ key: "t", severity: "info", title: "hello-alert", body: "b" });
  const body = await (await fetch(`${open.url}/api/alerts`)).json();
  assert.equal(body.active, false, "no sinks configured");
  assert.equal(body.history[0].title, "hello-alert");
});
