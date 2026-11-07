/**
 * Realtime health alerts: Telegram, Discord, or a generic JSON webhook.
 *
 * The fleet runs unattended, so the failures that matter — the AI tier going
 * dark, a shop whose add-to-cart rate collapses, a proxy that only ever meets
 * bot walls — must reach the operator without anyone watching the dashboard.
 *
 * Design rules:
 *  - Alerts are best effort. A dead webhook never blocks or fails a session.
 *  - Dedup: one alert key is delivered at most once per cooldown, so a flapping
 *    condition cannot flood a chat. Suppressed repeats are counted and
 *    reported on the next delivery.
 *  - Rate rules use a rolling window with a minimum sample size, so two failed
 *    clicks on a quiet shop are not a "collapse".
 *  - Secrets come from environment variables, not from config files.
 *  - History is stored in the database so the dashboard can show it.
 */
import type { AlertSinkConfig, AlertsConfig } from "../config.js";
import type { SiteViewerDb } from "../storage/db.js";
import type { AiProviderEvent } from "../ai/elementDetector.js";
import { parseProxy } from "../profiles/proxy.js";

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  /** Dedup key, e.g. "atc_rate:shop.example". */
  key: string;
  severity: AlertSeverity;
  title: string;
  body: string;
}

export interface AlertSink {
  readonly name: string;
  send(alert: Alert, suppressed: number): Promise<void>;
}

const NS_ALERT = "alert";
const MAX_BODY = 1500;

function fmt(alert: Alert, suppressed: number): string {
  const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟠" : "🔵";
  const tail = suppressed > 0 ? `\n(+${suppressed} similar alert(s) suppressed)` : "";
  const text = `${icon} ${alert.title}\n${alert.body}${tail}`;
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}

function assertHttp(url: string, label: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`${label}: invalid URL`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${label}: only http(s) URLs are allowed`);
  return u;
}

export class TelegramSink implements AlertSink {
  readonly name = "telegram";
  constructor(private readonly token: string, private readonly chatId: string, private readonly fetchImpl: typeof fetch = fetch, private readonly apiBase = "https://api.telegram.org") {}
  async send(alert: Alert, suppressed: number): Promise<void> {
    const resp = await this.fetchImpl(`${this.apiBase}/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: fmt(alert, suppressed), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`telegram ${resp.status}`);
  }
}

export class DiscordSink implements AlertSink {
  readonly name = "discord";
  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch = fetch) {
    assertHttp(url, "discord webhook");
  }
  async send(alert: Alert, suppressed: number): Promise<void> {
    const resp = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Never let alert text ping @everyone / roles.
      body: JSON.stringify({ content: fmt(alert, suppressed), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`discord ${resp.status}`);
  }
}

export class WebhookSink implements AlertSink {
  readonly name = "webhook";
  constructor(private readonly url: string, private readonly headers: Record<string, string> = {}, private readonly fetchImpl: typeof fetch = fetch) {
    assertHttp(url, "webhook");
  }
  async send(alert: Alert, suppressed: number): Promise<void> {
    const resp = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify({ ...alert, suppressed, text: fmt(alert, suppressed), ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`webhook ${resp.status}`);
  }
}

export function buildSinks(cfg: AlertSinkConfig[], env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): AlertSink[] {
  const sinks: AlertSink[] = [];
  for (const c of cfg) {
    try {
      if (c.type === "telegram") {
        const token = (c.botTokenEnv ? env[c.botTokenEnv] : undefined) ?? env.TELEGRAM_BOT_TOKEN ?? c.botToken;
        if (token && c.chatId) sinks.push(new TelegramSink(token, c.chatId, fetchImpl));
      } else if (c.type === "discord") {
        const url = (c.webhookUrlEnv ? env[c.webhookUrlEnv] : undefined) ?? env.DISCORD_WEBHOOK_URL ?? c.webhookUrl;
        if (url) sinks.push(new DiscordSink(url, fetchImpl));
      } else if (c.type === "webhook") {
        const url = (c.urlEnv ? env[c.urlEnv] : undefined) ?? c.url;
        if (url) sinks.push(new WebhookSink(url, c.headers, fetchImpl));
      }
    } catch {
      // A malformed sink is skipped; the rest still work.
    }
  }
  return sinks;
}

/**
 * Reduce a proxy string to `host:port` for display. Proxy URLs routinely carry
 * credentials (`http://user:pass@host:port`, `host:port:user:pass`); an alert
 * is sent to a third-party chat service and must never contain them.
 */
export function proxyLabel(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return "direct";
  // Built on the same parser the rest of the app uses, so every proxy format it
  // accepts is handled here too. An unparseable string is never echoed back.
  try {
    const p = parseProxy(t);
    return `${p.host}:${p.port}`;
  } catch {
    return "proxy";
  }
}

interface Sample { at: number; ok: boolean }

export class AlertManager {
  private readonly sinks: AlertSink[];
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly atcMinAttempts: number;
  private readonly atcMinRate: number;
  private readonly challengeThreshold: number;
  private readonly lastSent = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  private readonly atc = new Map<string, Sample[]>();
  private readonly challenges = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(
    private readonly cfg: AlertsConfig | undefined,
    private readonly db?: SiteViewerDb,
    options: { sinks?: AlertSink[]; now?: () => number; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
  ) {
    this.sinks = options.sinks ?? (cfg?.enabled ? buildSinks(cfg.sinks, options.env, options.fetchImpl) : []);
    this.cooldownMs = cfg?.cooldownMs ?? 10 * 60_000;
    this.windowMs = cfg?.windowMs ?? 30 * 60_000;
    this.atcMinAttempts = cfg?.atcMinAttempts ?? 8;
    this.atcMinRate = cfg?.atcMinSuccessRate ?? 0.4;
    this.challengeThreshold = cfg?.challengeThreshold ?? 5;
    this.now = options.now ?? Date.now;
  }

  get active(): boolean {
    return this.sinks.length > 0;
  }

  /** Deliver an alert, subject to dedup. Resolves once delivery settles; never rejects. */
  async notify(alert: Alert): Promise<boolean> {
    const t = this.now();
    const last = this.lastSent.get(alert.key);
    if (last !== undefined && t - last < this.cooldownMs) {
      this.suppressed.set(alert.key, (this.suppressed.get(alert.key) ?? 0) + 1);
      return false;
    }
    const suppressed = this.suppressed.get(alert.key) ?? 0;
    this.lastSent.set(alert.key, t);
    this.suppressed.delete(alert.key);
    try { this.db?.appendEvent(NS_ALERT, alert.severity, { ...alert, suppressed }); } catch { /* history is optional */ }
    if (this.sinks.length === 0) return true;
    await Promise.all(
      this.sinks.map((s) => s.send(alert, suppressed).catch(() => undefined)),
    );
    return true;
  }

  /** Recent alert history (newest first) for the dashboard. */
  history(limit = 50): Array<Alert & { ts: number; suppressed: number }> {
    if (!this.db) return [];
    return this.db.queryEvents<Alert & { suppressed: number }>(NS_ALERT, { limit }).map((e) => ({ ...e.data, ts: e.ts }));
  }

  /** Feed one add-to-cart outcome; alerts when a host's success rate collapses. */
  recordAtc(host: string, verified: boolean): void {
    if (!host) return;
    const t = this.now();
    const list = (this.atc.get(host) ?? []).filter((s) => t - s.at <= this.windowMs);
    list.push({ at: t, ok: verified });
    this.atc.set(host, list);
    if (list.length < this.atcMinAttempts) return;
    const rate = list.filter((s) => s.ok).length / list.length;
    if (rate < this.atcMinRate) {
      void this.notify({
        key: `atc_rate:${host}`,
        severity: "warning",
        title: `Add-to-cart success dropped on ${host}`,
        body: `${Math.round(rate * 100)}% verified over the last ${list.length} attempts (threshold ${Math.round(this.atcMinRate * 100)}%). The theme may have changed — recipes for this shop may need re-learning.`,
      });
    }
  }

  /** Feed one WAF/bot challenge; alerts when one proxy keeps meeting them. */
  recordChallenge(proxyKey: string, host: string): void {
    const t = this.now();
    const id = proxyLabel(proxyKey);
    const list = (this.challenges.get(id) ?? []).filter((at) => t - at <= this.windowMs);
    list.push(t);
    this.challenges.set(id, list);
    if (list.length >= this.challengeThreshold) {
      void this.notify({
        key: `challenge:${id}`,
        severity: "warning",
        title: `Repeated bot challenges on ${id === "direct" ? "the direct connection" : `proxy ${id}`}`,
        body: `${list.length} challenges in the last ${Math.round(this.windowMs / 60_000)} min (latest on ${host}). The exit IP may be flagged — consider rotating it.`,
      });
    }
  }

  /** Map an AI-provider health signal to an alert. */
  providerEvent(e: AiProviderEvent): void {
    const critical = e.kind === "api_auth_failed";
    const titles: Record<AiProviderEvent["kind"], string> = {
      cookie_pool_empty: "AI cookie pool has no healthy cookies",
      cookie_path_failed: "AI cookie pool failing — failed over to the official API",
      failover_to_api: "AI request served by the official API (cookie pool unavailable)",
      api_auth_failed: "Anthropic API key rejected",
      api_rate_limited: "Anthropic API rate-limited",
      api_failed: "Anthropic API request failed",
    };
    void this.notify({
      key: `ai:${e.kind}`,
      severity: critical ? "critical" : e.kind === "failover_to_api" ? "info" : "warning",
      title: titles[e.kind],
      body: e.detail,
    });
  }
}
