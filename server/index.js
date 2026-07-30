/**
 * Minimal Express backend for the shelf-execution evaluator.
 *
 * The browser talks only to this server. This server is the only place the
 * OpenAI key exists, and it is read from the environment — never from a file
 * that ships to the client, never returned in a response.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';

// Resolve .env from the project root, NOT the working directory. `dotenv/config`
// looks in process.cwd(), so starting the server from a parent folder — which is
// what `node DemoProject/server/index.js` or a VS Code terminal rooted one level
// up does — silently loses the key and reports it as missing.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

import * as store from './store.js';
import * as catalog from './catalog.js';
import { evaluateImage, getModel, hasApiKey, httpError } from './openai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

// Images arrive as base64 data URIs inside a JSON body. The frontend downsizes
// to ~1280px before sending, so this ceiling is generous.
const MAX_BODY = '25mb';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: MAX_BODY }));

// Every /api response reports live state — health, results, the catalog. Express
// attaches an ETag but no Cache-Control, and a browser given a validator with no
// freshness directive is free to reuse the body without revalidating. That is how
// a page kept insisting the API key was missing minutes after it had been fixed.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});

// The page shell must revalidate too, so a restart can never leave an old
// index.html pinning an old bundle. Hashed assets under /uploads and
// /catalog/images keep their long cache below.
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/.test(filePath)) res.set('Cache-Control', 'no-cache');
  },
}));
app.use('/uploads', express.static(store.UPLOADS_DIR, { maxAge: '1h', immutable: true }));
app.use('/catalog/images', express.static(catalog.CATALOG_IMAGES_DIR, { maxAge: '1d' }));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: getModel(),
    apiKeyConfigured: hasApiKey(),
    catalog: catalog.summary(),
    storage: { ephemeral: store.isEphemeral, location: store.describeStorage() },
  });
});

/** The product list, for the report's slicer and the "what can it recognise" view. */
app.get('/api/catalog', (_req, res) => {
  if (!catalog.isLoaded()) throw httpError(404, 'No catalog imported. Run: npm run import:catalog -- "<file.xlsx>"');
  res.json({ ...catalog.summary(), products: catalog.products().map(catalog.publicProduct) });
});

/**
 * POST /api/evaluate
 * body: { image: dataURI, thumbnail?: dataURI, filename?, store?, section?, merchandiser? }
 */
app.post('/api/evaluate', asyncRoute(async (req, res) => {
  const { image, thumbnail, filename, store: storeName, section, merchandiser } = req.body ?? {};

  if (!store.parseDataUri(image)) {
    throw httpError(400, 'Body must include `image` as a base64 image data URI (data:image/...;base64,...).');
  }

  const startedAt = Date.now();
  const { evaluation, model, usage, referenceImagesSent } = await evaluateImage(image);

  const id = store.newId();
  const saved = await store.saveDataUri(image, id);
  const savedThumb = store.parseDataUri(thumbnail)
    ? await store.saveDataUri(thumbnail, `${id}-thumb`)
    : saved;

  const record = {
    id,
    timestamp: new Date().toISOString(),
    filename: sanitiseLabel(filename, 120) || 'photo',
    store: sanitiseLabel(storeName, 60) || 'Unassigned',
    section: sanitiseLabel(section, 60) || 'Unassigned',
    merchandiser: sanitiseLabel(merchandiser, 60) || 'Unassigned',
    model,
    latencyMs: Date.now() - startedAt,
    bytes: saved.bytes,
    imagePath: `/uploads/${saved.filename}`,
    thumbPath: `/uploads/${savedThumb.filename}`,
    photo_quality: evaluation.photo_quality,
    checks: evaluation.checks,
    overall_verdict: evaluation.overall_verdict,
    summary_status: summaryStatus(evaluation),
    identified_products: evaluation.identified_products ?? [],
    unlisted_products: evaluation.unlisted_products ?? [],
    referenceImagesSent: referenceImagesSent ?? 0,
    usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } : null,
  };

  await store.insert(record);
  res.status(201).json(record);
}));

/** GET /api/results?limit=200 — newest first. */
app.get('/api/results', asyncRoute(async (req, res) => {
  const all = await store.readAll();
  const limit = Number(req.query.limit);
  res.json(Number.isFinite(limit) && limit > 0 ? all.slice(0, limit) : all);
}));

app.get('/api/results/:id', asyncRoute(async (req, res) => {
  const record = await store.findById(req.params.id);
  if (!record) throw httpError(404, 'No evaluation with that id.');
  res.json(record);
}));

app.delete('/api/results/:id', asyncRoute(async (req, res) => {
  const removed = await store.remove(req.params.id);
  if (!removed) throw httpError(404, 'No evaluation with that id.');
  res.status(204).end();
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// Anything else falls through to the SPA-ish static pages.
app.use((_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.expose || status < 500 ? err.message : 'Internal server error.' });
});

// ---------------------------------------------------------------------------

/** fail > uncertain (or poor photo) > pass. */
export function summaryStatus(evaluation) {
  const statuses = evaluation.checks.map((c) => c.status);
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('uncertain') || evaluation.photo_quality.status === 'poor') return 'uncertain';
  return 'pass';
}

function sanitiseLabel(value, maxLength) {
  if (typeof value !== 'string') return '';
  // Drop control characters and angle brackets. The UI renders via textContent
  // anyway; this just keeps the stored JSON clean for other consumers.
  return Array.from(value)
    .filter((ch) => ch === " " || ch > " ")
    .join("")
    .replaceAll("<", "")
    .replaceAll(">", "")
    .trim()
    .slice(0, maxLength);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

await store.init();
catalog.load();

/**
 * The app is exported rather than started here, because a serverless platform
 * imports it as a request handler and never calls listen(). `npm start` runs
 * this file directly, which is the only case that should bind a port.
 */
export default app;

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  app.listen(PORT, () => {
    const cat = catalog.summary();
    console.log(`\n  Shelf Execution AI  →  http://localhost:${PORT}`);
    console.log(`  Model: ${getModel()}`);
    console.log(
      hasApiKey()
        ? '  OPENAI_API_KEY: loaded from environment ✓'
        : '  OPENAI_API_KEY: MISSING — copy .env.example to .env and add your key.',
    );
    console.log(
      cat
        ? `  Catalog: ${cat.productCount} products from ${cat.source} ✓`
        : '  Catalog: none — run `npm run import:catalog -- "<file.xlsx>"` to enable SKU identification.',
    );
    console.log(`  Storage: ${store.describeStorage()}\n`);
  });
}
