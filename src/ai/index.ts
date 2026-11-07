/**
 * AI Module barrel export.
 */
export { CookiePool, type CookieEntry, type PoolStats } from "./cookiePool.js";
export { ClaudeClient, ClaudeAuthError, ClaudeRateLimitError, type ClaudeResponse } from "./claudeClient.js";
export { buildDetectionPrompt, preprocessHtml, type DetectionPromptOptions } from "./promptTemplates.js";
export { AnthropicApiClient, ClaudeTransientError, DEFAULT_ANTHROPIC_API_MODEL } from "./anthropicApiClient.js";
export { resolveAiProvider, readAnthropicKey, type ResolvedAiProvider } from "./provider.js";
