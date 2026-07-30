/**
 * Imports a product catalog from an .xlsx workbook into `data/catalog/`.
 *
 *   npm run import:catalog -- "/path/to/Product Information.xlsx"
 *   npm run import:catalog -- "/path/to/file.xlsx" --sheet "Sheet1 (2)"
 *   npm run import:catalog -- --file-id file-8zjsraWovE2bsjLuKe15uz
 *   npm run import:catalog -- --clear
 *
 * Produces:
 *   data/catalog/catalog.json   the product list the prompt and UI read
 *   data/catalog/images/*.png   reference photos pulled out of the workbook
 *
 * Runs once, offline. The server only ever reads the generated JSON, so this
 * script carries the messy part: .xlsx is a ZIP of XML, and modern Excel stores
 * "picture in cell" images in the rich-value tables rather than as drawings.
 * Both image styles are handled. No third-party dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = path.join(__dirname, '..', 'data', 'catalog');
const IMAGES_DIR = path.join(CATALOG_DIR, 'images');
const CATALOG_FILE = path.join(CATALOG_DIR, 'catalog.json');

/* Header aliases. A workbook that names its columns differently still imports,
   and a SKU/UPC column is picked up automatically if one exists. */
const FIELD_ALIASES = {
  name: ['product name', 'name', 'item', 'item name', 'product', 'title'],
  sku: ['sku', 'upc', 'plu', 'item code', 'item #', 'item number', 'product code', 'code'],
  category: ['category', 'dept', 'department', 'class', 'type'],
  price: ['retail price', 'price', 'srp', 'unit price', 'shelf price'],
  description: ['description', 'desc', 'details'],
  notes: ['notes', 'note', 'comments'],
};

/* ========================================================================== */
/* ZIP                                                                        */
/* ========================================================================== */

function readZip(buffer) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP/xlsx file (no end-of-central-directory record).');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error('ZIP64 workbooks are not supported by this importer.');

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      // The central directory's sizes are authoritative; the local header only
      // tells us where the payload starts.
      const lo = entry.localOffset;
      const start = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
      const raw = buffer.subarray(start, start + entry.compressedSize);
      return entry.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    },
    text(name) {
      const buf = this.read(name);
      return buf ? buf.toString('utf8') : null;
    },
  };
}

/* ========================================================================== */
/* XML helpers — narrow, purpose-built readers rather than a general parser    */
/* ========================================================================== */

const decodeEntities = (s) => s
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'").replaceAll('&#10;', '\n').replaceAll('&amp;', '&');

function sharedStrings(zip) {
  const xml = zip.text('xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join(''),
  );
}

/** Worksheet name -> internal part path, via workbook.xml + its rels. */
function sheetIndex(zip) {
  const workbook = zip.text('xl/workbook.xml') ?? '';
  const rels = zip.text('xl/_rels/workbook.xml.rels') ?? '';
  const relById = new Map(
    [...rels.matchAll(/<Relationship([^>]*)\/>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[1])?.[1],
      /Target="([^"]+)"/.exec(m[1])?.[1],
    ]),
  );
  return [...workbook.matchAll(/<sheet([^>]*)\/>/g)].map((m) => {
    const name = decodeEntities(/name="([^"]*)"/.exec(m[1])?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(m[1])?.[1];
    let target = relById.get(rid) ?? '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    return { name, part: target };
  });
}

const colToIndex = (letters) =>
  [...letters].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** Parse a worksheet into a dense grid of strings plus the vm= image markers. */
function readSheet(zip, part, strings) {
  const xml = zip.text(part);
  if (xml === null) throw new Error(`Worksheet part missing from the workbook: ${part}`);

  const grid = [];
  const imageMarkers = []; // { row, col, vm }

  for (const rowMatch of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(rowMatch[1]);
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c ([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[3] ?? '';
      const ref = /r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      const col = colToIndex(ref[1]);

      const vm = /vm="(\d+)"/.exec(attrs);
      if (vm) imageMarkers.push({ row: rowNum, col, vm: Number(vm[1]) });

      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) value = type === 's' ? strings[Number(v)] ?? '' : decodeEntities(v);
      }
      // Excel writes #VALUE! for in-cell images it can't render as text; that is
      // noise here because the real picture comes from the rich-value table.
      cells[col] = value.startsWith('#') && value.endsWith('!') ? '' : value;
    }
    grid[rowNum - 1] = cells;
  }
  return { grid, imageMarkers };
}

/* ========================================================================== */
/* Images: rich values ("picture in cell") and classic drawing anchors         */
/* ========================================================================== */

function richValueImages(zip, imageMarkers) {
  const metadata = zip.text('xl/metadata.xml');
  const richValue = zip.text('xl/richData/rdrichvalue.xml');
  const richRel = zip.text('xl/richData/richValueRel.xml');
  const richRelRels = zip.text('xl/richData/_rels/richValueRel.xml.rels');
  if (!metadata || !richValue || !richRel || !richRelRels) return new Map();

  // cell vm="N" -> valueMetadata block N-1 -> rich-value index
  const valueMetadata = metadata.split('<valueMetadata')[1] ?? '';
  const rvIndexByVm = [...valueMetadata.matchAll(/<rc[^>]*v="(\d+)"/g)].map((m) => Number(m[1]));

  // rich value -> index into richValueRel -> relationship id -> media part
  const rvRelIndex = [...richValue.matchAll(/<rv[^>]*>([\s\S]*?)<\/rv>/g)].map((m) => {
    const vs = [...m[1].matchAll(/<v>([\s\S]*?)<\/v>/g)].map((v) => decodeEntities(v[1]));
    return { rel: Number(vs[0]), alt: (vs[2] ?? '').replace(/\s+/g, ' ').trim() };
  });
  const relIds = [...richRel.matchAll(/<rel r:id="([^"]+)"\s*\/>/g)].map((m) => m[1]);
  const targetById = new Map(
    [...richRelRels.matchAll(/<Relationship([^>]*)\/>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[1])?.[1],
      /Target="([^"]+)"/.exec(m[1])?.[1],
    ]),
  );

  const byRow = new Map();
  for (const marker of imageMarkers) {
    const rvIdx = rvIndexByVm[marker.vm - 1];
    const rv = rvIndexByVm.length && rvIdx !== undefined ? rvRelIndex[rvIdx] : undefined;
    if (!rv || Number.isNaN(rv.rel)) continue;
    const target = targetById.get(relIds[rv.rel]);
    if (!target) continue;
    const part = target.replace(/^\.\.\//, 'xl/').replace(/^\//, '');
    if (!byRow.has(marker.row)) byRow.set(marker.row, []);
    byRow.get(marker.row).push({ part, alt: rv.alt, col: marker.col });
  }
  for (const list of byRow.values()) list.sort((a, b) => a.col - b.col);
  return byRow;
}

function drawingImages(zip, sheetPart) {
  const relsPart = sheetPart.replace(/([^/]+)$/, '_rels/$1.rels');
  const rels = zip.text(relsPart);
  if (!rels) return new Map();
  const drawingTarget = [...rels.matchAll(/<Relationship([^>]*)\/>/g)]
    .map((m) => /Target="([^"]+)"/.exec(m[1])?.[1] ?? '')
    .find((t) => t.includes('drawings/'));
  if (!drawingTarget) return new Map();

  const drawingPart = drawingTarget.replace(/^\.\.\//, 'xl/').replace(/^\//, '');
  const xml = zip.text(drawingPart);
  if (!xml) return new Map();
  const drawingRels = zip.text(drawingPart.replace(/([^/]+)$/, '_rels/$1.rels')) ?? '';
  const targetById = new Map(
    [...drawingRels.matchAll(/<Relationship([^>]*)\/>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[1])?.[1],
      /Target="([^"]+)"/.exec(m[1])?.[1],
    ]),
  );

  const byRow = new Map();
  for (const anchor of xml.split(/(?=<xdr:(?:one|two)CellAnchor)/).slice(1)) {
    const row = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(anchor)?.[1]);
    const col = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(anchor)?.[1] ?? 0);
    const embed = /r:embed="([^"]+)"/.exec(anchor)?.[1];
    const target = embed && targetById.get(embed);
    if (Number.isNaN(row) || !target) continue;
    const part = target.replace(/^\.\.\//, 'xl/').replace(/^\//, '');
    const key = row + 1; // drawing rows are 0-based
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push({ part, alt: '', col });
  }
  return byRow;
}

/* ========================================================================== */
/* Catalog assembly                                                           */
/* ========================================================================== */

function findHeaderRow(grid) {
  for (let r = 0; r < Math.min(grid.length, 40); r++) {
    const cells = (grid[r] ?? []).map((c) => (c ?? '').trim().toLowerCase());
    if (cells.some((c) => FIELD_ALIASES.name.includes(c))) {
      const map = {};
      cells.forEach((cell, col) => {
        for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
          if (map[field] === undefined && aliases.includes(cell)) map[field] = col;
        }
      });
      return { rowIndex: r, columns: map };
    }
  }
  return null;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const clean = (s) => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function importSheet(zip, sheet, strings) {
  const { grid, imageMarkers } = readSheet(zip, sheet.part, strings);
  const header = findHeaderRow(grid);
  if (!header) return null;

  const rich = richValueImages(zip, imageMarkers);
  const drawn = drawingImages(zip, sheet.part);
  const imagesByRow = new Map([...drawn, ...rich]);

  const products = [];
  for (let r = header.rowIndex + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const at = (field) => clean(row[header.columns[field]] ?? '');
    const name = at('name');
    if (!name) continue;

    products.push({
      name,
      sku: at('sku') || null,
      category: at('category') || null,
      price: at('price') || null,
      description: at('description') || null,
      notes: at('notes') || null,
      images: imagesByRow.get(r + 1) ?? [],
    });
  }
  return { sheet: sheet.name, headerRow: header.rowIndex + 1, columns: header.columns, products };
}

const SCALAR_FIELDS = ['sku', 'category', 'price', 'description', 'notes'];

function mergeProducts(sheets) {
  // A workbook often holds a rough sheet and a tidy one. Merge the tidiest first
  // — the one mapping the most catalog columns — so its values win conflicts.
  const ranked = [...sheets].sort(
    (a, b) => Object.keys(b.columns).length - Object.keys(a.columns).length,
  );

  const merged = new Map();
  for (const sheet of ranked) {
    for (const product of sheet.products) {
      const id = slug(product.name);
      const existing = merged.get(id);
      if (!existing) {
        merged.set(id, { id, ...product, extraNotes: [] });
        continue;
      }

      for (const field of SCALAR_FIELDS) {
        const incoming = product[field];
        if (!incoming) continue;
        if (!existing[field]) {
          existing[field] = incoming;
        } else if (existing[field] !== incoming) {
          // Don't silently drop the loser — a conflicting cell is usually a note
          // filed under the wrong heading, and it still carries information.
          existing.extraNotes.push(`${field} (${sheet.sheet}): ${incoming}`);
        }
      }

      const seen = new Set(existing.images.map((i) => i.part));
      existing.images.push(...product.images.filter((i) => !seen.has(i.part)));
    }
  }

  for (const product of merged.values()) {
    if (product.extraNotes.length) {
      product.notes = [product.notes, ...product.extraNotes].filter(Boolean).join(' · ');
    }
    delete product.extraNotes;
  }
  return [...merged.values()];
}

/* ========================================================================== */

function run(sourcePath, sheetFilter) {
  const buffer = fs.readFileSync(sourcePath);
  const zip = readZip(buffer);
  if (!zip.has('xl/workbook.xml')) throw new Error('That file is not an .xlsx workbook.');

  const strings = sharedStrings(zip);
  const allSheets = sheetIndex(zip);
  const wanted = sheetFilter ? allSheets.filter((s) => s.name === sheetFilter) : allSheets;
  if (!wanted.length) {
    throw new Error(`No sheet named "${sheetFilter}". Available: ${allSheets.map((s) => s.name).join(', ')}`);
  }

  const imported = wanted.map((s) => importSheet(zip, s, strings)).filter(Boolean);
  if (!imported.length) {
    throw new Error(
      `Could not find a header row. Expected a column named one of: ${FIELD_ALIASES.name.join(', ')}.`,
    );
  }

  const products = mergeProducts(imported);
  if (!products.length) throw new Error('Header row found, but no product rows under it.');

  fs.rmSync(IMAGES_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  let written = 0;
  for (const product of products) {
    const saved = [];
    product.images.forEach((image, i) => {
      const data = zip.read(image.part);
      if (!data) return;
      const ext = path.extname(image.part) || '.png';
      const filename = `${product.id}-${i + 1}${ext}`;
      fs.writeFileSync(path.join(IMAGES_DIR, filename), data);
      saved.push({ url: `/catalog/images/${filename}`, alt: image.alt || `${product.name} reference photo` });
      written++;
    });
    product.images = saved;
  }

  const catalog = {
    source: path.basename(sourcePath),
    importedAt: new Date().toISOString(),
    sheets: imported.map((s) => ({ name: s.sheet, headerRow: s.headerRow, products: s.products.length })),
    productCount: products.length,
    products,
  };

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  console.log(`Imported ${products.length} products from ${path.basename(sourcePath)}`);
  for (const s of catalog.sheets) console.log(`  sheet "${s.name}": ${s.products} rows (header on row ${s.headerRow})`);
  console.log(`  ${written} reference image(s) → data/catalog/images/`);
  const withSku = products.filter((p) => p.sku).length;
  console.log(withSku
    ? `  ${withSku} product(s) carry a SKU/UPC code.`
    : '  No SKU/UPC column found — product name is the identifier.');
  console.log(`\nWrote ${path.relative(process.cwd(), CATALOG_FILE)}. Restart the server to pick it up.`);
}

/* ========================================================================== */
/* Import from a file already uploaded to OpenAI Files                        */
/* ========================================================================== */

const EXTRACTION_PROMPT = `Read the attached product catalog spreadsheet and extract every product row.

Return ONLY valid JSON, no markdown fences and no preamble, in exactly this shape:
{"products": [{"name": "...", "sku": "... or null", "category": "... or null", "price": "... or null", "description": "... or null", "notes": "... or null"}]}

Rules:
- One entry per product row. Copy the product name exactly as written, including capitalisation.
- Use null for a field the sheet does not contain. Never invent a SKU, price, or category.
- If several sheets list the same products, merge them into one entry per product.
- Ignore header rows, blank rows, and formula errors such as #VALUE!.`;

async function runFromFileId(fileId) {
  const dotenv = await import('dotenv');
  dotenv.default.config({ path: path.join(__dirname, '..', '.env') });

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set. Add it to .env before importing by file id.');

  const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-terra';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

  const metaRes = await fetch(`${baseUrl}/files/${fileId}`, { headers });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(`Could not read file ${fileId}: ${meta?.error?.message ?? metaRes.status}`);
  console.log(`Reading ${meta.filename} (${(meta.bytes / 1024 / 1024).toFixed(1)} MB, purpose ${meta.purpose}) via the Responses API…`);

  // Chat Completions rejects a spreadsheet file_id (it accepts PDF only), so the
  // extraction goes through the Responses API, which reads the sheet's contents.
  const res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: EXTRACTION_PROMPT },
          { type: 'input_file', file_id: fileId },
        ],
      }],
    }),
  });

  const payload = await res.json();
  if (!res.ok) throw new Error(`Responses API error (${res.status}): ${payload?.error?.message ?? 'unknown'}`);

  const text = payload.output
    ?.flatMap((item) => item.content ?? [])
    .map((c) => c.text)
    .filter(Boolean)
    .join('')
    .trim();
  if (!text) throw new Error('The model returned no text for that file.');

  const parsed = parseJsonLoosely(text);
  if (!Array.isArray(parsed?.products) || !parsed.products.length) {
    throw new Error(`Could not parse a product list from the response. First 300 chars: ${text.slice(0, 300)}`);
  }

  const products = [];
  const seen = new Set();
  for (const raw of parsed.products) {
    const name = clean(raw?.name);
    if (!name) continue;
    const id = slug(name);
    if (seen.has(id)) continue;
    seen.add(id);
    products.push({
      id,
      name,
      sku: nullable(raw.sku),
      category: nullable(raw.category),
      price: nullable(raw.price),
      description: nullable(raw.description),
      notes: nullable(raw.notes),
      images: [],
    });
  }
  if (!products.length) throw new Error('The response contained no usable product rows.');

  // Keep any reference photos an earlier local import extracted — the file id
  // route returns text only, and losing the photos would be a downgrade.
  const existing = readExistingImages();
  let carried = 0;
  for (const product of products) {
    const images = existing.get(product.id);
    if (images?.length) {
      product.images = images;
      carried += images.length;
    }
  }

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(CATALOG_FILE, `${JSON.stringify({
    source: `${meta.filename} (OpenAI file ${fileId})`,
    sourceFileId: fileId,
    importedAt: new Date().toISOString(),
    extractedBy: payload.model ?? model,
    sheets: [],
    productCount: products.length,
    products,
  }, null, 2)}\n`, 'utf8');

  console.log(`\nImported ${products.length} products from OpenAI file ${fileId}`);
  console.log(`  extracted by ${payload.model ?? model}`);
  console.log(carried
    ? `  ${carried} reference photo(s) carried over from the earlier local import.`
    : '  No reference photos — a file id returns the sheet\'s text only.\n' +
      '  For the embedded product photos, import the .xlsx from disk instead.');
  const withSku = products.filter((p) => p.sku).length;
  console.log(withSku ? `  ${withSku} product(s) carry a SKU/UPC code.` : '  No SKU/UPC column — product name is the identifier.');
  console.log('\nRestart the server to pick it up.');
}

function readExistingImages() {
  try {
    const previous = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    return new Map((previous.products ?? []).map((p) => [p.id, p.images ?? []]));
  } catch {
    return new Map();
  }
}

function parseJsonLoosely(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  for (const candidate of [raw, fenced?.[1], first !== -1 && last > first ? raw.slice(first, last + 1) : null]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate.trim());
    } catch {
      /* next */
    }
  }
  return null;
}

const nullable = (value) => clean(value) || null;

function clear() {
  fs.rmSync(CATALOG_DIR, { recursive: true, force: true });
  console.log('Removed data/catalog/. The app falls back to catalog-free evaluation.');
}

const args = process.argv.slice(2);
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

if (args[0] === '--clear') {
  clear();
} else if (flagValue('--file-id')) {
  await runFromFileId(flagValue('--file-id'));
} else {
  const sourcePath = args.find((a) => !a.startsWith('--'));
  if (!sourcePath) {
    console.error('Usage:');
    console.error('  npm run import:catalog -- "/path/to/catalog.xlsx" [--sheet "Sheet name"]');
    console.error('  npm run import:catalog -- --file-id file-xxxxxxxx');
    process.exit(1);
  }
  run(sourcePath, flagValue('--sheet'));
}
