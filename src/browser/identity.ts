/**
 * Per-profile browser identity.
 *
 * A persistent profile keeps its cookies between runs, so it presents itself
 * to the storefront as a returning visitor. That only holds together if the
 * rest of the identity is stable too: a returning visitor does not change
 * screen resolution, timezone and colour scheme between visits.
 *
 * Everything here is therefore derived deterministically from the profile's
 * pinned `identity.seed`, fixed once at creation, rather than re-drawn per
 * launch from the session RNG.
 */
import type { HumanConfig } from "cloakbrowser/human";
import type { Profile, ProfileIdentity } from "../profiles/types.js";
import { Rng } from "../util/random.js";

/** A resolved identity, ready to hand to the browser launcher. */
export interface ResolvedIdentity {
  viewport: { width: number; height: number };
  timezone?: string;
  locale?: string;
  colorScheme: "light" | "dark" | "no-preference";
}

/**
 * Resolve a profile's identity.
 *
 * `timezone`/`locale` are only filled in when explicitly configured — when a
 * proxy is in play they are better left to CloakBrowser's `geoip`, which
 * derives them from the exit IP so the two cannot contradict each other.
 */
export function resolveIdentity(identity: ProfileIdentity): ResolvedIdentity {
  const rng = new Rng(identity.seed);

  // A small, stable preference drawn from the same seed. Roughly one visitor
  // in four browses in dark mode.
  const colorScheme: ResolvedIdentity["colorScheme"] = rng.chance(0.25) ? "dark" : "light";

  return {
    viewport: identity.viewport,
    ...(identity.timezone ? { timezone: identity.timezone } : {}),
    ...(identity.locale ? { locale: identity.locale } : {}),
    colorScheme: identity.colorScheme ?? colorScheme,
  };
}

/**
 * Per-profile overrides for CloakBrowser's human-behaviour layer.
 *
 * The layer's own defaults are good; what they lack is variation *between*
 * profiles. Two profiles running side by side with byte-identical mouse
 * physics are more alike than two real visitors would be, so each profile
 * gets its own stable jitter around the preset — a slightly different hand.
 */
export function humanConfigFor(identity: ProfileIdentity): Partial<HumanConfig> {
  const rng = new Rng(identity.seed ^ 0x5f3a71c9);

  /** Scale a [min, max] tuple by a factor, keeping it ordered. */
  const scale = (range: [number, number], factor: number): [number, number] => [
    Math.round(range[0] * factor),
    Math.round(range[1] * factor),
  ];

  // One "hand speed" per profile: a consistently brisk or unhurried operator.
  const hand = rng.float(0.8, 1.3);

  return {
    // Curve resolution and wobble: how straight this profile's mouse paths are.
    mouse_wobble_max: Math.round(rng.float(2, 6)),
    mouse_overshoot_chance: Number(rng.float(0.15, 0.4).toFixed(2)),
    mouse_max_steps: Math.round(rng.float(20, 34)),

    // Scroll physics.
    scroll_delta_base: scale([90, 140], hand),
    scroll_overshoot_chance: Number(rng.float(0.1, 0.35).toFixed(2)),
    scroll_pause_fast: scale([40, 90], 1 / hand),
    scroll_pause_slow: scale([120, 260], 1 / hand),
    scroll_settle_delay: scale([180, 420], 1 / hand),

    // Idle drift: the cursor should not be perfectly motionless while the
    // visitor reads.
    idle_drift_px: Math.round(rng.float(3, 9)),
    idle_pause_range: scale([300, 1200], 1 / hand),
    idle_between_actions: true,
    idle_between_duration: scale([200, 900], 1 / hand),
  };
}

/** Human-readable identity summary for logs and the dashboard. */
export function describeIdentity(profile: Profile): string {
  const { viewport, timezone, locale } = profile.identity;
  const parts = [`${viewport.width}x${viewport.height}`];
  if (timezone) parts.push(timezone);
  if (locale) parts.push(locale);
  return parts.join(" · ");
}
