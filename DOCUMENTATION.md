# Universal Speed Reader Documentation

## Why The App Preprocesses Books

Universal Speed Reader is not only a basic EPUB reader. The app is meant to be a universal reading surface where the same book can move between normal reading, speed reading, TTS, pronunciation fixes, chapter-aware pacing, and progress tracking.

Most EPUB readers keep the EPUB as the main source of truth and ask a rendering engine to display sections or pages on demand. That is fast for opening a traditional reader, but it makes app-level features harder because positions are tied to renderer-specific concepts such as pages, scroll offsets, DOM ranges, or EPUB CFIs.

This app instead imports an EPUB into a normalized internal model:

- paragraphs with stable sequential IDs
- words addressed by paragraph ID and word index
- chapters mapped to paragraph starts
- optional in-book image blocks anchored after paragraphs (normal reading only)
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

The tradeoff is import cost. The app does more work before a book becomes fully readable than a basic EPUB renderer would. It extracts text, builds chapters, computes word counts, chunks content, and stores normalized data.

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
- On import, zip-relative image paths are materialized to `data:image/...` strings and stored in `book_images`.
- Supported raster formats: jpeg, png, webp, gif. SVG is also supported both as zip `.svg` assets and as inline `<svg>` markup (serialized to a data URL).
- Missing or unsupported images soft-fail; they do not fail the whole import.
- Books imported before this change need a retry/re-import to gain images. There is no automatic backfill.
- SQLite schema version 2 adds the `book_images` table via a normal migration (`user_version`), not an ad-hoc create on every open.

## Library covers

On import, the app materializes the EPUB cover into a `data:image/...;base64,...` string and stores that in `books.cover_path` so library UI can use it directly as an `<img src>`. The EPUB parser still returns a zip-relative cover path; conversion happens during import execution when the raw EPUB bytes are available. SVG covers are supported the same way as other image assets.

Manual cover edits already store data URLs the same way. Books imported before this change may still have a bare zip path (broken in the library); retry or restore re-runs import and repairs the cover. There is no automatic backfill for old rows.

## Deleting books during import

Library delete is always available, including while a book shows Processing. Delete cancels the active/queued import for that book, removes its DB rows and raw EPUB, and ignores any late write from the cancelled worker.
