import { describe, expect, test } from "bun:test";
import { getBookSourceFormat, loadLibraryEntries } from "./libraryBooks";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";
import { setBookRepositoryForTests } from "@/lib/storage/appRepository";

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
