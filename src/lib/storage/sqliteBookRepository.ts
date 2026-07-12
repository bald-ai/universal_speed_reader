import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
  type capSQLiteSet,
} from "@capacitor-community/sqlite";
import type { BookRepository, ListBooksOptions } from "@/lib/storage/bookRepository";
import type { Book, BookImage, Chapter, Paragraph } from "@/types/book";
import type { Mode } from "@/types/reading";
import { classifyNavigationTitle, navigationLevel } from "@/lib/navigationHierarchy";
import type { NavigationKind } from "@/types/navigation";
import type {
  AppSettingRow,
  BookPatch,
  BookChapterRow,
  BookChunkRow,
  BookContentReplacement,
  BookImageRow,
  BookRow,
  ImportJobPatch,
  ImportJobRow,
  ProcessingStatus,
  ReadableBookBundle,
  ReadingProgressRow,
  StorageSnapshot,
  StoredBookAggregate,
} from "@/types/storage";

const DB_NAME = "universal_speed_reader";
const DB_VERSION = 3;
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

const SCHEMA_V2_SQL = `
  CREATE TABLE IF NOT EXISTS book_images (
    book_id TEXT NOT NULL,
    image_index INTEGER NOT NULL,
    after_paragraph_id INTEGER NOT NULL,
    alt TEXT,
    src TEXT NOT NULL,
    PRIMARY KEY (book_id, image_index),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );
`;

const SCHEMA_V3_SQL = `
  ALTER TABLE book_chapters ADD COLUMN kind TEXT NOT NULL DEFAULT 'chapter';
  ALTER TABLE book_chapters ADD COLUMN level INTEGER NOT NULL DEFAULT 2;
`;

type SqlRow = Record<string, unknown>;

const PROCESSING_STATUS_VALUES = new Set<ProcessingStatus>([
  "queued",
  "validating",
  "extracting_metadata",
  "extracting_text",
  "building_chapters",
  "completed",
  "failed",
]);

const MODE_VALUES = new Set<Mode>(["normal", "speed"]);
const NAVIGATION_KIND_VALUES = new Set<NavigationKind>([
  "frontmatter", "part", "chapter", "section", "scene", "backmatter",
]);

function readRequiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    throw new Error(`Invalid persisted data: ${key} is missing`);
  }
  return String(value);
}

function readRequiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Invalid persisted data: ${key} is not a valid number`);
}

function readNullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const next = String(value);
  return next.length > 0 ? next : null;
}

function readProcessingStatus(row: SqlRow, key: string): ProcessingStatus {
  const value = readRequiredString(row, key);
  if (!PROCESSING_STATUS_VALUES.has(value as ProcessingStatus)) {
    throw new Error(`Invalid persisted data: ${key} has unsupported status "${value}"`);
  }
  return value as ProcessingStatus;
}

function readMode(row: SqlRow, key: string): Mode {
  const value = readRequiredString(row, key);
  if (!MODE_VALUES.has(value as Mode)) {
    throw new Error(`Invalid persisted data: ${key} has unsupported mode "${value}"`);
  }
  return value as Mode;
}

function parseParagraphsJson(raw: unknown): Paragraph[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as Array<{
      id: number;
      text: string;
      sceneBreakBefore?: Paragraph["sceneBreakBefore"];
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => typeof entry?.id === "number" && typeof entry?.text === "string")
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        ...(entry.sceneBreakBefore ? { sceneBreakBefore: entry.sceneBreakBefore } : {}),
      }));
  } catch {
    return [];
  }
}

function toBookRow(row: SqlRow): BookRow {
  return {
    id: readRequiredString(row, "id"),
    title: readRequiredString(row, "title"),
    author: readNullableString(row, "author"),
    cover_path: readNullableString(row, "cover_path"),
    language: readNullableString(row, "language"),
    source_uri: readRequiredString(row, "source_uri"),
    size_bytes: readRequiredNumber(row, "size_bytes"),
    processing_status: readProcessingStatus(row, "processing_status"),
    processing_error: readNullableString(row, "processing_error"),
    total_chunks: readRequiredNumber(row, "total_chunks"),
    total_paragraphs: readRequiredNumber(row, "total_paragraphs"),
    total_words: readRequiredNumber(row, "total_words"),
    created_at: readRequiredNumber(row, "created_at"),
    updated_at: readRequiredNumber(row, "updated_at"),
  };
}

function toBookChunkRow(row: SqlRow): BookChunkRow {
  return {
    book_id: readRequiredString(row, "book_id"),
    chunk_index: readRequiredNumber(row, "chunk_index"),
    paragraphs_json: parseParagraphsJson(row.paragraphs_json),
  };
}

function toBookChapterRow(row: SqlRow): BookChapterRow {
  const title = readRequiredString(row, "title");
  const rawKind = readNullableString(row, "kind");
  const kind = rawKind && NAVIGATION_KIND_VALUES.has(rawKind as NavigationKind)
    ? rawKind as NavigationKind
    : classifyNavigationTitle(title);
  const rawLevel = row.level;
  const level = typeof rawLevel === "number" && Number.isInteger(rawLevel) && rawLevel > 0
    ? rawLevel
    : navigationLevel(kind);
  return {
    book_id: readRequiredString(row, "book_id"),
    chapter_index: readRequiredNumber(row, "chapter_index"),
    title,
    start_paragraph_id: readRequiredNumber(row, "start_paragraph_id"),
    kind,
    level,
  };
}

function toBookImageRow(row: SqlRow): BookImageRow {
  return {
    book_id: readRequiredString(row, "book_id"),
    image_index: readRequiredNumber(row, "image_index"),
    after_paragraph_id: readRequiredNumber(row, "after_paragraph_id"),
    alt: readNullableString(row, "alt"),
    src: readRequiredString(row, "src"),
  };
}

function toBookImages(rows: BookImageRow[]): BookImage[] {
  return rows.map((row) => ({
    id: `${row.book_id}-img-${row.image_index}`,
    afterParagraphId: row.after_paragraph_id,
    alt: row.alt,
    src: row.src,
  }));
}

function toReadingProgressRow(row: SqlRow): ReadingProgressRow {
  return {
    book_id: readRequiredString(row, "book_id"),
    paragraph_id: readRequiredNumber(row, "paragraph_id"),
    word_index: readRequiredNumber(row, "word_index"),
    mode: readMode(row, "mode"),
    updated_at: readRequiredNumber(row, "updated_at"),
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
    key: readRequiredString(row, "key"),
    value_json: valueJson,
  };
}

function toImportJobRow(row: SqlRow): ImportJobRow {
  return {
    book_id: readRequiredString(row, "book_id"),
    attempt: readRequiredNumber(row, "attempt"),
    status: readProcessingStatus(row, "status"),
    error: readNullableString(row, "error"),
    started_at: readRequiredNumber(row, "started_at"),
    finished_at:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : readRequiredNumber(row, "finished_at"),
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

  async patchBook(bookId: string, patch: BookPatch): Promise<BookRow> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const patchKeys = Object.keys(patch);
      if (patchKeys.includes("id") || patchKeys.includes("created_at")) {
        throw new Error("patchBook does not allow updating immutable book fields");
      }

      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length > 0) {
        const setClause = entries.map(([column]) => `${column} = ?`).join(", ");
        await db.run(`UPDATE books SET ${setClause} WHERE id = ?`, [
          ...entries.map(([, value]) => value),
          bookId,
        ]);
      }

      const rows = await this.queryRows(db, "SELECT * FROM books WHERE id = ? LIMIT 1", [bookId]);
      if (rows.length === 0) {
        throw new Error(`Book ${bookId} not found`);
      }
      return toBookRow(rows[0]);
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

  async setBookAndImportStatus(
    bookId: string,
    attempt: number,
    status: ProcessingStatus,
    patch?: {
      processing_error?: string | null;
      updated_at?: number;
      finished_at?: number | null;
    }
  ): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      const now = patch?.updated_at ?? Date.now();
      const processingError = patch?.processing_error ?? null;
      const hasFinishedAtPatch = Object.prototype.hasOwnProperty.call(patch ?? {}, "finished_at");
      const finishedAt = hasFinishedAtPatch ? (patch?.finished_at ?? null) : null;

      await db.beginTransaction();
      try {
        const bookRows = await this.queryRows(db, "SELECT id FROM books WHERE id = ? LIMIT 1", [bookId]);
        if (bookRows.length === 0) {
          throw new Error(`Book ${bookId} not found`);
        }
        const jobRows = await this.queryRows(
          db,
          "SELECT status, error, finished_at FROM import_jobs WHERE book_id = ? AND attempt = ? LIMIT 1",
          [bookId, attempt]
        );
        if (jobRows.length === 0) {
          throw new Error(`Import job ${bookId}/${attempt} not found`);
        }

        await db.run(
          `
          UPDATE books
          SET processing_status = ?, processing_error = ?, updated_at = ?
          WHERE id = ?
          `,
          [status, processingError, now, bookId],
          false
        );

        const nextFinishedAt = hasFinishedAtPatch
          ? finishedAt
          : (jobRows[0].finished_at === null || jobRows[0].finished_at === undefined
              ? null
              : readRequiredNumber(jobRows[0], "finished_at"));

        await db.run(
          `
          UPDATE import_jobs
          SET status = ?, error = ?, finished_at = ?
          WHERE book_id = ? AND attempt = ?
          `,
          [status, processingError, nextFinishedAt, bookId, attempt],
          false
        );

        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction();
        throw error;
      }
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

  async clearAllBooks(): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      await db.beginTransaction();
      try {
        await db.execute(
          `
          DELETE FROM reading_progress;
          DELETE FROM import_jobs;
          DELETE FROM book_chunks;
          DELETE FROM book_chapters;
          DELETE FROM book_images;
          DELETE FROM books;
          `,
          false
        );
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
        await db.run("DELETE FROM book_images WHERE book_id = ?", [bookId], false);

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
              "INSERT INTO book_chapters (book_id, chapter_index, title, start_paragraph_id, kind, level) VALUES (?, ?, ?, ?, ?, ?)",
            values: [
              bookId,
              chapterIndex,
              chapter.title,
              chapter.start_paragraph_id,
              chapter.kind ?? classifyNavigationTitle(chapter.title),
              chapter.level ?? navigationLevel(chapter.kind ?? classifyNavigationTitle(chapter.title)),
            ],
          }));
          await db.executeSet(chapterInserts, false);
        }

        if ((replacement.images ?? []).length > 0) {
          const imageInserts: capSQLiteSet[] = (replacement.images ?? []).map((image, imageIndex) => ({
            statement:
              "INSERT INTO book_images (book_id, image_index, after_paragraph_id, alt, src) VALUES (?, ?, ?, ?, ?)",
            values: [bookId, imageIndex, image.after_paragraph_id, image.alt, image.src],
          }));
          await db.executeSet(imageInserts, false);
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
        await db.run("DELETE FROM book_images WHERE book_id = ?", [bookId], false);
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
      const imageRows = await this.queryRows(
        db,
        "SELECT * FROM book_images WHERE book_id = ? ORDER BY image_index ASC",
        [bookId]
      );

      return {
        book: toBookRow(bookRows[0]),
        chapters: chapterRows.map(toBookChapterRow),
        chunks: chunkRows.map(toBookChunkRow),
        images: imageRows.map(toBookImageRow),
      };
    });
  }

  async getReadableBook(bookId: string): Promise<ReadableBookBundle | null> {
    return this.withLock(async () => {
      const db = await this.getDb();
      const bookRows = await this.queryRows(db, "SELECT * FROM books WHERE id = ? LIMIT 1", [bookId]);
      if (bookRows.length === 0) return null;
      const metadata = toBookRow(bookRows[0]);
      if (metadata.processing_status !== "completed") return null;

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
      const imageRows = await this.queryRows(
        db,
        "SELECT * FROM book_images WHERE book_id = ? ORDER BY image_index ASC",
        [bookId]
      );

      const paragraphs: Paragraph[] = chunkRows.map(toBookChunkRow).flatMap((chunk) => chunk.paragraphs_json);
      const chapters: Chapter[] = chapterRows.map(toBookChapterRow).map((chapter) => ({
          index: chapter.chapter_index,
          title: chapter.title,
          startParagraphId: chapter.start_paragraph_id,
          kind: chapter.kind ?? classifyNavigationTitle(chapter.title),
          level: chapter.level ?? navigationLevel(chapter.kind ?? classifyNavigationTitle(chapter.title)),
        }));
      const images = toBookImages(imageRows.map(toBookImageRow));

      const book: Book = {
        id: metadata.id,
        title: metadata.title,
        author: metadata.author ?? undefined,
        coverUrl: metadata.cover_path ?? undefined,
        paragraphs,
        chapters,
        images,
        totalWords: metadata.total_words,
      };

      return {
        metadata,
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
    patch: ImportJobPatch
  ): Promise<void> {
    await this.withLock(async () => {
      const db = await this.getDb();
      const entries: Array<[string, unknown]> = [];
      if (Object.prototype.hasOwnProperty.call(patch, "status") && patch.status) {
        entries.push(["status", patch.status]);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "error")) {
        entries.push(["error", patch.error ?? null]);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "finished_at")) {
        entries.push(["finished_at", patch.finished_at ?? null]);
      }
      if (entries.length === 0) return;

      const setClause = entries.map(([column]) => `${column} = ?`).join(", ");
      await db.run(`UPDATE import_jobs SET ${setClause} WHERE book_id = ? AND attempt = ?`, [
        ...entries.map(([, value]) => value),
        bookId,
        attempt,
      ]);

      const rows = await this.queryRows(
        db,
        "SELECT book_id FROM import_jobs WHERE book_id = ? AND attempt = ? LIMIT 1",
        [bookId, attempt]
      );
      if (rows.length === 0) {
        throw new Error(`Import job ${bookId}/${attempt} not found`);
      }
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
      if (rows[0].max_attempt === null || rows[0].max_attempt === undefined) return 1;
      const maxAttempt = readRequiredNumber(rows[0], "max_attempt");
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
      const bookImages = (
        await this.queryRows(db, "SELECT * FROM book_images ORDER BY book_id ASC, image_index ASC")
      ).map(toBookImageRow);
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
        book_images: bookImages,
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
          DELETE FROM book_images;
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
                "INSERT INTO book_chapters (book_id, chapter_index, title, start_paragraph_id, kind, level) VALUES (?, ?, ?, ?, ?, ?)",
              values: [
                chapter.book_id,
                chapter.chapter_index,
                chapter.title,
                chapter.start_paragraph_id,
                chapter.kind ?? classifyNavigationTitle(chapter.title),
                chapter.level ?? navigationLevel(chapter.kind ?? classifyNavigationTitle(chapter.title)),
              ],
            })),
            false
          );
        }

        if ((snapshot.book_images ?? []).length > 0) {
          await db.executeSet(
            snapshot.book_images.map((image) => ({
              statement:
                "INSERT INTO book_images (book_id, image_index, after_paragraph_id, alt, src) VALUES (?, ?, ?, ?, ?)",
              values: [
                image.book_id,
                image.image_index,
                image.after_paragraph_id,
                image.alt,
                image.src,
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
    const value = rows[0]?.user_version;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  private async applyMigrations(db: SQLiteDBConnection, currentVersion: number): Promise<void> {
    for (let version = currentVersion + 1; version <= DB_VERSION; version += 1) {
      if (version === 1) {
        await db.execute(SCHEMA_V1_SQL);
      } else if (version === 2) {
        await db.execute(SCHEMA_V2_SQL);
      } else if (version === 3) {
        await db.execute(SCHEMA_V3_SQL);
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
