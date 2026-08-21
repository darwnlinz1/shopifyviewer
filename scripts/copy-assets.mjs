/**
 * Copy the dashboard's static assets into dist/.
 *
 * `tsc` only emits JavaScript, so the HTML, CSS and browser-side JS that the
 * server serves from `server/public` would be missing from a built package
 * without this step.
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "src", "server", "public");
const to = join(root, "dist", "server", "public");

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
process.stdout.write(`copied ${from} → ${to}\n`);
