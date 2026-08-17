#!/usr/bin/env python3
"""
Build the static JSON dataset for the 50 States of Electricity dashboard.

Pulls calendar-year 2024 data from the U.S. Energy Information Administration
(EIA) API v2 and writes plain JSON into ../data/ so the published site needs no
API key and no server.

Sources (all EIA):
  1. electricity/electric-power-operational-data
     -> net generation by state x energy source (utility-scale), plus EIA's
        estimated small-scale ("behind-the-meter") solar PV series, fuel DPV.
  2. electricity/facility-fuel
     -> net generation and fuel consumed for electricity generation (MMBtu)
        for every individual power plant, by energy source.
  3. electricity/operating-generator-capacity
     -> plant metadata: operator, county, lat/lon, nameplate capacity,
        balancing authority, technology.
  4. electricity/state-electricity-profiles/emissions-by-state-by-fuel
     -> EIA's own official CO2 totals by state, used to validate our
        plant-level estimate.

CO2 estimate: per plant-fuel, CO2 = (fuel consumed for electricity generation,
MMBtu) x (EIA CO2 emission factor, kg CO2/MMBtu). See FACTORS below for the
per-fuel citations. Fuels without a published EIA factor are left unattributed
and reported as such, rather than guessed at.

Usage:
    set EIA_API_KEY=...            (or put it in a .env file at the repo root)
    python scripts/build_data.py           # full build
    python scripts/build_data.py --no-cache  # ignore the raw response cache
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

YEAR = 2024

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / ".cache"
API = "https://api.eia.gov/v2/"
PAGE = 5000

# ─────────────────────────────────────────────────────────────────────────────
# Taxonomy
# ─────────────────────────────────────────────────────────────────────────────
# Every energy source carries its own chart colour (see assets/css/styles.css and
# scripts/derive_source_palette.mjs), so there is no coarser grouping layer.
DETAIL_LABEL = {
    "coal": "Coal",
    "gas": "Natural gas",
    "nuclear": "Nuclear",
    "wind": "Wind",
    "solar_utility": "Solar (utility-scale)",
    "solar_small_scale": "Solar (small-scale)",
    "hydro": "Hydro (conventional)",
    "geothermal": "Geothermal",
    "biomass": "Biomass",
    "petroleum": "Petroleum",
    "pumped_storage": "Pumped storage hydro",
    # "Other" also carries other gases (blast furnace and other manufactured
    # gas), which are reported here rather than as a category of their own.
    "other": "Other",
}

DETAIL_ORDER = [
    "coal", "gas", "petroleum", "nuclear", "hydro", "wind",
    "solar_utility", "solar_small_scale", "geothermal", "biomass",
    "pumped_storage", "other",
]

# State-level fuel codes from electric-power-operational-data. These 13 codes
# form an exact, mutually exclusive partition of net generation: their sum
# equals the "ALL" series (verified in validate_state_partition below). DPV
# (EIA's estimated small-scale solar) sits OUTSIDE that partition and is added
# on top, because it is not part of utility-scale net generation.
STATE_FUEL_TO_DETAIL = {
    "COW": "coal",            # all coal products
    "NG": "gas",              # natural gas
    "OOG": "other",           # other gases, reported within "Other"
    "PEL": "petroleum",       # petroleum liquids
    "PC": "petroleum",        # petroleum coke
    "NUC": "nuclear",
    "HYC": "hydro",           # conventional hydroelectric
    "WND": "wind",
    "SUN": "solar_utility",   # utility-scale solar (PV + thermal)
    "GEO": "geothermal",
    "BIO": "biomass",
    "OTH": "other",
    "HPS": "pumped_storage",  # net of pumping load, usually negative
}
STATE_PARTITION = list(STATE_FUEL_TO_DETAIL.keys())
DPV_CODE = "DPV"  # estimated small scale solar photovoltaic

# The facility-fuel route reports each plant twice over, at two granularities:
#   fuelType  = an AGGREGATE energy-source category (19 values, e.g. COL "Coal")
#   fuel2002  = the SPECIFIC EIA-923 fuel actually burned (44 values, e.g. BIT)
# Rows with primeMover == "ALL" and fuelType != "ALL" form an exact partition of
# the plant (verified per plant against its own ALL/ALL row in get_plants).
# We group by fuelType and look emission factors up on fuel2002.
FUELTYPE_TO_DETAIL = {
    "COL": "coal",              # coal, excluding waste coal
    "WOC": "coal",              # waste coal
    "NG": "gas",
    "OOG": "other",             # blast furnace / other manufactured gas
    "DFO": "petroleum",         # distillate fuel oil
    "RFO": "petroleum",         # residual fuel oil
    "PC": "petroleum",          # petroleum coke
    "WOO": "petroleum",         # waste oil and other oils (WO, KER, JF, PG)
    "NUC": "nuclear",
    "HYC": "hydro",             # conventional hydroelectric
    "HPS": "pumped_storage",    # pumped storage, net of pumping load
    "WND": "wind",
    "SUN": "solar_utility",
    "GEO": "geothermal",
    "WWW": "biomass",           # wood waste solids (WDS, BLQ, WDL)
    "MLG": "biomass",           # landfill gas + biogenic MSW (LFG, MSB)
    "ORW": "biomass",           # other renewables (OBG, AB, OBS, OBL, SLW)
    "OTH": "other",             # non-biogenic MSW, waste heat, storage, steam
}

# ─────────────────────────────────────────────────────────────────────────────
# CO2 emission factors, kg CO2 per million Btu.
#
# "epa_a3"   = EIA, Electric Power Annual, Table A.3 "Carbon dioxide
#              uncontrolled emission factors"
#              https://www.eia.gov/electricity/annual/html/epa_a_03.html
# "coeff"    = EIA, "Carbon Dioxide Emissions Coefficients"
#              https://www.eia.gov/environment/emissions/co2_vol_mass.php
#
# Keys are fuel2002 (specific EIA-923 fuel) codes. `kind` decides the treatment:
#   "fossil"    counted in the headline CO2 figure
#   "zero"      genuinely no combustion CO2 (nuclear, wind, solar, water) -> 0
#   "biogenic"  biomass carbon: EXCLUDED from CO2 totals, matching EIA's own
#               state electric-power CO2 series. EIA publishes no electric-power
#               factor for these streams, so no tonnage is estimated at all; the
#               biogenic FUEL burned is reported instead, so the size of what is
#               being left out is visible rather than implied to be zero
#   "unknown"   EIA publishes no single applicable factor: reported as
#               unattributed rather than guessed at
# ─────────────────────────────────────────────────────────────────────────────
def _f(kg, src, kind="fossil", note=None):
    d = {"kg_per_mmbtu": kg, "src": src, "kind": kind}
    if note:
        d["note"] = note
    return d


FACTORS: dict[str, dict] = {
    # ---- coal ----
    "ANT": _f(103.69, "coeff"),
    "BIT": _f(93.24, "epa_a3"),
    "SUB": _f(97.13, "epa_a3"),
    "LIG": _f(98.27, "epa_a3"),
    "RC": _f(93.24, "epa_a3"),
    "WC": _f(93.24, "epa_a3"),
    "SC": _f(93.24, "epa_a3"),
    "SGC": _f(93.24, "epa_a3"),
    # ---- natural gas ----
    "NG": _f(52.91, "epa_a3"),
    # ---- petroleum ----
    "DFO": _f(74.14, "epa_a3"),
    "RFO": _f(75.09, "epa_a3"),
    "JF": _f(72.23, "epa_a3"),
    "KER": _f(73.19, "epa_a3"),
    "WO": _f(74.00, "epa_a3"),
    "PC": _f(102.12, "epa_a3"),
    "SGP": _f(102.12, "epa_a3"),
    "PG": _f(62.88, "epa_a3"),
    # ---- non-biogenic waste ----
    "TDF": _f(85.97, "epa_a3"),
    "MSN": _f(49.89, "coeff", note="EIA publishes one municipal-solid-waste factor; applied to the non-biogenic MSW stream."),
    "MSW": _f(49.89, "coeff"),
    # ---- genuinely carbon-free at the point of generation ----
    "NUC": _f(0.0, None, "zero"),
    "WND": _f(0.0, None, "zero"),
    "SUN": _f(0.0, None, "zero"),
    "WAT": _f(0.0, None, "zero"),
    "H2": _f(0.0, None, "zero", note="No combustion CO2; upstream production emissions are out of scope."),
    "MWH": _f(0.0, None, "zero", note="Electricity consumed for storage, not a combusted fuel."),
    # ---- no single published EIA factor: left unattributed ----
    "GEO": _f(None, "epa_a3", "unknown",
              note="EIA gives 11.81 kg/MMBtu for steam plants and 0.00 for binary-cycle plants; the API does not say which a given plant is, so geothermal is left unattributed."),
    "BFG": _f(None, None, "unknown", note="Blast furnace gas: no EIA electric-power emission factor published."),
    "OG": _f(None, None, "unknown", note="Other manufactured gas: composition varies by site, no single EIA factor."),
    "OOG": _f(None, None, "unknown"),
    "PUR": _f(None, None, "unknown", note="Purchased steam: emissions belong to the producing facility."),
    "WH": _f(None, None, "unknown", note="Waste heat recovery: no fuel combusted at this plant."),
    "OTH": _f(None, None, "unknown"),
    # ---- biogenic: excluded from headline CO2 ----
    **{c: _f(None, None, "biogenic") for c in
       ["AB", "BLQ", "LFG", "MSB", "OBG", "OBL", "OBS", "SLW", "WDL", "WDS"]},
}

FACTOR_SOURCES = {
    "epa_a3": {
        "title": "EIA, Electric Power Annual, Table A.3 — Carbon dioxide uncontrolled emission factors",
        "url": "https://www.eia.gov/electricity/annual/html/epa_a_03.html",
    },
    "coeff": {
        "title": "EIA, Carbon Dioxide Emissions Coefficients",
        "url": "https://www.eia.gov/environment/emissions/co2_vol_mass.php",
    },
}

# 50 states + DC. EIA also returns census regions and US totals on the same
# route; we filter to these.
STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
    "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine",
    "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
    "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}


# ─────────────────────────────────────────────────────────────────────────────
# HTTP
# ─────────────────────────────────────────────────────────────────────────────
def load_key() -> str:
    key = os.environ.get("EIA_API_KEY", "").strip()
    if not key:
        env = ROOT / ".env"
        if env.exists():
            for line in env.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("EIA_API_KEY"):
                    key = line.split("=", 1)[1].strip().strip("'\"")
    if not key:
        sys.exit(
            "ERROR: no EIA API key.\n"
            "  Get a free key at https://www.eia.gov/opendata/register.php\n"
            "  then either  set EIA_API_KEY=yourkey\n"
            "  or create a .env file at the repo root containing:\n"
            "      EIA_API_KEY=yourkey\n"
            "  (.env is gitignored and never published.)"
        )
    return key


def fetch(key: str, route: str, params: list[tuple[str, str]], use_cache: bool = True) -> dict:
    """GET one page of the EIA API, with an on-disk cache of raw responses."""
    qs = urllib.parse.urlencode(params, doseq=True)
    # hashlib, not hash(): str hashing is salted per process, so hash() would
    # produce a different filename every run and the cache would never hit.
    digest = hashlib.sha1(qs.encode("utf-8")).hexdigest()[:16]
    cache_key = f"{route.strip('/').replace('/', '_')}__{digest}.json"
    cache_file = CACHE / cache_key
    if use_cache and cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))

    url = f"{API}{route}?" + urllib.parse.urlencode([("api_key", key)] + params, doseq=True)
    last = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "50-states-of-electricity/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                payload = json.loads(r.read())
            CACHE.mkdir(exist_ok=True)
            cache_file.write_text(json.dumps(payload), encoding="utf-8")
            return payload
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            wait = 2 ** attempt
            print(f"    retry {attempt + 1}/5 after {wait}s ({type(e).__name__}: {e})", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"EIA request failed after 5 attempts: {route} :: {last}")


def fetch_all(key: str, route: str, params: list[tuple[str, str]], use_cache: bool = True,
              label: str = "") -> list[dict]:
    """Page through every row for a query."""
    rows: list[dict] = []
    offset = 0
    total = None
    while True:
        page = fetch(key, route, params + [("offset", str(offset)), ("length", str(PAGE))], use_cache)
        resp = page.get("response", {})
        if total is None:
            total = int(resp.get("total", 0))
            print(f"  {label or route}: {total:,} rows", flush=True)
        batch = resp.get("data", [])
        rows.extend(batch)
        offset += PAGE
        if not batch or offset >= total:
            break
        print(f"    ...{min(offset, total):,}/{total:,}", flush=True)
    return rows


def num(v) -> float:
    """EIA returns numbers as strings, nulls, or absent keys."""
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def to_mwh(value: float, units: str | None) -> float:
    """Normalise EIA generation units to MWh."""
    u = (units or "").lower()
    if "thousand megawatthours" in u:
        return value * 1_000.0
    if "million megawatthours" in u:
        return value * 1_000_000.0
    if "megawatthours" in u:
        return value
    if "gigawatthours" in u:
        return value * 1_000.0
    if "kilowatthours" in u:
        return value / 1_000.0
    raise ValueError(f"unrecognised generation units: {units!r}")


# ─────────────────────────────────────────────────────────────────────────────
# Extract
# ─────────────────────────────────────────────────────────────────────────────
def get_state_mix(key: str, use_cache: bool) -> tuple[dict, dict, list[str]]:
    """State x energy source net generation (MWh), plus small-scale solar."""
    fuels = STATE_PARTITION + [DPV_CODE, "ALL"]
    rows = fetch_all(
        key,
        "electricity/electric-power-operational-data/data/",
        [("frequency", "annual"), ("start", str(YEAR)), ("end", str(YEAR)),
         ("data[]", "generation"), ("facets[sectorid][]", "99")]
        + [("facets[fueltypeid][]", f) for f in fuels],
        use_cache,
        label="state generation mix",
    )
    # location -> fuelcode -> MWh
    mix: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for r in rows:
        loc = r.get("location")
        fuel = r.get("fueltypeid")
        if loc not in STATES and loc != "US":
            continue  # skip census regions
        if r.get("generation") is None:
            continue
        mix[loc][fuel] += to_mwh(num(r["generation"]), r.get("generation-units"))
    warnings = validate_state_partition(mix)
    return mix, {}, warnings


def validate_state_partition(mix: dict) -> list[str]:
    """The 13 partition codes must sum to EIA's own ALL series."""
    warnings = []
    for loc, fuels in sorted(mix.items()):
        part = sum(fuels.get(f, 0.0) for f in STATE_PARTITION)
        allv = fuels.get("ALL", 0.0)
        if allv and abs(part - allv) / abs(allv) > 0.005:
            warnings.append(
                f"{loc}: fuel partition {part:,.0f} MWh != EIA ALL {allv:,.0f} MWh "
                f"({(part - allv) / allv * 100:+.2f}%)"
            )
    return warnings


def get_plants(key: str, use_cache: bool) -> tuple[dict, list[str]]:
    """Per-plant, per-fuel generation, fuel burned, and estimated CO2."""
    rows = fetch_all(
        key,
        "electricity/facility-fuel/data/",
        [("frequency", "annual"), ("start", str(YEAR)), ("end", str(YEAR)),
         ("data[]", "generation"), ("data[]", "consumption-for-eg-btu"),
         ("data[]", "total-consumption-btu")],
        use_cache,
        label="plant-level generation",
    )
    plants: dict[str, dict] = {}
    unmapped_type: dict[str, float] = defaultdict(float)
    unmapped_fuel: dict[str, float] = defaultdict(float)
    # each plant's own ALL/ALL row, kept aside to validate the partition
    plant_totals: dict[str, dict[str, float]] = {}

    for r in rows:
        state = r.get("state")
        if state not in STATES:
            continue
        pid = str(r.get("plantCode"))
        ftype, f2002, pm = r.get("fuelType"), r.get("fuel2002"), r.get("primeMover")
        gen = to_mwh(num(r.get("generation")), r.get("generation-units") or "megawatthours")
        mmbtu_eg = num(r.get("consumption-for-eg-btu"))
        mmbtu_tot = num(r.get("total-consumption-btu"))

        # The plant's own reported total — our cross-check, not an input.
        if ftype == "ALL" and pm == "ALL":
            plant_totals[pid] = {"gen": gen, "mmbtu_eg": mmbtu_eg, "mmbtu_tot": mmbtu_tot}
            continue
        # Keep only per-fuel rows rolled up across prime movers: these partition
        # the plant exactly, so nothing is double-counted.
        if pm != "ALL" or ftype == "ALL":
            continue

        detail = FUELTYPE_TO_DETAIL.get(ftype)
        if detail is None:
            unmapped_type[ftype] += gen
            detail = "other"

        p = plants.setdefault(pid, {
            "id": pid,
            "name": (r.get("plantName") or "").strip(),
            "state": state,
            "gen_mwh": 0.0,
            "by_detail": defaultdict(float),
            "co2_t": 0.0,             # electricity-only basis (headline)
            "co2_total_t": 0.0,       # all fuel burned, incl. useful thermal output
            "mmbtu_biogenic": 0.0,    # biomass fuel burned; deliberately not priced
            "mmbtu_eg": 0.0,
            "mmbtu_unattributed": 0.0,
            "fuels": {},
        })
        p["gen_mwh"] += gen
        p["by_detail"][detail] += gen
        p["mmbtu_eg"] += mmbtu_eg

        f = FACTORS.get(f2002)
        if f is None:
            unmapped_fuel[f2002] += gen
            kind, factor = "unknown", None
        else:
            kind, factor = f["kind"], f["kg_per_mmbtu"]

        if kind == "biogenic":
            # No tonnage is estimated: EIA publishes no electric-power factor for
            # these streams and its own state series excludes biogenic carbon.
            # Record the fuel burned so the exclusion is a disclosed quantity
            # rather than a silent zero.
            p["mmbtu_biogenic"] += mmbtu_eg
        elif factor is None:
            p["mmbtu_unattributed"] += mmbtu_eg
        else:
            p["co2_t"] += mmbtu_eg * factor / 1000.0
            p["co2_total_t"] += mmbtu_tot * factor / 1000.0

        fr = p["fuels"].setdefault(f2002, {
            "fuel_type": ftype, "gen_mwh": 0.0, "mmbtu_eg": 0.0, "mmbtu_total": 0.0, "kind": kind,
        })
        fr["gen_mwh"] += gen
        fr["mmbtu_eg"] += mmbtu_eg
        fr["mmbtu_total"] += mmbtu_tot

    # ── validate: our per-fuel partition must reproduce each plant's ALL row ──
    bad_gen = bad_btu = 0
    worst = None
    for pid, p in plants.items():
        t = plant_totals.get(pid)
        if not t:
            continue
        if abs(t["gen"]) > 1000 and abs(p["gen_mwh"] - t["gen"]) / abs(t["gen"]) > 0.005:
            bad_gen += 1
            d = abs(p["gen_mwh"] - t["gen"])
            if worst is None or d > worst[1]:
                worst = (pid, d)
        if t["mmbtu_eg"] > 1000 and abs(p["mmbtu_eg"] - t["mmbtu_eg"]) / t["mmbtu_eg"] > 0.005:
            bad_btu += 1

    warnings = []
    warnings += [f"unmapped fuelType {c!r}: {g:,.0f} MWh" for c, g in
                 sorted(unmapped_type.items(), key=lambda kv: -abs(kv[1]))]
    warnings += [f"unmapped fuel2002 {c!r} (no CO2 factor): {g:,.0f} MWh" for c, g in
                 sorted(unmapped_fuel.items(), key=lambda kv: -abs(kv[1]))]
    if bad_gen:
        warnings.append(f"{bad_gen} plants where the per-fuel generation partition "
                        f"disagrees with the plant's own ALL row by >0.5% (worst: plant {worst[0]}, {worst[1]:,.0f} MWh)")
    if bad_btu:
        warnings.append(f"{bad_btu} plants where the per-fuel MMBtu partition "
                        f"disagrees with the plant's own ALL row by >0.5%")
    print(f"    partition check: {len(plants):,} plants, "
          f"{bad_gen} generation mismatches, {bad_btu} MMBtu mismatches")
    return plants, warnings


def get_plant_meta(key: str, use_cache: bool) -> dict:
    """Plant metadata from the generator inventory (EIA-860)."""
    rows = fetch_all(
        key,
        "electricity/operating-generator-capacity/data/",
        [("frequency", "monthly"), ("start", f"{YEAR}-12"), ("end", f"{YEAR}-12"),
         ("data[]", "nameplate-capacity-mw"), ("data[]", "county"),
         ("data[]", "latitude"), ("data[]", "longitude")],
        use_cache,
        label="plant metadata",
    )
    meta: dict[str, dict] = {}
    for r in rows:
        pid = str(r.get("plantid"))
        m = meta.setdefault(pid, {
            "operator": (r.get("entityName") or "").strip(),
            "county": (r.get("county") or "").strip(),
            "lat": None, "lon": None,
            "capacity_mw": 0.0,
            "ba": (r.get("balancing-authority-code") or "") or None,
            "sector": (r.get("sectorName") or "").strip(),
            "techs": set(),
        })
        m["capacity_mw"] += num(r.get("nameplate-capacity-mw"))
        if m["lat"] is None and r.get("latitude") not in (None, ""):
            try:
                m["lat"] = round(float(r["latitude"]), 4)
                m["lon"] = round(float(r["longitude"]), 4)
            except (TypeError, ValueError):
                pass
        if r.get("technology"):
            m["techs"].add(r["technology"])
    for m in meta.values():
        m["techs"] = sorted(m["techs"])
    return meta


SD_COLS = [
    "total-net-generation", "total-international-imports", "total-international-exports",
    "total-supply", "total-elect-indust", "direct-use", "estimated-losses",
    "net-interstate-trade", "unaccounted", "total-disposition",
]


def get_supply_disposition(key: str, use_cache: bool) -> dict:
    """
    Where each state's electricity came from and where it went (EIA State
    Electricity Profiles, supply & disposition).

    Sign convention worth pinning down: EIA labels `net-interstate-trade`
    "Net Interstate Imports", but it sits on the DISPOSITION side of the
    balance, so a net importer carries a NEGATIVE value. Verified against the
    accounting identity for 2024 -- California -53.2 TWh (a well-known net
    importer) and Wyoming +21.0 TWh (generates 40.7 TWh against 17.2 TWh of
    retail sales, so a heavy net exporter). We therefore flip the sign into
    `net_interstate_imports_mwh`, where positive means imported.
    """
    rows = fetch_all(
        key,
        "electricity/state-electricity-profiles/source-disposition/data/",
        [("frequency", "annual"), ("start", str(YEAR)), ("end", str(YEAR))]
        + [("data[]", c) for c in SD_COLS],
        use_cache,
        label="supply & disposition by state",
    )
    out: dict[str, dict] = {}
    for r in rows:
        st = r.get("state") or r.get("stateid")
        if st not in STATES and st != "US":
            continue
        out[st] = {c: num(r.get(c)) for c in SD_COLS}
    return out


def demand_block(sd: dict | None) -> dict | None:
    """Turn one supply/disposition row into the figures the dashboard shows."""
    if not sd:
        return None
    gen = sd["total-net-generation"]
    intl_in, intl_out = sd["total-international-imports"], sd["total-international-exports"]
    net_interstate = -sd["net-interstate-trade"]          # flip: positive = imported
    net_intl = intl_in - intl_out
    net_imports = net_interstate + net_intl
    retail, direct, losses = sd["total-elect-indust"], sd["direct-use"], sd["estimated-losses"]
    consumed = retail + direct
    # Everything the state had available to use: own generation plus net imports.
    available = gen + net_imports
    return {
        "generation_mwh": r2(gen),
        "retail_sales_mwh": r2(retail),
        "direct_use_mwh": r2(direct),
        "consumed_mwh": r2(consumed),
        "losses_mwh": r2(losses),
        "requirement_mwh": r2(consumed + losses),
        "intl_imports_mwh": r2(intl_in),
        "intl_exports_mwh": r2(intl_out),
        "net_interstate_imports_mwh": r2(net_interstate),
        "net_intl_imports_mwh": r2(net_intl),
        "net_imports_mwh": r2(net_imports),
        "available_mwh": r2(available),
        "unaccounted_mwh": r2(sd["unaccounted"]),
        # Share of the electricity a state used that came from outside its borders.
        # Negative for net exporters, so it is only meaningful for importers.
        "import_share_pct": r2(net_imports / available * 100, 2) if available > 0 else None,
        "is_net_importer": net_imports > 0,
    }


def get_official_co2(key: str, use_cache: bool) -> dict:
    """EIA's own electric-power CO2 by state and fuel (thousand metric tons)."""
    rows = fetch_all(
        key,
        "electricity/state-electricity-profiles/emissions-by-state-by-fuel/data/",
        [("frequency", "annual"), ("start", str(YEAR)), ("end", str(YEAR)),
         ("data[]", "co2-thousand-metric-tons")],
        use_cache,
        label="official EIA CO2 by state",
    )
    out: dict[str, dict[str, float]] = defaultdict(dict)
    for r in rows:
        st = r.get("stateid")
        if st not in STATES and st != "US":
            continue
        out[st][r.get("fuelid")] = num(r.get("co2-thousand-metric-tons"))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Transform
# ─────────────────────────────────────────────────────────────────────────────
def r2(x: float, nd: int = 1) -> float:
    return round(x + 0.0, nd)


def detail_block(by_detail: dict[str, float]) -> list[dict]:
    """
    Ordered energy-source rows. Only exact zeros are dropped: a magnitude
    threshold here would let a small contribution vanish from the breakdown
    while still counting toward the total, so the rows would stop reconciling
    with it (verify_data.py checks exactly that).
    """
    out = []
    for d in DETAIL_ORDER:
        v = by_detail.get(d, 0.0)
        if v == 0:
            continue
        out.append({"key": d, "label": DETAIL_LABEL[d], "mwh": r2(v)})
    return out



RENEWABLE_DETAILS = {"hydro", "wind", "solar_utility", "solar_small_scale",
                     "geothermal", "biomass"}

# Fossil share is computed from the EIA energy-source CODES, not from the display
# categories. "Other gases" (blast furnace and other manufactured gas) is fossil,
# but it is reported inside the "Other" display category, which also holds
# non-fossil items like waste heat and storage. Reading the codes keeps the share
# exact regardless of how the categories are grouped for the charts.
FOSSIL_STATE_CODES = {"COW", "NG", "OOG", "PEL", "PC"}


def summarise(by_detail: dict[str, float], fuels: dict[str, float]) -> dict:
    total = sum(v for v in by_detail.values())
    pos = sum(v for v in by_detail.values() if v > 0)
    share = lambda keys: (sum(by_detail.get(k, 0.0) for k in keys) / pos * 100) if pos else 0.0
    fossil = sum(fuels.get(c, 0.0) for c in FOSSIL_STATE_CODES)
    return {
        "total_mwh": r2(total),
        "fossil_pct": r2(fossil / pos * 100 if pos else 0.0, 2),
        "renewable_pct": r2(share(RENEWABLE_DETAILS), 2),
        "carbon_free_pct": r2(share(RENEWABLE_DETAILS | {"nuclear"}), 2),
    }


def build():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-cache", action="store_true", help="ignore the raw response cache")
    args = ap.parse_args()
    use_cache = not args.no_cache

    key = load_key()
    print(f"Building {YEAR} dataset from the EIA API v2\n")

    mix, _, mix_warnings = get_state_mix(key, use_cache)
    plants, plant_warnings = get_plants(key, use_cache)
    meta = get_plant_meta(key, use_cache)
    official = get_official_co2(key, use_cache)
    supply = get_supply_disposition(key, use_cache)

    warnings = mix_warnings + plant_warnings
    print()

    # ── attach metadata, group plants by state ──────────────────────────────
    by_state: dict[str, list[dict]] = defaultdict(list)
    for p in plants.values():
        m = meta.get(p["id"], {})
        primary = max(p["by_detail"].items(), key=lambda kv: kv[1])[0] if p["by_detail"] else "other"
        rec = {
            "id": p["id"],
            "name": p["name"],
            "operator": m.get("operator") or None,
            "county": m.get("county") or None,
            "lat": m.get("lat"),
            "lon": m.get("lon"),
            "capacity_mw": r2(m.get("capacity_mw", 0.0), 1) or None,
            "ba": m.get("ba"),
            "sector": m.get("sector") or None,
            "gen_mwh": r2(p["gen_mwh"]),
            "primary": primary,
            "co2_t": r2(p["co2_t"], 0),
            "co2_total_t": r2(p["co2_total_t"], 0),
            "biogenic_mmbtu": r2(p["mmbtu_biogenic"], 0),
            "sources": detail_block(p["by_detail"]),
            # per-fuel detail for the methodology drawer
            "fuel_codes": {c: {"gen_mwh": r2(v["gen_mwh"]), "mmbtu": r2(v["mmbtu_eg"], 0),
                               "kind": v["kind"]}
                           for c, v in sorted(p["fuels"].items())
                           if v["gen_mwh"] or v["mmbtu_eg"]},
            "co2_unattributed_mmbtu": r2(p["mmbtu_unattributed"], 0),
        }
        rec["co2_kg_per_mwh"] = r2(p["co2_t"] * 1000 / p["gen_mwh"], 1) if p["gen_mwh"] > 0 else None
        by_state[p["state"]].append(rec)

    for lst in by_state.values():
        lst.sort(key=lambda r: -r["gen_mwh"])

    # ── per-state files ─────────────────────────────────────────────────────
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "state").mkdir(exist_ok=True)

    index_rows = []
    us_detail: dict[str, float] = defaultdict(float)
    us_fuels: dict[str, float] = defaultdict(float)   # raw codes, for fossil share

    for code, name in sorted(STATES.items(), key=lambda kv: kv[1]):
        fuels = mix.get(code, {})
        by_detail: dict[str, float] = defaultdict(float)
        for fc, detail in STATE_FUEL_TO_DETAIL.items():
            by_detail[detail] += fuels.get(fc, 0.0)
        by_detail["solar_small_scale"] += fuels.get(DPV_CODE, 0.0)
        for d, v in by_detail.items():
            us_detail[d] += v
        for fc in STATE_PARTITION:
            us_fuels[fc] += fuels.get(fc, 0.0)

        plist = by_state.get(code, [])
        est_co2 = sum(p["co2_t"] for p in plist)
        est_co2_total = sum(p["co2_total_t"] for p in plist)
        off_co2 = official.get(code, {}).get("ALL", 0.0) * 1000.0  # kt -> t
        summary = summarise(by_detail, fuels)

        state_doc = {
            "year": YEAR,
            "code": code,
            "name": name,
            **summary,
            "utility_scale_mwh": r2(sum(v for d, v in by_detail.items() if d != "solar_small_scale")),
            "small_scale_solar_mwh": r2(by_detail.get("solar_small_scale", 0.0)),
            "sources": detail_block(by_detail),
            "co2": {
                "estimate_t": r2(est_co2, 0),
                "estimate_all_fuel_t": r2(est_co2_total, 0),
                "eia_official_t": r2(off_co2, 0),
                "eia_official_by_fuel_t": {k: r2(v * 1000.0, 0)
                                           for k, v in sorted(official.get(code, {}).items())
                                           if k != "ALL"},
                "ratio_to_official": r2(est_co2_total / off_co2, 3) if off_co2 else None,
                "biogenic_mmbtu": r2(sum(p["biogenic_mmbtu"] for p in plist), 0),
                "unattributed_mmbtu": r2(sum(p["co2_unattributed_mmbtu"] for p in plist), 0),
            },
            "plant_count": len(plist),
            "demand": demand_block(supply.get(code)),
            "plants": plist,
        }
        if summary["total_mwh"]:
            state_doc["co2_kg_per_mwh"] = r2(est_co2 * 1000 / summary["total_mwh"], 1)

        (DATA / "state" / f"{code}.json").write_text(
            json.dumps(state_doc, separators=(",", ":")), encoding="utf-8")

        index_rows.append({
            "code": code, "name": name,
            "total_mwh": summary["total_mwh"],
            "small_scale_solar_mwh": state_doc["small_scale_solar_mwh"],
            "fossil_pct": summary["fossil_pct"],
            "renewable_pct": summary["renewable_pct"],
            "carbon_free_pct": summary["carbon_free_pct"],
            "co2_t": r2(est_co2, 0),
            "co2_official_t": r2(off_co2, 0),
            "co2_kg_per_mwh": state_doc.get("co2_kg_per_mwh"),
            "plant_count": len(plist),
            # Detailed sources travel with the index too, so the cross-state
            # chart can name what is inside its "Other" slot, and the by-source
            # rankings can be built without loading 51 state files. Petroleum is
            # 66% of Hawaii's generation but only ever reads as "Other" otherwise.
            "sources": detail_block(by_detail),
            "demand": demand_block(supply.get(code)),
        })

    # ── national ────────────────────────────────────────────────────────────
    all_plants = [p for lst in by_state.values() for p in lst]
    all_plants.sort(key=lambda r: -r["gen_mwh"])
    us_est = sum(p["co2_t"] for p in all_plants)
    us_est_total = sum(p["co2_total_t"] for p in all_plants)
    us_off = official.get("US", {}).get("ALL", 0.0) * 1000.0
    if not us_off:
        us_off = sum(r["co2_official_t"] for r in index_rows)
    us_summary = summarise(us_detail, us_fuels)

    us_doc = {
        "year": YEAR, "code": "US", "name": "United States",
        **us_summary,
        "utility_scale_mwh": r2(sum(v for d, v in us_detail.items() if d != "solar_small_scale")),
        "small_scale_solar_mwh": r2(us_detail.get("solar_small_scale", 0.0)),
        "sources": detail_block(us_detail),
        "co2": {
            "estimate_t": r2(us_est, 0),
            "estimate_all_fuel_t": r2(us_est_total, 0),
            "eia_official_t": r2(us_off, 0),
            "ratio_to_official": r2(us_est_total / us_off, 3) if us_off else None,
            "biogenic_mmbtu": r2(sum(p["biogenic_mmbtu"] for p in all_plants), 0),
            "unattributed_mmbtu": r2(sum(p["co2_unattributed_mmbtu"] for p in all_plants), 0),
        },
        "plant_count": len(all_plants),
        # National: interstate trade nets out across states, so only the
        # international balance is a real import. Summed rather than taken from a
        # US row so it always agrees with the state figures shown alongside.
        "demand": (lambda ds: {
            **{k: r2(sum(d[k] for d in ds)) for k in
               ("generation_mwh", "retail_sales_mwh", "direct_use_mwh", "consumed_mwh",
                "losses_mwh", "requirement_mwh", "intl_imports_mwh", "intl_exports_mwh",
                "net_interstate_imports_mwh", "net_intl_imports_mwh", "unaccounted_mwh")},
            "net_imports_mwh": r2(sum(d["net_intl_imports_mwh"] for d in ds)),
            "available_mwh": r2(sum(d["generation_mwh"] + d["net_intl_imports_mwh"] for d in ds)),
            "import_share_pct": r2(
                sum(d["net_intl_imports_mwh"] for d in ds)
                / sum(d["generation_mwh"] + d["net_intl_imports_mwh"] for d in ds) * 100, 2),
            "is_net_importer": sum(d["net_intl_imports_mwh"] for d in ds) > 0,
            "interstate_residual_mwh": r2(sum(d["net_interstate_imports_mwh"] for d in ds)),
        })([d for d in (demand_block(supply.get(c)) for c in STATES) if d]),
        "co2_kg_per_mwh": r2(us_est * 1000 / us_summary["total_mwh"], 1) if us_summary["total_mwh"] else None,
        # the national file carries the 300 largest plants; per-state files hold
        # every plant, so the landing view stays small
        "plants": all_plants[:300],
        "plants_truncated": True,
    }
    (DATA / "us.json").write_text(json.dumps(us_doc, separators=(",", ":")), encoding="utf-8")

    index_rows.sort(key=lambda r: -r["total_mwh"])
    (DATA / "index.json").write_text(json.dumps({
        "year": YEAR,
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "detail_order": DETAIL_ORDER,
        "detail_labels": DETAIL_LABEL,
        "us": {k: us_doc[k] for k in
               ("total_mwh", "small_scale_solar_mwh", "fossil_pct", "renewable_pct",
                "carbon_free_pct", "plant_count", "co2_kg_per_mwh")},
        "states": index_rows,
    }, separators=(",", ":")), encoding="utf-8")

    # ── metadata / provenance ───────────────────────────────────────────────
    used_factors = {
        code: {
            "kg_co2_per_mmbtu": f["kg_per_mmbtu"],
            "treatment": f["kind"],
            "source": f.get("src"),
            **({"note": f["note"]} if f.get("note") else {}),
        }
        for code, f in sorted(FACTORS.items())
    }

    (DATA / "meta.json").write_text(json.dumps({
        "year": YEAR,
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "api": "EIA API v2 (https://api.eia.gov/v2/)",
        "sources": [
            {
                "id": "operational",
                "title": "EIA, Electric Power Operations (Annual and Monthly) — net generation by state and energy source",
                "route": "electricity/electric-power-operational-data",
                "url": "https://www.eia.gov/opendata/browser/electricity/electric-power-operational-data",
                "form": "Form EIA-923",
                "used_for": "State and national generation mix; estimated small-scale (behind-the-meter) solar PV via energy-source code DPV.",
            },
            {
                "id": "facility",
                "title": "EIA, Electric Power Operations for Individual Power Plants (Annual and Monthly)",
                "route": "electricity/facility-fuel",
                "url": "https://www.eia.gov/opendata/browser/electricity/facility-fuel",
                "form": "Form EIA-923",
                "used_for": "Per-plant net generation (MWh) and fuel consumed for electricity generation (MMBtu), the basis of the per-plant CO2 estimate.",
            },
            {
                "id": "generators",
                "title": "EIA, Inventory of Operable Generators",
                "route": "electricity/operating-generator-capacity",
                "url": "https://www.eia.gov/opendata/browser/electricity/operating-generator-capacity",
                "form": "Form EIA-860 / EIA-860M",
                "used_for": "Plant operator, county, coordinates, nameplate capacity, balancing authority.",
            },
            {
                "id": "disposition",
                "title": "EIA, State Electricity Profiles — Supply and disposition of electricity",
                "route": "electricity/state-electricity-profiles/source-disposition",
                "url": "https://www.eia.gov/opendata/browser/electricity/state-electricity-profiles",
                "used_for": "State electricity demand (retail sales, direct use), transmission and distribution losses, international imports and exports, and net interstate trade.",
            },
            {
                "id": "emissions",
                "title": "EIA, State Electricity Profiles — Emissions by state by fuel",
                "route": "electricity/state-electricity-profiles/emissions-by-state-by-fuel",
                "url": "https://www.eia.gov/opendata/browser/electricity/state-electricity-profiles",
                "used_for": "EIA's own official electric-power CO2 by state, shown alongside our plant-level estimate as a cross-check.",
            },
            *[{"id": k, "title": v["title"], "url": v["url"],
               "used_for": "CO2 emission factors (kg CO2 per MMBtu)."}
              for k, v in FACTOR_SOURCES.items()],
        ],
        "methodology": {
            "generation": (
                "Net generation for calendar year 2024, all sectors, from Form EIA-923 as served by "
                "the EIA API. State mixes use the 13 mutually exclusive energy-source codes that sum "
                "exactly to EIA's own all-fuels total; the build verifies that identity for every state."
            ),
            "small_scale_solar": (
                "Behind-the-meter solar is EIA's own estimate of small-scale (<1 MW) distributed solar "
                "PV generation, energy-source code DPV, published by state and sector. It is not part "
                "of utility-scale net generation, so it is reported separately and added on top of the "
                "utility-scale total rather than being mixed into it. It is an EIA model estimate, not "
                "metered generation, and no plant-level detail exists for it."
            ),
            "co2": (
                "Per-plant CO2 is an estimate, not a measurement. For each plant and each fuel it "
                "burns, CO2 = fuel consumed (MMBtu, Form EIA-923) x the EIA CO2 emission factor for "
                "that specific fuel. Fuel codes are read at EIA's finest granularity, so bituminous, "
                "subbituminous and lignite coal each get their own factor rather than a coal average. "
                "Two bases are reported: the headline per-plant figure uses fuel consumed FOR "
                "ELECTRICITY GENERATION, which excludes fuel burned for useful thermal output at "
                "combined-heat-and-power plants and so reflects electricity alone; the all-fuel basis "
                "adds that thermal fuel back and is what we compare against EIA's own published state "
                "total. Biogenic CO2 from biomass is excluded from both, matching EIA's state "
                "electric-power CO2 series: EIA publishes no electric-power emission factor for wood, "
                "black liquor, landfill gas or biogenic municipal waste, so no tonnage is estimated "
                "for them at all. Because that exclusion is a convention rather than an absence of "
                "stack emissions, the biogenic FUEL burned is reported instead, so its scale is "
                "visible. Nuclear, wind, solar and water are zero by construction. "
                "Fuels for which EIA publishes no single applicable factor - geothermal (which differs "
                "between steam and binary-cycle plants), blast-furnace and other manufactured gases, "
                "purchased steam and waste heat - are left unattributed rather than guessed at, and "
                "the unattributed MMBtu is reported so the gap is visible. Every state view shows our "
                "estimate next to EIA's official state total."
            ),
            "demand_and_trade": (
                "Demand is what a state's customers actually used: retail sales to end users plus "
                "electricity generated and consumed on site by commercial and industrial facilities "
                "(direct use). Transmission and distribution losses are reported separately, and the "
                "three together are the state's total requirement. Net imports are what the state had "
                "to bring in beyond its own generation: net interstate trade plus net international "
                "trade with Canada and Mexico. EIA reports interstate trade on the disposition side of "
                "the balance, so a net importer carries a negative value in the raw series; we flip "
                "the sign so positive always means imported, and verified it against the accounting "
                "identity (California nets -53.2 TWh in the raw series and is a well-known net "
                "importer; Wyoming nets +21.0 TWh against just 17.2 TWh of retail sales). Import "
                "dependence is net imports as a share of all electricity the state had available. "
                "EIA does NOT publish state-to-state electricity flows, so this dashboard does not "
                "claim to say which particular states a given state imported from - see the caveats."
            ),
            "caveats": [
                "Generation is in-state production, not consumption: it excludes imports and exports, so a state's mix is not the mix its customers consume.",
                "Pumped-storage hydro is net of pumping load and is usually negative; it is a storage round-trip, not a source of energy.",
                "'Other' net generation can be negative in some states, which is why the treemap omits negative values and the bar chart shows them.",
                "Plant coordinates, operator and capacity come from the December 2024 generator inventory; plants that retired mid-year may generate in EIA-923 without appearing there.",
                "Which specific states a state imported from is not shown, because EIA publishes no state-to-state electricity flow data. Only each state's NET position is known. Power flows over an interconnected grid operated by balancing authorities whose footprints cross state lines - PJM alone spans 13 states - so a state-to-state matrix cannot be derived from published state totals without inventing it. EIA's hourly balancing-authority interchange series (electricity/rto/interchange-data) is the closest real directional data, but it is authority-to-authority, not state-to-state.",
                "Net imports can be negative: that state is a net exporter, and its import dependence is not meaningful.",
            ],
        },
        "co2_factors": used_factors,
        "factor_sources": FACTOR_SOURCES,
        "validation": {
            "state_partition_warnings": mix_warnings,
            "plant_fuel_warnings": plant_warnings,
        },
    }, indent=2), encoding="utf-8")

    # ── report ──────────────────────────────────────────────────────────────
    print("=" * 74)
    print(f"US {YEAR}: {us_summary['total_mwh'] / 1e6:,.1f} TWh total "
          f"({us_doc['utility_scale_mwh'] / 1e6:,.1f} utility-scale "
          f"+ {us_doc['small_scale_solar_mwh'] / 1e6:,.1f} small-scale solar)")
    print(f"   fossil {us_summary['fossil_pct']:.1f}%  renewable {us_summary['renewable_pct']:.1f}%  "
          f"carbon-free {us_summary['carbon_free_pct']:.1f}%")
    print(f"   plants: {len(all_plants):,}")
    if us_off:
        print(f"   CO2 (electricity only)  {us_est / 1e6:,.1f} Mt")
        print(f"   CO2 (all fuel burned)   {us_est_total / 1e6:,.1f} Mt")
        print(f"   EIA official            {us_off / 1e6:,.1f} Mt  "
              f"-> all-fuel estimate is {us_est_total / us_off * 100:.1f}% of official")
    print("=" * 74)
    for r in index_rows[:8]:
        print(f"   {r['code']}  {r['total_mwh'] / 1e6:7,.1f} TWh  "
              f"{r['plant_count']:5,} plants  CO2 est {r['co2_t'] / 1e6:6,.1f} Mt "
              f"/ official {r['co2_official_t'] / 1e6:6,.1f} Mt")
    if warnings:
        print("\nWARNINGS:")
        for w in warnings:
            print(f"   - {w}")
    else:
        print("\nNo validation warnings.")
    print(f"\nWrote {len(list((DATA / 'state').glob('*.json')))} state files + us.json, index.json, meta.json")


if __name__ == "__main__":
    build()
