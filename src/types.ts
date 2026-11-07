/**
 * Shared domain types for the Shopify storefront behavior simulator.
 */

/** Kinds of storefront page the navigator can recognise. */
export type PageType =
  | "home"
  | "collection_list"
  | "collection"
  | "product"
  | "search"
  | "cart"
  | "article"
  | "blog"
  | "page"
  | "not_found"
  | "unknown";

/** A page that is not a usable storefront document for a synthetic QA visit. */
export type PageCondition =
  | "storefront"
  | "challenge"
  | "consent_wall"
  | "maintenance"
  | "login_required"
  | "geo_blocked"
  | "empty_shell";

/** Result of the deterministic, once-per-page QA check. */
export interface PageAudit {
  checked: boolean;
  pageType: PageType;
  issues: string[];
}

/** Why the session deliberately stopped interacting with the page. */
export interface SessionBlocker {
  kind: "safety" | Exclude<PageCondition, "storefront">;
  message: string;
  url: string;
}

/** States of the behaviour state machine. */
export type BehaviorState =
  | "START"
  | "HOME"
  | "COLLECTION"
  | "PRODUCT"
  | "BROWSE"
  | "EXIT";

/** A micro-action the behaviour engine can decide to perform. */
export type ActionKind =
  // navigation
  | "goto_home"
  | "goto_collection"
  | "goto_product"
  | "go_back"
  | "go_forward"
  // on-page behaviour
  | "scroll"
  | "view_media"
  | "read_section"
  | "inspect_details"
  | "hover_variants"
  | "dwell"
  // collection browsing
  | "hover_card"
  // reading simulation
  // lifecycle
  | "exit";

/** A decision produced by the behaviour engine. */
export interface Decision {
  action: ActionKind;
  /** Target URL for navigation actions. */
  url?: string;
  /** Human-readable reason, recorded in the log for traceability. */
  reason: string;
  /** Next state to move into once the action succeeds. */
  nextState: BehaviorState;
}

/** A link discovered on the current page. */
export interface DiscoveredLink {
  url: string;
  text: string;
  kind: PageType;
}

/**
 * What the navigator actually observed on the live page. The behaviour engine
 * decides purely from this snapshot plus session state, never from a fixed
 * script.
 */
export interface PageObservation {
  url: string;
  title: string;
  pageType: PageType;
  /** Total scrollable height in CSS pixels. */
  scrollHeight: number;
  viewportHeight: number;
  /** Current vertical scroll offset. */
  scrollY: number;
  /** Product links available for navigation from here. */
  productLinks: DiscoveredLink[];
  /** Collection links available for navigation from here. */
  collectionLinks: DiscoveredLink[];
  /** Number of gallery/media items detected (product pages). */
  mediaCount: number;
  /** Number of collapsible sections detected (accordions, tabs). */
  sectionCount: number;
  /** Whether variant pickers/swatches are present. */
  hasVariants: boolean;
  /** Whether a price element was found. */
  hasPrice: boolean;
  /** Whether the page rendered a recognisable main content region. */
  hasMainContent: boolean;
  /** Whether this is safe, usable storefront content rather than an interstitial. */
  condition: PageCondition;
  /** Short evidence for a non-storefront condition, when available. */
  conditionDetail?: string;
}

/** Timing and health metrics for a single navigation. */
export interface NavigationMetrics {
  url: string;
  status: number | null;
  /** Wall-clock ms from goto() start to load-state settled. */
  elapsedMs: number;
  /** Navigation Timing: responseStart - startTime. */
  ttfbMs: number | null;
  /** Navigation Timing: domContentLoadedEventEnd - startTime. */
  domContentLoadedMs: number | null;
  /** Navigation Timing: loadEventEnd - startTime. */
  loadEventMs: number | null;
  /** First Contentful Paint, when the browser reports it. */
  firstContentfulPaintMs: number | null;
  /** Uncaught JavaScript exceptions seen so far this session. */
  jsErrors: number;
  /** console.error output so far — noisier, often third-party. */
  consoleErrors: number;
  failedRequests: number;
}

/** Aggregate outcome of one simulated session. */
export interface SessionResult {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Why the session stopped. */
  exitReason: "timer" | "engine_exit" | "error" | "aborted" | "blocked";
  actionsPerformed: number;
  pagesVisited: number;
  productsViewed: number;
  collectionsViewed: number;
  jsErrors: number;
  consoleErrors: number;
  failedRequests: number;
  navigationErrors: number;
  /** Slowest navigation observed, for a quick performance read. */
  slowestNavigation: NavigationMetrics | null;
  blocker?: SessionBlocker;
  error?: string;
}


// ═══════════════════════════════════════════════════════════════════════
// AI-DRIVEN ARCHITECTURE TYPES (v2)
// ═══════════════════════════════════════════════════════════════════════

/**
 * An element detected by the AI layer on the current page.
 * Replaces the old hardcoded selector system with adaptive detection.
 */
export interface AiDetectedElement {
  /** Element type for the backend to know how to interact */
  kind: "product_link" | "collection_link" | "add_to_cart" | "gallery" |
        "variant_picker" | "accordion" | "navigation" | "search" | "scrollable";
  /** CSS selector or text-based locator */
  selector: string;
  /** Human-readable text */
  text: string;
  /** URL if it's a link */
  url?: string;
  /** Confidence score 0-1 */
  confidence: number;
}

/**
 * Result of an AI detection pass on a single page.
 * The backend uses this to know what to click, scroll, and interact with.
 */
export interface AiPageDetection {
  /** URL this detection was for */
  url: string;
  /** Page type identified by AI */
  pageType: PageType;
  /** All detected elements, sorted by confidence */
  elements: AiDetectedElement[];
  /** Which AI account was used */
  accountSource: string;
  /** Detection latency in ms */
  elapsedMs: number;
  /** The prompt intent that was used */
  intent: "discover" | "interact" | "add_to_cart" | "navigate_back";
}

/**
 * Action the AI-driven engine decides to perform.
 * Supersedes the old Decision type for v2 architecture.
 */
export interface AiDecision {
  /** What to do */
  action: AiActionKind;
  /** Element to interact with (for click/hover actions) */
  targetElement?: AiDetectedElement;
  /** URL for navigation actions */
  url?: string;
  /** Prepared add-to-cart plan for the current product page, when one exists */
  plan?: AtcPlan;
  /**
   * Upper bound on how long executing this action may take. Set when a
   * scheduled add-to-cart is close: the visitor wraps up what they are doing
   * so the next decision lands at the mark, not one scroll past it.
   */
  maxMs?: number;
  /** How many items a choreography step covers (thumbnails, sections, cards, variants). */
  count?: number;
  /** Pre-checkout choreography phase the decision belongs to (for the timeline). */
  phase?: string;
  /** inspect_cart only: stay on the cart afterwards, ready for checkout. */
  park?: boolean;
  /** Human-readable reason */
  reason: string;
}

/** One variant group (Size, Colour…) with clickable option selectors. */
export interface AtcVariantGroup {
  group: string;
  /** Selectors the backend may pick at random — one per option control. */
  options: string[];
}

/**
 * The per-product add-to-cart plan the AI prepares while the visitor is
 * still scrolling. At the scheduled minute the backend only executes it:
 * random-pick one option per variant group (max two groups), then click the
 * add-to-cart control. A plan that found nothing is still a valid answer —
 * the visit simply continues without touching the cart.
 */
export interface AtcPlan {
  addToCart?: { selector: string; text: string };
  variants: AtcVariantGroup[];
  /** The buy button is disabled until a variant/size is chosen. Tells the
   * executor it MUST satisfy a variant group before the click will register. */
  variantGated?: boolean;
  /** A scoped-form fallback selector the AI is confident resolves even if the
   * specific `addToCart.selector` goes stale (e.g. form[action*="/cart/add"]
   * submit). Tried after the specific selector, before the generic chain. */
  formSelector?: string;
  isSoldOut?: boolean;
}

/**
 * Actions the AI-driven engine can take.
 */
export type AiActionKind =
  // navigation (same as before)
  | "goto_home"
  | "goto_product"
  | "goto_collection"
  | "go_back"
  // AI-driven interactions
  | "click_element"
  | "scroll"
  | "hover_element"
  | "dwell"
  // pre-checkout choreography
  | "hover_card"
  | "view_media"
  | "read_section"
  | "select_text"
  | "explore_variants"
  | "inspect_cart"
  // advance actions (10-min mark etc.)
  | "add_to_cart"
  // lifecycle
  | "exit";

/**
 * Session state for the AI-driven engine.
 * Tracks what the session has done and what the AI has detected.
 */
export interface AiSessionState {
  /** Pages visited this session */
  visitedUrls: Set<string>;
  /** Products clicked/viewed */
  visitedProducts: Set<string>;
  /** Collections visited */
  visitedCollections: Set<string>;
  /** Last detection result (cache to avoid re-detecting same page) */
  lastDetection: AiPageDetection | null;
  /** URL of the last detection */
  lastDetectionUrl: string | null;
  /** How many AI calls have been made this session */
  aiCallsCount: number;
  /** Total time spent on AI calls */
  aiCallsTotalMs: number;
  /** Whether the 10-min advance action has been performed */
  advanceActionPerformed: boolean;
  /** Current page's add-to-cart element (detected once, reused) */
  cachedAddToCart: AiDetectedElement | null;
}

/**
 * Configuration for the AI detection layer.
 */
export interface AiConfig {
  /** Path to the cookies directory */
  cookiesDir: string;
  /** Claude API base URL */
  claudeBaseUrl?: string;
  /** Model to use (default: haiku for speed/cost) */
  model?: string;
  /** Max HTML chars to send to Claude */
  maxHtmlChars: number;
  /** Max retries with different accounts on errors */
  maxRetries: number;
  /** Advance action time in ms (default: 10 min) */
  advanceActionTimeMs: number;
  /** Cooldown between AI detection calls in ms */
  detectionCooldownMs: number;
}

/**
 * Profile configuration for the AI-driven system.
 */
export interface AiProfileConfig {
  /** Storefront URL */
  storefront: string;
  /** Proxy URL */
  proxy?: string;
  /** Session duration in minutes */
  durationMinutes?: number;
}
