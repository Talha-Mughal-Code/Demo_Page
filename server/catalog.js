/**
 * Product catalog: the authorised product list the model matches shelf photos
 * against. Built offline by `npm run import:catalog` from an .xlsx workbook.
 *
 * The catalog is small by design — it goes into the prompt verbatim, so the
 * model picks from a closed list rather than inventing product names. Anything
 * it returns is then re-checked against the list here, server-side, because a
 * name that isn't in the catalog is a hallucination, not an identification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_DIR = path.join(__dirname, '..', 'data', 'catalog');
export const CATALOG_IMAGES_DIR = path.join(CATALOG_DIR, 'images');
const CATALOG_FILE = path.join(CATALOG_DIR, 'catalog.json');

/** Beyond this the catalog no longer belongs inline in a prompt. */
const MAX_INLINE_PRODUCTS = 250;

/** Reference photos sent with each evaluation. Each costs a low-detail image. */
const DEFAULT_REFERENCE_IMAGE_LIMIT = 24;
const MAX_REFERENCE_BYTES = 600 * 1024;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

let catalog = null;

export function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    if (!Array.isArray(parsed.products) || !parsed.products.length) {
      catalog = null;
      return null;
    }
    catalog = parsed;
    catalog.byKey = new Map(parsed.products.map((p) => [normalise(p.name), p]));
    for (const product of parsed.products) {
      if (product.sku) catalog.byKey.set(normalise(product.sku), product);
    }
  } catch {
    catalog = null; // No catalog is a supported state, not an error.
  }
  return catalog;
}

export function isLoaded() {
  return Boolean(catalog);
}

export function summary() {
  if (!catalog) return null;
  return {
    source: catalog.source,
    importedAt: catalog.importedAt,
    productCount: catalog.products.length,
    hasSkuCodes: catalog.products.some((p) => p.sku),
    truncatedInPrompt: catalog.products.length > MAX_INLINE_PRODUCTS,
    referenceImages: referenceImagesEnabled()
      ? catalog.products.filter((p) => p.images?.length).length
      : 0,
  };
}

export function products() {
  return catalog?.products ?? [];
}

/** Loose key so "GARDEN HARVEST", "Garden  Harvest" and "garden-harvest" agree. */
function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Resolve a name the model returned to a real catalog product.
 * Exact key first, then a contained-substring match. Nothing fuzzier — a near
 * miss on a product name is worth surfacing as "not in catalog" rather than
 * quietly snapping to the wrong SKU.
 */
export function resolve(name) {
  if (!catalog || !name) return null;
  const key = normalise(name);
  if (!key) return null;

  const exact = catalog.byKey.get(key);
  if (exact) return exact;

  const contained = catalog.products.filter((p) => {
    const other = normalise(p.name);
    return other.includes(key) || key.includes(other);
  });
  return contained.length === 1 ? contained[0] : null;
}

/** The public shape stored on a record and rendered by the UI. */
export function publicProduct(product) {
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    sku: product.sku ?? null,
    category: product.category ?? null,
    price: product.price ?? null,
    description: product.description ?? null,
    image: product.images?.[0]?.url ?? null,
  };
}

/* -------------------------------------------------------------------------
   Prompt addendum
   ------------------------------------------------------------------------- */

/**
 * Extra instruction appended to the base 6-check prompt when a catalog exists.
 * Returns '' when there is no catalog, so the base prompt goes out unchanged.
 */
export function promptAddendum() {
  if (!catalog) return '';

  const listed = catalog.products.slice(0, MAX_INLINE_PRODUCTS);
  const lines = listed.map((p, i) => {
    const parts = [`${i + 1}. ${p.name}`];
    if (p.sku) parts.push(`SKU ${p.sku}`);
    if (p.category) parts.push(`category: ${p.category}`);
    if (p.price) parts.push(`list price: ${p.price}`);
    if (p.description) parts.push(p.description);
    return parts.join(' — ');
  });

  return `

PRODUCT CATALOG
The following is the complete authorised product list for this display. Use it to identify what is on the shelf.

${lines.join('\n')}

In addition to the JSON above, add these two top-level keys and no others:
"identified_products": [
  {"catalog_name": "a name copied exactly from the list above", "location": "where it is, e.g. 'front row, 2nd crate from left'", "confidence": "high|medium|low", "tag_price": "price on that item's tag as read, or null", "rationale": "under 12 words"}
],
"unlisted_products": ["short description of a product NOT in the list above, including where it is in the photo"]

Catalog rules:
- A shelf tag that legibly names a catalog product is direct evidence of identity. Read the tags: if a tag names a product on the list, identify that product, and say the tag was the source. The tag outranks appearance.
${referenceImagesEnabled() ? `- Reference photos are attached after the shelf photo. They are EXAMPLES of each product, not templates it must match. Several products rotate their recipe, colour and season, so real stock can look quite different from its reference and still be that product. Use the photos to recognise a product's type and style — never to reject something for not matching exactly.
` : ''}- "catalog_name" must be copied character-for-character from the list. Never invent, abbreviate, or merge names.
- Go bin by bin across the whole display and give a separate entry for EACH bin you can identify, up to 20. The same product in two different bins is two entries with different locations — that is expected, not a duplicate. One entry for a display of many bins means you stopped early.
- Confidence reflects how sure you are: "high" for a legible tag or an unmistakable product, "medium" for a clear type match without tag confirmation, "low" for a probable match worth a human check. Report a low-confidence match rather than omitting it — a merchandiser would rather check five candidates than be handed one. Never invent a name with no basis in the photo.
- If a bin holds something you genuinely cannot place, put it in "unlisted_products" with its location. Every bin should end up in one list or the other, or be explained in a rationale.
- Put anything on the shelf that is not in the catalog into "unlisted_products" instead. An unlisted product is a real finding, not an error.
- Judge "Wrong Product Under Tag" against the catalog: the product in the bin should match the product named on its tag.`;
}

/* -------------------------------------------------------------------------
   Reference photos
   ------------------------------------------------------------------------- */

export function referenceImagesEnabled() {
  return isLoaded() && process.env.CATALOG_REFERENCE_IMAGES !== 'false';
}

/**
 * The workbook's product photos, as message content the model can actually look
 * at. This is what those photos are for: a visual key so the model can tell one
 * bouquet from another, rather than matching on a text description alone.
 *
 * Sent at `detail: "low"` — they are already thumbnail-sized, and the job is
 * recognition, not reading fine print. One photo per product keeps the request
 * bounded no matter how many the workbook holds.
 */
export function referenceImageBlocks() {
  if (!referenceImagesEnabled()) return { blocks: [], products: [] };

  const limit = Number(process.env.CATALOG_REFERENCE_IMAGE_LIMIT) || DEFAULT_REFERENCE_IMAGE_LIMIT;
  const blocks = [];
  const included = [];
  const skipped = [];
  let sent = 0;

  for (const product of catalog.products) {
    // A product held on many photos is one whose appearance varies — rotating
    // bouquet recipes, seasonal colourways. Showing a single example of those
    // teaches the model a template it will then reject real product against, so
    // sample several across the set instead.
    const available = product.images ?? [];
    const wanted = available.length >= 3 ? 3 : available.length;
    const picks = spread(available, Math.min(wanted, Math.max(0, limit - sent)));

    const uris = picks.map((image) => readImageDataUri(image.url)).filter(Boolean);
    if (!uris.length) {
      skipped.push(product.name);
      continue;
    }

    blocks.push({
      type: 'text',
      text: uris.length > 1
        ? `REFERENCE PHOTOS — ${product.name} (${uris.length} examples; this product varies in appearance)`
        : `REFERENCE PHOTO — ${product.name}`,
    });
    for (const url of uris) blocks.push({ type: 'image_url', image_url: { url, detail: 'low' } });
    included.push(product.name);
    sent += uris.length;
  }

  if (!blocks.length) return { blocks: [], products: [] };

  blocks.unshift({
    type: 'text',
    text:
      'CATALOG REFERENCE PHOTOS FOLLOW. These show what each catalog product looks like. ' +
      'They are NOT the shelf being audited — never grade them, never read prices off them, ' +
      'and never treat them as part of the display. Use them only to recognise which catalog ' +
      'products appear in the shelf photo above.' +
      (skipped.length ? ` No reference photo is available for: ${skipped.join(', ')}.` : ''),
  });

  return { blocks, products: included };
}

/** Evenly sample `count` items across a list, so examples span the variation. */
function spread(items, count) {
  if (count <= 0 || !items.length) return [];
  if (count >= items.length) return items;
  const step = (items.length - 1) / (count - 1 || 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]);
}

function readImageDataUri(url) {
  if (!url) return null;
  const filename = path.basename(url);
  // Defend the read against a traversal-shaped filename in the generated JSON.
  const full = path.join(CATALOG_IMAGES_DIR, filename);
  if (!full.startsWith(CATALOG_IMAGES_DIR)) return null;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_REFERENCE_BYTES) return null;
    const mime = MIME_BY_EXT[path.extname(filename).toLowerCase()];
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
   Normalising what came back
   ------------------------------------------------------------------------- */

const CONFIDENCE = new Set(['high', 'medium', 'low']);

/**
 * Validate the model's identifications against the real catalog.
 * A name that doesn't resolve is demoted to an unlisted sighting rather than
 * being reported as an identified SKU.
 */
export function normaliseIdentifications(parsed) {
  if (!catalog) return { identified_products: [], unlisted_products: [] };

  const identified = [];
  const unlisted = [];
  const seen = new Set();

  for (const raw of Array.isArray(parsed?.identified_products) ? parsed.identified_products.slice(0, 20) : []) {
    const name = typeof raw?.catalog_name === 'string' ? raw.catalog_name.trim() : '';
    if (!name || name.toLowerCase() === 'null') continue;

    const product = resolve(name);
    if (!product) {
      unlisted.push(`${name} (named by the model but not in the catalog)`);
      continue;
    }

    const location = cleanField(raw.location);
    // One product legitimately appears in several bins, so identity alone is not
    // a duplicate — only the same product in the same place is.
    const key = `${product.id}@${(location ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    identified.push({
      ...publicProduct(product),
      location,
      confidence: CONFIDENCE.has(raw.confidence) ? raw.confidence : 'low',
      tag_price: cleanField(raw.tag_price),
      rationale: typeof raw.rationale === 'string' ? raw.rationale.trim() : '',
    });
  }

  for (const raw of Array.isArray(parsed?.unlisted_products) ? parsed.unlisted_products.slice(0, 8) : []) {
    const text = typeof raw === 'string' ? raw.trim() : raw?.description?.trim();
    if (text) unlisted.push(text);
  }

  return { identified_products: identified, unlisted_products: unlisted.slice(0, 12) };
}

/** Trim to a real value, treating the literal string "null" as absent. */
function cleanField(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== 'null' ? trimmed : null;
}
