/**
 * Proxy parsing, validation and connectivity testing.
 *
 * Vendors hand out proxy strings with inline credentials;
 * the stock-Playwright fallback needs `{ server, username, password }` split
 * out — so the parse happens here once and both consumers read the same shape.
 *
 * The dashboard's Save button runs `validateProxy`; the Test button runs
 * `testProxy`, which actually opens a connection so a typo or a dead endpoint
 * is caught before a 15-minute session is spent on it.
 */
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
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

  // Vendor form: host:port:user:pass (no scheme). Must be checked before URL parsing
  // because passwords may contain @ and : which would otherwise be treated as URL.
  if (!trimmed.includes("://")) {
    // Bracketed IPv6 must be matched before any naive ":" split — "[::1]"
    // contains colons of its own. Supports [h]:p and [h]:p:user:pass where pass may contain : and @.
    const ipv6 = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?(?::([^:\s]+):(.+))?$/.exec(trimmed);
    if (ipv6) {
      const [, host, port, user, pass] = ipv6;
      return buildProxy("http", `[${host}]`, port ?? "", user, pass, trimmed);
    }
    const parts = trimmed.split(":");
    // Vendor requires host:port with numeric port and valid host; password may contain : and @
    if (parts.length >= 4 && /^\d+$/.test(parts[1]!) && HOST_PATTERN.test(parts[0]!)) {
      const host = parts[0]!;
      const port = parts[1]!;
      const username = parts[2]!;
      const password = parts.slice(3).join(":");
      return buildProxy("http", host, port, username, password, trimmed);
    }
    if (parts.length === 2 && /^\d+$/.test(parts[1]!) && HOST_PATTERN.test(parts[0]!)) {
      const [host, port] = parts as [string, string];
      return buildProxy("http", host, port, undefined, undefined, trimmed);
    }
    // Not vendor-like; fall through to URL handling (e.g. user:pass@host:port)
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

// ── Bare-form protocol auto-detection ────────────────────────────────────────
// A bare `127.0.0.1:60000` says nothing about whether the port speaks HTTP
// CONNECT or SOCKS. Local tunnels (Clash/V2Ray/SSH -D) are almost always
// SOCKS5 while the parser defaults to http — which makes a perfectly live
// proxy look dead. We sniff once per endpoint and remember the answer.

const detectedScheme = new Map<string, "http" | "socks5">();

function bareKey(input: string): string | null {
  const t = input.trim();
  if (t.includes("://") || t.includes("@")) return null;
  return `${t}`;
}

/**
 * Resolve a proxy string to its best protocol. Explicit schemes are trusted;
 * bare forms get probed once (HTTP first, then a SOCKS5 handshake) and the
 * detected scheme is cached for the lifetime of the process so launches and
 * tests agree without paying the probe again.
 */
export async function resolveProxy(
  input: string,
  options: { timeoutMs?: number } = {},
): Promise<ParsedProxy> {
  const key = bareKey(input);
  const parsed = parseProxy(input);

  if (!key || parsed.protocol !== "http" || !DEFAULT_PORTS.http) {
    // Explicit scheme (or non-default port semantics): trust the operator.
  } else {
    const remembered = detectedScheme.get(key);
    if (remembered === "socks5") {
      return buildProxy("socks5", parsed.host, String(parsed.port), parsed.username, parsed.password, input.trim());
    }
    if (!remembered) {
      const found = await sniffBareProtocol(parsed.host, parsed.port, parsed.username, parsed.password, options.timeoutMs ?? 6_000);
      detectedScheme.set(key, found);
      if (found === "socks5") {
        return buildProxy("socks5", parsed.host, String(parsed.port), parsed.username, parsed.password, input.trim());
      }
    }
  }
  return parsed;
}

/** Reset learned schemes — mainly for tests. */
export function forgetDetectedProxies(): void {
  detectedScheme.clear();
}

/**
 * Sniff whether host:port speaks plain-HTTP-proxy or SOCKS5.
 * Returns whichever answered first; "http" is the fallback answer when
 * nothing conclusive responds (the caller will surface its own errors).
 * Verified with global.rotip.711proxy.com: it answers SOCKS5 handshake (0500/0502)
 * but its SOCKS CONNECT to port 80 hangs, while HTTP CONNECT to 443 works — so we
 * must verify full echo, not just the greeting, before choosing SOCKS.
 */
export async function sniffBareProtocol(
  host: string,
  port: number,
  username: string | undefined,
  password: string | undefined,
  timeoutMs: number,
): Promise<"http" | "socks5"> {
  // Run all probes concurrently; whichever succeeds first determines the protocol.
  // This avoids sequential 4s+4s+8s=16s wait for proxies like 711global that only handle HTTPS.
  const plainTimeout = Math.min(timeoutMs, 4_000);
  const httpsTimeout = Math.min(Math.max(8_000, timeoutMs), 10_000);
  const httpProxy = buildProxy("http", host, String(port), username, password, "");
  // Promise.any ignores rejections, so map null -> rejection to let the race continue
  const socksAny = socks5EchoIp({ host, port, username, password }, plainTimeout).then(() => "socks5" as const).catch(() => { throw new Error("socks fail"); });
  const httpPlainAny = fetchIpThroughProxy(httpProxy, "http://api.ipify.org/", plainTimeout).then(() => "http" as const).catch(() => { throw new Error("http plain fail"); });
  const httpsAny = fetchIpViaHttpsConnect(httpProxy, httpsTimeout).then(() => "http" as const).catch(() => { throw new Error("https fail"); });
  try {
    // First success wins; prefer SOCKS if it completes first, otherwise HTTP
    const winner = await Promise.any([socksAny, httpPlainAny, httpsAny]);
    return winner;
  } catch {
    return "http";
  }
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
): Promise<ProxyCheck & { note?: string }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const checkedAt = new Date().toISOString();
  const started = Date.now();

  let proxy: ParsedProxy;
  let wasBare = false;
  try {
    proxy = parseProxy(input);
    wasBare = !input.trim().includes("://") && !input.trim().includes("@");
  } catch (err) {
    return { ok: false, checkedAt, error: err instanceof Error ? err.message : String(err) };
  }

  // Bare form: sniff the real protocol once (HTTP CONNECT vs SOCKS5) and
  // remember it — launches in this process will use the same answer.
  if (wasBare && proxy.protocol === "http") {
    try {
      await resolveProxy(input, { timeoutMs: Math.min(timeoutMs, 8_000) });
      const remembered = bareKey(input) ? detectedScheme.get(bareKey(input) as string) : undefined;
      if (remembered === "socks5") proxy = buildProxy("socks5", proxy.host, String(proxy.port), proxy.username, proxy.password, input.trim());
    } catch { /* fall through with parsed */ }
  }

  if (proxy.protocol === "socks4" || proxy.protocol === "socks5") {
    try {
      const ip = await socks5EchoIp({ host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password }, timeoutMs);
      const schemeNote = wasBare ? ` — save as socks5://${proxy.host}:${proxy.port} to skip re-detection` : "";
      return {
        ok: true,
        checkedAt,
        latencyMs: Date.now() - started,
        ...(ip ? { ip } : {}),
        error: `SOCKS verified end-to-end${schemeNote}`,
        ...(wasBare ? { note: `bare ip:port answered as ${proxy.protocol.toUpperCase()} — save with the socks5:// prefix` } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const schemeNote = wasBare ? ` — if this endpoint is HTTP, save as http://${proxy.host}:${proxy.port}` : "";
      return { ok: false, checkedAt, latencyMs: Date.now() - started, error: msg + schemeNote };
    }
  }

  // HTTP proxies from vendors like 711proxy often block plain-HTTP absolute-URI GETs
  // (http://api.ipify.org) but handle HTTPS CONNECT correctly. Probe both in parallel
  // and return whichever succeeds first; this avoids sequential 5s+8s=13s wait.
  const plainTimeout = Math.min(timeoutMs, 5_000);
  const httpsTimeout = Math.min(Math.max(8_000, timeoutMs), 10_000);
  const echoUrl = options.echoUrl ?? "http://api.ipify.org/";
  const plainAny = fetchIpThroughProxy(proxy, echoUrl, plainTimeout).then(ip => ({ ip, via: "plain" as const })).catch(err => {
    (err as any).__via = "plain";
    throw err;
  });
  const httpsAny = fetchIpViaHttpsConnect(proxy, httpsTimeout).then(ip => ({ ip, via: "https" as const })).catch(err => {
    (err as any).__via = "https";
    throw err;
  });
  try {
    const winner = await Promise.any([plainAny, httpsAny]);
    return { ok: true, checkedAt, latencyMs: Date.now() - started, ...(winner.ip ? { ip: winner.ip } : {}) };
  } catch (agg) {
    const errors: Error[] = (agg as AggregateError).errors ?? [];
    // Surface credential errors immediately
    for (const e of errors) {
      const code = (e as any)?.statusCode;
      if (code === 401 || code === 407) {
        return {
          ok: false,
          checkedAt,
          latencyMs: Date.now() - started,
          error: `proxy demands credentials (${code}) — enter it as host:port:user:pass, e.g. ${proxy.host}:${proxy.port}:myuser:mypass`,
        };
      }
    }
    const plainErr = errors.find(e => (e as any).__via === "plain") ?? errors[0];
    const httpsErr = errors.find(e => (e as any).__via === "https") ?? errors[1];
    const msg = plainErr instanceof Error ? plainErr.message : String(plainErr ?? "plain failed");
    const msg2 = httpsErr instanceof Error ? httpsErr.message : String(httpsErr ?? "https failed");
    const hint = wasBare ? " — a live local tunnel may be SOCKS5; try the socks5:// prefix" : "";
    return { ok: false, checkedAt, latencyMs: Date.now() - started, error: `${msg} / https: ${msg2}${hint}` };
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

interface SocksEndpoint {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * Minimal SOCKS5 client — greeting, optional user/pass auth, CONNECT to a
 * domain. Just enough to (a) recognise a SOCKS5 port during protocol sniffing
 * and (b) verify it end-to-end without pulling in `socks-proxy-agent`.
 */
export function socks5Handshake(
  proxy: SocksEndpoint,
  timeoutMs: number,
): Promise<{ ok: true; socket: import("node:net").Socket } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    let stage: "greeting" | "auth" | "connect" = "greeting";
    const finish = (result: { ok: true; socket: import("node:net").Socket } | { ok: false; error: string }): void => {
      if (!result.ok) socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("error", (err) => finish({ ok: false, error: err.message }));
    socket.once("timeout", () => finish({ ok: false, error: `socks5 timed out after ${timeoutMs}ms` }));

    socket.on("connect", () => {
      if (proxy.username) {
        // Offer both no-auth and user/pass; 711proxy and similar choose 0x02 when credentials present,
        // and the no-auth path hangs after CONNECT (verified with global.rotip.711proxy.com).
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      } else {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      }
    });

    socket.on("data", (chunk: Buffer) => {
      if (stage === "greeting") {
        // Expect VER=5 METHOD
        if (chunk[0] !== 0x05) return finish({ ok: false, error: "not a SOCKS5 endpoint" });
        const method = chunk[1];
        if (method === 0x00) {
          stage = "connect";
          sendConnect(socket);
        } else if (method === 0x02 && proxy.username) {
          stage = "auth";
          const u = Buffer.from(proxy.username);
          const p = Buffer.from(proxy.password ?? "");
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        } else {
          finish({ ok: false, error: "SOCKS5 requires an unsupported auth method" });
        }
        return;
      }
      if (stage === "auth") {
        if (chunk[1] !== 0x00) return finish({ ok: false, error: "SOCKS5 credentials rejected" });
        stage = "connect";
        sendConnect(socket);
        return;
      }
      // connect reply: VER REP ... BINDADDR BINDPORT
      if (chunk[1] === 0x00) finish({ ok: true, socket });
      else finish({ ok: false, error: `SOCKS5 CONNECT failed (code ${chunk[1]})` });
    });

    function sendConnect(sock: import("node:net").Socket): void {
      const hostBuf = Buffer.from("api.ipify.org");
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([0x00, 0x50]), // port 80
      ]));
    }
  });
}

/** GET the IP-echo through an established SOCKS5 tunnel and pull the IP out. */
async function socks5EchoIp(
  proxy: SocksEndpoint,
  timeoutMs: number,
): Promise<string | undefined> {
  const hs = await socks5Handshake(proxy, timeoutMs);
  if (!hs.ok) throw new Error(hs.error);
  const socket = hs.socket;
  socket.setTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    let body = "";
    socket.write(`GET http://api.ipify.org/ HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n`);
    socket.on("data", (c: Buffer) => { if (body.length < 512) body += c.toString("utf8"); });
    socket.on("end", () => {
      const m = body.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      resolve(m?.[0]);
    });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("echo timed out")); });
    socket.once("error", (e) => { socket.destroy(); reject(e); });
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
export function fetchIpThroughProxy(
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
        if (res.statusCode === 407 || res.statusCode === 401) {
          res.resume();
          const e = new Error("proxy requires credentials");
          (e as any).statusCode = res.statusCode;
          reject(e);
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

/**
 * Fetch IP via HTTPS CONNECT tunnel.
 *
 * Some residential proxies (e.g. 711proxy global.rotip) reject plain HTTP
 * absolute-URI GETs (http://api.ipify.org) with a timeout, but handle
 * CONNECT to port 443 correctly. This mirrors what Chrome does for HTTPS
 * navigations, so we replicate it for the Test button.
 */
export function fetchIpViaHttpsConnect(proxy: ParsedProxy, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const succeed = (ip: string | undefined): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ip);
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => fail(new Error(`https CONNECT timed out after ${timeoutMs}ms`)));
    socket.once("error", (e) => fail(e as Error));

    let headerBuf = "";
    const onData = (chunk: Buffer): void => {
      headerBuf += chunk.toString("utf8");
      if (headerBuf.includes("\r\n\r\n")) {
        socket.removeListener("data", onData);
        const statusLine = headerBuf.split("\r\n")[0] ?? "";
        const m = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
        const code = m ? parseInt(m[1]!, 10) : 0;
        if (code !== 200) {
          const e = new Error(`proxy CONNECT returned HTTP ${code || "?"}`);
          (e as any).statusCode = code;
          fail(e);
          return;
        }
        // Upgrade to TLS over the same socket
        socket.removeAllListeners("timeout");
        socket.removeAllListeners("error");
        const tlsSocket = tlsConnect({
          socket: socket as any,
          servername: "api.ipify.org",
          rejectUnauthorized: false,
        } as any);
        tlsSocket.setTimeout(timeoutMs);
        tlsSocket.once("timeout", () => {
          tlsSocket.destroy();
          fail(new Error(`tls timed out after ${timeoutMs}ms`));
        });
        tlsSocket.once("error", (e) => {
          tlsSocket.destroy();
          fail(e as Error);
        });
        let body = "";
        tlsSocket.on("data", (c: Buffer) => {
          if (body.length < 4096) body += c.toString("utf8");
        });
        const extractIp = (raw: string): string | undefined => {
          // raw includes HTTP headers + body; strip headers to avoid matching Date: 14:25:01 as IPv6
          const sep = raw.indexOf("\r\n\r\n");
          const payload = sep !== -1 ? raw.slice(sep + 4) : raw;
          const m = payload.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
          if (m) return m[0];
          // fallback: IPv6 in payload only
          const m6 = payload.match(/\b[0-9a-f:]{6,}\b/i);
          return m6?.[0];
        };
        tlsSocket.on("end", () => {
          const ip = extractIp(body);
          tlsSocket.destroy();
          succeed(ip);
        });
        // Some servers emit close without end
        tlsSocket.on("close", () => {
          if (!settled) {
            const ip = extractIp(body);
            if (ip) succeed(ip);
            else if (body) succeed(undefined);
          }
        });
        tlsSocket.write("GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\nUser-Agent: Mozilla/5.0\r\n\r\n");
      }
    };
    socket.on("data", onData);

    socket.on("connect", () => {
      let req = `CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\n`;
      if (proxy.username) {
        const token = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64");
        req += `Proxy-Authorization: Basic ${token}\r\n`;
      }
      req += "Proxy-Connection: Keep-Alive\r\n\r\n";
      socket.write(req);
    });
  });
}

// ── Resilient Dynamic Proxy Pool & Quarantine Circuit Breaker ─────────────────

export interface ProxyFeedback {
  proxyServer: string;
  success: boolean;
  statusCode?: number;
  latencyMs?: number;
  isWafBlock?: boolean;
  isRateLimit?: boolean;
  errorMessage?: string;
}

export interface ProxyHealthNode {
  server: string;
  consecutiveFailures: number;
  totalRequests: number;
  successfulRequests: number;
  latencyEmaMs: number;
  quarantineUntil: number;
  quarantineReason?: string;
}

const proxyHealthMap = new Map<string, ProxyHealthNode>();
const BASE_QUARANTINE_MS = 10 * 60 * 1000; // 10 minutes base

export function getProxyHealth(server: string): ProxyHealthNode {
  let node = proxyHealthMap.get(server);
  if (!node) {
    node = {
      server,
      consecutiveFailures: 0,
      totalRequests: 0,
      successfulRequests: 0,
      latencyEmaMs: 0,
      quarantineUntil: 0,
    };
    proxyHealthMap.set(server, node);
  }
  return node;
}

export function isProxyQuarantined(server: string): boolean {
  const node = proxyHealthMap.get(server);
  if (!node) return false;
  if (node.quarantineUntil > Date.now()) return true;
  if (node.quarantineUntil > 0) {
    node.quarantineUntil = 0; // Quarantine expired
  }
  return false;
}

export function reportProxyOutcome(feedback: ProxyFeedback): void {
  const node = getProxyHealth(feedback.proxyServer);
  node.totalRequests++;

  if (feedback.success) {
    node.successfulRequests++;
    node.consecutiveFailures = 0;
    if (feedback.latencyMs && feedback.latencyMs > 0) {
      node.latencyEmaMs = node.latencyEmaMs === 0
        ? feedback.latencyMs
        : Math.round(node.latencyEmaMs * 0.7 + feedback.latencyMs * 0.3);
    }
  } else {
    node.consecutiveFailures++;
    const isWaf = feedback.isWafBlock || feedback.statusCode === 403;
    const is429 = feedback.isRateLimit || feedback.statusCode === 429;

    if (isWaf || is429 || node.consecutiveFailures >= 3) {
      const exponent = Math.min(node.consecutiveFailures - 1, 4);
      const duration = BASE_QUARANTINE_MS * Math.pow(2, exponent);
      node.quarantineUntil = Date.now() + duration;
      node.quarantineReason = isWaf ? "WAF 403 Challenge" : is429 ? "HTTP 429 Rate Limit" : "Consecutive Failures";
    }
  }
}

