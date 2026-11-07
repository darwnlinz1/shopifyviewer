/**
 * Alert layer: dedup, rolling-window rules, secret handling, sink delivery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { AlertManager, DiscordSink, TelegramSink, WebhookSink, buildSinks, proxyLabel } from "../dist/alerts/alertManager.js";
import { SiteViewerDb } from "../dist/storage/db.js";

function recorder() {
  const sent = [];
  return { sent, name: "rec", send: async (alert, suppressed) => { sent.push({ ...alert, suppressed }); } };
}

test("dedup: same key once per cooldown, suppressed repeats are counted, then re-armed", async () => {
  let t = 0;
  const rec = recorder();
  const m = new AlertManager({ enabled: true, sinks: [], cooldownMs: 1000 }, undefined, { sinks: [rec], now: () => t });
  const a = { key: "k", severity: "warning", title: "T", body: "B" };
  assert.equal(await m.notify(a), true);
  assert.equal(await m.notify(a), false);
  assert.equal(await m.notify(a), false);
  t = 1500;
  assert.equal(await m.notify(a), true);
  assert.equal(rec.sent.length, 2);
  assert.equal(rec.sent[1].suppressed, 2, "next delivery reports how many were swallowed");
  assert.equal(await m.notify({ ...a, key: "other" }), true, "different keys are independent");
});

test("ATC rule: needs a minimum sample, fires on collapse, not on a healthy shop", async () => {
  const rec = recorder();
  const m = new AlertManager({ enabled: true, sinks: [], atcMinAttempts: 5, atcMinSuccessRate: 0.5 }, undefined, { sinks: [rec] });
  for (let i = 0; i < 4; i++) m.recordAtc("bad.example", false);
  await Promise.resolve();
  assert.equal(rec.sent.length, 0, "4 failures is below the 5-attempt minimum");
  m.recordAtc("bad.example", false);
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.sent.length, 1);
  assert.match(rec.sent[0].title, /bad\.example/);

  for (let i = 0; i < 10; i++) m.recordAtc("good.example", i % 5 !== 0); // 80% ok
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.sent.filter((a) => /good\.example/.test(a.title)).length, 0);
});

test("ATC rule: samples age out of the rolling window", async () => {
  let t = 0;
  const rec = recorder();
  const m = new AlertManager({ enabled: true, sinks: [], atcMinAttempts: 3, atcMinSuccessRate: 0.5, windowMs: 1000 }, undefined, { sinks: [rec], now: () => t });
  m.recordAtc("s.example", false);
  m.recordAtc("s.example", false);
  t = 5000; // those two are now outside the window
  m.recordAtc("s.example", false);
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.sent.length, 0);
});

test("challenge rule: fires at threshold and the alert never contains proxy credentials", async () => {
  const rec = recorder();
  const m = new AlertManager({ enabled: true, sinks: [], challengeThreshold: 3 }, undefined, { sinks: [rec] });
  for (let i = 0; i < 3; i++) m.recordChallenge("http://user:SUPERSECRET@10.1.2.3:8080", "shop.example");
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.sent.length, 1);
  const text = JSON.stringify(rec.sent[0]);
  assert.ok(!text.includes("SUPERSECRET") && !text.includes("user:"), text);
  assert.ok(text.includes("10.1.2.3:8080"));
});

test("proxyLabel strips credentials from every common proxy spelling", () => {
  assert.equal(proxyLabel("http://u:p@h.example:3128"), "h.example:3128");
  assert.equal(proxyLabel("socks5://u:p@h.example:1080/"), "h.example:1080");
  assert.equal(proxyLabel("h.example:8000:user:pass"), "h.example:8000");
  assert.equal(proxyLabel("h.example:8000"), "h.example:8000");
  assert.equal(proxyLabel(""), "direct");
});

test("provider events map to alerts; a rejected API key is critical", async () => {
  const rec = recorder();
  const m = new AlertManager({ enabled: true, sinks: [] }, undefined, { sinks: [rec] });
  m.providerEvent({ kind: "api_auth_failed", detail: "401" });
  m.providerEvent({ kind: "cookie_pool_empty", detail: "none" });
  await new Promise((r) => setImmediate(r));
  assert.equal(rec.sent.find((a) => /key rejected/i.test(a.title)).severity, "critical");
  assert.equal(rec.sent.length, 2);
});

test("a failing sink never breaks notify, and history is stored", async () => {
  const db = new SiteViewerDb(":memory:");
  const bad = { name: "bad", send: async () => { throw new Error("down"); } };
  const good = recorder();
  const m = new AlertManager({ enabled: true, sinks: [] }, db, { sinks: [bad, good] });
  assert.equal(await m.notify({ key: "x", severity: "info", title: "hello", body: "b" }), true);
  assert.equal(good.sent.length, 1, "healthy sinks still get it");
  assert.equal(m.history()[0].title, "hello");
  db.close();
});

test("sinks speak the right wire formats", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { hits.push({ url: req.url, headers: req.headers, body: JSON.parse(b) }); res.writeHead(200); res.end("{}"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const alert = { key: "k", severity: "critical", title: "Title", body: "Body @everyone" };
  try {
    await new TelegramSink("123:ABC", "-100", fetch, base).send(alert, 0);
    await new DiscordSink(`${base}/hook`).send(alert, 3);
    await new WebhookSink(`${base}/wh`, { "x-token": "t" }).send(alert, 0);
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }

  assert.equal(hits[0].url, "/bot123:ABC/sendMessage");
  assert.equal(hits[0].body.chat_id, "-100");
  assert.match(hits[0].body.text, /Title/);
  assert.deepEqual(hits[1].body.allowed_mentions, { parse: [] }, "alert text must not ping @everyone");
  assert.match(hits[1].body.content, /3 similar alert/);
  assert.equal(hits[2].headers["x-token"], "t");
  assert.equal(hits[2].body.severity, "critical");
});

test("buildSinks reads secrets from the environment and skips malformed sinks", () => {
  const sinks = buildSinks(
    [
      { type: "telegram", chatId: "1", botTokenEnv: "TG" },
      { type: "discord", webhookUrlEnv: "DC" },
      { type: "webhook", url: "file:///etc/passwd" }, // non-http scheme: rejected
      { type: "telegram", chatId: "2" },               // no token anywhere: skipped
    ],
    { TG: "tok", DC: "https://discord.example/api/webhooks/1/x" },
  );
  assert.deepEqual(sinks.map((s) => s.name), ["telegram", "discord"]);
});
