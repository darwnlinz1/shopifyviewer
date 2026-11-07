/**
 * Structured logging.
 *
 * Every event carries sessionId, timestamp, action and URL so a run can be
 * replayed or diffed later. Events go to a per-session JSONL file and,
 * optionally, to the console in a compact human-readable form.
 */
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { resolve, join } from "node:path";
import type { LoggingConfig } from "../config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** A single structured event line. */
export interface LogEvent {
  ts: string;
  sessionId: string;
  level: LogLevel;
  /** Short machine-readable event name, e.g. "navigate", "scroll", "error". */
  event: string;
  /** The URL the session was on when the event happened. */
  url?: string;
  /** Behaviour-engine state at the time. */
  state?: string;
  msg?: string;
  /** Arbitrary structured payload (metrics, decision reasons, error detail). */
  data?: Record<string, unknown>;
}

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

export class Logger {
  private stream: WriteStream | null = null;
  private readonly threshold: number;
  private readonly useColor: boolean;

  /** Optional callback that returns a formatted elapsed/total time string */
  private timerFn?: () => string;

  constructor(
    private readonly sessionId: string,
    private readonly config: LoggingConfig,
    private readonly label = sessionId,
    timerFn?: () => string,
  ) {
    this.timerFn = timerFn;
    this.threshold = LEVEL_ORDER[config.level];
    this.useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

    if (config.jsonl) {
      const dir = resolve(process.cwd(), config.dir);
      mkdirSync(dir, { recursive: true });
      this.stream = createWriteStream(join(dir, `${sessionId}.jsonl`), {
        flags: "a",
      });
    }
  }

  /** Emit a structured event. */
  log(
    level: LogLevel,
    event: string,
    msg?: string,
    extra?: { url?: string; state?: string; data?: Record<string, unknown> },
  ): void {
    const entry: LogEvent = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      level,
      event,
      ...(extra?.url ? { url: extra.url } : {}),
      ...(extra?.state ? { state: extra.state } : {}),
      ...(msg ? { msg } : {}),
      ...(extra?.data ? { data: extra.data } : {}),
    };

    this.stream?.write(`${JSON.stringify(entry)}\n`);

    if (this.config.console && LEVEL_ORDER[level] >= this.threshold) {
      const color = this.useColor ? COLORS[level] : "";
      const reset = this.useColor ? RESET : "";
      const dim = this.useColor ? "\x1b[90m" : "";
      const bright = this.useColor ? "\x1b[97m" : "";
      const where = entry.url ? ` ${shorten(entry.url)}` : "";
      const detail = msg ? ` ${msg}` : "";
      
      // Build the countdown from the timer callback
      const timer = this.timerFn ? ` ${dim}${this.timerFn()}${reset}` : "";
      
      // Pretty block format:
      // [Gymshark     ] 02:31/05:00  ai_scan   discover products=13 /collections/all
      const paddedLabel = this.label.padEnd(14).slice(0, 14);
      
      process.stdout.write(
        `${bright}[${paddedLabel}]${reset}${timer} ${color}${event}${reset}${detail}${where}\n`,
      );
    }
  }

  debug(event: string, msg?: string, extra?: Parameters<Logger["log"]>[3]): void {
    this.log("debug", event, msg, extra);
  }
  info(event: string, msg?: string, extra?: Parameters<Logger["log"]>[3]): void {
    this.log("info", event, msg, extra);
  }
  warn(event: string, msg?: string, extra?: Parameters<Logger["log"]>[3]): void {
    this.log("warn", event, msg, extra);
  }
  error(event: string, msg?: string, extra?: Parameters<Logger["log"]>[3]): void {
    this.log("error", event, msg, extra);
  }

  /** Flush and close the JSONL stream. */
  async close(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    this.stream = null;
    await new Promise<void>((res) => stream.end(res));
  }
}

/** Trim a URL for console display, keeping the path meaningful. */
function shorten(url: string, max = 72): string {
  try {
    const parsed = new URL(url);
    const short = `${parsed.pathname}${parsed.search}`;
    return short.length > max ? `${short.slice(0, max - 1)}…` : short;
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url;
  }
}
