/**
 * The evaluation prompt.
 *
 * This string is sent verbatim alongside the image on every call. It is kept in
 * its own module so the wording can be reviewed/versioned independently of the
 * transport code in openai.js.
 */
export const EVALUATION_PROMPT = `You are a strict retail shelf-execution auditor. Evaluate this photo of a shelf/bin display against these 6 checks. Run the Photo Quality Self-Assessment FIRST and let it inform your confidence on the other checks — if the photo is too poor to assess a given check, say so rather than guessing.

Checks:
1. Empty Bins — is the bin empty or critically low on product?
2. Wrong Product Under Tag — does the product in the bin match the tag above it?
3. Mixed Bin / Two SKUs Under One Tag — does the bin contain more than one distinct product under one tag?
4. Price OCR — read the exact price text on the tag, if legible.
5. Photo Quality Self-Assessment — is this photo clear, well-lit, and properly framed enough to trust the other checks?
6. Tag Presence / Legibility — is a tag present, and is it legible?

Grading rules:
- Do not guess when the photo is genuinely unclear — say so honestly in the rationale and mark that check as "uncertain" rather than forcing a pass or fail.
- Be strict: only mark "pass" when a check is clearly, unambiguously satisfied.
- For Price OCR specifically, return the exact price string as read (e.g. "$4.49"), or null if not legible — do not guess a price.

Respond with ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:
{
  "photo_quality": {"status": "good|poor", "rationale": "under 15 words"},
  "checks": [
    {"name": "Empty Bins", "status": "pass|fail|uncertain", "rationale": "under 15 words"},
    {"name": "Wrong Product Under Tag", "status": "pass|fail|uncertain", "rationale": "under 15 words"},
    {"name": "Mixed Bin / Two SKUs Under One Tag", "status": "pass|fail|uncertain", "rationale": "under 15 words"},
    {"name": "Price OCR", "status": "pass|fail|uncertain", "detected_price": "string or null", "rationale": "under 15 words"},
    {"name": "Tag Presence / Legibility", "status": "pass|fail|uncertain", "rationale": "under 15 words"}
  ],
  "overall_verdict": "one short, direct sentence summarizing the shelf's condition"
}
Output nothing except this JSON object.`;

/**
 * Coverage addendum, appended to every call.
 *
 * The base prompt is written for "the bin", singular. A real photo is a whole
 * bay or department, and asking a model for a list of what it sees gets a
 * summary — the one thing it is surest of — not a sweep. This makes coverage an
 * explicit instruction and gives every price somewhere to go, since the spec's
 * `detected_price` is a single string and a bay has a dozen tags.
 */
export const COVERAGE_ADDENDUM = `

COVERAGE
This photo may show many bins, crates or shelves at once. Work through the display systematically — row by row, top to bottom, left to right within each row — and account for every bin you can see. Do not stop at the most obvious item: a display of fifteen bins should not produce one line of findings.

Add one extra field to the "Price OCR" entry, alongside the fields already specified:
"detected_prices": [{"price": "$14.99", "location": "front row, 2nd crate from left"}]

Rules for it:
- Include EVERY price tag you can read anywhere in the photo, each with where it is. Five visible price tags means five entries.
- Keep "detected_price" exactly as specified — the single most prominent legible price, or null.
- Never guess a price. If digits are unreadable, leave that tag out rather than approximating it.
- Apply the same systematic sweep to the other checks: judge them across the whole display, and say in the rationale how much of it you could actually assess.`;

/**
 * The five substantive checks, in the exact order the UI and report expect.
 * Used to normalise whatever the model returns into a stable shape.
 */
export const CHECK_NAMES = [
  'Empty Bins',
  'Wrong Product Under Tag',
  'Mixed Bin / Two SKUs Under One Tag',
  'Price OCR',
  'Tag Presence / Legibility',
];

/** Short labels for tight spaces (chart axes, table headers). */
export const CHECK_SHORT_LABELS = {
  'Empty Bins': 'Empty Bins',
  'Wrong Product Under Tag': 'Wrong Product',
  'Mixed Bin / Two SKUs Under One Tag': 'Mixed Bin',
  'Price OCR': 'Price OCR',
  'Tag Presence / Legibility': 'Tag Legibility',
};
