/**
 * Profile registry.
 *
 * Profiles are persisted as a single JSON file next to the profile
 * directories, so the dashboard survives a restart with its proxies, cookies
 * and pinned identities intact.
 *
 * Ordering is the important detail here. `list()` always returns profiles
 * sorted by `ordinal` — a value fixed at creation and never touched again —
 * so a profile occupies the same slot in the dashboard grid no matter what
 * happens to its status. Sorting on anything mutable (status, last run, the
 * order sessions happen to finish in) is what makes cards jump around under
 * the operator's cursor.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Profile, ProfileIdentity, ProxyCheck } from "./types.js";
import type { ParsedCookieFile } from "./cookies.js";
import { buildProfileCookies } from "./cookies.js";
import { validateProxy } from "./proxy.js";

/** Viewports a new profile can be assigned. */
const VIEWPORT_POOL: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
];

export interface CreateProfileInput {
  name?: string;
  proxy?: string;
  durationMinutes?: number;
  timezone?: string;
  locale?: string;
  notes?: string;
}

/** Fields the dashboard is allowed to edit on an existing profile. */
export interface UpdateProfileInput {
  headed?: boolean;
  name?: string;
  proxy?: string;
  durationMinutes?: number | null;
  timezone?: string;
  locale?: string;
  /** Per-profile storefront URL; null/empty clears back to the global one. */
  storefront?: string | null;
  notes?: string;
}

interface StoreFile {
  version: 1;
  nextOrdinal: number;
  profiles: Profile[];
}

export class ProfileStore {
  private readonly path: string;
  private data: StoreFile;

  constructor(private readonly profileDir: string) {
    const base = resolve(process.cwd(), profileDir);
    mkdirSync(base, { recursive: true });
    this.path = join(base, "profiles.json");
    this.data = this.read();
  }

  private read(): StoreFile {
    if (!existsSync(this.path)) return { version: 1, nextOrdinal: 1, profiles: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoreFile>;
      const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
      return {
        version: 1,
        // Rebuild the counter from the data so a hand-edited file cannot hand
        // out an ordinal that is already taken.
        nextOrdinal: Math.max(1, ...profiles.map((p) => (p.ordinal ?? 0) + 1)),
        profiles,
      };
    } catch (err) {
      throw new Error(
        `Profile store at ${this.path} is corrupt: ${err instanceof Error ? err.message : String(err)}. ` +
          `Move it aside to start fresh.`,
      );
    }
  }

  /**
   * Persist atomically. A half-written profiles.json would take every profile
   * with it — including cookie jars the operator may not be able to re-export.
   */
  private write(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }

  /** Every profile, in stable creation order. */
  list(): Profile[] {
    return [...this.data.profiles].sort((a, b) => a.ordinal - b.ordinal);
  }

  get(id: string): Profile | undefined {
    return this.data.profiles.find((p) => p.id === id);
  }

  /** Throwing accessor for call sites where a missing profile is a bug. */
  require(id: string): Profile {
    const profile = this.get(id);
    if (!profile) throw new Error(`No such profile: ${id}`);
    return profile;
  }

  create(input: CreateProfileInput = {}): Profile {
    const ordinal = this.data.nextOrdinal++;

    if (input.proxy) {
      const check = validateProxy(input.proxy);
      if (!check.ok) throw new Error(`Invalid proxy: ${check.error}`);
    }

    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const identity: ProfileIdentity = {
      seed,
      // Pinned once: this profile is "the 1536×864 one" for the rest of its life.
      viewport: VIEWPORT_POOL[seed % VIEWPORT_POOL.length] ?? { width: 1440, height: 900 },
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    };

    const profile: Profile = {
      id: randomUUID(),
      name: input.name?.trim() || `Profile ${ordinal}`,
      ordinal,
      createdAt: new Date().toISOString(),
      proxy: input.proxy?.trim() ?? "",
      identity,
      ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      stats: { runs: 0, pagesVisited: 0, productsViewed: 0, jsErrors: 0 },
    };

    this.data.profiles.push(profile);
    this.write();
    return profile;
  }

  update(id: string, patch: UpdateProfileInput): Profile {
    const profile = this.require(id);

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("Profile name cannot be empty");
      profile.name = name;
    }

    if (patch.proxy !== undefined) {
      const proxy = patch.proxy.trim();
      if (proxy) {
        const check = validateProxy(proxy);
        if (!check.ok) throw new Error(`Invalid proxy: ${check.error}`);
      }
      profile.proxy = proxy;
      // The stored check belongs to the old endpoint; keeping it would show a
      // green tick next to an untested proxy.
      delete profile.proxyCheck;
    }

    if (patch.durationMinutes !== undefined) {
      if (patch.durationMinutes === null) delete profile.durationMinutes;
      else {
        if (!(patch.durationMinutes > 0)) throw new Error("Duration must be greater than zero");
        profile.durationMinutes = patch.durationMinutes;
      }
    }

    if (patch.timezone !== undefined) {
      if (patch.timezone) profile.identity.timezone = patch.timezone;
      else delete profile.identity.timezone;
    }
    if (patch.locale !== undefined) {
      if (patch.locale) profile.identity.locale = patch.locale;
      else delete profile.identity.locale;
    }
    if (patch.notes !== undefined) profile.notes = patch.notes;
    if (patch.headed !== undefined) profile.headed = patch.headed;

    if (patch.storefront !== undefined) {
      const url = typeof patch.storefront === "string" ? patch.storefront.trim() : "";
      if (!url) {
        // Empty string / null clears the override — back to the global shop.
        delete profile.storefront;
      } else {
        let parsed: URL;
        try {
          parsed = new URL(url.includes("://") ? url : `https://${url}`);
        } catch {
          throw new Error(`Invalid storefront URL: ${url}`);
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error(`Storefront must be an http(s) URL: ${url}`);
        }
        // Normalised without trailing slash, matching how the global
        // storefront is stored.
        profile.storefront = parsed.toString().replace(/\/+$/, "");
      }
    }

    this.write();
    return profile;
  }

  /** Attach a parsed cookie file to a profile. */
  setCookies(id: string, parsed: ParsedCookieFile, sourceName: string, sourcePath?: string): Profile {
    const profile = this.require(id);
    profile.cookies = buildProfileCookies(parsed, sourceName, sourcePath);
    this.write();
    return profile;
  }

  clearCookies(id: string): Profile {
    const profile = this.require(id);
    delete profile.cookies;
    this.write();
    return profile;
  }

  recordProxyCheck(id: string, check: ProxyCheck): Profile {
    const profile = this.require(id);
    profile.proxyCheck = check;
    this.write();
    return profile;
  }

  /** Fold one finished run into the profile's lifetime counters. */
  recordRun(
    id: string,
    run: { pagesVisited: number; productsViewed: number; jsErrors: number; exitReason: string },
  ): Profile | undefined {
    const profile = this.get(id);
    if (!profile) return undefined;
    profile.stats.runs++;
    profile.stats.pagesVisited += run.pagesVisited;
    profile.stats.productsViewed += run.productsViewed;
    profile.stats.jsErrors += run.jsErrors;
    profile.stats.lastRunAt = new Date().toISOString();
    profile.stats.lastExitReason = run.exitReason;
    this.write();
    return profile;
  }

  /**
   * Remove a profile from the registry. The caller is responsible for stopping
   * any live session and deleting the user-data directory — the store only
   * owns the registry entry.
   */
  remove(id: string): Profile {
    const profile = this.require(id);
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    this.write();
    return profile;
  }

  /** Absolute path of a profile's Chromium user-data directory. */
  userDataDir(profile: Profile): string {
    return join(resolve(process.cwd(), this.profileDir), `profile-${profile.ordinal}`);
  }
}
