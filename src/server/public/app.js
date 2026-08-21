/**
 * Dashboard client.
 *
 * The one design rule everything here follows: **tiles are created once and
 * patched in place**. A state push updates the fields of existing tiles; it
 * never rebuilds the grid. Re-rendering a list on every push is what makes
 * cards flicker, lose their stream, and jump around while the operator is
 * trying to click one.
 *
 * The live views are plain <img> elements pointed at an MJPEG endpoint, so
 * they stream without any JavaScript involvement at all. That also means a
 * state push cannot interrupt them: as long as the <img> stays in the DOM with
 * the same src, the stream keeps running.
 */

const grid = document.getElementById("grid");
const emptyNote = document.getElementById("empty");
const template = document.getElementById("tile-template");
const conn = document.getElementById("conn");

/** profileId → { el, refs, streamKey } */
const tiles = new Map();

/** The profile whose settings dialog is open, if any. */
let settingsFor = null;

// ---------------------------------------------------------------- helpers

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

/** mm:ss from milliseconds. */
function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Path + query of a URL, which is the part worth showing in a small tile. */
function shortUrl(raw) {
  if (!raw || raw === "about:blank") return "—";
  try {
    const url = new URL(raw);
    return (url.pathname + url.search) || "/";
  } catch {
    return raw;
  }
}

/** Assign only when the value actually changed, to avoid pointless layout. */
function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

// ------------------------------------------------------------------ tiles

function createTile(profileId) {
  const el = template.content.firstElementChild.cloneNode(true);
  el.dataset.profileId = profileId;

  const refs = {
    name: el.querySelector(".tile__name"),
    time: el.querySelector(".tile__time"),
    screen: el.querySelector(".tile__screen"),
    view: el.querySelector(".tile__view"),
    placeholder: el.querySelector(".tile__placeholder"),
    url: el.querySelector(".tile__url"),
    action: el.querySelector(".tile__action"),
    pages: el.querySelector(".s-pages"),
    products: el.querySelector(".s-products"),
    errors: el.querySelector(".s-errors"),
    errorsWrap: el.querySelector(".s-errors-wrap"),
    badges: el.querySelector(".tile__badges"),
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
    // Clicking the picture enlarges it; the tile keeps streaming underneath.
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

  const status = session?.status ?? "idle";
  if (el.dataset.status !== status) el.dataset.status = status;

  setText(refs.name, profile.name);
  setText(
    refs.time,
    session
      ? status === "lingering"
        ? "held open"
        : clock(session.remainingMs)
      : "",
  );

  setText(refs.url, session ? shortUrl(session.url) : "—");
  setText(
    refs.action,
    session
      ? status === "lingering"
        ? "budget spent · browser kept open"
        : session.lastReason || session.state
      : "idle",
  );

  setText(refs.pages, String(session?.pagesVisited ?? profile.stats.pagesVisited));
  setText(refs.products, String(session?.productsViewed ?? profile.stats.productsViewed));
  const errors = session?.jsErrors ?? profile.stats.jsErrors;
  setText(refs.errors, String(errors));
  refs.errorsWrap.dataset.bad = errors > 0 ? "1" : "0";

  // Badges are static per profile, so only touch them when they change.
  const badges =
    (profile.proxy ? "p" : "") + (profile.cookies ? "c" : "");
  if (refs.badges.dataset.key !== badges) {
    refs.badges.dataset.key = badges;
    refs.badges.replaceChildren();
    if (profile.proxy) refs.badges.append(badge("proxy", "proxy"));
    if (profile.cookies) {
      refs.badges.append(badge("cookie", `${profile.cookies.count} cookies`));
    }
  }

  // The stream <img> is only touched when the session identity changes.
  // Re-assigning src on every push would restart the stream several times a
  // second and the tile would never show anything.
  const streamKey = session && session.status !== "finished" ? session.sessionId : null;
  if (tile.streamKey !== streamKey) {
    tile.streamKey = streamKey;
    if (streamKey) {
      refs.view.src = `/api/profiles/${encodeURIComponent(profile.id)}/stream.mjpg?mode=thumb&s=${streamKey}`;
      el.classList.add("tile--live");
    } else {
      refs.view.removeAttribute("src");
      el.classList.remove("tile--live");
      setText(refs.placeholder, "no browser open");
    }
  }

  refs.continue.textContent =
    !session ? "Start" : status === "paused" ? "Resume" : status === "lingering" ? "Continue" : "Continue";
  refs.continue.disabled = status === "running" || status === "starting";
  refs.pause.disabled = status !== "running";
  refs.close.disabled = !session;
}

function badge(kind, label) {
  const span = document.createElement("span");
  span.className = `badge badge--${kind}`;
  span.textContent = label;
  return span;
}

function render(state) {
  const seen = new Set();
  // `state` arrives in stable ordinal order from the server, and tiles are
  // appended in first-seen order, so positions stay put across pushes.
  for (const view of state) {
    seen.add(view.profile.id);
    updateTile(view);
  }

  for (const [id, tile] of tiles) {
    if (seen.has(id)) continue;
    tile.el.remove();
    tiles.delete(id);
  }

  emptyNote.hidden = state.length > 0;
  renderFleet(state);
  if (settingsFor) {
    const current = state.find((v) => v.profile.id === settingsFor);
    if (current) refreshSettingsBadges(current);
  }
}

function renderFleet(state) {
  const running = state.filter((v) => v.session?.status === "running").length;
  const held = state.filter((v) => v.session?.status === "lingering").length;
  const errors = state.reduce((sum, v) => sum + (v.session?.jsErrors ?? 0), 0);
  document.getElementById("fleet-stats").innerHTML =
    `<span><b>${state.length}</b> profiles</span>` +
    `<span><b>${running}</b> running</span>` +
    `<span><b>${held}</b> held open</span>` +
    `<span><b>${errors}</b> js errors</span>`;
}

// ---------------------------------------------------------------- actions

async function runAction(profileId, action) {
  try {
    if (action === "continue") await api(`/api/profiles/${profileId}/continue`, { method: "POST" });
    else if (action === "pause") await api(`/api/profiles/${profileId}/pause`, { method: "POST" });
    else if (action === "close") await api(`/api/profiles/${profileId}/close`, { method: "POST" });
    else if (action === "settings") openSettings(profileId);
    else if (action === "delete") {
      const name = tiles.get(profileId)?.refs.name.textContent ?? "this profile";
      // Deleting drops the cookie jar and the whole user-data directory, so it
      // is worth one confirmation.
      if (!confirm(`Delete ${name}?\n\nIts browser profile directory and imported cookies are removed too.`)) return;
      await api(`/api/profiles/${profileId}`, { method: "DELETE" });
    }
  } catch (err) {
    alert(err.message);
  }
}

// ----------------------------------------------------------------- viewer

const overlay = document.getElementById("overlay");
const overlayView = document.getElementById("overlay-view");

function openViewer(profileId) {
  const tile = tiles.get(profileId);
  if (!tile?.streamKey) return;
  document.getElementById("overlay-name").textContent = tile.refs.name.textContent;
  document.getElementById("overlay-url").textContent = tile.refs.url.textContent;
  // A separate connection at full quality. The thumbnail keeps running, and
  // the server raises the capture quality while any full viewer is attached.
  overlayView.src = `/api/profiles/${encodeURIComponent(profileId)}/stream.mjpg?mode=full&t=${Date.now()}`;
  overlay.hidden = false;
}

function closeViewer() {
  overlay.hidden = true;
  // Dropping the src closes the connection, which lets the server fall back
  // to thumbnail quality.
  overlayView.removeAttribute("src");
}

document.getElementById("overlay-close").addEventListener("click", closeViewer);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeViewer(); });

// --------------------------------------------------------------- settings

const settings = document.getElementById("settings");
const proxyStatus = document.getElementById("proxy-status");
const cookieStatus = document.getElementById("cookie-status");

function openSettings(profileId) {
  const view = latestState.find((v) => v.profile.id === profileId);
  if (!view) return;
  settingsFor = profileId;

  document.getElementById("settings-name").textContent = view.profile.name;
  document.getElementById("f-name").value = view.profile.name;
  document.getElementById("f-proxy").value = view.profile.proxy || "";
  document.getElementById("f-duration").value = view.profile.durationMinutes ?? "";
  proxyStatus.textContent = "";
  proxyStatus.removeAttribute("data-tone");
  refreshSettingsBadges(view);
  settings.hidden = false;
}

function refreshSettingsBadges(view) {
  const cookies = view.profile.cookies;
  cookieStatus.textContent = cookies
    ? `${cookies.count} cookies from ${cookies.sourceName} · ${cookies.domains.slice(0, 3).join(", ")}`
    : "none imported";

  const check = view.profile.proxyCheck;
  if (check && !proxyStatus.textContent) {
    proxyStatus.textContent = check.ok
      ? `ok${check.ip ? ` · exit ${check.ip}` : ""}${check.latencyMs ? ` · ${check.latencyMs}ms` : ""}`
      : `failed: ${check.error}`;
    proxyStatus.dataset.tone = check.ok ? "ok" : "bad";
  }
  document.getElementById("settings-identity").textContent =
    `Fingerprint ${view.identity} — pinned to this profile, identical on every run.`;
}

function closeSettings() {
  settings.hidden = true;
  settingsFor = null;
}

document.getElementById("settings-close").addEventListener("click", closeSettings);
settings.addEventListener("click", (e) => { if (e.target === settings) closeSettings(); });

document.getElementById("save-proxy").addEventListener("click", async () => {
  if (!settingsFor) return;
  try {
    await api(`/api/profiles/${settingsFor}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: document.getElementById("f-name").value,
        proxy: document.getElementById("f-proxy").value,
        durationMinutes: document.getElementById("f-duration").value
          ? Number(document.getElementById("f-duration").value)
          : null,
      }),
    });
    proxyStatus.textContent = "saved";
    proxyStatus.dataset.tone = "ok";
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

// The file picker hands us a real file from the operator's disk; we read it
// in the page and post the contents, so no multipart parsing is needed on the
// server and the same endpoint works for JSON and cookies.txt alike.
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
  } catch (err) {
    cookieStatus.textContent = err.message;
    cookieStatus.dataset.tone = "bad";
  } finally {
    event.target.value = "";
  }
});

document.getElementById("clear-cookies").addEventListener("click", async () => {
  if (!settingsFor) return;
  await api(`/api/profiles/${settingsFor}/cookies`, { method: "DELETE" });
  cookieStatus.textContent = "cleared";
  cookieStatus.dataset.tone = "ok";
});

// ------------------------------------------------------------------ shell

document.getElementById("new-profile").addEventListener("click", async () => {
  const name = prompt("Profile name", `Profile ${tiles.size + 1}`);
  if (name === null) return;
  try {
    await api("/api/profiles", { method: "POST", body: JSON.stringify({ name }) });
  } catch (err) {
    alert(err.message);
  }
});

const density = document.getElementById("density");
density.addEventListener("input", () => {
  document.documentElement.style.setProperty("--tile", `${density.value}px`);
  localStorage.setItem("tileSize", density.value);
});

const savedSize = localStorage.getItem("tileSize");
if (savedSize) {
  density.value = savedSize;
  document.documentElement.style.setProperty("--tile", `${savedSize}px`);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!overlay.hidden) closeViewer();
  else if (!settings.hidden) closeSettings();
});

// ------------------------------------------------------------------ state

let latestState = [];

function connect() {
  const source = new EventSource("/api/events");

  source.addEventListener("state", (event) => {
    latestState = JSON.parse(event.data);
    conn.dataset.live = "1";
    render(latestState);
  });

  source.addEventListener("error", () => {
    conn.dataset.live = "0";
    // EventSource reconnects on its own; closing here and re-opening on a
    // timer would fight with it.
  });

  source.addEventListener("open", () => {
    conn.dataset.live = "1";
  });
}

fetch("/api/meta")
  .then((r) => r.json())
  .then((meta) => {
    document.getElementById("storefront").textContent =
      `${meta.storefront} · ${meta.defaultDurationMinutes} min default` +
      (meta.headless ? " · headless" : " · headed");
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
