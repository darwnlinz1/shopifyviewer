/**
 * Tier 0 of the detection waterfall: selector recipes remembered per shop.
 *
 * A theme renders every product page of a shop from the same template, so the
 * selectors that found the buy button, the option groups and the cart drawer
 * on the first product page hold for the next ten thousand. They are stored
 * per `hostname + pageType` in data/domain-recipes.json; a lookup is a Map
 * read, and a selector that stops working is dropped after a couple of
 * failures so the shop is simply re-learned by the tiers below.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDb, type SiteViewerDb } from "../storage/db.js";

const NS_RECIPES = "recipe";

export type RecipePageType = "home" | "collection" | "product" | "cart" | "search" | "other";

export type RecipeField = "productCard" | "addToCart" | "variantGroups" | "cartDrawer" | "gallery" | "sections";

export type RecipeSource = "tier1" | "ai" | "manual";

export interface DomainSelectorRecipe {
  hostname: string;
  pageType: RecipePageType;
  /** Product link inside a listing card. */
  productCard?: string;
  /** The buy-box add-to-cart control. */
  addToCart?: string;
  /** Option-group containers (size, colour…). */
  variantGroups?: string[];
  /** Drawer / mini-cart that opens after an add. */
  cartDrawer?: string;
  /** Gallery thumbnails or carousel arrow. */
  gallery?: string;
  /** Collapsible description / shipping / size-guide headers. */
  sections?: string;
  source: RecipeSource;
  confidence: number;
  hits: number;
  failures: number;
  /** Consecutive failures per field; a success resets that field. */
  fieldFailures?: Partial<Record<RecipeField, number>>;
  learnedAt: string;
  updatedAt: string;
}

interface RecipeFile {
  version: 1;
  recipes: DomainSelectorRecipe[];
}

export interface RecipeCacheOptions {
  /** Debounce before the file is rewritten after a change. */
  flushDelayMs?: number;
  /** Consecutive failures that drop a field. */
  maxFieldFailures?: number;
  /** Recipes kept; the least recently updated go first. */
  maxRecipes?: number;
  /**
   * Persist to this database (one row per recipe, only changed rows written)
   * instead of rewriting the whole JSON file. `path` is then only the legacy
   * file imported once when the table is empty.
   */
  db?: SiteViewerDb;
}

export const DEFAULT_RECIPE_PATH = "./data/domain-recipes.json";

export class DomainRecipeCache {
  readonly path: string;
  private readonly recipes = new Map<string, DomainSelectorRecipe>();
  private readonly flushDelayMs: number;
  private readonly maxFieldFailures: number;
  private readonly maxRecipes: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private readonly db: SiteViewerDb | undefined;
  /** Keys changed since the last flush; null value = deleted. */
  private readonly pending = new Map<string, DomainSelectorRecipe | null>();

  constructor(path: string = DEFAULT_RECIPE_PATH, options: RecipeCacheOptions = {}) {
    this.path = resolve(process.cwd(), path);
    this.db = options.db;
    this.flushDelayMs = options.flushDelayMs ?? 400;
    this.maxFieldFailures = Math.max(1, options.maxFieldFailures ?? 2);
    this.maxRecipes = Math.max(10, options.maxRecipes ?? 5000);
    this.load();
  }

  /** Classify a storefront URL the way recipes are keyed. */
  static pageTypeOf(url: string): RecipePageType {
    let path: string;
    try {
      path = new URL(url, "https://x.invalid").pathname.toLowerCase().replace(/\/+$/, "") || "/";
    } catch {
      return "other";
    }
    // Locale prefixes (/en-us/products/...) do not change the template.
    const bare = path.replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/)/, "") || "/";
    if (/\/products?\/[^/]+$/.test(bare)) return "product";
    if (/^\/collections(\/[^/]+)?$/.test(bare)) return "collection";
    if (bare === "/") return "home";
    if (/^\/cart$/.test(bare)) return "cart";
    if (/^\/search$/.test(bare)) return "search";
    return "other";
  }

  /** www.shop.com and shop.com serve the same theme. */
  static hostOf(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  private static keyOf(host: string, pageType: RecipePageType): string {
    return `${host}|${pageType}`;
  }

  get size(): number {
    return this.recipes.size;
  }

  list(): DomainSelectorRecipe[] {
    return [...this.recipes.values()];
  }

  get(url: string, pageType: RecipePageType = DomainRecipeCache.pageTypeOf(url)): DomainSelectorRecipe | undefined {
    const host = DomainRecipeCache.hostOf(url);
    return host ? this.recipes.get(DomainRecipeCache.keyOf(host, pageType)) : undefined;
  }

  /**
   * Merge selectors into the recipe for this shop + page type.
   *
   * A selector that is already known keeps its history. A different one
   * replaces it when it comes from a stronger source (an AI or operator
   * correction), when the old one has been failing, or when it scored at
   * least as well — otherwise the proven selector stays.
   */
  learn(
    url: string,
    pageType: RecipePageType,
    fields: Partial<Pick<DomainSelectorRecipe, RecipeField>>,
    source: RecipeSource,
    confidence: number,
  ): DomainSelectorRecipe | undefined {
    const host = DomainRecipeCache.hostOf(url);
    if (!host) return undefined;
    const key = DomainRecipeCache.keyOf(host, pageType);
    const now = new Date().toISOString();
    const existing = this.recipes.get(key);
    const recipe: DomainSelectorRecipe = existing ?? {
      hostname: host,
      pageType,
      source,
      confidence,
      hits: 0,
      failures: 0,
      learnedAt: now,
      updatedAt: now,
    };

    let changed = !existing;
    for (const [field, value] of Object.entries(fields) as Array<[RecipeField, string | string[] | undefined]>) {
      if (value === undefined || (Array.isArray(value) ? value.length === 0 : !value)) continue;
      const current = recipe[field];
      const same = JSON.stringify(current) === JSON.stringify(value);
      if (same) continue;
      const failing = (recipe.fieldFailures?.[field] ?? 0) > 0;
      const stronger = source !== "tier1" && recipe.source === "tier1";
      if (current === undefined || failing || stronger || confidence >= recipe.confidence) {
        (recipe as unknown as Record<string, unknown>)[field] = value;
        if (recipe.fieldFailures) delete recipe.fieldFailures[field];
        changed = true;
      }
    }
    if (!changed) return recipe;

    if (source !== "tier1" || recipe.source === "tier1") recipe.source = source;
    recipe.confidence = Math.min(1, Math.max(0, confidence));
    recipe.updatedAt = now;
    this.recipes.set(key, recipe);
    this.pending.set(key, recipe);
    this.evict();
    this.scheduleFlush();
    return recipe;
  }

  /** A remembered selector just worked. */
  recordHit(url: string, pageType: RecipePageType, field?: RecipeField): void {
    const recipe = this.get(url, pageType);
    if (!recipe) return;
    recipe.hits++;
    if (field && recipe.fieldFailures?.[field]) delete recipe.fieldFailures[field];
    recipe.confidence = Math.min(1, recipe.confidence + 0.02);
    recipe.updatedAt = new Date().toISOString();
    this.pending.set(DomainRecipeCache.keyOf(recipe.hostname, recipe.pageType), recipe);
    this.scheduleFlush();
  }

  /**
   * A remembered selector failed. Returns true when the field was dropped,
   * which sends the next page of this shop back through Tier 1 / Tier 2.
   */
  recordFailure(url: string, pageType: RecipePageType, field: RecipeField): boolean {
    const recipe = this.get(url, pageType);
    if (!recipe || recipe[field] === undefined) return false;
    recipe.failures++;
    recipe.fieldFailures ??= {};
    const count = (recipe.fieldFailures[field] ?? 0) + 1;
    recipe.fieldFailures[field] = count;
    let dropped = false;
    if (count >= this.maxFieldFailures) {
      delete recipe[field];
      delete recipe.fieldFailures[field];
      recipe.confidence = Math.max(0, recipe.confidence - 0.2);
      dropped = true;
    }
    recipe.updatedAt = new Date().toISOString();
    this.pending.set(DomainRecipeCache.keyOf(recipe.hostname, recipe.pageType), recipe);
    this.scheduleFlush();
    return dropped;
  }

  forget(url: string, pageType: RecipePageType): void {
    const host = DomainRecipeCache.hostOf(url);
    if (!host) return;
    const key = DomainRecipeCache.keyOf(host, pageType);
    if (this.recipes.delete(key)) {
      this.pending.set(key, null);
      this.scheduleFlush();
    }
  }

  /** Write pending changes now (atomic: temp file + rename). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    if (this.db) {
      const db = this.db;
      const batch = [...this.pending];
      try {
        db.transaction(() => {
          for (const [key, recipe] of batch) {
            if (recipe) db.putDoc(NS_RECIPES, key, recipe);
            else db.deleteDoc(NS_RECIPES, key);
          }
        });
        for (const [key, recipe] of batch) if (this.pending.get(key) === recipe) this.pending.delete(key);
      } catch {
        this.dirty = true; // keep the batch; retried on the next change or exit
      }
      return;
    }
    const file: RecipeFile = { version: 1, recipes: [...this.recipes.values()] };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      renameSync(tmp, this.path);
    } catch {
      // A read-only data dir must not break browsing; recipes stay in memory.
      this.dirty = true;
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  private evict(): void {
    if (this.recipes.size <= this.maxRecipes) return;
    const oldest = [...this.recipes.entries()]
      .sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
      .slice(0, this.recipes.size - this.maxRecipes);
    for (const [key] of oldest) {
      this.recipes.delete(key);
      this.pending.set(key, null);
    }
  }

  private load(): void {
    if (this.db) {
      for (const { key, value } of this.db.listDocs<DomainSelectorRecipe>(NS_RECIPES)) this.recipes.set(key, value);
      if (this.recipes.size === 0) this.importLegacyJson();
      return;
    }
    this.loadJsonFile(this.path);
  }

  /** Seed an empty database from the old data/domain-recipes.json, once. */
  private importLegacyJson(): void {
    const legacy = join(dirname(this.path), "domain-recipes.json");
    if (!existsSync(legacy)) return;
    this.loadJsonFile(legacy);
    for (const [key, recipe] of this.recipes) this.pending.set(key, recipe);
    if (this.pending.size > 0) {
      this.dirty = true;
      this.flush();
    }
  }

  private loadJsonFile(file: string): void {
    if (!existsSync(file)) return;
    try {
      const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw) as Partial<RecipeFile>;
      for (const r of Array.isArray(parsed.recipes) ? parsed.recipes : []) {
        if (!r || typeof r.hostname !== "string" || typeof r.pageType !== "string") continue;
        this.recipes.set(DomainRecipeCache.keyOf(r.hostname, r.pageType), r);
      }
    } catch {
      // A corrupt cache is only lost learning; start empty rather than refuse to run.
    }
  }
}

const shared = new Map<string, DomainRecipeCache>();
let exitHookInstalled = false;

/** One cache per file for the whole process, flushed on exit. */
export function sharedRecipeCache(path: string = DEFAULT_RECIPE_PATH): DomainRecipeCache {
  const abs = resolve(process.cwd(), path);
  // Registered before the database opens: exit listeners run in registration
  // order, and the final flush must land before the connection is closed.
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const c of shared.values()) c.flush();
    });
  }
  let cache = shared.get(abs);
  if (!cache) {
    // A .db / .sqlite path selects the SQLite backend; anything else stays JSON.
    cache = /\.(db|sqlite3?)$/i.test(abs)
      ? new DomainRecipeCache(abs, { db: openDb(abs) })
      : new DomainRecipeCache(abs);
    shared.set(abs, cache);
  }
  return cache;
}
