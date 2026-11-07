/**
 * Cookie import.
 *
 * Operators export cookies from wherever they already have them — a browser
 * extension, a previous Playwright run, curl — so the importer accepts the
 * three shapes those tools actually produce and normalises them into
 * Playwright's `addCookies` format:
 *
 *   1. Playwright `storageState`  — `{ "cookies": [...], "origins": [...] }`
 *   2. A bare JSON array          — EditThisCookie / Cookie-Editor exports
 *   3. Netscape `cookies.txt`     — curl / wget / yt-dlp
 *
 * Anything unparseable fails loudly with the reason: a silently empty cookie
 * jar looks exactly like a logged-out session, which is a miserable thing to
 * debug at run time.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ProfileCookies, StoredCookie } from "./types.js";
export type { StoredCookie } from "./types.js";

/** Cookie formats the importer recognises. */
export type CookieFormat = "storage-state" | "json-array" | "netscape";

export interface ParsedCookieFile {
  format: CookieFormat;
  cookies: StoredCookie[];
  /** Non-fatal problems: entries skipped, fields defaulted. */
  warnings: string[];
}

/** Raised when a cookie file cannot be understood at all. */
export class CookieParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieParseError";
  }
}

/**
 * Normalise a sameSite value from any of the spellings the exporters use.
 * Chrome writes "no_restriction"/"unspecified", Firefox writes numbers,
 * Playwright writes "None"/"Lax"/"Strict".
 */
function normaliseSameSite(raw: unknown): StoredCookie["sameSite"] {
  if (typeof raw === "number") {
    // Firefox's numeric encoding: 0 none, 1 lax, 2 strict.
    return raw === 2 ? "Strict" : raw === 1 ? "Lax" : "None";
  }
  const value = String(raw ?? "").toLowerCase();
  if (value === "strict") return "Strict";
  if (value === "lax") return "Lax";
  if (value === "none" || value === "no_restriction") return "None";
  // "unspecified" and anything unknown: Lax matches modern Chrome's default.
  return "Lax";
}

/**
 * Normalise an expiry to Unix *seconds*. Exporters variously emit seconds,
 * milliseconds, ISO strings, or nothing at all for a session cookie.
 *
 * Some OpenBullet-style exporters write absurd far-future stamps (1e13+
 * seconds — the year 430,000). Chromium refuses those outright and would
 * otherwise void the whole jar, so any future stamp past a sane ceiling is
 * clamped rather than trusted.
 */
function normaliseExpiry(raw: unknown): number {
  // Anything past 2099 is exporter garbage (ticks/miscaled epochs), not a
  // real cookie lifetime — clamp it so engines accept the jar.
  const MAX_FUTURE_SEC = 4102444800;
  const clampFuture = (seconds: number): number =>
    seconds > MAX_FUTURE_SEC ? MAX_FUTURE_SEC : seconds;

  if (raw === undefined || raw === null || raw === "") return -1;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return -1;
    // Values past ~year 33658 are milliseconds that were never converted.
    return clampFuture(raw > 1e12 ? Math.round(raw / 1000) : Math.round(raw));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const numeric = Number(trimmed);
    // Any numeric string is an epoch — including "0", which Netscape uses to
    // mean "session cookie". Letting "0" fall through to Date.parse yields the
    // year 2000, and the cookie is then silently dropped as expired.
    if (trimmed !== "" && Number.isFinite(numeric)) return normaliseExpiry(numeric);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return clampFuture(Math.round(parsed / 1000));
  }
  return -1;
}

/** Convert one loose cookie object into a StoredCookie, or explain why not. */
function toStoredCookie(
  raw: Record<string, unknown>,
  index: number,
): { cookie: StoredCookie } | { skip: string } {
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!name) return { skip: `entry ${index}: missing "name"` };

  // Missing domain is recoverable when the export carries a url/host field
  // (Cookie-Editor style) — derive the scope from it instead of dropping the
  // row. Only a row with neither is truly unscopeable.
  let domain = typeof raw.domain === "string" ? raw.domain.trim() : "";
  if (!domain) {
    for (const fallback of [raw.url, raw.host]) {
      if (typeof fallback !== "string" || !fallback) continue;
      try {
        domain = new URL(fallback.includes("://") ? fallback : `https://${fallback}`).hostname;
        break;
      } catch {
        // not a URL; try the next fallback
      }
    }
  }
  if (!domain) return { skip: `cookie "${name}": missing "domain"` };

  // An absent value stores as empty rather than fatal: exporters omit the
  // value for flag cookies all the time, and Chromium happily keeps them.
  const value =
    typeof raw.value === "string"
      ? raw.value
      : raw.value === undefined || raw.value === null
        ? ""
        : String(raw.value);

  // Chrome exports host-only cookies with a leading dot stripped and a
  // `hostOnly` flag; Playwright infers host-only from the absence of the dot,
  // so honour the flag when it is present.
  const hostOnly = raw.hostOnly === true;
  const normalisedDomain =
    hostOnly && domain.startsWith(".") ? domain.slice(1) : domain;

  return {
    cookie: {
      name,
      value,
      domain: normalisedDomain,
      path: typeof raw.path === "string" && raw.path ? raw.path : "/",
      expires: normaliseExpiry(raw.expires ?? raw.expirationDate ?? raw.expiry),
      httpOnly: raw.httpOnly === true,
      secure: raw.secure === true,
      sameSite: normaliseSameSite(raw.sameSite),
    },
  };
}

/** Parse a Netscape `cookies.txt` body. */
function parseNetscape(text: string): ParsedCookieFile {
  const warnings: string[] = [];
  const cookies: StoredCookie[] = [];

  for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    // "#HttpOnly_" is the curl convention for an httpOnly cookie; every other
    // comment line is genuinely a comment.
    const httpOnly = trimmed.startsWith("#HttpOnly_");
    const body = httpOnly ? trimmed.slice("#HttpOnly_".length) : trimmed;
    if (!body || body.startsWith("#")) continue;

    let fields = body.split("\t");

    // Some exporters separate the columns with runs of spaces instead of
    // tabs. Fall back to whitespace splitting only when it plausibly yields a
    // full row — first token must look like a domain.
    if (fields.length === 1 && /\s/.test(body)) {
      const spaced = body.split(/\s+/);
      if (spaced.length >= 6 && /^[.#]?[\w-]+(\.[\w-]+)+$/.test(spaced[0] ?? "")) {
        fields = spaced;
      }
    }

    // Whatever is STILL a single field is prose from merged exports
    // ("Email: x@y.z; Cards: [visa]…", "DATA: Name: … | Address: …") —
    // vendor metadata, not cookie rows. Ignore QUIETLY so imports never
    // report phantom skips.
    if (fields.length === 1) continue;

    // The five leading columns are fixed; everything after them is
    // "name [value…]". Parsing left-to-right means a row whose value was
    // empty — and whose trailing tab an editor trimmed away — imports with an
    // empty value instead of being discarded wholesale. A value containing
    // tabs is malformed but recoverable: rejoin it.
    if (fields.length < 6) {
      warnings.push(`line ${lineNumber + 1}: too few fields (${fields.length})`);
      continue;
    }
    const [domain, includeSubdomains, path, secure, expiry] = fields;
    const tail = fields.slice(5);
    const name = tail[0] ?? "";
    const value = tail.slice(1).join("\t");
    if (!domain || !name) {
      warnings.push(`line ${lineNumber + 1}: missing domain or name`);
      continue;
    }
    const row: StoredCookie = {
      name,
      value,
      domain:
        includeSubdomains?.toUpperCase() === "TRUE" && !domain.startsWith(".")
          ? `.${domain}`
          : domain,
      path: path || "/",
      expires: normaliseExpiry(expiry),
      httpOnly,
      secure: secure?.toUpperCase() === "TRUE",
      sameSite: "Lax",
    };
    cookies.push(row);
  }

  return { format: "netscape", cookies, warnings };
}

/** Parse a JSON cookie export (storageState or a bare array). */
function parseJson(text: string): ParsedCookieFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new CookieParseError(
      `not valid JSON and not a Netscape cookies.txt file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let entries: unknown[];
  let format: CookieFormat;
  if (Array.isArray(data)) {
    entries = data;
    format = "json-array";
  } else if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { cookies?: unknown }).cookies)
  ) {
    entries = (data as { cookies: unknown[] }).cookies;
    format = "storage-state";
  } else {
    throw new CookieParseError(
      'JSON did not contain cookies: expected an array of cookies, or an object with a "cookies" array (Playwright storageState)',
    );
  }

  const warnings: string[] = [];
  const cookies: StoredCookie[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object") {
      warnings.push(`entry ${index}: not an object`);
      continue;
    }
    const result = toStoredCookie(entry as Record<string, unknown>, index);
    if ("skip" in result) warnings.push(result.skip);
    else cookies.push(result.cookie);
  }
  return { format, cookies, warnings };
}

/**
 * Take every row VERBATIM.
 *
 * No widening, no merging: a name present at several scopes (`shop.app` AND
 * `.shop.app`) is several real cookies a browser would hold side by side, and
 * collapsing them picks one value by guesswork while silently dropping the
 * other. The jar below is exactly the file, line for line — only unparseable
 * metadata lines produce warnings.
 */
export function parseCookieText(text: string): ParsedCookieFile {
  const trimmed = text.trim();
  if (!trimmed) throw new CookieParseError("file is empty");

  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const parsed = looksLikeJson ? parseJson(trimmed) : parseNetscape(trimmed);

  if (parsed.cookies.length === 0) {
    const detail = parsed.warnings.length
      ? ` (${parsed.warnings.slice(0, 3).join("; ")})`
      : "";
    throw new CookieParseError(`no usable cookies found in the file${detail}`);
  }
  return parsed;
}

/** Read and parse a cookie file from disk. */
export function parseCookieFile(path: string): ParsedCookieFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CookieParseError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseCookieText(text);
}

/** Distinct domains covered by a cookie set, most-frequent first. */
export function cookieDomains(cookies: StoredCookie[]): string[] {
  const counts = new Map<string, number>();
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, "");
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain);
}

/**
 * Stable, order-independent content fingerprint of a cookie jar.
 *
 * Injection is skipped whenever this matches what the browser already holds —
 * sites rewrite session values continuously, and stamping an older snapshot
 * back over the fresher state logs the visitor out. Value participates so any
 * server-side rotation produces a new signature; expiry participates because
 * the injector normalises stale stamps to session cookies and the captured
 * jar must agree with what was actually applied.
 */
export function jarSignature(cookies: StoredCookie[]): string {
  return cookies
    .map(
      (c) =>
        `${c.name}|${c.domain}|${c.path}|${c.expires}|${c.httpOnly ? 1 : 0}|${c.value}`,
    )
    .sort()
    .join("\n");
}

/** Build the stored record the profile keeps for an imported cookie file. */
export function buildProfileCookies(
  parsed: ParsedCookieFile,
  sourceName: string,
  sourcePath?: string,
): ProfileCookies {
  return {
    sourceName: basename(sourceName),
    ...(sourcePath ? { sourcePath } : {}),
    importedAt: new Date().toISOString(),
    count: parsed.cookies.length,
    domains: cookieDomains(parsed.cookies),
    cookies: parsed.cookies,
  };
}

/**
 * Drop cookies that have already expired. A persistent profile accumulates
 * stale cookies; feeding an expired jar to the browser is at best a no-op and
 * at worst re-sends a dead session id.
 */
export function liveCookies(cookies: StoredCookie[], now = Date.now()): StoredCookie[] {
  const nowSeconds = Math.floor(now / 1000);
  return cookies.filter((c) => c.expires === -1 || c.expires > nowSeconds);
}
