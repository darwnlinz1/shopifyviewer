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

/**
 * A self-hosted mobile/desktop device emulation pick, resolved against the
 * DEVICE_CATALOG in src/browser/identity.ts. Kept OUTSIDE ProfileIdentity so
 * the identity shape (viewport/timezone/locale) stays stable and the
 * dashboard.test.mjs identity-equality assertion is untouched.
 *
 * kind: desktop (undefined device = desktop), android, iphone, ipad.
 * model: a key in the catalog (e.g. "Pixel 7", "iPhone 14 Pro", "iPad Pro 11").
 */
export interface ProfileDevice {
  kind: "desktop" | "android" | "iphone" | "ipad";
  model: string;
}

/** Cookies attached to a profile, imported from a file on disk. */
export interface ProfileCookies {
  /** Original file the cookies came from, for display. */
  sourceName: string;
  /** Absolute path, when imported by path rather than upload. */
  sourcePath?: string;
  importedAt: string;
  /** Last time the jar was refreshed from a live browser (rotation adopt). */
  updatedAt?: string;
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
  /**
   * Open this profile in a real window on the operator's desktop rather than
   * headless. Remembered, so a profile the operator likes to watch directly
   * keeps opening that way.
   */
  headed?: boolean;
  /**
   * Per-profile storefront. When set, this profile browses this shop instead
   * of the global `config.storefront` — one fleet can watch several shops at
   * once without duplicating the deployment. Empty = follow the global
   * setting. The host is always validated against the safety allowlist at
   * session start, so a per-profile URL cannot widen what the browser may
   * touch.
   */
  storefront?: string;
  /**
   * Per-profile add-to-cart schedule, in minutes from session start.
   * Undefined/null = follow ai.advanceActionTimeMs from config (default 10).
   * 0 = this profile never adds to cart on a timer. Requires
   * safety.allowCart regardless — that remains the master switch.
   */
  atcMinutes?: number | null;
  /** Mobile/desktop device emulation. Undefined = desktop (default). */
  device?: ProfileDevice;
  /** Browser kernel for this profile. Undefined = follow config.browser.provider. */
  browserProvider?: "builtin" | "bitbrowser";
  /** The profile's id inside the BitBrowser app (provider "bitbrowser"). */
  bitBrowserId?: string;
  /**
   * SiteViewer created the BitBrowser profile itself, so it is deleted along
   * with this one. An id the operator pasted in is only ever unlinked.
   */
  bitBrowserManaged?: boolean;
  /** Hash of the proxy last pushed to the BitBrowser profile; a change triggers a re-sync. */
  bitBrowserProxySig?: string;
  /**
   * An imported jar has not been hard-written into the browser yet. Set when
   * cookies arrive while no BitBrowser window is open; cleared on next launch.
   */
  pendingCookieWrite?: boolean;
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
