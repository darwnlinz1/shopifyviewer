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
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Profile, ProfileIdentity, ProxyCheck } from "./types.js";
import type { ParsedCookieFile, StoredCookie } from "./cookies.js";
import { buildProfileCookies, cookieDomains } from "./cookies.js";
import { validateProxy } from "./proxy.js";
import { resolveGeoFromFilename } from "./geo.js";
import { isRestrictedStorefrontUrl } from "../config.js";

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
  /**
   * Add-to-cart schedule in minutes; 0 disables the timed ATC for this
   * profile. Omitted = follow ai.advanceActionTimeMs.
   */
  atcMinutes?: number | null;
  timezone?: string;
  locale?: string;
  /** Per-profile storefront URL; empty means follow the global one. */
  storefront?: string | null;
  /** Open in a real desktop window instead of headless. */
  headed?: boolean;
  /** Mobile/desktop device emulation. Omitted/null = desktop. */
  device?: import("./types.js").ProfileDevice | null;
  /** Browser kernel; omitted/null = follow config.browser.provider. */
  browserProvider?: BrowserProviderInput;
  /** Existing BitBrowser profile to drive; omitted/empty = auto-create on first launch. */
  bitBrowserId?: string | null;
  notes?: string;
}

export type BrowserProviderInput = "builtin" | "bitbrowser" | null;

/** BitBrowser profile ids are opaque hex/uuid-ish tokens; anything else is a paste error. */
const BITBROWSER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Fields the dashboard is allowed to edit on an existing profile. */
export interface UpdateProfileInput {
  headed?: boolean;
  name?: string;
  proxy?: string;
  durationMinutes?: number | null;
  /** null clears back to the config default; 0 disables timed ATC. */
  atcMinutes?: number | null;
  timezone?: string;
  locale?: string;
  /** Per-profile storefront URL; null/empty clears back to the global one. */
  storefront?: string | null;
  /** Mobile/desktop device emulation. null clears to desktop. */
  device?: import("./types.js").ProfileDevice | null;
  /** null clears back to config.browser.provider. */
  browserProvider?: BrowserProviderInput;
  /** null/empty unlinks; a value links an operator-owned BitBrowser profile. */
  bitBrowserId?: string | null;
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
    this.cleanupOrphanDirs();
  }

  /** Remove profile directories whose ordinal no longer matches any profile. */
  private cleanupOrphanDirs(): void {
    const base = resolve(process.cwd(), this.profileDir);
    const liveOrdinals = new Set(this.data.profiles.map((p) => String(p.ordinal)));
    let entries: string[];
    try { entries = readdirSync(base); } catch { return; }
    for (const entry of entries) {
      const match = /^profile-(\d+)$/.exec(entry);
      if (!match) continue;
      if (!liveOrdinals.has(match[1]!)) {
        try {
          rmSync(join(base, entry), { recursive: true, force: true });
        } catch {}
      }
    }
  }

  private read(): StoreFile {
    if (!existsSync(this.path)) return { version: 1, nextOrdinal: 1, profiles: [] };
    try {
      const raw = readFileSync(this.path, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
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
      ...(input.headed ? { headed: true } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.device && input.device.kind !== "desktop" ? { device: input.device } : {}),
      stats: { runs: 0, pagesVisited: 0, productsViewed: 0, jsErrors: 0 },
    };

    this.data.profiles.push(profile);

    // Reuse the update-path validation so a created-with-storefront profile
    // is normalised (scheme added, trailing slash dropped) exactly the same
    // way an edited one is.
    const patch: UpdateProfileInput = {
      ...(input.storefront !== undefined && input.storefront !== null ? { storefront: input.storefront } : {}),
      ...(input.atcMinutes !== undefined && input.atcMinutes !== null ? { atcMinutes: input.atcMinutes } : {}),
      ...(input.browserProvider !== undefined ? { browserProvider: input.browserProvider } : {}),
      ...(input.bitBrowserId !== undefined ? { bitBrowserId: input.bitBrowserId } : {}),
    };
    if (Object.keys(patch).length > 0) {
      try {
        this.update(profile.id, patch);
      } catch (err) {
        // A rejected field must not leave a half-created profile in the list.
        this.data.profiles = this.data.profiles.filter((p) => p.id !== profile.id);
        this.write();
        throw err;
      }
    }

    this.write();
    return this.require(profile.id);
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

    // ATC schedule: null = follow config default; 0 = timed ATC off;
    // n>0 = add to cart n minutes into the session.
    if (patch.atcMinutes !== undefined) {
      if (patch.atcMinutes === null) delete profile.atcMinutes;
      else {
        if (!(patch.atcMinutes >= 0)) throw new Error("ATC minutes must be 0 (off) or greater");
        profile.atcMinutes = patch.atcMinutes;
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
    if (patch.device !== undefined) {
      if (patch.device === null || patch.device.kind === "desktop") delete profile.device;
      else profile.device = patch.device;
    }
    if (patch.headed !== undefined) profile.headed = patch.headed;

    if (patch.browserProvider !== undefined) {
      if (patch.browserProvider === null) delete profile.browserProvider;
      else if (patch.browserProvider === "builtin" || patch.browserProvider === "bitbrowser") {
        profile.browserProvider = patch.browserProvider;
      } else {
        throw new Error(`Invalid browser provider: ${String(patch.browserProvider)} (expected builtin or bitbrowser)`);
      }
    }

    if (patch.bitBrowserId !== undefined) {
      const next = typeof patch.bitBrowserId === "string" ? patch.bitBrowserId.trim() : "";
      if (next && !BITBROWSER_ID_PATTERN.test(next)) {
        throw new Error(`Invalid BitBrowser profile ID: "${next}"`);
      }
      if (next !== (profile.bitBrowserId ?? "")) {
        if (next) {
          // Pasted by the operator: theirs to keep, so never deleted with this profile.
          profile.bitBrowserId = next;
          profile.bitBrowserManaged = false;
        } else {
          delete profile.bitBrowserId;
          delete profile.bitBrowserManaged;
        }
        delete profile.bitBrowserProxySig;
      }
    }

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
        const ssrfCheck = isRestrictedStorefrontUrl(parsed.toString());
        if (ssrfCheck.restricted) {
          throw new Error(`Invalid storefront URL: ${ssrfCheck.reason}`);
        }
        // Normalised without trailing slash, matching how the global
        // storefront is stored.
        profile.storefront = parsed.toString().replace(/\/+$/, "");
      }
    }

    this.write();
    return profile;
  }

  /**
   * IMPORT = ADD to the browser's cookie store, never replace.
   *
   * Each file's rows are merged into the jar: a row overrides only its own
   * name+domain+path triple, every other site's cookies stay untouched. The
   * jar is therefore a multi-site wallet — import shop.app today, another
   * shop tomorrow, and both logins coexist.
   */
  setCookies(id: string, parsed: ParsedCookieFile, sourceName: string, sourcePath?: string): Profile {
    const profile = this.require(id);
    const key = (c: StoredCookie) => `${c.name}|${c.domain}|${c.path}`;
    const map = new Map<string, StoredCookie>();
    for (const c of profile.cookies?.cookies ?? []) map.set(key(c), c);
    for (const c of parsed.cookies) map.set(key(c), c);
    const merged: ParsedCookieFile = { format: parsed.format, cookies: [...map.values()], warnings: parsed.warnings };
    profile.cookies = buildProfileCookies(merged, sourceName, sourcePath);

    // Auto-sync Timezone & Locale from cookie filename (e.g. `_US.txt` -> `America/New_York`)
    const geo = resolveGeoFromFilename(sourceName || sourcePath || "");
    if (geo) {
      profile.identity.timezone = geo.timezone;
      profile.identity.locale = geo.locale;
    }

    this.write();
    return profile;
  }

  /**
   * Adopt the browser's current jar as the profile's own — MERGE-ONLY.
   *
   * Browser values are fresher for every row they still hold. But when a site
   * revokes a session mid-visit it deletes cookies in the browser; adopting
   * that state wholesale would destroy the imported login forever. So rows
   * present only in the profile are KEPT, rows present in both take the
   * browser's fresher value, and new rows are added.
   */
  adoptCookies(id: string, captured: StoredCookie[]): Profile | undefined {
    const profile = this.get(id);
    if (!profile) return undefined;
    const existing = profile.cookies;
    const key = (c: StoredCookie) => `${c.name}|${c.domain}|${c.path}`;
    const map = new Map<string, StoredCookie>();
    for (const c of existing?.cookies ?? []) map.set(key(c), c);
    for (const c of captured) {
      map.set(key(c), c);
    }
    const merged = [...map.values()];
    profile.cookies = {
      sourceName: existing?.sourceName ?? "browser-session",
      ...(existing?.sourcePath ? { sourcePath: existing.sourcePath } : {}),
      importedAt: existing?.importedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      count: merged.length,
      domains: cookieDomains(merged),
      cookies: merged,
    };
    this.write();
    return profile;
  }

  clearCookies(id: string): Profile {
    const profile = this.require(id);
    delete profile.cookies;
    this.write();
    return profile;
  }

  /**
   * Remember which BitBrowser profile backs this one, after a launch created
   * or re-synced it. Undefined when the profile was deleted mid-launch.
   */
  recordBitBrowserLink(
    id: string,
    link: { bitBrowserId: string; managed: boolean; proxySig?: string },
  ): Profile | undefined {
    const profile = this.get(id);
    if (!profile) return undefined;
    profile.bitBrowserId = link.bitBrowserId;
    profile.bitBrowserManaged = link.managed;
    if (link.proxySig) profile.bitBrowserProxySig = link.proxySig;
    else delete profile.bitBrowserProxySig;
    this.write();
    return profile;
  }

  setPendingCookieWrite(id: string, pending: boolean): Profile | undefined {
    const profile = this.get(id);
    if (!profile) return undefined;
    if (pending) profile.pendingCookieWrite = true;
    else delete profile.pendingCookieWrite;
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