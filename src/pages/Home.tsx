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
import BulkImportReview from "@/components/library/BulkImportReview";
import EditBookModal, { type EditBookModalSavePayload } from "@/components/library/EditBookModal";
import MoodView from "@/components/library/MoodView";
import { motion } from "framer-motion";
import type { LibraryBook } from "@/types/book";
import { loadLibraryEntries, type LibraryEntry } from "@/lib/library/libraryBooks";
import { getBookImportService } from "@/lib/import/bookImportService";
import {
  isNativeEpubFolderPickerAvailable,
  pickNativeEpubFolder,
  readNativeEpubFolderFile,
  type NativeEpubFolderFile,
} from "@/lib/nativeEpubFolderPicker";
import { loadFolders, getFolderColorForBook } from "@/lib/moodStore";
import type { MoodFolder } from "@/types/book";

type PendingImportItem =
  | {
      kind: "file";
      name: string;
      size: number;
      file: File;
    }
  | {
      kind: "native-folder-file";
      name: string;
      size: number;
      nativeFile: NativeEpubFolderFile;
    };

type BatchImportTiming = {
  startedAtMs: number | null;
  elapsedMs: number;
  processedBytes: number;
};

type ImportTimingSummary = {
  bookCount: number;
  completedCount: number;
  failedCount: number;
  totalBytes: number;
  elapsedMs: number;
};

type TrackedImportBook = {
  bookId: string;
  item: PendingImportItem;
};

function loadPendingImportFile(item: PendingImportItem): Promise<File> {
  if (item.kind === "file") {
    return Promise.resolve(item.file);
  }
  return readNativeEpubFolderFile(item.nativeFile);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatSummaryBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatSummaryDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatSummaryRate(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) {
    return "--";
  }
  if (milliseconds < 1000) {
    return `${Math.max(1, Math.round(milliseconds))} ms`;
  }
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

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
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [savingBookId, setSavingBookId] = useState<string | null>(null);
  const [restoringBookId, setRestoringBookId] = useState<string | null>(null);
  const [editActionError, setEditActionError] = useState<string | null>(null);
  const [moodFolders, setMoodFolders] = useState<MoodFolder[]>([]);
  const [pendingImportItems, setPendingImportItems] = useState<PendingImportItem[]>([]);
  const [pendingImportDescription, setPendingImportDescription] = useState<string | null>(null);
  const [isImportingBatch, setIsImportingBatch] = useState(false);
  const [batchImportProgress, setBatchImportProgress] = useState({ completed: 0, failed: 0 });
  const [batchImportTiming, setBatchImportTiming] = useState<BatchImportTiming>({
    startedAtMs: null,
    elapsedMs: 0,
    processedBytes: 0,
  });
  const [lastImportSummary, setLastImportSummary] = useState<ImportTimingSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importRefreshTimeoutRef = useRef<number | null>(null);
  const importService = useMemo(() => getBookImportService(), []);

  const refreshLibrary = useCallback(async (options?: { showLoading?: boolean }) => {
    const showLoading = options?.showLoading ?? true;
    if (showLoading) {
      setIsLoading(true);
    }
    try {
      const [loaded, folders] = await Promise.all([loadLibraryEntries(), loadFolders()]);
      setEntries(loaded);
      setMoodFolders(folders);
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to load library");
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  }, []);

  const scheduleRefreshFromImport = useCallback(() => {
    if (importRefreshTimeoutRef.current !== null) {
      window.clearTimeout(importRefreshTimeoutRef.current);
    }
    importRefreshTimeoutRef.current = window.setTimeout(() => {
      importRefreshTimeoutRef.current = null;
      void refreshLibrary({ showLoading: false });
    }, 180);
  }, [refreshLibrary]);

  useEffect(() => {
    void refreshLibrary({ showLoading: true });
    const unsubscribe = importService.subscribe(() => {
      scheduleRefreshFromImport();
    });
    return () => {
      unsubscribe();
      if (importRefreshTimeoutRef.current !== null) {
        window.clearTimeout(importRefreshTimeoutRef.current);
        importRefreshTimeoutRef.current = null;
      }
    };
  }, [importService, refreshLibrary, scheduleRefreshFromImport]);

  useEffect(() => {
    if (!isImportingBatch || batchImportTiming.startedAtMs === null) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setBatchImportTiming((current) => {
        if (current.startedAtMs === null) {
          return current;
        }
        return {
          ...current,
          elapsedMs: Date.now() - current.startedAtMs,
        };
      });
    }, 500);

    return () => {
      window.clearInterval(timerId);
    };
  }, [batchImportTiming.startedAtMs, isImportingBatch]);

  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const editingEntry = useMemo(
    () => (editingBookId ? entryById.get(editingBookId) ?? null : null),
    [editingBookId, entryById]
  );
  const libraryBooks: LibraryBook[] = useMemo(
    () =>
      entries.map((entry) => ({
        ...entry.libraryBook,
        progressPercent: entry.progressPercent,
      })),
    [entries]
  );

  useEffect(() => {
    if (!editingBookId) return;
    if (entryById.has(editingBookId)) return;
    setEditingBookId(null);
    setEditActionError(null);
  }, [editingBookId, entryById]);

  const triggerImportPicker = () => {
    fileInputRef.current?.click();
  };

  const handleImportFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    const files = Array.from(selectedFiles);
    event.target.value = "";
    setPendingImportItems(files.map((file) => ({
      kind: "file",
      name: file.name,
      size: file.size,
      file,
    })));
    setPendingImportDescription("Android picked the files. Review the batch before adding it to your library.");
    setBatchImportProgress({ completed: 0, failed: 0 });
    setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
    setLastImportSummary(null);
    setImportError(null);
    setView("library");
  };

  const handleImportFolder = useCallback(async () => {
    if (isImportingBatch) return;
    setImportError(null);

    try {
      const outcome = await pickNativeEpubFolder();
      if (outcome.status === "unavailable") {
        setImportError("Folder import is available in the Android app.");
        return;
      }
      if (outcome.status === "canceled") {
        return;
      }
      if (outcome.files.length === 0) {
        setPendingImportItems([]);
        setPendingImportDescription(null);
        setBatchImportProgress({ completed: 0, failed: 0 });
        setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
        setImportError("No EPUB files found in that folder.");
        return;
      }

      setPendingImportItems(outcome.files.map((file) => ({
        kind: "native-folder-file",
        name: file.name,
        size: file.size,
        nativeFile: file,
      })));
      setPendingImportDescription("Android scanned the folder. Review the EPUBs before adding them to your library.");
      setBatchImportProgress({ completed: 0, failed: 0 });
      setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
      setLastImportSummary(null);
      setView("library");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not open that folder.");
    }
  }, [isImportingBatch]);

  const handleCancelPendingImport = useCallback(() => {
    if (isImportingBatch) return;
    setPendingImportItems([]);
    setPendingImportDescription(null);
    setBatchImportProgress({ completed: 0, failed: 0 });
    setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
  }, [isImportingBatch]);

  const handleStartPendingImport = useCallback(async () => {
    if (pendingImportItems.length === 0 || isImportingBatch) return;
    const totalPendingImports = pendingImportItems.length;
    const totalBytes = pendingImportItems.reduce((sum, item) => sum + item.size, 0);
    const startedAtMs = Date.now();
    const immediateFailures: string[] = [];
    const immediateFailedItems: PendingImportItem[] = [];
    const trackedBooks: TrackedImportBook[] = [];
    let completedCount = 0;
    let failedCount = 0;
    let processedBytes = 0;
    setIsImportingBatch(true);
    setBatchImportProgress({ completed: 0, failed: 0 });
    setBatchImportTiming({ startedAtMs, elapsedMs: 0, processedBytes: 0 });

    try {
      for (const item of pendingImportItems) {
        try {
          const file = await loadPendingImportFile(item);
          const bookId = await importService.importFromFile(file);
          trackedBooks.push({ bookId, item });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Import failed";
          immediateFailures.push(`${item.name}: ${message}`);
          immediateFailedItems.push(item);
        } finally {
          setBatchImportTiming((current) => ({
            ...current,
            elapsedMs: Date.now() - startedAtMs,
          }));
        }
      }

      while (completedCount + failedCount < totalPendingImports) {
        const snapshot = await importService.listImportSnapshot();
        const statusByBookId = new Map(snapshot.map((row) => [row.bookId, row]));
        const failedProcessingMessages: string[] = [];
        let nextCompletedCount = 0;
        let nextFailedCount = immediateFailedItems.length;
        let nextProcessedBytes = immediateFailedItems.reduce((sum, item) => sum + item.size, 0);

        for (const trackedBook of trackedBooks) {
          const row = statusByBookId.get(trackedBook.bookId);
          if (!row) continue;

          if (row.status === "completed") {
            nextCompletedCount += 1;
            nextProcessedBytes += trackedBook.item.size;
            continue;
          }

          if (row.status === "failed") {
            nextFailedCount += 1;
            nextProcessedBytes += trackedBook.item.size;
            failedProcessingMessages.push(
              `${trackedBook.item.name}: ${row.error ?? "Import failed during processing"}`
            );
          }
        }

        completedCount = nextCompletedCount;
        failedCount = nextFailedCount;
        processedBytes = nextProcessedBytes;
        setBatchImportProgress({ completed: completedCount, failed: failedCount });
        setBatchImportTiming((current) => ({
          ...current,
          elapsedMs: Date.now() - startedAtMs,
          processedBytes,
        }));

        if (completedCount + failedCount >= totalPendingImports) {
          immediateFailures.push(...failedProcessingMessages);
          break;
        }

        await delay(1000);
      }

      await refreshLibrary({ showLoading: false });
    } finally {
      const elapsedMs = Date.now() - startedAtMs;
      setIsImportingBatch(false);
      setBatchImportTiming({
        startedAtMs: null,
        elapsedMs,
        processedBytes,
      });
      setLastImportSummary({
        bookCount: totalPendingImports,
        completedCount,
        failedCount,
        totalBytes,
        elapsedMs,
      });
    }

    setPendingImportItems([]);
    setPendingImportDescription(null);

    if (immediateFailures.length === 0) {
      setImportError(null);
      return;
    }

    if (immediateFailures.length === 1) {
      setImportError(immediateFailures[0]);
      return;
    }

    setImportError(`${immediateFailures.length} of ${totalPendingImports} imports failed. First error: ${immediateFailures[0]}`);
  }, [importService, isImportingBatch, pendingImportItems, refreshLibrary]);

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
        await refreshLibrary();
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "Failed to delete book");
      } finally {
        setDeletingBookId((current) => (current === entry.id ? null : current));
      }
    },
    [importService, refreshLibrary]
  );

  const handleOpenEdit = useCallback((entry: LibraryEntry) => {
    const canEdit =
      entry.processingStatus === "completed" || entry.processingStatus === "failed";
    if (!canEdit) return;
    setEditActionError(null);
    setEditingBookId(entry.id);
  }, []);

  const handleSaveEdit = useCallback(
    async (payload: EditBookModalSavePayload) => {
      if (!editingBookId) return;
      const targetBookId = editingBookId;
      setSavingBookId(targetBookId);
      setEditActionError(null);
      try {
        await importService.updateBookMetadata({
          bookId: targetBookId,
          title: payload.title,
          author: payload.author,
          coverDataUrl: payload.coverDataUrl,
        });
        await refreshLibrary();
        setEditingBookId((current) => (current === targetBookId ? null : current));
      } catch (error) {
        setEditActionError(error instanceof Error ? error.message : "Failed to update book");
      } finally {
        setSavingBookId((current) => (current === targetBookId ? null : current));
      }
    },
    [editingBookId, importService, refreshLibrary]
  );

  const handleRestoreOriginal = useCallback(async () => {
    if (!editingBookId) return;
    const targetBookId = editingBookId;
    setRestoringBookId(targetBookId);
    setEditActionError(null);
    try {
      await importService.restoreOriginalBook(targetBookId);
      await refreshLibrary();
      setEditingBookId((current) => (current === targetBookId ? null : current));
    } catch (error) {
      setEditActionError(error instanceof Error ? error.message : "Failed to restore original book");
    } finally {
      setRestoringBookId((current) => (current === targetBookId ? null : current));
    }
  }, [editingBookId, importService, refreshLibrary]);

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
            <div className={`mx-auto grid gap-2 ${isNativeEpubFolderPickerAvailable() ? "grid-cols-2 max-w-sm" : "max-w-xs"}`}>
              <button
                type="button"
                onClick={triggerImportPicker}
                className="rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-semibold text-violet-200 hover:bg-violet-500/25 transition-colors"
              >
                Import EPUB
              </button>
              {isNativeEpubFolderPickerAvailable() ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleImportFolder();
                  }}
                  className="rounded-xl border border-cyan-400/35 bg-cyan-500/10 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 transition-colors"
                >
                  Import folder
                </button>
              ) : null}
            </div>
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
            <div className="relative w-full grid grid-cols-2" role="tablist" aria-label="Library views">
              <button
                type="button"
                onClick={() => setView("mood")}
                className="relative h-7 rounded-lg"
                role="tab"
                id="home-tab-mood"
                aria-selected={view === "mood"}
                aria-controls="home-panel-mood"
                tabIndex={view === "mood" ? 0 : -1}
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
                role="tab"
                id="home-tab-library"
                aria-selected={view === "library"}
                aria-controls="home-panel-library"
                tabIndex={view === "library" ? 0 : -1}
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

        {lastImportSummary && pendingImportItems.length === 0 ? (
          <section className="rounded-2xl border border-emerald-400/25 bg-neutral-900/75 p-4 shadow-xl shadow-black/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-neutral-100">Last import</h2>
                <p className="mt-1 text-sm text-neutral-400">
                  {lastImportSummary.completedCount} completed
                  {lastImportSummary.failedCount > 0 ? `, ${lastImportSummary.failedCount} failed` : ""}
                  {" "}from {formatSummaryBytes(lastImportSummary.totalBytes)}
                </p>
              </div>
              <div className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200">
                {formatSummaryDuration(lastImportSummary.elapsedMs)}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Per book</div>
                <div className="mt-1 text-sm font-semibold text-neutral-100">
                  {formatSummaryRate(lastImportSummary.elapsedMs / Math.max(1, lastImportSummary.bookCount))}
                </div>
              </div>
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
                <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Per MB</div>
                <div className="mt-1 text-sm font-semibold text-neutral-100">
                  {formatSummaryRate(lastImportSummary.elapsedMs / Math.max(0.001, lastImportSummary.totalBytes / (1024 * 1024)))}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {pendingImportItems.length > 0 ? (
          <BulkImportReview
            files={pendingImportItems}
            description={pendingImportDescription ?? undefined}
            completedCount={batchImportProgress.completed}
            failedCount={batchImportProgress.failed}
            isImporting={isImportingBatch}
            elapsedMs={batchImportTiming.elapsedMs}
            processedBytes={batchImportTiming.processedBytes}
            onStart={() => {
              void handleStartPendingImport();
            }}
            onCancel={handleCancelPendingImport}
          />
        ) : null}

        {/* Book Section */}
        {view === "library" ? (
          <motion.section
            id="home-panel-library"
            role="tabpanel"
            aria-labelledby="home-tab-library"
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
                  const canEdit =
                    entry.processingStatus === "completed" || entry.processingStatus === "failed";
                  const isDeleting = deletingBookId === entry.id;
                  const isEditingBusy =
                    savingBookId === entry.id || restoringBookId === entry.id;
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
                        isDeleting ||
                        isEditingBusy
                      }
                      editLabel={isEditingBusy ? "Working..." : "Edit"}
                      editDisabled={isDeleting || isEditingBusy}
                      onEdit={
                        canEdit
                          ? () => {
                              handleOpenEdit(entry);
                            }
                          : undefined
                      }
                      deleteLabel={isDeleting ? "Deleting..." : "Delete"}
                      deleteDisabled={isDeleting || isEditingBusy}
                      onDelete={
                        canDelete
                          ? () => {
                              void handleDelete(entry);
                            }
                          : undefined
                      }
                      statusBadge={entry.processingStatus !== "completed" ? entry.processingStatusLabel : undefined}
                      progress={entry.progressPercent}
                      folderColor={getFolderColorForBook(moodFolders, entry.id)}
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
          <section id="home-panel-mood" role="tabpanel" aria-labelledby="home-tab-mood">
            <MoodView
              books={libraryBooks}
              onOpenBook={(bookId) => {
                const entry = entryById.get(bookId);
                if (!entry) return;
                if (entry.processingStatus !== "completed") return;
                setLocation(`/reader/${bookId}`);
              }}
            />
          </section>
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
      <EditBookModal
        entry={editingEntry}
        isSaving={!!editingEntry && savingBookId === editingEntry.id}
        isRestoring={!!editingEntry && restoringBookId === editingEntry.id}
        error={editActionError}
        onClose={() => {
          if (savingBookId || restoringBookId) return;
          setEditingBookId(null);
          setEditActionError(null);
        }}
        onSave={handleSaveEdit}
        onRestore={handleRestoreOriginal}
      />
    </main>
  );
}
