/**
 * src/performance/AdaptiveLauncher.ts
 *
 * Adaptive launch gate with real-time Windows CPU feedback and circuit breaker.
 * Prevents launch thundering herds and 100% CPU lock when spawning 50+ Chromium instances.
 */
import os from "node:os";

export interface AdaptiveLauncherOptions {
  baseIntervalMs?: number;
  targetCpuPercent?: number;
  maxCpuThreshold?: number;
  minFreeRamMb?: number;
  maxConcurrent?: number;
}

export class AdaptiveLauncher {
  private activeLaunches = 0;
  private readonly maxConcurrent: number;
  private readonly baseIntervalMs: number;
  private readonly targetCpuPercent: number;
  private readonly maxCpuThreshold: number;
  private readonly minFreeRamMb: number;
  private lastCpuSample = this.sampleCpu();
  private cpuEma = 25;
  private lastLaunchTime = 0;
  private launchCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: AdaptiveLauncherOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.baseIntervalMs = options.baseIntervalMs ?? 300;
    this.targetCpuPercent = options.targetCpuPercent ?? 75;
    this.maxCpuThreshold = options.maxCpuThreshold ?? 85;
    this.minFreeRamMb = options.minFreeRamMb ?? 1024;
  }

  private sampleCpu(): { idle: number; total: number } {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += (cpu.times as any)[type];
      }
      idle += cpu.times.idle;
    }
    return { idle, total };
  }

  public refreshCpuLoad(): number {
    const current = this.sampleCpu();
    const idleDelta = current.idle - this.lastCpuSample.idle;
    const totalDelta = current.total - this.lastCpuSample.total;
    this.lastCpuSample = current;

    if (totalDelta > 0) {
      const instantCpu = Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
      this.cpuEma = 0.35 * instantCpu + 0.65 * this.cpuEma;
    }
    return this.cpuEma;
  }

  public async acquire(): Promise<void> {
    if (this.activeLaunches < this.maxConcurrent) {
      this.activeLaunches++;
      await this.enforceAdaptiveDelay();
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(async () => {
        this.activeLaunches++;
        await this.enforceAdaptiveDelay();
        resolve();
      });
    });
  }

  private async enforceAdaptiveDelay(): Promise<void> {
    while (true) {
      const cpu = this.refreshCpuLoad();
      const freeMemMb = os.freemem() / (1024 * 1024);

      // ── Circuit Breaker: Wait if host CPU > threshold or RAM depleted ──
      if (cpu >= this.maxCpuThreshold || freeMemMb < this.minFreeRamMb) {
        await new Promise<void>((r) => setTimeout(r, 600));
        continue;
      }

      // ── Dynamic Interval Calculation ──
      const cpuRatio = Math.max(0.1, cpu / this.targetCpuPercent);
      const dynamicPenalty = Math.pow(cpuRatio, 2.5) * 350;
      const baseGap = this.launchCount < 5 ? 450 : this.baseIntervalMs;
      const requiredGap = Math.round(baseGap + dynamicPenalty);

      const elapsed = Date.now() - this.lastLaunchTime;
      if (elapsed < requiredGap) {
        await new Promise<void>((r) => setTimeout(r, requiredGap - elapsed));
      }

      this.lastLaunchTime = Date.now();
      this.launchCount++;
      break;
    }
  }

  public release(): void {
    this.activeLaunches--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  public resetStats(): void {
    this.launchCount = 0;
  }
}
