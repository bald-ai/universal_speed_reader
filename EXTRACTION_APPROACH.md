# Book Extraction Approach — Audit Brief

This document describes how Universal Speed Reader extracts **reflowable EPUBs** and **selectable-text PDFs** into the app’s normalized reading model. It is written for an external model audit: self-contained, implementation-accurate, and grounded in the product north star plus real issues discussed across Cursor/Codex work on this system.

**Production code:** `src/lib/bookParser/`  
**Research / corpus lab (same logic origin):** `book-parser-lab/`  
**Import wiring / soft-vs-hard policy:** `src/lib/import/`  
**Product context:** `DOCUMENTATION.md`

---

## 0. North star (why extraction quality matters)

### Product job

The target user often already has **several readers** — one that is good for EPUBs, one for PDFs, one for TTS, maybe another for speed reading or “god knows what.” The north star for this project is:

> **One app that consolidates that stack.** Same library, same book, same place in the book — across normal reading, speed reading, and TTS — with enough format coverage and fidelity that people do not keep bouncing back to specialist apps.

That is a bigger niche than “cool RSVP toy.” Extraction is the foundation of that bet. If bringing a file in feels worse than opening it in AlReader / ReadEra / a dedicated TTS app, consolidation fails even if RSVP is clever.

### Extraction success bar (human, not lab)

We do **not** need extraction to feel *better* than reading the raw file in a traditional renderer. We need:

1. **Not worse** — readers should not feel they would have a better experience with the raw EPUB/PDF in another app for ordinary reading of that file.
2. **Often a quiet advantage** — processing text lets us reflow for phones, normalize junk, turn ornaments into quiet scene breaks, share one position model across modes, and make dense PDFs actually readable on a handset.
3. **Minimum cost for the payoff** — preprocess only as much as the multi-mode model needs; industry readers usually open fast and render lazily. Our cost is intentional, but time-to-first-word and fidelity tradeoffs are fair audit targets.

A useful field-test framing already discussed: keep raw bytes, optionally compare **Source (original render)** vs **App (normalized)**. That measures *extraction/experience parity*, not “is RSVP better than paging.”

### Why we still preprocess (advantage of the cost)

Mature readers (Readium, KOReader, Foliate/epub.js, Calibre, ReadEra-style PDF viewers) mostly **keep the file as source of truth and render it**. We convert into an app-owned model keyed by:

```ts
{ paragraphId, wordIndex }
```

That unlocks what specialist apps do not share easily:

| Capability | Why the normalized model helps |
|---|---|
| Speed reading | Synchronous current/next word without an EPUB renderer in the timed loop |
| TTS | Spoken chunks mapped back to exact book positions; pronunciation rules over owned text |
| Shared resume | Leave RSVP/TTS and land on the same word in normal reading |
| Stable progress | Survives font size, rotation, padding — not page/scroll/CFI |
| Chapter-aware pacing | Pauses/slowdowns at paragraph, scene, and chapter boundaries |
| Library / whole-book features | Word counts, chapter progress, rule previews |

**Industry contrast:** Readest/Koodo/KOReader typically import lightly (metadata/cover/hash), open with an engine, and cache derived data later. We currently gate *readable* on full-book parse + chunk store. That is the right architecture for the multi-mode product **if** extraction quality stays at parity; the remaining product debt is often *when* the book becomes readable (incremental/first-chunk), not whether the model exists.

### On-device comparison evidence (what “not worse” looks like)

A July 2026 capture comparison (AlReaderX EPUB, ReadEra PDF, this app both) on Dracula/Frankenstein supported:

- **Our strength:** default prose legibility and **cross-format consistency** — EPUB and PDF become the same comfortable mobile surface (serif measure, leading, paragraph spacing). Critics ranked that strongest vs AlReader’s rivers/hyphenation and ReadEra’s tiny page-fit PDF text.
- **Their strength we must not lose via extraction:** cover/visual identity (AlReader), source PDF pagination/links/hierarchy (ReadEra), images/headings/dividers/italics/meaningful spacing.
- **Product lesson for extraction:** preserve covers, images, headings, links, dividers, italics, and meaningful spacing during normalization. Offer comfort without making people miss the raw file for “truth.”
- **Known parity risk:** chapter label / progress timing (e.g. Frankenstein Letter 2→3) needs source-to-reader audit — can feel worse than a raw TOC even when prose is fine.

### Soft vs hard (product decision already shipped)

From failure-mode discussions on real lab failures:

| Situation | Product stance |
|---|---|
| Missing images, book otherwise fine (e.g. Three Blind Mice) | **Soft** — still readable / RSVP / TTS; warn “some pictures missing.” Images are normal-reading only anyway. |
| Garbled/control glyphs that hurt TTS/RSVP (e.g. math PDF font maps) | **Soft for now** — trust user autonomy; warn that speech/speed may sound wrong. Do **not** auto-disable TTS/RSVP. |
| Almost no text, broken paragraph IDs, collapsed unusable model, timeout, unsupported/DRM/scan | **Hard** — purge from library; show only under Last import; user imports the file again. Restore of an existing book must **not** delete prior good content on hard-fail. |

Trust the user: flawed-but-usable beats a dead Failed row.

---

## 1. Why this extractor exists (technical)

Import converts each book into the logical model so one file drives normal reading, RSVP, TTS, chapter-aware pacing, and shared progress.

Word counts and positions use whitespace tokenization with leading/trailing quote stripping (`tokenizeParagraph` in `src/lib/bookParser/text.ts`) — the same definition runtime uses for progress/TTS.

**Audit lens:** judge extraction by the north star in §0, not by “did we match Readium’s CSS fidelity.” Pixel-perfect layout is out of scope; **feeling worse than the raw file** is in scope.

---

## 2. Target output model

Parser output schema version **2** (`ParsedBook` in `src/lib/bookParser/types.ts`):

| Field | Shape / meaning |
|---|---|
| `metadata` | `title`, `authors[]`, optional `language`, `identifier` |
| `paragraphs` | `{ id, text, sceneBreakBefore? }[]` — IDs are `1..N` sequential |
| `chapters` | `{ title, startParagraphId, kind?, level? }[]` — navigation entries |
| `images` | `{ afterParagraphId, alt, src, mediaType? }[]` — sidecar for normal reading only |
| `cover` | `{ src, mediaType? } \| null` — library cover pointer (materialized later by import) |
| `totals` | words, paragraphs, chapters, images, sceneBreaks |
| `diagnostics` | `{ bucket, severity, message, code?, details? }[]` |
| `timings` | `totalMs` (+ optional open/structure/content phases) |

**Image anchoring:** `afterParagraphId = 0` means before the first paragraph; otherwise after that paragraph. Anchors must be monotonic non-decreasing.

**Scene breaks:** anonymous narrative transitions stored as `paragraph.sceneBreakBefore` (`"text-ornament" | "horizontal-rule" | "css-separator" | "whitespace"`). They never get their own paragraph ID or words. If a named navigation entry starts at the same paragraph, the named entry wins and the scene-break flag is cleared in `buildBook`.

**Images are ignored by** speed reading and TTS. Only normal reading interleaves them.

---

## 3. Architecture map

```
File bytes
  → detectBookSourceFormat (magic: %PDF- / ZIP PK)
  → parseEpub | parsePdf
  → buildBook (normalize IDs, dedupe chapters, clamp image anchors, totals)
  → validateParserOutput (adds/merges diagnostics; pass = no severity:failure)
  → BookImportService
       → classifyImportDiagnostics (soft warnings vs hard fail)
       → chunk + store paragraphs/chapters/images
       → materialize ONE library cover as data URL
       → keep in-book media as pointers
```

### Key production files

| File | Role |
|---|---|
| `src/lib/bookParser/index.ts` | Format detect + `parseBookBytes` entry |
| `src/lib/bookParser/epub.ts` | EPUB orchestration |
| `src/lib/bookParser/epub-archive.ts` | Selective ZIP (`fflate`); inflate markup/SVG only, never rasters during parse |
| `src/lib/bookParser/epub-package.ts` | `container.xml`, OPF metadata/manifest/spine, fixed-layout reject |
| `src/lib/bookParser/epub-content.ts` | DOM flow extraction, images, scene ornaments, CSS separators/backgrounds |
| `src/lib/bookParser/epub-navigation.ts` | nav / NCX / heading / file-boundary chapter choice |
| `src/lib/bookParser/pdf.ts` | PDF.js load, per-page text+operators, orientation, columns, outline flatten |
| `src/lib/bookParser/pdf-content.ts` | Furniture filter, paragraph rebuild, scene breaks, PDF image pointers |
| `src/lib/bookParser/pdf-structure.ts` | Outline vs heading chapters, text-quality diagnostics, metadata |
| `src/lib/bookParser/model.ts` | `buildBook`, chapter dedupe + navigation kind/level |
| `src/lib/bookParser/validate.ts` | Strict model validation |
| `src/lib/bookParser/diagnosticCodes.ts` | Stable codes + which codes import soft-allows |
| `src/lib/import/importDiagnostics.ts` | Soft vs hard classification for library completion |
| `src/lib/import/bookImportService.ts` | Queue, timeout wrapper, persistence, cover materialization, purge on hard fail |

**Dependencies used for extraction:**

- EPUB: `fflate` (ZIP), `cheerio` (XHTML/HTML/XML DOM)
- PDF: `pdfjs-dist` legacy build (`pdfjs-dist/legacy/build/pdf.mjs`) with worker; image decoding / OffscreenCanvas deliberately disabled at load time

---

## 4. Format detection

`detectBookSourceFormat(fileName, bytes)`:

1. If bytes start with `%PDF-` → `pdf`
2. Else if ZIP magic `PK` → `epub`
3. Else if extension claims `.epub`/`.pdf` but content mismatches → error
4. Else → unsupported

PDF parsing is lazy-imported so EPUB-only imports do not pay PDF.js startup cost.

---

## 5. EPUB extraction pipeline

### 5.1 Open and structure

1. Build `SelectiveZipArchive` over source bytes.
2. Inspect `mimetype` (warning if missing/unexpected; not a hard crash by itself).
3. Read `META-INF/container.xml` → OPF path.
4. Parse package document:
   - metadata (title/creators/language/identifier)
   - **reject fixed-layout** (`rendition:layout=pre-paginated` or legacy `fixed-layout` true)
   - manifest items (id, href→path, media-type, properties, fallback)
   - spine reading order (`linear` vs non-linear)
   - nav item (`properties` includes `nav`), NCX (spine `toc` / manifest), guide cover paths, EPUB2 cover meta id
5. Preload content documents under a total byte safety limit.

### 5.2 Cover discovery (pointer only at parse time)

Priority / candidates:

1. Manifest `cover-image` property
2. EPUB2 cover meta id
3. Guide cover paths
4. Manifest/spine items whose id/filename looks cover-like
5. First-spine image-only wrapper fallback (when mostly image, little prose)

Cover wrappers that are content documents are scanned for the first resolvable image. Raster/SVG covers remain **ZIP-relative paths** (or small inline SVG data URLs). Import later materializes **one** library cover into `books.cover_path` as a data URL for `<img src>`.

### 5.3 Reading order and content extraction

- Prefer **linear spine** items that are content documents (XHTML/HTML/XML).
- Skip the navigation document if it appears in the spine (avoids dumping TOC labels into prose).
- If linear content extracts but fails text viability **and** non-linear items exist, try a full-spine recovery pass; keep recovery only if it becomes viable. Short genuine linear books must not absorb useless auxiliary content.
- Each content document:
  - Collect linked/embedded stylesheet rules for CSS `background-image` / `content:url(...)` and CSS separator heuristics
  - Remove `script/noscript/template/style/head`, `[hidden]`, `aria-hidden=true`, and CSS `display:none` / `visibility:hidden`
  - Walk DOM in order via `extractFlowElement`

### 5.4 Paragraph emission (DOM flow)

Block elements (`p`, `div`, headings, `li`, `blockquote`, `section`, table cells, etc.) flush text buffers into paragraphs.

Rules of note:

- Nested container soup: emit semantic blocks; flush text before media so image order stays monotonic; mixed containers keep direct text before/after child blocks.
- Element IDs (`id` / `xml:id` / `name`) register anchors → later chapter target resolution.
- Soft hyphens stripped; whitespace collapsed (`normalizeText`).
- Punctuation-only fragments can be held and prepended to the next readable paragraph.
- Scene ornaments / `<hr>` / CSS separators set `pendingSceneBreakSource`; applied only when both previous and next paragraphs have ≥8 words.
- First sane heading in a file becomes a file-chapter title fallback; each file that emits text also records a file-start paragraph for TOC fallbacks.

Minimum viable EPUB text after extraction: provisional book with **≥3 words**, else hard throw. Broader viability (≥50 words and ≥150 letters) is enforced in validation / import classification.

### 5.5 EPUB images (first-class)

Supported media types: jpeg, png, webp, gif, svg.

Embedding patterns handled:

| Pattern | Handling |
|---|---|
| `<img src>` / lazy attrs / `srcset` | Resolve against XHTML path; keep ZIP-relative pointer; `srcset` picks highest descriptor score |
| `<picture>` | One local candidate; avoid duplicate fallback emission |
| `<object data>` / `<embed src>` / `input[type=image]` / `video[poster]` | Accept supported local images |
| Inline SVG wrapping a single `<image href>` | Unwrap to referenced asset (fixes blank `data:` relative links) |
| Self-contained inline SVG | Small `data:image/svg+xml...` if under size limit and no external deps |
| Standalone SVG asset | ZIP pointer if self-contained; wrapper-unwrap if one-image; **fail/warn** if external deps (reader cannot resolve ZIP deps from an isolated SVG blob) |
| Inline / linked CSS `background-image` or `content:url` | Match rule to element; resolve URL relative to XHTML or stylesheet; anchor before that element’s text |
| Data URI | Keep only if supported type and ≤ `MAX_INLINE_IMAGE_CHARACTERS` (96 KiB) |
| Remote `http(s):` / `//` | Skip; diagnostic (offline / unstable) |
| Cover duplicate | Suppress sidecar when `src` equals cover |

Unresolved referenced images emit diagnostics in bucket `Images missing / blank / badly placed` with severity `failure` at parse time (phase-1 strict posture). Import may **soft-allow** these (see §9).

Alt text: `alt` / `aria-label` / `title` / SVG title|desc / figure caption — never synthesized from filename as publisher prose.

### 5.6 EPUB chapters

Sources evaluated in `chooseChapterSource`:

1. EPUB3 nav TOC (`nav[epub:type=toc]` / `role=doc-toc`, else first nav) — preserve full link labels (golden Pride behavior includes caption+chapter combined labels)
2. NCX `navPoint` labels
3. Heading fallback (`h1`–`h6` collected during extraction) — warning
4. File-boundary fallback — diagnostic failure (not trusted), still returned for inspection
5. Last resort: single `{ title: bookTitle, startParagraphId: 1 }`

Selection prefers usable nav over NCX when starts are sufficiently spread; collapsed starts (`distinctStarts / chapters < 0.4` when ≥4 chapters) force fallback. Targets resolve via fragment anchors then file starts.

Navigation `kind` / `level` assigned in `buildBook` via `classifyNavigationTitle` (frontmatter/part/chapter/section/scene/backmatter).

### 5.7 EPUB size / time limits

| Limit | Value |
|---|---|
| Default / absolute parser timeout | 30 000 ms |
| Structure entry max | 8 MiB |
| Content entry max | 48 MiB |
| Total content preload | 192 MiB |
| Stylesheet | 4 MiB |
| SVG asset inspect | 8 MiB |
| Inline image characters | 96 KiB |
| Max image warning diagnostics | 30 |

---

## 6. PDF extraction pipeline

Scope: **selectable-text PDFs only**. No OCR. Scanned/image-dominated books are rejected via text-quality diagnostics.

### 6.1 Load

PDF.js `getDocument` with:

- `isImageDecoderSupported: false`
- `isOffscreenCanvasSupported: false`
- `maxImageSize: 20_000_000`
- `stopAtErrors: false`
- `useWorkerFetch: false`
- verbosity errors only

Metadata + outline collected with `Promise.allSettled` (partial failure → warnings, not always abort).

Hard timeout: **30 000 ms** absolute (caller timeout clamped to this). Deadline races each async PDF.js call; on timeout, destroy loading task after pending op settles.

### 6.2 Per-page extraction

For each page:

1. `getTextContent` + `getOperatorList` in parallel
2. Position text items through viewport transform; strip nulls; compute baseline/fontSize/angle
3. **Dominant quarter-turn recovery:** if ≥80% of readable LTR/RTL characters are within 8° of ±90° and enough volume (≥20 items, ≥120 chars), re-viewport with +90/+270 so full-page sideways tables become horizontal. Mixed/true vertical remains diagnosed later as failure when ≥25% of items are vertical.
4. Cluster into lines by baseline proximity; split large horizontal gaps into column runs; join glyph gaps with whitespace/punctuation heuristics; preserve vertical items separately
5. **Two-column order** when enough left/right clusters and few spanning lines: left then right between spanning boundaries
6. Image candidates from paint image / inline image operators (with save/restore/transform/form/group matrix stack). Skip tiny masks (`<24px` side or `<4096` pixels) and near-invisible display areas. Count `declaredImageCount` for validation.

### 6.3 Page furniture

`filterRepeatedPageFurniture`:

- Drop clear copyright/DOI footers and ellipsis+page-number headers
- Across ≥3 pages, drop header/footer signatures repeating on ≥35% of pages or on odd/even parity ≥60%

### 6.4 Paragraph reconstruction

`buildParagraphs`:

1. Primary geometry mode: page-local gap clustering → typical gap + optional larger paragraph-gap cluster; breaks on large gaps, list markers, indentation after sentence end, short last line + sentence boundary, column/page changes
2. If model would fail collapsed-paragraph validation (≥1000 words and one paragraph, or largest >5000, or largest >90% of words), **retry** with conservative `hasEOL` + aligned prose + sentence-boundary recovery
3. Merge wrap-continued paragraphs across page boundaries when previous does not end a sentence
4. Promote bare `Chapter N` lines to strong headings
5. `recoverEmbeddedChapterHeadings`: only when a consecutive chapter-number sequence is spread through the book; optional compact contents sequence supplies titles without becoming duplicate chapters; strips leading `***` ornaments before recovered chapter titles
6. `stripCompactPdfContents`: remove compact contents lists from front matter before first body chapter heading
7. `inferPdfSceneBreaks`: isolated ornament lines, long embedded ornament runs (≥16 symbols with sentence context), and large page-local whitespace gaps between sentence-ended/sentence-started prose (≥8 words each)
8. `splitOversizedProseParagraphs`: only for already-oversized non-heading blocks (>500 words) with repeated sentence boundaries — split into ~180–420 word synthetic chunks. Punctuation-free collapsed text remains rejected by validation (validator not relaxed)

Heading detection (`headingKind`):

- **strong:** structural patterns (`Chapter/Part/Book/Section` + ordinal, prologue/epilogue/contents/etc., emphasized numbered titles)
- **typographic:** all-caps or larger+centered short lines

### 6.5 PDF chapters

`buildChapters`:

1. Map outline items (max 500 evaluated) to paragraphs via title match on page headings, else nearest baseline to outline target Y
2. Filter junk outline titles (`_Hlk…`, `_Toc…`, `OLE_LINK…`) at flatten time
3. Prefer outline when reliable (≥2 title-matched, or ≥3 well-spread starts, and not majority production-artifact titles like `cover.pdf` / `bookblock`)
4. Else replace with visible-heading sequence (warning) when numbered headings are reliable or production-artifact outline + reliable heading fallback
5. Failures: unmapped outlines, no outline/headings, long books (≥12 pages) with <2 chapters

### 6.6 PDF images

Pointer form (crop geometry for on-demand render from stored PDF):

```
pdf://page/<n>/image/<i>?object=<id>&x=&y=&width=&height=&pageWidth=
```

Anchoring: last paragraph on the page whose baseline is above image center (column-aware), else last paragraph from previous pages. Captions from nearby fig/plate/table/illustration lines when present. Repeated edge object IDs across ≥3 pages dropped as furniture.

Cover pointer: `pdf://page/1` (import renders first page to a data URL for the library).

### 6.7 PDF text-quality diagnostics

`addTextQualityDiagnostics`:

- Too few words/chars (<20 words or <80 chars) → unusable; message notes scanned if ≥50% pages have image ops
- ≥4 pages and <25% text pages with <20 words/page → `picture_heavy` (OCR likely)
- ≥25% vertical text items → hard other failure (reconstruction unsupported)
- Too many replacement/private-use chars → `garbled_text`

---

## 7. Shared model finalization (`buildBook`)

1. Reassign paragraph IDs to `1..N`; normalize text
2. Drop scene breaks on paragraph 1 or where a navigation entry starts at that paragraph
3. Deduplicate chapters by title+start; classify kind/level; sort by start then precedence
4. Clamp image `afterParagraphId` to `[0, paragraphCount]`; normalize alt
5. Compute totals from arrays

---

## 8. Validation (`validateParserOutput`)

Always run after parse. Merges parser diagnostics with generated ones. `pass` = no diagnostic with `severity: "failure"`.

Checks:

| Check | Hard failure condition (examples) |
|---|---|
| Text viability | <50 words or <150 letters |
| Garbled decoding | replacement+control chars >0.2% of text |
| Collapsed paragraphs | ≥1000 words and one para / largest >5000 / largest >90% |
| Empty paragraphs | any empty |
| Paragraph IDs | not exactly `index+1` |
| Scene breaks | anchored on id ≤1; ornament junk density; >35% scene-break density with >20 breaks |
| Chapters | empty; nonsense titles; invalid/non-monotonic starts; collapsed starts |
| Cover | missing → **warning**; oversized inline cover payload → failure |
| Images | invalid/non-monotonic anchors; bad PDF pointer shape; oversized `data:`; ≥3 declared but 0 extracted |
| Totals | mismatch arrays |
| Timing | `totalMs` > 30 000 |

Failure buckets (fixed tally vocabulary): Crash, No/unusable text, Bad paragraph IDs, Weak/missing/nonsense chapters, Cover missing, Images missing/blank/badly placed, Timeout/extreme slowness, Other.

---

## 9. Import soft vs hard policy (product layer)

Important for auditors: **parser severity and import disposition are not identical.**

`classifyImportDiagnostics` soft-allows (book completes openable with `processing_warnings`) for codes in `SOFT_DIAGNOSTIC_CODES`:

- `cover_missing`, `cover_inline_payload`
- `images_invalid`, `images_inline_payload`, `images_undeclared`
- `weak_chapters`
- `garbled_text`
- `ornament_junk`
- `picture_heavy`
- `empty_paragraphs`

Also any diagnostic with `severity: "warning"`.

Hard-fail (new import purged from library; restore keeps prior content) for e.g.:

- `unusable_text`, `collapsed_paragraphs`, `bad_paragraph_ids`
- `scene_break_density`, `timeout`, `totals_mismatch`, `timing_invalid`
- other non-soft `severity: "failure"`

User-facing recovery:

- New hard-fail → import the file again (no Failed-row “Retry import” UX)
- Existing completed book → Edit → **Restore to original**

Import wrapper timeout is **180 s** (`IMPORT_TIMEOUT_MS`) for the whole job (persist + parse + cover + DB). Parser quality ceiling remains **30 s**.

After soft-complete, oversized/invalid inline image payloads may still be dropped at row conversion (`toBookImageRows`), forcing an `images_missing` warning.

---

## 10. Runtime media policy (post-import)

| Asset | Storage | Load |
|---|---|---|
| EPUB in-book images | ZIP-relative path in `book_images.src` | On demand from raw EPUB in IndexedDB → `blob:` URL cache |
| EPUB inline SVG (self-contained) | `data:image/svg+xml...` | Direct |
| PDF in-book images | `pdf://page/.../image/...?crop` | Crop-render from stored PDF when needed |
| Library cover | Materialized `data:image/...;base64,...` in `books.cover_path` | Direct `<img>` |

Supported rasters: jpeg, png, webp, gif. SVG: zip asset or inline markup.

---

## 11. Explicit non-goals / out of scope

- OCR / scanned page books
- Fixed-layout EPUB, comics, manga, page-image magazines
- DRM-locked files
- Pixel-perfect publisher CSS / full layout fidelity
- Becoming a Kindle/Apple Books clone
- Promoting tiny PDF image masks / decorative form resources aggressively
- Reliable reconstruction of true vertical / mixed multi-orientation books
- Network fetches for remote images during import

---

## 12. Empirical lab results (phase 1)

Standalone corpus (`book-parser-lab`), definitive run **498/500 (99.6%)**:

| Format | Pass | Fail |
|---|---:|---:|
| EPUB 400 | 399 | 1 |
| PDF 100 | 99 | 1 |

Genuine failures retained as strict:

1. **Three Blind Mice (EPUB):** absolute `file:///` image refs absent from ZIP → blank illustration positions
2. **Finite Difference Computing… (PDF):** broken font map → 1734 control glyphs; accepting would corrupt TTS/RSVP

Performance (single worker, caffeinated): median **246 ms**, p95 **4.05 s**, 0 books over 30 s. Golden Pride and Prejudice baseline: ~130k words, 2515 paragraphs, 63 nav entries, 163 monotonic image sidecars, separate cover pointer.

Corpus: Gutenberg EPUBs + CC DOAB/OAPEN selectable-text PDFs; deterministic hashes; OCR-dependent PDFs excluded at acquisition screening.

See `book-parser-lab/REPORT.md`, `RESEARCH.md`, `EXPECTATIONS.md`, `MANUAL_QA.md`.

---

## 13. Design principles (how we approach hard cases)

1. **Consolidation first** — one library for the stack of readers people already juggle; extraction must not push them back to a specialist app.
2. **Parity over perfection** — do not need better than raw-file reading; must not feel worse for ordinary consumption of that file.
3. **Processing as advantage when cheap** — reflow, mobile measure, scene separators, shared position, TTS/RSVP — when it improves readability without lying about the book.
4. **App model first** — extraction serves `{paragraphId, wordIndex}`, not a live CSS viewer.
5. **Pointers over materialization** — do not base64 every illustration into SQLite at import; one library cover is enough to materialize.
6. **Trust the user (soft vs hard)** — flawed-but-usable completes with warnings; only unusable/unsafe models hard-fail and leave the library.
7. **Prefer publisher navigation labels as supplied** when targets resolve; fall back with diagnostics rather than inventing fake structure silently.
8. **PDF paragraphs are reconstructed, not trusted** — glyphs → geometry + sentence context + conservative recovery; validator stays authoritative (Alice-in-Wonderland-style collapsed spacing is a real regression class we already hit).
9. **Outline distrust** — Office/InDesign junk bookmarks and production filenames lose to reliable visible heading sequences.
10. **Scene boundaries are anonymous** — ornaments/HR/CSS/whitespace become quiet separators (not raw `***` junk in the prose stream when we can help it); named nav wins on collision.
11. **Killable time budget** — 30 s quality ceiling so pathological files cannot hang the device.
12. **Do not OCR** — refuse rather than invent text for scans.
13. **Images are normal-reading chrome** — RSVP/TTS stay on text; missing images should not kill the book.

---

## 14. Real issues already seen (conversation- and device-backed)

These are the failure modes and product tensions that keep coming up — prioritize auditing against these over abstract EPUB edge-case tourism.

| Issue | Why it matters for consolidation |
|---|---|
| **Missing / blank images** while text is fine | User opens illustrated book in another reader → pictures work; in ours → blanks. Feels worse. Soft-warn path exists; fidelity still needs to match “crazy EPUB embedding shit.” |
| **Collapsed PDF paragraphs** (modest spacing → one giant block) | Real device fail: Alice PDF ~7k/26k words in one paragraph → hard reject of a perfectly selectable book. Recovery passes exist; must stay effective without weakening true garbage rejection. |
| **Raw `****` ornaments instead of scene separators** | PDF path used to leave asterisk runs in prose while EPUB got quiet separators — feels cheaper than AlReader/EPUB path. |
| **Chapter / label / progress mismatch** | Frankenstein Letter 2 @ 100% → Letter 3 @ 4%; PDF divider before label updates. Makes TOC/progress feel less trustworthy than raw TOC. |
| **TTS reading text the eye does not see** | e.g. “Chapter 2” spoken when UI shows a separator glyph — mode parity bug; extraction + display contract must stay aligned. |
| **Garbled math / font-map PDFs** | Soft-allowed; TTS/RSVP may gibber. User is warned, modes stay on — intentional autonomy. |
| **Import feels slow vs specialist apps** | Full-book preprocess before first word vs industry lazy open. Model is justified; time-to-first-word is the fair cost critique. |
| **PDF comfort vs PDF fidelity** | We win handheld readability; ReadEra wins source-page truth. Consolidation needs both “comfortable” and “I don’t miss the original layout” for text PDFs. |
| **Part/hierarchy separator noise** | Monte Cristo-style part diamonds / start-of-book separators — low severity but visible polish debt (`Dev/REVISIT.md`). |
| **Cover / chapter metadata wrong or weak** | Library trust and navigation trust; covers must be displayable; chapters should match what a normal reader’s TOC implies when possible. |

---

## 15. Known technical limitations / open risks

- Publisher-damaged EPUBs with missing assets cannot be reconstructed truthfully; soft-complete may still leave blank spots unless images were dropped.
- PDF font maps can look fine visually while extracting private-use/control glyphs; soft-warn rather than font-specific repair.
- Multi-column PDF order is heuristic; pathological layouts may mis-order.
- PDF image anchors are approximate (operator position among text), not semantic figure association.
- Complex SVG with external ZIP dependencies cannot be one stable blob pointer.
- Synthetic PDF paragraph splitting improves RSVP/TTS chunking but is not original paragraph semantics — can feel “re-edited.”
- File-boundary EPUB chapters are untrusted (diagnostic) yet may appear before import classification.
- Import soft-allows several parser `failure` severities — product contract is `diagnosticCodes.ts` + `importDiagnostics.ts`, not raw validator `pass`.
- Vertical/rotated mixed pages beyond dominant quarter-turn tables remain unsupported.
- No DRM, no OCR, no fixed-layout comics path by design.
- No in-app “Source vs App” fidelity toggle yet (discussed as the right field test); lab corpus ≠ user’s real shelf judgment.

---

## 16. Suggested audit questions (aligned to north star)

**Parity / “not worse”**

1. For popular reflowable EPUBs and selectable-text PDFs, where would a picky reader still prefer AlReader/ReadEra/raw file — and is that extraction, UI chrome, or inherent non-goals (CSS fidelity, page geometry)?
2. Are image embedding patterns covered enough that illustrated books rarely feel broken vs a traditional EPUB viewer?
3. Do PDF paragraph/chapter/scene reconstructions preserve reading rhythm, or do they create “reprocessed novel” feel (giant blocks, wrong breaks, leftover `***`, missing separators)?
4. Is chapter navigation trustworthy enough that TOC/progress won’t make people distrust the whole app?

**Consolidation / multi-mode**

5. Does the soft-warn policy for images + garbled text correctly support “one app for EPUB+PDF+TTS+RSVP,” or should garbled text harder-gate speech/speed?
6. Any cases where normal reading, RSVP, and TTS diverge (spoken-only headings, image alts bleeding, separator vs title)?

**Cost / advantage**

7. Is the full-book-before-readable gate still justified, or should first-chunk readability land without weakening `{paragraphId, wordIndex}` integrity?
8. Pointer media + on-demand load: right efficiency story for mobile, or still too much import work?

**Safety**

9. Integrity holes where a soft-completed book can produce unsafe position streams?
10. Are 30 s parser / 180 s import ceilings and hard-fail purge/restore rules correct for real devices?

---

## 17. Conversation / decision provenance (for auditors)

| Theme | Where it was worked |
|---|---|
| Why preprocess / industry contrast | Codex: Find well-made OSS reader app; DOCUMENTATION “Why The App Preprocesses Books” |
| EPUB vs Readium/KOReader/Foliate | Codex: Compare EPUB parsing |
| Lab → production integration Qs | Codex: Execute EXPECTATIONS.md; “pushed changes for processing books…” |
| Soft vs hard, trust user, no Failed rows | Cursor: library failure-mode thinking; Soft vs hard import plan |
| Field-test Source vs App | Cursor: extraction quality evaluation idea |
| Alice PDF collapsed paragraphs; PDF ornaments | Codex: Fix PDF import regression |
| AlReaderX / ReadEra / us comparison | Codex viz: reader-experience-comparison (2026-07-14) |
| Part separators / hierarchy noise | Cursor → `Dev/REVISIT.md` |
| Covers + in-book images plans | Cursor implement threads; later pointer policy |

---

## 18. Quick reproduction pointers

```sh
# Unit tests covering parser behaviors
bun test src/lib/bookParser

# Lab package (standalone corpus tooling)
cd book-parser-lab && bun install && bun run test && bun run check

# Single-file lab parse
bun run parse -- /absolute/path/book.epub --output /tmp/out.json
```

Production entry for auditors reading code:

```ts
parseBookBytes({ sourceBytes, sourceName, timeoutMs?, signal?, onPhaseChange? })
```
