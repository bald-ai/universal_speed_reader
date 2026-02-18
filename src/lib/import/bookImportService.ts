import { parseEpubBytes } from "@/lib/epub/epubParser";
import { getBookRepository } from "@/lib/storage/appRepository";
import type { BookRepository } from "@/lib/storage/bookRepository";
import { deleteRawEpub, loadRawEpub, storeRawEpub, type RawEpubRecord } from "@/lib/import/rawEpubStore";
import {
  chunkParagraphs,
  computeTotalWords,
  hasSequentialParagraphIds,
  normalizeChapters,
} from "@/lib/import/normalization";
import type {
  BookRow,
  ImportErrorBucket,
  ImportJobRow,
  ProcessingStatus,
} from "@/types/storage";

const MAX_IMPORT_SIZE_BYTES = 150 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 180_000;
const MAX_TITLE_LENGTH = 160;
const MAX_AUTHOR_LENGTH = 160;

export type ImportPayload = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type ImportSnapshotRow = {
  bookId: string;
  status: ProcessingStatus;
  error: string | null;
};

export type UpdateBookMetadataInput = {
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
  const withoutExtension = fileName.replace(/\.epub$/i, "").trim();
  return withoutExtension.length > 0 ? withoutExtension : "Untitled";
}

function createBookId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new ImportFailure("Processing timeout", "Processing timeout: import exceeded 180 seconds"));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
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
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("timeout")) {
    return new ImportFailure("Processing timeout", message);
  }
  if (normalized.includes("unsupported format")) {
    return new ImportFailure("Unsupported format", message);
  }
  if (normalized.includes("too large")) {
    return new ImportFailure("File too large", message);
  }
  return new ImportFailure("Corrupted/Unreadable EPUB", message);
}

type ImportTask = {
  bookId: string;
  attempt: number;
  source: RawEpubRecord;
  clearProgressOnSuccess: boolean;
};

type RawStoreAdapter = {
  store: (record: RawEpubRecord) => Promise<void>;
  load: (bookId: string) => Promise<RawEpubRecord | null>;
  remove: (bookId: string) => Promise<void>;
};

export class BookImportService {
  private readonly listeners = new Set<() => void>();
  private readonly queue: ImportTask[] = [];
  private activeBookId: string | null = null;
  private isRunning = false;
  private readonly repositoryPromise: Promise<BookRepository>;
  private readonly rawStore: RawStoreAdapter;
  private enqueueLock: Promise<void> = Promise.resolve();

  constructor(repositoryPromise?: Promise<BookRepository>, rawStore?: RawStoreAdapter) {
    this.repositoryPromise = repositoryPromise ?? getBookRepository();
    this.rawStore = rawStore ?? {
      store: storeRawEpub,
      load: loadRawEpub,
      remove: deleteRawEpub,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async importFromFile(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return this.importFromBytes({
      fileName: file.name,
      mimeType: file.type || "application/epub+zip",
      bytes,
    });
  }

  async importFromBytes(payload: ImportPayload): Promise<string> {
    const repository = await this.repositoryPromise;
    const now = Date.now();
    const bookId = createBookId();

    const initialBook: BookRow = {
      id: bookId,
      title: fileNameToTitle(payload.fileName),
      author: null,
      cover_path: null,
      language: null,
      source_uri: `indexeddb://raw_epubs/${bookId}/${encodeURIComponent(payload.fileName)}`,
      size_bytes: payload.bytes.byteLength,
      processing_status: "queued",
      processing_error: null,
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

    const normalizedName = payload.fileName.toLowerCase();
    if (!normalizedName.endsWith(".epub")) {
      await this.failImport(
        repository,
        bookId,
        attempt,
        new ImportFailure("Unsupported format", "Unsupported format: only .epub files are allowed")
      );
      return bookId;
    }
    if (payload.bytes.byteLength > MAX_IMPORT_SIZE_BYTES) {
      await this.failImport(
        repository,
        bookId,
        attempt,
        new ImportFailure("File too large", "File too large: maximum size is 150 MB")
      );
      return bookId;
    }

    const source: RawEpubRecord = {
      bookId,
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      sizeBytes: payload.bytes.byteLength,
      bytes: payload.bytes,
      storedAt: now,
    };
    try {
      await this.rawStore.store(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failImport(
        repository,
        bookId,
        attempt,
        new ImportFailure(
          "Corrupted/Unreadable EPUB",
          `Corrupted/Unreadable EPUB: failed to persist source file for retry (${message})`
        )
      );
      return bookId;
    }

    this.queue.push({
      bookId,
      attempt,
      source,
      clearProgressOnSuccess: false,
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
      await repository.setBookStatus(bookId, "queued", {
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
            "Corrupted/Unreadable EPUB",
            "Corrupted/Unreadable EPUB: no stored source file available for retry"
          )
        );
        return;
      }

      this.queue.push({
        bookId,
        attempt,
        source,
        clearProgressOnSuccess: false,
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
      await repository.setBookStatus(bookId, "queued", {
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
            "Corrupted/Unreadable EPUB",
            "Corrupted/Unreadable EPUB: no stored source file available for restore"
          )
        );
        return;
      }

      this.queue.push({
        bookId,
        attempt,
        source,
        clearProgressOnSuccess: true,
      });
      this.emit();
      void this.runQueue();

      const terminalStatus = await this.waitForAttemptTerminalStatus(bookId, attempt);
      if (terminalStatus === "failed") {
        const latest = await repository.getBook(bookId);
        const details = latest?.processing_error ?? "Restore failed";
        throw new Error(details);
      }
    });
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.withEnqueueLock(async () => {
      if (this.activeBookId === bookId) {
        throw new Error("Book is currently processing and cannot be deleted");
      }

      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        if (this.queue[index]?.bookId === bookId) {
          this.queue.splice(index, 1);
        }
      }

      const repository = await this.repositoryPromise;
      await repository.deleteBook(bookId);
      await this.rawStore.remove(bookId);
      this.emit();
    });
  }

  async listImportSnapshot(): Promise<ImportSnapshotRow[]> {
    const repository = await this.repositoryPromise;
    const books = await repository.listBooks();
    return books.map((book) => ({
      bookId: book.id,
      status: book.processing_status,
      error: book.processing_error,
    }));
  }

  private async runQueue(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emit();
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) break;
        const repository = await this.repositoryPromise;
        this.activeBookId = task.bookId;
        try {
          await this.executeTask(repository, task);
        } finally {
          if (this.activeBookId === task.bookId) {
            this.activeBookId = null;
          }
        }
      }
    } finally {
      this.activeBookId = null;
      this.isRunning = false;
      this.emit();
    }
  }

  private async executeTask(repository: BookRepository, task: ImportTask): Promise<void> {
    const { bookId, attempt, source, clearProgressOnSuccess } = task;
    const markStatus = async (
      status: ProcessingStatus,
      patch?: {
        error?: string | null;
        finishedAt?: number | null;
      }
    ) => {
      const now = Date.now();
      await repository.setBookStatus(bookId, status, {
        processing_error: patch?.error ?? null,
        updated_at: now,
      });
      await repository.patchImportJob(bookId, attempt, {
        status,
        error: patch?.error ?? null,
        finished_at: patch?.finishedAt ?? null,
      });
      this.emit();
    };

    try {
      await markStatus("validating");
      if (source.sizeBytes > MAX_IMPORT_SIZE_BYTES) {
        throw new ImportFailure("File too large", "File too large: maximum size is 150 MB");
      }
      if (!source.fileName.toLowerCase().endsWith(".epub")) {
        throw new ImportFailure("Unsupported format", "Unsupported format: only .epub files are allowed");
      }

      await repository.clearBookContent(bookId);

      const parsed = await withTimeout(
        parseEpubBytes(source.bytes, {
          onPhaseChange: async (phase) => {
            await markStatus(phase);
          },
        }),
        IMPORT_TIMEOUT_MS
      );

      if (parsed.paragraphs.length === 0) {
        throw new ImportFailure(
          "Corrupted/Unreadable EPUB",
          "Corrupted/Unreadable EPUB: no readable paragraphs extracted"
        );
      }
      if (!hasSequentialParagraphIds(parsed.paragraphs)) {
        throw new ImportFailure(
          "Corrupted/Unreadable EPUB",
          "Corrupted/Unreadable EPUB: paragraph ids are not sequential"
        );
      }

      if (parsed.chapters.length === 0) {
        parsed.chapters = [{ title: "Full book", start_paragraph_id: 1 }];
      }

      const chunkRows = chunkParagraphs(bookId, parsed.paragraphs);
      const chapterRows = normalizeChapters(bookId, parsed.chapters);
      const totalWords = parsed.totalWords > 0 ? parsed.totalWords : computeTotalWords(parsed.paragraphs);
      await repository.patchBook(bookId, {
        title: parsed.title || fileNameToTitle(source.fileName),
        author: parsed.author,
        cover_path: parsed.coverPath,
        language: parsed.language,
        size_bytes: source.sizeBytes,
        updated_at: Date.now(),
      });
      await repository.replaceBookContent(bookId, {
        chunks: chunkRows,
        chapters: chapterRows,
        total_chunks: chunkRows.length,
        total_paragraphs: parsed.paragraphs.length,
        total_words: totalWords,
      });
      if (clearProgressOnSuccess) {
        await repository.deleteReadingProgress(bookId);
      }

      await markStatus("completed", { finishedAt: Date.now(), error: null });
    } catch (unknownError) {
      const failure = classifyError(unknownError);
      await this.failImport(repository, bookId, attempt, failure);
    }
  }

  private async failImport(
    repository: BookRepository,
    bookId: string,
    attempt: number,
    failure: ImportFailure
  ): Promise<void> {
    const message = formatFailure(failure);
    await repository.setBookStatus(bookId, "failed", {
      processing_error: message,
      updated_at: Date.now(),
    });
    await repository.patchImportJob(bookId, attempt, {
      status: "failed",
      error: message,
      finished_at: Date.now(),
    });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
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
    while (Date.now() - start < timeoutMs) {
      const repository = await this.repositoryPromise;
      const job = (await repository.listImportJobs(bookId)).find((entry) => entry.attempt === attempt);
      if (job?.status === "completed" || job?.status === "failed") {
        return job.status;
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
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
