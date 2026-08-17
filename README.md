# 50 States of Electricity

A static dashboard showing what every U.S. state's electricity was made of in **calendar year 2024** —
including per-plant generation, an estimated CO₂ figure for each plant, and EIA's own estimate of
behind-the-meter (rooftop) solar.

Every number comes from the **U.S. Energy Information Administration**. Nothing is modelled here
except the CO₂ estimate, which is documented in full on the page and in [SOURCES.md](SOURCES.md).

## What it shows

- **National and per-state generation mix** for all 50 states + DC — treemap, stacked bar, ranked bars.
- **All 51 geographies side by side** as 100% stacked rows, sortable by carbon-free share, renewable
  share, fossil share, total generation, or carbon intensity.
- **Behind-the-meter solar** as a distinct, clearly-labelled category (EIA series `DPV`), added on top
  of utility-scale generation rather than mixed into it.
- **Every power plant** that reported generation to EIA in 2024 — 13,208 of them — with operator,
  county, nameplate capacity, net generation, and an estimated CO₂ figure with intensity in kg/MWh.
  Searchable, sortable, CSV-exportable.
- **A validation panel** comparing our bottom-up CO₂ estimate against EIA's own published state
  totals, so you can see how much to trust it. Nationally the all-fuel estimate lands at **99.4%**
  of EIA's figure.

## Architecture

The published site is **fully static** — plain HTML, CSS and ES modules, no build step, no runtime
dependencies, and **no API key in the browser**. A Python script pulls from the EIA API at build time
and writes plain JSON into `data/`.

```
index.html                 the dashboard
assets/css/styles.css      brand tokens + layout
assets/js/charts.js        dependency-free SVG charts (treemap, bars, stacked rows)
assets/js/app.js           data loading, filtering, rendering
data/index.json            51-state index — the only file loaded up front (~33 KB)
data/us.json               national totals + 300 largest plants
data/state/XX.json         one file per state, every plant, loaded on demand
data/meta.json             sources, emission factors, methodology, provenance
scripts/build_data.py      the ETL — stdlib only, no pip install
scripts/derive_palette.mjs derives + validates the chart palette from brand colours
```

Per-state files load only when that state is selected, so the landing view stays small.

## Rebuilding the data

You need a free EIA API key: <https://www.eia.gov/opendata/register.php>

```bash
cp .env.example .env      # then paste your key into .env  (.env is gitignored)
python scripts/build_data.py
```

No `pip install` required — the script uses only the Python standard library (3.9+).

Raw API responses are cached in `.cache/` so re-runs are fast. Use `--no-cache` to force a refetch.

The build **validates itself** and refuses to hide problems. It checks that:

- the 13 energy-source codes used for each state sum exactly to EIA's own all-fuels total;
- each plant's per-fuel rows reproduce that plant's own reported total, for both generation and
  fuel consumed (this catches the double-counting trap in the `facility-fuel` route — see below);
- every fuel code encountered has a known category and a documented emission-factor treatment.

Anything unexpected is printed as a warning and written into `data/meta.json` under `validation`.

### A trap worth knowing about

The EIA `facility-fuel` route returns each plant at **three** granularities in the same response, and
it carries **two different fuel vocabularies**:

- `fuelType` is an *aggregate* category (19 values, e.g. `COL` = Coal)
- `fuel2002` is the *specific* fuel burned (44 values, e.g. `BIT` = Bituminous)

Summing rows naively double- or triple-counts. This build keeps only rows where
`primeMover == "ALL"` and `fuelType != "ALL"`, groups on `fuelType`, and looks emission factors up on
`fuel2002` — so bituminous, subbituminous and lignite coal each get their own factor instead of a
coal average. The per-plant partition check above is what proves this is right.

## Deploying to GitHub Pages

1. Create a repository and push this directory.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`. The included workflow ([.github/workflows/pages.yml](.github/workflows/pages.yml))
   publishes the site as-is, using the committed JSON. No secrets needed.

The `data/` JSON is committed deliberately: it makes the site reproducible, diffable, and independent
of API availability or rate limits.

### Optional: scheduled data refresh

[.github/workflows/refresh-data.yml](.github/workflows/refresh-data.yml) re-runs the ETL monthly and
opens a pull request if the numbers changed. It needs a repository secret named `EIA_API_KEY`
(**Settings → Secrets and variables → Actions**). It is manual-dispatch and schedule only, so it
never runs on forks or pull requests, and the key is never exposed to the published site.

> **Keep your API key out of the repo.** It belongs in `.env` locally (gitignored) or in an Actions
> secret. The published dashboard never needs it, because the data is pre-built.

## Design

Built to the **Employ America Brand Guidelines 2025** — Deep Blue `#191E3A`, Bright Blue `#007BEA`,
Warm White `#F9F7F5` surfaces, Orange `#EF8C48` accents, Lato for headers and body, Montserrat for
subheads.

The eight chart colours are **derived** from the brand chart palette rather than used raw: several
brand colours sit outside a legible lightness band or collapse into each other under colour-vision
deficiency. `scripts/derive_palette.mjs` holds each brand colour's hue, moves only its lightness, and
picks the steps that minimise deviation from the brand values while clearing the lightness-band,
chroma, colour-blind-separation and contrast gates — separately for light and dark mode. Five of the
eight land on the near-exact brand hex. Run it to see the report:

```bash
node scripts/derive_palette.mjs
```

Accessibility: every chart has a table-view twin or direct value labels, marks are keyboard-focusable
with the same readout as hover, identity is never carried by colour alone, and both themes are
independently validated.

## Licence & attribution

EIA data are U.S. Government works in the public domain. This dashboard is **not** affiliated with or
endorsed by the EIA. Code is available for reuse; please keep the source attributions intact.
