# Android Migration TODO (Universal Speed Reader)

Date: 2026-02-16

## Agreed / Confirmed

- [x] V1 will be offline-first (no Convex/backend dependency).
- [x] No user accounts in V1.
- [x] No cloud sync in V1.
- [x] V1 book format support: EPUB only (non-DRM).
- [x] Keep current settings values as default values.
- [x] Implement real reading-progress persistence (current `saveProgress` no-op must be replaced).
- [x] Keep using EPUB preprocessing, but make it runtime import flow for user-uploaded books.
- [x] Import should parse once, then read from normalized local data for smooth reading.
- [x] Target behavior should mirror the strong parts of Petra Reader MVP architecture.
- [x] Use lightweight local DB architecture (SQLite-first on Android, same data model on web fallback).
- [x] Reuse Petra Reader EPUB compatibility heuristics where they proved reliable.

## Clarified During Discussion

- [x] We do not strictly need one giant JSON file format.
- [x] We do need a normalized internal representation (paragraphs + chapters + metadata).
- [x] Current repo (`universal_speed_reader`) uses build-time conversion from `test.epub` to `public/books/test.json`.
- [x] Petra Reader flow is: upload EPUB -> background parse -> chunked paragraph storage + processing status.
- [x] Existing tests are real and currently passing (`bun test`: 29 pass, 0 fail).

## Locked V1 Scope (Functionality > Storage)

- [x] Use `@capacitor-community/sqlite` as the V1 local DB package.
- [x] Copy every imported EPUB into app-managed storage.
- [x] Process every uploaded EPUB to the final readable state (metadata + chapters + chunks) during import.
- [x] Keep both raw EPUB copy and processed data in V1 (no storage optimization/ejection in V1).
- [x] Use single import queue (`1` active processing job at a time).
- [x] Allow duplicate imports in V1 (no dedup enforcement).
- [x] Retry strategy in V1 is manual only (user-triggered retry).
- [x] Use processing statuses in UI with generic placeholder UX for now.
  - Internal pipeline statuses: `queued`, `validating`, `extracting_metadata`, `extracting_text`, `building_chapters`, `completed`, `failed`
  - UI may group these into simpler labels (`Queued`, `Processing`, `Completed`, `Failed`) as long as internal status is preserved in DB.
- [x] Library and Mood are UI-only views in V1 (same underlying processed data, no storage/state differences).
- [x] Skip folder upload in V1.
- [x] Prioritize reliability and functionality over storage footprint during early testing.

## Detailed Book Processing Plan (Implementation Blueprint)

### 1) Storage model (lightweight DB, offline-first)

- [x] Use local DB tables as primary source of truth.
- [x] Keep normalized text and chapter index in DB, not in `/public/books/*.json`.
- [x] Keep raw EPUB file path/URI reference for optional reprocess support.

Tables to implement:

- [ ] `books`
  - `id` (string, uuid)
  - `title` (string)
  - `author` (string | null)
  - `cover_path` (string | null)
  - `language` (string | null)
  - `source_uri` (string)
  - `size_bytes` (number)
  - `processing_status` (`queued|validating|extracting_metadata|extracting_text|building_chapters|completed|failed`)
  - `processing_error` (string | null)
  - `total_chunks` (number)
  - `total_paragraphs` (number)
  - `total_words` (number)
  - `created_at` (number)
  - `updated_at` (number)
- [ ] `book_chunks`
  - `book_id` (string)
  - `chunk_index` (number)
  - `paragraphs_json` (json array of `{ id, text }`)
- [ ] `book_chapters`
  - `book_id` (string)
  - `chapter_index` (number)
  - `title` (string)
  - `start_paragraph_id` (number)
- [ ] `reading_progress`
  - `book_id` (string)
  - `paragraph_id` (number)
  - `word_index` (number)
  - `mode` (`normal|speed`)
  - `updated_at` (number)
- [ ] `app_settings`
  - `key` (string)
  - `value_json` (json)
- [ ] `import_jobs`
  - `book_id` (string)
  - `attempt` (number)
  - `status` (string)
  - `error` (string | null)
  - `started_at` (number)
  - `finished_at` (number | null)

### 2) Import and processing state machine

- [ ] `queued` -> file selected, DB row created.
- [ ] `validating` -> verify zip/EPUB container and basic readability.
- [ ] `extracting_metadata` -> title/author/language/cover extraction.
- [ ] `extracting_text` -> stream paragraphs in spine order.
- [ ] `building_chapters` -> TOC/heading/fallback chapter mapping.
- [ ] `completed` -> chunks + chapters committed.
- [ ] `failed` -> error persisted, safe retry possible.

Rules:

- [ ] Reader can open only `completed` books.
- [ ] Any failure writes `processing_error` and keeps import trace.
- [x] Retry is manual only and user-triggered.
- [ ] Manual retry means new import attempt, cleanly replacing chunks for that `book_id`.

### 3) Parser strategy (strict first, compatibility second)

Strict standards path:

- [ ] Read `container.xml` and OPF package metadata.
- [ ] Use OPF spine for reading order.
- [ ] Prefer EPUB3 `nav` for chapter map.
- [ ] Fallback to EPUB2 NCX when needed.

Compatibility layer (ported from Petra logic):

- [ ] Path normalization (`./`, `../`, `OEBPS/`, `OPS/`, slash and case normalization).
- [ ] Anchor collection across patterns (`id`, `name`, parent wrapper, empty sibling anchors).
- [ ] TOC matching by `(file + anchor)` and `(file only)`.
- [ ] Heading fallback when TOC mapping is weak.
- [ ] Text-title fuzzy fallback when chapter detection is incomplete.
- [ ] Ignore known structural headings (`toc`, `cover`, `copyright`, etc.).
- [ ] Final fallback chapter: `Full book` at paragraph `1`.

### 4) Normalization and chunking

- [ ] Normalize all extracted content into stable app shape:
  - paragraphs: `{ id, text }`, 1-based sequential ids
  - chapters: `{ index, title, start_paragraph_id }`
- [ ] Compute `total_words` during import (single pass).
- [ ] Chunk size target: `50` paragraphs per chunk (same proven Petra baseline).
- [ ] Flush chunks in small batches to avoid long UI stalls.
- [ ] Ensure chunk + chapter writes are atomic enough to avoid half-import visibility.

### 5) Performance and reliability guardrails

- [ ] Do processing off the UI critical path.
- [ ] Write progress status frequently so app crash does not lose context.
- [x] Hard-limit import size to `150 MB` per EPUB in V1.
- [x] Import timeout default: fail job after `180s` total processing time.
- [x] Validate file as EPUB before parse (extension + container/readability checks).
- [x] If no readable paragraphs are extracted, mark as `failed` with explicit message.
- [x] User-facing error buckets for import: `Unsupported format`, `File too large`, `Corrupted/Unreadable EPUB`, `Processing timeout`.
- [x] Duplicate imports are allowed in V1 (skip dedup work for now).
- [ ] Keep raw source reference to allow reprocess without re-pick (when permission allows).

### 6) Reader integration contract

- [ ] Replace `/books/${bookId}.json` fetch with local repository read.
- [ ] Library screen queries `books` by status and metadata.
- [ ] Reader requests chunk window around visible range.
- [ ] Reading position save is debounced and persisted in `reading_progress`.
- [ ] Last position restoration on open is required behavior.

### 7) Migration steps from current prototype

- [ ] Step 1: Persist settings to `app_settings`.
- [ ] Step 2: Implement `reading_progress` and wire `saveProgress`.
- [ ] Step 3: Add import job pipeline and status UI.
- [ ] Step 4: Port Petra EPUB parser + fallback module into local ingestion service.
- [ ] Step 5: Write chunks/chapters/metadata into DB.
- [ ] Step 6: Switch Home/Reader to DB-backed repository.
- [ ] Step 7: Remove static sample-book coupling and mock-only gating.

### 8) Test plan for processing confidence

- [x] Keep V1 parser testing basic and practical (no heavy fixture engineering for now).
- [x] Real-book validation fixtures are copied into project at:
  - `/Users/michalkrsik/windsurf_project_folder/universal_speed_reader/Devnotes/fixtures/plath-bell-jar.epub`
  - `/Users/michalkrsik/windsurf_project_folder/universal_speed_reader/Devnotes/fixtures/fitzgerald-great-gatsby.epub`
  - `/Users/michalkrsik/windsurf_project_folder/universal_speed_reader/Devnotes/fixtures/shelley-frankenstein.epub`
- [ ] Handoff requirement: processing must work end-to-end on all 3 fixture books above.
- [ ] Required checks per fixture EPUB:
  - processing status reaches `completed`
  - extracted paragraph count is `> 0`
  - extracted chapter count is `> 0` (or explicit `Full book` fallback)
  - paragraph ids are sequential and stable
  - total words is `> 0`
  - reader opens and resume position persists after reopen
- [ ] Handoff must include a simple extraction report table per tested book:
  - file name
  - final status
  - paragraph count
  - chapter count
  - total words
  - error (if failed)

### 9) Reliability handoff gate (must pass before implementation handoff)

This section is the hard gate. If any item fails, implementation is not handoff-ready.

#### 9.1 Required test layers

- [ ] **Parser unit tests (pure logic):**
  - container/OPF discovery works on normal and nested paths
  - spine order is preserved exactly
  - EPUB3 `nav` is preferred, EPUB2 NCX fallback works
  - path normalization handles `./`, `../`, `OEBPS/`, `OPS/`, slash and case variations
  - anchor matching works for `id`, `name`, wrapper, and sibling-anchor edge cases
  - heading/title fallback produces stable chapter map when TOC mapping is weak
- [ ] **Normalization/chunking unit tests:**
  - paragraph ids are 1-based and strictly sequential
  - chapter indexes are sequential and `start_paragraph_id` is monotonic
  - chunk indexes are sequential, chunk size cap respected (`<= 50` except final chunk)
  - `total_words` equals recomputed token count from stored paragraphs
- [ ] **DB integration tests (SQLite repository):**
  - schema creation/migrations create all required tables
  - import writes are transactional enough to avoid visible half-imports
  - status transitions are persisted in correct order
  - manual retry clears/replaces previous chunks/chapters for same `book_id`
  - failed imports keep error + attempt history
- [ ] **End-to-end import tests (real fixtures):**
  - each fixture reaches `completed`
  - reader opens imported book
  - resume position persists after app reopen

#### 9.2 Invariants for every `completed` book

- [ ] `books.processing_status = completed`
- [ ] `processing_error IS NULL`
- [ ] `total_paragraphs > 0`
- [ ] `total_words > 0`
- [ ] paragraph ids start at `1` and increase by `+1` without gaps
- [ ] chapter count `> 0` or explicit fallback chapter `Full book`
- [ ] each chapter `start_paragraph_id` points to an existing paragraph id
- [ ] every paragraph appears in exactly one chunk row
- [ ] `book_chunks.chunk_index` starts at `0` and is gap-free
- [ ] recomputed paragraph/word/chunk counts match `books` table totals

#### 9.3 Content-truth tests on real fixture books

- [ ] For each fixture EPUB, define what "good parsing" means before implementation:
  - chapter order is human-correct
  - chapter titles are sensible (not file names/noise)
  - paragraph boundaries look natural (not merged garbage/single-word splits)
- [ ] Create fixture assertions from real book content (not only counts):
  - assert expected chapter titles/order for sampled chapters
  - assert selected paragraph snippets at deterministic positions
  - assert TOC-to-chapter mapping stays stable after refactors
- [ ] Store these expectations in tests so regressions fail loudly.

#### 9.4 Processing state-machine assertions

- [ ] Happy path transitions:
  - `queued -> validating -> extracting_metadata -> extracting_text -> building_chapters -> completed`
- [ ] Failure path transitions:
  - `queued -> ... -> failed` (must stop terminally, with stored error)
- [ ] No illegal transitions (example: `completed -> processing`)
- [ ] `updated_at` changes on each status transition
- [ ] `import_jobs.attempt` increments on each manual retry

#### 9.5 Handoff evidence package (required artifact)

- [ ] Test run summary with command + pass/fail counts
- [ ] Extraction report table for all 3 real fixture books
- [ ] State-transition log snippet per tested book
- [ ] Explicit note of any known limitations or flaky behavior

Use this report format in handoff:

| file | final_status | paragraphs | chapters | total_words | duration_ms | attempts | error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| plath-bell-jar.epub | completed | ... | ... | ... | ... | ... | null |
| fitzgerald-great-gatsby.epub | completed | ... | ... | ... | ... | ... | null |
| shelley-frankenstein.epub | completed | ... | ... | ... | ... | ... | null |

#### 9.6 Required commands and report location

- [ ] `bun test` must pass (unit + integration + parser coverage)
- [ ] `bun run build` must pass
- [ ] Add and run `bun run test:epub-fixtures` (or equivalent) for real-book end-to-end checks
- [ ] Save handoff report at:
  - `/Users/michalkrsik/windsurf_project_folder/universal_speed_reader/Devnotes/reports/android_import_validation.md`
- [ ] Save fixture expected metrics snapshot at:
  - `/Users/michalkrsik/windsurf_project_folder/universal_speed_reader/Devnotes/fixtures/expected_metrics.json`

### 10) TDD-first execution order (for the implementation agent)

- [ ] Write failing unit tests for parser + normalization rules first.
- [ ] Before implementing parser logic, inspect real fixture outputs and encode "good parse" expectations as tests (chapter mapping + sampled text snippets).
- [ ] Write failing DB integration tests for status transitions + retry replacement.
- [ ] Implement minimum code to pass unit and integration tests.
- [ ] Add fixture-based end-to-end tests and make them pass.
- [ ] After each parser change: run tests, inspect fixture output quality, and tighten tests if quality checks were only manual.
- [ ] Produce handoff evidence package from section 9.5.
- [ ] Only then mark migration steps complete.

## Out Of Scope (for now)

- [x] Folder upload behavior (batch import UX, error handling, retry behavior).
- [x] V1.1 storage-saving mode (processed-data eviction policy).
- [x] V1.1 backup/export-import format and UX.
