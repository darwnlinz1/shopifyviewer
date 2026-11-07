/**
 * Dependency bootstrap.
 *
 * The tool is routinely handed to someone as a folder rather than installed
 * from a registry, and the first thing they do is run it. Failing with
 * "Cannot find package 'x'" at that point is a bad first
 * impression and an avoidable one: we know exactly what is missing and how to
 * get it, so we do that instead of complaining.
 *
 * This runs before any command and is a no-op once dependencies are present,
 * so the cost on every subsequent run is one `require.resolve`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Packages the tool cannot run without. */
const RUNTIME_DEPS = ["rebrowser-playwright"] as const;

/**
 * Marks a process that is already the result of a bootstrap restart.
 *
 * Without this the failure mode is spectacular: the restarted process checks
 * its dependencies, still cannot resolve one, installs and restarts again, and
 * each restart spawns another. One bad check forks until the machine gives up.
 * Bootstrapping is allowed to happen exactly once per invocation.
 */
const GUARD = "STOREFRONT_SIM_BOOTSTRAPPED";

/** The project root — one level above the compiled or source entry point. */
function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up until a package.json turns up, so this works from src/ and dist/.
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/**
 * Whether a package can actually be imported.
 *
 * `import.meta.resolve` first, and not as a stylistic preference:
 * Some optional deps are ESM-only and their `exports` maps declare `import` with no
 * `require` condition. `require.resolve` therefore throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED for a package that is installed and perfectly
 * usable — so a CJS-style check reports it permanently missing and this
 * bootstrap would reinstall it on every single run.
 */
function canResolve(name: string): boolean {
  try {
    import.meta.resolve(name);
    return true;
  } catch {
    // Older runtimes without import.meta.resolve, and CJS-only packages.
  }
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

/** Which required packages cannot currently be resolved. */
export function missingDependencies(): string[] {
  return RUNTIME_DEPS.filter((name) => !canResolve(name));
}

/**
 * Install dependencies if any are missing.
 *
 * Returns true when the tool is ready to run. Output is inherited so the
 * operator sees npm's progress rather than staring at a frozen terminal for a
 * minute.
 */
export function ensureDependencies(options: { quiet?: boolean } = {}): boolean {
  const missing = missingDependencies();
  if (missing.length === 0) return true;

  const root = projectRoot();

  // Already been round once and the dependency is still not resolvable.
  // Installing again would not change that, so say so and stop.
  if (process.env[GUARD] === "1") {
    process.stderr.write(
      `Cannot load ${missing.join(", ")} even after installing.\n\n` +
        `Install by hand and check for errors:\n` +
        `  cd "${root}"\n` +
        `  npm install\n`,
    );
    return false;
  }
  if (!options.quiet) {
    process.stderr.write(
      `Missing ${missing.join(", ")} — installing dependencies once, this takes a minute…\n\n`,
    );
  }

  // npm is `npm.cmd` on Windows, and spawnSync does not go through a shell.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["install", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: options.quiet ? "ignore" : "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.stderr.write(
      `\nAutomatic install failed. Run it yourself:\n  cd "${root}"\n  npm install\n`,
    );
    return false;
  }

  // Verify on disk rather than with require.resolve: Node caches resolution
  // failures for the life of the process, so a package installed a moment ago
  // still looks absent to the resolver that just failed to find it.
  const stillMissing = missing.filter(
    (name) => !existsSync(join(root, "node_modules", name, "package.json")),
  );
  if (stillMissing.length > 0) {
    process.stderr.write(
      `\nStill missing after install: ${stillMissing.join(", ")}.\n` +
        `Check that "${join(root, "package.json")}" lists them as dependencies.\n`,
    );
    return false;
  }

  // That same stale resolver state is why this process cannot simply carry on:
  // the import would fail even though the package is now there. Re-running the
  // exact same command in a fresh process is the reliable way through, and it
  // only ever happens once.
  if (!options.quiet) process.stderr.write("\nDependencies ready — starting.\n\n");

  // execArgv carries whatever loader is in play. Dropping it would restart a
  // `tsx src/cli.ts` run as plain `node src/cli.ts`, which cannot execute
  // TypeScript at all — the restart has to look exactly like the original.
  const rerun = spawnSync(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      stdio: "inherit",
      cwd: process.cwd(),
      env: { ...process.env, [GUARD]: "1" },
    },
  );
  process.exit(rerun.status ?? 1);
}

