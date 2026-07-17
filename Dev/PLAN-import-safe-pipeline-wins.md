# Plan: Safe import pipeline wins + batch serialization

**Status:** Implemented (one package: A, B, C, D, E, F, H)
**Source proposal:** `Dev/PROPOSAL-import-safe-pipeline-wins.md` (approved with decisions below)
**Deferred:** G (EPUB worker) — revisit only after this package is measured on device.
**Out of scope:** any parse concurrency increase, parallel SQLite writers, raising the 30s parser ceiling, background import.

## Locked decisions (do not re-litigate)

1. A–F ship as one package, plus H (batch read serialization) folded in.
2. Session card shows a **coarse** phase label during parse ("Processing"); no in-memory phase plumbing.
3. Yields (E) use a **time budget**, not per-unit yields.
4. PDF cover travels as an **optional field on the parser output**.
5. The protective byte copy before PDF.js **stays** (PDF.js detaches the buffer it is given); F removes only other copies.
6. Keep the 30-second parser ceiling exactly as is.
7. No new manual checklist items beyond the proposal's list.

---

## Implementation order

1. A + B (quiet the locked session)
2. H (serialize batch reads — fixes "works solo, fails in batch")
3. C + D (single-open covers)
4. E (cooperative yields)
5. F (byte-copy reduction — highest foot-gun, do last)

Run `bun run lint` and the test suite after each step. Run `bun run build` at the end (parser modules are touched).

---

## A. Suppress full library reloads while a batch is locked

**Files:** `src/pages/Home.tsx`

Current behavior: `importService.subscribe(() => scheduleRefreshFromImport())` (~L303) schedules a debounced (180 ms) `refreshLibrary` on **every** service emit, including every phase change of every book in a locked batch.

Changes:

1. Add `const isImportingBatchRef = useRef(false);` next to the other refs. Set it `true` at the top of `runImportBatch` (where `setIsImportingBatch(true)` is called) and `false` in the same place(s) `setIsImportingBatch(false)` runs at batch end. A ref is required because the subscribe callback is registered once and must not close over stale state.
2. In the subscribe callback: `if (isImportingBatchRef.current) return;` before `scheduleRefreshFromImport()`.
3. When the batch starts, also clear any pending debounce timer (`importRefreshTimeoutRef`) so a refresh scheduled just before lock cannot fire mid-batch.
4. Verify every batch exit path (success, cancel cleanup, thrown error) performs exactly one `refreshLibrary({ showLoading: false })` **before** unlocking / showing Last import. The success and cancel paths already do this (~L826-829 region); if the error path can unlock without a refresh, move the refresh into the `finally` that unlocks.

Non-batch imports (lone Restore, single file) keep the existing debounced refresh — do not touch that path.

**Tests:** extend the existing Home foreground-import regression tests: mock service emits while a batch is active → `loadLibraryEntries` is not called repeatedly; one refresh after batch end. Cancel path still ends with a consistent library.

---

## B. Coalesce mid-parse status persistence

**Files:** `src/lib/import/bookImportService.ts`, `src/lib/import/importPhaseLabel.ts` (+ its test)

Current behavior: `executeTask` passes `onPhaseChange: async (phase) => { ...await markStatus(phase); }` (~L1013-1018). Each parser phase does an awaited SQLite transaction (two UPDATEs), a `getBook` read (inside `ensureNotCancelled`), and an emit — all stealing wall-clock time from the 30s parse budget.

Changes:

1. In `executeTask`, **remove the `onPhaseChange` option entirely** from the `parseBookBytes` call. Parsers already guard with `options.onPhaseChange?.(...)`, so no parser changes are needed. Do not add any replacement DB work in its place.
2. Keep: the enqueue-time `status: "queued"` insert, the initial `await markStatus("validating")`, and all terminal writes (`completed`, hard-fail path, canceled). Nothing else changes in the try/catch flow.
3. Per decision 2: in `importPhaseLabel.ts`, change the `"validating"` case label from `"Validating"` to `"Processing"` so the session card shows an honest label for the whole parse. Update `importPhaseLabel.test.ts` to match. Leave `isActiveImportStatus` alone.

Note on cancellation: dropping per-phase `markStatus` also drops its per-phase `ensureNotCancelled` (a `getBook` DB read). This is intended — cancellation is still enforced by the `AbortSignal` passed into the parser, the parser's own abort checks each spine document / PDF page, and the `ensureNotCancelled` calls after parse returns. Do not reintroduce mid-parse DB reads.

**Tests:** in `bookImportService` tests, spy on `repository.setBookAndImportStatus`; a successful import must call it exactly twice (`validating`, `completed`).

---

## H. Serialize batch reads with parsing (fixes solo-works / batch-fails)

**Files:** `src/pages/Home.tsx`, `src/lib/import/bookImportService.ts`

Root cause: while book N parses, Home reads the next files with 2 parallel workers (`BATCH_IMPORT_READ_CONCURRENCY = 2`) and the service buffers up to 96 MB / 4 inline sources. File reads, base64/native bridge work, and IndexedDB persistence compete with the parser on the same WebView, eating the parser's 30s wall-clock budget. Goal: **book N in a batch runs under the same conditions as a solo import.**

Changes:

1. `Home.tsx`: set `BATCH_IMPORT_READ_CONCURRENCY = 1`.
2. `bookImportService.ts`: add a public method:

   ```ts
   /** Resolves when no task is executing and the queue is empty. */
   waitForIdle(signal?: AbortSignal): Promise<void>
   ```

   Implementation: if `!this.isRunning && this.queue.length === 0`, resolve immediately. Otherwise subscribe to the service's own emit (the existing listener mechanism `emit()` drives), re-check the condition on each emit, unsubscribe and resolve when idle. If `signal` aborts, unsubscribe and resolve (not reject) — the caller checks `signal.aborted` right after, and the existing batch-worker abort handling takes over. `runQueue` already emits in its `finally`, so idle is always observed.
3. In `runImportBatch`'s worker (the callback given to `runWithLimitedConcurrency`), insert `await importService.waitForIdle(signal);` **before** `loadPendingImportPayload(item, signal)`. The very first book resolves immediately; every later book waits until the previous parse fully finishes before its file is even read.
4. Do **not** change: `inlineSourceMode: "bounded"`, the 96 MB / 4-task caps (they become a backstop), or `persistRawSource` timing (the cancel/purge paths await `task.persistSource`; solo imports have the same persist-during-own-parse overlap, so this matches the solo environment already).

Tradeoff (accepted): batch wall time grows by the sum of file-read times (~1–3 s per book) because reads no longer overlap parsing. A smarter gated-overlap variant is parked in `Dev/REVISIT.md`.

**Tests:** unit test `waitForIdle` (resolves immediately when idle; resolves after a queued task finishes; resolves on abort). If practical, a Home-level test asserting the second item's read does not start until the first book reaches a terminal state.

---

## C. PDF: one document open for parse + cover

**Files:** `src/lib/import/pdfImageRenderer.ts`, `src/lib/bookParser/pdf.ts`, `src/lib/bookParser/types.ts`, `src/lib/import/bookImportService.ts`

Current behavior: `parsePdf` opens the document via `getDocument` and destroys it; then `executeTask` calls `createPdfCoverDataUrl(storedSource.bytes)` (~L1084), which opens the whole document a second time (second worker + full decode).

Changes:

1. `pdfImageRenderer.ts`: extract the body of `createPdfCoverDataUrl` into an exported helper that takes an already-open document:

   ```ts
   export async function pdfCoverDataUrlFromDocument(document: PdfDocument): Promise<string | null> {
     const canvas = await renderPointer(document, { pageNumber: 1, crop: null }, 700);
     return canvas ? canvasToDataUrl(canvas) : null;
   }
   ```

   Keep `createPdfCoverDataUrl` as a thin open/render/destroy wrapper around it (existing tests keep passing). The structural `PdfDocument` type is compatible with PDF.js's `PDFDocumentProxy`.
2. `types.ts`: add to `ParserOutput` an optional field:

   ```ts
   /** Library cover rendered during parse (data URL), or null when unavailable. */
   coverDataUrl?: string | null;
   ```

   (Shared with D — one field for both formats.)
3. `pdf.ts` (`parsePdf`): inside the `try` block, after the page-extraction loop completes (and only when not timed out and `options.signal` is not aborted), render the cover from the **live** document:

   ```ts
   let coverDataUrl: string | null = null;
   try {
     coverDataUrl = await pdfCoverDataUrlFromDocument(document);
   } catch { coverDataUrl = null; }
   ```

   Store it in a variable declared before the `try` and attach it to the returned `ParserOutput`. Cover rendering must happen before the `finally` destroys the loading task. Soft-fail semantics: any error or missing canvas ⇒ `null`. In non-DOM test environments `canvasContext` returns `null`, so the result is `null` — tests must not expect a data URL there.
4. `bookImportService.ts`: replace the PDF branch `: await createPdfCoverDataUrl(storedSource.bytes)` with `: parsed.coverDataUrl ?? null`. **No fallback reopen** — a failed in-parse cover render means no cover, same soft-fail class as today.

Layering note (accepted in review): `bookParser/pdf.ts` importing a helper from `lib/import/pdfImageRenderer.ts` is fine; if bundling or parser unit tests choke on `pdfImageRenderer`'s `loadRawBook` import, move the pure render helpers (`renderPointer`, `canvasContext`, `canvasToDataUrl`, the new function) into a small standalone module (e.g. `src/lib/import/pdfPageRender.ts`) and have both files import it.

**Tests:** mock/spy that `createPdfCoverDataUrl` is **not** called during a PDF import; parser test that `ParserOutput.coverDataUrl` is populated when a canvas is available (jsdom or mocked render) and `null` otherwise.

---

## D. EPUB: cover from the parse archive (no second zip open)

**Files:** `src/lib/import/epubAssetDataUrl.ts`, `src/lib/bookParser/epub.ts`, `src/lib/import/bookImportService.ts` (`src/lib/import/epubCoverDataUrl.ts` stays for now)

Current behavior: parse builds a `SelectiveZipArchive` and discovers `state.cover` (a zip path). Then `executeTask` calls `epubCoverDataUrl(storedSource.bytes, rawCoverSrc)` → `epubAssetDataUrl` → `ZipArchive.fromBytes(epubBytes)` — a second full zip reader constructed only for the cover.

Changes:

1. `epubAssetDataUrl.ts`: export the currently-private `bytesToBase64`, and add a small pure helper:

   ```ts
   /** Builds a data URL from already-extracted asset bytes. Soft-fails to null. */
   export function assetDataUrlFromBytes(bytes: Uint8Array, mimeType: string): string | null
   ```

   (mime check via existing `mimeFromAssetPath` stays with the caller.)
2. `epub.ts` (`parseEpub`): after extraction succeeds (near where the final `buildBook` result is assembled), materialize the cover from the **same** `SelectiveZipArchive`:

   - If `state.cover?.src` is falsy or starts with `"data:"`, set `coverDataUrl` to `null` (matches today's behavior — `mimeFromAssetPath` on a `data:` src yields null).
   - Else: `mimeFromAssetPath(src)`; if null ⇒ `null`. Resolve via `archive.resolve(src)`; if null ⇒ `null`. Read bytes with `archive.read(resolvedPath, <existing max-entry-bytes constant used for content>)`; empty ⇒ `null`. Then `assetDataUrlFromBytes(bytes, mime)`.
   - Wrap the whole thing in try/catch ⇒ `null`. Attach to `ParserOutput.coverDataUrl`.

   **Semantics guard:** the result for the same book must equal what `epubCoverDataUrl(storedSource.bytes, src)` returns today. The known risk is path-resolution differences between `ZipArchive.readEntryBytes` and `SelectiveZipArchive.resolve` (case/URI-decoded names). Add a fixture test comparing old helper vs new parse-time value on the cover fixture EPUB(s); if they diverge, match `SelectiveZipArchive.resolve`'s lookup order to the old behavior for the cover path only.
3. `bookImportService.ts`: EPUB branch becomes:

   ```ts
   isOversizedInlineCover(rawCoverSrc) ? null : parsed.coverDataUrl ?? null
   ```

   The `cover_missing` warning logic stays exactly as is.
4. Keep `epubCoverDataUrl.ts` and its tests (it documents the standalone path and guards the comparison test); it just stops being called from `executeTask`.

**Tests:** fixture EPUB with a cover → `ParserOutput.coverDataUrl` matches the legacy helper output; import test asserting no `ZipArchive.fromBytes` construction on the import path (spy or module mock).

---

## E. Cooperative yields between parse units (time budget)

**Files:** new `src/lib/bookParser/cooperativeYield.ts`, `src/lib/bookParser/epub.ts`, `src/lib/bookParser/pdf.ts`

Purpose: let the UI paint and `AbortSignal` be observed between parse units, without meaningfully extending wall time (the 30s ceiling is wall-clock — yields count against it).

1. New helper:

   ```ts
   const YIELD_BUDGET_MS = 50; // Yield at most every ~50ms of work: cancel stays
   // responsive while total overhead stays a few % of the 30s wall-clock budget.

   export function createCooperativeYielder(budgetMs = YIELD_BUDGET_MS): () => Promise<void> {
     let lastYield = performance.now();
     return async () => {
       if (performance.now() - lastYield < budgetMs) return;
       await macrotask();
       lastYield = performance.now();
     };
   }
   ```

   `macrotask()` should use `MessageChannel` (avoids the 4 ms nested-`setTimeout` clamp in WebViews):

   ```ts
   function macrotask(): Promise<void> {
     return new Promise((resolve) => {
       const { port1, port2 } = new MessageChannel();
       port1.onmessage = () => { port1.close(); resolve(); };
       port2.postMessage(null);
     });
   }
   ```

   Fall back to `setTimeout(0)` if `MessageChannel` is unavailable.
2. `epub.ts`: create one yielder per parse at the top of `parseEpub`; in `extractReadingOrder`, call `await maybeYield()` after each `extractContentDocument`. The existing `throwIfEpubAborted` + `checkDeadline` at the loop top then observe the abort promptly.
3. `pdf.ts`: same — one yielder per parse, `await maybeYield()` after each `extractPage` in the page loop, before the loop-top `throwIfPdfAborted`.
4. Do not add yields anywhere else (no per-paragraph or per-image yields).

**Tests:** unit test the yielder with a fake clock (no yield under budget, yields past budget). Abort-responsiveness tests only if they can avoid real-time assertions; no wall-clock flakiness.

---

## F. Reduce avoidable byte copies (careful ownership)

**Files:** `src/lib/import/rawEpubStore.ts`, comments in `src/lib/bookParser/pdf.ts` and `src/lib/import/pdfImageRenderer.ts`

**Copies that must STAY (add explanatory comments, do not remove):**

- `pdf.ts` ~L120: `const data = new Uint8Array(options.sourceBytes);` — PDF.js transfers this buffer to its worker, **detaching** it. The raw source is persisted after parse (`ensureTaskSourcePersisted` runs after `parseBookBytes`); parsing a shared buffer without this copy corrupts the stored book. Comment must say exactly this.
- `pdfImageRenderer.ts` `openDocument`: `data: new Uint8Array(bytes)` — same reason; protects the raw-store memory cache.
- `epubAssetObjectUrl` blob copy — already documented, leave it.

**Copies to remove (scope of this item — `put()` path only):**

In `rawEpubStore.ts` `IndexedDbRawStore.put()` there are two copies per stored book today: `cloneRecord(record)` for the memory cache, plus `bytes.buffer.slice(...)` for IndexedDB.

1. Add an ownership rule to the `RawBookRecord` doc comment: *bytes handed to `store()` are owned by the store and must not be mutated or detached by callers afterward.* (True today: the import path only reads them, and PDF.js gets its own protective copy.)
2. `put()`: drop `cloneRecord`; put the original record in the memory cache.
3. `put()` IDB write: when the view is exact (`bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength` — the common case), pass `bytes.buffer` directly and let structured clone make the single unavoidable copy. Keep the explicit `slice` only for non-exact views (structured-cloning a subarray's Uint8Array would persist the entire underlying buffer).
4. **Leave `get()`/`load()` cloning as is** — the read-path clone protects the memory cache from readers, and read paths are not the batch memory peak. Do not widen scope.

**Tests:** raw store round-trip with a non-zero-`byteOffset` subarray view (stored bytes byte-identical to the view, not the whole buffer); existing round-trip tests stay green; an import fixture still stores byte-identical raw source.

---

## Docs / handoff

- `DOCUMENTATION.md`: update the foreground-import notes: (1) library grid refresh is deferred until session unlock; the session card is the live source while locked; (2) the per-book phase label during parse is a coarse "Processing"; (3) batch file reads are serialized with parsing so each batch book parses under solo-equivalent conditions; (4) library covers are rendered during parse from the already-open document/archive.
- Handoff note: no concurrency policy change (batch read concurrency actually *decreased* to 1); 30s parser ceiling unchanged.
- Gates: `bun run lint`, full test run, `bun run build`.
- Manual on-device checklist (from the proposal):
  - [ ] Multi-book folder import → library inert, session card updates, UI responsive.
  - [ ] Cancel mid-batch → canceled buckets, no stuck Processing rows, one consistent refresh.
  - [ ] EPUB with cover + PDF with cover both show covers after unlock.
  - [ ] Lone **Restore to original** still works outside a batch.
  - [ ] No new hard-fail / timeout spike on a small mixed sample.

## Reviewer checklist (self-check before handoff)

- [ ] No parse concurrency or multi-writer SQLite introduced; batch reads serialized.
- [ ] Locked batch: no full library reload per emit; exactly one refresh at unlock on every exit path.
- [ ] Successful import performs exactly 2 `setBookAndImportStatus` calls.
- [ ] PDF/EPUB covers produced without a second document/zip open; no fallback reopen.
- [ ] Protective PDF.js copies still present, with comments explaining why.
- [ ] Soft/hard failure, purge, Restore, Cancel, and Last import semantics unchanged.
