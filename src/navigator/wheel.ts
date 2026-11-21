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

/** Put the cursor somewhere content-like so wheel events land on the page. */
export async function seatCursor(page: Page, rng: Rng): Promise<void> {
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  const target = {
    x: Math.round(size.width * rng.float(0.3, 0.7)),
    y: Math.round(size.height * rng.float(0.35, 0.65)),
  };
  await withMouse(() => page.mouse.move(target.x, target.y), 3_000);
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

  // 1. Hardware discrimination: 68% Trackpad (Smooth Inertia), 32% Hardware Detents
  const style = opts.style || (rng.chance(0.68) ? "trackpad" : "detent");
  let moved = 0;

  if (style === "detent") {
    // HARDWARE DETENT: Discrete mechanical spring-release notches
    const notches = Math.max(1, Math.round(total / rng.int(60, 110)));
    const notchSize = total / notches;

    for (let i = 0; i < notches; i++) {
      const step = Math.round(notchSize * rng.float(0.88, 1.14));
      const applied = await withMouse(() => page.mouse.wheel(0, step * direction), 2000);
      if (applied === null) return null;
      moved += step;
      // Mechanical detent pause (35ms - 65ms)
      await sleep(rng.int(35, 65));
    }
  } else {
    // TRACKPAD: Viscous Fluid Exponential Decay v(t) = v0 * exp(-gamma * t)
    // Exact Discrete Exponential Integrator + Bresenham Sub-Pixel Error Diffusion Accumulator
    const gamma = 4.35 + rng.next() * 0.85; // s^-1
    let currentVelocity = total * gamma;     // v0 such that integral_0^inf v dt = total
    const maxDurationSec = 1.4;
    const baseDt = 1 / 60; // 60Hz nominal frame interval (16.67ms)

    let elapsed = 0;
    let subpixelRemainder = 0; // Bresenham Residual Error Accumulator

    while (elapsed < maxDurationSec && Math.abs(currentVelocity) > 0.6) {
      // Frame timing jitter (~14.5ms - 18.5ms)
      const frameJitter = (rng.next() - 0.5) * 0.003;
      const dt = Math.max(0.008, baseDt + frameJitter);
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

      const sleepMs = Math.max(8, Math.round(dt * 1000));
      await sleep(sleepMs);
    }

    // Flush any residual sub-pixel accumulated difference
    if (Math.abs(subpixelRemainder) >= 0.5) {
      const finalFlush = Math.round(subpixelRemainder);
      if (finalFlush !== 0) {
        await withMouse(() => page.mouse.wheel(0, finalFlush * direction), 2000);
        moved += Math.abs(finalFlush);
      }
    }
  }

  // 3. Biological Overshoot and Viscous Rebound
  if (rng.chance(0.14) && moved > 140) {
    const overshootPx = rng.int(14, 36);
    const over = await withMouse(() => page.mouse.wheel(0, overshootPx * direction), 2000);
    if (over !== null) {
      // Cognitive reaction pause
      await sleep(rng.int(110, 220));

      // Viscous Rebound
      const reboundGamma = 6.0;
      let reboundV = overshootPx * reboundGamma;
      let rElapsed = 0;
      let rRemainder = 0;

      while (rElapsed < 0.45 && reboundV > 0.8) {
        const dt = 1 / 60;
        rElapsed += dt;
        const rDisp = (reboundV / reboundGamma) * (1.0 - Math.exp(-reboundGamma * dt));
        reboundV *= Math.exp(-reboundGamma * dt);

        const rawR = rDisp + rRemainder;
        const intR = Math.floor(rawR);
        rRemainder = rawR - intR;

        if (intR > 0) {
          await withMouse(() => page.mouse.wheel(0, -intR * direction), 2000);
        }
        await sleep(Math.round(dt * 1000));
      }
    }
  }

  return moved * direction;
}
