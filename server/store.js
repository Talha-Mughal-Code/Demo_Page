/**
 * Dead-simple file-backed store: one JSON array of evaluations plus an uploads
 * folder for the images. Deliberately dependency-free — swapping this module for
 * SQLite/Postgres later means reimplementing five functions, nothing else.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where evaluations and their photos are written.
 *
 * A serverless filesystem is read-only apart from /tmp, so a deployed instance
 * cannot write into the project directory. /tmp works, but it is per-instance
 * and cleared on cold start — history there is a scratch pad, not a record.
 * `isEphemeral` is surfaced through /api/health so the UI can say so out loud
 * rather than quietly losing rows.
 *
 * Set DATA_DIR to a mounted volume to make a deployment durable.
 */
const PROJECT_DATA_DIR = path.join(__dirname, '..', 'data');
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

export const DATA_DIR = process.env.DATA_DIR
  || (isServerless ? path.join('/tmp', 'shelf-execution-data') : PROJECT_DATA_DIR);
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

/** True when writes will not survive a restart of the instance. */
export const isEphemeral = !process.env.DATA_DIR && isServerless;

export function describeStorage() {
  if (isEphemeral) {
    return `${DATA_DIR} (EPHEMERAL — serverless /tmp, cleared on cold start; set DATA_DIR to persist)`;
  }
  return DATA_DIR;
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
};

// Serialises writes so two concurrent uploads can't clobber the file.
let writeChain = Promise.resolve();

export async function init() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  try {
    await fs.access(RESULTS_FILE);
  } catch {
    await fs.writeFile(RESULTS_FILE, '[]\n', 'utf8');
  }
}

export function newId() {
  return crypto.randomUUID();
}

export async function readAll() {
  try {
    const raw = await fs.readFile(RESULTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    // A corrupt file shouldn't take the whole app down; start fresh but keep a copy.
    await fs.rename(RESULTS_FILE, `${RESULTS_FILE}.corrupt-${Date.now()}`).catch(() => {});
    return [];
  }
}

export async function insert(record) {
  return enqueue(async () => {
    const all = await readAll();
    all.unshift(record); // newest first
    await atomicWrite(all);
    return record;
  });
}

export async function remove(id) {
  return enqueue(async () => {
    const all = await readAll();
    const target = all.find((r) => r.id === id);
    if (!target) return false;
    await atomicWrite(all.filter((r) => r.id !== id));
    for (const rel of [target.imagePath, target.thumbPath]) {
      if (rel) await fs.unlink(path.join(UPLOADS_DIR, path.basename(rel))).catch(() => {});
    }
    return true;
  });
}

export async function findById(id) {
  const all = await readAll();
  return all.find((r) => r.id === id) ?? null;
}

/**
 * Persist a data-URI image to the uploads folder.
 * @returns {Promise<{filename: string, bytes: number}>}
 */
export async function saveDataUri(dataUri, basename) {
  const parsed = parseDataUri(dataUri);
  if (!parsed) throw new Error('Expected a base64 image data URI.');
  const ext = EXT_BY_MIME[parsed.mime] ?? 'jpg';
  const filename = `${basename}.${ext}`;
  await fs.writeFile(path.join(UPLOADS_DIR, filename), parsed.buffer);
  return { filename, bytes: parsed.buffer.length };
}

export function parseDataUri(dataUri) {
  if (typeof dataUri !== 'string') return null;
  const match = dataUri.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) return null;
  return { mime: match[1].toLowerCase(), buffer };
}

async function atomicWrite(all) {
  const tmp = `${RESULTS_FILE}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, RESULTS_FILE);
}

function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
