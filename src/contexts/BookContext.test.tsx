import { describe, expect, it } from "bun:test";
import { __bookContextInternals } from "@/contexts/BookContext";
import type { BookRepository } from "@/lib/storage/bookRepository";
import type { BookRow, ReadableBookBundle } from "@/types/storage";

function makeBookRow(
  id: string,
  status: BookRow["processing_status"],
  processingError: string | null = null
): BookRow {
  const now = Date.now();
  return {
    id,
    title: "Fixture Book",
    author: "Fixture Author",
    cover_path: null,
    language: "en",
    source_uri: `memory://${id}.epub`,
    size_bytes: 1024,
    processing_status: status,
    processing_error: processingError,
    processing_warnings: null,
    total_chunks: status === "completed" ? 1 : 0,
    total_paragraphs: status === "completed" ? 2 : 0,
    total_words: status === "completed" ? 4 : 0,
    created_at: now,
    updated_at: now,
  };
}

function makeReadableBundle(id: string): ReadableBookBundle {
  const metadata = makeBookRow(id, "completed");
  return {
    metadata,
    book: {
      id,
      title: metadata.title,
      author: metadata.author ?? undefined,
      paragraphs: [
        { id: 1, text: "One two" },
        { id: 2, text: "Three four" },
      ],
      chapters: [
        { index: 0, title: "Chapter 1", startParagraphId: 1 },
      ],
      images: [],
      totalWords: metadata.total_words,
    },
  };
}

function makeRepository(overrides: {
  readable: ReadableBookBundle | null;
  metadata: BookRow | null;
}): Pick<BookRepository, "getReadableBook" | "getBook"> {
  return {
    async getReadableBook() {
      return overrides.readable;
    },
    async getBook() {
      return overrides.metadata;
    },
  };
}

describe("BookContext internals", () => {
  it("recognizes processing statuses only for active import phases", () => {
    expect(__bookContextInternals.isProcessingStatus("queued")).toBe(true);
    expect(__bookContextInternals.isProcessingStatus("extracting_text")).toBe(true);
    expect(__bookContextInternals.isProcessingStatus("completed")).toBe(false);
    expect(__bookContextInternals.isProcessingStatus("failed")).toBe(false);
  });

  it("returns a ready result when readable book content exists", async () => {
    const readable = makeReadableBundle("book-ready");
    const out = await __bookContextInternals.resolveBookLoadResult(
      makeRepository({
        readable,
        metadata: readable.metadata,
      }),
      "book-ready"
    );

    expect(out).toEqual({
      kind: "ready",
      book: readable.book,
    });
  });

  it("returns processing while metadata says the import is still running", async () => {
    const out = await __bookContextInternals.resolveBookLoadResult(
      makeRepository({
        readable: null,
        metadata: makeBookRow("book-processing", "extracting_metadata"),
      }),
      "book-processing"
    );

    expect(out).toEqual({
      kind: "processing",
    });
  });

  it("returns a failure message from failed metadata", async () => {
    const out = await __bookContextInternals.resolveBookLoadResult(
      makeRepository({
        readable: null,
        metadata: makeBookRow(
          "book-failed",
          "failed",
          "Corrupted/Unreadable EPUB: invalid OPF"
        ),
      }),
      "book-failed"
    );

    expect(out).toEqual({
      kind: "error",
      message: "Corrupted/Unreadable EPUB: invalid OPF",
    });
  });

  it("returns not found when neither readable content nor metadata exists", async () => {
    const out = await __bookContextInternals.resolveBookLoadResult(
      makeRepository({
        readable: null,
        metadata: null,
      }),
      "missing-book"
    );

    expect(out).toEqual({
      kind: "error",
      message: "Book not found",
    });
  });

  it("returns a generic unavailable error for non-failed, non-processing metadata", async () => {
    const out = await __bookContextInternals.resolveBookLoadResult(
      makeRepository({
        readable: null,
        metadata: makeBookRow("book-empty", "completed"),
      }),
      "book-empty"
    );

    expect(out).toEqual({
      kind: "error",
      message: "Book content is unavailable",
    });
  });
});
