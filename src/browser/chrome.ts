/**
 * Browser engine: system Google Chrome / Microsoft Edge via Playwright.
 *
 * One persistent user-data directory per profile, privacy hardening applied
 * through launch args + init scripts, cookies injected from the profile jar
 * on every launch.
 */
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import type { BrowserContext } from "rebrowser-playwright";
import type { BrowserConfig, BrowserProvider, SimulatorConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Profile, StoredCookie } from "../profiles/types.js";
import { parseProxy, redactProxy, resolveProxy } from "../profiles/proxy.js";
import { resolveIdentity } from "./identity.js";
import { Rng } from "../util/random.js";
import { buildNoiseScript } from "./noiseInject.js";
import { setupNetworkFilter } from "../navigator/networkFilter.js";
import { applyRuntimeCpuOptimizations } from "../performance/RuntimeCpuOptimizer.js";

export type BrowserEngine = "chrome" | "bitbrowser" | "none";

export interface LaunchedBrowser {
  context: BrowserContext;
  engine: BrowserEngine;
  profilePath: string;
  cookiesInjected: number;
  close(): Promise<void>;
}

/** Callbacks a launcher uses to persist what it learned about the profile. */
export interface LaunchHooks {
  /** The BitBrowser profile backing this one was created or re-synced. */
  bitBrowserLinked?(link: { id: string; managed: boolean; proxySig: string }): void;
  /** A pending cookie import was hard-written into the browser. */
  cookiesHardWritten?(): void;
}

export interface LaunchRequest {
  slot: number;
  sessionId: string;
  config: SimulatorConfig;
  logger: Logger;
  rng: Rng;
  profile?: Profile;
  userDataDir?: string;
  hooks?: LaunchHooks;
}

/** The kernel a profile runs on: its own pick, else the config default. */
export function providerFor(config: SimulatorConfig, profile?: Pick<Profile, "browserProvider">): BrowserProvider {
  return profile?.browserProvider ?? config.browser.provider ?? "builtin";
}

export function profilePathFor(browser: BrowserConfig, slot: number, sessionId: string): string {
  const base = resolve(process.cwd(), browser.profileDir);
  const name = browser.persistProfiles ? "slot-" + slot : "session-" + sessionId;
  const path = join(base, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Real-browser User-Agent.
 *
 * Headless Chromium announces itself as "HeadlessChrome" and sites like
 * shop.app silently refuse sessions to it — cookies arrive, the account does
 * not appear. Always present the UA of the actual installed browser instead,
 * derived from its own --version output.
 *
 * When version detection fails we no longer pin ONE stale fallback (every
 * profile then shared an identical, months-old UA — itself a fingerprint).
 * Instead a recent real Chrome build is picked per call from a small rolling
 * pool, so a fleet looks like many up-to-date desktops rather than one clone.
 */
export function resolveUserAgent(execPath: string, seed?: number, device?: import("./identity.js").DeviceSpec): string {
  const detected = detectBrowserVersion(execPath);
  const version = detected ?? pickRecentChromeVersion(seed);
  // Mobile/tablet device: emit its own UA. Android fills {MAJOR} with the
  // resolved Chrome major; iOS/iPadOS Safari carries a fixed UA (Safari version
  // is not the Chrome major, so no substitution).
  if (device) {
    const major = version.split(".")[0] ?? "140";
    return device.ua.replace("{MAJOR}", major);
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/**
 * Rolling pool of recent stable Chrome full-version strings (major builds
 * shipped through 2025-2026). Kept current-ish so the fallback never presents
 * an obviously old browser; a seed makes the pick stable per profile.
 */
const RECENT_CHROME_VERSIONS = [
  "131.0.0.0", "132.0.0.0", "133.0.0.0", "134.0.0.0", "135.0.0.0",
  "136.0.0.0", "137.0.0.0", "138.0.0.0", "139.0.0.0", "140.0.0.0",
];

function pickRecentChromeVersion(seed?: number): string {
  const pool = RECENT_CHROME_VERSIONS;
  const idx = seed === undefined
    ? Math.floor(Math.random() * pool.length)
    : Math.abs(seed) % pool.length;
  return pool[idx] ?? pool[pool.length - 1] ?? "140.0.0.0";
}

/**
 * Read the installed browser's version WITHOUT running its binary.
 *
 * `chrome.exe --version` is not a query: when a Chrome instance is already
 * running it forwards the command line to that instance, which answers
 * "Opening in existing browser session." and raises the user's own window —
 * so every launch, cookie import and version probe visibly hijacked the
 * operator's desktop Chrome. Both sources below only read from disk.
 */
function detectBrowserVersion(execPath: string): string | null {
  // Chrome and Edge keep a directory named after the running version next to
  // the binary — the cheapest reliable source on Windows.
  try {
    const versions = readdirSync(dirname(execPath), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => compareVersions(b, a));
    if (versions[0]) return versions[0];
  } catch { /* fall through */ }

  // Windows file metadata, for installs laid out without that directory.
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item $env:CF_EXE).VersionInfo.ProductVersion"],
        { timeout: 5000, env: { ...process.env, CF_EXE: execPath }, windowsHide: true },
      ).toString();
      const m = /(\d+\.\d+\.\d+\.\d+)/.exec(out);
      if (m?.[1]) return m[1];
    } catch { /* fall through */ }
  }

  return null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function findSystemChrome(): string | undefined {
  const c: string[] = [];
  const cwd = process.cwd();
  // Project portable Ungoogled-Chromium takes top priority
  c.push(
    join(cwd, "bin", "ungoogled-chromium", "chrome.exe"),
    join(cwd, "bin", "chrome.exe"),
    join(cwd, "browsers", "ungoogled-chromium", "chrome.exe"),
  );
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localApp = process.env["LOCALAPPDATA"] ?? "C:\\Users\\Default\\AppData\\Local";
    c.push(
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localApp, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  } else if (process.platform === "darwin") {
    c.push(
      join(cwd, "bin", "ungoogled-chromium", "Chromium.app", "Contents", "MacOS", "Chromium"),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    c.push(
      join(cwd, "bin", "ungoogled-chromium", "chrome"),
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  return c.find(p => p && existsSync(p));
}

/** Detect human-readable browser branding from executable path. */
export function detectBrowserEngineBranding(execPath?: string): { name: string; isUngoogled: boolean; isEdge: boolean } {
  const p = (execPath ?? "").toLowerCase();
  if (p.includes("ungoogled") || p.includes("bin\\ungoogled-chromium") || p.includes("bin/ungoogled-chromium")) {
    return { name: "Ungoogled-Chromium", isUngoogled: true, isEdge: false };
  }
  if (p.includes("msedge") || p.includes("edge")) {
    return { name: "Microsoft Edge", isUngoogled: false, isEdge: true };
  }
  return { name: "Google Chrome", isUngoogled: false, isEdge: false };
}

/** Remove stale Chromium lock files that prevent relaunch after a crash. */
function cleanStaleLocks(profileDir: string): void {
  const locks = ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"];
  for (const name of locks) {
    const p = join(profileDir, name);
    // Remove unconditionally: on Windows SingletonLock is a normal non-empty
    // file, so the old symlink/zero-length heuristic left it behind and every
    // relaunch after a hard crash collided with the lock. Chromium recreates
    // the lock it actually needs on launch, so deleting a stale one is safe.
    try { rmSync(p, { force: true }); } catch { /* already gone */ }
  }
}

/**
 * Stop Chrome from restoring the previous session's tabs (a Google account
 * management page, welcome pages, whatever was open when the browser last
 * died). Every launch must start on a clean slate.
 */
function disableTabRestore(profilePath: string): void {
  try {
    const prefFile = join(profilePath, "Default", "Preferences");
    if (!existsSync(prefFile)) return;
    const prefs = JSON.parse(readFileSync(prefFile, "utf8"));
    prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 5 };
    if (prefs.profile) {
      prefs.profile.exit_type = "Normal";
      prefs.profile.exited_cleanly = true;
    }
    writeFileSync(prefFile, JSON.stringify(prefs));
  } catch { /* unreadable prefs — Chrome defaults apply */ }
}

/** BitBrowser's own start tab. Closing it makes the kernel tear the window down after the next navigation. */
export function isBitBrowserConsole(url: string): boolean {
  return /console\.bitbrowser\.net/i.test(url);
}

/** Close Chrome internals, Google account pages and shop.app account tabs. The BitBrowser console tab is left open; the session uses another tab. */
export async function closeSystemTabs(context: BrowserContext): Promise<void> {
  for (const page of context.pages()) {
    const u = page.url();
    if (/^chrome(-edge)?:\/\//i.test(u) || /^https?:\/\/(myaccount|accounts)\.google\./i.test(u) || /shop\.app\/account/i.test(u)) {
      await page.close().catch(() => undefined);
    }
  }
  if (context.pages().length === 0) await context.newPage().catch(() => undefined);
}

function stabilityArgs(): string[] {
  return [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,BackForwardCache",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--autoplay-policy=user-gesture-required",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--enable-webgl",
    "--enable-webgl2",
    ...(process.platform === "win32" ? ["--use-gl=angle", "--use-angle=d3d11"] : []),
    "--no-service-autorun",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-search-engine-choice-screen",
  ];
}

function privacyArgs(privacy?: import("../config.js").PrivacyConfig): string[] {
  if (!privacy) return [];
  const a: string[] = [];
  if (privacy.disableWebRTC) {
    a.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--enforce-webrtc-ip-permission-check", "--disable-webrtc-encryption");
    // Fallback: disable WebRTC via feature
    a.push("--disable-features=WebRtcHideLocalIpsWithMdns");
  }
  if (privacy.disableGeolocation) a.push("--disable-geolocation");
  if (privacy.disableWebGL) a.push("--disable-webgl", "--disable-webgl2", "--disable-3d-apis");
  if (privacy.enableDoNotTrack) a.push("--enable-do-not-track");
  return a;
}

function privacyHeaders(privacy?: import("../config.js").PrivacyConfig): Record<string, string> | undefined {
  if (privacy?.enableDoNotTrack) return { DNT: "1" };
  return undefined;
}

function privacyInitScripts(privacy?: import("../config.js").PrivacyConfig): string[] {
  if (!privacy) return [];
  const scripts: string[] = [];
  // Combine canvas/webgl blocking into one to avoid override conflict
  if (privacy.disableWebGL || privacy.disableCanvas) {
    const needWebGL = !!privacy.disableWebGL;
    const needCanvas = !!privacy.disableCanvas;
    scripts.push(`try{(function(){const orig=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){const s=String(t).toLowerCase();if(${needWebGL}&&s.includes('webgl'))return null;if(${needCanvas}&&s==='2d')return null;return orig.apply(this,[t,...a])};if(${needCanvas}){HTMLCanvasElement.prototype.toDataURL=function(){return 'data:,'};if(HTMLCanvasElement.prototype.toBlob)HTMLCanvasElement.prototype.toBlob=function(cb){cb&&cb(null)};try{const p=CanvasRenderingContext2D&&CanvasRenderingContext2D.prototype;if(p&&p.getImageData)p.getImageData=function(){throw new Error('Canvas disabled')};}catch(e){}}if(${needWebGL}){try{Object.defineProperty(navigator,'gpu',{get:()=>undefined,configurable:true})}catch(e){}}})()}catch(e){}`);
  }
  if (privacy.disableWebRTC) {
    scripts.push(`try{(function(){const e=new Error('WebRTC disabled');const f=function(){throw e};try{delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;delete window.mozRTCPeerConnection;}catch(_){}window.RTCPeerConnection=f;window.webkitRTCPeerConnection=f;window.mozRTCPeerConnection=f;if(navigator.mediaDevices){navigator.mediaDevices.getUserMedia=()=>Promise.reject(e);if(navigator.mediaDevices.getDisplayMedia)navigator.mediaDevices.getDisplayMedia=()=>Promise.reject(e);}})()}catch(e){}`);
  }
  if (privacy.disableGeolocation) {
    scripts.push(`try{(function(){const e={code:1,message:'Geolocation disabled'};if(navigator.geolocation){navigator.geolocation.getCurrentPosition=(s,er)=>er&&er(e);navigator.geolocation.watchPosition=(s,er)=>{er&&er(e);return -1};navigator.geolocation.clearWatch=()=>{}}if(navigator.permissions&&navigator.permissions.query){const o=navigator.permissions.query.bind(navigator.permissions);navigator.permissions.query=(p)=>p&&p.name==='geolocation'?Promise.resolve({state:'denied',onchange:null}):o(p)}})()}catch(e){}`);
  }
  if (privacy.enableDoNotTrack) {
    scripts.push(`try{Object.defineProperty(navigator,'doNotTrack',{get:()=>'1',configurable:true});Object.defineProperty(window,'doNotTrack',{get:()=>'1',configurable:true});Object.defineProperty(navigator,'msDoNotTrack',{get:()=>'1',configurable:true});}catch(e){}`);
  }
  return scripts;
}

/**
 * Verify the kernel a session needs is reachable before it starts: a local
 * Chrome/Edge binary for builtin, the Local API for BitBrowser.
 */
export async function preflight(
  config: SimulatorConfig,
  _logger: Logger,
  provider: BrowserProvider = providerFor(config),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (provider === "bitbrowser") {
    const { checkBitBrowserHealth, bitBrowserSettings } = await import("./bitbrowser.js");
    const health = await checkBitBrowserHealth(bitBrowserSettings(config));
    return health.ok
      ? { ok: true }
      : { ok: false, reason: `BitBrowser Local API khong phan hoi tai ${health.apiUrl}: ${health.error ?? "unknown error"}` };
  }
  if (config.browser.executablePath && existsSync(config.browser.executablePath)) return { ok: true };
  if (findSystemChrome()) return { ok: true };
  return { ok: false, reason: "Khong tim thay Google Chrome hay Microsoft Edge. Cai Chrome, hoac dat browser.executablePath trong config." };
}

/**
 * Sec-CH-UA Client-Hint headers matching the UA string's Chrome major.
 *
 * A UA string that says Chrome/140 while the Sec-CH-UA header advertises a
 * different (or missing) brand list is a cheap tell. Deriving the hints from
 * the same version keeps the two consistent, which is what a real Chrome does.
 */
function clientHintHeaders(userAgent: string, device?: import("./identity.js").DeviceSpec): Record<string, string> {
  // iOS Safari does NOT send Sec-CH-UA client hints at all — only Chromium
  // does. Emitting them on an iPhone/iPad UA is itself a tell, so skip.
  if (device && !device.chromium) return {};
  const major = /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? "140";
  // Chrome's GREASE brand list: a real header carries the branded entry plus
  // two decoy brands. Order is randomised by Chrome but a stable trio passes.
  const brands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`;
  const mobile = device ? "?1" : "?0";
  const platform = device ? `"${device.uaPlatform}"` : '"Windows"';
  return {
    "sec-ch-ua": brands,
    "sec-ch-ua-mobile": mobile,
    "sec-ch-ua-platform": platform,
  };
}

/**
 * Stealth init scripts applied on EVERY launch (independent of the privacy
 * toggles). These smooth over the headless/automation tells that survive
 * --disable-blink-features=AutomationControlled:
 *
 *  - navigator.webdriver forced undefined (belt-and-braces; the flag above
 *    usually handles it, but a revived context can still leak it).
 *  - A realistic navigator.plugins / mimeTypes shape (headless ships zero).
 *  - chrome.runtime stub so `window.chrome` is more than an empty object.
 *  - Permissions.query notification quirk that real Chrome exhibits.
 *  - Per-profile deterministic Canvas + WebGL noise so the fingerprint is
 *    STABLE for one profile but DIFFERENT across profiles — a fleet of clones
 *    sharing one canvas hash is itself a signal. Seeded by the profile so the
 *    same profile always renders the same tiny perturbation.
 */
function stealthInitScripts(ctx: { seed: number; uaMajor: string; viewport: { width: number; height: number }; locale: string; device?: import("./identity.js").DeviceSpec }): string[] {
  const s = Math.abs(ctx.seed) % 1000;
  const major = ctx.uaMajor;
  const vw = ctx.viewport.width;
  const vh = ctx.viewport.height;
  const device = ctx.device;
  const isMobile = !!device;
  const screenW = isMobile ? vw : Math.max(vw, 1536);
  const screenH = isMobile ? vh : Math.max(vh + 120, 864);
  const availH = isMobile ? vh : screenH - 48;
  const dpr = device ? device.dpr : 1;
  const uaPlatform = device ? device.uaPlatform : "Windows";
  const navPlatform = device ? device.platform : "Win32";
  const maxTouch = device ? device.maxTouchPoints : 0;
  const chromium = device ? device.chromium : true;

  return [
    `try{(function(){
      const REG_SYM = Symbol.for('__v8_native_reg__');
      const REG_FN_SYM = Symbol.for('__v8_reg_fn__');
      if (window[REG_SYM]) return;

      // ── Unified Native Property Descriptor Registry (WeakMap-based) ──
      const originalToString = Function.prototype.toString;
      const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
      const globalRegistry = window[REG_SYM] || (window[REG_SYM] = new WeakMap());

      const registerNative = (fn, name, length = 0) => {
        if (typeof fn === 'function') {
          const fnName = name || fn.name || '';
          globalRegistry.set(fn, fnName);
          try {
            Object.defineProperties(fn, {
              name: { value: fnName, writable: false, enumerable: false, configurable: true },
              length: { value: length, writable: false, enumerable: false, configurable: true }
            });
          } catch(e) {}
        }
        return fn;
      };
      window[REG_FN_SYM] = registerNative;

      // 1. Hook Function.prototype.toString
      const toStringHandler = function toString() {
        if (typeof this !== 'function') {
          throw new TypeError('Function.prototype.toString requires that "this" be a Function');
        }
        const reg = window[REG_SYM] || globalRegistry;
        if (reg && reg.has(this)) {
          const n = reg.get(this);
          return n ? ('function ' + n + '() { [native code] }') : 'function () { [native code] }';
        }
        if (this === toStringHandler || this === originalToString) {
          return 'function toString() { [native code] }';
        }
        return Reflect.apply(originalToString, this, arguments);
      };
      registerNative(toStringHandler, 'toString', 0);
      Object.defineProperty(Function.prototype, 'toString', {
        value: toStringHandler,
        writable: true,
        enumerable: false,
        configurable: true,
      });

      // 2. Hook Object.getOwnPropertyDescriptor
      const descriptorHandler = function getOwnPropertyDescriptor(target, prop) {
        const desc = Reflect.apply(originalGetOwnPropertyDescriptor, Object, arguments);
        const reg = window[REG_SYM] || globalRegistry;
        if (desc && desc.value && typeof desc.value === 'function' && reg && reg.has(desc.value)) {
          return {
            value: desc.value,
            writable: desc.writable,
            enumerable: desc.enumerable,
            configurable: desc.configurable
          };
        }
        return desc;
      };
      registerNative(descriptorHandler, 'getOwnPropertyDescriptor', 2);
      Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
        value: descriptorHandler,
        writable: true,
        enumerable: false,
        configurable: true,
      });

      // 3. Iframe ContentWindow & ContentDocument Realm Hooking (Disarms Pixelscan clean iframe extraction)
      try {
        const origContentWindowDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
        if (origContentWindowDesc && origContentWindowDesc.get) {
          const origContentWindowGet = origContentWindowDesc.get;
          Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
            get: function() {
              const win = origContentWindowGet.call(this);
              if (win) {
                try {
                  win[REG_SYM] = globalRegistry;
                  win[REG_FN_SYM] = registerNative;
                  win.Function.prototype.toString = toStringHandler;
                  win.Object.getOwnPropertyDescriptor = descriptorHandler;
                } catch(e) {}
              }
              return win;
            },
            configurable: true,
            enumerable: true,
          });
        }

        const origContentDocDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument');
        if (origContentDocDesc && origContentDocDesc.get) {
          const origContentDocGet = origContentDocDesc.get;
          Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
            get: function() {
              const doc = origContentDocGet.call(this);
              if (doc && doc.defaultView) {
                try {
                  doc.defaultView[REG_SYM] = globalRegistry;
                  doc.defaultView[REG_FN_SYM] = registerNative;
                  doc.defaultView.Function.prototype.toString = toStringHandler;
                  doc.defaultView.Object.getOwnPropertyDescriptor = descriptorHandler;
                } catch(e) {}
              }
              return doc;
            },
            configurable: true,
            enumerable: true,
          });
        }
      } catch(e) {}

      // 4. Authentic window.chrome Structure (No fake runtime)
      const csiFn = registerNative(function csi() {
        return {
          startE: Date.now() - Math.floor(performance.now()),
          onloadT: Date.now() - 50,
          pageT: performance.now(),
          tran: 15
        };
      }, 'csi', 0);

      const loadTimesFn = registerNative(function loadTimes() {
        const perf = performance.timing || {};
        const startSec = (perf.navigationStart || Date.now()) / 1000;
        return {
          requestTime: startSec,
          startLoadTime: startSec,
          commitLoadTime: startSec + 0.05,
          finishDocumentLoadTime: startSec + 0.1,
          firstPaintTime: startSec + 0.08,
          finishLoadTime: startSec + 0.12,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          connectionInfo: 'h2'
        };
      }, 'loadTimes', 0);

      const getDetailsFn = registerNative(function getDetails() { return null; }, 'getDetails', 0);
      const getIsInstalledFn = registerNative(function getIsInstalled() { return false; }, 'getIsInstalled', 0);
      const getRunningStateFn = registerNative(function getRunningState() { return 'cannot_run'; }, 'getRunningState', 0);

      const appObj = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: getDetailsFn,
        getIsInstalled: getIsInstalledFn,
        getRunningState: getRunningStateFn
      };

      Object.defineProperty(window, 'chrome', {
        value: { app: appObj, csi: csiFn, loadTimes: loadTimesFn },
        writable: true,
        enumerable: true,
        configurable: true
      });

      // 5. Clean Screen and WebIDL Platform Properties on Prototypes
      const defProto = (proto, k, v) => {
        try {
          const g = registerNative(function() {
            if (this !== window.navigator && Object.getPrototypeOf(this) !== proto) {
              throw new TypeError("Failed to read the '" + k + "' property from 'Navigator': Illegal invocation");
            }
            return v;
          }, 'get ' + k, 0);
          Object.defineProperty(proto, k, { get: g, configurable: true, enumerable: true });
        } catch(e) {}
      };

      try {
        const proto = Navigator.prototype;
        defProto(proto, 'platform', ${JSON.stringify(navPlatform)});
        defProto(proto, 'maxTouchPoints', ${maxTouch});
        defProto(proto, 'webdriver', false);
        if (!${isMobile} && (!navigator.plugins || navigator.plugins.length === 0)) {
          const fakePlugins = Object.create(PluginArray.prototype);
          const pdfNames = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
          pdfNames.forEach((name, idx) => {
            const p = Object.create(Plugin.prototype);
            Object.defineProperties(p, {
              name: { value: name, enumerable: true },
              filename: { value: 'internal-pdf-viewer', enumerable: true },
              description: { value: 'Portable Document Format', enumerable: true },
              length: { value: 2, enumerable: true },
            });
            Object.defineProperty(fakePlugins, idx, { value: p, enumerable: true });
          });
          Object.defineProperty(fakePlugins, 'length', { value: pdfNames.length, enumerable: false });
          defProto(proto, 'plugins', fakePlugins);
        }
      } catch(e) {}

      try {
        if (!${isMobile} && window.outerHeight === window.innerHeight) {
          Object.defineProperty(window, 'outerWidth', { get: registerNative(() => window.innerWidth + 16, 'get outerWidth', 0), configurable: true });
          Object.defineProperty(window, 'outerHeight', { get: registerNative(() => window.innerHeight + 88, 'get outerHeight', 0), configurable: true });
        }
      } catch(e) {}

      if (typeof Screen !== 'undefined' && Screen.prototype) {
        try {
          const defScreenProto = (k, v) => {
            const g = registerNative(function() {
              if (this !== window.screen && Object.getPrototypeOf(this) !== Screen.prototype) {
                throw new TypeError("Failed to read the '" + k + "' property from 'Screen': Illegal invocation");
              }
              return v;
            }, 'get ' + k, 0);
            Object.defineProperty(Screen.prototype, k, { get: g, configurable: true, enumerable: true });
          };
          defScreenProto('width', ${screenW});
          defScreenProto('height', ${screenH});
          defScreenProto('availWidth', ${screenW});
          defScreenProto('availHeight', ${availH});
          defScreenProto('pixelDepth', 24);
          defScreenProto('colorDepth', 24);
        } catch(e) {}
      }

      ${chromium ? `try {
        const isMob = ${isMobile};
        const brands = [{ brand: 'Chromium', version: '${major}' }, { brand: 'Google Chrome', version: '${major}' }, { brand: 'Not?A_Brand', version: '24' }];
        const high = { architecture: isMob ? 'arm' : 'x86', bitness: '64', brands, fullVersionList: brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' })), mobile: isMob, model: ${JSON.stringify(device?.model ?? "")}, platform: '${uaPlatform}', platformVersion: isMob ? '14.0.0' : '15.0.0', uaFullVersion: '${major}.0.0.0', wow64: false };
        const uad = {
          brands, mobile: isMob, platform: '${uaPlatform}',
          getHighEntropyValues: registerNative((hints) => {
            const r = {};
            (hints || []).forEach(h => { if (h in high) r[h] = high[h]; });
            r.brands = brands; r.mobile = isMob; r.platform = '${uaPlatform}';
            return Promise.resolve(r);
          }, 'getHighEntropyValues', 1),
          toJSON: registerNative(() => ({ brands, mobile: isMob, platform: '${uaPlatform}' }), 'toJSON', 0)
        };
        Object.defineProperty(Navigator.prototype, 'userAgentData', {
          get: registerNative(function() {
            if (this !== window.navigator && Object.getPrototypeOf(this) !== Navigator.prototype) {
              throw new TypeError("Failed to read property: Illegal invocation");
            }
            return uad;
          }, 'get userAgentData', 0),
          configurable: true,
          enumerable: true
        });
      } catch(e) {}` : ""}

      // ── WebGL 1 & WebGL 2 getParameter hook ──
      const webglVendor = ${device?.kind === "iphone" || device?.kind === "ipad" ? "'Apple Inc.'" : device?.kind === "android" ? "'Qualcomm'" : "'Google Inc. (Intel)'"};
      const webglRenderer = ${device?.kind === "iphone" || device?.kind === "ipad" ? "'Apple GPU'" : device?.kind === "android" ? "'Adreno (TM) 740'" : "'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'"};

      const patchGl = (proto) => {
        if (!proto || !proto.getParameter) return;
        const orig = proto.getParameter;
        const patchedGl = function(p) {
          const v = orig.call(this, p);
          if (p === 37445) return webglVendor;
          if (p === 37446) return webglRenderer;
          return v;
        };
        registerNative(patchedGl, 'getParameter', 1);
        proto.getParameter = patchedGl;
      };

      if (typeof WebGLRenderingContext !== 'undefined') patchGl(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') patchGl(WebGL2RenderingContext.prototype);
    })()}catch(e){}`
  ];
}


export async function launchBrowser(req: LaunchRequest): Promise<LaunchedBrowser> {
  if (providerFor(req.config, req.profile) === "bitbrowser") {
    const { launchBitBrowser } = await import("./bitbrowser.js");
    return launchBitBrowser(req);
  }
  const { config, logger, rng, slot, sessionId, profile } = req;
  const browserCfg = config.browser;
  const profilePath = req.userDataDir ?? profilePathFor(browserCfg, slot, sessionId);
  mkdirSync(profilePath, { recursive: true });
  cleanStaleLocks(profilePath);

  const identity = profile
    ? resolveIdentity(profile.identity, profile.device)
    : { viewport: rng.pick(browserCfg.viewports) ?? { width: 1440, height: 900 }, ...(browserCfg.timezone ? { timezone: browserCfg.timezone } : {}), ...(browserCfg.locale ? { locale: browserCfg.locale } : {}), colorScheme: "light" as const };

  if (!identity.viewport) identity.viewport = { width: 1440, height: 900 };

  const proxyInput = profile?.proxy || (browserCfg.proxies.length > 0 ? browserCfg.proxies[slot % browserCfg.proxies.length] : undefined);
  // Bare ip:port forms get protocol-sniffed once per endpoint (HTTP vs SOCKS5)
  // so a local tunnel entered without a scheme still works.
  const proxy = proxyInput ? await resolveProxy(proxyInput) : undefined;

  if (!identity.timezone && browserCfg.timezone) identity.timezone = browserCfg.timezone;
  if (!identity.locale && browserCfg.locale) identity.locale = browserCfg.locale;

  const execPath = browserCfg.executablePath ?? findSystemChrome();
  if (!execPath) throw new Error("Khong tim thay Google Chrome / Microsoft Edge. Cai Chrome hoac dat browser.executablePath.");

  const privacy = (browserCfg as any).privacy as import("../config.js").PrivacyConfig | undefined;
  const uaSeed = profile?.identity.seed;
  const device = identity.device;
  const userAgent = resolveUserAgent(execPath, uaSeed, device);
  const uaMajor = /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? "140";
  const extraHeaders = { ...clientHintHeaders(userAgent, device), ...(privacyHeaders(privacy) ?? {}) };
  // Stealth scripts run every launch; privacy scripts layer on the toggles.
  // Pass the resolved identity so the JS fingerprint stays consistent with
  // the UA string, client hints, viewport and locale (consistency > coverage).
  const stealthCtx = {
    seed: uaSeed ?? slot,
    uaMajor,
    viewport: identity.viewport,
    locale: identity.locale ?? "en-US",
    device,
  };
  const initScripts = [
    ...stealthInitScripts(stealthCtx),
    ...privacyInitScripts(privacy),
    buildNoiseScript(stealthCtx.seed),
  ];
  const pArgs = privacyArgs(privacy);
  if (privacy) logger.info("privacy", "privacy hardening", { data: privacy as unknown as Record<string, unknown> });

  logger.info("browser_launch", "launching browser", { data: { profilePath, viewport: identity.viewport, headless: browserCfg.headless, proxy: proxy ? redactProxy(proxy.raw) : null, privacy: privacy ?? null } });

  // Never restore the previous session's tabs (Google account pages etc.)
  disableTabRestore(profilePath);

  const { chromium } = await import("rebrowser-playwright");
  // New headless mode ("--headless=new") runs the FULL Chrome renderer, so
  // deviceMemory, fonts, WebGL and canvas report real values instead of the
  // stripped-down old-headless surface — native beats a JS mock. Only added
  // when running headless; a headed launch already uses the full renderer.
  const headlessArgs = browserCfg.headless ? ["--headless=new"] : [];
  const langArgs = [`--lang=${stealthCtx.locale}`];
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: browserCfg.headless,
    executablePath: execPath,
    // Present the installed browser's own UA (or a recent random one) — a
    // HeadlessChrome marker makes sites refuse sessions even when the cookie
    // jar is valid. Same UA feeds the Sec-CH-UA client hints above.
    userAgent,
    viewport: identity.viewport,
    colorScheme: identity.colorScheme as any,
    args: [...stabilityArgs(), ...headlessArgs, ...langArgs, ...pArgs],
    ...(proxy ? { proxy: { server: proxy.server, ...(proxy.username ? { username: proxy.username } : {}), ...(proxy.password ? { password: proxy.password } : {}) } } : {}),
    ...(identity.locale ? { locale: identity.locale } : {}),
    ...(identity.timezone ? { timezoneId: identity.timezone } : {}),
    ...(extraHeaders ? { extraHTTPHeaders: extraHeaders } : {}),
    // Mobile/tablet device emulation: DPR + mobile mode + touch surface.
    ...(device ? { deviceScaleFactor: device.dpr, isMobile: true, hasTouch: true } : {}),
  });
  for (const s of initScripts) await context.addInitScript({ content: s }).catch(() => {});
  (context as any).__profilePath = profilePath;

  // Intercept & block heavy ad trackers / pixels to maximize speed & save proxy bandwidth
  await applyRuntimeCpuOptimizations(context);
  context.on("page", (p) => {
    void setupNetworkFilter(p).catch(() => {});
  });
  for (const p of context.pages()) {
    void setupNetworkFilter(p).catch(() => {});
  }

  // Kill any Google-account / chrome:// tab the browser reopened on its own.
  await closeSystemTabs(context);

  const cookiesInjected = await syncJar(context, profile, logger);
  logger.info("browser_ready", "Browser ready (chrome)", { data: { engine: "chrome", profilePath, cookiesInjected, privacy: privacy ?? null } as unknown as Record<string, unknown> });
  return { context, engine: "chrome", profilePath, cookiesInjected, close: () => context.close() };
}

/**
 * Cookie contract (final):
 *
 *   IMPORT = HARD-WRITE. Parsed rows land in the browser's own cookie store
 *   the moment the operator picks a file — nothing is queued, skipped,
 *   filtered or altered. Values are copied character-for-character; only the
 *   container format changes (Netscape line -> Playwright addCookies row).
 *   Nothing already in the browser is ever deleted by an import.
 *
 *   LAUNCH = RESTORE-ONLY. Rows the profile knows but the browser no longer
 *   holds (a site revoked them mid-visit) are added back. Present rows —
 *   including server-rotated values — are left exactly as they are.
 */

/** Add every jar row that is missing from the browser. Never removes. */
export async function syncJar(
  context: BrowserContext,
  profile: Profile | undefined,
  logger: Logger,
): Promise<number> {
  return applyCookies(context, profile?.cookies?.cookies, logger, false);
}

/**
 * HARD-WRITE the given rows into the browser, overwriting any existing value
 * for the same name|domain|path. This is the IMPORT path: the operator picked
 * a file and every row in it must land verbatim, replacing whatever stale value
 * the browser already held.
 *
 * The restore-only `syncJar` skips rows already present, which is correct on
 * launch but wrong for an import: any Shopify storefront's Shop Pay embed sets
 * a LOGGED-OUT `.shop.app` cookie, so a missing-only sync would silently ignore
 * the logged-in `shop.app` cookie the operator just imported and the account
 * would never appear.
 */
export async function hardWriteCookies(
  context: BrowserContext,
  cookies: StoredCookie[] | undefined,
  logger: Logger,
): Promise<number> {
  return applyCookies(context, cookies, logger, true);
}

/**
 * Shared cookie writer.
 *
 *   overwrite=false (launch / restore): only rows the browser is missing are
 *     added; present rows — including server-rotated values — are left alone.
 *   overwrite=true  (import / hard-write): every row is written, replacing any
 *     existing value for the same name|domain|path.
 */
async function applyCookies(
  context: BrowserContext,
  stored: StoredCookie[] | undefined,
  logger: Logger,
  overwrite: boolean,
): Promise<number> {
  if (!stored || stored.length === 0) return 0;

  const keyOf = (c: { name: string; domain: string; path: string }) => `${c.name}|${c.domain}|${c.path}`;
  let target = stored;
  if (!overwrite) {
    const dir = await context.cookies().catch((): import("rebrowser-playwright").Cookie[] => []);
    const dirKeys = new Set(dir.map(keyOf));
    target = stored.filter((c) => !dirKeys.has(keyOf(c)));
    if (target.length === 0) {
      logger.info("cookies_sync", stored.length + " jar rows already present - nothing to add");
      return 0;
    }
  }

  // A past expiry stamp cannot be stored by Chromium; converting it to a
  // session cookie keeps the VALUE byte-for-byte while making the row
  // storable and sendable — same behaviour as importing through a browser
  // extension.
  const nowSeconds = Math.floor(Date.now() / 1000);
  let injected = 0;
  const rejected: string[] = [];
  let firstReason = "";
  for (const cookie of target) {
    const row = cookie.expires !== -1 && cookie.expires <= nowSeconds
      ? { ...cookie, expires: -1 }
      : cookie;
    try { await context.addCookies([row]); injected++; }
    catch (err) {
      rejected.push(cookie.name);
      if (!firstReason) firstReason = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    }
  }
  logger.info(
    "cookies_written",
    `hard-wrote ${injected}/${target.length} ${overwrite ? "imported" : "missing"} rows into the browser` +
      (rejected.length ? ` (${rejected.length} rejected: ${rejected.slice(0, 8).join(", ")}${firstReason ? " — " + firstReason : ""})` : ""),
  );
  return injected;
}

/**
 * Hard-write the profile's jar into a profile directory that has no live
 * browser: opens it headless for a moment, writes, closes. The cookies are
 * physically in that browser's store from then on.
 *
 * This is an IMPORT path, so it OVERWRITES: an existing logged-out value for
 * the same name|domain|path (a Shop Pay embed left one behind) is replaced by
 * the imported value.
 */
export async function writeJarToProfileDir(opts: {
  config: SimulatorConfig;
  userDataDir: string;
  profile: Profile | undefined;
  logger: Logger;
}): Promise<number> {
  const execPath = opts.config.browser.executablePath ?? findSystemChrome();
  if (!execPath) throw new Error("Khong tim thay Google Chrome / Microsoft Edge.");
  const { chromium } = await import("rebrowser-playwright");
  mkdirSync(opts.userDataDir, { recursive: true });
  cleanStaleLocks(opts.userDataDir);
  const context = await chromium.launchPersistentContext(opts.userDataDir, {
    headless: true,
    executablePath: execPath,
    userAgent: resolveUserAgent(execPath),
    args: stabilityArgs(),
  });
  try {
    const firstPage = context.pages()[0];
    if (firstPage) {
      await firstPage.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => undefined);
    }
    return await hardWriteCookies(context, opts.profile?.cookies?.cookies, opts.logger);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Snapshot everything the live browser currently holds, in the profile's
 * StoredCookie shape. Called when a session closes so the freshest
 * server-rotated values replace the original import — the next launch then
 * restores exactly this state instead of a stale export.
 */
export async function captureContextCookies(context: BrowserContext): Promise<StoredCookie[]> {
  try {
    const raw = await context.cookies();
    return raw.map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      // Playwright reports session cookies as expires:-1 already.
      expires: typeof c.expires === "number" ? Math.round(c.expires) : -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: (c.sameSite === "Strict" || c.sameSite === "None" ? c.sameSite : "Lax"),
    }));
  } catch {
    return [];
  }
}

export async function browserBinaryStatus(): Promise<{ installed: boolean; chromePath?: string; engine: "chrome" | "none" }> {
  const chromePath = findSystemChrome();
  return {
    installed: !!chromePath,
    ...(chromePath ? { chromePath } : {}),
    engine: chromePath ? "chrome" : "none",
  };
}

export { redactProxy };
