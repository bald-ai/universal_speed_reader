# Universal Speed Reader Documentation

## Android app identity

The Capacitor Android module is installed as `com.traycer.speedreader`. It is
registered with the other local Android apps in
[`../ANDROID_APP_IDS.md`](../ANDROID_APP_IDS.md). Before uploading an APK to a
phone, verify its embedded package ID using that registry; Android treats two
APKs with the same `applicationId` as one app and replaces the existing one.

## Why The App Preprocesses Books

Universal Speed Reader is not only a basic EPUB reader. The app is meant to be a universal reading surface where the same book can move between normal reading, speed reading, TTS, pronunciation fixes, chapter-aware pacing, and progress tracking.

Most EPUB readers keep the EPUB as the main source of truth and ask a rendering engine to display sections or pages on demand. That is fast for opening a traditional reader, but it makes app-level features harder because positions are tied to renderer-specific concepts such as pages, scroll offsets, DOM ranges, or EPUB CFIs.

This app imports EPUBs and selectable-text PDFs into a normalized internal model:

- paragraphs with stable sequential IDs
- words addressed by paragraph ID and word index
- chapters mapped to paragraph starts
- optional in-book image blocks anchored after paragraphs (normal reading only)
- optional anonymous scene boundaries anchored before a real paragraph
- total word and paragraph counts
- stored chunks for persistence

The key reader position is:

```ts
{ paragraphId, wordIndex }
```

This model lets Universal Speed Reader go beyond a basic reader:

- Speed reading can synchronously ask for the current word and next word without relying on an EPUB renderer during the timed playback loop.
- Normal reading and speed reading share the same position model, so the app can return from speed mode and highlight the exact word where the user stopped.
- Progress survives font size changes, layout changes, device rotation, and padding changes because it is saved as a logical text position, not as a visual page or scroll offset.
- TTS can build spoken chunks while mapping each spoken word back to its exact book position.
- Chapter-aware pacing can add pauses or slowdowns at paragraph and chapter boundaries.
- Book-level features such as word counts, chapter progress, pronunciation-rule previews, and library progress can be computed from app-owned text data.

The tradeoff is import cost. The app does more work before a book becomes fully readable than a basic file renderer would. It extracts text, builds chapters, computes word counts, chunks content, and stores normalized data.

That cost is intentional because it buys a richer and more reliable reading model. The part to optimize is not the existence of preprocessing itself, but how much of it must happen before first read.

Future improvements should preserve the normalized model while reducing the wait, for example by making books readable after the first usable content is available and continuing deeper processing in the background.

## In-book images

The normalized book model can also store sidecar image blocks for normal reading:

```ts
{ id, afterParagraphId, alt, src }
```

- `afterParagraphId` anchors the image after a paragraph (`0` means before the first paragraph).
- Images are shown only in normal reading, interleaved with paragraphs.
- Speed reading and TTS stay on the existing `{ paragraphId, wordIndex }` text model and ignore images.
- On EPUB import, zip-relative image paths are stored as-is in `book_images.src` (not base64-materialized).
- On PDF import, image pointers carry their page and crop location; the reader renders that part of the stored PDF only when it is needed.
- While reading, the app loads each image on demand from the raw EPUB in IndexedDB and caches a `blob:` URL.
- Inline `<svg>` markup is still serialized to a `data:image/svg+xml...` string at parse time and stored directly.
- Supported raster formats: jpeg, png, webp, gif. SVG is supported both as zip `.svg` assets and as inline `<svg>` markup.
- The production importer is intentionally strict: a book with missing, blank, or unplaceable in-book images is rejected instead of silently losing content.
- Books imported before this change may still have materialized `data:image/...` rows; those keep working. New imports use path references.
- SQLite schema version 2 adds the `book_images` table via a normal migration (`user_version`), not an ad-hoc create on every open.

## Soft vs hard import failures

Import trusts flawed-but-usable books and only hard-fails fully unusable ones.

- **Soft issues** (missing/broken images, garbled decoding text, missing cover, weak chapters, ornament junk, picture-heavy/low-text) complete as `processing_status: "completed"` with `books.processing_warnings` (`{ code, message }` JSON). The library row stays openable and shows a warning mark with plain explanations such as “Some pictures are missing.”
- **Hard failures** (unreadable/unsupported/too large, almost no usable text, broken paragraph IDs, timeout/save failure, unsafe model integrity) are recorded under **Last import** only for new imports. The book is deleted from the library and storage the same way as a user delete — no dead Failed rows remain. There is no user-facing Failed-row **Retry import**. Re-processing an existing book is **Restore to original** (Edit); if that hard-fails, the book is **not** deleted — prior content and soft warnings stay, and the book remains completed/openable while the UI reports the restore error. Metadata (title/cover/warnings) is only written after content replace succeeds, so a failed restore cannot mix a new cover/title onto the old body.
- Soft image issues drop invalid or oversized inline image payloads instead of storing them, and warn that some pictures are missing.
- Last import reports per-book **OK** / **With issues** / **Failed**, plus counts and timing. For a purged hard-fail, try again by importing the file again.
- Soft vs hard classification uses stable diagnostic `code` values (with message fallbacks for older uncoded diagnostics).
- Schema version 4 adds `processing_warnings`. A one-time startup cleanup removes any leftover `processing_status = "failed"` rows from older imports.

## Library covers

On import, the app materializes the library cover into a `data:image/...;base64,...` string and stores that in `books.cover_path` so library UI can use it directly as an `<img src>`. EPUB covers come from the raw EPUB archive. PDF covers are rendered from the first page. SVG covers are supported for EPUBs.

Library and Mood book rows show a compact `EPUB` or `PDF` badge derived from the
stored `books.source_uri`. This uses existing import metadata and requires no
database migration.

Manual cover edits already store data URLs the same way. Books imported before this change may still have a bare zip path (broken in the library); **Restore to original** re-runs import and repairs the cover. There is no automatic backfill for old rows.

## Deleting books during import

Library delete is always available, including while a book shows Processing. Delete cancels the active/queued import for that book, removes its DB rows and raw EPUB, and ignores any late write from the cancelled worker.

## Android file selection

Android's WebView file chooser can collapse a mixed EPUB/PDF `accept` list to one
MIME type and can restore a stale storage path that appears empty. Android uses
the app's native picker bridge instead: it requests EPUB/PDF files, starts at the
system Downloads root, and validates the selected filenames and MIME types before
import. Browser builds keep the native HTML file filter.

## Book processing

The production parser is based on the validated extraction work in `book-parser-lab/`. The lab remains available for corpus research, while the app uses a browser/Android-compatible version of the same EPUB and PDF extraction logic.

The extractor preserves mixed nested-container prose and DOM-order media,
including images referenced by inline, embedded, and linked CSS. Complex SVG
assets with unresolved external dependencies fail strict validation rather than
producing pointers that would render blank through the reader.

- EPUB 2/3 and selectable-text PDFs are supported.
- Scanned/OCR-only PDFs, fixed-layout EPUBs, comics, DRM-locked books, and books
  without enough usable text or a safe reading model hard-fail and are removed
  from the library after import. Soft quality issues such as missing images or
  weak chapters complete with warnings instead.
- The parser keeps the shared `{ paragraphId, wordIndex }` model used by normal
  reading, speed reading, TTS, and saved progress.
- PDF paragraph reconstruction profiles page-local line gaps so a repeated,
  modest paragraph-gap cluster is accepted when sentence context agrees. If a
  selectable-text PDF still produces a model that would fail the strict
  collapsed-paragraph check, aligned explicit line endings plus sentence
  boundaries are used for one conservative recovery pass. When a generator has
  also flattened paragraph starts into the middle of physical lines, only
  already-oversized prose blocks with repeated sentence-boundary evidence are
  divided into moderate reading chunks. Punctuation-free collapsed text remains
  rejected; the validator is not relaxed.
- PDF chapter reconstruction can replace production-file bookmarks (for
  example cover/interior filenames) with a document-wide visible-heading
  sequence. It also recovers chapter headings flattened into body lines only
  when consecutive chapter numbers are spread through the book; a compact
  contents sequence may provide the exact titles without becoming duplicate
  reader chapters. A raw asterisk ornament immediately before such a recovered
  chapter is removed so the reader's existing chapter divider is shown instead.
- EPUB scene ornaments, context-qualified horizontal rules, and narrowly
  identified CSS separators (semantic classes, ornament pseudo-content,
  centered spacing, and narrow rules from inline or linked stylesheets) are
  normalized into the same paragraph-anchored scene boundary.
  PDF import recognizes isolated ornament lines, conservative embedded ornament
  runs, and distinctly larger page-local whitespace gaps. Inline stars used for
  omissions, footnotes, or ordinary notation remain readable text.
- Anonymous scene boundaries never receive paragraph IDs or words. Normal
  reading renders a quiet accessible asterism, RSVP pauses longer than at a
  paragraph and shorter than at a chapter, and TTS uses deterministic silent
  pauses of 280 ms / 650 ms / 1,000 ms for paragraph / scene / chapter changes.
  A named navigation entry (part, chapter, section, or named scene) takes
  precedence when it begins at the same paragraph. Navigation kind and level
  are persisted, shown hierarchically in the navigation menu, and rendered with
  distinct part/chapter/section/named-scene separators.
- Compact PDF contents sequences used to recover chapter names are removed from
  linear prose. The first chapter divider is shown when front matter precedes
  it, and a matching in-body heading is not rendered a second time.
- The parser runs with a 30-second quality ceiling; a book exceeding it is
  rejected rather than completing with unreliable data.

## Parser-release fresh start

This parser release performs one product-owner-approved, one-time library reset
on first launch. It deletes existing books, their stored original files,
progress, folders, and moods so every imported book uses the new extraction
path. Book-scoped TTS replacement rules are also removed; global rules and
reader preferences such as theme and speed settings remain intact.
