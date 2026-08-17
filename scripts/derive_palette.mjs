/**
 * Derive a validated categorical fuel palette from the Employ America brand hues.
 *
 * Method (per the dataviz skill's "snap-to-passing"): hold each brand anchor's
 * OKLCH hue, move only its lightness, and pick the step per slot that maximises
 * the MINIMUM adjacent CVD deltaE (bottleneck DP over the fixed slot order).
 * Light and dark modes get their own steps from the same hue ramps.
 *
 * Run: node scripts/derive_palette.mjs
 */
// Self-contained: the gates below are implemented in this file so the script
// runs anywhere with plain `node scripts/derive_palette.mjs`, no dependencies.

// ── colour maths (OKLab/OKLCH <-> sRGB) ──────────────────────────────────────
const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin2s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hex2srgb = (h) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16) / 255);

function linFromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
const oklchOf = (hex) => {
  const [L, a, b] = oklabFromLin(hex2srgb(hex).map(s2lin));
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
};
const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
function lchToHex(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const rgb = linFromOklab([L, C * Math.cos(h), C * Math.sin(h)]);
  if (!inGamut(rgb)) return null;
  return (
    "#" +
    rgb.map((c) => Math.round(lin2s(Math.max(0, Math.min(1, c))) * 255).toString(16).padStart(2, "0")).join("")
  );
}
/** Max in-gamut chroma for a given L/hue (binary search). */
function maxChroma(L, Hdeg) {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (lchToHex(L, mid, Hdeg)) lo = mid; else hi = mid;
  }
  return lo;
}
/** A step holding hue, at lightness L and chroma C (clamped into gamut). */
function stepAt(L, Hdeg, C) {
  return lchToHex(L, Math.min(C, maxChroma(L, Hdeg) * 0.98), Hdeg);
}

// CVD sim + deltaE, identical maths to the skill's validator (Machado 2009 sev 1.0)
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
};
const linOf = (hex) => hex2srgb(hex).map(s2lin);
function sim(hex, kind) {
  const [r, g, b] = linOf(hex), M = MACHADO[kind], cl = (c) => Math.max(0, Math.min(1, c));
  return [cl(M[0][0] * r + M[0][1] * g + M[0][2] * b), cl(M[1][0] * r + M[1][1] * g + M[1][2] * b), cl(M[2][0] * r + M[2][1] * g + M[2][2] * b)];
}
function dE(h1, h2, kind) {
  const a = oklabFromLin(kind ? sim(h1, kind) : linOf(h1));
  const b = oklabFromLin(kind ? sim(h2, kind) : linOf(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
/** Score of an adjacent pair: must clear the normal-vision floor, then maximise CVD. */
const pairScore = (x, y) =>
  dE(x, y) < 15 ? -1 : Math.min(dE(x, y, "protan"), dE(x, y, "deutan"));

const relLum = (hex) => { const [r, g, b] = linOf(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The five computable gates a categorical chart palette must clear:
 * lightness band, chroma floor, CVD separation (protan/deutan, OKLab dE x100),
 * a normal-vision floor on the same pairs, and contrast against the surface.
 * Sub-3:1 contrast is a WARN requiring visible labels or a table view, not a fail.
 */
function validate(palette, { mode, surface }) {
  const [lo, hi] = BAND[mode];
  const report = [];
  let ok = true;

  const off = palette.filter((c) => { const L = oklchOf(c)[0]; return L < lo || L > hi; })
    .map((c) => [c, +oklchOf(c)[0].toFixed(3)]);
  if (off.length) ok = false;
  report.push(["Lightness band", !off.length,
    off.length ? `outside band: ${JSON.stringify(off)}` : `all ${palette.length} inside L ${lo}-${hi}`]);

  const lowC = palette.filter((c) => oklchOf(c)[1] < 0.10).map((c) => [c, +oklchOf(c)[1].toFixed(3)]);
  if (lowC.length) ok = false;
  report.push(["Chroma floor", !lowC.length,
    lowC.length ? `below floor: ${JSON.stringify(lowC)}` : `all ${palette.length} >= 0.1`]);

  const pairs = palette.slice(1).map((_, i) => [i, i + 1]);
  let worst = null;
  for (const kind of ["protan", "deutan"]) {
    for (const [i, j] of pairs) {
      const d = dE(palette[i], palette[j], kind);
      if (!worst || d < worst[0]) worst = [d, kind, palette[i], palette[j]];
    }
  }
  const state = worst[0] >= 8 ? "pass" : worst[0] >= 6 ? "floor" : "fail";
  if (state === "fail") ok = false;
  report.push(["CVD separation", state,
    `worst adjacent ${worst[3]} <-> ${worst[2]} dE ${worst[0].toFixed(1)} (${worst[1]})`]);

  let nWorst = null;
  for (const [i, j] of pairs) {
    const d = dE(palette[i], palette[j]);
    if (!nWorst || d < nWorst[0]) nWorst = [d, palette[i], palette[j]];
  }
  const nOk = nWorst[0] >= 15;
  if (!nOk) ok = false;
  report.push(["Normal-vision floor", nOk,
    `worst adjacent ${nWorst[2]} <-> ${nWorst[1]} dE ${nWorst[0].toFixed(1)}`
    + (nOk ? "" : " - below 15, hard to tell apart with full colour vision")]);

  const low = palette.filter((c) => contrast(c, surface) < 3)
    .map((c) => [c, +contrast(c, surface).toFixed(2)]);
  report.push(["Contrast vs surface", low.length ? "relief" : "pass",
    low.length ? `below 3:1 - needs visible labels or a table view: ${JSON.stringify(low)}`
               : `all ${palette.length} >= 3:1`]);

  return { report, ok };
}

// ── brand anchors: fuel slot -> brand colour whose HUE we hold ───────────────
// Fixed slot order = legend + stack order (fossil, nuclear, then renewables).
const SLOTS = [
  { key: "coal",      label: "Coal",                    anchor: "#2E2A73", anchorName: "Dark Purple" },
  { key: "gas",       label: "Natural gas",             anchor: "#FF591F", anchorName: "Bright Orange" },
  { key: "nuclear",   label: "Nuclear",                 anchor: "#8A2B9C", anchorName: "Bright Purple" },
  { key: "wind",      label: "Wind",                    anchor: "#40B2FF", anchorName: "Bright Light Blue" },
  { key: "solar_u",   label: "Solar (utility-scale)",   anchor: "#EAC14B", anchorName: "Yellow" },
  { key: "solar_btm", label: "Solar (small-scale)",     anchor: "#EF8C48", anchorName: "Orange" },
  { key: "hydro",     label: "Hydro",                   anchor: "#104591", anchorName: "Blue" },
  { key: "other",     label: "Other",                   anchor: "#008A6A", anchorName: "Green" },
];

const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] };
const SURFACE = { light: "#F9F7F5", dark: "#191E3A" };

/**
 * Candidate steps for a slot: hold the anchor's HUE, sweep lightness across the
 * mode's band, and try a few chroma multiples of the ANCHOR's own chroma so the
 * result still reads as the brand colour rather than a maxed-out neon.
 */
function candidates(anchor, mode) {
  const [aL, aC, aH] = oklchOf(anchor);
  const [lo, hi] = BAND[mode];
  const seen = new Map();
  for (let L = lo + 0.005; L <= hi - 0.005; L += 0.01) {
    for (const mult of [0.85, 1.0, 1.15, 1.3]) {
      const hex = stepAt(+L.toFixed(3), aH, aC * mult);
      if (!hex) continue;
      const [cL, cC] = oklchOf(hex);
      if (cC < 0.105) continue;                       // chroma floor + headroom
      if (cL < lo || cL > hi) continue;               // lightness band
      // deviation from brand: lightness move dominates, chroma move counts less
      const dev = Math.hypot((cL - aL) * 1.0, (cC - aC) * 0.6) * 100;
      if (!seen.has(hex) || seen.get(hex) > dev) seen.set(hex, dev);
    }
  }
  return [...seen.entries()].map(([hex, dev]) => ({ hex, dev }));
}

const CVD_TARGET = 8.0, NORMAL_FLOOR = 15.0;

/**
 * DP over the fixed slot chain: minimise TOTAL deviation from the brand anchors
 * subject to every adjacent pair clearing the CVD target and normal-vision floor.
 * i.e. "hold the hue, move the lightness as little as the gates allow".
 */
function optimise(mode) {
  const cands = SLOTS.map((s) => candidates(s.anchor, mode));
  cands.forEach((c, i) => { if (!c.length) throw new Error(`no in-band step for ${SLOTS[i].key}`); });

  const ok = (x, y) => dE(x, y) >= NORMAL_FLOOR && Math.min(dE(x, y, "protan"), dE(x, y, "deutan")) >= CVD_TARGET;

  let dp = cands[0].map((c) => c.dev);
  const back = cands.map((c) => c.map(() => -1));
  for (let i = 1; i < SLOTS.length; i++) {
    const next = cands[i].map(() => Infinity);
    for (let j = 0; j < cands[i].length; j++) {
      for (let k = 0; k < cands[i - 1].length; k++) {
        if (!Number.isFinite(dp[k])) continue;
        if (!ok(cands[i - 1][k].hex, cands[i][j].hex)) continue;
        const cost = dp[k] + cands[i][j].dev;
        if (cost < next[j]) { next[j] = cost; back[i][j] = k; }
      }
    }
    dp = next;
  }
  let best = -1;
  for (let j = 0; j < dp.length; j++) if (Number.isFinite(dp[j]) && (best < 0 || dp[j] < dp[best])) best = j;
  if (best < 0) throw new Error(`${mode}: no assignment satisfies the gates for this slot order`);

  const idx = new Array(SLOTS.length);
  idx[SLOTS.length - 1] = best;
  for (let i = SLOTS.length - 1; i > 0; i--) idx[i - 1] = back[i][idx[i]];
  const hexes = idx.map((j, i) => cands[i][j].hex);
  let bottleneck = Infinity;
  for (let i = 1; i < hexes.length; i++) bottleneck = Math.min(bottleneck, pairScore(hexes[i - 1], hexes[i]));
  return { hexes, bottleneck, totalDev: dp[best] };
}

// ── run ──────────────────────────────────────────────────────────────────────
const result = {};
for (const mode of ["light", "dark"]) {
  const { hexes, bottleneck, totalDev } = optimise(mode);
  result[mode] = hexes;
  console.log(`\n(total deviation from brand anchors: ${totalDev.toFixed(1)})`);
  console.log(`\n${"=".repeat(78)}\n${mode.toUpperCase()} mode  (surface ${SURFACE[mode]}, band ${BAND[mode].join("–")})\n${"=".repeat(78)}`);
  SLOTS.forEach((s, i) => {
    const [L, C, H] = oklchOf(hexes[i]);
    const [, , aH] = oklchOf(s.anchor);
    console.log(
      `  ${String(i + 1).padStart(2)}. ${s.label.padEnd(24)} ${hexes[i]}  ` +
      `L ${L.toFixed(3)} C ${C.toFixed(3)} H ${H.toFixed(0)}°   ` +
      `<- ${s.anchorName} ${s.anchor} (H ${aH.toFixed(0)}°)`
    );
  });
  console.log(`  min adjacent CVD deltaE = ${bottleneck.toFixed(1)}`);
  const v = validate(hexes, { mode, surface: SURFACE[mode] });
  for (const [name, state, detail] of v.report) {
    const g = { true: "PASS", false: "FAIL", pass: "PASS", floor: "WARN", fail: "FAIL", relief: "WARN" };
    console.log(`  [${(g[state] ?? state).padEnd(4)}] ${name.padEnd(22)} ${detail}`);
  }
  console.log(`  => ${v.ok ? "ALL CHECKS PASS" : "FAILED"}`);
}

console.log(`\n${"=".repeat(78)}\nCSS custom properties\n${"=".repeat(78)}`);
for (const mode of ["light", "dark"]) {
  console.log(`/* ${mode} */`);
  SLOTS.forEach((s, i) => console.log(`  --fuel-${s.key.replace(/_/g, "-")}: ${result[mode][i]};`));
}
console.log("\nJS palette arrays:");
for (const mode of ["light", "dark"]) console.log(`${mode}: ${JSON.stringify(result[mode])}`);
