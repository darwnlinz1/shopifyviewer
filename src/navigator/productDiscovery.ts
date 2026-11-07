/**
 * Universal Shopify Product Discovery
 *
 * Not every Shopify store renders product links the same way. Some use
 * server-side rendered <a href="/products/..."> tags, others use JavaScript
 * frameworks (Hydrogen, Remix) that mount product cards as React/Vue components
 * without any href in the initial HTML, and some use data attributes like
 * data-product-handle that JavaScript reads to build navigation.
 *
 * This module defines a prioritized list of discovery strategies, tried from
 * most-reliable (SSR hrefs) to least-reliable (JSON-LD, Shopify globals).
 * The page navigator calls `discoverProductLinks()` on every page, and the
 * result feeds directly into the behaviour engine's link pool.
 *
 * Research basis (2026-08): 12 Shopify stores analyzed.
 * - 50% render product links in SSR HTML (href="/products/...")
 * - 25% use data attributes (data-product-url, data-product-handle)
 * - 25% are fully JS-rendered SPA with no SSR product links
 *   (bonfire, ripcurl, mvmt, dingobrand)
 */

export interface DiscoveredProductLink {
  url: string;
  text: string;
}

export interface DiscoveryResult {
  links: DiscoveredProductLink[];
  method: string;
}

/**
 * Strategies ordered by reliability. Each strategy is a function that
 * extracts product links from the page's DOM or global state.
 *
 * The navigator tries each in order and uses the first one that returns
 * results. If all fail, it falls back to navigating to /collections/all.
 */
export type DiscoveryStrategy = (
  page: any, // Playwright Page
) => Promise<DiscoveryResult>;

/**
 * Strategy 1: href pattern match (most common, ~50% of stores).
 *
 * Scans all <a> tags for hrefs containing /products/ or /product/.
 * This is the fastest and most reliable method for SSR stores.
 */
export const strategyHrefPattern: DiscoveryStrategy = async (page) => {
  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const results: Array<{ url: string; text: string }> = [];
    const seen = new Set<string>();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      // Match /products/ (plural, Shopify standard) or /product/ (singular, some stores)
      if (!/\/products?\//.test(href)) continue;
      // Skip cart/checkout forms
      if (a.closest("form[action*='cart/add']")) continue;
      if (href.startsWith('#')) continue;
      try {
        const url = new URL(href, window.location.origin).href;
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({
          url,
          text: (a.textContent || '').trim().slice(0, 120),
        });
      } catch { /* invalid URL */ }
    }
    return results;
  }).catch(() => []);

  return { links, method: 'href-pattern' };
};

/**
 * Strategy 2: data-product-url / data-product-handle attributes.
 *
 * Some themes (Burton, Stance) store the product URL in data attributes
 * on the card element, which JavaScript uses for client-side navigation.
 * These attributes are present in SSR HTML even when the <a> tag is
 * rendered by a JS framework.
 */
export const strategyDataAttributes: DiscoveryStrategy = async (page) => {
  const links = await page.evaluate(() => {
    const results: Array<{ url: string; text: string }> = [];
    const seen = new Set<string>();

    // Strategy 2a: data-product-url (explicit full URL)
    for (const el of Array.from(document.querySelectorAll('[data-product-url]'))) {
      const raw = el.getAttribute('data-product-url');
      if (!raw) continue;
      try {
        const url = new URL(raw, window.location.origin).href;
        if (seen.has(url)) continue;
        seen.add(url);
        const title = el.getAttribute('data-product-title') ||
          el.querySelector('[data-product-title]')?.textContent || '';
        results.push({ url, text: title.trim().slice(0, 120) });
      } catch { /* invalid URL */ }
    }

    // Strategy 2b: data-product-handle (relative to /products/)
    for (const el of Array.from(document.querySelectorAll('[data-product-handle]'))) {
      const handle = el.getAttribute('data-product-handle');
      if (!handle) continue;
      const url = new URL('/products/' + handle, window.location.origin).href;
      if (seen.has(url)) continue;
      seen.add(url);
      const title = el.getAttribute('data-product-title') ||
        el.querySelector('[data-product-title]')?.textContent || '';
      results.push({ url, text: title.trim().slice(0, 120) });
    }

    // Strategy 2c: data-handle (generic, used by some themes)
    for (const el of Array.from(document.querySelectorAll('[data-handle]'))) {
      const handle = el.getAttribute('data-handle');
      if (!handle || !/^[a-z0-9-]+$/i.test(handle)) continue;
      // Not all data-handle are products; check if there's a nearby product indicator
      const parent = el.closest('[data-product-id], [data-product-url], .product-card, .card');
      if (!parent) continue;
      const url = new URL('/products/' + handle, window.location.origin).href;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ url, text: handle.replace(/-/g, ' ') });
    }

    return results;
  }).catch(() => []);

  return { links, method: 'data-attributes' };
};

/**
 * Strategy 3: JSON-LD structured data.
 *
 * Some stores embed product data as JSON-LD for SEO. This is reliable
 * when present, but not all stores include it on every page.
 */
export const strategyJsonLD: DiscoveryStrategy = async (page) => {
  const links = await page.evaluate(() => {
    const results: Array<{ url: string; text: string }> = [];
    const seen = new Set<string>();

    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const data = JSON.parse(script.textContent || '{}');
        const items = data['@type'] === 'ItemList' ? data.itemListElement :
          data['@type'] === 'CollectionPage' ? data.mainEntity?.itemListElement : [];

        for (const item of (items || [])) {
          const product = item.item || item;
          if (!product) continue;
          let url = product.url || product['@id'] || '';
          if (url && !url.startsWith('http')) {
            url = new URL(url, window.location.origin).href;
          }
          if (!url || seen.has(url)) continue;
          if (!/\/products?\//.test(url)) continue;
          seen.add(url);
          results.push({
            url,
            text: (product.name || '').slice(0, 120),
          });
        }
      } catch { /* JSON parse error */ }
    }

    return results;
  }).catch(() => []);

  return { links, method: 'json-ld' };
};

/**
 * Strategy 4: Shopify global variables.
 *
 * Shopify stores often expose product data through JavaScript globals:
 * - ShopifyAnalytics.meta.product (current product on PDP)
 * - __st.p (page type)
 * - meta.product (theme-specific)
 *
 * This strategy mainly detects what page type we're on and extracts
 * the current product URL when on a PDP.
 */
export const strategyShopifyGlobals: DiscoveryStrategy = async (page) => {
  const links = await page.evaluate(() => {
    const results: Array<{ url: string; text: string }> = [];
    const w = window;

    // Check for product JSON in window objects
    try {
      const productJson = (w as any).product;
      if (productJson && productJson.url) {
        results.push({
          url: new URL(productJson.url, window.location.origin).href,
          text: (productJson.title || '').slice(0, 120),
        });
      }
    } catch { /* */ }

    return results;
  }).catch(() => []);

  return { links, method: 'shopify-globals' };
};

/**
 * Strategy 5: Collection links (fallback for navigating between collections).
 *
 * When no product links are found, collecting collection links gives
 * the engine somewhere to go next. This is not product discovery per se,
 * but it feeds the engine's navigation options.
 */
export const strategyCollectionLinks: DiscoveryStrategy = async (page) => {
  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const results: Array<{ url: string; text: string }> = [];
    const seen = new Set<string>();
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (!/\/collections?\//.test(href)) continue;
      if (a.closest("form[action*='cart/add']")) continue;
      if (href.startsWith('#')) continue;
      try {
        const url = new URL(href, window.location.origin).href;
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({
          url,
          text: (a.textContent || '').trim().slice(0, 120),
        });
      } catch { /* invalid URL */ }
    }
    return results;
  }).catch(() => []);

  return { links, method: 'collection-links' };
};

/**
 * All product discovery strategies in priority order.
 * The navigator tries each until one returns results.
 */
export const PRODUCT_DISCOVERY_STRATEGIES: DiscoveryStrategy[] = [
  strategyHrefPattern,
  strategyDataAttributes,
  strategyJsonLD,
  strategyShopifyGlobals,
];

/**
 * Fallback navigation targets when no product links are found anywhere.
 *
 * These are tried in order. The navigator picks the first one that
 * hasn't been visited yet. /collections/all is the universal fallback
 * on Shopify, but some stores redirect it to the main collection page.
 */
export const FALLBACK_NAVIGATION_PATHS = [
  '/collections/all',
  '/collections',
  '/search?q=*&type=product',
];

/**
 * Known Shopify collection page patterns.
 * Used to identify collection pages that might contain product grids.
 */
export const COLLECTION_URL_PATTERNS = [
  /^\/collections\/[^/]+\/?$/,
  /^\/collections$/,
  /^\/collections\/all\/?$/,
];

/**
 * Known Shopify product page patterns.
 */
export const PRODUCT_URL_PATTERNS = [
  /^\/products\/[^/]+\/?$/,
  /^\/product\/[^/]+\/?$/,  // singular, some stores
];