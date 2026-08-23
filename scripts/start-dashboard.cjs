#!/usr/bin/env node
/**
 * Storefront Simulator — one-click launcher for Windows.
 *
 * Double-click (or run from cmd) and the dashboard comes up:
 *   1. installs npm dependencies on first run if missing
 *   2. provisions CloakBrowser's Chromium (~1GB, once) unless a fallback
 *      browser is already configured
 *   3. starts the dashboard and opens it in the default browser
 *
 * No Node knowledge required — this is the file non-technical operators use.
 */
const { spawn, spawnSync } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");

// This script lives in <root>/scripts/, so the project root is one level up.
// __dirname is used (not cwd) so double-clicking the .bat works from anywhere.
const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath; // the Node running this script

function info(msg) { console.log(`\n  ${msg}`); }
function step(no, msg) { console.log(`\n[${no}] ${msg}...`); }
function fail(msg, hint) {
  console.error(`\n  LOI: ${msg}`);
  if (hint) console.error(`\n  ${hint}`);
  console.error("");
  spawnSync(NODE, ["-e", "process.exit()"]);
  // Keep the window open so the operator can read the message.
  const pause = process.platform === "win32" ? "pause" : "sleep 30";
  spawnSync(process.platform === "win32" ? "cmd.exe" : "bash",
    process.platform === "win32" ? ["/c", "pause"] : ["-c", pause],
    { stdio: "inherit" });
  process.exit(1);
}

// ---------------------------------------------------------------- checks

if (!existsSync(path.join(ROOT, "dist", "cli.js"))) {
  fail(
    "Thieu ban build (dist/cli.js).",
    "Chay 'npm install' va 'npm run build' trong thu muc nay truoc.",
  );
}

// ---------------------------------------------------------------- deps

step(1, "Kiem tra thu vien (dependencies)");
// Resolve against the project's node_modules, not whatever is next to the
// Node binary — cwd alone does not affect require.resolve in `-e` scripts.
const missing = spawnSync(NODE, [
  "-e",
  `const path = require("path");
   for (const name of ["playwright-core", "cloakbrowser"]) {
     try { require.resolve(name, { paths: [${JSON.stringify(ROOT)}] }); }
     catch { console.log(name); }
   }`,
], { encoding: "utf8" });
const needInstall = (missing.stdout || "").trim().length > 0;

if (needInstall) {
  info("Chua du thu vien — dang cai dat (lan dau, ~1 phut)...");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: ROOT, stdio: "inherit", shell: true,
  });
  if (r.status !== 0) fail("npm install that bai.", "Kiem tra ket noi mang roi chay lai.");
} else {
  info("OK — da du thu vien.");
}

// ---------------------------------------------------------------- chromium

step(2, "Kiem tra trinh duyet Chromium");
let hasFallback = false;
try {
  const cfg = JSON.parse(require("fs").readFileSync(path.join(ROOT, "storefront-sim.config.json"), "utf8"));
  hasFallback = !!(cfg.browser && cfg.browser.allowFallbackBrowser);
} catch { /* no config = normal path */ }

const cloakCheck = spawnSync(NODE, ["-e", `
  const { createRequire } = require("module");
  const req = createRequire(${JSON.stringify(path.join(ROOT, "package.json"))});
  req("cloakbrowser")
    .then((m) => {
      const i = m.binaryInfo();
      console.log(i.installed ? "installed" : "missing:" + (i.downloadUrl || ""));
    })
    .catch(() => console.log("module-missing"));
`], { cwd: ROOT, encoding: "utf8" });
const cloakStatus = (cloakCheck.stdout || "").trim();

if (cloakStatus === "installed") {
  info("OK — Chromium cua CloakBrowser da san sang.");
} else if (hasFallback) {
  info("Bo qua — config dung Chrome/Edge co san (allowFallbackBrowser).");
} else {
  info("Dang tai Chromium cua CloakBrowser (~1GB, CHI LAN DAU)...");
  console.log("        Uong nuoc di choi mot luc, lan sau khong phai tai lai.\n");
  const r = spawnSync("npx", ["cloakbrowser", "install"], {
    cwd: ROOT, stdio: "inherit", shell: true,
  });
  if (r.status !== 0) {
    fail(
      "Tai Chromium khong thanh cong.",
      "Cach nhanh: mo storefront-sim.config.json, them vao phan \"browser\":\n         \"allowFallbackBrowser\": true\n       de dung Chrome/Edge tren may (khong can tai).",
    );
  }
}

// ---------------------------------------------------------------- launch

step(3, "Khoi dong dashboard");
const port = process.env.PORT || "7317";

info(`Dashboard se chay tai:  http://127.0.0.1:${port}`);
info("Dang mo trinh duyet... neu khong tu mo, copy dia chi tren vao browser.\n");
console.log("=".repeat(58));
console.log("  DE DUNG LAI: bam Ctrl+C trong cua so nay (hoac dong cua so)");
console.log("=".repeat(58) + "\n");

// Open the default browser once the server answers.
const probe = spawn(NODE, [
  "-e", `
  const http = require("http");
  const url = "http://127.0.0.1:${port}/api/meta";
  const started = Date.now();
  const timer = setInterval(() => {
    http.get(url, (res) => {
      clearInterval(timer);
      res.resume();
      const open = process.platform === "win32" ? "start"
        : process.platform === "darwin" ? "open" : "xdg-open";
      require("child_process").spawn(open, [url], { shell: true, detached: true, stdio: "ignore" }).unref();
      process.exit(0);
    }).on("error", () => {
      if (Date.now() - started > 60000) { clearInterval(timer); process.exit(1); }
    });
  }, 700);
`, ], { cwd: ROOT, detached: true, stdio: "ignore" });
probe.unref();

const dash = spawn(NODE, ["dist/cli.js", "dashboard", "--host", "127.0.0.1", "--port", port], {
  cwd: ROOT, stdio: "inherit",
});
dash.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    console.error(`\nDashboard ket thuc voi ma loi ${code}.`);
    spawnSync(process.platform === "win32" ? "cmd.exe" : "bash",
      process.platform === "win32" ? ["/c", "pause"] : ["-c", "sleep 30"],
      { stdio: "inherit" });
  }
});
