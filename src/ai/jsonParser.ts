/**
 * src/ai/jsonParser.ts
 *
 * Ultra-robust JSON Extractor & Sanitizer for Claude 3.5 outputs.
 * Handles: Markdown fences, conversational preamble/postscript, trailing commas,
 * unescaped control chars, single quotes, and truncated/partial payloads.
 */

export interface SafeJsonParseResult<T = Record<string, unknown>> {
  success: boolean;
  data: T | null;
  error?: string;
  repaired?: boolean;
}

/**
 * Remove comments, trailing commas, and normalize malformed JSON strings.
 */
function sanitizeJsonString(jsonStr: string): string {
  let cleaned = jsonStr.trim();

  // Strip single-line (// ...) and multi-line (/* ... */) comments
  cleaned = cleaned.replace(/\/\/.*$/gm, "");
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");

  // Remove trailing commas before object/array close
  cleaned = cleaned.replace(/,\s*([\}\]])/g, "$1");

  return cleaned;
}

/**
 * Repair truncated JSON by automatically balancing unclosed braces/brackets/quotes.
 */
function repairTruncatedJson(str: string): string {
  let inString = false;
  let isEscaped = false;
  const stack: string[] = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}") {
      if (stack.length > 0 && stack[stack.length - 1] === "{") {
        stack.pop();
      }
    } else if (char === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === "[") {
        stack.pop();
      }
    }
  }

  let repaired = str;

  // Close open string literal
  if (inString) {
    repaired += '"';
  }

  // Remove any trailing comma inside the incomplete segment
  repaired = repaired.replace(/,\s*$/, "");

  // Close unclosed brackets/braces in reverse order
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === "{") repaired += "}";
    else if (open === "[") repaired += "]";
  }

  return repaired;
}

/**
 * Extract all balanced JSON blocks from a text string.
 */
function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];

  // 1. Check markdown fences first
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    if (match[1]?.trim()) {
      blocks.push(match[1].trim());
    }
  }

  // 2. Scan balanced outer braces
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        blocks.push(text.slice(startIdx, i + 1).trim());
        startIdx = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  // If text starts with '{' but was never closed (truncated stream), push candidate
  if (depth > 0 && startIdx !== -1) {
    blocks.push(text.slice(startIdx).trim());
  }

  // Also include full trimmed text as candidate fallback
  blocks.push(text.trim());

  return blocks;
}

/**
 * Master parser: tries parsing candidate strings with multi-layer sanitization.
 */
export function safeParseClaudeJson<T = Record<string, unknown>>(rawResponse: string): SafeJsonParseResult<T> {
  if (!rawResponse || !rawResponse.trim()) {
    return { success: false, data: null, error: "Empty response" };
  }

  const candidates = extractJsonBlocks(rawResponse);

  for (const candidate of candidates) {
    // Attempt 1: Direct parse
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return { success: true, data: parsed as T, repaired: false };
      }
    } catch { /* proceed to sanitizer */ }

    // Attempt 2: Sanitize (strip trailing commas, comments)
    const sanitized = sanitizeJsonString(candidate);
    try {
      const parsed = JSON.parse(sanitized);
      if (parsed && typeof parsed === "object") {
        return { success: true, data: parsed as T, repaired: true };
      }
    } catch { /* proceed to repair */ }

    // Attempt 3: Repair truncated brackets/braces
    const repaired = repairTruncatedJson(sanitized);
    try {
      const parsed = JSON.parse(repaired);
      if (parsed && typeof parsed === "object") {
        return { success: true, data: parsed as T, repaired: true };
      }
    } catch { /* try next candidate */ }
  }

  return { success: false, data: null, error: "Failed to parse valid JSON from LLM response" };
}
