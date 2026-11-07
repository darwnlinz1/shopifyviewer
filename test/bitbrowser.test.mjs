/**
 * BitBrowser provider tests.
 *
 * The Local API is mocked (test/mockBitBrowser.mjs) but the kernel is real:
 * `/browser/open` launches a headless Chrome with remote debugging, so the
 * connectOverCDP → default-context path, cookie sync and close are exercised
 * exactly as with the app. Chrome-dependent tests skip when no binary exists.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BitBrowserClient,
  buildBitProfileCreatePayload,
  syncOrCreateBitProfile,
  proxySignature,
  bitBrowserOpenArgs,
} from "../dist/browser/bitbrowser.js";
import { launchBrowser, providerFor } from "../dist/browser/chrome.js";
import { viewportOf } from "../dist/browser/viewport.js";
import { parseProxy } from "../dist/profiles/proxy.js";
import { parseCookieText } from "../dist/profiles/cookies.js";
import { ProfileStore } from "../dist/profiles/store.js";
import { loadConfig } from "../dist/config.js";
import { Orchestrator } from "../dist/server/orchestrator.js";
import { startDashboard } from "../dist/server/http.js";
import { Logger } from "../dist/logging/logger.js";
import { Rng } from "../dist/util/random.js";
import { startMockBitBrowser } from "./mockBitBrowser.mjs";
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

const chromePath = findChromium();
const skipChrome = chromePath ? false : "no Chromium available";

let mock;
let shop;
let workDir;
const quietLogging = () => ({ dir: join(workDir, "logs"), console: false, jsonl: false, level: "error" });
const logger = () => new Logger("bb-test", quietLogging(), "bb");

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "sim-bitbrowser-"));
  mock = await startMockBitBrowser({ chromePath });
  shop = await startMockStorefront(0);
});

after(async () => {
  await mock?.close();
  await shop?.close();
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
});

function bareProfile(overrides = {}) {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    name: "BB Profile",
    ordinal: 1,
    createdAt: new Date().toISOString(),
    proxy: "",
    identity: { seed: 7, viewport: { width: 1440, height: 900 } },
    stats: { runs: 0, pagesVisited: 0, productsViewed: 0, jsErrors: 0 },
    ...overrides,
  };
}

test("Local API client spaces request starts at least 350ms apart and sends the API key", async () => {
  const client = new BitBrowserClient(mock.url, { minIntervalMs: 350, apiKey: "tok-123" });
  // Timestamp where the client issues each request: the in-process mock only
  // sees them when its event loop gets round to it, which compresses gaps.
  const issued = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith(mock.url)) issued.push(performance.now());
    return realFetch(input, init);
  };
  const from = mock.requests.length;
  try {
    await Promise.all([client.health(), client.health(), client.health(), client.health()]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(issued.length, 4);
  for (let i = 1; i < issued.length; i++) {
    const gap = issued[i] - issued[i - 1];
    assert.ok(gap >= 349, `request ${i} was issued ${gap.toFixed(1)}ms after the previous one`);
  }
  const burst = mock.requests.slice(from);
  assert.equal(burst.length, 4);
  assert.ok(burst.every((r) => r.apiKey === "tok-123"), "x-api-key must be forwarded when configured");
});

test("creates a BitBrowser profile with the kernel fingerprint payload", async () => {
  const client = new BitBrowserClient(mock.url, { minIntervalMs: 0 });
  const profile = bareProfile({ name: "BB Create" });
  const proxy = parseProxy("http://alice:s3cret@10.1.2.3:8080");
  const sync = await syncOrCreateBitProfile(client, profile, proxy, { apiUrl: mock.url, coreVersion: "136", autoCreateProfile: true });

  assert.equal(sync.created, true);
  assert.equal(sync.managed, true);
  assert.ok(mock.profiles.has(sync.id));
  assert.equal(sync.proxySig, proxySignature(proxy));

  const sent = mock.calls("/browser/update").at(-1).body;
  assert.equal(sent.name, "BB Create");
  assert.equal(sent.proxyMethod, 2);
  assert.equal(sent.proxyType, "http");
  assert.equal(sent.host, "10.1.2.3");
  assert.equal(sent.port, 8080);
  assert.equal(sent.proxyUserName, "alice");
  assert.equal(sent.proxyPassword, "s3cret");
  assert.deepEqual(sent.browserFingerPrint, {
    coreProduct: "chrome",
    coreVersion: "136",
    ostype: "PC",
    os: "Win32",
    isIpCreateTimeZone: true,
    isIpCreateLanguage: true,
    isIpCreatePosition: true,
    webRTC: "0",
    canvas: "0",
    webGL: "0",
    webGLMeta: "0",
    audioContext: "0",
    clientRectNoiseEnabled: true,
  });

  const android = buildBitProfileCreatePayload(bareProfile({ device: { kind: "android", model: "Pixel 7" } }), undefined, { apiUrl: mock.url });
  assert.equal(android.browserFingerPrint.ostype, "Android");
  assert.equal(android.browserFingerPrint.os, "Linux armv81");
  assert.equal(android.proxyType, "noproxy");
  const iphone = buildBitProfileCreatePayload(bareProfile({ device: { kind: "iphone", model: "iPhone 14 Pro" } }), undefined, { apiUrl: mock.url });
  assert.deepEqual([iphone.browserFingerPrint.ostype, iphone.browserFingerPrint.os], ["IOS", "iPhone"]);

  assert.deepEqual(bitBrowserOpenArgs(true), ["--autoplay-policy=user-gesture-required", "--headless=new"]);
  assert.deepEqual(bitBrowserOpenArgs(false), ["--autoplay-policy=user-gesture-required"]);
});

test("re-syncs only a changed proxy, through a partial update that keeps the fingerprint", async () => {
  const client = new BitBrowserClient(mock.url, { minIntervalMs: 0 });
  const cfg = { apiUrl: mock.url, coreVersion: "136", autoCreateProfile: true };
  const first = parseProxy("socks5://u:p@5.6.7.8:1080");
  const created = await syncOrCreateBitProfile(client, bareProfile(), first, cfg);
  const managed = bareProfile({ bitBrowserId: created.id, bitBrowserManaged: true, bitBrowserProxySig: created.proxySig });

  const partialBefore = mock.calls("/browser/update/partial").length;
  const same = await syncOrCreateBitProfile(client, managed, first, cfg);
  assert.equal(same.proxySynced, false, "an unchanged proxy must not touch the BitBrowser profile");
  assert.equal(mock.calls("/browser/update/partial").length, partialBefore);

  const next = parseProxy("http://9.9.9.9:3128");
  const resync = await syncOrCreateBitProfile(client, managed, next, cfg);
  assert.equal(resync.proxySynced, true);
  const partial = mock.calls("/browser/update/partial").at(-1).body;
  assert.deepEqual(partial.ids, [created.id]);
  assert.equal(partial.proxyType, "http");
  assert.equal(partial.host, "9.9.9.9");
  assert.equal(partial.port, 3128);
  assert.ok(!("browserFingerPrint" in partial), "proxy re-sync must not resend (and so re-randomise) the fingerprint");
  assert.equal(mock.calls("/browser/update").filter((r) => r.body.id === created.id).length, 0, "never a full update on an existing id");

  // An operator-linked profile keeps its own BitBrowser proxy unless ours sets one.
  const linked = bareProfile({ bitBrowserId: created.id, bitBrowserManaged: false });
  const untouched = await syncOrCreateBitProfile(client, linked, undefined, cfg);
  assert.equal(untouched.proxySynced, false);
  assert.equal(untouched.managed, false);

  await assert.rejects(
    () => syncOrCreateBitProfile(client, bareProfile({ bitBrowserId: created.id, bitBrowserManaged: true }), parseProxy("socks4://1.1.1.1:1080"), cfg),
    /socks4/,
  );
  await assert.rejects(
    () => syncOrCreateBitProfile(client, bareProfile(), undefined, { ...cfg, autoCreateProfile: false }),
    /autoCreateProfile is off/,
  );
});

test("launchBrowser runs a BitBrowser profile over CDP: default context, no injected stealth, jar synced, closed via the API", { skip: skipChrome }, async () => {
  const config = loadConfig(undefined, {
    storefront: shop.url,
    browser: {
      headless: true,
      provider: "bitbrowser",
      bitbrowser: { apiUrl: mock.url, minRequestIntervalMs: 50 },
      profileDir: join(workDir, "launch-profiles"),
    },
    logging: quietLogging(),
  });
  const store = new ProfileStore(join(workDir, "launch-store"));
  const created = store.create({ name: "BB Launch", storefront: shop.url });
  store.setCookies(
    created.id,
    parseCookieText(JSON.stringify([{ name: "sv_test", value: "abc123", domain: "127.0.0.1", path: "/", expirationDate: 4102444800 }])),
    "jar.json",
  );
  const profile = store.require(created.id);
  assert.equal(providerFor(config, profile), "bitbrowser");

  const linked = [];
  const launched = await launchBrowser({
    slot: 1,
    sessionId: "bb-launch",
    config,
    logger: logger(),
    rng: new Rng(1),
    profile,
    hooks: { bitBrowserLinked: (link) => linked.push(link) },
  });
  try {
    assert.equal(launched.engine, "bitbrowser");
    assert.match(launched.profilePath, /^bitbrowser:/);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].managed, true);
    assert.equal(profile.bitBrowserId, linked[0].id, "the in-memory profile reuses the id on a revive");

    const browser = launched.context.browser();
    assert.ok(browser, "context must come from the CDP-attached browser");
    assert.equal(browser.contexts()[0], launched.context, "must drive the profile's default context, never browser.newContext()");

    const opened = mock.calls("/browser/open").at(-1).body;
    assert.equal(opened.id, linked[0].id);
    assert.equal(opened.queue, true);
    assert.ok(opened.args.includes("--headless=new"));

    const page = launched.context.pages()[0] ?? (await launched.context.newPage());
    assert.equal(page.viewportSize(), null, "a CDP-attached page has no pinned viewport");
    const inner = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.deepEqual(viewportOf(page), inner, "viewportOf must report the measured window, not a guess");

    await page.goto(`${shop.url}/products/produit-1`, { waitUntil: "domcontentloaded" });
    const marks = await page.evaluate(() => ({
      reg: typeof window[Symbol.for("__v8_native_reg__")],
      noise: window.__noise_injected_v2__ === true,
      toStr: Function.prototype.toString.call(Function.prototype.toString),
    }));
    assert.equal(marks.reg, "undefined", "stealthInitScripts must not run on the BitBrowser kernel");
    assert.equal(marks.noise, false, "buildNoiseScript must not run on the BitBrowser kernel");
    assert.match(marks.toStr, /\[native code\]/);

    const cookies = await launched.context.cookies();
    assert.ok(cookies.some((c) => c.name === "sv_test" && c.value === "abc123"), "profile jar must be synced into the kernel");
    assert.equal(launched.cookiesInjected, 1);

    await launched.close();
    assert.equal(browser.isConnected(), false, "close() must disconnect Playwright");
    assert.ok(mock.calls("/browser/close").some((r) => r.body.id === linked[0].id), "close() must call /browser/close");
    assert.equal(mock.running.has(linked[0].id), false);
  } finally {
    await launched.close().catch(() => undefined);
  }
});

test("a cookie import made while the BitBrowser window was closed is hard-written on the next launch", { skip: skipChrome }, async () => {
  const config = loadConfig(undefined, {
    storefront: shop.url,
    browser: { headless: true, provider: "bitbrowser", bitbrowser: { apiUrl: mock.url, minRequestIntervalMs: 50 }, profileDir: join(workDir, "pending-profiles") },
    logging: quietLogging(),
  });
  const store = new ProfileStore(join(workDir, "pending-store"));
  const created = store.create({ name: "BB Pending" });
  store.setCookies(
    created.id,
    parseCookieText(JSON.stringify([{ name: "fresh_login", value: "v2", domain: "127.0.0.1", path: "/", expirationDate: 4102444800 }])),
    "login.json",
  );
  store.setPendingCookieWrite(created.id, true);

  let hardWritten = 0;
  const launched = await launchBrowser({
    slot: 2,
    sessionId: "bb-pending",
    config,
    logger: logger(),
    rng: new Rng(2),
    profile: store.require(created.id),
    hooks: { cookiesHardWritten: () => { hardWritten++; store.setPendingCookieWrite(created.id, false); } },
  });
  try {
    assert.equal(hardWritten, 1);
    assert.equal(store.require(created.id).pendingCookieWrite, undefined);
    const cookies = await launched.context.cookies();
    assert.ok(cookies.some((c) => c.name === "fresh_login" && c.value === "v2"));
  } finally {
    await launched.close();
  }
});

test("dashboard API accepts the engine fields and reports BitBrowser status", async () => {
  const orchestrator = new Orchestrator(
    loadConfig(undefined, {
      storefront: "https://shop.example",
      browser: { profileDir: join(workDir, "api-profiles"), bitbrowser: { apiUrl: mock.url, minRequestIntervalMs: 20 } },
      logging: quietLogging(),
    }),
  );
  const dashboard = await startDashboard(orchestrator, 0, "127.0.0.1");
  const api = async (path, options = {}) => {
    const res = await fetch(`${dashboard.url}${path}`, { headers: { "content-type": "application/json" }, ...options });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  try {
    const created = await api("/api/profiles", { method: "POST", body: JSON.stringify({ name: "Engine", browserProvider: "bitbrowser" }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.browserProvider, "bitbrowser");
    assert.equal(created.body.bitBrowserId, undefined, "no id until the first launch creates one");

    const bad = await api("/api/profiles", { method: "POST", body: JSON.stringify({ name: "Bad", browserProvider: "chrome" }) });
    assert.equal(bad.status, 400);
    const names = (await api("/api/state")).body.map((v) => v.profile.name);
    assert.ok(!names.includes("Bad"), "a rejected create must not leave a profile behind");

    const badId = await api(`/api/profiles/${created.body.id}`, { method: "PATCH", body: JSON.stringify({ bitBrowserId: "not an id!" }) });
    assert.equal(badId.status, 400);
    assert.match(badId.body.error, /Invalid BitBrowser profile ID/);

    const linkedId = "abcdef0123456789abcdef0123456789";
    const linked = await api(`/api/profiles/${created.body.id}`, { method: "PATCH", body: JSON.stringify({ bitBrowserId: linkedId }) });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.bitBrowserId, linkedId);
    assert.equal(linked.body.bitBrowserManaged, false, "a pasted id belongs to the operator");

    const cleared = await api(`/api/profiles/${created.body.id}`, { method: "PATCH", body: JSON.stringify({ browserProvider: null, bitBrowserId: null }) });
    assert.equal(cleared.body.browserProvider, undefined);
    assert.equal(cleared.body.bitBrowserId, undefined);

    const meta = (await api("/api/meta")).body;
    assert.equal(meta.provider, "builtin");
    assert.equal(meta.bitbrowser.apiUrl, mock.url);

    const status = (await api("/api/bitbrowser/status")).body;
    assert.equal(status.ok, true);
    assert.equal(typeof status.latencyMs, "number");

    const listed = await api("/api/bitbrowser/profiles");
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.body.list));

    const bulk = await api("/api/profiles/bulk-create", {
      method: "POST",
      body: JSON.stringify({ sites: ["https://a.example", "https://b.example"], proxies: [], browserProvider: "bitbrowser" }),
    });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.body.created, 2);
    assert.ok(bulk.body.profiles.every((p) => p.browserProvider === "bitbrowser"));
  } finally {
    await orchestrator.shutdown();
    await dashboard.close();
  }

  const offline = new Orchestrator(
    loadConfig(undefined, {
      storefront: "https://shop.example",
      browser: { profileDir: join(workDir, "offline-profiles"), bitbrowser: { apiUrl: "http://127.0.0.1:9", minRequestIntervalMs: 0 } },
      logging: quietLogging(),
    }),
  );
  try {
    const down = await offline.bitBrowserStatus();
    assert.equal(down.ok, false);
    assert.match(down.error, /BitBrowser Local API/);
  } finally {
    await offline.shutdown();
  }
});

test("orchestrator runs a BitBrowser session end to end and deletes only BitBrowser profiles it created", { skip: skipChrome }, async () => {
  const orchestrator = new Orchestrator(
    loadConfig(undefined, {
      storefront: "",
      browser: { headless: true, profileDir: join(workDir, "orch-profiles"), bitbrowser: { apiUrl: mock.url, minRequestIntervalMs: 50 } },
      session: { durationMs: 60_000, durationJitterMs: 0, hardTimeoutMs: 120_000, navigationTimeoutMs: 15_000 },
      behavior: { ...loadConfig().behavior, pageEngagementMs: { min: 2_000, max: 3_000 } },
      ai: { cookiesDir: join(workDir, "no-cookies"), recipeCachePath: join(workDir, "recipes.json") },
      logging: quietLogging(),
    }),
  );
  try {
    const profile = orchestrator.createProfile({ name: "BB Session", storefront: shop.url, browserProvider: "bitbrowser", atcMinutes: 0 });
    await orchestrator.startProfile(profile.id);

    const deadline = Date.now() + 45_000;
    let snap = null;
    while (Date.now() < deadline) {
      snap = orchestrator.snapshot().find((v) => v.profile.id === profile.id)?.session ?? null;
      if (snap && snap.status === "running" && snap.pagesVisited >= 1) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(snap, "session should be live");
    assert.equal(snap.engine, "bitbrowser");
    assert.ok(snap.url.startsWith(shop.url), `BitBrowser page should browse the shop, got ${snap.url}`);
    assert.ok(snap.pagesVisited >= 1, "the session should navigate inside the BitBrowser window");

    const stored = orchestrator.store.require(profile.id);
    assert.ok(stored.bitBrowserId, "the created BitBrowser id is persisted");
    assert.equal(stored.bitBrowserManaged, true);
    assert.equal(stored.bitBrowserProxySig, "noproxy");
    const bitId = stored.bitBrowserId;

    await orchestrator.closeSession(profile.id);
    assert.ok(mock.calls("/browser/close").some((r) => r.body.id === bitId));

    await orchestrator.deleteProfile(profile.id);
    assert.ok(mock.calls("/browser/delete").some((r) => r.body.id === bitId), "a managed BitBrowser profile is deleted with ours");

    const client = new BitBrowserClient(mock.url, { minIntervalMs: 0 });
    const operatorId = await client.create({ name: "operator-owned", proxyMethod: 2, proxyType: "noproxy", browserFingerPrint: { coreVersion: "136" } });
    const linked = orchestrator.createProfile({ name: "BB Linked", browserProvider: "bitbrowser", bitBrowserId: operatorId });
    await orchestrator.deleteProfile(linked.id);
    assert.ok(!mock.calls("/browser/delete").some((r) => r.body.id === operatorId), "an operator-linked BitBrowser profile is never deleted");
    assert.ok(mock.profiles.has(operatorId));
  } finally {
    await orchestrator.shutdown();
  }
});
