/**
 * Elastic pre-checkout choreography.
 *
 * A visit that ends in checkout leaves a recognisable trail in Shopify's
 * analytics (Trekkie / Monorail / Web Pixels): collection views, product
 * views, media and variant interaction, an add-to-cart, a cart view. The plan
 * below lays that trail out against the add-to-cart mark the operator set,
 * so a 1-minute and a 10-minute visit both read as one shopper deciding:
 *
 *   discovery     0–20% of the pre-ATC time: home → collection, hover cards
 *   compare       20% → deep start, only when the mark is ≥ 2 min away:
 *                 open product A, look at media and price, go Back, pick B
 *   deep PDP      last 45% before the mark (capped): gallery, details,
 *                 size/colour tried 15–40 s before the mark
 *   add to cart   at the mark, an in-stock variant from the product oracle
 *   inspect cart  5–12 s on the drawer or /cart, cart left intact
 */
import type { ChoreographyConfig } from "../config.js";
import { DEFAULT_CHOREOGRAPHY } from "../config.js";
import type { Rng } from "../util/random.js";

export type ChoreographyPhase =
  | "discovery"
  | "compare"
  | "deep_pdp"
  | "add_to_cart"
  | "inspect_cart"
  | "post_atc"
  | "checkout_ready"
  | "browse";

export interface ChoreographyPlan {
  /** A timed add-to-cart exists; without one the visit just browses. */
  enabled: boolean;
  targetAtcMs: number;
  discoveryEndMs: number;
  compareEnabled: boolean;
  /** Products to open and back out of before the one that gets bought. */
  compareTarget: number;
  /** How long product A gets before Back. */
  compareDwellMs: number;
  deepStartMs: number;
  deepPhaseMs: number;
  /** Variant exploration starts this long before the mark. */
  exploreLeadMs: number;
  /** Gallery images to flip through on the final product. */
  mediaTarget: number;
  /** Detail sections to open on the final product. */
  sectionTarget: number;
  /** Variant combinations to try before settling. */
  variantTarget: number;
  inspectCartMs: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function planChoreography(input: {
  targetAtcMs: number;
  rng: Rng;
  cfg?: Partial<ChoreographyConfig>;
}): ChoreographyPlan {
  const cfg = { ...DEFAULT_CHOREOGRAPHY, ...(input.cfg ?? {}) };
  const { rng } = input;
  const inspectCartMs = rng.int(cfg.inspectCartMs.min, cfg.inspectCartMs.max);
  const mediaTarget = rng.int(2, 5);
  const sectionTarget = rng.int(1, 2);
  const variantTarget = rng.int(1, 2);

  if (!Number.isFinite(input.targetAtcMs) || input.targetAtcMs >= Number.MAX_SAFE_INTEGER || input.targetAtcMs <= 0) {
    return {
      enabled: false,
      targetAtcMs: Number.MAX_SAFE_INTEGER,
      discoveryEndMs: Number.MAX_SAFE_INTEGER,
      compareEnabled: false,
      compareTarget: 0,
      compareDwellMs: 0,
      deepStartMs: Number.MAX_SAFE_INTEGER,
      deepPhaseMs: 0,
      exploreLeadMs: 0,
      mediaTarget,
      sectionTarget,
      variantTarget,
      inspectCartMs,
    };
  }

  const pre = input.targetAtcMs;
  const discoveryEndMs = Math.round(pre * 0.2);
  const deepPhaseMs = Math.round(Math.min(cfg.deepPhaseMaxMs, pre * 0.45));
  const deepStartMs = Math.max(discoveryEndMs, pre - deepPhaseMs);
  const compareWindow = deepStartMs - discoveryEndMs;
  const compareEnabled = pre >= cfg.compareMinAtcMs && compareWindow >= 15_000;
  const compareTarget = compareEnabled ? clamp(Math.floor(compareWindow / 45_000), 1, 3) : 0;
  const compareDwellMs = compareEnabled ? Math.round(clamp((compareWindow / compareTarget) * 0.45, 6_000, 25_000)) : 0;
  const leadDraw = rng.int(cfg.exploreVariantsLeadMs.min, cfg.exploreVariantsLeadMs.max);
  // A short deep phase cannot spend 40 s on variants; it keeps the order, not the length.
  const exploreLeadMs = Math.round(Math.min(leadDraw, Math.max(3_000, deepPhaseMs * 0.4)));

  return {
    enabled: true,
    targetAtcMs: pre,
    discoveryEndMs,
    compareEnabled,
    compareTarget,
    compareDwellMs,
    deepStartMs,
    deepPhaseMs,
    exploreLeadMs,
    mediaTarget,
    sectionTarget,
    variantTarget,
    inspectCartMs,
  };
}

/**
 * Deep-phase window for the second product of a two-item visit: it starts
 * once the first add is done, so it is scaled to the time actually left.
 */
export function secondProductWindow(
  plan: ChoreographyPlan,
  input: { targetAtcMs: number; startedAtMs: number; cfg?: Partial<ChoreographyConfig> },
): { deepStartMs: number; exploreLeadMs: number } {
  const cfg = { ...DEFAULT_CHOREOGRAPHY, ...(input.cfg ?? {}) };
  const span = Math.max(0, input.targetAtcMs - input.startedAtMs);
  const deep = Math.round(Math.min(cfg.deepPhaseMaxMs, span * 0.45));
  return {
    deepStartMs: input.targetAtcMs - deep,
    exploreLeadMs: Math.round(Math.min(plan.exploreLeadMs || cfg.exploreVariantsLeadMs.min, Math.max(3_000, deep * 0.4))),
  };
}
