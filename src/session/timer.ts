/**
 * Session Timer.
 *
 * Owns the ~15 minute session budget. The Behaviour Engine reads `phase()` and
 * `remainingMs()` to shape its decisions — browsing widely early on, and
 * winding down toward EXIT as the budget runs out — so a session ends by
 * choosing to leave, not by being killed mid-action.
 */
import type { SessionConfig } from "../config.js";
import { Rng } from "../util/random.js";

/** Coarse position within the session budget. */
export type SessionPhase = "early" | "mid" | "late" | "expired";

export class SessionTimer {
  readonly startedAt: number;
  /** Target end time, including per-session jitter. Moves when extended. */
  deadline: number;
  /** Absolute ceiling; a session is aborted if it somehow runs past this. */
  hardDeadline: number;
  plannedDurationMs: number;

  constructor(config: SessionConfig, rng: Rng) {
    this.startedAt = Date.now();
    const jitter = config.durationJitterMs
      ? rng.int(-config.durationJitterMs, config.durationJitterMs)
      : 0;
    this.plannedDurationMs = Math.max(30_000, config.durationMs + jitter);
    this.deadline = this.startedAt + this.plannedDurationMs;
    this.hardDeadline = this.startedAt + Math.max(config.hardTimeoutMs, this.plannedDurationMs + 60_000);
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  /** Fraction of the planned budget consumed, 0..1+. */
  progress(): number {
    return this.elapsedMs() / this.plannedDurationMs;
  }

  isExpired(): boolean {
    return Date.now() >= this.deadline;
  }

  isHardExpired(): boolean {
    return Date.now() >= this.hardDeadline;
  }

  phase(): SessionPhase {
    if (this.isExpired()) return "expired";
    const progress = this.progress();
    if (progress < 0.4) return "early";
    if (progress < 0.8) return "mid";
    return "late";
  }

  /**
   * Whether there is room for another action of roughly this cost. Keeps the
   * engine from starting a long gesture it cannot finish before the deadline.
   */
  hasRoomFor(estimatedMs: number): boolean {
    return this.remainingMs() > estimatedMs;
  }

  /**
   * Give the session more time.
   *
   * Both deadlines move together: extending only the soft deadline would let
   * the hard timeout fire first and kill the very session the operator just
   * asked to keep going.
   */
  extend(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    // A session extended after its deadline has already passed should get the
    // full extra time from now, not from a deadline in the past.
    const base = Math.max(Date.now(), this.deadline);
    this.deadline = base + ms;
    this.plannedDurationMs = this.deadline - this.startedAt;
    this.hardDeadline = Math.max(this.hardDeadline, this.deadline + 60_000);
  }

  /** Human-readable remaining time, for log lines. */
  formatRemaining(): string {
    const seconds = Math.round(this.remainingMs() / 1000);
    const mins = Math.floor(seconds / 60);
    return `${mins}m${String(seconds % 60).padStart(2, "0")}s`;
  }
}
