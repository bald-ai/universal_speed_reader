# Plan: Hard paragraph upper bound (early reject) — final

## Goal
Hard-cap imports at **50,000 paragraphs**. Clean reject before unsafe validator work and before post-parse import side effects.

## Non-goals
No classifier, no import-anyway, no word/nav caps, no mid-parse abort, no Android benchmarks, no unrelated file cleanups.

## Why 50k
Known-good ~12–15k paragraphs; Shakespeare ~143k / Webster ~431k fail. 50k rejects outliers with margin.

## Problem today
`parseBookBytes` always validates; `validateText` uses `Math.max(0, ...paragraphWordCounts)` and can stack-overflow before import service sees the count.

## Design (fully decided)

### Constant + error bucket
- `export const MAX_BOOK_PARAGRAPHS = 50_000` in `src/lib/bookParser/validate.ts`.
- Re-export from `src/lib/bookParser/index.ts`.
- `bookImportService.ts` imports `{ MAX_BOOK_PARAGRAPHS }` from `@/lib/bookParser` only.
- Add `"Book too large"` to `ImportErrorBucket` in `src/types/storage.ts`.

### `parseBookBytes` contract (unchanged)
Always resolves; assigns validation diagnostics; does not throw on `pass: false`. Keep that.

### Parser gate
Start of `validateParserOutput`, before `validateText`:
- Predicate: `book.paragraphs.length > MAX_BOOK_PARAGRAPHS`
- Diagnostic: `code=too_many_paragraphs`, `severity=failure`, `bucket="Other"`,
  `message=\`This book has ${book.paragraphs.length} paragraphs; maximum supported is ${MAX_BOOK_PARAGRAPHS}.\``
- `diagnostics = deduplicateDiagnostics([...book.diagnostics, limitDiagnostic])`
- Return immediately `{ pass: false, diagnostics }`

### Safe max
Replace spread max with:
```ts
let largestParagraphWords = 0;
for (const count of paragraphWordCounts) {
  if (count > largestParagraphWords) largestParagraphWords = count;
}
```
Empty array ⇒ `0`.

### Import gate
Immediately after `const parsed = await withTimeout(...parseBookBytes...)`:
```ts
const paragraphCount = parsed.book.paragraphs.length;
if (paragraphCount > MAX_BOOK_PARAGRAPHS) {
  throw new ImportFailure(
    "Book too large",
    `Book too large: this book has ${paragraphCount} paragraphs; maximum supported is ${MAX_BOOK_PARAGRAPHS}.`,
  );
}
```
Then existing persist/checks/classify/chunk/cover/replace. No `importDiagnostics` special-case.

Exact user-visible string (new import + restore):  
`Book too large: this book has ${paragraphCount} paragraphs; maximum supported is 50000.`  
(`formatFailure` returns message unchanged because it already starts with the bucket.)

### New import vs restore
- New import: purge provisional row; `terminalOutcomes.get(bookId).error` equals that string.
- Restore: flags already keep prior content; throws `Error` with that same string; book + prior chunks remain; `terminalOutcomes` failed with that error.

## Tests
1. `validateParserOutput` @ 50,000: no `too_many_paragraphs`.
2. @ 50,001, `chapters=[]`, one pre-seeded warning: one `too_many_paragraphs` (`Other`); pre-seeded kept; `weak_chapters`, `timing_invalid`, `totals_mismatch` absent.
3. In parser tests: `spyOn` `parseEpub` to return a 50,001-paragraph book; call `parseBookBytes` with dummy `.epub` bytes/name; assert resolves and diagnostics include `too_many_paragraphs`; `afterEach` calls `mock.restore()`. Do **not** use Bun `mock.module`.
4. Collapsed-paragraph fixture under the cap: `paragraphs=[{id:1,text: ("word ".repeat(6000)).trim()}]`, `totals.words=6000`, valid minimal chapters/cover/timings as required by fixture helpers; expect a `collapsed_paragraphs` failure diagnostic (proves iterative max path ran).
5. New-import oversize: in import tests, use `__setParseBookBytesForTests` so `parseBookBytes` resolves with 50,001 paragraphs; await terminal; assert:
   - `service` terminal outcome / `getTerminalOutcome(bookId)` (use whatever existing test helper exposes `terminalOutcomes`) status `failed` and error exactly  
     `Book too large: this book has 50001 paragraphs; maximum supported is 50000.`
   - `repository.getBook(bookId)` is `null`
   - `repository.listChunks(bookId)` (or equivalent existing API) is empty
   After the test (or in `afterEach`): restore the module mock so later tests see the real parser (`mock.restore()` / re-import pattern used by Bun).
6. Restore oversize with the same mock + same `afterEach` restore: `restoreOriginalBook` rejects with that exact message; book still present; prior chunk count unchanged.

## Files to change
- `src/lib/bookParser/validate.ts`
- `src/lib/bookParser/diagnosticCodes.ts`
- `src/lib/bookParser/index.ts`
- `src/types/storage.ts` (`ImportErrorBucket`)
- `src/lib/import/bookImportService.ts`
- `src/lib/bookParser/parser.test.ts` (or new `validate.paragraphCap.test.ts` if cleaner)
- `src/lib/import/bookImportService.test.ts`
- `DOCUMENTATION.md`

## Docs
Insert under the existing import/preprocessing section in `DOCUMENTATION.md` (after the normalized-model bullet list, before “Normal reading toolbar”) this exact paragraph:

`Imports hard-fail above 50,000 paragraphs. Oversized new imports are purged from the library and reported in Last import; use a smaller or split source file. Restore to original keeps the previous completed book if restore hits the same limit.`

## Verification
`bun run lint`, full tests, `bun run build`.

## Acceptance
≤50k success unchanged (safer max). >50k: no stack overflow; exact `"Book too large..."` string; no post-parse persist/patch/classify/chunk/cover/replace; new import purged; restore keeps content and throws the same string.
