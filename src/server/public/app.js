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

/** profileId → { el, refs, streamKey } */
const tiles = new Map();

let latestState = [];
let settingsFor = null;
let overlayFor = null;
let statusFilter = "all";
let textFilter = "";

// ================================================================= helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
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
    url: el.querySelector(".tile__url"),
    action: el.querySelector(".tile__action"),
    progress: el.querySelector(".tile__progress i"),
    pages: el.querySelector(".s-pages"),
    products: el.querySelector(".s-products"),
    errors: el.querySelector(".s-errors"),
    errorsWrap: el.querySelector(".s-errors-wrap"),
    qa: el.querySelector(".tile__qa"),
    issue: el.querySelector(".tile__issue"),
    badges: el.querySelector(".tile__badges"),
    desktop: el.querySelector('[data-act="desktop"]'),
    continue: el.querySelector('[data-act="continue"]'),
    pause: el.querySelector('[data-act="pause"]'),
    close: el.querySelector('[data-act="close"]'),
  };

  el.addEventListener("click", (event) => {
    const action = event.target.closest("[data-act]")?.dataset.act;
    if (action) {
      event.stopPropagation();
      void runAction(profileId, action);
      return;
    }
    if (event.target.closest(".tile__screen")) openViewer(profileId);
  });

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
  const badgeKey = `${profile.proxy ? "p" : ""}${profile.cookies ? `c${profile.cookies.count}` : ""}${profile.headed ? "d" : ""}${profile.storefront ? "s" : ""}`;
  if (refs.badges.dataset.key !== badgeKey) {
    refs.badges.dataset.key = badgeKey;
    refs.badges.replaceChildren();
    if (profile.proxy) refs.badges.append(badge("proxy", "proxy"));
    if (profile.cookies) refs.badges.append(badge("cookie", `${profile.cookies.count}c`));
    if (profile.headed) refs.badges.append(badge("desktop", "window"));
    // A per-profile storefront is worth a badge: the tile's URL bar would
    // give it away anyway, but the badge says it up front and survives
    // periods where no browser is open.
    if (profile.storefront) {
      let host = profile.storefront;
      try { host = new URL(profile.storefront).host; } catch { /* keep raw */ }
      const siteBadge = badge("site", host);
      siteBadge.title = `This profile browses ${profile.storefront} instead of the global shop`;
      refs.badges.append(siteBadge);
    }
  }

  // ---- the stream ------------------------------------------------------
  // Only touched when the session identity changes. Re-assigning src on every
  // push would restart the stream several times a second and nothing would
  // ever render.
  const streamKey = session && session.status !== "finished" ? session.sessionId : null;
  if (tile.streamKey !== streamKey) {
    tile.streamKey = streamKey;
    if (streamKey) {
      refs.view.src =
        `/api/profiles/${encodeURIComponent(profile.id)}/stream.mjpg?mode=thumb&s=${streamKey}`;
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
  renderFleet(state);

  if (settingsFor) {
    const current = state.find((v) => v.profile.id === settingsFor);
    if (current) refreshSettings(current);
  }
  if (overlayFor) syncOverlay(state);
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
  const signalTitle = signal.querySelector("b");
  const signalSub = signal.querySelector("small");
  const insight = document.getElementById("fleet-insight");
  if (blocked) {
    signal.dataset.tone = "danger";
    setText(signalTitle, `${blocked} profile${blocked === 1 ? " needs" : "s need"} review`);
    setText(signalSub, "Interaction stopped safely — inspect the live view");
    setText(insight, `${blocked} session${blocked === 1 ? " is" : "s are"} blocked before further interaction.`);
  } else if (qaIssues) {
    signal.dataset.tone = "warn";
    setText(signalTitle, `${qaIssues} QA signal${qaIssues === 1 ? "" : "s"} found`);
    setText(signalSub, "Profiles remain live; inspect the marked tile");
    setText(insight, `${qaIssues} page assertion${qaIssues === 1 ? " needs" : "s need"} attention.`);
  } else if (count("running")) {
    signal.dataset.tone = "ok";
    setText(signalTitle, `${count("running")} profile${count("running") === 1 ? " is" : "s are"} browsing`);
    setText(signalSub, "Safety guard and page assertions are active");
    setText(insight, "Live view, fixed tile positions, deterministic QA coverage.");
  } else {
    signal.dataset.tone = "muted";
    setText(signalTitle, "Fleet is ready");
    setText(signalSub, "Start a profile to begin a monitored visit");
    setText(insight, "Profiles are pinned in creation order.");
  }
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
      if (!confirm(`Delete ${name}?\n\nIts browser profile directory and imported cookies are removed too.`)) return;
      await api(`/api/profiles/${profileId}`, { method: "DELETE" });
      toast(`Deleted ${name}`);
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
    `/api/profiles/${encodeURIComponent(profileId)}/stream.mjpg?mode=full&t=${Date.now()}`;
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
    if (overlayFor) void runAction(overlayFor, button.dataset.overlayAct);
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
    proxyStatus.textContent = check.ok
      ? `ok${check.ip ? ` · exit ${check.ip}` : ""}${check.latencyMs ? ` · ${check.latencyMs}ms` : ""}`
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
  try {
    await api(`/api/profiles/${settingsFor}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: document.getElementById("f-name").value,
        storefront: document.getElementById("f-storefront").value.trim() || null,
        proxy: document.getElementById("f-proxy").value,
        durationMinutes: duration ? Number(duration) : null,
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

document.getElementById("test-proxy").addEventListener("click", async () => {
  if (!settingsFor) return;
  proxyStatus.textContent = "testing…";
  proxyStatus.removeAttribute("data-tone");
  try {
    const check = await api(`/api/profiles/${settingsFor}/proxy/test`, { method: "POST" });
    proxyStatus.textContent = check.ok
      ? `ok${check.ip ? ` · exit ${check.ip}` : ""}${check.latencyMs ? ` · ${check.latencyMs}ms` : ""}`
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
    cookieStatus.textContent =
      `imported ${result.imported} cookies (${result.format})` +
      (result.warnings.length ? ` · ${result.warnings.length} skipped` : "");
    cookieStatus.dataset.tone = "ok";
    toast(`Imported ${result.imported} cookies`, "ok");
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

async function createProfile() {
  const name = prompt("Profile name", `Profile ${latestState.length + 1}`);
  if (name === null) return;
  try {
    await api("/api/profiles", { method: "POST", body: JSON.stringify({ name }) });
    toast(`Created ${name}`, "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

document.getElementById("new-profile").addEventListener("click", createProfile);
document.getElementById("empty-create").addEventListener("click", createProfile);

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
    if (!overlay.hidden) closeViewer();
    else if (!settings.hidden) closeSettings();
    return;
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
  const source = new EventSource("/api/events");

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

fetch("/api/meta")
  .then((r) => r.json())
  .then((meta) => {
    document.getElementById("storefront").textContent =
      `${meta.storefront} · ${meta.defaultDurationMinutes}min · ` +
      (meta.headless ? "background" : "windowed");
  })
  .catch(() => undefined);

fetch("/api/state")
  .then((r) => r.json())
  .then((state) => {
    latestState = state;
    render(state);
  })
  .catch(() => undefined)
  .finally(connect);
