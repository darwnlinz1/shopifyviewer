/**
 * src/behavior/humanTyping.ts
 *
 * Ergonomic Biometric Keyboard Engine (V2.0.0 Architecture)
 *
 * Implements:
 *   1. Keystroke Dwell Time (Log-Normal Box-Muller: Key-Down to Key-Up, μ = 80ms, σ = 18ms, bounds [35ms, 160ms])
 *   2. Biomechanical QWERTY Digraph Flight Latency Matrix (4 tiers: Hand alternation, Cross-finger, Same-finger, Double-letter)
 *   3. Cognitive Typos with Spatial Adjacency, Motor Momentum Perception Lag (typing 1 more char before realizing), and PES (1.38x decay)
 */
import type { Page } from "rebrowser-playwright";
import type { Rng } from "../util/random.js";

interface KeyPosition {
  row: number;
  col: number;
  hand: 0 | 1; // 0 = Left, 1 = Right
  finger: 1 | 2 | 3 | 4 | 5; // 1 = Pinky ... 5 = Thumb
}

const KEY_MAP: Record<string, KeyPosition> = {
  // Number row (0)
  "1": { row: 0, col: 0, hand: 0, finger: 1 }, "2": { row: 0, col: 1, hand: 0, finger: 2 },
  "3": { row: 0, col: 2, hand: 0, finger: 3 }, "4": { row: 0, col: 3, hand: 0, finger: 4 },
  "5": { row: 0, col: 4, hand: 0, finger: 4 }, "6": { row: 0, col: 5, hand: 1, finger: 4 },
  "7": { row: 0, col: 6, hand: 1, finger: 4 }, "8": { row: 0, col: 7, hand: 1, finger: 3 },
  "9": { row: 0, col: 8, hand: 1, finger: 2 }, "0": { row: 0, col: 9, hand: 1, finger: 1 },

  // Top row (1)
  q: { row: 1, col: 0, hand: 0, finger: 1 }, w: { row: 1, col: 1, hand: 0, finger: 2 },
  e: { row: 1, col: 2, hand: 0, finger: 3 }, r: { row: 1, col: 3, hand: 0, finger: 4 },
  t: { row: 1, col: 4, hand: 0, finger: 4 }, y: { row: 1, col: 5, hand: 1, finger: 4 },
  u: { row: 1, col: 6, hand: 1, finger: 4 }, i: { row: 1, col: 7, hand: 1, finger: 3 },
  o: { row: 1, col: 8, hand: 1, finger: 2 }, p: { row: 1, col: 9, hand: 1, finger: 1 },

  // Home row (2)
  a: { row: 2, col: 0, hand: 0, finger: 1 }, s: { row: 2, col: 1, hand: 0, finger: 2 },
  d: { row: 2, col: 2, hand: 0, finger: 3 }, f: { row: 2, col: 3, hand: 0, finger: 4 },
  g: { row: 2, col: 4, hand: 0, finger: 4 }, h: { row: 2, col: 5, hand: 1, finger: 4 },
  j: { row: 2, col: 6, hand: 1, finger: 4 }, k: { row: 2, col: 7, hand: 1, finger: 3 },
  l: { row: 2, col: 8, hand: 1, finger: 2 },

  // Bottom row (3)
  z: { row: 3, col: 0, hand: 0, finger: 1 }, x: { row: 3, col: 1, hand: 0, finger: 2 },
  c: { row: 3, col: 2, hand: 0, finger: 3 }, v: { row: 3, col: 3, hand: 0, finger: 4 },
  b: { row: 3, col: 4, hand: 0, finger: 4 }, n: { row: 3, col: 5, hand: 1, finger: 4 },
  m: { row: 3, col: 6, hand: 1, finger: 4 },
  " ": { row: 4, col: 4, hand: 1, finger: 5 },
};

const QWERTY_ADJACENT: Record<string, string[]> = {
  a: ["q", "w", "s", "z"], b: ["v", "g", "h", "n"], c: ["x", "d", "f", "v"],
  d: ["s", "e", "r", "f", "c", "x"], e: ["w", "s", "d", "r"], f: ["d", "r", "t", "g", "v", "c"],
  g: ["f", "t", "y", "h", "b", "v"], h: ["g", "y", "u", "j", "n", "b"], i: ["u", "j", "k", "o"],
  k: ["j", "i", "o", "l", "m"], l: ["k", "o", "p"], m: ["n", "j", "k"], n: ["b", "h", "j", "m"],
  o: ["i", "k", "l", "p"], p: ["o", "l"], r: ["e", "d", "f", "t"], s: ["a", "w", "e", "d", "x", "z"],
  t: ["r", "f", "g", "y"], u: ["y", "h", "j", "i"], v: ["c", "f", "g", "b"], w: ["q", "a", "s", "e"],
  x: ["z", "s", "d", "c"], y: ["t", "g", "h", "u"], z: ["a", "s", "x"],
};

/**
 * Box-Muller Gaussian standard normal variate generator.
 */
function sampleGaussian(rng: Rng): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 <= 1e-7) u1 = rng.next();
  while (u2 <= 1e-7) u2 = rng.next();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Log-Normal distribution draw using Box-Muller transform.
 */
function sampleLogNormal(rng: Rng, meanMs: number, sigma = 0.20): number {
  const z0 = sampleGaussian(rng);
  return Math.round(meanMs * Math.exp(sigma * z0));
}

/**
 * Computes biomechanical flight latency between two consecutive characters.
 */
function computeFlightLatency(rng: Rng, prevChar: string, nextChar: string): number {
  const p1 = KEY_MAP[prevChar.toLowerCase()];
  const p2 = KEY_MAP[nextChar.toLowerCase()];

  if (!p1 || !p2) {
    return sampleLogNormal(rng, 140, 0.22);
  }

  // Tier 4: Double letter repetition (e.g. 'oo', 'll')
  if (prevChar.toLowerCase() === nextChar.toLowerCase()) {
    return sampleLogNormal(rng, 115, 0.18);
  }

  // Tier 1: Hand alternation (Left -> Right or Right -> Left)
  if (p1.hand !== p2.hand) {
    return sampleLogNormal(rng, 95, 0.20);
  }

  // Tier 2: Same hand, different finger
  if (p1.finger !== p2.finger) {
    const dist = Math.hypot(p1.row - p2.row, p1.col - p2.col);
    return sampleLogNormal(rng, 145 + dist * 8, 0.22);
  }

  // Tier 3: Same hand, same finger (physical transit delay)
  const rowDist = Math.abs(p1.row - p2.row);
  return sampleLogNormal(rng, 220 + rowDist * 35, 0.25);
}

/**
 * Determine whether two consecutive characters can exhibit N-graph key rollover
 * (Dhakal et al. CHI 2018: 25-45% of human keystrokes overlap on alternating hands or inward rolls).
 */
function canRolloverDigraph(prevChar: string, nextChar: string): boolean {
  if (!prevChar || !nextChar || prevChar.toLowerCase() === nextChar.toLowerCase()) return false;
  const p1 = KEY_MAP[prevChar.toLowerCase()];
  const p2 = KEY_MAP[nextChar.toLowerCase()];
  if (!p1 || !p2) return false;
  // Tier 1: Alternating hands (left <-> right)
  if (p1.hand !== p2.hand) return true;
  // Tier 2: Same-hand inward roll (outer finger -> inner finger, e.g. pinky/ring -> middle/index)
  if (p1.hand === p2.hand && p1.finger < p2.finger && p1.row === p2.row) return true;
  return false;
}

/**
 * Dispatches a single keystroke with distinct keydown and keyup dwell timing.
 * Dwell time strictly conforms to Log-Normal(μ=80ms, σ=18ms, [35ms, 160ms]).
 */
async function pressKeyWithDwell(page: Page, key: string, rng: Rng): Promise<number> {
  const dwellTime = Math.max(35, Math.min(160, sampleLogNormal(rng, 80, 0.22)));
  await page.keyboard.down(key);
  await new Promise((r) => setTimeout(r, dwellTime));
  await page.keyboard.up(key);
  return dwellTime;
}

/**
 * Types human-like text with authentic dwell times, QWERTY digraph flight times,
 * N-graph key rollover (overlapping keydown/keyup on alternating hands),
 * cognitive perception lag, and post-error slowing.
 */
export async function typeHumanLike(page: Page, text: string, rng: Rng): Promise<void> {
  let prevChar = " ";
  let prevDwell = 75;
  let pendingKeyUp: Promise<void> | null = null;
  let i = 0;
  let postErrorSlowing = 1.0;

  while (i < text.length) {
    const char = text[i] ?? "";
    const lower = char.toLowerCase();

    // 3% chance of typo on adjacent key
    const willTypo = rng.next() < 0.03 && QWERTY_ADJACENT[lower];

    if (willTypo) {
      if (pendingKeyUp) {
        await pendingKeyUp;
        pendingKeyUp = null;
      }
      const adjacent = QWERTY_ADJACENT[lower] ?? [];
      const wrongChar = adjacent[Math.floor(rng.next() * adjacent.length)] ?? "e";

      const typoFlight = computeFlightLatency(rng, prevChar, wrongChar);
      const typoReleaseDelay = Math.max(8, Math.round(typoFlight * postErrorSlowing) - prevDwell);
      await new Promise((r) => setTimeout(r, typoReleaseDelay));
      prevDwell = await pressKeyWithDwell(page, wrongChar, rng);

      // Motor Momentum Perception Lag: 1 extra character typed before brain realizes error
      const hasNext = i < text.length - 1;
      let nextCharTyped = "";
      if (hasNext) {
        nextCharTyped = text[i + 1] ?? "";
        const nextFlight = computeFlightLatency(rng, wrongChar, nextCharTyped);
        await new Promise((r) => setTimeout(r, Math.max(8, nextFlight - prevDwell)));
        prevDwell = await pressKeyWithDwell(page, nextCharTyped, rng);
      }

      // Cognitive realization pause (200ms - 420ms)
      await new Promise((r) => setTimeout(r, 200 + rng.next() * 220));

      // Sequential backspacing with physiological pauses
      if (hasNext) {
        await pressKeyWithDwell(page, "Backspace", rng);
        await new Promise((r) => setTimeout(r, 65 + rng.next() * 30));
      }
      await pressKeyWithDwell(page, "Backspace", rng);

      // Post-Error Slowing hesitation
      await new Promise((r) => setTimeout(r, 160 + rng.next() * 120));
      postErrorSlowing = 1.38;
      prevDwell = 85;
    }

    // Type the correct character (with N-graph rollover when biomechanically eligible)
    const baseFlight = computeFlightLatency(rng, prevChar, char);
    const targetFlight = Math.round(baseFlight * postErrorSlowing);
    const rawRpDelay = targetFlight - prevDwell;
    postErrorSlowing = Math.max(1.0, postErrorSlowing - 0.14);

    const nextChar = i + 1 < text.length ? (text[i + 1] ?? "") : "";
    const nextEligibleRollover = canRolloverDigraph(char, nextChar) && postErrorSlowing <= 1.05 && rng.chance(0.55);
    const currentDwell = Math.max(35, Math.min(160, sampleLogNormal(rng, 80, 0.22)));

    if (pendingKeyUp) {
      // Previous key is still held down (rollover active): press current key now, then await previous keyup
      await page.keyboard.down(char);
      await pendingKeyUp;
      pendingKeyUp = null;
      await new Promise((r) => setTimeout(r, currentDwell));
      await page.keyboard.up(char);
      prevDwell = currentDwell;
    } else if (nextEligibleRollover) {
      const releaseToPressDelay = Math.max(8, rawRpDelay);
      await new Promise((r) => setTimeout(r, releaseToPressDelay));
      const overlapMs = rng.int(12, Math.min(36, currentDwell - 15));
      const preOverlapMs = Math.max(12, currentDwell - overlapMs);
      await page.keyboard.down(char);
      await new Promise((r) => setTimeout(r, preOverlapMs));
      // Schedule keyup after overlapMs while next iteration presses the next key!
      pendingKeyUp = new Promise<void>((resolve) => {
        setTimeout(() => {
          void page.keyboard.up(char).then(() => resolve()).catch(() => resolve());
        }, overlapMs);
      });
      prevDwell = currentDwell;
    } else {
      const releaseToPressDelay = Math.max(10, rawRpDelay);
      await new Promise((r) => setTimeout(r, releaseToPressDelay));
      await page.keyboard.down(char);
      await new Promise((r) => setTimeout(r, currentDwell));
      await page.keyboard.up(char);
      prevDwell = currentDwell;
    }

    prevChar = char;
    i++;
  }

  if (pendingKeyUp) {
    await pendingKeyUp;
  }
}
