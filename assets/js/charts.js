/* ==========================================================================
   charts.js — dependency-free SVG chart primitives.

   Mark specs follow the house data-viz rules: bars capped at 24px with a 4px
   rounded data-end squared at the baseline, 2px surface-coloured gaps doing the
   separating (never a stroke around a mark), hairline solid gridlines, labels
   in text tokens rather than the series colour, selective direct labels, and a
   hover/focus tooltip on every mark.

   All user/API-derived strings enter the DOM through textContent, never
   innerHTML concatenation.
   ========================================================================== */

const SVGNS = "http://www.w3.org/2000/svg";
export const GAP = 2;          // surface gap between touching marks
const BAR_MAX = 24;            // max bar thickness
const RADIUS = 4;              // rounded data-end

/* ---------- small helpers ---------- */
export const el = (name, attrs = {}, parent = null) => {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    n.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(n);
  return n;
};
const text = (parent, str, attrs = {}) => {
  const t = el("text", attrs, parent);
  t.textContent = str;
  return t;
};
export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

/**
 * The rendered width of a chart host. Every chart draws at its container's true
 * pixel width so the viewBox aspect matches and the SVG never letterboxes; a
 * zero here means an ancestor is still hidden, which is a caller bug.
 */
function hostWidth(host, fallback = 900) {
  const w = host.clientWidth || host.getBoundingClientRect().width
    || host.parentElement?.clientWidth || 0;
  if (w < 2) {
    console.warn("charts: host has no width yet — is an ancestor still hidden?", host.id || host);
    return fallback;
  }
  return Math.round(w);
}

/** Rounded on the data end only, square at the baseline. */
function barPath(x, y, w, h, r, dir) {
  r = Math.max(0, Math.min(r, dir === "h" ? w : h, (dir === "h" ? h : w) / 2));
  if (r < .5) return `M${x} ${y}h${w}v${h}h${-w}z`;
  if (dir === "h") {
    // grows left -> right, rounded right edge
    return `M${x} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - r)}z`;
  }
  // grows bottom -> up, rounded top edge
  return `M${x} ${y + h}v${-(h - r)}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - r}z`;
}

/** Pick ink or white for a label sitting inside a coloured fill. */
export function inkOn(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.42 ? "ink" : "inv";
}

/** Approximate rendered text width (Lato ~0.53em average). */
const textW = (str, size, weight = 400) => str.length * size * (weight >= 700 ? 0.565 : 0.525);

/**
 * Percentage label. Whole numbers from 10% up, where a decimal adds nothing;
 * one place below that, so a 0.4% sliver does not round away to "0%".
 * Exported so the page and the charts label percentages identically.
 */
export const pctLabel = (v) => {
  const a = Math.abs(v);
  return `${v.toLocaleString("en-US", {
    minimumFractionDigits: a >= 10 ? 0 : 1,
    maximumFractionDigits: a >= 10 ? 0 : 1,
  })}%`;
};

/* ---------- tooltip singleton ---------- */
let tipNode = null;
function tip() {
  if (!tipNode) {
    tipNode = document.createElement("div");
    tipNode.className = "tip";
    tipNode.setAttribute("role", "status");
    document.body.appendChild(tipNode);
  }
  return tipNode;
}
/**
 * rows: [{ label, value, color }]  — value leads, label follows.
 * meta: optional plain-text footnote.
 */
export function showTip(evt, title, rows, meta) {
  const t = tip();
  clear(t);
  if (title) {
    const h = document.createElement("div");
    h.className = "tip__title";
    h.textContent = title;
    t.appendChild(h);
  }
  for (const r of rows) {
    const line = document.createElement("div");
    line.className = "tip__row";
    if (r.color) {
      const k = document.createElement("i");
      k.className = "tip__key";
      k.style.background = r.color;
      line.appendChild(k);
    }
    const v = document.createElement("span");
    v.className = "tip__val";
    v.textContent = r.value;
    line.appendChild(v);
    if (r.label) {
      const n = document.createElement("span");
      n.className = "tip__name";
      n.textContent = r.label;
      line.appendChild(n);
    }
    t.appendChild(line);
  }
  if (meta) {
    const m = document.createElement("div");
    m.className = "tip__meta";
    m.textContent = meta;
    t.appendChild(m);
  }
  t.dataset.show = "1";
  moveTip(evt);
}
export function moveTip(evt) {
  const t = tip();
  const pad = 10;
  const r = t.getBoundingClientRect();
  let x = evt.clientX;
  const y = evt.clientY;
  x = Math.max(r.width / 2 + pad, Math.min(window.innerWidth - r.width / 2 - pad, x));
  t.style.left = `${x}px`;
  t.style.top = `${Math.max(r.height + pad, y)}px`;
}
export function hideTip() { if (tipNode) tipNode.dataset.show = "0"; }

/** Wire hover + keyboard focus to the same readout. */
function interactive(node, title, rows, meta) {
  node.setAttribute("tabindex", "0");
  node.setAttribute("role", "img");
  const flat = rows.map((r) => `${r.label ? r.label + ": " : ""}${r.value}`).join(", ");
  node.setAttribute("aria-label", `${title ? title + ". " : ""}${flat}`);
  const enter = (e) => { node.dataset.hover = "1"; showTip(e, title, rows, meta); };
  const leave = () => { node.dataset.hover = "0"; hideTip(); };
  node.addEventListener("pointerenter", enter);
  node.addEventListener("pointermove", moveTip);
  node.addEventListener("pointerleave", leave);
  node.addEventListener("focus", () => {
    const b = node.getBoundingClientRect();
    enter({ clientX: b.left + b.width / 2, clientY: b.top });
  });
  node.addEventListener("blur", leave);
}

/* ======================================================================
   Treemap — squarified, part-to-whole at a glance.
   items: [{ label, value, color, sub? }]   (positive values only)
   ====================================================================== */
export function treemap(host, items, opts = {}) {
  const { height = 340, fmt = String, surface = "var(--surface)" } = opts;
  clear(host);
  const data = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  if (!data.length) { host.innerHTML = '<p class="empty">No positive generation to show.</p>'; return; }

  const W = hostWidth(host);
  const H = height;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none",
                          style: `height:${H}px`, role: "group" }, host);

  const total = data.reduce((s, d) => s + d.value, 0);
  const rects = squarify(data.map((d) => ({ ...d, area: d.value / total * W * H })), 0, 0, W, H);

  for (const r of rects) {
    // The 2px gap is carved out of the tile, so nothing needs a stroke.
    const x = r.x + GAP / 2, y = r.y + GAP / 2;
    const w = Math.max(0, r.w - GAP), h = Math.max(0, r.h - GAP);
    const g = el("g", { class: "mark" }, svg);
    el("rect", { x, y, width: w, height: h, rx: 3, fill: r.color }, g);

    const pct = r.value / total * 100;
    const mode = inkOn(r.color);
    const cls = mode === "inv" ? "mark-label mark-label--inv" : "mark-label";
    // Step the label down through smaller sizes and only draw the one that
    // genuinely fits with padding — never clip, never overflow the tile.
    const nameSize = [13, 11.5, 10.5].find(
      (s) => w > 54 && h > 28 && textW(r.label, s, 700) < w - 14) || 0;
    if (nameSize) {
      text(g, r.label, { x: x + 8, y: y + 7 + nameSize, class: cls, "font-size": nameSize });
      const valSize = Math.min(11.5, nameSize);
      const val = `${fmt(r.value)}  ·  ${pctLabel(pct)}`;
      if (h > nameSize + valSize + 22 && textW(val, valSize) < w - 14) {
        const v = text(g, val, { x: x + 8, y: y + 9 + nameSize + valSize + 3, class: cls,
                                 "font-size": valSize, "font-weight": 400 });
        v.setAttribute("opacity", mode === "inv" ? ".82" : ".72");
      }
    }
    // fmt carries its own unit, so no unit is appended here.
    interactive(g, r.label,
      [{ value: fmt(r.value), label: `${pctLabel(pct)} of total`, color: r.color }],
      r.sub || null);
  }
  return svg;
}

/** Squarified treemap layout (Bruls, Huizing & van Wijk). */
function squarify(items, x, y, w, h) {
  const out = [];
  const nodes = [...items];
  let cx = x, cy = y, cw = w, ch = h;

  while (nodes.length) {
    const short = Math.min(cw, ch);
    const row = [nodes.shift()];
    let rowArea = row[0].area;
    // grow the row while the worst aspect ratio keeps improving
    while (nodes.length) {
      const next = nodes[0];
      if (worst(row, rowArea, short) >= worst([...row, next], rowArea + next.area, short)) {
        row.push(nodes.shift());
        rowArea += next.area;
      } else break;
    }
    const thick = rowArea / short;
    let off = 0;
    for (const n of row) {
      const len = n.area / thick;
      out.push(cw <= ch
        ? { ...n, x: cx + off, y: cy, w: len, h: thick }
        : { ...n, x: cx, y: cy + off, w: thick, h: len });
      off += len;
    }
    if (cw <= ch) { cy += thick; ch -= thick; } else { cx += thick; cw -= thick; }
    if (ch < .5 || cw < .5) break;
  }
  return out;
}
function worst(row, area, short) {
  const thick = area / short;
  let bad = 1;
  for (const n of row) {
    const len = n.area / thick;
    bad = Math.max(bad, thick / len, len / thick);
  }
  return bad;
}

/* ======================================================================
   Horizontal bars — magnitude comparison with direct value labels.
   items: [{ label, value, color, sub?, meta? }]
   ====================================================================== */
export function hbar(host, items, opts = {}) {
  const { fmt = String, labelW = 148, rowH = 30, valueSuffix = "", showZeroRule = true,
          highlight = null, onClick = null } = opts;
  clear(host);
  if (!items.length) { host.innerHTML = '<p class="empty">Nothing to show.</p>'; return; }

  const W = hostWidth(host);
  const padR = 96;
  const plotW = Math.max(60, W - labelW - padR);
  const H = items.length * rowH + 8;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, style: `height:${H}px`, role: "group" }, host);

  const min = Math.min(0, ...items.map((d) => d.value));
  const max = Math.max(0, ...items.map((d) => d.value));
  const span = (max - min) || 1;
  const zeroX = labelW + (-min / span) * plotW;
  const scale = (v) => (Math.abs(v) / span) * plotW;

  if (showZeroRule && min < 0) {
    el("line", { x1: zeroX, y1: 2, x2: zeroX, y2: H - 6, class: "grid-line" }, svg);
  }

  const barH = Math.min(BAR_MAX, rowH - 8);
  items.forEach((d, i) => {
    const y = i * rowH + (rowH - barH) / 2 + 2;
    const len = Math.max(1, scale(d.value));
    const neg = d.value < 0;
    const x = neg ? zeroX - len : zeroX;
    const g = el("g", { class: "mark", style: onClick ? "cursor:pointer" : null }, svg);
    const dim = highlight && d.key !== highlight;

    // row label — text token, never the series colour
    text(g, d.label, {
      x: labelW - 10, y: y + barH / 2 + 4, "text-anchor": "end",
      class: dim ? "mark-label mark-label--dim" : "mark-label", "font-size": 12,
    });

    // Emphasis is carried by the label, not by fading every other bar: with 50
    // rows, dimming the rest makes the whole chart read washed out.
    el("path", {
      d: neg
        ? `M${x + len} ${y}h${-(len - RADIUS)}a${RADIUS} ${RADIUS} 0 0 0 ${-RADIUS} ${RADIUS}v${barH - 2 * RADIUS}a${RADIUS} ${RADIUS} 0 0 0 ${RADIUS} ${RADIUS}h${len - RADIUS}z`
        : barPath(x, y, len, barH, RADIUS, "h"),
      fill: d.color,
    }, g);

    // Value sits outside the bar end so it never collides with the fill. For a
    // negative bar the outside end points back at the row label, so put the
    // value in the empty positive space to the right of the zero rule instead.
    const vtxt = `${fmt(d.value)}${valueSuffix}`;
    text(g, vtxt, {
      x: neg ? zeroX + 8 : x + len + 8, y: y + barH / 2 + 4,
      "text-anchor": "start",
      class: "mark-label", "font-size": 11.5,
      "font-variant-numeric": "tabular-nums",
    });

    interactive(g, d.label,
      [{ value: vtxt, label: d.sub || "", color: d.color }], d.meta || null);
    if (onClick) {
      g.addEventListener("click", () => onClick(d));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(d); } });
    }
  });
  return svg;
}

/* ======================================================================
   100% stacked rows — share-of-mix across many categories (the 51 states).
   rows:  [{ key, label, total, parts: [{ key, label, value, color }] }]
   ====================================================================== */
export function stackedRows(host, rows, opts = {}) {
  const { labelW = 128, rowH = 22, fmt = String, highlight = null, onClick = null,
          trailW = 92, trailFmt = null, trailLabel = "" } = opts;
  clear(host);
  if (!rows.length) { host.innerHTML = '<p class="empty">Nothing to show.</p>'; return; }

  const W = hostWidth(host);
  const plotW = Math.max(80, W - labelW - trailW - 14);
  const H = rows.length * rowH + 26;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, style: `height:${H}px`, role: "group" }, host);

  // axis: 0-100% hairlines behind the bars
  const axis = el("g", {}, svg);
  for (const p of [0, 25, 50, 75, 100]) {
    const x = labelW + (p / 100) * plotW;
    el("line", { x1: x, y1: 16, x2: x, y2: H - 8, class: "grid-line" }, axis);
    text(axis, `${p}%`, { x, y: 10, "text-anchor": p === 0 ? "start" : p === 100 ? "end" : "middle",
                          class: "axis-text" });
  }

  const barH = Math.min(BAR_MAX, rowH - 6);
  rows.forEach((r, i) => {
    const y = 16 + i * rowH + (rowH - barH) / 2;
    const g = el("g", { class: "mark", style: onClick ? "cursor:pointer" : null }, svg);
    const dim = highlight && r.key !== highlight;
    const on = highlight && r.key === highlight;

    const lab = text(g, r.label, {
      x: labelW - 10, y: y + barH / 2 + 4, "text-anchor": "end", "font-size": 11.5,
      class: on ? "mark-label" : "mark-label mark-label--dim",
    });
    if (dim) lab.setAttribute("opacity", ".8");

    const pos = r.parts.filter((p) => p.value > 0);
    const sum = pos.reduce((s, p) => s + p.value, 0) || 1;
    let x = labelW;
    pos.forEach((p, j) => {
      const raw = (p.value / sum) * plotW;
      // carve the surface gap out of every segment but the last
      const w = Math.max(0.7, raw - (j < pos.length - 1 ? GAP : 0));
      const seg = el("rect", { x, y, width: w, height: barH, fill: p.color,
                               rx: j === 0 || j === pos.length - 1 ? 1.5 : 0 }, g);
      if (dim) seg.setAttribute("opacity", ".72");
      x += raw;
    });

    if (trailFmt) {
      text(g, trailFmt(r), { x: W - 4, y: y + barH / 2 + 4, "text-anchor": "end",
                             class: on ? "mark-label" : "mark-label mark-label--dim",
                             "font-size": 11.5, "font-variant-numeric": "tabular-nums" });
    }

    interactive(g, r.label,
      pos.slice().sort((a, b) => b.value - a.value).map((p) => ({
        value: pctLabel((p.value / sum) * 100),
        label: p.label, color: p.color,
      })),
      `${trailLabel}${trailLabel ? ": " : ""}${fmt(r.total)}`);
    if (onClick) {
      g.addEventListener("click", () => onClick(r));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(r); } });
    }
  });
  return svg;
}

/* ======================================================================
   A single 100% stacked bar — the selected geography's mix in one line.
   ====================================================================== */
/** "Solar (utility-scale)" -> "Solar": the qualifier never fits under a segment. */
const shortLabel = (s) => s.replace(/\s*\(.*\)\s*$/, "");

export function stackedBar(host, parts, opts = {}) {
  const { height = 46, fmt = String, pctSize = 14, labelSize = 13 } = opts;
  clear(host);
  const pos = parts.filter((p) => p.value > 0);
  if (!pos.length) { host.innerHTML = '<p class="empty">Nothing to show.</p>'; return; }

  const W = hostWidth(host);
  const H = height + 24;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, style: `height:${H}px`, role: "group" }, host);
  const sum = pos.reduce((s, p) => s + p.value, 0);
  let x = 0;
  // Right edge of the last label drawn, so names never run into each other as the
  // segments narrow toward the tail. A name that will not fit is simply dropped —
  // the legend, hover readout and table view all still carry it.
  let lastLabelRight = -Infinity;
  // Shortening drops the qualifier, so both solar rows become "Solar". Draw each
  // distinct name once — largest first, so the bigger segment keeps it — and let
  // the legend and hover readout separate them.
  const drawnNames = new Set();

  pos.forEach((p, j) => {
    const raw = (p.value / sum) * W;
    const w = Math.max(0.7, raw - (j < pos.length - 1 ? GAP : 0));
    const g = el("g", { class: "mark" }, svg);
    el("rect", { x, y: 0, width: w, height: height, fill: p.color,
                 rx: j === 0 || j === pos.length - 1 ? 2 : 0 }, g);

    const pct = (p.value / sum) * 100;
    const lbl = `${pct.toFixed(0)}%`;
    if (textW(lbl, pctSize, 700) < w - 8) {
      const mode = inkOn(p.color);
      text(g, lbl, { x: x + w / 2, y: height / 2 + pctSize / 2 - 1, "text-anchor": "middle",
                     class: mode === "inv" ? "mark-label mark-label--inv" : "mark-label",
                     "font-size": pctSize });
    }

    const name = shortLabel(p.label);
    const nameW = textW(name, labelSize);
    const centre = x + w / 2;
    // must fit inside its own segment, clear the previous name, and not repeat one
    if (nameW < w - 6 && centre - nameW / 2 > lastLabelRight + 8 && !drawnNames.has(name)) {
      text(svg, name, { x: centre, y: height + labelSize + 4, "text-anchor": "middle",
                        class: "axis-text", "font-size": labelSize });
      lastLabelRight = centre + nameW / 2;
      drawnNames.add(name);
    }

    // fmt carries its own unit, so no unit is appended here.
    interactive(g, p.label,
      [{ value: fmt(p.value), label: pctLabel(pct), color: p.color }]);
    x += raw;
  });
  return svg;
}

/** Redraw on container resize, debounced. */
export function onResize(fn) {
  let t = null;
  const run = () => { clearTimeout(t); t = setTimeout(fn, 120); };
  window.addEventListener("resize", run);
  return run;
}
