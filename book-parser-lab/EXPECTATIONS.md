# Book Parser Lab — Expectations Brief

This document is the shared brief for an experimental **standalone book parser** inside this repo. It is meant for a capable model (or human) to execute overnight research + implementation without rediscovering product intent from chat history.

## High-level intent

Create a **more consistent extraction process** for popular EPUBs (and the real-world variations of those files) and for **text PDFs**, so users face **minimum friction** when bringing books into the app.

Extraction must be done in a way that supports **this app’s internal reading model**, because later features depend on it:

- normal reading
- speed reading
- TTS
- shared progress / word positions
- chapter-aware behavior

This is **not** a project to become Apple Books / Kindle (full CSS, exact page layout, fixed-layout comics). It is a project to turn common book files into a trustworthy app-owned model with low user pain.

## Success definition

**Success = reliable extraction into the app model**, with books that feel about as good as the current **Pride and Prejudice** import (golden example), including images in roughly the right reading order.

Not success:

- pixel-perfect publisher layout
- comics / manga / fixed-layout “page image” books
- scanned PDFs that need OCR (out of scope for this phase)

## Target output model (must match app)

The parser’s output should closely match what the app already uses:

```ts
paragraphs: { id, text }[]          // sequential IDs
chapters: { title, startParagraphId }[]
images: { afterParagraphId, alt, src }[]  // 0 = before first paragraph
cover: separate cover pointer/data for library use
totals: word/paragraph counts as needed
```

Why this shape exists: speed reading, TTS, and progress all key off `{ paragraphId, wordIndex }`. Images are sidecar blocks for normal reading only.

**Image `src` policy (efficient):**

- Prefer **pointers**, not eager base64 of every asset
- EPUB: zip-relative path (or equivalent stable ref)
- PDF: page + image index (or object id)
- Inline `data:image/...` only when the asset is already inline and small/self-contained
- Position must look good in reading order; a bit above/below the “perfect” spot is OK
- Do **not** reintroduce the slow “materialize all images to giant text in SQLite during import” approach

Library covers may still be materialized as a single displayable image (one cover is cheap). In-book images should stay on-demand/pointers.

## Formats in scope

### EPUB (primary, ~80% of overnight corpus)

Support popular **reflowable** text EPUBs and their common variations:

1. EPUB 2 and EPUB 3
2. TOC via nav, NCX, both, or weak/messy TOC with fallbacks
3. Many HTML files or one large HTML file
4. Chapter markers via file boundaries, anchors, headings, imperfect TOC
5. Clean paragraph HTML and nested `div` soup
6. Covers: declared cover and sensible fallbacks
7. Images in common weird forms (see below)

Out of scope for now: fixed-layout, comics/manga, DRM-locked files, script-heavy magazine layouts.

Treat the shape list as a **living checklist**. When real popular books reveal a new common pattern, add it — do not pretend the first list is complete.

### PDF (secondary, ~20% of overnight corpus)

- **Text PDFs only** (selectable text)
- May include images/illustrations
- Same output model as EPUB
- **No OCR / scanned-page PDFs** in this phase

## Images: treat as a first-class research problem

Images are not a side note. Users notice missing or blank images. The lab must handle **many forms**, efficiently.

Known painful example already found in-app:

- Inline SVG that only wraps `<image xlink:href="cover.jpg">`
- Serializing that SVG to a standalone `data:` URL breaks the relative link → tall blank space
- Fix direction for that pattern: treat as a normal image pointer to the referenced raster file (and research sibling patterns)

The implementer **must not hesitate to research** this problem space:

- How popular EPUB producers embed images (img, SVG wrappers, object/embed, CSS background if relevant to extraction, spine cover HTML, etc.)
- How text PDFs store images and how to anchor them to reading order
- What efficient reference schemes other extractors use
- Failure modes that create blank space, duplicates, or huge import cost

Do not stop at the first SVG bug. Build a small taxonomy of image embedding patterns and make the parser handle the common ones without expensive eager decoding of every byte into text.

## Project shape

| Decision | Choice |
|----------|--------|
| Location | Isolated package/folder **inside this app repo** |
| Starting point | **Blank slate** parser (do not fork old heuristics blindly) |
| Reference | App model + current Pride and Prejudice look + this brief + `DOCUMENTATION.md` |
| Language | **TypeScript** from day one (realistic on-phone import later) |
| Integration | Standalone first; wire into app only if results are good enough |

Reuse lessons, not legacy code:

- path/pointer images beat base64-everything
- strict failures are useful while investigating
- the app differs from typical readers (normalized model, not live EPUB renderer)

## Quality bar and phases

### Phase 1 (this lab)

- **Strict:** if extraction looks unreliable, **fail clearly** so failures can be counted
- Goal is to learn **common fail reasons and how often**
- Soft “best effort always” comes in **phase 2** after data exists
- Spot-checked books should feel **about equal to Pride and Prejudice** (not “better than”)
- Must collect a list of **at least 20 broken books** from **realistic** sources — no cheating by stocking the corpus with intentionally garbage files

### Automatic PASS (phase 1)

Closer to real quality than bare smoke tests:

- No crash / no timeout beyond agreed budget
- Real text extracted; sequential paragraph IDs
- Chapters look sane (not empty/nonsense-only)
- Cover found when reasonably present
- Image anchors look sane when images exist
- Output matches the target model

“Looks good” verification:

- Auto checks on **all** books
- Previews/screenshots (or equivalent HTML preview) for **failures**
- Manual spot-check a sample, including hard/illustrated books
- Pride and Prejudice = golden visual/reading reference

### Speed

Match **current app import feel**, scaled by size/type (e.g. illustrated Pride-class in seconds on device after pointer-based images — not multi-minute base64 import). Overnight laptop bulk should finish hundreds of books without pathological per-book cost.

## Overnight corpus and evaluation

- **Size:** 250–500 books
- **Mix:** ~80% EPUB, ~20% text PDF
- **Sources:** legal free sources only (Project Gutenberg, Standard Ebooks, Internet Archive public-domain, libre/author-shared freebies, etc.)
- **Variety:** popular + classics + messy-but-legal free editions (stand-ins for janky real-world files)
- **No piracy** of commercial indie/romance catalogs
- **Compare:** new parser only (no mandatory old-vs-new bakeoff); Pride is the quality benchmark

### Failure buckets to tally

Use a short fixed list (add buckets later if new patterns dominate):

1. Crash
2. No / unusable text
3. Bad paragraph IDs
4. Weak / missing / nonsense chapters
5. Cover missing
6. Images missing / blank / badly placed
7. Timeout / extreme slowness
8. Other (rare; explain)

## Morning deliverables

1. Parser package in-repo (runnable)
2. Corpus (or reproducible download scripts) + run results
3. **Desktop output folders** (required) — copy/symlink evaluated books into:
   - **Good books:** `/Users/michalkrsik/Desktop/good books`
   - **Bad books:** `/Users/michalkrsik/Desktop/bad books`  
   Use those exact paths. “Good” ≈ equals Pride-quality / auto PASS and looks fine; “Bad” = failed or clearly not good enough (include the ≥20 realistically broken set here, plus any other failures). Keep filenames recognizable (title/id). Do not put corpus junk outside these two result folders on the Desktop.
4. Report including:
   - pass rate
   - failure counts by bucket
   - list of ≥20 realistically broken books
   - previews/links for failures
   - plain-English section: how it did, what went well, what went poorly, what to do next
5. Notes from **research** on EPUB/PDF image and structure variants (even if not all are implemented yet)

## Explicit non-goals (phase 1)

- App UI integration / replacing production import path
- OCR for scanned PDFs
- Fixed-layout comics
- Perfect CSS fidelity
- Python-in-Android runtime (TypeScript path)

## Working rules for the implementing agent

1. Read this brief and `DOCUMENTATION.md` before coding.
2. Research freely when stuck on EPUB/PDF structure or image embedding — do not guess in the dark.
3. Prefer efficient pointer-based media handling.
4. Keep output app-model-compatible.
5. Optimize for **minimum user friction** and **consistent** results across popular file variants.
6. When uncertain, choose the option that protects TTS/speed-reading positions and readable normal-mode order.
