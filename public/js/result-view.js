/**
 * Renders one evaluation record.
 *
 * Shared by the Evaluate page (which shows the result it just produced) and the
 * History page (which shows a stored one), so a past evaluation looks exactly
 * like a fresh one — same banner, same cards, same catalog panel.
 */
import { confidenceChip, el, formatDateTime, statusChip, STATUS } from './shared.js';

/**
 * @param {HTMLElement} mount - container to render into (replaced wholesale)
 * @param {object} record - an evaluation record from the API
 */
export function renderResult(mount, record) {
  const frag = document.createDocumentFragment();

  frag.append(photoQualityBanner(record.photo_quality));
  frag.append(resultHead(record));

  const checks = el('div', 'checks');
  for (const check of record.checks) checks.append(checkCard(check));
  frag.append(checks);

  const catalogSection = catalogPanel(record);
  if (catalogSection) frag.append(catalogSection);

  const verdict = el('div', 'verdict');
  verdict.style.marginTop = '12px';
  verdict.append(
    el('div', 'verdict__label', 'Overall verdict'),
    el('div', 'verdict__text', record.overall_verdict),
  );
  frag.append(verdict);

  mount.replaceChildren(frag);
}

function resultHead(record) {
  const head = el('div', 'result-head');
  head.style.margin = '14px 0 10px';

  const left = el('div');
  left.style.display = 'flex';
  left.style.gap = '12px';
  left.style.alignItems = 'center';

  // The thumbnail travels with the result, so a record opened from History is
  // unambiguously tied to its photo.
  if (record.thumbPath) {
    const thumb = el('img', 'history-item__thumb');
    thumb.src = record.thumbPath;
    thumb.alt = 'The evaluated shelf photo';
    left.append(thumb);
  }

  const heading = el('div');
  heading.append(el('div', 'section-title', 'Checks'));
  heading.append(el('div', 'small muted', [
    record.store !== 'Unassigned' ? record.store : null,
    record.section !== 'Unassigned' ? record.section : null,
    formatDateTime(record.timestamp),
    record.model,
  ].filter(Boolean).join(' · ')));
  left.append(heading);

  head.append(
    left,
    statusChip(record.summary_status, `Overall: ${STATUS[record.summary_status]?.label ?? record.summary_status}`),
  );
  return head;
}

function photoQualityBanner(pq) {
  const poor = pq.status === 'poor';
  const banner = el('div', `banner ${poor ? 'banner--warn' : 'banner--good'}`);
  banner.setAttribute('role', poor ? 'alert' : 'status');
  banner.append(el('span', 'banner__icon', poor ? '⚠' : '✓'));
  const body = el('div');
  body.append(
    el('div', 'banner__title', poor
      ? 'Photo quality is poor — results below may be unreliable'
      : 'Photo quality is good'),
    el('div', 'banner__text', poor
      ? `${pq.rationale} Consider retaking the photo before acting on these results.`
      : pq.rationale),
  );
  banner.append(body);
  return banner;
}

function checkCard(check) {
  const card = el('div', `check check--${check.status}`);
  card.append(el('div', 'check__rail'));

  const body = el('div');
  body.append(el('div', 'check__name', check.name), el('div', 'check__why', check.rationale));

  if (check.name === 'Price OCR') {
    const all = check.detected_prices ?? [];

    const readout = el('div', 'price-readout');
    readout.append(el('span', 'price-readout__label', all.length > 1 ? 'Most prominent' : 'Detected price'));
    readout.append(check.detected_price
      ? el('span', 'price-readout__value', check.detected_price)
      : el('span', 'price-readout__value price-readout__value--none', 'Not legible'));
    body.append(readout);

    // A bay carries many tags. Listing them all with their positions is what
    // makes this actionable — one headline price is not a price audit.
    if (all.length > 1) {
      const wrap = el('div', 'price-list');
      wrap.append(el('div', 'price-list__head', `${all.length} price tags read across the display`));
      const rows = el('div', 'price-list__rows');
      for (const entry of all) {
        const row = el('div', 'price-list__row');
        row.append(el('span', 'price-list__price', entry.price));
        row.append(el('span', 'price-list__where', entry.location ?? 'location not given'));
        rows.append(row);
      }
      wrap.append(rows);
      body.append(wrap);
    }
  }

  card.append(body, statusChip(check.status));
  return card;
}

/**
 * Catalog identifications. Rendered only when the record carries them, so a
 * catalog-free install shows exactly the original five cards and nothing more.
 */
function catalogPanel(record) {
  const identified = record.identified_products ?? [];
  const unlisted = record.unlisted_products ?? [];
  if (!identified.length && !unlisted.length) return null;

  const section = el('div');
  section.style.marginTop = '16px';

  const head = el('div', 'result-head');
  head.style.marginBottom = '8px';
  head.append(el('div', 'section-title', 'Catalog identification'));
  head.append(el('span', 'small muted', `${identified.length} matched · ${unlisted.length} not in catalog`));
  section.append(head);

  if (identified.length) {
    const grid = el('div', 'product-grid');
    for (const product of identified) grid.append(productCard(product));
    section.append(grid);
  }

  if (unlisted.length) {
    const box = el('div', 'unlisted');
    const title = el('div', 'unlisted__title');
    title.append(el('span', null, '⚠'), document.createTextNode(' Seen on the shelf but not in the catalog'));
    box.append(title);
    const list = el('ul', 'unlisted__list');
    for (const item of unlisted) list.append(el('li', null, item));
    box.append(list);
    box.append(el('div', 'small muted', 'Unlisted product is a finding in its own right — it may be unauthorised, mis-tagged, or simply missing from the catalog file.'));
    section.append(box);
  }

  return section;
}

function productCard(product) {
  const card = el('div', 'product-card');

  const figure = el('div', 'product-card__figure');
  if (product.image) {
    const img = el('img');
    img.src = product.image;
    img.alt = `Catalog reference photo for ${product.name}`;
    img.loading = 'lazy';
    figure.append(img);
  } else {
    figure.append(el('span', 'muted small', 'no photo'));
  }
  card.append(figure);

  const body = el('div');
  body.append(el('div', 'product-card__name', product.name));

  if (product.location) {
    const where = el('div', 'product-card__where');
    where.append(el('span', null, '📍'), document.createTextNode(` ${product.location}`));
    body.append(where);
  }

  const meta = [product.sku ? `SKU ${product.sku}` : null, product.category, product.description]
    .filter(Boolean).join(' · ');
  if (meta) body.append(el('div', 'product-card__meta', meta));
  if (product.rationale) body.append(el('div', 'product-card__why', product.rationale));

  const foot = el('div', 'product-card__foot');
  foot.append(confidenceChip(product.confidence));
  if (product.tag_price) {
    const price = el('span', 'product-card__price', product.tag_price);
    price.title = 'Price read from this product’s shelf tag';
    foot.append(price);
  }
  body.append(foot);

  card.append(body);
  return card;
}

/** Five status dots summarising a record, for compact list rows. */
export function flagDots(record) {
  const flags = el('div', 'flag-dots');
  flags.setAttribute('role', 'img');
  flags.setAttribute('aria-label', record.checks.map((c) => `${c.name}: ${c.status}`).join(', '));
  for (const check of record.checks) {
    const dot = el('span', `flag-dot flag-dot--${check.status}`);
    dot.title = `${check.name}: ${STATUS[check.status]?.label ?? check.status}`;
    flags.append(dot);
  }
  return flags;
}
