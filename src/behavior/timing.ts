/**
 * Session pacing.
 *
 * The simulator used to draw every delay from a uniform range. Uniform draws
 * give a flat histogram: a pause is exactly as likely to be 800 ms as 3400 ms.
 * Real inter-action gaps are heavy-tailed — mostly short, occasionally much
 * longer — so this module reshapes the same configured ranges into a
 * log-normal distribution and adds the two properties a sequence of
 * independent draws cannot have:
 *
 *   - **tempo**: a slowly random-walking multiplier, so consecutive pauses are
 *     correlated. A visitor who is skimming keeps skimming for a while.
 *   - **fatigue**: a gentle drift toward slower pacing as the session ages.
 *
 * Everything still flows through the session's seeded `Rng`, so a seed
 * reproduces a run exactly, as before.
 */
import type { BehaviorConfig, Range } from "../config.js";
import type { Rng } from "../util/random.js";

/** Where in the configured range the log-normal median sits. */
const MEDIAN_POSITION = 0.32;

/** Spread of the log-normal in log space. Larger = longer tail. */
const DEFAULT_SIGMA = 0.55;

/** Tempo is clamped to this band so the walk cannot run away. */
const TEMPO_MIN = 0.65;
const TEMPO_MAX = 1.6;

/** Average reading speed, in characters per minute (≈230 wpm at 5.5 chars/word). */
const CHARS_PER_MINUTE = 1265;

/** Standard normal deviate via Box–Muller. */
function standardNormal(rng: Rng): number {
  // rng.next() returns [0, 1); log(0) is -Infinity, so floor the first draw.
  const u1 = Math.max(rng.next(), Number.EPSILON);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Draw from a log-normal shaped to sit inside `range`.
 *
 * The median is placed low in the range so the long tail has somewhere to go
 * before it hits the ceiling; clamping still happens, but rarely enough that
 * it does not pile probability mass on `max`.
 */
export function heavyTailed(rng: Rng, range: Range, sigma = DEFAULT_SIGMA): number {
  const span = range.max - range.min;
  if (span <= 0) return range.min;
  const median = range.min + span * MEDIAN_POSITION;
  const value = median * Math.exp(sigma * standardNormal(rng));
  return Math.round(Math.min(range.max, Math.max(range.min, value)));
}

/**
 * Pacing state for one session.
 *
 * One instance per session; every delay the navigator waits for comes from
 * here so tempo and fatigue apply uniformly.
 */
export class Pacing {
  /** Current tempo multiplier; 1 is the configured baseline. */
  private tempo = 1;

  constructor(
    private readonly rng: Rng,
    private readonly behavior: BehaviorConfig,
    /** Returns session progress in 0..1, used for the fatigue drift. */
    private readonly progress: () => number = () => 0,
  ) {}

  /**
   * Advance the tempo random walk one step and return the current multiplier.
   *
   * The walk is multiplicative in log space so tempo cannot go negative, and
   * the step is small enough that a run of pauses stays visibly correlated
   * rather than resampling independently each time.
   */
  private nextTempo(): number {
    this.tempo *= Math.exp(0.18 * standardNormal(this.rng));
    this.tempo = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, this.tempo));

    // Fatigue: by the end of the budget a visitor is ~20% slower than at the
    // start. Applied on top of the walk rather than folded into it, so it is a
    // trend rather than something the walk can wander back out of.
    const fatigue = 1 + 0.2 * Math.min(1, Math.max(0, this.progress()));
    return this.tempo * fatigue;
  }

  /** A paced delay drawn from `range`, in ms. */
  private draw(range: Range, sigma?: number): number {
    return Math.round(heavyTailed(this.rng, range, sigma) * this.nextTempo());
  }

  /** Pause between two consecutive actions. */
  actionPause(): number {
    return this.draw(this.behavior.actionPause);
  }

  /** Settle time after arriving on a new page, before acting. */
  pageSettle(): number {
    return this.draw(this.behavior.pageSettle);
  }

  /** Pause between two steps of one scroll gesture. */
  scrollPause(): number {
    // Scroll steps within a single gesture are tighter than think-time between
    // actions, so the tail is shorter.
    return this.draw(this.behavior.scrollPause, 0.4);
  }

  /** Time spent looking at one gallery image. */
  mediaDwell(): number {
    return this.draw(this.behavior.mediaDwell);
  }

  /** Time spent on one section when its length is unknown. */
  sectionDwell(): number {
    return this.draw(this.behavior.sectionDwell);
  }

  /**
   * Time to read `characters` of text.
   *
   * Scaled to the actual content rather than drawn from a fixed range: a
   * two-line shipping note and a thousand-word ingredient list should not take
   * the same time. Visitors skim rather than read every word, so a per-draw
   * skim factor is applied, and the result is clamped to the configured dwell
   * range so a huge description cannot eat the whole session budget. Tempo and
   * fatigue then apply on top, exactly as they do to every other delay, so the
   * final value can exceed `sectionDwell.max` by that multiplier.
   */
  readingTime(characters: number): number {
    if (!Number.isFinite(characters) || characters <= 0) return this.sectionDwell();

    const skim = 0.25 + this.rng.next() * 0.35;
    const base = (characters / CHARS_PER_MINUTE) * 60_000 * skim;
    const { min, max } = this.behavior.sectionDwell;
    return Math.round(Math.min(max, Math.max(min, base)) * this.nextTempo());
  }

  /** Current tempo, for logging. */
  get currentTempo(): number {
    return Math.round(this.tempo * 100) / 100;
  }
}
