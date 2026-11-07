/**
 * Live browser view.
 *
 * Each session's page is tapped with CDP `Page.startScreencast`, which streams
 * JPEG frames of whatever the browser is rendering. That works headless as
 * well as headed, so the dashboard shows the same live picture either way.
 *
 * Two quality modes, because the dashboard is a wall of many profiles:
 *
 *   - **thumb** — small, coarse, a couple of frames a second. Cheap enough
 *     that every tile can stream all the time without being clicked. Legible
 *     as motion: you can see a page scroll, not read its body text.
 *   - **full**  — what a tile switches to when the operator enlarges it.
 *
 * Chromium supports one screencast per page, so switching modes restarts the
 * stream with new parameters rather than running two.
 */
import type { CDPSession, Page } from "rebrowser-playwright";

export type ScreencastMode = "thumb" | "full";

interface ModeSettings {
  quality: number;
  maxWidth: number;
  maxHeight: number;
  /** Capture every Nth frame — the cheap way to throttle frame rate. */
  everyNthFrame: number;
}

const MODES: Record<ScreencastMode, ModeSettings> = {
  thumb: { quality: 20, maxWidth: 280, maxHeight: 180, everyNthFrame: 4 },
  full: { quality: 50, maxWidth: 960, maxHeight: 600, everyNthFrame: 2 },
};

type FrameListener = (frame: Buffer) => void;

/**
 * A live JPEG feed for one page.
 */
export class Screencast {
  private cdp: CDPSession | null = null;
  private mode: ScreencastMode = "thumb";
  private latest: Buffer | null = null;
  private listeners = new Set<FrameListener>();
  private started = false;
  private closed = false;
  private fullViewers = 0;
  private navListener: ((frame: any) => void) | null = null;

  constructor(private readonly page: Page) {}

  /**
   * Mark the feed ready. Built-in Chromium captures one frame immediately so
   * the dashboard tile is live. BitBrowser must pass `{ eager: false }`:
   * Page.startScreencast on an unwatched kernel window closes the browser
   * during the first navigation.
   */
  async start(opts?: { eager?: boolean }): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.navListener = (frame: any) => {
      if (frame === this.page.mainFrame() && !this.closed && this.listeners.size > 0) {
        void this.restart();
      }
    };
    this.page.on("framenavigated", this.navListener);
    if (opts?.eager !== false || this.listeners.size > 0) await this.applyMode();
  }

  private async ensureCdp(): Promise<boolean> {
    if (this.cdp || this.closed) return !!this.cdp;
    let attachTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.cdp = await Promise.race([
        this.page.context().newCDPSession(this.page),
        new Promise<never>((_, reject) => {
          attachTimer = setTimeout(() => reject(new Error("screencast attach timed out")), 10_000);
        }),
      ]);
    } catch {
      this.cdp = null;
      return false;
    } finally {
      if (attachTimer) clearTimeout(attachTimer);
    }
    this.cdp.on("Page.screencastFrame", (event: any) => {
      const { data, sessionId } = event as { data: string; sessionId: number };
      this.cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      this.latest = Buffer.from(data, "base64");
      for (const listener of this.listeners) {
        try {
          listener(this.latest);
        } catch {
          // A broken pipe on one viewer must not stop the others.
        }
      }
      if (this.listeners.size === 0) {
        this.cdp?.send("Page.stopScreencast").catch(() => undefined);
      }
    });
    return true;
  }

  private async applyMode(): Promise<void> {
    if (this.closed || !(await this.ensureCdp()) || !this.cdp) return;
    const settings = MODES[this.mode];
    await this.cdp
      .send("Page.startScreencast", {
        format: "jpeg",
        quality: settings.quality,
        maxWidth: settings.maxWidth,
        maxHeight: settings.maxHeight,
        everyNthFrame: settings.everyNthFrame,
      })
      .catch(() => undefined);
  }

  private async restart(): Promise<void> {
    if (!this.cdp || this.closed) return;
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    await this.applyMode();
  }

  /** Switch quality, restarting the stream when the mode actually changes. */
  private async setMode(mode: ScreencastMode): Promise<void> {
    if (this.mode === mode || this.closed) return;
    this.mode = mode;
    await this.restart();
  }

  /** The most recent frame, if any has arrived yet. */
  get lastFrame(): Buffer | null {
    return this.latest;
  }

  get currentMode(): ScreencastMode {
    return this.mode;
  }

  /**
   * Subscribe to frames.
   */
  subscribe(listener: FrameListener, mode: ScreencastMode = "thumb"): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      void this.applyMode();
    }
    if (mode === "full") {
      this.fullViewers++;
      void this.setMode("full");
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(listener);
      if (mode === "full") {
        this.fullViewers = Math.max(0, this.fullViewers - 1);
        if (this.fullViewers === 0) void this.setMode("thumb");
      }
      if (this.listeners.size === 0) {
        // Stop C++ JPEG encoding in Chromium to drop CPU to 0% when unwatched
        this.cdp?.send("Page.stopScreencast").catch(() => undefined);
      }
    };
  }

  /** Stop streaming, unregister listeners and detach. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    if (this.navListener) {
      this.page.off("framenavigated", this.navListener);
      this.navListener = null;
    }
    if (!this.cdp) return;
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
    this.cdp = null;
  }
}
