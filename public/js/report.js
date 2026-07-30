/* Power BI–style compliance report, computed live from stored evaluations. */
import {
  api,
  CHECK_NAMES,
  CHECK_SHORT,
  dayKey,
  el,
  formatDateTime,
  statusChip,
  STATUS,
} from './shared.js';
import { columnChart, donutChart, lineChart, mountChart, stackedBarChart } from './charts.js';

/* Status is the only colour dimension on this page; it is reserved and never
   reused as a series colour. `labelInk` is the ink used for the direct label
   printed inside each fill. */
const SERIES = [
  { key: 'pass', label: 'Pass', color: STATUS.pass.color, labelInk: '#ffffff' },
  { key: 'fail', label: 'Fail', color: STATUS.fail.color, labelInk: '#ffffff' },
  { key: 'uncertain', label: 'Uncertain', color: STATUS.uncertain.color, ink: STATUS.uncertain.ink, labelInk: '#5d3d00', dashed: true },
];

const dom = {
  subtitle: document.getElementById('report-subtitle'),
  kpiRow: document.getElementById('kpi-row'),
  callout: document.getElementById('quality-callout'),
  detailTable: document.getElementById('detail-table'),
  detailCount: document.getElementById('detail-count'),
  storeNote: document.getElementById('store-note'),
  catalogRow: document.getElementById('catalog-row'),
  catalogHint: document.getElementById('catalog-hint'),
  productsNote: document.getElementById('products-note'),
  unlistedList: document.getElementById('unlisted-list'),
  productSlicer: document.getElementById('slicer-product'),
  slicers: {
    range: document.getElementById('s-range'),
    store: document.getElementById('s-store'),
    section: document.getElementById('s-section'),
    merch: document.getElementById('s-merch'),
    status: document.getElementById('s-status'),
    quality: document.getElementById('s-quality'),
    product: document.getElementById('s-product'),
  },
};

let allRows = [];
let catalogInfo = null;

init();

async function init() {
  for (const select of Object.values(dom.slicers)) select.addEventListener('change', render);
  document.getElementById('refresh-btn').addEventListener('click', load);
  document.getElementById('print-btn').addEventListener('click', () => window.print());
  document.getElementById('csv-btn').addEventListener('click', exportCsv);
  document.getElementById('reset-btn').addEventListener('click', () => {
    dom.slicers.range.value = 'all';
    for (const key of ['store', 'section', 'merch', 'status', 'quality']) dom.slicers[key].value = '';
    render();
  });
  for (const btn of document.querySelectorAll('.toggle-table')) {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.table);
      target.hidden = !target.hidden;
      btn.textContent = target.hidden ? 'Show data table' : 'Hide data table';
    });
  }
  await load();
}

async function load() {
  try {
    allRows = await api('/api/results');
  } catch (err) {
    dom.subtitle.textContent = `Could not load data: ${err.message}`;
    allRows = [];
  }
  try {
    catalogInfo = (await api('/api/health'))?.catalog ?? null;
  } catch {
    catalogInfo = null;
  }
  // The catalog visuals only exist when there is a catalog to visualise.
  const hasCatalog = Boolean(catalogInfo) || allRows.some((r) => r.identified_products?.length);
  dom.catalogRow.hidden = !hasCatalog;
  dom.productSlicer.hidden = !hasCatalog;
  if (catalogInfo) dom.catalogHint.textContent = `${catalogInfo.productCount} products · ${catalogInfo.source}`;

  populateSlicers();
  render();
}

function populateSlicers() {
  fillSelect(dom.slicers.store, unique(allRows.map((r) => r.store)));
  fillSelect(dom.slicers.section, unique(allRows.map((r) => r.section)));
  fillSelect(dom.slicers.merch, unique(allRows.map((r) => r.merchandiser)));
  fillSelect(dom.slicers.product, unique(allRows.flatMap((r) => (r.identified_products ?? []).map((p) => p.name))));
}

function fillSelect(select, values) {
  const current = select.value;
  const first = select.querySelector('option');
  select.replaceChildren(first);
  for (const value of values) {
    const option = el('option', null, value);
    option.value = value;
    select.append(option);
  }
  if (values.includes(current)) select.value = current;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/* -------------------------------------------------------------------------
   Filter + aggregate
   ------------------------------------------------------------------------- */

function filtered() {
  const { range, store, section, merch, status, quality, product } = dom.slicers;
  const days = range.value === 'all' ? null : Number(range.value);
  const cutoff = days ? Date.now() - days * 86400000 : null;

  return allRows.filter((r) => {
    if (cutoff && new Date(r.timestamp).getTime() < cutoff) return false;
    if (store.value && r.store !== store.value) return false;
    if (section.value && r.section !== section.value) return false;
    if (merch.value && r.merchandiser !== merch.value) return false;
    if (status.value && r.summary_status !== status.value) return false;
    if (quality.value && r.photo_quality.status !== quality.value) return false;
    if (product.value && !(r.identified_products ?? []).some((p) => p.name === product.value)) return false;
    return true;
  });
}

function tally(rows) {
  const byCheck = new Map(CHECK_NAMES.map((name) => [name, { pass: 0, fail: 0, uncertain: 0 }]));
  const byOutcome = { pass: 0, fail: 0, uncertain: 0 };
  let passes = 0;
  let fails = 0;
  let uncertain = 0;
  let poorPhotos = 0;
  let pricesRead = 0;

  for (const row of rows) {
    byOutcome[row.summary_status] = (byOutcome[row.summary_status] ?? 0) + 1;
    if (row.photo_quality.status === 'poor') poorPhotos++;
    for (const check of row.checks) {
      const bucket = byCheck.get(check.name);
      if (bucket) bucket[check.status]++;
      if (check.status === 'pass') passes++;
      else if (check.status === 'fail') fails++;
      else uncertain++;
      if (check.name === 'Price OCR' && check.detected_price) pricesRead++;
    }
  }

  const graded = passes + fails;
  return {
    rows,
    byCheck,
    byOutcome,
    passes,
    fails,
    uncertain,
    poorPhotos,
    pricesRead,
    graded,
    score: graded ? Math.round((passes / graded) * 100) : null,
  };
}

/* -------------------------------------------------------------------------
   Render
   ------------------------------------------------------------------------- */

function render() {
  const rows = filtered();
  const agg = tally(rows);

  dom.subtitle.textContent = allRows.length
    ? `${rows.length} of ${allRows.length} evaluations in view · latest ${formatDateTime(allRows[0].timestamp)}`
    : 'No evaluations stored yet — run one from the Evaluate page.';

  renderCallout(agg);
  renderKpis(agg);
  renderTrend(rows);
  renderDonut(agg);
  renderChecks(agg);
  renderStores(rows);
  if (!dom.catalogRow.hidden) renderCatalog(rows);
  renderDetail(rows);
}

function renderCallout(agg) {
  const share = agg.rows.length ? agg.poorPhotos / agg.rows.length : 0;
  if (!agg.poorPhotos) {
    dom.callout.hidden = true;
    return;
  }
  dom.callout.hidden = false;
  const banner = el('div', 'banner banner--warn');
  banner.setAttribute('role', 'status');
  banner.append(el('span', 'banner__icon', '⚠'));
  const body = el('div');
  body.append(
    el('div', 'banner__title', `${agg.poorPhotos} of ${agg.rows.length} photos were graded poor quality (${Math.round(share * 100)}%)`),
    el('div', 'banner__text', 'Checks derived from those photos are lower confidence. Filter to “Good photos only” to see the figures the model was confident about.'),
  );
  banner.append(body);
  dom.callout.replaceChildren(banner);
}

function renderKpis(agg) {
  const total = agg.rows.length;
  const failing = agg.byOutcome.fail ?? 0;
  const emptyBins = agg.byCheck.get('Empty Bins')?.fail ?? 0;
  const priceRate = total ? Math.round((agg.pricesRead / total) * 100) : 0;
  const qualityRate = total ? Math.round(((total - agg.poorPhotos) / total) * 100) : 0;

  const tiles = [
    { cls: 'kpi--accent', label: 'Photos evaluated', value: String(total), foot: total ? 'in current filter' : 'no data in filter' },
    {
      cls: 'kpi--pass',
      label: 'Execution score',
      value: agg.score === null ? '—' : `${agg.score}%`,
      foot: `${agg.passes} pass / ${agg.fails} fail of ${agg.graded} graded`,
    },
    { cls: 'kpi--fail', label: 'Shelves with a failure', value: String(failing), foot: total ? `${Math.round((failing / total) * 100)}% of photos` : '—' },
    { cls: 'kpi--fail', label: 'Bins flagged empty', value: String(emptyBins), foot: 'Empty Bins check failed' },
    { cls: 'kpi--uncertain', label: 'Uncertain results', value: String(agg.uncertain), foot: 'model declined to call it' },
    { cls: 'kpi--accent', label: 'Price read rate', value: `${priceRate}%`, foot: `${agg.pricesRead} of ${total} tags legible` },
    { cls: 'kpi--uncertain', label: 'Usable photos', value: `${qualityRate}%`, foot: `${agg.poorPhotos} graded poor` },
  ];

  if (!dom.catalogRow.hidden) {
    const distinct = new Set(agg.rows.flatMap((r) => (r.identified_products ?? []).map((p) => p.name)));
    const unlistedCount = agg.rows.reduce((sum, r) => sum + (r.unlisted_products?.length ?? 0), 0);
    tiles.push(
      {
        cls: 'kpi--accent',
        label: 'Catalog SKUs seen',
        value: String(distinct.size),
        foot: catalogInfo ? `of ${catalogInfo.productCount} in the catalog` : 'distinct products identified',
      },
      {
        cls: 'kpi--uncertain',
        label: 'Unlisted sightings',
        value: String(unlistedCount),
        foot: 'products not in the catalog',
      },
    );
  }

  dom.kpiRow.replaceChildren(...tiles.map((t) => {
    const tile = el('div', `kpi ${t.cls}`);
    tile.append(el('div', 'kpi__label', t.label), el('div', 'kpi__value', t.value), el('div', 'kpi__foot', t.foot));
    return tile;
  }));
}

function renderTrend(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const key = dayKey(row.timestamp);
    if (!byDay.has(key)) byDay.set(key, { pass: 0, fail: 0, photos: 0 });
    const bucket = byDay.get(key);
    bucket.photos++;
    for (const check of row.checks) {
      if (check.status === 'pass') bucket.pass++;
      else if (check.status === 'fail') bucket.fail++;
    }
  }

  const points = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, b]) => {
      const graded = b.pass + b.fail;
      const date = new Date(`${key}T00:00:00`);
      return {
        label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        shortLabel: date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
        value: graded ? Math.round((b.pass / graded) * 100) : 0,
        detail: `${b.photos} photo${b.photos === 1 ? '' : 's'} · ${graded} graded checks`,
      };
    });

  mountChart(document.getElementById('chart-trend'), (w) => lineChart(w, {
    points,
    height: Math.max(200, Math.min(300, Math.round(w * 0.5))),
  }));
}

function renderDonut(agg) {
  const segments = SERIES.map((s) => ({
    label: `${s.label} shelves`,
    value: agg.byOutcome[s.key] ?? 0,
    color: s.color,
    ink: s.ink,
    dashed: s.dashed,
  }));
  const total = agg.rows.length;
  const passShare = total ? Math.round(((agg.byOutcome.pass ?? 0) / total) * 100) : 0;

  mountChart(document.getElementById('chart-donut'), (w) => donutChart(w, {
    segments,
    centerValue: total ? `${passShare}%` : '—',
    centerLabel: 'clean shelves',
  }));

  renderLegend(document.getElementById('legend-donut'), segments.map((s, i) => ({
    label: `${SERIES[i].label} · ${s.value}`,
    color: s.color,
    dashed: s.dashed,
  })));

  renderTable(document.getElementById('table-donut'), ['Outcome', 'Photos', 'Share'],
    SERIES.map((s) => {
      const value = agg.byOutcome[s.key] ?? 0;
      return [s.label, String(value), total ? `${Math.round((value / total) * 100)}%` : '—'];
    }));
}

function renderChecks(agg) {
  const rows = CHECK_NAMES.map((name) => ({
    label: CHECK_SHORT[name],
    values: agg.byCheck.get(name) ?? { pass: 0, fail: 0, uncertain: 0 },
  }));

  renderLegend(document.getElementById('legend-checks'), SERIES.map((s) => ({
    label: s.label, color: s.color, dashed: s.dashed,
  })));

  mountChart(document.getElementById('chart-checks'), (w) => stackedBarChart(w, { rows, series: SERIES }));

  renderTable(document.getElementById('table-checks'), ['Check', 'Pass', 'Fail', 'Uncertain'],
    CHECK_NAMES.map((name) => {
      const b = agg.byCheck.get(name);
      return [name, String(b.pass), String(b.fail), String(b.uncertain)];
    }));
}

function renderStores(rows) {
  const byStore = new Map();
  for (const row of rows) {
    if (!byStore.has(row.store)) byStore.set(row.store, { fails: 0, photos: 0 });
    const bucket = byStore.get(row.store);
    bucket.photos++;
    bucket.fails += row.checks.filter((c) => c.status === 'fail').length;
  }

  const sorted = [...byStore.entries()].sort((a, b) => b[1].fails - a[1].fails);
  const shown = sorted.slice(0, 8);
  const bars = shown.map(([store, b]) => ({
    label: store,
    value: b.fails,
    detail: `${b.photos} photo${b.photos === 1 ? '' : 's'} evaluated`,
    color: STATUS.fail.color,
  }));

  mountChart(document.getElementById('chart-store'), (w) => columnChart(w, { bars, height: 220 }));

  dom.storeNote.textContent = sorted.length > shown.length
    ? `Showing the 8 stores with the most failures; ${sorted.length - shown.length} more not shown.`
    : 'Tag a store on the Evaluate page to break this down further.';
}

function renderCatalog(rows) {
  // How often each catalog product was positively identified, and what turned up
  // that the catalog doesn't know about.
  const sightings = new Map();
  const unlisted = new Map();

  for (const row of rows) {
    for (const product of row.identified_products ?? []) {
      if (!sightings.has(product.name)) {
        sightings.set(product.name, { count: 0, high: 0, image: product.image, category: product.category });
      }
      const bucket = sightings.get(product.name);
      bucket.count++;
      if (product.confidence === 'high') bucket.high++;
    }
    for (const item of row.unlisted_products ?? []) {
      // Group case-insensitively; "Tulip bunches" and "tulip bunches" are one thing.
      const key = item.trim().toLowerCase();
      const bucket = unlisted.get(key) ?? { label: item.trim(), count: 0 };
      bucket.count++;
      unlisted.set(key, bucket);
    }
  }

  const sorted = [...sightings.entries()].sort((a, b) => b[1].count - a[1].count);
  const shown = sorted.slice(0, 10);
  const bars = shown.map(([name, b]) => ({
    label: name,
    value: b.count,
    detail: `${b.high} identified with high confidence${b.category ? ` · ${b.category}` : ''}`,
  }));

  mountChart(document.getElementById('chart-products'), (w) => columnChart(w, { bars, height: 250 }));

  const identifiedTotal = rows.filter((r) => r.identified_products?.length).length;
  dom.productsNote.textContent = rows.length
    ? `${identifiedTotal} of ${rows.length} photos matched at least one catalog product.` +
      (sorted.length > shown.length ? ` Showing the top ${shown.length} of ${sorted.length}.` : '')
    : 'No photos in the current filter.';

  if (!unlisted.size) {
    const empty = el('div', 'empty-state');
    empty.append(
      el('div', 'empty-state__icon', '✓'),
      el('div', 'empty-state__title', 'Everything seen was in the catalog'),
      el('div', 'small', 'No unlisted products flagged in this filter.'),
    );
    dom.unlistedList.replaceChildren(empty);
    return;
  }

  const list = el('div', 'unlisted-rows');
  for (const { label, count } of [...unlisted.values()].sort((a, b) => b.count - a.count).slice(0, 12)) {
    const row = el('div', 'unlisted-row');
    row.append(el('span', null, label), el('span', 'mono muted', `${count}×`));
    list.append(row);
  }
  dom.unlistedList.replaceChildren(list);
}

function renderLegend(mount, items) {
  mount.replaceChildren(...items.map((item) => {
    const node = el('span', 'chart-legend__item');
    const swatch = el('span', `chart-legend__swatch${item.dashed ? ' chart-legend__swatch--uncertain' : ''}`);
    swatch.style.background = item.color;
    node.append(swatch, document.createTextNode(item.label));
    return node;
  }));
}

function renderTable(mount, headers, bodyRows) {
  const scroll = el('div', 'table-scroll');
  const table = el('table', 'data');
  table.style.minWidth = '0';
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h, i) => {
    const th = el('th', i ? 'num' : null, h);
    if (i) th.style.textAlign = 'right';
    hr.append(th);
  });
  thead.append(hr);
  const tbody = el('tbody');
  for (const row of bodyRows) {
    const tr = el('tr');
    row.forEach((cell, i) => tr.append(el('td', i ? 'num' : null, cell)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  scroll.append(table);
  mount.replaceChildren(scroll);
}

function renderDetail(rows) {
  dom.detailCount.textContent = rows.length === 1 ? '1 row' : `${rows.length} rows`;

  if (!rows.length) {
    const empty = el('div', 'empty-state');
    empty.append(
      el('div', 'empty-state__icon', '📉'),
      el('div', 'empty-state__title', 'Nothing matches these filters'),
      el('div', 'small', 'Widen the date range or reset the slicers.'),
    );
    dom.detailTable.replaceChildren(empty);
    return;
  }

  const table = el('table', 'data');
  const thead = el('thead');
  const hr = el('tr');
  const showProducts = !dom.catalogRow.hidden;
  const headers = ['When', 'Store', 'Section', 'Photo', 'Outcome', ...CHECK_NAMES.map((n) => CHECK_SHORT[n]), 'Price'];
  if (showProducts) headers.push('Catalog match');
  headers.push('Verdict');
  for (const h of headers) hr.append(el('th', null, h));
  thead.append(hr);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    tr.append(el('td', 'mono', formatDateTime(row.timestamp)));
    tr.append(el('td', null, row.store));
    tr.append(el('td', null, row.section));

    const quality = el('td');
    quality.append(statusChip(row.photo_quality.status === 'good' ? 'pass' : 'uncertain',
      row.photo_quality.status === 'good' ? 'Good' : 'Poor'));
    quality.title = row.photo_quality.rationale;
    tr.append(quality);

    const outcome = el('td');
    outcome.append(statusChip(row.summary_status));
    tr.append(outcome);

    for (const name of CHECK_NAMES) {
      const check = row.checks.find((c) => c.name === name);
      const td = el('td');
      const glyph = el('span', null, STATUS[check?.status]?.glyph ?? '–');
      glyph.style.color = STATUS[check?.status]?.ink ?? 'var(--muted)';
      glyph.style.fontWeight = '700';
      glyph.title = `${name}: ${STATUS[check?.status]?.label ?? 'n/a'} — ${check?.rationale ?? ''}`;
      td.append(glyph);
      tr.append(td);
    }

    const priceCheck = row.checks.find((c) => c.name === 'Price OCR');
    const allPrices = priceCheck?.detected_prices ?? [];
    const priceCell = el('td', 'mono', priceCheck?.detected_price ?? '—');
    if (!priceCheck?.detected_price) priceCell.style.color = 'var(--muted)';
    if (allPrices.length > 1) {
      const more = el('div', 'small muted');
      more.textContent = `+${allPrices.length - 1} more`;
      more.title = allPrices.map((p) => `${p.price} — ${p.location ?? 'location not given'}`).join('\n');
      priceCell.append(more);
    }
    tr.append(priceCell);

    if (showProducts) {
      const names = (row.identified_products ?? []).map((p) => p.name);
      const unlistedCount = row.unlisted_products?.length ?? 0;
      const cell = el('td');
      cell.style.minWidth = '170px';
      cell.append(el('span', null, names.length ? names.join(', ') : '—'));
      if (unlistedCount) {
        const flag = el('div', 'small');
        flag.style.color = 'var(--uncertain-ink)';
        flag.style.fontWeight = '600';
        flag.textContent = `+${unlistedCount} not in catalog`;
        flag.title = row.unlisted_products.join('; ');
        cell.append(flag);
      }
      if (!names.length) cell.style.color = 'var(--muted)';
      tr.append(cell);
    }

    const verdict = el('td', null, row.overall_verdict);
    verdict.style.minWidth = '220px';
    tr.append(verdict);

    tbody.append(tr);
  }

  table.append(thead, tbody);
  const scroll = el('div', 'table-scroll');
  scroll.append(table);
  dom.detailTable.replaceChildren(scroll);
}

/* -------------------------------------------------------------------------
   CSV export of exactly what is on screen
   ------------------------------------------------------------------------- */

function exportCsv() {
  const rows = filtered();
  const headers = [
    'timestamp', 'store', 'section', 'merchandiser', 'photo_quality', 'photo_quality_rationale',
    'overall_status',
    ...CHECK_NAMES.flatMap((n) => [`${CHECK_SHORT[n]} status`, `${CHECK_SHORT[n]} rationale`]),
    'detected_price', 'all_detected_prices',
    'identified_products', 'identification_confidence', 'unlisted_products',
    'overall_verdict', 'model',
  ];

  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    const cells = [
      row.timestamp, row.store, row.section, row.merchandiser,
      row.photo_quality.status, row.photo_quality.rationale, row.summary_status,
      ...CHECK_NAMES.flatMap((name) => {
        const check = row.checks.find((c) => c.name === name);
        return [check?.status ?? '', check?.rationale ?? ''];
      }),
      row.checks.find((c) => c.name === 'Price OCR')?.detected_price ?? '',
      (row.checks.find((c) => c.name === 'Price OCR')?.detected_prices ?? [])
        .map((p) => (p.location ? `${p.price} (${p.location})` : p.price)).join('; '),
      (row.identified_products ?? [])
        .map((p) => (p.location ? `${p.name} (${p.location})` : p.name)).join('; '),
      (row.identified_products ?? []).map((p) => `${p.name}=${p.confidence}`).join('; '),
      (row.unlisted_products ?? []).join('; '),
      row.overall_verdict, row.model,
    ];
    lines.push(cells.map(csvCell).join(','));
  }

  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = `shelf-execution-${dayKey(new Date().toISOString())}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}
