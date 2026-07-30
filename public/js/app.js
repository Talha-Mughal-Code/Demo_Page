/* Evaluate page: pick a photo, run it, show the result. History lives on its
   own page and shares the result renderer. */
import { api, el, fileToResizedDataUri, formatBytes } from './shared.js';
import { renderResult } from './result-view.js';

// Long edge sent to the model. Enough detail to OCR a shelf tag, small enough
// to keep the upload and the vision token bill sane.
const EVAL_MAX_EDGE = 2000;
const EVAL_QUALITY = 0.86;
const THUMB_MAX_EDGE = 320;
const THUMB_QUALITY = 0.7;

const dom = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  cameraInput: document.getElementById('camera-input'),
  cameraBtn: document.getElementById('camera-btn'),
  preview: document.getElementById('preview'),
  previewImg: document.getElementById('preview-img'),
  previewName: document.getElementById('preview-name'),
  previewSize: document.getElementById('preview-size'),
  previewEmpty: document.getElementById('preview-empty'),
  evaluateBtn: document.getElementById('evaluate-btn'),
  evaluateLabel: document.getElementById('evaluate-label'),
  clearBtn: document.getElementById('clear-btn'),
  resultSection: document.getElementById('result-section'),
  resultBody: document.getElementById('result-body'),
  errorBox: document.getElementById('error-box'),
  keyWarning: document.getElementById('key-warning'),
  modelHint: document.getElementById('model-hint'),
  fStore: document.getElementById('f-store'),
  fSection: document.getElementById('f-section'),
  fMerch: document.getElementById('f-merch'),
};

let pending = null; // { dataUri, thumbUri, name, bytes }
let busy = false;

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

init();

async function init() {
  restoreContext();
  wireUpload();
  loadHealth();
}

let healthPoll = null;

async function loadHealth() {
  try {
    const health = await api('/api/health');
    dom.modelHint.textContent = [
      `Model: ${health.model}`,
      '6 checks',
      health.catalog
        ? `catalog: ${health.catalog.productCount} products`
        : 'no catalog imported',
    ].join(' · ');
    dom.keyWarning.hidden = health.apiKeyConfigured;

    // Fixing the key means editing .env and restarting the server — neither of
    // which reloads this page. Without re-checking, an open tab keeps showing a
    // warning that stopped being true minutes ago. Poll only while it's showing.
    if (health.apiKeyConfigured) {
      clearInterval(healthPoll);
      healthPoll = null;
    } else if (!healthPoll) {
      healthPoll = setInterval(loadHealth, 5000);
    }
  } catch {
    dom.modelHint.textContent = 'Backend unreachable';
  }
}

/* Also re-check whenever the user comes back to the tab. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadHealth();
});
window.addEventListener('focus', loadHealth);

/* Remember store/section/merchandiser between shots — a merchandiser working an
   aisle takes many photos in a row. */
function restoreContext() {
  for (const [key, node] of Object.entries({ store: dom.fStore, section: dom.fSection, merch: dom.fMerch })) {
    node.value = localStorage.getItem(`shelf.${key}`) ?? '';
    node.addEventListener('change', () => localStorage.setItem(`shelf.${key}`, node.value));
  }
}

/* -------------------------------------------------------------------------
   Upload interactions
   ------------------------------------------------------------------------- */

function wireUpload() {
  dom.dropzone.addEventListener('click', () => dom.fileInput.click());
  dom.cameraBtn.addEventListener('click', () => dom.cameraInput.click());
  dom.fileInput.addEventListener('change', (e) => acceptFile(e.target.files?.[0]));
  dom.cameraInput.addEventListener('change', (e) => acceptFile(e.target.files?.[0]));

  for (const type of ['dragenter', 'dragover']) {
    dom.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dom.dropzone.classList.add('is-dragging');
    });
  }
  for (const type of ['dragleave', 'dragend', 'drop']) {
    dom.dropzone.addEventListener(type, () => dom.dropzone.classList.remove('is-dragging'));
  }
  dom.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    acceptFile(e.dataTransfer?.files?.[0]);
  });
  // Stop the browser navigating away if a drop lands outside the zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  dom.evaluateBtn.addEventListener('click', runEvaluation);
  dom.clearBtn.addEventListener('click', clearSelection);
}

async function acceptFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showError('That file is not an image. Choose a JPG, PNG, WebP or HEIC photo.');
    return;
  }
  clearError();
  try {
    const [full, thumb] = await Promise.all([
      fileToResizedDataUri(file, EVAL_MAX_EDGE, EVAL_QUALITY),
      fileToResizedDataUri(file, THUMB_MAX_EDGE, THUMB_QUALITY),
    ]);
    pending = {
      dataUri: full.dataUri,
      thumbUri: thumb.dataUri,
      name: file.name,
      bytes: Math.round((full.dataUri.length * 3) / 4),
      dims: `${full.width}×${full.height}`,
    };
    dom.previewImg.src = full.dataUri;
    dom.previewName.textContent = file.name;
    dom.previewSize.textContent = `${pending.dims} · ${formatBytes(pending.bytes)}`;
    dom.preview.hidden = false;
    dom.previewEmpty.hidden = true;
    dom.clearBtn.hidden = false;
    dom.evaluateBtn.disabled = false;
  } catch (err) {
    showError(`Could not read that image: ${err.message}. HEIC photos may need converting to JPG first.`);
  }
  // Allow re-picking the same file.
  dom.fileInput.value = '';
  dom.cameraInput.value = '';
}

function clearSelection() {
  pending = null;
  dom.preview.hidden = true;
  dom.previewEmpty.hidden = false;
  dom.clearBtn.hidden = true;
  dom.evaluateBtn.disabled = true;
  dom.previewImg.removeAttribute('src');
  clearError();
}

/* -------------------------------------------------------------------------
   Evaluation
   ------------------------------------------------------------------------- */

async function runEvaluation() {
  if (!pending || busy) return;
  busy = true;
  clearError();
  setBusy(true);
  renderLoading();

  try {
    const record = await api('/api/evaluate', {
      method: 'POST',
      body: JSON.stringify({
        image: pending.dataUri,
        thumbnail: pending.thumbUri,
        filename: pending.name,
        store: dom.fStore.value,
        section: dom.fSection.value,
        merchandiser: dom.fMerch.value,
      }),
    });
    dom.resultSection.hidden = false;
    renderResult(dom.resultBody, record);
    showHistoryLink();
    loadHealth(); // a successful call proves the key works; clear any stale warning
  } catch (err) {
    dom.resultSection.hidden = true;
    showError(err.message);
  } finally {
    busy = false;
    setBusy(false);
  }
}

/** After a run, point at History rather than listing it inline. */
function showHistoryLink() {
  const bar = document.getElementById('result-actions');
  if (!bar) return;
  bar.hidden = false;
}

function setBusy(state) {
  dom.evaluateBtn.disabled = state || !pending;
  dom.evaluateLabel.textContent = state ? 'Evaluating…' : 'Run evaluation';
  const existing = dom.evaluateBtn.querySelector('.spinner');
  if (state && !existing) dom.evaluateBtn.prepend(el('span', 'spinner'));
  if (!state && existing) existing.remove();
}

function renderLoading() {
  dom.resultSection.hidden = false;
  dom.resultBody.replaceChildren();
  const wrap = el('div');
  const bar = el('div', 'skeleton');
  bar.style.height = '54px';
  bar.style.marginBottom = '10px';
  wrap.append(bar);
  for (let i = 0; i < 5; i++) {
    const row = el('div', 'skeleton');
    row.style.height = '68px';
    row.style.marginBottom = '10px';
    wrap.append(row);
  }
  const note = el('p', 'small muted', 'Sending the photo to the vision model and grading 6 checks…');
  wrap.append(note);
  dom.resultBody.append(wrap);
  dom.resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* -------------------------------------------------------------------------
   Errors
   ------------------------------------------------------------------------- */

function showError(message) {
  dom.errorBox.hidden = false;
  const banner = el('div', 'banner banner--error');
  banner.setAttribute('role', 'alert');
  banner.append(el('span', 'banner__icon', '⚠'));
  const body = el('div');
  body.append(el('div', 'banner__title', 'Evaluation failed'), el('div', 'banner__text', message));
  banner.append(body);
  dom.errorBox.replaceChildren(banner);
}

function clearError() {
  dom.errorBox.hidden = true;
  dom.errorBox.replaceChildren();
}
