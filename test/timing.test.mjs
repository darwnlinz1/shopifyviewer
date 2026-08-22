/**
 * Pacing tests.
 *
 * These assert the *shape* of the delay distribution, which is the thing that
 * changed: uniform draws gave a flat histogram, and human inter-action gaps
 * are heavy-tailed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pacing, heavyTailed } from "../dist/behavior/timing.js";
import { Rng } from "../dist/util/random.js";

const BEHAVIOR = {
  actionPause: { min: 2000, max: 3000 },
  pageSettle: { min: 1200, max: 4000 },
  scrollPause: { min: 400, max: 2200 },
  scrollFraction: { min: 0.25, max: 0.9 },
  scrollSteps: { min: 2, max: 6 },
  mediaDwell: { min: 900, max: 3200 },
  sectionDwell: { min: 1500, max: 5000 },
  targetProducts: { min: 4, max: 9 },
  backProbability: 0.28,
  returnToCollectionProbability: 0.35,
  idleProbability: 0.18,
  maxActionsPerPage: 9,
  speedFactor: 1,
};

function sample(count, fn) {
  return Array.from({ length: count }, fn);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test("stays inside the configured range", () => {
  const rng = new Rng(1234);
  const range = { min: 800, max: 3500 };
  for (const value of sample(2000, () => heavyTailed(rng, range))) {
    assert.ok(value >= range.min && value <= range.max, `${value} outside range`);
  }
});

test("is right-skewed, not uniform", () => {
  const rng = new Rng(99);
  const range = { min: 800, max: 3500 };
  const values = sample(4000, () => heavyTailed(rng, range));

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const mid = median(values);

  // The defining property of a right-skewed distribution: the tail drags the
  // mean above the median. A uniform distribution has them equal.
  assert.ok(mean > mid, `expected mean ${mean} > median ${mid}`);

  // And the median must sit well below the midpoint of the range, which is
  // where a uniform distribution would put it.
  assert.ok(mid < (range.min + range.max) / 2, `median ${mid} not below midpoint`);
});

test("produces occasional long pauses", () => {
  const rng = new Rng(7);
  const range = { min: 800, max: 3500 };
  const values = sample(3000, () => heavyTailed(rng, range));
  // A heavy tail means some draws land near the top of the range; a flat
  // distribution would too, so the point is that most do not.
  const long = values.filter((v) => v > 2600).length / values.length;
  const short = values.filter((v) => v < 1500).length / values.length;
  assert.ok(long > 0.01, `expected some long pauses, got ${long}`);
  assert.ok(short > 0.4, `expected mostly short pauses, got ${short}`);
});

test("the same seed replays the same pacing", () => {
  const run = () => {
    const pacing = new Pacing(new Rng(4242), BEHAVIOR, () => 0);
    return sample(50, () => pacing.actionPause());
  };
  assert.deepEqual(run(), run());
});

test("consecutive delays are correlated, not independent", () => {
  // Tempo random-walks, so a run of pauses drifts together. Independent draws
  // would show no relationship between one pause and the next.
  const pacing = new Pacing(new Rng(21), BEHAVIOR, () => 0);
  const values = sample(4000, () => pacing.actionPause());

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < values.length - 1; i++) {
    covariance += (values[i] - mean) * (values[i + 1] - mean);
    variance += (values[i] - mean) ** 2;
  }
  const lag1 = covariance / variance;
  assert.ok(lag1 > 0.02, `expected positive lag-1 autocorrelation, got ${lag1}`);
});

test("fatigue slows the session down over its lifetime", () => {
  let progress = 0;
  const pacing = new Pacing(new Rng(5), BEHAVIOR, () => progress);

  const early = sample(400, () => pacing.actionPause());
  progress = 1;
  const late = sample(400, () => pacing.actionPause());

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(late) > mean(early), `late ${mean(late)} should exceed early ${mean(early)}`);
});

test("reading time scales with how much text there is", () => {
  const pacing = new Pacing(new Rng(11), BEHAVIOR, () => 0);
  const shortText = mean(sample(300, () => pacing.readingTime(120)));
  const longText = mean(sample(300, () => pacing.readingTime(4000)));
  assert.ok(longText > shortText, `${longText} should exceed ${shortText}`);

  function mean(xs) {
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }
});

test("reading time is bounded by the configured dwell range", () => {
  const pacing = new Pacing(new Rng(13), BEHAVIOR, () => 0);
  // A huge description must not be allowed to consume the whole budget. The
  // clamp is to sectionDwell.max; tempo and fatigue then scale it like any
  // other delay, so the ceiling is that maximum times the tempo band.
  const ceiling = BEHAVIOR.sectionDwell.max * 1.6 * 1.2;
  for (const value of sample(500, () => pacing.readingTime(500_000))) {
    assert.ok(value <= ceiling, `${value} exceeded ${ceiling}`);
  }
});

test("falls back to the dwell range for unmeasurable text", () => {
  const pacing = new Pacing(new Rng(3), BEHAVIOR, () => 0);
  for (const characters of [0, -5, Number.NaN]) {
    const value = pacing.readingTime(characters);
    assert.ok(value >= BEHAVIOR.sectionDwell.min * 0.6, `${value} too small`);
  }
});

test("the gap between actions stays inside its configured band", () => {
  // Unlike the dwells, this one is a hard band: it is the rhythm the operator
  // sets and watches, so "2 to 3 seconds" has to mean that. Tempo and fatigue
  // still vary it — inside the band, not out of it.
  const pacing = new Pacing(new Rng(7), BEHAVIOR, () => 0.5);
  const values = sample(3000, () => pacing.actionPause());

  for (const value of values) {
    assert.ok(
      value >= BEHAVIOR.actionPause.min && value <= BEHAVIOR.actionPause.max,
      `${value} escaped the ${BEHAVIOR.actionPause.min}-${BEHAVIOR.actionPause.max}ms band`,
    );
  }

  // Still varied inside it, rather than pinned to one end.
  const distinct = new Set(values).size;
  assert.ok(distinct > 500, `only ${distinct} distinct gaps — not random enough`);
});

test("speedFactor scales every delay", () => {
  const brisk = new Pacing(new Rng(7), { ...BEHAVIOR, speedFactor: 2 }, () => 0.5);
  const values = sample(500, () => brisk.actionPause());
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  // Twice as brisk: the same band, halved.
  assert.ok(mean > 900 && mean < 1600, `expected ~1250ms at pace 2, got ${Math.round(mean)}`);
  for (const value of values) {
    assert.ok(value <= BEHAVIOR.actionPause.max / 2 + 1, `${value} above the halved ceiling`);
  }
});

test("a nonsensical speedFactor cannot stall the session", () => {
  // A zero or negative factor would divide the delay to infinity.
  for (const factor of [0, -3, Number.NaN]) {
    const pacing = new Pacing(new Rng(1), { ...BEHAVIOR, speedFactor: factor }, () => 0);
    const value = pacing.actionPause();
    assert.ok(Number.isFinite(value) && value > 0 && value <= BEHAVIOR.actionPause.max, `${factor} → ${value}`);
  }
});
