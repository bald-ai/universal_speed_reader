# Proposal: Safe import pipeline wins (no concurrency increase)

**Status:** Ready for agent review  
**Audience:** Implementing / reviewing agent  
**Device context:** CMF Phone 2 Pro (Galaga / A001), 8 GB RAM, Dimensity 7300 Pro — moderate headroom; do not chase multi-book parse parallelism in this work.  
**Product fit:** Locked foreground import session on Library (screen awake, library inert until Cancel or batch end).

---

## Goal

Improve bulk/single import **wall time, UI responsiveness, and peak waste** by removing duplicate work and mid-import chatter — **without** raising parse concurrency or risking OOM / thermal collapse.

## Non-goals

- EPUB parse concurrency > 1
- PDF active-document concurrency > 1
- Parallel SQLite writers / multiple commit lanes
- Background import while minimized (see `Dev/REVISIT.md`)
- User-facing “Retry import” / Failed-row retry (hard fails purge; re-import file or **Restore to original**)
- Predicting a numeric speedup before phase timings exist (nice-to-have telemetry is optional, not blocking)

## Why “all at once” fits the locked session

During a started batch, Library/Mood are already inert and progress is owned by the session card (`ImportSessionReport`). Full-library reloads on every import event are largely wasted: the grid is not interactive, and the session UI already polls/snapshots live rows.

That makes a **single cohesive pass** correct:

1. Session-local progress becomes the source of truth while locked.
2. Pipeline stages stop doing redundant archive/PDF/cover/DB work behind that UI.
3. One library refresh at unlock / Last import handoff is enough for the grid.

Do **not** ship only the UI refresh change and leave double PDF/EPUB cover work; the locked session is the product reason to treat the package as one intentional import-path hardening.

---

## Current bottlenecks this package targets

| Waste | Evidence (approx.) | Effect |
|---|---|---|
| Full library + layout reload on import emits | `Home.tsx` `subscribe` → `scheduleRefreshFromImport` → `refreshLibrary` | SQLite read contention + UI work during locked session |
| Mid-parse phase → SQLite status writes | `bookImportService.executeTask` `onPhaseChange` → `markStatus` → `setBookAndImportStatus` + `emit` | Parse pauses on bridge; more emits |
| PDF opened twice | `pdf.ts` `getDocument` then destroy; `createPdfCoverDataUrl` opens again | Extra PDF.js worker + decode spike |
| EPUB zip re-opened for cover | Parse uses `SelectiveZipArchive`; cover uses `ZipArchive.fromBytes` via `epubAssetDataUrl` | Second inflate / large transient buffers |
| Long sync stretches on UI thread | EPUB `unzipSync` + Cheerio; few true yields | Jank, weak cancel mid-sync |
| Extra byte copies | PDF `new Uint8Array(sourceBytes)`; raw store clone + buffer slice | Higher peak RAM at concurrency 1 |

Hardware collapse modes (multi-book parse, PDF×2, unbounded workers) stay **out of scope**.

---

## Work items (implement as one package)

### A. Suppress full library reload while foreground batch is locked

**Behavior**

- While a batch session is active, import-service subscription must **not** call full `refreshLibrary`.
- Session UI continues to update from existing batch snapshot / polling / local result state.
- On batch end (success, cancel flush, or error path that unlocks): perform **one** `refreshLibrary`, then show Last import as today.
- Lone restore / non-batch import may keep a lighter refresh policy (refresh on terminal outcomes is enough; avoid per-phase full reloads).

**Acceptance**

- During locked batch: no repeated full library loads on phase changes.
- After unlock: library grid matches completed imports and folder placement.
- Cancel path still ends with consistent library + Last import canceled buckets.

**Tests**

- Home / session regression: mock import emits during active batch → `loadLibraryEntries` not called repeatedly.
- Existing `HomeForegroundImportRegression` extended if present.

### B. Coalesce mid-parse status persistence

**Behavior**

- Keep fine-grained phase for in-memory / session UI if useful.
- Persist to SQLite only at coarse boundaries, e.g. `queued` → `validating`/`processing` → terminal (`completed` / hard-fail purge path / canceled).
- Do not `await` a DB write on every parser phase callback.

**Acceptance**

- One book no longer performs a status write per extract phase.
- Session “current book / phase” label still usable (from memory or coarse status).
- Terminal outcomes and Last import unchanged.

**Tests**

- `bookImportService` tests: spy repository status writes; assert count stays small per successful import.

### C. PDF: single document open for parse + cover

**Behavior**

- While the parse-time PDF.js document is alive, render the library cover (page 1, existing size budget ~700px path) **before** `destroy`.
- Return cover data URL (or null) with parse result / import handoff so `createPdfCoverDataUrl(bytes)` is not called again on the same import.
- Preserve soft-fail cover behavior (missing/unreadable → warning path as today).

**Acceptance**

- Successful PDF import opens `getDocument` once for parse+cover.
- Peak memory during PDF import does not add a second full document for cover.
- Cover still appears on library row after unlock.

**Tests**

- Unit/integration: mock PDF.js document; assert cover helper not re-invoked with fresh open after parse.
- Existing PDF import tests updated for new handoff field if API changes.

### D. EPUB: cover from parse archive (no second zip open)

**Behavior**

- During EPUB parse (or immediately after with the same archive instance), extract cover asset bytes / data URL.
- Import path must not call `ZipArchive.fromBytes(epubBytes)` solely for cover when parse already had the archive.
- Soft-fail semantics unchanged.

**Acceptance**

- Successful EPUB import does not construct a second full zip reader only for cover.
- Cover still materializes to `books.cover_path` as today.

**Tests**

- Cover extraction covered with fixture EPUB; assert optional zip reuse path.
- Existing `epubCoverDataUrl` tests remain valid or move to shared helper.

### E. Cooperative yields between parse units (concurrency still 1)

**Behavior**

- Between EPUB spine documents and PDF pages, yield a macrotask (e.g. `setTimeout(0)` / equivalent helper) so the UI can paint and `AbortSignal` can be observed more often.
- Do **not** increase parallel in-flight books or pages.

**Acceptance**

- Cancel becomes responsive between units more reliably.
- No increase in 30s parser timeout rate on normal fixtures.
- Wall time may rise slightly; that is acceptable if jank drops.

**Tests**

- Abort mid-spine / mid-page tests if feasible with fake timers.
- No flaky timing assertions on wall clock.

### F. Reduce avoidable byte copies (careful ownership)

**Behavior**

- Prefer subarray / single owned `Uint8Array` through parse and raw-store write where safe.
- Document ownership: who may detach/transfer buffers; no use-after-detach.
- Do not break IndexedDB structured-clone requirements (copy only at the persistence boundary if the engine needs a contiguous `ArrayBuffer`).

**Acceptance**

- Peak RAM for a large PDF/EPUB import drops or stays flat vs baseline in a manual check.
- No corruption of stored raw sources or parse results.

**Tests**

- Raw store round-trip tests with non-zero `byteOffset` views.
- Import fixtures still complete byte-identically for stored raw where asserted today.

---

## Optional follow-up (same safety class, separate PR if large)

### G. EPUB parse in one Web Worker, still one book at a time

Moves sync unzip/Cheerio off the UI thread. **No** worker pool / concurrency 2.  
Protocol must replace non-cloneable `AbortSignal` / callbacks with explicit messages.  
Vite module workers are acceptable (no new dependency).

Treat as follow-up if A–F already make a large diff.

---

## Explicitly deferred

| Idea | Why deferred |
|---|---|
| EPUB concurrency 2–3 | Needs phase telemetry + thermal/RAM acceptance; collapse risk on 8 GB |
| PDF concurrency 2 | Highest OOM/thermal risk |
| Parallel SQLite commits | Bridge + lock already single-lane; backlog grows RAM |
| Synthetic startup microbenchmark | Prefer real-book feedback later |
| Full import phase telemetry suite | Useful; not required to land A–F |

---

## Suggested implementation order inside the package

1. **A + B** — locked-session refresh policy + status coalesce (product-aligned, unblocks quieter parse).
2. **C + D** — eliminate double PDF/EPUB cover work.
3. **E** — yields.
4. **F** — copy reduction (highest foot-gun; do after behavioral wins).
5. **G** — only if scoped separately or remaining budget allows.

Ship A–F together when practical; split G.

---

## Docs / handoff requirements

- Update `DOCUMENTATION.md` Foreground import session note: library grid refresh is deferred until session unlock; session card is live source during lock.
- Short note in handoff: no concurrency policy change.
- Run `bun run lint` and relevant tests; `bun run build` if worker or parser packaging changes (especially if G lands).
- Manual on-device checklist (Nothing/CMF test phone when free):
  - [ ] Start multi-book folder import → library inert, session card updates, UI stays responsive.
  - [ ] Cancel mid-batch → canceled buckets, no stuck Processing rows, one consistent refresh.
  - [ ] EPUB with cover + PDF with cover both show covers after unlock.
  - [ ] Lone **Restore to original** still works outside batch.
  - [ ] No new hard-fail / timeout spike on a small mixed sample.

---

## Review checklist for the reviewing agent

- [ ] Confirms no parse concurrency or multi-writer SQLite was introduced.
- [ ] Locked batch path does not full-reload library on every emit.
- [ ] PDF/EPUB cover paths do not re-open source after parse without a documented reason.
- [ ] Soft vs hard failure / purge / Restore semantics unchanged.
- [ ] Cancel + Last import behavior preserved.
- [ ] Tests cover refresh suppression and reduced status writes.
- [ ] Docs updated for session refresh behavior.

---

## Decision asked of reviewer

Approve implementing **A–F as one package** aligned with the locked foreground import session; keep **G** as an optional same-safety follow-up; keep all multi-book parse parallelism deferred until measured instrumentation work (separate proposal).
