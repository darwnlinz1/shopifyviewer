/**
 * src/behavior/aiEngine.ts
 *
 * Goal-Oriented AI Behavior Engine with State-Machine, Elastic Pacing & Multi-Product ATC.
 *
 * State Transitions:
 *   INITIAL_EXPLORE -> SEEK_PRODUCT -> ENGAGE_PRODUCT (Lock-on-PDP) -> EXECUTE_ATC_1 -> VERIFY_ATC
 *   -> [Multi-Product] -> SEEK_PRODUCT_2 -> ENGAGE_PRODUCT -> EXECUTE_ATC_2 -> VERIFY_ATC
 *   -> POST_ATC_BROWSE / CART_ABANDONMENT -> EXIT
 */
import type { SimulatorConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Rng } from "../util/random.js";
import type { SessionTimer } from "../session/timer.js";
import type { ElementDetector, DetectedProduct } from "../ai/elementDetector.js";
import type { AiDecision, AiDetectedElement, AtcPlan } from "../types.js";

export type Personality = "browser" | "browser_fast" | "shopper" | "researcher";

/** Core states for Goal-Oriented Shopper State Machine */
export type ShopperState =
  | "INITIAL_EXPLORE"
  | "SEEK_PRODUCT"
  | "ENGAGE_PRODUCT"
  | "EXECUTE_ATC_1"
  | "VERIFY_ATC"
  | "SEEK_PRODUCT_2"
  | "EXECUTE_ATC_2"
  | "POST_ATC_BROWSE"
  | "CART_ABANDONMENT"
  | "EXIT";

export interface VisitStateSnapshot {
  personality: string;
  shopperState?: ShopperState;
  visitedProducts: string[];
  visitedListings: string[];
  soldOutProducts?: string[];
  advanceActionPerformed: boolean;
  addToCartCount: number;
  targetAtcCount?: number;
  atcPlans?: Array<[string, AtcPlan]>;
  lastPlanUrl?: string | null;
  cachedAddToCart?: AiDetectedElement | null;
  targetAtc1Ms?: number;
  targetAtc2Ms?: number;
}

interface PersonalityConfig {
  scrollStepsMin: number;
  scrollStepsMax: number;
  dwellChance: number;
  atcChance: number;
  cartVisitChance: number;
  targetAtcCount: number;
}

const PERSONALITIES: Record<Personality, PersonalityConfig> = {
  browser:      { scrollStepsMin: 2, scrollStepsMax: 4, dwellChance: 0.3, atcChance: 0.0,  cartVisitChance: 0.2, targetAtcCount: 1 },
  browser_fast: { scrollStepsMin: 1, scrollStepsMax: 2, dwellChance: 0.1, atcChance: 0.0,  cartVisitChance: 0.1, targetAtcCount: 1 },
  shopper:      { scrollStepsMin: 3, scrollStepsMax: 6, dwellChance: 0.5, atcChance: 0.25, cartVisitChance: 0.5, targetAtcCount: 2 },
  researcher:   { scrollStepsMin: 4, scrollStepsMax: 7, dwellChance: 0.6, atcChance: 0.15, cartVisitChance: 0.7, targetAtcCount: 2 },
};

export interface AiSessionState {
  currentState: ShopperState;
  visitedProducts: Set<string>;
  visitedListings: Set<string>;
  soldOutProducts: Set<string>;
  cachedAddToCart: AiDetectedElement | null;
  lastDetectionUrl: string | null;
  cachedProductLinks: DetectedProduct[];
  aiCallsCount: number;
  aiCallsTotalMs: number;
  scrollSinceLastClick: number;
  advanceActionPerformed: boolean;
  addToCartCount: number;
  targetAtcCount: number;
  rescueAttempts: number;
  currentPageKey: string | null;
  pageEnteredElapsedMs: number;
  atcPlans: Map<string, AtcPlan>;
}

export function createAiSessionState(targetAtcCount = 1): AiSessionState {
  return {
    currentState: "INITIAL_EXPLORE",
    visitedProducts: new Set(),
    visitedListings: new Set(),
    soldOutProducts: new Set(),
    cachedAddToCart: null,
    lastDetectionUrl: null,
    cachedProductLinks: [],
    aiCallsCount: 0,
    aiCallsTotalMs: 0,
    scrollSinceLastClick: 0,
    advanceActionPerformed: false,
    addToCartCount: 0,
    targetAtcCount,
    rescueAttempts: 0,
    currentPageKey: null,
    pageEnteredElapsedMs: 0,
    atcPlans: new Map(),
  };
}

export class AiBehaviorEngine {
  readonly state: AiSessionState;
  personality: Personality;
  private cfg: PersonalityConfig;
  private readonly logger: Logger;
  private readonly rng: Rng;
  private readonly storefront: string;
  private readonly cartAllowed: boolean;

  private readonly config: SimulatorConfig;
  private readonly engageMinMs: number;
  private readonly engageMaxMs: number;

  /** Pacing Engine: Elastic Windows for ATC 1 & ATC 2 */
  private targetAtc1Ms: number = 0;
  private targetAtc2Ms: number = 0;
  private atcLeadTimeMs: number = 35_000;
  private pacingInitialized = false;

  private forcedAtcPending = false;
  private forcedAtcTurns = 0;
  private lastPlanUrl: string | null = null;

  constructor(config: SimulatorConfig, rng: Rng, logger: Logger, personality?: Personality) {
    this.config = config;
    this.rng = rng;
    this.logger = logger;
    this.storefront = config.storefront;

    const explicitAtcMs = (config as any)?.ai?.advanceActionTimeMs;
    const isExplicitlyDisabled = config.safety?.allowCart === false || explicitAtcMs === Number.MAX_SAFE_INTEGER;
    this.cartAllowed = !isExplicitlyDisabled;

    const engage = config.behavior?.pageEngagementMs ?? { min: 20_000, max: 40_000 };
    this.engageMinMs = Math.max(3_000, engage.min);
    this.engageMaxMs = Math.max(this.engageMinMs, engage.max);

    const all: Personality[] = ["shopper", "researcher", "browser", "browser_fast"];
    this.personality = personality ?? rng.pick(all) ?? "shopper";
    this.cfg = PERSONALITIES[this.personality];

    const initialTargetCount = this.cartAllowed ? (this.cfg.targetAtcCount ?? 1) : 0;
    this.state = createAiSessionState(initialTargetCount);

    logger.info("personality", `Assigned: ${this.personality} (Target ATC: ${this.state.targetAtcCount} items)`);
  }

  private initPacingEngine(timer: SessionTimer): void {
    if (this.pacingInitialized) return;
    const totalMs = timer.plannedDurationMs;

    if (!this.cartAllowed || this.state.targetAtcCount === 0) {
      this.targetAtc1Ms = Number.MAX_SAFE_INTEGER;
      this.targetAtc2Ms = Number.MAX_SAFE_INTEGER;
      this.pacingInitialized = true;
      return;
    }

    const explicitAtcMs = (this.config as any)?.ai?.advanceActionTimeMs;
    if (explicitAtcMs && explicitAtcMs > 0 && explicitAtcMs < Number.MAX_SAFE_INTEGER) {
      // User specifically configured ATC time (e.g. 4 minutes)
      const halfWindow = Math.min(15_000, Math.round(explicitAtcMs * 0.1));
      const targetStart = Math.max(3_000, explicitAtcMs - halfWindow);
      const targetEnd = Math.min(Math.max(targetStart, totalMs - 5_000), explicitAtcMs + halfWindow);
      this.targetAtc1Ms = this.rng.int(targetStart, Math.max(targetStart, targetEnd));
    } else {
      // Elastic ATC Window 1: 30% -> 55% of session duration
      const win1Start = Math.round(totalMs * 0.30);
      const win1End = Math.round(totalMs * 0.55);
      this.targetAtc1Ms = this.rng.int(win1Start, win1End);
    }

    // Elastic ATC Window 2: 65% -> 85% of session duration
    if (this.state.targetAtcCount >= 2) {
      const win2Start = Math.round(totalMs * 0.65);
      const win2End = Math.round(totalMs * 0.85);
      this.targetAtc2Ms = this.rng.int(win2Start, win2End);
    } else {
      this.targetAtc2Ms = Number.MAX_SAFE_INTEGER;
    }

    this.pacingInitialized = true;
    this.logger.info("pacing_engine_init",
      `Elastic ATC Pacing Configured | Total: ${Math.round(totalMs/1000)}s | ` +
      `ATC-1 Target: ${Math.round(this.targetAtc1Ms/1000)}s | ` +
      `ATC-2 Target: ${this.targetAtc2Ms < Number.MAX_SAFE_INTEGER ? Math.round(this.targetAtc2Ms/1000) + 's' : 'N/A'}`
    );
  }

  get atcPending(): boolean {
    if (!this.cartAllowed) return false;
    return this.state.addToCartCount < this.state.targetAtcCount;
  }

  hasAtcControl(): boolean {
    return this.state.cachedAddToCart !== null;
  }

  wantsFinalAtcTurn(timer?: SessionTimer): boolean {
    if (!this.atcPending) return false;
    if (!timer) return true;
    const currentTarget = this.state.addToCartCount === 0 ? this.targetAtc1Ms : this.targetAtc2Ms;
    return currentTarget <= timer.plannedDurationMs + 30_000;
  }

  requestForceAtc(): void {
    if (!this.cartAllowed) {
      this.logger.warn("force_atc_denied", "operator forced ATC but safety.allowCart=false");
      return;
    }
    this.forcedAtcPending = true;
    this.forcedAtcTurns = 0;
  }

  notifyAtcResult(verified: boolean, details?: { url?: string; reason?: string }): void {
    if (verified) {
      this.state.addToCartCount++;
      this.state.advanceActionPerformed = true;
      this.logger.info("fsm_atc_verified", `ATC #${this.state.addToCartCount} SUCCESSFUL!`);

      if (this.state.addToCartCount < this.state.targetAtcCount) {
        this.transitionTo("SEEK_PRODUCT_2", "ATC 1 verified -> moving to find product 2");
      } else {
        this.transitionTo("POST_ATC_BROWSE", "All target ATCs completed -> post browse");
      }
    } else {
      this.state.rescueAttempts++;
      this.logger.warn("fsm_atc_failed", `ATC attempt unverified (${this.state.rescueAttempts}/3)`);
      if (details?.url) {
        this.state.soldOutProducts.add(this.clean(details.url));
      }
      if (this.state.rescueAttempts <= 3) {
        this.transitionTo("SEEK_PRODUCT", "ATC failed/sold-out -> Triggering Rescue to find substitute product");
      } else {
        this.transitionTo("POST_ATC_BROWSE", "Max rescue attempts reached -> continuing browse");
      }
    }
  }

  private transitionTo(nextState: ShopperState, reason: string): void {
    const prev = this.state.currentState;
    if (prev !== nextState) {
      this.state.currentState = nextState;
      this.logger.info("fsm_transition", `[${prev}] -> [${nextState}] | Reason: ${reason}`);
    }
  }

  inheritVisitState(snap: VisitStateSnapshot): void {
    if (snap.personality && snap.personality in PERSONALITIES) {
      this.personality = snap.personality as Personality;
      this.cfg = PERSONALITIES[this.personality];
    }
    if (snap.shopperState) this.state.currentState = snap.shopperState;
    for (const p of snap.visitedProducts ?? []) this.state.visitedProducts.add(p);
    for (const l of snap.visitedListings ?? []) this.state.visitedListings.add(l);
    for (const s of snap.soldOutProducts ?? []) this.state.soldOutProducts.add(s);
    if (snap.advanceActionPerformed) this.state.advanceActionPerformed = true;
    this.state.addToCartCount = Math.max(this.state.addToCartCount, snap.addToCartCount ?? 0);
    this.state.targetAtcCount = snap.targetAtcCount ?? this.state.targetAtcCount;
    for (const [path, plan] of snap.atcPlans ?? []) this.state.atcPlans.set(path, plan);
    if (snap.lastPlanUrl) this.lastPlanUrl = snap.lastPlanUrl;
    if (snap.cachedAddToCart && !this.state.cachedAddToCart) {
      this.state.cachedAddToCart = snap.cachedAddToCart;
    }
    if (snap.targetAtc1Ms) this.targetAtc1Ms = snap.targetAtc1Ms;
    if (snap.targetAtc2Ms) this.targetAtc2Ms = snap.targetAtc2Ms;
    this.pacingInitialized = true;
  }

  exportVisitState(): VisitStateSnapshot {
    return {
      personality: this.personality,
      shopperState: this.state.currentState,
      visitedProducts: [...this.state.visitedProducts],
      visitedListings: [...this.state.visitedListings],
      soldOutProducts: [...this.state.soldOutProducts],
      advanceActionPerformed: this.state.advanceActionPerformed,
      addToCartCount: this.state.addToCartCount,
      targetAtcCount: this.state.targetAtcCount,
      targetAtc1Ms: this.targetAtc1Ms,
      targetAtc2Ms: this.targetAtc2Ms,
      ...(this.state.atcPlans.size ? { atcPlans: [...this.state.atcPlans.entries()] } : {}),
      ...(this.lastPlanUrl ? { lastPlanUrl: this.lastPlanUrl } : {}),
      ...(this.state.cachedAddToCart ? { cachedAddToCart: this.state.cachedAddToCart } : {}),
    };
  }

  rememberAtcPlan(pageUrl: string, plan: AtcPlan): void {
    try {
      const key = new URL(pageUrl, this.storefront).pathname.replace(/\/+$/, "");
      this.state.atcPlans.set(key, plan);
      if (this.state.atcPlans.size > 20) {
        const oldest = this.state.atcPlans.keys().next().value;
        if (oldest) this.state.atcPlans.delete(oldest);
      }
      const u = new URL(pageUrl);
      this.lastPlanUrl = u.origin + u.pathname.replace(/\/+$/, "");
    } catch {}
  }

  plannedAtcTargetUrl(currentUrl: string): string | null {
    if (this.getAtcPlanFor(currentUrl)) return null;
    return this.lastPlanUrl;
  }

  getAtcPlanFor(pageUrl: string): AtcPlan | undefined {
    try {
      const key = new URL(pageUrl, this.storefront).pathname.replace(/\/+$/, "");
      return this.state.atcPlans.get(key);
    } catch {
      return undefined;
    }
  }

  async decide(
    detector: ElementDetector,
    currentUrl: string,
    htmlSource: string,
    timer: SessionTimer,
  ): Promise<AiDecision> {
    this.initPacingEngine(timer);

    if (timer.isExpired() && !this.wantsFinalAtcTurn(timer)) {
      return { action: "exit", reason: "timer_expired" };
    }

    const elapsed = timer.elapsedMs();
    const isProductPage = currentUrl.includes("/products/");
    const isCartPage = currentUrl.includes("/cart") || currentUrl.includes("/checkout");
    const pageKey = this.clean(currentUrl);

    if (pageKey !== this.state.currentPageKey) {
      this.state.currentPageKey = pageKey;
      this.state.pageEnteredElapsedMs = elapsed;
      if (isProductPage) {
        this.state.visitedProducts.add(pageKey);
      }
    }
    const onPageMs = Math.max(0, elapsed - this.state.pageEnteredElapsedMs);
    const onPageSecs = Math.round(onPageMs / 1000);

    if (isCartPage) {
      if (this.state.currentState === "CART_ABANDONMENT" || this.state.currentState === "POST_ATC_BROWSE") {
        return { action: "go_back", reason: "cart viewed, simulating classic abandonment" };
      }
      return { action: "go_back", reason: "navigating back from cart" };
    }

    // Handle operator Force ATC
    if (this.forcedAtcPending && this.state.cachedAddToCart) {
      this.forcedAtcPending = false;
      this.state.advanceActionPerformed = true;
      this.state.addToCartCount++;
      return { action: "add_to_cart", targetElement: this.state.cachedAddToCart, reason: "operator forced ATC" };
    }
    if (this.forcedAtcPending && ++this.forcedAtcTurns > 10) {
      this.forcedAtcPending = false;
      this.logger.warn("force_atc_expired", "no add-to-cart control detected within 10 turns");
    }

    const isTargetingProduct2 = this.state.addToCartCount === 1 && this.state.targetAtcCount >= 2;
    const currentTargetAtcMs = isTargetingProduct2 ? this.targetAtc2Ms : this.targetAtc1Ms;
    const msToAtc = currentTargetAtcMs - elapsed;

    // 1. Automatic FSM State Transitions
    if (this.atcPending) {
      if (this.state.currentState === "INITIAL_EXPLORE") {
        if (msToAtc <= this.atcLeadTimeMs || isProductPage) {
          this.transitionTo(isProductPage ? "ENGAGE_PRODUCT" : "SEEK_PRODUCT",
            isProductPage ? "Landed on PDP during initial explore" : `Within lead time (${Math.round(msToAtc/1000)}s to ATC)`
          );
        }
      } else if (this.state.currentState === "SEEK_PRODUCT_2" && isProductPage) {
        this.transitionTo("ENGAGE_PRODUCT", "Landed on Product 2 PDP");
      } else if (this.state.currentState === "SEEK_PRODUCT" && isProductPage) {
        this.transitionTo("ENGAGE_PRODUCT", "Landed on target Product PDP");
      }
    }

    // 2. Element Detection
    const needsDetection = !this.state.cachedProductLinks.length || this.state.lastDetectionUrl !== currentUrl;
    if (needsDetection) {
      try {
        const intent = isProductPage ? "interact" : "discover";
        const result = await detector.detect(currentUrl, htmlSource, { intent });
        this.state.aiCallsCount++;
        this.state.aiCallsTotalMs += result.elapsedMs;
        this.state.lastDetectionUrl = currentUrl;
        this.state.cachedProductLinks = result.products;

        if (result.addToCart?.selector) {
          this.state.cachedAddToCart = {
            kind: "add_to_cart",
            selector: result.addToCart.selector,
            text: result.addToCart.text,
            confidence: 0.9,
          };
        }
        if (result.plan) this.rememberAtcPlan(currentUrl, result.plan);
        this.logger.info("ai_scan", `${intent} detected products=${result.products.length} atc=${!!result.addToCart} (cached: ${result.cached})`);
      } catch (err) {
        this.logger.warn("ai_failed", err instanceof Error ? err.message : String(err), { url: currentUrl });
      }
    }

    // 3. Sold-out detection
    if (isProductPage) {
      const isSoldOut = this.detectSoldOutFromHtml(htmlSource);
      if (isSoldOut) {
        this.logger.warn("sold_out_detected", `Product is sold out: ${currentUrl}`);
        this.state.soldOutProducts.add(pageKey);
        this.state.cachedAddToCart = null;
        if (this.atcPending) {
          this.transitionTo("SEEK_PRODUCT", "Sold out PDP detected -> Rescuing to another product");
          const target = this.pickNextProductUrl();
          if (target) {
            return { action: "goto_product", url: target, reason: "Rescue: product sold out, going to next" };
          }
          return { action: "go_back", reason: "Rescue: product sold out, navigating back" };
        }
      }
    }

    // ── STATE: INITIAL_EXPLORE ──
    if (this.state.currentState === "INITIAL_EXPLORE") {
      const canNavigate = onPageMs >= this.engageMinMs;
      if (!canNavigate) {
        return this.naturalEngageAction("browsing store naturally (initial explore)");
      }

      const unvisited = this.state.cachedProductLinks.filter(p => !this.state.visitedProducts.has(this.clean(p.url)));
      if (unvisited.length > 0 && this.rng.chance(0.6)) {
        const pick = this.rng.pick(unvisited)!;
        const targetUrl = pick.url.startsWith("http") ? pick.url : this.storefront + pick.url;
        return { action: "goto_product", url: targetUrl, reason: "explore product from home/collection" };
      }

      const listing = this.pickListingPath(htmlSource);
      if (listing) {
        this.state.visitedListings.add(listing);
        return { action: "goto_collection", url: this.storefront + listing, reason: "browse catalog collection" };
      }

      return this.naturalEngageAction("browsing homepage/listings");
    }

    // ── STATE: SEEK_PRODUCT / SEEK_PRODUCT_2 ──
    if (this.state.currentState === "SEEK_PRODUCT" || this.state.currentState === "SEEK_PRODUCT_2") {
      if (isProductPage) {
        this.transitionTo("ENGAGE_PRODUCT", "Already on PDP -> Locking on product");
      } else {
        const candidates = this.state.cachedProductLinks.filter(p => {
          const cleanUrl = this.clean(p.url);
          return !this.state.visitedProducts.has(cleanUrl) && !this.state.soldOutProducts.has(cleanUrl);
        });

        if (candidates.length > 0) {
          const pick = this.rng.pick(candidates)!;
          const targetUrl = pick.url.startsWith("http") ? pick.url : this.storefront + pick.url;
          return { action: "goto_product", url: targetUrl, reason: `Targeting product for ATC (${candidates.length} candidates)` };
        }

        const fallbackTarget = this.prepTargetUrl();
        if (fallbackTarget && !this.state.soldOutProducts.has(this.clean(fallbackTarget))) {
          return { action: "goto_product", url: fallbackTarget, reason: "Targeting product from memory" };
        }

        const listing = this.pickListingPath(htmlSource);
        if (listing) {
          return { action: "goto_collection", url: this.storefront + listing, reason: "Seeking product in collection" };
        }

        return { action: "scroll", reason: "Searching for product links on page" };
      }
    }

    // ── STATE: ENGAGE_PRODUCT (LOCK-ON-PDP PROTOCOL) ──
    if (this.state.currentState === "ENGAGE_PRODUCT") {
      if (!isProductPage) {
        const target = this.prepTargetUrl();
        if (target) {
          return { action: "goto_product", url: target, reason: "Returning to locked PDP for ATC" };
        }
      }

      const isDueForAtc = msToAtc <= 0 || (timer.isExpired() && this.wantsFinalAtcTurn(timer));
      if (isDueForAtc && this.cartAllowed) {
        const nextExecState = isTargetingProduct2 ? "EXECUTE_ATC_2" : "EXECUTE_ATC_1";
        this.transitionTo(nextExecState, `Target timestamp reached (${Math.round(currentTargetAtcMs/1000)}s) -> Executing ATC`);

        const atcElem = this.state.cachedAddToCart ?? { kind: "add_to_cart", selector: "", text: "Add to cart", confidence: 0.85 };
        return {
          action: "add_to_cart",
          targetElement: atcElem,
          plan: this.getAtcPlanFor(currentUrl),
          reason: `Executing ATC at target mark ${Math.round(currentTargetAtcMs/1000)}s`,
        };
      }

      // Lock on product page: NO REDIRECTS, ONLY SCROLL & DWELL
      const atcCapMs = msToAtc > 0 ? Math.max(1500, Math.min(6000, msToAtc)) : undefined;
      return this.naturalEngageAction(`reading & interacting with product (${onPageSecs}s, ${Math.round(msToAtc/1000)}s to ATC)`, atcCapMs);
    }

    // ── STATE: EXECUTE_ATC_1 / EXECUTE_ATC_2 ──
    if (this.state.currentState === "EXECUTE_ATC_1" || this.state.currentState === "EXECUTE_ATC_2") {
      const atcElem = this.state.cachedAddToCart ?? { kind: "add_to_cart", selector: "", text: "Add to cart", confidence: 0.85 };
      return {
        action: "add_to_cart",
        targetElement: atcElem,
        plan: this.getAtcPlanFor(currentUrl),
        reason: `Executing ATC in state ${this.state.currentState}`,
      };
    }

    // ── STATE: POST_ATC_BROWSE / CART_ABANDONMENT ──
    if (this.state.currentState === "POST_ATC_BROWSE" || this.state.currentState === "CART_ABANDONMENT") {
      if (this.rng.chance(0.25) && !isCartPage) {
        return { action: "goto_collection", url: this.storefront + "/cart", reason: "Visiting cart page (abandonment flow)" };
      }

      const canNavigate = onPageMs >= this.engageMinMs;
      if (!canNavigate) {
        return this.naturalEngageAction(`post-ATC relaxed browsing (${onPageSecs}s)`);
      }

      const candidates = this.state.cachedProductLinks.filter(p => !this.state.visitedProducts.has(this.clean(p.url)));
      if (candidates.length > 0 && this.rng.chance(0.5)) {
        const pick = this.rng.pick(candidates)!;
        const targetUrl = pick.url.startsWith("http") ? pick.url : this.storefront + pick.url;
        return { action: "goto_product", url: targetUrl, reason: "post-ATC glance at another product" };
      }

      const listing = this.pickListingPath(htmlSource);
      if (listing && this.rng.chance(0.6)) {
        return { action: "goto_collection", url: this.storefront + listing, reason: "post-ATC browsing collections" };
      }

      return this.naturalEngageAction("relaxing and scrolling store");
    }

    return { action: "scroll", reason: "fallback default scroll" };
  }

  private naturalEngageAction(reason: string, maxMs?: number): AiDecision {
    if (this.rng.chance(this.cfg.dwellChance)) {
      return { action: "dwell", ...(maxMs ? { maxMs } : {}), reason: `Dwell: ${reason}` };
    }
    return { action: "scroll", ...(maxMs ? { maxMs } : {}), reason: `Scroll: ${reason}` };
  }

  private detectSoldOutFromHtml(html: string): boolean {
    const lower = html.toLowerCase();
    if (/CONTROLS:[\s\S]*?(sold\s*out|out\s*of\s*stock|hết\s*hàng|tạm\s*hết)/i.test(html)) return true;
    if (lower.includes('"availability":"https://schema.org/outofstock"')) return true;
    if (lower.includes('"availability":"http://schema.org/outofstock"')) return true;
    return false;
  }

  private pickNextProductUrl(): string | null {
    const candidates = this.state.cachedProductLinks.filter(p => {
      const cleanUrl = this.clean(p.url);
      return !this.state.visitedProducts.has(cleanUrl) && !this.state.soldOutProducts.has(cleanUrl);
    });
    if (candidates.length > 0) {
      const pick = this.rng.pick(candidates)!;
      return pick.url.startsWith("http") ? pick.url : this.storefront + pick.url;
    }
    return null;
  }

  private prepTargetUrl(): string | null {
    if (this.lastPlanUrl && !this.state.soldOutProducts.has(this.clean(this.lastPlanUrl))) {
      return this.lastPlanUrl;
    }
    return this.pickNextProductUrl();
  }

  private pickListingPath(digest: string): string | null {
    let section = "";
    for (const rawLine of digest.split("\n")) {
      const line = rawLine.trim();
      if (line === "CONTROLS:") break;
      if (line === "LINKS:") { section = "links"; continue; }
      if (section !== "links" || !line.startsWith("/")) continue;
      const path = (line.split(" | ")[0] ?? "").split("?")[0] ?? "";
      if (/^\/collections\/[^/]+\/?$/.test(path) && !this.state.visitedListings.has(path)) {
        return path;
      }
    }
    return null;
  }

  private clean(url: string): string {
    try {
      return new URL(url, this.storefront).pathname.split("?")[0] ?? url;
    } catch {
      return url;
    }
  }
}
