/**
 * AI Element Detector with product link caching.
 */
import type { CookiePool, CookieEntry } from "./cookiePool.js";
import { ClaudeClient, ClaudeAuthError, ClaudeRateLimitError, ClaudePayloadError, type ClaudeResponse } from "./claudeClient.js";
import { ClaudeTransientError, type AnthropicApiClient } from "./anthropicApiClient.js";
import type { AiProvider } from "../config.js";
import { buildDetectionPrompt, preprocessHtml } from "./promptTemplates.js";
import { localDetect, sanitizeProductPath, hasProductSlug } from "./localFallback.js";
import type { Logger } from "../logging/logger.js";
import { DEFAULT_CLAUDE_MODEL } from "../config.js";

export interface DetectedProduct {
  selector: string;
  text: string;
  url: string;
}

export interface DetectedAddToCart {
  selector: string;
  text: string;
}

export interface PageDetectionResult {
  url: string;
  products: DetectedProduct[];
  addToCart: DetectedAddToCart | null;
  /** PDP plan with variant option groups, when the page exposes them. */
  plan?: import("../types.js").AtcPlan;
  is_sold_out?: boolean;
  accountSource: string;
  elapsedMs: number;
  cached: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Routes that are never product detail pages, whatever the model claimed.
 * Product-shaped URLs (/products/, including collection-scoped
 * /collections/<h>/products/<h>) always pass — a /collections/ prefix does
 * not make it a listing page. */
const NON_PRODUCT =
  /(\/blogs?\/)|(\/pages\/)|(\/policies\/)|(\/search)|(\/account)|(\/checkout)|(^\/cart$)|(\/apps\/)|(\/tools\/)|(gift[-_]?card|gift[-_]?certificate|e[-_]?gift)|(\.(png|jpe?g|gif|svg|webp|css|js|ico|pdf)$)/i;

function plausiblyNavigable(url: string): boolean {
  if (!url || url.length < 2 || url === "/") return false;
  if (/^(mailto:|tel:|javascript:)/i.test(url)) return false;
  if (/\/products?\//.test(url)) return hasProductSlug(url);
  return !NON_PRODUCT.test(url);
}

/** Provider-health signal for the alert layer. */
export interface AiProviderEvent {
  kind: "cookie_pool_empty" | "cookie_path_failed" | "api_auth_failed" | "api_rate_limited" | "api_failed" | "failover_to_api";
  detail: string;
}

/** After this many back-to-back cookie-path failures, hybrid skips the pool for a while. */
const COOKIE_BREAKER_FAILS = 2;
const COOKIE_BREAKER_OPEN_MS = 60_000;

interface CacheEntry {
  products: DetectedProduct[];
  addToCart: DetectedAddToCart | null;
  plan?: import("../types.js").AtcPlan;
  timestamp: number;
}

export class ElementDetector {
  private readonly client: ClaudeClient;
  private readonly pool: CookiePool;
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private readonly maxHtmlChars: number;
  private readonly detectionCooldownMs: number;
  private lastCallAt = 0;
  private readonly model?: string;
  private readonly mode: AiProvider;
  private readonly api: AnthropicApiClient | undefined;
  private readonly onProviderEvent: ((e: AiProviderEvent) => void) | undefined;
  private cookieFailStreak = 0;
  private cookieBreakerUntil = 0;
  /** A rejected API key stays rejected; stop spending requests (and alert noise) on it. */
  private apiDisabled = false;
  private excludeSet = new Set<string>();
  /** Product cache keyed by domain+pathname, TTL-based */
  private cache = new Map<string, CacheEntry>();
  /** In-flight background analyses keyed like the cache — prefetch dedupe. */
  private pending = new Map<string, Promise<PageDetectionResult>>();

  constructor(pool: CookiePool, logger: Logger, options: { maxRetries?: number; maxHtmlChars?: number; detectionCooldownMs?: number; model?: string; baseUrl?: string; client?: ClaudeClient; provider?: AiProvider; api?: AnthropicApiClient; onProviderEvent?: (e: AiProviderEvent) => void } = {}) {
    this.pool = pool;
    this.api = options.api;
    // Without an API client every mode is, in effect, the cookie pool.
    this.mode = options.api ? (options.provider ?? "hybrid") : "cookie_pool";
    this.onProviderEvent = options.onProviderEvent;
    this.logger = logger;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxHtmlChars = options.maxHtmlChars ?? 60000;
    this.detectionCooldownMs = options.detectionCooldownMs ?? 0;
    this.model = options.model ?? DEFAULT_CLAUDE_MODEL;
    this.client = options.client ?? new ClaudeClient(options.baseUrl);
  }

  /**
   * Start analysing a page in the background WITHOUT awaiting it.
   *
   * The session loop calls this the moment a page's digest is extracted, so
   * AI latency overlaps with engagement time. When the engine needs results
   * (after the floor), detect() resolves against the already-settled promise
   * instead of paying the wait again.
   */
  prefetch(
    url: string,
    htmlSource: string,
    options: { intent?: "discover" | "interact" | "add_to_cart"; skipCache?: boolean } = {},
  ): void {
    const key = this.cacheKey(url);
    if (this.pending.has(key)) return;
    const entry = this.cache.get(key);
    if (!options.skipCache && entry && entry.products.length > 0 && Date.now() - entry.timestamp < CACHE_TTL_MS) return;

    const startedAt = Date.now();
    const task = this.runDetection(url, htmlSource, options)
      .finally(() => {
        this.pending.delete(key);
        this.logger.debug("ai_prefetch_done", url + " settled in " + (Date.now() - startedAt) + "ms");
      });
    // A rejected prefetch must not become an unhandled rejection when nobody
    // awaits it (the engine's own detect() re-runs and surfaces errors).
    task.catch(() => undefined);
    this.pending.set(key, task);
    this.logger.info("ai_prefetch", "analysis started in background (" + (options.intent ?? "discover") + ")", { url });
  }

  private cacheKey(url: string): string {
    try { const u = new URL(url); return u.host + u.pathname.replace(/\/+$/, ""); } catch { return url; }
  }

  async detect(url: string, htmlSource: string, options: { intent?: "discover" | "interact" | "add_to_cart"; skipCache?: boolean } = {}): Promise<PageDetectionResult> {
    const intent = options.intent ?? "discover";
    const key = this.cacheKey(url);

    // Check cache first (only for discover/interact)
    if (!options.skipCache && intent !== "add_to_cart") {
      const entry = this.cache.get(key);
      if (entry && entry.products.length > 0 && Date.now() - entry.timestamp < CACHE_TTL_MS) {
        this.logger.debug("cache_hit", "Using cached products for " + key.slice(0, 60));
        return { url, products: entry.products, addToCart: entry.addToCart, ...(entry.plan ? { plan: entry.plan } : {}), accountSource: "cache", elapsedMs: 0, cached: true };
      }
    }

    // A prefetch fired on page arrival is usually settled by now — await it
    // instead of paying the AI latency twice.
    const inflight = this.pending.get(key);
    if (inflight) {
      try {
        const result = await inflight;
        this.logger.debug("ai_prefetch_hit", "result already ready for " + key.slice(0, 60));
        return result;
      } catch {
        // Prefetch failed; fall through so runDetection surfaces its own
        // error path (local fallback, retry accounting). Never consume the
        // same failed promise twice.
      }
    }

    return this.runDetection(url, htmlSource, options);
  }

  private async runDetection(url: string, htmlSource: string, options: { intent?: "discover" | "interact" | "add_to_cart"; skipCache?: boolean } = {}): Promise<PageDetectionResult> {
    const intent = options.intent ?? "discover";
    const key = this.cacheKey(url);
    // One bounded payload for both the prompt and any local fallback.
    const digest = preprocessHtml(htmlSource, this.maxHtmlChars);

    // No healthy cookies: skip the AI entirely and classify locally, caching the result so
    // subsequent turns on the same URL resolve in 0ms without re-triggering prefetch.
    const cookiesUsable =
      this.mode !== "anthropic_api" &&
      this.pool.hasCookies() &&
      !(this.mode === "hybrid" && Date.now() < this.cookieBreakerUntil);
    const apiUsable = this.mode !== "cookie_pool" && !!this.api && !this.apiDisabled;
    if (this.mode !== "anthropic_api" && !this.pool.hasCookies()) {
      this.emit({ kind: "cookie_pool_empty", detail: "no healthy cookies in the pool" });
    }

    if (!cookiesUsable && !apiUsable) {
      const local = localDetect(digest);
      if (!options.skipCache && local.products.length > 0) {
        this.cache.set(key, {
          products: local.products,
          addToCart: local.addToCart,
          timestamp: Date.now(),
        });
      }
      this.logger.debug("local_detect", "no cookies - local classification products=" + local.products.length, { url });
      return { url, products: local.products, addToCart: local.addToCart, accountSource: "local", elapsedMs: 0, cached: false };
    }

    const prompt = buildDetectionPrompt({ url, pageType: "", htmlSource: digest, intent });
    this.excludeSet.clear();
    let lastError: Error | null = null;

    let cookieAttempted = false;
    for (let attempt = 0; attempt < this.maxRetries && cookiesUsable; attempt++) {
      const cookie = this.pool.getNext(this.excludeSet);
      if (!cookie) break;
      cookieAttempted = true;

      if (this.detectionCooldownMs > 0) {
        const sinceLast = Date.now() - this.lastCallAt;
        if (sinceLast < this.detectionCooldownMs) {
          await new Promise<void>((r) => setTimeout(r, this.detectionCooldownMs - sinceLast));
        }
      }
      this.lastCallAt = Date.now();

      this.pool.beginRequest(cookie.source);
      try {
        const response = await this.client.send(prompt, cookie, {
          model: this.model,
          enableBuiltinTools: false,
        });
        const result = this.parseResponse(response, url, digest);
        this.pool.markSuccess(cookie.source);
        this.cookieFailStreak = 0;

        // Cache the result
        if (!options.skipCache) {
          this.cache.set(key, { products: result.products, addToCart: result.addToCart, ...(result.plan ? { plan: result.plan } : {}), timestamp: Date.now() });
          // Clean old cache entries (>50 entries)
          if (this.cache.size > 50) {
            const oldest = [...this.cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp).slice(0, 10);
            for (const [k] of oldest) this.cache.delete(k);
          }
        }
        
        this.logger.debug("claude_ok", response.elapsedMs + "ms via " + cookie.source + " products=" + result.products.length, { url });
        return { ...result, cached: false };
      } catch (err) {
        lastError = err as Error;
        if (err instanceof ClaudePayloadError && err.classification === "provider_payload") {
          // Permanent payload rejection — do not burn other cookies retrying the same prompt
          break;
        }
        this.pool.markFailure(cookie.source);
        if (err instanceof ClaudeAuthError) {
          this.pool.markInvalid(cookie.source, "auth_failed");
          this.pool.markFailure(cookie.source);
          this.excludeSet.add(cookie.source);
        } else if (err instanceof ClaudeRateLimitError) {
          this.pool.markRateLimited(cookie.source, err.retryAfter * 1000);
          this.excludeSet.add(cookie.source);
        } else {
          this.excludeSet.add(cookie.source);
        }
        if (attempt + 1 < this.maxRetries) {
          const backoffMs = Math.min(2000, 150 * Math.pow(2, attempt) + Math.floor(Math.random() * 100));
          await new Promise<void>((r) => setTimeout(r, backoffMs));
        }
      } finally {
        this.pool.endRequest(cookie.source);
      }
    }
    if (cookieAttempted) {
      if (++this.cookieFailStreak >= COOKIE_BREAKER_FAILS && this.mode === "hybrid") {
        this.cookieBreakerUntil = Date.now() + COOKIE_BREAKER_OPEN_MS;
        this.cookieFailStreak = 0;
        this.emit({ kind: "cookie_path_failed", detail: `cookie path failing (${lastError?.message ?? "unknown"}); using the official API for ${COOKIE_BREAKER_OPEN_MS / 1000}s` });
      }
    }

    // Official API: the only path in anthropic_api mode, the failover in hybrid.
    if (apiUsable && this.api) {
      if (cookieAttempted || !cookiesUsable) {
        if (this.mode === "hybrid") this.emit({ kind: "failover_to_api", detail: lastError?.message ?? "cookie pool unavailable" });
      }
      const viaApi = await this.runApiAttempts(prompt, digest, url, key, options);
      if (viaApi) return viaApi;
      lastError = this.lastApiError ?? lastError;
    }

    // Every AI attempt failed: fall back to the local classifier rather than
    // dead-ending the session. Only surfaces an error when even that is empty.
    const local = localDetect(digest);
    if (local.products.length > 0 || local.addToCart) {
      this.logger.warn("ai_failed_local_fallback", (lastError?.message ?? "no accounts") + " - local products=" + local.products.length, { url });
      return { url, products: local.products, addToCart: local.addToCart, accountSource: "local", elapsedMs: 0, cached: false };
    }
    throw new Error("Detection failed after " + this.maxRetries + ": " + (lastError?.message ?? "no accounts"));
  }

  private lastApiError: Error | null = null;

  private emit(e: AiProviderEvent): void {
    try { this.onProviderEvent?.(e); } catch { /* alerting must never break detection */ }
  }

  private async runApiAttempts(
    prompt: string,
    digest: string,
    url: string,
    key: string,
    options: { skipCache?: boolean },
  ): Promise<PageDetectionResult | null> {
    const api = this.api!;
    this.lastApiError = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await api.send(prompt);
        const result = this.parseResponse(response, url, digest);
        if (!options.skipCache) {
          this.cache.set(key, { products: result.products, addToCart: result.addToCart, ...(result.plan ? { plan: result.plan } : {}), timestamp: Date.now() });
        }
        this.logger.debug("api_ok", response.elapsedMs + "ms products=" + result.products.length + (response.usage ? " tokens=" + response.usage.input + "/" + response.usage.output : ""), { url });
        return { ...result, cached: false };
      } catch (err) {
        this.lastApiError = err as Error;
        if (err instanceof ClaudeAuthError) {
          this.apiDisabled = true;
          this.emit({ kind: "api_auth_failed", detail: err.message });
          return null;
        }
        if (err instanceof ClaudePayloadError) {
          this.emit({ kind: "api_failed", detail: err.message });
          return null;
        }
        let waitMs = Math.min(4000, 400 * 2 ** attempt + Math.floor(Math.random() * 150));
        if (err instanceof ClaudeRateLimitError) {
          this.emit({ kind: "api_rate_limited", detail: `retry after ${err.retryAfter}s` });
          // A long server-side window is not worth blocking a live browser session for.
          if (err.retryAfter > 10) return null;
          waitMs = err.retryAfter * 1000;
        } else if (err instanceof ClaudeTransientError && err.retryAfterMs) {
          if (err.retryAfterMs > 10_000) return null;
          waitMs = err.retryAfterMs;
        }
        if (attempt + 1 < this.maxRetries) await new Promise<void>((r) => setTimeout(r, waitMs));
      }
    }
    if (this.lastApiError) this.emit({ kind: "api_failed", detail: this.lastApiError.message });
    return null;
  }

  clearCache(): void { this.cache.clear(); }
  get cacheSize(): number { return this.cache.size; }

  private parseResponse(response: ClaudeResponse, url: string, digest: string): PageDetectionResult {
    const data = response.parsed as Record<string, any> | null;
    const emptyResult: PageDetectionResult = { url, products: [], addToCart: null, accountSource: response.accountSource, elapsedMs: response.elapsedMs, cached: false };
    if (!data) return emptyResult;

    // ATC-plan replies carry no products array at all — that is fine, the
    // plan below is the payload we came for.
    const products: DetectedProduct[] = Array.isArray(data.products)
      ? (data.products
        .filter((p: any) => p && typeof p === "object" && p.is_sold_out !== true)
        .map((p: any) => ({
          selector: String(p.selector ?? p.card_selector ?? ""),
          text: String(p.text ?? p.title ?? ""),
          url: sanitizeProductPath(String(p.url ?? "").split("?")[0] ?? ""),
        }))
        .filter((p: DetectedProduct) => plausiblyNavigable(p.url)))
      : [];

    const seen = new Set<string>();
    const unique = products.filter(p => { if (seen.has(p.url)) return false; seen.add(p.url); return true; });

    const aiAtcValid =
      data.add_to_cart &&
      typeof data.add_to_cart === "object" &&
      Boolean(data.add_to_cart.selector) &&
      data.add_to_cart.is_enabled !== false;
    const atc = aiAtcValid
      ? { selector: String(data.add_to_cart.selector ?? ""), text: String(data.add_to_cart.text ?? "") }
      : (() => {
          const localAtc = localDetect(digest).addToCart;
          return localAtc ? { selector: localAtc.selector, text: localAtc.text } : null;
        })();

    const isSoldOut = data.is_sold_out === true;
    const formSelector = typeof data.form_selector === "string" && data.form_selector.trim()
      ? data.form_selector.trim()
      : undefined;
    const variantGated = data.variant_gated === true;

    // Variant groups → the executable plan. Options arrive as strings or
    // {selector,label,is_available} objects; anything unusable is dropped, and a group
    // with no usable options is dropped with it.
    const plan: import("../types.js").AtcPlan | undefined = (atc || formSelector || Array.isArray(data.variants))
      ? {
          ...(atc ? { addToCart: atc } : {}),
          ...(formSelector ? { formSelector } : {}),
          ...(variantGated ? { variantGated: true } : {}),
          ...(isSoldOut ? { isSoldOut: true } : {}),
          variants: Array.isArray(data.variants)
            ? (data.variants
              .filter((v: any) => v && typeof v === "object")
              .map((v: any) => ({
                group: String(v.group ?? v.name ?? "").slice(0, 30),
                options: (Array.isArray(v.options) ? v.options : [])
                  .filter((o: any) => {
                    if (typeof o === "object" && o !== null) {
                      return o.is_available !== false; // keep only in-stock or unspecified options
                    }
                    return true;
                  })
                  .map((o: any) => (typeof o === "string" ? o : String(o?.selector ?? "")))
                  .filter(Boolean)
                  .slice(0, 12),
              }))
              .filter((v: any) => v.options.length > 0)
              .slice(0, 3))
            : [],
        }
      : undefined;

    return { url, products: unique, addToCart: atc, plan, is_sold_out: isSoldOut, accountSource: response.accountSource, elapsedMs: response.elapsedMs, cached: false };
  }
}