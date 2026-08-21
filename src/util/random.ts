/**
 * Seeded pseudo-random helpers.
 *
 * Every non-deterministic choice in the simulator flows through one Rng
 * instance, so a session can be reproduced exactly by reusing its seed — which
 * matters when a run surfaces a storefront bug you need to replay.
 */
import type { Range } from "../config.js";

/** mulberry32 — small, fast, good enough for behavioural jitter. */
export class Rng {
  private state: number;

  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  /** Sample a configured range, rounded to an integer. */
  range(range: Range): number {
    return Math.round(this.float(range.min, range.max));
  }

  /** Sample a configured range as a float (for fractions). */
  rangeFloat(range: Range): number {
    return this.float(range.min, range.max);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly pick one element; undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.next() * items.length)];
  }

  /**
   * Pick one entry by weight. Entries with weight <= 0 are never chosen.
   * Returns undefined when every candidate is unavailable.
   */
  weighted<T>(entries: ReadonlyArray<{ value: T; weight: number }>): T | undefined {
    const usable = entries.filter((e) => e.weight > 0);
    if (usable.length === 0) return undefined;
    const total = usable.reduce((sum, e) => sum + e.weight, 0);
    let roll = this.next() * total;
    for (const entry of usable) {
      roll -= entry.weight;
      if (roll <= 0) return entry.value;
    }
    return usable[usable.length - 1]!.value;
  }

  /** Fisher-Yates shuffle, returning a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}

/** Generate a random 32-bit seed. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
