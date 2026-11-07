/**
 * Unicode corruption guard — runs before every build (npm "prebuild").
 *
 * Detects mojibake generically: text that was UTF-8 once, mis-decoded as
 * CP1252, then saved as UTF-8 again. Such text is built exclusively from
 * characters in the image of CP1252's high byte range; re-encoding a run of
 * them back through CP1252 and strictly decoding as UTF-8 succeeds ONLY for
 * corrupted runs (a lone legitimate "é" or "—" fails strict decoding), which
 * makes the check exact rather than pattern-based.
 *
 * Exits non-zero listing every offending file:line so bad encodings can never
 * reach dist/ silently again.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Byte -> char for CP1252's high half (0x80-0x9F special table, rest latin1).
const HIGH = new Map([
  [0x80, "\u20AC"], [0x82, "\u201A"], [0x83, "\u0192"], [0x84, "\u201E"],
  [0x85, "\u2026"], [0x86, "\u2020"], [0x87, "\u2021"], [0x88, "\u02C6"],
  [0x89, "\u2030"], [0x8A, "\u0160"], [0x8B, "\u2039"], [0x8C, "\u0152"],
  [0x8E, "\u017D"], [0x91, "\u2018"], [0x92, "\u2019"], [0x93, "\u201C"],
  [0x94, "\u201D"], [0x95, "\u2022"], [0x96, "\u2013"], [0x97, "\u2014"],
  [0x98, "\u02DC"], [0x99, "\u2122"], [0x9A, "\u0161"], [0x9B, "\u203A"],
  [0x9C, "\u0153"], [0x9E, "\u017E"], [0x9F, "\u0178"],
]);
const IMAGE = new Set();
for (let b = 0x80; b <= 0xff; b++) {
  const ch = HIGH.has(b) ? HIGH.get(b) : String.fromCharCode(b);
  IMAGE.add(ch);
}
const decoder = new TextDecoder("utf8", { fatal: true });

/** True when a run of CP1252-image characters round-trips to valid UTF-8. */
function isMojibakeRun(run) {
  let bytes;
  try {
    const arr = [];
    for (const ch of run) {
      const cp = ch.codePointAt(0);
      const byte = [...HIGH.entries()].find(([, v]) => v === ch)?.[0] ?? cp;
      arr.push(byte);
    }
    bytes = Uint8Array.from(arr);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

const SUSPICIOUS = /[^\u0000-\u007f]/g;

const findings = [];
const exts = new Set([".ts", ".mjs", ".js", ".html", ".css"]);
(function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!exts.has("." + e.name.split(".").pop().toLowerCase())) continue;
    let text;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes("\uFFFD")) {
        findings.push(`${p.slice(root.length + 1)}:${i + 1} contains U+FFFD replacement character`);
        return;
      }
      // Find maximal runs of CP1252-image characters and test each.
      let start = -1;
      for (let idx = 0; idx <= line.length; idx++) {
        const inRun = idx < line.length && IMAGE.has(line[idx]);
        if (inRun && start < 0) start = idx;
        else if (!inRun && start >= 0) {
          const run = line.slice(start, idx);
          if (run.length >= 2 && SUSPICIOUS.test(run)) {
            const decoded = isMojibakeRun(run);
            if (decoded && /[^\u0000-\u00ff]/.test(decoded)) {
              findings.push(`${p.slice(root.length + 1)}:${i + 1} mojibake ${JSON.stringify(run.slice(0, 24))} -> should be ${JSON.stringify(decoded.slice(0, 12))}`);
            }
            SUSPICIOUS.lastIndex = 0;
          }
          start = -1;
        }
      }
    });
  }
})(join(root, "src"));
(function walkTests(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".test.mjs")) {
      const text = readFileSync(p, "utf8");
      if (text.includes("\uFFFD")) findings.push(`${p.slice(root.length + 1)} contains U+FFFD`);
    }
  }
})(join(root, "test"));

if (findings.length) {
  console.error("\nUnicode corruption detected — fix the sources before building:\n");
  for (const f of findings.slice(0, 40)) console.error("  " + f);
  if (findings.length > 40) console.error(`  ...and ${findings.length - 40} more`);
  console.error("\nThese sequences are UTF-8 text that was saved through the wrong codepage.");
  process.exit(1);
}
console.log(`unicode check ok (${readdirSync(join(root, "src"), { recursive: false }).length} top-level entries scanned)`);
