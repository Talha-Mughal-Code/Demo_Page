/* Shared helpers used by both the evaluate/history page and the report page. */

export const CHECK_NAMES = [
  'Empty Bins',
  'Wrong Product Under Tag',
  'Mixed Bin / Two SKUs Under One Tag',
  'Price OCR',
  'Tag Presence / Legibility',
];

export const CHECK_SHORT = {
  'Empty Bins': 'Empty Bins',
  'Wrong Product Under Tag': 'Wrong Product',
  'Mixed Bin / Two SKUs Under One Tag': 'Mixed Bin',
  'Price OCR': 'Price OCR',
  'Tag Presence / Legibility': 'Tag Legibility',
};

/**
 * Status presentation. Every status carries a glyph and a word, so colour is
 * never the only channel; `uncertain` also differs in shape (dashed outline)
 * because it means "we don't know", not "it's wrong".
 */
export const STATUS = {
  pass: { label: 'Pass', glyph: '✓', color: '#328d3b', ink: '#205825' },
  fail: { label: 'Fail', glyph: '✕', color: '#d3242c', ink: '#a01a20' },
  uncertain: { label: 'Uncertain', glyph: '?', color: '#fab219', ink: '#7d5200' },
};

export const STATUS_ORDER = ['pass', 'fail', 'uncertain'];

export function statusChip(status, labelOverride) {
  const meta = STATUS[status] ?? { label: status, glyph: '•' };
  const el = document.createElement('span');
  el.className = `chip chip--${STATUS[status] ? status : 'neutral'}`;
  const glyph = document.createElement('span');
  glyph.className = 'chip__glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = meta.glyph;
  el.append(glyph, document.createTextNode(labelOverride ?? meta.label));
  return el;
}

/**
 * Confidence meter. Deliberately NOT colour-coded: the status palette is
 * reserved for pass/fail/uncertain, and a "low confidence" identification is a
 * different axis from a failing check. Filled dots carry the level, the word
 * carries the meaning.
 */
export const CONFIDENCE_DOTS = { high: '●●●', medium: '●●○', low: '●○○' };

export function confidenceChip(level) {
  const chip = document.createElement('span');
  chip.className = 'chip chip--neutral';
  const dots = document.createElement('span');
  dots.className = 'conf-dots';
  dots.setAttribute('aria-hidden', 'true');
  dots.textContent = CONFIDENCE_DOTS[level] ?? '○○○';
  chip.append(dots, document.createTextNode(`${level ?? 'unknown'} confidence`));
  return chip;
}

/* --------------------------------------------------------------------------
   API
   -------------------------------------------------------------------------- */

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    // Never read the API from cache. The server also sends no-store; this is the
    // half of the fix that protects a tab still holding a stale response.
    cache: 'no-store',
    ...options,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);
  return payload;
}

/* --------------------------------------------------------------------------
   Image handling — resize in the browser so we send ~200 KB instead of 6 MB.
   -------------------------------------------------------------------------- */

export async function fileToResizedDataUri(file, maxEdge, quality) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  return { dataUri: canvas.toDataURL('image/jpeg', quality), width: w, height: h };
}

async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    try {
      // `imageOrientation` honours EXIF so in-store portrait shots aren't sideways.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/* --------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */

export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatRelative(iso) {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const secs = Math.round((Date.now() - d) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
