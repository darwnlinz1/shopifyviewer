/**
 * Pattern-based selector system.
 *
 * Class names differ across every Shopify theme.  Instead of matching
 * specific classes, the navigator scans the DOM for structural patterns:
 *   - href contains /products/  → product link
 *   - href contains /collections/ → collection link
 *   - <details> or aria-expanded → accordion
 *   - text contains $ or €       → price
 *   - #MainContent, main, [role=main] → main content
 *
 * The CSS selector lists below are FALLBACKS for when the href scan
 * misses links (e.g. JS-rendered SPA). They are tried most-generic first.
 */
export interface SelectorSet {
  /** Structural patterns the navigator scans for (no CSS needed). */
  productLinkPattern: string;
  collectionLinkPattern: string;
  /** CSS selectors as fallback when the href scan finds nothing. */
  productLink: string[];
  collectionLink: string[];
  mainContent: string[];
  productGrid: string[];
  productCard: string[];
  productTitle: string[];
  productPrice: string[];
  productDescription: string[];
  productMedia: string[];
  productMediaThumb: string[];
  variantPicker: string[];
  collapsibleSection: string[];
  contentSection: string[];
  pagination: string[];
  navMenuLink: string[];
  forbidden: string[];
}

const DEFAULT: SelectorSet = {
  // --- Pattern-based: match href substring, works across ALL Shopify themes ---
  productLinkPattern: "/products/",
  collectionLinkPattern: "/collections/",

  // --- Fallback CSS selectors (generic, not theme-specific) ---
  productLink: [
    'a[href*="/products/"]',
  ],
  collectionLink: [
    'a[href*="/collections/"]',
  ],
  mainContent: ["#MainContent", "main", '[role="main"]'],
  productGrid: [".product-grid", ".collection__products", '[class*="product-grid"]'],
  productCard: [".product-card", ".card-wrapper", ".product-item", '[class*="product-card"]', '[class*="card__"]'],
  productTitle: ["h1"],
  productPrice: [".price", '[class*="price"]', '[data-product-price]'],
  productDescription: [".product__description", ".rte", '[class*="description"]'],
  productMedia: [".product-media", ".product__media", '[class*="product-media"]', '[class*="gallery"]'],
  productMediaThumb: ['[class*="thumbnail"]', "button[data-media-id]", '[class*="media-nav"]'],
  variantPicker: [
    'input[type="radio"][name*="option"]',
    "fieldset",
    "select[name*='option']",
    '[class*="variant"]',
  ],
  collapsibleSection: ["details", "details.accordion", ".accordion", '[class*="accordion"]'],
  contentSection: [".shopify-section", "section"],
  pagination: [".pagination a", 'a[rel="next"]', '[class*="pagination"] a'],
  navMenuLink: ["nav a", "header a", ".header a"],
  forbidden: [
    "form[action*='/cart/add']",
    "button[name='add']",
    "[data-add-to-cart]",
    ".product-form__submit",
    "a[href*='/checkout']",
    "a[href*='/cart']",
    "a[href*='/account']",
  ],
};

export function buildSelectors(overrides?: Partial<Record<keyof SelectorSet, string[]>>): SelectorSet {
  if (!overrides) return { ...DEFAULT };
  const out = { ...DEFAULT };
  for (const [key, extra] of Object.entries(overrides)) {
    if (!extra || extra.length === 0) continue;
    const field = key as keyof SelectorSet;
    const current = out[field];
    if (Array.isArray(current) && Array.isArray(extra)) {
      (out[field] as string[]) = [...extra, ...current];
    }
  }
  return out;
}