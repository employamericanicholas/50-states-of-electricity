#!/usr/bin/env python3
"""
Consistency tests for the built dataset. Run after build_data.py; also run in CI.

These check internal coherence — that the numbers the dashboard renders actually
agree with each other and with EIA's own published totals — rather than just that
the files parse.

    python scripts/verify_data.py
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

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


def close(a: float, b: float, tol: float = 0.005) -> bool:
    """Relative closeness, tolerant of zeros."""
    if a == b:
        return True
    scale = max(abs(a), abs(b))
    return scale == 0 or abs(a - b) / scale <= tol


def main() -> int:
    index = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    meta = json.loads((DATA / "meta.json").read_text(encoding="utf-8"))
    us = json.loads((DATA / "us.json").read_text(encoding="utf-8"))

    print(f"Verifying {DATA} (year {index['year']})\n")

    # ── structure ────────────────────────────────────────────────────────────
    check(index["year"] == 2024, f"index year is {index['year']}, expected 2024")
    check(len(index["states"]) == 51, f"{len(index['states'])} states in index, expected 51")
    check(len(index["slot_order"]) == 8, "expected 8 colour slots")
    state_files = sorted(p.stem for p in (DATA / "state").glob("*.json"))
    check(len(state_files) == 51, f"{len(state_files)} state files, expected 51")
    check(sorted(s["code"] for s in index["states"]) == state_files,
          "index state codes do not match the state files on disk")

    # ── national totals reconcile against the sum of the states ─────────────
    sum_states = sum(s["total_mwh"] for s in index["states"])
    check(close(sum_states, us["total_mwh"]),
          f"sum of state generation {sum_states:,.0f} != us.json total {us['total_mwh']:,.0f}")
    sum_btm = sum(s["small_scale_solar_mwh"] for s in index["states"])
    check(close(sum_btm, us["small_scale_solar_mwh"]),
          f"sum of state small-scale solar {sum_btm:,.0f} != national {us['small_scale_solar_mwh']:,.0f}")
    check(close(us["utility_scale_mwh"] + us["small_scale_solar_mwh"], us["total_mwh"]),
          "national utility-scale + small-scale solar != total")

    # ── national CO2 lands close to EIA's published figure ──────────────────
    ratio = us["co2"]["ratio_to_official"]
    check(ratio is not None, "no national CO2 ratio to EIA's published figure")
    if ratio is not None:
        check(0.95 <= ratio <= 1.05,
              f"national all-fuel CO2 estimate is {ratio:.1%} of EIA's figure — outside 95-105%")
        print(f"  national CO2 agreement with EIA: {ratio:.1%}")
    check(us["co2"]["estimate_all_fuel_t"] >= us["co2"]["estimate_t"],
          "all-fuel CO2 should be >= electricity-only CO2 nationally")

    # ── every state ─────────────────────────────────────────────────────────
    slots = set(index["slot_order"])
    details = set(index["detail_order"])
    worst_ratio = (None, 0.0)

    for code in state_files:
        st = json.loads((DATA / "state" / f"{code}.json").read_text(encoding="utf-8"))
        tag = f"{code}"

        # sources sum to the reported total
        src_sum = sum(s["mwh"] for s in st["sources"])
        check(close(src_sum, st["total_mwh"]),
              f"{tag}: sources sum {src_sum:,.0f} != total_mwh {st['total_mwh']:,.0f}")

        # slots are a faithful regrouping of sources
        slot_sum = sum(s["mwh"] for s in st["slots"])
        check(close(slot_sum, src_sum), f"{tag}: slots sum != sources sum")
        for s in st["slots"]:
            check(s["key"] in slots, f"{tag}: unknown slot {s['key']!r}")
        for s in st["sources"]:
            check(s["key"] in details, f"{tag}: unknown source {s['key']!r}")
            check(s["slot"] in slots, f"{tag}: source {s['key']} maps to unknown slot {s['slot']!r}")

        # utility-scale + behind-the-meter == total
        check(close(st["utility_scale_mwh"] + st["small_scale_solar_mwh"], st["total_mwh"]),
              f"{tag}: utility-scale + small-scale solar != total")

        # shares are sane
        for k in ("fossil_pct", "renewable_pct", "carbon_free_pct"):
            check(-0.01 <= st[k] <= 100.01, f"{tag}: {k} = {st[k]} out of range")
        check(st["carbon_free_pct"] >= st["renewable_pct"] - 0.01,
              f"{tag}: carbon-free ({st['carbon_free_pct']}) < renewable ({st['renewable_pct']})")

        # index row agrees with the state file
        row = next(s for s in index["states"] if s["code"] == code)
        for k in ("total_mwh", "small_scale_solar_mwh", "fossil_pct", "renewable_pct",
                  "carbon_free_pct", "plant_count"):
            check(close(row[k], st[k] if k in st else row[k]),
                  f"{tag}: index.{k} disagrees with the state file")

        # plants
        check(st["plant_count"] == len(st["plants"]),
              f"{tag}: plant_count {st['plant_count']} != {len(st['plants'])} plant records")
        est = sum(p["co2_t"] for p in st["plants"])
        check(close(est, st["co2"]["estimate_t"], 0.01),
              f"{tag}: summed plant CO2 != state co2.estimate_t")
        for p in st["plants"]:
            check(p["primary_slot"] in slots, f"{tag}: plant {p['id']} bad primary_slot")
            psum = sum(s["mwh"] for s in p["sources"])
            check(close(psum, p["gen_mwh"], 0.02),
                  f"{tag}: plant {p['id']} sources sum != gen_mwh")
            check(p["co2_total_t"] >= p["co2_t"] - 1,
                  f"{tag}: plant {p['id']} all-fuel CO2 < electricity-only CO2")

        # CO2 vs EIA, per state
        r = st["co2"].get("ratio_to_official")
        if r is not None and st["co2"]["eia_official_t"] > 1e6:
            warn(0.85 <= r <= 1.15,
                 f"{tag}: all-fuel CO2 estimate is {r:.1%} of EIA's published figure")
            if abs(r - 1) > abs(worst_ratio[1] - 1) or worst_ratio[0] is None:
                worst_ratio = (code, r)

        # behind-the-meter solar never appears as a plant
        check(not any(p["primary"] == "solar_small_scale" for p in st["plants"]),
              f"{tag}: small-scale solar must not appear as a plant — it has no plant-level data")

        # ── demand & trade ──────────────────────────────────────────────────
        d = st.get("demand")
        check(d is not None, f"{tag}: no demand block")
        if d:
            # supply must equal disposition
            lhs = d["generation_mwh"] + d["net_imports_mwh"]
            rhs = d["consumed_mwh"] + d["losses_mwh"] + d["unaccounted_mwh"]
            check(close(lhs, rhs, 0.01),
                  f"{tag}: generation + net imports ({lhs:,.0f}) != consumed + losses + "
                  f"unaccounted ({rhs:,.0f})")
            check(close(d["consumed_mwh"], d["retail_sales_mwh"] + d["direct_use_mwh"]),
                  f"{tag}: consumed != retail sales + direct use")
            check(close(d["net_imports_mwh"],
                        d["net_interstate_imports_mwh"] + d["net_intl_imports_mwh"]),
                  f"{tag}: net imports != interstate + international")
            check(close(d["available_mwh"], d["generation_mwh"] + d["net_imports_mwh"]),
                  f"{tag}: available != generation + net imports")
            # the flag, the sign of net imports and the sign of the share must agree,
            # or the page would describe an exporter as import-dependent
            check(d["is_net_importer"] == (d["net_imports_mwh"] > 0),
                  f"{tag}: is_net_importer disagrees with the sign of net imports")
            if d["import_share_pct"] is not None:
                check(d["is_net_importer"] == (d["import_share_pct"] > 0),
                      f"{tag}: import_share_pct sign disagrees with is_net_importer")
            check(d["generation_mwh"] >= 0 and d["consumed_mwh"] >= 0,
                  f"{tag}: negative generation or consumption")
            # in-state generation here should match the mix total, less behind-the
            # -meter solar, which is not part of utility-scale supply
            check(close(d["generation_mwh"], st["utility_scale_mwh"], 0.02),
                  f"{tag}: demand-side generation {d['generation_mwh']:,.0f} != "
                  f"utility-scale mix total {st['utility_scale_mwh']:,.0f}")

            # index row carries the same demand figures
            rd = row.get("demand")
            check(rd is not None, f"{tag}: index row missing demand")
            if rd:
                for k in ("consumed_mwh", "net_imports_mwh", "import_share_pct", "generation_mwh"):
                    check(rd[k] == d[k], f"{tag}: index demand.{k} disagrees with the state file")

        # detailed sources travel with the index row, for the by-source rankings
        check(row.get("sources") is not None, f"{tag}: index row missing detailed sources")
        if row.get("sources"):
            check(len(row["sources"]) == len(st["sources"]),
                  f"{tag}: index sources count disagrees with the state file")

    if worst_ratio[0]:
        print(f"  widest per-state CO2 gap: {worst_ratio[0]} at {worst_ratio[1]:.1%} of EIA's figure")

    # ── emission factors are all documented ─────────────────────────────────
    valid = {"fossil", "zero", "biogenic", "unknown"}
    for code, f in meta["co2_factors"].items():
        check(f["treatment"] in valid, f"factor {code}: bad treatment {f['treatment']!r}")
        if f["treatment"] == "fossil":
            check(isinstance(f["kg_co2_per_mmbtu"], (int, float)) and f["kg_co2_per_mmbtu"] > 0,
                  f"factor {code}: fossil fuel needs a positive factor")
            check(f.get("source") in meta["factor_sources"],
                  f"factor {code}: fossil factor must cite a source")
        if f["treatment"] == "unknown":
            check(f["kg_co2_per_mmbtu"] is None, f"factor {code}: unknown must have no factor")

    # ── the build reported no warnings of its own ──────────────────────────
    v = meta["validation"]
    check(not v["state_partition_warnings"],
          f"build reported partition warnings: {v['state_partition_warnings']}")
    check(not v["plant_fuel_warnings"],
          f"build reported fuel warnings: {v['plant_fuel_warnings']}")

    # ── report ──────────────────────────────────────────────────────────────
    print(f"\n{checks:,} checks run")
    for w in warns:
        print(f"  WARN  {w}")
    for f in fails:
        print(f"  FAIL  {f}")
    if fails:
        print(f"\n{len(fails)} FAILURES")
        return 1
    print(f"\nAll checks passed{f' ({len(warns)} warnings)' if warns else ''}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
