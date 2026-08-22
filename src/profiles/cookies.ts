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
 */
function normaliseExpiry(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return -1;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return -1;
    // Values past ~year 33658 are milliseconds that were never converted.
    return raw > 1e12 ? Math.round(raw / 1000) : Math.round(raw);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const numeric = Number(trimmed);
    // Any numeric string is an epoch — including "0", which Netscape uses to
    // mean "session cookie". Letting "0" fall through to Date.parse yields the
    // year 2000, and the cookie is then silently dropped as expired.
    if (trimmed !== "" && Number.isFinite(numeric)) return normaliseExpiry(numeric);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
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

  const domain = typeof raw.domain === "string" ? raw.domain : "";
  if (!domain) return { skip: `cookie "${name}": missing "domain"` };

  // `value` is legitimately empty for some flags, so only its absence is fatal.
  const value =
    typeof raw.value === "string"
      ? raw.value
      : raw.value === undefined || raw.value === null
        ? undefined
        : String(raw.value);
  if (value === undefined) return { skip: `cookie "${name}": missing "value"` };

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

    // domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
    const fields = body.split("\t");
    if (fields.length < 7) {
      warnings.push(`line ${lineNumber + 1}: expected 7 tab-separated fields`);
      continue;
    }
    const [domain, includeSubdomains, path, secure, expiry, name, ...rest] = fields;
    if (!domain || !name) {
      warnings.push(`line ${lineNumber + 1}: missing domain or name`);
      continue;
    }
    cookies.push({
      name,
      // A value containing tabs is malformed but recoverable — rejoin it.
      value: rest.join("\t"),
      domain:
        includeSubdomains?.toUpperCase() === "TRUE" && !domain.startsWith(".")
          ? `.${domain}`
          : domain,
      path: path || "/",
      expires: normaliseExpiry(expiry),
      httpOnly,
      secure: secure?.toUpperCase() === "TRUE",
      sameSite: "Lax",
    });
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
 * Parse cookie file contents. The format is detected from the content, not the
 * extension — exports are routinely saved under the wrong name.
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
