#!/usr/bin/env python3
"""
Consistency tests for the Power Plant Browser dataset (data/plants/). Run after
build_plants.py; also run in CI.

Beyond checking that every file parses and every series has the right length,
this reconciles the monthly plant data against the Home page's annual 2024 data,
which comes from a different EIA route and frequency. The two should agree
closely; if they drift apart, one of the builds has gone wrong.

    python scripts/verify_plants.py
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PLANTS = DATA / "plants"

fails: list[str] = []
warns: list[str] = []
checks = 0


def check(cond: bool, msg: str) -> None:
    global checks
    checks += 1
    if not cond:
        fails.append(msg)


def warn(cond: bool, msg: str) -> None:
    global checks
    checks += 1
    if not cond:
        warns.append(msg)


def months_between(a: str, b: str) -> int:
    return (int(b[:4]) - int(a[:4])) * 12 + int(b[5:7]) - int(a[5:7]) + 1


# optional monthly series; the browser fills in whichever are omitted
SERIES = ["mmbtu_eg", "hr_mmbtu", "hr_gen", "co2_t", "co2_all_t",
          "biogenic_mmbtu", "unattributed_mmbtu"]


def main() -> int:
    meta = json.loads((PLANTS / "meta.json").read_text(encoding="utf-8"))
    detail_order = set(meta["detail_order"])
    print(f"Verifying {PLANTS} ({meta['start']} to {meta['end']})\n")

    check(len(meta["states"]) == 51, f"{len(meta['states'])} states in plant meta, expected 51")
    total_plants = 0
    us_monthly_2024 = us_annual_2024 = 0.0

    for st in meta["states"]:
        code = st["code"]
        idx_file = PLANTS / "index" / f"{code}.json"
        check(idx_file.exists(), f"missing plant index for {code}")
        if not idx_file.exists():
            continue
        idx = json.loads(idx_file.read_text(encoding="utf-8"))
        files = {p.stem for p in (PLANTS / code).glob("*.json")}
        ids = [p["id"] for p in idx["plants"]]
        check(len(ids) == len(set(ids)), f"{code}: duplicate plant ids in the index")
        check(set(ids) == files, f"{code}: index lists {len(ids)} plants but {len(files)} files exist")
        total_plants += len(ids)

        state_2024 = 0.0
        for row in idx["plants"]:
            check(bool(row["name"]), f"{code}/{row['id']}: plant has no name")
            check(bool(row["fuel_label"]), f"{code}/{row['id']}: plant has no fuel label")
            f = PLANTS / code / f"{row['id']}.json"
            if not f.exists():
                continue
            p = json.loads(f.read_text(encoding="utf-8"))
            n = months_between(p["start"], p["end"])
            check(meta["start"] <= p["start"] <= p["end"] <= meta["end"],
                  f"{code}/{p['id']}: range {p['start']}..{p['end']} outside the window")
            # optional series: absent (default), [] (all zero), or exactly n months
            for s in SERIES:
                if s in p:
                    check(len(p[s]) in (0, n), f"{code}/{p['id']}: {s} has {len(p[s])} months, expected {n}")
            check(all(0 <= i < n for i in p["missing"]), f"{code}/{p['id']}: missing-month index out of range")
            cap = p["capacity_mw"]
            check(all(0 <= i < n for i, _ in cap) and [i for i, _ in cap] == sorted({i for i, _ in cap}),
                  f"{code}/{p['id']}: capacity change points out of order or range")
            for k, arr in p["gen"].items():
                check(k in detail_order, f"{code}/{p['id']}: unknown energy source {k!r}")
                check(len(arr) == n, f"{code}/{p['id']}: gen[{k}] has {len(arr)} months, expected {n}")
            ny = int(p["end"][:4]) - int(p["start"][:4]) + 1
            check(len(p["fuel_years"]) == ny, f"{code}/{p['id']}: fuel_years does not span the plant's years")
            for c, fu in p["fuels"].items():
                check(len(fu["gen"]) == ny and len(fu["mmbtu"]) == ny,
                      f"{code}/{p['id']}: fuel {c} series has the wrong length")
            co2 = p.get("co2_t") or [0] * n
            co2_all = p.get("co2_all_t", co2) or [0] * n
            # EIA occasionally books a negative monthly fuel figure as a correction to
            # an earlier month; kept as reported, but a whole year must not go negative
            warn(all(v >= 0 for v in co2), f"{code}/{p['id']}: a month carries negative CO2 "
                                           f"(EIA fuel correction, kept as reported)")
            y0 = int(p["start"][:4])
            per_year: dict[int, float] = {}
            for i, v in enumerate(co2):
                y = y0 + (int(p["start"][5:7]) - 1 + i) // 12
                per_year[y] = per_year.get(y, 0.0) + v
            check(all(v >= -1 for v in per_year.values()), f"{code}/{p['id']}: negative annual CO2")
            # the all-fuel basis adds useful-thermal fuel, so it can never be smaller
            check(all(b >= a - 1 for a, b in zip(co2, co2_all)),
                  f"{code}/{p['id']}: all-fuel CO2 below the electricity-only figure")
            # per-fuel generation (stored by year) must add up to the per-source series
            by_fuel = sum(sum(fu["gen"]) for fu in p["fuels"].values())
            by_src = sum(sum(a) for a in p["gen"].values())
            check(abs(by_fuel - by_src) <= max(20.0, abs(by_src) * 0.002),
                  f"{code}/{p['id']}: fuel rows sum to {by_fuel:,.0f} MWh, sources to {by_src:,.0f}")
            check(set(p["context"]) == {str(y) for y in p["fuel_years"]},
                  f"{code}/{p['id']}: rank context does not cover the plant's years")
            if p["start"][:4] <= "2024" <= p["end"][:4]:
                off = months_between(p["start"], "2024-01") - 1
                lo, hi = max(0, off), min(n, off + 12)
                state_2024 += sum(sum(a[lo:hi]) for a in p["gen"].values())

        # reconcile with the Home page's annual 2024 plant totals for the same state
        home = json.loads((DATA / "state" / f"{code}.json").read_text(encoding="utf-8"))
        annual = sum(pl["gen_mwh"] for pl in home["plants"])
        us_monthly_2024 += state_2024
        us_annual_2024 += annual
        if abs(annual) > 1e5:
            ratio = state_2024 / annual
            warn(0.97 <= ratio <= 1.03,
                 f"{code}: 2024 monthly plant data is {ratio:.1%} of the Home page's annual figure")

    # every dot on the map must open a real plant, and sit on the globe
    pts = json.loads((PLANTS / "points.json").read_text(encoding="utf-8"))
    F = {f: i for i, f in enumerate(pts["fields"])}
    for r in pts["plants"]:
        check((PLANTS / r[F["state"]] / f"{r[F['id']]}.json").exists(),
              f"map point {r[F['state']]}/{r[F['id']]} has no plant file")
        check(-90 <= r[F["lat"]] <= 90 and -180 <= r[F["lon"]] <= 180,
              f"map point {r[F['state']]}/{r[F['id']]} has impossible coordinates")
    check(len({(r[F["state"]], r[F["id"]]) for r in pts["plants"]}) == len(pts["plants"]),
          "duplicate plants on the map")
    print(f"  map points: {len(pts['plants']):,}")

    # hand-sourced locations: each must name a real plant and cite where it came from
    extra = DATA / "plant_locations.json"
    if extra.exists():
        for r in json.loads(extra.read_text(encoding="utf-8"))["locations"]:
            tag = f"plant_locations.json {r.get('state')}/{r.get('id')}"
            check((PLANTS / r["state"] / f"{r['id']}.json").exists(), f"{tag}: no such plant")
            if r.get("lat") is not None:
                check(bool(r.get("source")) and bool(r.get("url")), f"{tag}: coordinates with no source cited")
                check(18 <= r["lat"] <= 72 and -180 <= r["lon"] <= -64,
                      f"{tag}: coordinates outside the United States")

    check(total_plants == meta["plant_count"],
          f"{total_plants} plants on disk, meta says {meta['plant_count']}")
    ratio = us_monthly_2024 / us_annual_2024 if us_annual_2024 else 0
    print(f"  plants: {total_plants:,}")
    print(f"  2024 monthly plant generation vs Home page annual: {ratio:.2%}")
    check(0.98 <= ratio <= 1.02,
          f"national 2024 monthly plant generation is {ratio:.1%} of the annual figure — outside 98-102%")

    print(f"\n{checks:,} checks run")
    for w in warns:
        print(f"  WARN  {w}")
    for f in fails:
        print(f"  FAIL  {f}")
    if fails:
        print(f"\n{len(fails)} FAILURES")
        return 1
    print("\nPlant dataset OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
