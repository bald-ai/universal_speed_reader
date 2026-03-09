import { describe, expect, it } from "bun:test";
import { __readingContextInternals, resolveReadingStateFromProgress } from "@/contexts/ReadingContext";
import type { BookRepository } from "@/lib/storage/bookRepository";
import type { ReadingProgressRow } from "@/types/storage";

function makeParagraphBook() {
  return {
    paragraphs: [
      { id: 10, text: "Alpha beta" },
      { id: 20, text: "Gamma delta epsilon" },
    ],
  };
}

function makeRepository(
  implementation: (
    bookId: string
  ) => Promise<ReadingProgressRow | null>
): Pick<BookRepository, "getReadingProgress"> {
  return {
    getReadingProgress: implementation,
  };
}

describe("ReadingContext internals", () => {
  it("restores saved progress through the shared progress resolver", () => {
    expect(
      resolveReadingStateFromProgress([10, 20], {
        paragraph_id: 20,
        word_index: 3,
        mode: "speed",
      })
    ).toEqual({
      mode: "speed",
      position: {
        paragraphId: 20,
        wordIndex: 3,
      },
    });
  });

  it("builds a progress row for an existing paragraph", () => {
    const originalNow = Date.now;
    Date.now = () => 123456;

    const row = __readingContextInternals.buildProgressRow(
      makeParagraphBook(),
      "book-1",
      "speed",
      {
        paragraphId: 20,
        wordIndex: 4,
      }
    );

    Date.now = originalNow;

    expect(row).toEqual({
      book_id: "book-1",
      paragraph_id: 20,
      word_index: 4,
      mode: "speed",
      updated_at: 123456,
    });
  });

  it("falls back to the first paragraph and clamps word index when building progress", () => {
    const row = __readingContextInternals.buildProgressRow(
      makeParagraphBook(),
      "book-2",
      "normal",
      {
        paragraphId: 999,
        wordIndex: -3,
      }
    );

    expect(row).toMatchObject({
      book_id: "book-2",
      paragraph_id: 10,
      word_index: 0,
      mode: "normal",
    });
  });

  it("returns null when building progress for a missing or empty book", () => {
    expect(
      __readingContextInternals.buildProgressRow(null, "book-3", "normal", {
        paragraphId: 1,
        wordIndex: 0,
      })
    ).toBeNull();
    expect(
      __readingContextInternals.buildProgressRow(
        {
          paragraphs: [],
        },
        "book-4",
        "normal",
        {
          paragraphId: 1,
          wordIndex: 0,
        }
      )
    ).toBeNull();
  });

  it("returns a fallback position only when the current paragraph is no longer valid", () => {
    expect(
      __readingContextInternals.ensureValidPosition(makeParagraphBook(), {
        paragraphId: 20,
        wordIndex: 1,
      })
    ).toBeNull();

    expect(
      __readingContextInternals.ensureValidPosition(makeParagraphBook(), {
        paragraphId: 999,
        wordIndex: 7,
      })
    ).toEqual({
      paragraphId: 10,
      wordIndex: 0,
    });
  });

  it("loads saved reading state from the repository", async () => {
    const out = await __readingContextInternals.loadReadingStateFromRepository(
      makeRepository(async () => ({
        book_id: "book-load",
        paragraph_id: 20,
        word_index: 2,
        mode: "speed",
        updated_at: 10,
      })),
      "book-load",
      [10, 20]
    );

    expect(out).toEqual({
      mode: "speed",
      position: {
        paragraphId: 20,
        wordIndex: 2,
      },
    });
  });

  it("falls back cleanly when reading progress cannot be loaded", async () => {
    const out = await __readingContextInternals.loadReadingStateFromRepository(
      makeRepository(async () => {
        throw new Error("db offline");
      }),
      "book-fallback",
      [10, 20]
    );

    expect(out).toEqual({
      mode: "normal",
      position: {
        paragraphId: 10,
        wordIndex: 0,
      },
    });
  });
});
