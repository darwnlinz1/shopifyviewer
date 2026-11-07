/**
 * Claude Web API Client - Desktop App Emulator.
 *
 * EXACT port from ai_orchestratorTOP/orchestrator/llm_client.py
 * Uses claude.ai/api (NOT api.anthropic.com).
 * Emulates the Claude Desktop App with cookie-based auth.
 *
 * Headers and payload are kept 1:1 with the Python source.
 */
import type { CookieEntry } from "./cookiePool.js";
import { DEFAULT_CLAUDE_MODEL } from "../config.js";

// --- Types ---

export interface ClaudeResponse {
  text: string;
  parsed: Record<string, unknown> | null;
  accountSource: string;
  orgId: string;
  elapsedMs: number;
  usage?: { input: number; output: number };
}

// --- Constants ---

const BASE_URL = "https://claude.ai/api";

/**
 * Timezone and locale reported to the API. Derived from this machine so the
 * payload cannot contradict the environment the cookies actually come from —
 * a pinned America/Los_Angeles on a machine that lives elsewhere is exactly
 * the kind of mismatch that gets an account flagged.
 */
function systemTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles"; }
  catch { return "America/Los_Angeles"; }
}

function systemLocale(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().locale || "en-US"; }
  catch { return "en-US"; }
}

const DESKTOP_HEADERS: Record<string, string> = {
  "Connection": "keep-alive",
  "accept-language": "en-US",
  "anthropic-client-app": "com.anthropic.claudefordesktop",
  "anthropic-client-os-platform": "win32",
  "anthropic-client-os-version": "10.0.19045",
  "anthropic-client-platform": "desktop_app",
  "anthropic-client-version": "1.12603.1",
  "anthropic-desktop-topbar": "1",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-site": "none",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.12603.1 Chrome/148.0.7778.254 Electron/42.4.0 Safari/537.36 MSIX",
  "Content-Type": "application/json",
};

// --- Stream parsing ---

interface StreamChunk { text: string; kind: "token" | "thinking"; }

class StreamBuffer {
  private chunks: StreamChunk[] = [];
  append(text: string, kind: "token" | "thinking" = "token"): void {
    if (text) this.chunks.push({ text, kind });
  }
  finish(): [string, StreamChunk[]] {
    const text = this.chunks.filter(c => c.kind !== "thinking").map(c => c.text).join("");
    return [text, [...this.chunks]];
  }
}

// --- Error classes ---

export class ClaudeAuthError extends Error {
  constructor(readonly accountSource: string, message?: string) {
    super(message ?? "Auth failed: " + accountSource);
    this.name = "ClaudeAuthError";
  }
}

export class ClaudeRateLimitError extends Error {
  retryAfter: number;
  constructor(readonly accountSource: string, retryAfter: number = 300) {
    super("Rate limited: " + accountSource);
    this.name = "ClaudeRateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class ClaudePayloadError extends Error {
  classification: string;
  constructor(message: string, classification = "provider_payload") {
    super(message);
    this.name = "ClaudePayloadError";
    this.classification = classification;
  }
}

// --- Full builtin tools list (exact from Python WebClaudeClient) ---

function buildBuiltinTools(mcpServerUuid: string): Array<Record<string, unknown>> {
  return [
    {
      name: "read_me",
      description: "Returns required context for show_widget...",
      input_schema: {
        type: "object",
        properties: {
          modules: {
            type: "array",
            items: {
              type: "string",
              enum: ["diagram", "mockup", "interactive", "data_viz", "art", "chart", "elicitation"],
            },
          },
          platform: { type: "string", enum: ["mobile", "desktop", "unknown"] },
        },
      },
      integration_name: "visualize",
      mcp_server_uuid: mcpServerUuid,
      mcp_server_url: "https://sandbox.claudemcpcontent.com/imagine_mcp",
      needs_approval: false,
      backend_execution: true,
      read_only_hint: true,
      is_mcp_app: false,
    },
    {
      name: "show_widget",
      description: "Show visual content...",
      input_schema: {
        type: "object",
        properties: {
          loading_messages: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
          title: { type: "string" },
          widget_code: { type: "string" },
        },
        required: ["loading_messages", "title", "widget_code"],
      },
      integration_name: "visualize",
      mcp_server_uuid: mcpServerUuid,
      mcp_server_url: "https://sandbox.claudemcpcontent.com/imagine_mcp",
      needs_approval: false,
      backend_execution: true,
      read_only_hint: true,
      is_mcp_app: true,
    },
    { type: "web_search_v0", name: "web_search" },
    { type: "artifacts_v0", name: "artifacts" },
    { type: "repl_v0", name: "repl" },
    { type: "widget", name: "weather_fetch" },
    { type: "widget", name: "recipe_display_v0" },
    { type: "widget", name: "places_map_display_v0" },
    { type: "widget", name: "message_compose_v1" },
    { type: "widget", name: "ask_user_input_v0" },
    { type: "widget", name: "recommend_claude_apps" },
    { type: "widget", name: "show_recommendation_cards" },
    { type: "widget", name: "schedule_cowork_task_v0" },
    { type: "widget", name: "chart_display_v0" },
    { type: "widget", name: "places_search" },
    { type: "widget", name: "fetch_sports_data" },
    { type: "widget", name: "options_card_display_v0" },
    { type: "widget", name: "step_card_display_v0" },
    { type: "widget", name: "itinerary_display_v0" },
    { type: "widget", name: "comparison_card_display_v0" },
    { type: "widget", name: "featured_card_display_v0" },
    { type: "widget", name: "product_carousel_display_v0" },
    { type: "widget", name: "link_preview_display_v0" },
    { type: "widget", name: "places_list_display_v0" },
  ];
}

// --- Main client ---

export class ClaudeClient {
  constructor(
    private readonly baseUrl: string = BASE_URL,
    private readonly timeoutMs: number = 120_000,
    private readonly stallMs: number = 30_000,
    private readonly maxTotalMs: number = 180_000,
  ) {}

  async send(
    prompt: string,
    cookie: CookieEntry,
    options: {
      model?: string;
      effort?: string;
      isNewChat?: boolean;
      enableBuiltinTools?: boolean;
    } = {},
  ): Promise<ClaudeResponse> {
    if (!cookie.orgId) throw new Error("No orgId for " + cookie.source);

    const model = options.model ?? DEFAULT_CLAUDE_MODEL;
    const effort = options.effort ?? "medium";
    const isNewChat = options.isNewChat ?? true;
    const enableTools = options.enableBuiltinTools ?? true;

    const chatUuid = crypto.randomUUID();
    const humanMsgUuid = crypto.randomUUID();
    const assistantMsgUuid = crypto.randomUUID();
    const mcpServerUuid = crypto.randomUUID();
    const activitySessionId = crypto.randomUUID();

    const url = this.baseUrl + "/organizations/" + cookie.orgId
      + "/chat_conversations/" + chatUuid + "/completion";

    // --- Build payload ---
    const payload: Record<string, any> = {
      prompt,
      timezone: systemTimezone(),
      locale: systemLocale(),
      model,
      effort,
      thinking_mode: "auto",
      turn_message_uuids: {
        human_message_uuid: humanMsgUuid,
        assistant_message_uuid: assistantMsgUuid,
      },
      attachments: [],
      files: [],
      sync_sources: [],
      rendering_mode: "messages",
    };

    if (enableTools) {
      payload.tools = buildBuiltinTools(mcpServerUuid);
    } else {
      // Omit tools entirely — empty list is rejected by Claude
    }

    // Conversation params: only on new chat
    if (isNewChat) {
      const convParams: Record<string, any> = {
        name: "",
        model,
        include_conversation_preferences: false,
        paprika_mode: null,
        compass_mode: null,
        is_temporary: false,  // exact from Python
      };
      if (enableTools) {
        convParams.tool_search_mode = "auto";
        convParams.enabled_imagine = true;
      }
      payload.create_conversation_params = convParams;
    }

    // --- Headers (exact from Python, per-request Cookie + activity session) ---
    const headers: Record<string, string> = {
      ...DESKTOP_HEADERS,
      "Cookie": cookie.cookieString,
      "x-activity-session-id": activitySessionId,
    };

    // --- Send request with streaming ---
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const maxTimer = setTimeout(() => controller.abort(), this.maxTotalMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // --- Error checking (exact from Python _check_response) ---
      if (resp.status === 403 && (await this.isEdgeChallenge(resp))) {
        // A Cloudflare interstitial says nothing about the cookie. Quarantining
        // it for good (as an auth failure would) turns one transient challenge
        // into a permanently lost account; a cooldown keeps it and lets the
        // caller fail over to another transport meanwhile.
        throw new ClaudeRateLimitError(cookie.source, 300);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new ClaudeAuthError(cookie.source, "API rejected auth (" + resp.status + ")");
      }
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") ?? "300", 10) || 300;
        throw new ClaudeRateLimitError(cookie.source, retryAfter);
      }
      if (resp.status === 400) {
        const detail = await resp.text().catch(() => "");
        if (this.looksLikeAccountError(detail)) {
          throw new ClaudeAuthError(cookie.source, "Account disabled: " + detail.slice(0, 200));
        }
        if (detail.toLowerCase().includes("conversation could not be created")) {
          throw new ClaudePayloadError("Ambiguous conversation (400): " + detail.slice(0, 200), "ambiguous_conversation");
        }
        throw new ClaudePayloadError("Claude rejected payload (400): " + detail.slice(0, 200), "provider_payload");
      }
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error("Claude error " + resp.status + ": " + detail.slice(0, 200));
      }

      // --- Stream reading (exact from Python) ---
      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      const streamBuffer = new StreamBuffer();
      let buf = "";
      let sawTerminal = false;
      let lastProgress = Date.now();
      let usage: { input: number; output: number } | undefined;

      try {
        while (true) {
          if (Date.now() - lastProgress > this.stallMs) {
            reader.cancel("stream stalled");
            throw new Error("Stream stalled for " + this.stallMs + "ms");
          }

          const readResult = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), this.stallMs)
            ),
          ]);

          if (readResult.done || !readResult.value) break;
          lastProgress = Date.now();

          buf += decoder.decode(readResult.value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const encoded = trimmed.slice(5).trim();
            if (encoded === "[DONE]") {
              sawTerminal = true;
              continue;
            }

            let data: any;
            try { data = JSON.parse(encoded); } catch { continue; }

            const eventType = String(data.type ?? "");

            // Terminal events
            if (
              eventType === "message_stop" ||
              data.stop_reason ||
              data.done === true ||
              (eventType === "message_delta" && data.delta?.stop_reason)
            ) {
              sawTerminal = true;
            }

            // Error in stream
            if (data.type === "error") {
              const error = typeof data.error === "object" ? data.error : {};
              const errorType = String(error.type ?? "").toLowerCase();
              const message = String(error.message ?? "Stream error");

              if (errorType.includes("rate_limit")) {
                throw new ClaudeRateLimitError(cookie.source, error.retry_after ?? 300);
              }
              if (errorType.includes("auth") || errorType.includes("permission") || errorType.includes("forbidden")) {
                throw new ClaudeAuthError(cookie.source, message);
              }
              throw new Error("Claude stream error: " + message);
            }

            // Extract text + thinking (exact from Python)
            let chunkText = "";
            let chunkType: "token" | "thinking" = "token";

            if (data.type === "content_block_delta") {
              const delta = data.delta ?? {};
              if (delta.type === "text_delta") {
                chunkText = delta.text ?? "";
              } else if (delta.type === "thinking_delta") {
                chunkText = delta.thinking ?? "";
                chunkType = "thinking";
              }
            } else if (data.completion) {
              chunkText = data.completion;
            } else if (data.delta?.text) {
              chunkText = data.delta.text;
            } else if (typeof data.text === "string") {
              chunkText = data.text;
            }

            if (chunkText) {
              streamBuffer.append(chunkText, chunkType);
            }

            // Usage from message
            if (data.message?.usage) {
              usage = {
                input: data.message.usage.input_tokens ?? 0,
                output: data.message.usage.output_tokens ?? 0,
              };
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!sawTerminal) {
        throw new Error("Stream ended before terminal event");
      }

      const [fullText] = streamBuffer.finish();

      return {
        text: fullText,
        parsed: extractJson(fullText),
        accountSource: cookie.source,
        orgId: cookie.orgId,
        elapsedMs: Date.now() - started,
        usage,
      };
    } finally {
      clearTimeout(timeout);
      clearTimeout(maxTimer);
    }
  }

  // --- Error classification ---

  /** True for a Cloudflare managed-challenge response rather than an API-level refusal. */
  private async isEdgeChallenge(resp: Response): Promise<boolean> {
    if ((resp.headers.get("cf-mitigated") ?? "").toLowerCase() === "challenge") return true;
    const type = resp.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return false;
    const body = (await resp.clone().text().catch(() => "")).slice(0, 4000).toLowerCase();
    return body.includes("just a moment") || body.includes("cf-chl") || body.includes("challenge-platform");
  }

  private looksLikeAccountError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      (lower.includes("account") && lower.includes("disabled")) ||
      (lower.includes("organization") && lower.includes("not found")) ||
      lower.includes("unauthorized") ||
      lower.includes("suspended")
    );
  }
}

// --- Response JSON extraction ---

import { safeParseClaudeJson } from "./jsonParser.js";

/**
 * Pull the JSON object out of a model reply. Models wrap payloads in code
 * fences, prepend commentary, or emit trailing prose — and the naive
 * first-{ to last-} slice breaks the moment any brace appears in prose.
 *
 * Uses safeParseClaudeJson with multi-layer sanitization and auto-repair.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const result = safeParseClaudeJson<Record<string, unknown>>(text);
  if (result.success && result.data) return result.data;
  return null;
}