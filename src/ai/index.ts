/**
 * AI Module barrel export.
 */
export { CookiePool, type CookieEntry, type PoolStats } from "./cookiePool.js";
export { ClaudeClient, ClaudeAuthError, ClaudeRateLimitError, type ClaudeResponse } from "./claudeClient.js";
export { buildDetectionPrompt, preprocessHtml, type DetectionPromptOptions } from "./promptTemplates.js";
