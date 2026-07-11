import { describe, expect, it } from "bun:test";
import { buildNormalReadingDisplayRows } from "@/lib/reader/buildNormalReadingDisplayRows";
import type { Book } from "@/types/book";

function makeBook(partial?: Partial<Book>): Book {
  return {
    id: "book-1",
    title: "Display Rows",
    paragraphs: [
      { id: 1, text: "First paragraph" },
      { id: 2, text: "Second paragraph" },
      { id: 3, text: "Third paragraph" },
    ],
    chapters: [{ index: 0, title: "One", startParagraphId: 1 }],
    images: [],
    totalWords: 6,
    ...partial,
  };
}

describe("buildNormalReadingDisplayRows", () => {
  it("returns only paragraphs when there are no images", () => {
    const rows = buildNormalReadingDisplayRows(makeBook());
    expect(rows.map((row) => row.kind)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("inserts images after the anchored paragraph and before the first when afterParagraphId is 0", () => {
    const rows = buildNormalReadingDisplayRows(
      makeBook({
        images: [
          {
            id: "img-before",
            afterParagraphId: 0,
            alt: "Frontispiece",
            src: "data:image/png;base64,aaa",
          },
          {
            id: "img-mid",
            afterParagraphId: 1,
            alt: "Mid",
            src: "data:image/png;base64,bbb",
          },
          {
            id: "img-end",
            afterParagraphId: 3,
            alt: null,
            src: "data:image/png;base64,ccc",
          },
        ],
      })
    );

    expect(
      rows.map((row) =>
        row.kind === "paragraph" ? `p:${row.paragraph.id}` : `i:${row.image.id}`
      )
    ).toEqual(["i:img-before", "p:1", "i:img-mid", "p:2", "p:3", "i:img-end"]);
  });

  it("preserves image order for the same afterParagraphId", () => {
    const rows = buildNormalReadingDisplayRows(
      makeBook({
        images: [
          {
            id: "img-a",
            afterParagraphId: 2,
            alt: null,
            src: "data:image/png;base64,a",
          },
          {
            id: "img-b",
            afterParagraphId: 2,
            alt: null,
            src: "data:image/png;base64,b",
          },
        ],
      })
    );

    expect(
      rows.map((row) =>
        row.kind === "paragraph" ? `p:${row.paragraph.id}` : `i:${row.image.id}`
      )
    ).toEqual(["p:1", "p:2", "i:img-a", "i:img-b", "p:3"]);
  });
});
