/**
 * Shopify storefront selectors.
 *
 * Themes differ, so nothing here is a single hard-coded selector. Each concept
 * is a *candidate list*, tried in order from most-specific (Dawn / Online Store
 * 2.0 conventions) to most-generic. The navigator picks the first candidate
 * that actually matches visible elements on the page, so the simulator keeps
 * working across themes without per-shop code.
 *
 * `selectorOverrides` in the config can prepend shop-specific candidates when a
 * heavily customised theme needs them.
 */

/** Every selector concept the navigator knows how to look for. */
export interface SelectorSet {
  mainContent: string[];
  productLink: string[];
  collectionLink: string[];
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
  /** Elements a read-only test session must never click. */
  forbidden: string[];
}

export const SHOPIFY_SELECTORS: SelectorSet = {
  mainContent: [
    "#MainContent",
    "main#MainContent",
    'main[role="main"]',
    "main",
    "#main",
    "[role='main']",
  ],

  productLink: [
    // Dawn / OS 2.0 product cards
    ".card__heading a[href*='/products/']",
    ".product-card-wrapper a[href*='/products/']",
    ".card-wrapper a[href*='/products/']",
    ".grid__item a[href*='/products/']",
    // Common third-party themes
    ".product-item a[href*='/products/']",
    ".product-card a[href*='/products/']",
    ".product-grid-item a[href*='/products/']",
    "[data-product-card] a[href*='/products/']",
    // Fallback: any product link in the document
    "a[href*='/products/']",
  ],

  collectionLink: [
    ".header__inline-menu a[href*='/collections/']",
    "nav a[href*='/collections/']",
    ".site-nav a[href*='/collections/']",
    "header a[href*='/collections/']",
    ".collection-list a[href*='/collections/']",
    ".card-wrapper a[href*='/collections/']",
    "a[href*='/collections/']",
  ],

  productGrid: [
    "#product-grid",
    ".collection .grid--collection",
    ".product-grid",
    ".collection__products",
    ".grid.product-grid",
    "[data-product-grid]",
  ],

  productCard: [
    ".card-wrapper",
    ".product-card-wrapper",
    ".product-item",
    ".product-card",
    ".grid__item",
    "[data-product-card]",
  ],

  productTitle: [
    ".product__title h1",
    "h1.product__title",
    "h1.product-single__title",
    ".product-meta__title",
    ".product__info-wrapper h1",
    "h1",
  ],

  productPrice: [
    ".price__regular .price-item--regular",
    ".product__info-wrapper .price",
    ".price-item",
    ".price",
    ".product-single__price",
    ".product__price",
    "[data-product-price]",
    ".money",
  ],

  productDescription: [
    ".product__description",
    ".product-single__description",
    ".product__info-wrapper .rte",
    "[data-product-description]",
    ".product-description",
    ".rte",
  ],

  productMedia: [
    "media-gallery .product__media-item",
    ".product__media-wrapper .product__media",
    ".product__media-item",
    ".product-single__photo",
    ".product__media img",
    "[data-product-media]",
    ".product-gallery__image",
    ".swiper-slide img",
    ".flickity-slider img",
  ],

  productMediaThumb: [
    ".thumbnail-list__item button",
    ".thumbnail-list__item",
    ".product__media-thumbnail",
    "[data-thumbnail-id]",
    ".product-single__thumbnail",
    ".product-gallery__thumbnail",
  ],

  variantPicker: [
    "variant-selects",
    "variant-radios",
    ".product-form__input input[type='radio']",
    ".product-form__input select",
    "select[name='id']",
    ".swatch",
    "[data-variant-option]",
    ".product-options",
  ],

  collapsibleSection: [
    ".product__accordion details",
    "details.accordion",
    ".accordion details",
    ".product__info-wrapper details",
    "details",
    "[data-accordion]",
    ".tab-title",
  ],

  contentSection: [
    ".shopify-section",
    "section[id^='shopify-section']",
    "section",
  ],

  pagination: [
    ".pagination__list a",
    ".pagination a",
    "a[rel='next']",
    ".pagination-wrapper a",
  ],

  navMenuLink: [
    ".header__inline-menu a",
    "header nav a",
    ".site-nav__link",
    "nav a",
  ],

  /**
   * Never interacted with. A storefront behaviour test reads the shop; it must
   * not create carts, orders, or account state.
   */
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

/** Merge shop-specific overrides in front of the built-in candidates. */
export function buildSelectors(
  overrides?: Partial<Record<keyof SelectorSet, string[]>>,
): SelectorSet {
  if (!overrides) return SHOPIFY_SELECTORS;
  const out = { ...SHOPIFY_SELECTORS };
  for (const [key, extra] of Object.entries(overrides)) {
    if (!extra || extra.length === 0) continue;
    const field = key as keyof SelectorSet;
    out[field] = [...extra, ...SHOPIFY_SELECTORS[field]];
  }
  return out;
}
