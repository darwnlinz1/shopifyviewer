/**
 * Minimal mock Shopify storefront used to exercise the simulator end to end
 * without touching a real shop. Mirrors Dawn's markup closely enough that the
 * built-in selector candidates resolve: /, /collections/<h>, /products/<h>.
 */
import { createServer } from "node:http";

const COLLECTIONS = [
  { handle: "soins-visage", title: "Soins Visage" },
  { handle: "maquillage", title: "Maquillage" },
  { handle: "all", title: "Tous les produits" },
];

const PRODUCTS = Array.from({ length: 12 }, (_, i) => ({
  handle: `produit-${i + 1}`,
  title: `Produit ${i + 1}`,
  price: `${(12 + i * 3).toFixed(2)} €`,
  collection: COLLECTIONS[i % 2].handle,
}));

const shopifyGlobals = (pageType) => `
<script>
  window.Shopify = { shop: "mock.myshopify.com", locale: "fr" };
  window.ShopifyAnalytics = { meta: { page: { pageType: ${JSON.stringify(pageType)} } } };
  window.__st = { p: ${JSON.stringify(pageType)} };
</script>`;

const header = () => `
<header class="header">
  <nav class="header__inline-menu">
    <a href="/" class="header__menu-item">Accueil</a>
    ${COLLECTIONS.map((c) => `<a class="header__menu-item" href="/collections/${c.handle}">${c.title}</a>`).join("\n")}
  </nav>
</header>`;

const productCard = (p) => `
<div class="grid__item">
  <div class="card-wrapper product-card-wrapper">
    <div class="card__media"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%23eee'/%3E%3C/svg%3E" alt="${p.title}" width="300" height="300"></div>
    <div class="card__content">
      <h3 class="card__heading"><a class="full-unstyled-link" href="/products/${p.handle}">${p.title}</a></h3>
      <div class="price"><span class="price-item price-item--regular">${p.price}</span></div>
    </div>
  </div>
</div>`;

function page(title, pageType, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${title}</title>
<style>body{font-family:sans-serif;margin:0}main{min-height:2400px;padding:24px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.card-wrapper{border:1px solid #ddd;padding:8px}
.product__media-item{height:420px;background:#f4f4f4;margin-bottom:12px}
.thumbnail-list__item{display:inline-block;margin:4px}
details{margin:8px 0;border-top:1px solid #ddd;padding:8px 0}</style>
${shopifyGlobals(pageType)}</head>
<body>${header()}<main id="MainContent" role="main">${body}</main></body></html>`;
}

const routes = {
  home: () =>
    page("Accueil — Mock Shop", "index", `
      <h1>Bienvenue</h1>
      <div class="collection-list">
        ${COLLECTIONS.map((c) => `<a class="card-wrapper" href="/collections/${c.handle}">${c.title}</a>`).join("")}
      </div>
      <h2>Produits vedettes</h2>
      <div id="product-grid" class="grid product-grid">
        ${PRODUCTS.slice(0, 4).map(productCard).join("")}
      </div>`),

  collection: (handle) => {
    const collection = COLLECTIONS.find((c) => c.handle === handle);
    if (!collection) return null;
    const items = handle === "all" ? PRODUCTS : PRODUCTS.filter((p) => p.collection === handle);
    return page(`${collection.title} — Mock Shop`, "collection", `
      <h1 class="collection-hero__title">${collection.title}</h1>
      <div id="product-grid" class="grid product-grid">${items.map(productCard).join("")}</div>
      <nav class="pagination"><a href="/collections/${handle}?page=2" rel="next">Suivant</a></nav>`);
  },

  product: (handle) => {
    const product = PRODUCTS.find((p) => p.handle === handle);
    if (!product) return null;
    const related = PRODUCTS.filter((p) => p.handle !== handle).slice(0, 4);
    return page(`${product.title} — Mock Shop`, "product", `
      <div class="product">
        <media-gallery class="product__media-wrapper">
          ${[1, 2, 3].map((n) => `<div class="product__media-item" data-media-id="${n}">Image ${n}</div>`).join("")}
          <div class="thumbnail-list">
            ${[1, 2, 3].map((n) => `<div class="thumbnail-list__item"><button type="button" data-thumbnail-id="${n}">Vue ${n}</button></div>`).join("")}
          </div>
        </media-gallery>
        <div class="product__info-wrapper">
          <div class="product__title"><h1>${product.title}</h1></div>
          <div class="price"><span class="price-item price-item--regular">${product.price}</span></div>
          <variant-selects class="product-form__input">
            <label><input type="radio" name="Taille" value="30ml"> 30ml</label>
            <label><input type="radio" name="Taille" value="50ml"> 50ml</label>
          </variant-selects>
          <div class="product__description rte"><p>Description détaillée du ${product.title}.</p></div>
          <div class="product__accordion">
            <details><summary>Ingrédients</summary><p>Aqua, Glycerin…</p></details>
            <details><summary>Livraison</summary><p>Expédition sous 48h.</p></details>
          </div>
          <form action="/cart/add" method="post">
            <button type="submit" name="add" class="product-form__submit">Ajouter au panier</button>
          </form>
        </div>
      </div>
      <h2>Vous aimerez aussi</h2>
      <div class="grid product-grid">${related.map(productCard).join("")}</div>`);
  },
};

export function startMockStorefront(port = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let html = null;

    if (path === "/") html = routes.home();
    else if (path.startsWith("/collections/")) html = routes.collection(path.split("/")[2]);
    else if (path.startsWith("/products/")) html = routes.product(path.split("/")[2]);

    if (!html) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("404", "404", "<h1>Page introuvable</h1>"));
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startMockStorefront(Number(process.argv[2]) || 4321);
  process.stdout.write(`Mock storefront on ${url}\n`);
}
