import type {
  AppSettingRow,
  BookChapterRow,
  BookChunkRow,
  BookContentReplacement,
  BookRow,
  ImportJobRow,
  ProcessingStatus,
  ReadableBookBundle,
  ReadingProgressRow,
  StorageSnapshot,
  StoredBookAggregate,
  StoredChapter,
  StoredParagraph,
} from "@/types/storage";
import type { Book, Chapter, Paragraph } from "@/types/book";
import type { BookRepository, ListBooksOptions } from "@/lib/storage/bookRepository";

const STORAGE_VERSION = 1;
const PERSIST_DB_NAME = "universal_speed_reader_state";
const PERSIST_STORE_NAME = "snapshot_store";

type PersistedEnvelope = {
  version: number;
  data: StorageSnapshot;
};

const EMPTY_SNAPSHOT: StorageSnapshot = {
  books: [],
  book_chunks: [],
  book_chapters: [],
  reading_progress: [],
  app_settings: [],
  import_jobs: [],
};

export type InMemoryRepositoryOptions = {
  persistKey?: string;
};

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortByNumberAsc<T>(items: T[], read: (item: T) => number): T[] {
  return [...items].sort((a, b) => read(a) - read(b));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStorageSnapshot(value: unknown): value is StorageSnapshot {
  if (!isObject(value)) return false;
  return (
    Array.isArray(value.books) &&
    Array.isArray(value.book_chunks) &&
    Array.isArray(value.book_chapters) &&
    Array.isArray(value.reading_progress) &&
    Array.isArray(value.app_settings) &&
    Array.isArray(value.import_jobs)
  );
}

function isBrowserLocalStorageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function toParagraphs(rows: StoredParagraph[]): Paragraph[] {
  return rows.map((p) => ({
    id: p.id,
    text: p.text,
  }));
}

function toChapters(rows: StoredChapter[]): Chapter[] {
  return rows.map((c) => ({
    index: c.index,
    title: c.title,
    startParagraphId: c.start_paragraph_id,
  }));
}

export class InMemoryBookRepository implements BookRepository {
  private readonly persistKey?: string;
  private initialized = false;
  private state: StorageSnapshot = clone(EMPTY_SNAPSHOT);
  private queue: Promise<void> = Promise.resolve();
  private persistDbPromise: Promise<IDBDatabase> | null = null;

  constructor(options?: InMemoryRepositoryOptions) {
    this.persistKey = options?.persistKey;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.loadFromPersistence();
  }

  async close(): Promise<void> {
    await this.persist();
  }

  async listBooks(options?: ListBooksOptions): Promise<BookRow[]> {
    return this.withLock(async () => {
      const statuses = options?.statuses;
      const filtered =
        statuses && statuses.length > 0
          ? this.state.books.filter((book) => statuses.includes(book.processing_status))
          : this.state.books;
      return clone(sortByNumberAsc(filtered, (book) => -book.created_at));
    });
  }

  async getBook(bookId: string): Promise<BookRow | null> {
    return this.withLock(async () => {
      const book = this.state.books.find((entry) => entry.id === bookId) ?? null;
      return book ? clone(book) : null;
    });
  }

  async upsertBook(book: BookRow): Promise<void> {
    await this.withLock(async () => {
      const index = this.state.books.findIndex((entry) => entry.id === book.id);
      if (index === -1) {
        this.state.books.push(clone(book));
      } else {
        this.state.books[index] = clone(book);
      }
      await this.persist();
    });
  }

  async patchBook(bookId: string, patch: Partial<BookRow>): Promise<BookRow> {
    return this.withLock(async () => {
      const index = this.state.books.findIndex((entry) => entry.id === bookId);
      if (index === -1) {
        throw new Error(`Book ${bookId} not found`);
      }
      const updated: BookRow = {
        ...this.state.books[index],
        ...patch,
      };
      this.state.books[index] = updated;
      await this.persist();
      return clone(updated);
    });
  }

  async setBookStatus(
    bookId: string,
    status: ProcessingStatus,
    patch?: Pick<BookRow, "processing_error" | "updated_at">
  ): Promise<BookRow> {
    const updatedAt = patch?.updated_at ?? Date.now();
    return this.patchBook(bookId, {
      processing_status: status,
      processing_error: patch?.processing_error ?? null,
      updated_at: updatedAt,
    });
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.withLock(async () => {
      this.state.books = this.state.books.filter((book) => book.id !== bookId);
      this.state.book_chunks = this.state.book_chunks.filter((chunk) => chunk.book_id !== bookId);
      this.state.book_chapters = this.state.book_chapters.filter(
        (chapter) => chapter.book_id !== bookId
      );
      this.state.reading_progress = this.state.reading_progress.filter(
        (progress) => progress.book_id !== bookId
      );
      this.state.import_jobs = this.state.import_jobs.filter((job) => job.book_id !== bookId);
      await this.persist();
    });
  }

  async replaceBookContent(bookId: string, replacement: BookContentReplacement): Promise<BookRow> {
    return this.withLock(async () => {
      const index = this.state.books.findIndex((entry) => entry.id === bookId);
      if (index === -1) {
        throw new Error(`Book ${bookId} not found`);
      }

      const normalizedChunks: BookChunkRow[] = sortByNumberAsc(
        replacement.chunks
          .filter((chunk) => chunk.book_id === bookId)
          .map((chunk, chunkIndex) => ({
            book_id: chunk.book_id,
            chunk_index: chunkIndex,
            paragraphs_json: chunk.paragraphs_json.map((paragraph) => ({
              id: paragraph.id,
              text: paragraph.text,
            })),
          })),
        (chunk) => chunk.chunk_index
      );

      const normalizedChapters: BookChapterRow[] = sortByNumberAsc(
        replacement.chapters
          .filter((chapter) => chapter.book_id === bookId)
          .map((chapter, chapterIndex) => ({
            book_id: chapter.book_id,
            chapter_index: chapterIndex,
            title: chapter.title,
            start_paragraph_id: chapter.start_paragraph_id,
          })),
        (chapter) => chapter.chapter_index
      );

      this.state.book_chunks = this.state.book_chunks.filter((chunk) => chunk.book_id !== bookId);
      this.state.book_chapters = this.state.book_chapters.filter(
        (chapter) => chapter.book_id !== bookId
      );
      this.state.book_chunks.push(...normalizedChunks);
      this.state.book_chapters.push(...normalizedChapters);

      const current = this.state.books[index];
      const updated: BookRow = {
        ...current,
        total_chunks: replacement.total_chunks,
        total_paragraphs: replacement.total_paragraphs,
        total_words: replacement.total_words,
        updated_at: Date.now(),
      };
      this.state.books[index] = updated;
      await this.persist();
      return clone(updated);
    });
  }

  async clearBookContent(bookId: string): Promise<void> {
    await this.withLock(async () => {
      this.state.book_chunks = this.state.book_chunks.filter((chunk) => chunk.book_id !== bookId);
      this.state.book_chapters = this.state.book_chapters.filter(
        (chapter) => chapter.book_id !== bookId
      );
      const index = this.state.books.findIndex((book) => book.id === bookId);
      if (index !== -1) {
        this.state.books[index] = {
          ...this.state.books[index],
          total_chunks: 0,
          total_paragraphs: 0,
          total_words: 0,
          updated_at: Date.now(),
        };
      }
      await this.persist();
    });
  }

  async getBookAggregate(bookId: string): Promise<StoredBookAggregate | null> {
    return this.withLock(async () => {
      const book = this.state.books.find((entry) => entry.id === bookId);
      if (!book) return null;

      const chapters = sortByNumberAsc(
        this.state.book_chapters.filter((entry) => entry.book_id === bookId),
        (entry) => entry.chapter_index
      );
      const chunks = sortByNumberAsc(
        this.state.book_chunks.filter((entry) => entry.book_id === bookId),
        (entry) => entry.chunk_index
      );

      return clone({
        book,
        chapters,
        chunks,
      });
    });
  }

  async getReadableBook(bookId: string): Promise<ReadableBookBundle | null> {
    return this.withLock(async () => {
      const book = this.state.books.find((entry) => entry.id === bookId);
      if (!book) return null;
      if (book.processing_status !== "completed") return null;

      const chunks = sortByNumberAsc(
        this.state.book_chunks.filter((entry) => entry.book_id === bookId),
        (entry) => entry.chunk_index
      );
      const chaptersRows = sortByNumberAsc(
        this.state.book_chapters.filter((entry) => entry.book_id === bookId),
        (entry) => entry.chapter_index
      );

      const allParagraphs = chunks
        .flatMap((chunk) => chunk.paragraphs_json)
        .map((paragraph) => ({
          id: paragraph.id,
          text: paragraph.text,
        }));

      const chapters = toChapters(
        chaptersRows.map((chapter) => ({
          index: chapter.chapter_index,
          title: chapter.title,
          start_paragraph_id: chapter.start_paragraph_id,
        }))
      );

      const readableBook: Book = {
        id: book.id,
        title: book.title,
        author: book.author ?? undefined,
        coverUrl: book.cover_path ?? undefined,
        paragraphs: toParagraphs(allParagraphs),
        chapters,
        totalWords: book.total_words,
      };

      return clone({
        metadata: book,
        book: readableBook,
      });
    });
  }

  async saveReadingProgress(progress: ReadingProgressRow): Promise<void> {
    await this.withLock(async () => {
      const index = this.state.reading_progress.findIndex(
        (entry) => entry.book_id === progress.book_id
      );
      if (index === -1) {
        this.state.reading_progress.push(clone(progress));
      } else {
        this.state.reading_progress[index] = clone(progress);
      }
      await this.persist();
    });
  }

  async getReadingProgress(bookId: string): Promise<ReadingProgressRow | null> {
    return this.withLock(async () => {
      const progress = this.state.reading_progress.find((entry) => entry.book_id === bookId) ?? null;
      return progress ? clone(progress) : null;
    });
  }

  async putAppSetting(key: string, value: unknown): Promise<void> {
    await this.withLock(async () => {
      const index = this.state.app_settings.findIndex((entry) => entry.key === key);
      const row: AppSettingRow = {
        key,
        value_json: clone(value),
      };
      if (index === -1) {
        this.state.app_settings.push(row);
      } else {
        this.state.app_settings[index] = row;
      }
      await this.persist();
    });
  }

  async getAppSetting<T>(key: string): Promise<T | null> {
    return this.withLock(async () => {
      const row = this.state.app_settings.find((entry) => entry.key === key);
      if (!row) return null;
      return clone(row.value_json) as T;
    });
  }

  async listAppSettings(): Promise<AppSettingRow[]> {
    return this.withLock(async () => clone(this.state.app_settings));
  }

  async insertImportJob(job: ImportJobRow): Promise<void> {
    await this.withLock(async () => {
      this.state.import_jobs = this.state.import_jobs.filter(
        (entry) => !(entry.book_id === job.book_id && entry.attempt === job.attempt)
      );
      this.state.import_jobs.push(clone(job));
      await this.persist();
    });
  }

  async patchImportJob(
    bookId: string,
    attempt: number,
    patch: Partial<Pick<ImportJobRow, "status" | "error" | "finished_at">>
  ): Promise<void> {
    await this.withLock(async () => {
      const index = this.state.import_jobs.findIndex(
        (entry) => entry.book_id === bookId && entry.attempt === attempt
      );
      if (index === -1) {
        throw new Error(`Import job ${bookId}/${attempt} not found`);
      }
      this.state.import_jobs[index] = {
        ...this.state.import_jobs[index],
        ...patch,
      };
      await this.persist();
    });
  }

  async listImportJobs(bookId: string): Promise<ImportJobRow[]> {
    return this.withLock(async () =>
      clone(
        sortByNumberAsc(
          this.state.import_jobs.filter((entry) => entry.book_id === bookId),
          (entry) => entry.attempt
        )
      )
    );
  }

  async nextImportAttempt(bookId: string): Promise<number> {
    return this.withLock(async () => {
      const jobs = this.state.import_jobs.filter((entry) => entry.book_id === bookId);
      if (jobs.length === 0) return 1;
      const max = Math.max(...jobs.map((entry) => entry.attempt));
      return max + 1;
    });
  }

  async exportSnapshot(): Promise<StorageSnapshot> {
    return this.withLock(async () => clone(this.state));
  }

  async importSnapshot(snapshot: StorageSnapshot): Promise<void> {
    await this.withLock(async () => {
      this.state = clone(snapshot);
      await this.persist();
    });
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async loadFromPersistence(): Promise<void> {
    const persistKey = this.persistKey;
    if (!persistKey) return;
    if (isIndexedDbAvailable()) {
      try {
        const db = await this.getPersistDb();
        const raw = await new Promise<unknown>((resolve, reject) => {
          const tx = db.transaction(PERSIST_STORE_NAME, "readonly");
          const store = tx.objectStore(PERSIST_STORE_NAME);
          const request = store.get(persistKey);
          request.onerror = () => reject(request.error ?? new Error("Failed to read persisted snapshot"));
          request.onsuccess = () => resolve(request.result);
        });

        if (isObject(raw) && "version" in raw && "data" in raw) {
          const parsed = raw as PersistedEnvelope;
          if (parsed.version === STORAGE_VERSION && isStorageSnapshot(parsed.data)) {
            this.state = clone(parsed.data);
            return;
          }
        }
      } catch (error) {
        console.warn("Failed to load snapshot from IndexedDB:", error);
      }
    }

    if (!isBrowserLocalStorageAvailable()) return;
    try {
      const raw = window.localStorage.getItem(persistKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedEnvelope;
      if (!isObject(parsed) || parsed.version !== STORAGE_VERSION) return;
      if (!isStorageSnapshot(parsed.data)) return;
      this.state = clone(parsed.data);
    } catch (error) {
      console.warn("Failed to load snapshot from localStorage:", error);
      this.state = clone(EMPTY_SNAPSHOT);
    }
  }

  private async persist(): Promise<void> {
    const persistKey = this.persistKey;
    if (!persistKey) return;
    const envelope: PersistedEnvelope = {
      version: STORAGE_VERSION,
      data: this.state,
    };

    if (isIndexedDbAvailable()) {
      try {
        const db = await this.getPersistDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(PERSIST_STORE_NAME, "readwrite");
          const store = tx.objectStore(PERSIST_STORE_NAME);
          const request = store.put({
            key: persistKey,
            ...envelope,
          });
          request.onerror = () => reject(request.error ?? new Error("Failed to persist snapshot"));
          request.onsuccess = () => resolve();
        });
        return;
      } catch (error) {
        console.warn("Failed to persist snapshot to IndexedDB:", error);
      }
    }

    if (!isBrowserLocalStorageAvailable()) return;
    try {
      window.localStorage.setItem(persistKey, JSON.stringify(envelope));
    } catch (error) {
      console.warn("Failed to persist snapshot to localStorage:", error);
    }
  }

  private async getPersistDb(): Promise<IDBDatabase> {
    if (!this.persistDbPromise) {
      this.persistDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(PERSIST_DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(PERSIST_STORE_NAME)) {
            db.createObjectStore(PERSIST_STORE_NAME, { keyPath: "key" });
          }
        };
        request.onerror = () => reject(request.error ?? new Error("Failed to open persistence database"));
        request.onsuccess = () => resolve(request.result);
      });
    }
    return this.persistDbPromise;
  }
}
