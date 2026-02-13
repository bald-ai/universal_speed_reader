import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
import type { LibraryBook, MoodFolder } from "@/types/book";
import { getUnassignedBooks, loadFolders, loadRecent, saveFolders, setRecent } from "@/lib/moodStore";
import { MOOD_ICONS, getIconEmoji } from "@/lib/moodIcons";

type MoodViewProps = {
  books: LibraryBook[];
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

const iconKeyForFolder = (folder: MoodFolder): string | undefined => {
  if (folder.icon) return folder.icon;
  const k = folder.label.trim().toLowerCase();
  if (k === "tired") return "moon";
  if (k === "chill") return "leaf";
  if (k === "magical") return "sparkles";
  if (k === "curious") return "telescope";
  return undefined;
};

const iconForFolder = (folder: MoodFolder): string => {
  const fromStore = getIconEmoji(folder.icon);
  if (fromStore) return fromStore;
  const k = folder.label.trim().toLowerCase();
  if (k === "tired") return "\uD83C\uDF19";
  if (k === "chill") return "\uD83C\uDF3F";
  if (k === "magical") return "\u2728";
  if (k === "curious") return "\uD83D\uDD2D";
  return "\uD83D\uDCDA";
};

const folderTheme = (folder: MoodFolder) => {
  const emoji = iconForFolder(folder);
  const colorKey = folder.color ?? DEFAULT_FOLDER_COLOR;
  const palette = FOLDER_COLORS.find((c) => c.key === colorKey) ?? FOLDER_COLORS.find((c) => c.key === DEFAULT_FOLDER_COLOR)!;
  return { ...palette, emoji };
};

const gradientForFolder = (folder: MoodFolder): string => folderTheme(folder).swatch;

const genreChipTheme = (genre: string | undefined) => {
  const g = (genre ?? "").toLowerCase();
  if (g === "romance") return "border-rose-500/30 bg-rose-500/10 text-rose-200";
  if (g === "science") return "border-sky-500/30 bg-sky-500/10 text-sky-200";
  if (g === "fantasy") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  if (g === "casual nonfiction") return "border-lime-500/30 bg-lime-500/10 text-lime-200";
  return "border-violet-500/30 bg-violet-500/10 text-violet-200";
};

function FolderPicker(props: {
  folders: MoodFolder[];
  book: LibraryBook;
  onToggleInFolder: (folderId: string, bookId: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const { folders, book, onToggleInFolder, open, onClose } = props;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute right-0 top-[calc(100%+8px)] z-30 w-56 rounded-xl border border-neutral-800 bg-neutral-900 shadow-xl shadow-black/40 overflow-hidden"
    >
      <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-neutral-500 border-b border-neutral-800">
        Add to folder
      </div>
      <div className="max-h-64 overflow-auto">
        {folders.map((f) => {
          const checked = f.bookIds.includes(book.id);
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onToggleInFolder(f.id, book.id)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-neutral-800 transition-colors"
            >
              <div className={`h-7 w-7 rounded-lg ${gradientForFolder(f)} border border-neutral-700`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-neutral-100 truncate">{f.label}</div>
              </div>
              <div className="w-5 text-right text-neutral-300">
                {checked ? "✓" : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function MoodView(props: MoodViewProps) {
  const { books, onOpenBook } = props;
  const [folders, setFolders] = useState<MoodFolder[]>([]);
  const [recent, setRecentMap] = useState<Record<string, string>>({});
  const [newEditId, setNewEditId] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null); // bookId

  useEffect(() => {
    setFolders(loadFolders());
    setRecentMap(loadRecent());
  }, []);

  const bookById = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);

  const unassigned = useMemo(() => getUnassignedBooks(folders, books), [folders, books]);

  const toggleBookInFolder = (folderId: string, bookId: string) => {
    setFolders((prev) => {
      const next = prev.map((f) => {
        if (f.id !== folderId) return f;
        const has = f.bookIds.includes(bookId);
        return { ...f, bookIds: has ? f.bookIds.filter((id) => id !== bookId) : [...f.bookIds, bookId] };
      });
      saveFolders(next);
      return next;
    });
  };

  const commitEdit = useCallback((folderId: string, label: string, icon?: string, color?: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    setFolders((prev) => {
      const next = prev.map((f) => (f.id === folderId ? { ...f, label: nextLabel, icon, color: color ?? f.color } : f));
      saveFolders(next);
      return next;
    });
  }, []);

  const deleteFolder = useCallback((folderId: string) => {
    setFolders((prev) => {
      const next = prev.filter((f) => f.id !== folderId);
      saveFolders(next);
      return next;
    });
  }, []);

  const createFolder = () => {
    const id = `mood-${Date.now().toString(36)}`;
    const f: MoodFolder = { id, label: "New Folder", color: DEFAULT_FOLDER_COLOR, bookIds: [] };
    setFolders((prev) => {
      const next = [...prev, f];
      saveFolders(next);
      return next;
    });
    setNewEditId(id);
  };

  const openMostRecent = (folderId: string, bookId: string) => {
    setRecent(folderId, bookId);
    setRecentMap((m) => ({ ...m, [folderId]: bookId }));
    onOpenBook(bookId);
  };

  const sensors = useSensors(
   useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
   const { active, over } = event;
   if (!over || active.id === over.id) return;
   setFolders((prev) => {
     const oldIndex = prev.findIndex((f) => f.id === active.id);
     const newIndex = prev.findIndex((f) => f.id === over.id);
     if (oldIndex === -1 || newIndex === -1) return prev;
     const next = arrayMove(prev, oldIndex, newIndex);
     saveFolders(next);
     return next;
   });
  }, []);

  const folderIds = useMemo(() => folders.map((f) => f.id), [folders]);

  return (
   <motion.section
     initial={{ opacity: 0, y: 14 }}
     animate={{ opacity: 1, y: 0 }}
     transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
     className="space-y-6"
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
               onOpenRecent={openMostRecent}
               onToggleBook={(bookId) => toggleBookInFolder(folder.id, bookId)}
               startInEditMode={newEditId === folder.id}
               onConsumeEditMode={() => setNewEditId(null)}
               onCommitEdit={commitEdit}
               onDeleteFolder={deleteFolder}
             />
           ))}
         </div>
       </SortableContext>
     </DndContext>

      <button
        type="button"
        onClick={createFolder}
        className="w-full rounded-2xl border border-dashed border-neutral-700 bg-neutral-900/20 px-4 py-4 text-sm text-neutral-500
          hover:border-violet-500/40 hover:text-violet-400 transition-colors"
      >
        + New Folder
      </button>

      <div className="pt-2">
        <div className="text-xs uppercase tracking-[0.2em] text-neutral-500 mb-3 px-1">
          Unassigned
        </div>

        <div className="space-y-2">
          {unassigned.length === 0 ? (
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-sm text-neutral-500">
              All books are in at least one folder.
            </div>
          ) : (
            unassigned.map((b) => (
              <div
                key={b.id}
                className="relative rounded-2xl border border-neutral-800 bg-gradient-to-br from-neutral-900/95 to-neutral-800/90 px-4 py-3 shadow-lg shadow-black/40"
              >
                <div className="grid grid-cols-[1fr_auto] items-center gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-neutral-100 truncate">{b.title}</div>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wider ${genreChipTheme(
                          b.genre
                        )}`}
                      >
                        {b.genre}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-neutral-400 truncate">{b.author ?? "Unknown author"}</div>
                  </div>

                  <div className="relative justify-self-end">
                    <button
                      type="button"
                      onClick={() => setPickerFor((cur) => (cur === b.id ? null : b.id))}
                      className="rounded-xl border border-neutral-700 bg-neutral-900/60 px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-neutral-900 transition-colors"
                    >
                      Add to folder
                    </button>
                    <FolderPicker
                      folders={folders}
                      book={b}
                      open={pickerFor === b.id}
                      onClose={() => setPickerFor(null)}
                      onToggleInFolder={toggleBookInFolder}
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </motion.section>
  );
}

function FolderCard(props: {
  folder: MoodFolder;
  bookById: Map<string, LibraryBook>;
  recentBookId: string | undefined;
  onOpenRecent: (folderId: string, bookId: string) => void;
  onToggleBook: (bookId: string) => void;
  startInEditMode: boolean;
  onConsumeEditMode: () => void;
  onCommitEdit: (folderId: string, label: string, icon?: string, color?: string) => void;
  onDeleteFolder: (folderId: string) => void;
}) {
  const {
    folder,
    bookById,
    recentBookId,
    onOpenRecent,
    onToggleBook,
    startInEditMode,
    onConsumeEditMode,
    onCommitEdit,
    onDeleteFolder,
  } = props;

  const [menuState, setMenuState] = useState<LocalMenuState>(startInEditMode ? "edit" : "closed");
  const [renameDraft, setRenameDraft] = useState(folder.label);
  const [iconDraft, setIconDraft] = useState<string | undefined>(iconKeyForFolder(folder));
  const [colorDraft, setColorDraft] = useState<string | undefined>(folder.color);

  useEffect(() => {
    if (startInEditMode) {
      setMenuState("edit");
      setRenameDraft(folder.label);
      setIconDraft(iconKeyForFolder(folder));
      setColorDraft(folder.color);
      onConsumeEditMode();
    }
  }, [startInEditMode, folder, onConsumeEditMode]);

  const ref = useRef<HTMLDivElement | null>(null);
  const theme = folderTheme(folder);

  useEffect(() => {
    if (menuState === "closed") return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setMenuState("closed");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuState]);

  const allBooksInFolder = folder.bookIds.map((id) => bookById.get(id)).filter(Boolean) as LibraryBook[];
  const bookCount = allBooksInFolder.length;

  const resolvedRecentId = (() => {
    if (recentBookId && folder.bookIds.includes(recentBookId)) return recentBookId;
    return folder.bookIds[0];
  })();
  const recentBook = resolvedRecentId ? bookById.get(resolvedRecentId) : undefined;

  const isEditing = menuState === "edit";
  const isManagingBooks = menuState === "books";
  const isMenuOpen = menuState === "menu";
  const isDeleting = menuState === "delete";

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
    <div ref={setNodeRef} style={sortableStyle} {...attributes} {...listeners}>
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

        <div className="relative px-3 pt-3 pb-1 flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-base leading-none select-none shrink-0">{theme.emoji}</span>
            <div className="text-xs font-bold text-neutral-50 tracking-tight truncate">{folder.label}</div>
            <span className="text-[10px] text-neutral-500 shrink-0">{bookCount}</span>
          </div>

          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                if (isEditing || isDeleting) return;
                setMenuState(isMenuOpen ? "closed" : "menu");
              }}
              className="h-6 w-6 rounded-md bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-neutral-200 text-xs transition-colors flex items-center justify-center"
              aria-label="Folder menu"
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

        <div className="relative px-3 pb-3 pt-1 flex-1 flex flex-col">
          {recentBook ? (
            <button
              type="button"
              onClick={() => onOpenRecent(folder.id, recentBook.id)}
              disabled={!!recentBook.isMock}
              className="w-full flex-1 rounded-xl bg-black/20 border border-white/5
                hover:bg-black/30 hover:border-white/10 active:scale-[0.98]
                transition-all duration-150 px-4 py-4 text-left flex flex-col
                disabled:hover:bg-black/20 disabled:hover:border-white/5 disabled:active:scale-100 disabled:cursor-not-allowed"
            >
              <div className="flex-1 flex items-center justify-center opacity-[0.12] pointer-events-none">
                <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={0.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                </svg>
              </div>
              <div className="mt-auto">
                <div className="text-sm font-semibold text-neutral-100 leading-snug line-clamp-2">{recentBook.title}</div>
                <div className="text-[11px] text-neutral-400 truncate mt-1">{recentBook.author ?? "Unknown author"}</div>
              </div>
            </button>
          ) : (
            <div className="flex-1 rounded-xl bg-black/10 border border-white/[0.03] flex flex-col items-center justify-center gap-2 px-4">
              <svg className="w-10 h-10 text-neutral-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={0.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
              <div className="text-[11px] text-neutral-600">Add books to start</div>
            </div>
          )}
        </div>

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
                    placeholder="Folder name"
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
                        aria-label="Remove from folder"
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
                Remove <span className="font-semibold">{folder.label}</span>?
              </div>
              <div className="text-[11px] text-neutral-400 mt-1 text-center">Books return to unassigned</div>
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
