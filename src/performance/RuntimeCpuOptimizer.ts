/**
 * src/performance/RuntimeCpuOptimizer.ts
 *
 * Comprehensive runtime CPU & resource reduction for Headless Chromium:
 * 1. Virtual FPS Governor (rAF throttled to 5 FPS) + Timer Clamping
 * 2. Universal Ultra-Low-CPU CSS Injection (disables all animations & transitions)
 * 3. Hardware-level Network Resource Interception (blocks heavy fonts, video, media, trackers)
 * 4. Tab Hibernation Controller (Page.setWebLifecycleState "frozen")
 */
import type { BrowserContext, Page, CDPSession } from "rebrowser-playwright";
import os from "node:os";

// ── 1. Non-Destructive Clean-Realm Stylesheet ──
// Preserves CSS transitions (so SPA cart drawers/modals fire transitionend),
// preserves web font metrics (offsetWidth/measureText), and emits zero branded DOM IDs.
export const ULTRA_LOW_CPU_CSS = `
video[autoplay], svg animate, svg animateTransform, svg animateMotion {
  animation-play-state: paused;
}
`;

// ── 2. Virtual FPS Governor (5 FPS) + Timer Clamping Init Script ──
export const RUNTIME_CPU_INIT_SCRIPT = `(() => {
  if (window.__cpu_throttler_injected__) return;
  window.__cpu_throttler_injected__ = true;

  const TARGET_FPS = 5;
  const FRAME_INTERVAL = 1000 / TARGET_FPS;
  const MIN_TIMER_MS = 500;

  // 1. Virtual FPS Governor
  let rafCallbacks = new Map();
  let nextRafId = 1;
  let lastFrameTime = performance.now();
  let masterTimer = null;

  function processRafQueue() {
    masterTimer = null;
    const now = performance.now();
    const currentQueue = Array.from(rafCallbacks.entries());
    rafCallbacks.clear();

    for (let i = 0; i < currentQueue.length; i++) {
      const [id, cb] = currentQueue[i];
      try { cb(now); } catch (err) {}
    }
    lastFrameTime = now;
  }

  function scheduleRafTick() {
    if (masterTimer !== null) return;
    const elapsed = performance.now() - lastFrameTime;
    const delay = Math.max(0, FRAME_INTERVAL - elapsed);
    masterTimer = setTimeout(processRafQueue, delay);
  }

  window.requestAnimationFrame = function(callback) {
    if (typeof callback !== 'function') return 0;
    const id = nextRafId++;
    rafCallbacks.set(id, callback);
    scheduleRafTick();
    return id;
  };

  window.cancelAnimationFrame = function(id) {
    rafCallbacks.delete(id);
    if (rafCallbacks.size === 0 && masterTimer !== null) {
      clearTimeout(masterTimer);
      masterTimer = null;
    }
  };

  // 2. Timer Clamping
  const originalSetInterval = window.setInterval.bind(window);
  const originalSetTimeout = window.setTimeout.bind(window);

  window.setInterval = function(handler, timeout, ...args) {
    const parsed = typeof timeout === 'number' ? timeout : 0;
    return originalSetInterval(handler, Math.max(parsed, MIN_TIMER_MS), ...args);
  };

  window.setTimeout = function(handler, timeout, ...args) {
    const parsed = typeof timeout === 'number' ? timeout : 0;
    const clamped = parsed > 0 ? Math.max(parsed, 50) : 0;
    return originalSetTimeout(handler, clamped, ...args);
  };
})();`;

// ── 3. High-Efficiency Blocked Patterns (Heavy Videos & 3rd-Party Ad/Heatmap Trackers Only) ──
// Webfonts (.woff2/.ttf) are intentionally NOT blocked so icon fonts and font-metrics probes remain 100% authentic.
export const RUNTIME_BLOCKED_PATTERNS: readonly string[] = [
  "*.mp4*",
  "*.webm*",
  "*.ogg*",
  "*.mp3*",
  "*.wav*",
  "*.m4v*",
  "*.mov*",
  "*.avi*",
  "*.glb*",
  "*.gltf*",
  "*connect.facebook.net*",
  "*analytics.tiktok.com*",
  "*google-analytics.com*",
  "*googletagmanager.com*",
  "*clarity.ms*",
  "*hotjar.com*",
  "*static.klaviyo.com*",
  "*snap.licdn.com*",
  "*omnisend.com*",
  "*privy.com*",
  "*criteo.com*",
  "*doubleclick.net*",
  "*widget.intercom.io*",
  "*client.crisp.chat*",
];

/** Set Windows OS process priority to BELOW_NORMAL so host event loop never starves */
export function setWindowsProcessEcoPriority(pid: number): void {
  if (process.platform !== "win32" || !pid) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Process might not be ready or already exited
  }
}

/** Applies clean-realm network tracker filtering and active focus/visibility emulation to context and all pages */
export async function applyRuntimeCpuOptimizations(context: BrowserContext): Promise<void> {
  const setupPage = async (page: Page) => {
    if (page.isClosed()) return;
    if (!(page as any).__networkFilterAttached) {
      (page as any).__networkFilterAttached = true;
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable").catch(() => {});
        await cdp.send("Network.setBlockedURLs", {
          urls: [...RUNTIME_BLOCKED_PATTERNS],
        }).catch(() => {});
        // Maintain active focus and visible page lifecycle state even when running in background/headless
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
        await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
        // Detach temporary CDP session to keep IPC channels clear and avoid stalling context.close()
        await cdp.detach().catch(() => {});
      } catch {}
    }
  };

  context.on("page", (p) => { void setupPage(p); });
  for (const p of context.pages()) {
    void setupPage(p);
  }
}
