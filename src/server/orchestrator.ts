/**
 * Orchestrator — profiles on one side, live browser sessions on the other.
 *
 * The dashboard talks only to this: it holds the profile registry, the
 * sessions currently running, and the screencast tap for each one. Everything
 * it exposes is keyed by *profile* id rather than session id, because a
 * profile is the thing the operator manages and a session is just what it is
 * doing right now.
 */
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SimulatorConfig } from "../config.js";
import { DEFAULT_CONFIG } from "../config.js";
import { Logger } from "../logging/logger.js";
import { preflight, hardWriteCookies, writeJarToProfileDir, captureContextCookies, findSystemChrome, detectBrowserEngineBranding } from "../browser/chrome.js";
import { startSession, type SessionHandle, type SessionSnapshot } from "../session/aiManager.js";
import { ProfileStore, type CreateProfileInput, type UpdateProfileInput } from "../profiles/store.js";
import { CookiePool } from "../ai/cookiePool.js";
import { parseCookieText, type ParsedCookieFile } from "../profiles/cookies.js";
import { testProxy } from "../profiles/proxy.js";
import { resolveGeoFromFilename, type GeoInfo } from "../profiles/geo.js";
import type { Profile, ProfileDevice } from "../profiles/types.js";
import { Screencast } from "./screencast.js";
import { describeIdentity } from "../browser/identity.js";

import { AdaptiveLauncher } from "../performance/AdaptiveLauncher.js";

/** A profile plus whatever it is doing right now. */
export interface ProfileView {
  profile: Profile;
  /** Live session state, or null when the profile has no browser open. */
  session: SessionSnapshot | null;
  /** Whether a live view is available to stream. */
  streaming: boolean;
  identity: string;
}

interface LiveSession {
  handle: SessionHandle;
  screencast: Screencast;
}

export interface OrchestratorEvents {
  /** Any change worth pushing to the dashboard. */
  update: [ProfileView[]];
}

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  readonly store: ProfileStore;
  private readonly sessions = new Map<string, LiveSession>();
  /** Profiles whose startProfile is in-flight (stagger + launch). Prevents
   * a double-click or /start + /continue race from launching two Chrome
   * processes against the same user-data directory. */
  private readonly launching = new Set<string>();
  private readonly logger: Logger;

  // ── Coalesced Push Engine (600ms Tick / 1.6Hz Throttle) ──
  private isDirty = true;
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly launcher = new AdaptiveLauncher({ maxConcurrent: 5, baseIntervalMs: 300, targetCpuPercent: 75 });
  private preflightDone = false;
  /** One cookie pool for the whole dashboard process — rate limits learned by
   * any profile's session immediately protect every other profile. */
  private sharedPool?: CookiePool;

  constructor(readonly config: SimulatorConfig) {
    super();
    this.setMaxListeners(150);
    this.store = new ProfileStore(config.browser.profileDir);
    this.cleanupStaleProfiles();
    this.logger = new Logger("dashboard", { ...config.logging, jsonl: false }, "dash");
    this.startCoalescedPushLoop();
    setImmediate(() => {
      try { this.ensureSharedPool(); } catch { /* surfaced on first use */ }
    });
  }

  private startCoalescedPushLoop(): void {
    if (this.pushTimer) return;
    this.pushTimer = setInterval(() => {
      if (!this.isDirty) return;
      this.isDirty = false;
      this.emit("update", this.snapshot());
    }, 600);
    this.pushTimer.unref();
  }

  private markDirty(): void {
    this.isDirty = true;
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  /** Static context the dashboard shows in its header. */
  meta(): {
    storefront: string;
    defaultDurationMinutes: number;
    headless: boolean;
    engine: { name: string; isUngoogled: boolean; isEdge: boolean };
  } {
    const execPath = this.config.browser.executablePath || findSystemChrome();
    return {
      storefront: this.config.storefront,
      defaultDurationMinutes: Math.round(this.config.session.durationMs / 60_000),
      headless: this.config.browser.headless,
      engine: detectBrowserEngineBranding(execPath),
    };
  }

  /** Everything the dashboard needs, in stable profile order. */
  snapshot(): ProfileView[] {
    return this.store.list().map((profile) => {
      const live = this.sessions.get(profile.id);
      return {
        profile,
        session: live ? live.handle.snapshot() : null,
        streaming: live ? live.screencast.lastFrame !== null : false,
        identity: describeIdentity(profile),
      };
    });
  }

  /**
   * Push state to subscribers on the next tick.
   *
   * A single browsing step fires several updates (decided, navigated,
   * finished); collapsing them into one push per tick keeps the dashboard from
   * re-rendering three times for one action.
   */
  private schedulePush(): void {
    this.markDirty();
  }

  // ---------------------------------------------------------------------
  // Profile management
  // ---------------------------------------------------------------------

  listProfiles(): Profile[] {
    return this.store.list();
  }

  createProfile(input: CreateProfileInput): Profile {
    const profile = this.store.create(input);
    this.schedulePush();
    return profile;
  }

  /**
   * Create many profiles at once from a paste of sites + proxies.
   *
   * One profile per proxy — paste 8 proxies, get 8 profiles. Sites are handed
   * out round-robin and need not match the proxy count: 8 proxies + 3 sites
   * gives 8 profiles cycling through the 3 sites. With no proxies at all, one
   * profile per site instead (so a proxy-less paste still does something
   * useful). Sites and proxies are deduplicated; blank lines are ignored.
   */
  bulkCreateProfiles(input: {
    sites: string[];
    proxies: string[];
    durationMinutes?: number;
    atcMinutes?: number | null;
    device?: ProfileDevice | null;
  }): { created: number; profiles: Profile[]; errors: string[] } {
    const sites = [...new Set(input.sites.map((s) => s.trim()).filter(Boolean))];
    const proxies = [...new Set(input.proxies.map((p) => p.trim()).filter(Boolean))];
    // Count is driven by proxies; fall back to sites when there are no proxies.
    const count = proxies.length > 0 ? proxies.length : sites.length;
    if (count === 0) {
      throw new Error("Paste at least one site or one proxy");
    }
    const profiles: Profile[] = [];
    const errors: string[] = [];
    for (let i = 0; i < count; i++) {
      const proxy = proxies.length > 0 ? proxies[i] : undefined;
      const site = sites.length > 0 ? sites[i % sites.length] : undefined;
      try {
        const profile = this.store.create({
          ...(proxy ? { proxy } : {}),
          ...(site ? { storefront: site } : {}),
          ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
          ...(input.atcMinutes !== undefined ? { atcMinutes: input.atcMinutes } : {}),
          ...(input.device ? { device: input.device } : {}),
        });
        profiles.push(profile);
      } catch (err) {
        errors.push(`row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.info("bulk_create", `created ${profiles.length} profile(s)`, {
      data: { sites: sites.length, proxies: proxies.length, errors: errors.length },
    });
    this.schedulePush();
    return { created: profiles.length, profiles, errors };
  }

  updateProfile(id: string, patch: UpdateProfileInput): Profile {
    const profile = this.store.update(id, patch);
    this.schedulePush();
    return profile;
  }

  /**
   * Delete a profile: stop its browser, drop its registry entry, and remove
   * its user-data directory.
   *
   * The directory goes too — leaving gigabytes of Chromium cache behind for a
   * profile the operator has deleted is not "safe", it is a disk leak.
   */
  async deleteProfile(id: string): Promise<void> {
    const profile = this.store.require(id);
    const dir = this.store.userDataDir(profile);

    await this.closeSession(id).catch(() => undefined);
    this.store.remove(id);
    await rm(dir, { recursive: true, force: true }).catch((err) =>
      this.logger.warn(
        "profile_dir_remove_failed",
        `${dir}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );

    this.logger.info("profile_deleted", profile.name, { data: { id, dir } });
    this.schedulePush();
  }

  /**
   * Import a cookie file's contents onto a profile.
   *
   * HARD-WRITE: the parsed rows land in that profile's browser cookie store
   * immediately — through the live context when one is open, otherwise by
   * briefly opening the profile directory headless. Nothing is deleted,
   * filtered or altered; values are copied verbatim.
   */
  async importCookies(id: string, text: string, sourceName: string, sourcePath?: string): Promise<{ parsed: ParsedCookieFile; geo: GeoInfo | null }> {
    const parsed = parseCookieText(text);
    const profile = this.store.setCookies(id, parsed, sourceName, sourcePath);
    const geo = resolveGeoFromFilename(sourceName || sourcePath || "");
    this.logger.info("cookies_imported", `${parsed.cookies.length} cookie(s) → ${sourceName}${geo ? ` [Geo: ${geo.countryCode} -> ${geo.timezone}]` : ""}`, {
      data: { profileId: id, format: parsed.format, warnings: parsed.warnings.length, geo: geo ?? undefined },
    });

    const live = this.sessions.get(id);
    if (live) {
      // IMPORT = HARD-WRITE: overwrite the whole imported jar into the running
      // browser, replacing any stale/logged-out value a site embed left behind.
      // Restore-only syncJar would skip a present-but-logged-out cookie and the
      // account would never appear when the operator opens that site in a tab.
      const n = await hardWriteCookies(live.handle.context, profile.cookies?.cookies, this.logger).catch(() => 0);
      this.logger.info("cookies_written_live", `${n} row(s) written into the running browser`);
    } else {
      const n = await writeJarToProfileDir({
        config: this.config,
        userDataDir: this.store.userDataDir(profile),
        profile,
        logger: this.logger,
      }).catch((err) => {
        this.logger.warn("cookies_write_failed", err instanceof Error ? err.message : String(err));
        return 0;
      });
      this.logger.info("cookies_written_dir", `${n} row(s) written into the profile browser store`);
    }
    this.schedulePush();
    return { parsed, geo };
  }

  clearCookies(id: string): void {
    this.store.clearCookies(id);
    this.schedulePush();
  }

  /** Run a live connectivity check against a profile's proxy. */
  async checkProxy(id: string): Promise<Profile> {
    const profile = this.store.require(id);
    if (!profile.proxy) throw new Error("This profile has no proxy configured");
    const check = await testProxy(profile.proxy);
    const updated = this.store.recordProxyCheck(id, check);
    this.schedulePush();
    return updated;
  }

  /** Privacy hardening config (global) */
  getPrivacyConfig(): import("../config.js").PrivacyConfig {
    return (this.config.browser as any).privacy ?? (DEFAULT_CONFIG.browser as any).privacy;
  }

  updatePrivacyConfig(patch: Partial<import("../config.js").PrivacyConfig>): import("../config.js").PrivacyConfig {
    const current = this.getPrivacyConfig();
    const updated = { ...current, ...patch } as import("../config.js").PrivacyConfig;
    (this.config.browser as any).privacy = updated;
    // Persist to storefront-sim.config.json
    try {
      const cfgPath = resolve(process.cwd(), "storefront-sim.config.json");
      let raw: any = {};
      if (existsSync(cfgPath)) raw = JSON.parse(readFileSync(cfgPath, "utf8"));
      raw.browser = raw.browser ?? {};
      raw.browser.privacy = updated;
      writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
      this.logger.info("privacy_updated", "privacy config saved", { data: updated as unknown as Record<string, unknown> });
    } catch (err) {
      this.logger.warn("privacy_save_failed", err instanceof Error ? err.message : String(err));
    }
    this.schedulePush();
    return updated;
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  isRunning(profileId: string): boolean {
    return this.sessions.has(profileId);
  }

  /**
   * Open a profile in a real window on the desktop, or send it back to the
   * background — same profile directory, same cookies, same proxy, same pinned
   * fingerprint.
   *
   * Chromium locks a user-data directory to one process, so this cannot simply
   * open a second window onto a running headless browser: the browser is
   * relaunched against the same directory instead. Everything that lives in
   * that directory — cookies, localStorage, history — carries over, and the
   * remaining session time carries over with it, so the visit continues rather
   * than starting again.
   */
  async setHeaded(profileId: string, headed: boolean): Promise<SessionSnapshot | null> {
    const profile = this.store.require(profileId);
    this.store.update(profileId, { headed });

    const live = this.sessions.get(profileId);
    if (!live) {
      // Nothing running: the preference is stored and takes effect on start.
      this.schedulePush();
      return null;
    }

    // Carry the whole visit across: the unspent budget AND the clock already
    // spent (so elapsed keeps counting, not reset), the page the visitor was
    // on, and the visit's identity — personality, seen products, cart
    // history. The tile and the desktop window are two views of ONE visit.
    const snap = live.handle.snapshot();
    const remainingMs = snap.remainingMs;
    const elapsedOffsetMs = snap.elapsedMs;
    const resumeUrl = snap.url && snap.url !== "about:blank" ? snap.url : undefined;
    const visitState = live.handle.exportVisitState();
    await this.closeSession(profileId);
    // Allow Windows Chromium process to exit cleanly and release user-data lock
    await new Promise<void>((r) => setTimeout(r, 1200));

    this.logger.info(
      "profile_relaunch",
      `${profile.name} → ${headed ? "desktop window" : "background"}`,
      { data: { profileId, remainingMs, elapsedOffsetMs, resumeUrl } },
    );
    return this.startProfile(profileId, {
      remainingMs,
      elapsedOffsetMs,
      visitState,
      ...(resumeUrl ? { resumeUrl } : {}),
    });
  }

  /** Launch a browser for a profile and start browsing. */
  async startProfile(
    profileId: string,
    options: {
      remainingMs?: number;
      /** Clock already spent by the visit this launch continues. */
      elapsedOffsetMs?: number;
      /** Page to reopen — a relaunch continues where the visitor was. */
      resumeUrl?: string;
      /** Visit identity carried across a desktop/background switch. */
      visitState?: ReturnType<import("../behavior/aiEngine.js").AiBehaviorEngine["exportVisitState"]>;
    } = {},
  ): Promise<SessionSnapshot> {
    if (this.sessions.has(profileId)) {
      throw new Error("This profile already has a browser open");
    }
    // Synchronous claim BEFORE any await: two concurrent starts (double-click,
    // /start racing /continue) would both pass the sessions.has() guard above
    // and each launch a Chrome process against the same user-data directory —
    // a Chromium single-lock collision plus a leaked, unregistered browser.
    if (this.launching.has(profileId)) {
      throw new Error("This profile is already starting");
    }
    this.launching.add(profileId);
    try {
      return await this.startProfileInner(profileId, options);
    } finally {
      this.launching.delete(profileId);
    }
  }

  private async startProfileInner(
    profileId: string,
    options: {
      remainingMs?: number;
      elapsedOffsetMs?: number;
      resumeUrl?: string;
      visitState?: ReturnType<import("../behavior/aiEngine.js").AiBehaviorEngine["exportVisitState"]>;
    },
  ): Promise<SessionSnapshot> {
    const profile = this.store.require(profileId);

    // Provision the binary and check the licence once per process, not once
    // per profile — otherwise starting six profiles at once races six
    // downloads.
    if (!this.preflightDone) {
      const result = await preflight(this.config, this.logger);
      if (!result.ok) throw new Error(result.reason);
      this.preflightDone = true;
    }

    const sessionId = `${profile.ordinal}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    // The screencast lives behind a mutable ref: a browser revive (operator
    // closed the desktop window) re-taps the new page through onPage, and
    // every stream reader follows the ref instead of a dead tap.
    const screenRef: { current: Screencast | null } = { current: null };
    const screencastProxy = {
      get lastFrame() { return screenRef.current?.lastFrame ?? null; },
      subscribe(fn: Parameters<Screencast["subscribe"]>[0]) { return screenRef.current?.subscribe(fn) ?? (() => undefined); },
      async start() { await screenRef.current?.start(); },
      async stop() { await screenRef.current?.stop().catch(() => undefined); },
    } as unknown as Screencast;

    // Each session is pinned to its own shop: a per-profile storefront wins,
    // and without one there is nothing to browse — fail fast instead of
    // opening a browser aimed at an empty URL.
    const storefront = profile.storefront ?? this.config.storefront;
    if (!storefront) {
      throw new Error(
        `Profile "${profile.name}" has no storefront set. Open its settings in the dashboard and pick a shop.`,
      );
    }
    let storefrontHost = "";
    try {
      storefrontHost = new URL(storefront).host;
    } catch {
      throw new Error(`Profile has an invalid storefront URL: ${storefront}`);
    }

    // A profile marked "show on desktop" opens a real window; everything else
    // about the launch is identical.
    const bareStorefrontHost = storefrontHost.startsWith("www.")
      ? storefrontHost.slice(4)
      : `www.${storefrontHost}`;
    // Widen this session's allowlist to its own shop: with no global
    // storefront the base allowlist is empty and would block every page.
    const sessionAllowedHosts = Array.from(
      new Set([...this.config.safety.allowedHosts, storefrontHost, bareStorefrontHost]),
    );
    const config = {
      ...this.config,
      storefront,
      seedCollections:
        storefront === this.config.storefront
          ? this.config.seedCollections
          : ["/collections/all"],
      safety: {
        ...this.config.safety,
        allowedHosts: sessionAllowedHosts,
        allowCart: profile.atcMinutes !== 0,
      },
      // Default headless; operator can toggle per-profile via Show Desktop button
      browser: { ...this.config.browser, headless: !profile.headed },
      ...(options.remainingMs && options.remainingMs > 0
        ? {
            session: {
              ...this.config.session,
              durationMs: options.remainingMs,
              durationJitterMs: 0,
            },
          }
        : (profile.durationMinutes && profile.durationMinutes > 0
            ? {
                session: {
                  ...this.config.session,
                  durationMs: Math.round(profile.durationMinutes * 60_000),
                  durationJitterMs: 0,
                },
              }
            : {})),
    };

    // Per-profile ATC schedule: 0 = timed add-to-cart off for this profile;
    // n>0 = n minutes into the visit. Unset = follow the global config.
    if (profile.atcMinutes !== undefined && profile.atcMinutes !== null) {
      const ms = profile.atcMinutes > 0
        ? Math.round(profile.atcMinutes * 60_000)
        : Number.MAX_SAFE_INTEGER;
      (config as any).ai = {
        ...((this.config as any).ai ?? {}),
        advanceActionTimeMs: ms,
      };
    }

    await this.launcher.acquire();
    let handle: SessionHandle;
    // Capture the launch promise so a 60s timeout can still close the browser
    // when the launch eventually lands — otherwise it leaks a live session.
    const launching = startSession({
      slot: profile.ordinal,
      sessionId,
      config,
      profile,
      userDataDir: this.store.userDataDir(profile),
      lingerMs: -1,
      // Expected account email from the imported cookie's filename, so the
      // account-tab login check confirms the right account (e.g.
      // "zunzun05@outlook.jp_JP.txt" → "zunzun05@outlook.jp").
      ...(this.emailFromCookieSource(profile) ? { accountEmailHint: this.emailFromCookieSource(profile) } : {}),
      // Relaunch continuity: the resumed clock and the page the visitor
      // was on travel with the session to its new window.
      ...(options.elapsedOffsetMs && options.elapsedOffsetMs > 0
        ? { elapsedOffsetMs: options.elapsedOffsetMs }
        : {}),
      ...(options.resumeUrl ? { resumeUrl: options.resumeUrl } : {}),
      ...(options.visitState ? { inherited: options.visitState } : {}),
      cookiePool: this.ensureSharedPool(),
      onPage: async (page) => {
        const old = screenRef.current;
        const fresh = new Screencast(page);
        await fresh.start().catch(() => undefined);
        screenRef.current = fresh;
        if (old) await old.stop().catch(() => undefined);
      },
      onUpdate: () => this.markDirty(),
    });
    const captured = launching.then((h) => h);
    try {
      // 60s timeout: if browser doesn't launch in time, kill and move on
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Browser launch timed out after 60s")), 60_000)
      );
      handle = await Promise.race([captured, timeout]);
    } catch (err) {
      void captured
        .then((h) => { void h.close().catch(() => undefined); })
        .catch(() => undefined);
      throw err;
    } finally {
      this.launcher.release();
    }

    if (!screenRef.current) throw new Error("Screencast failed to attach");
    this.sessions.set(profileId, { handle, screencast: screencastProxy });
    this.schedulePush();

    // Clean up when the session finishes on its own.
    void handle.done
      .then((result) => {
        this.store.recordRun(profileId, {
          pagesVisited: result.pagesVisited,
          productsViewed: result.productsViewed,
          jsErrors: result.jsErrors,
          exitReason: result.exitReason,
        });
      })
      .catch((err) =>
        this.logger.error(
          "session_failed",
          err instanceof Error ? err.message : String(err),
          { data: { profileId } },
        ),
      )
      .finally(() => {
        void this.sessions.get(profileId)?.screencast.stop();
        this.sessions.delete(profileId);
        this.schedulePush();
      });

    return handle.snapshot();
  }

  /** Pull the account email out of an imported cookie file's name, e.g.
   * "zunzun05@outlook.jp_JP.txt" → "zunzun05@outlook.jp". Returns undefined
   * when the profile has no cookies or the name carries no email. */
  private emailFromCookieSource(profile: Profile): string | undefined {
    const src = profile.cookies?.sourceName;
    if (!src) return undefined;
    const m = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(src);
    return m ? m[0] : undefined;
  }

  /** One lazily-built pool shared by every profile's session. */
  private ensureSharedPool(): CookiePool {
    if (!this.sharedPool) {
      this.sharedPool = new CookiePool((this.config as any).ai?.cookiesDir ?? "./Cookies");
    }
    return this.sharedPool;
  }

  pauseProfile(profileId: string): void {
    this.requireSession(profileId).handle.pause();
    this.schedulePush();
  }

  /**
   * Continue a profile.
   *
   * "Continue" means two different things depending on where the profile is,
   * and the operator should not have to care which: a paused session resumes,
   * and one that has run out of budget gets more time and starts browsing
   * again. A profile with no browser open is simply started.
   */
  async continueProfile(profileId: string, extendMs?: number): Promise<SessionSnapshot> {
    const live = this.sessions.get(profileId);
    if (!live) return this.startProfile(profileId);

    const status = live.handle.snapshot().status;
    if (status === "paused") {
      live.handle.resume();
    } else if (status === "lingering") {
      const profile = this.store.require(profileId);
      const extra =
        extendMs ?? Math.round((profile.durationMinutes ?? 5) * 60_000);
      // A lingering session has already left its loop, so more time alone
      // does not restart it — the browser is relaunched against the same
      // persistent profile. The extra budget becomes the session length and
      // the visit identity travels with it.
      const visitState = live.handle.exportVisitState();
      await this.closeSession(profileId);
      return this.startProfile(profileId, { remainingMs: extra, visitState });
    }
    this.schedulePush();
    return live.handle.snapshot();
  }

  /** Stop driving but leave the browser open for inspection. */
  parkProfile(profileId: string): void {
    this.requireSession(profileId).handle.park();
    this.schedulePush();
  }

  extendProfile(profileId: string, ms: number): void {
    this.requireSession(profileId).handle.extend(ms);
    this.schedulePush();
  }

  /** Force add-to-cart on a running profile. */
  forceAddToCart(profileId: string): boolean {
    const live = this.sessions.get(profileId);
    if (!live) throw new Error("This profile has no browser open");
    if (this.config.safety.allowCart !== true) {
      throw new Error("safety.allowCart is false — enable it in config before forcing add-to-cart");
    }
    live.handle.forceAtc();
    this.logger.info("force_atc_requested", "Operator requested add-to-cart", { data: { profileId } });
    return true;
  }

  /** Close a profile's browser. */
  async closeSession(profileId: string): Promise<void> {
    const live = this.sessions.get(profileId);
    if (!live) return;
    await live.screencast.stop().catch(() => undefined);
    // Save the browser's jar back to the profile BEFORE the context dies:
    // these are the freshest server-rotated values and the next launch must
    // restore them, not replay an older import over them.
    const captured = await captureContextCookies(live.handle.context).catch(() => []);
    if (captured.length > 0) {
      this.store.adoptCookies(profileId, captured);
      this.logger.info(
        "cookies_adopted",
        `saved ${captured.length} cookie(s) back from the browser`,
        { data: { profileId } },
      );
    }
    await live.handle.close().catch((err) =>
      this.logger.warn(
        "session_close_error",
        err instanceof Error ? err.message : String(err),
      ),
    );
    this.sessions.delete(profileId);
    this.schedulePush();
  }

  /** The live view for a profile, when it has one. */
  screencastFor(profileId: string): Screencast | undefined {
    return this.sessions.get(profileId)?.screencast;
  }

  private requireSession(profileId: string): LiveSession {
    const live = this.sessions.get(profileId);
    if (!live) throw new Error("This profile has no browser open");
    return live;
  }

  /** Remove stale Chromium lock files from all profile directories at startup. */
  private cleanupStaleProfiles(): void {
    const base = resolve(this.config.browser.profileDir);
    if (!existsSync(base)) return;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]) {
        try { rmSync(join(dir, lock), { force: true, recursive: true }); } catch {}
      }
    }
  }

  /** Close everything. Called on dashboard shutdown. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }
}

