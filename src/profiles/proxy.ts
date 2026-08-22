/**
 * Proxy parsing, validation and connectivity testing.
 *
 * CloakBrowser accepts a proxy URL string and extracts credentials itself, but
 * the stock-Playwright fallback needs `{ server, username, password }` split
 * out — so the parse happens here once and both consumers read the same shape.
 *
 * The dashboard's Save button runs `validateProxy`; the Test button runs
 * `testProxy`, which actually opens a connection so a typo or a dead endpoint
 * is caught before a 15-minute session is spent on it.
 */
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import type { ProxyCheck } from "./types.js";

/** A proxy URL split into the parts the browser launchers need. */
export interface ParsedProxy {
  /** Scheme + host + port, without credentials — safe to log. */
  server: string;
  protocol: "http" | "https" | "socks4" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** The original string, credentials included. */
  raw: string;
}

export class ProxyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyParseError";
  }
}

const SUPPORTED = new Set(["http", "https", "socks4", "socks5"]);

/**
 * A hostname, IPv4 address, or bracketed IPv6 literal.
 *
 * `new URL()` is lenient about what it will accept as a host — `http://!!!`
 * parses happily with a hostname of "!!!" — so a proxy that never resolves
 * would otherwise be saved as valid and only fail once a session tried to use
 * it.
 */
const HOST_PATTERN =
  /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)$/;

/** Default port by scheme, used when the operator omits one. */
const DEFAULT_PORTS: Record<string, number> = {
  http: 8080,
  https: 8443,
  socks4: 1080,
  socks5: 1080,
};

/**
 * Parse a proxy string.
 *
 * Accepts a full URL (`http://user:pass@host:8080`) and also the bare
 * `host:port:user:pass` form that proxy vendors hand out, because that is what
 * operators paste in practice.
 */
export function parseProxy(input: string): ParsedProxy {
  const trimmed = input.trim();
  if (!trimmed) throw new ProxyParseError("proxy is empty");

  // Vendor form: host:port:user:pass (no scheme, no @).
  if (!trimmed.includes("://") && !trimmed.includes("@")) {
    const parts = trimmed.split(":");
    if (parts.length === 4) {
      const [host, port, username, password] = parts as [string, string, string, string];
      return buildProxy("http", host, port, username, password, trimmed);
    }
    if (parts.length === 2) {
      const [host, port] = parts as [string, string];
      return buildProxy("http", host, port, undefined, undefined, trimmed);
    }
  }

  // Everything else must be a URL; assume http:// when the scheme is missing.
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ProxyParseError(
      `cannot parse "${input}". Expected http://host:port, socks5://user:pass@host:port, or host:port:user:pass`,
    );
  }

  const protocol = url.protocol.replace(":", "").toLowerCase();
  if (!SUPPORTED.has(protocol)) {
    throw new ProxyParseError(
      `unsupported proxy scheme "${protocol}". Supported: ${[...SUPPORTED].join(", ")}`,
    );
  }
  return buildProxy(
    protocol,
    url.hostname,
    url.port,
    // A URL-encoded password (%40 for @) has to be decoded before it is used.
    url.username ? decodeURIComponent(url.username) : undefined,
    url.password ? decodeURIComponent(url.password) : undefined,
    trimmed,
  );
}

function buildProxy(
  protocol: string,
  host: string,
  port: string,
  username: string | undefined,
  password: string | undefined,
  raw: string,
): ParsedProxy {
  if (!host) throw new ProxyParseError("proxy host is missing");
  if (!HOST_PATTERN.test(host)) {
    throw new ProxyParseError(`"${host}" is not a valid proxy host`);
  }

  const portNumber = port ? Number(port) : DEFAULT_PORTS[protocol];
  if (!portNumber || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new ProxyParseError(`invalid proxy port "${port}"`);
  }

  return {
    server: `${protocol}://${host}:${portNumber}`,
    protocol: protocol as ParsedProxy["protocol"],
    host,
    port: portNumber,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    raw,
  };
}

/** Parse without throwing — for form validation. */
export function validateProxy(input: string): { ok: true; proxy: ParsedProxy } | { ok: false; error: string } {
  try {
    return { ok: true, proxy: parseProxy(input) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Strip credentials so a proxy can be logged or shown in the UI. */
export function redactProxy(input: string): string {
  try {
    const parsed = parseProxy(input);
    return parsed.username ? `${parsed.protocol}://***@${parsed.host}:${parsed.port}` : parsed.server;
  } catch {
    return "<proxy>";
  }
}

/**
 * Open a real connection through the proxy and report the exit IP.
 *
 * HTTP(S) proxies are tested with a CONNECT tunnel to an IP-echo endpoint;
 * SOCKS proxies only get a TCP reachability check, since tunnelling SOCKS
 * needs `socks-proxy-agent`, which is an optional peer dependency we do not
 * want to hard-require just to validate a form field.
 */
export async function testProxy(
  input: string,
  options: { timeoutMs?: number; echoUrl?: string } = {},
): Promise<ProxyCheck> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const checkedAt = new Date().toISOString();
  const started = Date.now();

  let proxy: ParsedProxy;
  try {
    proxy = parseProxy(input);
  } catch (err) {
    return { ok: false, checkedAt, error: err instanceof Error ? err.message : String(err) };
  }

  if (proxy.protocol === "socks4" || proxy.protocol === "socks5") {
    const reachable = await tcpReachable(proxy.host, proxy.port, timeoutMs);
    return reachable.ok
      ? {
          ok: true,
          checkedAt,
          latencyMs: Date.now() - started,
          error: "SOCKS proxy reachable (exit IP not checked)",
        }
      : { ok: false, checkedAt, error: reachable.error };
  }

  try {
    const ip = await fetchIpThroughProxy(proxy, options.echoUrl ?? "http://api.ipify.org/", timeoutMs);
    return { ok: true, checkedAt, latencyMs: Date.now() - started, ...(ip ? { ip } : {}) };
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Plain TCP reachability check. */
function tcpReachable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const done = (result: { ok: true } | { ok: false; error: string }): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done({ ok: true }));
    socket.once("timeout", () => done({ ok: false, error: `timed out after ${timeoutMs}ms` }));
    socket.once("error", (err) => done({ ok: false, error: err.message }));
  });
}

/**
 * Fetch an IP-echo URL through an HTTP proxy.
 *
 * A plain (non-TLS) echo endpoint is used deliberately: the request goes to the
 * proxy as an absolute-URI GET, which is the same path a browser's ordinary
 * HTTP traffic takes, and it avoids having to hand-roll a CONNECT tunnel plus
 * TLS handshake just to read back an IP address.
 */
function fetchIpThroughProxy(
  proxy: ParsedProxy,
  echoUrl: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const target = new URL(echoUrl);
    const headers: Record<string, string> = { Host: target.host, Connection: "close" };
    if (proxy.username) {
      const token = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64");
      headers["Proxy-Authorization"] = `Basic ${token}`;
    }

    const req = httpRequest(
      { host: proxy.host, port: proxy.port, method: "GET", path: echoUrl, headers, timeout: timeoutMs },
      (res) => {
        if (res.statusCode === 407) {
          res.resume();
          reject(new Error("proxy rejected the credentials (407)"));
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new Error(`proxy returned HTTP ${res.statusCode ?? "?"}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        // An echo endpoint returns a few bytes; cap it so a misrouted request
        // to some large page cannot buffer without bound.
        res.on("data", (chunk: string) => {
          if (body.length < 256) body += chunk;
        });
        res.on("end", () => {
          const match = body.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f:]{6,}\b/i);
          resolve(match?.[0]);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => reject(err));
    req.end();
  });
}
