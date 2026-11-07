/**
 * Dashboard client.
 *
 * The one rule everything follows: **tiles are created once and patched in
 * place**. A state push updates the fields of existing tiles; it never rebuilds
 * the grid. Rebuilding on every push is what makes cards flicker, jump under
 * the cursor, and lose their video stream.
 *
 * The live views are plain <img> elements pointed at an MJPEG endpoint, so they
 * stream with no JavaScript involvement at all. As long as an <img> stays in
 * the DOM with an unchanged src, a state push cannot interrupt it — which is
 * why `src` is only ever touched when the session behind it actually changes.
 */

const grid = document.getElementById("grid");
const emptyState = document.getElementById("empty");
const template = document.getElementById("tile-template");
const conn = document.getElementById("conn");
const connLabel = document.getElementById("conn-label");
const toasts = document.getElementById("toasts");
const offlineBanner = document.getElementById("offline-banner");

/** profileId → { el, refs, streamKey } */
const tiles = new Map();

let latestState = [];
let settingsFor = null;
let overlayFor = null;
let statusFilter = "all";
let textFilter = "";
let liveStreamEnabled = false; // Default OFF for 0% CPU consumption across 50 streams
/** Kernel profiles use when they do not pick one ("builtin" | "bitbrowser"), from /api/meta. */
let defaultProvider = "builtin";

// ── Socket cleanup on refresh / navigate ──
// Release MJPEG streams immediately so browser sockets are freed instantly on reload
window.addEventListener("beforeunload", () => {
  for (const tile of tiles.values()) {
    const img = tile.refs?.view;
    if (img) img.removeAttribute("src");
  }
});


// ── IntersectionObserver: pause off-screen tile streams ──
// With 10+ profiles, streaming all simultaneously overwhelms the browser.
// Only visible tiles keep their MJPEG connection; off-screen ones disconnect.
const tileObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const el = entry.target;
    const img = el.querySelector(".tile__view");
    if (!img) continue;
    
    const profileId = el.dataset.profileId;
    const state = latestState.find(v => v.profile.id === profileId);
    const hasSession = state?.session && state.session.status !== "finished";
    
    if (entry.isIntersecting) {
      // Visible → connect stream ONLY if video grid is enabled by operator
      if (liveStreamEnabled && hasSession && !img.src) {
        img.src = withToken(`/api/profiles/${encodeURIComponent(profileId)}/stream.mjpg?mode=thumb&s=${state.session.sessionId}`);
        img.closest(".tile")?.classList.add("tile--live");
      }
      img.dataset.visible = "1";
    } else {
      // Off-screen → disconnect to save bandwidth
      img.removeAttribute("src");
      img.dataset.visible = "0";
      el.classList.remove("tile--live");
    }
  }
}, { threshold: 0.05 }); // 5% visible = considered on-screen


/** Prevent duplicate API calls from double-clicks. */
const _debouncePending = new Set();
async function debouncedRun(profileId, action) {
  const key = profileId + ":" + action;
  if (_debouncePending.has(key)) return;
  _debouncePending.add(key);
  try { await runAction(profileId, action); }
  finally { _debouncePending.delete(key); }
}


// ================================================================= helpers

// Dashboard auth: the server injects the token into index.html when one is
// configured; every API/stream/SSE call must carry it.
const TOKEN = window.__DASH_TOKEN__ || "";

/** ATC schedule field: reflect override state on the wrapper so CSS can show
 * a flag — blank = global default, 0 = OFF, n = "in n min". */
function syncAtcField(input) {
  const wrap = input.closest(".field--atc");
  if (!wrap) return;
  const flag = wrap.querySelector(".field__flag");
  const raw = input.value.trim();
  wrap.classList.toggle("has-value", raw !== "");
  wrap.classList.toggle("is-off", raw === "0");
  if (flag) {
    if (raw === "") flag.textContent = "";
    else if (raw === "0") flag.textContent = "off";
    else flag.textContent = `at ${raw}m`;
  }
}

function withToken(path) {
  if (!TOKEN) return path;
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
}

async function api(path, options = {}) {
  const res = await fetch(withToken(path), {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function toast(message, tone) {
  const el = document.createElement("div");
  el.className = "toast";
  if (tone) el.dataset.tone = tone;
  el.textContent = message;
  toasts.append(el);
  setTimeout(() => el.remove(), 4200);
}

/** mm:ss from milliseconds. */
function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Path + query — the part of a URL worth showing in a small tile. */
function shortUrl(raw) {
  if (!raw || raw === "about:blank") return "—";
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return raw;
  }
}

/** Write only when the value changed, to avoid pointless layout work. */
function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function statusOf(view) {
  return view.session?.status ?? "idle";
}

// ── Mobile/Desktop device emulation picker ────────────────────────────────
const DEFAULT_DEVICE_CATALOG = {
  desktop: [],
  android: ["Pixel 7", "Pixel 8", "Galaxy S23"],
  iphone: ["iPhone 14 Pro", "iPhone 15 Pro Max", "iPhone 12"],
  ipad: ["iPad Pro 11", "iPad Air"],
};
let deviceCatalog = { ...DEFAULT_DEVICE_CATALOG };

async function loadDeviceCatalog() {
  try {
    const data = await api("/api/devices");
    if (data && data.catalog) {
      deviceCatalog = data.catalog;
    }
    if (typeof settingsDevicePicker !== "undefined") settingsDevicePicker.refresh();
    if (typeof createDevicePicker !== "undefined") createDevicePicker.refresh();
    if (typeof bulkDevicePicker !== "undefined") bulkDevicePicker.refresh();
  } catch (e) {
    console.warn("Failed to load device catalog", e);
  }
}

function setupDevicePicker(kindsId, modelId) {
  const kindsEl = document.getElementById(kindsId);
  const modelEl = document.getElementById(modelId);
  if (!kindsEl || !modelEl) return { getDevice: () => null, setDevice: () => {}, refresh: () => {} };

  let currentKind = "desktop";
  let currentModel = "";

  function populateModels(kind, selectedModel) {
    modelEl.replaceChildren();
    const list = deviceCatalog[kind] || [];
    if (kind === "desktop" || list.length === 0) {
      modelEl.hidden = true;
      return;
    }
    modelEl.hidden = false;
    for (const name of list) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === (selectedModel || currentModel)) opt.selected = true;
      modelEl.append(opt);
    }
    if (!modelEl.value && list[0]) modelEl.value = list[0];
    currentModel = modelEl.value;
  }

  function setKind(kind, model) {
    currentKind = kind || "desktop";
    const list = deviceCatalog[currentKind] || [];
    currentModel = model || (list[0] || "");
    for (const chip of kindsEl.querySelectorAll(".device-chip")) {
      chip.classList.toggle("is-on", chip.dataset.kind === currentKind);
    }
    populateModels(currentKind, currentModel);
  }

  kindsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".device-chip");
    if (!chip) return;
    const kind = chip.dataset.kind;
    setKind(kind);
  });

  modelEl.addEventListener("change", () => {
    currentModel = modelEl.value;
  });

  return {
    getDevice() {
      if (currentKind === "desktop") return { kind: "desktop", model: "Desktop" };
      const list = deviceCatalog[currentKind] || [];
      const model = modelEl.value || currentModel || list[0] || "";
      return { kind: currentKind, model };
    },
    setDevice(device) {
      if (!device || device.kind === "desktop") {
        setKind("desktop");
      } else {
        setKind(device.kind, device.model);
      }
    },
    refresh() {
      populateModels(currentKind, currentModel);
    }
  };
}

const settingsDevicePicker = setupDevicePicker("s-device-kinds", "s-device-model");
const createDevicePicker = setupDevicePicker("c-device-kinds", "c-device-model");
const bulkDevicePicker = setupDevicePicker("bc-device-kinds", "bc-device-model");
void loadDeviceCatalog();

/**
 * Redraw the page-load sparkline when new timings arrived. The plotted value
 * is TTFB — the part of page load the storefront itself controls — so the
 * line answers "is the shop getting slower?" at a glance.
 */
function drawSpark(tile, navigations) {
  const { refs } = tile;
  if (!navigations.length) {
    if (!refs.sparkWrap.dataset.off) {
      refs.sparkWrap.dataset.off = "1";
      refs.sparkSvg.hidden = true;
      refs.sparkLabel.hidden = true;
    }
    return;
  }
  delete refs.sparkWrap.dataset.off;

  const key = navigations.map((m) => Math.round(m.ttfbMs ?? -1)).join(",");
  if (refs.sparkKey === key) return;
  refs.sparkKey = key;

  const values = navigations.slice(-24).map((m) => m.ttfbMs ?? null);
  const known = values.filter((v) => v !== null);
  const max = Math.max(500, ...known);
  // Onto the 100x20 viewBox; missing samples simply drop out of the line.
  const points = values
    .map((v, i) => {
      if (v === null) return "";
      const x = (i / Math.max(1, values.length - 1)) * 100;
      const y = 18 - (v / max) * 15;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
  refs.sparkLine.setAttribute("points", points);
  refs.sparkSvg.hidden = false;
  refs.sparkLabel.hidden = false;
  const last = known[known.length - 1] ?? 0;
  setText(refs.sparkLabel, `${Math.round(last)}ms`);
  refs.sparkWrap.dataset.slow = known.some((v) => v > 2500) ? "1" : "0";
}

// =================================================================== tiles

function createTile(profileId) {
  const el = template.content.firstElementChild.cloneNode(true);
  el.dataset.profileId = profileId;

  const refs = {
    name: el.querySelector(".tile__name"),
    elapsed: el.querySelector(".tile__elapsed"),
    budget: el.querySelector(".tile__budget"),
    state: el.querySelector(".tile__state"),
    view: el.querySelector(".tile__view"),
    liveFeed: el.querySelector(".tile__live-feed"),
    liveText: el.querySelector(".tile__live-text"),
    url: el.querySelector(".tile__url"),
    action: el.querySelector(".tile__action"),
    progress: el.querySelector(".tile__progress i"),
    pages: el.querySelector(".s-pages"),
    products: el.querySelector(".s-products"),
    errors: el.querySelector(".s-errors"),
    errorsWrap: el.querySelector(".s-errors-wrap"),
    qa: el.querySelector(".tile__qa"),
    issue: el.querySelector(".tile__issue"),
    login: el.querySelector(".tile__login"),
    atcPill: el.querySelector(".tile__atc-pill"),
    atcCountdown: el.querySelector(".tile__atc-countdown"),
    badges: el.querySelector(".tile__badges"),
    sparkWrap: el.querySelector(".tile__spark"),
    sparkSvg: el.querySelector(".tile__spark-svg"),
    sparkLine: el.querySelector(".tile__spark-line"),
    sparkLabel: el.querySelector(".tile__spark-label"),
    desktop: el.querySelector('[data-act="desktop"]'),
    continue: el.querySelector('[data-act="continue"]'),
    pause: el.querySelector('[data-act="pause"]'),
    close: el.querySelector('[data-act="close"]'),
  };

  el.addEventListener("click", (event) => {
    const action = event.target.closest("[data-act]")?.dataset.act;
    if (action) {
      event.stopPropagation();
      void debouncedRun(profileId, action);
      return;
    }
    if (event.target.closest(".tile__screen")) openViewer(profileId);
  });

  // profileId already assigned above
  tileObserver.observe(el);
  grid.append(el);
  const tile = { el, refs, streamKey: null };
  tiles.set(profileId, tile);
  return tile;
}

function updateTile(view) {
  const { profile, session } = view;
  const tile = tiles.get(profile.id) ?? createTile(profile.id);
  const { el, refs } = tile;
  const status = statusOf(view);

  if (el.dataset.status !== status) el.dataset.status = status;
  setText(refs.name, profile.name);

  // ---- timing --------------------------------------------------------
  // The clock counts up against the budget: "how far into this session are we"
  // reads better at a glance than "how long until it stops".
  if (session) {
    setText(refs.elapsed, clock(session.elapsedMs));
    setText(refs.budget, `/${clock(session.plannedDurationMs)}`);
    setText(refs.state, status === "lingering" ? "held open" : status);
    const pct = session.plannedDurationMs
      ? Math.min(100, (session.elapsedMs / session.plannedDurationMs) * 100)
      : 0;
    const width = `${pct.toFixed(1)}%`;
    if (refs.progress.style.width !== width) refs.progress.style.width = width;
  } else {
    setText(refs.elapsed, "0:00");
    setText(refs.budget, "");
    setText(refs.state, "idle");
    if (refs.progress.style.width !== "0%") refs.progress.style.width = "0%";
  }

  // ---- real-time live action feed ------------------------------------
  if (refs.liveText && refs.liveFeed) {
    if (session && session.status === "running") {
      const text = session.liveActionText || session.lastReason || "Đang duyệt...";
      setText(refs.liveText, text);
      refs.liveFeed.dataset.atc = session.atcVerified ? "1" : "0";
      refs.liveFeed.classList.toggle("is-active", true);
    } else if (session && session.status === "lingering") {
      setText(refs.liveText, "✓ Hoàn thành · Đang giữ phiên");
      refs.liveFeed.dataset.atc = session.atcVerified ? "1" : "0";
      refs.liveFeed.classList.toggle("is-active", false);
    } else if (session && session.status === "paused") {
      setText(refs.liveText, "⏸ Tạm dừng");
      refs.liveFeed.classList.toggle("is-active", false);
    } else {
      setText(refs.liveText, "Chưa mở trình duyệt");
      refs.liveFeed.dataset.atc = "0";
      refs.liveFeed.classList.toggle("is-active", false);
    }
  }

  // ---- what it is doing ----------------------------------------------
  setText(refs.url, session ? shortUrl(session.url) : "—");
  setText(
    refs.action,
    session
      ? status === "blocked"
        ? session.blocker?.message || "interaction stopped for review"
        : status === "lingering"
        ? "budget spent · browser kept open"
        : session.lastReason || session.state
      : "no browser open",
  );

  // ---- counters -------------------------------------------------------
  setText(refs.pages, String(session?.pagesVisited ?? profile.stats.pagesVisited));
  setText(refs.products, String(session?.productsViewed ?? profile.stats.productsViewed));
  const errors = session?.jsErrors ?? profile.stats.jsErrors;
  setText(refs.errors, String(errors));
  refs.errorsWrap.dataset.bad = errors > 0 ? "1" : "0";

  drawSpark(tile, session?.recentNavigations ?? []);

  // ---- login pill (from the account tab) ------------------------------
  if (session && session.accountLoggedIn) {
    refs.login.hidden = false;
    refs.login.dataset.logged = "1";
    setText(refs.login, `✓ ${session.accountEmail || "logged in"}`);
    refs.login.title = `Account tab shows ${session.accountEmail || "a logged-in visitor"}`;
  } else if (session && profile.cookies) {
    refs.login.hidden = false;
    refs.login.dataset.logged = "0";
    setText(refs.login, "chưa login");
    refs.login.title = "Account tab did not detect a logged-in visitor yet";
  } else {
    refs.login.hidden = true;
  }

  // ---- ATC pill: verified vs clicked-but-unconfirmed ------------------
  if (session && session.atcPerformed) {
    refs.atcPill.hidden = false;
    refs.atcPill.dataset.verified = session.atcVerified ? "1" : "0";
    refs.atcPill.dataset.clicked = "1";
    setText(refs.atcPill, session.atcVerified ? "✓ đã thêm giỏ" : "đã click · chưa xác nhận");
  } else {
    refs.atcPill.hidden = true;
  }

  // ---- ATC countdown: to the MARK, not the session end ----------------
  const scheduledAtc = session && session.atcMinutes != null && session.atcMinutes > 0;
  if (scheduledAtc && !session.atcPerformed && session.status === "running") {
    const msToAtc = Math.max(0, session.atcMinutes * 60_000 - (session.elapsedMs ?? 0));
    refs.atcCountdown.hidden = false;
    const secs = Math.ceil(msToAtc / 1000);
    const mm = Math.floor(secs / 60), ss = secs % 60;
    setText(refs.atcCountdown, msToAtc <= 0 ? "⏱ add cart ngay" : `⏱ add cart ${mm}:${String(ss).padStart(2, "0")}`);
    refs.atcCountdown.dataset.urgent = msToAtc <= 0 ? "2" : msToAtc <= 75_000 ? "1" : "0";
  } else {
    refs.atcCountdown.hidden = true;
  }

  // QA is deterministic: unlike browsing gestures, these checks happen once
  // on every newly visited page. A visible pill makes coverage and failures
  // readable without opening the event log.
  const blocker = session?.blocker;
  const qaIssues = session?.currentQaIssues ?? [];
  if (blocker) {
    setText(refs.qa, "interaction stopped");
    refs.qa.dataset.tone = "blocked";
    setText(refs.issue, blocker.kind.replace(/_/g, " "));
    refs.issue.dataset.tone = "blocked";
  } else if (qaIssues.length) {
    setText(refs.qa, `${qaIssues.length} QA issue${qaIssues.length === 1 ? "" : "s"}`);
    refs.qa.dataset.tone = "bad";
    setText(refs.issue, qaIssues[0].replace(/_/g, " "));
    refs.issue.dataset.tone = "bad";
  } else if (session?.qaCheckedPages) {
    setText(refs.qa, `${session.qaCheckedPages} page${session.qaCheckedPages === 1 ? "" : "s"} checked`);
    refs.qa.dataset.tone = "ok";
    setText(refs.issue, session.qaFailedPages ? `${session.qaFailedPages} past issue${session.qaFailedPages === 1 ? "" : "s"}` : "QA clean");
    refs.issue.dataset.tone = session.qaFailedPages ? "bad" : "ok";
  } else {
    setText(refs.qa, "QA pending");
    refs.qa.dataset.tone = "muted";
    setText(refs.issue, "waiting for first page");
    refs.issue.dataset.tone = "muted";
  }

  // The button reflects where this profile opens, so the operator can see at
  // a glance which ones have a window on their desktop.
  refs.desktop.dataset.on = profile.headed ? "1" : "0";
  refs.desktop.title = profile.headed
    ? "Opens on the desktop — click to send it back to the background"
    : "Open on the desktop (same cookies and proxy)";

  // ---- badges (static per profile) -------------------------------------
  const onBitBrowser = (profile.browserProvider || defaultProvider) === "bitbrowser";
  const badgeKey = `${profile.ordinal}${onBitBrowser ? `bb${profile.bitBrowserId || ""}` : ""}${profile.proxy ? "p" : ""}${profile.cookies ? `c${profile.cookies.count}` : ""}${profile.headed ? "d" : ""}${profile.storefront ? "s" : ""}${profile.device && profile.device.kind !== "desktop" ? `dev_${profile.device.kind}_${profile.device.model}` : ""}`;
  if (refs.badges.dataset.key !== badgeKey) {
    refs.badges.dataset.key = badgeKey;
    refs.badges.replaceChildren();
    if (onBitBrowser) {
      const bit = badge("bit", "BitBrowser");
      bit.title = profile.bitBrowserId
        ? `BitBrowser profile ${profile.bitBrowserId}${profile.bitBrowserManaged ? " (created by SiteViewer)" : " (linked)"}`
        : "BitBrowser — a profile is created on first launch";
      refs.badges.append(bit);
    }
    if (profile.proxy) refs.badges.append(badge("proxy", "proxy"));
    if (profile.cookies) refs.badges.append(badge("cookie", `${profile.cookies.count}c`));
    if (profile.headed) refs.badges.append(badge("desktop", "window"));
    if (profile.device && profile.device.kind !== "desktop") {
      const devBadge = badge("device", `📱 ${profile.device.model}`);
      devBadge.title = `Thiết bị: ${profile.device.model} (${profile.device.kind})`;
      refs.badges.append(devBadge);
    }
    // A per-profile storefront is worth a badge: the tile's URL bar would
    // give it away anyway, but the badge says it up front and survives
    // periods where no browser is open. The bare domain without the usual
    // marketing prefixes stays short enough to read at tile size.
    if (profile.storefront) {
      let host = profile.storefront;
      try { host = new URL(profile.storefront).host; } catch { /* keep raw */ }
      host = host.replace(/^www\./, "").replace(/\.(com|net|org|fr|vn|io|co|shop|store)$/, "");
      const siteBadge = badge("site", host);
      siteBadge.title = `This profile browses ${profile.storefront} instead of the global shop`;
      refs.badges.append(siteBadge);
    }
    // Ordinal badge so the operator can see position at a glance.
    const ordBadge = badge("ordinal", `#${profile.ordinal}`);
    ordBadge.title = `Creation order — tile position ${profile.ordinal}`;
    refs.badges.append(ordBadge);
  }

  // ---- the stream ------------------------------------------------------
  const streamKey = session && session.status !== "finished" ? session.sessionId : null;
  if (tile.streamKey !== streamKey || !liveStreamEnabled) {
    tile.streamKey = streamKey;
    const isVisible = refs.view.dataset.visible !== "0";
    if (liveStreamEnabled && streamKey && isVisible) {
      refs.view.src =
        withToken(`/api/profiles/${encodeURIComponent(profile.id)}/stream.mjpg?mode=thumb&s=${streamKey}`);
      el.classList.add("tile--live");
    } else {
      refs.view.removeAttribute("src");
      el.classList.remove("tile--live");
    }
  }

  // ---- controls --------------------------------------------------------
  refs.continue.textContent = !session ? "Start" : status === "paused" ? "Resume" : "Continue";
  refs.continue.disabled = status === "running" || status === "starting" || status === "stopping" || status === "blocked";
  refs.pause.disabled = status !== "running";
  refs.close.disabled = !session || status === "stopping";

  // ---- filtering -------------------------------------------------------
  // Hidden rather than removed, so a filtered-out tile keeps its position and
  // its stream when the filter is cleared again.
  const matchesText = !textFilter || profile.name.toLowerCase().includes(textFilter);
  const matchesStatus = statusFilter === "all" || status === statusFilter;
  el.hidden = !(matchesText && matchesStatus);
}

function badge(kind, label) {
  const span = document.createElement("span");
  span.className = `badge badge--${kind}`;
  span.textContent = label;
  return span;
}

function render(state) {
  const seen = new Set();
  // State arrives in stable ordinal order and tiles are appended in first-seen
  // order, so positions never shift across pushes.
  for (const view of state) {
    seen.add(view.profile.id);
    updateTile(view);
  }

  for (const [id, tile] of tiles) {
    if (seen.has(id)) continue;
    tile.el.remove();
    tiles.delete(id);
  }

  emptyState.dataset.show = state.length === 0 ? "1" : "0";
  renderWorkflow(state);
  renderFleet(state);

  if (settingsFor) {
    const current = state.find((v) => v.profile.id === settingsFor);
    if (current) refreshSettings(current);
  }
  if (overlayFor) syncOverlay(state);
}

// ---- Workflow panel -------------------------------------------------------
// Maps each profile's live session onto the human pipeline:
// chưa mở → đang mở → duyệt/scroll → chuẩn bị addcart → đã addcart → giữ browser.
const ACTION_LABEL = {
  scroll: "Đang cuộn trang",
  dwell: "Đang đọc nội dung trang",
  goto_product: "Đang mở sản phẩm",
  goto_collection: "Đang mở danh mục",
  goto_home: "Đang về trang chủ",
  go_back: "Quay lại trang trước",
  click_element: "Đang mở liên kết",
  hover_element: "Đang xem chi tiết",
};

function stageOf(view) {
  const s = view.session;
  const p = view.profile;
  if (!s) return { tone: "idle", label: "Chưa mở" };
  if (s.status === "starting") return { tone: "info", label: "Đang khởi động trình duyệt..." };
  if (s.status === "blocked") return { tone: "danger", label: "Bị chặn — cần xử lý tay" };

  const rem = s.remainingMs ?? 0;
  if (s.status === "lingering") {
    return s.atcPerformed
      ? { tone: "ok", label: "Hoàn tất — đã thêm giỏ hàng, giữ trình duyệt" }
      : { tone: "info", label: "Hết giờ — đang giữ trình duyệt" };
  }
  if (s.status !== "running") return { tone: "idle", label: "Đang " + s.status + "..." };

  if (s.atcPerformed) {
    return s.lastAction === "add_to_cart"
      ? { tone: "ok", label: "Vừa thêm vào giỏ hàng" }
      : { tone: "ok", label: "Đã thêm giỏ hàng — tiếp tục duyệt" };
  }
  // Cửa sổ chuẩn bị: engine chủ động vào product trước mốc — hiện đếm ngược.
  // Đếm ngược tới MỐC ATC (atcMinutes tính từ đầu session), KHÔNG phải thời
  // gian còn lại của session — hai giá trị khác nhau khi ATC < session length.
  const scheduled = s.atcMinutes != null && s.atcMinutes > 0;
  const msToAtc = scheduled ? Math.max(0, s.atcMinutes * 60_000 - (s.elapsedMs ?? 0)) : 0;
  if (scheduled && msToAtc <= 75_000 && msToAtc > 0) {
    return { tone: "warn", label: `Chuẩn bị thêm giỏ hàng (${Math.ceil(msToAtc / 1000)}s)` };
  }
  const label = ACTION_LABEL[s.lastAction] ?? "Đang duyệt cửa hàng";
  if (scheduled) {
    if (msToAtc <= 0) {
      return { tone: "warn", label: `${label} — Add cart ngay` };
    }
    const mins = Math.floor(msToAtc / 60000), secs = Math.round((msToAtc % 60000) / 1000);
    return { tone: "run", label: `${label} — Add cart sau ${mins}p${String(secs).padStart(2, "0")}s` };
  }
  return { tone: "run", label };
}

function wfEsc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderWorkflow(state) {
  const panel = document.getElementById("workflow");
  const rows = document.getElementById("wf-rows");
  if (!panel || !rows) return;
  panel.hidden = state.length === 0;
  const html = state.map((view) => {
    const st = stageOf(view);
    const host = (() => { try { return new URL(view.profile.storefront || "").host.replace(/^www\./, ""); } catch { return ""; } })();
    const time = new Date().toLocaleTimeString("vi-VN", { hour12: false });
    const caret = st.tone === "run" || st.tone === "warn" ? '<span class="wf-caret"></span>' : "";
    return `<div class="wf-row wf-row--${st.tone}">`
      + `<span class="wf-time">${time}</span>`
      + `<span class="wf-ord">[${String(view.profile.ordinal).padStart(4, "0")}]</span>`
      + `<span class="wf-name">${wfEsc(view.profile.name)}</span>`
      + `<span class="wf-site">${host ? wfEsc(host) : "—"}</span>`
      + `<span class="wf-stage">${wfEsc(st.label)}${caret}</span>`
      + `</div>`;
  }).join("");
  rows.innerHTML = html;
}

function renderFleet(state) {
  const count = (status) => state.filter((v) => statusOf(v) === status).length;
  const errors = state.reduce((sum, v) => sum + (v.session?.jsErrors ?? 0), 0);
  const blocked = count("blocked");
  const qaIssues = state.reduce((sum, v) => sum + (v.session?.qaFailedPages ?? 0), 0);

  const cells = [
    ["profiles", state.length, ""],
    ["running", count("running"), "ok"],
    ["held", count("lingering"), "info"],
    ["attention", blocked + qaIssues, blocked + qaIssues ? "danger" : ""],
    ["js errors", errors, errors > 0 ? "danger" : ""],
  ];

  document.getElementById("fleet-stats").innerHTML = cells
    .map(([label, value, tone]) =>
      `<span class="stat"${tone ? ` data-tone="${tone}"` : ""}><b>${value}</b>${label}</span>`)
    .join("");

  const signal = document.getElementById("fleet-signal");
  const signalTitle = document.getElementById("signal-title");
  const signalSub = document.getElementById("signal-sub");
  if (blocked) {
    signal.dataset.tone = "danger";
    setText(signalTitle, `${blocked} profile${blocked === 1 ? " needs" : "s need"} review`);
    setText(signalSub, "Interaction stopped safely — inspect the live view");
  } else if (qaIssues) {
    signal.dataset.tone = "warn";
    setText(signalTitle, `${qaIssues} QA signal${qaIssues === 1 ? "" : "s"} found`);
    setText(signalSub, "Profiles remain live; inspect the marked tile");
  } else if (count("running")) {
    signal.dataset.tone = "ok";
    setText(signalTitle, `${count("running")} profile${count("running") === 1 ? " is" : "s are"} browsing`);
    setText(signalSub, "Safety guard and page assertions are active");
  } else {
    signal.dataset.tone = "muted";
    setText(signalTitle, "Fleet is ready");
    setText(signalSub, "Start a profile to begin a monitored visit");
  }

  // The tab title carries the same signal, so a dashboard parked in a
  // background tab still announces trouble.
  const attentionTotal = blocked + qaIssues;
  document.title = attentionTotal
    ? `(${attentionTotal}) Storefront Simulator`
    : count("running")
      ? `(${count("running")}▶) Storefront Simulator`
      : "Storefront Simulator";
}

// ================================================================= actions

async function runAction(profileId, action) {
  try {
    if (action === "continue") {
      await api(`/api/profiles/${profileId}/continue`, { method: "POST" });
    } else if (action === "pause") {
      await api(`/api/profiles/${profileId}/pause`, { method: "POST" });
    } else if (action === "close") {
      await api(`/api/profiles/${profileId}/close`, { method: "POST" });
    } else if (action === "desktop") {
      const view = latestState.find((v) => v.profile.id === profileId);
      const headed = !view?.profile.headed;
      // Chromium locks a profile directory to one process, so a running
      // profile is relaunched against the same directory rather than opened
      // twice. Say so, because the browser visibly restarts.
      await api(`/api/profiles/${profileId}/show`, {
        method: "POST",
        body: JSON.stringify({ headed }),
      });
      toast(
        headed
          ? view?.session
            ? "Reopening on your desktop — same cookies, proxy and remaining time"
            : "Will open on your desktop when started"
          : "Back to the background",
        "ok",
      );
    } else if (action === "settings") {
      openSettings(profileId);
    } else if (action === "delete") {
      const name = tiles.get(profileId)?.refs.name.textContent ?? "this profile";
      // Deleting drops the cookie jar and the whole user-data directory, so it
      // is worth one confirmation.
      confirmModal(
        `Delete ${name}?`,
        "Its browser profile directory and imported cookies are removed too. This cannot be undone.",
        async () => {
          await api(`/api/profiles/${profileId}`, { method: "DELETE" });
          toast(`Deleted ${name}`);
        },
      );
    }
  } catch (err) {
    toast(err.message, "bad");
  }
}

/** Apply an action to every profile it currently makes sense for. */
async function bulk(action, applies, label) {
  const targets = latestState.filter(applies).map((v) => v.profile.id);
  if (targets.length === 0) {
    toast(`Nothing to ${label}`);
    return;
  }
  const results = await Promise.allSettled(
    targets.map((id) => api(`/api/profiles/${id}/${action}`, { method: "POST" })),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  toast(
    failed ? `${label}: ${targets.length - failed} ok, ${failed} failed` : `${label} ${targets.length} profile(s)`,
    failed ? "bad" : "ok",
  );
}

document.getElementById("bulk-start").addEventListener("click", () =>
  bulk("continue", (v) => statusOf(v) === "idle", "Started"));
document.getElementById("bulk-pause").addEventListener("click", () =>
  bulk("pause", (v) => statusOf(v) === "running", "Paused"));
document.getElementById("bulk-close").addEventListener("click", () =>
  bulk("close", (v) => v.session !== null, "Closed"));

document.getElementById("bulk-delete").addEventListener("click", () => {
  const targets = latestState.filter((v) => statusOf(v) === "idle").map((v) => v.profile.id);
  if (targets.length === 0) { toast("Nothing to delete"); return; }
  confirmModal(
    `Delete ${targets.length} idle profile(s)?`,
    "Their browser profile directories and imported cookies are removed too.",
    async () => {
      const result = await api("/api/profiles/batch-delete", {
        method: "POST",
        body: JSON.stringify({ ids: targets }),
      });
      toast(`Deleted ${result.deleted} profile(s)`, result.failed ? "bad" : "ok");
    },
  );
});

// ── Stream Toggle Button (Video Grid: TẮT / BẬT) ──
const streamToggleBtn = document.getElementById("stream-toggle");
const streamToggleLabel = document.getElementById("stream-toggle-label");

function syncStreamToggleUi() {
  if (!streamToggleBtn || !streamToggleLabel) return;
  if (liveStreamEnabled) {
    streamToggleBtn.style.background = "rgba(34,197,94,0.15)";
    streamToggleBtn.style.borderColor = "rgba(74,222,128,0.4)";
    streamToggleBtn.style.color = "#4ade80";
    streamToggleLabel.textContent = "Video Grid: BẬT";
  } else {
    streamToggleBtn.style.background = "rgba(99,102,241,0.12)";
    streamToggleBtn.style.borderColor = "rgba(99,102,241,0.3)";
    streamToggleBtn.style.color = "#a5b4fc";
    streamToggleLabel.textContent = "Video Grid: TẮT (0% CPU)";
  }
}

if (streamToggleBtn) {
  streamToggleBtn.addEventListener("click", () => {
    liveStreamEnabled = !liveStreamEnabled;
    syncStreamToggleUi();
    toast(liveStreamEnabled ? "Đã BẬT Video nền lưới" : "Đã TẮT Video nền (0% CPU)", liveStreamEnabled ? "ok" : "info");
    for (const [profileId, tile] of tiles.entries()) {
      const state = latestState.find((v) => v.profile.id === profileId);
      const hasSession = state?.session && state.session.status !== "finished";
      const isVisible = tile.refs.view.dataset.visible !== "0";
      if (liveStreamEnabled && hasSession && isVisible) {
        tile.refs.view.src = withToken(`/api/profiles/${encodeURIComponent(profileId)}/stream.mjpg?mode=thumb&s=${state.session.sessionId}`);
        tile.el.classList.add("tile--live");
      } else {
        tile.refs.view.removeAttribute("src");
        tile.el.classList.remove("tile--live");
      }
    }
  });
}

// ================================================================== viewer

const overlay = document.getElementById("overlay");
const overlayView = document.getElementById("overlay-view");

function openViewer(profileId) {
  const tile = tiles.get(profileId);
  if (!tile?.streamKey) return;
  overlayFor = profileId;

  const view = latestState.find((v) => v.profile.id === profileId);
  document.getElementById("overlay-name").textContent = view?.profile.name ?? "";
  document.getElementById("overlay-dot").parentElement.dataset.status = statusOf(view ?? {});

  // A second connection at full quality. The thumbnail keeps running, and the
  // server raises capture quality for as long as any full viewer is attached.
  overlayView.src =
    withToken(`/api/profiles/${encodeURIComponent(profileId)}/stream.mjpg?mode=full&t=${Date.now()}`);
  overlay.hidden = false;
  syncOverlay(latestState);
}

function syncOverlay(state) {
  const view = state.find((v) => v.profile.id === overlayFor);
  if (!view) {
    closeViewer();
    return;
  }
  document.getElementById("overlay-url").textContent = view.session ? view.session.url : "—";
  const panel = document.getElementById("overlay-dot").parentElement;
  panel.dataset.status = statusOf(view);
}

function closeViewer() {
  overlay.hidden = true;
  overlayFor = null;
  // Dropping src closes the connection, letting the server fall back to
  // thumbnail quality.
  overlayView.removeAttribute("src");
}

document.getElementById("overlay-dismiss").addEventListener("click", closeViewer);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeViewer(); });

document.querySelectorAll("[data-overlay-act]").forEach((button) => {
  button.addEventListener("click", () => {
    if (overlayFor) void debouncedRun(overlayFor, button.dataset.overlayAct);
  });
});

// ================================================================ settings

const settings = document.getElementById("settings");
const proxyStatus = document.getElementById("proxy-status");
const cookieStatus = document.getElementById("cookie-status");

function openSettings(profileId) {
  const view = latestState.find((v) => v.profile.id === profileId);
  if (!view) return;
  settingsFor = profileId;

  document.getElementById("f-name").value = view.profile.name;
  document.getElementById("f-storefront").value = view.profile.storefront || "";
  document.getElementById("f-proxy").value = view.profile.proxy || "";
  document.getElementById("f-duration").value = view.profile.durationMinutes ?? "";
  // 0 is meaningful ("timed ATC off"), so only blank means "follow global".
  document.getElementById("f-atc").value = view.profile.atcMinutes ?? "";
  syncAtcField(document.getElementById("f-atc"));
  settingsDevicePicker.setDevice(view.profile.device);
  document.getElementById("f-provider").value = view.profile.browserProvider || "";
  document.getElementById("f-bitbrowser-id").value = view.profile.bitBrowserId || "";
  syncEngineFields("f");
  proxyStatus.textContent = "";
  proxyStatus.removeAttribute("data-tone");
  cookieStatus.removeAttribute("data-tone");
  refreshSettings(view, true);
  settings.hidden = false;
}

function refreshSettings(view, resetProxyStatus = false) {
  document.getElementById("settings-name").textContent = view.profile.name;

  const cookies = view.profile.cookies;
  if (!cookieStatus.dataset.tone) {
    cookieStatus.textContent = cookies
      ? `${cookies.count} cookies · ${cookies.sourceName} · ${cookies.domains.slice(0, 3).join(", ")}`
      : "none imported";
  }

  const check = view.profile.proxyCheck;
  if (check && (resetProxyStatus || !proxyStatus.textContent)) {
    const noteSuffix = check.note ? ` — ${check.note}` : "";
    proxyStatus.textContent = check.ok
      ? `ok${check.ip ? ` · exit ${check.ip}` : ""}${check.latencyMs ? ` · ${check.latencyMs}ms` : ""}${noteSuffix}`
      : `failed: ${check.error}`;
    proxyStatus.dataset.tone = check.ok ? "ok" : "bad";
  }

  document.getElementById("settings-identity").innerHTML =
    `Fingerprint <b>${view.identity}</b> — pinned to this profile and identical on every run, ` +
    `so a returning visitor does not arrive with a different screen each time.`;
}

function closeSettings() {
  settings.hidden = true;
  settingsFor = null;
}

document.getElementById("settings-dismiss").addEventListener("click", closeSettings);
settings.addEventListener("click", (e) => { if (e.target === settings) closeSettings(); });

document.getElementById("save-proxy").addEventListener("click", async () => {
  if (!settingsFor) return;
  const duration = document.getElementById("f-duration").value;
  const atcRaw = document.getElementById("f-atc").value.trim();
  const dev = settingsDevicePicker.getDevice();
  try {
    await api(`/api/profiles/${settingsFor}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: document.getElementById("f-name").value,
        storefront: document.getElementById("f-storefront").value.trim() || null,
        proxy: document.getElementById("f-proxy").value,
        durationMinutes: duration ? Number(duration) : null,
        atcMinutes: atcRaw === "" ? null : Math.max(0, Number(atcRaw)),
        device: dev && dev.kind !== "desktop" ? dev : null,
        browserProvider: document.getElementById("f-provider").value || null,
        bitBrowserId: document.getElementById("f-bitbrowser-id").value.trim() || null,
      }),
    });
    proxyStatus.textContent = "saved";
    proxyStatus.dataset.tone = "ok";
    toast("Profile saved", "ok");
  } catch (err) {
    proxyStatus.textContent = err.message;
    proxyStatus.dataset.tone = "bad";
  }
});

document.getElementById("f-atc").addEventListener("input", (e) => syncAtcField(e.target));

/**
 * Show the BitBrowser profile-ID field only when that kernel is in play:
 * picked explicitly, or inherited from a config whose default is BitBrowser.
 */
function syncEngineFields(prefix) {
  const picked = document.getElementById(`${prefix}-provider`).value;
  const effective = picked || defaultProvider;
  const field = document.getElementById(`${prefix}-bitbrowser-field`);
  if (field) field.hidden = effective !== "bitbrowser";
  const note = document.getElementById(`${prefix}-bitbrowser-note`);
  if (note) note.hidden = effective !== "bitbrowser";
}
document.getElementById("f-provider").addEventListener("change", () => syncEngineFields("f"));
document.getElementById("c-provider").addEventListener("change", () => syncEngineFields("c"));

document.getElementById("test-proxy").addEventListener("click", async () => {
  if (!settingsFor) return;
  proxyStatus.textContent = "testing…";
  proxyStatus.removeAttribute("data-tone");
  try {
    const check = await api(`/api/profiles/${settingsFor}/proxy/test`, { method: "POST" });
    proxyStatus.textContent = check.ok
      ? `ok${check.ip ? ` · exit ${check.ip}` : ""}${check.latencyMs ? ` · ${check.latencyMs}ms` : ""}${check.note ? ` — ${check.note}` : ""}`
      : `failed: ${check.error}`;
    proxyStatus.dataset.tone = check.ok ? "ok" : "bad";
  } catch (err) {
    proxyStatus.textContent = err.message;
    proxyStatus.dataset.tone = "bad";
  }
});

// The picker hands us a real file from disk; we read it in the page and post
// the contents, so the server needs no multipart parsing and the same endpoint
// takes JSON exports and cookies.txt alike.
document.getElementById("f-cookies").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file || !settingsFor) return;
  cookieStatus.textContent = `reading ${file.name}…`;
  cookieStatus.removeAttribute("data-tone");
  try {
    const contents = await file.text();
    const result = await api(`/api/profiles/${settingsFor}/cookies`, {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contents }),
    });
    const warnDetail = result.warnings.slice(0, 2).join(" | ");
    const geoText = result.geoSync ? ` [📍 ${result.geoSync.country} · ${result.geoSync.timezone}]` : "";
    cookieStatus.textContent =
      `imported ${result.imported} cookies (${result.format})${geoText}` +
      (result.warnings.length
        ? ` · ${result.warnings.length} skipped: ${warnDetail}${result.warnings.length > 2 ? " …" : ""}`
        : "");
    cookieStatus.dataset.tone = "ok";
    toast(
      result.warnings.length
        ? `Imported ${result.imported}, skipped ${result.warnings.length}: ${warnDetail}`
        : `Imported ${result.imported} cookies${result.geoSync ? ` (${result.geoSync.country} · ${result.geoSync.timezone})` : ""}`,
      "ok",
    );
  } catch (err) {
    cookieStatus.textContent = err.message;
    cookieStatus.dataset.tone = "bad";
  } finally {
    event.target.value = "";
  }
});

document.getElementById("clear-cookies").addEventListener("click", async () => {
  if (!settingsFor) return;
  try {
    await api(`/api/profiles/${settingsFor}/cookies`, { method: "DELETE" });
    cookieStatus.textContent = "cleared";
    cookieStatus.dataset.tone = "ok";
  } catch (err) {
    toast(err.message, "bad");
  }
});

// =================================================================== shell

// ---- create-profile modal (replaces window.prompt) ----------------------

const createModal = document.getElementById("create");
const createStatus = document.getElementById("create-status");

function openCreate() {
  document.getElementById("c-name").value = "";
  document.getElementById("c-storefront").value = "";
  document.getElementById("c-proxy").value = "";
  document.getElementById("c-duration").value = "";
  document.getElementById("c-atc").value = "";
  syncAtcField(document.getElementById("c-atc"));
  createDevicePicker.setDevice(null);
  document.getElementById("c-headed").checked = false;
  document.getElementById("c-provider").value = "";
  document.getElementById("c-bitbrowser-id").value = "";
  syncEngineFields("c");
  createStatus.textContent = "";
  createStatus.removeAttribute("data-tone");
  createModal.hidden = false;
  document.getElementById("c-name").focus();
}

function closeCreate() {
  createModal.hidden = true;
}

async function submitCreate() {
  const name = document.getElementById("c-name").value.trim();
  const storefront = document.getElementById("c-storefront").value.trim();
  const proxy = document.getElementById("c-proxy").value.trim();
  const duration = document.getElementById("c-duration").value;
  const atcRaw = document.getElementById("c-atc").value.trim();
  const headed = document.getElementById("c-headed").checked;
  const dev = createDevicePicker.getDevice();
  const provider = document.getElementById("c-provider").value;
  const bitBrowserId = document.getElementById("c-bitbrowser-id").value.trim();

  createStatus.textContent = "creating…";
  createStatus.removeAttribute("data-tone");
  try {
    await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify({
        ...(name ? { name } : {}),
        ...(storefront ? { storefront } : {}),
        ...(proxy ? { proxy } : {}),
        ...(duration ? { durationMinutes: Number(duration) } : {}),
        ...(atcRaw !== "" ? { atcMinutes: Math.max(0, Number(atcRaw)) } : {}),
        ...(headed ? { headed: true } : {}),
        ...(dev && dev.kind !== "desktop" ? { device: dev } : {}),
        ...(provider ? { browserProvider: provider } : {}),
        ...(bitBrowserId && (provider || defaultProvider) === "bitbrowser" ? { bitBrowserId } : {}),
      }),
    });
    toast(`Created ${name || "profile"}`, "ok");
    closeCreate();
  } catch (err) {
    createStatus.textContent = err.message;
    createStatus.dataset.tone = "bad";
  }
}

document.getElementById("new-profile").addEventListener("click", openCreate);
document.getElementById("empty-create").addEventListener("click", openCreate);
document.getElementById("create-dismiss").addEventListener("click", closeCreate);
document.getElementById("create-cancel").addEventListener("click", closeCreate);
createModal.addEventListener("click", (e) => { if (e.target === createModal) closeCreate(); });
document.getElementById("c-atc").addEventListener("input", (e) => syncAtcField(e.target));
document.getElementById("create-save").addEventListener("click", () => void submitCreate());
for (const id of ["c-name", "c-storefront", "c-proxy", "c-duration"]) {
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void submitCreate(); }
  });
}

// ---- bulk-create modal (paste sites + proxies) --------------------------

const bulkModal = document.getElementById("bulk-create");
const bulkStatus = document.getElementById("bulk-create-status");

function openBulk() {
  document.getElementById("bc-sites").value = "";
  document.getElementById("bc-proxies").value = "";
  document.getElementById("bc-duration").value = "";
  document.getElementById("bc-atc").value = "";
  syncAtcField(document.getElementById("bc-atc"));
  bulkDevicePicker.setDevice(null);
  document.getElementById("bc-provider").value = "";
  bulkStatus.textContent = "";
  bulkStatus.removeAttribute("data-tone");
  updateBulkPreview();
  bulkModal.hidden = false;
  document.getElementById("bc-proxies").focus();
}
function closeBulk() { bulkModal.hidden = true; }

// Live "N proxy + M site → N profiles" preview under the textareas.
function bulkLines(id) {
  return document.getElementById(id).value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function updateBulkPreview() {
  const preview = document.getElementById("bc-preview");
  if (!preview) return;
  const sites = [...new Set(bulkLines("bc-sites"))];
  const proxies = [...new Set(bulkLines("bc-proxies"))];
  const count = proxies.length > 0 ? proxies.length : sites.length;
  if (count === 0) { preview.textContent = "Dán site và proxy để xem trước"; return; }
  const driver = proxies.length > 0 ? `${proxies.length} proxy` : `${sites.length} site`;
  const siteNote = sites.length > 0 ? ` · luân phiên ${sites.length} site` : " · không có site (theo global)";
  preview.innerHTML = `${driver}${proxies.length > 0 ? siteNote : ""} → <b>${count} profile</b>`;
}

async function submitBulk() {
  const lines = (id) => document.getElementById(id).value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const sites = lines("bc-sites");
  const proxies = lines("bc-proxies");
  const duration = document.getElementById("bc-duration").value;
  const atcRaw = document.getElementById("bc-atc").value.trim();
  const dev = bulkDevicePicker.getDevice();
  const provider = document.getElementById("bc-provider").value;
  const count = proxies.length > 0 ? proxies.length : sites.length;
  if (count === 0) { bulkStatus.textContent = "Dán ít nhất 1 site hoặc 1 proxy"; bulkStatus.dataset.tone = "bad"; return; }

  bulkStatus.textContent = `creating ${count} profile(s)…`;
  bulkStatus.removeAttribute("data-tone");
  try {
    const r = await api("/api/profiles/bulk-create", {
      method: "POST",
      body: JSON.stringify({
        sites, proxies,
        ...(duration ? { durationMinutes: Number(duration) } : {}),
        ...(atcRaw !== "" ? { atcMinutes: Math.max(0, Number(atcRaw)) } : {}),
        ...(dev && dev.kind !== "desktop" ? { device: dev } : {}),
        ...(provider ? { browserProvider: provider } : {}),
      }),
    });
    toast(`Created ${r.created} profile(s)` + (r.errors?.length ? `, ${r.errors.length} failed` : ""), r.errors?.length ? "warn" : "ok");
    closeBulk();
  } catch (err) {
    bulkStatus.textContent = err.message;
    bulkStatus.dataset.tone = "bad";
  }
}

document.getElementById("bulk-create-btn").addEventListener("click", openBulk);
document.getElementById("bulk-create-dismiss").addEventListener("click", closeBulk);
document.getElementById("bulk-create-cancel").addEventListener("click", closeBulk);
bulkModal.addEventListener("click", (e) => { if (e.target === bulkModal) closeBulk(); });
document.getElementById("bc-atc").addEventListener("input", (e) => syncAtcField(e.target));
document.getElementById("bulk-create-save").addEventListener("click", () => void submitBulk());
// Live preview updates on every keystroke in either textarea.
document.getElementById("bc-sites").addEventListener("input", updateBulkPreview);
document.getElementById("bc-proxies").addEventListener("input", updateBulkPreview);

// ---- delete confirmation (replaces window.confirm) ----------------------

const confirmOverlay = document.getElementById("confirm");

function confirmModal(title, copy, onAccept) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-copy").textContent = copy;
  confirmOverlay.hidden = false;
  const accept = document.getElementById("confirm-accept");
  accept.focus();
  accept.onclick = () => {
    confirmOverlay.hidden = true;
    void onAccept().catch((err) => toast(err.message, "bad"));
  };
}

function closeConfirm() {
  confirmOverlay.hidden = true;
}

document.getElementById("confirm-cancel").addEventListener("click", closeConfirm);
confirmOverlay.addEventListener("click", (e) => { if (e.target === confirmOverlay) closeConfirm(); });

// ---- privacy hardening (separate setting) ---------------------------------
const privacyOverlay = document.getElementById("privacy");
const privacyStatus = document.getElementById("privacy-status");
function openPrivacy() {
  privacyOverlay.hidden = false;
  privacyStatus.textContent = "đang tải...";
  privacyStatus.removeAttribute("data-tone");
  api("/api/config/privacy").then(cfg => {
    document.getElementById("p-webrtc").checked = !!cfg.disableWebRTC;
    document.getElementById("p-geo").checked = !!cfg.disableGeolocation;
    document.getElementById("p-dnt").checked = !!cfg.enableDoNotTrack;
    document.getElementById("p-webgl").checked = !!cfg.disableWebGL;
    document.getElementById("p-canvas").checked = !!cfg.disableCanvas;
    privacyStatus.textContent = "Áp dụng khi mở browser mới";
    privacyStatus.dataset.tone = "ok";
  }).catch(err => {
    privacyStatus.textContent = err.message;
    privacyStatus.dataset.tone = "bad";
  });
}
function closePrivacy() { privacyOverlay.hidden = true; }
document.getElementById("privacy-btn").addEventListener("click", openPrivacy);
document.getElementById("privacy-dismiss").addEventListener("click", closePrivacy);
document.getElementById("privacy-cancel").addEventListener("click", closePrivacy);
privacyOverlay.addEventListener("click", (e) => { if (e.target === privacyOverlay) closePrivacy(); });
document.getElementById("privacy-save").addEventListener("click", async () => {
  privacyStatus.textContent = "đang lưu...";
  try {
    const cfg = await api("/api/config/privacy", {
      method: "PATCH",
      body: JSON.stringify({
        disableWebRTC: document.getElementById("p-webrtc").checked,
        disableGeolocation: document.getElementById("p-geo").checked,
        enableDoNotTrack: document.getElementById("p-dnt").checked,
        disableWebGL: document.getElementById("p-webgl").checked,
        disableCanvas: document.getElementById("p-canvas").checked,
      }),
    });
    privacyStatus.textContent = "Đã lưu — browser mới sẽ áp dụng";
    privacyStatus.dataset.tone = "ok";
    toast("Privacy đã lưu", "ok");
  } catch (err) {
    privacyStatus.textContent = err.message;
    privacyStatus.dataset.tone = "bad";
  }
});

document.getElementById("filter").addEventListener("input", (event) => {
  textFilter = event.target.value.trim().toLowerCase();
  render(latestState);
});

document.getElementById("status-filter").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  statusFilter = chip.dataset.filter;
  for (const other of document.querySelectorAll("#status-filter .chip")) {
    other.classList.toggle("is-on", other === chip);
  }
  render(latestState);
});

const density = document.getElementById("density");
density.addEventListener("input", () => {
  document.documentElement.style.setProperty("--tile", `${density.value}px`);
  try {
    localStorage.setItem("tileSize", density.value);
  } catch {
    // Private windows and blocked site data both throw here; the dashboard
    // works fine without remembering the setting.
  }
});

try {
  const saved = localStorage.getItem("tileSize");
  if (saved) {
    density.value = saved;
    document.documentElement.style.setProperty("--tile", `${saved}px`);
  }
} catch {
  /* see above */
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!confirmOverlay.hidden) closeConfirm();
    else if (!privacyOverlay.hidden) closePrivacy();
    else if (!createModal.hidden) closeCreate();
    else if (!overlay.hidden) closeViewer();
    else if (!settings.hidden) closeSettings();
    return;
  }
  // While the enlarged viewer is open: arrows step between profiles in wall
  // order, Space pauses/resumes — no reaching for the mouse.
  if (!overlay.hidden && overlayFor) {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const live = latestState.filter((v) => tiles.get(v.profile.id)?.streamKey);
      const index = live.findIndex((v) => v.profile.id === overlayFor);
      if (index >= 0) {
        const next = live[(index + (event.key === "ArrowRight" ? 1 : live.length - 1)) % live.length];
        openViewer(next.profile.id);
        event.preventDefault();
      }
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      void debouncedRun(overlayFor, statusOf(latestState.find((v) => v.profile.id === overlayFor) ?? {}) === "paused" ? "continue" : "pause");
      return;
    }
  }
  // "/" focuses the filter, unless the operator is already typing somewhere.
  if (event.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) {
    event.preventDefault();
    document.getElementById("filter").focus();
  }
});

// =================================================================== state

function setConnected(live) {
  conn.dataset.live = live ? "1" : "0";
  connLabel.textContent = live ? "live" : "reconnecting";
  // The wall keeps rendering its last state while offline, so the banner —
  // not just the tiny dot — has to say the data is stale.
  document.getElementById("offline-banner").hidden = Boolean(live);
  document.body.classList.toggle("is-offline", !live);
}

// State arrives only when something happens, but a clock has to move every
// second regardless. Ticking locally between pushes keeps it honest without
// asking the server for state it has not changed. Elapsed is derived from the
// server's startedAt, so a slow push cannot make the tile drift behind.
setInterval(() => {
  for (const view of latestState) {
    const tile = tiles.get(view.profile.id);
    const session = view.session;
    if (!tile || !session) continue;
    if (session.status !== "running" && session.status !== "starting") continue;

    const elapsed = Date.now() - new Date(session.startedAt).getTime();
    setText(tile.refs.elapsed, clock(elapsed));
    if (session.plannedDurationMs) {
      const pct = Math.min(100, (elapsed / session.plannedDurationMs) * 100);
      tile.refs.progress.style.width = `${pct.toFixed(1)}%`;
    }
  }
}, 1000);

function connect() {
  const source = new EventSource(withToken("/api/events"));

  source.addEventListener("state", (event) => {
    latestState = JSON.parse(event.data);
    setConnected(true);
    render(latestState);
  });

  source.addEventListener("open", () => setConnected(true));
  source.addEventListener("error", () => setConnected(false));
  // EventSource reconnects by itself; re-opening on a timer here would fight
  // with it.
}

fetch(withToken("/api/meta"))
  .then((r) => r.json())
  .then((meta) => {
    document.getElementById("storefront").textContent =
      `${meta.storefront || "per-profile"} · ${meta.defaultDurationMinutes}min · ` +
      (meta.headless ? "background" : "windowed");
    const engineEl = document.getElementById("engine-badge");
    if (engineEl && meta.engine) {
      engineEl.textContent = meta.engine.isUngoogled ? "🚀 Ungoogled-Chromium (RAM-Optimized)" : `⚡ ${meta.engine.name}`;
      engineEl.title = meta.engine.isUngoogled
        ? "Đang chạy Ungoogled-Chromium Portable (độc lập, siêu nhẹ, tiết kiệm 50% RAM)"
        : `Trình duyệt: ${meta.engine.name}`;
    }
    if (meta.provider) {
      defaultProvider = meta.provider;
      // Badges depend on the default kernel; force them to redraw.
      for (const tile of tiles.values()) delete tile.refs.badges.dataset.key;
      render(latestState);
    }
  })
  .catch(() => undefined);

/** Header pill: is the BitBrowser Local API answering right now? */
async function refreshBitBrowserBadge() {
  const el = document.getElementById("bitbrowser-badge");
  if (!el) return;
  try {
    const status = await api("/api/bitbrowser/status");
    el.hidden = false;
    el.dataset.tone = status.ok ? "ok" : "bad";
    el.textContent = status.ok ? `🧬 BitBrowser · ${status.latencyMs ?? "?"}ms` : "🧬 BitBrowser offline";
    el.title = status.ok
      ? `BitBrowser Local API ${status.apiUrl} · ${status.profilesLinked} profile(s) linked`
      : `${status.apiUrl}: ${status.error ?? "not reachable"}`;
  } catch {
    el.hidden = true;
  }
}
void refreshBitBrowserBadge();
setInterval(() => void refreshBitBrowserBadge(), 30_000);

fetch(withToken("/api/state"))
  .then((r) => r.json())
  .then((state) => {
    latestState = state;
    render(state);
  })
  .catch(() => undefined)
  .finally(connect);
