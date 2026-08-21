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
  exitReason: "timer" | "engine_exit" | "error" | "aborted";
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
  error?: string;
}
