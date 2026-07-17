import { describe, expect, test } from "bun:test";
import { getBookSourceFormat, loadLibraryEntries } from "./libraryBooks";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";
import { setBookRepositoryForTests } from "@/lib/storage/appRepository";

class ProgressTrackingRepository extends InMemoryBookRepository {
  getReadingProgressCalls = 0;
  listReadingProgressCalls = 0;

  override async getReadingProgress(bookId: string) {
    this.getReadingProgressCalls += 1;
    return super.getReadingProgress(bookId);
  }

  override async listReadingProgress() {
    this.listReadingProgressCalls += 1;
    return super.listReadingProgress();
  }
}

describe("library book source format", () => {
  test("derives EPUB and PDF from stored source URIs", () => {
    expect(getBookSourceFormat("indexeddb://raw_books/id/title.epub")).toBe("EPUB");
    expect(getBookSourceFormat("indexeddb://raw_books/id/title.PDF")).toBe("PDF");
    expect(getBookSourceFormat("indexeddb://raw_books/id/My%20Book.pdf")).toBe("PDF");
  });

  test("does not invent a format for an unknown legacy source", () => {
    expect(getBookSourceFormat("memory://book-without-extension")).toBeNull();
  });
});

describe("library progress loading", () => {
  test("loads all progress rows in one repository operation", async () => {
    const repository = new ProgressTrackingRepository();
    await repository.init();
    setBookRepositoryForTests(repository);

    try {
      await repository.upsertBook({
        id: "progress-book",
        title: "Progress Book",
        author: "Author",
        cover_path: null,
        language: "en",
        source_uri: "indexeddb://raw_books/progress-book/progress.epub",
        size_bytes: 10,
        processing_status: "completed",
        processing_error: null,
        processing_warnings: null,
        total_chunks: 1,
        total_paragraphs: 5,
        total_words: 100,
        created_at: 1,
        updated_at: 1,
      });
      await repository.saveReadingProgress({
        book_id: "progress-book",
        paragraph_id: 3,
        word_index: 4,
        mode: "normal",
        updated_at: 2,
      });

      const entries = await loadLibraryEntries();

      expect(entries[0]?.progressPercent).toBe(40);
      expect(repository.listReadingProgressCalls).toBe(1);
      expect(repository.getReadingProgressCalls).toBe(0);
    } finally {
      setBookRepositoryForTests(null);
    }
  });
});

describe("library soft-import warnings", () => {
  test("exposes processing warnings on completed openable entries", async () => {
    const repository = new InMemoryBookRepository();
    await repository.init();
    setBookRepositoryForTests(repository);
    await repository.upsertBook({
      id: "soft-book",
      title: "Soft Book",
      author: "Author",
      cover_path: null,
      language: "en",
      source_uri: "indexeddb://raw_books/soft-book/soft.epub",
      size_bytes: 10,
      processing_status: "completed",
      processing_error: null,
      processing_warnings: [{ code: "images_missing", message: "Some pictures are missing." }],
      total_chunks: 1,
      total_paragraphs: 2,
      total_words: 40,
      created_at: 1,
      updated_at: 1,
    });

    const entries = await loadLibraryEntries();
    expect(entries[0]?.processingWarnings).toEqual([
      { code: "images_missing", message: "Some pictures are missing." },
    ]);
    expect(entries[0]?.processingStatus).toBe("completed");
    setBookRepositoryForTests(null);
  });
});
