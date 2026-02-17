import {
  useMemo,
  useRef,
  useState,
  memo,
  useEffect,
  useCallback,
  type ChangeEvent,
} from "react";
import { useLocation } from "wouter";
import BookCard from "@/components/library/BookCard";
import MoodView from "@/components/library/MoodView";
import { motion } from "framer-motion";
import type { LibraryBook } from "@/types/book";
import { loadLibraryEntries, type LibraryEntry } from "@/lib/library/libraryBooks";
import { getBookImportService } from "@/lib/import/bookImportService";
import { removeBookReferences } from "@/lib/moodStore";
import { clearBookTokenCache } from "@/lib/utils/tokenCache";

const BackgroundDecoration = memo(function BackgroundDecoration() {
  return (
    <>
      <div className="absolute inset-0 bg-gradient-to-b from-neutral-950 via-neutral-900/20 to-neutral-950 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-violet-500/5 rounded-full blur-3xl pointer-events-none" />
    </>
  );
});

export default function Home() {
  const [, setLocation] = useLocation();
  const [view, setView] = useState<"mood" | "library">("mood");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [importError, setImportError] = useState<string | null>(null);
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importService = useMemo(() => getBookImportService(), []);

  const refreshLibrary = useCallback(async () => {
    setIsLoading(true);
    try {
      const loaded = await loadLibraryEntries();
      setEntries(loaded);
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to load library");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
    const unsubscribe = importService.subscribe(() => {
      void refreshLibrary();
    });
    return unsubscribe;
  }, [importService, refreshLibrary]);

  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const libraryBooks: LibraryBook[] = useMemo(
    () => entries.map((entry) => entry.libraryBook),
    [entries]
  );

  const triggerImportPicker = () => {
    fileInputRef.current?.click();
  };

  const handleImportFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    const files = Array.from(selectedFiles);
    const failures: string[] = [];

    for (const file of files) {
      try {
        await importService.importFromFile(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Import failed";
        failures.push(`${file.name}: ${message}`);
      }
    }

    event.target.value = "";
    await refreshLibrary();

    if (failures.length === 0) {
      setImportError(null);
      return;
    }

    if (failures.length === 1) {
      setImportError(failures[0]);
      return;
    }

    setImportError(`${failures.length} of ${files.length} imports failed. First error: ${failures[0]}`);
  };

  const handleOpenOrRetry = useCallback(
    async (entry: LibraryEntry) => {
      if (entry.processingStatus === "completed") {
        setLocation(`/reader/${entry.id}`);
        return;
      }
      if (entry.processingStatus === "failed") {
        await importService.retryImport(entry.id);
        await refreshLibrary();
      }
    },
    [importService, refreshLibrary, setLocation]
  );

  const handleDelete = useCallback(
    async (entry: LibraryEntry) => {
      const confirmed =
        typeof window === "undefined"
          ? true
          : window.confirm(
              `Delete "${entry.title}" from your library?\n\nThis removes the uploaded file, reading progress, and import history.`
            );
      if (!confirmed) return;

      setDeletingBookId(entry.id);
      try {
        await importService.deleteBook(entry.id);
        clearBookTokenCache(entry.id);
        await removeBookReferences(entry.id);
        await refreshLibrary();
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "Failed to delete book");
      } finally {
        setDeletingBookId((current) => (current === entry.id ? null : current));
      }
    },
    [importService, refreshLibrary]
  );

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-8 bg-neutral-950 text-neutral-100 relative overflow-hidden">
      <BackgroundDecoration />
      <input
        ref={fileInputRef}
        type="file"
        accept=".epub,application/epub+zip"
        className="hidden"
        multiple
        onChange={(event) => {
          void handleImportFiles(event);
        }}
      />

      <div className="w-full max-w-md space-y-8 relative z-10">
        {/* Header */}
        <motion.header
          className="text-center mb-2"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 border border-violet-500/20 mb-6"
          >
            <svg
              className="w-8 h-8 text-violet-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          </motion.div>

          <motion.h1
            className="text-4xl font-bold tracking-tight bg-gradient-to-r from-neutral-100 to-neutral-400 bg-clip-text text-transparent"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            Speed Reading
          </motion.h1>

          <motion.p
            className="text-sm text-neutral-400 mt-3 max-w-xs mx-auto leading-relaxed"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            Practice rapid serial visual presentation (RSVP) and switch to normal reading whenever you need more context.
          </motion.p>

          <motion.div
            className="mt-5"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.35 }}
          >
            <button
              type="button"
              onClick={triggerImportPicker}
              className="rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-semibold text-violet-200 hover:bg-violet-500/25 transition-colors"
            >
              Import EPUB
            </button>
          </motion.div>
        </motion.header>

        {/* View Toggle */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.38, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="flex justify-center"
        >
          <div className="w-full rounded-xl bg-neutral-900 border border-neutral-800 p-1 h-9 flex items-center">
            <div className="relative w-full grid grid-cols-2">
              <button
                type="button"
                onClick={() => setView("mood")}
                className="relative h-7 rounded-lg"
              >
                {view === "mood" ? (
                  <motion.div
                    layoutId="home-view-pill"
                    className="absolute inset-0 rounded-lg bg-neutral-100"
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  />
                ) : null}
                <span
                  className={`relative z-10 text-xs font-semibold transition-colors ${
                    view === "mood" ? "text-neutral-900" : "text-neutral-400"
                  }`}
                >
                  Mood
                </span>
              </button>
              <button
                type="button"
                onClick={() => setView("library")}
                className="relative h-7 rounded-lg"
              >
                {view === "library" ? (
                  <motion.div
                    layoutId="home-view-pill"
                    className="absolute inset-0 rounded-lg bg-neutral-100"
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  />
                ) : null}
                <span
                  className={`relative z-10 text-xs font-semibold transition-colors ${
                    view === "library" ? "text-neutral-900" : "text-neutral-400"
                  }`}
                >
                  Library
                </span>
              </button>
            </div>
          </div>
        </motion.div>

        {/* Book Section */}
        {view === "library" ? (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.4 }}
          >
            <motion.h2
              className="text-xs uppercase tracking-[0.2em] text-neutral-500 mb-4 px-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.5 }}
            >
              Your Library
            </motion.h2>

            <div className="space-y-4">
              {isLoading ? (
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-sm text-neutral-400">
                  Loading library…
                </div>
              ) : entries.length === 0 ? (
                <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 px-4 py-4 text-sm text-neutral-400">
                  No books yet. Import an EPUB to start reading.
                </div>
              ) : (
                entries.map((entry, index) => {
                  const canDelete =
                    entry.processingStatus === "completed" || entry.processingStatus === "failed";
                  const isDeleting = deletingBookId === entry.id;
                  return (
                    <BookCard
                      key={entry.id}
                      title={entry.title}
                      author={entry.author}
                      genre={entry.libraryBook.genre}
                      description={entry.libraryBook.description}
                      coverUrl={entry.coverUrl}
                      readLabel={
                        entry.processingStatus === "completed"
                          ? entry.progressPercent > 0
                            ? "Resume"
                            : "Read"
                          : entry.processingStatus === "failed"
                          ? "Retry import"
                          : entry.processingStatusLabel
                      }
                      readDisabled={
                        (entry.processingStatus !== "completed" && entry.processingStatus !== "failed") ||
                        isDeleting
                      }
                      deleteLabel={isDeleting ? "Deleting..." : "Delete"}
                      deleteDisabled={isDeleting}
                      onDelete={
                        canDelete
                          ? () => {
                              void handleDelete(entry);
                            }
                          : undefined
                      }
                      statusBadge={entry.processingStatusLabel}
                      progress={entry.progressPercent}
                      onRead={() => {
                        void handleOpenOrRetry(entry);
                      }}
                      index={index}
                    />
                  );
                })
              )}
            </div>
          </motion.section>
        ) : (
          <MoodView
            books={libraryBooks}
            onOpenBook={(bookId) => {
              const entry = entryById.get(bookId);
              if (!entry) return;
              if (entry.processingStatus !== "completed") return;
              setLocation(`/reader/${bookId}`);
            }}
          />
        )}

        {importError ? (
          <div className="rounded-xl border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {importError}
          </div>
        ) : null}

        {/* Footer */}
        <motion.footer
          className="text-center pt-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.6 }}
        >
          <p className="text-xs text-neutral-600">
            Offline-first mode: imports, settings, and progress are stored locally
          </p>
        </motion.footer>
      </div>
    </main>
  );
}
