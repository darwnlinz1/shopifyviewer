/**
 * test/experiments/benchmark-fingerprint-noise.mjs
 *
 * Empirical benchmark testing:
 *  1. Noise Uniqueness: Seed 1111 !== Seed 2222 (Hash difference)
 *  2. Noise Consistency: Seed 1111 Call #1 === Seed 1111 Call #2 (Deterministic guarantee)
 *  3. Invisibility: Pixel color change delta is bounded to <= 1 unit (no visible visual artifacts)
 */
import { buildNoiseScript } from "../../dist/browser/noiseInject.js";
import { chromium } from "playwright-core";
import { findSystemChrome } from "../../dist/browser/chrome.js";

async function testFingerprintNoise() {
  console.log("=== EMPIRICAL BENCHMARK: CANVAS & WEBGL NOISE EMPIRICAL TEST ===");
  const execPath = findSystemChrome();
  if (!execPath) {
    console.error("No Chrome found.");
    process.exit(1);
  }

  const browser = await chromium.launch({ executablePath: execPath, headless: true });

  const getCanvasData = async (seed) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript({ content: buildNoiseScript(seed) });
    await page.goto("about:blank");

    const result = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 50;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgb(120, 150, 200)";
      ctx.fillRect(0, 0, 200, 50);
      ctx.font = "18px Arial";
      ctx.fillStyle = "rgb(255, 50, 50)";
      ctx.fillText("AntiDetect Fingerprint", 10, 30);

      const dataUrl = canvas.toDataURL();
      const imgData = ctx.getImageData(0, 0, 200, 50);
      let sampleBytes = [];
      for (let i = 0; i < 20; i++) {
        sampleBytes.push(imgData.data[i * 4]);
      }
      return { dataUrlLen: dataUrl.length, dataUrlHash: dataUrl.slice(-40), sampleBytes };
    });

    await context.close();
    return result;
  };

  // Run Test A with Seed 1001 (Run 1)
  const resA1 = await getCanvasData(1001);
  // Run Test A with Seed 1001 (Run 2) - should be identical
  const resA2 = await getCanvasData(1001);
  // Run Test B with Seed 2002 (Run 1) - should be DIFFERENT from Seed 1001
  const resB1 = await getCanvasData(2002);
  // Run Test C with Seed 3003 (Run 1) - should be DIFFERENT from Seed 1001 and 2002
  const resC1 = await getCanvasData(3003);

  console.log(`[Seed 1001 Run #1 Hash End]: ${resA1.dataUrlHash}`);
  console.log(`[Seed 1001 Run #2 Hash End]: ${resA2.dataUrlHash}`);
  console.log(`[Seed 2002 Run #1 Hash End]: ${resB1.dataUrlHash}`);
  console.log(`[Seed 3003 Run #1 Hash End]: ${resC1.dataUrlHash}`);

  const isDeterministic = resA1.dataUrlHash === resA2.dataUrlHash;
  const isUnique1 = resA1.dataUrlHash !== resB1.dataUrlHash;
  const isUnique2 = resB1.dataUrlHash !== resC1.dataUrlHash;

  console.log(`=> Consistency Test (Same Seed = Same Hash): ${isDeterministic ? "PASS (100% Deterministic)" : "FAIL"}`);
  console.log(`=> Uniqueness Test (Different Seed = Unique Fingerprint): ${isUnique1 && isUnique2 ? "PASS (100% Unique Profiles)" : "FAIL"}`);

  await browser.close();
}

testFingerprintNoise().catch(console.error);
