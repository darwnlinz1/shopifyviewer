import http from "node:http";
import { Orchestrator } from "../dist/server/orchestrator.js";
import { loadConfig, DEFAULT_CONFIG } from "../dist/config.js";
import { sleep } from "../dist/util/random.js";

let atcRequestsReceived = 0;
let cartState = { item_count: 0 };

const STOREFRONT_PORT = 9124;
const STOREFRONT_URL = `http://127.0.0.1:${STOREFRONT_PORT}`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, STOREFRONT_URL);
  const path = url.pathname;
  console.log(`[HTTP INCOMING] ${req.method} ${path}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (path === "/cart/add.js" || path === "/cart/add") {
    atcRequestsReceived++;
    cartState.item_count++;
    console.log(`\n🎉 [STOREFRONT API] POST /cart/add.js SUCCESS (Total: ${atcRequestsReceived})\n`);
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
  console.log(`[TEST-SERVER] Storefront online at ${STOREFRONT_URL}`);

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
      pageEngagementMs: { min: 500, max: 1000 },
    },
    logging: {
      dir: "./logs",
      level: "debug",
      jsonl: true,
      console: true,
    }
  });

  const orchestrator = new Orchestrator(config);
  const prof = orchestrator.store.create({
    name: "Debug_Shopper",
    storefront: STOREFRONT_URL,
    durationMinutes: 0.5,
    atcMinutes: 0.05, // 3s
  });

  console.log(`[TEST] Starting profile ${prof.id}...`);
  await orchestrator.startProfile(prof.id);

  for (let s = 1; s <= 20; s++) {
    await sleep(1000);
    const snap = orchestrator.snapshot().find(x => x.profile.id === prof.id);
    console.log(`[T+${s}s] Status: ${snap?.session?.status} | URL: ${snap?.session?.url} | Action: ${snap?.session?.lastAction} | Reason: ${snap?.session?.lastReason} | ATC Done: ${snap?.session?.atcVerified}`);
    if (snap?.session?.atcVerified) {
      console.log(`\n🎉 ATC COMPLETED!`);
      break;
    }
  }

  await orchestrator.closeSession(prof.id).catch(() => {});
  try { orchestrator.store.remove(prof.id); } catch {}
  server.close();
  process.exit(0);
});
