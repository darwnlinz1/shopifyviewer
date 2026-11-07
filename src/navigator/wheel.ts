/**
 * src/navigator/wheel.ts
 *
 * Production-Grade Viscous Fluid Scrolling Physics Engine (V2.0.0 Architecture)
 *
 * Implements:
 *   1. Viscous Fluid Drag Decay Model: v(t) = v0 * exp(-gamma * t), S_inf = v0 / gamma => v0 = gamma * D
 *   2. Exact Analytic Discrete Exponential Integrator: Delta y_k = (v_k / gamma) * (1 - exp(-gamma * dt))
 *   3. Bresenham Sub-Pixel Residual Accumulator: 0px cumulative drift, zero rounding jitter
 *   4. Biological Overshoot & Viscous Rebound
 *   5. Hardware Detent Emulation for Mechanical Mouse Wheels
 */
import type { Page } from "rebrowser-playwright";
import type { Rng } from "../util/random.js";
import { sleep } from "../util/random.js";
import { HumanCursor } from "../behavior/humanCursor.js";
import { viewportOf } from "../browser/viewport.js";

const sessionScrollStyle = new WeakMap<Page, "trackpad" | "detent">();
const sessionDetentQuantum = new WeakMap<Page, number>();

async function withMouse<T>(fn: () => Promise<T>, ms = 6_000): Promise<T | null> {
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((r) => setTimeout(() => r(null), ms)),
    ]);
  } catch {
    return null;
  }
}

/** Put the cursor somewhere content-like using a continuous biological trajectory so wheel events land naturally. */
export async function seatCursor(page: Page, rng: Rng): Promise<void> {
  const size = viewportOf(page);
  const target = {
    x: Math.round(size.width * rng.float(0.3, 0.7)),
    y: Math.round(size.height * rng.float(0.35, 0.65)),
  };
  const cursor = new HumanCursor(page, rng);
  await withMouse(() => cursor.moveTo(target), 3_000);
}

/**
 * Scroll by `distance` px (signed) as one eased burst of genuine wheel input.
 * Returns the signed distance travelled, or null if the page went away.
 */
export async function wheelBy(
  page: Page,
  rng: Rng,
  distance: number,
  opts: { style?: "trackpad" | "detent" } = {},
): Promise<number | null> {
  const direction = Math.sign(distance);
  const total = Math.abs(distance);
  if (total < 4) return 0;

  // 1. Hardware discrimination: Persist per-page/session (68% Trackpad Smooth Inertia, 32% Hardware Detents)
  // Real users do not swap physical input hardware on every scroll burst!
  let style = opts.style ?? sessionScrollStyle.get(page);
  if (!style) {
    style = rng.chance(0.68) ? "trackpad" : "detent";
    if (page && typeof page === "object") sessionScrollStyle.set(page, style);
  }
  let moved = 0;

  if (style === "detent") {
    // HARDWARE DETENT: Constant OS wheel quantum per session (100px or 120px) with Log-Normal inter-notch timing
    let quantum = sessionDetentQuantum.get(page);
    if (!quantum) {
      quantum = rng.chance(0.5) ? 100 : 120;
      if (page && typeof page === "object") sessionDetentQuantum.set(page, quantum);
    }
    const notches = Math.max(1, Math.round(total / quantum));
    const baseStep = Math.round(total / notches);

    const spinStart = performance.now();
    let plannedMs = 0;
    for (let i = 0; i < notches; ) {
      // Notches the page was too busy to take one by one arrive together (input coalescing).
      const overdue = Math.floor((performance.now() - spinStart - plannedMs) / 50);
      const batch = Math.min(notches - i, 1 + Math.min(3, Math.max(0, overdue)));
      const step = i + batch >= notches ? Math.max(12, total - moved) : baseStep * batch;
      const applied = await withMouse(() => page.mouse.wheel(0, step * direction), 2000);
      if (applied === null) return null;
      moved += step;
      i += batch;
      // Mechanical detent pause (Log-Normal-like 35ms - 75ms, slightly slower at end of finger stroke)
      const progress = i / notches;
      const pauseMs = Math.round(rng.int(35, 62) * (1 + 0.25 * progress));
      // A normal page takes an event in well under 25ms; only real lag merges notches.
      plannedMs += (pauseMs + 25) * batch;
      await sleep(pauseMs);
    }
  } else {
    // TRACKPAD: Two-Phase Gesture Physics
    //   Phase I: Active Finger Contact Acceleration Ramp (~22% of distance over 3-5 frames)
    //   Phase II: Viscous Fluid Exponential Decay v(t) = v_peak * exp(-gamma * t) (~78% of distance)
    const rampRatio = total > 80 ? rng.float(0.18, 0.25) : 0;
    const rampTotal = total * rampRatio;
    const coastTotal = total - rampTotal;

    const baseDt = 1 / 60; // 60Hz nominal frame interval (16.67ms)
    let subpixelRemainder = 0; // Bresenham Residual Error Accumulator
    // Frames are scheduled on the wall clock: the CDP round-trip of a wheel
    // event eats into the frame instead of being added on top of it, so the
    // gesture lasts as long as the physics says, not physics + IPC latency.
    const clockStart = performance.now();
    let frameClock = 0;
    const waitForFrame = async (dtMs: number): Promise<void> => {
      frameClock += dtMs;
      const ahead = frameClock - (performance.now() - clockStart);
      if (ahead > 1) await sleep(Math.round(ahead));
    };

    if (rampTotal > 6) {
      const rampFrames = rng.int(3, 5);
      // Rising ramp weights (1, 2, ..., rampFrames) normalized to sum to rampTotal
      const weightSum = (rampFrames * (rampFrames + 1)) / 2;
      for (let f = 1; f <= rampFrames; f++) {
        const exactRamp = (rampTotal * f) / weightSum + subpixelRemainder;
        const intStep = exactRamp >= 0 ? Math.floor(exactRamp) : Math.ceil(exactRamp);
        subpixelRemainder = exactRamp - intStep;
        if (intStep !== 0) {
          const applied = await withMouse(() => page.mouse.wheel(0, intStep * direction), 2000);
          if (applied === null) return null;
          moved += Math.abs(intStep);
        }
        await waitForFrame(rng.int(13, 18));
      }
    }

    const gamma = 4.35 + rng.next() * 0.85; // s^-1
    let currentVelocity = coastTotal * gamma; // v0 such that integral_0^inf v dt = coastTotal
    const maxDurationSec = 1.35;
    // Momentum ends once it is under ~0.4 px/frame; the few pixels left are flushed below.
    const stopVelocity = 24;
    let elapsed = 0;
    const coastStart = performance.now();

    while (elapsed < maxDurationSec && Math.abs(currentVelocity) > stopVelocity) {
      // Frame timing jitter (~14.5ms - 18.5ms)
      const frameJitter = (rng.next() - 0.5) * 0.003;
      // A busy page answers each wheel event slower than a frame: the physics
      // then advances by the time that really passed, in one larger event —
      // input coalescing, as a loaded browser does — so the gesture keeps its
      // real duration instead of stretching to many seconds.
      const lag = (performance.now() - coastStart) / 1000 - elapsed;
      const dt = Math.min(0.12, Math.max(0.008, baseDt + frameJitter, lag));
      elapsed += dt;

      // Exact analytic exponential displacement across [t_k, t_k + dt]
      const exactDisplacement = (currentVelocity / gamma) * (1.0 - Math.exp(-gamma * dt));
      currentVelocity *= Math.exp(-gamma * dt);

      // Bresenham Sub-Pixel Error Accumulation
      const rawDelta = exactDisplacement + subpixelRemainder;
      const integerStep = rawDelta >= 0 ? Math.floor(rawDelta) : Math.ceil(rawDelta);
      subpixelRemainder = rawDelta - integerStep;

      if (integerStep !== 0) {
        const applied = await withMouse(() => page.mouse.wheel(0, integerStep * direction), 2000);
        if (applied === null) return null;
        moved += Math.abs(integerStep);
      }

      await waitForFrame(Math.max(8, Math.round(dt * 1000)));
    }

    // Flush the momentum tail and any sub-pixel residue in one last event.
    const tail = Math.round(Math.max(0, total - moved));
    if (tail > 0) {
      await withMouse(() => page.mouse.wheel(0, tail * direction), 2000);
      moved += tail;
    }
  }

  // 3. Biological Overshoot and Viscous Rebound
  if (rng.chance(0.14) && moved > 140) {
    const overshootPx = rng.int(14, 36);
    const over = await withMouse(() => page.mouse.wheel(0, overshootPx * direction), 2000);
    if (over !== null) {
      // Cognitive reaction pause
      await sleep(rng.int(110, 220));

      // Viscous Rebound (wall-clock frames, like the main gesture)
      const reboundGamma = 6.0;
      let reboundV = overshootPx * reboundGamma;
      let rElapsed = 0;
      let rRemainder = 0;
      let reboundBack = 0;
      const reboundStart = performance.now();

      while (rElapsed < 0.45 && reboundV > 12) {
        const dt = 1 / 60;
        rElapsed += dt;
        const rDisp = (reboundV / reboundGamma) * (1.0 - Math.exp(-reboundGamma * dt));
        reboundV *= Math.exp(-reboundGamma * dt);

        const rawR = rDisp + rRemainder;
        const intR = Math.floor(rawR);
        rRemainder = rawR - intR;

        if (intR > 0) {
          await withMouse(() => page.mouse.wheel(0, -intR * direction), 2000);
          reboundBack += intR;
        }
        const ahead = rElapsed * 1000 - (performance.now() - reboundStart);
        if (ahead > 1) await sleep(Math.round(ahead));
      }
      const reboundTail = overshootPx - reboundBack;
      if (reboundTail > 0) await withMouse(() => page.mouse.wheel(0, -reboundTail * direction), 2000);
    }
  }

  return moved * direction;
}
