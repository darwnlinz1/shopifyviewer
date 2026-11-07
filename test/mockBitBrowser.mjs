/**
 * Mock of the BitBrowser Local API.
 *
 * Speaks the same wire format as the app (POST + JSON body, `{ success,
 * data | msg }` replies) and records every request with its arrival time, so
 * tests can assert payloads and the client's rate limiting. `/browser/open`
 * launches a real headless Chrome with remote debugging and hands back its
 * CDP websocket — the same contract BitBrowser's kernel fulfils — which lets
 * the whole connectOverCDP path run without the app installed.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startMockBitBrowser({ chromePath, failOpenFor = new Set() } = {}) {
  const requests = [];
  const profiles = new Map();
  const running = new Map();
  let nextId = 1;
  const workDir = mkdtempSync(join(tmpdir(), "mock-bitbrowser-"));

  const reply = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };

  async function openChrome(id, args) {
    if (!chromePath) throw new Error("mock has no chromePath");
    const userDataDir = join(workDir, `profile-${id}`);
    const child = spawn(
      chromePath,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        ...args.filter((a) => a.startsWith("--headless") || a.startsWith("--autoplay")),
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const portFile = join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, "utf8").split(/\r?\n/);
        if (port && path) {
          running.set(id, child);
          return { ws: `ws://127.0.0.1:${port}${path}`, http: `127.0.0.1:${port}`, pid: child.pid, coreVersion: "mock" };
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill();
    throw new Error("chrome did not expose a debugging port");
  }

  function closeChrome(id) {
    const child = running.get(id);
    if (!child) return false;
    running.delete(id);
    child.kill();
    return true;
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { body = {}; }
      const path = new URL(req.url, "http://x").pathname;
      requests.push({ path, body, at: Date.now(), apiKey: req.headers["x-api-key"] ?? null });
      if (req.method !== "POST") return reply(res, 405, { success: false, msg: "POST only" });
      try {
        switch (path) {
          case "/health":
            return reply(res, 200, { success: true, data: {} });
          case "/browser/list": {
            const list = [...profiles.values()].map((p) => ({ id: p.id, seq: p.seq, name: p.name, remark: p.remark ?? "", proxyType: p.proxyType ?? "noproxy", status: running.has(p.id) ? 1 : 0 }));
            return reply(res, 200, { success: true, data: { page: body.page ?? 0, pageSize: body.pageSize ?? 10, totalNum: list.length, list } });
          }
          case "/browser/update": {
            if (!body.browserFingerPrint) return reply(res, 200, { success: false, msg: "browserFingerPrint is required" });
            const id = body.id ?? `bb${String(nextId++).padStart(30, "0")}`;
            profiles.set(id, { ...(profiles.get(id) ?? {}), ...body, id, seq: profiles.size + 100 });
            return reply(res, 200, { success: true, data: { id } });
          }
          case "/browser/update/partial": {
            for (const id of body.ids ?? []) {
              const p = profiles.get(id);
              if (!p) return reply(res, 200, { success: false, msg: `browser ${id} not exist` });
              const { ids: _ids, ...fields } = body;
              profiles.set(id, { ...p, ...fields });
            }
            return reply(res, 200, { success: true, data: {} });
          }
          case "/browser/open": {
            if (!profiles.has(body.id)) return reply(res, 200, { success: false, msg: `browser ${body.id} not exist` });
            if (failOpenFor.has(body.id)) return reply(res, 200, { success: false, msg: "open failed (injected)" });
            const data = await openChrome(body.id, body.args ?? []);
            return reply(res, 200, { success: true, data });
          }
          case "/browser/close":
            closeChrome(body.id);
            return reply(res, 200, { success: true, data: {} });
          case "/browser/delete":
            closeChrome(body.id);
            profiles.delete(body.id);
            return reply(res, 200, { success: true, data: {} });
          default:
            return reply(res, 404, { success: false, msg: `no route ${path}` });
        }
      } catch (err) {
        return reply(res, 200, { success: false, msg: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    profiles,
    running,
    /** Requests to one endpoint, in arrival order. */
    calls: (path) => requests.filter((r) => r.path === path),
    async close() {
      for (const id of [...running.keys()]) closeChrome(id);
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      await new Promise((r) => setTimeout(r, 500));
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
