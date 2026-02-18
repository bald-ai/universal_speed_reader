# Mood Folder Carousel — Implementation Plan

**Reference prototype:** `prototype/transitions.html`  
Horizontal scroll carousel with chevron hints, dot indicators, and per-book progress bars.

---

## Step 1: Add `progressPercent` to `LibraryBook`

- `src/types/book.ts:25` — add `progressPercent: number` to `LibraryBook`
- `src/pages/Home.tsx:62` — map `progressPercent` from `LibraryEntry` into `libraryBooks`

## Step 2: Convert FolderCard to horizontal scroll carousel

- `src/components/library/MoodView.tsx:498-527` — replace single "recent book" display with a scroll container holding all `folder.bookIds` as slides
- CSS: `overflow-x: auto`, `scroll-snap-type: x mandatory`, each slide `flex: 0 0 100%`
- Keep empty-folder placeholder as-is

## Step 3: Add progress bar + percentage to each slide

- Each book slide shows the purple progress bar and percentage text (matching prototype)
- Look up `progressPercent` from the `books` prop by book ID

## Step 4: Add chevron hints + dot indicators

- Subtle chevron SVGs on left/right edges at 15% opacity
- Hide left chevron on first slide, hide right on last
- Dot row below carousel, active dot highlighted
- Single `onScroll` listener drives both

## Step 5: Auto-scroll to most recently read book

- `moodStore` already tracks `recent: Record<folderId, bookId>`
- On mount, find the index of the recent bookId in `folder.bookIds` and `scrollTo` that slide (no animation, instant)

## Step 6: Verify overlays still work

- Edit, manage-books, and delete overlays (MoodView.tsx lines 530-689) render on top of the card — these must not break when the inner content changes to a carousel

## Step 7: Lint + build gate

- `bun run lint` and `bun run build` must pass

---

## What stays the same

- Folder grid layout (2-column `grid-cols-2`)
- Drag-to-reorder via `@dnd-kit`
- Folder header (emoji, name, count, menu)
- All overlay states (edit, manage, delete)
- Unassigned section below folders

## Decisions

- Most recently read book in the folder auto-scrolls to front on mount
- 2-column layout stays as-is
