/**
 * src/security/wafDetector.ts
 *
 * Automated Challenge Detection & Mitigation Router.
 * Accurately detects and classifies active WAF interstitials across
 * Cloudflare Turnstile, DataDome Slider, Akamai Bot Manager,
 * and rate limits. Provides automated non-interactive solving,
 * biomechanical checkbox clicking, and quarantine escalation.
 */

import type { Page, Frame } from "rebrowser-playwright";
import type { Logger } from "../logging/logger.js";
import { sleep } from "../util/random.js";
import { evaluateIsolated } from "../navigator/isolate.js";

export type WafEngineType =
  | "cloudflare_turnstile"
  | "cloudflare_managed_challenge"
  | "datadome_slider"
  | "akamai_bot_manager"
  | "rate_limit_429"
  | "none";

export interface WafChallengeState {
  engine: WafEngineType;
  isInteractive: boolean;
  detectedAt: number;
  url: string;
  pageTitle: string;
  targetFrame?: Frame;
  challengeDetails?: Record<string, unknown>;
}

export interface WafSolveResult {
  resolved: boolean;
  engine: WafEngineType;
  elapsedMs: number;
  actionTaken: "auto_pass" | "biomechanical_click" | "proxy_failover" | "timeout" | "unhandled";
  error?: string;
}

export class WafChallengeDetector {
  /**
   * Non-invasive Turnstile observer (maintains 100% pristine window.turnstile descriptor).
   */
  public static async injectTurnstileHooks(_page: Page): Promise<void> {
    // Non-invasive: No JS monkey-patching on window.turnstile to prevent WAF bot detection traps
  }

  /**
   * Probe DOM for populated Cloudflare Turnstile token inputs non-invasively.
   */
  public static async probeTurnstileToken(page: Page): Promise<string | null> {
    try {
      return await evaluateIsolated(page, () => {
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], [name="cf-turnstile-response"], [name="g-recaptcha-response"]',
          ),
        );
        for (const input of inputs) {
          if (input.value && input.value.length > 20) {
            return input.value;
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  /**
   * Inspect page state, DOM elements, and child iframes to detect WAF barriers.
   */
  public static async inspectPage(page: Page, logger?: Logger): Promise<WafChallengeState> {
    const url = page.url();
    const isolatedTitle = await evaluateIsolated(page, function pageTitleInPage(): string { return document.title || ""; });
    const pageTitle = (isolatedTitle ?? (await (typeof page.title === "function" ? page.title() : Promise.resolve("")).catch(() => ""))) || "";

    // Inject hooks for SPAs
    await this.injectTurnstileHooks(page);

    // 1. Cloudflare Turnstile / Managed Challenge Detection
    if (
      /just a moment|checking your browser|attention required|cf-chl|cloudflare/i.test(pageTitle) ||
      url.includes("/cdn-cgi/challenge-platform/")
    ) {
      const turnstileFrame = page.frames().find((f) => f.url().includes("challenges.cloudflare.com"));
      return {
        engine: turnstileFrame ? "cloudflare_turnstile" : "cloudflare_managed_challenge",
        isInteractive: !!turnstileFrame,
        detectedAt: Date.now(),
        url,
        pageTitle,
        targetFrame: turnstileFrame,
      };
    }

    // Direct Turnstile Widget Probe in DOM (isolated utility world)
    const hasTurnstileWidget = !!(await evaluateIsolated(page, () => {
      return !!(
        document.querySelector(".cf-turnstile") ||
        document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        document.querySelector("#cf-challenge-running")
      );
    }));

    if (hasTurnstileWidget) {
      const activeToken = await this.probeTurnstileToken(page);
      if (activeToken) {
        return {
          engine: "none",
          isInteractive: false,
          detectedAt: Date.now(),
          url,
          pageTitle,
          challengeDetails: { turnstileToken: activeToken },
        };
      }

      const turnstileFrame = page.frames().find((f) => f.url().includes("challenges.cloudflare.com"));
      return {
        engine: "cloudflare_turnstile",
        isInteractive: true,
        detectedAt: Date.now(),
        url,
        pageTitle,
        targetFrame: turnstileFrame,
      };
    }

    // 2. DataDome Slider & Interstitial Detection
    if (/geo\.captcha-delivery\.com/i.test(url)) {
      return {
        engine: "datadome_slider",
        isInteractive: true,
        detectedAt: Date.now(),
        url,
        pageTitle,
      };
    }

    const dataDomeDetected = !!(await evaluateIsolated(page, () => {
      const hasCaptchaDiv = !!document.querySelector("#datadome-captcha");
      const hasDataDomeIframe = !!document.querySelector('iframe[src*="captcha-delivery.com"]');
      const hasDataDomeScript = !!document.querySelector('script[src*="datadome.js"], script[src*="tags.js"]');
      const isBlocked = document.title.toLowerCase().includes("datadome") || (document.body && document.body.innerText && document.body.innerText.includes("DataDome"));
      return hasCaptchaDiv || hasDataDomeIframe || (hasDataDomeScript && isBlocked);
    }));

    if (dataDomeDetected) {
      const dataDomeFrame = page.frames().find((f) => f.url().includes("captcha-delivery.com"));
      return {
        engine: "datadome_slider",
        isInteractive: true,
        detectedAt: Date.now(),
        url,
        pageTitle,
        targetFrame: dataDomeFrame,
      };
    }

    // 3. Akamai Bot Manager Premier Detection
    if (/access denied|reference #|errors\.edgesuite\.net/i.test(pageTitle)) {
      return {
        engine: "akamai_bot_manager",
        isInteractive: false,
        detectedAt: Date.now(),
        url,
        pageTitle,
      };
    }

    // 4. Rate Limit 429
    if (/too many requests|rate limit|error 429/i.test(pageTitle)) {
      return {
        engine: "rate_limit_429",
        isInteractive: false,
        detectedAt: Date.now(),
        url,
        pageTitle,
      };
    }

    return {
      engine: "none",
      isInteractive: false,
      detectedAt: Date.now(),
      url,
      pageTitle,
    };
  }

  /**
   * Execute tailored mitigation routine based on detected WAF challenge.
   */
  public static async resolveChallenge(
    page: Page,
    state: WafChallengeState,
    logger: Logger,
    maxWaitTimeoutMs = 15000,
  ): Promise<WafSolveResult> {
    const started = Date.now();
    logger.warn("waf_mitigation_started", `Executing mitigation ladder for: ${state.engine}`, {
      data: { url: state.url, isInteractive: state.isInteractive }
    });

    switch (state.engine) {
      case "cloudflare_turnstile":
      case "cloudflare_managed_challenge": {
        // Step 1: Check if token already solved in SPA / embedded widget
        const initialToken = await this.probeTurnstileToken(page);
        if (initialToken) {
          const elapsedMs = Date.now() - started;
          logger.info("turnstile_token_immediate", `Turnstile token observed in DOM in ${elapsedMs}ms`);
          return {
            resolved: true,
            engine: state.engine,
            elapsedMs,
            actionTaken: "auto_pass",
          };
        }

        // Step 2: Wait for non-interactive auto-solve (up to 4.5s)
        for (let i = 0; i < 9; i++) {
          await sleep(500);
          const token = await this.probeTurnstileToken(page);
          const current = await this.inspectPage(page, logger);
          if (token || current.engine === "none") {
            const elapsedMs = Date.now() - started;
            logger.info("turnstile_auto_solved", `Cloudflare Turnstile auto-solved passively in ${elapsedMs}ms`);
            return {
              resolved: true,
              engine: state.engine,
              elapsedMs,
              actionTaken: "auto_pass",
            };
          }
        }

        // Step 3: Interactive checkbox resolution
        try {
          const turnstileFrame =
            state.targetFrame ||
            page.frames().find((f) => f.url().includes("challenges.cloudflare.com"));

          if (turnstileFrame) {
            const checkbox = turnstileFrame
              .locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage')
              .first();
            if (await checkbox.isVisible({ timeout: 3000 }).catch(() => false)) {
              logger.info("turnstile_checkbox_found", "Interactive Turnstile checkbox found. Executing click.");

              const box = await checkbox.boundingBox({ timeout: 2000 }).catch(() => null);
              if (box) {
                const targetX = box.x + box.width / 2 + (Math.random() * 4 - 2);
                const targetY = box.y + box.height / 2 + (Math.random() * 4 - 2);

                await page.mouse.move(targetX, targetY);
                await sleep(150);
                await page.mouse.down();
                await sleep(120);
                await page.mouse.up();
              } else {
                await checkbox.click({ timeout: 2000 }).catch(() => {});
              }

              // Await verification clearance
              for (let i = 0; i < 12; i++) {
                await sleep(600);
                const solvedToken = await this.probeTurnstileToken(page);
                const postClick = await this.inspectPage(page, logger);
                if (solvedToken || postClick.engine === "none") {
                  const elapsedMs = Date.now() - started;
                  logger.info("turnstile_click_solved", `Turnstile passed via interaction in ${elapsedMs}ms`);
                  return {
                    resolved: true,
                    engine: state.engine,
                    elapsedMs,
                    actionTaken: "biomechanical_click",
                  };
                }
              }
            }
          }
        } catch (err) {
          logger.debug("turnstile_solve_err", "Turnstile checkbox attempt error", { data: { error: String(err) } });
        }

        return {
          resolved: false,
          engine: state.engine,
          elapsedMs: Date.now() - started,
          actionTaken: "timeout",
          error: "Cloudflare Turnstile could not be solved within budget.",
        };
      }

      case "datadome_slider":
      case "akamai_bot_manager":
      case "rate_limit_429": {
        return {
          resolved: false,
          engine: state.engine,
          elapsedMs: Date.now() - started,
          actionTaken: "proxy_failover",
          error: `WAF barrier ${state.engine} requires proxy rotation/cooldown.`,
        };
      }

      default:
        return {
          resolved: true,
          engine: "none",
          elapsedMs: Date.now() - started,
          actionTaken: "auto_pass",
        };
    }
  }
}
