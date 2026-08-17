/* ==========================================================================
   factors.js — renders the CO2 emission-factor reference page from meta.json,
   so the factors and their citations have exactly one source of truth.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
const nf = (n, d = 2) => (n === null || n === undefined
  ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));

/** EIA-923 fuel codes -> plain-language names. */
const FUEL_NAMES = {
  ANT: "Anthracite coal", BIT: "Bituminous coal", SUB: "Subbituminous coal",
  LIG: "Lignite coal", RC: "Refined coal", WC: "Waste coal", SC: "Coal synfuel",
  SGC: "Coal-derived synthesis gas", NG: "Natural gas",
  DFO: "Distillate fuel oil", RFO: "Residual fuel oil", JF: "Jet fuel",
  KER: "Kerosene", WO: "Waste oil", PC: "Petroleum coke",
  SGP: "Synthesis gas from petroleum coke", PG: "Gaseous propane",
  TDF: "Tire-derived fuel", MSN: "Municipal solid waste (non-biogenic)",
  MSW: "Municipal solid waste", NUC: "Nuclear", WND: "Wind", SUN: "Solar",
  WAT: "Water (hydro)", H2: "Hydrogen", MWH: "Electricity for storage",
  GEO: "Geothermal", BFG: "Blast furnace gas", OG: "Other manufactured gas",
  OOG: "Other gases", PUR: "Purchased steam", WH: "Waste heat", OTH: "Other",
  AB: "Agricultural byproducts", BLQ: "Black liquor", LFG: "Landfill gas",
  MSB: "Municipal solid waste (biogenic)", OBG: "Other biomass gas",
  OBL: "Other biomass liquids", OBS: "Other biomass solids", SLW: "Sludge waste",
  WDL: "Wood waste liquids", WDS: "Wood / wood waste solids",
};

const TREATMENT = {
  fossil: "Counted",
  zero: "Zero by construction",
  biogenic: "Excluded (biogenic)",
  unknown: "Unattributed",
};
// order the table so the fuels that actually drive the estimate come first
const TREATMENT_ORDER = ["fossil", "zero", "biogenic", "unknown"];

async function main() {
  let meta;
  try {
    const r = await fetch("./data/meta.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    meta = await r.json();
  } catch (e) {
    const b = $("#banner");
    b.hidden = false;
    b.textContent = `Could not load data/meta.json (${e.message}). If you opened this file `
      + `directly from disk, browsers block local fetches — run a local server instead: `
      + `python -m http.server`;
    return;
  }

  $("#mastMeta").textContent = `EIA data · calendar year ${meta.year}`;
  $("#builtStamp").textContent =
    `Data built ${meta.generated_utc.replace("T", " ").replace("Z", " UTC")}`;

  // ---- factor table ----
  const entries = Object.entries(meta.co2_factors);
  entries.sort((a, b) => {
    const t = TREATMENT_ORDER.indexOf(a[1].treatment) - TREATMENT_ORDER.indexOf(b[1].treatment);
    if (t) return t;
    // within a treatment, biggest factor first, then alphabetical
    const fa = a[1].kg_co2_per_mmbtu, fb = b[1].kg_co2_per_mmbtu;
    if (fa !== fb) return (fb ?? -1) - (fa ?? -1);
    return a[0].localeCompare(b[0]);
  });

  const tb = $("#factorBody");
  clear(tb);
  for (const [code, f] of entries) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = code;
    const name = document.createElement("td");
    name.textContent = FUEL_NAMES[code] || "—";
    const val = document.createElement("td");
    val.className = "num";
    val.textContent = f.kg_co2_per_mmbtu === null ? "—" : nf(f.kg_co2_per_mmbtu);
    const treat = document.createElement("td");
    treat.textContent = TREATMENT[f.treatment] || f.treatment;
    const src = document.createElement("td");
    if (f.source && meta.factor_sources[f.source]) {
      const a = document.createElement("a");
      a.href = meta.factor_sources[f.source].url;
      a.textContent = meta.factor_sources[f.source].title;
      a.rel = "noopener";
      a.target = "_blank";
      src.appendChild(a);
    } else {
      src.textContent = "—";
      src.className = "t-muted";
    }
    const note = document.createElement("td");
    note.textContent = f.note || "";
    note.className = "t-muted";
    note.style.whiteSpace = "normal";
    tr.append(th, name, val, treat, src, note);
    tb.appendChild(tr);
  }

  const counted = entries.filter(([, f]) => f.treatment === "fossil").length;
  $("#factorCount").textContent = `${entries.length} fuel codes`;
  $("#factorNote").textContent =
    `${counted} of ${entries.length} fuel codes carry a factor and are counted. The rest are either `
    + `carbon-free at the point of generation, biogenic and excluded by convention, or fuels for which `
    + `EIA publishes no single applicable factor — those are left unattributed rather than guessed at.`;
  $("#factorCaption").textContent =
    `CO₂ emission factors applied in the ${meta.year} dataset, in kilograms of CO₂ per million Btu.`;

  // ---- methodology ----
  const meth = $("#methodBodies");
  clear(meth);
  const blocks = [
    ["CO₂ estimates", meta.methodology.co2],
    ["Generation data", meta.methodology.generation],
    ["What this does not tell you", meta.methodology.caveats],
  ];
  for (const [title, body] of blocks) {
    const d = document.createElement("details");
    d.className = "method";
    if (title === "CO₂ estimates") d.open = true;
    const s = document.createElement("summary");
    s.textContent = title;
    const wrap = document.createElement("div");
    wrap.className = "method__body";
    if (Array.isArray(body)) {
      const ul = document.createElement("ul");
      for (const item of body) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    } else {
      wrap.textContent = body;
    }
    d.append(s, wrap);
    meth.appendChild(d);
  }

  // ---- sources ----
  const ul = $("#sourceList");
  clear(ul);
  for (const s of meta.sources) {
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
    }
    const span = document.createElement("span");
    span.textContent = s.used_for;
    li.appendChild(span);
    ul.appendChild(li);
  }
}

main();
