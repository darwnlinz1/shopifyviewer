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
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { preflight } from "../browser/cloak.js";
import { startSession, type SessionHandle, type SessionSnapshot } from "../session/manager.js";
import { ProfileStore, type CreateProfileInput, type UpdateProfileInput } from "../profiles/store.js";
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

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  readonly store: ProfileStore;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly logger: Logger;
  /** Coalesces bursts of updates into one push per tick. */
  private pushQueued = false;
  private preflightDone = false;

  constructor(private readonly config: SimulatorConfig) {
    super();
    this.store = new ProfileStore(config.browser.profileDir);
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

  /** Import a cookie file's contents onto a profile. */
  importCookies(id: string, text: string, sourceName: string, sourcePath?: string): ParsedCookieFile {
    const parsed = parseCookieText(text);
    this.store.setCookies(id, parsed, sourceName, sourcePath);
    this.logger.info("cookies_imported", `${parsed.cookies.length} cookie(s) → ${sourceName}`, {
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

  /** Launch a browser for a profile and start browsing. */
  async startProfile(profileId: string): Promise<SessionSnapshot> {
    if (this.sessions.has(profileId)) {
      throw new Error("This profile already has a browser open");
    }
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
    let screencast: Screencast | undefined;

    const handle = await startSession({
      slot: profile.ordinal,
      sessionId,
      config: this.config,
      profile,
      userDataDir: this.store.userDataDir(profile),
      // The dashboard exists to be watched, so a finished session holds its
      // browser open until the operator says otherwise.
      lingerMs: -1,
      onPage: async (page) => {
        screencast = new Screencast(page);
        await screencast.start();
      },
      onUpdate: () => this.schedulePush(),
    });

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
      // does not restart it — the browser is relaunched against the same
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

  /** Close everything. Called on dashboard shutdown. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }
}
