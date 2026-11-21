/**
 * Isolated-world evaluation.
 *
 * page.evaluate runs in the page's main world, where its calls are visible
 * to any anti-bot script watching for automation (stack inspection, patched
 * built-ins). CDP's Runtime.evaluate in a freshly created isolated world
 * sees the same DOM but none of the page's JS traps — the same trick the
 * stealth browser packages use internally.
 *
 * Falls back to null on anything unexpected (non-Chromium engines, closed
 * pages, protocol errors); callers decide whether to retry in the main world.
 *
 * NOTE: the function is serialized with toString() and evaluated in the
 * browser, so it must stay fully self-contained. Under tsx/esbuild a
 * `__name` helper leaks into the transpiled body and both worlds fail
 * ("__name is not defined") — run sessions from the built dist output.
 */
import type { Page } from "rebrowser-playwright";

/** Run a self-contained function (no closures) in an isolated world without CDP session leaks. */
export async function evaluateIsolated<R>(
  page: Page,
  fn: () => R,
): Promise<R | null> {
  try {
    const expression = "(" + fn.toString() + ")()";
    // rebrowser-playwright utility context evaluation: zero CDP Runtime.enable leaks
    if (typeof (page as any).evaluateInUtilityContext === "function") {
      return await (page as any).evaluateInUtilityContext(expression);
    }
    // Standard page evaluation fallback
    return await page.evaluate(fn);
  } catch {
    return null;
  }
}

