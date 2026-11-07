/**
 * Automated downloader & setup for Ungoogled-Chromium Portable (Windows x64).
 *
 * Downloads the official Windows 64-bit portable release and extracts it into
 * `./bin/ungoogled-chromium/chrome.exe`.
 */
import { existsSync, mkdirSync, rmSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const BIN_DIR = resolve(process.cwd(), "bin");
const TARGET_DIR = join(BIN_DIR, "ungoogled-chromium");
const TARGET_EXE = join(TARGET_DIR, "chrome.exe");

if (existsSync(TARGET_EXE)) {
  console.log(`[OK] Ungoogled-Chromium da co san tai: ${TARGET_EXE}`);
  process.exit(0);
}

mkdirSync(BIN_DIR, { recursive: true });

console.log("[1/4] Dang tim phien ban Ungoogled-Chromium Windows x64 moi nhat...");

let downloadUrl = "";
let zipFileName = "ungoogled-chromium-windows-x64.zip";

try {
  const resp = await fetch("https://api.github.com/repos/ungoogled-software/ungoogled-chromium-windows/releases/latest", {
    headers: { "User-Agent": "SiteViewer-Setup" },
  });
  if (resp.ok) {
    const data = await resp.json();
    const asset = data.assets?.find((a) => a.name && a.name.endsWith("_windows_x64.zip"));
    if (asset && asset.browser_download_url) {
      downloadUrl = asset.browser_download_url;
      zipFileName = asset.name;
    }
  }
} catch (e) {
  console.warn("Khong the query GitHub API, su dung link fallback...", e.message);
}

if (!downloadUrl) {
  // Fallback to known stable release
  downloadUrl = "https://github.com/ungoogled-software/ungoogled-chromium-windows/releases/download/151.0.7922.173-1.1/ungoogled-chromium_151.0.7922.173-1.1_windows_x64.zip";
}

console.log(`[2/4] Dang tai: ${downloadUrl}`);
const zipPath = join(BIN_DIR, zipFileName);

// Use PowerShell WebClient to download cleanly
try {
  execSync(`powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('${downloadUrl}', '${zipPath}')"`, {
    stdio: "inherit",
  });
} catch (err) {
  console.error("Loi khi tai file zip:", err.message);
  process.exit(1);
}

console.log("[3/4] Dang giai nen Ungoogled-Chromium Portable...");
const tempExtract = join(BIN_DIR, "temp_extract");
rmSync(tempExtract, { recursive: true, force: true });
mkdirSync(tempExtract, { recursive: true });

try {
  execSync(`powershell -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tempExtract}' -Force"`, {
    stdio: "inherit",
  });
} catch (err) {
  console.error("Loi khi giai nen zip:", err.message);
  process.exit(1);
}

// Find the extracted folder (usually ungoogled-chromium_...)
const extractedEntries = readdirSync(tempExtract);
const innerFolder = extractedEntries.find((f) => existsSync(join(tempExtract, f, "chrome.exe")));

rmSync(TARGET_DIR, { recursive: true, force: true });

if (innerFolder) {
  renameSync(join(tempExtract, innerFolder), TARGET_DIR);
} else if (existsSync(join(tempExtract, "chrome.exe"))) {
  renameSync(tempExtract, TARGET_DIR);
} else {
  console.error("Khong tim thay chrome.exe ben trong goi zip da giai nen!");
  process.exit(1);
}

// Clean up temporary files
rmSync(tempExtract, { recursive: true, force: true });
rmSync(zipPath, { force: true });

if (existsSync(TARGET_EXE)) {
  console.log(`\n========================================================`);
  console.log(`[THANH CONG] Ungoogled-Chromium da san sang tai:\n${TARGET_EXE}`);
  console.log(`========================================================\n`);
} else {
  console.error("[THAT BAI] Khong tim thay chrome.exe sau khi cai dat.");
  process.exit(1);
}
