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
// legacy engine removed
import type { Profile, ProfileIdentity, ProfileDevice } from "../profiles/types.js";
import { Rng } from "../util/random.js";

/**
 * Device emulation catalog.
 *
 * Each entry is a self-consistent mobile/tablet profile: the viewport, DPR,
 * navigator.platform, UA-CH platform + mobile flag, and a User-Agent template
 * ({MAJOR} is filled with the resolved Chrome major for Android). iOS entries
 * carry a fixed Safari UA (Safari version is not the Chrome major).
 *
 * Consistency is the whole point: a UA that says iPhone while the viewport is
 * 1440px, sec-ch-ua-mobile is ?0, and maxTouchPoints is 0 is a louder bot tell
 * than plain desktop. Every field here moves together.
 */
export interface DeviceSpec {
  kind: ProfileDevice["kind"];
  model: string;
  viewport: { width: number; height: number };
  dpr: number;
  /** navigator.platform value. */
  platform: string;
  /** UA-CH platform ("Android" | "iOS" — desktop uses "Windows" elsewhere). */
  uaPlatform: string;
  /** Fixed touch points (mobile > 0). */
  maxTouchPoints: number;
  /** true for Chromium-based (Android Chrome); iOS Safari is false. */
  chromium: boolean;
  /** UA template; {MAJOR} replaced with the Chrome major for Android. */
  ua: string;
  /** Device RAM reported via navigator.deviceMemory; null = not reported (iOS). */
  deviceMemory: number | null;
}

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = (device: string): string =>
  `Mozilla/5.0 (Linux; Android 14; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{MAJOR}.0.0.0 Mobile Safari/537.36`;

/** Every emulatable device, keyed by kind for the dashboard picker. */
export const DEVICE_CATALOG: Record<ProfileDevice["kind"], DeviceSpec[]> = {
  desktop: [],
  android: [
    { kind: "android", model: "Pixel 7", viewport: { width: 412, height: 915 }, dpr: 2.625, platform: "Linux armv8l", uaPlatform: "Android", maxTouchPoints: 5, chromium: true, ua: ANDROID_UA("Pixel 7"), deviceMemory: 8 },
    { kind: "android", model: "Pixel 8", viewport: { width: 412, height: 892 }, dpr: 2.625, platform: "Linux armv8l", uaPlatform: "Android", maxTouchPoints: 5, chromium: true, ua: ANDROID_UA("Pixel 8"), deviceMemory: 8 },
    { kind: "android", model: "Galaxy S23", viewport: { width: 360, height: 780 }, dpr: 3, platform: "Linux armv8l", uaPlatform: "Android", maxTouchPoints: 5, chromium: true, ua: ANDROID_UA("SM-S911B"), deviceMemory: 8 },
  ],
  iphone: [
    { kind: "iphone", model: "iPhone 14 Pro", viewport: { width: 393, height: 852 }, dpr: 3, platform: "iPhone", uaPlatform: "iOS", maxTouchPoints: 5, chromium: false, ua: IOS_UA, deviceMemory: null },
    { kind: "iphone", model: "iPhone 15 Pro Max", viewport: { width: 430, height: 932 }, dpr: 3, platform: "iPhone", uaPlatform: "iOS", maxTouchPoints: 5, chromium: false, ua: IOS_UA, deviceMemory: null },
    { kind: "iphone", model: "iPhone 12", viewport: { width: 390, height: 844 }, dpr: 3, platform: "iPhone", uaPlatform: "iOS", maxTouchPoints: 5, chromium: false, ua: IOS_UA, deviceMemory: null },
  ],
  ipad: [
    { kind: "ipad", model: "iPad Pro 11", viewport: { width: 834, height: 1194 }, dpr: 2, platform: "iPad", uaPlatform: "iOS", maxTouchPoints: 5, chromium: false, ua: IPAD_UA, deviceMemory: null },
    { kind: "ipad", model: "iPad Air", viewport: { width: 820, height: 1180 }, dpr: 2, platform: "iPad", uaPlatform: "iOS", maxTouchPoints: 5, chromium: false, ua: IPAD_UA, deviceMemory: null },
  ],
};

/** Look up a device spec; returns undefined for desktop or unknown model. */
export function resolveDevice(device: ProfileDevice | undefined): DeviceSpec | undefined {
  if (!device || device.kind === "desktop") return undefined;
  const list = DEVICE_CATALOG[device.kind] ?? [];
  return list.find((d) => d.model === device.model) ?? list[0];
}

/** A resolved identity, ready to hand to the browser launcher. */
export interface ResolvedIdentity {
  viewport: { width: number; height: number };
  timezone?: string;
  locale?: string;
  colorScheme: "light" | "dark" | "no-preference";
  /** Present only when a mobile/tablet device is emulated. */
  device?: DeviceSpec;
}

/**
 * Resolve a profile's identity.
 *
 * `timezone`/`locale` are only filled in when explicitly configured — when a
 * proxy is in play they are better left to geoip mode, which
 * derives them from the exit IP so the two cannot contradict each other.
 *
 * A device emulation, when set, WINS the viewport (a phone is 393px wide, not
 * 1440) and carries the rest of the mobile fingerprint downstream.
 */
export function resolveIdentity(identity: ProfileIdentity, device?: ProfileDevice): ResolvedIdentity {
  const rng = new Rng(identity.seed);

  // A small, stable preference drawn from the same seed. Roughly one visitor
  // in four browses in dark mode.
  const colorScheme: ResolvedIdentity["colorScheme"] = rng.chance(0.25) ? "dark" : "light";
  const spec = resolveDevice(device);

  return {
    viewport: spec ? spec.viewport : identity.viewport,
    ...(identity.timezone ? { timezone: identity.timezone } : {}),
    ...(identity.locale ? { locale: identity.locale } : {}),
    colorScheme: identity.colorScheme ?? colorScheme,
    ...(spec ? { device: spec } : {}),
  };
}

/**
 * Per-profile overrides for the human-behaviour layer.
 *
 * The layer's own defaults are good; what they lack is variation *between*
 * profiles. Two profiles running side by side with byte-identical mouse
 * physics are more alike than two real visitors would be, so each profile
 * gets its own stable jitter around the preset — a slightly different hand.
 */
export function humanConfigFor(identity: ProfileIdentity): Partial<any> {
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
