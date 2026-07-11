import type {
  AppSettingRow,
  BookContentReplacement,
  BookPatch,
  BookRow,
  ImportJobPatch,
  ImportJobRow,
  ProcessingStatus,
  ReadableBookBundle,
  ReadingProgressRow,
  StorageSnapshot,
  StoredBookAggregate,
} from "@/types/storage";

export type ListBooksOptions = {
  statuses?: ProcessingStatus[];
};

export interface BookRepository {
  init(): Promise<void>;
  close(): Promise<void>;

  listBooks(options?: ListBooksOptions): Promise<BookRow[]>;
  getBook(bookId: string): Promise<BookRow | null>;
  upsertBook(book: BookRow): Promise<void>;
  patchBook(bookId: string, patch: BookPatch): Promise<BookRow>;
  setBookStatus(
    bookId: string,
    status: ProcessingStatus,
    patch?: Pick<BookRow, "processing_error" | "updated_at">
  ): Promise<BookRow>;
  setBookAndImportStatus(
    bookId: string,
    attempt: number,
    status: ProcessingStatus,
    patch?: {
      processing_error?: string | null;
      updated_at?: number;
      finished_at?: number | null;
    }
  ): Promise<void>;
  deleteBook(bookId: string): Promise<void>;
  /** Deletes all library books and their book-specific data, preserving app preferences. */
  clearAllBooks(): Promise<void>;

  replaceBookContent(bookId: string, replacement: BookContentReplacement): Promise<BookRow>;
  clearBookContent(bookId: string): Promise<void>;
  getBookAggregate(bookId: string): Promise<StoredBookAggregate | null>;
  getReadableBook(bookId: string): Promise<ReadableBookBundle | null>;

  saveReadingProgress(progress: ReadingProgressRow): Promise<void>;
  getReadingProgress(bookId: string): Promise<ReadingProgressRow | null>;
  deleteReadingProgress(bookId: string): Promise<void>;

  putAppSetting(key: string, value: unknown): Promise<void>;
  getAppSetting<T>(key: string): Promise<T | null>;
  listAppSettings(): Promise<AppSettingRow[]>;

  insertImportJob(job: ImportJobRow): Promise<void>;
  patchImportJob(
    bookId: string,
    attempt: number,
    patch: ImportJobPatch
  ): Promise<void>;
  listImportJobs(bookId: string): Promise<ImportJobRow[]>;
  nextImportAttempt(bookId: string): Promise<number>;

  exportSnapshot(): Promise<StorageSnapshot>;
  importSnapshot(snapshot: StorageSnapshot): Promise<void>;
}
