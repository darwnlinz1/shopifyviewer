/**
 * Tier 1 of the detection waterfall: find the buy box from four invariants
 * that hold across themes, without asking the AI.
 *
 *   1. Platform data oracle — the product JSON a Shopify theme ships for its
 *      own variant picker (`<script type="application/json">`, JSON-LD offers,
 *      the inline ShopifyAnalytics meta, or `/products/<handle>.js`). It lists
 *      every variant id, its option values and whether it is `available`, so
 *      in-stock combinations are known instead of guessed from CSS classes.
 *   2. HTML5 form contract — `form[action*="/cart/add"]`, `input[name="id"]`,
 *      `button[name="add"]`, `form="product-form-…"`, `<product-form>`,
 *      `<variant-radios>`, `[data-pf-type="ProductATC"]`.
 *   3. Accessibility tree — role=button / radiogroup / radio, aria-checked,
 *      aria-disabled.
 *   4. Buy-box geometry — the main add-to-cart sits below the product title
 *      and price, 160–580px wide and 38–72px tall, visible; express-pay
 *      buttons, quick-adds in recommendation cards, header/footer controls
 *      and hidden mobile duplicates are excluded.
 *
 * The scan runs in Playwright's utility world: it reads the DOM the page
 * renders but never touches the page's own JS realm (main-world globals such
 * as window.ShopifyAnalytics are read from their inline script text instead).
 * Scoring happens in Node from the raw signals, so it is a pure function.
 */
import type { Page } from "rebrowser-playwright";
import { evaluateIsolated } from "./isolate.js";
import { DomainRecipeCache, type DomainSelectorRecipe, type RecipePageType } from "../ai/domainRecipeCache.js";
import type { Rng } from "../util/random.js";

// ─────────────────────────────────────────────────────────────────────
// Raw scan (what the page reports)
// ─────────────────────────────────────────────────────────────────────

export interface RawRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawControl extends RawRect {
  /** Exact path to this element on this page. */
  path: string;
  /** A selector that should find the same control on other pages of the shop. */
  general: string | null;
  tag: string;
  type: string;
  name: string;
  text: string;
  role: string;
  vis: boolean;
  disabled: boolean;
  inCartForm: boolean;
  formAttrCart: boolean;
  formHasIdInput: boolean;
  inProductForm: boolean;
  dataAtc: boolean;
  classHint: boolean;
  textAtc: boolean;
  textBuyNow: boolean;
  textPreorder: boolean;
  textSoldOut: boolean;
  checkoutish: boolean;
  isExpress: boolean;
  inHeader: boolean;
  inFooter: boolean;
  inRelated: boolean;
  inQuickAdd: boolean;
  inForeignCard: boolean;
  inDrawer: boolean;
  inSticky: boolean;
  inDialog: boolean;
  matchesRecipe: boolean;
}

export interface RawVariantOption {
  value: string;
  label: string;
  /** Clickable element (label/button/radio); null for <select> options. */
  path: string | null;
  available: boolean;
  checked: boolean;
}

export interface RawVariantGroup {
  kind: "select" | "radio" | "button";
  name: string;
  path: string;
  general: string | null;
  /** The theme's own `select[name="id"]` (values are variant ids). */
  isVariantId: boolean;
  visible: boolean;
  options: RawVariantOption[];
}

export interface RawBuyBoxScan {
  url: string;
  path: string;
  title: string;
  viewport: { w: number; h: number };
  scrollY: number;
  h1: (RawRect & { text: string }) | null;
  price: (RawRect & { text: string }) | null;
  controls: RawControl[];
  variantGroups: RawVariantGroup[];
  selectedVariantId: string | null;
  oracle: { productJson: string[]; ldJson: string[]; analyticsMeta: string | null };
  productCards: { selector: string | null; count: number; linkCount: number };
  /** thumbs / arrow: controls to click; stack: photos stacked beside the buy box, viewed by scrolling. */
  gallery: { selector: string; count: number; kind: "thumbs" | "arrow" | "stack" } | null;
  sections: { selector: string; count: number } | null;
  cartDrawer: string | null;
  scanMs: number;
}

export interface BuyBoxScanArg {
  recipeAtc?: string | null;
  recipeCard?: string | null;
}

/**
 * In-page signal collector. Serialized into the utility world, so it must
 * stay self-contained: no imports, no closures over module scope.
 */
export function collectBuyBoxSignals(arg: BuyBoxScanArg): RawBuyBoxScan {
  const t0 = performance.now();
  const doc = document;
  const sx = window.scrollX || 0;
  const sy = window.scrollY || 0;
  const norm = (s: string | null | undefined): string => (s || "").replace(/\s+/g, " ").trim();
  const esc = (s: string): string =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const anyEl = el as unknown as { checkVisibility?: (o: object) => boolean };
    if (typeof anyEl.checkVisibility === "function") {
      return anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && parseFloat(st.opacity || "1") >= 0.05;
  };
  const rectOf = (el: Element): { x: number; y: number; w: number; h: number } => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // getAttribute, not .id: a form holding <input name="id"> returns that input from form.id.
  const idOf = (el: Element): string => el.getAttribute("id") || "";
  const uniqueId = (el: Element): boolean => {
    const id = idOf(el);
    if (!id) return false;
    try {
      return doc.querySelectorAll("#" + esc(id)).length === 1;
    } catch {
      return false;
    }
  };
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== doc.documentElement && parts.length < 12) {
      const cur: Element = node;
      if (uniqueId(cur)) {
        parts.unshift("#" + esc(idOf(cur)));
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
  const firstVisible = (sel: string): Element | null => {
    try {
      for (const e of Array.from(doc.querySelectorAll(sel))) if (visible(e)) return e;
    } catch {
      /* invalid selector from a stale recipe */
    }
    return null;
  };
  const countVisible = (sel: string, skip: string): number => {
    let n = 0;
    try {
      for (const e of Array.from(doc.querySelectorAll(sel))) {
        if (n > 60) break;
        if (visible(e) && !e.closest(skip)) n++;
      }
    } catch {
      return 0;
    }
    return n;
  };

  const ATC =
    /\b(add|adding)\b[^.|]{0,25}\b(cart|bag|basket|trolley|tote|order)\b|ajouter au panier|in den warenkorb|aggiungi al carrello|a[ñn]adir al carrito|agregar al carrito|toevoegen aan winkel|l[äa]gg i varukorgen|dodaj do koszyka|adicionar ao carrinho|カートに|加入购物车|加入購物車|장바구니|thêm vào giỏ|thêm giỏ hàng/i;
  const BUY_NOW = /\bbuy\s*(it\s*)?now\b|acheter maintenant|jetzt kaufen|comprar ahora|mua ngay/i;
  const PREORDER = /\bpre-?order\b|précommande|precommande|vorbestellen|đặt trước/i;
  const SOLDOUT = /sold\s*out|out\s*of\s*stock|unavailable|épuisé|ausverkauft|agotado|esaurito|hết\s*hàng|tạm\s*hết|notify me|back in stock/i;
  const CHECKOUTISH = /check\s*out|thanh toán|paiement|zur kasse|\bpay\b/i;
  const EXPRESS_TEXT = /shop\s*pay|paypal|apple\s*pay|google\s*pay|\bg\s*pay\b|amazon\s*pay|buy with|klarna|afterpay|venmo|more payment options/i;
  const EXPRESS_SEL =
    '.shopify-payment-button, [data-shopify="payment-button"], shopify-accelerated-checkout, shopify-buy-it-now-button, [class*="dynamic-checkout" i], [class*="payment-button" i], [class*="express-checkout" i], [class*="shop-pay" i], [class*="paypal" i], [class*="apple-pay" i], [class*="gpay" i], [id*="paypal" i]';
  const HEADER_SEL = 'header, [role="banner"], #shopify-section-header, [class*="site-header" i], [class*="announcement" i]';
  const FOOTER_SEL = 'footer, [role="contentinfo"], #shopify-section-footer, [class*="site-footer" i]';
  const RELATED_SEL =
    '[class*="related" i], [class*="recommend" i], [class*="upsell" i], [class*="cross-sell" i], [class*="crosssell" i], [class*="you-may" i], [class*="recently" i], [class*="complementary" i], product-recommendations, [id*="recommend" i], [id*="related" i]';
  const QUICK_SEL =
    '[class*="quick-add" i], [class*="quickadd" i], [class*="quick-shop" i], [class*="quickshop" i], [class*="quick-view" i], [class*="quickview" i], quick-add-modal, [id*="quick-add" i]';
  const DRAWER_SEL =
    'cart-drawer, cart-notification, #CartDrawer, [class*="cart-drawer" i], [id*="cart-drawer" i], [class*="mini-cart" i], [class*="minicart" i], [class*="side-cart" i], [class*="cart-flyout" i], [class*="drawer--cart" i], [id*="CartNotification" i]';
  const PRODUCT_FORM_SEL = 'product-form, [data-product-form], form[action*="/cart/add"], buy-buttons, [data-type="add-to-cart-form"]';
  const CARD_SEL =
    '[class*="card" i], [class*="product-item" i], [class*="product-tile" i], [class*="grid__item" i], [class*="product-grid-item" i], li, article';

  const here = location.pathname.replace(/\/+$/, "");
  const productTail = (p: string): string => {
    const i = p.indexOf("/products/");
    return i >= 0 ? p.slice(i) : p;
  };
  const inForeignCard = (el: Element): boolean => {
    const card = el.closest(CARD_SEL);
    if (!card) return false;
    const a = card.querySelector('a[href*="/products/"]') as HTMLAnchorElement | null;
    if (!a) return false;
    try {
      const p = new URL(a.href, location.href).pathname.replace(/\/+$/, "");
      return productTail(p) !== productTail(here);
    } catch {
      return false;
    }
  };
  const inSticky = (el: Element): boolean => {
    let node: Element | null = el;
    for (let i = 0; node && i < 7; i++) {
      const pos = getComputedStyle(node).position;
      if (pos === "fixed" || pos === "sticky") return true;
      if (/sticky/i.test(String((node as HTMLElement).className || ""))) return true;
      node = node.parentElement;
    }
    return false;
  };
  const generalOf = (el: Element): string | null => {
    const tag = el.tagName.toLowerCase();
    const cands: string[] = [];
    const ownId = idOf(el);
    if (ownId && !/\d{3,}/.test(ownId)) cands.push("#" + esc(ownId));
    const name = el.getAttribute("name");
    const form = el.closest("form");
    const action = form ? form.getAttribute("action") || "" : "";
    if (name && /\/cart\/add/.test(action)) cands.push('form[action*="/cart/add"] ' + tag + '[name="' + name + '"]');
    for (const a of ["data-add-to-cart", "data-pf-type", "data-testid", "data-test", "data-action", "data-qa", "data-hook"]) {
      const v = el.getAttribute(a);
      if (v === null || v.length > 60 || /\d{4,}/.test(v) || /["\\]/.test(v)) continue;
      cands.push(v ? tag + "[" + a + '="' + v + '"]' : tag + "[" + a + "]");
    }
    const classes = Array.from(el.classList).filter(
      (c) => c.length > 2 && c.length < 48 && !/\d{3,}/.test(c) && !/^(js-|is-|has-|active$|disabled$|loading|hidden|button$|btn$)/i.test(c),
    );
    for (const c of classes.slice(0, 5)) cands.push(tag + "." + esc(c));
    if (name) cands.push(tag + '[name="' + name + '"]');
    const type = (el as HTMLButtonElement).type;
    if (type === "submit" && /\/cart\/add/.test(action)) cands.push('form[action*="/cart/add"] [type="submit"]');
    const pf = el.closest("product-form, buy-buttons");
    if (pf && type === "submit") cands.push(pf.tagName.toLowerCase() + ' [type="submit"]');
    for (const sel of cands) if (firstVisible(sel) === el) return sel;
    return null;
  };

  // ── h1 + price: the anchors of buy-box geometry ──
  let h1El: Element | null =
    Array.from(doc.querySelectorAll("h1")).find((e) => visible(e) && !e.closest(HEADER_SEL) && norm(e.textContent).length > 1) || null;
  if (!h1El) {
    h1El =
      Array.from(
        doc.querySelectorAll('[class*="product__title" i], [class*="product-title" i], [class*="product_title" i], [itemprop="name"]'),
      ).find((e) => visible(e) && !e.closest(HEADER_SEL)) || null;
  }
  const h1 = h1El ? { ...rectOf(h1El), text: norm(h1El.textContent).slice(0, 120) } : null;
  const priceEls = Array.from(
    doc.querySelectorAll('[class*="price" i]:not([class*="compare" i]), [data-product-price], [itemprop="price"]'),
  ).filter(
    (e) =>
      visible(e) &&
      /\d/.test(e.textContent || "") &&
      !e.closest(RELATED_SEL + "," + QUICK_SEL + "," + HEADER_SEL + "," + FOOTER_SEL + "," + DRAWER_SEL) &&
      !inForeignCard(e),
  );
  let priceEl: Element | null = priceEls[0] || null;
  if (h1 && priceEls.length > 1) {
    let best = Infinity;
    for (const e of priceEls.slice(0, 30)) {
      const d = Math.abs(rectOf(e).y - h1.y);
      if (d < best) {
        best = d;
        priceEl = e;
      }
    }
  }
  const price = priceEl ? { ...rectOf(priceEl), text: norm(priceEl.textContent).slice(0, 40) } : null;

  // ── Layer 2/3/4 candidates: buttons that could be the add-to-cart ──
  const recipeEl = arg && arg.recipeAtc ? firstVisible(arg.recipeAtc) : null;
  const controls: RawControl[] = [];
  let generalBudget = 10;
  // Mega-menus can hold hundreds of controls ahead of the buy box in document
  // order, so chrome is skipped before anything is counted, not after a cut.
  const nodes = Array.from(
    doc.querySelectorAll(
      'button, input[type="submit"], input[type="button"], [role="button"], a[class*="cart" i], a[class*="buy" i], [data-add-to-cart], [data-pf-type="ProductATC"]',
    ),
  );
  let examined = 0;
  for (const el of nodes) {
    if (controls.length >= 40 || examined >= 900) break;
    if (el !== recipeEl && el.closest('header, nav, [role="navigation"], footer, [role="contentinfo"]')) continue;
    examined++;
    const h = el as HTMLElement;
    const text = norm(h.innerText || (h as HTMLInputElement).value || h.getAttribute("aria-label") || h.textContent || "").slice(0, 80);
    const idcls = (idOf(h) + " " + (h.getAttribute("class") || "")).toLowerCase();
    const form = h.closest("form");
    const action = form ? form.getAttribute("action") || "" : "";
    const actionPath = action.split("?")[0] || "";
    const testId = (h.getAttribute("data-testid") || "").toLowerCase();
    // A cart-page form (`/cart`, `/world/en/cart`) updates a bag that already
    // exists. It is not an add. Headless shops post the add to `/api/cart`.
    const cartPageForm = /\/cart\/?$/.test(actionPath) && !/\/cart\/add/.test(actionPath);
    if (testId.endsWith("-loading") || testId === "add-to-bag-loading") continue;
    const formAttr = h.getAttribute("form");
    const formAttrEl = formAttr ? doc.getElementById(formAttr) : null;
    const formAttrCart = !!formAttrEl && /\/cart\/add|\/api\/cart/.test(formAttrEl.getAttribute("action") || "");
    const inCartForm = /\/cart\/add|\/api\/cart/.test(action);
    const dataAtc = h.matches(
      '[data-add-to-cart], [data-product-form-atc], [data-kit-promo-primary], [data-pf-type="ProductATC"], [data-testid^="add-to-bag"], [data-testid$="addToBag-submit"], [data-testid*="add-to-cart" i], [data-test*="add-to-cart" i], [data-action*="add-to-cart" i], [data-hook*="add-to-cart" i], [data-qa*="add-to-cart" i]',
    );
    const classHint = /add[-_ ]?to[-_ ]?(cart|bag|basket)|addtocart|\batc\b|product-form__submit|product-form__atc|atc-button|product__add|btn-?cart|buy-?button|add-?cart/.test(idcls);
    const textBuyNow = BUY_NOW.test(text);
    const textAtc = (ATC.test(text) && !textBuyNow) || (/^add$/i.test(text) && (inCartForm || formAttrCart));
    const textPreorder = PREORDER.test(text);
    const textSoldOut = SOLDOUT.test(text) && text.length < 60;
    if (cartPageForm && !textAtc && !dataAtc && !classHint) continue;
    const relevant = inCartForm || formAttrCart || dataAtc || classHint || textAtc || textBuyNow || textPreorder || textSoldOut || el === recipeEl;
    if (!relevant) continue;
    const strong = inCartForm || formAttrCart || dataAtc || classHint || textAtc || el === recipeEl;
    const r = rectOf(h);
    controls.push({
      ...r,
      path: pathOf(h),
      general: strong && generalBudget-- > 0 ? generalOf(h) : null,
      tag: h.tagName.toLowerCase(),
      type: String((h as HTMLButtonElement).type || ""),
      name: h.getAttribute("name") || "",
      text,
      role: h.getAttribute("role") || "",
      vis: visible(h),
      disabled: (h as HTMLButtonElement).disabled === true || h.getAttribute("aria-disabled") === "true",
      inCartForm,
      formAttrCart,
      formHasIdInput: !!(form || formAttrEl)?.querySelector('input[name="id"], select[name="id"]'),
      inProductForm: !!h.closest(PRODUCT_FORM_SEL) || formAttrCart,
      dataAtc,
      classHint,
      textAtc,
      textBuyNow,
      textPreorder,
      textSoldOut,
      checkoutish: CHECKOUTISH.test(text) || h.getAttribute("name") === "checkout",
      isExpress: !!h.closest(EXPRESS_SEL) || EXPRESS_TEXT.test(text) || EXPRESS_TEXT.test(h.getAttribute("aria-label") || ""),
      inHeader: !!h.closest(HEADER_SEL),
      inFooter: !!h.closest(FOOTER_SEL),
      inRelated: !!h.closest(RELATED_SEL),
      inQuickAdd: !!h.closest(QUICK_SEL),
      inForeignCard: inForeignCard(h),
      inDrawer: !!h.closest(DRAWER_SEL),
      inSticky: inSticky(h),
      inDialog: !!h.closest('[role="dialog"], dialog, [aria-modal="true"]'),
      matchesRecipe: el === recipeEl,
    });
  }

  // ── Variant groups inside the main product's section ──
  const forms = Array.from(doc.querySelectorAll('form[action*="/cart/add"], form[action*="/api/cart"]')).filter(
    (f) => !f.closest(RELATED_SEL + "," + QUICK_SEL + "," + DRAWER_SEL + "," + FOOTER_SEL) && !inForeignCard(f),
  );
  const mainForm = forms[0] || null;
  // The buy box is the smallest ancestor of the cart form that also holds the
  // product title — not the form's nearest block, since themes put the option
  // pickers in a sibling of the buy-button block.
  let scopeNode: Element | null = null;
  if (mainForm && h1El) {
    let node: Element | null = mainForm;
    while (node && node !== doc.body && !node.contains(h1El)) node = node.parentElement;
    scopeNode = node && node !== doc.body ? node : null;
  }
  if (!scopeNode && mainForm) scopeNode = mainForm.closest('[id^="shopify-section"][id*="main" i], section, main, [role="main"]');
  const scope: Element = scopeNode || doc.querySelector('main, [role="main"]') || doc.body;
  const excluded = (el: Element): boolean =>
    !!el.closest(RELATED_SEL + "," + QUICK_SEL + "," + DRAWER_SEL + "," + FOOTER_SEL + "," + HEADER_SEL) || inForeignCard(el);
  const SKIP_GROUP =
    /selling[_-]?plan|payment|shipping|rating|review|frequency|quantity|qty|subscription|purchase[_-]?(type|option)|delivery|currency|country|locale|sort|filter/i;
  const unavailableCls = (el: Element | null): boolean =>
    !!el && /sold[-_ ]?out|disabled|unavailable|out[-_]?of[-_]?stock|crossed|strikethrough/i.test(String((el as HTMLElement).className || ""));
  // Themes put screen-reader-only text ("Variant sold out or unavailable") in
  // every option label and only reveal it for the dead ones, so stock and
  // labels are read from the text a shopper can actually see.
  const SR_ONLY = '.visually-hidden, .sr-only, [class*="visually-hidden" i], [class*="sr-only" i], [class*="screen-reader" i], [hidden]';
  const seenText = (el: Element | null): string => {
    if (!el) return "";
    let out = "";
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || (parent !== el && parent.closest(SR_ONLY) && el.contains(parent.closest(SR_ONLY)))) continue;
      if (parent.closest("script, style, template")) continue;
      out += " " + (n.textContent || "");
    }
    return norm(out);
  };
  const groupName = (el: Element, fallback: string): string => {
    const fs = el.closest("fieldset");
    const legend = fs ? fs.querySelector("legend") : null;
    const lab = legend ? norm(legend.textContent) : "";
    if (lab) return lab.replace(/[:：].*$/, "").slice(0, 40);
    const holder = el.closest("[data-option-name]");
    const dn = el.getAttribute("data-option-name") || (holder ? holder.getAttribute("data-option-name") : null);
    if (dn) return norm(dn).slice(0, 40);
    const al = el.getAttribute("aria-label");
    if (al) return norm(al).slice(0, 40);
    if (idOf(el)) {
      const l = doc.querySelector('label[for="' + esc(idOf(el)) + '"]');
      if (l) return norm(l.textContent).replace(/[:：].*$/, "").slice(0, 40);
    }
    return norm(fallback.replace(/^options\[|\]$/g, "").replace(/-\d+$/, "")).slice(0, 40);
  };
  const variantGroups: RawVariantGroup[] = [];
  /** A container selector that should match the same option group on other PDPs. */
  const groupGeneral = (holder: Element): string | null => {
    const tag = holder.tagName.toLowerCase();
    const cands: string[] = [];
    const custom = holder.closest("variant-radios, variant-selects, variant-picker, product-variants, product-options");
    if (custom && custom !== holder) cands.push(custom.tagName.toLowerCase() + " " + tag);
    if (tag === "select") {
      const nm = holder.getAttribute("name") || "";
      if (/^options\[/.test(nm)) cands.push('select[name^="options["]');
    }
    const cls = Array.from(holder.classList).find((c) => c.length > 2 && c.length < 40 && !/\d{3,}/.test(c) && !/^(js|is-|has-)/.test(c));
    if (cls) cands.push(tag + "." + esc(cls));
    for (const sel of cands) {
      try {
        if (Array.from(doc.querySelectorAll(sel)).includes(holder)) return sel;
      } catch {
        /* skip */
      }
    }
    return null;
  };

  for (const s of Array.from(scope.querySelectorAll("select"))) {
    const sel = s as HTMLSelectElement;
    const nm = sel.name || sel.id || "";
    if (SKIP_GROUP.test(nm) || excluded(sel)) continue;
    const opts = Array.from(sel.options).filter((o) => o.value !== "" || norm(o.text) !== "");
    if (!opts.length) continue;
    variantGroups.push({
      kind: "select",
      name: groupName(sel, nm),
      path: pathOf(sel),
      general: groupGeneral(sel),
      isVariantId: nm === "id",
      visible: visible(sel),
      options: opts.slice(0, 60).map((o) => ({
        value: o.value,
        label: norm(o.text).slice(0, 60),
        path: null,
        available: !o.disabled && !SOLDOUT.test(o.text),
        checked: o.selected,
      })),
    });
  }

  const radioMap = new Map<string, HTMLInputElement[]>();
  for (const r of Array.from(scope.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]) {
    if (!r.name || SKIP_GROUP.test(r.name) || excluded(r)) continue;
    radioMap.set(r.name, [...(radioMap.get(r.name) || []), r]);
  }
  for (const [nm, list] of radioMap) {
    const options = list.slice(0, 40).map((r) => {
      const label: Element | null =
        (r.labels && r.labels[0]) || r.closest("label") || (idOf(r) ? doc.querySelector('label[for="' + esc(idOf(r)) + '"]') : null);
      const clickable = label && visible(label) ? label : visible(r) ? r : null;
      const shown = seenText(label);
      return {
        value: r.value,
        label: (shown || r.value).slice(0, 60),
        path: clickable ? pathOf(clickable) : null,
        available:
          !r.disabled &&
          r.getAttribute("aria-disabled") !== "true" &&
          !unavailableCls(r) &&
          !unavailableCls(label) &&
          !SOLDOUT.test(shown),
        checked: r.checked,
      };
    });
    if (!options.some((o) => o.path)) continue;
    const first = list[0] as HTMLInputElement;
    const holder = first.closest("fieldset") || first.parentElement || first;
    variantGroups.push({ kind: "radio", name: groupName(first, nm), path: pathOf(holder), general: groupGeneral(holder), isVariantId: false, visible: true, options });
  }

  const seenItems = new Set<Element>();
  for (const c of Array.from(
    scope.querySelectorAll(
      '[role="radiogroup"], [class*="swatch" i], [data-option-index], [data-option-name], [class*="option-values" i], [class*="variant-picker" i], [class*="variant-option" i], [class*="product-option" i], [class*="size-selector" i], [class*="color-selector" i]',
    ),
  )) {
    if (variantGroups.length >= 6) break;
    if (c.querySelector('input[type="radio"], select') || excluded(c)) continue;
    const items = Array.from(
      c.querySelectorAll('button, [role="radio"], [data-value], [data-option-value], li[data-value], a[data-value]'),
    ).filter((e) => {
      if (seenItems.has(e) || !visible(e)) return false;
      const t = norm(e.textContent || e.getAttribute("aria-label") || e.getAttribute("data-value"));
      return t.length > 0 && t.length <= 80 && !ATC.test(t) && !CHECKOUTISH.test(t) && !/size\s*guide|select your size/i.test(t);
    });
    if (items.length < 2) continue;
    for (const e of items) seenItems.add(e);
    variantGroups.push({
      kind: "button",
      name: groupName(c, c.getAttribute("data-option-name") || "Option"),
      path: pathOf(c),
      general: groupGeneral(c),
      isVariantId: false,
      visible: true,
      options: items.slice(0, 40).map((e) => ({
        value: norm(e.getAttribute("data-value") || e.getAttribute("data-option-value") || e.getAttribute("aria-label") || seenText(e)).slice(0, 60),
        label: (seenText(e) || norm(e.getAttribute("aria-label"))).slice(0, 60),
        path: pathOf(e),
        available: !(e as HTMLButtonElement).disabled && e.getAttribute("aria-disabled") !== "true" && !unavailableCls(e),
        checked:
          e.getAttribute("aria-checked") === "true" ||
          e.getAttribute("aria-pressed") === "true" ||
          /\b(selected|active|is-active|current|is-selected)\b/i.test(String((e as HTMLElement).className || "")),
      })),
    });
  }

  // Closed size/colour popups (Outdoor Voices): the list stays display:none
  // until the combobox opens, so visibility cannot be required here.
  for (const box of Array.from(scope.querySelectorAll('[role="listbox"]'))) {
    if (variantGroups.length >= 6 || excluded(box) || box.closest("size-guide, template")) continue;
    const id = box.getAttribute("id");
    const trigger = id ? doc.querySelector('[aria-controls="' + esc(id) + '"]') : null;
    if (trigger && !visible(trigger)) continue;
    const items = Array.from(box.querySelectorAll('button, [role="option"]')).filter((e) => {
      if (seenItems.has(e) || e.closest("size-guide, template")) return false;
      const t = norm(e.getAttribute("data-option-value") || e.getAttribute("aria-label") || seenText(e));
      return t.length > 0 && t.length <= 80 && !ATC.test(t) && !/size\s*guide|select your size/i.test(t);
    });
    if (items.length < 2) continue;
    for (const e of items) seenItems.add(e);
    const triggerName = trigger ? norm(trigger.getAttribute("aria-label") || seenText(trigger)) : "";
    variantGroups.push({
      kind: "button",
      name: (triggerName || groupName(box, "Option")).replace(/select your size/i, "Size").slice(0, 40),
      path: trigger ? pathOf(trigger) : pathOf(box),
      general: groupGeneral(trigger || box),
      isVariantId: false,
      visible: true,
      options: items.slice(0, 40).map((e) => ({
        value: norm(e.getAttribute("data-option-value") || e.getAttribute("data-value") || seenText(e)).slice(0, 80),
        label: (seenText(e) || norm(e.getAttribute("aria-label") || e.getAttribute("data-option-value"))).slice(0, 80),
        path: pathOf(e),
        available: !(e as HTMLButtonElement).disabled && e.getAttribute("aria-disabled") !== "true" && !unavailableCls(e) && !SOLDOUT.test(seenText(e)),
        checked: e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-checked") === "true",
      })),
    });
  }

  // Button radios that are not inside a radiogroup (Chubbies size chips).
  const loose = new Map<string, HTMLElement[]>();
  for (const e of Array.from(scope.querySelectorAll('button[role="radio"], [role="radio"]')) as HTMLElement[]) {
    if (e.tagName === "INPUT" || seenItems.has(e) || excluded(e) || !visible(e)) continue;
    const typed = e.getAttribute("data-fs-variant-type");
    const wrap = e.parentElement && e.parentElement.parentElement ? e.parentElement.parentElement : e.parentElement;
    const key = typed || (wrap ? pathOf(wrap) : pathOf(e));
    loose.set(key, [...(loose.get(key) || []), e]);
  }
  for (const [, items] of loose) {
    if (variantGroups.length >= 6 || items.length < 2) continue;
    for (const e of items) seenItems.add(e);
    const first = items[0] as HTMLElement;
    const holder = first.parentElement && first.parentElement.parentElement ? first.parentElement.parentElement : first.parentElement || first;
    variantGroups.push({
      kind: "button",
      name: groupName(first, first.getAttribute("data-fs-variant-type") || "Option"),
      path: pathOf(holder),
      general: groupGeneral(holder),
      isVariantId: false,
      visible: true,
      options: items.slice(0, 40).map((e) => ({
        value: norm(e.getAttribute("data-fs-variant-value") || e.getAttribute("data-value") || e.getAttribute("title") || seenText(e)).slice(0, 80),
        label: (seenText(e) || norm(e.getAttribute("title") || e.getAttribute("aria-label"))).slice(0, 80),
        path: pathOf(e),
        available: !(e as HTMLButtonElement).disabled && e.getAttribute("aria-disabled") !== "true" && !unavailableCls(e) && !SOLDOUT.test(seenText(e)),
        checked: e.getAttribute("aria-checked") === "true" || e.getAttribute("aria-pressed") === "true",
      })),
    });
  }

  const idInput = (mainForm ? mainForm.querySelector('input[name="id"], select[name="id"]') : null) as HTMLInputElement | null;
  const urlVariant = new URLSearchParams(location.search).get("variant");
  const selectedVariantId = (idInput && idInput.value) || urlVariant || null;

  // ── Layer 1 sources (raw text; parsed in Node) ──
  const productJson: string[] = [];
  const jsonScripts = Array.from(doc.querySelectorAll('script[type="application/json"]'));
  jsonScripts.sort((a, b) => Number(scope.contains(b)) - Number(scope.contains(a)));
  for (const s of jsonScripts) {
    if (productJson.length >= 4) break;
    const t = s.textContent || "";
    if (t.length < 20 || t.length > 200_000) continue;
    if (!/"variants"\s*:|"available"\s*:|"option1"\s*:/.test(t)) continue;
    if (s.closest(RELATED_SEL + "," + QUICK_SEL) || inForeignCard(s)) continue;
    productJson.push(t);
  }
  const ldJson: string[] = [];
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const t = s.textContent || "";
    if (t.length < 150_000 && /"@type"\s*:\s*"(Product|ProductGroup)"/.test(t)) ldJson.push(t);
    if (ldJson.length >= 3) break;
  }
  let analyticsMeta: string | null = null;
  for (const s of Array.from(doc.querySelectorAll("script:not([src])"))) {
    const t = s.textContent || "";
    if (t.length > 300_000 || t.indexOf("var meta = ") < 0 || t.indexOf("ShopifyAnalytics") < 0) continue;
    const m = /var meta = (\{[\s\S]*?\});\s*for\s*\(/.exec(t);
    if (m && m[1]) {
      analyticsMeta = m[1].slice(0, 150_000);
      break;
    }
  }

  // ── Listing cards ──
  const sigCount = new Map<string, number>();
  let linkCount = 0;
  for (const a of Array.from(doc.querySelectorAll('a[href*="/products/"]'))) {
    if (linkCount >= 300) break;
    if (a.closest(HEADER_SEL + "," + FOOTER_SEL + ', nav, [role="navigation"]')) continue;
    const r = a.getBoundingClientRect();
    if (r.width < 16 || r.height < 10) continue;
    linkCount++;
    const card = a.closest(CARD_SEL);
    if (!card) continue;
    const cls = Array.from(card.classList).find((c) => c.length > 2 && c.length < 40 && !/\d{3,}/.test(c));
    const sig = card.tagName.toLowerCase() + (cls ? "." + esc(cls) : "");
    sigCount.set(sig, (sigCount.get(sig) || 0) + 1);
  }
  let bestSig: string | null = null;
  let bestN = 0;
  for (const [sig, n] of sigCount) {
    if (n > bestN) {
      bestSig = sig;
      bestN = n;
    }
  }
  let cardSelector: string | null = null;
  if (arg && arg.recipeCard && firstVisible(arg.recipeCard)) cardSelector = arg.recipeCard;
  else if (bestSig && bestN >= 2) cardSelector = bestSig + ' a[href*="/products/"]';
  const productCards = {
    selector: cardSelector,
    count: cardSelector ? countVisible(cardSelector, HEADER_SEL + "," + FOOTER_SEL) : 0,
    linkCount,
  };

  // ── Gallery / sections / cart drawer, for the choreography ──
  const skipMedia = HEADER_SEL + "," + FOOTER_SEL + "," + RELATED_SEL + "," + DRAWER_SEL;
  let gallery: RawBuyBoxScan["gallery"] = null;
  for (const sel of [
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
  ]) {
    const n = countVisible(sel, skipMedia);
    if (n >= 2) {
      gallery = { selector: sel, count: n, kind: "thumbs" };
      break;
    }
  }
  if (!gallery) {
    for (const sel of [
      '[class*="gallery" i] button[aria-label*="next" i]',
      '[class*="media" i] button[aria-label*="next" i]',
      '[class*="media" i] button[name="next" i]',
      '[class*="gallery" i] button[name="next" i]',
      '[class*="slider" i] button[class*="next" i]',
      ".swiper-button-next",
      ".slick-next",
      ".flickity-prev-next-button.next",
      'button[aria-label*="next image" i]',
      'button[aria-label*="next slide" i]',
    ]) {
      const n = countVisible(sel, skipMedia);
      if (n >= 1) {
        gallery = { selector: sel, count: n, kind: "arrow" };
        break;
      }
    }
  }
  if (!gallery && h1El) {
    // No controls at all: the photos are stacked in a column or grid beside
    // the buy box, and looking at them means scrolling down through them.
    const root = doc.querySelector('main, [role="main"]') || doc.body;
    const big = Array.from(root.querySelectorAll("img")).filter((img) => {
      if (img.closest(skipMedia)) return false;
      const r = img.getBoundingClientRect();
      return r.width >= 240 && r.height >= 200 && visible(img);
    });
    if (big.length >= 3) {
      const firstFew = big.slice(0, 3);
      let holder: Element | null = firstFew[0]!.parentElement;
      while (holder && holder !== root && !firstFew.every((i) => holder!.contains(i))) holder = holder.parentElement;
      if (holder && holder !== root && !holder.contains(h1El)) {
        const shots = big.filter((i) => holder!.contains(i));
        const tops = shots.map((i) => i.getBoundingClientRect().top);
        if (shots.length >= 3 && Math.max(...tops) - Math.min(...tops) > innerHeight * 0.8) {
          const general = groupGeneral(holder);
          const unique = !!general && doc.querySelectorAll(general).length === 1;
          gallery = { selector: (unique ? general : pathOf(holder)) + " img", count: shots.length, kind: "stack" };
        }
      }
    }
  }
  const skipSections =
    skipMedia + ', nav, [role="navigation"], [class*="menu" i], [id*="menu" i], [class*="localization" i], localization-form, [class*="filter" i], [class*="facet" i]';
  let sections: RawBuyBoxScan["sections"] = null;
  for (const sel of [
    "details > summary",
    '[class*="accordion" i] button[aria-expanded]',
    "button[aria-expanded][aria-controls]",
    '[class*="collapsible" i] summary',
    '[class*="collapsible" i] button',
    '[role="tab"]',
    '[class*="accordion" i] [class*="title" i]',
  ]) {
    const n = countVisible(sel, skipSections);
    if (n >= 1) {
      sections = { selector: sel, count: n };
      break;
    }
  }
  let cartDrawer: string | null = null;
  for (const sel of [
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
  ]) {
    if (doc.querySelector(sel)) {
      cartDrawer = sel;
      break;
    }
  }

  return {
    url: location.href,
    path: location.pathname,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollY: sy,
    h1,
    price,
    controls,
    variantGroups,
    selectedVariantId,
    oracle: { productJson, ldJson, analyticsMeta },
    productCards,
    gallery,
    sections,
    cartDrawer,
    scanMs: Math.round((performance.now() - t0) * 100) / 100,
  };
}

/** Fetch `/products/<handle>.js` from the utility world (same origin, page's cookies). */
export async function fetchProductJsInPage(arg: { path: string }): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch(arg.path, { headers: { accept: "application/json" }, credentials: "same-origin", signal: ctl.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length < 2_000_000 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Layer 1: product oracle
// ─────────────────────────────────────────────────────────────────────

export interface OracleVariant {
  id: string;
  title: string;
  options: string[];
  /** null when the source does not carry stock (e.g. ShopifyAnalytics meta). */
  available: boolean | null;
  price?: number | null;
}

export interface ProductOracle {
  source: "product-json" | "products.js" | "ld+json" | "analytics-meta";
  title?: string;
  optionNames: string[];
  variants: OracleVariant[];
  hasAvailability: boolean;
}

const asNumber = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function toVariant(v: Record<string, unknown>): OracleVariant | null {
  if (!v || (v.id === undefined && v.variant_id === undefined)) return null;
  const options = Array.isArray(v.options)
    ? (v.options as unknown[]).map((o) => (typeof o === "object" && o !== null ? String((o as Record<string, unknown>).value ?? "") : String(o)))
    : [v.option1, v.option2, v.option3].filter((x) => x !== undefined && x !== null && x !== "").map((x) => String(x));
  const available =
    typeof v.available === "boolean"
      ? v.available
      : typeof v.inventory_quantity === "number"
        ? v.inventory_quantity > 0 || v.inventory_policy === "continue"
        : null;
  return {
    id: String(v.id ?? v.variant_id),
    title: String(v.title ?? v.public_title ?? v.name ?? ""),
    options: options.filter((o) => o !== ""),
    available,
    price: asNumber(v.price),
  };
}

function optionNamesOf(product: Record<string, unknown>): string[] {
  const opts = product.options;
  if (!Array.isArray(opts)) return [];
  return opts
    .map((o) => (typeof o === "string" ? o : typeof o === "object" && o !== null ? String((o as Record<string, unknown>).name ?? "") : ""))
    .filter(Boolean);
}

/** Shopify product object, `{ product }` wrapper, or a bare variants array. */
function parseShopifyProduct(text: string, source: ProductOracle["source"]): ProductOracle | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).product) {
    data = (data as Record<string, unknown>).product;
  }
  let variantsRaw: unknown[] | null = null;
  let product: Record<string, unknown> = {};
  if (Array.isArray(data)) variantsRaw = data;
  else if (data && typeof data === "object") {
    product = data as Record<string, unknown>;
    if (Array.isArray(product.variants)) variantsRaw = product.variants;
  }
  if (!variantsRaw) return null;
  const variants = variantsRaw
    .map((v) => (v && typeof v === "object" ? toVariant(v as Record<string, unknown>) : null))
    .filter((v): v is OracleVariant => !!v);
  if (!variants.length) return null;
  return {
    source,
    ...(typeof product.title === "string" ? { title: product.title } : {}),
    optionNames: optionNamesOf(product),
    variants,
    hasAvailability: variants.some((v) => v.available !== null),
  };
}

function parseLdJson(text: string): ProductOracle | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const nodes: Record<string, unknown>[] = [];
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const o = n as Record<string, unknown>;
    const type = Array.isArray(o["@type"]) ? (o["@type"] as unknown[]).join(",") : String(o["@type"] ?? "");
    if (/Product/.test(type)) nodes.push(o);
    if (o["@graph"]) visit(o["@graph"]);
  };
  visit(data);
  const product = nodes[0];
  if (!product) return null;
  const offersOf = (p: Record<string, unknown>): Record<string, unknown>[] => {
    const offers = p.offers as unknown;
    if (!offers) return [];
    if (Array.isArray(offers)) return offers as Record<string, unknown>[];
    const o = offers as Record<string, unknown>;
    if (Array.isArray(o.offers)) return o.offers as Record<string, unknown>[];
    return [o];
  };
  const fromOffer = (offer: Record<string, unknown>, name: string): OracleVariant | null => {
    const url = String(offer.url ?? "");
    const id = /[?&]variant=(\d+)/.exec(url)?.[1] ?? String(offer.sku ?? "");
    if (!id) return null;
    const avail = String(offer.availability ?? "");
    const available = /InStock|PreOrder|LimitedAvailability|OnlineOnly|BackOrder/i.test(avail)
      ? true
      : /OutOfStock|SoldOut|Discontinued/i.test(avail)
        ? false
        : null;
    return { id, title: String(offer.name ?? name ?? ""), options: [], available, price: asNumber(offer.price) };
  };
  const variants: OracleVariant[] = [];
  const hasVariant = product.hasVariant;
  if (Array.isArray(hasVariant)) {
    for (const v of hasVariant as Record<string, unknown>[]) {
      for (const offer of offersOf(v)) {
        const ov = fromOffer(offer, String(v.name ?? ""));
        if (ov) variants.push(ov);
      }
    }
  }
  for (const offer of offersOf(product)) {
    const ov = fromOffer(offer, String(product.name ?? ""));
    if (ov && !variants.some((x) => x.id === ov.id)) variants.push(ov);
  }
  if (!variants.length) return null;
  return {
    source: "ld+json",
    ...(typeof product.name === "string" ? { title: product.name } : {}),
    optionNames: [],
    variants,
    hasAvailability: variants.some((v) => v.available !== null),
  };
}

function parseAnalyticsMeta(text: string): ProductOracle | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(text);
  } catch {
    return null;
  }
  const product = meta.product as Record<string, unknown> | undefined;
  if (!product || !Array.isArray(product.variants)) return null;
  const variants = (product.variants as Record<string, unknown>[])
    .map((v) => {
      const pub = String(v.public_title ?? "");
      return {
        id: String(v.id ?? ""),
        title: String(v.name ?? pub),
        options: pub ? pub.split(" / ").map((s) => s.trim()).filter(Boolean) : [],
        available: null,
        price: asNumber(v.price),
      } as OracleVariant;
    })
    .filter((v) => v.id);
  if (!variants.length) return null;
  return { source: "analytics-meta", optionNames: [], variants, hasAvailability: false };
}

/**
 * Merge every oracle source into one view. Theme product JSON (or the .js
 * endpoint) is authoritative; JSON-LD contributes stock per variant id when
 * the primary source lacks it; ShopifyAnalytics is the last resort.
 */
export function parseProductOracle(sources: RawBuyBoxScan["oracle"], productJs?: string | null): ProductOracle | null {
  const candidates: ProductOracle[] = [];
  for (const text of sources.productJson) {
    const o = parseShopifyProduct(text, "product-json");
    if (o) candidates.push(o);
  }
  if (productJs) {
    const o = parseShopifyProduct(productJs, "products.js");
    if (o) candidates.push(o);
  }
  const rank = (o: ProductOracle): number =>
    (o.hasAvailability ? 4 : 0) + (o.optionNames.length ? 2 : 0) + (o.variants.some((v) => v.options.length) ? 1 : 0);
  candidates.sort((a, b) => rank(b) - rank(a) || b.variants.length - a.variants.length);
  let primary: ProductOracle | null = candidates[0] ?? null;

  const ld = sources.ldJson.map(parseLdJson).find((o): o is ProductOracle => !!o) ?? null;
  if (!primary && ld) primary = ld;
  else if (primary && ld && !primary.hasAvailability) {
    for (const v of primary.variants) {
      const hit = ld.variants.find((x) => x.id === v.id);
      if (hit && hit.available !== null) v.available = hit.available;
    }
    primary.hasAvailability = primary.variants.some((v) => v.available !== null);
  }
  if (!primary && sources.analyticsMeta) primary = parseAnalyticsMeta(sources.analyticsMeta);
  return primary;
}

/** `/products/<handle>.js` (or the collection-scoped equivalent) for a product path. */
export function productJsPath(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.(js|json)$/, "") + ".js";
}

// ─────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────

export interface ScoredControl {
  /** Selector to click: the generalisable one when known, else the exact path. */
  selector: string;
  path: string;
  general: string | null;
  text: string;
  score: number;
  signals: string[];
  disabled: boolean;
  soldOutLabel: boolean;
  rect: RawRect;
}

export interface VariantOptionView extends RawVariantOption {}

export interface VariantGroupView extends Omit<RawVariantGroup, "options"> {
  options: VariantOptionView[];
  /** Which oracle option position this group controls; null when unknown. */
  oracleIndex: number | null;
}

export interface MultiSignalResult {
  pageType: RecipePageType;
  confidence: number;
  atc: ScoredControl | null;
  candidates: ScoredControl[];
  soldOut: boolean;
  variantGroups: VariantGroupView[];
  oracle: ProductOracle | null;
  selectedVariantId: string | null;
  productCards: RawBuyBoxScan["productCards"];
  gallery: RawBuyBoxScan["gallery"];
  sections: RawBuyBoxScan["sections"];
  cartDrawer: string | null;
  recipeMatched: boolean;
  scanMs: number;
  h1Text: string | null;
  priceText: string | null;
}

const classifyPath = (path: string): RecipePageType => DomainRecipeCache.pageTypeOf(path);

/** Score one control against the buy-box invariants. -1 = excluded outright. */
export function scoreControl(c: RawControl, scan: Pick<RawBuyBoxScan, "h1" | "price">): { score: number; signals: string[] } {
  if (!c.vis || c.isExpress || c.checkoutish) return { score: -1, signals: [] };
  if (/^(select( a| your)? size|choose( a)? size|add method to cart)$/i.test(c.text.trim()) || /splide__arrow|swiper-button|miniBag|productRecs-addToBag|js-quickadd/i.test(c.general || "")) return { score: -1, signals: [] };
  let s = 0;
  const sig: string[] = [];
  const add = (w: number, label: string): void => {
    s += w;
    sig.push(label);
  };
  // Layer 2 — form contract
  if (c.inCartForm) add(0.3, "form:/cart/add");
  else if (c.formAttrCart) add(0.25, "form-attr:/cart/add");
  if (c.name === "add") add(0.15, "name=add");
  if (c.type === "submit" && (c.inCartForm || c.formAttrCart)) add(0.1, "submit");
  if (c.inProductForm) add(0.1, "product-form");
  if (c.formHasIdInput) add(0.05, "input[name=id]");
  if (c.dataAtc) add(0.25, "data-atc");
  if (c.classHint) add(0.12, "class-hint");
  // Label
  if (c.textAtc) add(0.25, "label:add-to-cart");
  else if (c.textPreorder) add(0.18, "label:pre-order");
  else if (c.textBuyNow) add(0.1, "label:buy-now");
  if (c.textSoldOut) sig.push("label:sold-out");
  // Layer 3 — role
  if (c.tag === "button" || c.role === "button" || c.type === "submit") add(0.05, "role:button");
  // Layer 4 — geometry
  if (c.w >= 160 && c.w <= 580) add(0.1, "width");
  else if (c.w >= 100 && c.w <= 720) add(0.03, "width~");
  else add(-0.1, "width!");
  if (c.h >= 38 && c.h <= 72) add(0.07, "height");
  else if (c.h >= 28 && c.h <= 90) add(0.02, "height~");
  else add(-0.08, "height!");
  const h1 = scan.h1;
  if (h1) {
    const dy = c.y - (h1.y + h1.h);
    if (dy > 0 && dy < 700) add(0.15, "below-h1");
    else if (dy <= 0 && dy > -150) add(0.03, "beside-h1");
    else add(-0.15, "far-from-h1");
    const colLeft = h1.x - 60;
    const colRight = h1.x + Math.max(h1.w, 320) + 60;
    if (Math.min(c.x + c.w, colRight) - Math.max(c.x, colLeft) > 0) add(0.05, "buy-box-column");
  }
  if (scan.price && c.y >= scan.price.y) add(0.04, "below-price");
  // Context the buy box never lives in
  if (c.inRelated || c.inQuickAdd || c.inForeignCard) add(-0.8, "card/related");
  if (c.inHeader || c.inFooter) add(-0.8, "chrome");
  if (c.inDrawer) add(-0.8, "drawer");
  if (c.inSticky) add(-0.2, "sticky");
  if (c.inDialog && !c.inProductForm) add(-0.3, "dialog");
  if (c.disabled) add(-0.45, "disabled");
  if (c.matchesRecipe) add(0.2, "recipe");
  return { score: Math.max(0, Math.min(1, s)), signals: sig };
}

const normValue = (s: string | undefined | null): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function matchOracleIndex(group: RawVariantGroup, order: number, oracle: ProductOracle): number | null {
  const name = normValue(group.name);
  if (name && oracle.optionNames.length) {
    const i = oracle.optionNames.findIndex((n) => {
      const on = normValue(n);
      return on === name || (on.length > 1 && (name.includes(on) || on.includes(name)));
    });
    if (i >= 0) return i;
  }
  const width = Math.max(0, ...oracle.variants.map((v) => v.options.length));
  let best: number | null = null;
  let bestHits = 0;
  for (let i = 0; i < width; i++) {
    const values = new Set(oracle.variants.map((v) => normValue(v.options[i])));
    const hits = group.options.filter((o) => values.has(normValue(o.value)) || values.has(normValue(o.label))).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = i;
    }
  }
  if (best !== null && bestHits > 0) return best;
  return order < width ? order : null;
}

/** Overlay oracle stock on the DOM option groups. */
function applyOracle(groups: RawVariantGroup[], oracle: ProductOracle | null): VariantGroupView[] {
  let order = 0;
  return groups.map((g) => {
    const view: VariantGroupView = { ...g, options: g.options.map((o) => ({ ...o })), oracleIndex: null };
    if (!oracle) return view;
    if (g.isVariantId) {
      for (const o of view.options) {
        const v = oracle.variants.find((x) => x.id === o.value);
        if (v && v.available !== null) o.available = o.available && v.available;
      }
      return view;
    }
    const idx = matchOracleIndex(g, order++, oracle);
    view.oracleIndex = idx;
    if (idx === null || !oracle.hasAvailability) return view;
    for (const o of view.options) {
      const matching = oracle.variants.filter((v) => {
        const val = normValue(v.options[idx]);
        return val === normValue(o.value) || val === normValue(o.label);
      });
      if (matching.length) o.available = o.available && matching.some((v) => v.available !== false);
    }
    return view;
  });
}

/** Turn a raw scan into a scored buy-box view. Pure — no page access. */
export function scoreBuyBox(raw: RawBuyBoxScan, opts: { productJs?: string | null } = {}): MultiSignalResult {
  const scored = raw.controls
    .map((c) => {
      const { score, signals } = scoreControl(c, raw);
      return {
        selector: c.general ?? c.path,
        path: c.path,
        general: c.general,
        text: c.text,
        score,
        signals,
        disabled: c.disabled,
        soldOutLabel: c.textSoldOut,
        rect: { x: c.x, y: c.y, w: c.w, h: c.h },
      } as ScoredControl;
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0] ?? null;
  let confidence = top ? top.score : 0;
  const runnerUp = scored[1];
  // Two equally convincing buttons in different places is ambiguity, not certainty.
  if (top && runnerUp && runnerUp.score > top.score - 0.04 && Math.abs(runnerUp.rect.y - top.rect.y) > 80) confidence -= 0.1;

  const oracle = parseProductOracle(raw.oracle, opts.productJs);
  const variantGroups = applyOracle(raw.variantGroups, oracle);
  let pageType = classifyPath(raw.path);
  if (pageType === "other" && top && top.score >= 0.8 && raw.h1) pageType = "product";

  const oracleSoldOut = !!oracle && oracle.hasAvailability && oracle.variants.length > 0 && oracle.variants.every((v) => v.available === false);
  const labelSoldOut = !!top && top.soldOutLabel && top.disabled;

  return {
    pageType,
    confidence: Math.max(0, Math.min(1, Math.round(confidence * 1000) / 1000)),
    atc: top,
    candidates: scored.slice(0, 3),
    soldOut: oracleSoldOut || labelSoldOut,
    variantGroups,
    oracle,
    selectedVariantId: raw.selectedVariantId,
    productCards: raw.productCards,
    gallery: raw.gallery,
    sections: raw.sections,
    cartDrawer: raw.cartDrawer,
    recipeMatched: raw.controls.some((c) => c.matchesRecipe && c.vis),
    scanMs: raw.scanMs,
    h1Text: raw.h1?.text ?? null,
    priceText: raw.price?.text ?? null,
  };
}

/**
 * Scan the live page. The oracle's `.js` endpoint is only fetched on a
 * product page whose embedded JSON carries no stock information.
 */
export async function detectMultiSignal(
  page: Page,
  opts: { recipe?: DomainSelectorRecipe | undefined; fetchProductJs?: boolean } = {},
): Promise<MultiSignalResult | null> {
  const raw = await evaluateIsolated(page, collectBuyBoxSignals, {
    recipeAtc: opts.recipe?.addToCart ?? null,
    recipeCard: opts.recipe?.productCard ?? null,
  });
  if (!raw) return null;
  let productJs: string | null = null;
  if (opts.fetchProductJs !== false && classifyPath(raw.path) === "product") {
    const prelim = parseProductOracle(raw.oracle);
    // JSON-LD knows stock per variant but not option values, so it cannot be
    // mapped onto size/colour controls; the .js endpoint can.
    const unmappable =
      !!prelim &&
      raw.variantGroups.some((g) => !g.isVariantId) &&
      !prelim.variants.some((v) => v.options.length > 0);
    if (!prelim || !prelim.hasAvailability || unmappable) {
      productJs = await evaluateIsolated(page, fetchProductJsInPage, { path: productJsPath(raw.path) });
    }
  }
  return scoreBuyBox(raw, { productJs });
}

// ─────────────────────────────────────────────────────────────────────
// Variant planning
// ─────────────────────────────────────────────────────────────────────

export interface VariantStep {
  group: VariantGroupView;
  option: VariantOptionView;
}

export interface VariantPlan {
  variantId: string | null;
  steps: VariantStep[];
  source: "oracle" | "dom";
}

/** Groups a visitor can actually operate (not the hidden variant-id select). */
export function operableGroups(result: Pick<MultiSignalResult, "variantGroups">): VariantGroupView[] {
  return result.variantGroups.filter((g) => {
    if (g.isVariantId || !g.visible) return false;
    if (/\{|\}|size-guide|display\s*=|<\s*style/i.test(g.name)) return false;
    const labels = g.options.map((o) => `${o.label} ${o.value}`);
    const survey = labels.filter((label) => /star|rated|review|weight training|not regularly|recommend/i.test(label)).length;
    if (survey >= 2) return false;
    return g.options.some((o) => o.path || g.kind === "select");
  });
}

/**
 * Choose an in-stock variant and the clicks that select it.
 *
 * With an oracle carrying stock, only `available` variants are considered and
 * every operable group gets the option that variant needs. `preferCurrent`
 * keeps the variant already selected when it is in stock (the final pick
 * before add-to-cart); `exclude` steers exploration toward variants not tried;
 * `maxChanges` only considers combinations reachable in that many clicks, so
 * a choice that is started can always be finished (null when none fits).
 */
export function planVariantSelection(
  result: Pick<MultiSignalResult, "variantGroups" | "oracle" | "selectedVariantId">,
  rng: Rng,
  opts: { preferCurrent?: boolean; exclude?: Set<string>; maxChanges?: number } = {},
): VariantPlan | null {
  const groups = operableGroups(result);
  const oracle = result.oracle;
  const idSelect = result.variantGroups.find((g) => g.isVariantId && g.visible);

  if (oracle && oracle.hasAvailability) {
    const inStock = oracle.variants.filter((v) => v.available !== false);
    const resolvable = inStock
      .map((v) => {
        const steps: VariantStep[] = [];
        for (const g of groups) {
          if (g.oracleIndex === null) continue;
          const want = normValue(v.options[g.oracleIndex]);
          const option = g.options.find((o) => normValue(o.value) === want || normValue(o.label) === want);
          if (!option || (!option.path && g.kind !== "select")) return null;
          steps.push({ group: g, option });
        }
        if (!groups.length && idSelect) {
          const option = idSelect.options.find((o) => o.value === v.id);
          if (!option) return null;
          steps.push({ group: idSelect as VariantGroupView, option });
        }
        return { variant: v, steps };
      })
      .filter((x): x is { variant: OracleVariant; steps: VariantStep[] } => !!x);
    if (resolvable.length) {
      const clicksFor = (r: { steps: VariantStep[] }): number => r.steps.filter((s) => !s.option.checked).length;
      const pool = opts.maxChanges === undefined ? resolvable : resolvable.filter((r) => clicksFor(r) <= opts.maxChanges!);
      if (!pool.length) return null;
      const current = opts.preferCurrent ? pool.find((r) => r.variant.id === result.selectedVariantId) : undefined;
      const fresh = pool.filter((r) => !opts.exclude?.has(r.variant.id) && r.variant.id !== result.selectedVariantId);
      const pick = current ?? rng.pick(fresh.length ? fresh : pool)!;
      return { variantId: pick.variant.id, steps: pick.steps, source: "oracle" };
    }
  }

  if (!groups.length) return null;
  // Without stock data each group is picked on its own; past the click budget a group keeps its current choice.
  const free = new Set(rng.shuffle(groups.map((_, i) => i)).slice(0, opts.maxChanges ?? groups.length));
  const steps: VariantStep[] = [];
  groups.forEach((g, i) => {
    const usable = g.options.filter((o) => o.available && (o.path || g.kind === "select") && !(g.kind === "select" && o.value === ""));
    if (!usable.length) return;
    const checked = usable.find((o) => o.checked);
    const pick = (opts.preferCurrent || !free.has(i)) && checked ? checked : rng.pick(usable)!;
    steps.push({ group: g, option: pick });
  });
  return steps.length ? { variantId: null, steps, source: "dom" } : null;
}
