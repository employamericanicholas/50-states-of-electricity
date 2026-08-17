/* ==========================================================================
   app.js — 50 States of Electricity
   Loads the pre-built EIA dataset from /data and renders the dashboard.
   Static: no API key in the browser, no server, no third-party libraries.
   ========================================================================== */

import { treemap, hbar, stackedRows, stackedBar, clear, onResize, hideTip } from "./charts.js";

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
  plantSort: { key: "gen_mwh", dir: -1 },
  plantQuery: "",
  plantLimit: 100,
};

/* ---------- formatting ---------- */
const nf = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n)
  ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));

/** MWh -> a value carrying its own unit, e.g. "1,869.9 TWh" / "412.5 GWh". */
function energy(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${nf(v / 1e6, 1)} TWh`;
  if (a >= 1e3) return `${nf(v / 1e3, 1)} GWh`;
  return `${nf(v, 0)} MWh`;
}
/** Compact, unit-free — for tight treemap tiles. */
function mwh(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${nf(v / 1e6, 1)} TWh`;
  if (a >= 1e3) return `${nf(v / 1e3, 1)} GWh`;
  return `${nf(v, 0)} MWh`;
}
const twh = (v, d = 1) => nf(v / 1e6, d);
const mt = (v, d = 1) => nf(v / 1e6, d);        // tonnes -> million tonnes
const pct = (v, d = 1) => `${nf(v, d)}%`;

const slotColor = (slot) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--fuel-${slot}`).trim() || "#888";

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
  const co2 = S.basis === "all" ? g.co2.estimate_all_fuel_t : g.co2.estimate_t;
  const intensity = g.total_mwh > 0 ? (co2 * 1000) / g.total_mwh : null;

  $("#heroValue").textContent = twh(g.total_mwh);
  $("#heroSub").innerHTML = "";
  const sub = $("#heroSub");
  const utility = g.utility_scale_mwh, btm = g.small_scale_solar_mwh;
  sub.append(
    document.createTextNode(`${twh(utility)} TWh utility-scale, plus `),
    Object.assign(document.createElement("b"), { textContent: `${twh(btm)} TWh` }),
    document.createTextNode(" estimated behind-the-meter solar."),
  );

  const tiles = [
    {
      label: "Carbon-free share", value: nf(g.carbon_free_pct, 1), unit: "%",
      meter: g.carbon_free_pct, foot: "Nuclear + all renewables",
    },
    {
      label: "Renewable share", value: nf(g.renewable_pct, 1), unit: "%",
      meter: g.renewable_pct, foot: "Incl. small-scale solar",
    },
    {
      label: "Fossil share", value: nf(g.fossil_pct, 1), unit: "%",
      meter: g.fossil_pct, foot: "Coal, gas, petroleum, other gases",
    },
    {
      label: "Estimated CO₂", value: mt(co2), unit: "Mt",
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
  // finest-grained sources, with their colour slot
  return S.geo.sources.map((s) => ({
    key: s.key, label: s.label, value: s.mwh, slot: s.slot, color: slotColor(s.slot),
  }));
}

function renderMix() {
  const rows = mixRows();
  const posTotal = rows.filter((r) => r.value > 0).reduce((s, r) => s + r.value, 0);
  const negatives = rows.filter((r) => r.value < 0);

  // ---- treemap of the 8 colour slots, subdivided by detailed source ----
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
    sub: r.value > 0 ? `${((r.value / posTotal) * 100).toFixed(1)}% of generation` : "net negative",
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
    b.textContent = r.value > 0 ? `${((r.value / posTotal) * 100).toFixed(1)}%` : "net −";
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
    c2.textContent = r.value > 0 ? pct((r.value / posTotal) * 100, 2) : "—";
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
  carbon_free_pct: { label: "Carbon-free share", fmt: (r) => pct(r.carbon_free_pct, 1) },
  renewable_pct: { label: "Renewable share", fmt: (r) => pct(r.renewable_pct, 1) },
  fossil_pct: { label: "Fossil share", fmt: (r) => pct(r.fossil_pct, 1) },
  total_mwh: { label: "Total generation", fmt: (r) => `${twh(r.total_mwh)} TWh` },
  co2_kg_per_mwh: { label: "Carbon intensity", fmt: (r) => `${nf(r.co2_kg_per_mwh, 0)} kg/MWh` },
  name: { label: "State name", fmt: (r) => pct(r.carbon_free_pct, 1) },
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
    parts: r.slots.map((s) => ({
      key: s.key, label: s.label, value: s.mwh, color: slotColor(s.key),
    })),
  })), {
    labelW: 138, rowH: 23, fmt: (v) => `${twh(v)} TWh`,
    highlight: S.code === "US" ? null : S.code,
    // trailFmt receives the row, so read the metric off its original index record
    trailW: 104, trailFmt: (row) => spec.fmt(row.src), trailLabel: "Total generation",
    onClick: (r) => selectGeo(r.key),
  });

  slotLegend($("#rankLegend"));
  $("#rankCaption").textContent =
    `All 50 states and the District of Columbia, 2024, ordered by ${spec.label.toLowerCase()}. `
    + `Each row is that state's own generation mix as a share of its total. `
    + `Select a row to open that state.`;
}

/** Legend for the 8 colour slots, in fixed slot order. */
function slotLegend(host) {
  clear(host);
  for (const slot of S.index.slot_order) {
    const li = document.createElement("li");
    const i = document.createElement("i");
    i.style.background = slotColor(slot);
    const s = document.createElement("span");
    s.textContent = S.index.slot_labels[slot];
    li.append(i, s);
    host.appendChild(li);
  }
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
    color: slotColor(p.primary_slot),
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
    sw.style.background = slotColor(p.primary_slot);
    src.append(sw, document.createTextNode(S.index.detail_labels[p.primary] || p.primary));
    tr.appendChild(src);

    add(p.capacity_mw === null || p.capacity_mw === undefined ? "—" : nf(p.capacity_mw, 1), "num");
    add(nf(p.gen_mwh), "num");
    const c = co2Of(p);
    add(c > 0 ? nf(c) : "—", "num");
    add(p.co2_kg_per_mwh === null || p.co2_kg_per_mwh === undefined || co2Of(p) === 0
      ? "—" : nf(p.co2_kg_per_mwh, 1), "num");
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
    { dt: "Our estimate — electricity only", dd: `${mt(c.estimate_t)} Mt`,
      small: "Fuel burned to generate electricity, summed over every plant." },
    { dt: "Our estimate — all fuel burned", dd: `${mt(c.estimate_all_fuel_t)} Mt`,
      small: "Adds fuel burned for useful thermal output at CHP plants." },
    { dt: "EIA's published figure", dd: `${mt(c.eia_official_t)} Mt`,
      small: "EIA State Electricity Profiles, CO₂ from the electric power sector." },
    { dt: "Agreement", dd: c.ratio_to_official ? pct(c.ratio_to_official * 100, 1) : "—",
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
    bits.push(`${nf(c.unattributed_mmbtu / 1e6, 1)} million MMBtu of fuel here has no published `
      + `EIA emission factor (geothermal, blast-furnace and other manufactured gases, purchased `
      + `steam, waste heat) and is left unattributed rather than guessed at.`);
  }
  if (c.biogenic_t !== undefined && S.geo.sources.some((s) => s.key === "biomass")) {
    bits.push(`Biogenic CO₂ from biomass is excluded from every figure above, matching EIA's own `
      + `state series.`);
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

  // emission factor table
  const fb = $("#factorBody");
  clear(fb);
  const treat = { fossil: "Counted", zero: "Zero by construction", biogenic: "Excluded (biogenic)", unknown: "Unattributed" };
  for (const [code, f] of Object.entries(m.co2_factors)) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = code;
    const v = document.createElement("td");
    v.className = "num";
    v.textContent = f.kg_co2_per_mmbtu === null ? "—" : nf(f.kg_co2_per_mmbtu, 2);
    const t = document.createElement("td");
    t.textContent = treat[f.treatment] || f.treatment;
    const src = document.createElement("td");
    src.textContent = f.source ? (m.factor_sources[f.source]?.title || f.source) : "—";
    if (!f.source) src.className = "t-muted";
    const n = document.createElement("td");
    n.textContent = f.note || "";
    n.className = "t-muted";
    n.style.whiteSpace = "normal";
    tr.append(th, v, t, src, n);
    fb.appendChild(tr);
  }

  $("#builtStamp").textContent = `Data built ${m.generated_utc.replace("T", " ").replace("Z", " UTC")}`;
  $("#mastMeta").textContent = `EIA data · calendar year ${m.year}`;
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
  renderPlants();
  renderValidation();
  document.title = S.code === "US"
    ? "50 States of Electricity — U.S. power generation and emissions, 2024"
    : `${S.geo.name} electricity mix 2024 — 50 States of Electricity`;
  $("#geoName").textContent = S.geo.name;
  $("#mixGeo").textContent = S.geo.name;
  $("#plantGeo").textContent = S.geo.name;
  $("#valGeo").textContent = S.geo.name;
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

  // theme
  const applyTheme = (mode) => {
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem("50soe-theme", mode); } catch { /* private mode */ }
    $("#themeBtn").setAttribute("aria-label",
      mode === "dark" ? "Switch to light theme" : "Switch to dark theme");
    renderAll();   // charts re-read the CSS custom properties
  };
  $("#themeBtn").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  // back/forward
  window.addEventListener("popstate", (e) => {
    const code = e.state?.code || new URLSearchParams(location.search).get("state") || "US";
    selectGeo(code, { push: false });
  });

  onResize(() => { renderMix(); renderRanking(); renderPlants(); });
}

async function main() {
  // theme before first paint of charts
  try {
    const saved = localStorage.getItem("50soe-theme");
    if (saved) document.documentElement.dataset.theme = saved;
    else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.dataset.theme = "dark";
    }
  } catch { /* ignore */ }

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
