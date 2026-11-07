/**
 * Decide which AI transport(s) a run uses, from config + environment.
 */
import type { AiConfig, AiProvider } from "../config.js";
import { AnthropicApiClient } from "./anthropicApiClient.js";

export interface ResolvedAiProvider {
  mode: AiProvider;
  /** Present for anthropic_api and hybrid. */
  api?: AnthropicApiClient;
  /** Why this mode was chosen (logged once at session start). */
  reason: string;
}

export function readAnthropicKey(ai: Pick<AiConfig, "anthropic">, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envName = ai.anthropic?.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const fromEnv = env[envName]?.trim();
  if (fromEnv) return fromEnv;
  const literal = ai.anthropic?.apiKey?.trim();
  return literal || undefined;
}

export function resolveAiProvider(ai: Partial<AiConfig>, env: NodeJS.ProcessEnv = process.env): ResolvedAiProvider {
  const key = readAnthropicKey({ anthropic: ai.anthropic }, env);
  const requested = ai.provider;

  const makeApi = (apiKey: string): AnthropicApiClient =>
    new AnthropicApiClient({
      apiKey,
      ...(ai.anthropic?.baseUrl ? { baseUrl: ai.anthropic.baseUrl } : {}),
      ...(ai.anthropic?.model ? { model: ai.anthropic.model } : {}),
      ...(ai.anthropic?.maxTokens ? { maxTokens: ai.anthropic.maxTokens } : {}),
      ...(ai.anthropic?.timeoutMs ? { timeoutMs: ai.anthropic.timeoutMs } : {}),
    });

  if (requested === "cookie_pool") return { mode: "cookie_pool", reason: "configured" };

  if (requested === "anthropic_api" || requested === "hybrid") {
    if (!key) {
      // A requested API mode with no key must not silently become something
      // else without saying so — the caller logs `reason`.
      return {
        mode: "cookie_pool",
        reason: `provider "${requested}" requested but no API key (${ai.anthropic?.apiKeyEnv ?? "ANTHROPIC_API_KEY"}) is set; using cookie_pool`,
      };
    }
    return { mode: requested, api: makeApi(key), reason: "configured" };
  }

  return key
    ? { mode: "hybrid", api: makeApi(key), reason: "API key found in environment; cookie pool first, official API as failover" }
    : { mode: "cookie_pool", reason: "no API key in environment" };
}
