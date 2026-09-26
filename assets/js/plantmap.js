/* ==========================================================================
   plantmap.js — the national plant map above the Power Plant Browser's menus.

   Leaflet (loaded from cdnjs in plants.html, pinned with an integrity hash) on
   OpenStreetMap tiles, desaturated in the stylesheet. All ~14,500 plants draw on one canvas layer, which
   stays fast where 14,500 SVG circles would not. The dropdowns below the map
   remain the keyboard- and screen-reader-accessible way to pick a plant; the
   map is an additional way in, never the only one.

   Plant names come from EIA and enter the DOM through textContent only.
   ========================================================================== */

const US_BOUNDS = [[24.4, -125.0], [49.5, -66.9]];   // the lower 48

/** Dot radius in px from capacity: area tracks MW, clamped so every plant stays hittable. */
const radiusFor = (mw) => Math.max(2.2, Math.min(13, 1.8 + Math.sqrt(mw || 0) * 0.32));

/**
 * host:     the element the map fills
 * data:     data/plants/points.json
 * colorOf:  energy-source key -> CSS colour
 * labelOf:  energy-source key -> display label
 * onSelect: (state, plantId) => void, called when a dot is clicked
 * Returns null when Leaflet is unavailable, so the page can carry on without a map.
 */
export function createPlantMap(host, data, { colorOf, labelOf, onSelect, legendHost, countHost }) {
  const L = window.L;
  if (!L) return null;

  const F = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  const rows = data.plants;
  const byId = new Map(rows.map((r) => [`${r[F.state]}/${r[F.id]}`, r]));

  const map = L.map(host, {
    preferCanvas: true,
    zoomSnap: 0.5,
    minZoom: 3,
    maxZoom: 15,
    // Scroll-to-zoom only once the map has been clicked, so scrolling the page
    // past the map never gets captured by it.
    scrollWheelZoom: false,
    // One-finger drag on a phone would trap page scrolling; pinch still zooms.
    dragging: !L.Browser.mobile,
    worldCopyJump: false,
  });
  map.fitBounds(US_BOUNDS);
  // OpenStreetMap's standard tiles need no key, only attribution (tile usage
  // policy: https://operations.osmfoundation.org/policies/tiles/). The stylesheet
  // desaturates them to a quiet grey, so the source colours on the dots carry
  // the map; see .plantmap .leaflet-tile-pane.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  map.on("click focus", () => map.scrollWheelZoom.enable());
  map.on("mouseout blur", () => map.scrollWheelZoom.disable());

  // a generous hit tolerance, so a 2px solar dot is still easy to land on
  const renderer = L.canvas({ padding: 0.4, tolerance: 5 });

  // one layer group per (source, operating?) pair, so the legend can filter
  const groups = new Map();
  const counts = new Map();
  for (const r of rows) {
    const key = data.detail_order[r[F.primary]];
    const active = r[F.active] === 1;
    const gk = `${key}|${active ? 1 : 0}`;
    if (!groups.has(gk)) groups.set(gk, L.layerGroup());
    counts.set(key, (counts.get(key) || 0) + (active ? 1 : 0));

    const m = L.circleMarker([r[F.lat], r[F.lon]], {
      renderer,
      radius: radiusFor(r[F.capacity_mw]),
      // the 1px surface-colour ring keeps overlapping dots legible
      color: "#ffffff", weight: 0.8, opacity: active ? 0.9 : 0.5,
      fillColor: colorOf(key), fillOpacity: active ? 0.85 : 0.3,
    });
    m.bindTooltip(() => tipFor(r), { className: "planttip", direction: "top", offset: [0, -6] });
    m.on("click", () => onSelect(r[F.state], r[F.id]));
    groups.get(gk).addLayer(m);
  }

  function tipFor(r) {
    const el = document.createElement("div");
    const t = document.createElement("div");
    t.className = "planttip__title";
    t.textContent = r[F.name];
    const s = document.createElement("div");
    const mw = r[F.capacity_mw];
    s.textContent = [data.fuel_labels[r[F.fuel_label]],
      mw ? `${mw.toLocaleString("en-US", { maximumFractionDigits: mw < 10 ? 1 : 0 })} MW` : null,
      r[F.state], r[F.active] ? null : "retired"].filter(Boolean).join(" · ");
    el.append(t, s);
    return el;
  }

  // ---- filters: one toggle per energy source, plus retired plants ----
  const shown = new Set(data.detail_order.filter((k) => counts.has(k) || groups.has(`${k}|0`)));
  let showRetired = true;

  function apply() {
    let n = 0;
    for (const [gk, g] of groups) {
      const [key, active] = gk.split("|");
      const on = shown.has(key) && (active === "1" || showRetired);
      if (on) { g.addTo(map); n += g.getLayers().length; } else g.remove();
    }
    if (countHost) countHost.textContent = `${n.toLocaleString("en-US")} plants shown`;
  }

  if (legendHost) {
    legendHost.textContent = "";
    for (const key of data.detail_order) {
      if (!shown.has(key)) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", "true");
      const i = document.createElement("i");
      i.style.background = colorOf(key);
      const txt = document.createElement("span");
      txt.textContent = labelOf(key);
      const c = document.createElement("b");
      c.textContent = (counts.get(key) || 0).toLocaleString("en-US");
      b.append(i, txt, c);
      b.title = `Show or hide ${labelOf(key).toLowerCase()} plants`;
      b.addEventListener("click", () => {
        if (shown.has(key)) shown.delete(key); else shown.add(key);
        b.setAttribute("aria-pressed", String(shown.has(key)));
        apply();
      });
      legendHost.appendChild(b);
    }
    const r = document.createElement("button");
    r.type = "button";
    r.className = "maplegend__retired";
    r.setAttribute("aria-pressed", "true");
    const i = document.createElement("i");
    const txt = document.createElement("span");
    txt.textContent = "Retired plants";
    r.append(i, txt);
    r.addEventListener("click", () => {
      showRetired = !showRetired;
      r.setAttribute("aria-pressed", String(showRetired));
      apply();
    });
    legendHost.appendChild(r);
  }
  apply();

  // ---- selection ring, on its own pane so it always sits above the dots ----
  map.createPane("selected").style.zIndex = 450;
  const ring = L.circleMarker([0, 0], {
    pane: "selected", renderer: L.svg({ pane: "selected" }), interactive: false,
    radius: 10, color: "#191e3a", weight: 2.5, fill: false, opacity: 0,
  }).addTo(map);

  return {
    map,
    /** Mark a plant as selected; `view` is "none", "pan" (keep zoom) or "zoom" (close in). */
    select(state, id, { view = "none", animate = true } = {}) {
      const r = byId.get(`${state}/${id}`);
      if (!r) { ring.setStyle({ opacity: 0 }); return false; }
      const ll = [r[F.lat], r[F.lon]];
      ring.setLatLng(ll).setRadius(radiusFor(r[F.capacity_mw]) + 5).setStyle({ opacity: 1 });
      if (view === "zoom") map.flyTo(ll, Math.max(map.getZoom(), 9), { animate, duration: 0.9 });
      else if (view === "pan" && !map.getBounds().pad(-0.1).contains(ll)) map.panTo(ll, { animate });
      return true;
    },
    /** Frame every plant in a state. */
    fitState(state, { animate = true } = {}) {
      const pts = rows.filter((r) => r[F.state] === state);
      if (!pts.length) return;
      // Frame the middle 98% of a large state's plants: EIA has the odd plant
      // filed under one state with coordinates in another (a "Florida" solar farm
      // sitting in Wisconsin), and one stray point would zoom the view right out.
      const trim = pts.length >= 50 ? Math.floor(pts.length * 0.01) : 0;
      const q = (k) => pts.map((r) => r[k]).sort((a, b) => a - b).slice(trim, pts.length - trim);
      const la = q(F.lat), lo = q(F.lon);
      const b = L.latLngBounds([la[0], lo[0]], [la.at(-1), lo.at(-1)]).pad(0.08);
      map.flyToBounds(b, { maxZoom: 9, animate, duration: 0.9 });
    },
    invalidate() { map.invalidateSize(); },
  };
}
