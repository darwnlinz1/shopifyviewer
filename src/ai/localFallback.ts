/**
 * Local element detection — no AI involved.
 *
 * Parses the same source digest the AI reads and classifies with plain
 * rules. Used when the Claude pool has no healthy cookies, and as the
 * last-resort fallback when every AI attempt fails, so a session keeps
 * browsing instead of dead-ending.
 *
 * The rules are deliberately conservative: canonical Shopify product paths
 * only. Everything ambiguous is left to the AI path.
 */
import type { DetectedProduct, DetectedAddToCart } from "./elementDetector.js";

/** Routes that are never products even when a card-like context wraps them. */
const NEVER_PRODUCT =
  /(\.(png|jpe?g|gif|svg|webp|css|js|ico|pdf)$)|(^(mailto:|tel:|javascript:))|(gift[-_]?card|gift[-_]?certificate|e[-_]?gift)|(\/(cookie[-_]?consent|privacy|terms|account|login|search|wishlist)\/?$)/i;

/**
 * Markup leakage cut. Product handles are plain slugs; a space, pipe, quote
 * or angle bracket — raw or percent-encoded — marks where the real URL ended
 * and theme template junk began (e.g. "/products/slug |" seen in the wild).
 */
export function sanitizeProductPath(path: string): string {
  const i = path.search(/ |\||["'`<>]|%20|%7C|%22|%27|%3C|%3E/i);
  return i >= 0 ? path.slice(0, i) : path;
}

/** A product detail page ends with exactly one slug after /products/.
 * Everything longer (/products/policies/x, /products/a/b) is a theme
 * template bug, not a PDP. */
const PRODUCT_TAIL = /\/products?\/([^/?#]+)\/?$/;

export function hasProductSlug(path: string): boolean {
  if (NEVER_PRODUCT.test(path)) return false;
  const m = PRODUCT_TAIL.exec(path);
  return !!m && /^[a-z0-9._~-]+$/i.test(m[1] ?? "");
}

function looksLikeProductPath(path: string): boolean {
  if (!path || path.length < 2 || path === "/") return false;
  if (NEVER_PRODUCT.test(path)) return false;
  // Accepts both canonical shapes:
  //   /products/<handle>            and  /product/<handle>
  //   /collections/<h>/products/<h>  (collection-scoped, very common)
  return hasProductSlug(path);
}

export interface LocalDetection {
  products: DetectedProduct[];
  addToCart: DetectedAddToCart | null;
}

/**
 * Digest format produced by the session loop's extraction script:
 *   JSON-LD: {...}
 *   OG:TYPE=product
 *   LINKS:
 *   /products/handle | Link text | ctx:card--content | price:$49
 *   CONTROLS:
 *   button#AddToCart | Add to cart | name=add form:/cart/add
 */
export function localDetect(digest: string): LocalDetection {
  const products = new Map<string, DetectedProduct>();
  let section = "";

  for (const rawLine of digest.split("\n")) {
    const line = rawLine.trim();
    if (line === "LINKS:") { section = "links"; continue; }
    if (line === "CONTROLS:") { section = "controls"; continue; }
    if (line === "VARIANTS:") { section = "variants"; continue; }
    if (!line || line.startsWith("JSON-LD:") || line.startsWith("OG:TYPE=") || line.startsWith("TITLE=")) continue;
    if (section !== "links") continue;

    const fields = line.split(" | ");
    const rawHref = fields[0] ?? "";
    const path = sanitizeProductPath((rawHref.split("?")[0] ?? ""));
    const sfccTile = (/\.html\/?$/i.test(path) && (/product[-_ ]?tile|product-name/i.test(line) || /\d{6,}\.html$/i.test(path))) && !NEVER_PRODUCT.test(path);
    const pid = /(?:\?|&)pid=([^&\s|]+)/i.exec(rawHref);
    const productUrl = pid ? rawHref.split(" ")[0] : path;
    if ((!looksLikeProductPath(path) && !sfccTile && !pid) || products.has(productUrl)) continue;
    products.set(productUrl, { selector: "", url: productUrl, text: (fields[1] ?? "").trim() });
  }

  return { products: [...products.values()], addToCart: findAddToCart(digest) };
}

/**
 * Strong ATC signals: add/buy followed within reason by cart/bag/basket,
 * "Buy It Now", Vietnamese. Labels mentioning checkout are NEVER an
 * add-to-cart — that is the cart drawer's payment button (Bokksu renders
 * "ADD $27.00 TO CHECKOUT"), and clicking it walks toward payment.
 */
const STRONG_ATC =
  /\b(add|adding|ajouter|hinzuf|aggiungi|añadir|agregar|toevoegen)\b[^.|]{0,30}\b(cart|bag|basket|panier|carrito|carrello|warenkorb|korb|winkelwagen|giỏ)\b|\bbuy\s*(it)?\s*now\b|\badd\b\s*[—-]|thêm vào giỏ|add to my/i;
const CHECKOUTISH = /checkout|payment|thanh toán/i;
/** Attribute junk leaking into a label ("name=add form:/cart/add") — that is
 * the meta column, not human text, and matching on it produced garbage
 * selectors on aiju-cosmetique.fr. */
const ATTRIBUTE_JUNK = /\bname=\b|\bform:\b/;

/** Best-effort add-to-cart selector from the CONTROLS section. */
function findAddToCart(digest: string): DetectedAddToCart | null {
  let section = "";
  for (const rawLine of digest.split("\n")) {
    const line = rawLine.trim();
    if (line === "CONTROLS:") { section = "controls"; continue; }
    if (line === "LINKS:" || line.startsWith("JSON-LD:") || line === "VARIANTS:") { section = ""; continue; }
    if (section !== "controls") continue;

    const fields = line.split(" | ");
    const ident = fields[0] ?? "";
    const label = fields[1] ?? "";
    const meta = fields.slice(2).join(" ");
    if (!STRONG_ATC.test(label) || CHECKOUTISH.test(label) || ATTRIBUTE_JUNK.test(label)) continue;

    // #id beats [name] beats the cart form beats a text match — anything
    // that resolves beats skipping the button entirely.
    const idMatch = ident.match(/#[\w-]+/);
    const selector =
      idMatch?.[0] ??
      (() => {
        const nameMatch = meta.match(/name=([^\s]+)/);
        if (nameMatch) {
          const tag = ident.split("#")[0]?.trim() || "button";
          return `${tag}[name="${nameMatch[1]}"]`;
        }
        return null;
      })() ??
      (() => {
        const formMatch = meta.match(/form:([^\s]+)/);
        if (formMatch) {
          const act = (formMatch[1] ?? "").replace(/"/g, "");
          if (/cart\/add/.test(act)) {
            return 'form[action*="cart/add"] button[type=submit], form[action*="cart/add"] input[type=submit]';
          }
          if (/cart/.test(act)) {
            return `form[action="${act}"] button, form[action="${act}"] input[type=submit]`;
          }
        }
        return null;
      })() ??
      // Plain labelled button with nothing else to hang onto: Playwright's
      // text engine finds it regardless of theme classnames.
      `button:has-text("${label.replace(/["\\]/g, "").slice(0, 40)}")`;

    return { selector, text: label };
  }
  return null;
}