import { BookParserError, parseBookBytes } from "@/lib/bookParser";
import { removeBookReferences } from "@/lib/moodStore";
import { removeBookFromLibraryLayout, updateLibraryLayout } from "@/lib/libraryLayoutStore";
import { getBookRepository } from "@/lib/storage/appRepository";
import type { BookRepository } from "@/lib/storage/bookRepository";
import { deleteRawBook, loadRawBook, storeRawBook, type RawBookRecord } from "@/lib/import/rawEpubStore";
import { removeBookRulesFromStore, TTS_REGEX_SETTINGS_KEY } from "@/lib/ttsRegex/storePersistence";
import { clearBookTokenCache } from "@/lib/utils/tokenCache";
import {
  chunkParagraphs,
  computeTotalWords,
  hasSequentialParagraphIds,
  normalizeChapters,
} from "@/lib/import/normalization";
import { epubCoverDataUrl } from "@/lib/import/epubCoverDataUrl";
import { createPdfCoverDataUrl } from "@/lib/import/pdfImageRenderer";
import { clearBookImageSrcCache } from "@/lib/reader/resolveBookImageSrc";
import {
  classifyImportDiagnostics,
  ensureImagesMissingWarning,
} from "@/lib/import/importDiagnostics";
import { MAX_INLINE_MEDIA_LENGTH } from "@/lib/bookParser/validate";
import type {
  BookImageRow,
  BookRow,
  ImportErrorBucket,
  ImportJobRow,
  ProcessingStatus,
  ProcessingWarning,
} from "@/types/storage";
import type { BookFormat, BookImage as ParsedBookImage } from "@/lib/bookParser/types";

const MAX_IMPORT_SIZE_BYTES = 150 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 180_000;
const MAX_TITLE_LENGTH = 160;
const MAX_AUTHOR_LENGTH = 160;
const INLINE_BATCH_MAX_BYTES = 96 * 1024 * 1024;
const INLINE_BATCH_MAX_TASKS = 4;

export type ImportPayload = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

type ImportOptions = {
  inlineSourceMode?: "idle" | "bounded";
};

type ImportSnapshotRow = {
  bookId: string;
  status: ProcessingStatus;
  error: string | null;
  warnings: ProcessingWarning[] | null;
};

type ImportTerminalOutcome = {
  status: "completed" | "failed";
  attempt: number;
  error: string | null;
  warnings: ProcessingWarning[] | null;
  fileName: string;
};

type UpdateBookMetadataInput = {
  bookId: string;
  title: string;
  author: string | null;
  coverDataUrl?: string | null;
};

class ImportFailure extends Error {
  readonly bucket: ImportErrorBucket;

  constructor(bucket: ImportErrorBucket, message: string) {
    super(message);
    this.name = "ImportFailure";
    this.bucket = bucket;
  }
}

function fileNameToTitle(fileName: string): string {
  const withoutExtension = fileName.replace(/\.(?:epub|pdf)$/i, "").trim();
  return withoutExtension.length > 0 ? withoutExtension : "Untitled";
}

function createBookId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

class ImportCancelledError extends Error {
  constructor() {
    super("Import cancelled");
    this.name = "ImportCancelledError";
  }
}

function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;

    const settleResolve = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      resolve(value);
    };

    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      reject(error);
    };

    const onExternalAbort = () => {
      controller.abort();
      settleReject(new ImportCancelledError());
    };

    const timeoutId = setTimeout(() => {
      controller.abort();
      settleReject(
        new ImportFailure("Processing timeout", "Processing timeout: import exceeded 180 seconds")
      );
    }, timeoutMs);

    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
        return;
      }
      externalSignal.addEventListener("abort", onExternalAbort);
    }

    work(controller.signal).then(settleResolve, settleReject);
  });
}

function formatFailure(error: ImportFailure): string {
  const details = error.message.trim();
  if (!details) return error.bucket;
  if (details.toLowerCase().startsWith(error.bucket.toLowerCase())) {
    return details;
  }
  return `${error.bucket}: ${details}`;
}

function classifyError(error: unknown): ImportFailure {
  if (error instanceof ImportFailure) return error;
  if (error instanceof BookParserError) {
    return new ImportFailure("Corrupted/Unreadable book", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("aborted")) {
    return new ImportFailure("Processing timeout", "Processing timeout: import was cancelled");
  }
  if (normalized.includes("timeout")) {
    return new ImportFailure("Processing timeout", message);
  }
  if (normalized.includes("unsupported format")) {
    return new ImportFailure("Unsupported format", message);
  }
  if (normalized.includes("too large")) {
    return new ImportFailure("File too large", message);
  }
  return new ImportFailure("Corrupted/Unreadable book", message);
}

/**
 * Persist image sidecar rows as cheap references:
 * - inline `data:image/...` (e.g. serialized SVG) stored as-is when small enough
 * - zip-relative paths stored as paths (loaded on demand while reading)
 * Drops invalid or oversized payloads and reports how many were removed.
 */
export function toBookImageRows(
  bookId: string,
  parsedImages: ParsedBookImage[],
  format: BookFormat,
  paragraphCount: number
): { rows: BookImageRow[]; droppedCount: number } {
  if (parsedImages.length === 0) return { rows: [], droppedCount: 0 };
  const rows: BookImageRow[] = [];
  let droppedCount = 0;
  let previousAnchor = 0;

  for (const image of parsedImages) {
    const src = image.src.trim();
    const validAnchor = Number.isInteger(image.afterParagraphId)
      && image.afterParagraphId >= 0
      && image.afterParagraphId <= paragraphCount
      && image.afterParagraphId >= previousAnchor;
    const validSource = src.length > 0
      && !src.startsWith("blob:")
      && !/^javascript:/iu.test(src)
      && !(src.startsWith("data:") && src.length > MAX_INLINE_MEDIA_LENGTH)
      && (format !== "pdf" || /^pdf:\/\/page\/\d+(?:\/image\/\d+)?(?:[?#].*)?$/u.test(src));

    if (!validAnchor || !validSource) {
      droppedCount += 1;
      continue;
    }

    rows.push({
      book_id: bookId,
      image_index: rows.length,
      after_paragraph_id: image.afterParagraphId,
      alt: image.alt.trim() || null,
      src,
    });
    previousAnchor = image.afterParagraphId;
  }

  return { rows, droppedCount };
}

function isOversizedInlineCover(src: string | null | undefined): boolean {
  if (!src) return false;
  return src.startsWith("data:") && src.length > MAX_INLINE_MEDIA_LENGTH;
}

type ImportTask = {
  bookId: string;
  attempt: number;
  source: Pick<RawBookRecord, "fileName" | "mimeType" | "sizeBytes">;
  inlineSource?: RawBookRecord;
  inlineReservationBytes?: number;
  persistSource?: Promise<RawSourcePersistResult>;
  clearProgressOnSuccess: boolean;
  clearExistingContentBeforeParse: boolean;
  /** When true, hard-fail removes the library row. False for retry/restore of an existing book. */
  purgeOnHardFailure: boolean;
};

type RawSourcePersistResult =
  | { status: "stored" }
  | { status: "failed"; error: unknown };

function validateSource(source: Pick<RawBookRecord, "fileName" | "sizeBytes">): ImportFailure | null {
  const normalizedName = source.fileName.toLowerCase();
  if (!normalizedName.endsWith(".epub") && !normalizedName.endsWith(".pdf")) {
    return new ImportFailure("Unsupported format", "Unsupported format: only .epub and .pdf files are allowed");
  }
  if (source.sizeBytes > MAX_IMPORT_SIZE_BYTES) {
    return new ImportFailure("File too large", "File too large: maximum size is 150 MB");
  }
  return null;
}

type RawStoreAdapter = {
  store: (record: RawBookRecord) => Promise<void>;
  load: (bookId: string) => Promise<RawBookRecord | null>;
  remove: (bookId: string) => Promise<void>;
};

export class BookImportService {
  private readonly listeners = new Set<() => void>();
  private readonly queue: ImportTask[] = [];
  private readonly cancelledBookIds = new Set<string>();
  private activeBookId: string | null = null;
  private activeAbortController: AbortController | null = null;
  private isRunning = false;
  private readonly repositoryPromise: Promise<BookRepository>;
  private readonly rawStore: RawStoreAdapter;
  private enqueueLock: Promise<void> = Promise.resolve();
  private inlineBatchBytes = 0;
  private inlineBatchTasks = 0;
  /** Terminal outcomes retained after hard-fail purge so Last import can still report them. */
  private readonly terminalOutcomes = new Map<string, ImportTerminalOutcome>();
  private legacyFailedPurgePromise: Promise<void> | null = null;

  constructor(repositoryPromise?: Promise<BookRepository>, rawStore?: RawStoreAdapter) {
    this.repositoryPromise = repositoryPromise ?? getBookRepository();
    this.rawStore = rawStore ?? {
      store: storeRawBook,
      load: loadRawBook,
      remove: deleteRawBook,
    };
  }

  /** Removes leftover Failed library rows from older imports (one-time). */
  async purgeLegacyFailedBooks(): Promise<void> {
    if (!this.legacyFailedPurgePromise) {
      this.legacyFailedPurgePromise = this.runLegacyFailedPurge();
    }
    await this.legacyFailedPurgePromise;
  }

  private async runLegacyFailedPurge(): Promise<void> {
    const repository = await this.repositoryPromise;
    const settingKey = "import.purge_failed_library_rows.v1";
    const alreadyApplied = await repository.getAppSetting<boolean>(settingKey);
    if (alreadyApplied === true) return;

    const failedBooks = await repository.listBooks({ statuses: ["failed"] });
    for (const book of failedBooks) {
      await this.deleteBook(book.id);
    }
    await repository.putAppSetting(settingKey, true);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async importFromFile(file: File, options?: ImportOptions): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return this.importFromBytes({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      bytes,
    }, options);
  }

  async importFromBytes(payload: ImportPayload, options?: ImportOptions): Promise<string> {
    const repository = await this.repositoryPromise;
    const now = Date.now();
    const bookId = createBookId();

    const initialBook: BookRow = {
      id: bookId,
      title: fileNameToTitle(payload.fileName),
      author: null,
      cover_path: null,
      language: null,
      source_uri: `indexeddb://raw_books/${bookId}/${encodeURIComponent(payload.fileName)}`,
      size_bytes: payload.bytes.byteLength,
      processing_status: "queued",
      processing_error: null,
      processing_warnings: null,
      total_chunks: 0,
      total_paragraphs: 0,
      total_words: 0,
      created_at: now,
      updated_at: now,
    };

    await repository.upsertBook(initialBook);
    const attempt = await repository.nextImportAttempt(bookId);
    await repository.insertImportJob({
      book_id: bookId,
      attempt,
      status: "queued",
      error: null,
      started_at: now,
      finished_at: null,
    });
    this.emit();

    const source: RawBookRecord = {
      bookId,
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      sizeBytes: payload.bytes.byteLength,
      bytes: payload.bytes,
      storedAt: now,
    };

    const validationFailure = validateSource(source);
    if (validationFailure) {
      await this.failImport(repository, bookId, attempt, validationFailure, {
        fileName: payload.fileName,
        purge: true,
      });
      return bookId;
    }

    const inlineReservationBytes = this.reserveInlineSource(
      source.sizeBytes,
      options?.inlineSourceMode ?? "idle"
    );
    if (inlineReservationBytes !== null) {
      this.queue.push({
        bookId,
        attempt,
        source: {
          fileName: source.fileName,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
        },
        inlineSource: source,
        inlineReservationBytes,
        persistSource: this.persistRawSource(source),
        clearProgressOnSuccess: false,
        clearExistingContentBeforeParse: false,
        purgeOnHardFailure: true,
      });
      this.emit();
      void this.runQueue();
      return bookId;
    }

    try {
      await this.rawStore.store(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failImport(
        repository,
        bookId,
        attempt,
        new ImportFailure(
          "Corrupted/Unreadable book",
          `Corrupted/Unreadable book: failed to persist source file for retry (${message})`
        ),
        { fileName: payload.fileName, purge: true }
      );
      return bookId;
    }

    this.queue.push({
      bookId,
      attempt,
      source: {
        fileName: source.fileName,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
      },
      clearProgressOnSuccess: false,
      clearExistingContentBeforeParse: false,
      purgeOnHardFailure: true,
    });
    this.emit();
    void this.runQueue();
    return bookId;
  }

  async retryImport(bookId: string): Promise<void> {
    await this.withEnqueueLock(async () => {
      const repository = await this.repositoryPromise;
      const book = await repository.getBook(bookId);
      if (!book) {
        throw new Error(`Cannot retry unknown book ${bookId}`);
      }
      if (this.hasPendingOrActiveTask(bookId)) {
        return;
      }
      const canRetry =
        book.processing_status === "failed" || book.processing_status === "completed";
      if (!canRetry) {
        throw new Error("Book is currently processing and cannot be retried");
      }

      const now = Date.now();
      const attempt = await repository.nextImportAttempt(bookId);
      const job: ImportJobRow = {
        book_id: bookId,
        attempt,
        status: "queued",
        error: null,
        started_at: now,
        finished_at: null,
      };
      await repository.insertImportJob(job);
      // Keep prior soft warnings until a successful re-import replaces them.
      await repository.patchBook(bookId, {
        processing_status: "queued",
        processing_error: null,
        updated_at: now,
      });
      this.emit();

      const source = await this.rawStore.load(bookId);
      if (!source) {
        await this.failImport(
          repository,
          bookId,
          attempt,
          new ImportFailure(
            "Corrupted/Unreadable book",
            "Corrupted/Unreadable book: no stored source file available for retry"
          ),
          { fileName: book.title, purge: false }
        );
        return;
      }

      this.queue.push({
        bookId,
        attempt,
        source: {
          fileName: source.fileName,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
        },
        clearProgressOnSuccess: false,
        // Keep prior content until replace succeeds so a hard-fail cannot wipe the book.
        clearExistingContentBeforeParse: false,
        purgeOnHardFailure: false,
      });
      this.emit();
      void this.runQueue();
    });
  }

  async updateBookMetadata(input: UpdateBookMetadataInput): Promise<void> {
    await this.withEnqueueLock(async () => {
      const repository = await this.repositoryPromise;
      const book = await repository.getBook(input.bookId);
      if (!book) {
        throw new Error(`Cannot update unknown book ${input.bookId}`);
      }
      if (this.hasPendingOrActiveTask(input.bookId)) {
        throw new Error("Book is currently processing and cannot be edited");
      }
      const canEdit =
        book.processing_status === "failed" || book.processing_status === "completed";
      if (!canEdit) {
        throw new Error("Book is currently processing and cannot be edited");
      }

      const title = input.title.trim();
      if (!title) {
        throw new Error("Title is required");
      }
      if (title.length > MAX_TITLE_LENGTH) {
        throw new Error(`Title must be ${MAX_TITLE_LENGTH} characters or fewer`);
      }

      const author = input.author?.trim() ?? "";
      if (author.length > MAX_AUTHOR_LENGTH) {
        throw new Error(`Author must be ${MAX_AUTHOR_LENGTH} characters or fewer`);
      }

      const patch: Partial<BookRow> = {
        title,
        author: author.length > 0 ? author : null,
        updated_at: Date.now(),
      };

      if (Object.prototype.hasOwnProperty.call(input, "coverDataUrl")) {
        const coverDataUrl = input.coverDataUrl?.trim() ?? null;
        if (coverDataUrl && !coverDataUrl.startsWith("data:image/")) {
          throw new Error("Replacement cover must be a valid data URL");
        }
        patch.cover_path = coverDataUrl;
      }

      await repository.patchBook(input.bookId, patch);
      this.emit();
    });
  }

  async restoreOriginalBook(bookId: string): Promise<void> {
    await this.withEnqueueLock(async () => {
      const repository = await this.repositoryPromise;
      const book = await repository.getBook(bookId);
      if (!book) {
        throw new Error(`Cannot restore unknown book ${bookId}`);
      }
      if (this.hasPendingOrActiveTask(bookId)) {
        throw new Error("Book is currently processing and cannot be restored");
      }
      const canRestore =
        book.processing_status === "failed" || book.processing_status === "completed";
      if (!canRestore) {
        throw new Error("Book is currently processing and cannot be restored");
      }

      const now = Date.now();
      const attempt = await repository.nextImportAttempt(bookId);
      const job: ImportJobRow = {
        book_id: bookId,
        attempt,
        status: "queued",
        error: null,
        started_at: now,
        finished_at: null,
      };
      await repository.insertImportJob(job);
      // Keep prior soft warnings until a successful restore replaces them.
      await repository.patchBook(bookId, {
        processing_status: "queued",
        processing_error: null,
        updated_at: now,
      });
      this.emit();

      const source = await this.rawStore.load(bookId);
      if (!source) {
        const failure = new ImportFailure(
          "Corrupted/Unreadable book",
          "Corrupted/Unreadable book: no stored source file available for restore"
        );
        await this.failImport(
          repository,
          bookId,
          attempt,
          failure,
          { fileName: book.title, purge: false }
        );
        throw new Error(formatFailure(failure));
      }

      this.queue.push({
        bookId,
        attempt,
        source: {
          fileName: source.fileName,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
        },
        clearProgressOnSuccess: true,
        // Keep prior content until replace succeeds so a hard-fail cannot wipe the book.
        clearExistingContentBeforeParse: false,
        purgeOnHardFailure: false,
      });
      this.emit();
      void this.runQueue();

      const terminalStatus = await this.waitForAttemptTerminalStatus(bookId, attempt);
      if (terminalStatus === "failed") {
        const outcome = this.terminalOutcomes.get(bookId);
        const details = outcome?.error ?? "Restore failed";
        throw new Error(details);
      }
    });
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.withEnqueueLock(async () => {
      // Allow delete during processing: cancel the active/queued import, then remove rows.
      this.cancelledBookIds.add(bookId);
      if (this.activeBookId === bookId) {
        this.activeAbortController?.abort();
      }

      const removedTasks: ImportTask[] = [];
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        if (this.queue[index]?.bookId !== bookId) continue;
        const [removedTask] = this.queue.splice(index, 1);
        if (removedTask) {
          removedTasks.push(removedTask);
          this.releaseInlineSource(removedTask);
        }
      }

      const repository = await this.repositoryPromise;
      await repository.deleteBook(bookId);
      await Promise.all(removedTasks.map((task) => task.persistSource?.then(() => undefined)));
      await this.rawStore.remove(bookId);
      clearBookTokenCache(bookId);
      await clearBookImageSrcCache(bookId);
      await removeBookReferences(bookId, { repository });
      await updateLibraryLayout(
        (layout) => removeBookFromLibraryLayout(layout, bookId),
        { repository }
      );
      await this.removeDeletedBookTtsRules(repository, bookId);
      this.emit();
    });
  }

  async listImportSnapshot(): Promise<ImportSnapshotRow[]> {
    const repository = await this.repositoryPromise;
    const books = await repository.listBooks();
    const bookIds = new Set(books.map((book) => book.id));
    const rows: ImportSnapshotRow[] = books.map((book) => ({
      bookId: book.id,
      status: book.processing_status,
      error: book.processing_error,
      warnings: book.processing_warnings,
    }));

    for (const [bookId, outcome] of this.terminalOutcomes) {
      if (bookIds.has(bookId)) continue;
      rows.push({
        bookId,
        status: outcome.status,
        error: outcome.error,
        warnings: outcome.warnings,
      });
    }
    return rows;
  }

  private async runQueue(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emit();
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) break;
        if (this.cancelledBookIds.has(task.bookId)) {
          this.releaseInlineSource(task);
          this.cancelledBookIds.delete(task.bookId);
          continue;
        }
        const repository = await this.repositoryPromise;
        this.activeBookId = task.bookId;
        this.activeAbortController = new AbortController();
        try {
          await this.executeTask(repository, task, this.activeAbortController.signal);
        } finally {
          this.releaseInlineSource(task);
          if (this.activeBookId === task.bookId) {
            this.activeBookId = null;
          }
          this.activeAbortController = null;
          this.cancelledBookIds.delete(task.bookId);
        }
      }
    } finally {
      this.activeBookId = null;
      this.activeAbortController = null;
      this.isRunning = false;
      this.emit();
    }
  }

  private canProcessInline(): boolean {
    return !this.isRunning && this.queue.length === 0;
  }

  private reserveInlineSource(sizeBytes: number, mode: ImportOptions["inlineSourceMode"]): number | null {
    if (mode === "idle") {
      if (!this.canProcessInline()) return null;
      this.inlineBatchBytes += sizeBytes;
      this.inlineBatchTasks += 1;
      return sizeBytes;
    }

    if (this.inlineBatchTasks >= INLINE_BATCH_MAX_TASKS) return null;
    if (this.inlineBatchBytes + sizeBytes > INLINE_BATCH_MAX_BYTES) return null;

    this.inlineBatchBytes += sizeBytes;
    this.inlineBatchTasks += 1;
    return sizeBytes;
  }

  private releaseInlineSource(task: ImportTask): void {
    if (task.inlineReservationBytes === undefined) return;
    this.inlineBatchBytes = Math.max(0, this.inlineBatchBytes - task.inlineReservationBytes);
    this.inlineBatchTasks = Math.max(0, this.inlineBatchTasks - 1);
    task.inlineReservationBytes = undefined;
  }

  private persistRawSource(source: RawBookRecord): Promise<RawSourcePersistResult> {
    return Promise.resolve()
      .then(() => this.rawStore.store(source))
      .then(
        () => ({ status: "stored" as const }),
        (error: unknown) => ({ status: "failed" as const, error })
      );
  }

  private async removeDeletedBookTtsRules(
    repository: Pick<BookRepository, "getAppSetting" | "putAppSetting">,
    bookId: string
  ): Promise<void> {
    const saved = await repository.getAppSetting<unknown>(TTS_REGEX_SETTINGS_KEY);
    const { store, changed } = removeBookRulesFromStore(saved, bookId);
    if (!changed) return;
    await repository.putAppSetting(TTS_REGEX_SETTINGS_KEY, store);
  }

  private async executeTask(
    repository: BookRepository,
    task: ImportTask,
    cancelSignal?: AbortSignal
  ): Promise<void> {
    const {
      bookId,
      attempt,
      source,
      clearProgressOnSuccess,
      clearExistingContentBeforeParse,
      purgeOnHardFailure,
    } = task;
    const ensureNotCancelled = async () => {
      if (this.cancelledBookIds.has(bookId) || cancelSignal?.aborted) {
        throw new ImportCancelledError();
      }
      if (!(await repository.getBook(bookId))) {
        throw new ImportCancelledError();
      }
    };
    const markStatus = async (
      status: ProcessingStatus,
      patch?: {
        error?: string | null;
        finishedAt?: number | null;
      }
    ) => {
      await ensureNotCancelled();
      await repository.setBookAndImportStatus(bookId, attempt, status, {
        processing_error: patch?.error ?? null,
        updated_at: Date.now(),
        finished_at: patch?.finishedAt ?? null,
      });
      this.emit();
    };

    try {
      await markStatus("validating");
      const validationFailure = validateSource(source);
      if (validationFailure) {
        throw validationFailure;
      }

      const storedSource = await this.loadTaskSource(task);

      if (clearExistingContentBeforeParse) {
        await ensureNotCancelled();
        await repository.clearBookContent(bookId);
      }

      const parsed = await withTimeout(
        (signal) =>
          parseBookBytes({
            sourceBytes: storedSource.bytes,
            sourceName: storedSource.fileName,
            signal,
            onPhaseChange: async (phase) => {
              if (signal.aborted) return;
              await markStatus(phase);
            },
          }),
        IMPORT_TIMEOUT_MS,
        cancelSignal
      );

      await ensureNotCancelled();
      await this.ensureTaskSourcePersisted(task);

      if (storedSource.sizeBytes !== source.sizeBytes || storedSource.fileName !== source.fileName) {
        // Keep metadata stable when the persisted source changed between queue and execution.
        await ensureNotCancelled();
        await repository.patchBook(bookId, {
          source_uri: `indexeddb://raw_books/${bookId}/${encodeURIComponent(storedSource.fileName)}`,
          size_bytes: storedSource.sizeBytes,
          updated_at: Date.now(),
        });
      }

      if (parsed.book.paragraphs.length === 0) {
        throw new ImportFailure(
          "Corrupted/Unreadable book",
          "Corrupted/Unreadable book: no readable paragraphs extracted"
        );
      }
      if (!hasSequentialParagraphIds(parsed.book.paragraphs)) {
        throw new ImportFailure(
          "Corrupted/Unreadable book",
          "Corrupted/Unreadable book: paragraph ids are not sequential"
        );
      }

      const classification = classifyImportDiagnostics(parsed.book.diagnostics);
      if (classification.hardFailure) {
        throw new ImportFailure(
          "Book content not reliable",
          `Book content not reliable: ${classification.hardFailure.message}`
        );
      }

      const chunkRows = chunkParagraphs(bookId, parsed.book.paragraphs);
      const chapterRows = normalizeChapters(
        bookId,
        parsed.book.chapters.map((chapter) => ({
          title: chapter.title,
          start_paragraph_id: chapter.startParagraphId,
          kind: chapter.kind,
          level: chapter.level,
        }))
      );
      await ensureNotCancelled();
      const { rows: imageRows, droppedCount: droppedImageCount } = toBookImageRows(
        bookId,
        parsed.book.images,
        parsed.book.format,
        parsed.book.paragraphs.length
      );
      const totalWords = parsed.book.totals.words > 0
        ? parsed.book.totals.words
        : computeTotalWords(parsed.book.paragraphs);
      await ensureNotCancelled();
      const rawCoverSrc = parsed.book.cover?.src ?? null;
      const coverDataUrl = parsed.book.format === "epub"
        ? (isOversizedInlineCover(rawCoverSrc)
          ? null
          : await epubCoverDataUrl(storedSource.bytes, rawCoverSrc))
        : await createPdfCoverDataUrl(storedSource.bytes);
      await ensureNotCancelled();
      let processingWarnings = classification.warnings.length > 0 ? [...classification.warnings] : [];
      if (droppedImageCount > 0) {
        processingWarnings = ensureImagesMissingWarning(processingWarnings);
      }
      if (
        isOversizedInlineCover(rawCoverSrc)
        && !processingWarnings.some((warning) => warning.code === "cover_missing")
      ) {
        processingWarnings.push({ code: "cover_missing", message: "No cover image was found." });
      }
      const warningsToStore = processingWarnings.length > 0 ? processingWarnings : null;
      // Replace content before metadata so a late failure cannot leave a new
      // cover/title/warnings on the previous body (Restore keep-prior path).
      await ensureNotCancelled();
      await repository.replaceBookContent(bookId, {
        chunks: chunkRows,
        chapters: chapterRows,
        images: imageRows,
        total_chunks: chunkRows.length,
        total_paragraphs: parsed.book.paragraphs.length,
        total_words: totalWords,
      });
      clearBookTokenCache(bookId);
      await ensureNotCancelled();
      await repository.patchBook(bookId, {
        title: parsed.book.metadata.title || fileNameToTitle(storedSource.fileName),
        author: parsed.book.metadata.authors.join(", ") || null,
        cover_path: coverDataUrl,
        language: parsed.book.metadata.language ?? null,
        size_bytes: storedSource.sizeBytes,
        processing_warnings: warningsToStore,
        updated_at: Date.now(),
      });
      if (clearProgressOnSuccess) {
        await ensureNotCancelled();
        await repository.deleteReadingProgress(bookId);
      }

      await markStatus("completed", { finishedAt: Date.now(), error: null });
      this.terminalOutcomes.set(bookId, {
        status: "completed",
        attempt,
        error: null,
        warnings: warningsToStore,
        fileName: storedSource.fileName,
      });
    } catch (unknownError) {
      if (
        unknownError instanceof ImportCancelledError ||
        this.cancelledBookIds.has(bookId) ||
        !(await repository.getBook(bookId))
      ) {
        return;
      }
      const failure = await this.resolveTaskFailure(task, unknownError);
      await this.failImport(repository, bookId, attempt, failure, {
        fileName: task.source.fileName,
        purge: purgeOnHardFailure,
      });
    }
  }

  private async loadTaskSource(task: ImportTask): Promise<RawBookRecord> {
    if (task.inlineSource) {
      return task.inlineSource;
    }

    const storedSource = await this.rawStore.load(task.bookId);
    if (!storedSource) {
      throw new ImportFailure(
        "Corrupted/Unreadable book",
        "Corrupted/Unreadable book: no stored source file available for processing"
      );
    }
    return storedSource;
  }

  private formatPersistSourceFailure(error: unknown): ImportFailure {
    const message = error instanceof Error ? error.message : String(error);
    return new ImportFailure(
      "Corrupted/Unreadable book",
      `Corrupted/Unreadable book: failed to persist source file for retry (${message})`
    );
  }

  private async getPersistSourceFailure(task: ImportTask): Promise<ImportFailure | null> {
    if (!task.persistSource) return null;
    const result = await task.persistSource;
    if (result.status === "stored") return null;
    return this.formatPersistSourceFailure(result.error);
  }

  private async ensureTaskSourcePersisted(task: ImportTask): Promise<void> {
    const persistenceFailure = await this.getPersistSourceFailure(task);
    if (persistenceFailure) {
      throw persistenceFailure;
    }
  }

  private async resolveTaskFailure(task: ImportTask, error: unknown): Promise<ImportFailure> {
    return (await this.getPersistSourceFailure(task)) ?? classifyError(error);
  }

  private async failImport(
    repository: BookRepository,
    bookId: string,
    attempt: number,
    failure: ImportFailure,
    options?: { fileName?: string; purge?: boolean }
  ): Promise<void> {
    const message = formatFailure(failure);
    const purge = options?.purge !== false;
    const book = await repository.getBook(bookId);
    const resolvedFileName = options?.fileName
      ?? (() => {
        const encoded = book?.source_uri.split("/").pop();
        if (!encoded) return book?.title ?? "Unknown file";
        try {
          return decodeURIComponent(encoded);
        } catch {
          return encoded;
        }
      })();

    this.terminalOutcomes.set(bookId, {
      status: "failed",
      attempt,
      error: message,
      warnings: null,
      fileName: resolvedFileName,
    });

    if (!book) {
      this.emit();
      return;
    }

    if (purge) {
      await repository.setBookAndImportStatus(bookId, attempt, "failed", {
        processing_error: message,
        updated_at: Date.now(),
        finished_at: Date.now(),
      });
      this.emit();
      try {
        await this.deleteBook(bookId);
      } catch (error) {
        // The failed outcome is already terminal. Cleanup must not reject the
        // active task and strand every later item in the import queue.
        console.warn(`Could not fully purge failed import ${bookId}:`, error);
      }
      return;
    }

    // Restore hard-fail: keep the existing library book, prior content, and warnings.
    await repository.patchImportJob(bookId, attempt, {
      status: "failed",
      error: message,
      finished_at: Date.now(),
    });
    await repository.patchBook(bookId, {
      processing_status: "completed",
      processing_error: null,
      updated_at: Date.now(),
    });
    this.emit();
  }

  /** Clears Last-import outcomes for purged hard-fails. Call at the start of each import batch. */
  clearTerminalOutcomes(): void {
    this.terminalOutcomes.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.warn("Import subscriber failed:", error);
      }
    }
  }

  private hasPendingOrActiveTask(bookId: string): boolean {
    if (this.activeBookId === bookId) return true;
    return this.queue.some((task) => task.bookId === bookId);
  }

  private async waitForAttemptTerminalStatus(
    bookId: string,
    attempt: number,
    timeoutMs = IMPORT_TIMEOUT_MS + 120_000
  ): Promise<ProcessingStatus> {
    const start = Date.now();
    let delayMs = 120;
    while (Date.now() - start < timeoutMs) {
      const outcome = this.terminalOutcomes.get(bookId);
      if (outcome?.attempt === attempt) {
        return outcome.status;
      }
      const repository = await this.repositoryPromise;
      const job = (await repository.listImportJobs(bookId)).find((entry) => entry.attempt === attempt);
      if (job?.status === "completed" || job?.status === "failed") {
        return job.status;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(1600, Math.round(delayMs * 1.5));
    }
    throw new Error("Restore timed out");
  }

  private withEnqueueLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.enqueueLock.then(work);
    this.enqueueLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

let singletonService: BookImportService | null = null;

export function getBookImportService(): BookImportService {
  if (!singletonService) {
    singletonService = new BookImportService();
  }
  return singletonService;
}
