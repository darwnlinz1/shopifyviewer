/**
 * The interactions of the pre-checkout choreography (see choreography.ts):
 * hovering listing cards, flipping through the gallery, opening and reading
 * detail sections, highlighting a line of text, trying size/colour, and
 * reviewing the cart after an add. Each step works to a deadline so the
 * scheduled add-to-cart still lands on its mark.
 */
import type { Page } from "rebrowser-playwright";
import type { ChoreographyConfig, Range } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Rng } from "../util/random.js";
import { sleep } from "../util/random.js";
import type { Pacing } from "./timing.js";
import { HumanCursor } from "./humanCursor.js";
import { viewportOf } from "../browser/viewport.js";
import { evaluateIsolated } from "../navigator/isolate.js";
import { wheelBy } from "../navigator/wheel.js";
import { clickTarget, findTargets, hoverTarget, scrollIntoComfort, type Target } from "./humanActions.js";
import { detectMultiSignal, planVariantSelection, type MultiSignalResult, type VariantStep } from "../navigator/multiSignalDetector.js";

export interface ChoreoContext {
  page: Page;
  rng: Rng;
  logger: Logger;
  pacing: Pacing;
  cfg: ChoreographyConfig;
  /** Wall-clock time (Date.now()) by which the step must be finished. */
  deadline: number;
}

export interface ChoreoResult {
  /** Sub-actions actually performed (images viewed, sections read…); 0 = nothing to do here. */
  performed: number;
  detail?: string;
  navigated?: boolean;
  variantId?: string | null;
  /** inspect_cart: where the cart was reviewed. */
  via?: "drawer" | "cart_page";
  /** inspect_cart: the drawer selector that matched, for the shop's recipe. */
  drawerSelector?: string | null;
}

const remaining = (ctx: ChoreoContext): number => ctx.deadline - Date.now();
const draw = (rng: Rng, r: Range): number => rng.int(r.min, r.max);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const CHROME_SKIP = 'header, footer, nav, [role="navigation"], [class*="announcement" i]';
const RELATED_SKIP = '[class*="related" i], [class*="recommend" i], [class*="upsell" i], product-recommendations, [class*="recently" i]';
const DRAWER_SKIP = 'cart-drawer, cart-notification, [class*="cart-drawer" i], [class*="mini-cart" i], [role="dialog"]';
const MENU_SKIP = '[class*="menu" i], [id*="menu" i], [class*="localization" i], localization-form, [class*="filter" i], [class*="facet" i]';

export const DRAWER_SELECTORS = [
  "cart-drawer",
  "cart-notification",
  "#CartDrawer",
  "#cart-drawer",
  '[class*="cart-drawer" i]',
  '[id*="cart-drawer" i]',
  '[class*="mini-cart" i]',
  '[class*="side-cart" i]',
  '[class*="cart-flyout" i]',
  '[class*="drawer--cart" i]',
  "#CartNotification",
  '[aria-label*="cart" i][role="dialog"]',
];

/** Which cart drawer is open right now, if any (isolated world). */
export function openCartDrawerInPage(arg: { selectors: string[] }): string | null {
  for (const sel of arg.selectors) {
    let els: Element[] = [];
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity || "1") === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || r.right <= 0 || r.left >= window.innerWidth || r.bottom <= 0 || r.top >= window.innerHeight) continue;
      const cls = String((el as HTMLElement).className || "");
      if (el.hasAttribute("open") || el.getAttribute("aria-hidden") === "false" || /active|open|visible|is-open|animate/i.test(cls)) return sel;
    }
  }
  return null;
}

export async function openCartDrawer(page: Page, preferred?: string | null): Promise<string | null> {
  const selectors = preferred ? [preferred, ...DRAWER_SELECTORS.filter((s) => s !== preferred)] : DRAWER_SELECTORS;
  return evaluateIsolated(page, openCartDrawerInPage, { selectors });
}

const isCartPath = (url: string): boolean => {
  try {
    return /^(\/[a-z]{2}(-[a-z]{2})?)?\/cart\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** hover_card — rest on a couple of product cards the way a shopper eyes a grid. */
export async function hoverProductCards(ctx: ChoreoContext, opts: { count: number; cardSelector?: string | null }): Promise<ChoreoResult> {
  const { page, rng } = ctx;
  const selectors = [opts.cardSelector, '[class*="card" i] a[href*="/products/"]', 'a[href*="/products/"] img', 'a[href*="/products/"]'].filter(
    (s): s is string => !!s,
  );
  const inView = async (): Promise<Target[]> => {
    const vp = viewportOf(page);
    const all = await findTargets(page, { selectors, skip: CHROME_SKIP + "," + DRAWER_SKIP, max: 30 });
    return all.filter((t) => t.y > vp.height * 0.08 && t.y + t.h < vp.height * 0.92);
  };
  let cards = await inView();
  if (!cards.length && remaining(ctx) > 2500) {
    await wheelBy(page, rng, Math.round(viewportOf(page).height * rng.float(0.35, 0.6)));
    await sleep(rng.int(200, 400));
    cards = await inView();
  }
  const seen = new Set<string>();
  let performed = 0;
  for (const card of rng.shuffle(cards)) {
    if (performed >= opts.count || remaining(ctx) < 800) break;
    if (card.href && seen.has(card.href)) continue;
    if (card.href) seen.add(card.href);
    if (await hoverTarget(page, rng, card, Math.min(rng.int(450, 1300), remaining(ctx) - 300))) performed++;
  }
  return { performed, detail: performed ? `${performed} card(s)` : "no cards in view" };
}

/** Move the eye/hand onto the main product image after it changes. */
async function gazeAtMainMedia(ctx: ChoreoContext): Promise<void> {
  const { page, rng } = ctx;
  const main = await findTargets(page, {
    selectors: ['[class*="product__media" i] img', ".product__media-item", '[class*="product-gallery" i] img', '[class*="main-image" i]', "media-gallery img", "[data-media-id]"],
    skip: CHROME_SKIP + "," + RELATED_SKIP,
    max: 4,
  });
  const vp = viewportOf(page);
  const shown = main.find((t) => t.y + t.h > 60 && t.y < vp.height - 60);
  if (!shown) return;
  const top = Math.max(shown.y, 30);
  const height = Math.min(shown.y + shown.h, vp.height - 30) - top;
  await new HumanCursor(page, rng)
    .moveTo({
      x: clamp(shown.x + shown.w * rng.float(0.3, 0.7), 10, vp.width - 10),
      y: clamp(top + height * rng.float(0.25, 0.65), 10, vp.height - 10),
    })
    .catch(() => undefined);
}

const THUMB_SELECTORS = [
  "button[class*='thumb' i]",
  ".media-thumbs__btn",
  ".swiper__thumbs .swiper-slide",
  ".product-images-slider .swiper-slide",
  "[data-thumbnail-id]",
  "button[data-media-id]",
  ".thumbnail-list button",
  ".product__media-list button",
  '[class*="thumbnail" i] button',
  '[class*="thumbnail" i] img',
  '[class*="thumb" i] button',
  '[aria-label*="Thumbnail" i]',
  '[aria-label*="Load image" i]',
  ".slick-dots button",
  ".flickity-page-dots .dot",
  ".swiper-pagination-bullet",
];
const ARROW_SELECTORS = [
  '[class*="gallery" i] button[aria-label*="next" i]',
  '[class*="media" i] button[aria-label*="next" i]',
  '[class*="media" i] button[name="next" i]',
  '[class*="gallery" i] button[name="next" i]',
  '[class*="slider" i] button[name="next" i]',
  '[class*="slider" i] button[class*="next" i]',
  ".swiper-button-next",
  ".slick-next",
  ".flickity-prev-next-button.next",
  'button[aria-label*="next image" i]',
  'button[aria-label*="next slide" i]',
];

/** view_media — flip through gallery images, a beat on each. */
export async function viewMedia(
  ctx: ChoreoContext,
  opts: { count: number; selector?: string | null; kind?: "thumbs" | "arrow" | "stack" },
): Promise<ChoreoResult> {
  const { page, rng } = ctx;
  const skip = CHROME_SKIP + "," + RELATED_SKIP + "," + DRAWER_SKIP;
  if (opts.kind === "stack" && opts.selector) return viewStackedMedia(ctx, opts.selector, opts.count, skip);
  const vp = viewportOf(page);
  // Wheel scrolling only reaches vertically; thumbnails a slider has moved off
  // to the side are left to its arrows.
  let targets = (
    opts.kind === "arrow" ? [] : await findTargets(page, { selectors: opts.selector ? [opts.selector, ...THUMB_SELECTORS] : THUMB_SELECTORS, skip, max: 12 })
  ).filter((t) => t.x < vp.width - 8 && t.x + t.w > 8);
  let arrow = false;
  if (targets.length < 2) {
    const arrows = await findTargets(page, { selectors: ARROW_SELECTORS, skip, max: 2 });
    if (arrows.length) {
      targets = arrows;
      arrow = true;
    }
  }
  if (!targets.length) {
    if (remaining(ctx) > 2_000) {
      const gazed = await viewStackedMedia(
        ctx,
        'media-gallery img, [class*="media-gallery" i] img, [class*="product__media" i] img, [class*="product-media" i] img',
        opts.count,
        skip,
      );
      if (gazed.performed > 0) return gazed;
    }
    return { performed: 0, detail: "no gallery" };
  }

  let performed = 0;
  let idx = arrow ? 0 : rng.int(1, Math.max(1, targets.length - 1));
  // A thumbnail costs a scroll, a click and a look; after the first, do not start one the deadline cannot fit.
  for (let i = 0; i < opts.count && (i === 0 || remaining(ctx) > 2500); i++) {
    const target = arrow ? targets[0] : targets[idx % targets.length];
    if (target && (await clickTarget(page, rng, target))) {
      performed++;
      await gazeAtMainMedia(ctx);
      await sleep(Math.min(draw(rng, ctx.cfg.mediaDwellMs), Math.max(250, remaining(ctx) - 200)));
    }
    // Mostly onward, now and then back a step to compare two shots.
    idx = arrow ? 0 : rng.chance(0.2) && idx > 1 ? idx - 1 : idx + 1;
  }
  if (performed > 0) return { performed, detail: `${performed} image(s)${arrow ? " via arrow" : ""}` };
  // Thumbs that would not take a click (covered, still laying out): look down the photo column instead.
  if (remaining(ctx) > 2_000) {
    const gazed = await viewStackedMedia(
      ctx,
      'media-gallery img, [class*="media-gallery" i] img, [class*="product__media" i] img, [class*="product-media" i] img',
      opts.count,
      skip,
    );
    if (gazed.performed > 0) return gazed;
  }
  return { performed: 0, detail: "0 image(s)" };
}

/**
 * A stacked gallery has nothing to click (clicking usually opens a zoom
 * overlay): the shopper scrolls down the column and looks at each photo.
 */
async function viewStackedMedia(ctx: ChoreoContext, selector: string, count: number, skip: string): Promise<ChoreoResult> {
  const { page, rng } = ctx;
  const shots = await findTargets(page, { selectors: [selector], skip, max: 14 });
  if (shots.length < 2) return { performed: 0, detail: "no gallery" };
  const vp = viewportOf(page);
  let i = Math.max(0, shots.findIndex((t) => t.y + t.h * 0.5 > 0));
  let performed = 0;
  for (let tries = 0; i < shots.length && performed < count && (tries === 0 || remaining(ctx) > 2500); tries++) {
    const box = await scrollIntoComfort(page, rng, shots[i]!.path, { topFrac: 0.04, bottomFrac: 0.96 });
    if (box && box.y < vp.height - 40 && box.y + box.height > 40) {
      const top = Math.max(box.y, 30);
      const bottom = Math.min(box.y + box.height, vp.height - 30);
      await new HumanCursor(page, rng)
        .moveTo({ x: clamp(box.x + box.width * rng.float(0.3, 0.7), 10, vp.width - 10), y: clamp(top + (bottom - top) * rng.float(0.3, 0.6), 10, vp.height - 10) })
        .catch(() => undefined);
      await sleep(Math.min(draw(rng, ctx.cfg.mediaDwellMs), Math.max(250, remaining(ctx) - 200)));
      performed++;
    }
    // Now and then a photo gets only a passing glance on the way down.
    i += rng.chance(0.25) ? 2 : 1;
  }
  return { performed, detail: `${performed} image(s) down the gallery` };
}

/** Length of the text a section header reveals (isolated world). */
export function sectionTextLengthInPage(arg: { path: string }): number {
  let el: Element | null = null;
  try {
    el = document.querySelector(arg.path);
  } catch {
    return 0;
  }
  if (!el) return 0;
  const details = el.closest("details");
  if (details) return ((details as HTMLElement).innerText || "").length;
  const id = el.getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (panel) return (panel.innerText || "").length;
  const next = el.nextElementSibling as HTMLElement | null;
  return (next?.innerText || "").length;
}

/** One line of readable text in view, as drag start/end points (isolated world). */
export function textLineInPage(arg: { path: string | null }): { x1: number; x2: number; y: number; chars: number } | null {
  const roots: Element[] = [];
  const push = (el: Element | null): void => {
    if (el && !roots.includes(el)) roots.push(el);
  };
  if (arg.path) {
    try {
      const el = document.querySelector(arg.path);
      push(el ? el.closest("details") : null);
      const id = el ? el.getAttribute("aria-controls") : null;
      push(id ? document.getElementById(id) : null);
    } catch {
      /* ignore */
    }
  }
  for (const sel of [".product__description", '[class*="description" i]', ".rte", "details[open]", '[class*="product__info" i]', "main"]) {
    try {
      document.querySelectorAll(sel).forEach((e) => push(e));
    } catch {
      /* ignore */
    }
  }
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || "").trim();
      if (text.length < 30) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest("a, button, label, input, select, textarea, summary, script, style, header, footer, nav")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const line = Array.from(range.getClientRects()).find(
        (r) => r.width > 60 && r.height > 6 && r.top > 70 && r.bottom < window.innerHeight - 70,
      );
      if (!line) continue;
      return { x1: line.left + 2, x2: line.left + Math.min(line.width, 520) - 2, y: line.top + line.height / 2, chars: text.length };
    }
  }
  return null;
}

/** select_text — press, drag across a line, release: the shopper's highlight-while-reading. */
export async function selectText(ctx: ChoreoContext, opts: { nearPath?: string | null } = {}): Promise<ChoreoResult> {
  const { page, rng } = ctx;
  const line = await evaluateIsolated(page, textLineInPage, { path: opts.nearPath ?? null });
  if (!line || remaining(ctx) < 1500) return { performed: 0, detail: "no text line in view" };
  const cursor = new HumanCursor(page, rng);
  await cursor.moveTo({ x: line.x1, y: line.y });
  await sleep(rng.int(120, 260));
  await page.mouse.down();
  await cursor.moveTo({ x: line.x2, y: line.y + rng.int(-1, 1) });
  await sleep(rng.int(60, 140));
  await page.mouse.up();
  await sleep(Math.min(rng.int(700, 1600), Math.max(200, remaining(ctx) - 200)));
  return { performed: 1, detail: `${Math.round(line.x2 - line.x1)}px line` };
}

/** Open sections already read, per page and URL — a section is read once, not again. */
const readOpenSections = new WeakMap<Page, { url: string; paths: Set<string> }>();

/** Nothing left to open: scroll to a section the theme shows open and read it there. */
async function readOpenSection(ctx: ChoreoContext, skip: string): Promise<ChoreoResult> {
  const { page, rng } = ctx;
  let seen = readOpenSections.get(page);
  if (!seen || seen.url !== page.url()) {
    seen = { url: page.url(), paths: new Set() };
    readOpenSections.set(page, seen);
  }
  const open = await findTargets(page, { selectors: ["details[open] > summary", '[aria-expanded="true"][aria-controls]'], skip, max: 6 });
  for (const t of rng.shuffle(open.filter((o) => !seen!.paths.has(o.path)))) {
    if (remaining(ctx) < 2000) break;
    const chars = (await evaluateIsolated(page, sectionTextLengthInPage, { path: t.path })) ?? 0;
    if (chars < 40) continue;
    if (!(await scrollIntoComfort(page, rng, t.path))) continue;
    seen.paths.add(t.path);
    await sleep(Math.min(ctx.pacing.readingTime(chars), Math.max(500, remaining(ctx) - 300)));
    return { performed: 1, detail: `"${t.text.slice(0, 40)}" ${chars} chars, already open` };
  }
  return { performed: 0, detail: "no unread sections" };
}

/** read_section — open a details/accordion header and read what it reveals. */
export async function readSection(ctx: ChoreoContext, opts: { selector?: string | null; selectText?: boolean } = {}): Promise<ChoreoResult> {
  const { page, rng } = ctx;
  const selectors = [
    opts.selector,
    "details > summary",
    '[class*="accordion" i] button[aria-expanded]',
    "button[aria-expanded][aria-controls]",
    '[class*="collapsible" i] summary',
    '[class*="collapsible" i] button',
    '[role="tab"]',
    '[class*="accordion" i] [class*="title" i]',
  ].filter((s): s is string => !!s);
  const skip = [CHROME_SKIP, RELATED_SKIP, DRAWER_SKIP, MENU_SKIP].join(",");
  const targets = await findTargets(page, { selectors, skip, closedOnly: true, max: 10 });
  if (!targets.length) return readOpenSection(ctx, skip);
  const preferred = targets.filter((t) =>
    /descri|detail|size|fit|taille|guide|ship|livraison|deliver|retour|return|ingr|material|care|compo|spec|feature|faq/i.test(t.text),
  );
  // A disclosure that opens onto nothing (a bundle picker, a lazy panel) is
  // glanced at and passed over; it does not count as reading.
  const order = [...rng.shuffle(preferred), ...rng.shuffle(targets.filter((t) => !preferred.includes(t)))];
  let pick: Target | null = null;
  let chars = 0;
  let opened = 0;
  for (const candidate of order.slice(0, 2)) {
    if (pick === null && opened && remaining(ctx) < 1500) break;
    if (!(await clickTarget(page, rng, candidate))) continue;
    opened = Date.now();
    await sleep(rng.int(300, 600));
    chars = (await evaluateIsolated(page, sectionTextLengthInPage, { path: candidate.path })) ?? 0;
    if (chars >= 20) {
      pick = candidate;
      break;
    }
  }
  if (!pick) return { performed: 0, detail: opened ? "sections held nothing to read" : "section click missed" };
  const readMs = Math.min(ctx.pacing.readingTime(chars), Math.max(500, remaining(ctx) - 300));
  if (chars > 500 && readMs > 3000) {
    // A long panel gets read on the way down.
    await sleep(Math.round(readMs * 0.4));
    await wheelBy(page, rng, Math.round(viewportOf(page).height * rng.float(0.2, 0.35)));
  }
  let selected = false;
  if (opts.selectText && remaining(ctx) > 2500) selected = (await selectText(ctx, { nearPath: pick.path })).performed > 0;
  const rest = readMs - (Date.now() - opened);
  if (rest > 0) await sleep(Math.min(rest, Math.max(0, remaining(ctx) - 100)));
  return { performed: 1 + (selected ? 1 : 0), detail: `"${pick.text.slice(0, 40)}" ${chars} chars${selected ? " +select_text" : ""}` };
}

/** Select one variant option like a shopper: hover-and-pick for selects, a click otherwise. */
export async function applyVariantStep(page: Page, rng: Rng, step: VariantStep): Promise<boolean> {
  if (step.group.kind === "select") {
    const box = await scrollIntoComfort(page, rng, step.group.path);
    if (box) await new HumanCursor(page, rng).moveTo({ x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 }, box);
    return page
      .locator(step.group.path)
      .first()
      .selectOption(step.option.value, { timeout: 2500 })
      .then(() => true)
      .catch(() => false);
  }
  if (!step.option.path) return false;
  const shown = await page.locator(step.option.path).first().isVisible({ timeout: 400 }).catch(() => false);
  // A size list that lives in a closed combobox has no box until the trigger is pressed.
  if (!shown && step.group.path && step.group.path !== step.option.path) {
    await clickTarget(page, rng, { path: step.group.path });
    await sleep(rng.int(400, 700));
  }
  return clickTarget(page, rng, { path: step.option.path });
}

/**
 * explore_variants — try an in-stock size/colour the shopper has not looked
 * at yet (stock from the product oracle), then watch the image and price
 * update before moving on.
 */
export async function exploreVariants(
  ctx: ChoreoContext,
  opts: { tried: Set<string>; scan?: MultiSignalResult | null },
): Promise<ChoreoResult> {
  const { page, rng } = ctx;
  const scan = (await detectMultiSignal(page).catch(() => null)) ?? opts.scan ?? null;
  if (!scan) return { performed: 0, detail: "no scan" };
  // A click is a scroll, a move and a press (~1.8s). Only a combination that
  // fits is started, and a started one is finished: stopping halfway can
  // leave the page on a sold-out pairing nobody would pick.
  const affordable = Math.max(1, Math.floor((remaining(ctx) - 1200) / 1800));
  const plan = planVariantSelection(scan, rng, { exclude: opts.tried, maxChanges: affordable });
  if (!plan || !plan.steps.length) return { performed: 0, detail: "no variant controls" };
  let clicked = 0;
  for (const step of plan.steps) {
    if (step.option.checked) continue;
    if (await applyVariantStep(page, rng, step)) clicked++;
    await sleep(rng.int(350, 800));
  }
  await sleep(Math.min(rng.int(1000, 2000), Math.max(200, remaining(ctx) - 100)));
  const label = plan.steps.map((s) => `${s.group.name}=${s.option.label || s.option.value}`).join(", ");
  return { performed: clicked > 0 ? 1 : 0, variantId: plan.variantId, detail: `${label} (${plan.source})` };
}

async function closeDrawer(ctx: ChoreoContext, drawerSelector: string): Promise<void> {
  const closers = await findTargets(ctx.page, {
    selectors: [
      `${drawerSelector} [aria-label*="close" i]`,
      `${drawerSelector} [aria-label*="fermer" i]`,
      `${drawerSelector} [aria-label*="schlie" i]`,
      `${drawerSelector} [aria-label*="cerrar" i]`,
      `${drawerSelector} [class*="close" i]`,
    ],
    max: 1,
  });
  if (closers[0] && (await clickTarget(ctx.page, ctx.rng, closers[0]))) return;
  await ctx.page.keyboard.press("Escape").catch(() => undefined);
}

/**
 * inspect_cart — open the cart drawer (or /cart), look over the lines and
 * the subtotal, rest on the checkout button without pressing it. The cart is
 * left exactly as it is, ready for checkout. `park` keeps the drawer/page up.
 */
export async function inspectCart(ctx: ChoreoContext, opts: { drawerSelector?: string | null; park?: boolean } = {}): Promise<ChoreoResult> {
  const { page, rng } = ctx;
  const startUrl = page.url();
  let drawer = await openCartDrawer(page, opts.drawerSelector);
  let via: ChoreoResult["via"] = drawer ? "drawer" : isCartPath(page.url()) ? "cart_page" : undefined;

  if (!via) {
    const icons = await findTargets(page, {
      selectors: [
        'header a[href$="/cart"]',
        'header a[href*="/cart"]',
        "#cart-icon-bubble",
        '[aria-controls*="cart" i]',
        'header [class*="cart-icon" i]',
        'header button[class*="cart" i]',
        "[data-cart-toggle]",
        'a[href$="/cart"]',
      ],
      skip: 'footer, [role="dialog"]',
      max: 2,
    });
    if (icons[0] && (await clickTarget(page, rng, icons[0]))) {
      const until = Date.now() + 4_000;
      while (Date.now() < until && !via) {
        await sleep(300);
        drawer = await openCartDrawer(page, opts.drawerSelector);
        if (drawer) via = "drawer";
        else if (isCartPath(page.url())) {
          await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
          via = "cart_page";
        }
      }
    }
    if (!via) {
      try {
        await page.goto(new URL("/cart", page.url()).href, { waitUntil: "domcontentloaded", timeout: 20_000 });
        if (isCartPath(page.url())) via = "cart_page";
      } catch {
        /* unreachable cart */
      }
    }
  }
  if (!via) return { performed: 0, detail: "cart unreachable" };

  const scoped = (sels: string[]): string[] => (via === "drawer" && drawer ? sels.map((s) => `${drawer} ${s}`) : sels.map((s) => `main ${s}`));
  const items = await findTargets(page, {
    selectors: scoped(['[class*="cart-item" i]', '[class*="line-item" i]', '[class*="cart__item" i]', "tr", "li"]),
    max: 6,
  });
  for (const item of items.slice(0, rng.int(1, 3))) {
    if (remaining(ctx) < 1500) break;
    await hoverTarget(page, rng, item, rng.int(600, 1400));
  }
  const totals = await findTargets(page, { selectors: scoped(['[class*="subtotal" i]', '[class*="totals" i]', '[class*="total" i]']), max: 2 });
  if (totals[0] && remaining(ctx) > 1200) await hoverTarget(page, rng, totals[0], rng.int(800, 1600));
  const checkout = await findTargets(page, { selectors: scoped(['[name="checkout"]', '[class*="checkout" i]', 'a[href*="/checkout"]']), max: 1 });
  if (checkout[0] && remaining(ctx) > 900) await hoverTarget(page, rng, checkout[0], rng.int(500, 1100));
  const rest = remaining(ctx) - 250;
  if (rest > 0) await sleep(Math.min(rest, 6_000));
  if (via === "drawer" && drawer) {
    if (!opts.park) await closeDrawer(ctx, drawer);
    else {
      // Ready for checkout means the cart page itself, the way a shopper clicks "View cart".
      const viewCart = await findTargets(page, { selectors: [`${drawer} a[href$="/cart"]`, `${drawer} a[href*="/cart?"]`], max: 1 });
      if (viewCart[0] && (await clickTarget(page, rng, viewCart[0]))) {
        await page.waitForURL((u) => isCartPath(u.href), { timeout: 8_000 }).catch(() => undefined);
        if (isCartPath(page.url())) via = "cart_page";
      }
    }
  }

  return {
    performed: 1,
    navigated: page.url() !== startUrl,
    via,
    drawerSelector: via === "drawer" ? drawer : null,
    detail: `${via}${items.length ? `, ${Math.min(items.length, 3)} line(s)` : ""}${totals.length ? ", subtotal" : ""}`,
  };
}
