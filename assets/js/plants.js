/* ==========================================================================
   plants.js — the Power Plant Browser.
   Pick a state, then a plant; everything below renders from that plant's own
   pre-built file in data/plants/XX/<id>.json (see scripts/build_plants.py).
   Static: no API key in the browser, no server, no third-party libraries.
   ========================================================================== */

// Keep the ?v= in step with plants.html, for the reason given in app.js.
import { columns, line, heatmap, seqColor, clear, onResize, hideTip, pctLabel }
  from "./charts.js?v=14";

const DATA = "./data";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- state ---------- */
const S = {
  meta: null,        // data/plants/meta.json
  factors: null,     // co2_factors from data/meta.json (shared with the Home page)
  state: null,       // selected state code
  index: null,       // data/plants/index/XX.json
  plant: null,       // the selected plant's file, plus derived series (see derive)
  year: null,
  basis: "elec",
  range: "all",
  monthlyView: "chart",
  usIntensity: null,  // U.S. kg CO2/MWh, 2024, from the Home page dataset
};

/* ---------- formatting (the same conventions as the Home page) ---------- */
const nf = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n)
  ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));

/** MWh -> whole number with the unit that keeps it whole: TWh from 10 TWh, GWh from 1 GWh. */
function energyParts(v) {
  const a = Math.abs(v);
  if (a >= 1e7) return { value: nf(v / 1e6, 0), unit: "TWh" };
  if (a >= 1e3) return { value: nf(v / 1e3, a >= 1e4 ? 0 : 1), unit: "GWh" };
  return { value: nf(v, 0), unit: "MWh" };
}
const energy = (v) => { const p = energyParts(v); return `${p.value} ${p.unit}`; };

/** One unit for a whole chart, chosen from its largest value. */
function commonEnergyFmt(values) {
  const max = Math.max(0, ...values.map((v) => Math.abs(v)));
  const [div, unit] = max >= 1e7 ? [1e6, "TWh"] : max >= 1e3 ? [1e3, "GWh"] : [1, "MWh"];
  return (v) => {
    const s = v / div;
    if (v !== 0 && Math.abs(s) < 0.05) return `${v < 0 ? "−" : ""}<0.1 ${unit}`;
    return `${nf(s, Math.abs(s) < 10 && s !== Math.round(s) ? 1 : 0)} ${unit}`;
  };
}
/** Tonnes of CO2: Mt from 10 Mt, kt from 10 kt, otherwise tonnes. */
function co2(t) {
  const a = Math.abs(t);
  if (a >= 1e7) return { value: nf(t / 1e6, 0), unit: "Mt" };
  if (a >= 1e4) return { value: nf(t / 1e3, 0), unit: "kt" };
  return { value: nf(t, 0), unit: "t" };
}
const co2Str = (t) => { const c = co2(t); return `${c.value} ${c.unit}`; };
function commonCo2Fmt(values) {
  const max = Math.max(0, ...values.map((v) => Math.abs(v)));
  const [div, unit] = max >= 1e7 ? [1e6, "Mt"] : max >= 1e4 ? [1e3, "kt"] : [1, "t"];
  return (v) => `${nf(v / div, Math.abs(v / div) < 10 && v !== 0 && div > 1 ? 1 : 0)} ${unit}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
function monthAdd(ym, k) {
  const i = +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1) + k;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}
const hoursIn = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate() * 24;
/** "2024-06" -> "Jun 2024"; "2024" -> "2024" */
const fmtYM = (s) => (s && s.length >= 7 ? monthName(s) : s || "—");

const cssVar = (name, fallback = "#8a8f9a") =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const sourceColor = (key) => cssVar(`--fuel-${key}`);
const label = (key) => S.meta.detail_labels[key] || key;

/* ---------- data loading ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

/* ==========================================================================
   Derived series. Everything the page shows is computed once per plant here,
   so the charts, tiles, tables and CSV all read the same numbers.
   ========================================================================== */
function derive(file) {
  const n = (+file.end.slice(0, 4) - +file.start.slice(0, 4)) * 12
    + (+file.end.slice(5, 7) - +file.start.slice(5, 7)) + 1;
  const months = Array.from({ length: n }, (_, i) => monthAdd(file.start, i));
  const keys = S.meta.detail_order.filter((k) => file.gen[k]);
  const total = months.map((_, i) => keys.reduce((s, k) => s + file.gen[k][i], 0));
  const storage = file.primary === "pumped_storage" || file.fuel_label === "Battery storage";

  // The file omits series that carry no information (see put() in
  // build_plants.py): absent means "use the default", [] means all zero.
  const zeros = () => new Array(n).fill(0);
  const ser = (v, dflt = zeros()) => (v === undefined ? dflt : v.length ? v : zeros());
  const missing = new Set(file.missing || []);
  const capacity = zeros();
  (file.capacity_mw || []).forEach(([i, mw], k, all) => {
    const to = k + 1 < all.length ? all[k + 1][0] : n;
    for (let j = i; j < to; j++) capacity[j] = mw;
  });
  const mmbtu = ser(file.mmbtu_eg);
  const co2e = ser(file.co2_t);
  const doc = {
    ...file,
    reported: months.map((_, i) => (missing.has(i) ? 0 : 1)),
    capacity_mw: capacity,
    mmbtu_eg: mmbtu,
    hr_mmbtu: ser(file.hr_mmbtu, mmbtu),
    hr_gen: ser(file.hr_gen, total),
    co2_t: co2e,
    co2_all_t: ser(file.co2_all_t, co2e),
    biogenic_mmbtu: ser(file.biogenic_mmbtu),
    unattributed_mmbtu: ser(file.unattributed_mmbtu),
  };

  // A month EIA's monthly series has no row for is "no data", which is not the
  // same as zero. These gaps are in the source: the API returns nothing for them.
  const rep = (i) => doc.reported[i] === 1;
  // Above ~100% the capacity on file is smaller than what was really running,
  // usually units generating test power before their listed online date, so the
  // ratio says nothing about how hard the plant ran and is not shown.
  const cf = months.map((m, i) => {
    const cap = doc.capacity_mw[i];
    const v = !storage && rep(i) && cap > 0 ? total[i] / (cap * hoursIn(m)) * 100 : null;
    return v !== null && v <= CF_CEILING ? v : null;
  });
  const heat = months.map((_, i) => (doc.hr_gen[i] > 0 && doc.hr_mmbtu[i] > 0
    ? (doc.hr_mmbtu[i] / doc.hr_gen[i]) * 1000 : null));

  // annual roll-up
  const years = [...new Set(months.map((m) => +m.slice(0, 4)))];
  const annual = years.map((y) => {
    const idx = months.map((m, i) => (+m.slice(0, 4) === y ? i : -1)).filter((i) => i >= 0);
    const sum = (arr) => idx.reduce((s, i) => s + (arr[i] || 0), 0);
    const byKey = Object.fromEntries(keys.map((k) => [k, sum(doc.gen[k])]));
    const gen = keys.reduce((s, k) => s + byKey[k], 0);
    // only months with a meaningful monthly capacity factor count toward the year's
    const ok = idx.filter((i) => cf[i] !== null);
    const capHours = ok.reduce((s, i) => s + doc.capacity_mw[i] * hoursIn(months[i]), 0);
    const cfGen = ok.reduce((s, i) => s + total[i], 0);
    const cfYear = !storage && capHours > 0 ? (cfGen / capHours) * 100 : null;
    const hrG = sum(doc.hr_gen), hrM = sum(doc.hr_mmbtu);
    const [rank, of, stateTotal] = doc.context[String(y)] || [];
    const lastIdx = idx[idx.length - 1];
    return {
      year: y, idx, byKey, gen,
      monthsReported: idx.filter(rep).length,
      partial: idx.length < 12,
      firstMonth: months[idx[0]], lastMonth: months[lastIdx],
      capEnd: doc.capacity_mw[lastIdx] || null,
      cf: cfYear !== null && cfYear <= CF_CEILING ? cfYear : null,
      co2: sum(doc.co2_t), co2All: sum(doc.co2_all_t),
      mmbtu: sum(doc.mmbtu_eg),
      bio: sum(doc.biogenic_mmbtu), unattr: sum(doc.unattributed_mmbtu),
      heat: hrG > 0 && hrM > 0 ? (hrM / hrG) * 1000 : null,
      rank: rank || null, of: of || null,
      share: stateTotal > 0 ? (gen / stateTotal) * 100 : null,
    };
  });
  return { ...doc, months, keys, total, storage, cf, heat, annual, rep };
}

/** Years after the last complete one hold only EIA's monthly survey sample. */
const sampleYear = (y) => y > S.meta.complete_through;
/** An operating plant whose data stops at the end of the last complete year reports annually. */
const annualOnly = (p) => p.active && p.end === `${S.meta.complete_through}-12` && p.end < S.meta.end;
const annualOnlyNote = (p) => "This plant reports to EIA once a year, and EIA has not yet published its "
  + `figures after ${monthName(p.end)}. They will appear here once EIA releases its next annual data.`;

/** Capacity factors above this mean the capacity on file is incomplete. */
const CF_CEILING = 105;

const co2Series = (p) => (S.basis === "all" ? p.co2_all_t : p.co2_t);
const co2Year = (a) => (S.basis === "all" ? a.co2All : a.co2);
const yearRow = () => S.plant.annual.find((a) => a.year === S.year) || S.plant.annual.at(-1);
const yearName = (a) => (a.partial
  ? `${a.year} (${MONTHS[+a.firstMonth.slice(5) - 1]}–${MONTHS[+a.lastMonth.slice(5) - 1]})`
  : String(a.year));
/** The default year: the latest complete calendar year in the plant's record. */
function defaultYear(p) {
  const full = p.annual.filter((a) => !a.partial && a.monthsReported > 0);
  return (full.at(-1) || p.annual.at(-1)).year;
}

/* ==========================================================================
   Selectors
   ========================================================================== */
function fillStates() {
  const sel = $("#stateSelect");
  clear(sel);
  const ph = new Option("Choose a state…", "");
  ph.disabled = true;
  sel.appendChild(ph);
  for (const s of S.meta.states) sel.appendChild(new Option(s.name, s.code));
  sel.value = S.state || "";
}

/** Plant dropdown: "Name (Fuel)", current plants first, then those no longer reporting. */
function fillPlants() {
  const sel = $("#plantSelect");
  clear(sel);
  const groups = [
    ["Operating", S.index.plants.filter((p) => p.active)],
    ["Retired or no longer operating", S.index.plants.filter((p) => !p.active)],
  ];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    const g = document.createElement("optgroup");
    g.label = `${title} — ${nf(list.length)}`;
    for (const p of list) {
      const text = p.active ? `${p.name} (${p.fuel_label})`
        : `${p.name} (${p.fuel_label}) — last data ${fmtYM(p.end)}`;
      g.appendChild(new Option(text, p.id));
    }
    sel.appendChild(g);
  }
  sel.disabled = false;
  $("#plantSelectLabel").textContent = `Power plant — ${nf(S.index.plants.length)} in ${S.index.name}`;
}

async function selectState(code, { plant = null, push = true } = {}) {
  if (!S.meta.states.some((s) => s.code === code)) return;
  S.state = code;
  $("#stateSelect").value = code;
  const sel = $("#plantSelect");
  sel.disabled = true;
  try {
    S.index = await getJSON(`${DATA}/plants/index/${code}.json`);
    fillPlants();
    // Land on something useful straight away: the named plant, else the state's
    // largest generator over the latest twelve months.
    const pick = (plant && S.index.plants.find((p) => p.id === plant))
      || S.index.plants.slice().sort((a, b) => b.gen_last12_mwh - a.gen_last12_mwh)[0];
    if (pick) await selectPlant(pick.id, { push });
  } catch (e) {
    console.error(e);
    showFatal(`Could not load the plant list for ${code}. ${e.message}`);
  }
}

async function selectPlant(id, { push = true } = {}) {
  const main = $("#main");
  main.classList.add("is-loading");
  hideTip();
  try {
    const doc = await getJSON(`${DATA}/plants/${S.state}/${id}.json`);
    S.plant = derive(doc);
    S.year = defaultYear(S.plant);
    $("#plantSelect").value = id;
    $("#intro").hidden = true;
    main.hidden = false;       // unhide BEFORE rendering: charts measure their width
    fillYears();
    renderAll();
    if (push) history.pushState({ state: S.state, plant: id }, "", `?state=${S.state}&plant=${id}`);
  } catch (e) {
    console.error(e);
    showFatal(`Could not load plant ${id}. ${e.message}`);
  } finally {
    main.classList.remove("is-loading");
  }
}

function fillYears() {
  const sel = $("#yearSelect");
  clear(sel);
  for (const a of S.plant.annual.slice().reverse()) sel.appendChild(new Option(yearName(a), a.year));
  sel.value = S.year;
}

/* ==========================================================================
   Render: profile — headline, tiles, facts
   ========================================================================== */
function renderProfile() {
  const p = S.plant;
  const a = yearRow();

  $("#plantEyebrow").textContent = p.active ? "Power plant" : "Power plant · retired or no longer operating";
  $("#plantName").textContent = p.name;
  const meta = $("#plantMeta");
  clear(meta);
  const chip = document.createElement("span");
  chip.className = "chip";
  const sw = document.createElement("i");
  sw.style.background = sourceColor(p.primary);
  chip.append(sw, document.createTextNode(p.fuel_label));
  meta.appendChild(chip);
  const bits = [p.operator, p.county ? `${p.county} County, ${p.state_name}` : p.state_name,
    p.capacity_now_mw ? `${nf(p.capacity_now_mw, p.capacity_now_mw < 10 ? 1 : 0)} MW nameplate` : null];
  for (const b of bits.filter(Boolean)) {
    const s = document.createElement("span");
    s.textContent = b;
    meta.appendChild(s);
  }

  // ---- hero ----
  const e = energyParts(a.gen);
  $("#heroLabel").textContent = `Net generation, ${yearName(a)}`;
  $("#heroValue").textContent = e.value;
  $("#heroUnit").textContent = e.unit;
  const whole = p.total.reduce((s, v) => s + v, 0);
  const peakI = p.total.reduce((best, v, i) => (v > p.total[best] ? i : best), 0);
  const sub = $("#heroSub");
  clear(sub);
  sub.append(
    Object.assign(document.createElement("b"), { textContent: energy(whole) }),
    document.createTextNode(` from ${monthName(p.start)} to ${monthName(p.end)}.`),
  );
  if (p.total[peakI] > 0) {
    sub.append(document.createTextNode(" Its biggest month was "),
      Object.assign(document.createElement("b"), { textContent: monthName(p.months[peakI]) }),
      document.createTextNode(`, at ${energy(p.total[peakI])}.`));
  }
  if (annualOnly(p) && a.year === +p.end.slice(0, 4)) {
    sub.append(document.createTextNode(` ${annualOnlyNote(p)}`));
  } else if (a.monthsReported < a.idx.length) {
    sub.append(document.createTextNode(
      ` EIA's monthly series has no data for ${a.idx.length - a.monthsReported} month`
      + `${a.idx.length - a.monthsReported === 1 ? "" : "s"} of ${a.year}, so this total is incomplete.`));
  }

  // ---- tiles ----
  const c = co2Year(a);
  const intensity = a.gen > 0 && c > 0 ? (c * 1000) / a.gen : null;
  const burns = p.hr_gen.some((v) => v > 0);
  const tiles = [
    {
      label: "Capacity", value: a.capEnd ? nf(a.capEnd, a.capEnd < 10 ? 1 : 0) : "—", unit: a.capEnd ? "MW" : "",
      foot: a.capEnd ? `Nameplate in service, ${monthName(a.lastMonth)}` : "No generator inventory on file",
    },
    {
      label: "Capacity factor", value: a.cf === null ? "—" : nf(a.cf, a.cf >= 10 ? 0 : 1),
      unit: a.cf === null ? "" : "%",
      meter: a.cf === null ? null : a.cf, meterColor: sourceColor(p.primary),
      foot: p.storage ? "Not meaningful for storage" : a.cf === null ? "No capacity on file"
        : "Generation ÷ (capacity × hours)",
    },
    {
      label: "Estimated CO₂", value: co2(c).value, unit: co2(c).unit,
      foot: c > 0 ? (S.basis === "all" ? "All fuel burned" : "Fuel burned for electricity")
        : a.bio > 0 ? "Biogenic fuel only — excluded" : "No fossil fuel burned",
    },
    {
      label: "Carbon intensity", value: intensity === null ? "—" : nf(intensity, 0),
      unit: intensity === null ? "" : "kg/MWh",
      foot: intensity === null ? "No fossil CO₂ to spread" : "Estimated CO₂ ÷ net generation",
    },
    {
      label: "Heat rate", value: a.heat === null ? "—" : nf(a.heat, 0), unit: a.heat === null ? "" : "Btu/kWh",
      foot: a.heat !== null ? "Fuel in ÷ electricity out" : burns ? "No fuel reported this year" : "Nothing combusted",
    },
    {
      label: "Rank in state", value: a.rank ? `#${nf(a.rank)}` : "—", unit: a.rank ? `of ${nf(a.of)}` : "",
      foot: sampleYear(a.year)
        ? `Among plants in EIA's monthly sample for ${a.year}`
        : a.share !== null && a.share > 0
          ? `${pctLabel(a.share)} of ${p.state_name}'s plant generation` : "By net generation",
    },
  ];
  const host = $("#tiles");
  clear(host);
  for (const t of tiles) {
    const d = document.createElement("div");
    d.className = "tile";
    const lab = Object.assign(document.createElement("div"), { className: "tile__label", textContent: t.label });
    const val = Object.assign(document.createElement("div"), { className: "tile__value", textContent: t.value });
    if (t.unit) val.appendChild(Object.assign(document.createElement("small"), { textContent: t.unit }));
    d.append(lab, val);
    if (typeof t.meter === "number") {
      const m = Object.assign(document.createElement("div"), { className: "tile__meter" });
      const i = document.createElement("i");
      i.style.width = `${Math.max(0, Math.min(100, t.meter))}%`;
      i.style.background = t.meterColor;
      m.appendChild(i);
      d.appendChild(m);
    }
    d.appendChild(Object.assign(document.createElement("div"), { className: "tile__foot", textContent: t.foot }));
    host.appendChild(d);
  }

  // ---- facts ----
  const inService = p.generators.filter((g) => g.status !== "RE");
  const online = p.generators.map((g) => g.online).filter(Boolean).sort();
  const facts = [
    ["EIA plant ID", p.id, "Form EIA-860 / EIA-923 identifier"],
    ["Operator", p.operator || "—", p.sector || ""],
    ["Location", p.county ? `${p.county} County` : "—", p.state_name],
    ["Balancing authority", p.ba || "—", p.ba_name || ""],
    ["Generators", `${nf(inService.length)} in service`,
      p.generators.length > inService.length
        ? `${nf(p.generators.length - inService.length)} retired or removed since 2016` : "None retired since 2016"],
    ["First unit online", online.length ? fmtYM(online[0]) : "—",
      online.length > 1 ? `Newest: ${fmtYM(online.at(-1))}` : ""],
    ["Reporting", `${monthName(p.start)} – ${monthName(p.end)}`,
      `Data for ${nf(p.reported.filter((x) => x).length)} of ${nf(p.reported.length)} months`],
  ];
  const grid = $("#factsGrid");
  clear(grid);
  for (const [dt, dd, small] of facts) {
    const div = document.createElement("div");
    const t = Object.assign(document.createElement("dt"), { textContent: dt });
    const v = Object.assign(document.createElement("dd"), { textContent: dd });
    if (small) v.appendChild(Object.assign(document.createElement("small"), { textContent: small }));
    div.append(t, v);
    grid.appendChild(div);
  }
  if (p.lat !== null && p.lat !== undefined) {
    const div = document.createElement("div");
    div.appendChild(Object.assign(document.createElement("dt"), { textContent: "Coordinates" }));
    const v = Object.assign(document.createElement("dd"), { textContent: `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}` });
    const sm = document.createElement("small");
    const aMap = Object.assign(document.createElement("a"), {
      href: `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=13/${p.lat}/${p.lon}`,
      textContent: "View on a map ↗", target: "_blank", rel: "noopener",
    });
    sm.appendChild(aMap);
    v.appendChild(sm);
    div.append(v);
    grid.appendChild(div);
  }
}

/* ==========================================================================
   Render: monthly generation
   ========================================================================== */
function rangeStart() {
  const n = S.plant.months.length;
  return S.range === "all" ? 0 : Math.max(0, n - Number(S.range));
}

function renderMonthly() {
  const p = S.plant;
  const lo = rangeStart();
  const idx = p.months.map((_, i) => i).slice(lo);
  const fmt = commonEnergyFmt(idx.map((i) => p.total[i]).concat(
    idx.map((i) => p.keys.reduce((s, k) => s + Math.max(0, p.gen[k][i]), 0))));
  const many = idx.length > 36;

  columns($("#monthlyChart"), idx.map((i) => ({
    label: monthName(p.months[i]),
    parts: p.keys.map((k) => ({ label: label(k), value: p.gen[k][i], color: sourceColor(k) })),
    meta: !p.rep(i) ? "No data for this month in EIA's monthly plant series"
      : p.keys.filter((k) => p.gen[k][i] !== 0).length > 1 ? `Net total: ${fmt(p.total[i])}` : null,
  })), {
    height: 300, fmt, totalLabel: "Net total",
    ariaLabel: `Monthly net generation, ${p.name}`,
    // label Januaries when showing years; every quarter when zoomed in
    xLabel: (k) => {
      const m = p.months[idx[k]];
      if (many) return m.endsWith("-01") ? m.slice(0, 4) : null;
      return ["01", "04", "07", "10"].includes(m.slice(5)) ? monthName(m) : null;
    },
  });

  const leg = $("#monthlyLegend");
  clear(leg);
  if (p.keys.length > 1) {
    const whole = Object.fromEntries(p.keys.map((k) => [k, p.gen[k].reduce((s, v) => s + v, 0)]));
    const pos = p.keys.reduce((s, k) => s + Math.max(0, whole[k]), 0);
    for (const k of p.keys.slice().sort((a, b) => Math.abs(whole[b]) - Math.abs(whole[a]))) {
      const li = document.createElement("li");
      const i = document.createElement("i");
      i.style.background = sourceColor(k);
      li.append(i, document.createTextNode(`${label(k)} `),
        Object.assign(document.createElement("b"),
          { textContent: whole[k] > 0 && pos > 0 ? pctLabel((whole[k] / pos) * 100) : "net −" }));
      leg.appendChild(li);
    }
  }

  const missing = p.reported.filter((x) => !x).length;
  const tail = annualOnly(p) ? `${annualOnlyNote(p)} ` : "";
  $("#monthlyHeading").textContent = p.keys.length > 1
    ? `Net generation by energy source, ${monthName(p.months[lo])} – ${monthName(p.end)}`
    : `Net generation from ${(!p.keys.length || p.keys[0] === p.primary ? p.fuel_label
      : label(p.keys[0])).toLowerCase()}, ${monthName(p.months[lo])} – ${monthName(p.end)}`;
  $("#monthlyNote").textContent =
    `Each column is one month. ${p.keys.length > 1 ? "Shares in the legend are of the whole period. " : ""}${tail}`
    + (missing ? `EIA's monthly series has no data for ${missing} month${missing === 1 ? "" : "s"} of this `
      + "plant's record; those are left blank rather than filled in. " : "")
    + `The latest months are preliminary: EIA revises them, and for smaller plants outside its monthly `
    + `survey sample they are EIA estimates until the annual survey comes in.`;

  renderMonthlyTable();
}

function renderMonthlyTable() {
  const p = S.plant;
  const head = $("#monthlyHead");
  clear(head);
  const cols = ["Month", ...(p.keys.length > 1 ? p.keys.map(label) : []), "Net generation MWh",
    "Capacity factor", "Est. CO₂ t"];
  cols.forEach((c, j) => {
    const th = Object.assign(document.createElement("th"), { scope: "col", textContent: c });
    if (j) th.className = "num";
    head.appendChild(th);
  });
  const body = $("#monthlyBody");
  clear(body);
  const c = co2Series(p);
  for (let i = p.months.length - 1; i >= 0; i--) {
    const tr = document.createElement("tr");
    tr.appendChild(Object.assign(document.createElement("th"), { scope: "row", textContent: monthName(p.months[i]) }));
    const add = (v, cls = "num") => tr.appendChild(Object.assign(document.createElement("td"), { className: cls, textContent: v }));
    if (!p.rep(i)) {
      const td = add("No data in EIA's monthly series", "t-muted");
      td.colSpan = cols.length - 1;
    } else {
      if (p.keys.length > 1) for (const k of p.keys) add(nf(p.gen[k][i]));
      add(nf(p.total[i]));
      add(p.cf[i] === null ? "—" : pctLabel(p.cf[i]));
      add(c[i] > 0 ? nf(c[i]) : "—");
    }
    body.appendChild(tr);
  }
  $("#monthlyCaption").textContent =
    `${p.name}, monthly net generation in MWh, newest first. Source: EIA Form EIA-923 via the EIA API.`;
}

/* ==========================================================================
   Render: year by year
   ========================================================================== */
function renderAnnual() {
  const p = S.plant;
  const fmt = commonEnergyFmt(p.annual.map((a) => a.gen));
  columns($("#annualChart"), p.annual.map((a) => ({
    label: yearName(a),
    parts: p.keys.map((k) => ({ label: label(k), value: a.byKey[k], color: sourceColor(k) })),
    meta: [a.cf !== null ? `Capacity factor ${pctLabel(a.cf)}` : null,
      a.monthsReported < a.idx.length ? `Data for ${a.monthsReported} of ${a.idx.length} months` : null].filter(Boolean).join(" · ") || null,
  })), {
    height: 280, fmt, capLabels: true, ariaLabel: `Annual net generation, ${p.name}`,
    xLabel: (i) => `${p.annual[i].year}${p.annual[i].partial ? " YTD" : ""}`,
  });
  const part = p.annual.find((a) => a.partial);
  $("#annualNote").textContent = `Net generation each calendar year${part ? `; ${yearName(part)} is the year to date` : ""}. `
    + "Hover a column for its capacity factor.";

  renderHeatmap();

  // ---- annual table ----
  const body = $("#annualBody");
  clear(body);
  for (const a of p.annual.slice().reverse()) {
    const tr = document.createElement("tr");
    const yth = Object.assign(document.createElement("th"), { scope: "row", textContent: yearName(a) });
    if (a.monthsReported < a.idx.length) {
      yth.append(Object.assign(document.createElement("span"), { className: "t-muted",
        textContent: ` · data for ${a.monthsReported} of ${a.idx.length} months` }));
    }
    tr.appendChild(yth);
    const add = (v) => tr.appendChild(Object.assign(document.createElement("td"), { className: "num", textContent: v }));
    const c = co2Year(a);
    add(nf(a.gen));
    add(a.capEnd ? nf(a.capEnd, a.capEnd < 10 ? 1 : 0) : "—");
    add(a.cf === null ? "—" : pctLabel(a.cf));
    add(c > 0 ? nf(c) : "—");
    add(c > 0 && a.gen > 0 ? nf((c * 1000) / a.gen) : "—");
    add(a.heat === null ? "—" : nf(a.heat));
    const star = sampleYear(a.year) ? "*" : "";
    add(a.rank ? `${nf(a.rank)} of ${nf(a.of)}${star}` : "—");
    add(a.share === null || a.share <= 0 ? "—" : `${pctLabel(a.share)}${star}`);
    if (a.year === S.year) tr.style.background = "var(--surface-sunk)";
    body.appendChild(tr);
  }
  $("#annualCaption").textContent =
    `${p.name}, by calendar year. Capacity is nameplate in service at the end of the year. `
    + `Rank and share are among ${p.state_name} plants with data that year, by net generation.`
    + (p.annual.some((a) => sampleYear(a.year))
      ? ` * After ${S.meta.complete_through}, only plants in EIA's monthly survey sample have data yet, `
        + "so those ranks and shares are among that smaller set." : "");
}

function renderHeatmap() {
  const p = S.plant;
  const years = p.annual.map((a) => a.year);
  const useCf = p.cf.some((v) => v !== null);
  const vals = useCf ? p.cf : p.total;
  const finite = vals.filter((v, i) => v !== null && p.rep(i));
  const max = useCf ? 100 : Math.max(1, ...finite.map(Math.abs));
  const at = (y, m) => p.months.indexOf(`${y}-${String(m + 1).padStart(2, "0")}`);
  const fmtG = commonEnergyFmt(p.total);

  $("#heatTitle").textContent = useCf ? "Capacity factor, month by month" : "Net generation, month by month";
  $("#heatNote").textContent = useCf
    ? "How hard the plant ran each month, as a share of what its capacity could have produced running flat out. "
      + "Darker is higher. Seasonal patterns show up down the columns."
    : p.storage
      ? "Storage plants are net consumers, so this shows net generation rather than capacity factor. Darker is a larger magnitude."
      : "No capacity is on file for this plant, so this shows net generation. Darker is higher.";

  heatmap($("#heatChart"), years.map(String), MONTHS, (r, c) => {
    const i = at(years[r], c);
    if (i < 0 || !p.rep(i)) return null;
    const v = vals[i];
    if (v === null) {
      // generation without a usable capacity factor still gets a readout
      return useCf && p.total[i] !== 0 ? {
        color: "var(--surface-sunk)", title: monthName(p.months[i]),
        rows: [{ value: fmtG(p.total[i]), label: "net generation" }],
        meta: "Capacity factor not meaningful: the capacity on file is smaller than what was generating.",
      } : null;
    }
    const t = useCf ? Math.min(1, Math.max(0, v) / max) : Math.abs(v) / max;
    return {
      color: seqColor(t),
      label: useCf ? nf(v, 0) : null,
      title: monthName(p.months[i]),
      rows: [
        useCf ? { value: pctLabel(v), label: "capacity factor" } : null,
        { value: fmtG(p.total[i]), label: "net generation" },
      ].filter(Boolean),
    };
  }, { ariaLabel: `${useCf ? "Capacity factor" : "Net generation"} by month and year, ${p.name}` });

  const sc = $("#heatScale");
  clear(sc);
  const bar = document.createElement("span");
  bar.className = "scale__bar";
  bar.style.background = `linear-gradient(90deg, ${[0, .25, .5, .75, 1].map(seqColor).join(",")})`;
  sc.append(document.createTextNode(useCf ? "0%" : "0"), bar,
    document.createTextNode(useCf ? `${nf(max, 0)}%` : fmtG(max)));
  const nr = document.createElement("span");
  nr.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-left:12px";
  const sw = document.createElement("i");
  sw.style.cssText = "width:12px;height:12px;border-radius:2px;background:var(--surface-sunk);display:block;border:1px solid var(--rule)";
  nr.append(sw, document.createTextNode("no data, or outside the plant's record"));
  sc.appendChild(nr);
}

/* ==========================================================================
   Render: emissions
   ========================================================================== */
function renderEmissions() {
  const p = S.plant;
  const c = co2Series(p);
  const any = c.some((v) => v > 0);
  const bio = p.biogenic_mmbtu.reduce((s, v) => s + v, 0);
  const unattr = p.unattributed_mmbtu.reduce((s, v) => s + v, 0);
  $("#emNone").hidden = any;
  $("#emCharts").hidden = !any;
  if (!any) {
    $("#emNoneText").textContent = bio > 0
      ? `${p.name} burns biomass (${nf(bio / 1e6, 1)} million MMBtu over the period). EIA publishes no `
        + "electric-power emission factor for biogenic fuels and excludes biogenic carbon from its own state "
        + "series, so no CO₂ is estimated here. That is an accounting convention, not an absence of stack emissions."
      : unattr > 0
        ? `${p.name} reports fuel that has no single published EIA emission factor (for example geothermal `
          + "steam, waste heat or manufactured gases), so its CO₂ is left unattributed rather than guessed at."
        : `${p.name} burns no fuel — ${p.fuel_label.toLowerCase()} generation has no combustion CO₂ at the plant.`;
    return;
  }

  const lo = rangeStart();
  const idx = p.months.map((_, i) => i).slice(lo);
  const many = idx.length > 36;
  const xl = (k) => {
    const m = p.months[idx[k]];
    return many ? (m.endsWith("-01") ? m.slice(0, 4) : null)
      : (["01", "04", "07", "10"].includes(m.slice(5)) ? monthName(m) : null);
  };
  const fmtC = commonCo2Fmt(idx.map((i) => c[i]));
  columns($("#emChart"), idx.map((i) => ({
    label: monthName(p.months[i]),
    parts: [{ label: "estimated CO₂", value: c[i], color: cssVar("--co2") }],
    meta: p.rep(i) ? null : "No data for this month in EIA's monthly plant series",
  })), { height: 250, fmt: fmtC, xLabel: xl, ariaLabel: `Monthly estimated CO₂, ${p.name}` });
  $("#emNote").textContent = `Tonnes of CO₂ per month, ${S.basis === "all"
    ? "from all fuel burned, including for useful heat at combined-heat-and-power plants"
    : "from fuel burned to generate electricity"}. Follows the time range chosen above.`;

  line($("#intChart"), idx.map((i) => ({
    label: monthName(p.months[i]),
    value: p.total[i] > 0 && c[i] > 0 ? (c[i] * 1000) / p.total[i] : null,
  })), {
    height: 250, fmt: (v) => `${nf(v, 0)} kg/MWh`, tickFmt: (v) => nf(v, 0), xLabel: xl,
    color: cssVar("--accent"), name: "kg CO₂ per MWh", ariaLabel: `Monthly carbon intensity, ${p.name}`,
  });
  $("#intNote").textContent = "Kilograms of CO₂ per megawatt-hour of net generation, each month. "
    + "Gaps are months with no generation."
    + (S.usIntensity ? ` For comparison, all U.S. generation averaged ${nf(S.usIntensity, 0)} kg/MWh in 2024 `
      + "on the same method (Home page)." : "");

  // ---- key figures ----
  const full = p.annual.filter((a) => !a.partial && a.monthsReported === 12 && co2Year(a) > 0);
  const whole = c.reduce((s, v) => s + v, 0);
  const peak = p.annual.reduce((b, a) => (co2Year(a) > co2Year(b) ? a : b), p.annual[0]);
  const items = [
    ["Total, whole period", co2Str(whole), `${monthName(p.start)} – ${monthName(p.end)}`],
    ["Highest year", co2Str(co2Year(peak)), yearName(peak)],
  ];
  if (full.length >= 2) {
    const f = full[0], l = full.at(-1);
    const ch = ((co2Year(l) - co2Year(f)) / co2Year(f)) * 100;
    items.push([`Change, ${f.year} to ${l.year}`, `${ch > 0 ? "+" : ch < 0 ? "−" : ""}${pctLabel(Math.abs(ch))}`,
      `${co2Str(co2Year(f))} → ${co2Str(co2Year(l))}`]);
  }
  const a = yearRow();
  items.push([`Fuel burned, ${yearName(a)}`, `${nf(a.mmbtu / 1e6, a.mmbtu >= 1e7 ? 0 : 2)} million MMBtu`,
    "For electricity generation"]);
  const grid = $("#emGrid");
  clear(grid);
  for (const [dt, dd, small] of items) {
    const div = document.createElement("div");
    const v = Object.assign(document.createElement("dd"), { textContent: dd });
    v.appendChild(Object.assign(document.createElement("small"), { textContent: small }));
    div.append(Object.assign(document.createElement("dt"), { textContent: dt }), v);
    grid.appendChild(div);
  }
  const foot = $("#emFoot");
  const bits = [];
  if (bio > 0) {
    bits.push(`This plant also burned ${nf(bio / 1e6, 2)} million MMBtu of biomass over the period, which `
      + "carries no CO₂ in any figure here — EIA excludes biogenic carbon from its electric-power series.");
  }
  if (unattr > 0) {
    bits.push(`${nf(unattr / 1e6, 2)} million MMBtu of fuel has no published EIA emission factor and is left `
      + "unattributed rather than guessed at.");
  }
  foot.textContent = bits.join(" ");
  foot.hidden = !bits.length;
}

/* ==========================================================================
   Render: fuels and heat rate
   ========================================================================== */
const TREATMENT = { fossil: "Counted", zero: "Zero by construction",
                    biogenic: "Excluded (biogenic)", unknown: "Unattributed" };

function renderFuels() {
  const p = S.plant;
  const a = yearRow();

  const lo = rangeStart();
  const idx = p.months.map((_, i) => i).slice(lo);
  const many = idx.length > 36;
  const hasHeat = idx.some((i) => p.heat[i] !== null);
  $("#hrNote").textContent = hasHeat
    ? "Btu of fuel burned per kilowatt-hour of net generation, each month. A modern combined-cycle gas plant "
      + "runs near 6,500–7,000; an older coal unit often 10,000 or more. Spikes are usually months when the "
      + "plant barely ran and start-up fuel dominated."
    : "This plant burns no fuel, so it has no heat rate.";
  if (hasHeat) {
    line($("#hrChart"), idx.map((i) => ({ label: monthName(p.months[i]), value: p.heat[i] })), {
      height: 250, fmt: (v) => `${nf(v, 0)} Btu/kWh`, tickFmt: (v) => nf(v, 0),
      color: sourceColor(p.primary), name: "heat rate", ariaLabel: `Monthly heat rate, ${p.name}`,
      xLabel: (k) => {
        const m = p.months[idx[k]];
        return many ? (m.endsWith("-01") ? m.slice(0, 4) : null)
          : (["01", "04", "07", "10"].includes(m.slice(5)) ? monthName(m) : null);
      },
    });
  } else {
    clear($("#hrChart"));
  }

  $("#fuelTableTitle").textContent = `By fuel, ${yearName(a)}`;
  const body = $("#fuelBody");
  clear(body);
  const yi = p.fuel_years.indexOf(a.year);   // per-fuel detail is stored by year
  const rows = Object.entries(p.fuels).map(([code, f]) => ({
    code, ...f, g: f.gen[yi] || 0, m: f.mmbtu[yi] || 0,
  })).filter((r) => r.g !== 0 || r.m !== 0).sort((x, y) => Math.abs(y.g) - Math.abs(x.g) || y.m - x.m);
  for (const r of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = sourceColor(r.detail);
    th.append(sw, document.createTextNode(`${S.meta.fuel_names[r.code] || r.code} `),
      Object.assign(document.createElement("span"), { className: "t-muted", textContent: r.code }));
    tr.appendChild(th);
    const add = (v, cls = "num") => tr.appendChild(Object.assign(document.createElement("td"), { className: cls, textContent: v }));
    const fct = S.factors[r.code];
    add(nf(r.g));
    add(r.m > 0 ? nf(r.m) : "—");
    add(fct && fct.kg_co2_per_mmbtu !== null ? nf(fct.kg_co2_per_mmbtu, 2) : "—");
    add(TREATMENT[r.kind] || r.kind, "");
    body.appendChild(tr);
  }
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = Object.assign(document.createElement("td"), { className: "t-muted", textContent: "Nothing reported this year." });
    td.colSpan = 5;
    tr.appendChild(td);
    body.appendChild(tr);
  }
  $("#fuelCaption").textContent = `${p.name}, ${yearName(a)}. Change the year at the top of the page. `
    + "Fuel is MMBtu consumed for electricity generation (Form EIA-923).";
}

/* ==========================================================================
   Render: generators
   ========================================================================== */
function renderGenerators() {
  const p = S.plant;
  const body = $("#genBody");
  clear(body);
  if (!p.generators.length) {
    const tr = document.createElement("tr");
    const td = Object.assign(document.createElement("td"), { className: "t-muted",
      textContent: "No generators for this plant appear in EIA's inventory from December 2016 onward." });
    td.colSpan = 8;
    tr.appendChild(td);
    body.appendChild(tr);
  }
  for (const g of p.generators) {
    const tr = document.createElement("tr");
    if (g.status === "RE") tr.className = "t-muted";
    tr.appendChild(Object.assign(document.createElement("th"), { scope: "row", textContent: g.id }));
    const add = (v, cls = "") => tr.appendChild(Object.assign(document.createElement("td"), { className: cls, textContent: v }));
    add(g.technology || "—");
    add(S.meta.fuel_names[g.fuel] || g.fuel || "—");
    add(nf(g.capacity_mw, g.capacity_mw < 10 ? 1 : 0), "num");
    add(g.summer_mw ? nf(g.summer_mw, g.summer_mw < 10 ? 1 : 0) : "—", "num");
    add(fmtYM(g.online));
    add(g.planned_retirement ? fmtYM(g.planned_retirement) : "—");
    add(g.status === "RE" ? `Retired or removed (last listed ${fmtYM(g.last_seen)})`
      : S.meta.status_labels[g.status] || g.status || "—");
    body.appendChild(tr);
  }
  const cap = p.generators.filter((g) => g.status !== "RE").reduce((s, g) => s + g.capacity_mw, 0);
  $("#genCaption").textContent = `${nf(p.generators.length)} generator${p.generators.length === 1 ? "" : "s"} `
    + `listed since December 2016; ${nf(cap, cap < 10 ? 1 : 0)} MW nameplate in service in the latest inventory `
    + `(${fmtYM(S.meta.generator_snapshots.at(-1))}).`;
}

/* ==========================================================================
   Render: notes
   ========================================================================== */
function renderNotes() {
  const notes = [
    ["Where the numbers come from",
      "Monthly net generation and fuel consumed come from Form EIA-923, served by the EIA API route "
      + "electricity/facility-fuel. Generator details — capacity, technology, online and planned retirement "
      + "dates, operator, county and coordinates — come from the monthly generator inventory, Form EIA-860M "
      + "(electricity/operating-generator-capacity), read once per December and for the latest month."],
    ["Recent months are preliminary",
      "EIA surveys a sample of plants every month and the rest once a year. Until a year's annual survey is "
      + "processed, monthly figures for plants outside the sample are EIA estimates, and all recent months "
      + "can be revised. The Home page uses final 2024 annual data, so a plant's 2024 total here can differ "
      + "slightly from the one shown there."],
    ["Months with no data",
      "EIA's monthly plant series occasionally has no row at all for a plant in a given month, even for a "
      + "large plant that was clearly running. Those months are shown blank and labelled, never filled in, "
      + "so a year containing one reads as incomplete rather than as a quiet month."],
    ["Capacity factor",
      "Net generation divided by what the plant's nameplate capacity could have produced running every hour "
      + "of the month. Capacity counts each generator from its online month until the last inventory it "
      + "appears in, so a retirement is dated to within a year. Nameplate overstates what some technologies "
      + "can deliver — solar, for example — so their capacity factors read low by design. It is not shown for "
      + "storage, which is a net consumer."],
    ["CO₂ estimates",
      "For each fuel, CO₂ = fuel consumed (MMBtu) × EIA's CO₂ emission factor for that specific fuel, the "
      + "same method and factors as the Home page. The electricity basis counts only fuel burned to generate "
      + "electricity; the all-fuel basis adds fuel used for useful heat at combined-heat-and-power plants. "
      + "Biomass is excluded, matching EIA's own series, and fuels with no published factor are left "
      + "unattributed."],
    ["Heat rate",
      "Fuel consumed for electricity generation divided by net generation, counting only fuels that are "
      + "actually burned (and nuclear). EIA also reports a nominal Btu figure for wind, solar and hydro; it is "
      + "left out, because dividing it by generation would look like a heat rate without being one."],
    ["Plants that report once a year",
      "EIA surveys larger plants every month and smaller ones once a year. The smaller plants' figures only "
      + "appear once EIA publishes that year's annual data, so every plant is covered through the end of the "
      + "last complete year, and only the monthly sample after it. A plant is listed as operating if its "
      + "generators are still in service in EIA's latest inventory, however recently it reported."],
    ["Rank and share",
      "Among all plants in the state with data for that year, by net generation. Share is of the state's "
      + "total plant generation, which excludes behind-the-meter rooftop solar. For years after the last "
      + "complete one, both are among the monthly sample only, and are marked with an asterisk."],
  ];
  const host = $("#noteBodies");
  clear(host);
  for (const [t, body] of notes) {
    const d = document.createElement("details");
    d.className = "method";
    d.append(Object.assign(document.createElement("summary"), { textContent: t }),
      Object.assign(document.createElement("div"), { className: "method__body", textContent: body }));
    host.appendChild(d);
  }
}

/* ==========================================================================
   CSV export
   ========================================================================== */
function downloadCSV() {
  const p = S.plant;
  const head = ["month", "has_data", ...p.keys.map((k) => `net_generation_mwh_${k}`), "net_generation_mwh_total",
    "nameplate_capacity_mw", "capacity_factor_pct", "fuel_for_electricity_mmbtu", "heat_rate_btu_per_kwh",
    "estimated_co2_tonnes_electricity_only", "estimated_co2_tonnes_all_fuel", "biogenic_fuel_mmbtu",
    "unattributed_fuel_mmbtu"];
  const r1 = (v) => (v === null || v === undefined ? "" : Math.round(v * 10) / 10);
  const body = p.months.map((m, i) => [
    m, p.reported[i], ...p.keys.map((k) => p.gen[k][i]), r1(p.total[i]), p.capacity_mw[i], r1(p.cf[i]),
    p.mmbtu_eg[i], r1(p.heat[i]), p.co2_t[i], p.co2_all_t[i], p.biogenic_mmbtu[i], p.unattributed_mmbtu[i],
  ].join(","));
  const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const note = `# ${esc(p.name)} (EIA plant ${p.id}), ${p.state_name} — 50 States of Electricity`
    + "\n# Generation and fuel: EIA Form EIA-923 via EIA API v2 (electricity/facility-fuel), monthly"
    + "\n# Capacity: EIA Form EIA-860M (electricity/operating-generator-capacity)"
    + `\n# CO2 is an estimate: fuel MMBtu x EIA emission factor. See ${location.origin}${location.pathname.replace(/[^/]*$/, "")}emission-factors.html`;
  const blob = new Blob([`${note}\n${head.join(",")}\n${body.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${p.id}-monthly.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ==========================================================================
   Orchestration
   ========================================================================== */
function renderAll() {
  renderProfile();
  renderMonthly();
  renderAnnual();
  renderEmissions();
  renderFuels();
  renderGenerators();
  document.title = `${S.plant.name}, ${S.plant.state_name} — Power Plant Browser`;
}

function showFatal(msg) {
  const b = $("#banner");
  b.hidden = false;
  b.textContent = msg;
}

function wireUI() {
  $("#stateSelect").addEventListener("change", (e) => selectState(e.target.value));
  $("#plantSelect").addEventListener("change", (e) => selectPlant(e.target.value));
  $("#yearSelect").addEventListener("change", (e) => {
    S.year = Number(e.target.value);
    renderProfile(); renderAnnual(); renderEmissions(); renderFuels();
  });
  $("#basisSelect").addEventListener("change", (e) => {
    S.basis = e.target.value;
    renderProfile(); renderAnnual(); renderEmissions(); renderMonthlyTable();
  });
  for (const btn of $$("#rangeToggle button")) {
    btn.addEventListener("click", () => {
      S.range = btn.dataset.range;
      for (const b of $$("#rangeToggle button")) b.setAttribute("aria-pressed", String(b === btn));
      renderMonthly(); renderEmissions(); renderFuels();
    });
  }
  for (const btn of $$("#monthlyView button")) {
    btn.addEventListener("click", () => {
      S.monthlyView = btn.dataset.view;
      for (const b of $$("#monthlyView button")) b.setAttribute("aria-pressed", String(b === btn));
      $("#monthlyChartView").hidden = S.monthlyView !== "chart";
      $("#monthlyTableView").hidden = S.monthlyView !== "table";
      if (S.monthlyView === "chart") renderMonthly();
    });
  }
  $("#csvBtn").addEventListener("click", downloadCSV);

  window.addEventListener("popstate", (e) => {
    const q = new URLSearchParams(location.search);
    const st = e.state?.state || q.get("state");
    const pl = e.state?.plant || q.get("plant");
    if (!st) return;
    if (st === S.state && pl) selectPlant(pl, { push: false });
    else selectState(st, { plant: pl, push: false });
  });

  onResize(() => {
    if (!S.plant) return;
    if (S.monthlyView === "chart") renderMonthly();
    renderAnnual(); renderEmissions(); renderFuels();
  });
}

async function main() {
  try {
    const [meta, siteMeta, siteIndex] = await Promise.all([
      getJSON(`${DATA}/plants/meta.json`),
      getJSON(`${DATA}/meta.json`),
      getJSON(`${DATA}/index.json`),
    ]);
    S.meta = meta;
    S.factors = siteMeta.co2_factors;
    S.usIntensity = siteIndex.us?.co2_kg_per_mwh ?? null;
    fillStates();
    renderNotes();
    wireUI();
    $("#introStart").textContent = monthName(meta.start);
    $("#builtStamp").textContent = `Data built ${meta.generated_utc.replace("T", " ").replace("Z", " UTC")}`;
    $("#windowStamp").textContent = `${monthName(meta.start)} – ${monthName(meta.end)} · Form EIA-923 / EIA-860M`;
    $("#boot").hidden = true;

    const q = new URLSearchParams(location.search);
    const st = (q.get("state") || "").toUpperCase();
    if (st && meta.states.some((s) => s.code === st)) {
      await selectState(st, { plant: q.get("plant"), push: false });
    } else {
      $("#intro").hidden = false;
    }
  } catch (e) {
    console.error(e);
    $("#boot").hidden = true;
    showFatal(`Could not load the plant dataset (${e.message}). If you are opening plants.html directly `
      + "from disk, browsers block local fetches — run a local server instead: python -m http.server");
  }
}

main();
