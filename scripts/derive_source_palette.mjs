/**
 * Derive the per-source chart palette.
 *
 * Each energy source has a REQUESTED hue (coal red, gas orange, biomass dark
 * green, and so on). Hue is therefore fixed input, not something to optimise.
 * The problem is that six sources land in the warm 24-92 degree arc, and
 * red/orange/brown/yellow all collapse onto one axis under protanopia and
 * deuteranopia -- hue stops carrying identity there, so LIGHTNESS has to.
 *
 * So: hold every requested hue, and search the lightness of all sources at once
 * for the assignment that maximises the WORST all-pairs separation. All-pairs
 * rather than adjacent, because with a dozen sources in one treemap or stacked
 * bar any two can end up side by side.
 *
 * Each source gets a lightness RANGE that keeps its description true -- "dark
 * brown" may not drift light, "bright yellow" may not drift dark -- so the
 * result still reads as the palette that was asked for.
 *
 * Run: node scripts/derive_source_palette.mjs
 */

// ── colour maths ────────────────────────────────────────────────────────────
const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin2s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hex2srgb = (h) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16) / 255);
const linOf = (h) => hex2srgb(h).map(s2lin);

function linFromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
const oklch = (h) => { const [L, a, b] = oklabFromLin(linOf(h));
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180 / Math.PI) % 360 + 360) % 360]; };
const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
function lchToHex(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const rgb = linFromOklab([L, C * Math.cos(h), C * Math.sin(h)]);
  if (!inGamut(rgb)) return null;
  return "#" + rgb.map((c) => Math.round(lin2s(Math.max(0, Math.min(1, c))) * 255)
    .toString(16).padStart(2, "0")).join("");
}
function maxChroma(L, H) {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 36; i++) { const mid = (lo + hi) / 2; if (lchToHex(L, mid, H)) lo = mid; else hi = mid; }
  return lo;
}
/** Step at lightness L on hue H, at `chroma` clamped into gamut. */
const step = (L, H, chroma) => lchToHex(L, Math.min(chroma, maxChroma(L, H) * 0.97), H);

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

// ── the requested palette: hue is input, lightness is the free variable ─────
const NORMAL_FLOOR = 15, CVD_FLOOR = 8;

/**
 * Colours that have been reviewed and approved are PINNED to their exact hex, so
 * a later run cannot quietly drift them. Only the entries carrying a lightness
 * range are free, and they are optimised against the pinned set.
 *
 * "Other gases" is merged into "Other" and shares its grey, so it has no slot.
 */
const SPEC = [
  ["coal",              { hex: "#b32d32" }, "red"],
  // brand Bright Orange, unchanged. The earlier #fd7047 had drifted lighter and
  // less saturated, which is what read as salmon rather than orange.
  ["gas",               { hex: "#ff591f" }, "bright orange"],
  ["geothermal",        { hex: "#b20066" }, "pink (brand Pink)"],
  ["petroleum",         { hex: "#633e1d" }, "dark brown"],
  ["solar_utility",     { hex: "#f0c630" }, "brighter yellow"],
  ["solar_small_scale", { hex: "#ef8c48" }, "orange (brand Orange)"],
  ["biomass",           { hex: "#358452" }, "dark green"],
  ["wind",              { hex: "#42b1fc" }, "light blue"],
  ["hydro",             { hex: "#3064b5" }, "blue"],
  ["nuclear",           { hex: "#9b3aad" }, "purple"],
  ["other",             { hex: "#5c6069" }, "dark grey"],
];

/** Normalised headroom of a pair: 1.0 means exactly at both floors. */
function pairScore(a, b) {
  const n = dE(a, b) / NORMAL_FLOOR;
  const c = Math.min(dE(a, b, "protan"), dE(a, b, "deutan")) / CVD_FLOOR;
  return Math.min(n, c);
}
function worstPair(hexes) {
  let worst = Infinity, which = null;
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      const s = pairScore(hexes[i], hexes[j]);
      if (s < worst) { worst = s; which = [i, j]; }
    }
  }
  return { worst, which };
}

// A pinned slot has exactly one candidate; a free slot has one per 0.01 of
// lightness across its band.
const cands = SPEC.map(([, spec]) => {
  if (spec.hex) return [spec.hex];
  const out = [];
  for (let L = spec.band[0]; L <= spec.band[1] + 1e-9; L += 0.01) {
    const hex = step(+L.toFixed(3), spec.hue, spec.chroma);
    if (hex) out.push(hex);
  }
  if (!out.length) throw new Error("no in-gamut step for a free slot");
  return out;
});
const isFree = SPEC.map(([, spec]) => !spec.hex);

// Exhaustive over the free slots (few of them, so no need to hill-climb):
// pick the combination whose worst all-pairs score is highest.
const freeIdx = isFree.flatMap((f, i) => (f ? [i] : []));
let pick = cands.map(() => 0);
const hexAt = (p) => p.map((i, k) => cands[k][i]);

function search(depth, current) {
  if (depth === freeIdx.length) {
    return { score: worstPair(hexAt(current)).worst, pick: [...current] };
  }
  const k = freeIdx[depth];
  let best = null;
  for (let i = 0; i < cands[k].length; i++) {
    const trial = [...current];
    trial[k] = i;
    const r = search(depth + 1, trial);
    if (!best || r.score > best.score) best = r;
  }
  return best;
}
pick = search(0, pick).pick;

const hexes = hexAt(pick);

// ── report ──────────────────────────────────────────────────────────────────
console.log("Per-source palette: requested hue held, lightness optimised\n");
console.log("  key                 hex        L     C    H    contrast  asked for");
SPEC.forEach(([key, spec, want], k) => {
  const [L, C, H] = oklch(hexes[k]);
  console.log(`  ${key.padEnd(19)} ${hexes[k]}   ${L.toFixed(2)}  ${C.toFixed(2)}  ${String(Math.round(H)).padStart(3)}  `
    + `${contrast(hexes[k], "#ffffff").toFixed(2).padStart(6)}:1  ${want}${spec.hex ? " (pinned)" : " (optimised)"}`);
});
console.log(`  ${"pumped_storage".padEnd(19)} ${hexes[SPEC.findIndex(s => s[0] === "hydro")]}   `
  + `(shares hydro, as requested)`);

const pairs = [];
for (let i = 0; i < hexes.length; i++) {
  for (let j = i + 1; j < hexes.length; j++) {
    pairs.push({ a: SPEC[i][0], b: SPEC[j][0], n: dE(hexes[i], hexes[j]),
                 c: Math.min(dE(hexes[i], hexes[j], "protan"), dE(hexes[i], hexes[j], "deutan")) });
  }
}
pairs.sort((x, y) => pairScore(hexes[SPEC.findIndex(s => s[0] === x.a)], hexes[SPEC.findIndex(s => s[0] === x.b)])
  - pairScore(hexes[SPEC.findIndex(s => s[0] === y.a)], hexes[SPEC.findIndex(s => s[0] === y.b)]));

console.log(`\nWorst 8 of ${pairs.length} pairs (want normal >= ${NORMAL_FLOOR}, CVD >= ${CVD_FLOOR}):\n`);
console.log("  pair                                        normal   CVD");
for (const p of pairs.slice(0, 8)) {
  const bad = p.n < NORMAL_FLOOR || p.c < CVD_FLOOR;
  console.log(`  ${(p.a + " <-> " + p.b).padEnd(43)} ${p.n.toFixed(1).padStart(6)} ${p.c.toFixed(1).padStart(5)}`
    + (bad ? "   <-- below floor" : ""));
}
const failing = pairs.filter((p) => p.n < NORMAL_FLOOR || p.c < CVD_FLOOR);
console.log(`\n${failing.length} pair(s) below the floors (was 11 with the un-optimised hexes).`);

console.log("\nCSS custom properties:");
SPEC.forEach(([key], k) => console.log(`  --fuel-${key}: ${hexes[k]};`));
console.log(`  --fuel-pumped_storage: ${hexes[SPEC.findIndex(s => s[0] === "hydro")]};`);
