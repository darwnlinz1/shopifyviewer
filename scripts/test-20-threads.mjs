import http from "node:http";
import os from "node:os";
import { Orchestrator } from "../dist/server/orchestrator.js";
import { loadConfig, DEFAULT_CONFIG } from "../dist/config.js";
import { sleep } from "../dist/util/random.js";

let atcRequestsReceived = 0;
let cartState = { item_count: 0 };

const STOREFRONT_PORT = 9125;
const STOREFRONT_URL = `http://127.0.0.1:${STOREFRONT_PORT}`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, STOREFRONT_URL);
  const path = url.pathname;
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (path === "/cart/add.js" || path === "/cart/add") {
    atcRequestsReceived++;
    cartState.item_count++;
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ id: 41001, title: "Classic Cotton Tee", quantity: 1, item_count: cartState.item_count }));
    return;
  }

  if (path === "/cart.js") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ item_count: cartState.item_count, total_price: 2500, items: [] }));
    return;
  }

  if (path.startsWith("/products/classic-cotton-tee")) {
    res.writeHead(200);
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Classic Cotton Tee – Test Shopify Store</title>
        <meta property="og:type" content="product">
      </head>
      <body>
        <h1>Classic Cotton Tee</h1>
        <p>Premium everyday wear 100% organic cotton t-shirt with modern styling and comfort fit.</p>
        <div class="price">$25.00</div>

        <variant-radios>
          <fieldset class="product-form__input">
            <legend>Size</legend>
            <input type="radio" id="opt-s" name="Size" value="S" class="disabled" disabled>
            <label for="opt-s" class="sold-out">S (Sold Out)</label>

            <input type="radio" id="opt-m" name="Size" value="M" checked>
            <label for="opt-m">M</label>

            <input type="radio" id="opt-l" name="Size" value="L">
            <label for="opt-l">L</label>
          </fieldset>
        </variant-radios>

        <product-form class="product-form">
          <form method="post" action="/cart/add" id="AddToCartForm">
            <input type="hidden" name="id" value="41001">
            <button type="submit" name="add" id="AddToCart" class="product-form__submit btn-add-to-cart">
              <span>Add to cart</span>
            </button>
          </form>
        </product-form>

        <cart-drawer id="CartDrawer" class="cart-drawer" style="display:none;">
          <div class="cart-drawer__inner">Item added!</div>
        </cart-drawer>

        <script>
          document.getElementById("AddToCartForm").addEventListener("submit", function(e) {
            e.preventDefault();
            fetch("/cart/add.js", { method: "POST" }).then(function() {
              document.getElementById("CartDrawer").style.display = "block";
            });
          });
        </script>
      </body>
      </html>
    `);
    return;
  }

  if (path.startsWith("/collections")) {
    res.writeHead(200);
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Summer Collection – Test Shopify Store</title></head>
      <body>
        <h1>Summer Collection</h1>
        <p>Discover our summer season arrivals with great deals and fresh designs.</p>
        <div class="product-grid">
          <div class="card">
            <a href="/products/classic-cotton-tee">Classic Cotton Tee - $25</a>
          </div>
        </div>
      </body>
      </html>
    `);
    return;
  }

  res.writeHead(200);
  res.end(`
    <!DOCTYPE html>
    <html>
    <head><title>Test Shopify Storefront</title></head>
    <body>
      <h1>Welcome to Premium Apparel</h1>
      <p>Discover high quality clothing and accessories curated for modern lifestyles.</p>
      <nav>
        <a href="/collections/summer-collection">Summer Collection</a>
        <a href="/products/classic-cotton-tee">Featured: Classic Cotton Tee</a>
      </nav>
    </body>
    </html>
  `);
});

server.listen(STOREFRONT_PORT, async () => {
  console.log(`[TEST-SERVER] Mock Storefront listening on ${STOREFRONT_URL}`);

  const NUM_PROFILES = 20;
  const config = loadConfig(undefined, {
    storefront: STOREFRONT_URL,
    browser: {
      ...DEFAULT_CONFIG.browser,
      headless: true,
      profileDir: "./tempprofolio",
    },
    safety: {
      ...DEFAULT_CONFIG.safety,
      allowCart: true,
      allowedHosts: ["127.0.0.1", "localhost", `127.0.0.1:${STOREFRONT_PORT}`],
    },
    behavior: {
      ...DEFAULT_CONFIG.behavior,
      pageEngagementMs: { min: 800, max: 1500 },
    },
  });

  const orchestrator = new Orchestrator(config);
  const createdProfiles = [];

  for (let i = 1; i <= NUM_PROFILES; i++) {
    const prof = orchestrator.store.create({
      name: `Shopper_${i}`,
      storefront: STOREFRONT_URL,
      durationMinutes: 0.8, // 48s duration
      notes: "test_20",
    });
    createdProfiles.push(prof);
  }

  let initialCpu = os.cpus();
  function getCpuUsage() {
    const currentCpu = os.cpus();
    let user = 0, sys = 0, idle = 0;
    for (let i = 0; i < currentCpu.length; i++) {
      const prev = initialCpu[i].times;
      const curr = currentCpu[i].times;
      user += curr.user - prev.user;
      sys += curr.sys - prev.sys;
      idle += curr.idle - prev.idle;
    }
    initialCpu = currentCpu;
    const total = user + sys + idle;
    return total > 0 ? Math.round(((user + sys) / total) * 100) : 0;
  }

  console.log(`[BENCHMARK] Launching ${NUM_PROFILES} profiles...`);
  await Promise.all(createdProfiles.map(p => orchestrator.startProfile(p.id)));

  console.log(`\n========================================================================================`);
  console.log(`TIME (s) | ACTIVE / TOTAL | SYSTEM CPU (%) | RSS MEM (MB) | ATC CALLS | ATC CONFIRMED`);
  console.log(`========================================================================================`);

  for (let s = 2; s <= 45; s += 2) {
    await sleep(2000);
    const snap = orchestrator.snapshot();
    const memUsage = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const cpu = getCpuUsage();
    const running = snap.filter(x => x.session && x.session.status === "running").length;
    const atcDone = snap.filter(x => x.session && x.session.atcVerified).length;

    console.log(
      `  ${s.toString().padStart(4)}s  | ` +
      `   ${running.toString().padStart(2)} / ${NUM_PROFILES}   | ` +
      `     ${cpu.toString().padStart(3)}%     | ` +
      `   ${memUsage.toString().padStart(5)} MB   | ` +
      `    ${atcRequestsReceived.toString().padStart(3)}    | ` +
      `      ${atcDone.toString().padStart(2)} / ${NUM_PROFILES}`
    );

    if (atcDone === NUM_PROFILES && atcRequestsReceived >= NUM_PROFILES) {
      console.log(`\n🎯 ALL 20 PROFILES COMPLETED ATC VERIFICATION!`);
      break;
    }
  }

  const finalSnap = orchestrator.snapshot();
  const totalVerified = finalSnap.filter(s => s.session && s.session.atcVerified).length;

  console.log(`========================================================================================`);
  console.log(`[FINAL BENCHMARK RESULT]`);
  console.log(`- Profiles Launched: ${NUM_PROFILES}`);
  console.log(`- Total Add-To-Cart HTTP Requests: ${atcRequestsReceived}`);
  console.log(`- Total Profiles with Verified ATC: ${totalVerified} / ${NUM_PROFILES}`);
  console.log(`========================================================================================\n`);

  for (const p of createdProfiles) {
    await orchestrator.closeSession(p.id).catch(() => {});
    try { orchestrator.store.remove(p.id); } catch {}
  }
  server.close();
  process.exit(0);
});
