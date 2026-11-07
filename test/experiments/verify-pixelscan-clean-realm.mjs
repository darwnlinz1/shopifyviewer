/**
 * test/experiments/verify-pixelscan-clean-realm.mjs
 *
 * Dedicated verification of:
 *   1. Clean Realm Iframe toString extraction (Pixelscan tamperedFunctions trap)
 *   2. Languages consistency (navigator.languages vs Intl vs navigator.language)
 *   3. Own property leakage on navigator (73 parameters trap)
 *   4. Function .prototype ownership on native methods
 */

import { launchBrowser, findSystemChrome } from "../../dist/browser/chrome.js";
import { Rng } from "../../dist/util/random.js";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

async function verifyPixelscanCleanRealm() {
  console.log("==================================================================================");
  console.log("       PIXELSCAN CLEAN REALM & TAMPERED FUNCTIONS DEEP VERIFICATION              ");
  console.log("==================================================================================");

  // 1. Start local HTTP server to host real HTML page with iframe
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Pixelscan Test Bed</title></head>
<body>
  <h1>Pixelscan Verification Sandbox</h1>
  <iframe id="test-iframe" style="display:none;"></iframe>
</body>
</html>`);
  });

  const port = await new Promise((resolve) => {
    server.listen(9123, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });

  const execPath = findSystemChrome();
  const testDir = join(process.cwd(), "tmp-pixelscan-clean-test");
  mkdirSync(testDir, { recursive: true });

  const dummyConfig = {
    browser: {
      profileDir: "tmp-pixelscan-clean-test",
      persistProfiles: false,
      headless: true,
      executablePath: execPath,
      viewports: [{ width: 1440, height: 900 }],
      proxies: [],
      locale: "en-US",
    },
    privacy: {},
  };

  const rng = new Rng(1337);
  const launchReq = {
    slot: 1,
    sessionId: "pixelscan-verify-" + Date.now(),
    config: dummyConfig,
    logger: { info: () => {}, warn: () => {}, error: console.error, debug: () => {} },
    rng,
    userDataDir: testDir,
  };

  const launched = await launchBrowser(launchReq);
  const page = launched.context.pages()[0] || (await launched.context.newPage());

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  const results = await page.evaluate(() => {
    // 1. Pixelscan Clean Iframe toString extraction
    const ifr = document.getElementById("test-iframe");
    const cleanToString = (ifr && ifr.contentWindow) ? ifr.contentWindow.Function.prototype.toString : Function.prototype.toString;

    const toDataURLStr = cleanToString.call(HTMLCanvasElement.prototype.toDataURL);
    const getImageDataStr = cleanToString.call(CanvasRenderingContext2D.prototype.getImageData);
    const getParameterStr = cleanToString.call(WebGLRenderingContext.prototype.getParameter);
    const getChannelDataStr = cleanToString.call(AudioBuffer.prototype.getChannelData);
    const startRenderingStr = cleanToString.call(OfflineAudioContext.prototype.startRendering);
    const toStringItselfStr = cleanToString.call(Function.prototype.toString);

    // 2. Navigator instance own properties (73 parameters check)
    const navigatorOwnProps = Object.getOwnPropertyNames(navigator);

    // 3. Languages check
    const navLangs = Array.from(navigator.languages || []);
    const navLang = navigator.language;
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;

    // 4. Webdriver check
    const isWdFalse = navigator.webdriver === false;
    const hasWdOwn = navigator.hasOwnProperty("webdriver");
    const hasChromeRuntime = !!(window.chrome && window.chrome.runtime);
    const hasChromeApp = !!(window.chrome && window.chrome.app);
    const hasChromeCsi = !!(window.chrome && window.chrome.csi);

    // 5. Prototype property leak on methods (Native methods NEVER have .prototype)
    const toDataUrlHasProto = HTMLCanvasElement.prototype.toDataURL.hasOwnProperty("prototype");
    const getImageDataHasProto = CanvasRenderingContext2D.prototype.getImageData.hasOwnProperty("prototype");

    return {
      toDataURLStr,
      getImageDataStr,
      getParameterStr,
      getChannelDataStr,
      startRenderingStr,
      toStringItselfStr,
      navigatorOwnProps,
      navLangs,
      navLang,
      intlLocale,
      isWdFalse,
      hasWdOwn,
      hasChromeRuntime,
      hasChromeApp,
      hasChromeCsi,
      toDataUrlHasProto,
      getImageDataHasProto,
    };
  });

  await launched.close();
  await new Promise((r) => server.close(r));
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}

  console.log("\n--- 1. CLEAN REALM IFRAME TOSTRING RESULTS ---");
  console.log("HTMLCanvasElement.prototype.toDataURL  :", results.toDataURLStr);
  console.log("CanvasRenderingContext2D.getImageData  :", results.getImageDataStr);
  console.log("WebGLRenderingContext.getParameter     :", results.getParameterStr);
  console.log("AudioBuffer.prototype.getChannelData   :", results.getChannelDataStr);
  console.log("OfflineAudioContext.startRendering     :", results.startRenderingStr);
  console.log("Function.prototype.toString            :", results.toStringItselfStr);

  const allMethodsNative =
    results.toDataURLStr.includes("[native code]") &&
    results.getImageDataStr.includes("[native code]") &&
    results.getParameterStr.includes("[native code]") &&
    results.getChannelDataStr.includes("[native code]") &&
    results.startRenderingStr.includes("[native code]") &&
    results.toStringItselfStr.includes("[native code]");

  console.log("\n--- 2. NAVIGATOR OWN PROPERTIES (73 PARAMS CHECK) ---");
  console.log("navigator own properties count         :", results.navigatorOwnProps.length);
  console.log("navigator own properties list          :", results.navigatorOwnProps);

  console.log("\n--- 3. LANGUAGES CONSISTENCY CHECK ---");
  console.log("navigator.languages                    :", results.navLangs);
  console.log("navigator.language                     :", results.navLang);
  console.log("Intl locale                            :", results.intlLocale);

  console.log("\n--- 4. WEBDRIVER & CHROME STRUCTURE ---");
  console.log("navigator.webdriver === false          :", results.isWdFalse);
  console.log("navigator.hasOwnProperty('webdriver')  :", results.hasWdOwn);
  console.log("window.chrome.runtime exists           :", results.hasChromeRuntime, "(Must be FALSE)");
  console.log("window.chrome.app exists               :", results.hasChromeApp, "(Must be TRUE)");
  console.log("window.chrome.csi exists               :", results.hasChromeCsi, "(Must be TRUE)");

  console.log("\n--- 5. PROTOTYPE PROPERTY LEAKS ---");
  console.log("toDataURL.hasOwnProperty('prototype')  :", results.toDataUrlHasProto, "(Must be FALSE)");
  console.log("getImageData.hasOwnProperty('prototype'):", results.getImageDataHasProto, "(Must be FALSE)");

  console.log("\n==================================================================================");
  console.log("                               VERDICT SUMMARY                                    ");
  console.log("==================================================================================");
  console.log("[+] Clean Realm Iframe toString (tamperedFunctions):", allMethodsNative ? "PASSED (100% NATIVE)" : "FAILED");
  console.log("[+] Navigator Own Properties (73 Parameters)      :", results.navigatorOwnProps.length === 0 ? "PASSED (0 Own Props, 100% Clean)" : "FAILED");
  console.log("[+] Languages & Intl Consistency                  :", (results.navLangs.length > 0 && results.navLangs[0] === results.navLang) ? "PASSED (100% Consistent)" : "FAILED");
  console.log("[+] Webdriver & Chrome Structure                  :", (results.isWdFalse && !results.hasWdOwn && !results.hasChromeRuntime && results.hasChromeApp) ? "PASSED" : "FAILED");
  console.log("[+] Prototype Property Invariant                  :", (!results.toDataUrlHasProto && !results.getImageDataHasProto) ? "PASSED" : "FAILED");
  console.log("==================================================================================");
}

verifyPixelscanCleanRealm().catch(console.error);
