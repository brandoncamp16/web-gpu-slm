// Small dependency-free SVG charts: horizontal bars and a multi-series line chart.
// Every value shown on hover is also available in the tables on the page.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function svgText(x, y, text, attrs = {}) {
  const t = svgEl('text', { x, y, ...attrs });
  t.textContent = text;
  return t;
}

// Clean axis ticks from 0 to a rounded maximum
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

// CSS background for a legend/tooltip key: solid, or striped for textured series
function keyBackground(color, textured, shape) {
  if (!textured) return color;
  return shape === 'line'
    ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`
    : `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)`;
}

// Diagonal hatch fill for textured bars (one pattern per color per chart)
let patternCount = 0;
function hatchFill(svg, defs, cache, color) {
  if (!cache.has(color)) {
    const id = `hatch-${++patternCount}`;
    const pattern = svgEl('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.append(svgEl('rect', { width: 6, height: 6, fill: color, 'fill-opacity': 0.3 }));
    pattern.append(svgEl('rect', { width: 3, height: 6, fill: color }));
    defs.append(pattern);
    cache.set(color, `url(#${id})`);
  }
  return cache.get(color);
}

const compact = (v) => (Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}K` : `${+v.toFixed(1)}`);

function legend(items) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-legend';
  for (const item of items) {
    const entry = document.createElement('span');
    entry.className = 'legend-item';
    const key = document.createElement('span');
    key.className = item.shape === 'line' ? 'legend-line' : 'legend-swatch';
    key.style.background = keyBackground(item.color, item.textured, item.shape);
    key.setAttribute('aria-hidden', 'true');
    entry.append(key, document.createTextNode(item.name));
    wrap.append(entry);
  }
  return wrap;
}

// Tooltip rows lead with the value; the series name follows with a short line key
function tooltipContent(tooltip, title, rows) {
  tooltip.replaceChildren();
  if (title) {
    const head = document.createElement('div');
    head.className = 'tt-title';
    head.textContent = title;
    tooltip.append(head);
  }
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'legend-line';
    key.style.background = keyBackground(row.color, row.textured, 'line');
    const value = document.createElement('strong');
    value.textContent = row.value;
    const name = document.createElement('span');
    name.className = 'tt-name';
    name.textContent = row.name;
    line.append(key, value, name);
    tooltip.append(line);
  }
}

function placeTooltip(tooltip, frame, x, y) {
  tooltip.hidden = false;
  const maxX = frame.clientWidth - tooltip.offsetWidth - 4;
  tooltip.style.left = `${Math.max(4, Math.min(x + 12, maxX))}px`;
  tooltip.style.top = `${Math.max(0, y - tooltip.offsetHeight - 8)}px`;
}

// Re-render a chart when its container changes width
function responsive(container, draw) {
  container._draw = draw;
  draw();
  if (!container._observer) {
    let lastWidth = container.clientWidth;
    container._observer = new ResizeObserver(() => {
      if (container.clientWidth !== lastWidth) {
        lastWidth = container.clientWidth;
        requestAnimationFrame(() => container._draw());
      }
    });
    container._observer.observe(container);
  }
}

// Width of a label in pixels, measured with the page font
let measureCtx = null;
function textWidth(text, size = 12) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${size}px ${getComputedStyle(document.body).fontFamily}`;
  return measureCtx.measureText(text).width;
}

function emptyState(container, message) {
  const p = document.createElement('p');
  p.className = 'chart-empty';
  p.textContent = message;
  container.replaceChildren(p);
}

/**
 * Horizontal bar chart.
 * groups: [{ label, bars: [{ name, color, value }] }]
 * legendItems: [{ name, color }] (omit for a single series)
 */
export function barChart(container, { groups, legendItems, format, ariaLabel, emptyMessage = 'No data yet.' }) {
  const hasData = groups.some((g) => g.bars.some((b) => b.value != null));
  if (!hasData) return emptyState(container, emptyMessage);

  responsive(container, () => {
    const width = Math.max(container.clientWidth, 280);
    // Category labels sit beside the bars when they fit, otherwise above them
    const sideW = Math.max(...groups.map((g) => textWidth(g.label))) + 14;
    const labelsAbove = sideW > width * 0.38;
    const labelW = labelsAbove ? 4 : sideW;
    const labelRow = labelsAbove ? 18 : 0;
    const valuePad = 76;
    const barH = 14;
    const gap = 2; // surface gap between touching bars
    const groupGap = 16;
    const axisH = 22;
    const plotW = width - labelW - valuePad;

    const groupHeights = groups.map((g) => g.bars.length * barH + (g.bars.length - 1) * gap);
    const height = groupHeights.reduce((a, b) => a + b, 0) + (groupGap + labelRow) * groups.length - groupGap + axisH + 4;
    const max = Math.max(...groups.flatMap((g) => g.bars.map((b) => b.value ?? 0)));
    const ticks = niceTicks(max);
    const scale = (v) => (v / ticks[ticks.length - 1]) * plotW;

    const frame = document.createElement('div');
    frame.className = 'chart-frame';
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': ariaLabel });
    const defs = svgEl('defs');
    svg.append(defs);
    const patterns = new Map();
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.hidden = true;

    const plotBottom = height - axisH;
    for (const t of ticks) {
      const x = labelW + scale(t);
      svg.append(svgEl('line', { x1: x, x2: x, y1: 0, y2: plotBottom, class: 'grid' }));
      svg.append(svgText(x, plotBottom + 15, compact(t), { class: 'axis-label', 'text-anchor': t === 0 && labelsAbove ? 'start' : 'middle' }));
    }

    let y = 0;
    groups.forEach((group, gi) => {
      if (labelsAbove) {
        svg.append(svgText(labelW, y + 12, group.label, { class: 'cat-label', 'text-anchor': 'start' }));
        y += labelRow;
      }
      const groupTop = y;
      if (!labelsAbove) {
        svg.append(svgText(labelW - 10, groupTop + groupHeights[gi] / 2 + 4, group.label, { class: 'cat-label', 'text-anchor': 'end' }));
      }
      for (const bar of group.bars) {
        const g = svgEl('g', {
          class: 'bar',
          tabindex: '0',
          role: 'img',
          'aria-label': `${group.label}, ${bar.name}: ${bar.value != null ? format(bar.value) : 'no data'}`,
        });
        // Hit area is the whole row, bigger than the painted bar
        g.append(svgEl('rect', { x: labelW, y: y - 1, width: plotW + valuePad, height: barH + 2, fill: 'transparent' }));
        if (bar.value != null) {
          const w = Math.max(scale(bar.value), 1);
          const r = Math.min(4, w, barH / 2);
          // Rounded data end, square at the baseline
          const d = `M${labelW},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-(w - r)} z`;
          g.append(svgEl('path', { d, fill: bar.textured ? hatchFill(svg, defs, patterns, bar.color) : bar.color, class: 'bar-mark' }));
          g.append(svgText(labelW + w + 6, y + barH - 3, `${bar.prefix ? `${bar.prefix} ` : ''}${format(bar.value)}`, { class: 'value-label' }));
        } else {
          g.append(svgText(labelW + 6, y + barH - 3, 'no data', { class: 'axis-label' }));
        }
        const show = (px, py) => {
          tooltipContent(tooltip, group.label, [{ name: bar.name, color: bar.color, textured: bar.textured, value: bar.value != null ? format(bar.value) : 'no data' }]);
          placeTooltip(tooltip, frame, px, py);
          g.classList.add('active');
        };
        const hide = () => {
          tooltip.hidden = true;
          g.classList.remove('active');
        };
        const barTop = y;
        g.addEventListener('pointermove', (e) => {
          const box = frame.getBoundingClientRect();
          show(e.clientX - box.left, e.clientY - box.top);
        });
        g.addEventListener('pointerdown', (e) => {
          const box = frame.getBoundingClientRect();
          show(e.clientX - box.left, e.clientY - box.top);
        });
        g.addEventListener('pointerleave', hide);
        g.addEventListener('focus', () => show(labelW + (bar.value != null ? scale(bar.value) : 0), barTop));
        g.addEventListener('blur', hide);
        svg.append(g);
        y += barH + gap;
      }
      y = groupTop + groupHeights[gi] + groupGap;
    });

    frame.append(svg, tooltip);
    const children = [];
    if (legendItems?.length > 1) children.push(legend(legendItems));
    children.push(frame);
    container.replaceChildren(...children);
  });
}

/**
 * Multi-series line chart over run order.
 * xLabels: label per x position (e.g. run time)
 * series: [{ name, color, values: [number|null per x] }]
 */
export function lineChart(container, { xLabels, series, format, ariaLabel, emptyMessage = 'No data yet.' }) {
  const n = xLabels.length;
  const hasData = series.some((s) => s.values.some((v) => v != null));
  if (!hasData) return emptyState(container, emptyMessage);

  responsive(container, () => {
    const width = Math.max(container.clientWidth, 280);
    const height = 240;
    const pad = { l: 48, r: 16, t: 10, b: 26 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const max = Math.max(...series.flatMap((s) => s.values.filter((v) => v != null)));
    const ticks = niceTicks(max);
    const xAt = (i) => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v) => pad.t + plotH - (v / ticks[ticks.length - 1]) * plotH;

    const frame = document.createElement('div');
    frame.className = 'chart-frame';
    const svg = svgEl('svg', {
      width, height, viewBox: `0 0 ${width} ${height}`, tabindex: '0', role: 'img',
      'aria-label': `${ariaLabel}. Use the left and right arrow keys to step through runs.`,
    });
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.hidden = true;

    for (const t of ticks) {
      const y = yAt(t);
      svg.append(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: y, y2: y, class: 'grid' }));
      svg.append(svgText(pad.l - 8, y + 4, compact(t), { class: 'axis-label', 'text-anchor': 'end' }));
    }
    svg.append(svgText(pad.l, height - 6, 'Run 1', { class: 'axis-label', 'text-anchor': 'start' }));
    if (n > 1) svg.append(svgText(width - pad.r, height - 6, `Run ${n}`, { class: 'axis-label', 'text-anchor': 'end' }));

    const crosshair = svgEl('line', { y1: pad.t, y2: pad.t + plotH, class: 'crosshair', visibility: 'hidden' });
    svg.append(crosshair);

    for (const s of series) {
      // Connect this series' own points in run order, skipping runs it wasn't part of
      let d = '';
      s.values.forEach((v, i) => {
        if (v != null) d += `${d ? 'L' : 'M'}${xAt(i)},${yAt(v)}`;
      });
      svg.append(svgEl('path', { d, class: 'series-line', stroke: s.color, ...(s.textured ? { 'stroke-dasharray': '6 4' } : {}) }));
      if (n <= 60) {
        s.values.forEach((v, i) => {
          if (v != null) svg.append(svgEl('circle', { cx: xAt(i), cy: yAt(v), r: 4, fill: s.color, class: 'series-dot' }));
        });
      }
    }

    let active = -1;
    const showAt = (i) => {
      active = i;
      const x = xAt(i);
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('visibility', 'visible');
      const rows = series
        .filter((s) => s.values[i] != null)
        .map((s) => ({ name: s.name, color: s.color, textured: s.textured, value: format(s.values[i]) }));
      tooltipContent(tooltip, `Run ${i + 1} · ${xLabels[i]}`, rows.length ? rows : [{ name: '', color: 'transparent', value: 'no data' }]);
      placeTooltip(tooltip, frame, x, pad.t + 40);
    };
    const hide = () => {
      crosshair.setAttribute('visibility', 'hidden');
      tooltip.hidden = true;
    };

    // Transparent overlay: the pointer only has to be nearest an x position
    const overlay = svgEl('rect', { x: pad.l - 8, y: pad.t, width: plotW + 16, height: plotH, fill: 'transparent' });
    const nearest = (e) => {
      const box = svg.getBoundingClientRect();
      const px = e.clientX - box.left;
      const i = n === 1 ? 0 : Math.round(((px - pad.l) / plotW) * (n - 1));
      showAt(Math.max(0, Math.min(n - 1, i)));
    };
    overlay.addEventListener('pointermove', nearest);
    overlay.addEventListener('pointerdown', nearest); // taps on touch screens
    overlay.addEventListener('pointerleave', hide);
    svg.append(overlay);

    svg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = active < 0 ? n - 1 : active + (e.key === 'ArrowRight' ? 1 : -1);
      showAt(Math.max(0, Math.min(n - 1, next)));
    });
    svg.addEventListener('blur', hide);

    frame.append(svg, tooltip);
    // A single series needs no legend: the chart title names it
    container.replaceChildren(
      ...(series.length > 1 ? [legend(series.map((s) => ({ name: s.name, color: s.color, textured: s.textured, shape: 'line' })))] : []),
      frame,
    );
  });
}
