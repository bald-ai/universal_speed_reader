# Plan: Replace Carousel with Pill List in Mood Folder Cards

## Reference Implementation

**The approved UI lives at `src/sandbox/folder-card.tsx`.**
Run `sandbox.html` in the browser to see it live. Every visual decision — spacing, colors, touch targets, animations — is final in that file. When implementing, **match it exactly**. Do not improvise on the UI. The key components to port are:
- `BookRowContent` — text-only row (no cover thumbnails in the list)
- `ReorderableBookRow` — row with the subtle pill drag handle
- `SearchableBookList` — the fullscreen in-card overlay
- `FolderCard` body — single selected book default view + 🔍 trigger

### Critical visual spec (do not deviate)
- **Pill handle**: `w-[3px] h-4 rounded-full`, color `bg-white/[0.12]`, hover `bg-white/25`, active `bg-violet-400/40`
- **Touch target**: the outer `div` wrapping the pill is `w-6` (24px) — this is the grabbable zone
- **Drag feedback**: `scale: 1.02`, `boxShadow: "0 8px 25px rgba(0,0,0,0.5)"`, `backgroundColor: "rgba(30,25,50,0.95)"`
- **Selected row**: `bg-violet-500/15 border border-violet-500/20`
- **No cover thumbnails** in the list rows — text only to preserve readability at small card widths
- **Reorder disabled** while search query is non-empty (plain filtered list instead)

---

## Branch

```bash
git switch -c feat/mood-folder-pill-list
```

All work on this branch. Do not merge without review.

---

## Steps

### 1. Add callbacks in `MoodView` (parent component)

In `src/components/library/MoodView.tsx`, add two new callbacks alongside the existing `toggleBookInFolder`, `commitEdit`, etc.:

**`reorderFolderBooks(folderId, nextBookIds)`** — updates `folder.bookIds` order via the existing `applyFolderMutation → saveFolders` path. No store schema changes needed — `bookIds` order already persists.

```ts
const reorderFolderBooks = useCallback((folderId: string, nextBookIds: string[]) => {
  applyFolderMutation((current) => {
    let changed = false;
    const next = current.map((f) => {
      if (f.id !== folderId) return f;
      if (f.bookIds.length === nextBookIds.length && f.bookIds.every((id, i) => id === nextBookIds[i])) return f;
      changed = true;
      return { ...f, bookIds: nextBookIds };
    });
    return changed ? next : current;
  });
}, [applyFolderMutation]);
```

**`setFolderRecentBook(folderId, bookId)`** — sets which book is displayed on the card without opening the reader. Split from `openMostRecent`:

```ts
const setFolderRecentBook = useCallback((folderId: string, bookId: string) => {
  setRecentMap((prev) => ({ ...prev, [folderId]: bookId }));
  void setRecent(folderId, bookId)
    .then(() => setPersistError(null))
    .catch((err) => setPersistError(err instanceof Error ? err.message : "Failed to save recent book"));
}, []);

const openMostRecent = useCallback((folderId: string, bookId: string) => {
  setFolderRecentBook(folderId, bookId);
  onOpenBook(bookId);
}, [onOpenBook, setFolderRecentBook]);
```

Pass both to `FolderCard`:
- `onSelectRecentBook={setFolderRecentBook}`
- `onReorderBooks={reorderFolderBooks}`

### 2. Update `FolderCard` props

Add to `FolderCard` props interface:
```ts
onSelectRecentBook: (folderId: string, bookId: string) => void;
onReorderBooks: (folderId: string, nextBookIds: string[]) => void;
```

Add local state:
```ts
const [isPickerOpen, setIsPickerOpen] = useState(false);
```

Keep `isPickerOpen` **separate** from existing `menuState` to avoid overlay collisions with edit/delete/manage-books.

### 3. Replace carousel body with single selected-book view

**Remove** all carousel-specific code from `FolderCard`:
- `carouselRef`
- `activeSlideIndex` state
- `recentBookIndex` memo
- `syncActiveSlideFromScroll` callback
- All scroll-position `useEffect`s
- Left/right arrow indicator divs
- The `snap-x snap-mandatory` horizontal scroll container
- Per-book `snap-start` slide wrappers

**Replace** with the single-book view from the reference (see `FolderCard` body in `src/sandbox/folder-card.tsx`):
- `AnimatePresence mode="wait"` wrapping a `motion.button` keyed by `selectedBook.id`
- Clicking the book calls `onOpenRecent(folder.id, book.id)` (opens reader)

Derive selected book simply:
```ts
const selectedBookId = recentBookId && folder.bookIds.includes(recentBookId) ? recentBookId : folder.bookIds[0];
const selectedBook = selectedBookId ? bookById.get(selectedBookId) : undefined;
```

### 4. Add 🔍 button to card header

Add next to the existing `⋯` menu button. Disable while edit/delete/manage overlays are open:
```ts
const overlayLocked = isEditing || isManagingBooks || isDeleting;
// search button onClick:
if (overlayLocked) return;
setIsPickerOpen(true);
setMenuState("closed");
```

### 5. Port overlay components into `MoodView.tsx`

Add to framer-motion imports:
```ts
import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
```

Copy these components from `src/sandbox/folder-card.tsx` into `MoodView.tsx` as internal helpers:
- `BookRowContent`
- `ReorderableBookRow`
- `SearchableBookList` (rename to `FolderBookPickerOverlay` if preferred)

Wire overlay in `FolderCard` JSX — render alongside existing edit/delete/manage overlays using `AnimatePresence`.

### 6. Wire reorder to persist

In the overlay's `onReorder` callback, call `onReorderBooks(folder.id, newBookIds)`.

**Important**: Use `bookIds` (strings) as `Reorder.Group` values in production, not `LibraryBook` objects. This avoids object-identity issues:
```tsx
<Reorder.Group axis="y" values={orderedBookIds} onReorder={(nextIds) => onReorderBooks(folder.id, nextIds)}>
```

### 7. Guard against nested drag conflicts

The whole folder card is wrapped with dnd-kit sortable listeners for folder reordering. This conflicts with the framer-motion `Reorder` inside the picker overlay.

**Fix**: disable folder drag listeners while picker is open:
```tsx
<div ref={setNodeRef} style={sortableStyle} {...attributes} {...(!isPickerOpen ? listeners : {})}>
```

Also add `onPointerDown={(e) => e.stopPropagation()}` on the overlay root if needed.

### 8. Preserve existing overlays

Do NOT touch:
- Edit overlay (`menuState === "edit"`)
- Delete overlay (`menuState === "delete"`)
- Manage-books overlay (`menuState === "books"`)

They stay exactly as they are.

---

## What NOT to change
- `src/lib/moodStore.ts` — no schema or API changes needed
- `src/types/book.ts` — no type changes needed
- `sandbox.html` / `src/sandbox/` — leave as reference, do not delete

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Nested drag conflict (dnd-kit folders vs framer-motion books) | Disable folder listeners when picker is open |
| Stale `recentBookId` (book removed from folder) | Fallback: `recentBookId exists in bookIds ? use it : first book` |
| Overlay state collision (picker + edit/delete open simultaneously) | `isPickerOpen` is separate; block opening while `menuState !== "closed"` |
| Reorder while filtering | Disabled — plain filtered list when query is non-empty |


