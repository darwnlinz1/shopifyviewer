/**
 * test/experiments/benchmark-memory.mjs
 *
 * Empirical benchmark testing:
 *  1. Performance metrics with Performance.enable
 *  2. JavaScript Heap + DOM node reclamation via about:blank navigation
 */
import { chromium } from "playwright-core";
import { findSystemChrome } from "../../dist/browser/chrome.js";

async function measureMemory() {
  console.log("=== EMPIRICAL BENCHMARK: TAB HIBERNATION & MEMORY RECLAMATION ===");
  const execPath = findSystemChrome();
  if (!execPath) {
    console.error("No Chrome found.");
    process.exit(1);
  }

  const browser = await chromium.launch({
    executablePath: execPath,
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--js-flags=--max-old-space-size=256",
    ],
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  const getMetrics = async () => {
    try {
      const perf = await cdp.send("Performance.getMetrics");
      const jsHeap = perf.metrics.find((m) => m.name === "JSHeapUsedSize")?.value || 0;
      const totalHeap = perf.metrics.find((m) => m.name === "JSHeapTotalSize")?.value || 0;
      const nodes = perf.metrics.find((m) => m.name === "Nodes")?.value || 0;
      const docs = perf.metrics.find((m) => m.name === "Documents")?.value || 0;
      const listeners = perf.metrics.find((m) => m.name === "JSEventListeners")?.value || 0;
      return {
        jsHeapMB: (jsHeap / (1024 * 1024)).toFixed(2),
        totalHeapMB: (totalHeap / (1024 * 1024)).toFixed(2),
        nodes,
        docs,
        listeners,
      };
    } catch (e) {
      return { jsHeapMB: "0", totalHeapMB: "0", nodes: 0, docs: 0, listeners: 0 };
    }
  };

  // 1. Initial baseline
  await page.goto("about:blank");
  await page.waitForTimeout(300);
  const baseline = await getMetrics();
  console.log(`[1. Baseline about:blank] Used Heap: ${baseline.jsHeapMB} MB | Total Heap: ${baseline.totalHeapMB} MB | DOM Nodes: ${baseline.nodes} | Listeners: ${baseline.listeners}`);

  // 2. Heavy eCommerce Page Simulation (5,000 DOM nodes + complex objects + event listeners)
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head><title>Shopify Heavy Storefront</title></head>
      <body>
        <div id="grid"></div>
        <script>
          window.mockAnalyticsData = [];
          for (let i = 0; i < 50000; i++) {
            window.mockAnalyticsData.push({ id: i, payload: "heavy_session_event_tracking_" + i });
          }
          const container = document.getElementById('grid');
          for (let i = 0; i < 3000; i++) {
            const el = document.createElement('div');
            el.className = 'product-card';
            el.innerHTML = '<div class="thumb">Image ' + i + '</div><h3>Product Title #' + i + '</h3><span class="price">$149.99</span><button class="atc">Add to Cart</button>';
            el.querySelector('.atc').addEventListener('click', () => console.log('clicked ' + i));
            container.appendChild(el);
          }
        </script>
      </body>
    </html>
  `);
  await page.waitForTimeout(800);
  const loaded = await getMetrics();
  console.log(`[2. Active Storefront Loaded] Used Heap: ${loaded.jsHeapMB} MB | Total Heap: ${loaded.totalHeapMB} MB | DOM Nodes: ${loaded.nodes} | Listeners: ${loaded.listeners}`);

  // 3. Hibernation to about:blank
  await page.goto("about:blank");
  await page.waitForTimeout(500);
  try {
    await cdp.send("HeapProfiler.collectGarbage");
  } catch {}
  await page.waitForTimeout(300);

  const hibernated = await getMetrics();
  console.log(`[3. Post-Hibernation about:blank] Used Heap: ${hibernated.jsHeapMB} MB | Total Heap: ${hibernated.totalHeapMB} MB | DOM Nodes: ${hibernated.nodes} | Listeners: ${hibernated.listeners}`);

  const usedSavedMB = (parseFloat(loaded.jsHeapMB) - parseFloat(hibernated.jsHeapMB)).toFixed(2);
  const percentSaved = (((parseFloat(loaded.jsHeapMB) - parseFloat(hibernated.jsHeapMB)) / parseFloat(loaded.jsHeapMB)) * 100).toFixed(1);
  const nodesFreed = loaded.nodes - hibernated.nodes;

  console.log("--------------------------------------------------");
  console.log(`=> EMPIRICAL RESULT:`);
  console.log(`   - JS Heap Reclaimed: ${usedSavedMB} MB (${percentSaved}% memory reduction)`);
  console.log(`   - DOM Nodes Purged: ${nodesFreed} nodes (${((nodesFreed / loaded.nodes) * 100).toFixed(1)}% purged)`);
  console.log(`   - Event Listeners Removed: ${loaded.listeners - hibernated.listeners} listeners`);
  console.log("--------------------------------------------------");

  await browser.close();
}

measureMemory().catch(console.error);
