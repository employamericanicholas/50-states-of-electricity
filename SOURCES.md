# Sources & methodology

Every figure in this dashboard traces to a U.S. Energy Information Administration (EIA) series.
This file is the citable version of what the site shows in its Methodology section; the machine
-readable version, including the exact emission factor applied to every fuel code, is generated into
[`data/meta.json`](data/meta.json) at build time.

Reporting period: **calendar year 2024**. EIA states that all data prior to 2025 are final.

---

## 1. Generation by state and energy source

**EIA, Electric Power Operations (Annual and Monthly)** — collected on Form EIA-923.
API route: `electricity/electric-power-operational-data`
<https://www.eia.gov/opendata/browser/electricity/electric-power-operational-data>

Queried at `frequency=annual`, `sectorid=99` (all sectors), for these 13 energy-source codes:

| Code | Energy source | Code | Energy source |
|---|---|---|---|
| `COW` | All coal products | `NUC` | Nuclear |
| `NG` | Natural gas | `HYC` | Conventional hydroelectric |
| `OOG` | Other gases | `WND` | Wind |
| `PEL` | Petroleum liquids | `SUN` | Utility-scale solar (PV + thermal) |
| `PC` | Petroleum coke | `GEO` | Geothermal |
| `OTH` | Other | `BIO` | Biomass |
| `HPS` | Pumped storage (net of pumping load) | | |

These 13 codes form a mutually exclusive partition of net generation. The build asserts that their
sum equals EIA's own `ALL` series for every state and for the U.S., and fails loudly if it does not.
As of the current build, all 51 geographies reconcile.

**Net generation is production, not consumption.** It excludes interstate imports and exports, so a
state's mix is not the mix its customers actually consume.

## 2. Behind-the-meter (small-scale) solar

Same route, energy-source code **`DPV`** — *estimated small scale solar photovoltaic*.

EIA defines small-scale PV as installations under 1 MW, generally sited at the point of consumption:
"behind-the-meter", customer-sited, or distributed generation. EIA estimates this generation by state
and sector using data reported by utilities and third-party owners together with other information.

Two properties matter for reading this dashboard correctly:

1. **It is an EIA model estimate, not metered output.** No plant-level detail exists, so behind-the
   -meter solar appears in state and national mixes but never in the plant table.
2. **It is additive, not a subset.** `DPV` sits outside the 13-code utility-scale partition above.
   Verified empirically: for California 2024, `SPV` (utility-scale PV) 46,382 GWh + `DPV` 31,724 GWh
   = `TPV` (total PV) 78,107 GWh, while the all-fuels `ALL` series equals the 13-code partition
   exactly and excludes `DPV`. The dashboard therefore reports it as a separate category added on top
   of the utility-scale total, and labels it as an estimate wherever it appears.

Background: <https://www.eia.gov/todayinenergy/detail.php?id=31452>

## 3. Plant-level generation and fuel consumption

**EIA, Electric Power Operations for Individual Power Plants** — Form EIA-923.
API route: `electricity/facility-fuel`
<https://www.eia.gov/opendata/browser/electricity/facility-fuel>

Fields used: `generation` (MWh), `consumption-for-eg-btu` (MMBtu of fuel burned **for electricity
generation**), and `total-consumption-btu` (MMBtu of **all** fuel burned, including for useful thermal
output at combined-heat-and-power plants).

This route returns each plant three times over — once as a total, once per fuel aggregated across
prime movers, and once per fuel per prime mover — and it carries two fuel vocabularies
(`fuelType`, 19 aggregate categories; `fuel2002`, 44 specific fuels). The build keeps only rows with
`primeMover == "ALL"` and `fuelType != "ALL"`, which partition each plant exactly, then verifies that
partition against the plant's own reported total for both generation and fuel. All 13,208 plants
reconcile in the current build.

## 4. Plant attributes

**EIA, Inventory of Operable Generators** — Forms EIA-860 / EIA-860M.
API route: `electricity/operating-generator-capacity`, snapshot `2024-12`
<https://www.eia.gov/opendata/browser/electricity/operating-generator-capacity>

Supplies operator, county, latitude/longitude, nameplate capacity (summed across a plant's
generators), balancing authority, sector, and technology. Because this is a December 2024 snapshot, a
plant that retired mid-year can report generation in EIA-923 without appearing here; such plants show
generation with a blank operator or capacity rather than being dropped.

## 5. EIA's own CO₂ figures (used as a cross-check)

**EIA, State Electricity Profiles — Emissions by state by fuel**
API route: `electricity/state-electricity-profiles/emissions-by-state-by-fuel`
<https://www.eia.gov/opendata/browser/electricity/state-electricity-profiles>

Field `co2-thousand-metric-tons`, by state and by fuel. This is **not** an input to our estimate — it
is the independent figure we check ourselves against and display alongside our own.

## 6. CO₂ emission factors

- **EIA, Electric Power Annual, Table A.3 — Carbon dioxide uncontrolled emission factors**
  <https://www.eia.gov/electricity/annual/html/epa_a_03.html>
- **EIA, Carbon Dioxide Emissions Coefficients**
  <https://www.eia.gov/environment/emissions/co2_vol_mass.php>

Factors are in kg CO₂ per million Btu and are applied to the **specific** fuel each plant burned, so
bituminous (93.24), subbituminous (97.13) and lignite (98.27) coal each carry their own factor rather
than a coal average. Natural gas is 52.91. The complete table, with the source and treatment of every
fuel code, is rendered on the page and written to `data/meta.json`.

---

## How the CO₂ estimate is built

For each plant, for each fuel it burned:

```
CO₂ (tonnes) = fuel consumed (MMBtu) × emission factor (kg CO₂/MMBtu) ÷ 1000
```

Two bases are reported, and the dashboard lets you switch between them:

| Basis | Fuel input | What it answers |
|---|---|---|
| **Electricity only** (default) | `consumption-for-eg-btu` | Emissions attributable to generating electricity |
| **All fuel burned** | `total-consumption-btu` | Total plant combustion, comparable to EIA's published series |

### Treatment of each fuel class

- **Fossil fuels** — counted, using the factors above.
- **Nuclear, wind, solar, water** — zero by construction, not "unknown".
- **Biogenic carbon** (wood, black liquor, landfill gas, biogenic municipal solid waste,
  agricultural byproducts, sludge) — **excluded** from all headline figures. This matches EIA's own
  state electric-power CO₂ series, which excludes biogenic carbon; verified against California 2024,
  where EIA reports only 458 kt in "Other" despite 4,750 GWh of biomass generation.
- **Fuels with no single published EIA factor** — **left unattributed rather than guessed at**:
  geothermal (EIA publishes 11.81 for steam plants and 0.00 for binary-cycle plants, and the API does
  not say which a given plant is), blast furnace gas, other manufactured gases, purchased steam, and
  waste heat. The unattributed MMBtu is reported per state so the size of the gap is visible.

### How accurate is it?

Compared against EIA's independently published state totals for 2024:

| | Estimate | EIA published | Agreement |
|---|---|---|---|
| United States, all-fuel basis | 1,527.6 Mt | 1,537.1 Mt | **99.4%** |
| United States, electricity-only basis | 1,439.5 Mt | 1,537.1 Mt | 93.7% |

The ~6% difference between the two bases is fuel burned for useful thermal output at CHP plants, which
EIA's series includes and the electricity-only basis deliberately excludes. The residual 0.6% on the
all-fuel basis is the unattributed fuels listed above. Per-state agreement is shown on the page for
whichever geography is selected.

---

## Known limitations

- **Production, not consumption.** Imports and exports are out of scope.
- **Pumped storage is net of pumping load** and is normally negative. It is a storage round trip, not
  an energy source. Treemaps cannot represent negative values, so negative categories are shown in the
  ranked bars and the table and noted beneath the treemap.
- **"Other" generation can be net negative** in some states, for the same reason.
- **CO₂ is an estimate throughout** — derived from reported fuel consumption and published average
  factors, not from stack monitoring. Plant-specific controls, fuel quality and combustion efficiency
  are not modelled. For measured, unit-level emissions, see EPA's Clean Air Markets data or eGRID.
- **Emissions are CO₂ only** — not methane, nitrous oxide, or CO₂-equivalent.
- Behind-the-meter solar carries the uncertainty of any model estimate, and has no plant-level detail.

## Attribution

EIA data are U.S. Government works in the public domain. This dashboard is not affiliated with or
endorsed by the U.S. Energy Information Administration.
