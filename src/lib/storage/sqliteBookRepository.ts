import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
  type capSQLiteSet,
} from "@capacitor-community/sqlite";
import type { BookRepository, ListBooksOptions } from "@/lib/storage/bookRepository";
import type { Book, Chapter, Paragraph } from "@/types/book";
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
} from "@/types/storage";

const DB_NAME = "universal_speed_reader";
const DB_VERSION = 1;
const SCHEMA_V1_SQL = `
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    cover_path TEXT,
    language TEXT,
    source_uri TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    processing_status TEXT NOT NULL,
    processing_error TEXT,
    total_chunks INTEGER NOT NULL DEFAULT 0,
    total_paragraphs INTEGER NOT NULL DEFAULT 0,
    total_words INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS book_chunks (
    book_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    paragraphs_json TEXT NOT NULL,
    PRIMARY KEY (book_id, chunk_index),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS book_chapters (
    book_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    start_paragraph_id INTEGER NOT NULL,
    PRIMARY KEY (book_id, chapter_index),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reading_progress (
    book_id TEXT PRIMARY KEY NOT NULL,
    paragraph_id INTEGER NOT NULL,
    word_index INTEGER NOT NULL,
    mode TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS import_jobs (
    book_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    PRIMARY KEY (book_id, attempt),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );
`;

type SqlRow = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const next = String(value);
  return next.length > 0 ? next : null;
}

function parseParagraphsJson(raw: unknown): Paragraph[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ id: number; text: string }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => typeof entry?.id === "number" && typeof entry?.text === "string")
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
      }));
  } catch {
    return [];
  }
}

function toBookRow(row: SqlRow): BookRow {
  return {
    id: asString(row.id),
    title: asString(row.title),
    author: asNullableString(row.author),
    cover_path: asNullableString(row.cover_path),
    language: asNullableString(row.language),
    source_uri: asString(row.source_uri),
    size_bytes: asNumber(row.size_bytes),
    processing_status: asString(row.processing_status) as ProcessingStatus,
    processing_error: asNullableString(row.processing_error),
    total_chunks: asNumber(row.total_chunks),
    total_paragraphs: asNumber(row.total_paragraphs),
    total_words: asNumber(row.total_words),
    created_at: asNumber(row.created_at),
    updated_at: asNumber(row.updated_at),
  };
}

function toBookChunkRow(row: SqlRow): BookChunkRow {
  return {
    book_id: asString(row.book_id),
    chunk_index: asNumber(row.chunk_index),
    paragraphs_json: parseParagraphsJson(row.paragraphs_json),
  };
}

function toBookChapterRow(row: SqlRow): BookChapterRow {
  return {
    book_id: asString(row.book_id),
    chapter_index: asNumber(row.chapter_index),
    title: asString(row.title),
    start_paragraph_id: asNumber(row.start_paragraph_id),
  };
}

function toReadingProgressRow(row: SqlRow): ReadingProgressRow {
  return {
    book_id: asString(row.book_id),
    paragraph_id: asNumber(row.paragraph_id),
    word_index: asNumber(row.word_index),
    mode: asString(row.mode) as ReadingProgressRow["mode"],
    updated_at: asNumber(row.updated_at),
  };
}

function toAppSettingRow(row: SqlRow): AppSettingRow {
  let valueJson: unknown = null;
  if (typeof row.value_json === "string") {
    try {
      valueJson = JSON.parse(row.value_json);
    } catch {
      valueJson = null;
    }
  }
  return {
    key: asString(row.key),
    value_json: valueJson,
  };
}

function toImportJobRow(row: SqlRow): ImportJobRow {
  return {
    book_id: asString(row.book_id),
    attempt: asNumber(row.attempt),
    status: asString(row.status) as ProcessingStatus,
    error: asNullableString(row.error),
    started_at: asNumber(row.started_at),
    finished_at: row.finished_at === null || row.finished_at === undefined ? null : asNumber(row.finished_at),
  };
}

export class SqliteBookRepository implements BookRepository {
  private readonly sqlite = new SQLiteConnection(CapacitorSQLite);
  private db: SQLiteDBConnection | null = null;
  private initPromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.openAndPrepare();
    return this.initPromise;
  }

  async close(): Promise<void> {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    await db.close();
    await this.sqlite.closeConnection(DB_NAME, false);
  }

  async listBooks(options?: ListBooksOptions): Promise<BookRow[]> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const statuses = options?.statuses ?? [];
      if (statuses.length > 0) {
        const placeholders = statuses.map(() => "?").join(", ");
        const rows = await this.queryRows(
          db,
          `SELECT * FROM books WHERE processing_status IN (${placeholders}) ORDER BY created_at DESC`,
          statuses
        );
        return rows.map(toBookRow);
      }
      const rows = await this.queryRows(db, "SELECT * FROM books ORDER BY created_at DESC");
      return rows.map(toBookRow);
    });
  }

  async getBook(bookId: string): Promise<BookRow | null> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const rows = await this.queryRows(db, "SELECT * FROM books WHERE id = ? LIMIT 1", [bookId]);
      if (rows.length === 0) return null;
      return toBookRow(rows[0]);
    });
  }

  async upsertBook(book: BookRow): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.run(
        `
        INSERT INTO books (
          id, title, author, cover_path, language, source_uri, size_bytes,
          processing_status, processing_error, total_chunks, total_paragraphs,
          total_words, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,
          author=excluded.author,
          cover_path=excluded.cover_path,
          language=excluded.language,
          source_uri=excluded.source_uri,
          size_bytes=excluded.size_bytes,
          processing_status=excluded.processing_status,
          processing_error=excluded.processing_error,
          total_chunks=excluded.total_chunks,
          total_paragraphs=excluded.total_paragraphs,
          total_words=excluded.total_words,
          updated_at=excluded.updated_at
        `,
        [
          book.id,
          book.title,
          book.author,
          book.cover_path,
          book.language,
          book.source_uri,
          book.size_bytes,
          book.processing_status,
          book.processing_error,
          book.total_chunks,
          book.total_paragraphs,
          book.total_words,
          book.created_at,
          book.updated_at,
        ]
      );
    });
  }

  async patchBook(bookId: string, patch: Partial<BookRow>): Promise<BookRow> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const rows = await this.queryRows(db, "SELECT * FROM books WHERE id = ? LIMIT 1", [bookId]);
      if (rows.length === 0) {
        throw new Error(`Book ${bookId} not found`);
      }
      const existing = toBookRow(rows[0]);
      const merged: BookRow = { ...existing, ...patch };
      await db.run(
        `
        INSERT INTO books (
          id, title, author, cover_path, language, source_uri, size_bytes,
          processing_status, processing_error, total_chunks, total_paragraphs,
          total_words, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,
          author=excluded.author,
          cover_path=excluded.cover_path,
          language=excluded.language,
          source_uri=excluded.source_uri,
          size_bytes=excluded.size_bytes,
          processing_status=excluded.processing_status,
          processing_error=excluded.processing_error,
          total_chunks=excluded.total_chunks,
          total_paragraphs=excluded.total_paragraphs,
          total_words=excluded.total_words,
          updated_at=excluded.updated_at
        `,
        [
          merged.id,
          merged.title,
          merged.author,
          merged.cover_path,
          merged.language,
          merged.source_uri,
          merged.size_bytes,
          merged.processing_status,
          merged.processing_error,
          merged.total_chunks,
          merged.total_paragraphs,
          merged.total_words,
          merged.created_at,
          merged.updated_at,
        ]
      );
      return merged;
    });
  }

  async setBookStatus(
    bookId: string,
    status: ProcessingStatus,
    patch?: Pick<BookRow, "processing_error" | "updated_at">
  ): Promise<BookRow> {
    return this.patchBook(bookId, {
      processing_status: status,
      processing_error: patch?.processing_error ?? null,
      updated_at: patch?.updated_at ?? Date.now(),
    });
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.beginTransaction();
      try {
        await db.run("DELETE FROM books WHERE id = ?", [bookId], false);
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction();
        throw error;
      }
    });
  }

  async replaceBookContent(bookId: string, replacement: BookContentReplacement): Promise<BookRow> {
    return this.withLock(async () => {
      const db = await this.getDb();
      await db.beginTransaction();
      try {
        await db.run("DELETE FROM book_chunks WHERE book_id = ?", [bookId], false);
        await db.run("DELETE FROM book_chapters WHERE book_id = ?", [bookId], false);

        if (replacement.chunks.length > 0) {
          const inserts: capSQLiteSet[] = replacement.chunks.map((chunk, chunkIndex) => ({
            statement:
              "INSERT INTO book_chunks (book_id, chunk_index, paragraphs_json) VALUES (?, ?, ?)",
            values: [bookId, chunkIndex, JSON.stringify(chunk.paragraphs_json)],
          }));
          await db.executeSet(inserts, false);
        }

        if (replacement.chapters.length > 0) {
          const chapterInserts: capSQLiteSet[] = replacement.chapters.map((chapter, chapterIndex) => ({
            statement:
              "INSERT INTO book_chapters (book_id, chapter_index, title, start_paragraph_id) VALUES (?, ?, ?, ?)",
            values: [bookId, chapterIndex, chapter.title, chapter.start_paragraph_id],
          }));
          await db.executeSet(chapterInserts, false);
        }

        await db.run(
          `
          UPDATE books
          SET total_chunks = ?, total_paragraphs = ?, total_words = ?, updated_at = ?
          WHERE id = ?
          `,
          [
            replacement.total_chunks,
            replacement.total_paragraphs,
            replacement.total_words,
            Date.now(),
            bookId,
          ],
          false
        );

        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction();
        throw error;
      }

      const rows = await this.queryRows(db, "SELECT * FROM books WHERE id = ? LIMIT 1", [bookId]);
      if (rows.length === 0) {
        throw new Error(`Book ${bookId} not found after replaceBookContent`);
      }
      return toBookRow(rows[0]);
    });
  }

  async clearBookContent(bookId: string): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.beginTransaction();
      try {
        await db.run("DELETE FROM book_chunks WHERE book_id = ?", [bookId], false);
        await db.run("DELETE FROM book_chapters WHERE book_id = ?", [bookId], false);
        await db.run(
          `
          UPDATE books
          SET total_chunks = 0, total_paragraphs = 0, total_words = 0, updated_at = ?
          WHERE id = ?
          `,
          [Date.now(), bookId],
          false
        );
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction();
        throw error;
      }
    });
  }

  async getBookAggregate(bookId: string): Promise<StoredBookAggregate | null> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const bookRows = await this.queryRows(db, "SELECT * FROM books WHERE id = ? LIMIT 1", [bookId]);
      if (bookRows.length === 0) return null;

      const chapterRows = await this.queryRows(
        db,
        "SELECT * FROM book_chapters WHERE book_id = ? ORDER BY chapter_index ASC",
        [bookId]
      );
      const chunkRows = await this.queryRows(
        db,
        "SELECT * FROM book_chunks WHERE book_id = ? ORDER BY chunk_index ASC",
        [bookId]
      );

      return {
        book: toBookRow(bookRows[0]),
        chapters: chapterRows.map(toBookChapterRow),
        chunks: chunkRows.map(toBookChunkRow),
      };
    });
  }

  async getReadableBook(bookId: string): Promise<ReadableBookBundle | null> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const bookRows = await this.queryRows(db, "SELECT * FROM books WHERE id = ? LIMIT 1", [bookId]);
      if (bookRows.length === 0) return null;
      const aggregate: StoredBookAggregate = {
        book: toBookRow(bookRows[0]),
        chapters: (
          await this.queryRows(
            db,
            "SELECT * FROM book_chapters WHERE book_id = ? ORDER BY chapter_index ASC",
            [bookId]
          )
        ).map(toBookChapterRow),
        chunks: (
          await this.queryRows(
            db,
            "SELECT * FROM book_chunks WHERE book_id = ? ORDER BY chunk_index ASC",
            [bookId]
          )
        ).map(toBookChunkRow),
      };
      if (aggregate.book.processing_status !== "completed") return null;

      const paragraphs: Paragraph[] = aggregate.chunks
        .sort((a, b) => a.chunk_index - b.chunk_index)
        .flatMap((chunk) => chunk.paragraphs_json);
      const chapters: Chapter[] = aggregate.chapters
        .sort((a, b) => a.chapter_index - b.chapter_index)
        .map((chapter) => ({
          index: chapter.chapter_index,
          title: chapter.title,
          startParagraphId: chapter.start_paragraph_id,
        }));

      const book: Book = {
        id: aggregate.book.id,
        title: aggregate.book.title,
        author: aggregate.book.author ?? undefined,
        coverUrl: aggregate.book.cover_path ?? undefined,
        paragraphs,
        chapters,
        totalWords: aggregate.book.total_words,
      };

      return {
        metadata: aggregate.book,
        book,
      };
    });
  }

  async saveReadingProgress(progress: ReadingProgressRow): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.run(
        `
        INSERT INTO reading_progress (book_id, paragraph_id, word_index, mode, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(book_id) DO UPDATE SET
          paragraph_id=excluded.paragraph_id,
          word_index=excluded.word_index,
          mode=excluded.mode,
          updated_at=excluded.updated_at
        `,
        [
          progress.book_id,
          progress.paragraph_id,
          progress.word_index,
          progress.mode,
          progress.updated_at,
        ]
      );
    });
  }

  async getReadingProgress(bookId: string): Promise<ReadingProgressRow | null> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const rows = await this.queryRows(
        db,
        "SELECT * FROM reading_progress WHERE book_id = ? LIMIT 1",
        [bookId]
      );
      if (rows.length === 0) return null;
      return toReadingProgressRow(rows[0]);
    });
  }

  async deleteReadingProgress(bookId: string): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.run("DELETE FROM reading_progress WHERE book_id = ?", [bookId]);
    });
  }

  async putAppSetting(key: string, value: unknown): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.run(
        `
        INSERT INTO app_settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
        `,
        [key, JSON.stringify(value)]
      );
    });
  }

  async getAppSetting<T>(key: string): Promise<T | null> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const rows = await this.queryRows(db, "SELECT * FROM app_settings WHERE key = ? LIMIT 1", [key]);
      if (rows.length === 0) return null;
      const setting = toAppSettingRow(rows[0]);
      return setting.value_json as T;
    });
  }

  async listAppSettings(): Promise<AppSettingRow[]> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const rows = await this.queryRows(db, "SELECT * FROM app_settings ORDER BY key ASC");
      return rows.map(toAppSettingRow);
    });
  }

  async insertImportJob(job: ImportJobRow): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.run(
        `
        INSERT INTO import_jobs (book_id, attempt, status, error, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(book_id, attempt) DO UPDATE SET
          status=excluded.status,
          error=excluded.error,
          started_at=excluded.started_at,
          finished_at=excluded.finished_at
        `,
        [job.book_id, job.attempt, job.status, job.error, job.started_at, job.finished_at]
      );
    });
  }

  async patchImportJob(
    bookId: string,
    attempt: number,
    patch: Partial<Pick<ImportJobRow, "status" | "error" | "finished_at">>
  ): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      const rows = await this.queryRows(
        db,
        "SELECT * FROM import_jobs WHERE book_id = ? AND attempt = ? LIMIT 1",
        [bookId, attempt]
      );
      if (rows.length === 0) {
        throw new Error(`Import job ${bookId}/${attempt} not found`);
      }
      const existing = toImportJobRow(rows[0]);
      const hasErrorPatch = Object.prototype.hasOwnProperty.call(patch, "error");
      const hasFinishedAtPatch = Object.prototype.hasOwnProperty.call(patch, "finished_at");
      const nextStatus = patch.status ?? existing.status;
      const nextError = hasErrorPatch ? (patch.error ?? null) : existing.error;
      const nextFinishedAt = hasFinishedAtPatch
        ? (patch.finished_at ?? null)
        : existing.finished_at;
      await db.run(
        `
        UPDATE import_jobs
        SET status = ?, error = ?, finished_at = ?
        WHERE book_id = ? AND attempt = ?
        `,
        [
          nextStatus,
          nextError,
          nextFinishedAt,
          bookId,
          attempt,
        ]
      );
    });
  }

  async listImportJobs(bookId: string): Promise<ImportJobRow[]> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const rows = await this.queryRows(
        db,
        "SELECT * FROM import_jobs WHERE book_id = ? ORDER BY attempt ASC",
        [bookId]
      );
      return rows.map(toImportJobRow);
    });
  }

  async nextImportAttempt(bookId: string): Promise<number> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const rows = await this.queryRows(
        db,
        "SELECT MAX(attempt) AS max_attempt FROM import_jobs WHERE book_id = ?",
        [bookId]
      );
      if (rows.length === 0) return 1;
      const maxAttempt = asNumber(rows[0].max_attempt);
      return maxAttempt + 1;
    });
  }

  async exportSnapshot(): Promise<StorageSnapshot> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const books = (await this.queryRows(db, "SELECT * FROM books ORDER BY created_at ASC")).map(toBookRow);
      const bookChunks = (
        await this.queryRows(db, "SELECT * FROM book_chunks ORDER BY book_id ASC, chunk_index ASC")
      ).map(toBookChunkRow);
      const bookChapters = (
        await this.queryRows(db, "SELECT * FROM book_chapters ORDER BY book_id ASC, chapter_index ASC")
      ).map(toBookChapterRow);
      const readingProgress = (
        await this.queryRows(db, "SELECT * FROM reading_progress ORDER BY book_id ASC")
      ).map(toReadingProgressRow);
      const appSettings = (
        await this.queryRows(db, "SELECT * FROM app_settings ORDER BY key ASC")
      ).map(toAppSettingRow);
      const importJobs = (
        await this.queryRows(db, "SELECT * FROM import_jobs ORDER BY book_id ASC, attempt ASC")
      ).map(toImportJobRow);

      return {
        books,
        book_chunks: bookChunks,
        book_chapters: bookChapters,
        reading_progress: readingProgress,
        app_settings: appSettings,
        import_jobs: importJobs,
      };
    });
  }

  async importSnapshot(snapshot: StorageSnapshot): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.beginTransaction();
      try {
        await db.execute(
          `
          DELETE FROM reading_progress;
          DELETE FROM app_settings;
          DELETE FROM import_jobs;
          DELETE FROM book_chunks;
          DELETE FROM book_chapters;
          DELETE FROM books;
          `,
          false
        );

        if (snapshot.books.length > 0) {
          await db.executeSet(
            snapshot.books.map((book) => ({
              statement:
                "INSERT INTO books (id, title, author, cover_path, language, source_uri, size_bytes, processing_status, processing_error, total_chunks, total_paragraphs, total_words, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              values: [
                book.id,
                book.title,
                book.author,
                book.cover_path,
                book.language,
                book.source_uri,
                book.size_bytes,
                book.processing_status,
                book.processing_error,
                book.total_chunks,
                book.total_paragraphs,
                book.total_words,
                book.created_at,
                book.updated_at,
              ],
            })),
            false
          );
        }

        if (snapshot.book_chunks.length > 0) {
          await db.executeSet(
            snapshot.book_chunks.map((chunk) => ({
              statement:
                "INSERT INTO book_chunks (book_id, chunk_index, paragraphs_json) VALUES (?, ?, ?)",
              values: [chunk.book_id, chunk.chunk_index, JSON.stringify(chunk.paragraphs_json)],
            })),
            false
          );
        }

        if (snapshot.book_chapters.length > 0) {
          await db.executeSet(
            snapshot.book_chapters.map((chapter) => ({
              statement:
                "INSERT INTO book_chapters (book_id, chapter_index, title, start_paragraph_id) VALUES (?, ?, ?, ?)",
              values: [
                chapter.book_id,
                chapter.chapter_index,
                chapter.title,
                chapter.start_paragraph_id,
              ],
            })),
            false
          );
        }

        if (snapshot.reading_progress.length > 0) {
          await db.executeSet(
            snapshot.reading_progress.map((progress) => ({
              statement:
                "INSERT INTO reading_progress (book_id, paragraph_id, word_index, mode, updated_at) VALUES (?, ?, ?, ?, ?)",
              values: [
                progress.book_id,
                progress.paragraph_id,
                progress.word_index,
                progress.mode,
                progress.updated_at,
              ],
            })),
            false
          );
        }

        if (snapshot.app_settings.length > 0) {
          await db.executeSet(
            snapshot.app_settings.map((setting) => ({
              statement: "INSERT INTO app_settings (key, value_json) VALUES (?, ?)",
              values: [setting.key, JSON.stringify(setting.value_json)],
            })),
            false
          );
        }

        if (snapshot.import_jobs.length > 0) {
          await db.executeSet(
            snapshot.import_jobs.map((job) => ({
              statement:
                "INSERT INTO import_jobs (book_id, attempt, status, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
              values: [job.book_id, job.attempt, job.status, job.error, job.started_at, job.finished_at],
            })),
            false
          );
        }

        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction();
        throw error;
      }
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

  private async getDb(): Promise<SQLiteDBConnection> {
    await this.init();
    if (!this.db) {
      throw new Error("SQLite connection is not initialized");
    }
    return this.db;
  }

  private async openAndPrepare(): Promise<void> {
    const consistency = await this.sqlite.checkConnectionsConsistency().catch(() => ({ result: false }));
    if (!consistency.result) {
      await this.sqlite.closeAllConnections().catch(() => undefined);
    }

    const hasConnection = await this.sqlite.isConnection(DB_NAME, false);
    this.db = hasConnection.result
      ? await this.sqlite.retrieveConnection(DB_NAME, false)
      : await this.sqlite.createConnection(DB_NAME, false, "no-encryption", DB_VERSION, false);

    await this.db.open();
    await this.db.execute("PRAGMA foreign_keys = ON;");

    const currentVersion = await this.readUserVersion(this.db);
    if (currentVersion > DB_VERSION) {
      throw new Error(
        `Database version ${currentVersion} is newer than supported version ${DB_VERSION}`
      );
    }
    await this.applyMigrations(this.db, currentVersion);
    await this.db.execute("PRAGMA foreign_keys = ON;");
  }

  private async queryRows(db: SQLiteDBConnection, statement: string, values: unknown[] = []): Promise<SqlRow[]> {
    const response = await db.query(statement, values);
    const rows = response.values ?? [];
    return rows.filter((row): row is SqlRow => typeof row === "object" && row !== null);
  }

  private async readUserVersion(db: SQLiteDBConnection): Promise<number> {
    const rows = await this.queryRows(db, "PRAGMA user_version;");
    if (rows.length === 0) return 0;
    return asNumber(rows[0]?.user_version);
  }

  private async applyMigrations(db: SQLiteDBConnection, currentVersion: number): Promise<void> {
    for (let version = currentVersion + 1; version <= DB_VERSION; version += 1) {
      if (version === 1) {
        await db.execute(SCHEMA_V1_SQL);
      } else {
        throw new Error(`No SQLite migration defined for schema version ${version}`);
      }
      await db.execute(`PRAGMA user_version = ${version};`);
    }
  }
}

export async function createSqliteBookRepository(): Promise<BookRepository> {
  const repo = new SqliteBookRepository();
  await repo.init();
  return repo;
}
