/**
 * Add-to-cart: execute the click and prove the shop took it.
 *
 * Order of attempts, strongest first:
 *   1. Tier 0/1 — a fresh buy-box scan on the live page (the shop's recipe or
 *      the multi-signal score). The variant comes from the product oracle:
 *      an `available` combination, the current one kept when in stock.
 *   2. Tier 2 — the AI plan's selector, then its form fallback.
 *   3. The generic Shopify chain, role/text match, form.requestSubmit().
 *
 * Verification counts items. /cart.js, a locale cart JSON endpoint, /api/cart,
 * or an explicit "Empty bag" / "N items" label has to rise. A POST, a drawer,
 * or a /cart URL alone does not count. The tier that produced a verified add
 * is written back to the shop's recipe; an unverified one weakens it and
 * escalates the shop's next PDP to Tier 2.
 */
import type { Page } from "rebrowser-playwright";
import type { Logger } from "../logging/logger.js";
import type { Rng } from "../util/random.js";
import { sleep } from "../util/random.js";
import type { AiDecision } from "../types.js";
import { HumanCursor } from "../behavior/humanCursor.js";
import { evaluateIsolated } from "../navigator/isolate.js";
import { detectMultiSignal, planVariantSelection } from "../navigator/multiSignalDetector.js";
import type { DetectionTier, DetectionWaterfall } from "../ai/detectionWaterfall.js";
import { applyVariantStep, openCartDrawer, DRAWER_SELECTORS } from "../behavior/pdpChoreography.js";
import { clickTarget } from "../behavior/humanActions.js";

export interface AtcContext {
  page: Page;
  logger: Logger;
  rng: Rng;
  waterfall?: DetectionWaterfall | null;
}

export interface AtcResult {
  clicked: boolean;
  verified: boolean;
  /** Which evidence confirmed it. */
  how?: string;
  /** Detection tier whose selector made the add. */
  tier?: DetectionTier;
  selector?: string | null;
  variantId?: string | null;
  drawerSelector?: string | null;
  navigated: boolean;
}

/**
 * Dismiss newsletter/geo/consent/REGION overlays that hide or cover buy
 * controls. Escape first, then the usual close affordances, then region/
 * country redirect dialogs (gymshark-class "ARE YOU IN THE RIGHT PLACE?" —
 * the buy box never renders until a region is picked — and MyShopify's
 * auto-redirect banner). Bounded — this is a courtesy pass, not a guarantee.
 */
export async function dismissPopups(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);

  // Age verification acceptance (18+, 21+)
  await page.evaluate(() => {
    const ageButtons = Array.from(document.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], input[type="button"], input[type="submit"]'
    ));
    for (const btn of ageButtons) {
      const text = (btn.innerText || btn.textContent || "").toLowerCase().trim();
      if (/^(i am 21\+|i am 18\+|enter|yes, i am|yes|i agree|agree & enter|over 21|over 18|confirm age)$/i.test(text)) {
        if (btn.offsetParent !== null) { btn.click(); return; }
      }
    }
  }).catch(() => undefined);

  // Cookie consent
  await page.evaluate(() => {
    const consentSels = [
      '#onetrust-accept-btn-handler',
      '#accept-cookies',
      '.cc-btn.cc-allow',
      '[data-testid*="cookie-accept" i]',
      'button[id*="cookie-accept" i]',
      'button[class*="cookie-accept" i]',
    ];
    for (const sel of consentSels) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.offsetParent !== null) { el.click(); break; }
    }
  }).catch(() => undefined);

  const closeSels = [
    '[aria-label*="lose" i]',
    '[aria-label*="close" i]',
    'button[class*="close" i]',
    '[class*="popup"] button',
    '[class*="modal"] button[class*="close" i]',
    '[class*="banner"] [class*="accept"]',
    'div.klaviyo-close-form',
  ];
  for (const sel of closeSels) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        await loc.click({ timeout: 900 }).catch(() => undefined);
        await sleep(250);
      }
    } catch { /* next */ }
  }
  // Region / country pickers: ONLY click inside an active modal/dialog overlay,
  // NEVER click general page links like <a href="/pages/about-us">!
  try {
    const modalRegionSels = [
      '[role="dialog"] button[class*="country" i], [role="dialog"] button[class*="region" i]',
      '[aria-modal="true"] button[class*="country" i], [aria-modal="true"] button[class*="region" i]',
      '[class*="localization" i] button[type="submit"], [class*="country-selector" i] button[type="submit"]',
      '[id*="localization" i] button[type="submit"]',
    ];
    for (const sel of modalRegionSels) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 800 }).catch(() => undefined);
        await sleep(300);
      }
    }
  } catch { /* no region dialog */ }
}

/** Carousel, slider, and promo controls that themes put next to the buy box. */
const DECOY_CONTROL = /splide|swiper-button|slick-|flickity|__arrow|slider-direction|promo-bar-button|carousel__arrow/i;

/** `form[action="/cart"]` and `/world/en/cart` are the bag itself, not an add. */
function isCartPageSelector(selector: string): boolean {
  return /\/cart["']/i.test(selector) && !/cart\/add/i.test(selector);
}

/** Click a selector if a visible match exists with biological trajectory. */
export async function clickBySelector(page: Page, selector: string, rng?: Rng): Promise<boolean> {
  if (DECOY_CONTROL.test(selector) || isCartPageSelector(selector)) return false;
  const specific = /add-to-bag|add-to-cart|product-form__atc|atc-button|data-product-form-atc|cart\/add|\/api\/cart|\[name=.?add/i.test(selector);
  const loc = page.locator(selector);
  const count = Math.min(await loc.count().catch(() => 0), 8);
  for (let i = 0; i < count; i++) {
    const candidate = loc.nth(i);
    const visible = await candidate.isVisible({ timeout: 1500 }).catch(() => false);
    if (!visible) continue;
    const kind = await candidate.evaluate((el) => {
      const blob = `${el.className || ""} ${el.getAttribute("aria-label") || ""} ${el.id || ""} ${(el as HTMLElement).getAttribute("data-testid") || ""}`;
      if (/loading/i.test((el as HTMLElement).getAttribute("data-testid") || "")) return "skip";
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return "skip";
      if (/splide|swiper-button|slick-|flickity|__arrow|slider-direction|promo-bar-button/i.test(blob)) return "skip";
      const form = el.closest("form");
      const action = (form?.getAttribute("action") || "").split("?")[0] || "";
      const label = `${(el as HTMLElement).innerText || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (/^(select( a| your)? size|choose( a)? size)$/i.test(label)) return "skip";
      const addControl = /add to (cart|bag|basket)/i.test(label) || (el.getAttribute("data-testid") || "").toLowerCase() === "add-to-bag" || el.hasAttribute("data-product-form-atc") || /product-form__atc|atc-button/i.test(String((el as HTMLElement).className || ""));
      if (/\/cart\/?$/.test(action) && !/\/cart\/add/.test(action) && !addControl) return "skip";
      const link = el.closest("a");
      if (link && /\/collections\//.test(link.getAttribute("href") || "") && !addControl) return "skip";
      return addControl ? "add" : "plain";
    }).catch(() => "skip");
    if (kind === "skip") continue;
    // A class like button.button--black matches promo buttons as well as the buy box.
    if (kind === "plain" && !specific) continue;
    await candidate.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await sleep(150);

    if (rng) {
      // Click THIS match (not .first(), which may be a hidden duplicate).
      const box = await candidate.boundingBox({ timeout: 2000 }).catch(() => null);
      if (box && (await new HumanCursor(page, rng).clickBox(box))) return true;
    }

    const clicked = await candidate.click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!clicked) {
      const forceClicked = await candidate.click({ force: true, timeout: 2000 }).then(() => true).catch(() => false);
      if (forceClicked) return true;
    } else {
      return true;
    }
  }
  return false;
}

function qtyFromPayload(value: unknown, depth = 0): number | null {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    let sum = 0;
    let saw = false;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as { quantity?: unknown; node?: unknown };
      if (typeof row.quantity === "number") {
        sum += row.quantity;
        saw = true;
        continue;
      }
      const nested = qtyFromPayload(row.node, depth + 1);
      if (nested !== null) {
        sum += nested;
        saw = true;
      }
    }
    return saw ? sum : null;
  }
  if (typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.item_count === "number") return o.item_count;
  if (typeof o.itemCount === "number") return o.itemCount;
  if (typeof o.cartQuantity === "number") return o.cartQuantity;
  if (typeof o.totalQuantity === "number") return o.totalQuantity;
  for (const key of ["cart", "cartLinesAdd", "cartCreate", "lines", "lineItems", "items", "edges", "node", "nodes", "data"]) {
    if (o[key] == null) continue;
    const nested = qtyFromPayload(o[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/** Item count from cart JSON, then an explicit bag label. -1 = unreadable. */
async function readCartCount(page: Page): Promise<number> {
  const probe = async (): Promise<number> => {
    const parse = (value: unknown, depth = 0): number | null => {
      if (depth > 6 || value == null) return null;
      if (Array.isArray(value)) {
        let sum = 0;
        let saw = false;
        for (const item of value) {
          if (!item || typeof item !== "object") continue;
          const row = item as { quantity?: unknown; node?: unknown };
          if (typeof row.quantity === "number") {
            sum += row.quantity;
            saw = true;
            continue;
          }
          const nested = parse(row.node, depth + 1);
          if (nested !== null) {
            sum += nested;
            saw = true;
          }
        }
        return saw ? sum : null;
      }
      if (typeof value !== "object") return null;
      const o = value as Record<string, unknown>;
      if (typeof o.item_count === "number") return o.item_count;
      if (typeof o.itemCount === "number") return o.itemCount;
      if (typeof o.totalQuantity === "number") return o.totalQuantity;
      for (const key of ["cart", "cartLinesAdd", "cartCreate", "lines", "lineItems", "items", "edges", "node", "nodes", "data"]) {
        if (o[key] == null) continue;
        const nested = parse(o[key], depth + 1);
        if (nested !== null) return nested;
      }
      return null;
    };
    const paths = ["/cart.js", "/cart.json", "/api/cart"];
    const head = location.pathname.split("/").filter(Boolean);
    for (let i = 1; i <= Math.min(3, head.length); i++) {
      const pre = "/" + head.slice(0, i).join("/");
      if (/\/(products|collections|pages|search|account)/.test(pre)) continue;
      paths.push(pre + "/cart.js", pre + "/cart.json");
    }
    const product = location.pathname.match(/^(.*)\/products\//);
    if (product && product[1]) paths.push(product[1] + "/cart.js");
    const seen = new Set<string>();
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        const r = await fetch(path, { headers: { accept: "application/json, text/javascript" }, credentials: "same-origin" });
        if (!r.ok) continue;
        const ct = r.headers.get("content-type") || "";
        const text = await r.text();
        const looksCart = /json|javascript/i.test(ct) || text.trim().startsWith("{");
        if (!looksCart) continue;
        const n = parse(JSON.parse(text));
        if (typeof n === "number" && n >= 0) return n;
      } catch {
        /* next endpoint */
      }
    }
    const bits: string[] = [];
    for (const el of Array.from(document.querySelectorAll('header .sr-only, [data-testid*="cart" i] .sr-only, [data-testid*="bag" i] .sr-only, header [aria-label*="bag" i], header [aria-label*="cart" i]'))) {
      bits.push((el.getAttribute("aria-label") || "") + " " + (el.textContent || ""));
    }
    const text = bits.join(" ").replace(/\s+/g, " ");
    if (/empty\s+bag/i.test(text)) return 0;
    const counted = text.match(/(\d+)\s*items?\b/i);
    if (counted) return Number(counted[1]);
    const bagDigit = text.match(/\b(?:bag|cart)\b[^\d]{0,16}(\d{1,2})\b/i);
    if (bagDigit) return Number(bagDigit[1]);
    const mini = document.querySelector(".minicart-qty-value");
    if (mini) {
      const n = parseInt((mini.textContent || "").replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
    const lines = Array.from(document.querySelectorAll('[data-testid="cart-line-item"]')).filter((el) => {
      if (el.closest("template")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (lines.length > 0) return lines.length;
    return -1;
  };
  const isolated = await evaluateIsolated(page, probe);
  if (typeof isolated === "number" && isolated >= 0) return isolated;
  const main = (await page.evaluate(probe).catch(() => -1)) as number;
  if (typeof main === "number" && main >= 0) return main;
  return typeof isolated === "number" ? isolated : -1;
}

function badgeCountInPage(): number {
  const sels = ['[class*="cart-count" i]', '[class*="cart_count" i]', '[class*="CartCount"]', "[data-cart-count]", '[class*="cart" i] [class*="count" i]', '[class*="bag" i] [class*="count" i]', '[aria-label*="cart" i] [class*="count" i]', 'header [class*="badge" i]'];
  let best = 0;
  for (const sel of sels) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const n = parseInt((el.textContent || "").trim().replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(n) && n > best && n < 100) best = n;
    }
  }
  return best;
}

async function readBadgeCount(page: Page): Promise<number> {
  const isolated = await evaluateIsolated(page, badgeCountInPage);
  if (typeof isolated === "number") return isolated;
  return (await page.evaluate(badgeCountInPage).catch(() => 0)) as number;
}

/** A visible quick-add / size-picker modal (never the cart drawer): option + confirm paths. */
function quickAddModalInPage(arg: { drawerSelectors: string[] }): { option: string | null; confirm: string | null } | null {
  const esc = (s: string): string => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s);
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.length < 12) {
      const cur: Element = node;
      const id = cur.getAttribute("id");
      if (id && document.querySelectorAll("#" + esc(id)).length === 1) {
        parts.unshift("#" + esc(id));
        break;
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
  const isDrawer = (el: Element): boolean =>
    arg.drawerSelectors.some((s) => {
      try {
        return !!el.closest(s);
      } catch {
        return false;
      }
    });
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 40 && r.height > 40 && st.display !== "none" && st.visibility !== "hidden";
  };
  const NOT_OPTION = /add|close|cancel|cart|bag|view|check\s*out|checkout|pay|remove|delete|qty|quantity|^[+\-−]$|×|wishlist/i;
  const CONFIRM = /add|ajouter|thêm|hinzuf|añadir|aggiungi|in den/i;
  for (const m of Array.from(document.querySelectorAll('[role="dialog"], [class*="quick-add" i], [id*="quick-add" i], [class*="quick-shop" i], [class*="modal" i], [class*="popover" i]'))) {
    if (!shown(m) || isDrawer(m)) continue;
    const buttons = Array.from(m.querySelectorAll('button:not([disabled]), label, [role="radio"]')).filter(shown);
    const SIZE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|\d{1,2}(?:\.\d)?)$/i;
    const option = buttons.find((b) => {
      const t = (b.textContent || "").trim();
      if (b.closest("nav, header, footer") && !SIZE.test(t) && !b.hasAttribute("data-fs-variant-value") && !b.hasAttribute("data-option-value")) return false;
      return t.length >= 1 && t.length <= 10 && !NOT_OPTION.test(t) && !/sold|disabled|unavailable/i.test(String((b as HTMLElement).className || ""));
    });
    const confirm = buttons.find((b) => CONFIRM.test(b.textContent || "") && !/check\s*out|checkout|pay/i.test(b.textContent || ""));
    if (option || confirm) return { option: option ? pathOf(option) : null, confirm: confirm ? pathOf(confirm) : null };
  }
  return null;
}

/**
 * Extra buy-box steps the main scan misses.
 * `bundle`: Brooklinen keeps the CTA on "Start Building" / "Next" until each component is chosen.
 * `size`: a size portal that only appears after the add button is pressed.
 */
/** True when the buy control is still waiting for a size or pack. */
function variantStillUnselected(): boolean {
  if (document.querySelector("[data-fs-has-selected-variant='false'], [data-option-indeterminate]")) return true;
  const buttons = Array.from(document.querySelectorAll("button"));
  const prompt = /^(select( a| your)? size|choose( a)? size)$/i;
  if (buttons.some((b) => prompt.test((b.textContent || "").replace(/\s+/g, " ").trim()))) return true;
  const sizes = buttons.filter((b) => /select size\s+\d/i.test((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")));
  const picked = sizes.some((b) => b.getAttribute("aria-pressed") === "true" || /\b(selected|is-selected)\b/i.test(String(b.className || "")));
  if (sizes.length > 1 && !picked) return true;
  const textOptions = Array.from(document.querySelectorAll('button[class*="option-button" i], button[data-testid*="text-option" i]'));
  const visibleOptions = textOptions.filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && !(b as HTMLButtonElement).disabled;
  });
  const optionPicked = visibleOptions.some((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /\b(selected|is-selected)\b/i.test(String((b as HTMLElement).className || "")));
  if (visibleOptions.length > 0 && !optionPicked) return true;
  const sizeWord = /^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|\d{1,2})$/i;
  const chips = buttons.filter((b) => {
    const t = (b.textContent || "").replace(/\s+/g, " ").trim();
    if (!sizeWord.test(t) || b.closest("header, footer, nav")) return false;
    const r = b.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && !(b as HTMLButtonElement).disabled;
  });
  const chipPicked = chips.some((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /\b(selected|is-selected)\b/i.test(String((b as HTMLElement).className || "")));
  return chips.length > 1 && !chipPicked;
}

function atcPageStep(kind: "bundle" | "size" | "flavor"): { option: string | null; advance: string | null } | null {
  const pathOf = (el: Element): string => {
    const esc = (s: string): string => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s);
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && parts.length < 12) {
      const cur: Element = node;
      const id = cur.getAttribute("id");
      if (id && document.querySelectorAll("#" + esc(id)).length === 1) {
        parts.unshift("#" + esc(id));
        break;
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
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && st.display !== "none" && st.visibility !== "hidden";
  };
  if (kind === "flavor") {
    const plus = document.querySelector('[data-testid$="-quantity-increase"]');
    const submit = document.querySelector('[data-testid="product-form-add-to-cart"] button, [data-testid="product-form-add-to-cart"]');
    const waiting = !!submit && ((submit as HTMLButtonElement).disabled || /choose flavor/i.test(submit.textContent || ""));
    if (!plus || !shown(plus) || !waiting) return null;
    return { option: pathOf(plus), advance: null };
  }
  if (kind === "bundle") {
    const root = document.querySelector('[data-bundle="true"]');
    if (!root) return null;
    const ADD = /add to (cart|bag|basket)/i;
    const ADVANCE = /^(start building|make selection|next|continue)$/i;
    const buttons = Array.from(root.querySelectorAll("button")).filter((b) => shown(b) && !(b as HTMLButtonElement).disabled);
    const addReady = buttons.some((b) => ADD.test((b.textContent || "").replace(/\s+/g, " ")));
    const advance = addReady ? undefined : buttons.find((b) => ADVANCE.test((b.textContent || "").replace(/\s+/g, " ").trim()));
    const SIZEWORD = /^(xxs|xs|s|m|l|xl|xxl|twin|full|queen|king|cali king|california king)$/i;
    const option = buttons.find((b) => {
      if (b === advance) return false;
      const t = (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g, " ").trim();
      if (!SIZEWORD.test(t) || /size guide|sold out|please select/i.test(t)) return false;
      const picked = b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /\b(selected|is-selected)\b/i.test(String((b as HTMLElement).className || ""));
      return !picked;
    });
    if (!option && !advance) return null;
    return { option: option ? pathOf(option) : null, advance: advance ? pathOf(advance) : null };
  }
  const SIZE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|\d{1,2}(?:\.\d)?|\d{1,2}(?:\.\d)?(?:\s*-\s*\d{1,2}(?:\.\d)?)?\s*(?:in|inch|inches|cm|mm))$/i;
  const selectSize = /select size\s+(\d+(?:\.\d+)?)/i;
  const nodes = Array.from(document.querySelectorAll('button[data-fs-variant-value], button[role="radio"][data-fs-variant-type="Size"], button.product-form__option-button, button[class*="option-button" i], button[data-testid*="text-option" i], [role="radiogroup"] label, [role="radiogroup"] [role="radio"], label:has(input[type="radio"]), [role="listbox"] [role="option"], button'));
  const option = nodes.find((el) => {
    if (!shown(el) || el.closest("header, footer, size-guide")) return false;
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return false;
    if (el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") return false;
    if (/unavailable|sold-out|soldout/i.test(String((el as HTMLElement).className || ""))) return false;
    const raw = (el.getAttribute("data-fs-variant-value") || el.getAttribute("data-option-value") || el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
    const named = raw.match(selectSize);
    const label = named ? named[1] : raw;
    const choice = el.matches('label, [role="radio"]') || !!el.closest('[role="radiogroup"]');
    const word = /^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl|small|medium|large|x-small|x-large|xx-large|\d{1,2}(?:\.\d)?|\d{1,2}(?:\.\d)?(?:\s*-\s*\d{1,2}(?:\.\d)?)?\s*(?:in|inch|inches|cm|mm))$/i;
    return (choice ? word : SIZE).test(label);
  });
  if (option) return { option: pathOf(option), advance: null };
  const opener = document.querySelector("[data-option-indeterminate], button[role='combobox'][aria-label='Size']");
  return opener && shown(opener) ? { option: null, advance: pathOf(opener) } : null;
}

/** The oracle already named an in-stock variant, but the visible size control did not take the click. */
function pinVariantInPage(arg: { variantId: string; labels: string[] }): boolean {
  const want = arg.labels
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((s) => s.length > 0 && s.length <= 40);
  const forms = Array.from(document.querySelectorAll('form[action*="cart/add" i], form[action*="Cart-AddProduct"]'));
  const root = forms[0] || document.querySelector("product-form") || document.querySelector("#shopify-section-static-product-react form");
  if (!root) return false;
  let picked = false;
  const seenNames = new Set<string>();
  const radios = Array.from(root.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
  for (const label of want) {
    const input = radios.find((r) => {
      if (r.disabled || r.getAttribute("aria-disabled") === "true" || seenNames.has(r.name)) return false;
      const lab = (r.labels && r.labels[0]) || r.closest("label");
      const text = ((lab && lab.textContent) || "").replace(/\s+/g, " ").trim().toLowerCase();
      return text === label || r.value.trim().toLowerCase() === label;
    });
    if (!input) continue;
    seenNames.add(input.name);
    input.click();
    picked = true;
  }
  const idEl = root.querySelector('input[name="id"], select[name="id"]') as HTMLInputElement | HTMLSelectElement | null;
  if (idEl && /^\d+$/.test(arg.variantId)) {
    const proto = idEl.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(idEl, arg.variantId);
    else idEl.value = arg.variantId;
    idEl.dispatchEvent(new Event("input", { bubbles: true }));
    idEl.dispatchEvent(new Event("change", { bubbles: true }));
    picked = true;
  }
  return picked;
}

/**
 * Execute an add_to_cart decision. A failure is silent by design: the visit
 * keeps browsing exactly as if no cart was ever touched.
 */
export async function executeAddToCart(decision: AiDecision, ctx: AtcContext): Promise<AtcResult> {
  const { page, logger, rng } = ctx;
  const none: AtcResult = { clicked: false, verified: false, navigated: false };

  // The plan was prepared for a specific product page; the visitor may
  // have wandered since. Go back to that page before pressing anything.
  if (decision.url) {
    try {
      const target = new URL(decision.url);
      if (target.pathname !== new URL(page.url()).pathname) {
        logger.info("atc_return", "returning to planned product page", { data: { url: decision.url } });
        await page.goto(decision.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await sleep(rng.int(1800, 2800));
      }
    } catch { /* malformed target — click where we are */ }
  }

  const plan = decision.plan;
  const aiSelector = plan?.addToCart?.selector ?? decision.targetElement?.selector ?? "";

  // Golden evidence, network layer: (1) POST /cart/add(.js) — the Shopify
  // standard; (2) any cart-ish POST — custom stacks; (3) small POST bodies
  // that look like a cart mutation — headless/GraphQL stacks hide them.
  let addHit = false;
  let networkQty: number | null = null;
  let cartBodyHint = "";
  const bodyChecks: Array<Promise<void>> = [];
  const noteCartBody = (t: string): void => {
    if (/cart(id|line|_count)|"item_count"|CartLine|AddedToCart|merchandiseId|cartLinesAdd|cartCreate|checkoutCreate|"quantity"\s*:\s*[1-9]|"totalQuantity"\s*:\s*[1-9]|"subtotalPrice"/i.test(t)) {
      addHit = true;
    }
    let best: number | null = null;
    try {
      best = qtyFromPayload(JSON.parse(t));
    } catch { /* HTML, a stream, or an empty body */ }
    for (const match of t.matchAll(/(?:totalQuantity|itemCount|item_count)\\?"\s*:\s*(\d+)/g)) {
      const n = Number(match[1]);
      if (best === null || n > best) best = n;
    }
    if (best !== null && best >= 0) networkQty = best;
    if (networkQty === null && !cartBodyHint) {
      try {
        const parsed = JSON.parse(t) as unknown;
        cartBodyHint = parsed && typeof parsed === "object" ? Object.keys(parsed as object).slice(0, 12).join(",") : "non-json";
      } catch {
        cartBodyHint = "non-json";
      }
    }
  };
  const onResponse = (resp: { url(): string; status(): number; request(): { method(): string; headers(): Record<string, string> }; text(): Promise<string> }): void => {
    try {
      const u = resp.url();
      if (resp.status() >= 400) return;
      const method = resp.request().method().toUpperCase();
      const cartWrite = /\/cart\/add(\.js)?|cart[_-]?add|add[_-]?to[_-]?cart|add[_-]?item|\/api\/.*\/cart/i.test(u) && (method === "POST" || method === "PUT");
      if (cartWrite) addHit = true;
      if (method !== "POST" && method !== "PUT") return;
      if (!cartWrite && !/cart|graphql|api|checkout|storefront|lines|items/i.test(u)) return;
      const lenStr = resp.request().headers()["content-length"] ?? "0";
      if (Number(lenStr) > 120_000) return;
      bodyChecks.push(resp.text().then(noteCartBody).catch(() => undefined));
    } catch { /* response may be gone */ }
  };

  page.on("response", onResponse);
  let before = -1;
  let after = -1;
  let clicks = 0;
  let drawerBefore = false;
  let drawerSelector: string | null = null;
  let badgeBefore = 0;
  let badgeCount = 0;
  let usedTier: DetectionTier | undefined;
  let usedSelector: string | null = null;
  let variantId: string | null = null;
  let variantSource = "";
  const url = page.url();

  try {
    before = await readCartCount(page);
    badgeBefore = await readBadgeCount(page);
    drawerBefore = !!(await openCartDrawer(page));

    // Overlays first — a newsletter modal above the buy box eats clicks.
    await dismissPopups(page);
    if (before === -1) {
      logger.warn("atc_cart_unreadable", "no cart JSON or bag label yet", { data: { url } });
    }

    // ── Tier 0/1: the buy box as it is right now ──
    const recipe = ctx.waterfall?.recipes.get(url, "product");
    const threshold = ctx.waterfall?.threshold ?? 0.8;
    const escalated = ctx.waterfall?.isEscalated(url) ?? false;
    let scan = await detectMultiSignal(page, { recipe }).catch(() => null);
    if (scan?.atc?.disabled) {
      await sleep(rng.int(1000, 1600));
      scan = (await detectMultiSignal(page, { recipe }).catch(() => null)) ?? scan;
    }
    const scanTier: DetectionTier = scan?.recipeMatched ? 0 : 1;

    // ── Variant: an in-stock combination, from the oracle when it has stock ──
    const vplan = scan ? planVariantSelection(scan, rng, { preferCurrent: true }) : null;
    if (vplan && vplan.steps.length) {
      variantId = vplan.variantId;
      variantSource = vplan.source;
      const pendingSteps = vplan.steps.filter((s) => !s.option.checked);
      let variantClicks = 0;
      for (const step of vplan.steps) {
        if (step.option.checked) continue;
        const beforeStep = page.url();
        if (await applyVariantStep(page, rng, step)) {
          clicks++;
          variantClicks++;
        }
        await sleep(rng.int(350, 850));
        if (page.url() !== beforeStep) await page.waitForLoadState("domcontentloaded", { timeout: 12_000 }).catch(() => undefined);
      }
      if (variantId && variantClicks < pendingSteps.length) {
        const labels = pendingSteps.map((s) => s.option.label || s.option.value).filter((s) => !!s);
        const pinned = await evaluateIsolated(page, pinVariantInPage, { variantId, labels });
        if (pinned) {
          clicks++;
          logger.debug("atc_variant_pin", "set the product form to the in-stock variant", { data: { variantId, labels } });
        }
      }
      logger.debug("atc_variant", `${vplan.source}: ${vplan.steps.map((s) => `${s.group.name}=${s.option.label || s.option.value}`).join(", ")}`, { data: { variantId } });
      if (clicks > 0) {
        await sleep(rng.int(400, 900));
        scan = (await detectMultiSignal(page, { recipe, fetchProductJs: false }).catch(() => null)) ?? scan;
      }
    } else {
      // No operable groups found by Tier 1: fall back to the AI plan's groups.
      const groups = plan?.variants?.length ? [...plan.variants].slice(0, 2) : [];
      for (const g of groups) {
        if (!g.options.length) continue;
        const pick = g.options[Math.floor(rng.float(0, g.options.length)) % g.options.length];
        if (!pick) continue;
        if (await clickBySelector(page, pick, rng)) clicks++;
        await sleep(rng.int(350, 850));
      }
    }

    // A bundle CTA is not an add until each component has been chosen.
    for (let step = 0; step < 4; step++) {
      const bundle = await evaluateIsolated(page, atcPageStep, "bundle");
      if (!bundle) break;
      if (bundle.option && (await clickTarget(page, rng, { path: bundle.option }))) clicks++;
      await sleep(rng.int(350, 700));
      if (bundle.advance && (await clickTarget(page, rng, { path: bundle.advance }))) clicks++;
      await sleep(rng.int(500, 900));
      logger.debug("atc_bundle_step", "advanced a bundle component", { data: { step } });
    }

    const flavor = await evaluateIsolated(page, atcPageStep, "flavor");
    if (flavor?.option && (await clickTarget(page, rng, { path: flavor.option }))) {
      clicks++;
      await sleep(rng.int(400, 800));
      logger.debug("atc_flavor", "raised a flavor before add-to-cart");
    }

    // A closed size list or a "Select A Size" prompt has to be resolved before the add.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await evaluateIsolated(page, variantStillUnselected))) break;
      const size = await evaluateIsolated(page, atcPageStep, "size");
      if (!size) break;
      if (size.advance && (await clickTarget(page, rng, { path: size.advance }))) clicks++;
      await sleep(rng.int(300, 600));
      const opened = size.option ? size : await evaluateIsolated(page, atcPageStep, "size");
      if (opened?.option && (await clickTarget(page, rng, { path: opened.option }))) clicks++;
      await sleep(rng.int(400, 800));
      logger.debug("atc_size_first", "chose a size before add-to-cart", { data: { attempt } });
    }
    if (clicks > 0) {
      scan = (await detectMultiSignal(page, { recipe, fetchProductJs: false }).catch(() => null)) ?? scan;
    }

    // ── Main add-to-cart click, strongest tier first ──
    let clickedMain = false;
    const tierAtc = scan?.atc ?? null;
    const tierConfident = !!scan && !escalated && (scan.confidence >= threshold || scan.recipeMatched);
    if (tierAtc && tierConfident && !tierAtc.disabled && (await clickTarget(page, rng, { path: tierAtc.path }))) {
      clickedMain = true;
      clicks++;
      usedTier = scanTier;
      usedSelector = tierAtc.general;
      logger.debug("atc_tier_click", `tier${scanTier} ${tierAtc.selector} (confidence ${scan?.confidence})`);
    }
    if (!clickedMain && aiSelector) {
      await page.waitForSelector(aiSelector, { timeout: 8_000 }).catch(() => undefined);
      if (await clickBySelector(page, aiSelector, rng)) {
        clickedMain = true;
        clicks++;
        usedTier = 2;
        usedSelector = aiSelector;
      } else {
        logger.debug("add_to_cart_invisible", "Add-to-cart control not visible", { data: { url: page.url(), selector: aiSelector } });
      }
    }
    if (!clickedMain && plan?.formSelector) {
      await page.waitForSelector(plan.formSelector, { timeout: 4000 }).catch(() => undefined);
      if (await clickBySelector(page, plan.formSelector, rng)) {
        clickedMain = true;
        clicks++;
        usedTier = 2;
        usedSelector = plan.formSelector;
        logger.debug("atc_form_click", "AI form fallback: " + plan.formSelector);
      }
    }
    if (!clickedMain && tierAtc && !tierAtc.disabled && (await clickTarget(page, rng, { path: tierAtc.path }))) {
      // An unconfident Tier 1 pick still beats the generic chain.
      clickedMain = true;
      clicks++;
      usedTier = 1;
      usedSelector = tierAtc.general;
    }

    const pathIsProduct = /\/products\/|\/product\//.test((() => { try { return new URL(page.url()).pathname; } catch { return ""; } })());
    const buyBox = await evaluateIsolated(page, () =>
      !!document.querySelector('form[action*="Cart-AddProduct"], [data-test-id="add-to-cart-button"], [data-testid="product-form-add-to-cart"], button.buy__add, button.product__cta, button.add-to-cart-button'),
    );
    const onProduct = pathIsProduct || !!buyBox;
    if (!clickedMain && !onProduct) {
      logger.info("atc_not_on_product", "refusing the generic add chain off a product page", { url: page.url() });
    }
    if (!clickedMain && onProduct) {
      const generic = [
        '[data-testid="add-to-bag"]',
        '[data-testid="add-to-bag-button"]',
        '[data-testid$="addToBag-submit"]',
        '[data-test-id="add-to-cart-button"]',
        '[data-testid="product-form-add-to-cart"] button',
        "button.buy__add",
        "button.product__cta",
        "button.add-to-cart-button",
        'form[action*="Cart-AddProduct"] button[name="add"]',
        "#add-to-cart",
        "#btnAddToBag",
        "button[data-kit-promo-primary]",
        "button[data-product-form-atc]",
        "button.product-form__atc",
        'form[action*="/api/cart"] button[aria-label*="add" i]',
        'form[action*="/cart/add"] [type="submit"]',
        'form[action*="/cart/add"] [name="add"]',
        'form[action*="/cart/add"] button',
        'product-form form [type="submit"]',
        'product-form form button[name="add"]',
        'product-form button[type="submit"]',
        'form#AddToCartForm [type="submit"]',
        '[data-action="add-to-cart"]',
        '[data-add-to-cart]',
        '[data-testid*="add-to-cart" i]',
        '[data-test*="add-to-cart" i]',
        'button[class*="add-to-cart" i]',
        'button[class*="AddToCart" i]',
        'button[id*="add-to-cart" i]',
        '[id*="AddToCart" i]',
        ".product-form__submit",
        '[class*="sticky-atc" i] button',
        '[class*="sticky-cart" i] button',
        '[data-sticky-add-to-cart] button',
        '[name="add"]',
        'button[name="add"]',
        'input[name="add"]',
        'button[aria-label*="Add to cart" i]',
        'button[aria-label*="Add to bag" i]',
      ];
      for (let pass = 0; pass < 2 && !clickedMain; pass++) {
        if (pass === 1) await sleep(2500);
        await dismissPopups(page);
        for (const sel of generic) {
          const loc = page.locator(sel).first();
          if (!(await loc.isVisible({ timeout: 1000 }).catch(() => false))) continue;
          if (await loc.isDisabled({ timeout: 600 }).catch(() => true)) continue;
          await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
          if (!(await clickBySelector(page, sel, rng))) continue;
          clickedMain = true;
          clicks++;
          usedTier = 1;
          usedSelector = sel;
          logger.debug("atc_generic_click", "fallback clicked: " + sel);
          break;
        }
        if (!clickedMain) {
          const byText = page.getByRole("button", { name: /add to cart|add to bag|buy now|thêm vào giỏ|ajouter au panier|in den warenkorb/i }).first();
          if (await byText.isVisible({ timeout: 1000 }).catch(() => false)) {
            await byText.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
            await byText.click({ timeout: 4000 }).catch(() => {});
            clickedMain = true;
            clicks++;
            usedTier = 1;
            logger.debug("atc_text_click", "fallback clicked by text");
          }
        }
      }

      // Last resort: native form.requestSubmit()
      if (!clickedMain) {
        const formSubmitted = await page.evaluate(() => {
          const form = document.querySelector<HTMLFormElement>('form[action*="/cart/add"], form[action*="Cart-AddProduct"], form[action*="/api/cart"], product-form form, form#AddToCartForm');
          if (form) {
            const submitBtn = form.querySelector<HTMLElement>('button[type="submit"]:not([class*="splide" i]):not([class*="arrow" i]), [name="add"], button:not([class*="splide" i]):not([class*="arrow" i])');
            if (typeof form.requestSubmit === "function") {
              form.requestSubmit(submitBtn as HTMLButtonElement);
              return true;
            } else if (submitBtn) {
              submitBtn.click();
              return true;
            }
          }
          return false;
        }).catch(() => false);
        if (formSubmitted) {
          clickedMain = true;
          clicks++;
          usedTier = 1;
          logger.debug("atc_form_request_submit", "Fallback triggered via form.requestSubmit()");
        }
      }
    }

    // A cart POST can be an empty LinesAdd. Open the size list when no size is selected yet.
    await sleep(rng.int(1000, 1800));
    const stillNeedsVariant = !!(await evaluateIsolated(page, variantStillUnselected));
    // An empty LinesAdd still matches the cart POST. That is not a size selection.
    if (clickedMain && (!addHit || stillNeedsVariant)) {
      const modal = await evaluateIsolated(page, quickAddModalInPage, { drawerSelectors: DRAWER_SELECTORS });
      const portal = modal?.option ? null : await evaluateIsolated(page, atcPageStep, "size");
      const optionPath = modal?.option ?? portal?.option ?? null;
      let picked = false;
      if (optionPath && (await clickTarget(page, rng, { path: optionPath }))) {
        clicks++;
        picked = true;
      }
      await sleep(rng.int(400, 900));
      if (modal?.confirm && (await clickTarget(page, rng, { path: modal.confirm }))) clicks++;
      else if (picked && usedSelector && (await clickBySelector(page, usedSelector, rng))) clicks++;
      if (optionPath) {
        logger.debug("atc_modal_handled", "Handled quick-add/size picker", { data: { option: optionPath, confirm: modal?.confirm ?? usedSelector } });
        await sleep(rng.int(1800, 2600));
      }
    }

    // Drain in-flight network bodies
    await sleep(rng.int(2200, 3400));
    if (bodyChecks.length) await Promise.race([Promise.all(bodyChecks), sleep(1500)]);

    drawerSelector = clicks > 0 ? await openCartDrawer(page, ctx.waterfall?.recipes.get(url, "product")?.cartDrawer) : null;
    after = clicks > 0 ? await readCartCount(page) : before;
    if (clicks > 0 && networkQty !== null && before >= 0 && networkQty > after) after = networkQty;
    if (clicks > 0 && networkQty !== null && before < 0 && after < 0 && networkQty > 0) after = networkQty;
    badgeCount = clicks > 0 ? await readBadgeCount(page) : badgeBefore;
  } finally {
    page.off("response", onResponse);
  }

  if (!clicks) {
    logger.debug("atc_noop", "nothing clickable — visit continues", { url: page.url() });
    return none;
  }

  const landedOnCart = /\/cart(\?|$)/.test(page.url());
  const cartCountIncreased = before >= 0 && after > before;
  const becameReadable = before < 0 && after > 0;
  // A network hint, an opened drawer, or a cart URL is not enough. The item
  // count has to rise. An unreadable count that stays unreadable is not a success.
  const verified = cartCountIncreased || becameReadable;
  const tier: DetectionTier = usedTier ?? 1;

  if (verified) {
    const how = cartCountIncreased ? "cart.js" : "cart.js";
    logger.info("atc_success", `add-to-cart verified via ${how}: ${before} -> ${after} items (tier${tier}${variantSource ? `, variant ${variantSource}` : ""})`, {
      url: page.url(),
      data: { selector: usedSelector ?? "", tier, variantId, variantSource },
    });
    ctx.waterfall?.noteAtcSuccess(url, { tier, selector: usedSelector, cartDrawer: drawerSelector });
    return { clicked: true, verified: true, how, tier, selector: usedSelector, variantId, drawerSelector, navigated: landedOnCart };
  }

  logger.warn("atc_unverified", `clicked but unconfirmed (net=${addHit}, cart ${before} -> ${after}) — continuing browse`, {
    url: page.url(),
    data: { selector: usedSelector ?? "", tier, networkQty, cartBodyHint },
  });
  ctx.waterfall?.noteAtcFailure(url, { tier, selector: usedSelector });
  return { clicked: true, verified: false, tier, selector: usedSelector, variantId, drawerSelector: null, navigated: landedOnCart };
}
