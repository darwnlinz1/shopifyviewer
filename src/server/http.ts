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
import { dirname, join, extname, normalize } from "node:path";
import type { Orchestrator } from "./orchestrator.js";

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

/** Serve a static asset from the bundled public directory. */
async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Resolve inside PUBLIC_DIR and verify the result stayed there, so a
  // traversal like /../../etc/passwd cannot escape.
  const target = join(PUBLIC_DIR, normalize(relative));
  if (!target.startsWith(PUBLIC_DIR)) throw new HttpError(403, "Forbidden");

  let contents: Buffer;
  try {
    contents = await readFile(target);
  } catch {
    throw new HttpError(404, "Not found");
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
  };

  // Show the most recent frame at once, so a tile is never blank while it
  // waits for the page to repaint.
  const initial = screencast.lastFrame;
  if (initial) writeFrame(initial);

  const unsubscribe = screencast.subscribe(writeFrame, mode);
  const finish = (): void => {
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on("close", finish);
  req.on("error", finish);
  res.on("error", finish);
}

/** Build (but do not start) the dashboard HTTP server. */
export function createDashboardServer(orchestrator: Orchestrator): Server {
  /** Open SSE connections. */
  const sseClients = new Set<ServerResponse>();

  orchestrator.on("update", (state) => {
    const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of sseClients) {
      if (!client.writableEnded) client.write(payload);
    }
  });

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // ---- live state -----------------------------------------------------
    if (path === "/api/meta" && method === "GET") {
      sendJson(res, 200, orchestrator.meta());
      return;
    }

    if (path === "/api/state" && method === "GET") {
      sendJson(res, 200, orchestrator.snapshot());
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
      });
      sendJson(res, 201, profile);
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
            ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
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
        const parsed = orchestrator.importCookies(id, text, name);
        sendJson(res, 200, {
          format: parsed.format,
          imported: parsed.cookies.length,
          warnings: parsed.warnings.slice(0, 10),
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
        sendJson(res, 200, await orchestrator.startProfile(id));
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

    if (path.startsWith("/api/")) throw new HttpError(404, `No such endpoint: ${method} ${path}`);
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    await serveStatic(res, path);
  }
}

/** Start the dashboard on `host:port`. */
export async function startDashboard(
  orchestrator: Orchestrator,
  port: number,
  host: string,
): Promise<DashboardServer> {
  const server = createDashboardServer(orchestrator);

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
