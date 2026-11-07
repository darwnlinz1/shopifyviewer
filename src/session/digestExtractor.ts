/**
 * The SOURCE DIGEST: a compact text view of the page that the AI tier and the
 * local classifier both read.
 *
 * Layout:
 *   TITLE= / BODYTEXT=       bot-wall fingerprints and rendered-text size
 *   JSON-LD:{...}            authoritative product markers
 *   OG:TYPE=product          secondary confirmation
 *   VARIANTS:                option selects and radio groups
 *   LINKS:                   every unique same-origin path + text + card ctx + price
 *   CONTROLS:                buttons/submits — where an add-to-cart lives
 */
import type { Page } from "rebrowser-playwright";
import { evaluateIsolated } from "../navigator/isolate.js";

/**
 * Build the digest. Serialized into the isolated world (invisible to page
 * scripts), so it must stay self-contained: no closures, no imports.
 */
export function extractSourceDigest(): string {
  const out: string[] = [];
  const push = (line: string): void => { if (out.length < 280) out.push(line); };

  // The title carries bot-wall fingerprints ("Just a moment...", etc.) that
  // survive even when nothing else renders.
  push("TITLE=" + (document.title || "").slice(0, 120));
  // Rendered-text size: a hydrated-but-blank SPA (failed XHRs, throttled
  // APIs) keeps hidden template anchors while showing a white screen.
  const bodyTextLen = ((document.body?.innerText || "").replace(/\s+/g, " ").trim()).length;
  push("BODYTEXT=" + bodyTextLen);

  const ld: string[] = [];
  const itemListUrls: Array<{ path: string; title: string }> = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    const t = (s.textContent || "").trim();
    if (!t) return;
    if (t.length <= 1500 && /"@type"\s*:\s*"?product/i.test(t)) {
      ld.push(t);
    }
    if (/"@type"\s*:\s*"?(ItemList|CollectionPage)/i.test(t)) {
      try {
        const data = JSON.parse(t);
        const items = data["@type"] === "ItemList" ? data.itemListElement : data.mainEntity?.itemListElement;
        if (Array.isArray(items)) {
          for (const item of items) {
            const prod = item?.item || item;
            const rawUrl = prod?.url || prod?.["@id"];
            if (typeof rawUrl === "string" && /\/products?\//.test(rawUrl)) {
              const u = new URL(rawUrl, location.origin);
              itemListUrls.push({ path: u.pathname, title: String(prod?.name || "").trim().slice(0, 80) });
            }
          }
        }
      } catch {}
    }
  });
  if (ld.length) push("JSON-LD:\n" + ld.join("\n---\n"));
  const og = document.querySelector('meta[property="og:type"]');
  const ogType = og ? og.getAttribute("content") : null;
  if (ogType) push("OG:TYPE=" + ogType);

  // Variant controls: option selects and radio groups. Placed early — a PDP's
  // size/colour pickers are exactly what the ATC plan needs and must not be
  // crowded out of the line budget by navigation links.
  push("VARIANTS:");
  const seenVariant = new Set<string>();
  document.querySelectorAll("select").forEach((s) => {
    const el = s as HTMLSelectElement;
    const key = "select" + (el.id || el.name || "");
    if (!el.options.length || seenVariant.has(key)) return;
    seenVariant.add(key);
    const label = (el.closest("label")?.textContent || el.getAttribute("aria-label") || "options").trim().slice(0, 30);
    const opts = Array.from(el.options).map((o) => o.text.trim()).filter(Boolean).slice(0, 12).join("|");
    if (opts) push(`select${el.id ? "#" + el.id : ""}${el.name ? "[name=" + el.name + "]" : ""} | ${label} | opts:${opts}`);
  });
  const radioGroups = new Map<string, string[]>();
  document.querySelectorAll('input[type=radio]').forEach((r) => {
    const el = r as HTMLInputElement;
    if (!el.name) return;
    const lbl = ((el.closest("label")?.textContent || "") || el.value || "").trim().slice(0, 24);
    if (!radioGroups.has(el.name)) radioGroups.set(el.name, []);
    const arr = radioGroups.get(el.name) as string[];
    if (arr.length < 12 && lbl) arr.push(lbl);
  });
  for (const [nm, opts] of radioGroups) {
    if (opts.length >= 2) {
      push(`radio[name=${nm}] | group | opts:${opts.join("|")}`);
      if (out.length > 250) break;
    }
  }

  push("LINKS:");
  const seen = new Set<string>();
  const productLines: string[] = [];
  const collectionLines: string[] = [];
  const otherLines: string[] = [];
  document.querySelectorAll("a[href]").forEach((a) => {
    const el = a as HTMLAnchorElement;
    const href = el.href || "";
    if (!href || href.startsWith("javascript:") || href.endsWith("#")) return;
    let u: URL;
    try { u = new URL(href, location.origin); } catch { return; }
    if (seen.has(u.pathname)) return;
    seen.add(u.pathname);
    // Flatten whitespace: multi-line link text would otherwise tear one
    // entry into two digest lines.
    const text = ((el as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const card = el.closest('[class*="card"], [class*="product"], article, li');
    const cls = card ? String(card.className).slice(0, 90) : "";
    const priceEl = card?.querySelector("[class*='price'], [data-price]");
    const price = priceEl ? ((priceEl as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 30) : "";
    const line = u.pathname + (u.search || "") + " | " + text + (cls ? " | ctx:" + cls : "") + (price ? " | price:" + price : "");
    // Product links go first: header/footer nav must not crowd them out of
    // the line budget (a 280-line cap fills with ~100 nav links easily).
    if (/\/products?\//.test(u.pathname) && !/\/products\/(cookie[-_]?consent|privacy|terms|account|login|search|wishlist)\/?$/i.test(u.pathname)) productLines.push(line);
    else if (/\.html$/i.test(u.pathname) && (/product/i.test(cls + " " + text) || /\d{6,}\.html$/i.test(u.pathname))) productLines.push(line);
    else if (/Product-Show/i.test(u.pathname + u.search)) productLines.push(line);
    else if (/\/collections\/[^/]+\/?$/.test(u.pathname)) collectionLines.push(line);
    else otherLines.push(line);
  });
  // SPA / Hydrogen / Remix fallback: [data-product-url], [data-product-handle], JSON-LD ItemList products
  document.querySelectorAll("[data-product-url], [data-product-handle]").forEach((el) => {
    const rawUrl = el.getAttribute("data-product-url") || (el.getAttribute("data-product-handle") ? "/products/" + el.getAttribute("data-product-handle") : "");
    if (!rawUrl) return;
    let u: URL;
    try { u = new URL(rawUrl, location.origin); } catch { return; }
    if (seen.has(u.pathname)) return;
    seen.add(u.pathname);
    const text = (el.getAttribute("data-product-title") || (el as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const priceEl = el.querySelector("[class*='price'], [data-price]");
    const price = priceEl ? ((priceEl as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 30) : "";
    productLines.push(u.pathname + " | " + text + " | ctx:spa-data-card" + (price ? " | price:" + price : ""));
  });
  for (const item of itemListUrls) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    productLines.push(item.path + " | " + item.title + " | ctx:json-ld-itemlist");
  }
  [...productLines, ...collectionLines, ...otherLines].forEach(push);

  // Buttons/submits — where an add-to-cart lives. ATC-shaped labels go
  // first: upsell/gift widgets can fill the whole line budget otherwise.
  push("CONTROLS:");
  const atcControls: string[] = [];
  const otherControls: string[] = [];
  document.querySelectorAll('button, input[type=submit], [role="button"]').forEach((b) => {
    const el = b as HTMLButtonElement;
    const rawLabel = (el.innerText || el.value || el.getAttribute("aria-label") || "") as string;
    // Flatten newlines: a two-line label ("Ajouter au panier\nAjouté") must
    // stay one digest line or the parsers below tear it apart.
    const label = rawLabel.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!label) return;
    const form = el.closest("form");
    const action = form ? (form.getAttribute("action") || "") : "";
    const bits = [
      el.name ? "name=" + el.name : "",
      action.includes("cart") ? "form:" + action.slice(0, 60) : "",
    ].filter(Boolean);
    const line = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + " | " + label + (bits.length ? " | " + bits.join(" ") : "");
    if (/add\s|buy|cart|bag|mua|giỏ/i.test(label)) atcControls.push(line);
    else otherControls.push(line);
  });
  [...atcControls, ...otherControls].forEach(push);

  return out.join("\n");
}

/** Digest of the live page: isolated world first, main world only as a last resort. */
export async function readDigest(page: Page): Promise<string> {
  const isolated = await evaluateIsolated(page, extractSourceDigest);
  if (typeof isolated === "string" && isolated.length >= 20) return isolated;
  if (typeof page.isClosed === "function" && page.isClosed()) return "";
  // On Chromium the isolated world is available. A null result means the frame
  // died mid-navigation; falling through to page.evaluate only makes
  // rebrowser log "session closed".
  if (isolated === null && typeof page.context === "function") return "";
  return page.evaluate(extractSourceDigest).catch(() => "");
}

/** Product title from a digest (OG title wins over the document title). */
export function digestProductTitle(digest: string): string {
  const m = /^OG:TITLE=(.*)$/m.exec(digest) || /^TITLE=(.*)$/m.exec(digest);
  return m && m[1] ? m[1].replace(/—.*$/i, "").trim().slice(0, 45) : "";
}

/** First price the digest saw. */
export function digestPrice(digest: string): string {
  const m = /price:([^\n|]+)/i.exec(digest);
  return m && m[1] ? m[1].trim() : "";
}
