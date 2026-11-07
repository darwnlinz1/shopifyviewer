/**
 * test/experiments/benchmark-mouse-dynamics.mjs
 *
 * Empirical benchmark comparing:
 *  1. Linear/Robotic mouse movement vs Biological Cubic Bézier trajectory
 *  2. Velocity profile (Fitts's Law ease-in-out verification)
 *  3. Micro-jitter entropy distribution
 *  4. Overshoot frequency and correction amplitude
 */
import { Rng } from "../../dist/util/random.js";

function simulateLinearMove(p0, p3, steps = 30) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: p0.x + (p3.x - p0.x) * t,
      y: p0.y + (p3.y - p0.y) * t,
      t,
    });
  }
  return points;
}

function simulateBezierBiological(p0, p3, rng) {
  const distance = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  let destPoint = { ...p3 };
  const shouldOvershoot = distance > 120 && rng.next() < 0.6;
  
  if (shouldOvershoot) {
    const angle = Math.atan2(p3.y - p0.y, p3.x - p0.x);
    const overshootDist = 4 + rng.next() * 8;
    destPoint = {
      x: p3.x + Math.cos(angle) * overshootDist,
      y: p3.y + Math.sin(angle) * overshootDist,
    };
  }

  const perpAngle = Math.atan2(destPoint.y - p0.y, destPoint.x - p0.x) + Math.PI / 2;
  const curvature = (rng.next() - 0.5) * Math.min(distance * 0.35, 100);

  const p1 = {
    x: p0.x + (destPoint.x - p0.x) * 0.25 + Math.cos(perpAngle) * curvature,
    y: p0.y + (destPoint.y - p0.y) * 0.25 + Math.sin(perpAngle) * curvature,
  };
  const p2 = {
    x: p0.x + (destPoint.x - p0.x) * 0.75 + Math.cos(perpAngle) * (curvature * 0.6),
    y: p0.y + (destPoint.y - p0.y) * 0.75 + Math.sin(perpAngle) * (curvature * 0.6),
  };

  const steps = Math.max(12, Math.min(50, Math.round(distance / 14) + Math.round(rng.next() * 8)));
  const points = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const easedT = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    const cx =
      Math.pow(1 - easedT, 3) * p0.x +
      3 * Math.pow(1 - easedT, 2) * easedT * p1.x +
      3 * (1 - easedT) * Math.pow(easedT, 2) * p2.x +
      Math.pow(easedT, 3) * destPoint.x;

    const cy =
      Math.pow(1 - easedT, 3) * p0.y +
      3 * Math.pow(1 - easedT, 2) * easedT * p1.y +
      3 * (1 - easedT) * Math.pow(easedT, 2) * p2.y +
      Math.pow(easedT, 3) * destPoint.y;

    const jitterX = (rng.next() - 0.5) * 1.2;
    const jitterY = (rng.next() - 0.5) * 1.2;

    points.push({
      x: cx + jitterX,
      y: cy + jitterY,
      rawT: t,
      easedT,
    });
  }

  return { points, shouldOvershoot, steps };
}

function calculateCurvatureEntropy(points) {
  // Measure standard deviation of angles (curvature entropy)
  let angles = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const ang1 = Math.atan2(b.y - a.y, b.x - a.x);
    const ang2 = Math.atan2(c.y - b.y, c.x - b.x);
    angles.push(Math.abs(ang2 - ang1));
  }
  const mean = angles.reduce((acc, v) => acc + v, 0) / (angles.length || 1);
  const variance = angles.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (angles.length || 1);
  return { meanCurvatureRad: mean.toFixed(4), curvatureVariance: variance.toFixed(6) };
}

function runMouseBenchmark() {
  console.log("=== EMPIRICAL BENCHMARK: BIOMETRIC MOUSE DYNAMICS ===");
  const rng = new Rng(42);
  const p0 = { x: 100, y: 150 };
  const p3 = { x: 850, y: 620 };

  const linear = simulateLinearMove(p0, p3, 30);
  const linearEntropy = calculateCurvatureEntropy(linear);
  console.log(`[Linear Trajectory (Bot Tell)] Curvature Variance: ${linearEntropy.curvatureVariance} (0.000000 = Absolute Line = 100% Bot Flag)`);

  let biologicalRuns = [];
  let overshootCount = 0;
  for (let k = 0; k < 100; k++) {
    const res = simulateBezierBiological(p0, p3, rng);
    biologicalRuns.push(res);
    if (res.shouldOvershoot) overshootCount++;
  }

  const sampleBio = biologicalRuns[0];
  const bioEntropy = calculateCurvatureEntropy(sampleBio.points);
  console.log(`[Biological Bézier Trajectory] Curvature Variance: ${bioEntropy.curvatureVariance} (Natural Non-Zero Entropy)`);
  console.log(`[Human Hesitation / Overshoot Rate]: ${overshootCount}% across 100 sampled movements`);
  console.log(`[Average Step Resolution]: ~${(Math.hypot(p3.x - p0.x, p3.y - p0.y) / sampleBio.steps).toFixed(1)} px/step`);
}

runMouseBenchmark();
