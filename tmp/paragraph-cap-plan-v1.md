# Plan: Hard paragraph upper bound (early reject)

## Goal
Add a hard maximum of **50,000 paragraphs** per imported book. Reject oversized books with a clean, intentional failure **before** post-parse import work (chunking, cover, SQLite content replace) and **before** validator code that can crash on giant arrays. This is a product safety guardrail, not a measured Android ceiling.

## Non-goals
- No content-type classifier (dictionary vs novel).
- No “import anyway” escape hatch.
- No word-count / navigation-count caps in this change.
- No mid-parse streaming abort unless it falls out cheaply; full parse may still run.
- No Android device benchmarking in this change.

## Why 50k
Known-good long novels sit ~12–15k paragraphs (War and Peace, Monte Cristo). Known disasters: Shakespeare ~143k, Webster ~431k. 50k is ~3–4× known-good and rejects the outliers.

## Problem today
1. `parseBookBytes` always runs `validateParserOutput` after parse.
2. `validateText` does `Math.max(0, ...paragraphWordCounts)`, which throws `RangeError: Maximum call stack size exceeded` on ~143k+ elements.
3. Import then chunks/persists only after validation returns. Giant books can die inside validation with a stack overflow rather than a product limit message.
4. Existing pre-parse gates only cover format + 150 MB source size.

## Design

### Constant
- Add `MAX_BOOK_PARAGRAPHS = 50_000` next to other import/parser resource limits (prefer `bookImportService.ts` or a tiny shared constant module used by both import and parser validate — pick one source of truth, export it).

### Early check location (critical)
Check paragraph count in **two coordinated places**:

1. **Primary product gate (import service)** — immediately after `parseBookBytes` returns, before:
   - empty/sequential paragraph checks that are fine to keep,
   - `classifyImportDiagnostics`,
   - `chunkParagraphs` / cover / `replaceBookContent`.

   Prefer ordering:
   ```
   parseBookBytes
   → if paragraphs.length > MAX → ImportFailure (hard purge path for new imports)
   → existing empty/id checks
   → classifyImportDiagnostics
   → persist
   ```

   Actually: validation currently runs *inside* `parseBookBytes`. So the Math.max crash happens **before** the import service can see the count. Therefore the gate must also exist **inside the parser path before the unsafe validate work**.

2. **Parser-path gate (required for “ahead of time”)** — in `parseBookBytes` (or at the start of `validateParserOutput` / `validateText`):
   - If `book.paragraphs.length > MAX_BOOK_PARAGRAPHS`, emit a hard failure diagnostic (or throw a typed parser/import error) and **skip** the `Math.max(...array)` path and other O(n) validate work that is unnecessary once over the cap.
   - Prefer: fail-fast at the top of `validateParserOutput` with a new diagnostic code, and short-circuit the rest of validation.

### Diagnostic / user-facing failure
- New hard `DiagnosticCode`, e.g. `too_many_paragraphs`.
- Failure bucket: `"Other"` or a clearer existing/new bucket if one fits; keep consistent with hard-fail classification (must NOT be in `SOFT_DIAGNOSTIC_CODES`).
- Import maps this to an `ImportFailure` with a clear category/message, e.g.:
  - Category: something like `"Book too large"` (or reuse an existing clear hard-fail category if product prefers consistency with size limits)
  - Message: include the cap and actual count: `This book has 142796 paragraphs; maximum supported is 50000.`
- New imports: existing hard-fail purge behavior applies (no Failed library row / no Retry import UX).
- Restore-to-original of an existing book: keep existing keep-prior-content hard-fail behavior (`purgeOnHardFailure: false`).

### Fix the latent crash regardless
Even with the cap, replace `Math.max(0, ...paragraphWordCounts)` with a loop (or safe reduce) so future higher caps / lab tooling cannot stack-overflow. Same pattern wherever similar spreads exist on paragraph-sized arrays in validate/pdf-content if touched.

### Tests
- Unit: validate/parser short-circuits at `MAX + 1` with the new diagnostic; does not throw RangeError.
- Unit: `Math.max` replacement finds the true max on a moderately large synthetic array (e.g. 20k) without stack overflow.
- Import service: synthetic parsed book / fixture over the cap hard-fails with expected message and does not persist chunks (follow existing hard-fail purge tests).
- Optional: document that Shakespeare/Webster are expected rejects under this cap (no need to load 50MB JSON in CI).

### Docs
- Short note in `DOCUMENTATION.md`: max 50k paragraphs; oversize books hard-fail and are purged from library for new imports; import the file again is N/A for this limit (user needs a smaller/split source).

## Implementation order
1. Add constant + diagnostic code.
2. Short-circuit at top of `validateParserOutput` (or equivalent) + safe max loop.
3. Ensure import classification hard-fails the new code with clear `ImportFailure` copy.
4. Tests + docs.
5. Lint/tests gate.

## Acceptance
- Books ≤ 50k paragraphs: unchanged success path.
- Books > 50k: clean hard-fail with explicit paragraph-limit message; no stack overflow; no chunk persistence for new imports; library row purged for new hard-fails.
- `Math.max` spread crash gone for paragraph word-count scan.

## Open questions for reviewer
1. Is short-circuit-only-in-validate enough, or should import also re-check length defensively after parse?
2. Exact user-facing failure category string.
3. Should lab scripts share the same constant, or app-only?
