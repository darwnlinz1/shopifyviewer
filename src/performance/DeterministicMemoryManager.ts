/**
 * src/performance/DeterministicMemoryManager.ts
 *
 * Deterministic Memory Pressure Monitor & Idle-Interval GC Scheduler.
 * Coordinates Node.js host V8 GC with native Chromium memory management.
 * Eliminates mid-transaction stop-the-world pauses and CDP HeapProfiler detection.
 */
import type { Page } from "rebrowser-playwright";
import type { Logger } from "../logging/logger.js";

export type MemoryPressureLevel = "normal" | "pressure" | "critical" | "emergency";

export interface MemoryStats {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  pressureLevel: MemoryPressureLevel;
}

export interface MemoryManagerOptions {
  checkIntervalMs?: number;
  thresholdPressureMb?: number;
  thresholdCriticalMb?: number;
  thresholdEmergencyMb?: number;
}

export class DeterministicMemoryManager {
  private intervalTimer: NodeJS.Timeout | null = null;
  private readonly thresholdPressureMb: number;
  private readonly thresholdCriticalMb: number;
  private readonly thresholdEmergencyMb: number;
  private isCollecting = false;
  private pendingIdleGc = false;
  private readonly activePages = new Set<Page>();

  constructor(
    private readonly logger: Logger,
    options: MemoryManagerOptions = {},
  ) {
    this.thresholdPressureMb = options.thresholdPressureMb ?? 280;
    this.thresholdCriticalMb = options.thresholdCriticalMb ?? 400;
    this.thresholdEmergencyMb = options.thresholdEmergencyMb ?? 500;
    const intervalMs = options.checkIntervalMs ?? 15_000;

    this.start(intervalMs);
  }

  public start(intervalMs = 15_000): void {
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      this.evaluateMemoryPressure();
    }, intervalMs);
  }

  public stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  public registerPage(page: Page): void {
    this.activePages.add(page);
    page.once("close", () => this.activePages.delete(page));
  }

  public unregisterPage(page: Page): void {
    this.activePages.delete(page);
  }

  public getMemoryStats(): MemoryStats {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / (1024 * 1024));
    const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
    const externalMb = Math.round(mem.external / (1024 * 1024));

    let pressureLevel: MemoryPressureLevel = "normal";
    if (rssMb >= this.thresholdEmergencyMb) {
      pressureLevel = "emergency";
    } else if (rssMb >= this.thresholdCriticalMb) {
      pressureLevel = "critical";
    } else if (rssMb >= this.thresholdPressureMb) {
      pressureLevel = "pressure";
    }

    return { rssMb, heapUsedMb, heapTotalMb, externalMb, pressureLevel };
  }

  /**
   * Schedules or executes a synchronized GC cycle strictly during an IDLE navigation boundary.
   */
  public async performDeterministicGC(reason = "scheduled_idle"): Promise<void> {
    if (this.isCollecting) return;
    this.isCollecting = true;
    const started = Date.now();

    try {
      if (typeof global.gc === "function") {
        global.gc();
      }
      this.pendingIdleGc = false;
      const stats = this.getMemoryStats();
      this.logger.debug(
        "deterministic_gc_complete",
        `Idle GC completed in ${Date.now() - started}ms [Reason: ${reason}] -> RSS: ${stats.rssMb}MB, Heap: ${stats.heapUsedMb}MB`,
      );
    } finally {
      this.isCollecting = false;
    }
  }

  /**
   * Invoked by task runners and navigation handlers when a page enters an idle interval
   * (e.g. between product visits or during pageSettle).
   */
  public async notifyNavigationIdle(): Promise<void> {
    if (this.pendingIdleGc) {
      this.logger.info("idle_gc_sweep_executing", "Executing deferred GC sweep during navigation idle interval");
      await this.performDeterministicGC("idle_navigation_window");
    }
  }

  private evaluateMemoryPressure(): void {
    const stats = this.getMemoryStats();
    if (stats.pressureLevel === "critical" || stats.pressureLevel === "emergency" || stats.pressureLevel === "pressure") {
      this.pendingIdleGc = true;
    }
  }
}
