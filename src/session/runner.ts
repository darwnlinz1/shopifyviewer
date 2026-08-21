/**
 * Multi-session runner.
 *
 * Runs N independent sessions with a bounded concurrency. Each session gets
 * its own persistent profile slot, its own seed, its own log file and its own
 * CloakBrowser instance, so sessions never share cookies or state — which is
 * what makes them useful as independent samples when testing a storefront.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SimulatorConfig } from "../config.js";
import { runSession } from "./manager.js";
import { Rng, randomSeed } from "../util/random.js";
import type { SessionResult } from "../types.js";

export interface RunSummary {
  storefront: string;
  startedAt: string;
  endedAt: string;
  sessions: SessionResult[];
  totals: {
    sessions: number;
    succeeded: number;
    failed: number;
    pagesVisited: number;
    productsViewed: number;
    collectionsViewed: number;
    jsErrors: number;
    consoleErrors: number;
    failedRequests: number;
    navigationErrors: number;
    /** Mean page-load wall time across every session's slowest navigation. */
    slowestNavigationMs: number | null;
  };
}

export interface RunOptions {
  config: SimulatorConfig;
  signal?: AbortSignal;
}

export async function runAll({ config, signal }: RunOptions): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const { count, concurrency } = config.session;
  const seedRng = new Rng(config.seed ?? randomSeed());

  const queue = Array.from({ length: count }, (_, index) => ({
    slot: index,
    sessionId: `${Date.now().toString(36)}-${index}-${randomUUID().slice(0, 8)}`,
    // Each session gets its own deterministic seed derived from the run seed.
    seed: config.seed !== undefined ? config.seed + index : seedRng.int(0, 0xffffffff),
  }));

  const results: SessionResult[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      if (signal?.aborted) return;
      const job = queue[cursor++];
      if (!job) return;
      try {
        const result = await runSession({
          slot: job.slot,
          sessionId: job.sessionId,
          seed: job.seed,
          config,
          lingerMs: config.session.lingerMs,
          ...(signal ? { signal } : {}),
        });
        results.push(result);
      } catch (err) {
        // runSession handles its own errors; this only catches a launch-time
        // throw so one bad session cannot take the whole run down.
        results.push({
          sessionId: job.sessionId,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: 0,
          exitReason: "error",
          actionsPerformed: 0,
          pagesVisited: 0,
          productsViewed: 0,
          collectionsViewed: 0,
          jsErrors: 0,
          consoleErrors: 0,
          failedRequests: 0,
          navigationErrors: 0,
          slowestNavigation: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, count) },
    () => worker(),
  );
  await Promise.all(workers);

  results.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const slowest = results
    .map((r) => r.slowestNavigation?.elapsedMs)
    .filter((v): v is number => typeof v === "number");

  const summary: RunSummary = {
    storefront: config.storefront,
    startedAt,
    endedAt: new Date().toISOString(),
    sessions: results,
    totals: {
      sessions: results.length,
      succeeded: results.filter((r) => r.exitReason !== "error").length,
      failed: results.filter((r) => r.exitReason === "error").length,
      pagesVisited: sum(results.map((r) => r.pagesVisited)),
      productsViewed: sum(results.map((r) => r.productsViewed)),
      collectionsViewed: sum(results.map((r) => r.collectionsViewed)),
      jsErrors: sum(results.map((r) => r.jsErrors)),
      consoleErrors: sum(results.map((r) => r.consoleErrors)),
      failedRequests: sum(results.map((r) => r.failedRequests)),
      navigationErrors: sum(results.map((r) => r.navigationErrors)),
      slowestNavigationMs:
        slowest.length > 0 ? Math.round(sum(slowest) / slowest.length) : null,
    },
  };

  if (config.logging.jsonl) {
    const dir = resolve(process.cwd(), config.logging.dir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `run-${startedAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  return summary;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
