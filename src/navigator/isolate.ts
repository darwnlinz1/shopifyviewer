/**
 * Isolated-world evaluation.
 *
 * page.evaluate runs in the page's main world, where its calls are visible
 * to any anti-bot script watching for automation (stack inspection, patched
 * built-ins). An isolated world sees the same DOM but none of the page's JS:
 * its own globals, its own copies of the DOM bindings, nothing the page can
 * hook — the same mechanism browser extensions' content scripts use.
 *
 * Playwright's client API has no world option, so the world is created over a
 * raw CDP session: Page.createIsolatedWorld + Runtime.evaluate with its
 * context id. Runtime.enable is never sent (that is the classic automation
 * leak). The world is cached per page and recreated after a main-frame
 * navigation, which destroys it along with the old document.
 *
 * Returns null when no isolated world can be had (closed page, non-Chromium,
 * a test double); callers that must still get an answer fall back to the main
 * world explicitly.
 *
 * NOTE: the function is serialized with toString() and evaluated in the
 * browser, so it must stay fully self-contained. Under tsx/esbuild a
 * `__name` helper leaks into the transpiled body ("__name is not defined") —
 * run sessions from the built dist output.
 */
import type { CDPSession, Page } from "rebrowser-playwright";

interface IsolatedWorld {
  cdp: CDPSession;
  contextId: number;
}

/** Neutral name; it only shows up in DevTools' context picker. */
const WORLD_NAME = "sv_isolated";

const worlds = new WeakMap<object, Promise<IsolatedWorld | null>>();
const sessions = new WeakMap<object, Promise<CDPSession | null>>();
const watched = new WeakSet<object>();

function sessionFor(page: Page): Promise<CDPSession | null> {
  let session = sessions.get(page);
  if (!session) {
    session = (async () => {
      try {
        return await page.context().newCDPSession(page);
      } catch {
        return null;
      }
    })();
    sessions.set(page, session);
  }
  return session;
}

function worldFor(page: Page, fresh: boolean): Promise<IsolatedWorld | null> {
  if (!fresh) {
    const cached = worlds.get(page);
    if (cached) return cached;
  }
  if (!watched.has(page) && typeof page.on === "function") {
    watched.add(page);
    // A new document takes the old world with it.
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) worlds.delete(page);
    });
  }
  const world = (async (): Promise<IsolatedWorld | null> => {
    const cdp = await sessionFor(page);
    if (!cdp) return null;
    try {
      const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      const created = (await cdp.send("Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: WORLD_NAME,
        grantUniveralAccess: true,
      })) as { executionContextId: number };
      return { cdp, contextId: created.executionContextId };
    } catch {
      return null;
    }
  })();
  worlds.set(page, world);
  return world;
}

/**
 * Run a self-contained function (no closures) in an isolated world. `arg`
 * must be JSON-serialisable; it is inlined into the expression. Promises are
 * awaited, so async functions work.
 */
export async function evaluateIsolated<R>(page: Page, fn: () => R): Promise<Awaited<R> | null>;
export async function evaluateIsolated<R, A>(page: Page, fn: (arg: A) => R, arg: A): Promise<Awaited<R> | null>;
export async function evaluateIsolated<R, A>(
  page: Page,
  fn: ((arg: A) => R) | (() => R),
  arg?: A,
): Promise<Awaited<R> | null> {
  if (!page || typeof page.context !== "function") return null;
  if (typeof page.isClosed === "function" && page.isClosed()) return null;
  const expression = "(" + fn.toString() + ")(" + (arg === undefined ? "" : JSON.stringify(arg)) + ")";

  for (let attempt = 0; attempt < 2; attempt++) {
    const world = await worldFor(page, attempt > 0);
    if (!world) return null;
    try {
      const res = (await world.cdp.send("Runtime.evaluate", {
        expression,
        contextId: world.contextId,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
      if (res.exceptionDetails) return null;
      return (res.result?.value ?? null) as Awaited<R> | null;
    } catch (err) {
      // Context destroyed mid-flight (navigation) — rebuild the world once.
      // A session that is already gone will only log again if we retry.
      worlds.delete(page);
      const msg = err instanceof Error ? err.message : String(err);
      if (/session closed|target closed|browser has been closed|execution context was destroyed/i.test(msg)) return null;
    }
  }
  return null;
}
