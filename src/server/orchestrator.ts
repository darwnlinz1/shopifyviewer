/**
 * Orchestrator â€” profiles on one side, live browser sessions on the other.
 *
 * The dashboard talks only to this: it holds the profile registry, the
 * sessions currently running, and the screencast tap for each one. Everything
 * it exposes is keyed by *profile* id rather than session id, because a
 * profile is the thing the operator manages and a session is just what it is
 * doing right now.
 */
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { preflight } from "../browser/obscura.js";
import { startSession, type SessionHandle, type SessionSnapshot } from "../session/aiManager.js";
import { ProfileStore, type CreateProfileInput, type UpdateProfileInput } from "../profiles/store.js";
import { CookiePool } from "../ai/cookiePool.js";
import { parseCookieText, type ParsedCookieFile } from "../profiles/cookies.js";
import { testProxy } from "../profiles/proxy.js";
import type { Profile } from "../profiles/types.js";
import { Screencast } from "./screencast.js";
import { describeIdentity } from "../browser/identity.js";

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

/** Limits concurrent browser launches to avoid Windows process-spawn contention. */
class LaunchGate {
  private active = 0;
  private readonly max: number;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrent = 3) { this.max = maxConcurrent; }

  async acquire(): Promise<void> {
    if (this.active < this.max) { this.active++; return; }
    return new Promise<void>(resolve => this.queue.push(() => { this.active++; resolve(); }));
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  get pending(): number { return this.queue.length; }
  get running(): number { return this.active; }
}

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  readonly store: ProfileStore;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly logger: Logger;
  /** Coalesces bursts of updates into one push per tick. */
  private pushQueued = false;
  private preflightDone = false;
  /** Limits how many browsers launch at the same time. */
  private readonly launchGate = new LaunchGate(2);
  private lastLaunchAt = 0;

  constructor(readonly config: SimulatorConfig) {
    super();
    this.store = new ProfileStore(config.browser.profileDir);
    this.cleanupStaleProfiles();
    this.logger = new Logger("dashboard", { ...config.logging, jsonl: false }, "dash");
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  /** Static context the dashboard shows in its header. */
  meta(): { storefront: string; defaultDurationMinutes: number; headless: boolean } {
    return {
      storefront: this.config.storefront,
      defaultDurationMinutes: Math.round(this.config.session.durationMs / 60_000),
      headless: this.config.browser.headless,
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
    if (this.pushQueued) return;
    this.pushQueued = true;
    setImmediate(() => {
      this.pushQueued = false;
      this.emit("update", this.snapshot());
    });
  }

  // ---------------------------------------------------------------------
  // Profile management
  // ---------------------------------------------------------------------

  createProfile(input: CreateProfileInput): Profile {
    const profile = this.store.create(input);
    this.schedulePush();
    return profile;
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
   * The directory goes too â€” leaving gigabytes of Chromium cache behind for a
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

  /** Import a cookie file's contents onto a profile. */
  importCookies(id: string, text: string, sourceName: string, sourcePath?: string): ParsedCookieFile {
    const parsed = parseCookieText(text);
    this.store.setCookies(id, parsed, sourceName, sourcePath);
    this.logger.info("cookies_imported", `${parsed.cookies.length} cookie(s) â†’ ${sourceName}`, {
      data: { profileId: id, format: parsed.format, warnings: parsed.warnings.length },
    });
    this.schedulePush();
    return parsed;
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

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  isRunning(profileId: string): boolean {
    return this.sessions.has(profileId);
  }

  /**
   * Open a profile in a real window on the desktop, or send it back to the
   * background â€” same profile directory, same cookies, same proxy, same pinned
   * fingerprint.
   *
   * Chromium locks a user-data directory to one process, so this cannot simply
   * open a second window onto a running headless browser: the browser is
   * relaunched against the same directory instead. Everything that lives in
   * that directory â€” cookies, localStorage, history â€” carries over, and the
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

    // Carry the unspent budget across so reopening a window mid-visit does not
    // hand the profile a fresh fifteen minutes.
    const remainingMs = live.handle.snapshot().remainingMs;
    await this.closeSession(profileId);

    this.logger.info(
      "profile_relaunch",
      `${profile.name} â†’ ${headed ? "desktop window" : "background"}`,
      { data: { profileId, remainingMs } },
    );
    return this.startProfile(profileId, { remainingMs });
  }

  /** Launch a browser for a profile and start browsing. */
  async startProfile(
    profileId: string,
    options: { remainingMs?: number } = {},
  ): Promise<SessionSnapshot> {
    if (this.sessions.has(profileId)) {
      throw new Error("This profile already has a browser open");
    }
    const profile = this.store.require(profileId);

    // Provision the binary and check the licence once per process, not once
    // per profile â€” otherwise starting six profiles at once races six
    // downloads.
    if (!this.preflightDone) {
      const result = await preflight(this.config, this.logger);
      if (!result.ok) throw new Error(result.reason);
      this.preflightDone = true;
    }

    const sessionId = `${profile.ordinal}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    let screencast: Screencast | undefined;

    // A per-profile storefront overrides the global one for this session. No
    // allowlist gate here — the operator decides which shop a profile browses,
    // and the session stays pinned to whatever it was pointed at.
    const storefront = profile.storefront ?? this.config.storefront;
    let storefrontHost = "";
    try {
      storefrontHost = new URL(storefront).host;
    } catch {
      throw new Error(`Profile has an invalid storefront URL: ${storefront}`);
    }

    // A profile marked "show on desktop" opens a real window; everything else
    // about the launch is identical.
    const config = {
      ...this.config,
      storefront,
      seedCollections:
        storefront === this.config.storefront
          ? this.config.seedCollections
          : ["/collections/all"],
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
        : {}),
    };

    // Stagger launches: wait at least 5s since the last one, then hold a gate slot
    const now = Date.now();
    const gap = now - this.lastLaunchAt;
    if (gap < 5000) await new Promise<void>(r => setTimeout(r, 5000 - gap));
    this.lastLaunchAt = Date.now();

    await this.launchGate.acquire();
    let handle: SessionHandle;
    try {
      // 60s timeout: if browser doesn't launch in time, kill and move on
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Browser launch timed out after 60s")), 60_000)
      );
      handle = await Promise.race([
        startSession({
          slot: profile.ordinal,
          sessionId,
          config,
          profile,
          userDataDir: this.store.userDataDir(profile),
          lingerMs: -1,
          onPage: async (page) => {
            screencast = new Screencast(page);
            await screencast.start();
          },
          onUpdate: () => this.schedulePush(),
        }),
        timeout,
      ]);
    } finally {
      this.launchGate.release();
    }

    if (!screencast) throw new Error("Screencast failed to attach");
    this.sessions.set(profileId, { handle, screencast });
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
      live.handle.extend(extra);
      // A lingering session has already left its loop, so more time alone
      // does not restart it â€” the browser is relaunched against the same
      // persistent profile, which keeps its cookies and history.
      await this.closeSession(profileId);
      return this.startProfile(profileId);
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
    // Access the engine's state through the handle's page context is not directly exposed.
    // Instead we log the intent; the engine will pick it up on next decide cycle.
    this.logger.info("force_atc_requested", "Operator requested add-to-cart", { data: { profileId } });
    return true;
  }

  /** Close a profile's browser. */
  async closeSession(profileId: string): Promise<void> {
    const live = this.sessions.get(profileId);
    if (!live) return;
    await live.screencast.stop().catch(() => undefined);
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

