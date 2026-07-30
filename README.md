# Shelf Execution AI

A retail shelf-execution evaluation tool. A merchandiser photographs a shelf or
bin display; the photo goes to a vision-capable OpenAI model, which grades it
against **6 fixed checks** and returns structured JSON. Results are stored, listed
in a running history, and rolled up into a Power BI–style compliance report.

```
Browser  ──(base64 image, JSON)──►  Express backend  ──(OPENAI_API_KEY)──►  OpenAI
   ▲                                      │
   └──────── parsed evaluation ───────────┘
```

**The OpenAI API key never leaves the server.** The browser only ever talks to
this app's own `/api/*` endpoints — there is no call to `api.openai.com` in any
file under `public/`, and no key is embedded, bundled, or returned in a response.

---

## The 6 checks

| # | Check | What it flags |
|---|-------|---------------|
| 1 | **Empty Bins** | Bin/slot is empty or critically low on product |
| 2 | **Wrong Product Under Tag** | Physical product doesn't match the tag's product identity |
| 3 | **Mixed Bin / Two SKUs Under One Tag** | One slot holds more than one distinct SKU under a single tag |
| 4 | **Price OCR** | Reads the exact price text on the tag, or returns `null` if illegible |
| 5 | **Photo Quality Self-Assessment** | Is the photo blurry/dark/badly framed/obscured — **run first**, and it gates trust in the other five |
| 6 | **Tag Presence / Legibility** | Is a tag physically present, and is it readable |

Check 5 is surfaced separately as a **banner at the top of the result**, because
it governs how much to believe everything below it. Checks 1–4 and 6 render as
the five substantive result cards.

Each check returns `pass` / `fail` / `uncertain`. **`uncertain` is not a soft
fail** — it means the model declined to guess, and it is styled distinctly
(amber, dashed outline, `?` glyph) rather than as a paler red.

---

## Product catalog (SKU identification)

Point the app at a product catalog and it will also tell you **which catalog
products are in the photo**, and flag anything on the shelf that isn't in the
catalog at all.

```bash
# From a local .xlsx — brings the product data AND the photos embedded in the sheet
npm run import:catalog -- "/path/to/Product Information.xlsx"
npm run import:catalog -- "/path/to/file.xlsx" --sheet "Sheet1 (2)"   # one sheet only

# From a file already uploaded to OpenAI Files (Storage → Files → File ID)
npm run import:catalog -- --file-id file-8zjsraWovE2bsjLuKe15uz

npm run catalog:clear                                                 # back to catalog-free
```

**Which one to use.** The local `.xlsx` route is the fuller import: it is the only
one that can extract the reference photos embedded in the sheet, and it needs no
API call. The `--file-id` route reads the workbook you uploaded to OpenAI, via
the Responses API, and returns the product **text** only — no images come back.
Run it after a local import and it keeps the photos the local import already
extracted, so you can use the uploaded file as the source of record without
losing them.

> Worth knowing: a spreadsheet `file_id` **cannot** be attached to a Chat
> Completions request — that endpoint accepts PDF for file inputs and rejects an
> .xlsx with `Expected a file with an application/pdf MIME type`. The Responses
> API reads it fine, which is why the importer uses that endpoint. Either way the
> file is read **once, at import time**, not on every photo: the evaluation call
> then carries a ~2 KB product list instead of a 10 MB workbook.

The importer reads the workbook offline and writes `data/catalog/catalog.json`
plus the reference photos it finds inside the file. Restart the server to pick
it up. It has **no dependencies** — an `.xlsx` is a ZIP of XML, and the reader
handles both classic anchored images and modern "picture in cell" rich values.

It matches columns by name, so most catalog exports import as-is:

| Field | Accepted column headers |
|---|---|
| name *(required)* | `product name`, `name`, `item`, `item name`, `product`, `title` |
| sku | `sku`, `upc`, `plu`, `item code`, `item #`, `product code`, `code` |
| category | `category`, `dept`, `department`, `class`, `type` |
| price | `retail price`, `price`, `srp`, `unit price`, `shelf price` |
| description | `description`, `desc`, `details` |
| notes | `notes`, `note`, `comments` |

Headers don't have to be on row 1 — it scans the first 40 rows. If a workbook has
several sheets, all are merged; the sheet mapping the most catalog columns wins
any conflict, and the losing value is kept as a note rather than discarded.

### How it's used

The catalog goes into the prompt **verbatim as a closed list**, so the model
chooses a name rather than inventing one. Whatever it returns is then re-checked
against the real catalog server-side — a name that doesn't resolve is reported
as an unlisted sighting, never as an identified SKU. That's the guard against a
confident-sounding hallucination becoming a row in your report.

**Coverage is an explicit instruction.** A photo shows a whole bay or department,
but the spec's checks are written for "the bin", singular — and a model asked for
a *list* of what it sees returns a summary, not a sweep. So every call carries a
coverage addendum telling it to work row by row, left to right, account for every
bin, and give each finding a `location` ("front row, 2nd crate from left").

On a real Sprouts flower display that took one photo from **1 product and 1
price** to **7 products, 8 prices and 8 unlisted bins**, each localised — the
same photo, the same model. Products that appear in several bins are several
entries, because that is what a merchandiser needs to walk the display.

**The reference photos are sent to the model**, not just shown to you. Each
evaluation attaches up to one low-detail photo per product (three for products
holding several, so rotating recipes are represented by their spread rather than
one arbitrary example) after the shelf photo, clearly labelled as references that
must not be graded. Two rules make them useful rather than harmful:

- A shelf tag that legibly names a catalog product **outranks appearance** — the
  tag is the identification, the photo is corroboration.
- Reference photos are **examples, not templates**. Products whose recipe rotates
  can look nothing like their reference and still be that product, so the model is
  told never to reject a match for failing to look identical.

Both matter. Without them the model compared bouquets against a single reference,
found them different, and reported nothing — on a photo whose tags plainly read
WANDERLUST.

Set `CATALOG_REFERENCE_IMAGES=false` to send the text list only, or
`CATALOG_REFERENCE_IMAGE_LIMIT=<n>` to cap how many images go out (default 24).

Two keys are added to the response when a catalog is loaded:

```jsonc
"identified_products": [
  { "name": "DOZEN ROSE BUNCH RED", "category": "ROSE", "sku": null,
    "location": "top row, 6th black bin from left",
    "confidence": "high", "tag_price": null,
    "rationale": "Distinct bunch of red roses visible at upper right.",
    "image": "/catalog/images/dozen-rose-bunch-red-1.png" }
],
"unlisted_products": ["tulip bunches", "hydrangea bunches"]
```

With no catalog imported, the prompt and the response shape are exactly the
6-check contract described above — nothing is added.

Why the catalog is read once at import rather than attached to every evaluation:
the model gets a ~2 KB closed list instead of a 10 MB workbook, it costs a
fraction as much, it is deterministic across calls, and every answer is verified
against the real product list before it is stored.

---

## Quick start

```bash
cd "Demo Project"
npm install

cp .env.example .env
# open .env and set OPENAI_API_KEY=sk-...

npm start
# → http://localhost:3000
```

### Setting `OPENAI_API_KEY`

Any of these work — the server reads `process.env.OPENAI_API_KEY`:

**1. `.env` file (recommended for local dev)** — loaded by `dotenv`, git-ignored:

```
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxx
```

**2. Shell environment (macOS / Linux):**

```bash
export OPENAI_API_KEY="sk-proj-xxxxxxxxxxxxxxxxxxxx"
npm start
```

**3. Shell environment (Windows PowerShell):**

```powershell
$env:OPENAI_API_KEY = "sk-proj-xxxxxxxxxxxxxxxxxxxx"
npm start
```

If the key is missing the app still boots, the console says so, and a red banner
appears on the Evaluate page — nothing silently half-works.

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | **yes** | — | Server-side only |
| `OPENAI_MODEL` | no | `gpt-5.6-terra` | Any vision-capable Chat Completions model — `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-4o` … |
| `PORT` | no | `3000` | |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | For Azure OpenAI / a gateway / a proxy |
| `OPENAI_MAX_OUTPUT_TOKENS` | no | `4000` with a catalog, `2500` without | Output budget per evaluation |
| `CATALOG_REFERENCE_IMAGES` | no | `true` | Send the catalog's reference photos with each call |
| `CATALOG_REFERENCE_IMAGE_LIMIT` | no | `24` | Cap on reference images per call |

> **On the output budget.** Reasoning models spend part of this allowance
> thinking before writing a token of JSON, so a busy shelf can exhaust it
> mid-answer. If that happens the server retries once at triple the budget; only
> if that also runs out do you get an error, and it tells you which knob to turn.
> Typical usage is 800–1300 tokens, so the default leaves real headroom.

> Model names move. `OPENAI_MODEL` exists so you can point at whatever the
> current recommended vision model is without touching code. The server also
> auto-adapts if the target model rejects `temperature`,
> `max_completion_tokens`/`max_tokens`, or `response_format` — it strips the
> offending parameter and retries rather than failing the request.

---

## Caching

`/api/*` responses are sent `no-store`, and HTML/JS/CSS are sent `no-cache`.
This matters more than it sounds: Express attaches an ETag but no freshness
directive, and a browser handed a validator with no `Cache-Control` may reuse
the body without revalidating. That is enough for a page to keep insisting the
API key is missing long after it was fixed, because it is reading a stored copy
of an old `/api/health`. Reference photos and uploads, whose contents never
change, keep a long cache.

---

## No synthetic data

Every row in History and every figure on the report comes from a real model call
on a real photo. There is no seeder, no fixture, and no fallback that invents a
result — if the API call fails you get an error, not a plausible-looking record.
The report starts empty and fills up as you evaluate photos.

---

## Using it

### Evaluate (`/`)
- Click or drag a photo in, or tap **Take photo** to open the rear camera on a phone.
- Optional **Store / Aisle / Merchandiser** fields become slicers on the report;
  they're remembered between shots.
- The photo is downscaled to 1400px in the browser before upload — a 6 MB phone
  photo goes over the wire at roughly 200 KB, which also cuts the vision token cost.
- Results render as: photo-quality banner → five check cards → overall verdict.
  The Price OCR card shows the detected price string prominently.

### History (`/history.html`)
Its own page: every stored evaluation as a row — thumbnail, timestamp, five
status dots, overall chip, and how many catalog products matched.

- **Search** across store, section, merchandiser, photo name, verdict, and the
  names of every product identified or flagged as unlisted.
- **Filter** by outcome and photo quality; **sort** by newest, oldest, worst
  outcome first, or most catalog matches.
- Click any row to open the full result — the same banner, cards and catalog
  panel the Evaluate page shows, because both use one renderer
  (`js/result-view.js`). **Delete** lives there, next to what you're deleting.

The open record's id is in the URL hash, so a result is linkable and the browser
back button returns you to the list.

### Report (`/report.html`)
A Power BI–style canvas over the same data:
- **Slicers**: date range, store, section, merchandiser, outcome, photo quality.
- **KPI tiles**: photos evaluated, execution score, failing shelves, empty bins,
  uncertain results, price read rate, usable photos.
- **Visuals**: execution-score trend by day, shelf outcome donut, outcome mix by
  check, failed checks by store, and a full detail table.
- **Export CSV** dumps exactly the filtered rows; **Print / PDF** gives a clean
  print layout with the chrome stripped.

**Execution score** = `passes ÷ (passes + fails)` across all graded checks.
Uncertain results are *excluded* rather than counted as failures — counting "we
couldn't tell" as "the shelf is wrong" would overstate the problem. The
denominator is shown on the tile so the exclusion is visible.

---

## API

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/api/health` | — | `{ ok, model, apiKeyConfigured, catalog }` |
| `GET` | `/api/catalog` | — | The imported product list (404 when none) |
| `POST` | `/api/evaluate` | `{ image, thumbnail?, filename?, store?, section?, merchandiser? }` — `image` is a `data:image/…;base64,…` URI | `201` + the stored evaluation record |
| `GET` | `/api/results` | `?limit=n` | Array of records, newest first |
| `GET` | `/api/results/:id` | — | One record |
| `DELETE` | `/api/results/:id` | — | `204` |

### Record shape

```jsonc
{
  "id": "3f2a…",
  "timestamp": "2026-07-30T14:22:11.004Z",
  "store": "Store 1042 — Riverside",
  "section": "Aisle 7 — Snacks",
  "merchandiser": "A. Okafor",
  "model": "gpt-5.6-terra",
  "imagePath": "/uploads/3f2a….jpg",
  "thumbPath": "/uploads/3f2a…-thumb.jpg",
  "photo_quality": { "status": "good", "rationale": "Sharp, evenly lit, whole bay in frame." },
  "checks": [
    { "name": "Empty Bins", "status": "pass", "rationale": "…" },
    { "name": "Wrong Product Under Tag", "status": "fail", "rationale": "…" },
    { "name": "Mixed Bin / Two SKUs Under One Tag", "status": "pass", "rationale": "…" },
    { "name": "Price OCR", "status": "pass", "detected_price": "$4.49",
      "detected_prices": [{ "price": "$4.49", "location": "front row, 2nd crate from left" }],
      "rationale": "…" },
    { "name": "Tag Presence / Legibility", "status": "pass", "rationale": "…" }
  ],
  "overall_verdict": "One short sentence.",
  "summary_status": "fail"     // fail > uncertain > pass
}
```

---

## How the model call works

`server/openai.js` posts to `POST {base}/chat/completions` with one user message
containing two content blocks: the instruction text (verbatim from
`server/prompt.js`) and an `image_url` block holding the base64 data URI at
`detail: "high"`.

Two independent guards keep the response parseable:

1. `response_format: { type: "json_object" }` — JSON mode at the API level.
2. The prompt itself demands bare JSON with no fences and no preamble.

And two more keep bad output from reaching the UI:

3. `parseJsonLoosely` still recovers if a fence or stray preamble slips through.
4. `normaliseEvaluation` coerces whatever came back into the exact expected
   shape — all five checks present, in order, unknown statuses downgraded to
   `uncertain` rather than silently dropped.

---

## Storage

`data/results.json` (one JSON array, newest first) plus `data/uploads/` for the
images. Both are git-ignored and created on first run. Writes are serialised and
written atomically via a temp file + rename, so two concurrent uploads can't
clobber each other.

This is a stage-appropriate store, not a production one. `server/store.js` is
the whole persistence surface — five functions — so moving to SQLite or Postgres
means reimplementing that one module and nothing else.

---

## Project layout

```
Demo Project/
├── package.json
├── .env.example              # copy to .env, add your key
├── README.md
├── server/
│   ├── index.js              # Express app, routes, static hosting
│   ├── openai.js             # the only place OPENAI_API_KEY is read
│   ├── prompt.js             # the evaluation prompt, verbatim
│   ├── catalog.js            # product list, prompt addendum, match validation
│   └── store.js              # JSON-file store + image persistence
├── public/
│   ├── index.html            # Evaluate
│   ├── history.html          # History list + record detail
│   ├── report.html           # Power BI–style report
│   ├── css/app.css
│   └── js/
│       ├── shared.js         # status vocabulary, API helper, image resize
│       ├── app.js            # evaluate
│       ├── result-view.js    # one record, rendered — shared by evaluate + history
│       ├── history.js        # history list, filters, detail routing
│       ├── charts.js         # hand-rolled SVG charts (no chart library)
│       └── report.js         # slicers, aggregation, visuals, CSV export
├── scripts/
│   └── import-catalog.js     # .xlsx → catalog.json (dependency-free reader)
└── data/                     # created at runtime, git-ignored
    ├── results.json
    ├── uploads/
    └── catalog/              # catalog.json + extracted reference photos
```

No build step, no bundler, no CDN. `npm install` pulls exactly two runtime
dependencies (`express`, `dotenv`); everything else is standard library and
platform APIs, so the app runs on a store network with no outbound access other
than the OpenAI call itself.

---

## Design notes

- **Committed light theme.** This mirrors the Power BI report it's modelled on,
  and a phone held up in a bright aisle wants maximum contrast, not a dim theme.
- **Status colour is never the only signal.** Every status carries a glyph (`✓`
  `✕` `?`) and a word alongside its colour; `uncertain` additionally differs in
  *shape* (dashed outline, hatched rail) so it can't read as a weak fail.
- **Charts label their own data.** The amber `uncertain` fill is below 3:1
  against white, so every stacked segment prints its count directly and both
  status visuals offer a **Show data table** toggle — the number is always
  reachable without relying on the fill.
- **Single scale per chart.** No dual axes anywhere; measures on different
  scales get their own visual.
- **Charts redraw at true pixel width** (via `ResizeObserver`) rather than being
  scaled by a viewBox, so axis text is the size it claims to be on a phone.

---

## Limits worth knowing

- Vision models are not a planogram system. They read what's in the frame; they
  cannot know that a tag is *supposed* to hold a different SKU without that
  context. Treat `Wrong Product Under Tag` as a prompt to look, not a verdict.
- **Identification degrades with distance.** A whole-department shot resolves a
  couple of products; a photo framed on one bay resolves most of them. On a wide
  shot the model is right to return few high-confidence matches — that's the
  strictness working, not a bug. Frame per bay for real coverage.
- Visually similar catalog entries are the hard case. Where products differ only
  by recipe (rotating mixed bouquets, say) the model will usually answer `low`
  confidence, and it should — the reference photo on the result card is there so
  a person can settle it in a glance.
- `uncertain` rates rise sharply on poor photos — that's the design working, but
  it means photo discipline in-store drives how useful the data is.
- `detected_price` is one string, because the spec defines it that way. Every
  legible price also lands in `detected_prices` — an array of
  `{price, location}` — so a bay with a dozen tags reports a dozen prices rather
  than one headline figure.
- There's no auth. Anyone who can reach the port can post images and read
  results. Put it behind your own auth before it leaves a laptop.
