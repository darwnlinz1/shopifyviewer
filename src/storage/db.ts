/**
 * Embedded SQLite storage (Node's built-in `node:sqlite`, no native addon).
 *
 * Why this exists: the old persistence was one file per concern, rewritten
 * whole on every change — `profiles.json` (every profile, cookie jars
 * included) on each edit, `cookie-health.json`, `cookie-quarantine.json`, the
 * recipe file — plus a synchronous `appendFileSync` for every cookie-audit
 * event. With dozens of live profiles on Windows that is a steady stream of
 * whole-file rewrites that contend with antivirus and with each other
 * (EBUSY), and a crash mid-write could cost a profile's cookie jar.
 *
 * One database in WAL mode gives atomic multi-row transactions, row-level
 * upserts (only what changed is written), concurrent readers while a write is
 * in flight, and crash safety from the journal rather than from rename tricks.
 *
 * The schema is deliberately small and generic:
 *   docs    (ns, key) → JSON document   — profiles, recipes, cookie health…
 *   events  append-only log             — cookie audit, alert history
 * Each consumer owns a namespace, so adding one never needs a migration.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Bump when the DDL below changes; migrations run in order from user_version. */
const SCHEMA_VERSION = 1;

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        ns         TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        json       TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS events (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        ts   INTEGER NOT NULL,
        ns   TEXT    NOT NULL,
        kind TEXT    NOT NULL,
        json TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_ns_ts ON events (ns, ts);
      CREATE INDEX IF NOT EXISTS events_ns_kind ON events (ns, kind, ts);
    `);
  },
];

export interface StoredEvent<T = unknown> {
  id: number;
  ts: number;
  ns: string;
  kind: string;
  data: T;
}

export interface EventQuery {
  kind?: string;
  /** Only events at or after this epoch-ms. */
  since?: number;
  /** Newest first, capped. Default 200. */
  limit?: number;
}

export class SiteViewerDb {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private txDepth = 0;
  private readonly appendsSincePrune = new Map<string, number>();
  private closed = false;

  constructor(path: string, private readonly maxEventsPerNs = 100_000) {
    this.path = path === ":memory:" ? path : resolve(process.cwd(), path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    // WAL: readers never block the writer and vice versa. NORMAL sync is the
    // documented WAL pairing — durable across app crashes, and a power cut can
    // lose at most the last few commits, never corrupt the file.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    // Another process (a second dashboard, a CLI run) may hold the write lock
    // for a moment; wait instead of throwing SQLITE_BUSY.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA temp_store = MEMORY");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    let version = row.user_version;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `Database ${this.path} is schema v${version}, newer than this build (v${SCHEMA_VERSION}). Upgrade SiteViewer.`,
      );
    }
    while (version < SCHEMA_VERSION) {
      const step = MIGRATIONS[version];
      if (!step) throw new Error(`Missing migration ${version} → ${version + 1}`);
      this.transaction(() => {
        step(this.db);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
      version++;
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /**
   * Run `fn` atomically. Nested calls join the outer transaction, so a helper
   * that opens its own can still be composed into a larger atomic unit.
   * Throwing rolls everything back.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    // IMMEDIATE takes the write lock up front: no deadlock from two readers
    // trying to upgrade at the same moment.
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  // ── documents ──

  getDoc<T>(ns: string, key: string): T | undefined {
    const row = this.stmt("SELECT json FROM docs WHERE ns = ? AND key = ?").get(ns, key) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  putDoc(ns: string, key: string, value: unknown): void {
    this.stmt(
      "INSERT INTO docs (ns, key, json, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (ns, key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
    ).run(ns, key, JSON.stringify(value), Date.now());
  }

  deleteDoc(ns: string, key: string): boolean {
    return Number(this.stmt("DELETE FROM docs WHERE ns = ? AND key = ?").run(ns, key).changes) > 0;
  }

  listDocs<T>(ns: string): Array<{ key: string; value: T; updatedAt: number }> {
    const rows = this.stmt("SELECT key, json, updated_at FROM docs WHERE ns = ? ORDER BY key").all(ns) as Array<{
      key: string;
      json: string;
      updated_at: number;
    }>;
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.json) as T, updatedAt: r.updated_at }));
  }

  countDocs(ns: string): number {
    const row = this.stmt("SELECT COUNT(*) AS n FROM docs WHERE ns = ?").get(ns) as { n: number };
    return Number(row.n);
  }

  // ── events ──

  appendEvent(ns: string, kind: string, data: unknown, ts: number = Date.now()): void {
    this.stmt("INSERT INTO events (ts, ns, kind, json) VALUES (?, ?, ?, ?)").run(ts, ns, kind, JSON.stringify(data));
    // Counted per namespace: a busy one (cookie_audit) must reach its own
    // threshold however many appends other namespaces interleave.
    const n = (this.appendsSincePrune.get(ns) ?? 0) + 1;
    if (n >= 1000) {
      this.appendsSincePrune.set(ns, 0);
      this.pruneEvents(ns, this.maxEventsPerNs);
    } else {
      this.appendsSincePrune.set(ns, n);
    }
  }

  queryEvents<T = unknown>(ns: string, q: EventQuery = {}): Array<StoredEvent<T>> {
    const where = ["ns = ?"];
    const args: Array<string | number> = [ns];
    if (q.kind) { where.push("kind = ?"); args.push(q.kind); }
    if (q.since !== undefined) { where.push("ts >= ?"); args.push(q.since); }
    args.push(Math.max(1, Math.min(10_000, q.limit ?? 200)));
    const rows = this.db
      .prepare(`SELECT id, ts, ns, kind, json FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...args) as Array<{ id: number; ts: number; ns: string; kind: string; json: string }>;
    return rows.map((r) => ({ id: r.id, ts: r.ts, ns: r.ns, kind: r.kind, data: JSON.parse(r.json) as T }));
  }

  countEvents(ns: string, q: { kind?: string; since?: number } = {}): number {
    const where = ["ns = ?"];
    const args: Array<string | number> = [ns];
    if (q.kind) { where.push("kind = ?"); args.push(q.kind); }
    if (q.since !== undefined) { where.push("ts >= ?"); args.push(q.since); }
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where.join(" AND ")}`).get(...args) as { n: number };
    return Number(row.n);
  }

  /** Keep only the newest `keep` events of a namespace. */
  pruneEvents(ns: string, keep: number): number {
    const res = this.stmt(
      "DELETE FROM events WHERE ns = ? AND id <= (SELECT id FROM events WHERE ns = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
    ).run(ns, ns, Math.max(0, keep));
    return Number(res.changes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    this.db.close();
  }
}

const open = new Map<string, SiteViewerDb>();
let exitHook = false;

/** One connection per file for the whole process. */
export function openDb(path: string): SiteViewerDb {
  const key = path === ":memory:" ? path : resolve(process.cwd(), path);
  let db = open.get(key);
  if (!db) {
    db = new SiteViewerDb(key);
    open.set(key, db);
  }
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => closeAllDbs());
  }
  return db;
}

export function closeAllDbs(): void {
  for (const db of open.values()) {
    try { db.close(); } catch { /* shutting down */ }
  }
  open.clear();
}

export const DEFAULT_DB_PATH = "./data/siteviewer.db";

/**
 * The database a run should use, or undefined when storage is disabled
 * (`dbPath: ""`) or SQLite cannot be opened. Callers then keep their legacy
 * file persistence, so a broken database never stops the fleet from running.
 */
export function storageFor(
  config: { storage?: { dbPath?: string } },
  onError?: (err: unknown) => void,
): SiteViewerDb | undefined {
  // An explicit `dbPath: ""` disables storage outright: an environment variable
  // must not re-enable it for some processes and leave others on JSON files.
  if (config.storage?.dbPath === "") return undefined;
  // Otherwise SITEVIEWER_DB_PATH wins when set: lets a container or a test
  // harness point the database at a scratch location without editing config.
  const path = process.env.SITEVIEWER_DB_PATH || config.storage?.dbPath;
  if (!path) return undefined;
  try {
    return openDb(path);
  } catch (err) {
    onError?.(err);
    return undefined;
  }
}
