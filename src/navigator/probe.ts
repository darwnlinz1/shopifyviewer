/**
 * Selector probe.
 *
 * Visits a homepage, a collection and a product on the target shop and reports
 * which of the built-in candidate selectors actually match that theme, with
 * counts. Run this once against a new storefront to confirm the simulator can
 * see the elements it needs — and to generate `selectorOverrides` if some
 * concept comes back empty.
 */
import type { Page } from "rebrowser-playwright";
import type { SimulatorConfig } from "../config.js";
import { Logger } from "../logging/logger.js";
import { Rng, randomSeed } from "../util/random.js";
import { Pacing } from "../behavior/timing.js";
import { launchBrowser } from "../browser/chrome.js";
import { PageNavigator, openSessionPage } from "./pageNavigator.js";
import { buildSelectors, type SelectorSet } from "./selectors.js";
import type { PageType } from "../types.js";

/** Per-concept probe outcome for one page. */
export interface SelectorHit {
  concept: keyof SelectorSet;
  /** First candidate that matched, or null when none did. */
  matched: string | null;
  count: number;
  /** Every candidate that matched, with its count — useful for tuning. */
  alternatives: Array<{ selector: string; count: number }>;
}

export interface ProbedPage {
  url: string;
  detectedType: PageType;
  title: string;
  status: number | null;
  loadMs: number;
  scrollHeight: number;
  hits: SelectorHit[];
  /** Concepts with zero matches — these are what an override would fix. */
  missing: Array<keyof SelectorSet>;
}

export interface ProbeReport {
  storefront: string;
  engine: string;
  pages: ProbedPage[];
  /** Suggested `selectorOverrides` skeleton for whatever is missing. */
  suggestedOverrides: Record<string, string[]>;
}

/** Concepts that only make sense on a product page. */
const PRODUCT_ONLY: Array<keyof SelectorSet> = [
  "productTitle",
  "productPrice",
  "productDescription",
  "productMedia",
  "productMediaThumb",
  "variantPicker",
  "collapsibleSection",
];

/** Concepts that only make sense on a collection page. */
const COLLECTION_ONLY: Array<keyof SelectorSet> = [
  "productGrid",
  "productCard",
  "pagination",
];

export async function probeStorefront(
  config: SimulatorConfig,
): Promise<ProbeReport> {
  const logger = new Logger("probe", { ...config.logging, jsonl: false }, "probe");
  const rng = new Rng(config.seed ?? randomSeed());
  const selectors = buildSelectors(config.selectorOverrides);

  const browser = await launchBrowser({
    slot: 0,
    sessionId: "probe",
    config,
    logger,
    rng,
  });

  const pages: ProbedPage[] = [];

  try {
    const page: Page = await openSessionPage(browser.context);
    page.setDefaultTimeout(config.session.navigationTimeoutMs);
    // The probe only loads pages and counts selectors, so its pacing needs no
    // session arc — a flat progress function is enough.
    const pacing = new Pacing(rng, config.behavior);
    const navigator = new PageNavigator(page, config, logger, rng, pacing);

    // 1. Homepage.
    const home = await probeOne(page, navigator, selectors, config.storefront);
    pages.push(home);

    // 2. A collection — prefer a configured seed, else the first one linked
    //    from the homepage, else Shopify's universal /collections/all.
    const collectionUrl =
      absolutise(config.seedCollections[0], config.storefront) ??
      (await firstLink(page, selectors.collectionLink)) ??
      `${config.storefront}/collections/all`;
    const collection = await probeOne(page, navigator, selectors, collectionUrl);
    pages.push(collection);

    // 3. A product — the first one linked from the collection page.
    const productUrl = await firstLink(page, selectors.productLink);
    if (productUrl) {
      pages.push(await probeOne(page, navigator, selectors, productUrl));
    } else {
      logger.warn("probe_no_product", "no product link found on the collection page", {
        url: collectionUrl,
      });
    }
  } finally {
    await browser.close().catch(() => undefined);
    await logger.close();
  }

  return {
    storefront: config.storefront,
    engine: browser.engine,
    pages,
    suggestedOverrides: buildSuggestions(pages),
  };
}

/** Load one URL and test every selector concept against it. */
async function probeOne(
  page: Page,
  navigator: PageNavigator,
  selectors: SelectorSet,
  url: string,
): Promise<ProbedPage> {
  const metrics = await navigator.goto(url);
  const detectedType = await navigator.detectPageType();
  const title = await page.title().catch(() => "");
  const scrollHeight = await page
    .evaluate(() => document.documentElement?.scrollHeight ?? 0)
    .catch(() => 0);

  const hits: SelectorHit[] = [];
  for (const concept of Object.keys(selectors) as Array<keyof SelectorSet>) {
    if (concept === "forbidden") continue;
    const alternatives: Array<{ selector: string; count: number }> = [];
    for (const selector of selectors[concept]) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) alternatives.push({ selector, count });
    }
    hits.push({
      concept,
      matched: alternatives[0]?.selector ?? null,
      count: alternatives[0]?.count ?? 0,
      alternatives,
    });
  }

  return {
    url: metrics.url,
    detectedType,
    title,
    status: metrics.status,
    loadMs: metrics.elapsedMs,
    scrollHeight,
    hits,
    missing: relevantMissing(hits, detectedType),
  };
}

/** Only report a concept as missing when it is relevant to that page type. */
function relevantMissing(
  hits: SelectorHit[],
  pageType: PageType,
): Array<keyof SelectorSet> {
  return hits
    .filter((hit) => {
      if (hit.matched) return false;
      if (PRODUCT_ONLY.includes(hit.concept)) return pageType === "product";
      if (COLLECTION_ONLY.includes(hit.concept)) return pageType === "collection";
      return true;
    })
    .map((hit) => hit.concept);
}

/** Skeleton overrides object listing whatever the theme did not expose. */
function buildSuggestions(pages: ProbedPage[]): Record<string, string[]> {
  const missing = new Set<string>();
  for (const page of pages) {
    for (const concept of page.missing) missing.add(concept);
  }
  const out: Record<string, string[]> = {};
  for (const concept of missing) out[concept] = ["/* add a selector for this theme */"];
  return out;
}

/** First href on the page matching any candidate selector. */
async function firstLink(page: Page, candidates: string[]): Promise<string | null> {
  for (const selector of candidates) {
    const href = await page
      .evaluate((sel) => {
        const el = document.querySelector<HTMLAnchorElement>(sel);
        return el?.href ?? null;
      }, selector)
      .catch(() => null);
    if (href) return href;
  }
  return null;
}

function absolutise(path: string | undefined, base: string): string | null {
  if (!path) return null;
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

/** Render a probe report as readable console output. */
export function formatProbeReport(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push(`\nStorefront: ${report.storefront}   (engine: ${report.engine})`);

  for (const page of report.pages) {
    lines.push("");
    lines.push(`── ${page.detectedType.toUpperCase()} · ${page.url}`);
    lines.push(
      `   status=${page.status ?? "?"}  load=${page.loadMs}ms  height=${page.scrollHeight}px  "${page.title.slice(0, 60)}"`,
    );
    for (const hit of page.hits) {
      const relevant =
        hit.matched !== null ||
        page.missing.includes(hit.concept);
      if (!relevant) continue;
      const mark = hit.matched ? "✓" : "✗";
      const detail = hit.matched
        ? `${hit.count.toString().padStart(3)} × ${hit.matched}`
        : "  no candidate matched";
      lines.push(`   ${mark} ${hit.concept.padEnd(20)} ${detail}`);
    }
  }

  const missingCount = Object.keys(report.suggestedOverrides).length;
  lines.push("");
  if (missingCount === 0) {
    lines.push("All relevant selector concepts matched — no overrides needed.");
  } else {
    lines.push(
      `${missingCount} concept(s) need a theme-specific selector. Add to your config:`,
    );
    lines.push(
      JSON.stringify({ selectorOverrides: report.suggestedOverrides }, null, 2),
    );
  }
  return lines.join("\n");
}
