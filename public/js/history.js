/**
 * History page: a filterable list of every stored evaluation, and a detail view
 * for any one of them.
 *
 * List and detail are two states of one page rather than two pages, so opening a
 * record and going back costs no round trip and keeps the scroll position. The
 * record id lives in the URL hash, so a detail view is linkable and the browser
 * back button does what you'd expect.
 */
import { api, el, formatDateTime, formatRelative, statusChip, STATUS } from './shared.js';
import { renderResult, flagDots } from './result-view.js';

const dom = {
  listView: document.getElementById('list-view'),
  detailView: document.getElementById('detail-view'),
  detailBody: document.getElementById('detail-body'),
  list: document.getElementById('history-list'),
  count: document.getElementById('history-count'),
  errorBox: document.getElementById('error-box'),
  openPhoto: document.getElementById('open-photo'),
  filters: {
    search: document.getElementById('f-search'),
    status: document.getElementById('f-status'),
    quality: document.getElementById('f-quality'),
    sort: document.getElementById('f-sort'),
  },
};

const SEVERITY = { fail: 0, uncertain: 1, pass: 2 };

let records = [];
let current = null;

init();

async function init() {
  document.getElementById('refresh-btn').addEventListener('click', () => load(true));
  document.getElementById('back-btn').addEventListener('click', () => {
    location.hash = '';
  });
  document.getElementById('delete-btn').addEventListener('click', deleteCurrent);
  document.getElementById('reset-btn').addEventListener('click', () => {
    dom.filters.search.value = '';
    dom.filters.status.value = '';
    dom.filters.quality.value = '';
    dom.filters.sort.value = 'newest';
    renderList();
  });

  dom.filters.search.addEventListener('input', renderList);
  for (const key of ['status', 'quality', 'sort']) {
    dom.filters[key].addEventListener('change', renderList);
  }

  window.addEventListener('hashchange', route);
  await load();
}

async function load(announce = false) {
  try {
    records = await api('/api/results');
    clearError();
    if (announce) flash(`Reloaded — ${records.length} evaluation${records.length === 1 ? '' : 's'}.`);
  } catch (err) {
    records = [];
    showError(`Could not load history: ${err.message}`);
  }
  renderList();
  route();
}

/* -------------------------------------------------------------------------
   Routing between list and detail
   ------------------------------------------------------------------------- */

function route() {
  const id = location.hash.replace(/^#/, '');
  if (!id) return showList();

  const record = records.find((r) => r.id === id);
  if (!record) {
    showList();
    if (records.length) showError('That evaluation no longer exists.');
    return;
  }
  showDetail(record);
}

function showList() {
  current = null;
  dom.detailView.hidden = true;
  dom.listView.hidden = false;
}

function showDetail(record) {
  current = record;
  dom.listView.hidden = true;
  dom.detailView.hidden = false;
  dom.openPhoto.href = record.imagePath;
  renderResult(dom.detailBody, record);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

async function deleteCurrent() {
  if (!current) return;
  if (!confirm('Delete this evaluation and its photo?')) return;
  try {
    await api(`/api/results/${current.id}`, { method: 'DELETE' });
    records = records.filter((r) => r.id !== current.id);
    location.hash = '';
    renderList();
    showList();
  } catch (err) {
    showError(err.message);
  }
}

/* -------------------------------------------------------------------------
   List
   ------------------------------------------------------------------------- */

function visible() {
  const term = dom.filters.search.value.trim().toLowerCase();
  const { status, quality, sort } = dom.filters;

  const rows = records.filter((r) => {
    if (status.value && r.summary_status !== status.value) return false;
    if (quality.value && r.photo_quality.status !== quality.value) return false;
    if (!term) return true;
    // Search across everything a person might remember about a photo.
    return [
      r.store, r.section, r.merchandiser, r.filename, r.overall_verdict,
      ...(r.identified_products ?? []).map((p) => p.name),
      ...(r.unlisted_products ?? []),
    ].filter(Boolean).join(' ').toLowerCase().includes(term);
  });

  const sorters = {
    newest: (a, b) => b.timestamp.localeCompare(a.timestamp),
    oldest: (a, b) => a.timestamp.localeCompare(b.timestamp),
    worst: (a, b) => SEVERITY[a.summary_status] - SEVERITY[b.summary_status]
      || b.timestamp.localeCompare(a.timestamp),
    matches: (a, b) => (b.identified_products?.length ?? 0) - (a.identified_products?.length ?? 0)
      || b.timestamp.localeCompare(a.timestamp),
  };
  return rows.sort(sorters[sort.value] ?? sorters.newest);
}

function renderList() {
  const rows = visible();

  dom.count.textContent = records.length
    ? rows.length === records.length
      ? `${records.length} evaluation${records.length === 1 ? '' : 's'}`
      : `${rows.length} of ${records.length} evaluations shown`
    : 'No evaluations yet';

  if (!records.length) {
    dom.list.replaceChildren(emptyState(
      '🗂', 'No evaluations yet',
      'Photos you evaluate will be listed here.',
      { label: 'Evaluate a photo', href: '/index.html' },
    ));
    return;
  }

  if (!rows.length) {
    dom.list.replaceChildren(emptyState('🔍', 'Nothing matches those filters', 'Try clearing the search or the outcome filter.'));
    return;
  }

  dom.list.replaceChildren(...rows.map(listRow));
}

function listRow(record) {
  const row = el('div', 'history-item history-item--link');
  row.tabIndex = 0;
  row.setAttribute('role', 'link');

  const open = () => { location.hash = record.id; };
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    open();
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  const thumb = el('img', 'history-item__thumb');
  thumb.src = record.thumbPath;
  thumb.alt = `Shelf photo evaluated ${formatDateTime(record.timestamp)}`;
  thumb.loading = 'lazy';
  row.append(thumb);

  const mid = el('div');
  mid.append(el('div', 'history-item__title', [
    record.store !== 'Unassigned' ? record.store : null,
    record.section !== 'Unassigned' ? record.section : null,
  ].filter(Boolean).join(' · ') || record.filename));
  mid.append(el('div', 'history-item__verdict', record.overall_verdict));
  mid.append(flagDots(record));

  const meta = el('div', 'history-item__meta');
  meta.append(document.createTextNode(`${formatDateTime(record.timestamp)} · ${formatRelative(record.timestamp)}`));

  const matched = record.identified_products?.length ?? 0;
  const unlisted = record.unlisted_products?.length ?? 0;
  if (matched || unlisted) {
    meta.append(document.createTextNode(` · ${matched} matched`));
    if (unlisted) meta.append(document.createTextNode(`, ${unlisted} unlisted`));
  }
  if (record.photo_quality.status === 'poor') {
    const warn = el('span', null, ' · ⚠ poor photo');
    warn.style.color = 'var(--uncertain-ink)';
    warn.style.fontWeight = '600';
    meta.append(warn);
  }
  mid.append(meta);
  row.append(mid);

  const right = el('div', 'history-item__right');
  right.append(statusChip(record.summary_status));
  const view = el('button', 'btn btn--ghost small', 'View');
  view.type = 'button';
  view.addEventListener('click', open);
  right.append(view);
  row.append(right);

  return row;
}

function emptyState(icon, title, body, action) {
  const box = el('div', 'empty-state');
  box.append(el('div', 'empty-state__icon', icon), el('div', 'empty-state__title', title), el('div', 'small', body));
  if (action) {
    const link = el('a', 'btn btn--primary', action.label);
    link.href = action.href;
    link.style.marginTop = '12px';
    box.append(link);
  }
  return box;
}

/* -------------------------------------------------------------------------
   Messages
   ------------------------------------------------------------------------- */

function banner(kind, title, text) {
  const node = el('div', `banner banner--${kind}`);
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.append(el('span', 'banner__icon', kind === 'error' ? '⚠' : '✓'));
  const body = el('div');
  body.append(el('div', 'banner__title', title));
  if (text) body.append(el('div', 'banner__text', text));
  node.append(body);
  return node;
}

function showError(message) {
  dom.errorBox.hidden = false;
  dom.errorBox.replaceChildren(banner('error', 'Something went wrong', message));
}

function flash(message) {
  dom.errorBox.hidden = false;
  dom.errorBox.replaceChildren(banner('good', message));
  setTimeout(clearError, 2500);
}

function clearError() {
  dom.errorBox.hidden = true;
  dom.errorBox.replaceChildren();
}
