/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  REFERENCE IMPLEMENTATION — "Pill List" Folder Card          ║
 * ║                                                              ║
 * ║  This is the approved design for the book switcher inside    ║
 * ║  mood folder cards. Use this file as the source of truth     ║
 * ║  when porting into MoodView.tsx.                             ║
 * ║                                                              ║
 * ║  Key design decisions:                                       ║
 * ║  • Default view: single selected book (cover + info)         ║
 * ║  • 🔍 icon in header opens fullscreen in-card overlay        ║
 * ║  • Overlay: searchable list, text-only rows (no thumbnails)  ║
 * ║  • Reorder: 3px visible pill on left edge, 24px (w-6)        ║
 * ║    touch target. Pill glows violet on press.                  ║
 * ║  • Reorder disabled while search query is active             ║
 * ║  • Selecting a row closes overlay, shows that book           ║
 * ║  • Tapping the main book card opens it (reader)              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import type { LibraryBook, MoodFolder } from "@/types/book";
import { getBookCoverPlaceholder } from "@/lib/library/coverPlaceholders";

/* ── colour palette ── */
const FOLDER_COLORS = [
  { key: "violet", gradient: "from-violet-500/20 via-indigo-900/15 to-transparent", border: "border-violet-500/25", hoverBorder: "hover:border-violet-400/50", glow: "bg-violet-500/30" },
] as const;
const DEFAULT_FOLDER_COLOR = "violet";
const folderTheme = (folder: MoodFolder) => {
  const colorKey = folder.color ?? DEFAULT_FOLDER_COLOR;
  const palette = FOLDER_COLORS.find((c) => c.key === colorKey) ?? FOLDER_COLORS[0];
  return { ...palette, emoji: "📚" };
};

/* ── MoodBookCover ── */
function MoodBookCover(props: { coverUrl?: string; progressPercent: number; title: string; className?: string }) {
  const { coverUrl, progressPercent, title, className = "" } = props;
  const [fail, setFail] = useState(false);
  useEffect(() => { setFail(false); }, [coverUrl]);
  const src = useMemo(() => (coverUrl && !fail) ? coverUrl : getBookCoverPlaceholder(progressPercent), [fail, coverUrl, progressPercent]);
  const placeholder = !coverUrl || fail;
  return (
    <div className={`overflow-hidden rounded-lg ${className}`}>
      <img src={src} alt={title} className={`h-full w-full ${placeholder ? "object-contain p-2" : "object-cover"}`}
        loading="lazy" decoding="async" onError={coverUrl && !fail ? () => setFail(true) : undefined} />
    </div>
  );
}

/* ── Progress bar ── */
function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full bg-violet-400 transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-[11px] text-neutral-100 font-semibold tabular-nums">{percent}%</span>
    </div>
  );
}

/* ──────────────────────────────────────────────
   BookRowContent — text-only row (no thumbnail)
   Used inside both reorderable and plain lists.
   ────────────────────────────────────────────── */
function BookRowContent({ book, isSelected }: { book: LibraryBook; isSelected: boolean }) {
  return (
    <div className="flex-1 min-w-0 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className={`text-[12px] font-medium text-neutral-100 truncate ${isSelected ? "text-violet-200" : ""}`}>{book.title}</div>
        <div className="text-[10px] text-neutral-500 truncate">{book.author}</div>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-0.5">
        <span className="text-[10px] text-neutral-400 tabular-nums">{Math.round(book.progressPercent)}%</span>
        <div className="w-8 h-0.5 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full rounded-full bg-violet-400" style={{ width: `${book.progressPercent}%` }} />
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────
   ReorderableBookRow — single row with pill handle

   IMPORTANT VISUAL SPEC:
   • Pill: w-[3px] h-4 rounded-full
   • Pill color: bg-white/[0.12], hover → bg-white/25,
     active (pressing) → bg-violet-400/40
   • Touch target: w-6 (24px) — the outer div is the
     grab zone, the pill is just the visual indicator
   • Row highlight when selected: bg-violet-500/15
     with border-violet-500/20
   • Drag feedback: scale 1.02, elevated shadow,
     dark purple-tinted bg
   ────────────────────────────────────────────── */
function ReorderableBookRow({ book, isSelected, onSelect }: {
  book: LibraryBook; isSelected: boolean; onSelect: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item value={book}
      dragListener={false}
      dragControls={controls}
      className={`flex items-center rounded-lg transition-colors ${
        isSelected ? "bg-violet-500/15 border border-violet-500/20" : "hover:bg-white/5 border border-transparent"
      }`}
      whileDrag={{ scale: 1.02, boxShadow: "0 8px 25px rgba(0,0,0,0.5)", backgroundColor: "rgba(30,25,50,0.95)", borderRadius: 8, zIndex: 50 }}
    >
      {/* drag handle — 24px wide touch target, 3px visible pill */}
      <div className="pl-0.5 pr-1 py-2 cursor-grab active:cursor-grabbing touch-none shrink-0 flex items-center justify-center w-6"
        onPointerDown={(e) => controls.start(e)}>
        <div className="w-[3px] h-4 rounded-full bg-white/[0.12] hover:bg-white/25 active:bg-violet-400/40 transition-colors" />
      </div>
      <button type="button" onClick={onSelect} className="flex-1 min-w-0 pl-0 pr-2.5 py-2 text-left">
        <BookRowContent book={book} isSelected={isSelected} />
      </button>
    </Reorder.Item>
  );
}

/* ──────────────────────────────────────────────
   SearchableBookList — fullscreen in-card overlay

   Opens on top of the card. Contains:
   • Search input (autofocus)
   • Close button
   • When query is empty → Reorder.Group with
     ReorderableBookRow items
   • When query is non-empty → plain filtered list
     (no reorder, would be confusing on partial results)
   ────────────────────────────────────────────── */
function SearchableBookList(props: {
  books: LibraryBook[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onReorder: (newOrder: LibraryBook[]) => void;
  onClose: () => void;
}) {
  const { books, selectedId, onSelect, onReorder, onClose } = props;
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return books;
    const q = query.toLowerCase();
    return books.filter(
      (b) => b.title.toLowerCase().includes(q) || (b.author ?? "").toLowerCase().includes(q)
    );
  }, [books, query]);

  const isFiltering = query.trim().length > 0;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      className="absolute inset-0 z-10 bg-neutral-900/[0.97] backdrop-blur-sm rounded-2xl flex flex-col overflow-hidden">
      {/* header */}
      <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-2">
        <div className="relative flex-1">
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder={`Search ${books.length} books…`}
            className="w-full rounded-lg bg-black/40 border border-white/10 text-[11px] text-neutral-100 pl-6.5 pr-2 py-1.5 outline-none focus:border-violet-500/40 transition-colors placeholder:text-neutral-600" />
        </div>
        <button type="button" onClick={onClose}
          className="h-6 w-6 rounded-md bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-neutral-200 text-[10px] transition-colors flex items-center justify-center shrink-0">
          ✕
        </button>
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-20">
            <div className="text-[11px] text-neutral-600 italic">No matches</div>
          </div>
        ) : isFiltering ? (
          <div className="space-y-0.5">
            {filtered.map((b) => (
              <button key={b.id} type="button" onClick={() => onSelect(b.id)}
                className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                  b.id === selectedId ? "bg-violet-500/15 border border-violet-500/20" : "hover:bg-white/5 border border-transparent"
                }`}>
                <BookRowContent book={b} isSelected={b.id === selectedId} />
              </button>
            ))}
          </div>
        ) : (
          <Reorder.Group axis="y" values={books} onReorder={onReorder} className="space-y-0.5">
            {books.map((b) => (
              <ReorderableBookRow key={b.id} book={b} isSelected={b.id === selectedId} onSelect={() => onSelect(b.id)} />
            ))}
          </Reorder.Group>
        )}
      </div>
    </motion.div>
  );
}

/* ──────────────────────────────────────────────
   FolderCard — the complete component

   Default state: shows one selected book with
   cover, title, author, progress. Clicking opens
   the reader.

   🔍 button in header opens SearchableBookList
   overlay. Selecting a book closes overlay and
   swaps the displayed book.
   ────────────────────────────────────────────── */
function FolderCard({ folder, books, onOpenBook }: {
  folder: MoodFolder;
  books: LibraryBook[];
  onOpenBook: (bookId: string) => void;
}) {
  const bookById = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  const [orderedIds, setOrderedIds] = useState(folder.bookIds);
  const allBooks = orderedIds.map((id) => bookById.get(id)).filter(Boolean) as LibraryBook[];
  const [selectedId, setSelectedId] = useState(allBooks[0]?.id);
  const [listOpen, setListOpen] = useState(false);
  const selected = allBooks.find((b) => b.id === selectedId) ?? allBooks[0];
  const theme = folderTheme(folder);

  const handleReorder = useCallback((newOrder: LibraryBook[]) => {
    setOrderedIds(newOrder.map((b) => b.id));
  }, []);

  return (
    <div className={`group relative w-full min-h-[340px] rounded-2xl border overflow-hidden
      bg-neutral-900 text-left shadow-lg shadow-black/50 flex flex-col ${theme.border} ${theme.hoverBorder}`}>
      <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradient} pointer-events-none`} />
      <div className={`absolute -top-10 -right-10 w-28 h-28 ${theme.glow} rounded-full blur-3xl pointer-events-none opacity-40`} />

      {/* header: emoji + label + count + search button */}
      <div className="relative px-2.5 pt-2 pb-0 flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-base leading-none select-none shrink-0">{theme.emoji}</span>
          <div className="text-xs font-bold text-neutral-50 tracking-tight truncate">{folder.label}</div>
          <span className="text-[10px] text-neutral-500 shrink-0">{allBooks.length}</span>
        </div>
        <button type="button" onClick={() => setListOpen(true)}
          className="shrink-0 rounded-md bg-white/5 hover:bg-white/10 text-neutral-500 hover:text-neutral-200 px-1.5 py-0.5 text-[10px] transition-colors">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      </div>

      {/* body: single selected book */}
      <div className="relative px-2 pb-2 pt-1 flex-1 flex flex-col">
        {selected ? (
          <AnimatePresence mode="wait">
            <motion.button key={selected.id}
              initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.2 }}
              type="button" onClick={() => onOpenBook(selected.id)}
              className="flex-1 rounded-xl bg-black/20 border border-white/5 hover:bg-black/30 hover:border-white/10 active:scale-[0.98]
                transition-all duration-150 px-3 py-3 text-left flex flex-col">
              <MoodBookCover coverUrl={selected.coverUrl} progressPercent={selected.progressPercent} title={selected.title} className="mb-2 flex-1" />
              <div className="mt-auto">
                <div className="text-sm font-semibold text-neutral-100 leading-snug line-clamp-2">{selected.title}</div>
                <div className="text-[11px] text-neutral-400 truncate mt-0.5">{selected.author}</div>
                <div className="mt-1.5"><ProgressBar percent={Math.round(selected.progressPercent)} /></div>
              </div>
            </motion.button>
          </AnimatePresence>
        ) : (
          <div className="flex-1 rounded-xl bg-black/10 border border-white/[0.03] flex items-center justify-center">
            <div className="text-[11px] text-neutral-600">No books</div>
          </div>
        )}
      </div>

      {/* search + reorder overlay */}
      <AnimatePresence>
        {listOpen && (
          <SearchableBookList
            books={allBooks}
            selectedId={selectedId}
            onSelect={(id) => { setSelectedId(id); setListOpen(false); }}
            onReorder={handleReorder}
            onClose={() => setListOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Mock data ── */
const MOCK_BOOKS: LibraryBook[] = [
  { id: "b1",  title: "The Great Gatsby", author: "F. Scott Fitzgerald", genre: "Fiction", description: "", progressPercent: 42 },
  { id: "b2",  title: "Sapiens", author: "Yuval Noah Harari", genre: "Science", description: "", progressPercent: 78 },
  { id: "b3",  title: "Dune", author: "Frank Herbert", genre: "Fantasy", description: "", progressPercent: 15 },
  { id: "b4",  title: "Atomic Habits", author: "James Clear", genre: "Casual nonfiction", description: "", progressPercent: 91 },
  { id: "b5",  title: "The Name of the Wind", author: "Patrick Rothfuss", genre: "Fantasy", description: "", progressPercent: 5 },
  { id: "b6",  title: "Project Hail Mary", author: "Andy Weir", genre: "Science", description: "", progressPercent: 33 },
  { id: "b7",  title: "The Midnight Library", author: "Matt Haig", genre: "Fiction", description: "", progressPercent: 67 },
  { id: "b8",  title: "Educated", author: "Tara Westover", genre: "Casual nonfiction", description: "", progressPercent: 52 },
  { id: "b9",  title: "The Hobbit", author: "J.R.R. Tolkien", genre: "Fantasy", description: "", progressPercent: 88 },
  { id: "b10", title: "Circe", author: "Madeline Miller", genre: "Fantasy", description: "", progressPercent: 24 },
  { id: "b11", title: "Klara and the Sun", author: "Kazuo Ishiguro", genre: "Fiction", description: "", progressPercent: 10 },
  { id: "b12", title: "The Song of Achilles", author: "Madeline Miller", genre: "Fiction", description: "", progressPercent: 45 },
  { id: "b13", title: "Thinking, Fast and Slow", author: "Daniel Kahneman", genre: "Science", description: "", progressPercent: 60 },
  { id: "b14", title: "A Court of Thorns and Roses", author: "Sarah J. Maas", genre: "Romance", description: "", progressPercent: 73 },
  { id: "b15", title: "The Alchemist", author: "Paulo Coelho", genre: "Fiction", description: "", progressPercent: 100 },
  { id: "b16", title: "Where the Crawdads Sing", author: "Delia Owens", genre: "Fiction", description: "", progressPercent: 37 },
  { id: "b17", title: "Mistborn", author: "Brandon Sanderson", genre: "Fantasy", description: "", progressPercent: 19 },
  { id: "b18", title: "The Power of Now", author: "Eckhart Tolle", genre: "Casual nonfiction", description: "", progressPercent: 55 },
  { id: "b19", title: "Piranesi", author: "Susanna Clarke", genre: "Fantasy", description: "", progressPercent: 81 },
  { id: "b20", title: "Normal People", author: "Sally Rooney", genre: "Romance", description: "", progressPercent: 29 },
];
const MOCK_FOLDER: MoodFolder = { id: "sandbox-folder", label: "Evening Reads", color: "violet", bookIds: MOCK_BOOKS.map((b) => b.id) };

/* ── Sandbox wrapper (for sandbox.html only) ── */
export default function SandboxFolderCard() {
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-8 gap-6">
      <h1 className="text-lg font-bold text-neutral-300 tracking-tight">Approved Design — Pill List</h1>
      <p className="text-[11px] text-neutral-500 text-center max-w-xs">
        This is the reference. Tap 🔍 to open list. Drag the subtle pill to reorder. Tap a row to select.
      </p>
      {lastOpened && (
        <div className="text-xs text-neutral-500">
          Opened: <span className="text-violet-400 font-semibold">{MOCK_BOOKS.find((b) => b.id === lastOpened)?.title}</span>
        </div>
      )}
      <div className="w-[200px]">
        <FolderCard folder={MOCK_FOLDER} books={MOCK_BOOKS} onOpenBook={setLastOpened} />
      </div>
    </div>
  );
}
