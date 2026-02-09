import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, Reorder, motion, useDragControls } from "framer-motion";
import type { LibraryBook, MoodFolder } from "@/types/book";
import { getUnassignedBooks, loadFolders, loadRecent, saveFolders, setRecent } from "@/lib/moodStore";

type MoodViewProps = {
  books: LibraryBook[];
  onOpenBook: (bookId: string) => void;
};

type FolderMenuState =
  | { kind: "closed" }
  | { kind: "menu"; folderId: string }
  | { kind: "rename"; folderId: string }
  | { kind: "delete"; folderId: string };

const iconGrip = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
    <path d="M7 4a1 1 0 11-2 0 1 1 0 012 0zm0 6a1 1 0 11-2 0 1 1 0 012 0zm-1 5a1 1 0 100 2 1 1 0 000-2zm9-11a1 1 0 10-2 0 1 1 0 002 0zm-1 5a1 1 0 100 2 1 1 0 000-2zm1 6a1 1 0 11-2 0 1 1 0 012 0z" />
  </svg>
);

const gradientForFolder = (folder: MoodFolder): string => {
  const k = folder.label.trim().toLowerCase();
  if (k === "tired") return "bg-gradient-to-br from-rose-500/40 to-pink-500/30";
  if (k === "chill") return "bg-gradient-to-br from-lime-500/35 to-teal-500/30";
  if (k === "magical") return "bg-gradient-to-br from-amber-500/35 to-fuchsia-500/30";
  if (k === "curious") return "bg-gradient-to-br from-sky-500/35 to-emerald-500/30";
  return "bg-gradient-to-br from-violet-600/30 to-cyan-600/25";
};

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
  const [menu, setMenu] = useState<FolderMenuState>({ kind: "closed" });
  const [renameDraft, setRenameDraft] = useState("");
  const [expandedFolderId, setExpandedFolderId] = useState<string | null>(null);
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

  const removeBookFromFolder = (folderId: string, bookId: string) => {
    setFolders((prev) => {
      const next = prev.map((f) => (f.id === folderId ? { ...f, bookIds: f.bookIds.filter((id) => id !== bookId) } : f));
      saveFolders(next);
      return next;
    });
  };

  const commitRename = (folderId: string, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) {
      setMenu({ kind: "closed" });
      return;
    }
    setFolders((prev) => {
      const next = prev.map((f) => (f.id === folderId ? { ...f, label: nextLabel } : f));
      saveFolders(next);
      return next;
    });
    setMenu({ kind: "closed" });
  };

  const createFolder = () => {
    const id = `mood-${Date.now().toString(36)}`;
    const f: MoodFolder = { id, label: "New Folder", bookIds: [] };
    setFolders((prev) => {
      const next = [...prev, f];
      saveFolders(next);
      return next;
    });
    setRenameDraft("New Folder");
    setMenu({ kind: "rename", folderId: id });
  };

  const openMostRecent = (folderId: string, bookId: string) => {
    setRecent(folderId, bookId);
    setRecentMap((m) => ({ ...m, [folderId]: bookId }));
    onOpenBook(bookId);
  };

  const expandedFolder = expandedFolderId ? folders.find((f) => f.id === expandedFolderId) : undefined;
  const expandedBooks = useMemo(() => {
    if (!expandedFolder) return [];
    return expandedFolder.bookIds.map((id) => bookById.get(id)).filter(Boolean) as LibraryBook[];
  }, [expandedFolder, bookById]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="space-y-6"
    >
      <Reorder.Group
        axis="y"
        values={folders}
        onReorder={(next) => {
          setFolders(next);
          saveFolders(next);
        }}
        className="grid grid-cols-2 gap-4"
      >
        {folders.map((folder) => (
          <FolderCard
            key={folder.id}
            folder={folder}
            bookById={bookById}
            recentBookId={recent[folder.id]}
            expanded={expandedFolderId === folder.id}
            onToggleExpanded={() => setExpandedFolderId((cur) => (cur === folder.id ? null : folder.id))}
            onOpenRecent={openMostRecent}
            menu={menu}
            setMenu={setMenu}
            renameDraft={renameDraft}
            setRenameDraft={setRenameDraft}
            onCommitRename={commitRename}
            onDeleteFolder={() => {
              setFolders((prev) => {
                const next = prev.filter((f) => f.id !== folder.id);
                saveFolders(next);
                return next;
              });
              setMenu({ kind: "closed" });
            }}
          />
        ))}
      </Reorder.Group>

      <AnimatePresence initial={false}>
        {expandedFolder ? (
          <motion.div
            key={expandedFolder.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2 }}
            className="rounded-2xl border border-neutral-800 bg-gradient-to-br from-neutral-900/95 to-neutral-800/90 p-5 shadow-lg shadow-black/40"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-[0.2em] text-neutral-500">Folder</div>
                <div className="mt-1 text-lg font-semibold text-neutral-100 truncate">{expandedFolder.label}</div>
              </div>
              <button
                type="button"
                onClick={() => setExpandedFolderId(null)}
                className="h-9 w-9 rounded-xl border border-neutral-800 bg-neutral-900/60 text-neutral-300 hover:bg-neutral-900 transition-colors"
                aria-label="Close folder"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-2">
              {expandedBooks.length === 0 ? (
                <div className="text-sm text-neutral-500">No books in this folder yet.</div>
              ) : (
                expandedBooks.map((b) => (
                  <div
                    key={b.id}
                    className="relative flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-950/25 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-neutral-100 truncate">{b.title}</div>
                      <div className="text-xs text-neutral-500 truncate">{b.author ?? "Unknown author"}</div>
                    </div>

                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setPickerFor((cur) => (cur === b.id ? null : b.id))}
                        className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] font-semibold text-neutral-200 hover:bg-neutral-900 transition-colors"
                        title="Add to other folders"
                      >
                        Add
                      </button>
                      <FolderPicker
                        folders={folders}
                        book={b}
                        open={pickerFor === b.id}
                        onClose={() => setPickerFor(null)}
                        onToggleInFolder={toggleBookInFolder}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => removeBookFromFolder(expandedFolder.id, b.id)}
                      className="text-neutral-500 hover:text-red-400 transition-colors"
                      aria-label="Remove from folder"
                      title="Remove from this folder"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

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
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenRecent: (folderId: string, bookId: string) => void;
  menu: FolderMenuState;
  setMenu: (s: FolderMenuState) => void;
  renameDraft: string;
  setRenameDraft: (v: string) => void;
  onCommitRename: (folderId: string, label: string) => void;
  onDeleteFolder: () => void;
}) {
  const {
    folder,
    bookById,
    recentBookId,
    expanded,
    onToggleExpanded,
    onOpenRecent,
    menu,
    setMenu,
    renameDraft,
    setRenameDraft,
    onCommitRename,
    onDeleteFolder,
  } = props;

  const controls = useDragControls();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const open = menu.kind !== "closed";
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setMenu({ kind: "closed" });
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu.kind, setMenu]);

  const allBooksInFolder = folder.bookIds.map((id) => bookById.get(id)).filter(Boolean) as LibraryBook[];
  const bookCount = allBooksInFolder.length;

  const resolvedRecentId = (() => {
    if (recentBookId && folder.bookIds.includes(recentBookId)) return recentBookId;
    return folder.bookIds[0];
  })();
  const recentBook = resolvedRecentId ? bookById.get(resolvedRecentId) : undefined;

  const isRenaming = menu.kind === "rename" && menu.folderId === folder.id;
  const isMenuOpen = menu.kind === "menu" && menu.folderId === folder.id;
  const isDeleting = menu.kind === "delete" && menu.folderId === folder.id;

  return (
    <Reorder.Item
      value={folder}
      dragListener={false}
      dragControls={controls}
      className="w-full"
    >
      <motion.div
        ref={ref}
        whileHover={{ y: -3, transition: { duration: 0.2, ease: "easeOut" } }}
        className={`relative w-full h-full min-h-[190px] rounded-2xl border bg-gradient-to-br from-neutral-900/95 to-neutral-800/90
          p-4 text-left shadow-lg shadow-black/40 transition-colors duration-200 flex flex-col ${
            expanded ? "border-violet-500/40" : "border-neutral-800 hover:border-violet-500/40"
          }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onPointerDown={(e) => controls.start(e)}
              className="mt-1 text-neutral-500 hover:text-neutral-300 transition-colors cursor-grab active:cursor-grabbing"
              aria-label="Drag to reorder"
              title="Drag"
            >
              {iconGrip}
            </button>

            <div className={`h-12 w-12 rounded-xl ${gradientForFolder(folder)} border border-neutral-700`} />

            <div className="min-w-0">
              {isRenaming ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => onCommitRename(folder.id, renameDraft)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommitRename(folder.id, renameDraft);
                    if (e.key === "Escape") setMenu({ kind: "closed" });
                  }}
                  className="w-full rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-100 px-3 py-1 text-base font-semibold outline-none"
                />
              ) : (
                <div className="text-base font-semibold text-neutral-100 truncate">{folder.label}</div>
              )}
              <div className="mt-1 text-xs text-neutral-400">
                {bookCount} {bookCount === 1 ? "book" : "books"}
              </div>
            </div>
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => {
                if (isRenaming || isDeleting) return;
                setMenu(isMenuOpen ? { kind: "closed" } : { kind: "menu", folderId: folder.id });
                setRenameDraft(folder.label);
              }}
              className="h-9 w-9 rounded-xl border border-neutral-800 bg-neutral-900/60 text-neutral-300 hover:bg-neutral-900 transition-colors"
              aria-label="Folder menu"
            >
              ⋯
            </button>

            <AnimatePresence>
              {isMenuOpen ? (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-[calc(100%+8px)] z-20 w-32 rounded-xl border border-neutral-800 bg-neutral-900 shadow-xl shadow-black/40 overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setMenu({ kind: "rename", folderId: folder.id });
                      setRenameDraft(folder.label);
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 transition-colors"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => setMenu({ kind: "delete", folderId: folder.id })}
                    className="w-full px-3 py-2 text-left text-sm text-red-300 hover:bg-neutral-800 transition-colors"
                  >
                    Delete
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <div className="mt-3">
          {recentBook ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/30 px-3 py-2">
              <div className="text-sm font-semibold text-neutral-100 truncate">{recentBook.title}</div>
              <div className="mt-0.5 text-xs text-neutral-400 truncate">{recentBook.author ?? "Unknown author"}</div>
            </div>
          ) : (
            <div className="text-sm text-neutral-500">No books yet.</div>
          )}
        </div>

        <div className="mt-auto pt-3 space-y-2">
          {recentBook ? (
            <button
              type="button"
              onClick={() => onOpenRecent(folder.id, recentBook.id)}
              disabled={!!recentBook.isMock}
              className="w-full rounded-xl bg-neutral-100 text-neutral-900 text-sm font-semibold px-4 py-2
                hover:bg-white transition-colors duration-150 disabled:bg-neutral-800 disabled:text-neutral-400 disabled:hover:bg-neutral-800 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          ) : null}

          {bookCount > 0 ? (
            <button
              type="button"
              onClick={onToggleExpanded}
              className="w-full rounded-xl border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs font-semibold text-neutral-300 hover:bg-neutral-900 transition-colors"
            >
              {expanded ? "Hide books" : `Show all (${bookCount})`}
            </button>
          ) : null}
        </div>

        <AnimatePresence initial={false}>
          {isDeleting ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.15 }}
              className="mt-3 rounded-2xl border border-red-500/20 bg-red-950/20 px-4 py-3"
            >
              <div className="text-sm text-neutral-200">
                Remove folder? <span className="text-neutral-400">Books return to unassigned.</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMenu({ kind: "closed" })}
                  className="rounded-xl border border-neutral-700 bg-neutral-900/60 px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-neutral-900 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onDeleteFolder}
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/15 transition-colors"
                >
                  Confirm
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </Reorder.Item>
  );
}
