/**
 * Profile domain types.
 *
 * A *profile* is one browser identity: its own persistent Chromium user-data
 * directory, its own proxy, its own cookie jar and its own pinned fingerprint.
 * Profiles outlive runs — they are the unit the dashboard manages, while a
 * *session* is one timed browsing run performed by a profile.
 */

/** Where a profile currently is in its lifecycle. */
export type ProfileStatus =
  /** No browser open. */
  | "idle"
  /** Browser launching. */
  | "starting"
  /** Browsing under an active session timer. */
  | "running"
  /** Session suspended by the user; browser still open. */
  | "paused"
  /**
   * The session budget is spent but the browser is deliberately still open so
   * the operator can look at it. Nothing is driving the page any more.
   */
  | "lingering"
  /** Browser shutting down. */
  | "stopping"
  /** Last run ended in an error; browser closed. */
  | "error";

/** A stable browser identity, pinned once and reused on every run. */
export interface ProfileIdentity {
  /**
   * Seed for every per-profile fingerprint draw. Pinned at creation so a
   * profile presents the *same* browser each run — a persistent profile that
   * kept its cookies but changed screen size every run would contradict itself.
   */
  seed: number;
  viewport: { width: number; height: number };
  /** IANA timezone, e.g. "Europe/Paris". */
  timezone?: string;
  /** BCP 47 locale, e.g. "fr-FR". */
  locale?: string;
  colorScheme?: "light" | "dark" | "no-preference";
}

/** Cookies attached to a profile, imported from a file on disk. */
export interface ProfileCookies {
  /** Original file the cookies came from, for display. */
  sourceName: string;
  /** Absolute path, when imported by path rather than upload. */
  sourcePath?: string;
  importedAt: string;
  count: number;
  /** Hosts covered, for a quick sanity check in the UI. */
  domains: string[];
  /** The parsed cookies themselves, stored with the profile. */
  cookies: StoredCookie[];
}

/** A cookie in Playwright's `addCookies` shape. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** Aggregate counters kept across every run this profile has performed. */
export interface ProfileStats {
  runs: number;
  pagesVisited: number;
  productsViewed: number;
  jsErrors: number;
  lastRunAt?: string;
  lastExitReason?: string;
}

/** One managed browser profile. */
export interface Profile {
  id: string;
  name: string;
  /**
   * Creation ordinal. The dashboard sorts on this and never on a mutable
   * field, which is what keeps cards from reordering as sessions change state.
   */
  ordinal: number;
  createdAt: string;
  /** Proxy URL for this profile; empty means a direct connection. */
  proxy: string;
  /** Last recorded proxy check, surfaced next to the proxy field. */
  proxyCheck?: ProxyCheck;
  cookies?: ProfileCookies;
  identity: ProfileIdentity;
  /** Per-profile session length override, in minutes. */
  durationMinutes?: number;
  notes?: string;
  stats: ProfileStats;
}

/** Outcome of testing a proxy. */
export interface ProxyCheck {
  ok: boolean;
  checkedAt: string;
  /** Exit IP as seen by the outside world, when the check could determine it. */
  ip?: string;
  /** Round-trip latency of the check, in ms. */
  latencyMs?: number;
  error?: string;
}
