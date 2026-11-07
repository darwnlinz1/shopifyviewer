/**
 * Claude Cookie Pool with health tracking, audit logging and persistence.
 *
 * Audit trail: every pool transition — file loaded, cookie assigned to a
 * request, success/failure/rate-limit/quarantine — is appended as one JSONL
 * line to <cookiesDir>/cookie-audit.jsonl. That gives a traceable In/Out
 * history per cookie and enough data to compute survival rates after a run.
 *
 * Health persistence: per-cookie counters are written to
 * <cookiesDir>/cookie-health.json (debounced) and reloaded on startup, so a
 * restart does not forget which cookies were failing.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync, mkdirSync, appendFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SiteViewerDb } from "../storage/db.js";

const NS_HEALTH = "cookie_health";
const NS_QUARANTINE = "cookie_quarantine";
const NS_COOLDOWN = "cookie_cooldown";
const NS_AUDIT = "cookie_audit";

export interface CookiePoolOptions {
  /**
   * Persist health, cooldowns, quarantine and the audit trail in SQLite
   * instead of side files in the cookies directory. Legacy files are imported
   * once, then left alone.
   */
  db?: SiteViewerDb;
}

export interface CookieEntry {
  source: string;
  orgId: string | null;
  cookieString: string;
  sessionKey: string;
}

export interface CookieHealth {
  source: string;
  successCount: number;
  failCount: number;
  lastUsedAt: number | null;
  lastErrorAt: number | null;
  consecutiveFails: number;
}

export interface PoolStats {
  totalLoaded: number;
  active: number;
  quarantined: number;
  cooldown: number;
  healthy: number;
  degraded: number;
}

// --- Parsers ---

function parseNetscape(text: string): { cookieString: string; sessionKey: string | null; orgId: string | null } {
  const parts: string[] = [];
  let sessionKey: string | null = null;
  let orgId: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    // "#HttpOnly_" is the curl convention for an httpOnly cookie — the line
    // is real data, not a comment. Only other "#" lines are comments.
    const httpOnly = t.startsWith("#HttpOnly_");
    const body = httpOnly ? t.slice("#HttpOnly_".length) : t;
    if (!body || body.startsWith("#")) continue;
    const f = body.split("\t");
    if (f.length < 7) continue;
    const name = f[5]; const value = f[6] ?? "";
    if (!name) continue;
    parts.push(name + "=" + value);
    if (name === "sessionKey") sessionKey = value;
    if (name === "lastActiveOrg") orgId = value;
  }
  return { cookieString: parts.join("; "), sessionKey, orgId };
}

function parseJson(text: string): { cookieString: string; sessionKey: string | null; orgId: string | null } {
  let data: any;
  try { data = JSON.parse(text); } catch { return { cookieString: "", sessionKey: null, orgId: null }; }
  const entries = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : [];
  if (!entries.length) return { cookieString: "", sessionKey: null, orgId: null };
  const parts: string[] = [];
  let sk: string | null = null, oid: string | null = null;
  for (const e of entries) {
    if (!e.name || e.value === undefined) continue;
    parts.push(e.name + "=" + e.value);
    if (e.name === "sessionKey") sk = String(e.value);
    if (e.name === "lastActiveOrg") oid = String(e.value);
  }
  return { cookieString: parts.join("; "), sessionKey: sk, orgId: oid };
}

const QUARANTINE_FILE = ".cookie-quarantine.json";
const HEALTH_FILE = "cookie-health.json";
const AUDIT_FILE = "cookie-audit.jsonl";
const MAX_CONSECUTIVE_FAILS = 3;

type AuditEvent =
  | { event: "pool_loaded"; scanned: number; accepted: number; rejectedNoOrg: number; previouslyQuarantined: number }
  | { event: "assigned"; cookie: string; candidates: number; inFlight: number }
  | { event: "success"; cookie: string; totalSuccess: number }
  | { event: "failure"; cookie: string; consecutiveFails: number; totalFails: number; reason?: string }
  | { event: "rate_limited"; cookie: string; cooldownMs: number }
  | { event: "cooldown_expired"; cookie: string }
  | { event: "invalid_quarantined"; cookie: string; reason: string }
  | { event: "pool_summary"; stats: PoolStats; survivalRatePct: number; reason: string };

export class CookiePool {
  private pool: CookieEntry[] = [];
  private quarantined = new Map<string, any>();
  private cooldownUntil = new Map<string, number>();
  private activeRequests = new Map<string, number>();
  private health = new Map<string, CookieHealth>();
  /** Files that parsed but were rejected (no org id / no session key). */
  private rejectedFiles = new Map<string, string>();
  totalLoaded = 0;
  deadCount = 0;
  private readonly baseDir: string;
  private healthDirty = false;
  private lastHealthFlush = 0;

  private readonly db: SiteViewerDb | undefined;

  constructor(private readonly cookiesDir: string, options: CookiePoolOptions = {}) {
    this.baseDir = resolve(cookiesDir);
    this.db = options.db;
    mkdirSync(this.baseDir, { recursive: true });
    this.loadAll();
  }

  // ── Audit plumbing ──

  private audit(entry: AuditEvent): void {
    if (this.db) {
      try {
        const { event, ...rest } = entry;
        this.db.appendEvent(NS_AUDIT, event, rest);
      } catch { /* auditing must never break the pool */ }
      return;
    }
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      appendFileSync(join(this.baseDir, AUDIT_FILE), line, "utf8");
    } catch { /* auditing must never break the pool */ }
  }

  /** Append the current pool standing (survival rate etc.) to the audit. */
  auditSummary(reason: string): void {
    const stats = this.stats();
    const survival = stats.totalLoaded > 0 ? Math.round((stats.active / stats.totalLoaded) * 1000) / 10 : 100;
    this.audit({ event: "pool_summary", stats, survivalRatePct: survival, reason });
  }

  private scheduleHealthFlush(): void {
    this.healthDirty = true;
    const now = Date.now();
    if (now - this.lastHealthFlush < 5000) return;
    this.flushHealth();
  }

  /** Force-write pending health state (call at run end). */
  flushHealth(): void {
    if (!this.healthDirty) return;
    this.healthDirty = false;
    this.lastHealthFlush = Date.now();
    if (this.db) {
      try {
        const db = this.db;
        db.transaction(() => {
          for (const [source, h] of this.health) db.putDoc(NS_HEALTH, source, h);
          const now = Date.now();
          for (const { key } of db.listDocs(NS_COOLDOWN)) {
            if ((this.cooldownUntil.get(key) ?? 0) <= now) db.deleteDoc(NS_COOLDOWN, key);
          }
          for (const [source, until] of this.cooldownUntil) {
            if (until > now) db.putDoc(NS_COOLDOWN, source, until);
          }
        });
      } catch { this.healthDirty = true; /* retry on the next tick */ }
      return;
    }
    try {
      const data = {
        version: 2,
        health: Object.fromEntries(this.health),
        // Persist cooldowns too: a rate limit that outlives the process
        // should still be honoured by the next run.
        cooldowns: Object.fromEntries([...this.cooldownUntil.entries()].filter(([, t]) => t > Date.now())),
      };
      const p = join(this.baseDir, HEALTH_FILE);
      const tmp = p + "." + randomUUID().slice(0, 8) + ".tmp";
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmp, p);
    } catch { /* best effort */ }
  }

  loadAll(): void {
    this.pool = [];
    this.quarantined.clear();
    this.rejectedFiles.clear();
    this.loadQuarantine();
    const dir = this.baseDir;
    let scanned = 0;
    let rejectedNoOrg = 0;
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith(".txt") && !f.name.endsWith(".json")) continue;
      if (f.name === QUARANTINE_FILE || f.name === HEALTH_FILE || f.name === AUDIT_FILE) continue;
      scanned++;
      try {
        const filePath = join(dir, f.name);
        // A quarantine record stores the mtime the file had when it failed.
        // An unchanged file stays excluded, but a re-export saved over the
        // same name gets a fresh chance — otherwise refreshing dead browser
        // cookies could never bring them back.
        let mtimeMs = 0;
        try { mtimeMs = statSync(filePath).mtimeMs; } catch { /* unreadable */ }
        const q = this.quarantined.get(f.name);
        if (q && typeof q.mtimeMs === "number" && Math.abs(q.mtimeMs - mtimeMs) < 1) continue;
        const content = readFileSync(filePath, "utf8").trim();
        if (!content) continue;
        let parsed: { cookieString: string; sessionKey: string | null; orgId: string | null };
        if (content.startsWith("[") || content.startsWith("{")) {
          parsed = parseJson(content);
        } else if (content.includes("\t")) {
          parsed = parseNetscape(content);
        } else {
          parsed = { cookieString: content, sessionKey: null, orgId: null };
        }
        if (!parsed.sessionKey || !parsed.cookieString) {
          this.rejectedFiles.set(f.name, "missing_session_key");
          continue;
        }
        if (parsed.cookieString.indexOf("sessionKey=") === -1) {
          this.rejectedFiles.set(f.name, "missing_session_key");
          continue;
        }
        let orgId = parsed.orgId;
        if (!orgId) orgId = this.extractOrgId(parsed.cookieString);
        if (!orgId) {
          rejectedNoOrg++;
          this.rejectedFiles.set(f.name, "no_org_id");
          this.quarantine(f.name, "no_org_id", mtimeMs);
          continue;
        }
        // The file now parses and validates: clear any stale quarantine so
        // the record matches reality again.
        if (q) {
          this.quarantined.delete(f.name);
          this.persistQuarantine();
        }
        this.pool.push({ source: f.name, orgId, cookieString: parsed.cookieString, sessionKey: parsed.sessionKey });
        // Restore persisted counters, keep in-run increments on top.
        const prior = this.persistedHealth.get(f.name);
        this.health.set(f.name, prior
          ? { ...prior, source: f.name }
          : { source: f.name, successCount: 0, failCount: 0, lastUsedAt: null, lastErrorAt: null, consecutiveFails: 0 });
      } catch { /* skip */ }
    }
    this.totalLoaded = this.pool.length + this.quarantined.size;
    this.audit({
      event: "pool_loaded",
      scanned,
      accepted: this.pool.length,
      rejectedNoOrg,
      previouslyQuarantined: this.quarantined.size,
    });
    this.auditSummary("load");
  }

  hasCookies(): boolean { return this.pool.length > 0; }

  /** Get next healthy cookie. Skips cookies with >= MAX_CONSECUTIVE_FAILS. */
  getNext(exclude?: Set<string>): CookieEntry | undefined {
    const now = Date.now();
    for (const [s, t] of this.cooldownUntil) {
      if (t <= now) { this.cooldownUntil.delete(s); this.audit({ event: "cooldown_expired", cookie: s }); }
    }
    let cands = this.pool.filter(c => {
      if ((this.cooldownUntil.get(c.source) ?? 0) > now) return false;
      const h = this.health.get(c.source);
      if (h && h.consecutiveFails >= MAX_CONSECUTIVE_FAILS) return false;
      return true;
    });
    if (exclude?.size) cands = cands.filter(c => !exclude.has(c.source));
    // If all unhealthy, reset and try again — BUT keep cooldown filter.
    // Without it, a rate-limited cookie is reissued under full load and
    // triggers a 429 storm across every concurrent session.
    if (!cands.length) {
      for (const h of this.health.values()) h.consecutiveFails = Math.max(0, h.consecutiveFails - 1);
      cands = this.pool.filter(c => {
        if ((this.cooldownUntil.get(c.source) ?? 0) > now) return false;
        return !exclude?.has(c.source);
      });
    }
    if (!cands.length) return undefined;
    const minAct = Math.min(...cands.map(c => this.activeRequests.get(c.source) ?? 0));
    const balanced = cands.filter(c => (this.activeRequests.get(c.source) ?? 0) === minAct);
    // Prefer cookies with more successes
    balanced.sort((a, b) => (this.health.get(b.source)?.successCount ?? 0) - (this.health.get(a.source)?.successCount ?? 0));
    const pick = balanced[Math.floor(Math.random() * Math.min(5, balanced.length))] ?? balanced[0];
    if (pick) {
      // Atomic: reserve the slot inside getNext so two concurrent callers
      // never grab the same least-loaded cookie (race on beginRequest).
      this.activeRequests.set(pick.source, (this.activeRequests.get(pick.source) ?? 0) + 1);
      const h = this.health.get(pick.source);
      if (h) h.lastUsedAt = now;
      this.audit({
        event: "assigned",
        cookie: pick.source,
        candidates: cands.length,
        inFlight: this.activeRequests.get(pick.source) ?? 0,
      });
      this.scheduleHealthFlush();
    }
    return pick;
  }

  /** @deprecated Use getNext() which now atomically reserves the slot. */
  beginRequest(_source: string): void { /* no-op — slot already reserved */ }

  endRequest(source: string): void {
    const r = (this.activeRequests.get(source) ?? 0) - 1;
    if (r > 0) this.activeRequests.set(source, r); else this.activeRequests.delete(source);
  }

  markSuccess(source: string): void {
    const h = this.health.get(source);
    if (h) {
      h.successCount++;
      h.consecutiveFails = 0;
      this.audit({ event: "success", cookie: source, totalSuccess: h.successCount });
      this.scheduleHealthFlush();
    }
  }

  markFailure(source: string, reason?: string): void {
    const h = this.health.get(source);
    if (h) {
      h.failCount++;
      h.consecutiveFails++;
      h.lastErrorAt = Date.now();
      this.audit({ event: "failure", cookie: source, consecutiveFails: h.consecutiveFails, totalFails: h.failCount, ...(reason ? { reason } : {}) });
      this.scheduleHealthFlush();
    }
  }

  markRateLimited(source: string, ms = 300_000): void {
    this.cooldownUntil.set(source, Math.max(this.cooldownUntil.get(source) ?? 0, Date.now() + ms));
    this.markFailure(source, "rate_limited");
    this.audit({ event: "rate_limited", cookie: source, cooldownMs: ms });
  }

  markInvalid(source: string, reason = "auth_failed"): void {
    this.pool = this.pool.filter(c => c.source !== source);
    this.cooldownUntil.delete(source);
    this.activeRequests.delete(source);
    this.health.delete(source);
    this.deadCount++;
    // Record the file's mtime so re-exporting fresh browser cookies over the
    // same filename is honoured on the next start instead of staying dead.
    let mtimeMs: number | undefined;
    try { mtimeMs = statSync(join(this.baseDir, source)).mtimeMs; } catch { /* gone */ }
    this.quarantine(source, reason, mtimeMs);
    this.audit({ event: "invalid_quarantined", cookie: source, reason });
  }

  stats(): PoolStats {
    const now = Date.now();
    let healthy = 0, degraded = 0;
    for (const h of this.health.values()) {
      if (h.consecutiveFails >= MAX_CONSECUTIVE_FAILS) degraded++;
      else healthy++;
    }
    return {
      totalLoaded: this.totalLoaded,
      active: this.pool.length,
      quarantined: this.quarantined.size,
      cooldown: [...this.cooldownUntil.values()].filter(t => t > now).length,
      healthy,
      degraded,
    };
  }

  private extractOrgId(cookieString: string): string | null {
    const match = cookieString.match(/lastActiveOrg=([a-f0-9\-]{36})/);
    return match ? (match[1] ?? null) : null;
  }

  private loadQuarantine(): void {
    if (this.db) {
      this.importLegacyFiles(this.db);
      for (const { key, value } of this.db.listDocs<any>(NS_QUARANTINE)) this.quarantined.set(key, value);
      for (const { key, value } of this.db.listDocs<CookieHealth>(NS_HEALTH)) this.persistedHealth.set(key, value);
      const now = Date.now();
      for (const { key, value } of this.db.listDocs<number>(NS_COOLDOWN)) {
        if (Number.isFinite(value) && value > now) this.cooldownUntil.set(key, value);
      }
      return;
    }
    try {
      const d = JSON.parse(readFileSync(join(this.baseDir, QUARANTINE_FILE), "utf8"));
      for (const [s, m] of Object.entries(d)) this.quarantined.set(s, m);
    } catch { /* none yet */ }
    // Health + cooldown history from previous runs. v2 wraps both; the legacy
    // flat map (health only) is still accepted.
    try {
      const raw = JSON.parse(readFileSync(join(this.baseDir, HEALTH_FILE), "utf8"));
      if (raw && raw.version === 2) {
        for (const [s, v] of Object.entries(raw.health ?? {})) this.persistedHealth.set(s, v as CookieHealth);
        const now = Date.now();
        for (const [s, t] of Object.entries(raw.cooldowns ?? {})) {
          const until = Number(t);
          if (Number.isFinite(until) && until > now) this.cooldownUntil.set(s, until);
        }
      } else {
        for (const [s, v] of Object.entries(raw ?? {})) this.persistedHealth.set(s, v as CookieHealth);
      }
    } catch { /* first run */ }
  }

  private readonly persistedHealth = new Map<string, CookieHealth>();

  /** One-time import of the pre-SQLite side files; the files are renamed, never deleted. */
  private importLegacyFiles(db: SiteViewerDb): void {
    if (db.countDocs(NS_HEALTH) + db.countDocs(NS_QUARANTINE) > 0) return;
    const quarantineFile = join(this.baseDir, QUARANTINE_FILE);
    const healthFile = join(this.baseDir, HEALTH_FILE);
    try {
      db.transaction(() => {
        if (existsSync(quarantineFile)) {
          const q = JSON.parse(readFileSync(quarantineFile, "utf8"));
          for (const [source, meta] of Object.entries(q ?? {})) db.putDoc(NS_QUARANTINE, source, meta);
        }
        if (existsSync(healthFile)) {
          const raw = JSON.parse(readFileSync(healthFile, "utf8"));
          const health = raw && raw.version === 2 ? raw.health ?? {} : raw ?? {};
          for (const [source, h] of Object.entries(health)) db.putDoc(NS_HEALTH, source, h);
          for (const [source, until] of Object.entries(raw?.cooldowns ?? {})) db.putDoc(NS_COOLDOWN, source, Number(until));
        }
      });
      for (const f of [quarantineFile, healthFile]) {
        if (existsSync(f)) renameSync(f, f + ".migrated");
      }
    } catch { /* unreadable legacy state is only lost history */ }
  }

  private persistQuarantine(): void {
    if (this.db) {
      try {
        const db = this.db;
        db.transaction(() => {
          const known = new Set(this.quarantined.keys());
          for (const { key } of db.listDocs(NS_QUARANTINE)) if (!known.has(key)) db.deleteDoc(NS_QUARANTINE, key);
          for (const [source, meta] of this.quarantined) db.putDoc(NS_QUARANTINE, source, meta);
        });
      } catch { /* best effort */ }
      return;
    }
    const p = join(this.baseDir, QUARANTINE_FILE);
    const tmp = p + "." + randomUUID().slice(0, 8) + ".tmp";
    const data: Record<string, any> = {};
    for (const [s, m] of this.quarantined) data[s] = m;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      renameSync(tmp, p);
    } catch { try { unlinkSync(tmp); } catch {} }
  }

  private quarantine(source: string, reason: string, mtimeMs?: number): void {
    const entry: { reason: string; at: number; mtimeMs?: number } = { reason, at: Date.now() };
    if (typeof mtimeMs === "number" && mtimeMs > 0) entry.mtimeMs = mtimeMs;
    this.quarantined.set(source, entry);
    this.persistQuarantine();
  }
}
