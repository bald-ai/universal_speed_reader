import { describe, expect, it } from "bun:test";
import type { Book } from "../../types/book";
import {
  getTokensForParagraph,
  getWordCountForParagraph,
  primeBookTokenCache,
} from "./tokenCache";

let nextId = 1;

function makeBook(partial?: Partial<Book>): Book {
  return {
    id: `cache-book-${nextId++}`,
    title: "Cache Test",
    paragraphs: [
      { id: 1, text: "alpha beta" },
      { id: 2, text: "gamma" },
    ],
    chapters: [{ index: 0, title: "Only", startParagraphId: 1 }],
    totalWords: 3,
    ...partial,
  };
}

describe("token cache", () => {
  it("returns cached tokens for repeated reads of the same paragraph", () => {
    const book = makeBook();
    const paragraph = book.paragraphs[0];

    const first = getTokensForParagraph(book, paragraph);
    const second = getTokensForParagraph(book, paragraph);

    expect(first).toEqual(["alpha", "beta"]);
    expect(second).toBe(first);
  });

  it("does not share cache between books with different ids", () => {
    const bookA = makeBook({ id: "book-a", paragraphs: [{ id: 1, text: "alpha" }], totalWords: 1 });
    const bookB = makeBook({ id: "book-b", paragraphs: [{ id: 1, text: "beta" }], totalWords: 1 });

    expect(getTokensForParagraph(bookA, bookA.paragraphs[0])).toEqual(["alpha"]);
    expect(getTokensForParagraph(bookB, bookB.paragraphs[0])).toEqual(["beta"]);
  });

  it("uses paragraph count as part of cache key (same id, different shape)", () => {
    const v1 = makeBook({
      id: "same-id",
      paragraphs: [{ id: 1, text: "one" }],
      totalWords: 1,
    });
    const v2 = makeBook({
      id: "same-id",
      paragraphs: [
        { id: 1, text: "two" },
        { id: 2, text: "three" },
      ],
      totalWords: 2,
    });

    expect(getTokensForParagraph(v1, v1.paragraphs[0])).toEqual(["one"]);
    expect(getTokensForParagraph(v2, v2.paragraphs[0])).toEqual(["two"]);
  });

  it("primes cache and keeps word counts stable for empty and non-empty paragraphs", () => {
    const book = makeBook({
      paragraphs: [
        { id: 1, text: "  spaced   words  " },
        { id: 2, text: "   " },
      ],
      totalWords: 2,
    });

    primeBookTokenCache(book);

    expect(getTokensForParagraph(book, book.paragraphs[0])).toEqual(["spaced", "words"]);
    expect(getTokensForParagraph(book, book.paragraphs[1])).toEqual([]);
    expect(getWordCountForParagraph(book, book.paragraphs[0])).toBe(2);
    expect(getWordCountForParagraph(book, book.paragraphs[1])).toBe(0);
  });
});
