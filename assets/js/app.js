/* ==========================================================================
   app.js — 50 States of Electricity
   Loads the pre-built EIA dataset from /data and renders the dashboard.
   Static: no API key in the browser, no server, no third-party libraries.
   ========================================================================== */

// The ?v= must match the one on this file in index.html. Versioning only the
// entry point is not enough: the browser caches this import separately, so a
// new app.js could load against a stale charts.js and fail at import time —
// which no try/catch inside the module can see. Bump both together.
import { treemap, hbar, stackedRows, stackedBar, clear, onResize, hideTip, pctLabel }
  from "./charts.js?v=5";

const DATA = "./data";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- state ---------- */
const S = {
  index: null,
  meta: null,
  geo: null,          // currently loaded us.json or state/XX.json
  code: "US",
  basis: "elec",      // "elec" = fuel burned for electricity | "all" = all fuel burned
  mixView: "chart",
  rankSort: "carbon_free_pct",
  srcKey: "wind",        // selected energy-source tab
  srcMetric: "gwh",      // "gwh" = total generation | "share" = % of state's mix
  srcView: "chart",
  demandMetric: "consumed",
  plantSort: { key: "gen_mwh", dir: -1 },
  plantQuery: "",
  plantLimit: 100,
};

/* ---------- formatting ---------- */
const nf = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n)
  ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));

/**
 * MWh -> a value carrying its own unit, e.g. "1,870 TWh" / "413 GWh".
 * Whole numbers at every scale: these appear in ranked lists where a column of
 * round figures is easier to compare than one carrying a spurious decimal.
 * energyParts() returns the value and unit separately for the hero figure.
 */
/**
 * Only step up to TWh from 10 TWh, not 1 TWh. Whole numbers below that would
 * cost real accuracy — Vermont's 2,504 GWh would read as "3 TWh", off by a
 * fifth — so the smaller unit carries it instead.
 */
const TWH_FLOOR = 1e7;   // MWh

function energyParts(v) {
  const a = Math.abs(v);
  if (a >= TWH_FLOOR) return { value: nf(v / 1e6, 0), unit: "TWh" };
  if (a >= 1e3) return { value: nf(v / 1e3, 0), unit: "GWh" };
  return { value: nf(v, 0), unit: "MWh" };
}
function energy(v) {
  const p = energyParts(v);
  return `${p.value} ${p.unit}`;
}
const mwh = energy;                              // treemap tiles use the same format
/** MWh -> whole GWh. */
const gwh = (v, d = 0) => nf(v / 1e3, d);
/**
 * Tonnes of CO2 -> a whole number with the unit that makes it whole. Switching to
 * kilotonnes below 10 Mt keeps small states honest: Vermont's 11,700 t would
 * otherwise round to "0.0 Mt".
 */
function co2(t) {
  const a = Math.abs(t);
  if (a >= 1e7) return { value: nf(t / 1e6, 0), unit: "Mt" };
  return { value: nf(t / 1e3, 0), unit: "kt" };
}
const co2Str = (t) => { const c = co2(t); return `${c.value} ${c.unit}`; };
const pct = pctLabel;

/**
 * Colour for an energy source. Every source has its own hue now, so nothing is
 * folded into a shared "Other" bucket; pumped storage deliberately shares
 * hydro's blue. Read from CSS so the palette lives in one place.
 */
const cssVar = (name, fallback = "#8a8f9a") =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const sourceColor = (key) => cssVar(`--fuel-${key}`);
/** Supply/disposition categories are not energy sources; they have their own scale. */
const flowColor = (key) => cssVar(`--flow-${key}`);

/* ---------- data loading ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}
const geoURL = (code) => (code === "US" ? `${DATA}/us.json` : `${DATA}/state/${code}.json`);

/* ==========================================================================
   Render: headline figure + stat tiles
   ========================================================================== */
function renderHeadline() {
  const g = S.geo;
  const co2t = S.basis === "all" ? g.co2.estimate_all_fuel_t : g.co2.estimate_t;
  const intensity = g.total_mwh > 0 ? (co2t * 1000) / g.total_mwh : null;

  // The unit travels with the figure so the number itself stays whole — DC's
  // 0.4 TWh reads as "397 GWh" rather than rounding away to "0 TWh".
  const total = energyParts(g.total_mwh);
  $("#heroValue").textContent = total.value;
  $("#heroUnit").textContent = total.unit;

  const sub = $("#heroSub");
  clear(sub);
  sub.append(
    document.createTextNode(`${energy(g.utility_scale_mwh)} utility-scale, plus `),
    Object.assign(document.createElement("b"),
      { textContent: energy(g.small_scale_solar_mwh) }),
    document.createTextNode(" estimated behind-the-meter solar."),
  );

  const tiles = [
    {
      label: "Carbon-free share", value: nf(g.carbon_free_pct, g.carbon_free_pct >= 10 ? 0 : 1), unit: "%",
      meter: g.carbon_free_pct, foot: "Nuclear + all renewables",
    },
    {
      label: "Renewable share", value: nf(g.renewable_pct, g.renewable_pct >= 10 ? 0 : 1), unit: "%",
      meter: g.renewable_pct, foot: "Incl. small-scale solar",
    },
    {
      label: "Fossil share", value: nf(g.fossil_pct, g.fossil_pct >= 10 ? 0 : 1), unit: "%",
      meter: g.fossil_pct, foot: "Coal, gas, petroleum, other gases",
    },
    {
      label: "Estimated CO₂", value: co2(co2t).value, unit: co2(co2t).unit,
      foot: S.basis === "all" ? "All fuel burned" : "Fuel burned for electricity",
    },
    {
      label: "Carbon intensity", value: nf(intensity, 0), unit: "kg/MWh",
      foot: "Estimated CO₂ ÷ total generation",
    },
    {
      label: "Power plants", value: nf(g.plant_count), unit: "",
      foot: g.plants_truncated ? "Reporting to EIA-923" : "Reporting generation in 2024",
    },
  ];

  const host = $("#tiles");
  clear(host);
  for (const t of tiles) {
    const d = document.createElement("div");
    d.className = "tile";
    const lab = document.createElement("div");
    lab.className = "tile__label";
    lab.textContent = t.label;
    const val = document.createElement("div");
    val.className = "tile__value";
    val.textContent = t.value;
    if (t.unit) {
      const s = document.createElement("small");
      s.textContent = t.unit;
      val.appendChild(s);
    }
    d.append(lab, val);
    if (typeof t.meter === "number") {
      const m = document.createElement("div");
      m.className = "tile__meter";
      const i = document.createElement("i");
      i.style.width = `${Math.max(0, Math.min(100, t.meter))}%`;
      m.appendChild(i);
      d.appendChild(m);
    }
    const f = document.createElement("div");
    f.className = "tile__foot";
    f.textContent = t.foot;
    d.appendChild(f);
    host.appendChild(d);
  }
}

/* ==========================================================================
   Render: generation mix (treemap + bars + table twin)
   ========================================================================== */
function mixRows() {
  return S.geo.sources.map((s) => ({
    key: s.key, label: s.label, value: s.mwh, color: sourceColor(s.key),
  }));
}

function renderMix() {
  const rows = mixRows();
  const posTotal = rows.filter((r) => r.value > 0).reduce((s, r) => s + r.value, 0);
  const negatives = rows.filter((r) => r.value < 0);

  // ---- treemap: one tile per energy source ----
  const tmItems = rows.filter((r) => r.value > 0).map((r) => ({
    label: r.label, value: r.value, color: r.color,
    sub: r.key === "solar_small_scale"
      ? "EIA model estimate of distributed solar under 1 MW — not metered plant output."
      : null,
  }));
  treemap($("#mixTreemap"), tmItems, { height: 356, fmt: mwh });

  // ---- single stacked bar: the mix in one line ----
  stackedBar($("#mixBar"), rows.filter((r) => r.value > 0)
    .map((r) => ({ label: r.label, value: r.value, color: r.color })), { fmt: mwh });

  // ---- ranked bars with direct value labels ----
  hbar($("#mixBars"), rows.slice().sort((a, b) => b.value - a.value).map((r) => ({
    key: r.key, label: r.label, value: r.value, color: r.color,
    sub: r.value > 0 ? `${pctLabel((r.value / posTotal) * 100)} of generation` : "net negative",
  })), { fmt: energy, labelW: 208, rowH: 30 });

  // ---- legend (always present; identity never colour-alone) ----
  const leg = $("#mixLegend");
  clear(leg);
  for (const r of rows.slice().sort((a, b) => b.value - a.value)) {
    const li = document.createElement("li");
    const i = document.createElement("i");
    i.style.background = r.color;
    const name = document.createElement("span");
    name.textContent = `${r.label} `;
    const b = document.createElement("b");
    b.textContent = r.value > 0 ? pctLabel((r.value / posTotal) * 100) : "net −";
    li.append(i, name, b);
    leg.appendChild(li);
  }

  // ---- negative-value footnote (treemaps cannot show negatives) ----
  const note = $("#mixNote");
  if (negatives.length) {
    note.textContent = `${negatives.map((n) => n.label).join(" and ")} `
      + `${negatives.length > 1 ? "are" : "is"} net negative here `
      + `(${negatives.map((n) => `${nf(n.value)} MWh`).join("; ")}), so `
      + `${negatives.length > 1 ? "they are" : "it is"} shown in the ranked bars and the table but `
      + `omitted from the treemap and shares above.`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  // ---- table twin ----
  const tb = $("#mixTableBody");
  clear(tb);
  for (const r of rows.slice().sort((a, b) => b.value - a.value)) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = r.color;
    th.append(sw, document.createTextNode(r.label));
    const c1 = document.createElement("td");
    c1.className = "num";
    c1.textContent = nf(r.value);
    const c2 = document.createElement("td");
    c2.className = "num";
    c2.textContent = r.value > 0 ? pctLabel((r.value / posTotal) * 100) : "—";
    tr.append(th, c1, c2);
    tb.appendChild(tr);
  }
  $("#mixTableCaption").textContent =
    `${S.geo.name}, 2024 net generation by energy source. Shares are of positive generation `
    + `(${nf(posTotal)} MWh). Source: EIA Form EIA-923 via the EIA API.`;
}

/* ==========================================================================
   Render: state comparison (100% stacked rows, all 51)
   ========================================================================== */
const RANK_SORTS = {
  carbon_free_pct: { label: "Carbon-free share", fmt: (r) => pct(r.carbon_free_pct) },
  renewable_pct: { label: "Renewable share", fmt: (r) => pct(r.renewable_pct) },
  fossil_pct: { label: "Fossil share", fmt: (r) => pct(r.fossil_pct) },
  total_mwh: { label: "Total generation", fmt: (r) => energy(r.total_mwh) },
  co2_kg_per_mwh: { label: "Carbon intensity", fmt: (r) => `${nf(r.co2_kg_per_mwh, 0)} kg/MWh` },
  name: { label: "State name", fmt: (r) => pct(r.carbon_free_pct) },
};

function renderRanking() {
  const key = S.rankSort;
  const rows = S.index.states.slice().sort((a, b) => {
    if (key === "name") return a.name.localeCompare(b.name);
    return (b[key] ?? -Infinity) - (a[key] ?? -Infinity);
  });
  const spec = RANK_SORTS[key];

  stackedRows($("#rankChart"), rows.map((r) => ({
    key: r.code, label: r.name, total: r.total_mwh, src: r,
    // Every source has its own colour now, so segments and hover readout are the
    // same list — there is no shared "Other" bucket left to disambiguate.
    parts: (r.sources || []).map((s) => ({
      key: s.key, label: s.label, value: s.mwh, color: sourceColor(s.key),
    })),
  })), {
    labelW: 138, rowH: 23, fmt: (v) => energy(v),
    highlight: S.code === "US" ? null : S.code,
    // trailFmt receives the row, so read the metric off its original index record
    trailW: 104, trailFmt: (row) => spec.fmt(row.src), trailLabel: "Total generation",
    onClick: (r) => selectGeo(r.key),
  });

  sourceLegend($("#rankLegend"));
  $("#rankCaption").textContent =
    `All 50 states and the District of Columbia, 2024, ordered by ${spec.label.toLowerCase()}. `
    + `Each row is that state's own generation mix as a share of its total. `
    + `Select a row to open that state, or hover any row for its full breakdown. `
    + `Pumped storage shares hydro's colour.`;
}

/** Legend for the energy sources, in the documented source order. */
function sourceLegend(host) {
  clear(host);
  for (const key of S.index.detail_order) {
    const li = document.createElement("li");
    const i = document.createElement("i");
    i.style.background = sourceColor(key);
    const s = document.createElement("span");
    s.textContent = S.index.detail_labels[key];
    li.append(i, s);
    host.appendChild(li);
  }
}

/* ==========================================================================
   Render: by energy source — rank all states on one source
   ========================================================================== */
/** [{ code, name, mwh, share, total }] for one detailed source, across states. */
function sourceRows(key) {
  const out = [];
  for (const s of S.index.states) {
    const row = (s.sources || []).find((x) => x.key === key);
    const mwh = row ? row.mwh : 0;
    const pos = (s.sources || []).reduce((a, x) => a + (x.mwh > 0 ? x.mwh : 0), 0);
    out.push({
      code: s.code, name: s.name, mwh,
      share: pos > 0 ? (mwh / pos) * 100 : 0,
      total: s.total_mwh,
    });
  }
  return out;
}

function renderSourceTabs() {
  const host = $("#srcTabs");
  clear(host);
  for (const key of S.index.detail_order) {
    // only offer sources that actually generated somewhere
    const any = S.index.states.some((s) => (s.sources || []).some((x) => x.key === key && x.mwh !== 0));
    if (!any) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(key === S.srcKey));
    b.dataset.key = key;
    const i = document.createElement("i");
    i.style.background = sourceColor(key);
    const t = document.createElement("span");
    t.textContent = S.index.detail_labels[key];
    b.append(i, t);
    b.addEventListener("click", () => { S.srcKey = key; renderSourceRank(); });
    host.appendChild(b);
  }
}

function renderSourceRank() {
  // keep tab selection in sync
  for (const b of $$("#srcTabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.key === S.srcKey));
  }
  for (const b of $$("#srcMetric button")) {
    b.setAttribute("aria-pressed", String(b.dataset.metric === S.srcMetric));
  }

  const label = S.index.detail_labels[S.srcKey];
  const color = sourceColor(S.srcKey);
  const byGwh = S.srcMetric === "gwh";
  const rows = sourceRows(S.srcKey)
    .filter((r) => r.mwh !== 0)
    .sort((a, b) => (byGwh ? b.mwh - a.mwh : b.share - a.share));

  $("#srcRankHeading").textContent = byGwh
    ? `States by total ${label.toLowerCase()} generation`
    : `States by ${label.toLowerCase()} as a share of their own mix`;

  const natTotal = sourceRows(S.srcKey).reduce((a, r) => a + r.mwh, 0);
  $("#srcRankNote").textContent = byGwh
    ? `Total generation from ${label.toLowerCase()} in 2024, in gigawatt-hours. `
      + `${rows.length} states generated from this source; the national total was ${gwh(natTotal)} GWh.`
    : `${label} as a percentage of each state's own total generation. This is the same data ranked `
      + `a different way — a small state can top this list while barely registering on total output.`;

  hbar($("#srcRankChart"), rows.map((r) => ({
    key: r.code,
    label: r.name,
    value: byGwh ? r.mwh / 1e3 : r.share,
    color,
    sub: byGwh ? `${pctLabel(r.share)} of ${r.name}'s generation`
               : `${gwh(r.mwh)} GWh of ${gwh(r.total)} GWh total`,
    meta: S.srcKey === "solar_small_scale"
      ? "EIA model estimate of distributed solar under 1 MW." : null,
  })), {
    fmt: byGwh ? (v) => `${nf(v, 0)} GWh` : (v) => pctLabel(v),
    labelW: 150, rowH: 26,
    highlight: S.code === "US" ? null : S.code,
    onClick: (d) => selectGeo(d.key),
  });

  // table twin
  const tb = $("#srcTableBody");
  clear(tb);
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const rank = document.createElement("td");
    rank.className = "num t-muted";
    rank.textContent = String(i + 1);
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = r.name;
    const c1 = document.createElement("td");
    c1.className = "num";
    c1.textContent = gwh(r.mwh);
    const c2 = document.createElement("td");
    c2.className = "num";
    c2.textContent = pctLabel(r.share);
    const c3 = document.createElement("td");
    c3.className = "num t-muted";
    c3.textContent = gwh(r.total);
    tr.append(rank, th, c1, c2, c3);
    tb.appendChild(tr);
  });
  $("#srcTableCaption").textContent =
    `${label}, 2024, by state — ranked by ${byGwh ? "total generation" : "share of the state's own mix"}. `
    + `Source: EIA Form EIA-923 via the EIA API.`;
}

/* ==========================================================================
   Render: demand & interstate trade
   ========================================================================== */
const DEMAND_METRICS = {
  consumed: {
    label: "Demand (GWh)", get: (d) => d.consumed_mwh / 1e3,
    fmt: (v) => `${nf(v, 0)} GWh`,
    note: "Electricity used by customers in 2024 — retail sales to end users plus on-site "
        + "generation consumed directly by commercial and industrial facilities.",
  },
  share: {
    label: "Import dependence (%)", get: (d) => d.import_share_pct,
    fmt: (v) => pctLabel(v),
    note: "Net imports as a share of all electricity the state had available. Negative bars are net "
        + "exporters — they sent more out than they brought in.",
  },
  net: {
    label: "Net imports (GWh)", get: (d) => d.net_imports_mwh / 1e3,
    fmt: (v) => `${nf(v, 0)} GWh`,
    note: "Net electricity brought in from other states plus net international trade. Negative bars "
        + "are net exporters.",
  },
};

function renderDemand() {
  const d = S.geo.demand;
  const host = $("#demandGrid");
  clear(host);

  if (!d) {
    $("#demandBalance").innerHTML = '<p class="empty">No supply and disposition data for this geography.</p>';
    $("#depValue").textContent = "—";
    $("#depSub").textContent = "";
    $("#demandBalanceNote").textContent = "";
    return;
  }

  const isUS = S.code === "US";

  // ---- supply/disposition as two stacked bars ----
  $("#demandBalanceNote").textContent =
    `Both bars total the same amount, ${gwh(d.available_mwh)} GWh. The top bar is where the `
    + `electricity came from, the bottom is where it went.`;

  const supplyParts = [
    { label: "In-state generation", value: d.generation_mwh, color: flowColor("generation") },
    { label: isUS ? "Net imports from Canada & Mexico" : "Net imports from other states",
      value: Math.max(0, isUS ? d.net_intl_imports_mwh : d.net_interstate_imports_mwh),
      color: flowColor("imports") },
  ];
  if (!isUS && d.net_intl_imports_mwh > 0) {
    supplyParts.push({ label: "Net international imports",
                       value: d.net_intl_imports_mwh, color: flowColor("direct") });
  }
  const dispositionParts = [
    { label: "Retail sales to customers", value: d.retail_sales_mwh, color: flowColor("retail") },
    { label: "Direct use on site", value: d.direct_use_mwh, color: flowColor("direct") },
    { label: "Transmission & distribution losses", value: d.losses_mwh, color: flowColor("losses") },
  ];
  const exported = -Math.min(0, isUS ? d.net_intl_imports_mwh : d.net_interstate_imports_mwh);
  if (exported > 0) {
    dispositionParts.push({ label: "Net exports", value: exported, color: flowColor("exports") });
  }
  if (d.unaccounted_mwh > 0) {
    dispositionParts.push({ label: "Unaccounted", value: d.unaccounted_mwh, color: flowColor("unaccounted") });
  }

  const wrap = $("#demandBalance");
  clear(wrap);
  for (const [title, parts] of [["Supply", supplyParts], ["Disposition", dispositionParts]]) {
    const h = document.createElement("p");
    h.className = "card__note";
    h.style.margin = "10px 0 4px";
    h.textContent = title;
    const box = document.createElement("div");
    box.className = "chart";
    wrap.append(h, box);
    stackedBar(box, parts.filter((p) => p.value > 0), { fmt: (v) => `${gwh(v)} GWh`, height: 38 });
  }

  // ---- key figures ----
  const items = [
    { dt: "Electricity demand", dd: `${gwh(d.consumed_mwh, 0)} GWh`,
      small: "Retail sales plus direct use." },
    { dt: "In-state generation", dd: `${gwh(d.generation_mwh, 0)} GWh`,
      small: "What the state's own plants produced." },
    { dt: d.net_imports_mwh >= 0 ? "Net imports" : "Net exports",
      dd: `${gwh(Math.abs(d.net_imports_mwh), 0)} GWh`,
      small: isUS ? "International trade only; interstate flows net out."
                  : "Interstate plus international, net." },
    { dt: "Losses in delivery", dd: `${gwh(d.losses_mwh, 0)} GWh`,
      small: `${pctLabel(d.losses_mwh / d.available_mwh * 100)} of electricity available.` },
  ];
  for (const it of items) {
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = it.dt;
    const dd = document.createElement("dd");
    dd.textContent = it.dd;
    const sm = document.createElement("small");
    sm.textContent = it.small;
    dd.appendChild(sm);
    div.append(dt, dd);
    host.appendChild(div);
  }

  // ---- trade position hero. Label follows the direction of trade: calling a
  // net exporter's figure "import dependence" would state the opposite of fact.
  const share = d.import_share_pct;
  const imp = d.is_net_importer;
  $("#depTitle").textContent = imp ? "Import dependence" : "Net export position";
  $("#depLabel").textContent = imp
    ? "Net imports as a share of electricity used"
    : "Net exports as a share of electricity generated";
  $("#depValue").textContent = share === null ? "—" : nf(Math.abs(share), 1);

  const sub = $("#depSub");
  clear(sub);
  if (share !== null) {
    const b = document.createElement("b");
    b.textContent = imp ? "net importer" : "net exporter";
    sub.append(
      document.createTextNode(`${S.geo.name} was a `), b,
      document.createTextNode(imp
        ? ` in 2024, bringing in ${gwh(d.net_imports_mwh, 0)} GWh more than it sent out.`
        : ` in 2024, sending out ${gwh(-d.net_imports_mwh, 0)} GWh more than it brought in.`),
    );
  }
  $("#demandDepNote").textContent = imp
    ? "How much of the electricity used here had to come from outside the state."
    : "This state generated more than it used, so it had no net import need.";

  $("#depCaveat").textContent =
    "EIA publishes each state's NET position, not state-to-state flows, so this dashboard does not "
    + "claim to name the origin states. Power moves across an interconnected grid run by balancing "
    + "authorities whose territories cross state lines — PJM alone spans 13 states — so a "
    + "state-to-state matrix cannot be derived from published state totals without inventing it. "
    + "EIA's hourly balancing-authority interchange series is the closest real directional data, but "
    + "it is authority-to-authority rather than state-to-state.";

  renderDemandRank();
}

function renderDemandRank() {
  const spec = DEMAND_METRICS[S.demandMetric];
  for (const b of $$("#demandMetric button")) {
    b.setAttribute("aria-pressed", String(b.dataset.metric === S.demandMetric));
  }
  $("#demandRankNote").textContent = spec.note;

  const rows = S.index.states
    .filter((s) => s.demand && spec.get(s.demand) !== null)
    .map((s) => ({ code: s.code, name: s.name, v: spec.get(s.demand), d: s.demand }))
    .sort((a, b) => b.v - a.v);

  hbar($("#demandRankChart"), rows.map((r) => ({
    key: r.code, label: r.name, value: r.v,
    // one measure, one colour: bar length already carries the magnitude
    color: r.v < 0 ? flowColor("exports") : flowColor("generation"),
    sub: `${gwh(r.d.consumed_mwh, 0)} GWh used · ${gwh(r.d.generation_mwh, 0)} GWh generated`,
    meta: r.d.is_net_importer
      ? `Net importer: ${gwh(r.d.net_imports_mwh, 0)} GWh brought in.`
      : `Net exporter: ${gwh(-r.d.net_imports_mwh, 0)} GWh sent out.`,
  })), {
    fmt: spec.fmt, labelW: 150, rowH: 26,
    highlight: S.code === "US" ? null : S.code,
    onClick: (d) => selectGeo(d.key),
  });
}

/* ==========================================================================
   Render: plants
   ========================================================================== */
const PLANT_COLS = [
  { key: "name", label: "Plant", num: false },
  { key: "operator", label: "Operator", num: false },
  { key: "county", label: "County", num: false },
  { key: "primary", label: "Primary source", num: false },
  { key: "capacity_mw", label: "Capacity MW", num: true, d: 1 },
  { key: "gen_mwh", label: "Generation MWh", num: true, d: 0 },
  { key: "co2_key", label: "Est. CO₂ t", num: true, d: 0 },
  { key: "co2_kg_per_mwh", label: "kg CO₂/MWh", num: true, d: 1 },
];

const co2Of = (p) => (S.basis === "all" ? p.co2_total_t : p.co2_t);

function plantList() {
  const q = S.plantQuery.trim().toLowerCase();
  let list = S.geo.plants || [];
  if (q) {
    list = list.filter((p) =>
      (p.name || "").toLowerCase().includes(q)
      || (p.operator || "").toLowerCase().includes(q)
      || (p.county || "").toLowerCase().includes(q));
  }
  const { key, dir } = S.plantSort;
  const val = (p) => {
    if (key === "co2_key") return co2Of(p);
    if (key === "primary") return S.index.detail_labels[p.primary] || "";
    return p[key];
  };
  // dir === 1 ascending, dir === -1 descending. Missing numbers sort last in
  // both directions by falling to -Infinity.
  return list.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    if (typeof x === "string" || typeof y === "string") {
      return dir * String(x ?? "").localeCompare(String(y ?? ""));
    }
    return dir * ((x ?? -Infinity) - (y ?? -Infinity));
  });
}

function renderPlants() {
  const all = plantList();

  // ---- top plants bar chart ----
  const top = all.slice(0, 15).filter((p) => p.gen_mwh > 0);
  hbar($("#plantChart"), top.map((p) => ({
    key: p.id,
    label: p.name.length > 26 ? `${p.name.slice(0, 25)}…` : p.name,
    value: p.gen_mwh,
    color: sourceColor(p.primary),
    sub: S.index.detail_labels[p.primary] || "",
    meta: [p.operator, p.county ? `${p.county} County` : null, p.state]
      .filter(Boolean).join(" · "),
  })), { fmt: energy, labelW: 200, rowH: 29 });

  $("#plantChartCaption").textContent = all.length
    ? `The ${top.length} largest generators${S.plantQuery ? " matching your search" : ""} in `
      + `${S.geo.name}, by 2024 net generation, coloured by primary energy source.`
    : "No plants match your search.";

  // ---- table ----
  const shown = all.slice(0, S.plantLimit);
  const tb = $("#plantTableBody");
  clear(tb);
  for (const p of shown) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = p.name;
    tr.appendChild(th);

    const add = (val, cls = "") => {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      td.textContent = val;
      tr.appendChild(td);
      return td;
    };
    add(p.operator || "—", p.operator ? "" : "t-muted");
    add(p.county || "—", p.county ? "" : "t-muted");

    const src = document.createElement("td");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = sourceColor(p.primary);
    src.append(sw, document.createTextNode(S.index.detail_labels[p.primary] || p.primary));
    tr.appendChild(src);

    add(p.capacity_mw === null || p.capacity_mw === undefined ? "—" : nf(p.capacity_mw, 0), "num");
    add(nf(p.gen_mwh), "num");
    const c = co2Of(p);
    add(c > 0 ? nf(c) : "—", "num");
    add(p.co2_kg_per_mwh === null || p.co2_kg_per_mwh === undefined || co2Of(p) === 0
      ? "—" : nf(p.co2_kg_per_mwh, 0), "num");
    tb.appendChild(tr);
  }

  $("#plantCount").textContent = all.length > shown.length
    ? `Showing ${nf(shown.length)} of ${nf(all.length)} plants`
    : `${nf(all.length)} plant${all.length === 1 ? "" : "s"}`;
  $("#plantMore").hidden = all.length <= shown.length;

  $("#plantTableCaption").textContent =
    `${S.geo.name}, 2024. Generation from Form EIA-923; operator, county and capacity from the `
    + `December 2024 generator inventory (Form EIA-860M). CO₂ is estimated from fuel consumed `
    + `${S.basis === "all" ? "(all fuel burned, including for useful thermal output)" : "for electricity generation"}`
    + ` — see Methodology. Plants with no combustion show no CO₂.`;

  // sort indicators
  for (const th of $$("#plantTable thead th")) {
    const k = th.dataset.key;
    th.setAttribute("aria-sort", k === S.plantSort.key
      ? (S.plantSort.dir === -1 ? "descending" : "ascending") : "none");
  }
}

/* ==========================================================================
   Render: emissions validation panel
   ========================================================================== */
function renderValidation() {
  const c = S.geo.co2;
  const host = $("#validationGrid");
  clear(host);

  const items = [
    { dt: "Our estimate — electricity only", dd: co2Str(c.estimate_t),
      small: "Fuel burned to generate electricity, summed over every plant." },
    { dt: "Our estimate — all fuel burned", dd: co2Str(c.estimate_all_fuel_t),
      small: "Adds fuel burned for useful thermal output at CHP plants." },
    { dt: "EIA's published figure", dd: co2Str(c.eia_official_t),
      small: "EIA State Electricity Profiles, CO₂ from the electric power sector." },
    { dt: "Agreement", dd: c.ratio_to_official ? pct(c.ratio_to_official * 100) : "—",
      small: "All-fuel estimate as a share of EIA's published figure." },
  ];
  for (const it of items) {
    const d = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = it.dt;
    const dd = document.createElement("dd");
    dd.textContent = it.dd;
    const sm = document.createElement("small");
    sm.textContent = it.small;
    dd.appendChild(sm);
    d.append(dt, dd);
    host.appendChild(d);
  }

  const extra = $("#validationNote");
  clear(extra);
  const bits = [];
  if (c.unattributed_mmbtu > 0) {
    bits.push(`${nf(c.unattributed_mmbtu / 1e6, 0)} million MMBtu of fuel here has no published `
      + `EIA emission factor (geothermal, blast-furnace and other manufactured gases, purchased `
      + `steam, waste heat) and is left unattributed rather than guessed at.`);
  }
  if (c.biogenic_mmbtu > 0) {
    // The exclusion is a convention, not an absence of stack emissions, so name
    // its size rather than just asserting that it happened.
    bits.push(`A further ${nf(c.biogenic_mmbtu / 1e6, 0)} million MMBtu of biomass — wood, black `
      + `liquor, landfill gas, biogenic municipal waste — was burned here and carries no CO₂ in any `
      + `figure above. EIA publishes no electric-power factor for these fuels and excludes biogenic `
      + `carbon from its own state series, so none is estimated; that is an accounting convention, `
      + `not an absence of emissions at the stack.`);
  }
  extra.textContent = bits.join(" ");
  extra.hidden = !bits.length;
}

/* ==========================================================================
   Render: sources & methodology (from meta.json — nothing hard-coded)
   ========================================================================== */
function renderMeta() {
  const m = S.meta;

  const ul = $("#sourceList");
  clear(ul);
  for (const s of m.sources) {
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    const a = document.createElement("a");
    a.href = s.url;
    a.textContent = s.title;
    a.rel = "noopener";
    a.target = "_blank";
    strong.appendChild(a);
    li.appendChild(strong);
    if (s.route) {
      const code = document.createElement("code");
      code.textContent = s.route;
      li.appendChild(code);
      if (s.form) li.appendChild(document.createTextNode(` · ${s.form}`));
    } else if (s.form) {
      li.appendChild(document.createTextNode(s.form));
    }
    const span = document.createElement("span");
    span.textContent = s.used_for;
    li.appendChild(span);
    ul.appendChild(li);
  }

  const meth = $("#methodBodies");
  clear(meth);
  const blocks = [
    ["Generation data", m.methodology.generation],
    ["Behind-the-meter solar", m.methodology.small_scale_solar],
    ["CO₂ estimates", m.methodology.co2],
  ];
  for (const [title, body] of blocks) {
    const d = document.createElement("details");
    d.className = "method";
    const s = document.createElement("summary");
    s.textContent = title;
    const p = document.createElement("div");
    p.className = "method__body";
    p.textContent = body;
    d.append(s, p);
    meth.appendChild(d);
  }
  // caveats
  const d = document.createElement("details");
  d.className = "method";
  const s = document.createElement("summary");
  s.textContent = "What this dashboard does not tell you";
  const body = document.createElement("div");
  body.className = "method__body";
  const list = document.createElement("ul");
  for (const c of m.methodology.caveats) {
    const li = document.createElement("li");
    li.textContent = c;
    list.appendChild(li);
  }
  body.appendChild(list);
  d.append(s, body);
  meth.appendChild(d);

  // The emission-factor table itself lives on emission-factors.html, rendered
  // from this same meta.json by assets/js/factors.js.

  $("#builtStamp").textContent = `Data built ${m.generated_utc.replace("T", " ").replace("Z", " UTC")}`;
}

/* ==========================================================================
   CSV export
   ========================================================================== */
function downloadCSV() {
  const rows = plantList();
  const head = ["plant_id", "plant_name", "state", "operator", "county", "latitude", "longitude",
    "balancing_authority", "primary_energy_source", "nameplate_capacity_mw", "net_generation_mwh",
    "estimated_co2_tonnes_electricity_only", "estimated_co2_tonnes_all_fuel",
    "estimated_kg_co2_per_mwh", "unattributed_mmbtu"];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((p) => [
    p.id, p.name, p.state, p.operator, p.county, p.lat, p.lon, p.ba,
    S.index.detail_labels[p.primary] || p.primary, p.capacity_mw, p.gen_mwh,
    p.co2_t, p.co2_total_t, p.co2_kg_per_mwh, p.co2_unattributed_mmbtu,
  ].map(esc).join(","));

  const note = `# 50 States of Electricity — ${S.geo.name}, 2024`
    + `\n# Generation and fuel: EIA Form EIA-923 via EIA API v2 (electricity/facility-fuel)`
    + `\n# Plant attributes: EIA Form EIA-860M (electricity/operating-generator-capacity)`
    + `\n# CO2 is an estimate: fuel MMBtu x EIA emission factor. See ${location.origin}${location.pathname}#methodology`;

  const blob = new Blob([`${note}\n${head.join(",")}\n${body.join("\n")}\n`],
    { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `50-states-of-electricity-${S.code.toLowerCase()}-2024.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ==========================================================================
   Orchestration
   ========================================================================== */
function renderAll() {
  renderHeadline();
  renderMix();
  renderRanking();
  renderSourceRank();
  renderDemand();
  renderPlants();
  renderValidation();
  document.title = S.code === "US"
    ? "50 States of Electricity — U.S. power generation and emissions, 2024"
    : `${S.geo.name} electricity mix 2024 — 50 States of Electricity`;
  for (const [sel, name] of [["#geoName", 1], ["#mixGeo", 1], ["#plantGeo", 1],
                             ["#valGeo", 1], ["#demandGeo", 1]]) {
    const n = $(sel);
    if (n) n.textContent = S.geo.name;
  }
}

async function selectGeo(code, { push = true } = {}) {
  if (!S.index.states.some((s) => s.code === code) && code !== "US") return;
  const main = $("#main");
  main.classList.add("is-loading");   // hold the previous render, no skeleton flash
  hideTip();
  try {
    S.geo = await getJSON(geoURL(code));
    S.code = code;
    S.plantLimit = 100;
    $("#geoSelect").value = code;
    renderAll();
    if (push) {
      const url = code === "US" ? location.pathname : `${location.pathname}?state=${code}`;
      history.pushState({ code }, "", url);
    }
  } catch (e) {
    console.error(e);
    showFatal(`Could not load data for ${code}. ${e.message}`);
  } finally {
    main.classList.remove("is-loading");
  }
}

function showFatal(msg) {
  const b = $("#banner");
  b.hidden = false;
  b.textContent = msg;
}

function wireUI() {
  // state selector
  const sel = $("#geoSelect");
  const us = document.createElement("option");
  us.value = "US";
  us.textContent = "United States (all states)";
  sel.appendChild(us);
  const grp = document.createElement("optgroup");
  grp.label = "States & District of Columbia";
  for (const s of S.index.states.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const o = document.createElement("option");
    o.value = s.code;
    o.textContent = s.name;
    grp.appendChild(o);
  }
  sel.appendChild(grp);
  sel.addEventListener("change", () => selectGeo(sel.value));

  // CO2 basis
  $("#basisSelect").addEventListener("change", (e) => {
    S.basis = e.target.value;
    renderHeadline();
    renderPlants();
  });

  // ranking sort
  const rs = $("#rankSort");
  for (const [k, v] of Object.entries(RANK_SORTS)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = v.label;
    rs.appendChild(o);
  }
  rs.value = S.rankSort;
  rs.addEventListener("change", () => { S.rankSort = rs.value; renderRanking(); });

  // chart / table twin
  for (const btn of $$("#mixToggle button")) {
    btn.addEventListener("click", () => {
      S.mixView = btn.dataset.view;
      for (const b of $$("#mixToggle button")) {
        b.setAttribute("aria-pressed", String(b === btn));
      }
      $("#mixChartView").hidden = S.mixView !== "chart";
      $("#mixTableView").hidden = S.mixView !== "table";
      if (S.mixView === "chart") renderMix();
    });
  }

  // by-source: tabs are built once; metric and view toggles
  renderSourceTabs();
  for (const btn of $$("#srcMetric button")) {
    btn.addEventListener("click", () => { S.srcMetric = btn.dataset.metric; renderSourceRank(); });
  }
  for (const btn of $$("#srcView button")) {
    btn.addEventListener("click", () => {
      S.srcView = btn.dataset.view;
      for (const b of $$("#srcView button")) b.setAttribute("aria-pressed", String(b === btn));
      $("#srcChartView").hidden = S.srcView !== "chart";
      $("#srcTableView").hidden = S.srcView !== "table";
      if (S.srcView === "chart") renderSourceRank();
    });
  }
  // arrow-key navigation across the tablist
  $("#srcTabs").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabs = $$("#srcTabs button");
    const i = tabs.findIndex((t) => t.dataset.key === S.srcKey);
    const j = e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : (i + 1) % tabs.length;
    e.preventDefault();
    S.srcKey = tabs[j].dataset.key;
    renderSourceRank();
    tabs[j].focus();
  });

  // demand ranking metric
  for (const btn of $$("#demandMetric button")) {
    btn.addEventListener("click", () => { S.demandMetric = btn.dataset.metric; renderDemandRank(); });
  }

  // plant table sorting
  for (const th of $$("#plantTable thead th")) {
    if (!th.dataset.key) continue;
    th.setAttribute("aria-sort", "none");
    th.tabIndex = 0;
    const go = () => {
      const k = th.dataset.key;
      S.plantSort = S.plantSort.key === k
        ? { key: k, dir: -S.plantSort.dir }
        : { key: k, dir: th.classList.contains("num") ? -1 : 1 };
      renderPlants();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  }

  // search (debounced)
  let t = null;
  $("#plantSearch").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { S.plantQuery = e.target.value; S.plantLimit = 100; renderPlants(); }, 160);
  });

  $("#plantMore").addEventListener("click", () => { S.plantLimit += 250; renderPlants(); });
  $("#csvBtn").addEventListener("click", downloadCSV);

  // back/forward
  window.addEventListener("popstate", (e) => {
    const code = e.state?.code || new URLSearchParams(location.search).get("state") || "US";
    selectGeo(code, { push: false });
  });

  onResize(() => {
    renderMix(); renderRanking(); renderSourceRank(); renderDemand(); renderPlants();
  });
}

async function main() {
  try {
    const [index, meta] = await Promise.all([
      getJSON(`${DATA}/index.json`),
      getJSON(`${DATA}/meta.json`),
    ]);
    S.index = index;
    S.meta = meta;
    renderMeta();
    wireUI();

    // Unhide BEFORE the first render: charts measure their container width, and
    // a hidden ancestor reports clientWidth 0, which would letterbox every SVG.
    $("#boot").hidden = true;
    $("#main").hidden = false;

    const want = new URLSearchParams(location.search).get("state");
    await selectGeo(want && want !== "US" ? want.toUpperCase() : "US", { push: false });
  } catch (e) {
    console.error(e);
    $("#boot").hidden = true;
    showFatal(`Could not load the dataset (${e.message}). If you are opening index.html directly `
      + `from disk, browsers block local fetches — run a local server instead: python -m http.server`);
  }
}

main();
