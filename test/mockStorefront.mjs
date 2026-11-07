/**
 * Minimal mock Shopify storefront used to exercise the simulator end to end
 * without touching a real shop. Mirrors Dawn's markup closely enough that the
 * built-in selector candidates resolve: /, /collections/<h>, /products/<h>.
 *
 * Product pages carry what a real theme ships and what the detection tiers
 * read: a two-column buy box, option radios with the theme's variant JSON
 * (some combinations sold out), JSON-LD offers, the inline ShopifyAnalytics
 * meta, `/products/<h>.js`, and the usual decoys — a Shop Pay "buy now"
 * button, a sticky add-to-cart bar, a hidden mobile duplicate and quick-add
 * buttons in the recommendation cards. The cart is real too: `/cart/add`,
 * `/cart/add.js`, `/cart.js`, a `/cart` page, a header badge and a drawer.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const COLLECTIONS = [
  { handle: "soins-visage", title: "Soins Visage" },
  { handle: "maquillage", title: "Maquillage" },
  { handle: "all", title: "Tous les produits" },
];

const SIZES = ["30ml", "50ml", "100ml"];
const COLORS = ["Rose", "Noir"];

const PRODUCTS = Array.from({ length: 12 }, (_, i) => {
  const variants = [];
  let k = 0;
  for (const size of SIZES) {
    for (const color of COLORS) {
      // produit-12 is sold out entirely; elsewhere every fourth combination is.
      const available = i === 11 ? false : (i + k) % 4 !== 3;
      variants.push({ id: 1000 + i * 10 + k, title: `${size} / ${color}`, option1: size, option2: color, available, price: (12 + i * 3) * 100 });
      k++;
    }
  }
  return {
    id: 500 + i,
    handle: `produit-${i + 1}`,
    title: `Produit ${i + 1}`,
    price: `${(12 + i * 3).toFixed(2)} €`,
    collection: COLLECTIONS[i % 2].handle,
    variants,
    // produit-2 ships no variant JSON in the page; its stock comes from /products/<h>.js.
    embedJson: i !== 1,
  };
});

const euros = (cents) => `${(cents / 100).toFixed(2)} €`;

const carts = new Map();
function cartFor(req, res) {
  const token = /(?:^|;\s*)cart=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  if (token && carts.has(token)) return carts.get(token);
  const fresh = { token: token ?? randomUUID(), items: [] };
  carts.set(fresh.token, fresh);
  res.setHeader("set-cookie", `cart=${fresh.token}; Path=/; SameSite=Lax`);
  return fresh;
}
const itemCount = (cart) => cart.items.reduce((n, l) => n + l.quantity, 0);
const cartJson = (cart) => ({
  token: cart.token,
  item_count: itemCount(cart),
  total_price: cart.items.reduce((n, l) => n + l.price * l.quantity, 0),
  items: cart.items,
});

const shopifyGlobals = (pageType) => `
<script>
  window.Shopify = { shop: "mock.myshopify.com", locale: "fr" };
  window.ShopifyAnalytics = { meta: { page: { pageType: ${JSON.stringify(pageType)} } } };
  window.__st = { p: ${JSON.stringify(pageType)} };
</script>`;

/** A collapsed mega-menu holding hundreds of product links ahead of the page content. */
const megaMenu = () => `
  <div class="mega-menu" style="display:none">
    ${Array.from({ length: 450 }, (_, i) => PRODUCTS[i % PRODUCTS.length]).map((p, i) => `<a class="mega-menu__link" href="/products/${p.handle}?m=${i}">${p.title}</a>`).join("")}
  </div>`;

const header = (count, mega = false) => `
<header class="header">
  <nav class="header__inline-menu">
    <a href="/" class="header__menu-item">Accueil</a>
    ${COLLECTIONS.map((c) => `<a class="header__menu-item" href="/collections/${c.handle}">${c.title}</a>`).join("\n")}
  </nav>${mega ? megaMenu() : ""}
  <a href="/cart" id="cart-icon-bubble" class="header__icon header__icon--cart" aria-label="Panier">Panier <span class="cart-count-bubble">${count}</span></a>
</header>`;

const cartDrawer = () => `
<cart-drawer class="drawer" style="display:none">
  <div class="drawer__inner" role="dialog" aria-modal="true" aria-label="Votre panier">
    <button type="button" class="drawer__close" aria-label="Fermer le panier">×</button>
    <h2 class="drawer__heading">Votre panier</h2>
    <div class="cart-drawer__items"></div>
    <div class="totals"><span>Sous-total</span> <span class="totals__subtotal-value">0.00 €</span></div>
    <button type="button" name="checkout" class="cart__checkout-button">Paiement</button>
  </div>
</cart-drawer>`;

const productCard = (p, { quickAdd = false } = {}) => `
<div class="grid__item">
  <div class="card-wrapper product-card-wrapper">
    <div class="card__media"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%23eee'/%3E%3C/svg%3E" alt="${p.title}" width="300" height="300"></div>
    <div class="card__content">
      <h3 class="card__heading"><a class="full-unstyled-link" href="/products/${p.handle}">${p.title}</a></h3>
      <div class="price"><span class="price-item price-item--regular">${p.price}</span></div>
      ${quickAdd ? `<div class="quick-add"><button type="button" class="quick-add__submit button" style="width:220px;height:44px">Ajouter au panier</button></div>` : ""}
    </div>
  </div>
</div>`;

/** Shopify themes wrap every content block in a .shopify-section element. */
function section(id, inner) {
  return `<section id="shopify-section-${id}" class="shopify-section">${inner}</section>`;
}

const DRAWER_SCRIPT = `
<script>
(() => {
  const drawer = document.querySelector("cart-drawer");
  const bubble = document.querySelector(".cart-count-bubble");
  window.__openCartDrawer = async () => {
    const cart = await (await fetch("/cart.js")).json();
    if (bubble) bubble.textContent = String(cart.item_count);
    drawer.querySelector(".cart-drawer__items").innerHTML = cart.items.map((l) =>
      '<div class="cart-item"><span class="cart-item__name">' + l.product_title + ' — ' + l.variant_title + '</span> <span class="cart-item__qty">x' + l.quantity + '</span></div>').join("");
    drawer.querySelector(".totals__subtotal-value").textContent = (cart.total_price / 100).toFixed(2) + " €";
    drawer.style.display = "block";
    drawer.setAttribute("open", "");
    drawer.classList.add("active");
  };
  drawer?.querySelector(".drawer__close")?.addEventListener("click", () => {
    drawer.style.display = "none";
    drawer.removeAttribute("open");
    drawer.classList.remove("active");
  });
})();
</script>`;

/**
 * A full-viewport layer on top of the page: "overlay" closes on Escape,
 * "overlay-close" only through its own close button (a Klaviyo-style signup
 * modal), "overlay-stuck" not at all.
 */
const countryOverlay = (theme) => `
<div class="country-selector-drawer" style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.35)"><div style="background:#fff;width:320px;margin:120px auto;padding:16px">Choisissez votre pays${theme === "overlay-close" ? ` <button type="button" class="klaviyo-close-form" aria-label="Close dialog" onclick="this.closest('.country-selector-drawer').remove()">×</button>` : ""}</div></div>
${theme === "overlay" ? `<script>addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelector(".country-selector-drawer")?.remove(); });</script>` : ""}`;

/**
 * `theme`: "blocks" splits the product info into sibling blocks, "mega" adds a
 * header mega-menu, "stack" stacks the photos beside a tall sticky info column,
 * "overlay" / "overlay-close" / "overlay-stuck" cover the page with a layer.
 */
function page(title, pageType, body, cartCount = 0, extraHead = "", theme = "") {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${title}</title>
<style>body{font-family:sans-serif;margin:0}main{min-height:2400px;padding:24px}
.header{display:flex;justify-content:space-between;align-items:center;padding:8px 24px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.card-wrapper{border:1px solid #ddd;padding:8px}
.product{display:grid;grid-template-columns:1.2fr 1fr;gap:32px;align-items:start}
.product__media-item{height:420px;background:#f4f4f4;margin-bottom:12px}
.thumbnail-list__item{display:inline-block;margin:4px}
.product__info-wrapper{max-width:520px}
.product-form__submit{display:block;width:100%;max-width:440px;height:46px;font-size:15px}
.shopify-payment-button__button{display:block;width:100%;max-width:440px;height:46px;margin-top:8px}
fieldset{border:0;padding:0;margin:12px 0}
fieldset label{display:inline-block;border:1px solid #999;padding:6px 12px;margin:2px;cursor:pointer}
fieldset input[type=radio]{position:absolute;opacity:0;width:1px;height:1px}
fieldset label.is-disabled{text-decoration:line-through;color:#aaa}
.visually-hidden{position:absolute!important;overflow:hidden;width:1px;height:1px;margin:-1px;padding:0;border:0;clip:rect(0 0 0 0);white-space:nowrap}
.sticky-atc{position:fixed;bottom:0;left:0;right:0;height:64px;background:#fff;border-top:1px solid #ddd;display:flex;align-items:center;justify-content:space-between;padding:0 24px}
.sticky-atc[hidden]{display:none}
cart-drawer{position:fixed;top:0;right:0;bottom:0;width:380px;background:#fff;border-left:1px solid #ccc;padding:16px;z-index:10}
details{margin:8px 0;border-top:1px solid #ddd;padding:8px 0}</style>
${shopifyGlobals(pageType)}${extraHead}</head>
<body>${header(cartCount, theme === "mega")}<main id="MainContent" role="main">${body}</main>${cartDrawer()}${DRAWER_SCRIPT}${theme.startsWith("overlay") ? countryOverlay(theme) : ""}</body></html>`;
}

function productPage(product, cartCount, theme = "") {
  const related = PRODUCTS.filter((p) => p.handle !== product.handle).slice(0, 4);
  const firstAvailable = product.variants.find((v) => v.available) ?? product.variants[0];
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    offers: product.variants.map((v) => ({
      "@type": "Offer",
      name: `${product.title} - ${v.title}`,
      price: (v.price / 100).toFixed(2),
      priceCurrency: "EUR",
      availability: v.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: `/products/${product.handle}?variant=${v.id}`,
    })),
  };
  const meta = {
    product: {
      id: product.id,
      variants: product.variants.map((v) => ({ id: v.id, price: v.price, name: `${product.title} - ${v.title}`, public_title: v.title })),
    },
    page: { pageType: "product" },
  };
  const radios = (name, values, optionKey) => `
    <fieldset class="js product-form__input">
      <legend class="form__label">${name}</legend>
      ${values.map((value) => {
        const checked = firstAvailable[optionKey] === value ? " checked" : "";
        // Like Dawn: the screen-reader text sits in every label, shown or not.
        return `<label class="opt"><input type="radio" name="${name}" value="${value}"${checked}> ${value}<span class="visually-hidden label-unavailable">Variant sold out or unavailable</span></label>`;
      }).join("\n      ")}
    </fieldset>`;
  const head = `
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script>window.ShopifyAnalytics = window.ShopifyAnalytics || {}; window.ShopifyAnalytics.meta = window.ShopifyAnalytics.meta || {};
var meta = ${JSON.stringify(meta)};
for (var attr in meta) { window.ShopifyAnalytics.meta[attr] = meta[attr]; }</script>`;
  const variantScript = `
<script>
(() => {
  const variants = ${JSON.stringify(product.variants)};
  const form = document.getElementById("product-form-main");
  const idInput = form.querySelector('input[name="id"]');
  const button = form.querySelector('button[name="add"]');
  const price = document.querySelector(".product__info-wrapper .price-item");
  const current = () => {
    const size = document.querySelector('input[name="Taille"]:checked')?.value;
    const color = document.querySelector('input[name="Couleur"]:checked')?.value;
    return variants.find((v) => v.option1 === size && v.option2 === color);
  };
  const sync = (fromChange) => {
    const v = current();
    if (!v) return;
    idInput.value = String(v.id);
    button.disabled = !v.available;
    button.textContent = v.available ? "Ajouter au panier" : "Épuisé";
    if (price) price.textContent = (v.price / 100).toFixed(2) + " €";
    if (fromChange) history.replaceState(null, "", location.pathname + "?variant=" + v.id);
    for (const input of document.querySelectorAll('fieldset input[type="radio"]')) {
      const other = input.name === "Taille" ? document.querySelector('input[name="Couleur"]:checked')?.value : document.querySelector('input[name="Taille"]:checked')?.value;
      const combo = variants.find((x) => (input.name === "Taille" ? x.option1 === input.value && x.option2 === other : x.option2 === input.value && x.option1 === other));
      input.closest("label").classList.toggle("is-disabled", !!combo && !combo.available);
    }
  };
  document.addEventListener("change", (e) => { if (e.target.matches('fieldset input[type="radio"]')) sync(true); });
  sync(false);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const res = await fetch("/cart/add.js", { method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams(new FormData(form)) });
    if (res.ok) await window.__openCartDrawer?.();
  });
  const sticky = document.querySelector(".sticky-atc");
  addEventListener("scroll", () => { sticky.hidden = scrollY < 600; }, { passive: true });
})();
</script>`;

  const title = `<h1>${product.title}</h1>`;
  const price = `<div class="price"><span class="price-item price-item--regular">${product.price}</span></div>`;
  const options = `
          <variant-selects class="product-form__input" data-section="main-product">
            ${radios("Taille", SIZES, "option1")}
            ${radios("Couleur", COLORS, "option2")}
            ${product.embedJson ? `<script type="application/json">${JSON.stringify(product.variants)}</script>` : ""}
          </variant-selects>`;
  const details = `
          <div class="product__description rte"><p>Description détaillée du ${product.title} : une formule légère à l'eau de rose, testée sous contrôle dermatologique, pour tous les types de peau. Appliquer matin et soir sur une peau propre.</p></div>
          <div class="product__accordion">
            <details><summary>Ingrédients</summary><p>Aqua, Glycerin, Rosa Damascena Flower Water, Sodium Hyaluronate, Panthenol, Allantoin.</p></details>
            <details><summary>Livraison et retours</summary><p>Expédition sous 48h. Retours gratuits sous 30 jours.</p></details>
            <details><summary>Guide des tailles</summary><p>30ml : un mois d'utilisation. 100ml : trois mois.</p></details>
          </div>`;
  const buy = `
          <product-form class="product-form">
            <form method="post" action="/cart/add" id="product-form-main" data-type="add-to-cart-form">
              <input type="hidden" name="id" value="${firstAvailable.id}">
              <input type="hidden" name="quantity" value="1">
              <div class="product-form__buttons">
                <button type="submit" name="add" class="product-form__submit button button--full-width">Ajouter au panier</button>
                <button type="button" class="product-form__submit--mobile" style="display:none">Add to cart</button>
                <div class="shopify-payment-button"><button type="button" class="shopify-payment-button__button shopify-payment-button__button--unbranded">Acheter maintenant</button></div>
              </div>
            </form>
          </product-form>`;
  // "blocks" mirrors themes that give every info row its own block, so the
  // option pickers are a sibling of the buy-button block rather than its parent.
  const info = theme === "blocks"
    ? `
        <div class="product-info">
          <div class="product-info__block product-title">${title}</div>
          <div class="product-info__block product-price">${price}</div>
          <div class="product-info__block product-options">${options}</div>
          <div class="product-info__block product-details">${details}</div>
          <div class="product-info__block product-buy-buttons">${buy}</div>
        </div>`
    : theme === "stack"
    // Beside a stacked gallery the info column is sticky and taller than the
    // screen, its accordions below the fold until the column lets go.
    ? `
        <div class="product__info-wrapper" style="position:sticky;top:0;align-self:start">
          <div class="product__title">${title}</div>
          ${price}${options}${buy}
          <div class="product__story" style="height:900px">Une routine pensée pour durer.</div>
          ${details}
        </div>`
    : `
        <div class="product__info-wrapper">
          <div class="product__title">${title}</div>
          ${price}${options}${details}${buy}
        </div>`;

  // "stack": no thumbnails — the photos are stacked beside the buy box, and a
  // click on one opens a zoom (counted, since viewing must not click).
  const shot = (n) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='700'%3E%3Crect width='600' height='700' fill='%23${["ddd", "ccc", "bbb", "aaa"][n - 1]}'/%3E%3C/svg%3E`;
  const media = theme === "stack"
    ? `
        <div class="product-images-grid">
          ${[1, 2, 3, 4].map((n) => `<div class="product-image" role="button" aria-label="Open image ${n} of 4" onclick="window.__zoomClicks=(window.__zoomClicks||0)+1"><img src="${shot(n)}" width="600" height="700" alt="Vue ${n}"></div>`).join("")}
        </div>`
    : `
        <media-gallery class="product__media-wrapper">
          ${[1, 2, 3, 4].map((n) => `<div class="product__media-item" data-media-id="${n}">Image ${n}</div>`).join("")}
          <div class="thumbnail-list">
            ${[1, 2, 3, 4].map((n) => `<div class="thumbnail-list__item"><button type="button" data-thumbnail-id="${n}">Vue ${n}</button></div>`).join("")}
          </div>
        </media-gallery>`;

  return page(`${product.title} — Mock Shop`, "product",
    section("main-product", `
      <div class="product">${media}${info}
      </div>
      <div class="sticky-atc" hidden><span>${product.title}</span><button type="button" class="sticky-atc__button" style="width:200px;height:44px" onclick="document.querySelector('#product-form-main button[name=add]').click()">Add to cart</button></div>
      ${variantScript}
      `) +
    section("related-products", `
        <h2>Vous aimerez aussi</h2>
        <div class="grid product-grid related-products">${related.map((p) => productCard(p, { quickAdd: true })).join("")}</div>`),
    cartCount, head, theme);
}

function cartPage(cart) {
  const lines = cart.items.length
    ? cart.items.map((l) => `<tr class="cart-item"><td><a href="/products/${l.handle}">${l.product_title}</a> — ${l.variant_title}</td><td>x${l.quantity}</td><td>${euros(l.price * l.quantity)}</td></tr>`).join("")
    : `<tr><td>Votre panier est vide</td></tr>`;
  return page("Panier — Mock Shop", "cart",
    section("main-cart", `
      <h1>Votre panier</h1>
      <form action="/cart" method="post" id="cart">
        <table class="cart-items">${lines}</table>
        <div class="totals"><span>Sous-total</span> <span class="totals__subtotal-value">${euros(cartJson(cart).total_price)}</span></div>
        <button type="submit" name="checkout" class="cart__checkout-button">Paiement</button>
      </form>`),
    itemCount(cart));
}

const routes = {
  home: (count) =>
    page("Accueil — Mock Shop", "index",
      section("hero", "<h1>Bienvenue</h1>") +
      section("collection-list", `
        <div class="collection-list">
          ${COLLECTIONS.map((c) => `<a class="card-wrapper" href="/collections/${c.handle}">${c.title}</a>`).join("")}
        </div>`) +
      section("featured-products", `
        <h2>Produits vedettes</h2>
        <div id="product-grid" class="grid product-grid">
          ${PRODUCTS.slice(0, 4).map((p) => productCard(p)).join("")}
        </div>`), count),

  collection: (handle, count, theme = "") => {
    const collection = COLLECTIONS.find((c) => c.handle === handle);
    if (!collection) return null;
    const items = handle === "all" ? PRODUCTS : PRODUCTS.filter((p) => p.collection === handle);
    return page(`${collection.title} — Mock Shop`, "collection",
      section("collection-banner", `<h1 class="collection-hero__title">${collection.title}</h1>`) +
      section("collection-product-grid", `
        <div id="product-grid" class="grid product-grid">${items.map((p) => productCard(p)).join("")}</div>
        <nav class="pagination"><a href="/collections/${handle}?page=2" rel="next">Suivant</a></nav>`), count, "", theme);
  },
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function startMockStorefront(port = 0) {
  /** Every request, so tests can check what the server actually saw (Referer, cart calls). */
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    requests.push({ method: req.method, path, search: url.search, referer: req.headers.referer ?? null, at: Date.now() });
    if (requests.length > 5000) requests.shift();
    const cart = cartFor(req, res);
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && (path === "/cart/add" || path === "/cart/add.js")) {
      const form = new URLSearchParams(await readBody(req));
      const id = Number(form.get("id"));
      const quantity = Math.max(1, Number(form.get("quantity") ?? 1) || 1);
      const product = PRODUCTS.find((p) => p.variants.some((v) => v.id === id));
      const variant = product?.variants.find((v) => v.id === id);
      if (!product || !variant || !variant.available) {
        if (path.endsWith(".js")) return json(422, { status: 422, message: "Cart Error", description: "Sold out" });
        res.writeHead(303, { location: product ? `/products/${product.handle}` : "/" });
        return res.end();
      }
      const line = cart.items.find((l) => l.variant_id === id);
      if (line) line.quantity += quantity;
      else cart.items.push({ variant_id: id, product_id: product.id, handle: product.handle, product_title: product.title, variant_title: variant.title, price: variant.price, quantity });
      if (path.endsWith(".js")) return json(200, cart.items.find((l) => l.variant_id === id));
      res.writeHead(303, { location: "/cart" });
      return res.end();
    }
    if (path === "/cart.js") return json(200, cartJson(cart));

    let html = null;
    const count = itemCount(cart);
    const theme = url.searchParams.get("theme") ?? "";
    if (path === "/") html = routes.home(count);
    else if (path === "/cart") html = cartPage(cart);
    else if (path.startsWith("/collections/")) html = routes.collection(path.split("/")[2], count, theme);
    else if (path.startsWith("/products/")) {
      const handle = path.split("/")[2] ?? "";
      if (handle.endsWith(".js")) {
        const product = PRODUCTS.find((p) => p.handle === handle.slice(0, -3));
        if (!product) return json(404, { status: 404 });
        return json(200, {
          id: product.id,
          title: product.title,
          handle: product.handle,
          options: ["Taille", "Couleur"],
          variants: product.variants,
          available: product.variants.some((v) => v.available),
        });
      }
      const product = PRODUCTS.find((p) => p.handle === handle);
      if (product) html = productPage(product, count, theme);
    }

    if (!html) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("404", "404", "<h1>Page introuvable</h1>", count));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        products: PRODUCTS,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startMockStorefront(Number(process.argv[2]) || 4321);
  process.stdout.write(`Mock storefront on ${url}\n`);
}
