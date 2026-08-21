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
import type { CDPSession, Page } from "playwright-core";

export type ScreencastMode = "thumb" | "full";

interface ModeSettings {
  quality: number;
  maxWidth: number;
  maxHeight: number;
  /** Capture every Nth frame — the cheap way to throttle frame rate. */
  everyNthFrame: number;
}

const MODES: Record<ScreencastMode, ModeSettings> = {
  thumb: { quality: 30, maxWidth: 320, maxHeight: 200, everyNthFrame: 6 },
  full: { quality: 72, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
};

type FrameListener = (frame: Buffer) => void;

/**
 * A live JPEG feed for one page.
 *
 * Holds the most recent frame so a viewer that connects mid-session sees a
 * picture immediately rather than a blank tile until the next repaint.
 */
export class Screencast {
  private cdp: CDPSession | null = null;
  private mode: ScreencastMode = "thumb";
  private latest: Buffer | null = null;
  private listeners = new Set<FrameListener>();
  private started = false;
  private closed = false;
  /** Viewers currently asking for full quality. */
  private fullViewers = 0;

  constructor(private readonly page: Page) {}

  /** Attach to the page and begin streaming at thumbnail quality. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;

    this.cdp = await this.page.context().newCDPSession(this.page);

    this.cdp.on("Page.screencastFrame", (event) => {
      const { data, sessionId } = event as { data: string; sessionId: number };
      this.latest = Buffer.from(data, "base64");

      for (const listener of this.listeners) {
        try {
          listener(this.latest);
        } catch {
          // A broken pipe on one viewer must not stop the others.
        }
      }

      // Chromium stops sending frames until each one is acknowledged.
      this.cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    });

    // A page that navigates away tears down the screencast; restart it so the
    // tile does not freeze on the previous page for the rest of the session.
    this.page.on("framenavigated", (frame) => {
      if (frame === this.page.mainFrame()) {
        void this.restart();
      }
    });

    await this.applyMode();
  }

  private async applyMode(): Promise<void> {
    if (!this.cdp || this.closed) return;
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
   *
   * Quality is decided by demand: as long as at least one viewer wants full
   * quality the page streams full, and it drops back to thumbnail when the
   * last of them disconnects. That is what lets an enlarged tile be sharp
   * while the rest of the wall stays cheap.
   */
  subscribe(listener: FrameListener, mode: ScreencastMode = "thumb"): () => void {
    this.listeners.add(listener);
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
    };
  }

  /** Stop streaming and detach. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    if (!this.cdp) return;
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
    this.cdp = null;
  }
}
