/* ===========================================================================
   Minimal hand-rolled SVG charts. No chart library, no CDN — the app has to run
   offline behind a store network.

   Conventions held across every chart here:
   · thin marks, 2px strokes, 4px rounded data-ends anchored to the baseline
   · a 2px surface-coloured gap between adjacent fills so segments read apart
   · recessive grid/axes, ink-coloured text (never the series colour)
   · a hover tooltip on every plotted mark
   · charts re-render at their true pixel width, so label sizes are honest
   =========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SURFACE = '#ffffff';
const INK = '#231f20';
const INK_2 = '#55504f';
const MUTED = '#7c7573';
const GRID = '#e6e3df';
const AXIS = '#c8c3bf';

let tooltipEl = null;

function tooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'chart-tooltip';
    tooltipEl.setAttribute('role', 'presentation');
    document.body.append(tooltipEl);
  }
  return tooltipEl;
}

function showTip(html, event) {
  const tip = tooltip();
  tip.innerHTML = html;
  tip.classList.add('is-visible');
  const pad = 12;
  const rect = tip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

function hideTip() {
  if (tooltipEl) tooltipEl.classList.remove('is-visible');
}

function attachTip(node, html) {
  node.addEventListener('pointerenter', (e) => showTip(html, e));
  node.addEventListener('pointermove', (e) => showTip(html, e));
  node.addEventListener('pointerleave', hideTip);
  // Touch: a tap shows the tooltip, tapping elsewhere dismisses it.
  node.addEventListener('click', (e) => showTip(html, e));
}

document.addEventListener('scroll', hideTip, true);
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('svg.chart')) hideTip();
});

/* ------------------------------------------------------------------------ */

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  return node;
}

function text(str, attrs = {}) {
  const node = svgEl('text', attrs);
  node.textContent = str;
  return node;
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Mount a chart that redraws whenever its container changes width, so text is
 * always rendered at its true size rather than scaled by a viewBox.
 */
export function mountChart(container, render) {
  let lastWidth = 0;
  const draw = () => {
    const width = Math.round(container.clientWidth);
    if (!width) return;
    lastWidth = width;
    const svg = render(width);
    svg.classList.add('chart');
    container.replaceChildren(svg);
  };
  if (container._chartObserver) container._chartObserver.disconnect();
  const observer = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - lastWidth) > 2) draw();
  });
  observer.observe(container);
  container._chartObserver = observer;
  draw();
  return { redraw: draw };
}

/* ==========================================================================
   Donut — a part-to-whole share with a hero figure in the hole.
   ========================================================================== */

export function donutChart(width, { segments, centerValue, centerLabel }) {
  const size = Math.min(width, 260);
  const height = size;
  const cx = width / 2;
  const cy = height / 2;
  const outer = size / 2 - 4;
  const inner = outer * 0.62;

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  if (!total) {
    svg.append(svgEl('circle', { cx, cy, r: (outer + inner) / 2, fill: 'none', stroke: GRID, 'stroke-width': outer - inner }));
    svg.append(text('No data', { x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': 13, fill: MUTED }));
    return svg;
  }

  // A 2px gap in the surface colour between adjacent arcs.
  const gapRad = total > 1 ? 2 / ((outer + inner) / 2) : 0;
  let angle = -Math.PI / 2;

  for (const seg of segments) {
    if (!seg.value) continue;
    const sweep = (seg.value / total) * Math.PI * 2;
    const a0 = angle + (segments.filter((s) => s.value).length > 1 ? gapRad / 2 : 0);
    const a1 = angle + sweep - (segments.filter((s) => s.value).length > 1 ? gapRad / 2 : 0);
    const path = svgEl('path', {
      d: annulusPath(cx, cy, inner, outer, a0, Math.max(a0 + 0.0001, a1)),
      fill: seg.color,
      stroke: SURFACE,
      'stroke-width': 1,
      class: 'mark',
    });
    if (seg.dashed) {
      path.setAttribute('stroke', seg.ink ?? INK);
      path.setAttribute('stroke-width', 1);
      path.setAttribute('stroke-dasharray', '3 3');
    }
    const pct = Math.round((seg.value / total) * 100);
    attachTip(path, `<b>${esc(seg.label)}</b><br>${seg.value} of ${total} · ${pct}%`);
    svg.append(path);
    angle += sweep;
  }

  svg.append(text(centerValue, {
    x: cx, y: cy + 2, 'text-anchor': 'middle', 'font-size': 26, 'font-weight': 700,
    fill: INK, 'letter-spacing': '-0.02em',
  }));
  svg.append(text(centerLabel, { x: cx, y: cy + 20, 'text-anchor': 'middle', 'font-size': 11, fill: MUTED }));

  const title = svgEl('title');
  title.textContent = segments.map((s) => `${s.label}: ${s.value}`).join(', ');
  svg.append(title);
  return svg;
}

function annulusPath(cx, cy, r0, r1, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(r1, a0);
  const [x1, y1] = p(r1, a1);
  const [x2, y2] = p(r0, a1);
  const [x3, y3] = p(r0, a0);
  // A full circle can't be expressed as one arc — nudge the end back a hair.
  return `M${x0} ${y0} A${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`;
}

/* ==========================================================================
   Horizontal 100%-stacked bars — outcome mix per check.
   ========================================================================== */

export function stackedBarChart(width, { rows, series, labelWidth = 108 }) {
  const rowH = 26;
  const gap = 12;
  const top = 6;
  const bottom = 4;
  const height = top + rows.length * (rowH + gap) - gap + bottom;
  const plotX = Math.min(labelWidth, Math.max(72, width * 0.32));
  const plotW = Math.max(40, width - plotX - 46);

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

  rows.forEach((row, i) => {
    const y = top + i * (rowH + gap);
    const total = series.reduce((sum, s) => sum + (row.values[s.key] ?? 0), 0);

    svg.append(text(row.label, {
      x: plotX - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end', 'font-size': 12, fill: INK_2,
    }));

    if (!total) {
      svg.append(svgEl('rect', { x: plotX, y, width: plotW, height: rowH, rx: 4, fill: '#eeece9' }));
      return;
    }

    let cursor = plotX;
    series.forEach((s) => {
      const value = row.values[s.key] ?? 0;
      if (!value) return;
      const w = (value / total) * plotW;
      const drawW = Math.max(1, w - 2); // 2px surface gap between segments
      const rect = svgEl('rect', {
        x: cursor, y, width: drawW, height: rowH, rx: 4, fill: s.color, class: 'mark',
      });
      if (s.dashed) {
        rect.setAttribute('stroke', s.ink);
        rect.setAttribute('stroke-width', 1);
        rect.setAttribute('stroke-dasharray', '3 3');
      }
      attachTip(rect, `<b>${esc(row.label)}</b><br>${esc(s.label)}: ${value} of ${total} · ${Math.round((value / total) * 100)}%`);
      svg.append(rect);

      // Direct label inside the segment when it fits — the relief that lets a
      // low-contrast status fill carry a number.
      if (drawW > 22) {
        svg.append(text(String(value), {
          x: cursor + drawW / 2, y: y + rowH / 2 + 4, 'text-anchor': 'middle',
          'font-size': 11, 'font-weight': 700, fill: s.labelInk ?? '#ffffff',
          'pointer-events': 'none',
        }));
      }
      cursor += w;
    });

    svg.append(text(String(total), {
      x: plotX + plotW + 8, y: y + rowH / 2 + 4, 'font-size': 11, fill: MUTED,
      'font-variant-numeric': 'tabular-nums',
    }));
  });

  return svg;
}

/* ==========================================================================
   Line — one series over time, crosshair + tooltip.
   ========================================================================== */

export function lineChart(width, { points, color = '#328d3b', yMax = 100, yLabel = '%', height = 190 }) {
  const padL = 34;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const plotW = Math.max(20, width - padL - padR);
  const plotH = height - padT - padB;

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

  for (const t of [0, 25, 50, 75, 100]) {
    const y = padT + plotH - (t / yMax) * plotH;
    svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: y, y2: y, class: 'grid-line' }));
    svg.append(text(`${t}${yLabel}`, { x: padL - 6, y: y + 4, 'text-anchor': 'end', class: 'tick' }));
  }
  svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: padT + plotH, y2: padT + plotH, class: 'axis-line' }));

  if (!points.length) {
    svg.append(text('No data in range', { x: padL + plotW / 2, y: padT + plotH / 2, 'text-anchor': 'middle', 'font-size': 12, fill: MUTED }));
    return svg;
  }

  const x = (i) => (points.length === 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW);
  const y = (v) => padT + plotH - (Math.max(0, Math.min(yMax, v)) / yMax) * plotH;

  if (points.length > 1) {
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p.value)}`).join(' ');
    svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }

  points.forEach((p, i) => {
    // 2px surface ring keeps overlapping markers legible.
    svg.append(svgEl('circle', { cx: x(i), cy: y(p.value), r: 4.5, fill: color, stroke: SURFACE, 'stroke-width': 2, class: 'mark' }));
    const hit = svgEl('rect', {
      x: x(i) - Math.max(12, plotW / points.length / 2), y: padT,
      width: Math.max(24, plotW / points.length), height: plotH, class: 'hit',
    });
    attachTip(hit, `<b>${esc(p.label)}</b><br>${p.value}${yLabel} · ${esc(p.detail ?? '')}`);
    svg.append(hit);
  });

  // Tick labels anchored to the newest point and stepped backwards, so the
  // right-hand label is always the latest date and nothing collides.
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 62))));
  const ticks = [];
  for (let i = points.length - 1; i >= 0; i -= every) ticks.push(i);
  // Only anchor the left edge if a full step of clearance is left, otherwise the
  // first two labels collide.
  if (!ticks.includes(0) && Math.min(...ticks) >= every) ticks.push(0);

  for (const i of ticks) {
    const p = points[i];
    svg.append(text(p.shortLabel ?? p.label, {
      x: x(i), y: height - 8, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle',
      class: 'tick',
    }));
  }

  return svg;
}

/* ==========================================================================
   Column chart — one measure across a small set of categories.
   ========================================================================== */

export function columnChart(width, { bars, color = '#328d3b', height = 200, valueSuffix = '', labelHeight }) {
  const padL = 30;
  const padR = 10;
  const padT = 14;
  // Category labels wrap; long ones need more room under the axis or they clip.
  const longest = bars.reduce((max, b) => Math.max(max, String(b.label).length), 0);
  const padB = labelHeight ?? (longest > 18 ? 56 : longest > 10 ? 46 : 40);
  const plotW = Math.max(20, width - padL - padR);
  const plotH = height - padT - padB;

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

  if (!bars.length) {
    svg.append(text('No data in range', { x: width / 2, y: height / 2, 'text-anchor': 'middle', 'font-size': 12, fill: MUTED }));
    return svg;
  }

  const max = Math.max(1, ...bars.map((b) => b.value));
  const step = plotW / bars.length;
  const barW = Math.min(46, Math.max(10, step - 14));

  for (const frac of [0, 0.5, 1]) {
    const yy = padT + plotH - frac * plotH;
    svg.append(svgEl('line', { x1: padL, x2: padL + plotW, y1: yy, y2: yy, class: frac === 0 ? 'axis-line' : 'grid-line' }));
    svg.append(text(String(Math.round(max * frac)), { x: padL - 6, y: yy + 4, 'text-anchor': 'end', class: 'tick' }));
  }

  bars.forEach((b, i) => {
    const h = (b.value / max) * plotH;
    const x = padL + i * step + (step - barW) / 2;
    const y = padT + plotH - h;
    // rx 4 rounds the data end; the rect still sits on the baseline.
    const rect = svgEl('rect', { x, y, width: barW, height: Math.max(2, h), rx: 4, fill: b.color ?? color, class: 'mark' });
    attachTip(rect, `<b>${esc(b.label)}</b><br>${b.value}${valueSuffix}${b.detail ? `<br>${esc(b.detail)}` : ''}`);
    svg.append(rect);

    if (b.value > 0) {
      svg.append(text(`${b.value}${valueSuffix}`, {
        x: x + barW / 2, y: y - 5, 'text-anchor': 'middle', class: 'value-label', 'pointer-events': 'none',
      }));
    }

    const label = svgEl('foreignObject', { x: padL + i * step, y: padT + plotH + 6, width: step, height: padB - 8 });
    const div = document.createElement('div');
    div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    div.style.cssText = 'font:11px system-ui,-apple-system,sans-serif;color:#7c7573;text-align:center;line-height:1.2;overflow:hidden;';
    div.textContent = b.label;
    label.append(div);
    svg.append(label);
  });

  return svg;
}
