import { describe, expect, it } from "bun:test";
import { SqliteBookRepository } from "@/lib/storage/sqliteBookRepository";
import type { BookContentReplacement } from "@/types/storage";

type SqlRow = Record<string, unknown>;
type SqlValues = { values?: SqlRow[] };

class FakeSqliteDb {
  transactionActive = false;
  beginCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  runTransactions: boolean[] = [];
  executeTransactions: boolean[] = [];
  executeSetTransactions: boolean[] = [];
  bookRow: SqlRow;

  constructor(bookId: string) {
    const now = Date.now();
    this.bookRow = {
      id: bookId,
      title: "Fixture",
      author: null,
      cover_path: null,
      language: null,
      source_uri: `indexeddb://raw_epubs/${bookId}/fixture.epub`,
      size_bytes: 1,
      processing_status: "queued",
      processing_error: null,
      total_chunks: 0,
      total_paragraphs: 0,
      total_words: 0,
      created_at: now,
      updated_at: now,
    };
  }

  private assertNoNestedTransaction(transaction: boolean): void {
    if (transaction && this.transactionActive) {
      throw new Error("Run: Failed in beginTransactionAlready in transaction");
    }
  }

  async beginTransaction(): Promise<{ changes: { changes: number } }> {
    if (this.transactionActive) {
      throw new Error("beginTransactionAlready in transaction");
    }
    this.transactionActive = true;
    this.beginCount += 1;
    return { changes: { changes: 0 } };
  }

  async commitTransaction(): Promise<{ changes: { changes: number } }> {
    this.transactionActive = false;
    this.commitCount += 1;
    return { changes: { changes: 0 } };
  }

  async rollbackTransaction(): Promise<{ changes: { changes: number } }> {
    this.transactionActive = false;
    this.rollbackCount += 1;
    return { changes: { changes: 0 } };
  }

  async run(
    statement: string,
    values: unknown[] = [],
    transaction = true
  ): Promise<{ changes: { changes: number } }> {
    this.runTransactions.push(transaction);
    this.assertNoNestedTransaction(transaction);

    if (statement.includes("SET total_chunks = ?, total_paragraphs = ?, total_words = ?, updated_at = ?")) {
      this.bookRow.total_chunks = Number(values[0] ?? 0);
      this.bookRow.total_paragraphs = Number(values[1] ?? 0);
      this.bookRow.total_words = Number(values[2] ?? 0);
      this.bookRow.updated_at = Number(values[3] ?? 0);
    } else if (statement.includes("SET total_chunks = 0, total_paragraphs = 0, total_words = 0")) {
      this.bookRow.total_chunks = 0;
      this.bookRow.total_paragraphs = 0;
      this.bookRow.total_words = 0;
      this.bookRow.updated_at = Number(values[0] ?? 0);
    }

    return { changes: { changes: 1 } };
  }

  async execute(
    _statement: string,
    transaction = true
  ): Promise<{ changes: { changes: number } }> {
    this.executeTransactions.push(transaction);
    this.assertNoNestedTransaction(transaction);
    return { changes: { changes: 1 } };
  }

  async executeSet(
    _set: unknown[],
    transaction = true
  ): Promise<{ changes: { changes: number } }> {
    this.executeSetTransactions.push(transaction);
    this.assertNoNestedTransaction(transaction);
    return { changes: { changes: 1 } };
  }

  async query(statement: string, values: unknown[] = []): Promise<SqlValues> {
    if (statement.includes("SELECT * FROM books WHERE id = ? LIMIT 1")) {
      const requestedId = String(values[0] ?? "");
      if (requestedId === String(this.bookRow.id)) {
        return { values: [{ ...this.bookRow }] };
      }
      return { values: [] };
    }
    return { values: [] };
  }
}

function createRepositoryHarness(bookId: string): {
  repository: SqliteBookRepository;
  db: FakeSqliteDb;
} {
  const repository = new SqliteBookRepository();
  const db = new FakeSqliteDb(bookId);
  const mutableRepository = repository as unknown as {
    db: unknown;
    initPromise: Promise<void> | null;
  };
  mutableRepository.db = db;
  mutableRepository.initPromise = Promise.resolve();
  return { repository, db };
}

describe("sqlite repository transaction guard", () => {
  it("clearBookContent does not trigger nested run transactions", async () => {
    const { repository, db } = createRepositoryHarness("book-clear");

    await repository.clearBookContent("book-clear");

    expect(db.beginCount).toBe(1);
    expect(db.commitCount).toBe(1);
    expect(db.rollbackCount).toBe(0);
    expect(db.runTransactions.length).toBe(3);
    expect(db.runTransactions.every((transaction) => transaction === false)).toBe(true);
  });

  it("replaceBookContent uses non-transactional run/executeSet calls inside a manual transaction", async () => {
    const { repository, db } = createRepositoryHarness("book-replace");
    const replacement: BookContentReplacement = {
      chunks: [
        {
          book_id: "book-replace",
          chunk_index: 0,
          paragraphs_json: [{ id: 1, text: "alpha" }],
        },
      ],
      chapters: [
        {
          book_id: "book-replace",
          chapter_index: 0,
          title: "Chapter 1",
          start_paragraph_id: 1,
        },
      ],
      total_chunks: 1,
      total_paragraphs: 1,
      total_words: 1,
    };

    const updated = await repository.replaceBookContent("book-replace", replacement);

    expect(updated.total_chunks).toBe(1);
    expect(updated.total_paragraphs).toBe(1);
    expect(updated.total_words).toBe(1);
    expect(db.beginCount).toBe(1);
    expect(db.commitCount).toBe(1);
    expect(db.rollbackCount).toBe(0);
    expect(db.runTransactions.every((transaction) => transaction === false)).toBe(true);
    expect(db.executeSetTransactions.every((transaction) => transaction === false)).toBe(true);
  });
});
