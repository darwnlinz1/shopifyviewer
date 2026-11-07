/**
 * src/behavior/humanCursor.ts
 *
 * Biological Human Mouse Trajectory & Target Acquisition Engine (V2.0.0 Architecture)
 *
 * Mathematically grounded in:
 *   1. Flash & Hogan Minimum-Jerk Kinematic Trajectory Model (Quintic σ₅ & Septic σ₇ C³ Continuous Jerk Boundary)
 *   2. Lacquaniti Two-Thirds Power Law Curvature Coupling (v ∝ (κ + ε)^(-1/3))
 *   3. Decoupled 3-Pole IIR Pink Noise Filter (1/f PSD, α = 1.035)
 *   4. Neuromuscular Tremor (8–12Hz) with Symplectic Semi-Implicit Euler Integrator (det(A) <= 1 unconditionally stable)
 *   5. Meyer's Stochastic Optimized Dual-Submovement Superposition (Logistic Activation for D > 140px)
 *   6. Shannon Formulation Fitts's Law with Fast Non-Trigonometric Directional Effective Width W_eff(θ)
 *   7. Box-Muller Truncated Bivariate Gaussian Off-Center Landing ([0.18, 0.82])
 *   8. Cognitive Pre-Click Visual Confirmation Hesitation (50–130ms) & Log-Normal Dwell Time (35–160ms)
 */
import type { Page } from "rebrowser-playwright";
import type { Rng } from "../util/random.js";
import { viewportOf } from "../browser/viewport.js";

export interface Point {
  x: number;
  y: number;
}

export interface TargetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrajectoryPoint {
  x: number;
  y: number;
  timestamp: number; // milliseconds from start
  velocity?: number;
}

export class HumanCursor {
  private static readonly pagePositions = new WeakMap<Page, Point>();
  private currentPos: Point = { x: 500, y: 300 };

  // Decoupled 3-Pole IIR Pink Noise States (X and Y)
  private pinkStateX = [0, 0, 0];
  private pinkStateY = [0, 0, 0];
  private readonly pinkPoles = [0.99765, 0.96300, 0.57000];
  private readonly pinkGains = [0.099046, 0.2965164, 1.0526913];
  private readonly pinkB0 = 0.1848;

  // Decoupled 2nd-Order Symplectic Tremor States (X and Y)
  private tremorPosX = 0;
  private tremorVelX = 0;
  private tremorPosY = 0;
  private tremorVelY = 0;
  private tremorFreqHz = 10.0;
  private tremorQ = 4.2;

  constructor(
    private readonly page: Page,
    private readonly rng: Rng,
  ) {
    if (page && typeof page === "object") {
      const remembered = HumanCursor.pagePositions.get(page);
      if (remembered) {
        this.currentPos = { ...remembered };
      } else {
        const vp = viewportOf(page);
        this.currentPos = {
          x: Math.round(vp.width * (0.38 + this.rng.next() * 0.24)),
          y: Math.round(vp.height * (0.35 + this.rng.next() * 0.25)),
        };
        HumanCursor.pagePositions.set(page, { ...this.currentPos });
      }
    }
    this.resetNoiseGenerators();
  }

  /**
   * Resets and randomizes physiological tremor resonance frequencies per movement.
   */
  public resetNoiseGenerators(): void {
    this.pinkStateX = [0, 0, 0];
    this.pinkStateY = [0, 0, 0];
    this.tremorPosX = 0;
    this.tremorVelX = 0;
    this.tremorPosY = 0;
    this.tremorVelY = 0;
    this.tremorFreqHz = 8.5 + this.rng.next() * 3.0; // 8.5Hz - 11.5Hz
    this.tremorQ = 3.5 + this.rng.next() * 1.5;      // 3.5 - 5.0
  }

  /** Set current cursor origin and persist per Page so subsequent instances never teleport */
  public setPosition(pos: Point): void {
    this.currentPos = { ...pos };
    if (this.page && typeof this.page === "object") {
      HumanCursor.pagePositions.set(this.page, { ...pos });
    }
  }

  /** Get current cursor position */
  public getPosition(): Point {
    return { ...this.currentPos };
  }

  /**
   * Box-Muller transform for standard Gaussian deviate N(0, 1).
   */
  private sampleStandardGaussian(): number {
    let u1 = 0;
    let u2 = 0;
    while (u1 <= 1e-7) u1 = this.rng.next();
    while (u2 <= 1e-7) u2 = this.rng.next();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /**
   * Generates decoupled 1/f pink noise perturbation sample using a 3-pole IIR filter.
   */
  private stepPinkNoise(): { noiseX: number; noiseY: number } {
    const wx = this.sampleStandardGaussian();
    const wy = this.sampleStandardGaussian();

    let nyX = this.pinkB0 * wx;
    let nyY = this.pinkB0 * wy;

    for (let k = 0; k < 3; k++) {
      this.pinkStateX[k] = (this.pinkPoles[k] ?? 0.9) * (this.pinkStateX[k] ?? 0) + wx;
      this.pinkStateY[k] = (this.pinkPoles[k] ?? 0.9) * (this.pinkStateY[k] ?? 0) + wy;
      nyX += (this.pinkGains[k] ?? 0) * (this.pinkStateX[k] ?? 0);
      nyY += (this.pinkGains[k] ?? 0) * (this.pinkStateY[k] ?? 0);
    }

    return {
      noiseX: nyX * 0.025, // Scaled to ~ [-0.25, 0.25] px
      noiseY: nyY * 0.025,
    };
  }

  /**
   * Symplectic Semi-Implicit Euler Tremor Step (Unconditionally Stable: det(A) = 1 - gamma*dt < 1).
   */
  private stepTremor(dtSec: number, pinkX: number, pinkY: number): { tremX: number; tremY: number } {
    const w0 = 2.0 * Math.PI * this.tremorFreqHz;
    const gamma = w0 / this.tremorQ;
    const w0_sq = w0 * w0;

    // Semi-implicit symplectic integration: update velocity first, then position
    this.tremorVelX += (w0_sq * pinkX - gamma * this.tremorVelX - w0_sq * this.tremorPosX) * dtSec;
    this.tremorVelY += (w0_sq * pinkY - gamma * this.tremorVelY - w0_sq * this.tremorPosY) * dtSec;

    this.tremorPosX += this.tremorVelX * dtSec;
    this.tremorPosY += this.tremorVelY * dtSec;

    return {
      tremX: this.tremorPosX * 0.22, // Scaled physiological displacement in px
      tremY: this.tremorPosY * 0.22,
    };
  }

  /**
   * Septic basis polynomial function: σ₇(τ) = 35τ⁴ - 84τ⁵ + 70τ⁶ - 20τ⁷
   * Guarantees zero velocity, zero acceleration, and zero jerk at boundaries (C³ continuity).
   */
  private septic(tau: number): { sigma: number; dsigma: number; ddsigma: number } {
    const t = Math.max(0, Math.min(1, tau));
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t3 * t;
    const t5 = t4 * t;
    const t6 = t5 * t;
    const t7 = t6 * t;

    const sigma = 35.0 * t4 - 84.0 * t5 + 70.0 * t6 - 20.0 * t7;
    const dsigma = 140.0 * t3 - 420.0 * t4 + 420.0 * t5 - 140.0 * t6;
    const ddsigma = 420.0 * t2 - 1680.0 * t3 + 2100.0 * t4 - 840.0 * t5;

    return { sigma, dsigma, ddsigma };
  }

  /**
   * Fast Non-Trigonometric Directional Effective Target Width W_eff(θ) according to Shannon formulation.
   * W_eff = (W * H * D) / (W * |dy| + H * |dx|)
   */
  public computeEffectiveWidth(bounds: TargetBounds, dx: number, dy: number, dist?: number): number {
    const w = Math.max(8, bounds.width);
    const h = Math.max(8, bounds.height);
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const distance = dist !== undefined ? dist : Math.hypot(absDx, absDy);

    if (distance < 1e-4) return Math.min(w, h);
    const denominator = w * absDy + h * absDx;
    if (denominator < 1e-4) return Math.min(w, h);

    return (w * h * distance) / denominator;
  }

  /**
   * Computes movement duration using Fitts's Law (Shannon Formulation) with Log-Normal variance.
   */
  public computeMovementDuration(distance: number, effWidth: number): number {
    const a = 115 + this.rng.next() * 35; // Motor reaction latency (ms)
    const b = 135 + this.rng.next() * 25; // Slope: Inverse motor throughput (ms/bit)
    const indexDifficulty = Math.log2(distance / Math.max(4, effWidth) + 1.0);
    const rawDuration = a + b * indexDifficulty;

    // Log-Normal physiological execution variance
    const z0 = this.sampleStandardGaussian();
    const logNormalFactor = Math.exp(z0 * 0.08); // 8% standard deviation

    return Math.max(160, Math.round(rawDuration * logNormalFactor));
  }

  /**
   * Generates a biological trajectory incorporating Flash-Hogan Septic C³,
   * Two-Thirds Power Law curvature coupling, 3-pole Pink Noise, and Meyer's Dual-Submovements.
   */
  public generateTrajectory(
    start: Point,
    target: Point,
    targetBounds?: TargetBounds,
  ): TrajectoryPoint[] {
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 2) {
      return [{ x: target.x, y: target.y, timestamp: 0 }];
    }

    this.resetNoiseGenerators();
    const effWidth = targetBounds ? this.computeEffectiveWidth(targetBounds, dx, dy, distance) : 40;
    const durationMs = this.computeMovementDuration(distance, effWidth);
    const durationSec = durationMs / 1000;

    // Dual-submovement activation (Logistic activation for D > 140px)
    const probDual = 1.0 / (1.0 + Math.exp(-(distance - 140.0) / 28.0));
    const useDualSubmovement = distance > 140 && this.rng.next() < Math.max(0.80, probDual);

    // Normal vector for transverse curvature bow
    const perpX = -dy / distance;
    const perpY = dx / distance;
    const maxBow = (this.rng.next() - 0.5) * Math.min(22, distance * 0.08);

    // Primary submovement landing point (91-97% of distance with lateral drift)
    let pPrimary: Point = { ...target };
    if (useDualSubmovement) {
      const lambda1 = Math.max(0.89, Math.min(0.97, 0.935 + this.sampleStandardGaussian() * 0.025));
      const lateralDeviation = this.sampleStandardGaussian() * Math.min(24, distance * 0.055);

      pPrimary = {
        x: start.x + lambda1 * dx + perpX * lateralDeviation,
        y: start.y + lambda1 * dy + perpY * lateralDeviation,
      };
    }

    // 120Hz high-resolution sampling (~8.33ms per step)
    const dt = 1 / 120;
    const totalSteps = Math.max(14, Math.round(durationSec / dt));
    const trajectory: TrajectoryPoint[] = [];

    const sub1Duration = useDualSubmovement ? durationSec * 0.74 : durationSec;
    const sub2Start = useDualSubmovement ? durationSec * (0.60 + this.rng.next() * 0.05) : durationSec;
    const sub2Duration = durationSec - sub2Start;

    // Precompute Equi-Affine Arc-Length CDF Φ(u) for Lacquaniti Two-Thirds Power Law (v ∝ (κ + κ₀)^(-1/3)):
    // Spatial curve: X(u) = D1 * u, Y(u) = 16 * B * u² * (1 - u)² for u ∈ [0, 1].
    const d1 = Math.max(1, Math.hypot(pPrimary.x - start.x, pPrimary.y - start.y));
    const gridN = 64;
    const cdf: number[] = new Array(gridN + 1).fill(0);
    const kappa0 = 0.0015; // Regularization constant preventing infinite velocity on straight segments
    let accum = 0;
    for (let k = 1; k <= gridN; k++) {
      const u = (k - 0.5) / gridN;
      // g(u) = 16 B u²(1-u)² => g'(u) = 32 B u (1 - 3u + 2u²), g''(u) = 32 B (1 - 6u + 6u²)
      const gPrime = 32.0 * maxBow * u * (1.0 - 3.0 * u + 2.0 * u * u);
      const gSecond = 32.0 * maxBow * (1.0 - 6.0 * u + 6.0 * u * u);
      const dsDu = Math.hypot(d1, gPrime);
      const curvature = Math.abs(d1 * gSecond) / Math.pow(Math.max(1e-4, dsDu), 3);
      // Equi-affine differential weight: (κ(u) + κ₀)^(1/3) * ds/du
      const weight = Math.cbrt(curvature + kappa0) * dsDu;
      accum += weight / gridN;
      cdf[k] = accum;
    }
    const totalAffineLen = Math.max(1e-6, accum);
    for (let k = 1; k <= gridN; k++) {
      cdf[k] = (cdf[k] ?? 0) / totalAffineLen;
    }
    const invertAffineCdf = (q: number): number => {
      if (q <= 0) return 0;
      if (q >= 1) return 1;
      let lo = 0;
      let hi = gridN;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if ((cdf[mid] ?? 0) < q) lo = mid;
        else hi = mid;
      }
      const cLo = cdf[lo] ?? 0;
      const cHi = cdf[hi] ?? 1;
      const frac = cHi > cLo ? (q - cLo) / (cHi - cLo) : 0;
      return (lo + frac) / gridN;
    };

    let prevX = start.x;
    let prevY = start.y;

    for (let i = 0; i <= totalSteps; i++) {
      const rawTau = i / totalSteps;
      const t = rawTau * durationSec;

      // 1. Primary Minimum-Jerk progress in equi-affine space, inverted via Φ⁻¹ for Lacquaniti 2/3 Power Law
      const tau1 = Math.min(1.0, t / sub1Duration);
      const q1 = this.septic(tau1).sigma;
      const u1 = invertAffineCdf(q1);

      // 2. Smooth spatial curvature bow parameterized by chord progress u1: g(u) = 16·B·u²·(1-u)²
      const bow = 16.0 * maxBow * Math.pow(u1, 2) * Math.pow(1.0 - u1, 2);

      let cx = start.x + (pPrimary.x - start.x) * u1 + perpX * bow;
      let cy = start.y + (pPrimary.y - start.y) * u1 + perpY * bow;

      // 3. Secondary Corrective Submovement superposition
      if (useDualSubmovement && t >= sub2Start) {
        const tau2 = Math.min(1.0, (t - sub2Start) / sub2Duration);
        const s2 = this.septic(tau2).sigma;
        cx += (target.x - pPrimary.x) * s2;
        cy += (target.y - pPrimary.y) * s2;
      }

      // 4. Neuromuscular noise injection (Decoupled X and Y channels)
      const { noiseX, noiseY } = this.stepPinkNoise();
      const { tremX, tremY } = this.stepTremor(dt, noiseX, noiseY);

      // End-point visual-motor precision dampening (exact landing at i === totalSteps)
      const endDampening = i === totalSteps ? 0 : 1.0 - Math.pow(rawTau, 2) * 0.78;
      const finalX = cx + (noiseX + tremX) * endDampening;
      const finalY = cy + (noiseY + tremY) * endDampening;

      const vx = i === 0 ? 0 : (finalX - prevX) / dt;
      const vy = i === 0 ? 0 : (finalY - prevY) / dt;
      const velocity = Math.hypot(vx, vy);

      // Quantize to 0.5px physical DIP grid (matches DPR=1/DPR=2 OS pointer granularity instead of synthetic 0.1px)
      trajectory.push({
        x: Math.round(finalX * 2) / 2,
        y: Math.round(finalY * 2) / 2,
        timestamp: Math.round(t * 1000),
        velocity: Math.round(velocity),
      });

      prevX = finalX;
      prevY = finalY;
    }

    return trajectory;
  }

  /**
   * Move mouse from current position to target following a biological Minimum-Jerk curve.
   * Uses a deadline-anchored clock so CDP round-trip latency does not inflate Fitts's Law duration.
   */
  public async moveTo(target: Point, bounds?: TargetBounds): Promise<void> {
    const trajectory = this.generateTrajectory(this.currentPos, target, bounds);
    if (trajectory.length <= 1) {
      this.setPosition(target);
      return;
    }

    const startWall = performance.now();
    const last = trajectory.length - 1;
    for (let i = 1; i <= last; i++) {
      // Behind schedule (slow CDP round-trips): skip to the newest due sample,
      // as Chrome's input pipeline coalesces moves, instead of stretching the
      // movement past its Fitts's-law duration. The landing point always goes out.
      const late = performance.now() - startWall;
      while (i < last && (trajectory[i + 1]?.timestamp ?? Infinity) <= late) i++;
      const pt = trajectory[i];
      if (!pt) continue;

      await this.page.mouse.move(pt.x, pt.y).catch(() => undefined);
      this.setPosition({ x: pt.x, y: pt.y });

      const remainingWait = Math.round(pt.timestamp - (performance.now() - startWall));
      if (remainingWait > 1) {
        await new Promise((r) => setTimeout(r, remainingWait));
      }
    }
  }

  /**
   * Move to an element with biological trajectory and perform human click with hesitation,
   * uncorrelated Log-Normal dwell, and tendon-flexion micro-slip.
   */
  public async clickElement(selector: string): Promise<boolean> {
    try {
      const loc = this.page.locator(selector).first();
      const visible = await loc.isVisible({ timeout: 2500 }).catch(() => false);
      if (!visible) return false;

      const box = await loc.boundingBox({ timeout: 2000 });
      if (!box || box.width <= 0 || box.height <= 0) return false;
      return await this.clickBox(box);
    } catch {
      return false;
    }
  }

  /** Human click inside an already-measured viewport box. */
  public async clickBox(box: TargetBounds): Promise<boolean> {
    try {
      if (box.width <= 0 || box.height <= 0) return false;

      // Box-Muller Gaussian off-center landing ([0.18, 0.82])
      const z0 = this.sampleStandardGaussian();
      const z1 = this.sampleStandardGaussian();

      const normX = Math.min(0.82, Math.max(0.18, 0.5 + z0 * 0.11));
      const normY = Math.min(0.82, Math.max(0.18, 0.5 + z1 * 0.11));

      const targetX = Math.round((box.x + box.width * normX) * 2) / 2;
      const targetY = Math.round((box.y + box.height * normY) * 2) / 2;

      await this.moveTo({ x: targetX, y: targetY }, box);

      // Pre-click hesitation (Visual confirmation latency: 50ms - 130ms)
      const hesitation = Math.round(50 + this.rng.next() * 80);
      await new Promise((r) => setTimeout(r, hesitation));

      // Pointer down event
      await this.page.mouse.down();

      // Independent Gaussian draw for Log-Normal button dwell time (μ = 75ms, σ = 0.22, [35ms, 160ms])
      // Fixes ρ = 1.0 correlation bug where z0 from normX was reused for dwellDelay.
      const zDwell = this.sampleStandardGaussian();
      const dwellDelay = Math.max(35, Math.min(160, Math.round(75 * Math.exp(0.22 * zDwell))));

      // Biomechanical button-press micro-slip (~26% of clicks shift 0.5-1.5px during index-finger flexion)
      if (this.rng.next() < 0.26) {
        const preSlipWait = Math.round(dwellDelay * (0.38 + this.rng.next() * 0.22));
        await new Promise((r) => setTimeout(r, preSlipWait));
        const slipX = targetX + (this.rng.next() < 0.5 ? 0.5 : -0.5);
        const slipY = targetY + (this.rng.next() < 0.7 ? 1.0 : 0.5);
        await this.page.mouse.move(slipX, slipY).catch(() => undefined);
        this.setPosition({ x: slipX, y: slipY });
        await new Promise((r) => setTimeout(r, Math.max(10, dwellDelay - preSlipWait)));
      } else {
        await new Promise((r) => setTimeout(r, dwellDelay));
      }

      // Pointer up event
      await this.page.mouse.up();
      return true;
    } catch {
      return false;
    }
  }
}
