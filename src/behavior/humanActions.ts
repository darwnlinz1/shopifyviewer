/**
 * Human interaction primitives for the pre-checkout choreography.
 *
 * Targets are found and measured in the isolated world (paths + viewport
 * boxes), brought into view with real wheel input — never scrollIntoView,
 * which jumps the page without a single wheel event — and clicked or hovered
 * with HumanCursor, so every event the page sees is trusted mouse input.
 */
import type { Page } from "rebrowser-playwright";
import type { Rng } from "../util/random.js";
import { sleep } from "../util/random.js";
import { HumanCursor, type TargetBounds } from "./humanCursor.js";
import { wheelBy } from "../navigator/wheel.js";
import { viewportOf } from "../browser/viewport.js";
import { evaluateIsolated } from "../navigator/isolate.js";

export interface Target {
  /** Exact CSS path to the element on this page. */
  path: string;
  /** Viewport-relative box at measurement time. */
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** For links: resolved pathname. */
  href: string;
}

export interface FindTargetsArg {
  selectors: string[];
  /** Ancestors that disqualify a match (header, footer, related grids…). */
  skip?: string;
  /** Extra filter: closed collapsibles only. */
  closedOnly?: boolean;
  max?: number;
}

/** In-page target finder (isolated world; self-contained). */
export function findTargetsInPage(arg: FindTargetsArg): Target[] {
  const out: Target[] = [];
  const seen = new Set<Element>();
  const max = arg.max ?? 20;
  const esc = (s: string): string =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  const idOf = (el: Element): string => el.getAttribute("id") || "";
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.length < 12) {
      const cur: Element = node;
      const id = idOf(cur);
      if (id) {
        try {
          if (document.querySelectorAll("#" + esc(id)).length === 1) {
            parts.unshift("#" + esc(id));
            break;
          }
        } catch {
          /* fall through to nth-of-type */
        }
      }
      let part = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const anyEl = el as unknown as { checkVisibility?: (o: object) => boolean };
    return typeof anyEl.checkVisibility === "function" ? anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  };
  for (const sel of arg.selectors) {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (out.length >= max) break;
      if (seen.has(el) || !visible(el)) continue;
      if (arg.skip && el.closest(arg.skip)) continue;
      if (arg.closedOnly) {
        const d = el.closest("details");
        if (d && (d as HTMLDetailsElement).open) continue;
        if (el.getAttribute("aria-expanded") === "true") continue;
      }
      seen.add(el);
      const r = el.getBoundingClientRect();
      const a = el.closest("a") as HTMLAnchorElement | null;
      let href = "";
      try {
        href = a && a.href ? new URL(a.href, location.href).pathname : "";
      } catch {
        href = "";
      }
      out.push({
        path: pathOf(el),
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        text: ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80),
        href,
      });
    }
    if (out.length >= max) break;
  }
  return out;
}

interface MeasuredBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Page scroll offset and its maximum, to know which way scrolling can still go. */
  sy: number;
  maxSy: number;
  /** Inside a fixed/sticky container: wheel input will not move it. */
  pinned: boolean;
}

/** Current viewport box of an element by path (isolated world). */
export function boxOfPathInPage(arg: { path: string }): MeasuredBox | null {
  let el: Element | null = null;
  try {
    el = document.querySelector(arg.path);
  } catch {
    return null;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return null;
  let pinned = false;
  let node: Element | null = el;
  for (let i = 0; node && i < 8; i++) {
    const pos = getComputedStyle(node).position;
    if (pos === "fixed" || pos === "sticky") {
      pinned = true;
      break;
    }
    node = node.parentElement;
  }
  const doc = document.scrollingElement || document.documentElement;
  return {
    x: r.left,
    y: r.top,
    w: r.width,
    h: r.height,
    sy: window.scrollY || doc.scrollTop || 0,
    maxSy: Math.max(0, (doc.scrollHeight || 0) - window.innerHeight),
    pinned,
  };
}

export async function findTargets(page: Page, arg: FindTargetsArg): Promise<Target[]> {
  return (await evaluateIsolated(page, findTargetsInPage, arg)) ?? [];
}

export interface FindAnchorsArg {
  /** Pathname to match, without a trailing slash. */
  pathname: string;
  product: boolean;
  max?: number;
}

/**
 * Anchors in the page body whose pathname is the navigation target.
 *
 * Unlike the CSS finder, this ignores opacity (cards often fade in) and does
 * not throw away a grid because an ancestor's class happens to contain
 * "drawer" or "mega". Header, footer and dialogs are still skipped so a menu
 * link does not win over the card in the listing. Self-contained for the
 * isolated world.
 */
export function findAnchorsInPage(arg: FindAnchorsArg): Target[] {
  const want = arg.pathname;
  const max = arg.max ?? 6;
  const esc = (s: string): string =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.length < 12) {
      const cur: Element = node;
      const id = cur.getAttribute("id") || "";
      if (id) {
        try {
          if (document.querySelectorAll("#" + esc(id)).length === 1) {
            parts.unshift("#" + esc(id));
            break;
          }
        } catch { /* nth-of-type */ }
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const tailOf = (p: string): string => {
    const i = p.indexOf("/products/");
    return i >= 0 ? p.slice(i) : p;
  };
  const root = document.querySelector("main, [role='main'], #MainContent") || document.body;
  const ranked: { el: HTMLAnchorElement; top: number; inView: boolean; href: string; r: DOMRect }[] = [];
  for (const a of Array.from(root.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
    if (a.closest('header, footer, [role="dialog"], [role="navigation"]')) continue;
    let href = "";
    try {
      href = new URL(a.href, location.href).pathname.replace(/\/+$/, "") || "/";
    } catch {
      continue;
    }
    const same = arg.product ? tailOf(href) === tailOf(want) : href === want;
    if (!same) continue;
    const r = a.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    ranked.push({ el: a, top: r.top, inView: r.top > 40 && r.bottom < innerHeight * 0.92 && r.left < innerWidth, href, r });
  }
  ranked.sort((a, b) => Number(b.inView) - Number(a.inView) || a.top - b.top);
  return ranked.slice(0, max).map((item) => ({
    path: pathOf(item.el),
    x: item.r.left,
    y: item.r.top,
    w: item.r.width,
    h: item.r.height,
    text: (item.el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
    href: item.href,
  }));
}

export async function findAnchors(page: Page, arg: FindAnchorsArg): Promise<Target[]> {
  return (await evaluateIsolated(page, findAnchorsInPage, arg)) ?? [];
}

/**
 * Any real product or collection link on the page, when the exact URL the
 * engine picked only exists in a hidden menu. Prefers a card already in view.
 * Header links count only when they are actually on screen. Self-contained.
 */
export function findVisibleShopLinkInPage(arg: { kind: "product" | "collection" }): Target | null {
  const needle = arg.kind === "product" ? "/products/" : "/collections/";
  const esc = (s: string): string =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.length < 12) {
      const cur: Element = node;
      const id = cur.getAttribute("id") || "";
      if (id) {
        try {
          if (document.querySelectorAll("#" + esc(id)).length === 1) {
            parts.unshift("#" + esc(id));
            break;
          }
        } catch { /* nth-of-type */ }
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  let best: { el: HTMLAnchorElement; score: number; r: DOMRect; href: string } | null = null;
  for (const a of Array.from(document.querySelectorAll('a[href*="' + needle + '"]')) as HTMLAnchorElement[]) {
    if (a.closest('[role="dialog"]')) continue;
    let href = "";
    try {
      href = new URL(a.href, location.href).pathname.replace(/\/+$/, "") || "/";
    } catch {
      continue;
    }
    if (!href.includes(needle) || /gift[-_]?card|e[-_]?gift/i.test(href)) continue;
    const r = a.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const inChrome = !!a.closest('header, footer, nav, [role="navigation"]');
    const inView = r.bottom > 40 && r.top < innerHeight - 40 && r.right > 0 && r.left < innerWidth;
    if (inChrome && !inView) continue;
    const score = (inView ? 4 : 0) + (inChrome ? 0 : 2) + Math.min(r.width * r.height, 40_000) / 40_000;
    if (!best || score > best.score) best = { el: a, score, r, href };
  }
  if (!best) return null;
  return {
    path: pathOf(best.el),
    x: best.r.left,
    y: best.r.top,
    w: best.r.width,
    h: best.r.height,
    text: (best.el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
    href: best.href,
  };
}

async function measure(page: Page, path: string): Promise<MeasuredBox | null> {
  return evaluateIsolated(page, boxOfPathInPage, { path });
}

const toBounds = (b: MeasuredBox): TargetBounds => ({ x: b.x, y: b.y, width: b.w, height: b.h });

export async function boxOfPath(page: Page, path: string): Promise<TargetBounds | null> {
  const b = await measure(page, path);
  return b ? toBounds(b) : null;
}

/**
 * Wheel the page until the element sits in the comfortable reading band
 * (below sticky headers, above sticky add-to-cart bars). A target that is
 * already fully visible is accepted when scrolling cannot bring it closer —
 * a header link on an unscrolled page, a pinned element, the page's end.
 */
export async function scrollIntoComfort(
  page: Page,
  rng: Rng,
  path: string,
  opts: { topFrac?: number; bottomFrac?: number; maxGestures?: number } = {},
): Promise<TargetBounds | null> {
  const top = opts.topFrac ?? 0.14;
  const bottom = opts.bottomFrac ?? 0.76;
  let box = await measure(page, path);
  for (let i = 0; box && i < (opts.maxGestures ?? 6); i++) {
    const vp = viewportOf(page);
    const bodyBottom = box.y + Math.min(box.h, vp.height * 0.4);
    if (box.y >= vp.height * top && bodyBottom <= vp.height * bottom) return toBounds(box);
    const fullyVisible = box.y >= 0 && box.y + box.h <= vp.height;
    const targetY = vp.height * rng.float(0.32, 0.5);
    const delta = Math.round(box.y + Math.min(box.h, vp.height * 0.4) / 2 - targetY);
    const cannotMove = box.pinned || (delta < 0 && box.sy <= 1) || (delta > 0 && box.sy >= box.maxSy - 1);
    if (Math.abs(delta) < 10 || (fullyVisible && cannotMove)) return toBounds(box);
    // Heading back up a long page (reviews → buy box) is a few hard flings, not a dozen nudges.
    const reach = Math.abs(delta) > vp.height * 1.5 ? rng.float(1.5, 2.4) : rng.float(0.55, 0.85);
    const flick = Math.sign(delta) * Math.min(Math.abs(delta), Math.round(vp.height * reach));
    if ((await wheelBy(page, rng, flick)) === null) return null;
    await sleep(rng.int(140, 320));
    const next = await measure(page, path);
    // The wheel did not move it: take it as it is if it can be seen at all —
    // unless the page did scroll under it. A sticky column taller than the
    // screen holds still until its container ends, so keep going.
    if (next && Math.abs(next.y - box.y) < 4 && !(next.pinned && Math.abs(next.sy - box.sy) >= 4)) {
      return next.y + next.h > 0 && next.y < vp.height ? toBounds(next) : null;
    }
    box = next;
  }
  return box ? toBounds(box) : null;
}

/**
 * Would a click at (x, y) reach the target? False when something else sits on
 * top (a drawer, popup or sticky bar). A close or interactive ancestor on top
 * counts as a hit — a label wrapping its radio, a button wrapping its image —
 * but not a page container showing through where a slider clips the target
 * (isolated world).
 */
export function hitTestInPage(arg: { path: string; x: number; y: number }): boolean | null {
  let el: Element | null = null;
  try {
    el = document.querySelector(arg.path);
  } catch {
    return null;
  }
  if (!el) return null;
  const top = document.elementFromPoint(arg.x, arg.y);
  if (!top) return false;
  if (top === el || el.contains(top)) return true;
  if (!top.contains(el)) return false;
  if (top.matches('label, a, button, summary, [role="button"], [role="radio"], [role="option"], [role="tab"]')) return true;
  let depth = 0;
  for (let n: Element | null = el; n && n !== top; n = n.parentElement) depth++;
  return depth <= 2;
}

async function reachable(page: Page, path: string, box: TargetBounds): Promise<boolean | null> {
  return evaluateIsolated(page, hitTestInPage, { path, x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

/**
 * The overlay sitting on (x, y) — the topmost element's outermost fixed (or
 * high z-index absolute) layer — and its own close control, if it has one.
 * Nothing outside that layer is ever considered (isolated world).
 */
export function overlayAtInPage(arg: { x: number; y: number }): { closer: string | null } | null {
  const top = document.elementFromPoint(arg.x, arg.y);
  if (!top) return null;
  let layer: Element | null = null;
  for (let n: Element | null = top; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.position === "fixed" || (cs.position === "absolute" && Number(cs.zIndex) >= 100)) layer = n;
  }
  // A fixed shell that holds the page's own content is the page, not an overlay.
  if (!layer || layer.querySelector('main, [role="main"], #MainContent')) return null;
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.width >= 6 && r.height >= 6 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== "hidden";
  };
  const byLabel = Array.from(
    layer.querySelectorAll(
      '[aria-label*="close" i], [aria-label*="dismiss" i], [aria-label*="fermer" i], [aria-label*="schlie" i], [aria-label*="cerrar" i], [aria-label*="chiudi" i], [aria-label*="đóng" i], .klaviyo-close-form, button[class*="close" i], [class*="modal__close" i], [data-dismiss], [data-close]',
    ),
  ).find(shown);
  const byText = byLabel
    ? null
    : Array.from(layer.querySelectorAll('button, [role="button"]')).find(
        (b) => shown(b) && /^(×|✕|✖|x|close|no,? thanks|not now|maybe later|dismiss)$/i.test((b.textContent || "").trim()),
      );
  const closer = byLabel || byText;
  if (!closer) return { closer: null };
  const esc = (s: string): string =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  const parts: string[] = [];
  for (let node: Element | null = closer; node && node !== document.documentElement && parts.length < 12; node = node.parentElement) {
    const id = node.getAttribute("id");
    if (id && document.querySelectorAll("#" + esc(id)).length === 1) {
      parts.unshift("#" + esc(id));
      break;
    }
    const cur: Element = node;
    const same = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName) : [];
    parts.unshift(cur.tagName.toLowerCase() + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(cur) + 1) + ")" : ""));
  }
  return { closer: parts.join(" > ") };
}

/**
 * Close the overlay on (x, y) — by default the middle of the screen, where a
 * modal that also locks scrolling sits. Escape first, then the overlay's own
 * close button: what a shopper does, never a blind click into it. True when
 * an overlay was there and is gone.
 */
async function clearOverlay(page: Page, rng: Rng, at?: { x: number; y: number }): Promise<boolean> {
  const vp = viewportOf(page);
  const point = at ?? { x: vp.width / 2, y: vp.height / 2 };
  if (!(await evaluateIsolated(page, overlayAtInPage, point))) return false;
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(rng.int(250, 450));
  const still = await evaluateIsolated(page, overlayAtInPage, point);
  if (!still) return true;
  const closeBox = still.closer ? await boxOfPath(page, still.closer) : null;
  if (!closeBox || !(await new HumanCursor(page, rng).clickBox(closeBox))) return false;
  await sleep(rng.int(450, 900));
  return !(await evaluateIsolated(page, overlayAtInPage, point));
}

/** Scroll a target into view and click it with a human trajectory. */
export async function clickTarget(page: Page, rng: Rng, target: Pick<Target, "path">): Promise<boolean> {
  let box = await scrollIntoComfort(page, rng, target.path);
  // Out of reach: a modal may be locking the page's scroll.
  if (!box && (await clearOverlay(page, rng))) box = await scrollIntoComfort(page, rng, target.path);
  if (!box) return false;
  if ((await reachable(page, target.path, box)) === false) {
    await clearOverlay(page, rng, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    box = await boxOfPath(page, target.path);
    if (!box || (await reachable(page, target.path, box)) === false) return false;
  }
  return new HumanCursor(page, rng).clickBox(box);
}

/** Rest the cursor on a target for `dwellMs`, with the small drift of a reading eye/hand. */
export async function hoverTarget(page: Page, rng: Rng, target: Pick<Target, "path">, dwellMs: number): Promise<boolean> {
  const box = await scrollIntoComfort(page, rng, target.path);
  if (!box) return false;
  const cursor = new HumanCursor(page, rng);
  await cursor.moveTo({ x: box.x + box.width * rng.float(0.3, 0.7), y: box.y + box.height * rng.float(0.3, 0.7) }, box);
  const started = Date.now();
  while (Date.now() - started < dwellMs - 150) {
    const pos = cursor.getPosition();
    const vp = viewportOf(page);
    await cursor
      .moveTo({
        x: Math.max(8, Math.min(vp.width - 8, pos.x + rng.int(-14, 14))),
        y: Math.max(8, Math.min(vp.height - 8, pos.y + rng.int(-9, 9))),
      })
      .catch(() => undefined);
    await sleep(Math.min(dwellMs - (Date.now() - started), rng.int(260, 620)));
  }
  return true;
}
