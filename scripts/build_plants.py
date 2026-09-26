#!/usr/bin/env python3
"""
Build the per-plant monthly dataset behind the Power Plant Browser (plants.html).

For every power plant that reported to EIA at any point in the window, this
writes one JSON file with its monthly net generation by energy source, the fuel
it burned, an estimated CO2 figure, and its generator inventory. The window is
the last ten full calendar years plus the current year to date, ending at the
latest month the EIA API serves.

It shares its taxonomy, emission factors and HTTP helpers with build_data.py, so
a plant's figures here are computed exactly the way the Home page computes them.

Sources (all EIA):
  1. electricity/facility-fuel, MONTHLY
     -> per-plant, per-fuel net generation and fuel consumed (Form EIA-923).
  2. electricity/operating-generator-capacity, one snapshot per December plus
     the latest month
     -> generator inventory: capacity, technology, online and planned-retirement
        dates, status, operator, county, coordinates (Form EIA-860M).

Output:
  data/plants/meta.json            window, counts, validation, fuel names
  data/plants/index/XX.json        every plant in a state, for the dropdown
  data/plants/XX/<plantId>.json    one plant, loaded when it is selected

Usage:
    python scripts/build_plants.py              # full build
    python scripts/build_plants.py --no-cache   # ignore the raw response cache
    python scripts/build_plants.py --workers 4  # parallel EIA requests
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import json
import pathlib
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_data import (  # noqa: E402  (shared with the Home page build)
    DATA, DETAIL_LABEL, DETAIL_ORDER, FACTORS, FUELTYPE_TO_DETAIL, PAGE, STATES,
    fetch, load_key, num, r2, to_mwh,
)

OUT = DATA / "plants"
YEARS_BACK = 10

# Fuels whose MMBtu is actual heat input, so MMBtu / MWh is a real heat rate.
# EIA also reports a nominal Btu figure for wind, solar and water; dividing that
# by generation would produce a number that looks like a heat rate and is not.
HEAT_RATE_KINDS = {"fossil", "biogenic"}
HEAT_RATE_EXTRA = {"NUC"}   # nuclear's reported heat input is genuine
STORAGE_DETAILS = {"pumped_storage"}
STORAGE_FUELS = {"MWH"}     # batteries, reported under fuelType OTH

# EIA-923 fuel codes -> plain-language names (same list as the factors page).
FUEL_NAMES = {
    "ANT": "Anthracite coal", "BIT": "Bituminous coal", "SUB": "Subbituminous coal",
    "LIG": "Lignite coal", "RC": "Refined coal", "WC": "Waste coal", "SC": "Coal synfuel",
    "SGC": "Coal-derived synthesis gas", "NG": "Natural gas",
    "DFO": "Distillate fuel oil", "RFO": "Residual fuel oil", "JF": "Jet fuel",
    "KER": "Kerosene", "WO": "Waste oil", "PC": "Petroleum coke",
    "SGP": "Synthesis gas from petroleum coke", "PG": "Gaseous propane",
    "TDF": "Tire-derived fuel", "MSN": "Municipal solid waste (non-biogenic)",
    "MSW": "Municipal solid waste", "NUC": "Nuclear", "WND": "Wind", "SUN": "Solar",
    "WAT": "Water (hydro)", "H2": "Hydrogen", "MWH": "Electricity for storage (batteries)",
    "GEO": "Geothermal", "BFG": "Blast furnace gas", "OG": "Other manufactured gas",
    "OOG": "Other gases", "PUR": "Purchased steam", "WH": "Waste heat", "OTH": "Other",
    "AB": "Agricultural byproducts", "BLQ": "Black liquor", "LFG": "Landfill gas",
    "MSB": "Municipal solid waste (biogenic)", "OBG": "Other biomass gas",
    "OBL": "Other biomass liquids", "OBS": "Other biomass solids", "SLW": "Sludge waste",
    "WDL": "Wood waste liquids", "WDS": "Wood / wood waste solids",
}

# Short fuel names for the plant dropdown, "Plant name (Natural gas)". The
# display categories carry qualifiers that would nest a second pair of brackets.
SHORT_LABEL = {
    "coal": "Coal", "gas": "Natural gas", "petroleum": "Petroleum", "nuclear": "Nuclear",
    "hydro": "Hydro", "wind": "Wind", "solar_utility": "Solar", "geothermal": "Geothermal",
    "biomass": "Biomass", "pumped_storage": "Pumped storage", "other": "Other",
}
# "Other" is a catch-all, so name what is actually inside it where we can.
OTHER_FUEL_LABEL = {
    "MWH": "Battery storage", "WH": "Waste heat", "PUR": "Purchased steam",
    "BFG": "Blast furnace gas", "OG": "Other gases", "OOG": "Other gases",
    "MSN": "Municipal solid waste", "TDF": "Tire-derived fuel", "H2": "Hydrogen",
}


def fuel_label(primary: str, fuels: dict, lo: int, hi: int) -> str:
    if primary != "other":
        return SHORT_LABEL[primary]
    inside = {c: sum(abs(v) for v in f["gen"][lo:hi + 1]) + sum(f["mmbtu"][lo:hi + 1]) / 1e4
              for c, f in fuels.items() if f["detail"] == "other"}
    if not inside or not any(inside.values()):
        return "Other"
    return OTHER_FUEL_LABEL.get(max(inside, key=inside.get), "Other")


# EIA-860M generator status codes that appear on the operating-generator route.
STATUS_LABEL = {
    "OP": "Operating", "SB": "Standby / backup", "OS": "Out of service",
    "OA": "Out of service (returning)",
}


# ─────────────────────────────────────────────────────────────────────────────
# Months
# ─────────────────────────────────────────────────────────────────────────────
def month_add(ym: str, k: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    i = y * 12 + (m - 1) + k
    return f"{i // 12:04d}-{i % 12 + 1:02d}"


def month_range(a: str, b: str) -> list[str]:
    out, cur = [], a
    while cur <= b:
        out.append(cur)
        cur = month_add(cur, 1)
    return out


def hours_in(ym: str) -> int:
    return calendar.monthrange(int(ym[:4]), int(ym[5:7]))[1] * 24


def latest_period(key: str, route: str) -> str:
    meta = fetch(key, f"{route}/", [], use_cache=False)
    return meta["response"]["endPeriod"]


# ─────────────────────────────────────────────────────────────────────────────
# Extract
# ─────────────────────────────────────────────────────────────────────────────
def fetch_pages(key: str, route: str, params: list[tuple[str, str]], use_cache: bool,
                label: str) -> list[dict]:
    """Page through a query. The sort makes offset pagination deterministic."""
    rows, offset, total = [], 0, None
    while True:
        page = fetch(key, route, params + [("offset", str(offset)), ("length", str(PAGE))],
                     use_cache)
        resp = page.get("response", {})
        if total is None:
            total = int(resp.get("total", 0))
        batch = resp.get("data", [])
        rows.extend(batch)
        offset += PAGE
        if not batch or offset >= total:
            break
    if len(rows) != total:
        raise RuntimeError(f"{label}: expected {total:,} rows, got {len(rows):,}")
    print(f"  {label}: {total:,} rows", flush=True)
    return rows


def get_state_monthly(key: str, state: str, start: str, end: str, use_cache: bool) -> list[dict]:
    return fetch_pages(
        key, "electricity/facility-fuel/data/",
        [("frequency", "monthly"), ("start", start), ("end", end),
         ("data[]", "generation"), ("data[]", "consumption-for-eg-btu"),
         ("data[]", "total-consumption-btu"),
         ("facets[state][]", state), ("facets[primeMover][]", "ALL"),
         ("sort[0][column]", "period"), ("sort[0][direction]", "asc"),
         ("sort[1][column]", "plantCode"), ("sort[1][direction]", "asc"),
         ("sort[2][column]", "fuel2002"), ("sort[2][direction]", "asc")],
        use_cache, label=f"{state} monthly plant-fuel",
    )


def get_generator_snapshot(key: str, period: str, use_cache: bool) -> list[dict]:
    return fetch_pages(
        key, "electricity/operating-generator-capacity/data/",
        [("frequency", "monthly"), ("start", period), ("end", period),
         ("data[]", "nameplate-capacity-mw"), ("data[]", "net-summer-capacity-mw"),
         ("data[]", "operating-year-month"), ("data[]", "planned-retirement-year-month"),
         ("data[]", "county"), ("data[]", "latitude"), ("data[]", "longitude"),
         ("sort[0][column]", "plantid"), ("sort[0][direction]", "asc"),
         ("sort[1][column]", "generatorid"), ("sort[1][direction]", "asc")],
        use_cache, label=f"generators {period}",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Transform
# ─────────────────────────────────────────────────────────────────────────────
def build_state_plants(rows: list[dict], months: list[str]) -> tuple[dict, list[str]]:
    """Aggregate one state's monthly rows into per-plant monthly arrays."""
    mi = {m: i for i, m in enumerate(months)}
    n = len(months)
    zeros = lambda: [0.0] * n  # noqa: E731

    plants: dict[str, dict] = {}
    totals: dict[str, dict[int, float]] = defaultdict(dict)   # plant's own ALL row
    unmapped: dict[str, float] = defaultdict(float)

    for r in rows:
        i = mi.get(r.get("period"))
        if i is None:
            continue
        pid = str(r.get("plantCode"))
        ftype, f2002 = r.get("fuelType"), r.get("fuel2002")
        gen = to_mwh(num(r.get("generation")), r.get("generation-units") or "megawatthours")
        eg, tot = num(r.get("consumption-for-eg-btu")), num(r.get("total-consumption-btu"))

        p = plants.setdefault(pid, {
            "name": (r.get("plantName") or "").strip(),
            "reported": [False] * n,
            "gen": defaultdict(zeros),
            "mmbtu_eg": zeros(), "mmbtu_hr": zeros(), "gen_hr": zeros(),
            "co2": zeros(), "co2_all": zeros(),
            "bio": zeros(), "unattr": zeros(),
            "fuels": {},
        })
        # the name can change over ten years; keep the most recent spelling
        if r.get("plantName"):
            p["name"] = r["plantName"].strip()
        p["reported"][i] = True

        if ftype == "ALL":
            totals[pid][i] = gen
            continue

        detail = FUELTYPE_TO_DETAIL.get(ftype)
        if detail is None:
            unmapped[f"fuelType {ftype}"] += gen
            detail = "other"
        f = FACTORS.get(f2002)
        if f is None:
            unmapped[f"fuel2002 {f2002}"] += gen
            kind, factor = "unknown", None
        else:
            kind, factor = f["kind"], f["kg_per_mmbtu"]

        p["gen"][detail][i] += gen
        p["mmbtu_eg"][i] += eg
        if kind in HEAT_RATE_KINDS or f2002 in HEAT_RATE_EXTRA:
            p["mmbtu_hr"][i] += eg
            p["gen_hr"][i] += gen
        if kind == "biogenic":
            p["bio"][i] += eg
        elif factor is None:
            p["unattr"][i] += eg
        else:
            p["co2"][i] += eg * factor / 1000.0
            p["co2_all"][i] += tot * factor / 1000.0

        fr = p["fuels"].setdefault(f2002, {"detail": detail, "kind": kind,
                                           "gen": zeros(), "mmbtu": zeros()})
        fr["gen"][i] += gen
        fr["mmbtu"][i] += eg

    # every plant-month's fuel rows must reproduce that plant-month's own total
    bad = 0
    for pid, t in totals.items():
        p = plants[pid]
        for i, allv in t.items():
            part = sum(s[i] for s in p["gen"].values())
            if abs(allv) > 100 and abs(part - allv) / abs(allv) > 0.005:
                bad += 1
    warnings = [f"unmapped {k}: {v:,.0f} MWh" for k, v in sorted(unmapped.items())]
    if bad:
        warnings.append(f"{bad} plant-months where fuel rows disagree with the plant total by >0.5%")
    return plants, warnings


def gen_index(snapshots: dict[str, list[dict]]) -> dict[str, dict]:
    """
    Fold the generator snapshots into one inventory per plant. A generator's
    attributes come from the latest snapshot it appears in; one that vanishes
    from the inventory before the final snapshot has been retired or removed.
    """
    periods = sorted(snapshots)
    last = periods[-1]
    out: dict[str, dict] = {}
    for per in periods:
        for r in snapshots[per]:
            pid = str(r.get("plantid"))
            gid = str(r.get("generatorid"))
            p = out.setdefault(pid, {"gens": {}, "cap_by_snapshot": defaultdict(float), "meta": {}})
            cap = num(r.get("nameplate-capacity-mw"))
            p["cap_by_snapshot"][per] += cap
            p["gens"][gid] = {
                "id": gid,
                "technology": r.get("technology"),
                "prime_mover": r.get("prime_mover_code"),
                "fuel": r.get("energy_source_code"),
                "capacity_mw": r2(cap, 1),
                "summer_mw": r2(num(r.get("net-summer-capacity-mw")), 1),
                "online": r.get("operating-year-month") or None,
                "planned_retirement": r.get("planned-retirement-year-month") or None,
                "status": r.get("status"),
                "last_seen": per,
            }
            m = p["meta"]
            m["operator"] = (r.get("entityName") or "").strip() or m.get("operator")
            m["county"] = (r.get("county") or "").strip() or m.get("county")
            m["ba"] = r.get("balancing_authority_code") or m.get("ba")
            m["ba_name"] = r.get("balancing-authority-name") or m.get("ba_name")
            m["sector"] = r.get("sectorName") or m.get("sector")
            try:
                m["lat"] = round(float(r["latitude"]), 4)
                m["lon"] = round(float(r["longitude"]), 4)
            except (KeyError, TypeError, ValueError):
                pass
    for p in out.values():
        for g in p["gens"].values():
            if g["last_seen"] != last:
                g["status"] = "RE"
    return out


def monthly_capacity(gens: list[dict], months: list[str], final: str) -> list[float]:
    """
    Nameplate MW in service each month: a generator counts from its online month
    until the last inventory snapshot it appears in (or the end of the window if
    it is still listed). Retirements are therefore dated to within a year.
    """
    out = []
    for m in months:
        mw = 0.0
        for g in gens:
            on = g["online"] or "0000-00"
            off = final if g["status"] != "RE" else g["last_seen"]
            if on <= m <= off:
                mw += g["capacity_mw"]
        out.append(r2(mw, 1))
    return out


def rnd(xs: list[float], nd: int = 1) -> list[float]:
    """
    Round a series; whole numbers are written without a trailing .0. Decimals
    are only kept below 100, where they are a meaningful share of the value, so
    ~15,000 files x 127 months stay a manageable size.
    """
    out = []
    for x in xs:
        v = round(x + 0.0, nd if abs(x) < 100 else 0)
        out.append(int(v) if v == int(v) else v)
    return out


def changes(xs: list[float]) -> list[list]:
    """A mostly-constant series as [[index, value], ...] at each change."""
    out, prev = [], None
    for i, v in enumerate(xs):
        if v != prev:
            out.append([i, v])
            prev = v
    return out


def put(doc: dict, key: str, series: list, default: list | None = None) -> None:
    """
    Write a series only when it carries information. Without a default, an
    all-zero series is left out. With one, a series identical to the default is
    left out and an all-zero one is written as [] -- it must not fall back.
    """
    if default is None:
        if any(series):
            doc[key] = series
        return
    if series == default:
        return                       # browser falls back to the default series
    doc[key] = series if any(series) else []   # [] = explicitly all zero


def trim(xs: list, a: int, b: int) -> list:
    return xs[a:b + 1]


def write_json(path: pathlib.Path, doc: dict) -> pathlib.Path:
    path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    return path


def build():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-cache", action="store_true", help="ignore the raw response cache")
    ap.add_argument("--workers", type=int, default=6, help="parallel EIA requests")
    args = ap.parse_args()
    use_cache = not args.no_cache
    key = load_key()

    end = latest_period(key, "electricity/facility-fuel")
    start = f"{int(end[:4]) - YEARS_BACK}-01"
    gen_end = latest_period(key, "electricity/operating-generator-capacity")
    months = month_range(start, end)
    years = sorted({int(m[:4]) for m in months})
    print(f"Building the plant browser: {start} to {end} ({len(months)} months)\n")

    # December snapshots across the window, plus the latest month.
    snap_periods = sorted({f"{y}-12" for y in years if f"{y}-12" <= gen_end} | {gen_end})

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        snap_futs = {p: ex.submit(get_generator_snapshot, key, p, use_cache) for p in snap_periods}
        # largest states first, so the long poles start early
        order = sorted(STATES, key=lambda s: s not in ("TX", "CA", "NC", "MN", "NY", "IA"))
        state_futs = {s: ex.submit(get_state_monthly, key, s, start, end, use_cache) for s in order}
        snapshots = {p: f.result() for p, f in snap_futs.items()}
        state_rows = {s: f.result() for s, f in state_futs.items()}

    gens = gen_index(snapshots)
    final_snap = snap_periods[-1]

    # Overwrite in place and sweep stale files afterwards, rather than deleting
    # the tree first: synced folders (OneDrive, Dropbox) lock directories while
    # they upload, and a failed rmtree would leave no data at all.
    (OUT / "index").mkdir(parents=True, exist_ok=True)
    written: set[pathlib.Path] = set()

    # EIA surveys large plants monthly and the rest once a year; the annual
    # respondents only appear here once that year's annual data is published.
    # The last complete year is the last one before the plant count falls away.
    plants_by_year: dict[int, set] = defaultdict(set)
    for rows in state_rows.values():
        for r in rows:
            plants_by_year[int(r["period"][:4])].add(r["plantCode"])
    complete_through = years[0]
    for y in years[1:]:
        if len(plants_by_year[y]) < 0.8 * len(plants_by_year[y - 1]):
            break
        complete_through = y
    print(f"  every plant covered through {complete_through}; monthly sample only after that "
          f"({len(plants_by_year[complete_through]):,} plants, then "
          f"{len(plants_by_year.get(complete_through + 1, ())):,})\n")

    warnings: list[str] = []
    n_plants = 0
    active_cut = month_add(end, -6)
    for state in sorted(STATES):
        plants, w = build_state_plants(state_rows[state], months)
        warnings += [f"{state}: {x}" for x in w]
        (OUT / state).mkdir(exist_ok=True)

        # state totals by year, over the plants in this file, for rank and share
        annual: dict[str, dict[int, float]] = {}
        for pid, p in plants.items():
            per_year: dict[int, float] = defaultdict(float)
            for s in p["gen"].values():
                for i, v in enumerate(s):
                    per_year[int(months[i][:4])] += v
            annual[pid] = per_year
        state_total = {y: sum(a.get(y, 0.0) for a in annual.values()) for y in years}
        rank = {y: {pid: k + 1 for k, pid in enumerate(
            sorted((pid for pid in annual if annual[pid].get(y, 0.0) > 0),
                   key=lambda pid: -annual[pid][y]))} for y in years}
        ranked = {y: len(rank[y]) for y in years}

        idx_rows = []
        for pid, p in plants.items():
            rep = p["reported"]
            first = rep.index(True)
            last = len(rep) - 1 - rep[::-1].index(True)

            # primary source: largest absolute generation over the plant's final
            # twelve reported months, so a coal-to-gas conversion reads as gas
            lo = max(first, last - 11)
            mag = {d: sum(abs(v) for v in s[lo:last + 1]) for d, s in p["gen"].items()}
            if not any(mag.values()):
                mag = {d: sum(abs(v) for v in s) for d, s in p["gen"].items()}
            primary = max(mag, key=mag.get) if mag and any(mag.values()) else "other"
            flabel = fuel_label(primary, p["fuels"], lo, last)

            g = gens.get(pid, {"gens": {}, "meta": {}, "cap_by_snapshot": {}})
            glist = sorted(g["gens"].values(), key=lambda x: (x["status"] == "RE", x["id"]))
            cap_m = monthly_capacity(glist, months, end) if glist else [0.0] * len(months)
            in_service = [x for x in glist if x["status"] != "RE"]
            cap_now = r2(sum(x["capacity_mw"] for x in in_service), 1)
            # Operating means units still in service in the latest inventory. A plant
            # with no inventory record is judged on its data instead: recent monthly
            # data, or data through the last complete year for an annual respondent.
            is_active = bool(in_service) if glist else (
                months[last] >= active_cut or months[last] >= f"{complete_through}-12")

            detail_keys = [d for d in DETAIL_ORDER if d in p["gen"]
                           and any(v != 0 for v in p["gen"][d])]
            # Compact format; plants.js restores every omitted series (see derive()).
            # Monthly arrays run from the plant's first to last reported month.
            span = lambda xs: trim(xs, first, last)  # noqa: E731
            gen_arrays = {d: rnd(span(p["gen"][d])) for d in detail_keys}
            total = [sum(v) for v in zip(*gen_arrays.values())] if gen_arrays else []
            mmbtu = rnd(span(p["mmbtu_eg"]), 0)
            co2_e = rnd(span(p["co2"]))
            y_lo, y_hi = int(months[first][:4]), int(months[last][:4])
            span_years = list(range(y_lo, y_hi + 1))
            yi = {y: k for k, y in enumerate(span_years)}

            def by_year(xs):
                acc = [0.0] * len(span_years)
                for i, v in enumerate(xs):
                    acc[yi[int(months[first + i][:4])]] += v
                return rnd(acc, 0)

            doc = {
                "id": pid, "name": p["name"], "state": state, "state_name": STATES[state],
                **{k: g["meta"].get(k) for k in ("operator", "county", "ba", "ba_name",
                                                 "sector", "lat", "lon")},
                "primary": primary, "fuel_label": flabel,
                "active": is_active,
                "start": months[first], "end": months[last],
                # months inside the span with no report to EIA at all
                "missing": [i for i, x in enumerate(span(rep)) if not x],
                "gen": gen_arrays,
            }
            put(doc, "mmbtu_eg", mmbtu)
            # heat-rate inputs default to all fuel and all generation, which is
            # exactly right for a plant that burns one kind of fuel
            put(doc, "hr_mmbtu", rnd(span(p["mmbtu_hr"]), 0), mmbtu)
            put(doc, "hr_gen", rnd(span(p["gen_hr"])), total)
            put(doc, "co2_t", co2_e)
            put(doc, "co2_all_t", rnd(span(p["co2_all"])), co2_e)
            put(doc, "biogenic_mmbtu", rnd(span(p["bio"]), 0))
            put(doc, "unattributed_mmbtu", rnd(span(p["unattr"]), 0))
            doc["capacity_mw"] = changes(span(cap_m))
            doc["capacity_now_mw"] = cap_now or None
            # per-fuel detail is only ever shown by year, so it is stored by year
            doc["fuel_years"] = span_years
            doc["fuels"] = {c: {"detail": f["detail"], "kind": f["kind"],
                                "gen": by_year(span(f["gen"])), "mmbtu": by_year(span(f["mmbtu"]))}
                            for c, f in sorted(p["fuels"].items())
                            if any(f["gen"]) or any(f["mmbtu"])}
            doc["generators"] = [{k: v for k, v in x.items() if v is not None} for x in glist]
            # [rank, plants ranked, state plant total MWh] for each year in the span
            doc["context"] = {str(y): [rank[y].get(pid), ranked[y], r2(state_total[y], 0)]
                              for y in span_years}
            written.add(write_json(OUT / state / f"{pid}.json", doc))

            recent = sum(sum(s[max(0, len(months) - 12):]) for s in p["gen"].values())
            idx_rows.append({
                "id": pid, "name": p["name"], "primary": primary, "fuel_label": flabel,
                "active": is_active,
                "start": months[first], "end": months[last],
                "capacity_mw": cap_now or None,
                "gen_last12_mwh": r2(recent, 0),
            })
            n_plants += 1

        idx_rows.sort(key=lambda r: (r["name"].lower(), r["id"]))
        written.add(write_json(OUT / "index" / f"{state}.json", {
            "state": state, "name": STATES[state], "start": start, "end": end,
            "plants": idx_rows,
        }))
        print(f"  {state}: {len(idx_rows):,} plants", flush=True)

    stale = [f for f in OUT.rglob("*.json") if f not in written and f.name != "meta.json"]
    for f in stale:
        f.unlink()
    for d in sorted((d for d in OUT.iterdir() if d.is_dir()), reverse=True):
        try:
            d.rmdir()          # only succeeds when empty
        except OSError:
            pass
    if stale:
        print(f"  removed {len(stale):,} files for plants no longer in the window")

    (OUT / "meta.json").write_text(json.dumps({
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "start": start, "end": end, "generator_snapshots": snap_periods,
        "plant_count": n_plants,
        # last year with every plant's data; later months hold EIA's monthly sample only
        "complete_through": complete_through,
        "states": [{"code": c, "name": n} for c, n in sorted(STATES.items(), key=lambda kv: kv[1])],
        "detail_order": DETAIL_ORDER, "detail_labels": DETAIL_LABEL,
        "fuel_names": FUEL_NAMES, "status_labels": {**STATUS_LABEL, "RE": "Retired or removed"},
        "validation": {"warnings": warnings},
    }, indent=2), encoding="utf-8")

    print(f"\n{n_plants:,} plants written to {OUT.relative_to(DATA.parent)}")
    if warnings:
        print("\nWARNINGS:")
        for x in warnings:
            print(f"   - {x}")
    else:
        print("No validation warnings.")


if __name__ == "__main__":
    build()
