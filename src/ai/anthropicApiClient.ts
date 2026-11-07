/**
 * Official Anthropic Messages API client (`POST {baseUrl}/v1/messages`).
 *
 * The supported, billed path to the same Tier-2 detection prompt the cookie
 * pool serves. It has no session cookies to expire, no web endpoint to change
 * under it, and returns real `usage` for cost tracking.
 *
 * Error contract mirrors claudeClient.ts so ElementDetector can treat both
 * transports alike:
 *   401 / 403  → ClaudeAuthError          (key revoked or lacks access: permanent)
 *   429        → ClaudeRateLimitError     (honours retry-after)
 *   529 / 5xx  → ClaudeTransientError     (overloaded / upstream: retry with backoff)
 *   400 / 404  → ClaudePayloadError       (our request is wrong: never retried)
 */
import { ClaudeAuthError, ClaudeRateLimitError, ClaudePayloadError, extractJson, type ClaudeResponse } from "./claudeClient.js";

export const ANTHROPIC_API_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Detection is a short structured-extraction task: the small, fast tier is the right fit. */
export const DEFAULT_ANTHROPIC_API_MODEL = "claude-haiku-5-5";

export class ClaudeTransientError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ClaudeTransientError";
  }
}

export interface AnthropicApiOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Label recorded as `accountSource` so logs show which transport answered. */
export const API_SOURCE = "anthropic-api";

export class AnthropicApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicApiOptions) {
    if (!options.apiKey || !options.apiKey.trim()) throw new Error("AnthropicApiClient needs an apiKey");
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_ANTHROPIC_API_MODEL;
    this.maxTokens = options.maxTokens ?? 2048;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(prompt: string, options: { model?: string; maxTokens?: number } = {}): Promise<ClaudeResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: options.model ?? this.model,
          max_tokens: options.maxTokens ?? this.maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new ClaudeTransientError(0, aborted ? `Anthropic API timed out after ${this.timeoutMs}ms` : `Anthropic API unreachable: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) await this.throwForStatus(resp);

    const body = (await resp.json().catch(() => null)) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    } | null;
    if (!body || !Array.isArray(body.content)) {
      throw new ClaudeTransientError(resp.status, "Anthropic API returned an unreadable body");
    }
    const text = body.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return {
      text,
      parsed: extractJson(text),
      accountSource: API_SOURCE,
      orgId: "",
      elapsedMs: Date.now() - started,
      ...(body.usage ? { usage: { input: body.usage.input_tokens ?? 0, output: body.usage.output_tokens ?? 0 } } : {}),
    };
  }

  private async throwForStatus(resp: Response): Promise<never> {
    const detail = (await resp.text().catch(() => "")).slice(0, 300);
    const retryAfterSec = Number.parseFloat(resp.headers.get("retry-after") ?? "");
    const retryAfterMs = Number.isFinite(retryAfterSec) ? Math.round(retryAfterSec * 1000) : undefined;
    const s = resp.status;
    if (s === 401 || s === 403) throw new ClaudeAuthError(API_SOURCE, `Anthropic API rejected the key (${s}): ${detail}`);
    if (s === 429) throw new ClaudeRateLimitError(API_SOURCE, retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 30);
    if (s === 529 || s >= 500) throw new ClaudeTransientError(s, `Anthropic API ${s}: ${detail}`, retryAfterMs);
    if (s === 408 || s === 409) throw new ClaudeTransientError(s, `Anthropic API ${s}: ${detail}`, retryAfterMs);
    throw new ClaudePayloadError(`Anthropic API rejected the request (${s}): ${detail}`, "provider_payload");
  }
}
