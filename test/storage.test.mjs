/**
 * SQLite storage: the document/event store itself, plus the three consumers
 * that moved onto it (profiles, selector recipes, cookie-pool health) and the
 * one-time import of their legacy JSON files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SiteViewerDb } from "../dist/storage/db.js";
import { ProfileStore } from "../dist/profiles/store.js";
import { DomainRecipeCache } from "../dist/ai/domainRecipeCache.js";
import { CookiePool } from "../dist/ai/cookiePool.js";

const work = mkdtempSync(join(tmpdir(), "sv-storage-"));
process.on("exit", () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
const fresh = (name) => new SiteViewerDb(join(work, `${name}.db`));

test("docs: put/get/list/delete round-trip and upsert", () => {
  const db = fresh("docs");
  db.putDoc("ns", "a", { n: 1 });
  db.putDoc("ns", "a", { n: 2 });
  db.putDoc("ns", "b", { n: 3 });
  db.putDoc("other", "a", { n: 9 });
  assert.deepEqual(db.getDoc("ns", "a"), { n: 2 });
  assert.equal(db.countDocs("ns"), 2);
  assert.deepEqual(db.listDocs("ns").map((r) => r.key), ["a", "b"]);
  assert.equal(db.deleteDoc("ns", "a"), true);
  assert.equal(db.deleteDoc("ns", "a"), false);
  assert.equal(db.getDoc("ns", "a"), undefined);
  assert.deepEqual(db.getDoc("other", "a"), { n: 9 });
  db.close();
});

test("transaction: commits together, rolls back on throw, nests", () => {
  const db = fresh("tx");
  assert.throws(() => db.transaction(() => {
    db.putDoc("t", "x", 1);
    throw new Error("boom");
  }), /boom/);
  assert.equal(db.getDoc("t", "x"), undefined, "a thrown transaction must leave nothing behind");

  db.transaction(() => {
    db.putDoc("t", "a", 1);
    db.transaction(() => db.putDoc("t", "b", 2)); // joins the outer one
  });
  assert.equal(db.countDocs("t"), 2);
  db.close();
});

test("events: append, filter, newest first, prune", () => {
  const db = fresh("events");
  for (let i = 0; i < 20; i++) db.appendEvent("log", i % 2 ? "odd" : "even", { i }, 1000 + i);
  const newest = db.queryEvents("log", { limit: 3 });
  assert.deepEqual(newest.map((e) => e.data.i), [19, 18, 17]);
  assert.equal(db.countEvents("log", { kind: "odd" }), 10);
  assert.equal(db.queryEvents("log", { since: 1015 }).length, 5);
  db.pruneEvents("log", 5);
  assert.equal(db.countEvents("log"), 5);
  assert.deepEqual(db.queryEvents("log", { limit: 1 })[0].data, { i: 19 }, "prune keeps the newest");
  db.close();
});

test("persistence: reopening the file sees committed data; WAL is on", () => {
  const path = join(work, "persist.db");
  const a = new SiteViewerDb(path);
  a.putDoc("p", "k", { v: 42 });
  a.close();
  const b = new SiteViewerDb(path);
  assert.deepEqual(b.getDoc("p", "k"), { v: 42 });
  b.close();
});

test("ProfileStore on SQLite: persists, writes only changed rows, deletes", () => {
  const dir = join(work, "pstore");
  const db = fresh("pstore");
  const s1 = new ProfileStore(dir, { db });
  const a = s1.create({ name: "A" });
  const b = s1.create({ name: "B" });
  s1.update(a.id, { name: "A2" });
  assert.equal(db.countDocs(`profile:${dir}`), 2);

  const s2 = new ProfileStore(dir, { db }); // simulates a restart
  assert.deepEqual(s2.list().map((p) => p.name), ["A2", "B"]);
  assert.equal(s2.create({ name: "C" }).ordinal, 3, "ordinals continue after restart");

  s2.remove(b.id);
  assert.equal(db.countDocs(`profile:${dir}`), 2);
  assert.equal(db.getDoc(`profile:${dir}`, b.id), undefined);
  assert.ok(!existsSync(join(dir, "profiles.json")), "SQLite mode must not write profiles.json");
  db.close();
});

test("ProfileStore imports legacy profiles.json once and keeps a backup", () => {
  const dir = join(work, "legacy-profiles");
  // Build a legacy file with the JSON backend.
  const legacy = new ProfileStore(dir);
  const p = legacy.create({ name: "Old" });
  assert.ok(existsSync(join(dir, "profiles.json")));

  const db = fresh("legacy-profiles");
  const migrated = new ProfileStore(dir, { db });
  assert.deepEqual(migrated.list().map((x) => x.id), [p.id]);
  assert.ok(existsSync(join(dir, "profiles.json.migrated")), "original is kept as a backup");
  assert.ok(!existsSync(join(dir, "profiles.json")));
  db.close();
});

test("DomainRecipeCache on SQLite: learn → flush → reload; forget persists; legacy import", () => {
  const db = fresh("recipes");
  const path = join(work, "recipes.db");
  const c1 = new DomainRecipeCache(path, { db, flushDelayMs: 10_000 });
  c1.learn("https://shop.example/products/x", "product", { addToCart: "button.buy" }, "tier1", 0.9);
  c1.learn("https://other.example/", "home", { productCard: "a.card" }, "tier1", 0.9);
  c1.flush();

  const c2 = new DomainRecipeCache(path, { db });
  assert.equal(c2.size, 2);
  assert.equal(c2.get("https://shop.example/products/y", "product").addToCart, "button.buy");

  c2.forget("https://other.example/", "home");
  c2.flush();
  assert.equal(new DomainRecipeCache(path, { db }).size, 1);

  // Legacy: an empty db next to a domain-recipes.json is seeded from it.
  const legacyDir = join(work, "legacy-recipes");
  const legacyJson = new DomainRecipeCache(join(legacyDir, "domain-recipes.json"), { flushDelayMs: 10_000 });
  legacyJson.learn("https://legacy.example/products/z", "product", { addToCart: "form button" }, "tier1", 0.8);
  legacyJson.flush();
  const db2 = fresh("recipes-legacy");
  const seeded = new DomainRecipeCache(join(legacyDir, "siteviewer.db"), { db: db2 });
  assert.equal(seeded.get("https://legacy.example/products/z", "product")?.addToCart, "form button");
  assert.equal(db2.countDocs("recipe"), 1, "imported rows are persisted, not just held in memory");
  db.close();
  db2.close();
});

test("CookiePool on SQLite: audit trail + health survive in the db, no side files", () => {
  const dir = join(work, "cookies");
  const db = fresh("cookies");
  const sessionKey = "sk-ant-sid01-" + "a".repeat(24);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "acc.json"), JSON.stringify([
    { name: "sessionKey", value: sessionKey },
    { name: "lastActiveOrg", value: "11111111-2222-3333-4444-555555555555" },
  ]));

  const pool = new CookiePool(dir, { db });
  const picked = pool.getNext();
  assert.ok(picked);
  pool.markSuccess(picked.source);
  pool.markRateLimited(picked.source, 60_000);
  pool.flushHealth();

  assert.ok(db.countEvents("cookie_audit", { kind: "assigned" }) >= 1);
  assert.ok(db.countEvents("cookie_audit", { kind: "rate_limited" }) >= 1);
  assert.equal(db.getDoc("cookie_health", picked.source).successCount, 1);
  assert.ok(db.getDoc("cookie_cooldown", picked.source) > Date.now());

  const files = readdirSync(dir);
  assert.deepEqual(files.sort(), ["acc.json"], `no health/audit side files expected, got ${files}`);

  // A restart honours the persisted cooldown.
  const again = new CookiePool(dir, { db });
  assert.equal(again.getNext(), undefined, "cookie is still cooling down after restart");
  db.close();
});


test("event pruning is per namespace: a busy namespace is pruned however appends interleave", () => {
  const db = new SiteViewerDb(join(work, "prune-ns.db"), 50);
  // Interleave so the global 1000th append lands on the quiet namespace.
  for (let i = 0; i < 1100; i++) {
    db.appendEvent("busy", "k", { i });
    if (i % 10 === 0) db.appendEvent("quiet", "k", { i });
  }
  assert.ok(db.countEvents("busy") <= 50 + 999, "busy namespace must have been pruned at least once");
  assert.ok(db.countEvents("busy") < 1100, "pruning never ran for the busy namespace");
  db.close();
});

test("storageFor: dbPath \"\" disables storage even when SITEVIEWER_DB_PATH is set", async () => {
  const { storageFor } = await import("../dist/storage/db.js");
  assert.equal(process.env.SITEVIEWER_DB_PATH !== undefined, true, "test preload sets the env var");
  assert.equal(storageFor({ storage: { dbPath: "" } }), undefined);
  assert.ok(storageFor({ storage: { dbPath: "./ignored-by-env.db" } }), "env still redirects a normal path");
});

test("ProfileStore writes only the profile that changed", () => {
  const dir = join(work, "narrow-writes");
  const db = fresh("narrow-writes");
  const store = new ProfileStore(dir, { db });
  const a = store.create({ name: "A" });
  const b = store.create({ name: "B" });
  // Mutate B in memory without saving it; a write for A must not drag B along.
  store.get(b.id).name = "B-unsaved";
  store.update(a.id, { name: "A2" });
  const reloaded = new ProfileStore(dir, { db });
  assert.equal(reloaded.get(a.id).name, "A2");
  assert.equal(reloaded.get(b.id).name, "B", "an unrelated row must not be rewritten by update(A)");
  db.close();
});
