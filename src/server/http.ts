/**
 * Dashboard HTTP server.
 *
 * Three kinds of endpoint:
 *
 *   - a small JSON API for managing profiles and sessions
 *   - `/api/events`, a Server-Sent Events channel carrying state pushes
 *   - `/api/profiles/:id/stream.mjpg`, one live browser view per profile
 *
 * The live view is `multipart/x-mixed-replace`, the MJPEG convention every
 * browser has understood for two decades. A tile is then a plain `<img>`: no
 * WebSocket, no client-side decoding, no dependency, and a stalled stream
 * degrades to a frozen last frame instead of a broken tile.
 *
 * Only Node's own `http` module is used, so the dashboard adds nothing to the
 * dependency tree.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Orchestrator } from "./orchestrator.js";
import { DEVICE_CATALOG } from "../browser/identity.js";

/** Shape the device catalog for the dashboard: kinds → model labels. */
function thisCatalog(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [kind, list] of Object.entries(DEVICE_CATALOG)) {
    out[kind] = list.map((d) => d.model);
  }
  return out;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Cap on request bodies — a cookie export is the largest thing we accept. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MJPEG_BOUNDARY = "storefrontsimframe";

export interface DashboardServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Read and JSON-parse a request body, with a size ceiling. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new HttpError(400, `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** An error carrying the status code it should be reported with. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, `"${key}" must be a string`);
  return value;
}

/** Parse a device emulation pick from a request body; undefined = not set. */
function readDevice(body: Record<string, unknown>): import("../profiles/types.js").ProfileDevice | null | undefined {
  if (body.device === null) return null;
  if (typeof body.device !== "object" || body.device === null) return undefined;
  const d = body.device as Record<string, unknown>;
  const kind = d.kind;
  if (kind === "desktop") return null;
  if (kind === "android" || kind === "iphone" || kind === "ipad") {
    let model = typeof d.model === "string" ? d.model.trim() : "";
    if (!model) {
      if (kind === "android") model = "Pixel 7";
      else if (kind === "iphone") model = "iPhone 14 Pro";
      else if (kind === "ipad") model = "iPad Pro 11";
    }
    return { kind, model } as import("../profiles/types.js").ProfileDevice;
  }
  return undefined;
}

/**
 * Browser engine pick from a request body. Absent → undefined (untouched);
 * null / "" / "default" → null (follow the config default).
 */
function readProvider(body: Record<string, unknown>): "builtin" | "bitbrowser" | null | undefined {
  if (!("browserProvider" in body)) return undefined;
  const value = body.browserProvider;
  if (value === null || value === "" || value === "default") return null;
  if (value === "builtin" || value === "bitbrowser") return value;
  throw new HttpError(400, `Invalid browser provider: ${String(value)} (expected builtin or bitbrowser)`);
}

/** BitBrowser profile id from a request body; null/"" unlinks. */
function readBitBrowserId(body: Record<string, unknown>): string | null | undefined {
  if (!("bitBrowserId" in body)) return undefined;
  const value = body.bitBrowserId;
  if (value === null || value === "") return null;
  if (typeof value === "string") return value;
  throw new HttpError(400, `"bitBrowserId" must be a string or null`);
}

function engineFields(body: Record<string, unknown>): { browserProvider?: "builtin" | "bitbrowser" | null; bitBrowserId?: string | null } {
  const provider = readProvider(body);
  const bitBrowserId = readBitBrowserId(body);
  return {
    ...(provider !== undefined ? { browserProvider: provider } : {}),
    ...(bitBrowserId !== undefined ? { bitBrowserId } : {}),
  };
}

/** Constant-time string comparison; unequal lengths fail without leaking where they differ. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a comparison so the length mismatch is not a faster path.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Hostname part of a Host header, port stripped (IPv6 literals keep their brackets). */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0] ?? "";
}

/**
 * DNS-rebinding and cross-site request guard.
 *
 * A dashboard bound to loopback is still reachable from any web page the
 * operator opens: the page's JavaScript can aim `fetch` at 127.0.0.1, or point
 * an attacker-owned hostname at it (DNS rebinding) and read the answers. Two
 * cheap, standard checks close that:
 *   - the Host header must be a loopback name (or the exact host the server was
 *     told to bind to) — a rebound hostname carries the attacker's name;
 *   - a state-changing request that carries an Origin must come from the same
 *     host it is addressed to — a cross-site form or fetch carries a foreign one.
 */
function crossSiteVerdict(req: IncomingMessage, boundHost: string): string | null {
  const hostHeader = String(req.headers.host ?? "");
  const hostname = hostnameOf(hostHeader);
  const bound = boundHost.trim().toLowerCase();
  const wildcard = bound === "0.0.0.0" || bound === "::";
  const loopbackBound = LOOPBACK_HOSTS.has(bound) || bound === "";
  if (loopbackBound && !LOOPBACK_HOSTS.has(hostname)) {
    return `Host "${hostHeader}" is not allowed on a loopback dashboard`;
  }
  if (!loopbackBound && !wildcard && hostname !== bound && !LOOPBACK_HOSTS.has(hostname)) {
    return `Host "${hostHeader}" is not allowed`;
  }
  const method = req.method ?? "GET";
  const origin = req.headers.origin;
  if (origin && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    let originHost = "";
    try { originHost = new URL(origin).host.toLowerCase(); } catch { return "Malformed Origin"; }
    if (originHost !== hostHeader.trim().toLowerCase()) return `Cross-site request from ${origin} refused`;
  }
  return null;
}

/** Serve a static asset from the bundled public directory. */
async function serveStatic(res: ServerResponse, pathname: string, injectToken?: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Resolve inside PUBLIC_DIR and verify the result stayed there, so a
  // traversal like /../../etc/passwd cannot escape.
  const root = resolve(PUBLIC_DIR);
  const target = resolve(root, normalize(relative));
  if (target !== root && !target.startsWith(root + sep)) throw new HttpError(403, "Forbidden");

  let contents: Buffer;
  try {
    contents = await readFile(target);
  } catch {
    throw new HttpError(404, "Not found");
  }

  // Hand the page its token before app.js runs, so every API call it makes
  // can carry it. The caller passes a token ONLY for a request that already
  // proved it knows it; the shell is never a way to obtain it.
  if (injectToken && target.endsWith("index.html")) {
    // "<" is escaped so the value can never close the script element.
    const inject = `<script>window.__DASH_TOKEN__=${JSON.stringify(injectToken).replace(/</g, "\\u003c")};</script>`;
    const html = contents.toString("utf8");
    const headAt = html.indexOf("<head>");
    const patched =
      headAt >= 0
        ? html.slice(0, headAt + 6) + inject + html.slice(headAt + 6)
        : inject + html;
    contents = Buffer.from(patched, "utf8");
  }

  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
    "content-length": contents.length,
    "cache-control": "no-cache",
  });
  res.end(contents);
}

/**
 * Stream a profile's live browser view as MJPEG.
 *
 * The connection stays open for as long as the tile is on screen; the browser
 * closes it when the `<img>` goes away, which is what unsubscribes us.
 */
function streamMjpeg(
  orchestrator: Orchestrator,
  req: IncomingMessage,
  res: ServerResponse,
  profileId: string,
  mode: "thumb" | "full",
): void {
  const screencast = orchestrator.screencastFor(profileId);
  if (!screencast) throw new HttpError(404, "This profile has no browser open");

  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    "cache-control": "no-store, no-transform",
    connection: "close",
    pragma: "no-cache",
  });

  let lastSentAt = 0;

  const writeFrame = (frame: Buffer): void => {
    // `write` returning false means the socket buffer is full: the viewer is
    // slower than the stream. Dropping the frame is the right call for live
    // video — queueing them would build latency that never recovers.
    if (res.writableEnded || res.writableNeedDrain) return;
    res.write(
      `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    res.write(frame);
    res.write("\r\n");
    lastSentAt = Date.now();
  };

  // Show the most recent frame at once, so a tile is never blank while it
  // waits for the page to repaint.
  const initial = screencast.lastFrame;
  if (initial) writeFrame(initial);

  const unsubscribe = screencast.subscribe(writeFrame, mode);

  // Chromium only emits a screencast frame when the page actually repaints, so
  // a session sitting on a static product page can go many seconds without
  // producing one. That starves the stream in a way that is worse than it
  // sounds: a browser rendering multipart/x-mixed-replace only paints a part
  // once the *next* boundary arrives, so a tile whose page has gone quiet
  // stays blank while holding a perfectly good frame.
  //
  // Re-sending the last frame on a slow cadence fixes both halves: the pending
  // part gets flushed, and the connection stays warm through idle stretches.
  const heartbeat = setInterval(() => {
    const frame = screencast.lastFrame;
    if (!frame || res.writableEnded) return;
    if (Date.now() - lastSentAt < 700) return;
    writeFrame(frame);
  }, 500);

  const finish = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on("close", finish);
  req.on("error", finish);
  res.on("error", finish);
}

/**
 * Stream ALL profiles' screens over ONE multipart connection.
 * Each part has X-Profile-Id header so the client knows which tile to update.
 * Replaces N individual MJPEG connections with a single one.
 */
function streamMultiplexedScreens(orchestrator: Orchestrator, req: IncomingMessage, res: ServerResponse): void {
  const BOUNDARY = "multiprofile";

  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "cache-control": "no-store, no-transform",
    connection: "close",
  });

  const unsubs: Array<() => void> = [];
  const lastSentByProfile = new Map<string, number>();
  let closed = false;

  const sendFrame = (profileId: string, frame: Buffer): void => {
    if (closed || res.writableEnded || res.writableNeedDrain) return;
    res.write(
      `--${BOUNDARY}\r\nX-Profile-Id: ${profileId}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
    );
    res.write(frame);
    res.write("\r\n");
    lastSentByProfile.set(profileId, Date.now());
  };

  // Subscribe to each active screencast
  for (const view of orchestrator.snapshot()) {
    const sc = orchestrator.screencastFor(view.profile.id);
    if (!sc) continue;
    try {
      const unsub = sc.subscribe((frame) => {
        sendFrame(view.profile.id, frame);
      }, "thumb");
      unsubs.push(unsub);
    } catch {}
  }

  // Heartbeat: re-send last frames to keep connection warm
  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    const now = Date.now();
    for (const view of orchestrator.snapshot()) {
      const sc = orchestrator.screencastFor(view.profile.id);
      if (!sc?.lastFrame) continue;
      if (now - (lastSentByProfile.get(view.profile.id) ?? 0) >= 2500) {
        sendFrame(view.profile.id, sc.lastFrame);
      }
    }
  }, 3000);

  const cleanup = (): void => {
    closed = true;
    clearInterval(heartbeat);
    unsubs.forEach(u => u());
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
}

/** Build (but do not start) the dashboard HTTP server. */
export function createDashboardServer(orchestrator: Orchestrator, token?: string, boundHost = "127.0.0.1"): Server {
  /** Open SSE connections. */
  const sseClients = new Set<ServerResponse>();

  orchestrator.on("update", (state) => {
    const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of sseClients) {
      if (!client.writableEnded && !client.writableNeedDrain) client.write(payload);
    }
  });

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      let status = 500;
      if (err instanceof HttpError) {
        status = err.status;
      } else if (err instanceof Error) {
        const msg = err.message;
        if (msg.startsWith("No such profile")) status = 404;
        else if (/^(Invalid|cannot|must|empty|greater|Storefront)/i.test(msg)) status = 400;
        else if (/already has a browser open/i.test(msg)) status = 409;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) { res.end(); return; }
      sendJson(res, status, { error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // ---- auth ------------------------------------------------------------
    // When a token is configured, every API call must carry it — query param
    // (so <img>, EventSource and fetch all work) or a Bearer header. The
    // static shell stays open: it holds no state and cannot act.
    const refused = crossSiteVerdict(req, boundHost);
    if (refused) {
      sendJson(res, 403, { error: refused });
      return;
    }

    const presentedToken = url.searchParams.get("token") ?? "";
    const bearerToken = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const authed = !token || safeEqual(presentedToken, token) || safeEqual(bearerToken, token);
    if (token && path.startsWith("/api/") && !authed) {
      sendJson(res, 401, { error: "Invalid or missing dashboard token" });
      return;
    }

    // ---- live state -----------------------------------------------------
    if (path === "/api/health" && method === "GET") {
      sendJson(res, 200, { ok: true, uptime: process.uptime() });
      return;
    }

    if (path === "/api/meta" && method === "GET") {
      sendJson(res, 200, orchestrator.meta());
      return;
    }

    if (path === "/api/devices" && method === "GET") {
      sendJson(res, 200, { catalog: thisCatalog() });
      return;
    }

    if (path === "/api/alerts" && method === "GET") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      sendJson(res, 200, { active: orchestrator.alerts.active, history: orchestrator.alerts.history(limit) });
      return;
    }

    if (path === "/api/bitbrowser/status" && method === "GET") {
      sendJson(res, 200, await orchestrator.bitBrowserStatus());
      return;
    }

    if (path === "/api/bitbrowser/profiles" && method === "GET") {
      const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50) || 50));
      try {
        sendJson(res, 200, await orchestrator.listBitBrowserProfiles(page, pageSize));
      } catch (err) {
        throw new HttpError(502, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (path === "/api/state" && method === "GET") {
      sendJson(res, 200, orchestrator.snapshot());
      return;
    }

    if (path === "/api/config/privacy" && method === "GET") {
      sendJson(res, 200, orchestrator.getPrivacyConfig());
      return;
    }

    if (path === "/api/config/privacy" && method === "PATCH") {
      const body = await readJsonBody(req);
      const allowed = ["disableWebRTC", "disableGeolocation", "enableDoNotTrack", "disableWebGL", "disableCanvas"] as const;
      const patch: Record<string, boolean> = {};
      for (const k of allowed) if (typeof body[k] === "boolean") patch[k] = body[k] as boolean;
      sendJson(res, 200, orchestrator.updatePrivacyConfig(patch));
      return;
    }

    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`event: state\ndata: ${JSON.stringify(orchestrator.snapshot())}\n\n`);
      sseClients.add(res);

      // A comment line every 20s keeps intermediaries from timing the
      // connection out while nothing is happening.
      const keepAlive = setInterval(() => {
        if (!res.writableEnded) res.write(": keep-alive\n\n");
      }, 20_000);

      const drop = (): void => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      };
      req.on("close", drop);
      req.on("error", drop);
      return;
    }

    // ---- profile collection ---------------------------------------------
    if (path === "/api/profiles" && method === "POST") {
      const body = await readJsonBody(req);
      const profile = orchestrator.createProfile({
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.proxy === "string" ? { proxy: body.proxy } : {}),
        ...(typeof body.durationMinutes === "number"
          ? { durationMinutes: body.durationMinutes }
          : {}),
        ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
        ...(typeof body.locale === "string" ? { locale: body.locale } : {}),
        // Per-profile ATC schedule: number of minutes, or null for default.
        ...(body.atcMinutes === null || typeof body.atcMinutes === "number"
          ? { atcMinutes: body.atcMinutes as number | null }
          : {}),
        // Same fields the edit path accepts, so the create modal can configure
        // everything a profile has without a follow-up PATCH.
        ...(body.storefront === null || typeof body.storefront === "string"
          ? { storefront: body.storefront as string | null }
          : {}),
        ...(typeof body.headed === "boolean" ? { headed: body.headed } : {}),
        ...(() => { const d = readDevice(body); return d === undefined ? {} : { device: d }; })(),
        ...engineFields(body),
      });
      sendJson(res, 201, profile);
      return;
    }

    // ---- batch operations -------------------------------------------
    if (path === "/api/profiles/batch-delete" && method === "POST") {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === "string") : [];
      const results = await Promise.allSettled(ids.map((id: string) => orchestrator.deleteProfile(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      sendJson(res, 200, { deleted: ids.length - failed, failed });
      return;
    }

    // ---- bulk create: paste N sites + M proxies, get profiles fast ------
    // One profile per proxy (M profiles), each pinned to a site round-robin
    // from the pasted list. Sites and proxies need not match in count.
    if (path === "/api/profiles/bulk-create" && method === "POST") {
      const body = await readJsonBody(req);
      const sites = Array.isArray(body.sites)
        ? body.sites.filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
        : [];
      const proxies = Array.isArray(body.proxies)
        ? body.proxies.filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
        : [];
      const durationMinutes = typeof body.durationMinutes === "number" ? body.durationMinutes : undefined;
      const atcMinutes =
        body.atcMinutes === null || typeof body.atcMinutes === "number"
          ? (body.atcMinutes as number | null)
          : undefined;
      const device = readDevice(body);
      const browserProvider = readProvider(body);
      const result = orchestrator.bulkCreateProfiles({
        sites,
        proxies,
        durationMinutes,
        atcMinutes,
        device,
        ...(browserProvider !== undefined ? { browserProvider } : {}),
      });
      sendJson(res, 201, result);
      return;
    }

    // ---- bulk device: apply a device emulation config to ALL profiles -----
    if (path === "/api/profiles/bulk-device" && method === "POST") {
      const body = await readJsonBody(req);
      const device = readDevice(body);
      const profiles = orchestrator.listProfiles();
      for (const p of profiles) {
        orchestrator.updateProfile(p.id, { device });
      }
      sendJson(res, 200, { updated: profiles.length, device });
      return;
    }

    // ---- single profile --------------------------------------------------
    const profileMatch = /^\/api\/profiles\/([^/]+)(\/.*)?$/.exec(path);
    if (profileMatch) {
      const id = decodeURIComponent(profileMatch[1] ?? "");
      const action = profileMatch[2] ?? "";

      if (action === "" && method === "PATCH") {
        const body = await readJsonBody(req);
        sendJson(
          res,
          200,
          orchestrator.updateProfile(id, {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.proxy === "string" ? { proxy: body.proxy } : {}),
            ...(body.durationMinutes === null || typeof body.durationMinutes === "number"
              ? { durationMinutes: body.durationMinutes as number | null }
              : {}),
            ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
            ...(typeof body.locale === "string" ? { locale: body.locale } : {}),
            // null clears the override; a number sets minutes (0 = off).
            ...(body.atcMinutes === null || typeof body.atcMinutes === "number"
              ? { atcMinutes: body.atcMinutes as number | null }
              : {}),
            // null clears the override; a string sets it. Absent = untouched.
            ...(body.storefront === null || typeof body.storefront === "string"
              ? { storefront: body.storefront as string | null }
              : {}),
            ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
            ...(() => { const d = readDevice(body); return d === undefined ? {} : { device: d }; })(),
            ...engineFields(body),
          }),
        );
        return;
      }

      if (action === "" && method === "DELETE") {
        await orchestrator.deleteProfile(id);
        sendJson(res, 200, { deleted: id });
        return;
      }

      if (action === "/cookies" && method === "POST") {
        const body = await readJsonBody(req);
        const text = requireString(body, "contents");
        const name = typeof body.filename === "string" ? body.filename : "cookies";
        const { parsed, geo } = await orchestrator.importCookies(id, text, name);
        sendJson(res, 200, {
          format: parsed.format,
          imported: parsed.cookies.length,
          warnings: parsed.warnings.slice(0, 10),
          geoSync: geo ? { country: geo.countryCode, countryName: geo.countryName, timezone: geo.timezone, locale: geo.locale } : null,
        });
        return;
      }

      if (action === "/cookies" && method === "DELETE") {
        orchestrator.clearCookies(id);
        sendJson(res, 200, { cleared: id });
        return;
      }

      if (action === "/proxy/test" && method === "POST") {
        const profile = await orchestrator.checkProxy(id);
        sendJson(res, 200, profile.proxyCheck);
        return;
      }

      if (action === "/start" && method === "POST") {
        // Fire-and-forget: don't block the HTTP response waiting for browser launch.
        // The dashboard polls /api/state via SSE to see status changes.
        orchestrator.startProfile(id).catch(err => {
          console.error("start failed:", err.message);
        });
        sendJson(res, 202, { queued: true });
        return;
      }

      if (action === "/continue" && method === "POST") {
        const body = await readJsonBody(req);
        const extendMs =
          typeof body.extendMinutes === "number"
            ? Math.round(body.extendMinutes * 60_000)
            : undefined;
        sendJson(res, 200, await orchestrator.continueProfile(id, extendMs));
        return;
      }

      if (action === "/show" && method === "POST") {
        const body = await readJsonBody(req);
        const headed = body.headed !== false;
        sendJson(res, 200, { headed, session: await orchestrator.setHeaded(id, headed) });
        return;
      }

      if (action === "/pause" && method === "POST") {
        orchestrator.pauseProfile(id);
        sendJson(res, 200, { paused: id });
        return;
      }

      if (action === "/park" && method === "POST") {
        orchestrator.parkProfile(id);
        sendJson(res, 200, { parked: id });
        return;
      }

      if (action === "/extend" && method === "POST") {
        const body = await readJsonBody(req);
        const minutes = typeof body.minutes === "number" ? body.minutes : 5;
        orchestrator.extendProfile(id, Math.round(minutes * 60_000));
        sendJson(res, 200, { extended: id, minutes });
        return;
      }

      if (action === "/force-atc" && method === "POST") {
        const ok = orchestrator.forceAddToCart(id);
        sendJson(res, 200, { forced: ok });
        return;
      }

      if (action === "/close" && method === "POST") {
        await orchestrator.closeSession(id);
        sendJson(res, 200, { closed: id });
        return;
      }

      if (action === "/stream.mjpg" && method === "GET") {
        const mode = url.searchParams.get("mode") === "full" ? "full" : "thumb";
        streamMjpeg(orchestrator, req, res, id, mode);
        return;
      }
    }

    // ---- Multiplexed screen stream: ALL profiles over ONE connection ----
    if (path === "/api/screens.mjpg" && method === "GET") {
      streamMultiplexedScreens(orchestrator, req, res);
      return;
    }

    if (path.startsWith("/api/")) throw new HttpError(404, `No such endpoint: ${method} ${path}`);
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    // The shell gets the token injected only when the visitor already holds it
    // (opened via /?token=…); without it the page loads but every API call 401s.
    await serveStatic(res, path, token && authed ? token : undefined);
  }
}

/** Start the dashboard on `host:port`. */
export async function startDashboard(
  orchestrator: Orchestrator,
  port: number,
  host: string,
  token?: string,
): Promise<DashboardServer> {
  const server = createDashboardServer(orchestrator, token, host);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;

  return {
    server,
    url: `http://${displayHost}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}