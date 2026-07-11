# Book Parser Lab -- Final Phase-1 Report

## Result

> Post-review hardening note: the parser was subsequently updated to preserve
> mixed-container prose, anchor inline media in DOM order, discover embedded and
> linked stylesheet images, and reject complex externally dependent SVG assets.
> A separate full rerun in `results/post-review-hardened/` again passed 498/500
> books with the same two genuine failures and no new crash, timeout, chapter,
> image, or paragraph-ID failures. The performance figures below remain from the
> definitive single-worker `final-500-caffeinated` run because the hardening
> verification used four workers for faster regression feedback.

The standalone Mac-only parser passed **498 of 500 books (99.6%)** in the
definitive run:

| Format | Total | Passed | Failed |
|---|---:|---:|---:|
| EPUB | 400 | 399 | 1 |
| PDF | 100 | 99 | 1 |
| **All** | **500** | **498** | **2** |

The exploratory 250-book run had fewer than 20 failures, so the corpus was
expanded to the required 500-book cap. Only two genuine failures remained; no
failures were manufactured to reach the target of 20.

Definitive artifacts:

- [Generated Markdown report](results/final-500-caffeinated/report.md)
- [Generated HTML report](results/final-500-caffeinated/report.html)
- [Machine-readable summary](results/final-500-caffeinated/summary.json)
- [Exact corpus manifest snapshot](results/final-500-caffeinated/corpus-manifest.json)
- [Manual QA evidence](MANUAL_QA.md)
- [Structure and image research](RESEARCH.md)

## Genuine failures

1. **Complete Version of ye Three Blind Mice** (EPUB) --
   `Images missing / blank / badly placed`.
   The publication contains absolute publisher-build references to
   `page8.jpg`, `page20.jpg`, and `page31.png`, but those files are absent from
   the EPUB ZIP. Text, 8 navigation entries, and 52 other images extract, but a
   reader would still show blank illustration positions.
   [Failure preview](results/final-500-caffeinated/previews/pg-26060.html)
2. **Finite Difference Computing with Exponential Decay Models** (PDF) --
   `No / unusable text`.
   All 210 pages have a selectable layer, but the embedded font mapping emits
   1,734 control glyphs (0.423% of 410,333 extracted characters), including
   mathematical notation and bullets. Silently accepting it would corrupt TTS
   and speed-reading text.
   [Failure preview](results/final-500-caffeinated/previews/doab-746e13bf-6e83-4d59-a313-61d51351512f.html)

## Diagnostic tally

Counts are distinct books. Warnings do not fail a book.

| Bucket | Failures | Warnings |
|---|---:|---:|
| Crash | 0 | 0 |
| No / unusable text | 1 | 0 |
| Bad paragraph IDs | 0 | 0 |
| Weak / missing / nonsense chapters | 0 | 4 |
| Cover missing | 0 | 0 |
| Images missing / blank / badly placed | 1 | 0 |
| Timeout / extreme slowness | 0 | 0 |
| Other | 0 | 0 |

The four chapter warnings are explicit recoveries or bounded large outlines:
C-SPAN and *Putting a Face on It* replaced one junk bookmark with reliable
numbered headings; two large technical books exposed more than 500 outline
entries and were capped for evaluation.

## Performance

- Median end-to-end worker time: **246 ms**
- p95: **4.05 s**
- EPUBs over the 5-second target: **1**
- PDFs over the 10-second target: **0**
- Books over the absolute 30-second ceiling: **0**

The one EPUB over target is the 4.55-million-word Webster dictionary. It still
completed in 20.51 seconds. Lazy format dispatch was important here: EPUB
workers no longer load the PDF.js runtime.

The definitive run used one parser worker at a time under `caffeinate -i`, so
per-book timing was not distorted by CPU contention or Mac idle sleep.

## What went well

- Output matches the app-owned paragraph/chapter/image/cover model, with the
  production whitespace-token definition used for shared word positions.
- Pride and Prejudice matches the supplied reading baseline: 130,142 words,
  2,515 paragraphs, 63 navigation entries, 163 monotonic image sidecars, and a
  separate pointer cover.
- EPUB 2/3 navigation, NCX, weak TOCs, nested anchors, div soup, non-linear
  spines, many-file and single-file books, SVG image wrappers, `srcset`,
  object/embed, CSS backgrounds, and inline images are covered by parser tests.
- PDF text reconstruction handles repeated furniture, same-baseline columns,
  image operator identity/order, credible outlines, junk-outline fallback, and
  dominant full-page quarter-turned tables.
- All media remains pointer-based. Failure previews materialize only a bounded
  local view; parser output does not embed every illustration as giant text.
- The corpus is deterministic and resumable. Every selected item records its
  legal source, license, byte length, and SHA-256 hash.

## What went poorly

- Publisher files can be internally damaged even when the surrounding EPUB is
  readable; missing assets cannot be reconstructed truthfully.
- PDF font maps can make a visually correct page extract as control codes. A
  later phase may investigate font-specific repair, but phase 1 correctly fails
  instead of inventing mathematical symbols.
- PDF outlines are not inherently trustworthy. Several real books contained
  internal implementation names or a lone junk bookmark, requiring confidence
  checks against visible heading sequences.
- One acquired PDF had only 1 selectable page out of 384. It was correctly
  classified as OCR-dependent, persisted as `excluded`, and replaced with the
  in-scope *Brexit and Beyond* before the final evaluation.

## Corpus and method

The selected corpus is exactly 400 EPUBs and 100 selectable-text PDFs
(approximately 1.62 GB). EPUBs come from Project Gutenberg's permitted robot
harvest/mirror and official catalog. PDFs come from explicitly
Creative-Commons DOAB/OAPEN records. Acquisition validates signatures and size,
screens PDF text scope without filtering out screening errors, and continues
through failed/excluded candidates until the exact mix is complete.

Every selected book ran in a separate killable process with a hard 30-second
ceiling. All 500 outputs were automatically checked for usable text, sequential
paragraph IDs, sane chapter starts/titles, pointer-based monotonic image anchors,
cover policy, totals, timing, and model shape. Every failed book has an HTML
preview. Representative illustrated EPUBs, PDFs, repaired patterns, the excluded
scan, and both final failures were manually inspected; see [MANUAL_QA.md](MANUAL_QA.md).

## Recommended next step

Keep the parser standalone until the product owner accepts this report and the
two strict failures. For phase 2, decide the desired user-facing fallback policy
for damaged images and corrupt PDF font maps, then design app integration around
pointer media and the existing `{ paragraphId, wordIndex }` progress model.

Further hardening can research uncommon PDF image masks/form-contained graphics
and richer font repair. OCR, fixed-layout comics, DRM, full CSS fidelity, and
pixel-perfect page reproduction remain intentionally out of scope.

No production import/reader code, Android project, APK, phone state, or ADB path
was touched.

## Validation

- `bun run check` -- passed
- `bun run test` -- 37 tests passed after post-review hardening
- `bun run build` -- passed
- Root `bun test` -- passed
- Root `bun run lint` -- unavailable because the repository has no ESLint
  configuration; no tooling configuration was added without approval
