/**
 * Behaviour Engine — the state machine that drives a session.
 *
 * The engine never runs a fixed script. On every step it is handed a fresh
 * PageObservation (what is actually on the page right now) plus the session
 * timer, and it picks the next action from the options that page genuinely
 * offers, weighted by session state. Two sessions against the same shop take
 * different routes while both staying inside the intended workflow:
 *
 *     Home → Collection → Product → Browse → Product → Browse → Exit
 *
 * States
 *   START      nothing loaded yet
 *   HOME       on the storefront homepage
 *   COLLECTION on a collection / category listing
 *   PRODUCT    on a product detail page
 *   BROWSE     transient: just navigated (back/forward) and re-orienting
 *   EXIT       session is winding down
 */
import type { BehaviorConfig, SimulatorConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { Rng } from "../util/random.js";
import type { SessionTimer } from "../session/timer.js";
import type {
  ActionKind,
  BehaviorState,
  Decision,
  DiscoveredLink,
  PageObservation,
  PageType,
} from "../types.js";

/** Rough cost of each action, used to avoid starting work we can't finish. */
const ACTION_COST_MS: Record<ActionKind, number> = {
  goto_home: 8_000,
  goto_collection: 8_000,
  goto_product: 8_000,
  go_back: 6_000,
  go_forward: 6_000,
  scroll: 6_000,
  view_media: 8_000,
  read_section: 6_000,
  inspect_details: 5_000,
  hover_variants: 4_000,
  dwell: 4_000,
  exit: 0,
};

/** What the engine remembers across the session. */
export interface SessionMemory {
  visitedUrls: Set<string>;
  visitedProducts: Set<string>;
  visitedCollections: Set<string>;
  /** Collection the session most recently browsed, for returning to it. */
  lastCollectionUrl: string | null;
  /** Actions already performed on the page currently open. */
  pageActions: ActionKind[];
  /** Total actions this session. */
  totalActions: number;
  /** Products the session intends to look at before winding down. */
  productTarget: number;
  /** Navigations that failed, used to back off from a broken area. */
  consecutiveFailures: number;
}

export class BehaviorEngine {
  state: BehaviorState = "START";
  readonly memory: SessionMemory;
  private readonly behavior: BehaviorConfig;

  constructor(
    private readonly config: SimulatorConfig,
    private readonly rng: Rng,
    private readonly logger: Logger,
  ) {
    this.behavior = config.behavior;
    this.memory = {
      visitedUrls: new Set(),
      visitedProducts: new Set(),
      visitedCollections: new Set(),
      lastCollectionUrl: null,
      pageActions: [],
      totalActions: 0,
      productTarget: this.rng.range(this.behavior.targetProducts),
      consecutiveFailures: 0,
    };
  }

  /** Map an observed page type onto the state machine's state. */
  private stateForPageType(pageType: PageType): BehaviorState {
    switch (pageType) {
      case "home":
        return "HOME";
      case "collection":
      case "collection_list":
        return "COLLECTION";
      case "product":
        return "PRODUCT";
      default:
        return "BROWSE";
    }
  }

  /**
   * Re-anchor the machine to the page we are actually on. This is what makes
   * the engine content-driven: after a Back, a redirect, or a theme quirk, the
   * state follows reality rather than what the last decision assumed.
   */
  syncState(observation: PageObservation): void {
    const derived = this.stateForPageType(observation.pageType);
    if (derived !== this.state) {
      this.logger.debug(
        "state_change",
        `${this.state} → ${derived}`,
        { url: observation.url, state: derived },
      );
      this.state = derived;
    }
    this.memory.visitedUrls.add(observation.url);
    if (observation.pageType === "product") {
      this.memory.visitedProducts.add(observation.url);
    }
    if (observation.pageType === "collection") {
      this.memory.visitedCollections.add(observation.url);
      this.memory.lastCollectionUrl = observation.url;
    }
  }

  /** Called by the session manager when the page changed. */
  resetPageActions(): void {
    this.memory.pageActions = [];
  }

  /** Record that an action completed, for weighting later decisions. */
  noteAction(action: ActionKind): void {
    this.memory.pageActions.push(action);
    this.memory.totalActions++;
  }

  noteFailure(): void {
    this.memory.consecutiveFailures++;
  }

  noteSuccess(): void {
    this.memory.consecutiveFailures = 0;
  }

  private didOnThisPage(action: ActionKind): boolean {
    return this.memory.pageActions.includes(action);
  }

  /**
   * Weight for an action that has already been done here.
   *
   * Hard caps ("at most three sections, at most one inspect") are the wrong
   * shape: they say a visitor who has opened three accordions is now
   * *incapable* of opening a fourth. Real repetition tails off instead — the
   * second look is likely, the fifth unlikely, the ninth rare but possible.
   * Decay keeps every action reachable for as long as the page is open while
   * still pushing the session on to something else.
   */
  private fading(action: ActionKind, base: number, rate = 0.9): number {
    return base / (1 + this.countOnThisPage(action) * rate);
  }

  private countOnThisPage(action: ActionKind): number {
    return this.memory.pageActions.filter((a) => a === action).length;
  }

  /**
   * Pick the next action.
   *
   * Order of reasoning:
   *   1. Hard stops (timer expired, too many failures) → exit.
   *   2. If the page still has unexplored content and we haven't overstayed,
   *      prefer an on-page action.
   *   3. Otherwise choose a navigation that fits the current state.
   */
  decide(observation: PageObservation, timer: SessionTimer): Decision {
    // 1. Hard stops.
    if (timer.isExpired()) {
      return this.exitDecision("session timer reached");
    }
    if (this.memory.consecutiveFailures >= 4) {
      return this.exitDecision("too many consecutive navigation failures");
    }
    if (this.state === "START") {
      return {
        action: "goto_home",
        url: this.config.storefront,
        reason: "session start — open homepage",
        nextState: "HOME",
      };
    }

    // Winding down: once the browsing goal is met and the budget is nearly
    // spent, exiting becomes progressively more likely.
    const exitPressure = this.exitPressure(timer);
    if (exitPressure > 0 && this.rng.chance(exitPressure)) {
      return this.exitDecision(
        `winding down (products=${this.memory.visitedProducts.size}/${this.memory.productTarget}, ` +
          `remaining=${timer.formatRemaining()})`,
      );
    }

    // 2. On-page behaviour.
    const onPage = this.chooseOnPageAction(observation, timer);
    if (onPage) return onPage;

    // 3. Navigation.
    return this.chooseNavigation(observation, timer);
  }

  /** Probability of ending the session on this step. */
  private exitPressure(timer: SessionTimer): number {
    if (timer.phase() === "expired") return 1;

    // The session is given fifteen minutes to explore a shop, so it should
    // spend them. Winding down used to start at 80% elapsed and reach even
    // odds by the deadline, which meant a session regularly stopped browsing
    // minutes early with budget still on the clock. It now only begins to
    // taper in the last few percent, and gently — the timer ends the session,
    // not an early loss of interest.
    const progress = timer.progress();
    if (progress < 0.95) return 0;
    const lateness = Math.min(1, (progress - 0.95) / 0.05);
    return lateness * 0.12;
  }

  private exitDecision(reason: string): Decision {
    return { action: "exit", reason, nextState: "EXIT" };
  }

  /**
   * How long to linger on a page, by type.
   *
   * A product page is where the interesting content is — gallery, price,
   * description, accordions, variants — so it earns a longer look. A listing
   * page is mostly a means of getting to one, so the engine moves on sooner.
   */
  private engagementBudget(pageType: PageType): {
    minActions: number;
    maxActions: number;
  } {
    const ceiling = this.behavior.maxActionsPerPage;
    if (pageType === "product") return { minActions: 6, maxActions: ceiling };
    // Listing pages used to get half a product page's budget, which made the
    // session look like it glanced at a collection and left. A visitor scans a
    // grid properly — scrolls it, comes back up, looks again.
    return {
      minActions: 4,
      maxActions: Math.max(6, Math.ceil(ceiling * 0.8)),
    };
  }

  /**
   * Weighted choice among things worth doing on *this* page. Returns null when
   * the page is exhausted (or we've lingered long enough) and it is time to
   * navigate.
   */
  private chooseOnPageAction(
    observation: PageObservation,
    timer: SessionTimer,
  ): Decision | null {
    const actionsHere = this.memory.pageActions.length;
    const { minActions, maxActions } = this.engagementBudget(observation.pageType);
    if (actionsHere >= maxActions) return null;

    const canScroll = observation.scrollHeight > observation.viewportHeight * 1.2;
    const scrollsDone = this.countOnThisPage("scroll");

    // Already at the foot of the page. Scrolling again is either a no-op or a
    // trip back up, and a visitor who has reached the bottom of a listing
    // reads something or moves on — they do not keep dragging at the end stop.
    const atBottom =
      observation.scrollHeight > 0 &&
      observation.scrollY + observation.viewportHeight >= observation.scrollHeight - 8;

    const candidates: Array<{ value: ActionKind; weight: number }> = [];

    // Scrolling is the universal browsing gesture; it also triggers the lazy
    // loading most Shopify collection templates rely on. Base weight 3.5 (was
    // 6): at 6 it dominated the first action on nearly every page, so a fresh
    // page visibly lurched downward before anything else happened. A visitor
    // often reads the top of the page first.
    candidates.push({
      value: "scroll",
      weight: !canScroll
        ? 0
        : atBottom
          // One trip back up is normal; after that stop offering it, so the
          // remaining actions go to the page's content instead.
          ? (scrollsDone < 1 ? 1.5 : 0)
          // Never reaches zero: a long listing can be scrolled all afternoon.
        : this.fading("scroll", 3.5, 0.35),
    });

    // Idle reading pause. This decays too — without it every page would keep
    // one non-zero option forever and the engine could only ever leave by
    // hitting its ceiling, never by running out of things to do.
    candidates.push({
      value: "dwell",
      weight: this.fading("dwell", this.rng.chance(this.behavior.idleProbability) ? 1.5 : 0.4, 1.1),
    });

    // Home and collection pages have sections worth looking at too (hero,
    // featured collections, testimonials) — not just product accordions.
    if (observation.pageType !== "product") {
      candidates.push({
        value: "read_section",
        weight: observation.sectionCount > 0 ? this.fading("read_section", 2.5, 0.7) : 0,
      });
    }

    if (observation.pageType === "product") {
      candidates.push({
        value: "inspect_details",
        // Re-reading the price and title is one of the most ordinary things a
        // shopper does; once per page was never right.
        weight: this.fading("inspect_details", 6, 1.2),
      });
      candidates.push({
        value: "view_media",
        weight: observation.mediaCount > 0 ? this.fading("view_media", 5, 0.8) : 0,
      });
      candidates.push({
        value: "read_section",
        weight: observation.sectionCount > 0 ? this.fading("read_section", 4, 0.6) : 0,
      });
      candidates.push({
        value: "hover_variants",
        weight: observation.hasVariants ? this.fading("hover_variants", 3, 0.9) : 0,
      });
    }

    // Past the minimum, the pressure to move on grows with every extra action,
    // reaching certainty at the page type's ceiling.
    if (actionsHere >= minActions) {
      // Squared, so the pull toward leaving stays weak through most of the
      // page's budget and only becomes decisive near the ceiling. A linear
      // ramp made the engine bail out of pages it had barely started on.
      const linear = (actionsHere - minActions + 1) / (maxActions - minActions + 1);
      let pressure = linear * linear;
      // Nothing left below the fold is itself a reason to move on.
      if (atBottom) pressure = Math.min(1, pressure + 0.2);
      if (this.rng.chance(pressure)) return null;
    }

    const affordable = candidates.filter(
      (c) => c.weight > 0 && timer.hasRoomFor(ACTION_COST_MS[c.value]),
    );
    const chosen = this.rng.weighted(affordable);
    if (!chosen) return null;

    return {
      action: chosen,
      reason: `on-page (${observation.pageType}, ${actionsHere} action(s) here)`,
      nextState: this.state,
    };
  }

  /**
   * Choose where to go next. Options come from the links the page actually
   * exposes, so the route differs per shop and per session.
   */
  private chooseNavigation(
    observation: PageObservation,
    timer: SessionTimer,
  ): Decision {
    const unvisitedProducts = observation.productLinks.filter(
      (l) => !this.memory.visitedProducts.has(l.url),
    );
    const unvisitedCollections = observation.collectionLinks.filter(
      (l) => !this.memory.visitedCollections.has(l.url),
    );
    const needsProducts = this.memory.visitedProducts.size < this.memory.productTarget;

    type NavOption = { action: ActionKind; url?: string; why: string; next: BehaviorState };
    const options: Array<{ value: NavOption; weight: number }> = [];

    switch (this.state) {
      case "HOME": {
        // From home, the intended step is into a collection; going straight to
        // a featured product is a normal alternative when one is on the page.
        const collection = this.pickLink(unvisitedCollections, observation.collectionLinks);
        if (collection) {
          options.push({
            value: {
              action: "goto_collection",
              url: collection.url,
              why: `home → collection "${collection.text || collection.url}"`,
              next: "COLLECTION",
            },
            weight: 8,
          });
        }
        const product = this.pickLink(unvisitedProducts, observation.productLinks);
        if (product) {
          options.push({
            value: {
              action: "goto_product",
              url: product.url,
              why: "home → featured product",
              next: "PRODUCT",
            },
            weight: 2,
          });
        }
        break;
      }

      case "COLLECTION": {
        const product = this.pickLink(unvisitedProducts, observation.productLinks);
        if (product) {
          options.push({
            value: {
              action: "goto_product",
              url: product.url,
              why: `collection → product "${product.text || product.url}"`,
              next: "PRODUCT",
            },
            // Meeting the product target softens the pull (6 vs 10) but never
            // removes it: a visitor who has "seen enough" still clicks cards
            // on a listing — they just stop hunting for unseen ones.
            weight: needsProducts ? 10 : 6,
          });
        }
        const otherCollection = this.pickLink(unvisitedCollections, observation.collectionLinks);
        if (otherCollection) {
          options.push({
            value: {
              action: "goto_collection",
              url: otherCollection.url,
              why: "collection → another collection",
              next: "COLLECTION",
            },
            weight: 2,
          });
        }
        options.push({
          value: { action: "go_back", why: "collection → back", next: "BROWSE" },
          weight: this.behavior.backProbability * 3,
        });
        break;
      }

      case "PRODUCT": {
        // Related/recommended products on the PDP are the most natural next hop.
        const related = this.pickLink(unvisitedProducts, observation.productLinks);
        if (related) {
          options.push({
            value: {
              action: "goto_product",
              url: related.url,
              why: `product → related product "${related.text || related.url}"`,
              next: "PRODUCT",
            },
            // After the target is met this stays the strongest single option:
            // hopping related-product → related-product is what a shopper who
            // is "just looking" actually does. Dropping it to 3 used to hand
            // the turn to Back (0.28 × 10 ≈ 3) half the time, which read as
            // the session bouncing off every PDP instead of continuing.
            weight: needsProducts ? 7 : 5,
          });
        }
        options.push({
          value: { action: "go_back", why: "product → back to listing", next: "BROWSE" },
          weight: this.behavior.backProbability * 10,
        });
        if (this.memory.lastCollectionUrl) {
          options.push({
            value: {
              action: "goto_collection",
              url: this.memory.lastCollectionUrl,
              why: "product → return to last collection",
              next: "COLLECTION",
            },
            weight: this.behavior.returnToCollectionProbability * 8,
          });
        }
        const newCollection = this.pickLink(unvisitedCollections, observation.collectionLinks);
        if (newCollection) {
          options.push({
            value: {
              action: "goto_collection",
              url: newCollection.url,
              why: "product → new collection",
              next: "COLLECTION",
            },
            weight: 2,
          });
        }
        break;
      }

      case "BROWSE":
      default: {
        // Just came back / landed somewhere unclassified: re-enter the flow.
        const product = this.pickLink(unvisitedProducts, observation.productLinks);
        if (product) {
          options.push({
            value: {
              action: "goto_product",
              url: product.url,
              why: "browse → product",
              next: "PRODUCT",
            },
            weight: needsProducts ? 6 : 3,
          });
        }
        const collection = this.pickLink(unvisitedCollections, observation.collectionLinks);
        if (collection) {
          options.push({
            value: {
              action: "goto_collection",
              url: collection.url,
              why: "browse → collection",
              next: "COLLECTION",
            },
            weight: 5,
          });
        }
        options.push({
          value: { action: "go_forward", why: "browse → forward", next: "BROWSE" },
          weight: 1,
        });
        break;
      }
    }

    // Always keep a way back to a known-good page so a session can recover
    // from a dead end instead of stalling.
    if (this.memory.lastCollectionUrl && this.state !== "COLLECTION") {
      options.push({
        value: {
          action: "goto_collection",
          url: this.memory.lastCollectionUrl,
          why: "fallback → last collection",
          next: "COLLECTION",
        },
        weight: 1,
      });
    }
    options.push({
      value: {
        action: "goto_home",
        url: this.config.storefront,
        why: "fallback → homepage",
        next: "HOME",
      },
      weight: this.state === "HOME" ? 0 : 1,
    });

    const affordable = options.filter(
      (o) => o.weight > 0 && timer.hasRoomFor(ACTION_COST_MS[o.value.action]),
    );
    const chosen = this.rng.weighted(affordable);

    if (!chosen) {
      return this.exitDecision("no affordable navigation left in the budget");
    }

    return {
      action: chosen.action,
      ...(chosen.url ? { url: chosen.url } : {}),
      reason: chosen.why,
      nextState: chosen.next,
    };
  }

  /**
   * Prefer an unvisited link, but occasionally revisit — real sessions do
   * re-open pages, and revisits exercise the theme's cache paths.
   */
  private pickLink(
    unvisited: DiscoveredLink[],
    all: DiscoveredLink[],
  ): DiscoveredLink | undefined {
    if (unvisited.length > 0 && !this.rng.chance(0.1)) {
      return this.rng.pick(unvisited);
    }
    return this.rng.pick(all.length > 0 ? all : unvisited);
  }
}
