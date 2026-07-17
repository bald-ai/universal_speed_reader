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
import ImportSessionReport, {
  type ImportSessionCurrent,
} from "@/components/library/ImportSessionReport";
import LastImportReport from "@/components/library/LastImportReport";
import LibraryTreeView, {
  type BulkLibraryDeleteRequest,
} from "@/components/library/LibraryTreeView";
import MoodView from "@/components/library/MoodView";
import NestedPickPrune from "@/components/library/NestedPickPrune";
import { motion, useReducedMotion } from "framer-motion";
import type { LibraryBook } from "@/types/book";
import type { LibraryLayout } from "@/types/libraryLayout";
import { loadLibraryEntries, type LibraryEntry } from "@/lib/library/libraryBooks";
import {
  getBookImportService,
  isImportAbortError,
  type ImportPayload,
} from "@/lib/import/bookImportService";
import {
  stopBatchImportAfterFailure,
  watchBatchImportAbort,
} from "@/lib/import/batchImportCancellation";
import { importPhaseLabel, isActiveImportStatus } from "@/lib/import/importPhaseLabel";
import { isSupportedBookFile } from "@/lib/import/bookFileSelection";
import { startKeepAwake } from "@/lib/screenAwake";
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
  pruneEmptyFolders,
  saveLibraryLayout,
} from "@/lib/libraryLayoutStore";
import {
  SUPPORT_CONTACT_EMAIL,
  buildSupportMailto,
} from "@/lib/supportContact";

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

type ImportBookResultStatus = "ok" | "with_issues" | "failed" | "canceled";

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
  canceledCount: number;
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
/** One at a time so each batch book parses under solo-equivalent conditions (see plan H). */
const BATCH_IMPORT_READ_CONCURRENCY = 1;

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

async function loadPendingImportPayload(
  item: PendingImportItem,
  signal?: AbortSignal
): Promise<ImportPayload> {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  if (item.kind === "file") {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return {
      fileName: item.file.name,
      mimeType: item.file.type || "application/octet-stream",
      bytes,
    };
  }

  return {
    fileName: item.nativeFile.name,
    mimeType: item.nativeFile.type ?? "application/octet-stream",
    bytes: await readNativeEpubFolderBytes(item.nativeFile, signal),
  };
}

async function runWithLimitedConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      if (signal?.aborted) return;
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  const results = await Promise.allSettled(runners);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (rejected) {
    throw rejected.reason;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
  const shouldReduceMotion = useReducedMotion();
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
  const [isCancelingBatch, setIsCancelingBatch] = useState(false);
  const [isCancelImportConfirmOpen, setIsCancelImportConfirmOpen] = useState(false);
  const [batchImportProgress, setBatchImportProgress] = useState({
    completed: 0,
    withIssues: 0,
    failed: 0,
    canceled: 0,
  });
  const [batchImportTiming, setBatchImportTiming] = useState<BatchImportTiming>({
    startedAtMs: null,
    elapsedMs: 0,
    processedBytes: 0,
  });
  const [batchLiveBooks, setBatchLiveBooks] = useState<ImportBookResult[]>([]);
  const [batchCurrent, setBatchCurrent] = useState<ImportSessionCurrent | null>(null);
  const [batchTotalCount, setBatchTotalCount] = useState(0);
  const [lastImportSummary, setLastImportSummary] = useState<ImportTimingSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importRefreshTimeoutRef = useRef<number | null>(null);
  const batchAbortControllerRef = useRef<AbortController | null>(null);
  /** Ref so the import-service subscribe callback (registered once) sees live batch lock. */
  const isImportingBatchRef = useRef(false);
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
      if (isImportingBatchRef.current) return;
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

  useEffect(() => {
    if (!isImportingBatch) return undefined;
    const stopKeepingScreenAwake = startKeepAwake();
    return () => {
      stopKeepingScreenAwake();
    };
  }, [isImportingBatch]);

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
  const batchEstimatedRemainingMs = useMemo(() => {
    const total = batchTotalCount || pendingImportItems.length;
    const finished =
      batchImportProgress.completed + batchImportProgress.failed + batchImportProgress.canceled;
    const remaining = Math.max(0, total - finished);
    if (finished <= 0 || remaining <= 0 || batchImportTiming.elapsedMs <= 0) {
      return null;
    }
    return (batchImportTiming.elapsedMs / finished) * remaining;
  }, [
    batchImportProgress.canceled,
    batchImportProgress.completed,
    batchImportProgress.failed,
    batchImportTiming.elapsedMs,
    batchTotalCount,
    pendingImportItems.length,
  ]);

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
      setBatchImportProgress({ completed: 0, withIssues: 0, failed: 0, canceled: 0 });
      setBatchLiveBooks([]);
      setBatchCurrent(null);
      setBatchTotalCount(0);
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
    setBatchImportProgress({ completed: 0, withIssues: 0, failed: 0, canceled: 0 });
    setBatchLiveBooks([]);
    setBatchCurrent(null);
    setBatchTotalCount(0);
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
        setBatchImportProgress({ completed: 0, withIssues: 0, failed: 0, canceled: 0 });
        setBatchLiveBooks([]);
        setBatchCurrent(null);
        setBatchTotalCount(0);
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
      setBatchImportProgress({ completed: 0, withIssues: 0, failed: 0, canceled: 0 });
      setBatchLiveBooks([]);
      setBatchCurrent(null);
      setBatchTotalCount(0);
      setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
      setLastImportSummary(null);
      setView("library");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not open that folder.");
    }
  }, [isImportingBatch]);

  const handleCancelPendingImport = useCallback(() => {
    if (isImportingBatch) {
      if (isCancelingBatch) return;
      setIsCancelImportConfirmOpen(true);
      return;
    }
    setPendingImportItems([]);
    setPendingFolderImport(null);
    setPendingImportDescription(null);
    setBatchImportProgress({ completed: 0, withIssues: 0, failed: 0, canceled: 0 });
    setBatchLiveBooks([]);
    setBatchCurrent(null);
    setBatchTotalCount(0);
    setBatchImportTiming({ startedAtMs: null, elapsedMs: 0, processedBytes: 0 });
  }, [isCancelingBatch, isImportingBatch]);

  const handleConfirmCancelImport = useCallback(() => {
    if (!isImportingBatch || isCancelingBatch) {
      setIsCancelImportConfirmOpen(false);
      return;
    }
    setIsCancelImportConfirmOpen(false);
    setIsCancelingBatch(true);
    batchAbortControllerRef.current?.abort();
  }, [isCancelingBatch, isImportingBatch]);

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
    const abortController = new AbortController();
    batchAbortControllerRef.current = abortController;
    const signal = abortController.signal;
    const immediateFailedResults: ImportBookResult[] = [];
    const immediateCanceledResults: ImportBookResult[] = [];
    const trackedBooks: TrackedImportBook[] = [];
    const handledItems = new Set<PendingImportItem>();
    let immediateFailureSeq = 0;
    let immediateCanceledSeq = 0;
    let completedCount = 0;
    let withIssuesCount = 0;
    let failedCount = 0;
    let canceledCount = 0;
    let processedBytes = 0;
    let bookResults: ImportBookResult[] = [];
    let cancelCleanupStarted = false;
    let outcomesCollected = false;
    importService.clearTerminalOutcomes();
    setImportError(null);
    isImportingBatchRef.current = true;
    setIsImportingBatch(true);
    // Drop any refresh queued just before lock so it cannot fire mid-batch.
    if (importRefreshTimeoutRef.current !== null) {
      window.clearTimeout(importRefreshTimeoutRef.current);
      importRefreshTimeoutRef.current = null;
    }
    setIsCancelingBatch(false);
    setView("library");
    setEditingBookId(null);
    setIsImportChooserOpen(false);
    setBatchImportProgress({ completed: 0, withIssues: 0, failed: 0, canceled: 0 });
    setBatchLiveBooks([]);
    setBatchCurrent(null);
    setBatchTotalCount(totalPendingImports);
    setBatchImportTiming({ startedAtMs, elapsedMs: 0, processedBytes: 0 });

    const pushCanceledResult = (item: PendingImportItem, idPrefix: string) => {
      immediateCanceledSeq += 1;
      immediateCanceledResults.push({
        id: `${idPrefix}-${immediateCanceledSeq}`,
        fileName: item.name,
        status: "canceled",
        reason: null,
        sizeBytes: item.size,
      });
    };

    const trackBook = (bookId: string, item: PendingImportItem) => {
      trackedBooks.push({ bookId, item });
      // importFromBytes is no longer tied to this signal after it returns, so a
      // book enqueued just before/after abort must be canceled explicitly.
      if (signal.aborted) {
        void importService.cancelBooks([bookId]);
      }
    };

    const stopWatchingAbort = watchBatchImportAbort(
      signal,
      () => trackedBooks.map((tracked) => tracked.bookId),
      async (bookIds) => {
        setIsCancelingBatch(true);
        await importService.cancelBooks(bookIds);
      }
    );

    try {
      await runWithLimitedConcurrency(
        items,
        BATCH_IMPORT_READ_CONCURRENCY,
        async (item) => {
          handledItems.add(item);
          if (signal.aborted) {
            pushCanceledResult(item, "canceled-skip");
            return;
          }
          let bookId: string;
          try {
            // Wait until the previous book's parse finishes before reading this file.
            await importService.waitForIdle(signal);
            if (signal.aborted) {
              pushCanceledResult(item, "canceled-skip");
              return;
            }
            const payload = await loadPendingImportPayload(item, signal);
            if (signal.aborted) {
              pushCanceledResult(item, "canceled-load");
              return;
            }
            bookId = await importService.importFromBytes(payload, {
              inlineSourceMode: "bounded",
              signal,
            });
            if (signal.aborted) {
              trackBook(bookId, item);
              return;
            }
          } catch (error) {
            if (signal.aborted || isImportAbortError(error)) {
              pushCanceledResult(item, "canceled-prequeue");
              return;
            }
            const message = error instanceof Error ? error.message : "Import failed";
            immediateFailureSeq += 1;
            immediateFailedResults.push({
              id: `prequeue-${immediateFailureSeq}`,
              fileName: item.name,
              status: "failed",
              reason: message,
              sizeBytes: item.size,
            });
            return;
          } finally {
            setBatchImportTiming((current) => ({
              ...current,
              elapsedMs: Date.now() - startedAtMs,
            }));
          }

          trackBook(bookId, item);
          try {
            await options?.onBookImported?.(bookId, item);
          } catch (error) {
            // Stop sibling reads immediately; the outer catch awaits scoped
            // importer cleanup before the foreground session unlocks.
            stopWatchingAbort();
            abortController.abort();
            throw error;
          }
        },
        signal
      );

      for (const item of items) {
        if (!handledItems.has(item)) {
          pushCanceledResult(item, "canceled-unstarted");
        }
      }

      while (completedCount + failedCount + canceledCount < totalPendingImports) {
        if (signal.aborted && !cancelCleanupStarted) {
          cancelCleanupStarted = true;
          setIsCancelingBatch(true);
          const snapshotForCancel = await importService.listImportSnapshot();
          const statusByBookId = new Map(snapshotForCancel.map((row) => [row.bookId, row]));
          const toCancel = trackedBooks
            .filter((tracked) => {
              const row = statusByBookId.get(tracked.bookId);
              if (!row) return true;
              return (
                row.status !== "completed" &&
                row.status !== "failed" &&
                row.status !== "canceled"
              );
            })
            .map((tracked) => tracked.bookId);
          if (toCancel.length > 0) {
            await importService.cancelBooks(toCancel);
          }
        }

        const snapshot = await importService.listImportSnapshot();
        const statusByBookId = new Map(snapshot.map((row) => [row.bookId, row]));
        const nextResults: ImportBookResult[] = [
          ...immediateFailedResults,
          ...immediateCanceledResults,
        ];
        let nextCompletedCount = 0;
        let nextWithIssuesCount = 0;
        let nextFailedCount = immediateFailedResults.length;
        let nextCanceledCount = immediateCanceledResults.length;
        let nextProcessedBytes = [...immediateFailedResults, ...immediateCanceledResults].reduce(
          (sum, result) => sum + result.sizeBytes,
          0
        );

        for (const trackedBook of trackedBooks) {
          const row = statusByBookId.get(trackedBook.bookId);
          if (!row) {
            // Library delete mid-batch or cancel purge without a retained outcome.
            nextCanceledCount += 1;
            nextProcessedBytes += trackedBook.item.size;
            nextResults.push({
              id: trackedBook.bookId,
              fileName: trackedBook.item.name,
              status: "canceled",
              reason: null,
              sizeBytes: trackedBook.item.size,
            });
            continue;
          }

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
            nextResults.push({
              id: trackedBook.bookId,
              fileName: trackedBook.item.name,
              status: "failed",
              reason,
              sizeBytes: trackedBook.item.size,
            });
            continue;
          }

          if (row.status === "canceled") {
            nextCanceledCount += 1;
            nextProcessedBytes += trackedBook.item.size;
            nextResults.push({
              id: trackedBook.bookId,
              fileName: trackedBook.item.name,
              status: "canceled",
              reason: null,
              sizeBytes: trackedBook.item.size,
            });
          }
        }

        completedCount = nextCompletedCount;
        withIssuesCount = nextWithIssuesCount;
        failedCount = nextFailedCount;
        canceledCount = nextCanceledCount;
        processedBytes = nextProcessedBytes;
        bookResults = nextResults;

        let nextCurrent: ImportSessionCurrent | null = null;
        for (const trackedBook of trackedBooks) {
          const row = statusByBookId.get(trackedBook.bookId);
          if (!row || !isActiveImportStatus(row.status)) continue;
          nextCurrent = {
            fileName: trackedBook.item.name,
            phaseLabel: importPhaseLabel(row.status),
          };
          break;
        }

        setBatchImportProgress({
          completed: completedCount,
          withIssues: withIssuesCount,
          failed: failedCount,
          canceled: canceledCount,
        });
        setBatchLiveBooks(nextResults);
        setBatchCurrent(nextCurrent);
        setBatchImportTiming((current) => ({
          ...current,
          elapsedMs: Date.now() - startedAtMs,
          processedBytes,
        }));

        if (completedCount + failedCount + canceledCount >= totalPendingImports) {
          break;
        }

        await delay(signal.aborted ? 200 : 1000);
      }

      outcomesCollected = true;
    } catch (error) {
      if (!outcomesCollected) {
        stopWatchingAbort();
        setIsCancelingBatch(true);
        try {
          await stopBatchImportAfterFailure(
            abortController,
            () => trackedBooks.map((tracked) => tracked.bookId),
            (bookIds) => importService.cancelBooks(bookIds)
          );
        } catch (cleanupError) {
          console.warn("Could not fully clean up the failed import batch:", cleanupError);
        }
      }
      throw error;
    } finally {
      stopWatchingAbort();
      const elapsedMs = Date.now() - startedAtMs;
      if (batchAbortControllerRef.current === abortController) {
        batchAbortControllerRef.current = null;
      }
      // One library refresh on every exit path (success, cancel, error) before unlock.
      try {
        if (outcomesCollected) {
          await options?.onBeforeRefresh?.();
        }
        await refreshLibrary({ showLoading: false });
      } catch (refreshError) {
        console.warn("Could not refresh library after import batch:", refreshError);
      }
      isImportingBatchRef.current = false;
      setIsImportingBatch(false);
      setIsCancelingBatch(false);
      setIsCancelImportConfirmOpen(false);
      setBatchCurrent(null);
      setBatchLiveBooks([]);
      setBatchTotalCount(0);
      setBatchImportTiming({
        startedAtMs: null,
        elapsedMs,
        processedBytes,
      });
      if (outcomesCollected) {
        setLastImportSummary({
          bookCount: totalPendingImports,
          completedCount,
          withIssuesCount,
          failedCount,
          canceledCount,
          totalBytes,
          elapsedMs,
          books: bookResults,
        });
      }
    }

    // Batch outcomes (including failures) live in Last import — no duplicate footer banner.
    setImportError(null);
  }, [importService, isImportingBatch, refreshLibrary]);

  const handleStartPendingImport = useCallback(async () => {
    if (pendingImportItems.length === 0 || isImportingBatch) return;
    try {
      await runImportBatch(pendingImportItems);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed");
    } finally {
      setPendingImportItems([]);
      setPendingImportDescription(null);
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

    const createdFolderIds = new Set(prepared.folderIdByPath.values());

    try {
      setPendingImportItems(selectedItems);
      setPendingImportDescription(
        `Importing from ${pendingFolderImport.sourceFolderName}. Finished books keep their folder placement.`
      );
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
          // Keep placements only for books from this folder import that completed.
          // Drop canceled/failed placements and prune empty folders created for this import.
          nextLayout = {
            ...nextLayout,
            placements: nextLayout.placements.filter((placement) => {
              if (!importedBookIds.has(placement.bookId)) return true;
              return completedInBatch.has(placement.bookId);
            }),
          };
          nextLayout = pruneEmptyFolders(nextLayout, createdFolderIds);
          await saveLibraryLayout(nextLayout);
        },
      });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Folder import failed");
    } finally {
      setPendingFolderImport(null);
      setPendingImportItems([]);
      setPendingImportDescription(null);
    }
  }, [importService, isImportingBatch, pendingFolderImport, runImportBatch]);

  const handleOpenOrRetry = useCallback(
    async (entry: LibraryEntry) => {
      if (isImportingBatch) return;
      if (entry.processingStatus === "completed") {
        setLocation(`/reader/${entry.id}`);
        return;
      }
      if (entry.processingStatus === "failed") {
        await importService.retryImport(entry.id);
        await refreshLibrary();
      }
    },
    [importService, isImportingBatch, refreshLibrary, setLocation]
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

  const handleBulkDelete = useCallback(async (request: BulkLibraryDeleteRequest) => {
    if (request.mode === "books") {
      if (request.bookIds.length === 0) return;
      const confirmed =
        typeof window === "undefined"
          ? true
          : window.confirm(
              `Delete ${request.bookIds.length} book${request.bookIds.length === 1 ? "" : "s"} from your library?\n\nThis removes the uploaded files, reading progress, and import history.`
            );
      if (!confirmed) return;
      try {
        for (const bookId of request.bookIds) {
          await importService.deleteBook(bookId);
        }
        await refreshLibrary({ showLoading: false });
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "Failed to delete books");
        await refreshLibrary({ showLoading: false });
      }
      return;
    }

    if (request.mode === "folders-only") {
      let next = libraryLayout;
      for (const folderId of request.folderIds) {
        if (!next.folders.some((folder) => folder.id === folderId)) continue;
        next = deleteLibraryFolderOnly(next, folderId);
      }
      await handleLibraryLayoutChange(next);
      return;
    }

    let next = libraryLayout;
    const removedBookIds = new Set(request.bookIds);
    for (const folderId of request.folderIds) {
      if (!next.folders.some((folder) => folder.id === folderId)) continue;
      const result = deleteLibraryFolderWithContents(next, folderId);
      next = result.layout;
      for (const bookId of result.removedBookIds) {
        removedBookIds.add(bookId);
      }
    }
    try {
      for (const bookId of removedBookIds) {
        await importService.deleteBook(bookId);
      }
      await handleLibraryLayoutChange(next);
      await refreshLibrary({ showLoading: false });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to delete selection");
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
          initial={shouldReduceMotion ? false : { opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={shouldReduceMotion
            ? { duration: 0 }
            : { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          <motion.div
            initial={shouldReduceMotion ? false : { scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.6, delay: shouldReduceMotion ? 0 : 0.1 }}
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
            initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.5, delay: shouldReduceMotion ? 0 : 0.2 }}
          >
            Speed Reading
          </motion.h1>

          <motion.p
            className="text-sm text-neutral-400 mt-3 max-w-xs mx-auto leading-relaxed"
            initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.5, delay: shouldReduceMotion ? 0 : 0.3 }}
          >
            Practice rapid serial visual presentation (RSVP) and switch to normal reading whenever you need more context.
          </motion.p>

          <motion.div
            className="mt-5"
            initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.35, delay: shouldReduceMotion ? 0 : 0.35 }}
          >
            <div className="mx-auto max-w-xs">
              <button
                type="button"
                onClick={openImportChooser}
                disabled={isImportingBatch}
                className="w-full rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-semibold text-violet-200 hover:bg-violet-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-500/15"
              >
                Import
              </button>
            </div>
          </motion.div>
        </motion.header>

        {/* View Toggle */}
        <motion.div
          initial={shouldReduceMotion ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={shouldReduceMotion
            ? { duration: 0 }
            : { duration: 0.45, delay: 0.38, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="flex justify-center"
        >
          <div className="w-full rounded-xl bg-neutral-900 border border-neutral-800 p-1 h-9 flex items-center">
            <div className="relative w-full grid grid-cols-2" role="tablist" aria-label="Library views">
              <button
                type="button"
                onClick={() => {
                  if (isImportingBatch) return;
                  setView("mood");
                }}
                disabled={isImportingBatch}
                className="relative h-7 rounded-lg disabled:cursor-not-allowed"
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
                    transition={shouldReduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 420, damping: 32 }}
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
                onClick={() => {
                  if (isImportingBatch) return;
                  setView("library");
                }}
                disabled={isImportingBatch}
                className="relative h-7 rounded-lg disabled:cursor-not-allowed"
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
                    transition={shouldReduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 420, damping: 32 }}
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

        {isImportingBatch ? (
          <ImportSessionReport
            totalCount={batchTotalCount || pendingImportItems.length}
            completedCount={batchImportProgress.completed}
            withIssuesCount={batchImportProgress.withIssues}
            failedCount={batchImportProgress.failed}
            canceledCount={batchImportProgress.canceled}
            isCanceling={isCancelingBatch}
            elapsedMs={batchImportTiming.elapsedMs}
            estimatedRemainingMs={batchEstimatedRemainingMs}
            current={batchCurrent}
            books={batchLiveBooks}
            onCancel={handleCancelPendingImport}
          />
        ) : null}

        {!isImportingBatch && lastImportSummary && pendingImportItems.length === 0 && !pendingFolderImport ? (
          <LastImportReport
            summary={lastImportSummary}
            onDismiss={() => setLastImportSummary(null)}
          />
        ) : null}

        {!isImportingBatch && pendingImportItems.length > 0 ? (
          <BulkImportReview
            files={pendingImportItems}
            description={pendingImportDescription ?? undefined}
            onStart={() => {
              void handleStartPendingImport();
            }}
            onCancel={handleCancelPendingImport}
          />
        ) : null}

        {pendingFolderImport && pendingImportItems.length === 0 && !isImportingBatch ? (
          <NestedPickPrune
            root={pendingFolderImport.preview.root}
            title={`Review ${pendingFolderImport.sourceFolderName}`}
            description="Everything is selected. Remove books or folders you do not want before importing."
            confirmLabel="Import selected"
            isBusy={false}
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

        {isCancelImportConfirmOpen ? (
          <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
            <button
              type="button"
              aria-label="Keep importing"
              className="absolute inset-0"
              data-testid="cancel-import-dismiss"
              onClick={() => setIsCancelImportConfirmOpen(false)}
            />
            <div
              className="relative w-full rounded-2xl border border-neutral-800 bg-neutral-900 p-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] shadow-2xl shadow-black/60"
              data-testid="cancel-import-confirm"
            >
              <h2 className="text-base font-semibold text-neutral-100">Cancel this import?</h2>
              <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                Finished books will stay in your library. The current book and books still waiting will be removed.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  data-testid="cancel-import-keep"
                  onClick={() => setIsCancelImportConfirmOpen(false)}
                  className="rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm font-semibold text-neutral-300"
                >
                  Keep importing
                </button>
                <button
                  type="button"
                  data-testid="cancel-import-confirm-action"
                  onClick={handleConfirmCancelImport}
                  className="rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2.5 text-sm font-semibold text-rose-100"
                >
                  Cancel import
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Book Section — inert while a foreground import session owns the screen */}
        <div
          className={isImportingBatch ? "pointer-events-none select-none opacity-45" : undefined}
          aria-hidden={isImportingBatch || undefined}
        >
          {view === "library" ? (
            <motion.section
              id="home-panel-library"
              role="tabpanel"
              aria-labelledby="home-tab-library"
              initial={shouldReduceMotion ? false : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.5, delay: shouldReduceMotion ? 0 : 0.4 }}
            >
              <motion.h2
                className="text-xs uppercase tracking-[0.2em] text-neutral-500 mb-4 px-1"
                initial={shouldReduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.4, delay: shouldReduceMotion ? 0 : 0.5 }}
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
                onBulkDelete={(request) => {
                  if (isImportingBatch) return;
                  void handleBulkDelete(request);
                }}
                onOpenBook={(entry) => {
                  if (isImportingBatch) return;
                  void handleOpenOrRetry(entry);
                }}
                onEditBook={(entry) => {
                  if (isImportingBatch) return;
                  handleOpenEdit(entry);
                }}
                onDeleteBook={(entry) => {
                  if (isImportingBatch) return;
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
                  if (isImportingBatch) return;
                  const entry = entryById.get(bookId);
                  if (!entry) return;
                  if (entry.processingStatus !== "completed") return;
                  setLocation(`/reader/${bookId}`);
                }}
              />
            </section>
          )}
        </div>

        {importError ? (
          <div className="rounded-xl border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {importError}
          </div>
        ) : null}

        {/* Footer */}
        <motion.footer
          className={`text-center pt-8 space-y-2 ${
            isImportingBatch ? "pointer-events-none select-none opacity-45" : ""
          }`}
          aria-hidden={isImportingBatch || undefined}
          initial={shouldReduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: shouldReduceMotion ? 0 : 0.5, delay: shouldReduceMotion ? 0 : 0.6 }}
        >
          <p className="text-xs text-neutral-600">
            Offline-first mode: imports, settings, and progress are stored locally
          </p>
          <p className="text-xs text-neutral-500 leading-relaxed max-w-sm mx-auto">
            Contact{" "}
            <a
              href={buildSupportMailto({
                subject: "Speed Reading feedback",
                body: [
                  "What happened:",
                  "",
                  "(short description)",
                  "",
                  "If a book failed, attach the EPUB/PDF if you can.",
                ].join("\n"),
              })}
              aria-disabled={isImportingBatch || undefined}
              tabIndex={isImportingBatch ? -1 : undefined}
              onClick={(event) => {
                if (isImportingBatch) {
                  event.preventDefault();
                }
              }}
              className="text-neutral-400 underline underline-offset-2 hover:text-neutral-300 transition-colors"
              data-testid="home-support-email"
            >
              {SUPPORT_CONTACT_EMAIL}
            </a>
            . Send issues anytime — attach the file if one failed. I reply within 24h.
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
