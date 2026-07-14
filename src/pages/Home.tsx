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
import BulkImportReview from "@/components/library/BulkImportReview";
import EditBookModal, { type EditBookModalSavePayload } from "@/components/library/EditBookModal";
import LibraryTreeView from "@/components/library/LibraryTreeView";
import MoodView from "@/components/library/MoodView";
import NestedPickPrune from "@/components/library/NestedPickPrune";
import { motion } from "framer-motion";
import type { LibraryBook } from "@/types/book";
import type { LibraryLayout } from "@/types/libraryLayout";
import { loadLibraryEntries, type LibraryEntry } from "@/lib/library/libraryBooks";
import { getBookImportService, type ImportPayload } from "@/lib/import/bookImportService";
import { isSupportedBookFile } from "@/lib/import/bookFileSelection";
import {
  buildFolderImportPreview,
  flattenFolderImportBooks,
  type FolderImportBookNode,
  type FolderImportPreview,
} from "@/lib/import/folderImportTree";
import {
  isNativeEpubFolderPickerAvailable,
  pickNativeBookFiles,
  pickNativeEpubFolder,
  readNativeEpubFolderBytes,
  type NativeEpubFolderFile,
} from "@/lib/nativeEpubFolderPicker";
import {
  addLibraryFolder,
  deleteLibraryFolderOnly,
  deleteLibraryFolderWithContents,
  loadLibraryLayout,
  moveBookToFolder,
  saveLibraryLayout,
} from "@/lib/libraryLayoutStore";

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

type ImportBookResultStatus = "ok" | "with_issues" | "failed";

type ImportBookResult = {
  /** Stable row id: book id after enqueue, or a synthetic id for pre-queue failures. */
  id: string;
  fileName: string;
  status: ImportBookResultStatus;
  reason: string | null;
  sizeBytes: number;
};

type ImportTimingSummary = {
  bookCount: number;
  completedCount: number;
  withIssuesCount: number;
  failedCount: number;
  totalBytes: number;
  elapsedMs: number;
  books: ImportBookResult[];
};

type PendingFolderImport = {
  sourceFolderName: string;
  items: PendingImportItem[];
  preview: FolderImportPreview;
};

type TrackedImportBook = {
  bookId: string;
  item: PendingImportItem;
};

const EMPTY_LIBRARY_LAYOUT: LibraryLayout = {
  folders: [],
  placements: [],
};
const BATCH_IMPORT_READ_CONCURRENCY = 2;

type PreparedFolderImportLayout = {
  layout: LibraryLayout;
  folderIdByPath: Map<string, string>;
};

function folderPathKey(path: string[]): string {
  return path.join("\u0000");
}

function prepareFolderImportLayout(
  baseLayout: LibraryLayout,
  sourceFolderName: string,
  books: FolderImportBookNode[]
): PreparedFolderImportLayout {
  const rootFolder = addLibraryFolder(baseLayout, { label: sourceFolderName });
  let layout = rootFolder.layout;
  const folderIdByPath = new Map<string, string>([[folderPathKey([]), rootFolder.folder.id]]);

  for (const book of books) {
    let parentId = rootFolder.folder.id;
    const currentPath: string[] = [];
    for (const segment of book.folderPath) {
      currentPath.push(segment);
      const key = folderPathKey(currentPath);
      const existingId = folderIdByPath.get(key);
      if (existingId) {
        parentId = existingId;
        continue;
      }

      const created = addLibraryFolder(layout, { label: segment, parentId });
      layout = created.layout;
      folderIdByPath.set(key, created.folder.id);
      parentId = created.folder.id;
    }
  }

  return { layout, folderIdByPath };
}

async function loadPendingImportPayload(item: PendingImportItem): Promise<ImportPayload> {
  if (item.kind === "file") {
    return {
      fileName: item.file.name,
      mimeType: item.file.type || "application/octet-stream",
      bytes: new Uint8Array(await item.file.arrayBuffer()),
    };
  }

  return {
    fileName: item.nativeFile.name,
    mimeType: item.nativeFile.type ?? "application/octet-stream",
    bytes: await readNativeEpubFolderBytes(item.nativeFile),
  };
}

async function runWithLimitedConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(runners);
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
  const [libraryLayout, setLibraryLayout] = useState<LibraryLayout>(EMPTY_LIBRARY_LAYOUT);
  const [pendingImportItems, setPendingImportItems] = useState<PendingImportItem[]>([]);
  const [pendingFolderImport, setPendingFolderImport] = useState<PendingFolderImport | null>(null);
  const [pendingImportDescription, setPendingImportDescription] = useState<string | null>(null);
  const [isImportChooserOpen, setIsImportChooserOpen] = useState(false);
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
      const [loaded, loadedLayout] = await Promise.all([
        loadLibraryEntries(),
        loadLibraryLayout(),
      ]);
      setEntries(loaded);
      setLibraryLayout(loadedLayout);
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
  const busyBookIds = useMemo(() => {
    const ids = new Set<string>();
    if (savingBookId) ids.add(savingBookId);
    if (restoringBookId) ids.add(restoringBookId);
    return ids;
  }, [restoringBookId, savingBookId]);
  const libraryBooks: LibraryBook[] = useMemo(
    () =>
      entries
        .filter((entry) => entry.processingStatus === "completed")
        .map((entry) => ({
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

  const triggerImportPicker = async () => {
    setIsImportChooserOpen(false);
    if (!isNativeEpubFolderPickerAvailable()) {
      fileInputRef.current?.click();
      return;
    }

    setImportError(null);
    try {
      const outcome = await pickNativeBookFiles();
      if (outcome.status !== "selected") return;
      if (outcome.files.length === 0) {
        setImportError("No EPUB or PDF books selected.");
        return;
      }

      setPendingFolderImport(null);
      setPendingImportItems(outcome.files.map((file) => ({
        kind: "native-folder-file",
        name: file.name,
        size: file.size,
        nativeFile: file,
      })));
      setPendingImportDescription("Android picked the files. Review the batch before adding it to your library.");
      setBatchImportProgress({ completed: 0, failed: 0 });
      setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
      setLastImportSummary(null);
      setView("library");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not open those books.");
    }
  };

  const openImportChooser = () => {
    if (isImportingBatch) return;
    if (!isNativeEpubFolderPickerAvailable()) {
      void triggerImportPicker();
      return;
    }
    setIsImportChooserOpen(true);
  };

  const handleImportFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    const files = Array.from(selectedFiles);
    event.target.value = "";
    const unsupportedFiles = files.filter((file) => !isSupportedBookFile(file));
    if (unsupportedFiles.length > 0) {
      const unsupportedNames = unsupportedFiles.map((file) => file.name).join(", ");
      setImportError(`Only EPUB and PDF books can be imported. Unsupported: ${unsupportedNames}`);
      return;
    }
    setPendingFolderImport(null);
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
    setIsImportChooserOpen(false);
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
        setPendingFolderImport(null);
        setPendingImportDescription(null);
        setBatchImportProgress({ completed: 0, failed: 0 });
        setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
        setImportError("No EPUB or PDF books found in that folder.");
        return;
      }

      const items: PendingImportItem[] = outcome.files.map((file) => ({
        kind: "native-folder-file",
        name: file.name,
        size: file.size,
        nativeFile: file,
      }));
      setPendingImportItems([]);
      setPendingFolderImport({
        sourceFolderName: outcome.folderName,
        items,
        preview: buildFolderImportPreview(outcome.files, outcome.folderName),
      });
      setPendingImportDescription(null);
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
    setPendingFolderImport(null);
    setPendingImportDescription(null);
    setBatchImportProgress({ completed: 0, failed: 0 });
    setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
  }, [isImportingBatch]);

  const runImportBatch = useCallback(async (
    items: PendingImportItem[],
    options?: {
      onBookImported?: (bookId: string, item: PendingImportItem) => void | Promise<void>;
      onBeforeRefresh?: () => void | Promise<void>;
    }
  ) => {
    if (items.length === 0 || isImportingBatch) return;
    const totalPendingImports = items.length;
    const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
    const startedAtMs = Date.now();
    const immediateFailures: string[] = [];
    const immediateFailedResults: ImportBookResult[] = [];
    const trackedBooks: TrackedImportBook[] = [];
    let immediateFailureSeq = 0;
    let completedCount = 0;
    let withIssuesCount = 0;
    let failedCount = 0;
    let processedBytes = 0;
    let bookResults: ImportBookResult[] = [];
    importService.clearTerminalOutcomes();
    setIsImportingBatch(true);
    setBatchImportProgress({ completed: 0, failed: 0 });
    setBatchImportTiming({ startedAtMs, elapsedMs: 0, processedBytes: 0 });

    try {
      await runWithLimitedConcurrency(items, BATCH_IMPORT_READ_CONCURRENCY, async (item) => {
        try {
          const payload = await loadPendingImportPayload(item);
          const bookId = await importService.importFromBytes(payload, {
            inlineSourceMode: "bounded",
          });
          await options?.onBookImported?.(bookId, item);
          trackedBooks.push({ bookId, item });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Import failed";
          immediateFailures.push(`${item.name}: ${message}`);
          immediateFailureSeq += 1;
          immediateFailedResults.push({
            id: `prequeue-${immediateFailureSeq}`,
            fileName: item.name,
            status: "failed",
            reason: message,
            sizeBytes: item.size,
          });
        } finally {
          setBatchImportTiming((current) => ({
            ...current,
            elapsedMs: Date.now() - startedAtMs,
          }));
        }
      });

      while (completedCount + failedCount < totalPendingImports) {
        const snapshot = await importService.listImportSnapshot();
        const statusByBookId = new Map(snapshot.map((row) => [row.bookId, row]));
        const failedProcessingMessages: string[] = [];
        const nextResults: ImportBookResult[] = [...immediateFailedResults];
        let nextCompletedCount = 0;
        let nextWithIssuesCount = 0;
        let nextFailedCount = immediateFailedResults.length;
        let nextProcessedBytes = immediateFailedResults.reduce(
          (sum, result) => sum + result.sizeBytes,
          0
        );

        for (const trackedBook of trackedBooks) {
          const row = statusByBookId.get(trackedBook.bookId);
          if (!row) continue;

          if (row.status === "completed") {
            nextCompletedCount += 1;
            nextProcessedBytes += trackedBook.item.size;
            const warnings = row.warnings ?? [];
            if (warnings.length > 0) {
              nextWithIssuesCount += 1;
              nextResults.push({
                id: trackedBook.bookId,
                fileName: trackedBook.item.name,
                status: "with_issues",
                reason: warnings.map((warning) => warning.message).join(" "),
                sizeBytes: trackedBook.item.size,
              });
            } else {
              nextResults.push({
                id: trackedBook.bookId,
                fileName: trackedBook.item.name,
                status: "ok",
                reason: null,
                sizeBytes: trackedBook.item.size,
              });
            }
            continue;
          }

          if (row.status === "failed") {
            nextFailedCount += 1;
            nextProcessedBytes += trackedBook.item.size;
            const reason = row.error ?? "Import failed during processing";
            failedProcessingMessages.push(`${trackedBook.item.name}: ${reason}`);
            nextResults.push({
              id: trackedBook.bookId,
              fileName: trackedBook.item.name,
              status: "failed",
              reason,
              sizeBytes: trackedBook.item.size,
            });
          }
        }

        completedCount = nextCompletedCount;
        withIssuesCount = nextWithIssuesCount;
        failedCount = nextFailedCount;
        processedBytes = nextProcessedBytes;
        bookResults = nextResults;
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

      await options?.onBeforeRefresh?.();
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
        withIssuesCount,
        failedCount,
        totalBytes,
        elapsedMs,
        books: bookResults,
      });
    }

    if (immediateFailures.length === 0) {
      setImportError(null);
      return;
    }

    if (immediateFailures.length === 1) {
      setImportError(immediateFailures[0]);
      return;
    }

    setImportError(`${immediateFailures.length} of ${totalPendingImports} imports failed. First error: ${immediateFailures[0]}`);
  }, [importService, isImportingBatch, refreshLibrary]);

  const handleStartPendingImport = useCallback(async () => {
    if (pendingImportItems.length === 0 || isImportingBatch) return;
    try {
      await runImportBatch(pendingImportItems);
      setPendingImportItems([]);
      setPendingImportDescription(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed");
    }
  }, [isImportingBatch, pendingImportItems, runImportBatch]);

  const handleStartFolderImport = useCallback(async (keptBookIds: string[]) => {
    if (!pendingFolderImport || isImportingBatch) return;
    const selectedIdSet = new Set(keptBookIds);
    const keptBooks = flattenFolderImportBooks(pendingFolderImport.preview.root).filter((book) =>
      selectedIdSet.has(book.id)
    );
    if (keptBooks.length === 0) return;

    const selectedItems: PendingImportItem[] = [];
    for (const book of keptBooks) {
      const item = pendingFolderImport.items[book.sourceIndex];
      if (item) {
        selectedItems.push(item);
      }
    }
    const baseLayout = await loadLibraryLayout();
    const prepared = prepareFolderImportLayout(
      baseLayout,
      pendingFolderImport.sourceFolderName,
      keptBooks
    );
    let nextLayout = prepared.layout;
    const folderIdByItem = new Map<PendingImportItem, string>();
    for (const book of keptBooks) {
      const item = pendingFolderImport.items[book.sourceIndex];
      if (!item) continue;
      folderIdByItem.set(
        item,
        prepared.folderIdByPath.get(folderPathKey(book.folderPath)) ?? prepared.folderIdByPath.get(folderPathKey([]))!
      );
    }

    try {
      const importedBookIds = new Set<string>();
      await runImportBatch(selectedItems, {
        onBookImported: (bookId, item) => {
          importedBookIds.add(bookId);
          nextLayout = moveBookToFolder(nextLayout, bookId, folderIdByItem.get(item) ?? null);
        },
        onBeforeRefresh: async () => {
          const snapshot = await importService.listImportSnapshot();
          const completedInBatch = new Set(
            snapshot
              .filter((row) => importedBookIds.has(row.bookId) && row.status === "completed")
              .map((row) => row.bookId)
          );
          // Drop placements only for books from this folder import that hard-failed
          // (and were purged). Leave every other library placement alone.
          nextLayout = {
            ...nextLayout,
            placements: nextLayout.placements.filter((placement) => {
              if (!importedBookIds.has(placement.bookId)) return true;
              return completedInBatch.has(placement.bookId);
            }),
          };
          await saveLibraryLayout(nextLayout);
        },
      });
      setPendingFolderImport(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Folder import failed");
    }
  }, [importService, isImportingBatch, pendingFolderImport, runImportBatch]);

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

  const handleLibraryLayoutChange = useCallback(async (nextLayout: LibraryLayout) => {
    setLibraryLayout(nextLayout);
    try {
      await saveLibraryLayout(nextLayout);
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to save library folders");
      await refreshLibrary({ showLoading: false });
    }
  }, [refreshLibrary]);

  const handleCreateLibraryFolder = useCallback((parentId: string | null) => {
    const created = addLibraryFolder(libraryLayout, {
      label: "New folder",
      parentId,
      color: "cyan",
      insertAt: "top",
    });
    void handleLibraryLayoutChange(created.layout);
  }, [handleLibraryLayoutChange, libraryLayout]);

  const handleDeleteLibraryFolderOnly = useCallback((folderId: string) => {
    void handleLibraryLayoutChange(deleteLibraryFolderOnly(libraryLayout, folderId));
  }, [handleLibraryLayoutChange, libraryLayout]);

  const handleDeleteLibraryFolderWithContents = useCallback(async (folderId: string) => {
    const result = deleteLibraryFolderWithContents(libraryLayout, folderId);
    try {
      for (const bookId of result.removedBookIds) {
        await importService.deleteBook(bookId);
      }
      await handleLibraryLayoutChange(result.layout);
      await refreshLibrary({ showLoading: false });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to delete folder contents");
      await refreshLibrary({ showLoading: false });
    }
  }, [handleLibraryLayoutChange, importService, libraryLayout, refreshLibrary]);

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-8 bg-neutral-950 text-neutral-100 relative overflow-hidden">
      <BackgroundDecoration />
      <input
        ref={fileInputRef}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
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
            <div className="mx-auto max-w-xs">
              <button
                type="button"
                onClick={openImportChooser}
                className="w-full rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-semibold text-violet-200 hover:bg-violet-500/25 transition-colors"
              >
                Import
              </button>
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
                  Moods
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

        {lastImportSummary && pendingImportItems.length === 0 && !pendingFolderImport ? (
          <section className="rounded-2xl border border-emerald-400/25 bg-neutral-900/75 p-4 shadow-xl shadow-black/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-neutral-100">Last import</h2>
                <p className="mt-1 text-sm text-neutral-400">
                  {lastImportSummary.completedCount - lastImportSummary.withIssuesCount} OK
                  {lastImportSummary.withIssuesCount > 0
                    ? `, ${lastImportSummary.withIssuesCount} with issues`
                    : ""}
                  {lastImportSummary.failedCount > 0 ? `, ${lastImportSummary.failedCount} failed` : ""}
                  {" "}from {formatSummaryBytes(lastImportSummary.totalBytes)}
                </p>
              </div>
              <div className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200">
                {formatSummaryDuration(lastImportSummary.elapsedMs)}
              </div>
            </div>
            {lastImportSummary.books.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {lastImportSummary.books.map((book) => (
                  <li
                    key={book.id}
                    className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-neutral-100">{book.fileName}</div>
                        {book.reason ? (
                          <p className="mt-1 text-xs text-neutral-400">{book.reason}</p>
                        ) : null}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                          book.status === "ok"
                            ? "border border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                            : book.status === "with_issues"
                              ? "border border-amber-400/30 bg-amber-500/10 text-amber-100"
                              : "border border-rose-400/30 bg-rose-500/10 text-rose-100"
                        }`}
                      >
                        {book.status === "ok" ? "OK" : book.status === "with_issues" ? "With issues" : "Failed"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
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

        {pendingFolderImport ? (
          <NestedPickPrune
            root={pendingFolderImport.preview.root}
            title={`Review ${pendingFolderImport.sourceFolderName}`}
            description="Everything is selected. Remove books or folders you do not want before importing."
            confirmLabel="Import selected"
            isBusy={isImportingBatch}
            onCancel={handleCancelPendingImport}
            onConfirm={(keptBookIds) => {
              void handleStartFolderImport(keptBookIds);
            }}
          />
        ) : null}

        {isImportChooserOpen ? (
          <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
            <button
              type="button"
              aria-label="Close import chooser"
              className="absolute inset-0"
              onClick={() => setIsImportChooserOpen(false)}
            />
            <div className="relative w-full rounded-2xl border border-neutral-800 bg-neutral-900 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] shadow-2xl shadow-black/60">
              <button
                type="button"
                onClick={() => {
                  void triggerImportPicker();
                }}
                className="w-full rounded-xl px-4 py-3 text-left text-sm font-semibold text-neutral-100 hover:bg-neutral-800 transition-colors"
              >
                EPUB or PDF files
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleImportFolder();
                }}
                className="mt-1 w-full rounded-xl px-4 py-3 text-left text-sm font-semibold text-neutral-100 hover:bg-neutral-800 transition-colors"
              >
                Folder
              </button>
              <button
                type="button"
                onClick={() => setIsImportChooserOpen(false)}
                className="mt-2 w-full rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-semibold text-neutral-300"
              >
                Cancel
              </button>
            </div>
          </div>
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

            <LibraryTreeView
              entries={entries}
              layout={libraryLayout}
              isLoading={isLoading}
              deletingBookId={deletingBookId}
              busyBookIds={busyBookIds}
              onLayoutChange={handleLibraryLayoutChange}
              onCreateFolder={handleCreateLibraryFolder}
              onDeleteFolderOnly={handleDeleteLibraryFolderOnly}
              onDeleteFolderWithContents={(folderId) => {
                void handleDeleteLibraryFolderWithContents(folderId);
              }}
              onOpenBook={(entry) => {
                void handleOpenOrRetry(entry);
              }}
              onEditBook={handleOpenEdit}
              onDeleteBook={(entry) => {
                void handleDelete(entry);
              }}
            />
          </motion.section>
        ) : (
          <section id="home-panel-mood" role="tabpanel" aria-labelledby="home-tab-mood">
            <MoodView
              books={libraryBooks}
              libraryLayout={libraryLayout}
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
