/**
 * Viewport size that works for every kernel.
 *
 * A launched context pins its viewport, so `page.viewportSize()` answers. A
 * context attached over CDP (BitBrowser) never sets viewport emulation — the
 * kernel owns the window — and `viewportSize()` is null there. Cursor and
 * wheel maths still need real bounds, so those pages are measured from the
 * inside and the answer is cached per page.
 */
import type { Page } from "rebrowser-playwright";
import { evaluateIsolated } from "../navigator/isolate.js";

export interface ViewportSize {
  width: number;
  height: number;
}

const FALLBACK: ViewportSize = { width: 1440, height: 900 };
const measured = new WeakMap<object, ViewportSize>();

/** Best known viewport for `page`, synchronously. */
export function viewportOf(page: Page): ViewportSize {
  const pinned = typeof page.viewportSize === "function" ? page.viewportSize() : null;
  if (pinned) return pinned;
  return (page && typeof page === "object" ? measured.get(page) : undefined) ?? FALLBACK;
}

/** Measure an un-pinned page (no-op when the context pins a viewport). */
export async function measureViewport(page: Page): Promise<ViewportSize> {
  const pinned = typeof page.viewportSize === "function" ? page.viewportSize() : null;
  if (pinned) return pinned;
  const size = await evaluateIsolated(page, () => ({ width: window.innerWidth, height: window.innerHeight }));
  if (size && size.width > 0 && size.height > 0) {
    measured.set(page, size);
    return size;
  }
  return viewportOf(page);
}
