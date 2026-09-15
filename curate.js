const S = window.MMTServed;
const STORE = "mmt-locations";
const NEAR_M = 450;

const errEl = document.getElementById("err");
const titleEl = document.getElementById("lm-title");
const metaEl = document.getElementById("lm-meta");
const qEl = document.getElementById("stop-q");
const resultsEl = document.getElementById("stop-results");
const hintEl = document.getElementById("map-hint");
const editorEl = document.getElementById("editor");
const nameEl = document.getElementById("lm-name");
const iconsEl = document.getElementById("lm-icons");
const assignedEl = document.getElementById("lm-assigned");
const listEl = document.getElementById("lm-list");

let pack = null;
let loc = { reviewed: [], landmarks: [] };
let selectedId = "";
let map = null;
let pinLayer = null;
let fitted = false;
const stopMarkers = new Map();
let boxStart = null;
let boxRect = null;
let boxLmId = "";
let pendingClear = false;

function showErr(msg) {
  errEl.hidden = !msg;
  errEl.textContent = msg || "";
}

function loadLocal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE) || "null");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function saveLocal() {
  localStorage.setItem(STORE, JSON.stringify(loc));
}

function selected() {
  return loc.landmarks.find((lm) => lm.id === selectedId) || null;
}

function allStops() {
  return pack.stops || [];
}

function refreshMeta() {
  const assigned = new Set();
  for (const lm of loc.landmarks) {
    for (const code of lm.stops || []) assigned.add(code);
  }
  titleEl.textContent = "Landmarks";
  metaEl.textContent = `${loc.landmarks.length} placed · ${assigned.size} stops tagged`;
}

function iconChoicesHtml(selectedIcon) {
  return Object.entries(S.ICONS)
    .map(([id, spec]) => {
      const on = selectedIcon === id ? " on" : "";
      return `<button type="button" class="icon-choice${on}" data-set-icon="${id}" title="${spec.label}">${spec.svg}<span>${spec.label}</span></button>`;
    })
    .join("");
}

function renderEditor() {
  const lm = selected();
  editorEl.hidden = !lm;
  if (!lm) {
    hintEl.textContent = "Click the map to place a landmark.";
    return;
  }
  hintEl.textContent = "Click stops to assign them, or right-click and drag from the pin to box-select. Click the map to deselect.";
  if (document.activeElement !== nameEl) nameEl.value = lm.label || "";
  iconsEl.innerHTML = iconChoicesHtml(lm.icon || "landmark");
  const names = (lm.stops || [])
    .map((code) => {
      const g = pack.geo[code] || {};
      return `${g.n || code} (#${code})`;
    })
    .join(" · ");
  assignedEl.textContent =
    lm.stops && lm.stops.length
      ? `Shown at ${lm.stops.length} stop${lm.stops.length === 1 ? "" : "s"}: ${names}`
      : "No stops assigned yet.";
}

function renderList() {
  const rows = loc.landmarks
    .slice()
    .sort((a, b) => String(a.label || "").localeCompare(String(b.label || ""), "en") || a.id.localeCompare(b.id));
  listEl.innerHTML = rows
    .map((lm) => {
      const n = (lm.stops || []).length;
      const spec = S.ICONS[lm.icon] || {};
      const on = lm.id === selectedId ? " on" : "";
      return `<button type="button" class="lm-item${on}" data-lm="${S.escapeHtml(lm.id)}">
        <span class="lm-ico">${spec.svg || ""}</span>
        <span>
          <span class="nm">${S.escapeHtml(lm.label || "Untitled")}</span>
          <span class="cd">${n} stop${n === 1 ? "" : "s"}</span>
        </span>
      </button>`;
    })
    .join("");
}

function stopStyle(code, lm) {
  const assigned = !!(lm && (lm.stops || []).includes(code));
  const g = pack.geo[code];
  const near = !!(lm && g && Number.isFinite(lm.lat) && S.distM(lm, g) <= NEAR_M);
  return {
    radius: assigned ? 8 : near ? 7 : 5,
    color: assigned ? "#111" : near ? "#333366" : "#666",
    weight: assigned ? 2 : 1.2,
    fillColor: assigned ? "#333366" : near ? "#fff" : "#f4f2ee",
    fillOpacity: assigned ? 1 : 0.95,
  };
}

function pinIcon(lm, on) {
  const spec = S.ICONS[lm.icon] || {};
  return L.divIcon({
    className: `lm-pin${on ? " on" : ""}`,
    html: `<div class="lm-pin-inner">${spec.svg || ""}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function restyleStops() {
  const lm = selected();
  for (const [code, marker] of stopMarkers) {
    marker.setStyle(stopStyle(code, lm));
  }
}

function ensureStopMarkers() {
  if (stopMarkers.size) return;
  const bounds = [];
  for (const stop of allStops()) {
    const g = pack.geo[stop.code];
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    const marker = L.circleMarker([g.lat, g.lon], stopStyle(stop.code, selected()));
    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      onStopClick(stop.code);
    });
    marker.bindTooltip(`${stop.name || stop.code}  #${stop.code}`, { direction: "top", offset: [0, -6] });
    marker.addTo(map);
    stopMarkers.set(stop.code, marker);
    bounds.push([g.lat, g.lon]);
  }
  if (!fitted && bounds.length) {
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13 });
    fitted = true;
  }
}

function redrawPins() {
  if (!pinLayer) return;
  pinLayer.clearLayers();
  for (const item of loc.landmarks) {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    const marker = L.marker([item.lat, item.lon], {
      icon: pinIcon(item, item.id === selectedId),
      zIndexOffset: item.id === selectedId ? 600 : 400,
    });
    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      selectLandmark(item.id);
    });
    marker.on("mousedown", (e) => {
      if (!e.originalEvent || e.originalEvent.button !== 2) return;
      L.DomEvent.stop(e);
      startBoxSelect(item.id, e.originalEvent);
    });
    marker.bindTooltip(item.label || "Untitled", { direction: "top" });
    marker.addTo(pinLayer);
  }
}

function redraw() {
  refreshMeta();
  renderEditor();
  renderList();
  restyleStops();
  redrawPins();
}

function selectLandmark(id) {
  selectedId = id || "";
  redraw();
  if (id) nameEl.focus();
}

function clearSelection() {
  if (!selectedId) return false;
  selectedId = "";
  redraw();
  return true;
}

function onStopClick(code) {
  const lm = selected();
  if (lm) {
    const stops = lm.stops || (lm.stops = []);
    const i = stops.indexOf(code);
    if (i >= 0) stops.splice(i, 1);
    else stops.push(code);
    saveLocal();
    redraw();
    return;
  }
  const owner = loc.landmarks.find((item) => (item.stops || []).includes(code));
  if (owner) selectLandmark(owner.id);
}

function placeLandmark(lat, lon) {
  const lm = {
    id: S.newLandmarkId(),
    label: "",
    icon: "landmark",
    lat,
    lon,
    stops: [],
  };
  loc.landmarks.push(lm);
  selectedId = lm.id;
  saveLocal();
  redraw();
  nameEl.focus();
}

function onMapClick(e) {
  if (boxStart) return;
  if (clearSelection()) return;
  placeLandmark(e.latlng.lat, e.latlng.lng);
}

function eventLatLng(ev) {
  return map.mouseEventToLatLng(ev);
}

function startBoxSelect(lmId, ev) {
  selectedId = lmId;
  boxLmId = lmId;
  boxStart = eventLatLng(ev);
  if (boxRect) boxRect.remove();
  boxRect = L.rectangle(L.latLngBounds(boxStart, boxStart), {
    color: "#333366",
    weight: 1.5,
    fillColor: "#333366",
    fillOpacity: 0.12,
    dashArray: "4 3",
  }).addTo(map);
  if (map.dragging) map.dragging.disable();
  refreshMeta();
  renderEditor();
  renderList();
  restyleStops();
}

function moveBoxSelect(ev) {
  if (!boxStart || !boxRect) return;
  boxRect.setBounds(L.latLngBounds(boxStart, eventLatLng(ev)));
}

function finishBoxSelect(ev) {
  if (!boxStart) return;
  const end = ev ? eventLatLng(ev) : boxStart;
  const startPoint = map.latLngToContainerPoint(boxStart);
  const endPoint = map.latLngToContainerPoint(end);
  const bounds = L.latLngBounds(boxStart, end);
  const lm = loc.landmarks.find((item) => item.id === boxLmId);
  boxStart = null;
  boxLmId = "";
  if (boxRect) {
    boxRect.remove();
    boxRect = null;
  }
  if (map.dragging) map.dragging.enable();
  const dragged = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y) >= 8;
  if (!lm || !dragged) {
    redraw();
    return;
  }
  const stops = lm.stops || (lm.stops = []);
  for (const stop of allStops()) {
    const g = pack.geo[stop.code];
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    if (bounds.contains([g.lat, g.lon]) && !stops.includes(stop.code)) stops.push(stop.code);
  }
  saveLocal();
  redraw();
}

function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true }).setView([43.073, -89.401], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
  const el = map.getContainer();
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("mousemove", (e) => {
    if (boxStart) moveBoxSelect(e);
  });
  window.addEventListener("mouseup", (e) => {
    if (boxStart) finishBoxSelect(e);
  });
  ensureStopMarkers();
  setTimeout(() => map.invalidateSize(), 0);
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function searchStops(query) {
  const stops = allStops();
  const raw = query.trim();
  if (!raw) return [];
  const exact = stops.filter((s) => s.code === raw || s.code.replace(/^0+/, "") === raw.replace(/^0+/, ""));
  if (/^\d{3,5}$/.test(raw) && exact.length) return exact.slice(0, 8);
  const nq = norm(raw);
  const scored = [];
  for (const s of stops) {
    const name = norm(s.name);
    const code = s.code.toLowerCase();
    let score = 0;
    if (code === raw.toLowerCase()) score = 100;
    else if (code.startsWith(raw.toLowerCase())) score = 80;
    else if (name.startsWith(nq)) score = 60;
    else if (name.includes(nq)) score = 40;
    else if (norm(s.street).includes(nq)) score = 20;
    if (score) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, 12).map((x) => x.s);
}

function routePills(routes) {
  return (routes || [])
    .map((r) => `<span class="pill" style="background:${r.c};color:${r.t}">${S.escapeHtml(r.n)}</span>`)
    .join("");
}

function renderSearch(list) {
  if (!list.length) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    return;
  }
  resultsEl.hidden = false;
  resultsEl.innerHTML = list
    .map((s) => {
      const dir = s.dir ? `<span class="dir">${S.escapeHtml(s.dir)}</span>` : "";
      return `<button type="button" class="result" data-code="${S.escapeHtml(s.code)}">
        <div><span class="name">${S.escapeHtml(s.name)}</span><span class="code">#${S.escapeHtml(s.code)}</span></div>
        <div class="lines">${routePills(s.routes)}${dir}</div>
      </button>`;
    })
    .join("");
}

function jumpToStop(code) {
  const g = pack.geo[code];
  if (g && Number.isFinite(g.lat)) map.setView([g.lat, g.lon], 16);
}

nameEl.addEventListener("input", () => {
  const lm = selected();
  if (!lm) return;
  lm.label = nameEl.value;
  saveLocal();
  renderList();
  redrawPins();
});

iconsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-set-icon]");
  const lm = selected();
  if (!btn || !lm) return;
  lm.icon = btn.dataset.setIcon || "landmark";
  saveLocal();
  redraw();
});

listEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-lm]");
  if (!btn) return;
  selectLandmark(btn.dataset.lm);
  const lm = selected();
  if (lm && Number.isFinite(lm.lat)) map.setView([lm.lat, lm.lon], Math.max(map.getZoom(), 15));
});

document.getElementById("lm-delete").addEventListener("click", () => {
  if (!selectedId) return;
  loc.landmarks = loc.landmarks.filter((lm) => lm.id !== selectedId);
  selectedId = "";
  saveLocal();
  redraw();
});

const clearAllBtn = document.getElementById("clear-all");
function resetClearAll() {
  pendingClear = false;
  clearAllBtn.textContent = "Clear all landmarks";
  clearAllBtn.classList.remove("danger");
}
clearAllBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!loc.landmarks.length) return;
  if (!pendingClear) {
    pendingClear = true;
    clearAllBtn.textContent = "Confirm clear all";
    clearAllBtn.classList.add("danger");
    return;
  }
  loc.landmarks = [];
  selectedId = "";
  saveLocal();
  resetClearAll();
  redraw();
});
document.addEventListener("click", (e) => {
  if (pendingClear && !e.target.closest("#clear-all")) resetClearAll();
});

qEl.addEventListener("input", () => renderSearch(searchStops(qEl.value)));
qEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const first = resultsEl.querySelector("[data-code]");
  if (!first) return;
  e.preventDefault();
  first.click();
});

resultsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-code]");
  if (!btn) return;
  const stop = allStops().find((s) => s.code === btn.dataset.code);
  resultsEl.hidden = true;
  if (stop) qEl.value = `${stop.name}  #${stop.code}`;
  jumpToStop(btn.dataset.code);
});

document.getElementById("download").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(loc, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "locations.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("import").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    loc = S.migrateLocations(JSON.parse(await file.text()), pack);
    selectedId = "";
    saveLocal();
    redraw();
  } catch (err) {
    showErr(err.message || String(err));
  }
  e.target.value = "";
});

async function loadGzipJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Stop data missing. Run node github-stops-served/build-data.js");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const gzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  let text;
  if (gzip) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

showErr("Loading…");
Promise.all([
  loadGzipJson("data/served.json.gz"),
  fetch("data/locations.json")
    .then((r) => (r.ok ? r.json() : { reviewed: [], landmarks: [] }))
    .catch(() => ({ reviewed: [], landmarks: [] })),
])
  .then(([data, file]) => {
    pack = data;
    const local = loadLocal();
    const hasLocal =
      local &&
      ((Array.isArray(local.landmarks) && local.landmarks.length) ||
        (local.stops && Object.keys(local.stops).length));
    loc = S.migrateLocations(hasLocal ? local : file || {}, pack);
    saveLocal();
    showErr("");
    ensureMap();
    redraw();
  })
  .catch((e) => showErr(e.message || String(e)));
