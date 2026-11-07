/**
 * Decision execution — turns an engine decision into page input.
 *
 * Navigation clicks a real, visible link whenever the page has one (the
 * browser then sends a genuine Referer and the theme's own routing runs);
 * page.goto is only the fallback for targets the page does not link to.
 * Choreography steps are in behavior/pdpChoreography.ts, add-to-cart in
 * session/atcVerifier.ts.
 */
import type { Page } from "rebrowser-playwright";
import type { ChoreographyConfig } from "../config.js";
import { DEFAULT_CHOREOGRAPHY } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Rng } from "../util/random.js";
import { sleep } from "../util/random.js";
import type { Pacing } from "../behavior/timing.js";
import type { AiDecision, NavigationMetrics } from "../types.js";
import { HumanCursor } from "../behavior/humanCursor.js";
import { wheelBy, seatCursor } from "../navigator/wheel.js";
import { viewportOf } from "../browser/viewport.js";
import { evaluateIsolated } from "../navigator/isolate.js";
import type { DetectionTier, DetectionWaterfall } from "../ai/detectionWaterfall.js";
import { clickTarget, findAnchors, findTargets, findVisibleShopLinkInPage, type Target } from "../behavior/humanActions.js";
import {
  exploreVariants,
  hoverProductCards,
  inspectCart,
  readSection,
  selectText,
  viewMedia,
  type ChoreoContext,
} from "../behavior/pdpChoreography.js";
import { executeAddToCart } from "./atcVerifier.js";

export interface ExecContext {
  page: Page;
  logger: Logger;
  rng: Rng;
  pacing: Pacing;
  choreography?: ChoreographyConfig;
  waterfall?: DetectionWaterfall | null;
  /** Variant ids already tried on the current product page. */
  triedVariants?: Set<string>;
}

export interface ExecOutcome {
  navigated: boolean;
  failed: boolean;
  metrics: NavigationMetrics | null;
  /** True only when an add-to-cart was CONFIRMED (network/drawer/cart/count),
   * not merely clicked. Distinguishes "đã thêm giỏ" from "đã click chưa xác nhận". */
  atcVerified?: boolean;
  atcTier?: DetectionTier;
  /** Choreography sub-actions performed; 0 = nothing to act on here. */
  performed?: number;
  detail?: string;
  variantId?: string | null;
  /** The navigation came from clicking a link on the page (Referer kept). */
  clickThrough?: boolean;
}

const navMetrics = (url: string, started: number): NavigationMetrics => ({
  url,
  status: null,
  elapsedMs: Date.now() - started,
  ttfbMs: null,
  domContentLoadedMs: null,
  loadEventMs: null,
  firstContentfulPaintMs: null,
  jsErrors: 0,
  consoleErrors: 0,
  failedRequests: 0,
});

// ── Human-like mouse simulation ──
// A cubic Bézier path with per-step wobble and an occasional overshoot, rather
// than a straight linear interpolation — real cursors curve, jitter, and
// slightly overshoot a target before settling.
async function humanMouse(page: Page, rng: Rng): Promise<void> {
  try {
    const vp = viewportOf(page);
    const cursor = new HumanCursor(page, rng);
    await cursor.moveTo({ x: Math.round(vp.width * rng.float(0.15, 0.85)), y: Math.round(vp.height * rng.float(0.15, 0.8)) });
  } catch {}
}

// Hover near an element before clicking using biological Minimum-Jerk trajectory
async function hoverBeforeClick(page: Page, selector: string | undefined, rng: Rng): Promise<void> {
  if (!selector) { await humanMouse(page, rng); return; }
  try {
    const loc = page.locator(selector).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Bounded: a link detached by a navigation would otherwise be waited for 30s.
      const box = await loc.boundingBox({ timeout: 2000 }).catch(() => null);
      if (box) {
        const cursor = new HumanCursor(page, rng);
        const targetX = box.x + box.width * rng.float(0.3, 0.7);
        const targetY = box.y + box.height * rng.float(0.3, 0.7);
        await cursor.moveTo({ x: targetX, y: targetY }, box);
        await sleep(rng.int(120, 300));
        return;
      }
    }
  } catch {}
  await humanMouse(page, rng);
}

/**
 * Navigate, tolerating engines that never emit CDP lifecycle events.
 *
 * Some engines never answer `domcontentloaded` on schedule,
 * so every goto "times out" even though the document is fully there. On a
 * timeout, confirm reality directly — a non-empty title on a real URL means
 * the page arrived; only then report failure honestly.
 */
export async function smartNav(
  page: Page,
  url: string,
  timeoutMs: number,
  waitUntil: "domcontentloaded" = "domcontentloaded",
): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil, timeout: timeoutMs });
    return true;
  } catch {
    await sleep(2500);
    const title = await page.title().catch(() => "");
    const current = page.url();
    if (title && !current.startsWith("about:") && !/just a moment|checking your browser/i.test(title)) {
      return true;
    }
    return false;
  }
}

const productTail = (p: string): string => {
  const i = p.indexOf("/products/");
  return i >= 0 ? p.slice(i) : p;
};

/**
 * Click-through navigation: find a visible link to `targetUrl`, wheel it into
 * view, optionally eye a card or two first, and click it with HumanCursor so
 * the browser carries a real Referer and the theme's routing runs. Returns
 * ok=false to let the caller fall back to direct navigation.
 */
export async function clickThroughLink(
  page: Page,
  targetUrl: string,
  rng: Rng,
  logger: Logger,
  opts: { hoverCards?: boolean; cardSelector?: string | null; choreo?: ChoreographyConfig; pacing?: Pacing } = {},
): Promise<{ ok: boolean; hovered: number }> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl, page.url());
  } catch {
    return { ok: false, hovered: 0 };
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const isProduct = pathname.includes("/products/");
  const tail = isProduct ? productTail(pathname) : pathname;
  const q = (s: string): string => s.replace(/["\\]/g, "\\$&");
  const selectors = pathname === "/"
    ? ['header a[href="/"]', 'a[href="/"]', `a[href="${q(parsed.origin)}/"]`, `a[href="${q(parsed.origin)}"]`]
    : [`a[href$="${q(tail)}"]`, `a[href*="${q(tail)}?"]`, `a[href*="${q(tail)}#"]`, `a[href$="${q(tail)}/"]`];
  const skip = isProduct
    ? 'header, footer, nav, [role="navigation"], [role="dialog"]'
    : '[role="dialog"]';
  const sameTarget = (t: Target): boolean => {
    const p = t.href.replace(/\/+$/, "") || "/";
    return pathname === "/" ? p === "/" : isProduct ? productTail(p) === tail : p === pathname;
  };
  let matches = (pathname === "/" ? [] : await findAnchors(page, { pathname: isProduct ? tail : pathname, product: isProduct })).filter(sameTarget);
  if (!matches.length) matches = (await findTargets(page, { selectors, skip, max: 12 })).filter(sameTarget);
  if (!matches.length && pathname !== "/") {
    // A virtualized grid only mounts the cards in view. One screen down, then look again.
    await wheelBy(page, rng, Math.round(viewportOf(page).height * 0.7));
    await sleep(rng.int(180, 360));
    matches = (await findAnchors(page, { pathname: isProduct ? tail : pathname, product: isProduct })).filter(sameTarget);
  }
  let substitute = false;
  if (!matches.length && (isProduct || pathname.includes("/collections/"))) {
    const alt = await evaluateIsolated(page, findVisibleShopLinkInPage, { kind: isProduct ? "product" : "collection" });
    if (alt) {
      matches = [alt];
      substitute = true;
    }
  }
  if (!matches.length) return { ok: false, hovered: 0 };

  const vp = viewportOf(page);
  const rank = (t: Target): number =>
    (t.y > vp.height * 0.05 && t.y + t.h < vp.height * 0.9 ? 2 : 0) + (t.w * t.h > 4_000 ? 1 : 0);
  const target = [...matches].sort((a, b) => rank(b) - rank(a))[0]!;

  let hovered = 0;
  if (opts.hoverCards && isProduct && opts.choreo && opts.pacing && rng.chance(0.6)) {
    const res = await hoverProductCards(
      { page, rng, logger, pacing: opts.pacing, cfg: opts.choreo, deadline: Date.now() + 4_500 },
      { count: rng.int(1, 2), cardSelector: opts.cardSelector ?? null },
    );
    hovered = res.performed;
  }

  const prevUrl = page.url();
  if (!(await clickTarget(page, rng, target))) return { ok: false, hovered };
  const until = Date.now() + 9_000;
  while (Date.now() < until && page.url() === prevUrl) await sleep(150);
  await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
  await sleep(rng.int(250, 600));
  let landed = "";
  try {
    landed = new URL(page.url()).pathname.replace(/\/+$/, "") || "/";
  } catch { /* keep empty */ }
  const exact = pathname === "/" ? landed === "/" : isProduct ? productTail(landed) === tail : landed === pathname;
  const altOk = substitute && (isProduct ? landed.includes("/products/") : landed.includes("/collections/"));
  if (exact || altOk) logger.info("click_through_nav", exact ? `Clicked link to ${pathname} (Referer preserved)` : `Clicked a visible card (${landed}) instead of ${pathname}`);
  return { ok: exact || altOk, hovered };
}

/** Scroll direction state, kept in the isolated world so the page never sees it. */
function scrollStateInPage(): { vh: number; scrollY: number; scrollHeight: number; phase: "down" | "up" } {
  const w = window as unknown as { __svScrollPhase?: "down" | "up" };
  if (!w.__svScrollPhase) w.__svScrollPhase = "down";
  const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  const vh = window.innerHeight;
  const scrollHeight = Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0, vh);
  // Near the bottom (< 150px left) → turn back up; near the top again → down.
  if (w.__svScrollPhase === "down" && scrollY + vh >= scrollHeight - 150) w.__svScrollPhase = "up";
  else if (w.__svScrollPhase === "up" && scrollY <= 100) w.__svScrollPhase = "down";
  return { vh, scrollY, scrollHeight, phase: w.__svScrollPhase };
}

export async function executeDecision(decision: AiDecision, ctx: ExecContext): Promise<ExecOutcome> {
  const { page, logger, rng, pacing } = ctx;
  const noNav: ExecOutcome = { navigated: false, failed: false, metrics: null };
  const choreo = { ...DEFAULT_CHOREOGRAPHY, ...(ctx.choreography ?? {}) };
  const scan = ctx.waterfall?.lastScan(page.url())?.scan ?? null;
  const recipe = ctx.waterfall?.recipes.get(page.url());
  const stepCtx = (defaultMs: number): ChoreoContext => ({
    page,
    rng,
    logger,
    pacing,
    cfg: choreo,
    deadline: Date.now() + (decision.maxMs ?? defaultMs),
  });

  try {
    switch (decision.action) {
      // ── Navigation (Click-Through first to preserve Referer, fallback to smartNav) ──
      case "goto_home":
      case "goto_collection":
      case "goto_product": {
        const url = decision.url || decision.targetElement?.url;
        if (!url) return noNav;
        const started = Date.now();
        try {
          const fromListing = !page.url().includes("/products/");
          const ct = await clickThroughLink(page, url, rng, logger, {
            hoverCards: fromListing,
            cardSelector: recipe?.productCard ?? scan?.productCards.selector ?? null,
            choreo,
            pacing,
          });
          if (!ct.ok) logger.info("click_through_miss", `no clickable link to ${url}, direct navigation`);
          const ok = ct.ok ? true : await smartNav(page, url, 45_000);
          return {
            navigated: true,
            failed: !ok,
            metrics: navMetrics(page.url() || url, started),
            clickThrough: ct.ok,
            ...(ct.hovered ? { performed: ct.hovered, detail: `hovered ${ct.hovered} card(s) before clicking` } : {}),
          };
        } catch {
          return { navigated: true, failed: true, metrics: navMetrics(url, started) };
        }
      }

      // ── Back (browser history; compare flow returns to the listing) ──
      case "go_back": {
        const prev = page.url();
        const started = Date.now();
        await page.goBack({ timeout: 15_000, waitUntil: "domcontentloaded" }).catch(() => null);
        let navigated = page.url() !== prev;
        if (!navigated && decision.url && decision.url !== prev) navigated = await smartNav(page, decision.url, 30_000);
        return navigated ? { navigated: true, failed: false, metrics: navMetrics(page.url(), started) } : noNav;
      }

      // ── Click element (links, buttons, popups, etc.) ──
      // Prioritize real DOM element clicks; direct URL navigation is fallback only
      case "click_element": {
        const targetEl = decision.targetElement;
        if (!targetEl) return noNav;
        const targetUrl = targetEl.url;
        const sel = targetEl.selector || "";
        await hoverBeforeClick(page, sel || undefined, rng);

        // STRATEGY 1: Try CSS selector from AI (with biological trajectory + micro-slip click)
        if (sel && !sel.startsWith("text=")) {
          try {
            const loc = page.locator(sel).first();
            const vis = await loc.isVisible({ timeout: 2000 }).catch(() => false);
            if (vis) {
              await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await sleep(rng.int(120, 320));
              const navStart = Date.now();
              const prevUrl = page.url();
              const cursor = new HumanCursor(page, rng);
              const bioClicked = await cursor.clickElement(sel);
              if (!bioClicked) await loc.click({ timeout: 5000 }).catch(() => {});
              await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
              logger.debug("click_selector_ok", "clicked: " + sel);
              if (page.url() !== prevUrl) return { navigated: true, failed: false, metrics: navMetrics(page.url(), navStart) };
              return noNav;
            }
          } catch {}
        }

        // STRATEGY 2: Try text-based matching
        if (targetEl.text) {
          try {
            const textLoc = page.getByText(targetEl.text, { exact: false }).first();
            const visT = await textLoc.isVisible({ timeout: 2000 }).catch(() => false);
            if (visT) {
              await textLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await sleep(rng.int(150, 400));
              const navStart = Date.now();
              const prevUrl = page.url();
              await textLoc.click({ timeout: 5000 }).catch(() => {});
              await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
              logger.debug("click_text_ok", "clicked by text: " + targetEl.text.slice(0, 50));
              if (page.url() !== prevUrl) return { navigated: true, failed: false, metrics: navMetrics(page.url(), navStart) };
              return noNav;
            }
          } catch {}
        }

        // STRATEGY 3: A real link to the target URL
        if (targetUrl) {
          const navStart = Date.now();
          const ct = await clickThroughLink(page, targetUrl, rng, logger).catch(() => ({ ok: false, hovered: 0 }));
          if (ct.ok) return { navigated: true, failed: false, metrics: navMetrics(page.url(), navStart), clickThrough: true };
        }

        // STRATEGY 4 (Fallback only): Direct URL navigation when DOM clicking fails
        if (targetUrl) {
          try {
            const fullUrl = targetUrl.startsWith("/") ? new URL(targetUrl, page.url()).href : targetUrl;
            if (fullUrl.startsWith("http")) {
              const navStart = Date.now();
              logger.info("click_url_nav_fallback", "DOM click unavailable, falling back to direct nav: " + fullUrl.slice(0, 80));
              await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
              return { navigated: true, failed: false, metrics: navMetrics(fullUrl, navStart) };
            }
          } catch {
            logger.debug("url_nav_failed", "Fallback URL nav failed for: " + (targetUrl || "").slice(0, 60));
          }
        }

        logger.debug("click_all_failed", "all strategies exhausted");
        return noNav;
      }

      // ── Hover (biological trajectory to element) ──
      case "hover_element": {
        if (!decision.targetElement?.selector) return noNav;
        await hoverBeforeClick(page, decision.targetElement.selector, rng);
        return noNav;
      }

      // ── Scroll (natural eased wheel bursts) ──
      case "scroll": {
        // Sometimes move the mouse before scrolling, like a person reaching
        // for the wheel; wheel deltas land where the cursor sits.
        if (rng.chance(0.3)) await humanMouse(page, rng);
        await seatCursor(page, rng);

        const metrics = (await evaluateIsolated(page, scrollStateInPage)) ?? { vh: viewportOf(page).height, scrollY: 0, scrollHeight: 2000, phase: "down" as const };
        const steps = rng.int(2, 4);
        const mainDir = metrics.phase === "down" ? 1 : -1;
        const capMs = decision.maxMs;
        const startedAt = Date.now();

        for (let i = 0; i < steps; i++) {
          // A reader sometimes nudges back up a little before carrying on.
          const stepDir = rng.chance(0.18) ? -mainDir : mainDir;
          const distance = Math.round(metrics.vh * rng.float(0.3, 0.7) * stepDir);
          const moved = await wheelBy(page, rng, distance);
          if (moved === null) break; // page went away mid-gesture

          let pause = i === 0 && rng.chance(0.35) ? rng.int(800, 2000) : pacing.scrollPause();
          if (capMs !== undefined) {
            // A scheduled add-to-cart is close: trim the pause so the next
            // decision lands at the mark instead of past it.
            pause = Math.max(300, Math.min(pause, capMs - (Date.now() - startedAt)));
            if (Date.now() - startedAt >= capMs) break;
          }
          await sleep(pause);
        }

        // Gaze follows the content that just scrolled in.
        if ((capMs === undefined || Date.now() - startedAt < capMs - 600) && rng.chance(0.4)) {
          await hoverBeforeClick(page, 'a[href*="/products/"], [class*="price" i], h1, h2, [class*="card" i]', rng);
        }
        return noNav;
      }

      // ── Dwell (reading / ocular-following micro-drift) ──
      case "dwell": {
        const rawDwell = pacing.sectionDwell();
        const budget = decision.maxMs !== undefined ? Math.min(rawDwell, decision.maxMs) : rawDwell;
        const startedDwell = Date.now();
        if (budget > 900 && rng.chance(0.65)) {
          await sleep(Math.min(500, Math.round(budget * 0.35)));
          const cursor = new HumanCursor(page, rng);
          const pos = cursor.getPosition();
          const vp = viewportOf(page);
          await cursor.moveTo({
            x: Math.max(40, Math.min(vp.width - 40, pos.x + rng.int(-95, 95))),
            y: Math.max(40, Math.min(vp.height - 40, pos.y + rng.int(-55, 55))),
          }).catch(() => undefined);
        }
        const rem = budget - (Date.now() - startedDwell);
        if (rem > 20) await sleep(rem);
        return noNav;
      }

      // ── Pre-checkout choreography ──
      case "hover_card": {
        const r = await hoverProductCards(stepCtx(5_000), {
          count: decision.count ?? 2,
          cardSelector: recipe?.productCard ?? scan?.productCards.selector ?? null,
        });
        return { ...noNav, performed: r.performed, ...(r.detail ? { detail: r.detail } : {}) };
      }
      case "view_media": {
        const r = await viewMedia(stepCtx(9_000), {
          count: decision.count ?? 2,
          selector: scan?.gallery?.selector ?? recipe?.gallery ?? null,
          ...(scan?.gallery?.kind ? { kind: scan.gallery.kind } : {}),
        });
        return { ...noNav, performed: r.performed, ...(r.detail ? { detail: r.detail } : {}) };
      }
      case "read_section": {
        const r = await readSection(stepCtx(12_000), { selector: scan?.sections?.selector ?? recipe?.sections ?? null });
        return { ...noNav, performed: r.performed, ...(r.detail ? { detail: r.detail } : {}) };
      }
      case "select_text": {
        const r = await selectText(stepCtx(4_000));
        return { ...noNav, performed: r.performed, ...(r.detail ? { detail: r.detail } : {}) };
      }
      case "explore_variants": {
        const r = await exploreVariants(stepCtx(9_000), { tried: ctx.triedVariants ?? new Set(), scan });
        return { ...noNav, performed: r.performed, variantId: r.variantId ?? null, ...(r.detail ? { detail: r.detail } : {}) };
      }
      case "inspect_cart": {
        const started = Date.now();
        const r = await inspectCart(stepCtx(8_000), {
          drawerSelector: recipe?.cartDrawer ?? scan?.cartDrawer ?? null,
          park: decision.park === true,
        });
        return {
          navigated: !!r.navigated,
          failed: false,
          metrics: r.navigated ? navMetrics(page.url(), started) : null,
          performed: r.performed,
          ...(r.detail ? { detail: r.detail } : {}),
        };
      }

      // ── Add to cart (scheduled advance action) ──
      case "add_to_cart": {
        const r = await executeAddToCart(decision, { page, logger, rng, waterfall: ctx.waterfall ?? null });
        return {
          navigated: r.navigated,
          failed: false,
          metrics: null,
          atcVerified: r.verified,
          ...(r.tier !== undefined ? { atcTier: r.tier } : {}),
          variantId: r.variantId ?? null,
          performed: r.clicked ? 1 : 0,
          detail: r.verified ? `verified via ${r.how} (tier${r.tier ?? 1})` : r.clicked ? "clicked, unverified" : "nothing clickable",
        };
      }

      // ── Exit ──
      case "exit":
        return noNav;
    }
  } catch (err) {
    logger.error(
      "action_failed",
      decision.action + ": " + (err instanceof Error ? err.message : String(err)),
    );
    return { navigated: false, failed: true, metrics: null };
  }

  return noNav;
}
