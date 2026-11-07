/**
 * The 3-tier detection waterfall.
 *
 *   Tier 0  DomainRecipeCache — selectors this shop's theme already proved.
 *   Tier 1  multiSignalDetector — oracle + form contract + ARIA + buy-box
 *           geometry, scored from an isolated-world scan. No AI involved.
 *   Tier 2  ElementDetector — the AI (or its local fallback), consulted only
 *           when Tier 1 is unsure (confidence < threshold) or an add-to-cart
 *           on this shop did not register. What it finds that works is
 *           written back to Tier 0 for the whole domain.
 *
 * It answers the engine through the same `detect()` contract the AI detector
 * has, so the behaviour engine does not care which tier replied.
 */
import type { Page } from "rebrowser-playwright";
import type { Logger } from "../logging/logger.js";
import type { AtcPlan } from "../types.js";
import type { PageDetectionResult } from "./elementDetector.js";
import { localDetect } from "./localFallback.js";
import { preprocessHtml } from "./promptTemplates.js";
import { DomainRecipeCache, type RecipePageType } from "./domainRecipeCache.js";
import { detectMultiSignal, operableGroups, type MultiSignalResult } from "../navigator/multiSignalDetector.js";

export type DetectionTier = 0 | 1 | 2;

type DetectOptions = { intent?: "discover" | "interact" | "add_to_cart"; skipCache?: boolean };

/** What the behaviour engine needs from a detector. */
export interface PageDetector {
  detect(url: string, htmlSource: string, options?: DetectOptions): Promise<PageDetectionResult>;
}

/** The AI tier: a detector that can also start work in the background. */
export interface AiTier extends PageDetector {
  prefetch?(url: string, htmlSource: string, options?: DetectOptions): void;
}

export interface BuyBoxResolution {
  url: string;
  /** 0 when the shop's recipe matched the live buy box, 1 when Tier 1 scored it fresh. */
  tier: 0 | 1;
  confidence: number;
  scan: MultiSignalResult;
}

/** The page facts the choreography plans around. */
export interface PageFeatures {
  pageType: RecipePageType;
  galleryCount: number;
  sectionCount: number;
  variantGroupCount: number;
  productCardCount: number;
  soldOut: boolean;
  /** In-stock variants per the oracle; -1 when stock is unknown. */
  inStockVariants: number;
  tier: 0 | 1;
  confidence: number;
}

export function featuresOf(res: BuyBoxResolution): PageFeatures {
  const { scan } = res;
  const oracle = scan.oracle;
  return {
    pageType: scan.pageType,
    galleryCount: scan.gallery?.count ?? 0,
    sectionCount: scan.sections?.count ?? 0,
    variantGroupCount: operableGroups(scan).length,
    productCardCount: scan.productCards.count,
    soldOut: scan.soldOut,
    inStockVariants: oracle && oracle.hasAvailability ? oracle.variants.filter((v) => v.available !== false).length : -1,
    tier: res.tier,
    confidence: res.confidence,
  };
}

/** The add-to-cart plan the executor understands, built from a Tier 0/1 scan. */
export function planFromScan(scan: MultiSignalResult): AtcPlan {
  const variants = operableGroups(scan)
    .map((g) => ({ group: g.name, options: g.options.filter((o) => o.available && o.path).map((o) => o.path as string) }))
    .filter((g) => g.options.length > 0)
    .slice(0, 3);
  return {
    ...(scan.atc ? { addToCart: { selector: scan.atc.selector, text: scan.atc.text } } : {}),
    variants,
    ...(scan.atc?.disabled && variants.length ? { variantGated: true } : {}),
    ...(scan.soldOut ? { isSoldOut: true } : {}),
  };
}

const SCAN_CACHE_LIMIT = 80;

export class DetectionWaterfall implements PageDetector {
  private readonly scans = new Map<string, BuyBoxResolution>();
  /** Shops whose last add-to-cart did not register: their next PDP goes to Tier 2. */
  private readonly escalatedHosts = new Set<string>();
  readonly stats = { tier0: 0, tier1: 0, tier2: 0, local: 0 };

  constructor(
    private readonly ai: AiTier,
    readonly recipes: DomainRecipeCache,
    private readonly logger: Logger,
    private readonly options: { threshold: number; maxHtmlChars?: number },
  ) {}

  get threshold(): number {
    return this.options.threshold;
  }

  private static key(url: string): string {
    try {
      const u = new URL(url);
      return u.host + u.pathname.replace(/\/+$/, "");
    } catch {
      return url;
    }
  }

  isEscalated(url: string): boolean {
    return this.escalatedHosts.has(DomainRecipeCache.hostOf(url));
  }

  /**
   * Tier 0 + Tier 1 on the live page. Confident results are learned into the
   * shop's recipe right away; they are re-validated on every later scan.
   */
  async scan(page: Page, url: string): Promise<BuyBoxResolution | null> {
    const pageType = DomainRecipeCache.pageTypeOf(url);
    if (pageType === "cart") return null;
    const recipe = this.recipes.get(url, pageType);
    const scan = await detectMultiSignal(page, { recipe, fetchProductJs: pageType === "product" || pageType === "other" }).catch(() => null);
    if (!scan) return null;

    const tier: 0 | 1 = scan.recipeMatched ? 0 : 1;
    const confidence = tier === 0 && recipe ? Math.max(scan.confidence, Math.min(1, recipe.confidence)) : scan.confidence;
    const res: BuyBoxResolution = { url, tier, confidence, scan };
    const key = DetectionWaterfall.key(url);
    this.scans.delete(key);
    this.scans.set(key, res);
    if (this.scans.size > SCAN_CACHE_LIMIT) {
      const oldest = this.scans.keys().next().value;
      if (oldest) this.scans.delete(oldest);
    }

    if (scan.pageType === "product" && tier === 1 && scan.atc?.general && confidence >= this.threshold) {
      this.recipes.learn(
        url,
        "product",
        {
          addToCart: scan.atc.general,
          variantGroups: scan.variantGroups.map((g) => g.general).filter((g): g is string => !!g),
          // Recipes keep clickable gallery controls only; a stacked column is re-read per page.
          ...(scan.gallery && scan.gallery.kind !== "stack" ? { gallery: scan.gallery.selector } : {}),
          ...(scan.sections ? { sections: scan.sections.selector } : {}),
          ...(scan.cartDrawer ? { cartDrawer: scan.cartDrawer } : {}),
        },
        "tier1",
        confidence,
      );
    } else if ((scan.pageType === "collection" || scan.pageType === "home" || scan.pageType === "search") && scan.productCards.selector && scan.productCards.count >= 2) {
      this.recipes.learn(url, scan.pageType, { productCard: scan.productCards.selector }, "tier1", 0.85);
    }

    this.logger.debug(
      "tier_scan",
      `tier${tier} ${scan.pageType} confidence=${confidence.toFixed(2)} scan=${scan.scanMs}ms oracle=${scan.oracle?.source ?? "none"}`,
      { url },
    );
    return res;
  }

  lastScan(url: string): BuyBoxResolution | undefined {
    return this.scans.get(DetectionWaterfall.key(url));
  }

  /** Whether this page needs the AI tier at all. */
  needsAi(url: string, htmlSource: string): boolean {
    const pageType = DomainRecipeCache.pageTypeOf(url);
    if (pageType === "product") {
      if (this.isEscalated(url)) return true;
      const s = this.lastScan(url);
      return !s || !s.scan.atc || s.confidence < this.threshold;
    }
    return this.localProducts(htmlSource).length < 3;
  }

  /** Start the AI tier in the background, only where Tiers 0/1 fall short. */
  prefetch(url: string, htmlSource: string, options: DetectOptions = {}): void {
    if (!this.needsAi(url, htmlSource)) return;
    const escalated = DomainRecipeCache.pageTypeOf(url) === "product" && this.isEscalated(url);
    this.ai.prefetch?.(url, htmlSource, escalated ? { intent: "add_to_cart", skipCache: true } : options);
  }

  private localProducts(htmlSource: string): PageDetectionResult["products"] {
    return localDetect(preprocessHtml(htmlSource, this.options.maxHtmlChars ?? 40_000)).products;
  }

  async detect(url: string, htmlSource: string, options: DetectOptions = {}): Promise<PageDetectionResult> {
    const pageType = DomainRecipeCache.pageTypeOf(url);
    const local = localDetect(preprocessHtml(htmlSource, this.options.maxHtmlChars ?? 40_000));

    if (pageType === "product") {
      const s = this.lastScan(url);
      const escalated = this.isEscalated(url);
      if (s && s.scan.atc && !escalated && s.confidence >= this.threshold) {
        this.stats[s.tier === 0 ? "tier0" : "tier1"]++;
        return {
          url,
          products: local.products,
          addToCart: { selector: s.scan.atc.selector, text: s.scan.atc.text },
          plan: planFromScan(s.scan),
          is_sold_out: s.scan.soldOut,
          accountSource: s.tier === 0 ? "tier0-recipe" : "tier1-multisignal",
          elapsedMs: Math.round(s.scan.scanMs),
          cached: false,
        };
      }
      this.stats.tier2++;
      const ai = await this.ai.detect(url, htmlSource, escalated ? { ...options, intent: "add_to_cart", skipCache: true } : options);
      return {
        ...ai,
        products: ai.products.length ? ai.products : local.products,
        is_sold_out: ai.is_sold_out === true || s?.scan.soldOut === true,
      };
    }

    if (local.products.length >= 3) {
      this.stats.local++;
      return { url, products: local.products, addToCart: local.addToCart, accountSource: "local", elapsedMs: 0, cached: false };
    }
    this.stats.tier2++;
    return this.ai.detect(url, htmlSource, options);
  }

  /** A click that the shop confirmed: remember (or reinforce) what worked for the domain. */
  noteAtcSuccess(url: string, used: { tier: DetectionTier; selector?: string | null; cartDrawer?: string | null }): void {
    const host = DomainRecipeCache.hostOf(url);
    this.escalatedHosts.delete(host);
    const scan = this.lastScan(url)?.scan;
    const fields = {
      ...(used.selector ? { addToCart: used.selector } : {}),
      ...(used.cartDrawer ? { cartDrawer: used.cartDrawer } : {}),
      ...(scan ? { variantGroups: scan.variantGroups.map((g) => g.general).filter((g): g is string => !!g) } : {}),
    };
    if (used.tier === 2) this.recipes.learn(url, "product", fields, "ai", 0.9);
    else this.recipes.learn(url, "product", fields, "tier1", used.tier === 0 ? 0.97 : 0.95);
    this.recipes.recordHit(url, "product", "addToCart");
  }

  /** A click that did not register: weaken the recipe and send the shop's next PDP to Tier 2. */
  noteAtcFailure(url: string, used: { tier: DetectionTier; selector?: string | null }): void {
    const host = DomainRecipeCache.hostOf(url);
    const dropped = used.tier !== 2 ? this.recipes.recordFailure(url, "product", "addToCart") : false;
    this.escalatedHosts.add(host);
    this.logger.info(
      "tier_escalate",
      `add-to-cart unverified via tier${used.tier} — next product page of ${host} escalates to Tier 2${dropped ? " (recipe selector dropped)" : ""}`,
      { url },
    );
  }
}
