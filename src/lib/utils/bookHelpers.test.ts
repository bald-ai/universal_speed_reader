import { describe, expect, it } from "bun:test";
import type { Book } from "../../types/book";
import {
  calculateChapterPercentComplete,
  calculatePercentComplete,
  findChapterForParagraph,
  getNextPosition,
  getWordAtPosition,
} from "./bookHelpers";

function makeBook(partial?: Partial<Book>): Book {
  return {
    id: "book-1",
    title: "Test Book",
    paragraphs: [
      { id: 1, text: "One two three" },
      { id: 2, text: "" },
      { id: 3, text: "Four five" },
    ],
    chapters: [
      { index: 0, title: "Ch 1", startParagraphId: 1 },
      { index: 1, title: "Ch 2", startParagraphId: 3 },
    ],
    totalWords: 5,
    ...partial,
  };
}

describe("findChapterForParagraph", () => {
  it("returns null when no chapters exist", () => {
    const book = makeBook({ chapters: [] });
    expect(findChapterForParagraph(book, 1)).toBeNull();
  });

  it("returns matching chapter for middle and late paragraphs", () => {
    const book = makeBook();
    expect(findChapterForParagraph(book, 2)?.title).toBe("Ch 1");
    expect(findChapterForParagraph(book, 3)?.title).toBe("Ch 2");
    expect(findChapterForParagraph(book, 999)?.title).toBe("Ch 2");
  });
});

describe("calculatePercentComplete", () => {
  it("returns 0 for empty books, zero totals, or unknown paragraph", () => {
    expect(calculatePercentComplete(makeBook({ paragraphs: [] }), { paragraphId: 1, wordIndex: 0 })).toBe(0);
    expect(calculatePercentComplete(makeBook({ totalWords: 0 }), { paragraphId: 1, wordIndex: 0 })).toBe(0);
    expect(calculatePercentComplete(makeBook(), { paragraphId: 999, wordIndex: 0 })).toBe(0);
  });

  it("clamps wordIndex in current paragraph and rounds percent", () => {
    const book = makeBook();
    expect(calculatePercentComplete(book, { paragraphId: 1, wordIndex: -10 })).toBe(0);
    expect(calculatePercentComplete(book, { paragraphId: 1, wordIndex: 2 })).toBe(40);
    expect(calculatePercentComplete(book, { paragraphId: 1, wordIndex: 999 })).toBe(60);
    expect(calculatePercentComplete(book, { paragraphId: 3, wordIndex: 1 })).toBe(80);
  });

  it("works with non-sequential paragraph ids", () => {
    const book = makeBook({
      id: "book-ids",
      paragraphs: [
        { id: 10, text: "alpha beta" },
        { id: 30, text: "gamma delta" },
      ],
      chapters: [{ index: 0, title: "Only", startParagraphId: 10 }],
      totalWords: 4,
    });
    expect(calculatePercentComplete(book, { paragraphId: 30, wordIndex: 1 })).toBe(75);
  });
});

describe("calculateChapterPercentComplete", () => {
  it("returns chapter-local progress based on current chapter word count", () => {
    const book = makeBook();

    expect(calculateChapterPercentComplete(book, { paragraphId: 1, wordIndex: 0 })).toBe(0);
    expect(calculateChapterPercentComplete(book, { paragraphId: 1, wordIndex: 1 })).toBe(33);
    expect(calculateChapterPercentComplete(book, { paragraphId: 1, wordIndex: 3 })).toBe(100);

    expect(calculateChapterPercentComplete(book, { paragraphId: 3, wordIndex: 0 })).toBe(0);
    expect(calculateChapterPercentComplete(book, { paragraphId: 3, wordIndex: 1 })).toBe(50);
    expect(calculateChapterPercentComplete(book, { paragraphId: 3, wordIndex: 2 })).toBe(100);
  });

  it("falls back to book-level progress when chapters are missing", () => {
    const book = makeBook({ chapters: [] });
    expect(calculateChapterPercentComplete(book, { paragraphId: 3, wordIndex: 1 })).toBe(
      calculatePercentComplete(book, { paragraphId: 3, wordIndex: 1 })
    );
  });

  it("falls back to book-level progress when chapter metadata is unusable", () => {
    const book = makeBook({
      chapters: [{ index: 0, title: "Broken", startParagraphId: 99 }],
    });

    expect(calculateChapterPercentComplete(book, { paragraphId: 3, wordIndex: 1 })).toBe(
      calculatePercentComplete(book, { paragraphId: 3, wordIndex: 1 })
    );
  });
});

describe("getWordAtPosition", () => {
  it("returns null for missing paragraph or invalid index", () => {
    const book = makeBook();
    expect(getWordAtPosition(book, { paragraphId: 999, wordIndex: 0 })).toBeNull();
    expect(getWordAtPosition(book, { paragraphId: 1, wordIndex: -1 })).toBeNull();
    expect(getWordAtPosition(book, { paragraphId: 1, wordIndex: 99 })).toBeNull();
  });

  it("returns expected word for a valid position", () => {
    const book = makeBook();
    expect(getWordAtPosition(book, { paragraphId: 1, wordIndex: 1 })).toBe("two");
  });
});

describe("getNextPosition", () => {
  it("moves to next word in same paragraph when available", () => {
    const book = makeBook();
    expect(getNextPosition(book, { paragraphId: 1, wordIndex: 1 })).toEqual({
      paragraphId: 1,
      wordIndex: 2,
    });
  });

  it("skips empty paragraphs and jumps to first word of next non-empty paragraph", () => {
    const book = makeBook();
    expect(getNextPosition(book, { paragraphId: 1, wordIndex: 2 })).toEqual({
      paragraphId: 3,
      wordIndex: 0,
    });
  });

  it("returns null at book end or unknown paragraph", () => {
    const book = makeBook();
    expect(getNextPosition(book, { paragraphId: 3, wordIndex: 1 })).toBeNull();
    expect(getNextPosition(book, { paragraphId: 999, wordIndex: 0 })).toBeNull();
  });
});
