/**
 * src/behavior/aiEngine.ts
 *
 * Goal-oriented shopper state machine driving the elastic pre-checkout
 * choreography (see choreography.ts for the time plan).
 *
 *   INITIAL_EXPLORE ──(20% of pre-ATC)──► COMPARE_PRODUCTS ──(deep start)──► SEEK_PRODUCT
 *     discovery: home → collection,        open A, media + price,            pick B (or back to A)
 *     hover cards                          Back to the listing
 *
 *   SEEK_PRODUCT ──► ENGAGE_PRODUCT ──(mark)──► EXECUTE_ATC_1 ──verified──► INSPECT_CART
 *                    gallery, details,                                       drawer or /cart,
 *                    variants 15–40 s                                        cart left intact
 *                    before the mark
 *
 *   INSPECT_CART ──► SEEK_PRODUCT_2 … EXECUTE_ATC_2 (two-item personalities)
 *                └─► POST_ATC_BROWSE ──(last seconds)──► park on the cart, ready for checkout
 */
import type { ChoreographyConfig, SimulatorConfig } from "../config.js";
import { DEFAULT_CHOREOGRAPHY } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Rng } from "../util/random.js";
import type { SessionTimer } from "../session/timer.js";
import type { DetectedProduct } from "../ai/elementDetector.js";
import type { PageDetector, PageFeatures } from "../ai/detectionWaterfall.js";
import type { AiDecision, AiDetectedElement, AtcPlan } from "../types.js";
import { planChoreography, secondProductWindow, type ChoreographyPhase, type ChoreographyPlan } from "./choreography.js";

export type Personality = "browser" | "browser_fast" | "shopper" | "researcher";

/** Core states for Goal-Oriented Shopper State Machine */
export type ShopperState =
  | "INITIAL_EXPLORE"
  | "COMPARE_PRODUCTS"
  | "SEEK_PRODUCT"
  | "ENGAGE_PRODUCT"
  | "EXECUTE_ATC_1"
  | "VERIFY_ATC"
  | "SEEK_PRODUCT_2"
  | "EXECUTE_ATC_2"
  | "INSPECT_CART"
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
  choreographyPlan?: ChoreographyPlan;
  comparedProducts?: string[];
  compareDone?: number;
  atc1DoneAtMs?: number;
  completedAtcProducts?: string[];
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
  completedAtcProducts: Set<string>;
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
    completedAtcProducts: new Set(),
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

/** What the visitor has done on the product page currently open. */
interface PdpProgress {
  key: string;
  media: number;
  sections: number;
  selected: boolean;
  variants: number;
  /** Failed gallery looks on this page. One miss is a layout race, not proof there is no gallery. */
  mediaMisses: number;
  /** Features the executor found nothing for on this page. */
  exhausted: Set<string>;
}

type ActionResult = { performed?: number; variantId?: string | null; navigated?: boolean };

export class AiBehaviorEngine {
  readonly state: AiSessionState;
  personality: Personality;
  private cfg: PersonalityConfig;
  private readonly logger: Logger;
  private readonly rng: Rng;
  private readonly storefront: string;
  private readonly cartAllowed: boolean;

  private readonly config: SimulatorConfig;
  private readonly choreo: ChoreographyConfig;
  private readonly engageMinMs: number;
  private readonly engageMaxMs: number;

  /** Pacing Engine: Elastic Windows for ATC 1 & ATC 2 */
  private targetAtc1Ms: number = 0;
  private targetAtc2Ms: number = 0;
  private atcLeadTimeMs: number = 35_000;
  private pacingInitialized = false;
  private plan: ChoreographyPlan | null = null;
  private second: { deepStartMs: number; exploreLeadMs: number } | null = null;

  private forcedAtcPending = false;
  private forcedAtcTurns = 0;
  private lastPlanUrl: string | null = null;

  private readonly features = new Map<string, PageFeatures>();
  private pdp: PdpProgress = { key: "", media: 0, sections: 0, selected: false, variants: 0, mediaMisses: 0, exhausted: new Set() };
  private readonly triedVariants = new Map<string, Set<string>>();
  private readonly comparedProducts = new Set<string>();
  /** Details sections read anywhere in this visit. */
  private sectionsRead = 0;
  /** Products whose add-to-cart did not register; never retried. */
  private readonly failedAtcProducts = new Set<string>();
  private compareDone = 0;
  private compareCurrent: string | null = null;
  private compareMediaSeen = false;
  private lastListingUrl: string | null = null;
  private readonly hoveredPages = new Set<string>();
  private pendingInspect: { pageKey: string; budgetMs: number } | null = null;
  private parkedOnCart = false;
  private atc1DoneAtMs = 0;
  private lastElapsedMs = 0;
  private lastRemainingMs = Number.MAX_SAFE_INTEGER;

  constructor(config: SimulatorConfig, rng: Rng, logger: Logger, personality?: Personality) {
    this.config = config;
    this.rng = rng;
    this.logger = logger;
    this.storefront = config.storefront;
    this.choreo = { ...DEFAULT_CHOREOGRAPHY, ...(config.behavior?.choreography ?? {}) };

    const explicitAtcMs = (config as any)?.ai?.advanceActionTimeMs;
    const isExplicitlyDisabled = config.safety?.allowCart === false || explicitAtcMs === Number.MAX_SAFE_INTEGER;
    this.cartAllowed = !isExplicitlyDisabled;

    const engage = config.behavior?.pageEngagementMs ?? { min: 20_000, max: 40_000 };
    const speed = Number.isFinite(config.behavior?.speedFactor) && (config.behavior?.speedFactor ?? 0) > 0
      ? config.behavior!.speedFactor
      : 1;
    this.engageMinMs = Math.max(1_500, Math.round(engage.min / speed));
    this.engageMaxMs = Math.max(this.engageMinMs, Math.round(engage.max / speed));

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
      this.plan = planChoreography({ targetAtcMs: Number.MAX_SAFE_INTEGER, rng: this.rng, cfg: this.choreo });
      this.pacingInitialized = true;
      return;
    }

    const explicitAtcMs = (this.config as any)?.ai?.advanceActionTimeMs;
    if (explicitAtcMs && explicitAtcMs > 0 && explicitAtcMs < Number.MAX_SAFE_INTEGER) {
      // User specifically configured ATC time (e.g. 4 minutes)
      const halfWindow = Math.min(15_000, Math.round(explicitAtcMs * 0.1));
      let targetStart = Math.max(3_000, explicitAtcMs - halfWindow);
      const targetEnd = Math.min(Math.max(targetStart, totalMs - 5_000), explicitAtcMs + halfWindow);
      // The operator asked for a mark of at least 2 minutes, which is what turns
      // product comparison on. A 10% jitter must not drop that mark under the
      // threshold and silently skip the Back step.
      if (explicitAtcMs >= this.choreo.compareMinAtcMs) targetStart = Math.max(targetStart, this.choreo.compareMinAtcMs);
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
      this.targetAtc2Ms = Math.max(this.rng.int(win2Start, win2End), this.targetAtc1Ms + 15_000);
    } else {
      this.targetAtc2Ms = Number.MAX_SAFE_INTEGER;
    }

    this.plan = planChoreography({ targetAtcMs: this.targetAtc1Ms, rng: this.rng, cfg: this.choreo });
    this.pacingInitialized = true;
    const p = this.plan;
    this.logger.info("pacing_engine_init",
      `Elastic ATC Pacing Configured | Total: ${Math.round(totalMs/1000)}s | ` +
      `ATC-1 Target: ${Math.round(this.targetAtc1Ms/1000)}s | ` +
      `ATC-2 Target: ${this.targetAtc2Ms < Number.MAX_SAFE_INTEGER ? Math.round(this.targetAtc2Ms/1000) + 's' : 'N/A'}`
    );
    this.logger.info("choreography_plan",
      `discovery→${Math.round(p.discoveryEndMs / 1000)}s | compare ${p.compareEnabled ? `${p.compareTarget}x (${Math.round(p.compareDwellMs / 1000)}s each)` : "off"} | ` +
      `deep PDP ${Math.round(p.deepStartMs / 1000)}s→${Math.round(p.targetAtcMs / 1000)}s | variants ${Math.round(p.exploreLeadMs / 1000)}s before ATC | ` +
      `media ${p.mediaTarget} · sections ${p.sectionTarget} · variants ${p.variantTarget} · cart review ${Math.round(p.inspectCartMs / 1000)}s`,
      { data: { ...p } },
    );
  }

  get atcPending(): boolean {
    if (!this.cartAllowed) return false;
    return this.state.addToCartCount < this.state.targetAtcCount;
  }

  hasAtcControl(): boolean {
    return this.state.cachedAddToCart !== null;
  }

  /** The time plan this visit follows (null until the first decision). */
  get choreographyPlan(): ChoreographyPlan | null {
    return this.plan;
  }

  /** Where the visit is in its pre-checkout story, for the dashboard. */
  get currentPhase(): ChoreographyPhase {
    if (!this.plan?.enabled) return "browse";
    switch (this.state.currentState) {
      case "INITIAL_EXPLORE": return "discovery";
      case "COMPARE_PRODUCTS": return "compare";
      case "SEEK_PRODUCT":
      case "ENGAGE_PRODUCT": return "deep_pdp";
      case "EXECUTE_ATC_1":
      case "EXECUTE_ATC_2":
      case "VERIFY_ATC": return "add_to_cart";
      case "INSPECT_CART": return "inspect_cart";
      case "SEEK_PRODUCT_2": return this.second && this.lastElapsedMs >= this.second.deepStartMs ? "deep_pdp" : "post_atc";
      default:
        return this.parkedOnCart || this.lastRemainingMs <= this.choreo.checkoutReadyLeadMs ? "checkout_ready" : "post_atc";
    }
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

  /** Tier 0/1 facts about a page (gallery, sections, variants, stock). */
  notePageFeatures(url: string, features: PageFeatures): void {
    const key = this.clean(url);
    this.features.set(key, features);
    if (this.features.size > 120) {
      const oldest = this.features.keys().next().value;
      if (oldest) this.features.delete(oldest);
    }
    if (features.pageType === "product" && features.soldOut) this.state.soldOutProducts.add(key);
  }

  /** Variant ids already tried on a product page. */
  triedVariantsFor(url: string): Set<string> {
    const key = this.clean(url);
    let set = this.triedVariants.get(key);
    if (!set) {
      set = new Set();
      this.triedVariants.set(key, set);
    }
    return set;
  }

  /** Feed back what an executed step actually did, so nothing empty is retried. */
  noteActionResult(decision: AiDecision, result: ActionResult): void {
    const performed = result.performed ?? 0;
    const onPdp = this.state.currentPageKey === this.pdp.key;
    switch (decision.action) {
      case "view_media":
        if (performed > 0) {
          if (onPdp) this.pdp.media += performed;
          if (this.compareCurrent && this.compareCurrent === this.state.currentPageKey) this.compareMediaSeen = true;
        } else if (onPdp) {
          this.pdp.mediaMisses++;
          if (this.pdp.mediaMisses >= 2) this.pdp.exhausted.add("media");
        }
        break;
      case "read_section":
        if (performed > 0) this.sectionsRead++;
        if (performed > 0 && onPdp) this.pdp.sections++;
        else if (onPdp) this.pdp.exhausted.add("sections");
        break;
      case "select_text":
        if (onPdp) {
          if (performed > 0) this.pdp.selected = true;
          else this.pdp.exhausted.add("select");
        }
        break;
      case "explore_variants":
        if (performed > 0 && onPdp) this.pdp.variants++;
        else if (onPdp) this.pdp.exhausted.add("variants");
        if (result.variantId && this.state.currentPageKey) this.triedVariantsFor(this.state.currentPageKey).add(result.variantId);
        break;
      case "hover_card":
        if (this.state.currentPageKey) this.hoveredPages.add(this.state.currentPageKey);
        break;
      case "inspect_cart":
        if (decision.park) this.parkedOnCart = true;
        break;
      default:
        break;
    }
  }

  notifyAtcResult(verified: boolean, details?: { url?: string; reason?: string }): void {
    if (verified) {
      this.state.addToCartCount++;
      this.state.advanceActionPerformed = true;
      if (details?.url) {
        const cleanDone = this.clean(details.url);
        this.state.completedAtcProducts.add(cleanDone);
        this.state.visitedProducts.add(cleanDone);
      }
      this.logger.info("fsm_atc_verified", `ATC #${this.state.addToCartCount} SUCCESSFUL!`);
      if (this.state.addToCartCount === 1) this.atc1DoneAtMs = this.lastElapsedMs;
      if (this.state.addToCartCount < this.state.targetAtcCount && this.targetAtc2Ms < Number.MAX_SAFE_INTEGER && this.plan) {
        this.second = secondProductWindow(this.plan, { targetAtcMs: this.targetAtc2Ms, startedAtMs: this.lastElapsedMs, cfg: this.choreo });
      }
      // Review what was just added before anything else happens.
      const budgetMs = this.state.addToCartCount === 1 && this.plan
        ? this.plan.inspectCartMs
        : this.rng.int(this.choreo.inspectCartMs.min, this.choreo.inspectCartMs.max);
      this.pendingInspect = { pageKey: details?.url ? this.clean(details.url) : (this.state.currentPageKey ?? ""), budgetMs };
      this.transitionTo("INSPECT_CART", `ATC #${this.state.addToCartCount} verified -> reviewing cart`);
    } else {
      this.state.rescueAttempts++;
      this.logger.warn("fsm_atc_failed", `ATC attempt unverified (${this.state.rescueAttempts}/3)`);
      if (details?.url) {
        // An unverified click is not proof the product is sold out. Stock still
        // comes from the oracle or from the buy button's own label.
        this.failedAtcProducts.add(this.clean(details.url));
      }
      if (this.state.rescueAttempts <= 3) {
        this.transitionTo("SEEK_PRODUCT", "ATC failed/sold-out -> Triggering Rescue to find substitute product");
      } else {
        this.transitionTo("POST_ATC_BROWSE", "Max rescue attempts reached -> continuing browse");
      }
    }
  }

  private nextStateAfterAtc(): ShopperState {
    return this.state.addToCartCount < this.state.targetAtcCount ? "SEEK_PRODUCT_2" : "POST_ATC_BROWSE";
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
    for (const c of snap.completedAtcProducts ?? []) this.state.completedAtcProducts.add(c);
    for (const c of snap.comparedProducts ?? []) this.comparedProducts.add(c);
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
    if (snap.choreographyPlan) this.plan = snap.choreographyPlan;
    else this.plan = planChoreography({ targetAtcMs: this.targetAtc1Ms || Number.MAX_SAFE_INTEGER, rng: this.rng, cfg: this.choreo });
    if (snap.compareDone) this.compareDone = snap.compareDone;
    if (snap.atc1DoneAtMs) this.atc1DoneAtMs = snap.atc1DoneAtMs;
    if (this.state.currentState === "INSPECT_CART") this.state.currentState = this.nextStateAfterAtc();
    this.pacingInitialized = true;
  }

  exportVisitState(): VisitStateSnapshot {
    return {
      personality: this.personality,
      shopperState: this.state.currentState,
      visitedProducts: [...this.state.visitedProducts],
      visitedListings: [...this.state.visitedListings],
      soldOutProducts: [...this.state.soldOutProducts],
      completedAtcProducts: [...this.state.completedAtcProducts],
      advanceActionPerformed: this.state.advanceActionPerformed,
      addToCartCount: this.state.addToCartCount,
      targetAtcCount: this.state.targetAtcCount,
      targetAtc1Ms: this.targetAtc1Ms,
      targetAtc2Ms: this.targetAtc2Ms,
      ...(this.plan ? { choreographyPlan: this.plan } : {}),
      comparedProducts: [...this.comparedProducts],
      compareDone: this.compareDone,
      ...(this.atc1DoneAtMs ? { atc1DoneAtMs: this.atc1DoneAtMs } : {}),
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
    detector: PageDetector,
    currentUrl: string,
    htmlSource: string,
    timer: SessionTimer,
  ): Promise<AiDecision> {
    this.initPacingEngine(timer);

    if (timer.isExpired() && !this.wantsFinalAtcTurn(timer)) {
      return { action: "exit", reason: "timer_expired" };
    }

    const elapsed = timer.elapsedMs();
    this.lastElapsedMs = elapsed;
    this.lastRemainingMs = timer.remainingMs();
    const isProductPage = (/\/products?\//i.test(currentUrl) || /\d{6,}\.html/i.test(currentUrl)) && !/\/products\/(cookie[-_]?consent|privacy|terms|account|login|search|wishlist)\/?/i.test(currentUrl);
    const isCartPage = this.isCartUrl(currentUrl) || currentUrl.includes("/checkout");
    const pageKey = this.clean(currentUrl);
    const plan = this.plan!;

    if (pageKey !== this.state.currentPageKey) {
      this.state.currentPageKey = pageKey;
      this.state.pageEnteredElapsedMs = elapsed;
      if (isProductPage) {
        this.state.visitedProducts.add(pageKey);
      }
      if (this.pdp.key !== pageKey) {
        this.pdp = { key: pageKey, media: 0, sections: 0, selected: false, variants: 0, mediaMisses: 0, exhausted: new Set() };
      }
      if (!isProductPage && !isCartPage) this.lastListingUrl = currentUrl;
    }
    const onPageMs = Math.max(0, elapsed - this.state.pageEnteredElapsedMs);
    const onPageSecs = Math.round(onPageMs / 1000);
    const allAtcDone = this.cartAllowed && this.state.targetAtcCount > 0 && this.state.addToCartCount >= this.state.targetAtcCount;
    const checkoutReady = allAtcDone && this.lastRemainingMs <= this.choreo.checkoutReadyLeadMs;

    // ── Cart page ──
    if (isCartPage) {
      if (this.pendingInspect) {
        const budget = this.pendingInspect.budgetMs;
        this.pendingInspect = null;
        this.transitionTo(this.nextStateAfterAtc(), "cart reviewed");
        return { action: "inspect_cart", maxMs: budget, phase: "inspect_cart", reason: `Reviewing the cart (${Math.round(budget / 1000)}s)` };
      }
      if (checkoutReady || this.parkedOnCart) {
        return { action: "dwell", maxMs: 4_000, phase: "checkout_ready", reason: "checkout-ready: holding the cart for checkout" };
      }
      if (this.state.currentState === "CART_ABANDONMENT" || this.state.currentState === "POST_ATC_BROWSE") {
        return { action: "go_back", reason: "cart viewed, simulating classic abandonment" };
      }
      return { action: "go_back", reason: "navigating back from cart" };
    }

    // Handle operator Force ATC
    if (this.forcedAtcPending && this.state.cachedAddToCart) {
      this.forcedAtcPending = false;
      this.state.advanceActionPerformed = true;
      return { action: "add_to_cart", targetElement: this.state.cachedAddToCart, reason: "operator forced ATC" };
    }
    if (this.forcedAtcPending && ++this.forcedAtcTurns > 10) {
      this.forcedAtcPending = false;
      this.logger.warn("force_atc_expired", "no add-to-cart control detected within 10 turns");
    }

    // ── Cart review right after a verified add ──
    if (this.pendingInspect) {
      const pending = this.pendingInspect;
      this.pendingInspect = null;
      this.transitionTo(this.nextStateAfterAtc(), pending.pageKey === pageKey ? "cart reviewed" : "visitor moved on before the cart review");
      if (pending.pageKey === pageKey) {
        return {
          action: "inspect_cart",
          maxMs: pending.budgetMs,
          phase: "inspect_cart",
          reason: `Reviewing the cart after ATC #${this.state.addToCartCount} (${Math.round(pending.budgetMs / 1000)}s)`,
        };
      }
    }

    const isTargetingProduct2 = this.state.addToCartCount === 1 && this.state.targetAtcCount >= 2;
    const currentTargetAtcMs = isTargetingProduct2 ? this.targetAtc2Ms : this.targetAtc1Ms;
    const msToAtc = currentTargetAtcMs - elapsed;
    const deepStartMs = isTargetingProduct2
      ? (this.second?.deepStartMs ?? currentTargetAtcMs - this.atcLeadTimeMs)
      : plan.enabled ? plan.deepStartMs : currentTargetAtcMs - this.atcLeadTimeMs;
    const exploreLeadMs = isTargetingProduct2 ? (this.second?.exploreLeadMs ?? plan.exploreLeadMs) : plan.exploreLeadMs;
    const inDeepWindow = elapsed >= deepStartMs;

    // 1. Automatic FSM State Transitions
    const isFreshPdpForAtc = isProductPage
      && !this.state.completedAtcProducts.has(pageKey)
      && !this.state.soldOutProducts.has(pageKey)
      && !this.failedAtcProducts.has(pageKey)
      && !(this.state.currentState === "COMPARE_PRODUCTS" && !inDeepWindow);
    if (this.atcPending) {
      if (this.state.currentState === "INITIAL_EXPLORE" || this.state.currentState === "COMPARE_PRODUCTS") {
        // The comparison under way on this product finishes with Back even
        // after the deep window opens, as long as the deep phase still has
        // room for the product that will actually be bought. Cutting it here
        // locks product A as the purchase and the Back step never happens.
        const compareUnderway =
          this.state.currentState === "COMPARE_PRODUCTS"
          && this.compareDone < plan.compareTarget
          && this.compareCurrent === pageKey
          && msToAtc > Math.max(12_000, plan.deepPhaseMs * 0.6);
        if (inDeepWindow && !compareUnderway) {
          this.transitionTo(isFreshPdpForAtc ? "ENGAGE_PRODUCT" : "SEEK_PRODUCT",
            isFreshPdpForAtc
              ? `On PDP when the deep phase opens (${Math.round(msToAtc/1000)}s to ATC)`
              : `Deep phase opens (${Math.round(msToAtc/1000)}s to ATC)`,
          );
          this.compareCurrent = null;
        } else if (
          this.state.currentState === "INITIAL_EXPLORE"
          && plan.compareEnabled
          && elapsed >= plan.discoveryEndMs
        ) {
          this.transitionTo("COMPARE_PRODUCTS", `Discovery done -> comparing products before choosing (${plan.compareTarget}x)`);
        }
      } else if (this.state.currentState === "SEEK_PRODUCT_2" && isFreshPdpForAtc && inDeepWindow) {
        this.transitionTo("ENGAGE_PRODUCT", "Landed on Product 2 PDP");
      } else if (this.state.currentState === "SEEK_PRODUCT" && isFreshPdpForAtc) {
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
        if (result.is_sold_out) this.state.soldOutProducts.add(pageKey);
        this.logger.info("ai_scan", `${intent} detected products=${result.products.length} atc=${!!result.addToCart} via ${result.accountSource} (cached: ${result.cached})`);
      } catch (err) {
        this.logger.warn("ai_failed", err instanceof Error ? err.message : String(err), { url: currentUrl });
      }
    }

    // 3. Sold-out detection — the product oracle's stock count outranks text heuristics.
    if (isProductPage) {
      const f = this.features.get(pageKey);
      const oracleInStock = !!f && f.pageType === "product" && f.inStockVariants > 0;
      if (oracleInStock) this.state.soldOutProducts.delete(pageKey);
      const isSoldOut = !oracleInStock && (this.state.soldOutProducts.has(pageKey) || this.detectSoldOutFromHtml(htmlSource));
      if (isSoldOut) {
        this.logger.warn("sold_out_detected", `Product is sold out: ${currentUrl}`);
        this.state.soldOutProducts.add(pageKey);
        this.state.cachedAddToCart = null;
        if (this.atcPending && this.state.currentState !== "COMPARE_PRODUCTS" && this.state.currentState !== "INITIAL_EXPLORE") {
          this.transitionTo("SEEK_PRODUCT", "Sold out PDP detected -> Rescuing to another product");
          const target = this.pickNextProductUrl();
          if (target) {
            return { action: "goto_product", url: target, reason: "Rescue: product sold out, going to next" };
          }
          return { action: "go_back", reason: "Rescue: product sold out, navigating back" };
        }
      }
    }

    // ── STATE: INITIAL_EXPLORE (discovery) ──
    if (this.state.currentState === "INITIAL_EXPLORE") {
      return this.discoveryTurn({ isProductPage, onPageMs, htmlSource, timer, phase: plan.enabled ? "discovery" : "browse" });
    }

    // ── STATE: COMPARE_PRODUCTS (open A, look, Back) ──
    if (this.state.currentState === "COMPARE_PRODUCTS") {
      return this.compareTurn({ isProductPage, pageKey, onPageMs, htmlSource, currentUrl, plan });
    }

    // ── STATE: SEEK_PRODUCT / SEEK_PRODUCT_2 ──
    if (this.state.currentState === "SEEK_PRODUCT" || this.state.currentState === "SEEK_PRODUCT_2") {
      if (this.state.currentState === "SEEK_PRODUCT_2" && !inDeepWindow) {
        return this.discoveryTurn({ isProductPage, onPageMs, htmlSource, timer, phase: "post_atc" });
      }
      if (isFreshPdpForAtc) {
        this.transitionTo("ENGAGE_PRODUCT", "Already on fresh PDP -> Locking on product");
      } else {
        // "…or back to product A": once two or more were compared, one of them
        // can be the one bought. A single comparison always moves on to B.
        const returnable = [...this.comparedProducts].filter((p) =>
          this.buyable(p) && !this.state.completedAtcProducts.has(p) && !this.state.soldOutProducts.has(p),
        );
        if (this.compareDone >= 2 && returnable.length && this.state.currentState === "SEEK_PRODUCT" && this.rng.chance(0.25)) {
          const back = this.rng.pick(returnable)!;
          return { action: "goto_product", url: this.absolute(back), phase: "deep_pdp", reason: "Back to a compared product to buy it" };
        }

        const candidates = this.state.cachedProductLinks.filter(p => {
          const cleanUrl = this.clean(p.url);
          return this.buyable(cleanUrl) && !this.state.visitedProducts.has(cleanUrl) && !this.state.soldOutProducts.has(cleanUrl) && !this.state.completedAtcProducts.has(cleanUrl);
        });

        if (candidates.length > 0) {
          const pick = this.rng.pick(candidates)!;
          return { action: "goto_product", url: this.absolute(pick.url), phase: "deep_pdp", reason: `Targeting product for ATC (${candidates.length} candidates)` };
        }

        const fallbackTarget = this.prepTargetUrl();
        if (fallbackTarget && this.buyable(fallbackTarget) && !this.state.soldOutProducts.has(this.clean(fallbackTarget)) && !this.state.completedAtcProducts.has(this.clean(fallbackTarget))) {
          return { action: "goto_product", url: fallbackTarget, phase: "deep_pdp", reason: "Targeting product from memory" };
        }

        // Everything listed here was already seen: a seen, in-stock product is
        // still a fine purchase (shoppers buy what they looked at earlier).
        if (returnable.length) {
          return { action: "goto_product", url: this.absolute(this.rng.pick(returnable)!), phase: "deep_pdp", reason: "Back to a compared product to buy it" };
        }
        const revisit = this.state.cachedProductLinks.filter((p) => {
          const c = this.clean(p.url);
          return this.buyable(c) && c !== pageKey && !this.state.soldOutProducts.has(c) && !this.state.completedAtcProducts.has(c);
        });
        if (revisit.length) {
          return { action: "goto_product", url: this.absolute(this.rng.pick(revisit)!.url), phase: "deep_pdp", reason: "Returning to a product seen earlier" };
        }

        const listing = this.pickListingPath(htmlSource);
        if (listing) {
          this.state.visitedListings.add(listing);
          return { action: "goto_collection", url: this.storefront + listing, phase: "deep_pdp", reason: "Seeking product in collection" };
        }

        return { action: "scroll", phase: "deep_pdp", reason: "Searching for product links on page" };
      }
    }

    // ── STATE: ENGAGE_PRODUCT (deep PDP) ──
    if (this.state.currentState === "ENGAGE_PRODUCT") {
      if (!isProductPage) {
        const target = this.prepTargetUrl();
        if (target) {
          return { action: "goto_product", url: target, phase: "deep_pdp", reason: "Returning to locked PDP for ATC" };
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
          phase: "add_to_cart",
          reason: `Executing ATC at target mark ${Math.round(currentTargetAtcMs/1000)}s`,
        };
      }

      return this.deepPdpTurn({ pageKey, msToAtc, exploreLeadMs, onPageSecs });
    }

    // ── STATE: EXECUTE_ATC_1 / EXECUTE_ATC_2 ──
    if (this.state.currentState === "EXECUTE_ATC_1" || this.state.currentState === "EXECUTE_ATC_2") {
      const atcElem = this.state.cachedAddToCart ?? { kind: "add_to_cart", selector: "", text: "Add to cart", confidence: 0.85 };
      return {
        action: "add_to_cart",
        targetElement: atcElem,
        plan: this.getAtcPlanFor(currentUrl),
        phase: "add_to_cart",
        reason: `Executing ATC in state ${this.state.currentState}`,
      };
    }

    // ── STATE: POST_ATC_BROWSE / CART_ABANDONMENT ──
    if (this.state.currentState === "POST_ATC_BROWSE" || this.state.currentState === "CART_ABANDONMENT" || this.state.currentState === "INSPECT_CART") {
      if (this.state.currentState === "INSPECT_CART") this.transitionTo(this.nextStateAfterAtc(), "cart review skipped");
      if (this.parkedOnCart) {
        return { action: "dwell", maxMs: 4_000, phase: "checkout_ready", reason: "checkout-ready: holding the cart for checkout" };
      }
      if (checkoutReady) {
        return { action: "inspect_cart", park: true, maxMs: 8_000, phase: "checkout_ready", reason: "checkout-ready: parking on the cart" };
      }
      const canNavigate = onPageMs >= this.engageMinMs;
      if (!canNavigate) {
        return this.pageEngagement(isProductPage, `post-ATC relaxed browsing (${onPageSecs}s)`, "post_atc");
      }

      const candidates = this.state.cachedProductLinks.filter(p => !this.state.visitedProducts.has(this.clean(p.url)));
      if (candidates.length > 0 && this.rng.chance(0.5)) {
        const pick = this.rng.pick(candidates)!;
        return { action: "goto_product", url: this.absolute(pick.url), phase: "post_atc", reason: "post-ATC glance at another product" };
      }

      const listing = this.pickListingPath(htmlSource);
      if (listing && this.rng.chance(0.6)) {
        return { action: "goto_collection", url: this.storefront + listing, phase: "post_atc", reason: "post-ATC browsing collections" };
      }

      return this.pageEngagement(isProductPage, "relaxing and scrolling store", "post_atc");
    }

    return { action: "scroll", reason: "fallback default scroll" };
  }

  private buyable(url: string): boolean {
    return !/\/products\/(cookie[-_]?consent|privacy|terms|account|login|search|wishlist)\/?/i.test(url);
  }

  /** Home → collection → product, with real attention on each page before moving on. */
  private discoveryTurn(input: { isProductPage: boolean; onPageMs: number; htmlSource: string; timer: SessionTimer; phase: ChoreographyPhase }): AiDecision {
    const { isProductPage, onPageMs, htmlSource, timer, phase } = input;
    const isInitialLanding = this.state.visitedProducts.size === 0 && this.state.visitedListings.size === 0;
    const effectiveFloorMs = isInitialLanding
      ? Math.min(this.engageMinMs, Math.max(2_000, Math.round(timer.plannedDurationMs * 0.06)))
      : this.engageMinMs;
    if (onPageMs < effectiveFloorMs) {
      return this.pageEngagement(isProductPage, "browsing store naturally (initial explore)", phase);
    }

    const listing = this.pickListingPath(htmlSource);
    const here = this.clean(this.state.currentPageKey ?? "/");
    const isHome = here === "/" || /^\/(?:[a-z]{2}(?:-[a-z]{2})?|world\/[a-z]{2})\/?$/i.test(here);
    if (isHome && listing && this.state.visitedListings.size === 0 && this.rng.chance(0.9)) {
      this.state.visitedListings.add(listing);
      return { action: "goto_collection", url: this.storefront + listing, phase, reason: "home -> category (collection first)" };
    }

    const unvisited = this.state.cachedProductLinks.filter(p => !this.state.visitedProducts.has(this.clean(p.url)));
    if (unvisited.length > 0 && (isProductPage || this.rng.chance(0.6))) {
      const pick = this.rng.pick(unvisited)!;
      return { action: "goto_product", url: this.absolute(pick.url), phase, reason: "explore product from home/collection" };
    }

    if (listing) {
      this.state.visitedListings.add(listing);
      return { action: "goto_collection", url: this.storefront + listing, phase, reason: "browse catalog collection" };
    }

    return this.pageEngagement(isProductPage, "browsing homepage/listings", phase);
  }

  /** Product A: a look at the gallery and the price, then Back to the listing. */
  private compareTurn(input: { isProductPage: boolean; pageKey: string; onPageMs: number; htmlSource: string; currentUrl: string; plan: ChoreographyPlan }): AiDecision {
    const { isProductPage, pageKey, onPageMs, htmlSource, plan } = input;
    if (isProductPage) {
      if (this.compareCurrent !== pageKey) {
        this.compareCurrent = pageKey;
        this.compareMediaSeen = false;
      }
      const f = this.features.get(pageKey);
      if (!this.compareMediaSeen && (f?.galleryCount ?? 0) > 1 && !this.pdp.exhausted.has("media")) {
        return { action: "view_media", count: this.rng.int(1, 2), maxMs: 6_500, phase: "compare", reason: "compare: glancing at product A's photos" };
      }
      const dwellMs = plan.compareDwellMs || 8_000;
      if (onPageMs < dwellMs) {
        const left = dwellMs - onPageMs;
        return this.rng.chance(0.6)
          ? { action: "scroll", maxMs: Math.max(1_500, Math.min(6_000, left)), phase: "compare", reason: "compare: checking price and details of product A" }
          : { action: "dwell", maxMs: Math.max(1_200, Math.min(5_000, left)), phase: "compare", reason: "compare: weighing product A" };
      }
      this.compareDone++;
      this.comparedProducts.add(pageKey);
      this.compareCurrent = null;
      return {
        action: "go_back",
        ...(this.lastListingUrl ? { url: this.lastListingUrl } : {}),
        phase: "compare",
        reason: `compare: back to the listing after product A (${this.compareDone}/${plan.compareTarget})`,
      };
    }

    // On the listing: a look around, then the next product to compare.
    const floor = Math.max(2_500, Math.round(this.engageMinMs * 0.35));
    if (onPageMs < floor) {
      if (!this.hoveredPages.has(pageKey) && this.rng.chance(0.6)) {
        return { action: "hover_card", count: this.rng.int(1, 2), maxMs: 5_000, phase: "compare", reason: "compare: eyeing product cards" };
      }
      return { action: "scroll", maxMs: 4_000, phase: "compare", reason: "compare: scanning the listing" };
    }
    const candidates = this.state.cachedProductLinks.filter((p) => {
      const c = this.clean(p.url);
      return !this.state.visitedProducts.has(c) && !this.comparedProducts.has(c) && !this.state.soldOutProducts.has(c);
    });
    if (candidates.length) {
      const pick = this.rng.pick(candidates)!;
      return { action: "goto_product", url: this.absolute(pick.url), phase: "compare", reason: `compare: opening product ${this.compareDone === 0 ? "A" : "B"} from the listing` };
    }
    const listing = this.pickListingPath(htmlSource);
    if (listing) {
      this.state.visitedListings.add(listing);
      return { action: "goto_collection", url: this.storefront + listing, phase: "compare", reason: "compare: another collection to choose from" };
    }
    return { action: "scroll", maxMs: 4_000, phase: "compare", reason: "compare: looking for products" };
  }

  /**
   * A first look at the photos, then the details, then more photos — each
   * step sized to end before size/colour exploration has to start, which
   * itself ends before the add-to-cart mark.
   */
  private deepPdpTurn(input: { pageKey: string; msToAtc: number; exploreLeadMs: number; onPageSecs: number }): AiDecision {
    const { pageKey, msToAtc, exploreLeadMs, onPageSecs } = input;
    const plan = this.plan!;
    const f = this.features.get(pageKey);
    const cap = msToAtc > 0 ? Math.max(1_500, Math.min(12_000, msToAtc - 500)) : undefined;
    const p = this.pdp;
    const why = `${onPageSecs}s on page, ${Math.round(msToAtc / 1000)}s to ATC`;

    const exploring = (f?.variantGroupCount ?? 0) > 0 && p.variants < plan.variantTarget && !p.exhausted.has("variants");
    if (exploring && msToAtc <= exploreLeadMs && msToAtc > 2_500) {
      return { action: "explore_variants", count: 1, maxMs: Math.min(9_000, msToAtc - 1_200), phase: "deep_pdp", reason: `trying size/colour before deciding (${why})` };
    }
    // Time this page has before exploration (or, with nothing to explore, the mark).
    const free = msToAtc - (exploring ? exploreLeadMs : 0) - 300;
    if (exploring && free < 1_500 && msToAtc > exploreLeadMs) {
      // Too short for anything else: a pause that ends as the size/colour window opens.
      return { action: "dwell", maxMs: Math.max(600, free + 500), phase: "deep_pdp", reason: `a moment on the page before trying sizes (${why})` };
    }
    const fit = (wanted: number): number => Math.min(cap ?? wanted, wanted, free);
    const wantMedia = p.media < plan.mediaTarget && (f?.galleryCount ?? 0) > 1 && !p.exhausted.has("media") && free > 1_800;
    const wantRead = p.sections < plan.sectionTarget && (f?.sectionCount ?? 0) > 0 && !p.exhausted.has("sections") && free > 2_500;
    const media = (): AiDecision => {
      // In a short window the first look is one photo, so the details still get read.
      const count = Math.min(plan.mediaTarget - p.media, p.media === 0 && free < 20_000 ? 1 : this.rng.int(2, 3));
      return { action: "view_media", count, maxMs: fit(count * 2_700), phase: "deep_pdp", reason: `flipping through the gallery (${why})` };
    };
    const read = (): AiDecision => ({ action: "read_section", count: 1, maxMs: fit(12_000), phase: "deep_pdp", reason: `reading product details (${why})` });
    // A window too short for both: whichever this visit has not done yet comes first.
    if (wantRead && free < 9_000 && this.sectionsRead === 0) return read();
    if (wantMedia && p.media === 0) return media();
    if (wantRead) return read();
    if (wantMedia) return media();
    if (!p.selected && p.sections > 0 && !p.exhausted.has("select") && free > 3_000 && this.rng.chance(0.35)) {
      return { action: "select_text", maxMs: fit(4_000), phase: "deep_pdp", reason: `highlighting a line while reading (${why})` };
    }
    return this.pageEngagement(true, `reading & interacting with product (${why})`, "deep_pdp", free > 1_500 ? fit(12_000) : cap);
  }

  /** On-page attention: scroll/dwell, with gallery/details on PDPs and card hovers on listings. */
  private pageEngagement(isProductPage: boolean, reason: string, phase: ChoreographyPhase, maxMs?: number): AiDecision {
    const key = this.state.currentPageKey ?? "";
    const f = this.features.get(key);
    if (isProductPage && key === this.pdp.key) {
      const r = this.rng.next();
      if ((f?.galleryCount ?? 0) > 1 && this.pdp.media < 2 && !this.pdp.exhausted.has("media") && r < 0.3) {
        return { action: "view_media", count: this.rng.int(1, 2), maxMs: maxMs ?? 6_000, phase, reason: `Media: ${reason}` };
      }
      if ((f?.sectionCount ?? 0) > 0 && this.pdp.sections < 1 && !this.pdp.exhausted.has("sections") && r < 0.5) {
        return { action: "read_section", count: 1, maxMs: maxMs ?? 9_000, phase, reason: `Details: ${reason}` };
      }
    } else if (!isProductPage && (f?.productCardCount ?? 0) > 1 && !this.hoveredPages.has(key) && this.rng.chance(0.45)) {
      return { action: "hover_card", count: this.rng.int(1, 2), maxMs: maxMs ?? 5_000, phase, reason: `Cards: ${reason}` };
    }
    return this.naturalEngageAction(reason, maxMs, phase);
  }

  private naturalEngageAction(reason: string, maxMs?: number, phase?: ChoreographyPhase): AiDecision {
    const tag = phase ? { phase } : {};
    if (this.rng.chance(this.cfg.dwellChance)) {
      return { action: "dwell", ...(maxMs ? { maxMs } : {}), ...tag, reason: `Dwell: ${reason}` };
    }
    return { action: "scroll", ...(maxMs ? { maxMs } : {}), ...tag, reason: `Scroll: ${reason}` };
  }

  /**
   * Text fallback when no oracle is available. A product is sold out only when
   * the buy button itself says so, or when JSON-LD lists offers and none of
   * them is in stock — one sold-out size does not make the product sold out.
   */
  private detectSoldOutFromHtml(html: string): boolean {
    const controls = html.split("\nCONTROLS:")[1] ?? "";
    for (const line of controls.split("\n")) {
      const [ident = "", label = "", meta = ""] = line.split(" | ");
      if (!/sold\s*out|out\s*of\s*stock|hết\s*hàng|tạm\s*hết|épuisé|ausverkauft|agotado/i.test(label)) continue;
      if (/name=add|form:\S*cart\/add/i.test(meta) || /add-?to-?cart|addtocart/i.test(ident)) return true;
    }
    const ldOut = /"availability"\s*:\s*"https?:\/\/schema\.org\/(OutOfStock|SoldOut|Discontinued)"/i.test(html);
    const ldIn = /"availability"\s*:\s*"https?:\/\/schema\.org\/(InStock|PreOrder|LimitedAvailability|OnlineOnly|BackOrder|InStoreOnly)"/i.test(html);
    return ldOut && !ldIn;
  }

  private pickNextProductUrl(): string | null {
    const candidates = this.state.cachedProductLinks.filter(p => {
      const cleanUrl = this.clean(p.url);
      return !this.state.visitedProducts.has(cleanUrl) && !this.state.soldOutProducts.has(cleanUrl);
    });
    if (candidates.length > 0) {
      const pick = this.rng.pick(candidates)!;
      return this.absolute(pick.url);
    }
    return null;
  }

  private prepTargetUrl(): string | null {
    if (this.lastPlanUrl && !this.state.soldOutProducts.has(this.clean(this.lastPlanUrl)) && !this.state.completedAtcProducts.has(this.clean(this.lastPlanUrl))) {
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
      if (/\.html$/i.test(path)) continue;
      const parts = path.split("/").filter(Boolean);
      const at = parts.lastIndexOf("collections");
      if (at >= 0 && at === parts.length - 2 && !this.state.visitedListings.has(path)) {
        return path;
      }
    }
    return null;
  }

  private isCartUrl(url: string): boolean {
    try {
      return /^(\/[a-z]{2}(-[a-z]{2})?)?\/cart(\/|$)/i.test(new URL(url, this.storefront || "https://x.invalid").pathname);
    } catch {
      return false;
    }
  }

  private absolute(url: string): string {
    return url.startsWith("http") ? url : this.storefront + url;
  }

  private clean(url: string): string {
    try {
      return new URL(url, this.storefront).pathname.split("?")[0] ?? url;
    } catch {
      return url;
    }
  }
}
