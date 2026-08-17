/**
 * Report separation for the per-source chart palette.
 *
 * Unlike derive_palette.mjs (which optimises 8 slots against the ADJACENT-pair
 * gates), this checks ALL pairs: with a dozen sources in one treemap or stacked
 * bar, any two can end up side by side, so every pair has to be tellable apart.
 *
 * Run: node scripts/check_source_palette.mjs
 */
const SURFACE = "#ffffff";

// ── colour maths ────────────────────────────────────────────────────────────
const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex2srgb = (h) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16) / 255);
const linOf = (h) => hex2srgb(h).map(s2lin);
function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
const oklch = (h) => { const [L, a, b] = oklabFromLin(linOf(h)); return [L, Math.hypot(a, b),
  ((Math.atan2(b, a) * 180 / Math.PI) % 360 + 360) % 360]; };
const relLum = (h) => { const [r, g, b] = linOf(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05); };
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
};
function sim(hex, kind) {
  const [r, g, b] = linOf(hex), M = MACHADO[kind], cl = (c) => Math.max(0, Math.min(1, c));
  return [cl(M[0][0] * r + M[0][1] * g + M[0][2] * b), cl(M[1][0] * r + M[1][1] * g + M[1][2] * b),
          cl(M[2][0] * r + M[2][1] * g + M[2][2] * b)];
}
function dE(h1, h2, kind) {
  const a = oklabFromLin(kind ? sim(h1, kind) : linOf(h1));
  const b = oklabFromLin(kind ? sim(h2, kind) : linOf(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ── the palette under test ──────────────────────────────────────────────────
export const SOURCE_COLORS = {
  coal:              { hex: "#b5202a", label: "Coal",                  want: "red" },
  gas:               { hex: "#fd571c", label: "Natural gas",           want: "bright orange" },
  petroleum:         { hex: "#6a4423", label: "Petroleum",             want: "dark brown" },
  other_gases:       { hex: "#b9bec7", label: "Other gases",           want: "light grey" },
  nuclear:           { hex: "#8b2c9d", label: "Nuclear",               want: "purple" },
  hydro:             { hex: "#1a4e9b", label: "Hydro",                 want: "dark blue" },
  pumped_storage:    { hex: "#1a4e9b", label: "Pumped storage",        want: "same as hydro" },
  wind:              { hex: "#45b2fd", label: "Wind",                  want: "light blue" },
  solar_utility:     { hex: "#f0c62e", label: "Solar (utility)",       want: "brighter yellow" },
  solar_small_scale: { hex: "#a17c12", label: "Solar (small-scale)",   want: "darker yellow" },
  geothermal:        { hex: "#d26a0b", label: "Geothermal",            want: "orange" },
  biomass:           { hex: "#186b3c", label: "Biomass",               want: "dark green" },
  other:             { hex: "#565b66", label: "Other",                 want: "dark grey" },
};

import { pathToFileURL } from "node:url";

// Windows drive paths need pathToFileURL: a hand-built `file://C:/...` has two
// slashes where import.meta.url has three, so the guard would never match.
if (!process.argv[1] || import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keys = Object.keys(SOURCE_COLORS);
  console.log("Per-source palette — OKLCH and contrast on white\n");
  console.log("  key                 hex       L     C    H     contrast  wanted");
  for (const k of keys) {
    const { hex, want } = SOURCE_COLORS[k];
    const [L, C, H] = oklch(hex);
    const cr = contrast(hex, SURFACE);
    const flag = C < 0.05 ? " (neutral)" : "";
    console.log(`  ${k.padEnd(19)} ${hex}  ${L.toFixed(2)}  ${C.toFixed(2)}  ${String(Math.round(H)).padStart(3)}  `
      + `${cr.toFixed(2).padStart(6)}:1   ${want}${flag}`);
  }

  // all distinct pairs (pumped_storage deliberately equals hydro, so skip it)
  const cmp = keys.filter((k) => k !== "pumped_storage");
  const pairs = [];
  for (let i = 0; i < cmp.length; i++) {
    for (let j = i + 1; j < cmp.length; j++) {
      const a = SOURCE_COLORS[cmp[i]].hex, b = SOURCE_COLORS[cmp[j]].hex;
      pairs.push({
        a: cmp[i], b: cmp[j],
        normal: dE(a, b),
        cvd: Math.min(dE(a, b, "protan"), dE(a, b, "deutan")),
      });
    }
  }
  pairs.sort((x, y) => Math.min(x.normal, x.cvd) - Math.min(y.normal, y.cvd));

  console.log(`\nWorst 12 of ${pairs.length} pairs (OKLab dE x100; want normal >=15, CVD >=8):\n`);
  console.log("  pair                                        normal   CVD   verdict");
  for (const p of pairs.slice(0, 12)) {
    const bad = p.normal < 15 || p.cvd < 8;
    const verdict = p.cvd < 6 ? "COLLAPSES under CVD"
      : p.normal < 15 ? "too close in full colour"
      : p.cvd < 8 ? "CVD floor band" : "ok";
    console.log(`  ${(p.a + " <-> " + p.b).padEnd(43)} ${p.normal.toFixed(1).padStart(6)} `
      + `${p.cvd.toFixed(1).padStart(5)}   ${bad ? verdict.toUpperCase() : verdict}`);
  }
  const failing = pairs.filter((p) => p.normal < 15 || p.cvd < 8);
  console.log(`\n${failing.length} pair(s) below the gates.`);
}
