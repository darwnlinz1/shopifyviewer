/**
 * Official Anthropic API transport and the provider routing around it:
 * the client's HTTP contract and error mapping, mode resolution, and the
 * ElementDetector's cookie → API failover (hybrid), API-only, and breaker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnthropicApiClient, ClaudeTransientError, ANTHROPIC_API_VERSION } from "../dist/ai/anthropicApiClient.js";
import { ClaudeAuthError, ClaudeRateLimitError, ClaudePayloadError } from "../dist/ai/claudeClient.js";
import { resolveAiProvider } from "../dist/ai/provider.js";
import { ElementDetector } from "../dist/ai/elementDetector.js";
import { CookiePool } from "../dist/ai/cookiePool.js";

const work = mkdtempSync(join(tmpdir(), "sv-ai-"));
process.on("exit", () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

/** A mock /v1/messages endpoint whose behaviour each test scripts. */
async function mockApi(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res, seen.length);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const okReply = (json) => (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(json) }],
    usage: { input_tokens: 120, output_tokens: 30 },
    stop_reason: "end_turn",
  }));
};

const DETECTION = { products: [{ selector: "a.card", text: "Shirt", url: "/products/blue-shirt" }], add_to_cart: { selector: "button.buy", text: "Add to cart" } };

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function cookiePool(name) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.json"), JSON.stringify([
    { name: "sessionKey", value: "sk-ant-sid01-" + "x".repeat(24) },
    { name: "lastActiveOrg", value: "11111111-2222-3333-4444-555555555555" },
  ]));
  const pool = new CookiePool(dir);
  assert.ok(pool.hasCookies(), "fixture cookie must load, otherwise these tests never exercise the cookie path");
  return pool;
}

test("client: sends the documented request and parses text + usage", async () => {
  const api = await mockApi(okReply(DETECTION));
  try {
    const client = new AnthropicApiClient({ apiKey: "sk-test", baseUrl: api.url, model: "claude-haiku-5-5" });
    const r = await client.send("find the buy button");
    assert.equal(api.seen[0].url, "/v1/messages");
    assert.equal(api.seen[0].headers["x-api-key"], "sk-test");
    assert.equal(api.seen[0].headers["anthropic-version"], ANTHROPIC_API_VERSION);
    assert.equal(api.seen[0].body.model, "claude-haiku-5-5");
    assert.deepEqual(api.seen[0].body.messages, [{ role: "user", content: "find the buy button" }]);
    assert.ok(api.seen[0].body.max_tokens > 0);
    assert.equal(r.parsed.add_to_cart.selector, "button.buy");
    assert.deepEqual(r.usage, { input: 120, output: 30 });
    assert.equal(r.accountSource, "anthropic-api");
  } finally { await api.close(); }
});

test("client: maps HTTP statuses to the error classes the detector understands", async () => {
  const cases = [
    [401, ClaudeAuthError], [403, ClaudeAuthError],
    [429, ClaudeRateLimitError],
    [529, ClaudeTransientError], [500, ClaudeTransientError], [503, ClaudeTransientError],
    [400, ClaudePayloadError], [404, ClaudePayloadError],
  ];
  for (const [status, cls] of cases) {
    const api = await mockApi((req, res) => {
      res.writeHead(status, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ type: "error", error: { type: "x", message: "m" } }));
    });
    try {
      const client = new AnthropicApiClient({ apiKey: "k", baseUrl: api.url });
      await assert.rejects(client.send("p"), (err) => err instanceof cls, `status ${status} should be ${cls.name}`);
    } finally { await api.close(); }
  }
  // retry-after is honoured on 429
  const api = await mockApi((req, res) => { res.writeHead(429, { "retry-after": "7" }); res.end("{}"); });
  try {
    await assert.rejects(new AnthropicApiClient({ apiKey: "k", baseUrl: api.url }).send("p"), (e) => e.retryAfter === 7);
  } finally { await api.close(); }
});

test("client: unreachable server and timeout are transient, not fatal", async () => {
  const dead = new AnthropicApiClient({ apiKey: "k", baseUrl: "http://127.0.0.1:9", timeoutMs: 2000 });
  await assert.rejects(dead.send("p"), (e) => e instanceof ClaudeTransientError);

  const slow = await mockApi(() => { /* never answers */ });
  try {
    const c = new AnthropicApiClient({ apiKey: "k", baseUrl: slow.url, timeoutMs: 150 });
    await assert.rejects(c.send("p"), (e) => e instanceof ClaudeTransientError && /timed out/.test(e.message));
  } finally { await slow.close(); }
});

test("client: refuses to be built without a key", () => {
  assert.throws(() => new AnthropicApiClient({ apiKey: "  " }), /apiKey/);
});

test("resolveAiProvider: defaults, explicit modes, and the missing-key downgrade", () => {
  const noKey = {};
  const withKey = { ANTHROPIC_API_KEY: "sk-env" };

  assert.equal(resolveAiProvider({}, noKey).mode, "cookie_pool");
  const auto = resolveAiProvider({}, withKey);
  assert.equal(auto.mode, "hybrid");
  assert.ok(auto.api);

  assert.equal(resolveAiProvider({ provider: "cookie_pool" }, withKey).api, undefined, "cookie_pool never builds an API client");
  assert.equal(resolveAiProvider({ provider: "anthropic_api" }, withKey).mode, "anthropic_api");

  const missing = resolveAiProvider({ provider: "anthropic_api" }, noKey);
  assert.equal(missing.mode, "cookie_pool");
  assert.match(missing.reason, /no API key/);

  const custom = resolveAiProvider({ provider: "hybrid", anthropic: { apiKeyEnv: "MY_KEY" } }, { MY_KEY: "k" });
  assert.equal(custom.mode, "hybrid");
});

test("detector hybrid: a rate-limited cookie fails over to the API in the same call", async () => {
  const api = await mockApi(okReply(DETECTION));
  try {
    const events = [];
    const detector = new ElementDetector(cookiePool("hybrid-1"), logger, {
      maxRetries: 2,
      provider: "hybrid",
      api: new AnthropicApiClient({ apiKey: "k", baseUrl: api.url }),
      client: { send: async () => { throw new ClaudeRateLimitError("a.json", 300); } },
      onProviderEvent: (e) => events.push(e.kind),
    });
    const r = await detector.detect("https://shop.example/collections/all", "<html>…</html>");
    assert.equal(r.accountSource, "anthropic-api");
    assert.equal(r.products[0].url, "/products/blue-shirt");
    assert.equal(api.seen.length, 1);
    assert.ok(events.includes("failover_to_api"), `events: ${events}`);
  } finally { await api.close(); }
});

test("detector hybrid: a healthy cookie path never touches the API", async () => {
  const api = await mockApi(okReply(DETECTION));
  try {
    const detector = new ElementDetector(cookiePool("hybrid-2"), logger, {
      provider: "hybrid",
      api: new AnthropicApiClient({ apiKey: "k", baseUrl: api.url }),
      client: { send: async () => ({ text: "", parsed: DETECTION, accountSource: "a.json", orgId: "o", elapsedMs: 1 }) },
    });
    const r = await detector.detect("https://shop.example/collections/all", "<html></html>");
    assert.equal(r.accountSource, "a.json");
    assert.equal(api.seen.length, 0, "cookie pool is first choice: the paid API must stay idle");
  } finally { await api.close(); }
});

test("detector hybrid: breaker skips the failing cookie path after repeated failures", async () => {
  const api = await mockApi(okReply(DETECTION));
  try {
    let cookieCalls = 0;
    const events = [];
    const detector = new ElementDetector(cookiePool("hybrid-3"), logger, {
      maxRetries: 1,
      provider: "hybrid",
      api: new AnthropicApiClient({ apiKey: "k", baseUrl: api.url }),
      client: { send: async () => { cookieCalls++; throw new Error("boom"); } },
      onProviderEvent: (e) => events.push(e.kind),
    });
    for (let i = 0; i < 4; i++) {
      await detector.detect(`https://shop.example/p/${i}`, "<html></html>", { skipCache: true });
    }
    assert.equal(api.seen.length, 4, "every call was still answered");
    assert.equal(cookieCalls, 2, "after 2 straight failures the breaker opens and the pool is skipped");
    assert.ok(events.includes("cookie_path_failed"));
  } finally { await api.close(); }
});

test("detector anthropic_api: never asks the cookie pool; a revoked key stops after one try", async () => {
  const ok = await mockApi(okReply(DETECTION));
  try {
    let cookieCalls = 0;
    const d = new ElementDetector(cookiePool("api-only"), logger, {
      provider: "anthropic_api",
      api: new AnthropicApiClient({ apiKey: "k", baseUrl: ok.url }),
      client: { send: async () => { cookieCalls++; throw new Error("must not be called"); } },
    });
    const r = await d.detect("https://shop.example/", "<html></html>");
    assert.equal(r.accountSource, "anthropic-api");
    assert.equal(cookieCalls, 0);
  } finally { await ok.close(); }

  const bad = await mockApi((req, res) => { res.writeHead(401); res.end("{}"); });
  try {
    const events = [];
    const d = new ElementDetector(cookiePool("api-401"), logger, {
      maxRetries: 3,
      provider: "anthropic_api",
      api: new AnthropicApiClient({ apiKey: "revoked", baseUrl: bad.url }),
      onProviderEvent: (e) => events.push(e.kind),
    });
    // Falls back to local classification rather than throwing into the session.
    await d.detect("https://shop.example/", `<a href="/products/a-b-c">A</a>`, { skipCache: true }).catch(() => undefined);
    await d.detect("https://shop.example/2", `<a href="/products/a-b-c">A</a>`, { skipCache: true }).catch(() => undefined);
    assert.equal(bad.seen.length, 1, "a rejected key is not retried or re-sent");
    assert.deepEqual(events.filter((k) => k === "api_auth_failed").length, 1);
  } finally { await bad.close(); }
});

test("detector: a Cloudflare 403 does not permanently quarantine a good cookie", async () => {
  // Real ClaudeClient against a server that answers like a Cloudflare challenge.
  const cf = await mockApi((req, res) => {
    res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
    res.end("<html><title>Just a moment...</title></html>");
  });
  try {
    const pool = cookiePool("cf");
    const { ClaudeClient } = await import("../dist/ai/claudeClient.js");
    const d = new ElementDetector(pool, logger, { maxRetries: 1, baseUrl: cf.url, client: new ClaudeClient(cf.url) });
    await d.detect("https://shop.example/", "<html></html>", { skipCache: true }).catch(() => undefined);
    const stats = pool.stats();
    assert.equal(stats.quarantined, 0, "challenge must cool the cookie down, not quarantine it");
    assert.equal(stats.cooldown, 1);
  } finally { await cf.close(); }
});
