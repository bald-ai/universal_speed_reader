# Plan: Hard paragraph upper bound (early reject) — v2

## Goal
Add a hard maximum of **50,000 paragraphs** per imported book. Reject oversized books with a clean, intentional failure **before** unsafe validator work and **before** post-parse import side effects. This is a product safety guardrail, not a measured Android ceiling.

## Non-goals
- No content-type classifier (dictionary vs novel).
- No “import anyway” escape hatch.
- No word-count / navigation-count caps.
- No mid-parse streaming abort (full parse may still run; reject as soon as count is known).
- No Android device benchmarking in this change.
- No drive-by fixes in unrelated files (e.g. `pdf-content.ts`).

## Why 50k
Known-good long novels sit ~12–15k paragraphs. Known disasters: Shakespeare ~143k, Webster ~431k. 50k is ~3–4× known-good and rejects the outliers.

## Problem today
1. `parseBookBytes` always runs `validateParserOutput` after parse ([index.ts](src/lib/bookParser/index.ts)).
2. `validateText` does `Math.max(0, ...paragraphWordCounts)`, which throws `RangeError` on ~143k+ elements ([validate.ts](src/lib/bookParser/validate.ts)).
3. That crash happens **inside** `parseBookBytes`, so an import-service-only check never runs for the crash path.
4. After a successful parse return, import still does `ensureTaskSourcePersisted`, optional metadata patch, then empty/id checks, diagnostics, chunking, cover, `replaceBookContent` ([bookImportService.ts](src/lib/import/bookImportService.ts) ~1008+).

## Resolved design decisions

### Constant ownership
- Define and export `MAX_BOOK_PARAGRAPHS = 50_000` in the **parser layer** (same module family as `validate.ts` / parser resource limits).
- `bookImportService.ts` **imports** that constant for its defensive product gate.
- Do **not** define the canonical constant in the import service.
- Lab scripts are out of scope unless they already import app validate; no requirement to share into `book-parser-lab` in this change.

### Parser gate (required; prevents crash)
At the **start** of `validateParserOutput`, **before** `validateText` (and all other validators):

1. If `book.paragraphs.length > MAX_BOOK_PARAGRAPHS`:
2. Create a hard diagnostic:
   - `code`: `DiagnosticCode.too_many_paragraphs` (new; hard; not in `SOFT_DIAGNOSTIC_CODES`)
   - `severity`: `"failure"` (explicit)
   - `bucket`: `"Other"` (or keep consistent with other hard non-text failures)
   - `message`: include actual count and cap, e.g. `This book has 142796 paragraphs; maximum supported is 50000.`
3. Merge/deduplicate with existing `book.diagnostics` (do not drop pre-existing diagnostics).
4. Return `{ pass: false, diagnostics }` **without** running remaining validators.

### Safe max loop (crash fix even under the cap)
Replace `Math.max(0, ...paragraphWordCounts)` with an iterative max in `validateText` only. No unrelated spread cleanups.

### Import defensive gate (product copy + skip post-parse work)
Insert **immediately after** `await withTimeout(...)` returns `parsed`, and **before**:
- `ensureTaskSourcePersisted`
- metadata `patchBook` for source/size drift
- empty/sequential paragraph checks
- `classifyImportDiagnostics`
- chunk/cover/`replaceBookContent`

Throw:

```ts
new ImportFailure(
  "Book too large",
  `Book too large: this book has ${count} paragraphs; maximum supported is ${MAX_BOOK_PARAGRAPHS}.`
)
```

Notes:
- `importDiagnostics.ts` does **not** create this category. Today classifier hard-fails become `"Book content not reliable"`. The `"Book too large"` category comes from this **explicit import-service branch**.
- With the parser short-circuit, `parseBookBytes` still returns successfully with a failure diagnostic. The import gate should prefer the explicit count check (and may optionally also map `too_many_paragraphs` if classification is reached — but primary path is the immediate count throw so post-parse side effects never run).
- Because the parser gate short-circuits validation, classification alone is insufficient for the desired category string; keep the explicit import branch.

### New import vs Restore
- **New import**: `purgeOnHardFailure: true` — provisional library row is purged; outcome retained for Last import. No Failed-row / Retry-import UX.
- **Restore to original**: already queues with `clearExistingContentBeforeParse: false` and `purgeOnHardFailure: false` (comment: keep prior content until replace succeeds). Oversize restore must leave previously completed content intact and surface the failure without purging the book.
- Tests must cover both paths; if any restore ordering bug appears, fix clearing/rollback rather than assuming the flags alone.

## Tests
1. `validateParserOutput` at **50,000**: no `too_many_paragraphs` failure from the cap (other validators may still run).
2. `validateParserOutput` at **50,001**:
   - one `too_many_paragraphs` failure
   - pre-seeded `book.diagnostics` preserved after merge/dedupe
   - no diagnostics that only later validators could produce (proves short-circuit)
3. Safe-max: unit-test the iterative max helper (or in-limit fixture that reaches the largest-paragraph check) so the old spread path is not required for the assertion; do **not** treat “20k no throw” as proof.
4. Import service new-import oversize:
   - exact `ImportFailure` category `"Book too large"` and message shape
   - provisional row purged
   - assert no content replace / no chunk rows after failure
5. Restore oversize (or mocked oversize parse): completed prior content remains; book not purged.

## Docs
Short note in `DOCUMENTATION.md`: max 50k paragraphs; oversize hard-fails; new imports purged from library and shown via Last import; user needs a smaller/split source (not “Retry import”).

## Implementation order
1. Constant + `DiagnosticCode.too_many_paragraphs` in parser layer.
2. Short-circuit at top of `validateParserOutput` + iterative max in `validateText`.
3. Import-service gate immediately after `withTimeout(...)` with `"Book too large"`.
4. Tests + docs.
5. `bun run lint` / targeted tests.

## Acceptance
- ≤ 50k paragraphs: success path unchanged (aside from safer max loop).
- > 50k: clean hard-fail with explicit paragraph-limit messaging; no stack overflow; no chunk persistence for new imports; new-import row purged; restore keeps prior content.
- No open product questions left for implementer on constant ownership, gate placement, or failure category.
