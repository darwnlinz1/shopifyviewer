/**
 * Session Report Generator.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Cookie pool standing at session end (survival-rate tracking). */
export interface CookiePoolSummary {
  totalLoaded: number;
  active: number;
  quarantined: number;
  cooldown: number;
  healthy: number;
  degraded: number;
}

export interface SessionReport {
  sessionId: string;
  profileName: string;
  site: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  personality: string;
  pagesVisited: number;
  productsClicked: string[];
  addToCartPerformed: boolean;
  aiCalls: { total: number; avgMs: number };
  cookiesPool?: CookiePoolSummary;
  errors: number;
}

export function saveSessionReport(report: SessionReport, outputDir = "./reports"): string {
  const dir = resolve(outputDir);
  mkdirSync(dir, { recursive: true });
  const filepath = join(dir, report.sessionId + ".json");
  try {
    writeFileSync(filepath, JSON.stringify(report, null, 2), "utf8");
    return filepath;
  } catch { return ""; }
}