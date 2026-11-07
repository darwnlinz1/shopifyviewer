/**
 * BitBrowser kernel provider.
 *
 * BitBrowser's C++ kernel spoofs canvas, WebGL/WebGPU, audio, client rects
 * and WebRTC below the JavaScript layer, in every realm — workers, service
 * workers and iframes included — which is exactly where our own init-script
 * patches leak. So in this mode SiteViewer only drives: the profile is opened
 * through the BitBrowser Local API, Playwright attaches over CDP, and nothing
 * is injected into the page. Stacking `Object.defineProperty` patches on top
 * of the kernel's values would contradict them.
 *
 * Local API: every endpoint is `POST <apiUrl><path>` with a JSON body, and
 * replies `{ success, data | msg }`. The app rejects bursts, so all calls in
 * the process share one queue that spaces request starts apart.
 */
import { createHash } from "node:crypto";
import type { Browser } from "rebrowser-playwright";
import type { BitBrowserConfig, SimulatorConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Profile } from "../profiles/types.js";
import { resolveProxy, redactProxy, type ParsedProxy } from "../profiles/proxy.js";
import { resolveDevice } from "./identity.js";
import { applyRuntimeCpuOptimizations } from "../performance/RuntimeCpuOptimizer.js";
import { setupNetworkFilter } from "../navigator/networkFilter.js";
import { measureViewport } from "./viewport.js";
import { sleep } from "../util/random.js";
import {
  closeSystemTabs,
  hardWriteCookies,
  syncJar,
  type LaunchRequest,
  type LaunchedBrowser,
} from "./chrome.js";

export const DEFAULT_BITBROWSER: Required<Pick<BitBrowserConfig, "apiUrl" | "coreVersion" | "autoCreateProfile" | "minRequestIntervalMs">> = {
  apiUrl: "http://127.0.0.1:54345",
  coreVersion: "136",
  autoCreateProfile: true,
  minRequestIntervalMs: 350,
};

export function bitBrowserSettings(config: SimulatorConfig): BitBrowserConfig & typeof DEFAULT_BITBROWSER {
  return { ...DEFAULT_BITBROWSER, ...(config.browser.bitbrowser ?? {}) };
}

/** What `/browser/open` hands back. */
export interface BitBrowserOpenData {
  ws: string;
  http?: string;
  coreVersion?: string;
  driver?: string;
  pid?: number;
  seq?: number;
}

export interface BitBrowserProfileSummary {
  id: string;
  seq?: number;
  name?: string;
  remark?: string;
  groupId?: string;
  proxyType?: string;
  status?: number;
}

export class BitBrowserApiError extends Error {
  constructor(
    readonly endpoint: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BitBrowserApiError";
  }
}

interface ClientOptions {
  minIntervalMs?: number;
  timeoutMs?: number;
  apiKey?: string;
}

/** Thin Local API client; one instance per API endpoint shares the rate limit. */
export class BitBrowserClient {
  readonly apiUrl: string;
  /** Slots are handed out one at a time, measured from the previous request's actual start. */
  private slotChain: Promise<void> = Promise.resolve();
  private lastDispatchAt = 0;
  /**
   * Opens and closes run one at a time. BitBrowser rejects a burst of
   * /browser/open ("reduce the interface request frequency") and then kills
   * the windows it did start.
   */
  private heavyChain: Promise<void> = Promise.resolve();

  constructor(apiUrl: string, private readonly options: ClientOptions = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  private acquireSlot(): Promise<void> {
    const gap = Math.max(0, this.options.minIntervalMs ?? DEFAULT_BITBROWSER.minRequestIntervalMs);
    const turn = this.slotChain.then(async () => {
      const wait = this.lastDispatchAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastDispatchAt = Date.now();
    });
    this.slotChain = turn.catch(() => undefined);
    return turn;
  }

  async call<T = unknown>(endpoint: string, body: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.acquireSlot();
    const limit = timeoutMs ?? this.options.timeoutMs ?? 20_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    let res: Response;
    try {
      res = await fetch(this.apiUrl + endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { "x-api-key": this.options.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const why = controller.signal.aborted
        ? `timed out after ${limit}ms`
        : err instanceof Error ? err.message : String(err);
      throw new BitBrowserApiError(
        endpoint,
        `BitBrowser Local API ${endpoint} failed at ${this.apiUrl}: ${why}. Is BitBrowser running and signed in?`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => "");
    let json: { success?: boolean; data?: unknown; msg?: string } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new BitBrowserApiError(endpoint, `BitBrowser ${endpoint}: non-JSON reply (HTTP ${res.status})`, res.status);
    }
    if (!res.ok || !json || json.success !== true) {
      const msg = json?.msg || `HTTP ${res.status}`;
      throw new BitBrowserApiError(endpoint, `BitBrowser ${endpoint}: ${msg}`, res.status);
    }
    return json.data as T;
  }

  /** True when the app answers and the signed-in token still works. `/health` stays up after logout. */
  async health(): Promise<boolean> {
    try {
      await this.call("/health", {}, 5_000);
    } catch (err) {
      if (!(err instanceof BitBrowserApiError && err.status === 404)) throw err;
    }
    await this.call("/browser/list", { page: 0, pageSize: 1 }, 8_000);
    return true;
  }

  async list(page = 0, pageSize = 50): Promise<{ list: BitBrowserProfileSummary[]; totalNum: number }> {
    const data = await this.call<{ list?: Array<Record<string, unknown>>; totalNum?: number }>(
      "/browser/list",
      { page, pageSize },
    );
    const list = (data?.list ?? []).map((row) => ({
      id: String(row.id ?? ""),
      ...(typeof row.seq === "number" ? { seq: row.seq } : {}),
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      ...(typeof row.remark === "string" ? { remark: row.remark } : {}),
      ...(typeof row.groupId === "string" ? { groupId: row.groupId } : {}),
      ...(typeof row.proxyType === "string" ? { proxyType: row.proxyType } : {}),
      ...(typeof row.status === "number" ? { status: row.status } : {}),
    }));
    return { list, totalNum: Number(data?.totalNum ?? list.length) };
  }

  /** Create a profile; the fingerprint object is mandatory on create. */
  async create(payload: Record<string, unknown>): Promise<string> {
    const data = await this.call<{ id?: string }>("/browser/update", payload, 30_000);
    if (!data?.id) throw new BitBrowserApiError("/browser/update", "BitBrowser created no profile id");
    return data.id;
  }

  /** Change only the given fields; the stored fingerprint is left alone. */
  async updatePartial(ids: string[], fields: Record<string, unknown>): Promise<void> {
    await this.call("/browser/update/partial", { ids, ...fields }, 30_000);
  }

  private enqueueHeavy<T>(fn: () => Promise<T>, settleMs: number): Promise<T> {
    const run = this.heavyChain.then(fn, fn);
    this.heavyChain = run.then(() => sleep(settleMs), () => sleep(settleMs)).then(() => undefined);
    return run;
  }

  async open(id: string, args: string[]): Promise<BitBrowserOpenData> {
    // queue: the app serialises launches itself. We also keep only one open
    // in flight; five parallel /browser/open calls make it drop the windows.
    return this.enqueueHeavy(
      () => this.call<BitBrowserOpenData>("/browser/open", { id, args, queue: true }, 120_000),
      1_500,
    );
  }

  async close(id: string): Promise<void> {
    await this.enqueueHeavy(() => this.call("/browser/close", { id }, 30_000), 400);
  }

  async delete(id: string): Promise<void> {
    await this.call("/browser/delete", { id }, 30_000);
  }
}

const clients = new Map<string, BitBrowserClient>();

/** The process-wide client for an API endpoint, so every session shares one rate limit. */
export function bitBrowserClientFor(cfg: BitBrowserConfig): BitBrowserClient {
  const apiUrl = (cfg.apiUrl || DEFAULT_BITBROWSER.apiUrl).replace(/\/+$/, "");
  const apiKey = cfg.apiKey || process.env.BITBROWSER_API_KEY || "";
  const key = `${apiUrl}|${apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new BitBrowserClient(apiUrl, {
      minIntervalMs: cfg.minRequestIntervalMs ?? DEFAULT_BITBROWSER.minRequestIntervalMs,
      ...(apiKey ? { apiKey } : {}),
    });
    clients.set(key, client);
  }
  return client;
}

export async function checkBitBrowserHealth(
  cfg: BitBrowserConfig,
): Promise<{ ok: boolean; apiUrl: string; latencyMs?: number; error?: string }> {
  const client = bitBrowserClientFor(cfg);
  const started = Date.now();
  try {
    await client.health();
    return { ok: true, apiUrl: client.apiUrl, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, apiUrl: client.apiUrl, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stable digest of the proxy endpoint and credentials, stored on the profile
 * so a launch only pushes the proxy when it actually changed — without ever
 * keeping a second plaintext copy of the password.
 */
export function proxySignature(proxy: ParsedProxy | undefined): string {
  if (!proxy) return "noproxy";
  return createHash("sha256")
    .update(`${proxy.protocol}|${proxy.host}|${proxy.port}|${proxy.username ?? ""}|${proxy.password ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}

/** Proxy fields in the Local API's shape (proxyMethod 2 = custom proxy). */
export function bitProxyFields(proxy: ParsedProxy | undefined): Record<string, unknown> {
  if (!proxy) return { proxyMethod: 2, proxyType: "noproxy" };
  if (proxy.protocol === "socks4") {
    throw new Error("BitBrowser has no socks4 proxy type; use http, https or socks5");
  }
  return {
    proxyMethod: 2,
    proxyType: proxy.protocol,
    host: proxy.host.replace(/^\[|\]$/g, ""),
    port: proxy.port,
    proxyUserName: proxy.username ?? "",
    proxyPassword: proxy.password ?? "",
  };
}

/**
 * Create payload for a new BitBrowser profile. Timezone, language and
 * geolocation follow the proxy exit IP; canvas/WebGL/audio/client-rect noise
 * and WebRTC replacement are done by the kernel.
 */
export function buildBitProfileCreatePayload(
  profile: Profile,
  proxy: ParsedProxy | undefined,
  cfg: BitBrowserConfig,
): Record<string, unknown> {
  const device = resolveDevice(profile.device);
  // The Local API models Android as "Linux armv81" and every iOS device as
  // "iPhone"; other spellings fail its fingerprint validation.
  const ostype = !device ? "PC" : device.kind === "android" ? "Android" : "IOS";
  const os = !device ? "Win32" : device.kind === "android" ? "Linux armv81" : "iPhone";
  return {
    name: profile.name,
    remark: `SiteViewer profile ${profile.id}`,
    ...(cfg.groupId ? { groupId: cfg.groupId } : {}),
    ...bitProxyFields(proxy),
    browserFingerPrint: {
      coreProduct: "chrome",
      coreVersion: cfg.coreVersion ?? DEFAULT_BITBROWSER.coreVersion,
      ostype,
      os,
      isIpCreateTimeZone: true,
      isIpCreateLanguage: true,
      isIpCreatePosition: true,
      webRTC: "0",
      canvas: "0",
      webGL: "0",
      webGLMeta: "0",
      audioContext: "0",
      clientRectNoiseEnabled: true,
    },
  };
}

export interface BitProfileSync {
  id: string;
  created: boolean;
  proxySynced: boolean;
  /** SiteViewer owns the BitBrowser profile (and deletes it with ours). */
  managed: boolean;
  /** Signature of the proxy now on the BitBrowser profile; "" when untouched. */
  proxySig: string;
}

/**
 * Make sure the BitBrowser side exists and carries this profile's proxy.
 *
 * No id yet → create one with the full kernel fingerprint config. An id that
 * SiteViewer created gets the proxy re-pushed whenever it changed. An id the
 * operator pasted in keeps whatever proxy it has in BitBrowser unless this
 * profile sets one — clearing it from our side must not wipe theirs.
 */
export async function syncOrCreateBitProfile(
  client: BitBrowserClient,
  profile: Profile,
  proxy: ParsedProxy | undefined,
  cfg: BitBrowserConfig,
  logger?: Logger,
): Promise<BitProfileSync> {
  const sig = proxySignature(proxy);
  if (profile.bitBrowserId) {
    const managed = profile.bitBrowserManaged === true;
    const push = (managed || !!proxy) && profile.bitBrowserProxySig !== sig;
    if (push) {
      await client.updatePartial([profile.bitBrowserId], bitProxyFields(proxy));
      logger?.info("bitbrowser_proxy_synced", `proxy pushed to BitBrowser profile ${profile.bitBrowserId}`, {
        data: { proxy: proxy ? redactProxy(proxy.raw) : "noproxy" },
      });
    }
    return {
      id: profile.bitBrowserId,
      created: false,
      proxySynced: push,
      managed,
      proxySig: push ? sig : (profile.bitBrowserProxySig ?? ""),
    };
  }

  if (cfg.autoCreateProfile === false) {
    throw new Error(
      `Profile "${profile.name}" has no BitBrowser profile ID and browser.bitbrowser.autoCreateProfile is off. ` +
        `Paste an existing BitBrowser profile ID in the profile settings.`,
    );
  }
  const id = await client.create(buildBitProfileCreatePayload(profile, proxy, cfg));
  logger?.info("bitbrowser_profile_created", `created BitBrowser profile ${id}`, {
    data: { coreVersion: cfg.coreVersion, proxy: proxy ? redactProxy(proxy.raw) : "noproxy" },
  });
  return { id, created: true, proxySynced: true, managed: true, proxySig: sig };
}

/** Errors the app returns when the profile id no longer exists on its side. */
function isMissingProfileError(err: unknown): boolean {
  return /not\s*(exist|found)|不存在|no such|invalid id|browser.*deleted/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * CLI runs have no dashboard profile; they borrow operator-provided
 * BitBrowser ids by slot instead of creating a new profile every run.
 */
function cliStandInProfile(req: LaunchRequest, cfg: BitBrowserConfig): Profile {
  const ids = cfg.profileIds ?? [];
  const id = ids.length > 0 ? ids[req.slot % ids.length] : undefined;
  if (!id) {
    throw new Error(
      "BitBrowser provider without a dashboard profile needs browser.bitbrowser.profileIds (existing BitBrowser profile IDs, one per slot).",
    );
  }
  return {
    id: `cli-slot-${req.slot}`,
    name: `SiteViewer slot ${req.slot}`,
    ordinal: req.slot,
    createdAt: new Date().toISOString(),
    proxy: "",
    identity: { seed: req.slot, viewport: { width: 1440, height: 900 } },
    bitBrowserId: id,
    bitBrowserManaged: false,
    stats: { runs: 0, pagesVisited: 0, productsViewed: 0, jsErrors: 0 },
  };
}

/** Launch arguments for `/browser/open`. */
export function bitBrowserOpenArgs(headless: boolean): string[] {
  // Each window is a full Chromium. These flags cut renderer processes and
  // caches. They do not shrink the BitBrowser client process itself.
  return [
    "--autoplay-policy=user-gesture-required",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints,AudioServiceOutOfProcess,InterestFeedContentSuggestions",
    "--renderer-process-limit=3",
    "--disk-cache-size=33554432",
    "--js-flags=--max-old-space-size=384",
    ...(headless ? ["--headless=new"] : []),
  ];
}

/**
 * Open the profile in BitBrowser and attach to it.
 *
 * The default context IS the BitBrowser profile — its cookies, storage and
 * kernel fingerprint — so it is used as-is: `browser.newContext()` would open
 * a blank incognito-like context that has none of that.
 */
export async function launchBitBrowser(req: LaunchRequest): Promise<LaunchedBrowser> {
  const { config, logger, slot } = req;
  const cfg = bitBrowserSettings(config);
  const client = bitBrowserClientFor(cfg);
  const profile = req.profile ?? cliStandInProfile(req, cfg);

  const proxyInput = req.profile?.proxy
    || (config.browser.proxies.length > 0 ? config.browser.proxies[slot % config.browser.proxies.length] : undefined);
  const proxy = proxyInput ? await resolveProxy(proxyInput) : undefined;

  const timing = { syncMs: 0, openMs: 0, attachMs: 0 };
  let mark = Date.now();
  let sync = await syncOrCreateBitProfile(client, profile, proxy, cfg, logger);
  timing.syncMs = Date.now() - mark;
  const remember = (s: BitProfileSync): void => {
    profile.bitBrowserId = s.id;
    profile.bitBrowserManaged = s.managed;
    if (s.proxySig) profile.bitBrowserProxySig = s.proxySig;
    if (req.profile) req.hooks?.bitBrowserLinked?.(s);
  };
  remember(sync);

  const args = bitBrowserOpenArgs(config.browser.headless);
  logger.info("browser_launch", "opening BitBrowser profile", {
    data: { bitBrowserId: sync.id, headless: config.browser.headless, proxy: proxy ? redactProxy(proxy.raw) : null, apiUrl: client.apiUrl },
  });

  let opened: BitBrowserOpenData;
  mark = Date.now();
  try {
    opened = await client.open(sync.id, args);
  } catch (err) {
    if (!(sync.managed && !sync.created && cfg.autoCreateProfile !== false && isMissingProfileError(err))) throw err;
    // Deleted on the BitBrowser side: a profile SiteViewer owns is simply recreated.
    logger.warn("bitbrowser_profile_missing", `BitBrowser profile ${sync.id} is gone — recreating`);
    delete profile.bitBrowserId;
    delete profile.bitBrowserProxySig;
    sync = await syncOrCreateBitProfile(client, profile, proxy, cfg, logger);
    remember(sync);
    opened = await client.open(sync.id, args);
  }
  if (!opened?.ws) {
    await client.close(sync.id).catch(() => undefined);
    throw new Error(`BitBrowser /browser/open returned no CDP websocket for ${sync.id}`);
  }
  timing.openMs = Date.now() - mark;
  mark = Date.now();

  const { chromium } = await import("rebrowser-playwright");
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(opened.ws, { timeout: 30_000 });
  } catch (err) {
    await client.close(sync.id).catch(() => undefined);
    throw err;
  }
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    await client.close(sync.id).catch(() => undefined);
    throw new Error("BitBrowser kernel exposed no default browser context");
  }

  // Deliberately no context.addInitScript() here — see the file header.
  // Drop the kernel's console tab before any CDP setup, so we never attach to
  // a page we are about to close.
  await closeSystemTabs(context);
  await applyRuntimeCpuOptimizations(context);
  context.on("page", (p) => {
    void setupNetworkFilter(p).catch(() => {});
    void measureViewport(p).catch(() => undefined);
  });
  for (const p of context.pages()) {
    void setupNetworkFilter(p).catch(() => {});
    await measureViewport(p).catch(() => undefined);
  }

  let cookiesInjected: number;
  if (req.profile?.pendingCookieWrite) {
    // An import that arrived while the window was closed: overwrite, like a live import.
    cookiesInjected = await hardWriteCookies(context, req.profile.cookies?.cookies, logger);
    delete req.profile.pendingCookieWrite;
    req.hooks?.cookiesHardWritten?.();
  } else {
    cookiesInjected = await syncJar(context, req.profile, logger);
  }

  timing.attachMs = Date.now() - mark;
  const profilePath = `bitbrowser:${sync.id}`;
  (context as any).__profilePath = profilePath;
  logger.info("browser_ready", `Browser ready (bitbrowser) sync=${timing.syncMs}ms open=${timing.openMs}ms attach=${timing.attachMs}ms`, {
    data: {
      engine: "bitbrowser",
      bitBrowserId: sync.id,
      created: sync.created,
      coreVersion: opened.coreVersion ?? null,
      pid: opened.pid ?? null,
      cookiesInjected,
      ...timing,
    },
  });

  const bitBrowserId = sync.id;
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    // Disconnecting leaves the kernel running; the Local API closes the window
    // and lets BitBrowser persist the profile.
    closing ??= (async () => {
      await browser.close().catch(() => undefined);
      await client.close(bitBrowserId).catch((err) =>
        logger.warn("bitbrowser_close_failed", err instanceof Error ? err.message : String(err)),
      );
    })();
    return closing;
  };

  return { context, engine: "bitbrowser", profilePath, cookiesInjected, close };
}

/** Delete a BitBrowser profile SiteViewer created. Operator-owned ids are never passed here. */
export async function deleteBitBrowserProfile(cfg: BitBrowserConfig, bitBrowserId: string): Promise<void> {
  await bitBrowserClientFor(cfg).delete(bitBrowserId);
}
