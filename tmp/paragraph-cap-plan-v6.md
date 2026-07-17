# Plan: Hard paragraph upper bound (early reject) — v6

## Goal
Hard-cap imports at **50,000 paragraphs**. Clean reject before unsafe validator work and before post-parse import side effects.

## Non-goals
No classifier, no import-anyway, no word/nav caps, no mid-parse abort, no Android benchmarks, no unrelated file cleanups.

## Why 50k
Known-good ~12–15k paragraphs; Shakespeare ~143k / Webster ~431k fail. 50k rejects outliers with margin.

## Problem today
`parseBookBytes` always validates; `validateText` uses `Math.max(0, ...paragraphWordCounts)` and can stack-overflow before import service sees the count.

## Design (fully decided)

### Constant
- Exact export: `export const MAX_BOOK_PARAGRAPHS = 50_000` in [`src/lib/bookParser/validate.ts`](src/lib/bookParser/validate.ts) (alongside `MAX_INLINE_MEDIA_LENGTH`).
- Also re-export it from [`src/lib/bookParser/index.ts`](src/lib/bookParser/index.ts).
- `bookImportService.ts` imports `{ MAX_BOOK_PARAGRAPHS }` from `@/lib/bookParser` (or `validate`); does not redefine it.
- Add `"Book too large"` to the `ImportErrorBucket` union in `bookImportService.ts`.

### `parseBookBytes` contract (unchanged)
Today `parseBookBytes` always resolves: it assigns `validateParserOutput(...).diagnostics` onto the book and returns. It does **not** throw when `pass: false`. Keep that contract. The import gate relies on it.

### Parser gate
At start of `validateParserOutput`, before `validateText`:
- If `paragraphs.length > MAX_BOOK_PARAGRAPHS`, add failure diagnostic:
  - `code`: `DiagnosticCode.too_many_paragraphs` (new hard code; not in `SOFT_DIAGNOSTIC_CODES`)
  - `severity`: `"failure"`
  - `bucket`: `"Other"`
  - `message`: `This book has ${n} paragraphs; maximum supported is ${MAX_BOOK_PARAGRAPHS}.`
- Diagnostics = `deduplicateDiagnostics([...book.diagnostics, limitDiagnostic])` (existing key: code/bucket/severity/message).
- Return `{ pass: false, diagnostics }` immediately.

### Safe max
In `validateText` only, replace:
`const largestParagraphWords = Math.max(0, ...paragraphWordCounts);`
with an inline loop:
```ts
let largestParagraphWords = 0;
for (const count of paragraphWordCounts) {
  if (count > largestParagraphWords) largestParagraphWords = count;
}
```
Empty `paragraphWordCounts` ⇒ `0` (same as current `Math.max(0, ...[])`).

### Import gate
Immediately after `await withTimeout(...parseBookBytes...)` returns, before `ensureTaskSourcePersisted` / metadata patch / empty-id checks / `classifyImportDiagnostics` / chunk/cover/replace:

Exact strings:
- `ImportFailure.bucket` = `"Book too large"`
- `ImportFailure.message` = `` `Book too large: this book has ${n} paragraphs; maximum supported is ${MAX_BOOK_PARAGRAPHS}.` ``
- Because message already starts with the bucket, `formatFailure` returns that message unchanged.
- New-import Last import / `terminalOutcomes.error` = that same string.
- Restore: `restoreOriginalBook` throws `new Error(formatFailure(failure))` ⇒ same string; `terminalOutcomes.error` = same string.

**No** special-case mapping in `importDiagnostics.ts`. Classification is never reached for oversize on the happy gate path. Do not add an optional secondary mapper.

### New import vs restore
- New import: purge provisional row; Last import / `terminalOutcomes` keeps the failure.
- Restore: existing `clearExistingContentBeforeParse: false` + `purgeOnHardFailure: false` keep prior content. Failure surfaces as: `restoreOriginalBook` throws `Error` whose message is the formatted `"Book too large..."` string; book row remains; prior chunks remain; `terminalOutcomes` records failed with that error.

## Tests
1. `validateParserOutput` @ 50,000: no cap failure.
2. `validateParserOutput` @ 50,001 with empty `chapters` and a pre-seeded warning diagnostic: expect exactly one `too_many_paragraphs` failure (bucket `"Other"`); pre-seeded diagnostic still present; assert `weak_chapters` is **absent** (chapter validator skipped) and `timing_invalid`/`totals_mismatch` absent.
3. `parseBookBytes` must be invoked: use Bun `mock.module` so `parseEpub` (or PDF parse) returns a synthetic 50,001-paragraph `ParserOutput` body; assert `parseBookBytes` **resolves** (does not throw) and `book.diagnostics` includes `too_many_paragraphs`.
4. In-limit collapsed-paragraph fixture exercises inline iterative max.
5. Import new-import oversize: `mock.module` `parseBookBytes` to return 50,001 paragraphs; assert:
   - failure category/message via `terminalOutcomes` / Last-import error text: `"Book too large"` / includes count + 50000
   - book purged from repository
   - zero chunk rows
   - no cover/title promotion from parsed metadata (title stays filename-derived provisional)
   Observation method: Bun module mocks + `InMemoryBookRepository` observables (existing test style). No DI refactor for private-method spies.
6. Restore oversize with same `parseBookBytes` mock: throws message containing `Book too large`; book still present; prior chunk rows unchanged; not purged.

## Docs
One short `DOCUMENTATION.md` note: 50k paragraph max; oversize hard-fails; new imports purged and shown in Last import; use a smaller/split source.

## Implementation order
1. Constant + diagnostic code + validate short-circuit + inline max.
2. Import gate after `withTimeout`.
3. Tests + docs.
4. Gate: `bun run lint`, full tests, `bun run build`.

## Acceptance
- ≤50k unchanged success path (plus safer max).
- >50k: no stack overflow; `"Book too large"`; no post-parse persist/patch/classify/chunk/cover/replace; new import purged; restore preserves content and throws the same failure text.
