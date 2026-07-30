/**
 * Server-side OpenAI client.
 *
 * The API key is read from process.env here and nowhere else. Nothing in this
 * module is ever serialised to the browser — index.js returns only the parsed
 * evaluation object.
 */
import { EVALUATION_PROMPT, COVERAGE_ADDENDUM, CHECK_NAMES } from './prompt.js';
import * as catalog from './catalog.js';

const DEFAULT_MODEL = 'gpt-5.6-terra';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const VALID_CHECK_STATUS = new Set(['pass', 'fail', 'uncertain']);
const VALID_QUALITY_STATUS = new Set(['good', 'poor']);

export function getModel() {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

export function hasApiKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/**
 * Output budget for one evaluation.
 *
 * This has to cover the model's internal reasoning as well as the JSON it
 * finally writes, and reasoning is the larger and less predictable half. A
 * catalog adds an identification pass over every bin in frame, so it needs
 * appreciably more headroom.
 */
function tokenBudget() {
  const override = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(override) && override > 0) return override;
  return catalog.isLoaded() ? 4000 : 2500;
}

/**
 * Call the vision model with one image and return the parsed evaluation.
 *
 * @param {string} imageDataUri - full `data:image/...;base64,...` URI
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{evaluation: object, model: string, usage: object|null}>}
 */
export async function evaluateImage(imageDataUri, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw httpError(500, 'OPENAI_API_KEY is not set on the server. Copy .env.example to .env and add your key.');
  }

  const model = getModel();
  const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');

  // The 6-check prompt goes out verbatim. When a product catalog is loaded, its
  // addendum is appended after it, adding two keys to the response and nothing
  // else — so the base contract is identical with or without a catalog.
  const instruction = EVALUATION_PROMPT + COVERAGE_ADDENDUM + catalog.promptAddendum();
  const reference = catalog.referenceImageBlocks();

  const content = [
    { type: 'text', text: instruction },
    { type: 'text', text: 'PHOTO UNDER AUDIT — this is the shelf photo you are evaluating:' },
    { type: 'image_url', image_url: { url: imageDataUri, detail: 'high' } },
    ...reference.blocks,
  ];

  const messages = [{ role: 'user', content }];

  // Belt and braces: the prompt demands JSON, and JSON mode enforces it at the
  // API level. Some models reject some of these parameters — `postWithFallbacks`
  // strips whichever one the API complains about and retries.
  const body = {
    model,
    messages,
    response_format: { type: 'json_object' },
    max_completion_tokens: tokenBudget(),
    temperature: 0,
  };

  let data = await postWithFallbacks(`${baseUrl}/chat/completions`, apiKey, body, opts.signal);
  let raw = data?.choices?.[0]?.message?.content;

  // Reasoning models spend part of this budget thinking before they emit a
  // token of JSON, so a busy shelf can exhaust it mid-answer — or before the
  // answer starts. `length` means the budget was the limit, not the model, so
  // retry once with a much larger one rather than failing the upload.
  if (data?.choices?.[0]?.finish_reason === 'length') {
    const stretched = { ...body, max_completion_tokens: tokenBudget() * 3 };
    data = await postWithFallbacks(`${baseUrl}/chat/completions`, apiKey, stretched, opts.signal);
    raw = data?.choices?.[0]?.message?.content;
  }

  if (!raw || !raw.trim()) {
    const reason = data?.choices?.[0]?.finish_reason;
    throw httpError(502, reason === 'length'
      ? `The model ran out of output budget on this photo even after retrying (used ${data?.usage?.completion_tokens ?? '?'} tokens). ` +
        'Raise OPENAI_MAX_OUTPUT_TOKENS in .env, or send a photo of one bay rather than a whole department.'
      : `The model returned an empty response${reason ? ` (finish_reason: ${reason})` : ''}.`);
  }

  const parsed = parseJsonLoosely(raw);
  if (!parsed) {
    throw httpError(502, `The model did not return valid JSON. First 300 chars: ${raw.slice(0, 300)}`);
  }

  return {
    evaluation: normaliseEvaluation(parsed),
    model: data?.model || model,
    usage: data?.usage ?? null,
    referenceImagesSent: reference.products.length,
  };
}

/**
 * POST to the API, retrying without parameters the target model rejects.
 * Model families differ on `temperature`, `max_completion_tokens` vs
 * `max_tokens`, and `response_format`; rather than hard-coding a per-model
 * matrix we react to the API's own error message.
 */
async function postWithFallbacks(url, apiKey, body, signal) {
  let attempt = { ...body };

  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(attempt),
      signal,
    });

    if (res.ok) return res.json();

    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message || text;
    } catch {
      /* keep raw text */
    }

    const relaxed = relaxUnsupportedParam(attempt, message);
    if (res.status === 400 && relaxed) {
      attempt = relaxed;
      continue;
    }

    // Never echo the key or headers back to the client.
    throw httpError(
      res.status === 401 ? 401 : res.status === 429 ? 429 : 502,
      `OpenAI API error (${res.status}): ${message}`,
    );
  }

  throw httpError(502, 'OpenAI API rejected every parameter combination we tried.');
}

/** Drop or rename the one parameter the API says it does not support. */
function relaxUnsupportedParam(body, message) {
  const m = message.toLowerCase();
  const next = { ...body };

  if (m.includes('max_completion_tokens') && 'max_completion_tokens' in next) {
    next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
    return next;
  }
  if (m.includes("'max_tokens'") && 'max_tokens' in next) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    return next;
  }
  if (m.includes('temperature') && 'temperature' in next) {
    delete next.temperature;
    return next;
  }
  if (m.includes('response_format') && 'response_format' in next) {
    // The prompt still demands bare JSON, so this degrades safely.
    delete next.response_format;
    return next;
  }
  if (m.includes('detail')) {
    for (const part of next.messages?.[0]?.content ?? []) {
      if (part.type === 'image_url' && part.image_url?.detail) delete part.image_url.detail;
    }
    return next;
  }
  return null;
}

/** Tolerate a stray markdown fence or leading prose even though we asked for neither. */
function parseJsonLoosely(raw) {
  const candidates = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const value = JSON.parse(c);
      if (value && typeof value === 'object') return value;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Coerce the model's object into the exact shape the UI and report rely on:
 * all five checks present, in order, with a known status.
 */
export function normaliseEvaluation(parsed) {
  const byName = new Map();
  for (const check of Array.isArray(parsed.checks) ? parsed.checks : []) {
    if (check && typeof check.name === 'string') byName.set(check.name.trim().toLowerCase(), check);
  }

  const checks = CHECK_NAMES.map((name) => {
    const found = byName.get(name.toLowerCase()) ?? {};
    const status = VALID_CHECK_STATUS.has(found.status) ? found.status : 'uncertain';
    const out = {
      name,
      status,
      rationale: cleanText(found.rationale) || 'No rationale returned by the model.',
    };
    if (name === 'Price OCR') {
      const price = cleanText(found.detected_price);
      out.detected_price = price && price.toLowerCase() !== 'null' ? price : null;
      out.detected_prices = normalisePrices(found.detected_prices, out.detected_price);
    }
    return out;
  });

  const pq = parsed.photo_quality ?? {};
  const photoQualityStatus = VALID_QUALITY_STATUS.has(pq.status) ? pq.status : 'poor';

  return {
    photo_quality: {
      status: photoQualityStatus,
      rationale:
        cleanText(pq.rationale) ||
        (photoQualityStatus === 'poor'
          ? 'Model did not report photo quality; treating as unverified.'
          : 'Photo quality acceptable.'),
    },
    checks,
    overall_verdict: cleanText(parsed.overall_verdict) || 'No overall verdict returned by the model.',
    ...catalog.normaliseIdentifications(parsed),
  };
}

/**
 * Every legible price in the photo, deduped by price+location.
 *
 * A bay carries a dozen tags but the spec's `detected_price` is one string, so
 * this is where the rest live. Older records predate the field, and the single
 * price is folded in so a caller can read this one array and get everything.
 */
function normalisePrices(raw, primary) {
  const out = [];
  const seen = new Set();

  const add = (price, location) => {
    const text = cleanText(price);
    if (!text || text.toLowerCase() === 'null') return;
    const where = cleanText(location);
    const key = `${text.toLowerCase()}@${(where ?? '').toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ price: text, location: where || null });
  };

  for (const entry of Array.isArray(raw) ? raw.slice(0, 24) : []) {
    if (typeof entry === 'string') add(entry, null);
    else add(entry?.price, entry?.location);
  }

  // The headline price may not have been repeated in the array.
  if (primary && !out.some((p) => p.price.toLowerCase() === primary.toLowerCase())) {
    add(primary, null);
  }
  return out;
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return String(value).trim();
  return value.trim();
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}
