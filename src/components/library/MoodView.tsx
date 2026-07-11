import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import AddLibraryFolderToMoodSheet from "@/components/library/AddLibraryFolderToMoodSheet";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LibraryBook, Mood } from "@/types/book";
import type { LibraryLayout } from "@/types/libraryLayout";
import { addBookIdsToMood, loadMoods, loadRecent, saveMoods, setRecent } from "@/lib/moodStore";
import { MOOD_ICONS, getIconEmoji } from "@/lib/moodIcons";
import { getBookCoverPlaceholder } from "@/lib/library/coverPlaceholders";

type MoodViewProps = {
  books: LibraryBook[];
  libraryLayout: LibraryLayout;
  onOpenBook: (bookId: string) => void;
};

type LocalMenuState = "closed" | "menu" | "edit" | "books" | "delete";

const FOLDER_COLORS = [
  { key: "rose", label: "Rose", gradient: "from-rose-500/20 via-pink-900/15 to-transparent", border: "border-rose-500/25", hoverBorder: "hover:border-rose-400/50", glow: "bg-rose-500/30", swatch: "bg-gradient-to-br from-rose-500/40 to-pink-500/30", actionBg: "bg-rose-500/10 hover:bg-rose-500/20 border-rose-500/20" },
  { key: "emerald", label: "Emerald", gradient: "from-emerald-500/20 via-teal-900/15 to-transparent", border: "border-emerald-500/25", hoverBorder: "hover:border-emerald-400/50", glow: "bg-emerald-500/30", swatch: "bg-gradient-to-br from-lime-500/35 to-teal-500/30", actionBg: "bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/20" },
  { key: "fuchsia", label: "Fuchsia", gradient: "from-fuchsia-500/20 via-violet-900/15 to-transparent", border: "border-fuchsia-500/25", hoverBorder: "hover:border-fuchsia-400/50", glow: "bg-fuchsia-500/30", swatch: "bg-gradient-to-br from-amber-500/35 to-fuchsia-500/30", actionBg: "bg-fuchsia-500/10 hover:bg-fuchsia-500/20 border-fuchsia-500/20" },
  { key: "sky", label: "Sky", gradient: "from-sky-500/20 via-cyan-900/15 to-transparent", border: "border-sky-500/25", hoverBorder: "hover:border-sky-400/50", glow: "bg-sky-500/30", swatch: "bg-gradient-to-br from-sky-500/35 to-emerald-500/30", actionBg: "bg-sky-500/10 hover:bg-sky-500/20 border-sky-500/20" },
  { key: "violet", label: "Violet", gradient: "from-violet-500/20 via-indigo-900/15 to-transparent", border: "border-violet-500/25", hoverBorder: "hover:border-violet-400/50", glow: "bg-violet-500/30", swatch: "bg-gradient-to-br from-violet-600/30 to-cyan-600/25", actionBg: "bg-violet-500/10 hover:bg-violet-500/20 border-violet-500/20" },
  { key: "amber", label: "Amber", gradient: "from-amber-500/20 via-orange-900/15 to-transparent", border: "border-amber-500/25", hoverBorder: "hover:border-amber-400/50", glow: "bg-amber-500/30", swatch: "bg-gradient-to-br from-amber-500/35 to-orange-500/30", actionBg: "bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/20" },
  { key: "cyan", label: "Cyan", gradient: "from-cyan-500/20 via-teal-900/15 to-transparent", border: "border-cyan-500/25", hoverBorder: "hover:border-cyan-400/50", glow: "bg-cyan-500/30", swatch: "bg-gradient-to-br from-cyan-500/35 to-blue-500/30", actionBg: "bg-cyan-500/10 hover:bg-cyan-500/20 border-cyan-500/20" },
  { key: "lime", label: "Lime", gradient: "from-lime-500/20 via-green-900/15 to-transparent", border: "border-lime-500/25", hoverBorder: "hover:border-lime-400/50", glow: "bg-lime-500/30", swatch: "bg-gradient-to-br from-lime-500/35 to-green-500/30", actionBg: "bg-lime-500/10 hover:bg-lime-500/20 border-lime-500/20" },
] as const;

const DEFAULT_FOLDER_COLOR = "violet";

const iconKeyForFolder = (folder: Mood): string | undefined => {
  if (folder.icon) return folder.icon;
  const k = folder.label.trim().toLowerCase();
  if (k === "tired") return "moon";
  if (k === "chill") return "leaf";
  if (k === "magical") return "sparkles";
  if (k === "curious") return "telescope";
  return undefined;
};

const iconForFolder = (folder: Mood): string => {
  const fromStore = getIconEmoji(folder.icon);
  if (fromStore) return fromStore;
  const k = folder.label.trim().toLowerCase();
  if (k === "tired") return "\uD83C\uDF19";
  if (k === "chill") return "\uD83C\uDF3F";
  if (k === "magical") return "\u2728";
  if (k === "curious") return "\uD83D\uDD2D";
  return "\uD83D\uDCDA";
};

const folderTheme = (folder: Mood) => {
  const emoji = iconForFolder(folder);
  const colorKey = folder.color ?? DEFAULT_FOLDER_COLOR;
  const palette = FOLDER_COLORS.find((c) => c.key === colorKey) ?? FOLDER_COLORS.find((c) => c.key === DEFAULT_FOLDER_COLOR)!;
  return { ...palette, emoji };
};

function MoodBookCover(props: { coverUrl?: string; progressPercent: number; title: string }) {
  const { coverUrl, progressPercent, title } = props;
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);

  useEffect(() => {
    setCoverLoadFailed(false);
  }, [coverUrl]);

  const resolvedCoverUrl = useMemo(() => {
    if (coverUrl && !coverLoadFailed) {
      return coverUrl;
    }
    return getBookCoverPlaceholder(progressPercent);
  }, [coverLoadFailed, coverUrl, progressPercent]);

  const isUsingPlaceholder = !coverUrl || coverLoadFailed;

  return (
    <div className="mb-2 flex-1 overflow-hidden rounded-lg">
      <img
        src={resolvedCoverUrl}
        alt={title}
        className={`h-full w-full ${isUsingPlaceholder ? "object-contain p-3" : "object-cover"}`}
        loading="lazy"
        decoding="async"
        onError={coverUrl && !coverLoadFailed ? () => setCoverLoadFailed(true) : undefined}
      />
    </div>
  );
}

function FolderCardProgressBar({ percent }: { percent: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-violet-400 transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-[11px] font-semibold tabular-nums text-neutral-100">{percent}%</span>
    </div>
  );
}

function BookRowContent(props: { book: LibraryBook; isSelected: boolean }) {
  const { book, isSelected } = props;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[12px] font-medium text-neutral-100 ${isSelected ? "text-violet-200" : ""}`}>
          {book.title}
        </div>
        <div className="truncate text-[10px] text-neutral-500">{book.author ?? "Unknown author"}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="text-[10px] tabular-nums text-neutral-400">{Math.round(book.progressPercent)}%</span>
        <div className="h-0.5 w-8 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-violet-400" style={{ width: `${book.progressPercent}%` }} />
        </div>
      </div>
    </div>
  );
}

function ReorderableBookRow(props: {
  value: string;
  book: LibraryBook;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { value, book, isSelected, onSelect } = props;
  const controls = useDragControls();

  return (
    <Reorder.Item
      value={value}
      dragListener={false}
      dragControls={controls}
      className={`flex items-center rounded-lg border transition-colors ${
        isSelected
          ? "border-violet-500/20 bg-violet-500/15"
          : "border-transparent hover:bg-white/5"
      }`}
      whileDrag={{
        scale: 1.02,
        boxShadow: "0 8px 25px rgba(0,0,0,0.5)",
        backgroundColor: "rgba(30,25,50,0.95)",
        borderRadius: 8,
        zIndex: 50,
      }}
    >
      <div
        className="flex w-6 shrink-0 cursor-grab items-center justify-center py-2 pl-0.5 pr-1 touch-none active:cursor-grabbing"
        onPointerDown={(event) => {
          event.stopPropagation();
          controls.start(event);
        }}
      >
        <div className="h-4 w-[3px] rounded-full bg-white/[0.12] transition-colors hover:bg-white/25 active:bg-violet-400/40" />
      </div>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 py-2 pl-0 pr-2.5 text-left">
        <BookRowContent book={book} isSelected={isSelected} />
      </button>
    </Reorder.Item>
  );
}

function FolderBookPickerOverlay(props: {
  books: LibraryBook[];
  orderedBookIds: string[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onReorder: (nextBookIds: string[]) => void;
  onClose: () => void;
}) {
  const { books, orderedBookIds, selectedId, onSelect, onReorder, onClose } = props;
  const [query, setQuery] = useState("");
  const bookById = useMemo(() => new Map(books.map((book) => [book.id, book])), [books]);

  const filteredBooks = useMemo(() => {
    if (!query.trim()) return books;
    const normalizedQuery = query.toLowerCase();
    return books.filter((book) => {
      const author = book.author ?? "";
      return book.title.toLowerCase().includes(normalizedQuery) || author.toLowerCase().includes(normalizedQuery);
    });
  }, [books, query]);

  const isFiltering = query.trim().length > 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onPointerDown={(event) => event.stopPropagation()}
      className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-2xl bg-neutral-900/[0.97] backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <div className="relative flex-1">
          <svg
            className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            placeholder={`Search ${books.length} books...`}
            className="w-full rounded-lg border border-white/10 bg-black/40 py-1.5 pl-6.5 pr-2 text-[11px] text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 focus:border-violet-500/40"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/5 text-[10px] text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-200"
        >
          &#x2715;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {filteredBooks.length === 0 ? (
          <div className="flex h-20 items-center justify-center">
            <div className="text-[11px] italic text-neutral-600">No matches</div>
          </div>
        ) : isFiltering ? (
          <div className="space-y-0.5">
            {filteredBooks.map((book) => (
              <button
                key={book.id}
                type="button"
                onClick={() => onSelect(book.id)}
                className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  book.id === selectedId
                    ? "border-violet-500/20 bg-violet-500/15"
                    : "border-transparent hover:bg-white/5"
                }`}
              >
                <BookRowContent book={book} isSelected={book.id === selectedId} />
              </button>
            ))}
          </div>
        ) : (
          <Reorder.Group axis="y" values={orderedBookIds} onReorder={onReorder} className="space-y-0.5">
            {orderedBookIds.map((bookId) => {
              const book = bookById.get(bookId);
              if (!book) return null;

              return (
                <ReorderableBookRow
                  key={book.id}
                  value={book.id}
                  book={book}
                  isSelected={book.id === selectedId}
                  onSelect={() => onSelect(book.id)}
                />
              );
            })}
          </Reorder.Group>
        )}
      </div>
    </motion.div>
  );
}

function AddBookToMoodSheet(props: {
  mood: Mood;
  books: LibraryBook[];
  onClose: () => void;
  onAddBook: (moodId: string, bookId: string) => void;
}) {
  const { mood, books, onClose, onAddBook } = props;
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredBooks = useMemo(() => {
    if (!normalizedQuery) return books;
    return books.filter((book) => {
      const author = book.author ?? "";
      return book.title.toLowerCase().includes(normalizedQuery) || author.toLowerCase().includes(normalizedQuery);
    });
  }, [books, normalizedQuery]);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
      <div className="max-h-[82dvh] w-full overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60">
        <div className="border-b border-neutral-800 p-4">
          <div className="text-sm font-semibold text-neutral-100">Add book to {mood.label}</div>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search books..."
            className="mt-3 w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-violet-400/60"
          />
        </div>
        <div className="max-h-[58dvh] overflow-auto p-2">
          {filteredBooks.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-3 text-sm text-neutral-500">
              No books found.
            </div>
          ) : (
            filteredBooks.map((book) => {
              const alreadyInMood = mood.bookIds.includes(book.id);
              return (
                <button
                  key={book.id}
                  type="button"
                  disabled={alreadyInMood}
                  onClick={() => {
                    onAddBook(mood.id, book.id);
                    onClose();
                  }}
                  className="mb-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-neutral-100">{book.title}</span>
                    <span className="block truncate text-xs text-neutral-500">{book.author ?? "Unknown author"}</span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">{alreadyInMood ? "Already there" : "Add"}</span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-neutral-800 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          <button type="button" onClick={onClose} className="w-full rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MoodView(props: MoodViewProps) {
  const { books, libraryLayout, onOpenBook } = props;
  const [folders, setFolders] = useState<Mood[]>([]);
  const [recent, setRecentMap] = useState<Record<string, string>>({});
  const [newEditId, setNewEditId] = useState<string | null>(null);
  const [addingFolderToMoodId, setAddingFolderToMoodId] = useState<string | null>(null);
  const [addingBookToMoodId, setAddingBookToMoodId] = useState<string | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const foldersRef = useRef<Mood[]>([]);
  const folderMutationIdRef = useRef(0);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedFolders, loadedRecent] = await Promise.all([loadMoods(), loadRecent()]);
        if (cancelled) return;
        foldersRef.current = loadedFolders;
        setFolders(loadedFolders);
        setRecentMap(loadedRecent);
        setPersistError(null);
      } catch (error) {
        if (!cancelled) {
          setPersistError(error instanceof Error ? error.message : "Failed to load moods");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  const bookById = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);

  const persistFoldersWithRollback = useCallback(
    (next: Mood[], previous: Mood[], mutationId: number) => {
      persistQueueRef.current = persistQueueRef.current
        .then(async () => {
          try {
            await saveMoods(next);
            if (folderMutationIdRef.current === mutationId) {
              setPersistError(null);
            }
          } catch (error) {
            if (folderMutationIdRef.current === mutationId) {
              foldersRef.current = previous;
              setFolders(previous);
            }
            setPersistError(error instanceof Error ? error.message : "Failed to save moods");
          }
        })
        .catch(() => undefined);
    },
    []
  );

  const applyFolderMutation = useCallback(
    (mutate: (current: Mood[]) => Mood[]) => {
      const previous = foldersRef.current;
      const next = mutate(previous);
      if (next === previous) return;

      const mutationId = folderMutationIdRef.current + 1;
      folderMutationIdRef.current = mutationId;
      foldersRef.current = next;
      setFolders(next);
      persistFoldersWithRollback(next, previous, mutationId);
    },
    [persistFoldersWithRollback]
  );

  const toggleBookInFolder = useCallback((folderId: string, bookId: string) => {
    applyFolderMutation((current) => {
      let changed = false;
      const next = current.map((f) => {
        if (f.id !== folderId) return f;
        changed = true;
        const has = f.bookIds.includes(bookId);
        return {
          ...f,
          bookIds: has ? f.bookIds.filter((id) => id !== bookId) : [...f.bookIds, bookId],
        };
      });
      return changed ? next : current;
    });
  }, [applyFolderMutation]);

  const reorderFolderBooks = useCallback((folderId: string, nextBookIds: string[]) => {
    applyFolderMutation((current) => {
      let changed = false;
      const next = current.map((folder) => {
        if (folder.id !== folderId) return folder;
        if (
          folder.bookIds.length === nextBookIds.length &&
          folder.bookIds.every((bookId, index) => bookId === nextBookIds[index])
        ) {
          return folder;
        }

        changed = true;
        return { ...folder, bookIds: nextBookIds };
      });
      return changed ? next : current;
    });
  }, [applyFolderMutation]);

  const commitEdit = useCallback((folderId: string, label: string, icon?: string, color?: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    applyFolderMutation((current) => {
      let changed = false;
      const next = current.map((f) => {
        if (f.id !== folderId) return f;
        changed = true;
        return { ...f, label: nextLabel, icon, color: color ?? f.color };
      });
      return changed ? next : current;
    });
  }, [applyFolderMutation]);

  const deleteFolder = useCallback((folderId: string) => {
    applyFolderMutation((current) => {
      const next = current.filter((f) => f.id !== folderId);
      return next.length === current.length ? current : next;
    });
  }, [applyFolderMutation]);

  const addBooksToMood = useCallback((folderId: string, bookIds: string[]) => {
    applyFolderMutation((current) => {
      return addBookIdsToMood(current, folderId, bookIds);
    });
  }, [applyFolderMutation]);

  const createFolder = useCallback(() => {
    const id = `mood-${Date.now().toString(36)}`;
    const f: Mood = { id, label: "New Mood", color: DEFAULT_FOLDER_COLOR, bookIds: [] };
    applyFolderMutation((current) => [...current, f]);
    setNewEditId(id);
  }, [applyFolderMutation]);

  const setFolderRecentBook = useCallback((folderId: string, bookId: string) => {
    setRecentMap((previous) => ({ ...previous, [folderId]: bookId }));
    void setRecent(folderId, bookId)
      .then(() => {
        setPersistError(null);
      })
      .catch((error) => {
        setPersistError(error instanceof Error ? error.message : "Failed to save recent book");
      });
  }, []);

  const openMostRecent = useCallback((folderId: string, bookId: string) => {
    setFolderRecentBook(folderId, bookId);
    onOpenBook(bookId);
  }, [onOpenBook, setFolderRecentBook]);

  const sensors = useSensors(
   useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    applyFolderMutation((current) => {
      const oldIndex = current.findIndex((f) => f.id === String(active.id));
      const newIndex = current.findIndex((f) => f.id === String(over.id));
      if (oldIndex === -1 || newIndex === -1) return current;
      return arrayMove(current, oldIndex, newIndex);
    });
  }, [applyFolderMutation]);

  const folderIds = useMemo(() => folders.map((f) => f.id), [folders]);
  const moodForFolderImport = addingFolderToMoodId
    ? folders.find((folder) => folder.id === addingFolderToMoodId) ?? null
    : null;
  const moodForBookImport = addingBookToMoodId
    ? folders.find((folder) => folder.id === addingBookToMoodId) ?? null
    : null;

  return (
   <motion.section
     initial={{ opacity: 0, y: 14 }}
     animate={{ opacity: 1, y: 0 }}
     transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
     className="space-y-6 mt-2"
   >
     <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
       <SortableContext items={folderIds} strategy={rectSortingStrategy}>
         <div className="grid grid-cols-2 gap-4">
           {folders.map((folder) => (
             <FolderCard
               key={folder.id}
               folder={folder}
               bookById={bookById}
               recentBookId={recent[folder.id]}
               onOpenRecent={(folderId, bookId) => {
                 void openMostRecent(folderId, bookId);
               }}
               onSelectRecentBook={setFolderRecentBook}
               onReorderBooks={reorderFolderBooks}
               onToggleBook={(bookId) => {
                 toggleBookInFolder(folder.id, bookId);
               }}
               startInEditMode={newEditId === folder.id}
               onConsumeEditMode={() => setNewEditId(null)}
               onCommitEdit={(folderId, label, icon, color) => {
                 commitEdit(folderId, label, icon, color);
               }}
               onDeleteFolder={(folderId) => {
                 deleteFolder(folderId);
               }}
               onAddLibraryFolder={(folderId) => {
                 setAddingFolderToMoodId(folderId);
               }}
               onAddBook={(folderId) => {
                 setAddingBookToMoodId(folderId);
               }}
             />
           ))}
         </div>
       </SortableContext>
     </DndContext>

      <button
        type="button"
        onClick={() => {
          createFolder();
        }}
        className="w-full rounded-2xl border border-dashed border-neutral-700 bg-neutral-900/20 px-4 py-4 text-sm text-neutral-500
          hover:border-violet-500/40 hover:text-violet-400 transition-colors"
      >
        + New Mood
      </button>

      {persistError ? (
        <div className="rounded-xl border border-red-500/35 bg-red-950/35 px-3 py-2 text-xs text-red-200">
          {persistError}
        </div>
      ) : null}

      {moodForFolderImport ? (
        <AddLibraryFolderToMoodSheet
          mood={moodForFolderImport}
          books={books}
          layout={libraryLayout}
          onClose={() => setAddingFolderToMoodId(null)}
          onConfirm={addBooksToMood}
        />
      ) : null}
      {moodForBookImport ? (
        <AddBookToMoodSheet
          mood={moodForBookImport}
          books={books}
          onClose={() => setAddingBookToMoodId(null)}
          onAddBook={(moodId, bookId) => addBooksToMood(moodId, [bookId])}
        />
      ) : null}
    </motion.section>
  );
}

function FolderCard(props: {
  folder: Mood;
  bookById: Map<string, LibraryBook>;
  recentBookId: string | undefined;
  onOpenRecent: (folderId: string, bookId: string) => void;
  onSelectRecentBook: (folderId: string, bookId: string) => void;
  onReorderBooks: (folderId: string, nextBookIds: string[]) => void;
  onToggleBook: (bookId: string) => void;
  startInEditMode: boolean;
  onConsumeEditMode: () => void;
  onCommitEdit: (folderId: string, label: string, icon?: string, color?: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onAddLibraryFolder: (folderId: string) => void;
  onAddBook: (folderId: string) => void;
}) {
  const {
    folder,
    bookById,
    recentBookId,
    onOpenRecent,
    onSelectRecentBook,
    onReorderBooks,
    onToggleBook,
    startInEditMode,
    onConsumeEditMode,
    onCommitEdit,
    onDeleteFolder,
    onAddLibraryFolder,
    onAddBook,
  } = props;

  const [menuState, setMenuState] = useState<LocalMenuState>(startInEditMode ? "edit" : "closed");
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(folder.label);
  const [iconDraft, setIconDraft] = useState<string | undefined>(iconKeyForFolder(folder));
  const [colorDraft, setColorDraft] = useState<string | undefined>(folder.color);

  useEffect(() => {
    if (startInEditMode) {
      setMenuState("edit");
      setIsPickerOpen(false);
      setRenameDraft(folder.label);
      setIconDraft(iconKeyForFolder(folder));
      setColorDraft(folder.color);
      onConsumeEditMode();
    }
  }, [startInEditMode, folder, onConsumeEditMode]);

  const ref = useRef<HTMLDivElement | null>(null);
  const theme = folderTheme(folder);

  useEffect(() => {
    if (menuState === "closed" && !isPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setMenuState("closed");
      setIsPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [isPickerOpen, menuState]);

  const allBooksInFolder = folder.bookIds.map((id) => bookById.get(id)).filter(Boolean) as LibraryBook[];
  const bookCount = allBooksInFolder.length;
  const selectedBookId = recentBookId && folder.bookIds.includes(recentBookId) ? recentBookId : folder.bookIds[0];
  const selectedBook = selectedBookId ? bookById.get(selectedBookId) : undefined;

  const isEditing = menuState === "edit";
  const isManagingBooks = menuState === "books";
  const isMenuOpen = menuState === "menu";
  const isDeleting = menuState === "delete";
  const overlayLocked = isEditing || isManagingBooks || isDeleting;
  const searchDisabled = overlayLocked || bookCount === 0;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition: sortableTransition,
    isDragging,
  } = useSortable({ id: folder.id });

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition: sortableTransition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div ref={setNodeRef} style={sortableStyle} {...attributes} {...(!isPickerOpen ? listeners : {})}>
      <motion.div
        ref={ref}
        whileHover={isDragging ? undefined : { y: -4, transition: { duration: 0.25, ease: "easeOut" } }}
        className={`group relative w-full h-full min-h-[300px] rounded-2xl border overflow-hidden
          bg-neutral-900 text-left shadow-lg shadow-black/50
          transition-all duration-300 flex flex-col ${
            `${theme.border} ${theme.hoverBorder}`
          }`}
      >
        <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradient} pointer-events-none`} />
        <div className={`absolute -top-10 -right-10 w-28 h-28 ${theme.glow} rounded-full blur-3xl pointer-events-none opacity-40 group-hover:opacity-70 transition-opacity duration-500`} />

        <div className="relative px-2.5 pt-2 pb-0 flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-base leading-none select-none shrink-0">{theme.emoji}</span>
            <div className="text-xs font-bold text-neutral-50 tracking-tight truncate">{folder.label}</div>
            <span className="text-[10px] text-neutral-500 shrink-0">{bookCount}</span>
          </div>

          <div className="relative flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                if (searchDisabled) return;
                setIsPickerOpen(true);
                setMenuState("closed");
              }}
              disabled={searchDisabled}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-white/5 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Browse mood books"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => {
                if (isEditing || isDeleting) return;
                setMenuState(isMenuOpen ? "closed" : "menu");
              }}
              className="h-6 w-6 rounded-md bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-neutral-200 text-xs transition-colors flex items-center justify-center"
              aria-label="Mood menu"
            >
              &#x22EF;
            </button>

            <AnimatePresence>
              {isMenuOpen ? (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-[calc(100%+6px)] z-20 w-36 rounded-xl border border-white/10 bg-neutral-900/95 backdrop-blur-xl shadow-xl shadow-black/50 overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onAddLibraryFolder(folder.id);
                      setMenuState("closed");
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-neutral-200 hover:bg-white/5 transition-colors"
                  >
                    Add folder
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onAddBook(folder.id);
                      setMenuState("closed");
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-neutral-200 hover:bg-white/5 transition-colors"
                  >
                    Add book
                  </button>
                  {bookCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setMenuState("books")}
                      className="w-full px-3 py-2 text-left text-xs text-neutral-200 hover:bg-white/5 transition-colors"
                    >
                      Books
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setRenameDraft(folder.label);
                      setIconDraft(iconKeyForFolder(folder));
                      setColorDraft(folder.color);
                      setMenuState("edit");
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-neutral-200 hover:bg-white/5 transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setMenuState("delete")}
                    className="w-full px-3 py-2 text-left text-xs text-red-300 hover:bg-white/5 transition-colors"
                  >
                    Delete
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <div className="relative flex flex-1 flex-col px-2 pt-1 pb-2">
          {selectedBook ? (
            <AnimatePresence mode="wait">
              <motion.button
                key={selectedBook.id}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.2 }}
                type="button"
                onClick={() => onOpenRecent(folder.id, selectedBook.id)}
                className="flex flex-1 flex-col rounded-xl border border-white/5 bg-black/20 px-3 py-3 text-left transition-all duration-150 hover:border-white/10 hover:bg-black/30 active:scale-[0.98]"
              >
                <MoodBookCover
                  coverUrl={selectedBook.coverUrl}
                  progressPercent={Math.max(0, Math.min(100, Math.round(selectedBook.progressPercent)))}
                  title={selectedBook.title}
                />
                <div className="mt-auto">
                  <div className="line-clamp-2 text-sm font-semibold leading-snug text-neutral-100">
                    {selectedBook.title}
                  </div>
                  <div className="mt-1 text-[11px] text-neutral-400 truncate">
                    {selectedBook.author ?? "Unknown author"}
                  </div>
                  <div className="mt-2">
                    <FolderCardProgressBar percent={Math.max(0, Math.min(100, Math.round(selectedBook.progressPercent)))} />
                  </div>
                </div>
              </motion.button>
            </AnimatePresence>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-white/[0.03] bg-black/10 px-4">
              <svg className="h-10 w-10 text-neutral-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={0.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
              <div className="text-[11px] text-neutral-600">Add books to start</div>
            </div>
          )}
        </div>

        <AnimatePresence initial={false}>
          {isPickerOpen && bookCount > 0 ? (
            <FolderBookPickerOverlay
              books={allBooksInFolder}
              orderedBookIds={allBooksInFolder.map((book) => book.id)}
              selectedId={selectedBook?.id}
              onSelect={(bookId) => {
                onSelectRecentBook(folder.id, bookId);
                setIsPickerOpen(false);
              }}
              onReorder={(nextBookIds) => {
                onReorderBooks(folder.id, nextBookIds);
              }}
              onClose={() => setIsPickerOpen(false)}
            />
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {isEditing ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 bg-neutral-900/[0.97] backdrop-blur-sm rounded-2xl flex flex-col overflow-hidden"
            >
              <div className="px-3 pt-3 pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg shrink-0 select-none">{iconDraft ? (getIconEmoji(iconDraft) ?? theme.emoji) : theme.emoji}</span>
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { onCommitEdit(folder.id, renameDraft, iconDraft, colorDraft); setMenuState("closed"); }
                      if (e.key === "Escape") setMenuState("closed");
                    }}
                    placeholder="Mood name"
                    className="flex-1 min-w-0 rounded-lg bg-black/30 border border-white/10 text-neutral-100 px-2.5 py-1.5 text-sm font-semibold outline-none focus:border-white/20 transition-colors"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-auto px-3">
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2">Pick an icon</div>
                <div className="grid grid-cols-5 gap-1.5">
                  {MOOD_ICONS.map((icon) => (
                    <button
                      key={icon.key}
                      type="button"
                      onClick={() => setIconDraft(icon.key)}
                      className={`aspect-square rounded-lg flex items-center justify-center text-lg transition-all duration-150 ${
                        iconDraft === icon.key
                          ? "bg-white/15 ring-1 ring-white/40 scale-110"
                          : "bg-white/5 hover:bg-white/10"
                      }`}
                    >
                      {icon.emoji}
                    </button>
                  ))}
                </div>
              </div>

              <div className="px-3 pt-1 pb-1">
                <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2">Pick a color</div>
                <div className="grid grid-cols-4 gap-1.5">
                  {FOLDER_COLORS.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setColorDraft(c.key)}
                      className={`h-8 rounded-lg ${c.swatch} border transition-all duration-150 ${
                        colorDraft === c.key
                          ? "ring-1 ring-white/40 scale-105 border-white/30"
                          : "border-white/5 hover:border-white/15"
                      }`}
                      title={c.label}
                    />
                  ))}
                </div>
              </div>

              <div className="px-3 pb-3 pt-2">
                <button
                  type="button"
                  onClick={() => { onCommitEdit(folder.id, renameDraft, iconDraft, colorDraft); setMenuState("closed"); }}
                  className="w-full rounded-xl bg-white/90 text-neutral-900 text-sm font-semibold py-2 hover:bg-white transition-colors"
                >
                  Save
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {isManagingBooks ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 bg-neutral-900/[0.97] backdrop-blur-sm rounded-2xl flex flex-col overflow-hidden"
            >
              <div className="px-3 pt-3 pb-2 flex items-center justify-between">
                <div className="text-xs font-bold text-neutral-50 tracking-tight">Books</div>
                <button
                  type="button"
                  onClick={() => setMenuState("closed")}
                  className="h-6 w-6 rounded-md bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-neutral-200 text-[10px] transition-colors flex items-center justify-center"
                >
                  &#x2715;
                </button>
              </div>

              <div className="flex-1 overflow-auto px-3 pb-3 space-y-1">
                {allBooksInFolder.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-[11px] text-neutral-500 italic">No books yet</div>
                  </div>
                ) : (
                  allBooksInFolder.map((b) => (
                    <div
                      key={b.id}
                      className="w-full flex items-center gap-2 rounded-lg bg-white/[0.05] border border-white/5 px-2.5 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium text-neutral-100 truncate leading-snug">{b.title}</div>
                        <div className="text-[10px] text-neutral-500 truncate">{b.author ?? "Unknown"}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onToggleBook(b.id)}
                        className="shrink-0 h-5 w-5 rounded-md bg-white/5 hover:bg-red-500/20 text-neutral-500 hover:text-red-300 text-[10px] transition-colors flex items-center justify-center"
                        aria-label="Remove from mood"
                      >
                        &#x2715;
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {isDeleting ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm rounded-2xl px-4"
            >
              <div className="text-sm text-neutral-200 text-center">
                Remove mood <span className="font-semibold">{folder.label}</span>?
              </div>
              <div className="text-[11px] text-neutral-400 mt-1 text-center">Books stay in your Library.</div>
              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMenuState("closed")}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { onDeleteFolder(folder.id); setMenuState("closed"); }}
                  className="rounded-xl border border-red-500/30 bg-red-500/15 px-4 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/25 transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
