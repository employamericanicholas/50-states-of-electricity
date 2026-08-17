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

const SPEC = [
  // key,                hue, chroma, [Lmin, Lmax],  what was asked for
  ["coal",               24,  0.17, [0.42, 0.58], "red"],
  ["gas",                37,  0.19, [0.62, 0.80], "bright orange"],
  ["geothermal",         53,  0.15, [0.55, 0.73], "orange"],
  ["petroleum",          60,  0.07, [0.33, 0.47], "dark brown"],
  ["solar_small_scale",  87,  0.12, [0.52, 0.70], "darker yellow"],
  ["solar_utility",      92,  0.16, [0.78, 0.90], "brighter yellow"],
  ["biomass",           153,  0.11, [0.38, 0.55], "dark green"],
  ["wind",              243,  0.15, [0.66, 0.80], "light blue"],
  ["hydro",             259,  0.14, [0.36, 0.50], "dark blue"],
  ["nuclear",           321,  0.19, [0.42, 0.64], "purple"],
  ["other",             266,  0.015, [0.38, 0.60], "dark grey"],
  ["other_gases",       266,  0.015, [0.72, 0.88], "light grey"],
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

// candidate steps per source, at 0.01 lightness resolution
const cands = SPEC.map(([, hue, chroma, [lo, hi]]) => {
  const out = [];
  for (let L = lo; L <= hi + 1e-9; L += 0.01) {
    const hex = step(+L.toFixed(3), hue, chroma);
    if (hex) out.push(hex);
  }
  return out;
});

// hill-climb from the mid-range assignment: repeatedly move whichever source is
// in the worst pair to whichever of its own steps most improves the minimum.
let pick = cands.map((c) => Math.floor(c.length / 2));
const hexAt = (p) => p.map((i, k) => cands[k][i]);
let best = worstPair(hexAt(pick)).worst;

for (let iter = 0; iter < 4000; iter++) {
  const { which } = worstPair(hexAt(pick));
  let improved = false;
  for (const k of which) {
    for (let i = 0; i < cands[k].length; i++) {
      if (i === pick[k]) continue;
      const trial = [...pick];
      trial[k] = i;
      const s = worstPair(hexAt(trial)).worst;
      if (s > best + 1e-9) { best = s; pick = trial; improved = true; }
    }
  }
  if (!improved) break;
}

const hexes = hexAt(pick);

// ── report ──────────────────────────────────────────────────────────────────
console.log("Per-source palette: requested hue held, lightness optimised\n");
console.log("  key                 hex        L     C    H    contrast  asked for");
SPEC.forEach(([key, hue, , , want], k) => {
  const [L, C, H] = oklch(hexes[k]);
  console.log(`  ${key.padEnd(19)} ${hexes[k]}   ${L.toFixed(2)}  ${C.toFixed(2)}  ${String(Math.round(H)).padStart(3)}  `
    + `${contrast(hexes[k], "#ffffff").toFixed(2).padStart(6)}:1  ${want}`);
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
