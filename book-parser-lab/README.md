# Book Parser Lab

Standalone, Mac-only phase-1 parser and corpus evaluator for reflowable EPUBs
and selectable-text PDFs. It emits the Universal Speed Reader logical model;
it is not wired into the production app.

The acceptance contract is [`EXPECTATIONS.md`](EXPECTATIONS.md). Structure and
image findings are in [`RESEARCH.md`](RESEARCH.md). The completed outcome is in
[`REPORT.md`](REPORT.md), with spot-check evidence in [`MANUAL_QA.md`](MANUAL_QA.md).

## Setup and checks

```sh
cd book-parser-lab
bun install
bun run check
bun run test
bun run build
```

Dependencies are isolated in this folder. No Android command is part of the
lab workflow.

## Parse one book

```sh
bun run parse -- /absolute/path/book.epub --output results/book.json
bun run parse -- /absolute/path/book.pdf --output results/book.json
```

The JSON contains sequential paragraphs, chapter starts, pointer-based image
sidecars, a separate cover, app-compatible word totals, diagnostics, and
timings. A strict diagnostic makes the command exit non-zero while retaining
the inspectable output when possible.

## Reproduce the corpus and evaluation

```sh
# Minimum 80/20 phase-1 corpus: 200 EPUB + 50 PDF
bun run download-corpus -- --target 250

# Evaluate all selected manifest items and populate the required Desktop sets
bun run evaluate

# Complete policy: start at 250, extend by 50 while fewer than 20 genuine
# failures are found, and stop no later than 500.
bun run run:overnight

# Reproduce the definitive cap run without Mac idle sleep skewing timeouts.
bun src/cli.ts download-corpus --target 500 --epubs 400 --pdfs 100
caffeinate -i bun src/cli.ts evaluate --corpus ./corpus \
  --results ./results/final-500-caffeinated --concurrency 1
```

Useful overrides:

```sh
bun src/cli.ts download-corpus --target 250 --corpus /path/to/corpus --concurrency 4
bun src/cli.ts evaluate --corpus /path/to/corpus --results /path/to/results --no-desktop
bun src/cli.ts overnight --target 250 --cap 500 --target-failures 20
```

Acquisition is resumable. `corpus/manifest.json` records title, author, source,
effective download, license, selection reason, byte length, hash, and status.
Project Gutenberg files come from its documented robot harvest/mirror. PDFs
come from explicitly Creative-Commons DOAB/OAPEN book records. A bounded PDF.js
scope gate persists selectable-page evidence, excludes OCR-dependent scans, and
downloads replacements; screening errors remain eligible for real parser
evaluation so hard files are not selected away.

Each evaluation uses a separate process group and an absolute 30-second kill
deadline. Reports are written to `results/latest/` by default. Failed books get
bounded HTML previews; referenced EPUB preview assets are materialized only for
that diagnostic view, while the parser model remains pointer-based.

The definitive artifacts are in `results/final-500-caffeinated/`, including the
Markdown/HTML reports, all 500 records, failure previews, parsed outputs, and a
snapshot of the exact licensed corpus manifest with SHA-256 hashes.

Final classification is placed at the exact required paths:

- `/Users/michalkrsik/Desktop/good books`
- `/Users/michalkrsik/Desktop/bad books`

The classifier uses a stable ledger and removes only unchanged links/copies it
previously created. Unknown Desktop files are never deleted.

## Phase-1 interpretation

- Cover missing is tallied as a warning and does not fail a book alone.
- Fixed-layout EPUB, DRM, OCR/scanned PDF, and comics are out of scope and fail
  clearly when detected.
- Under-5-second EPUB and under-10-second PDF targets are reported; anything
  beyond 30 seconds is an automatic failure.
- Passing automation is necessary but not sufficient. The generated report
  records manual Pride, illustrated-book, difficult-PDF, and failure-preview
  spot checks before any integration decision.
