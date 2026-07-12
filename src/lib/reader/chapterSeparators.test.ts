import { describe, expect, it } from "bun:test";
import { buildChapterSeparatorStarts, isDuplicateVisibleChapterHeading, navigationEntryAtParagraph } from "./chapterSeparators";

describe("chapter separators", () => {
  it("shows the first chapter divider when front matter precedes it", () => {
    expect([...buildChapterSeparatorStarts({
      paragraphs: [{ id: 1, text: "Title" }, { id: 2, text: "Chapter I" }],
      chapters: [{ index: 0, title: "Chapter I", startParagraphId: 2 }],
    })]).toEqual([2]);
  });

  it("suppresses a divider only when the first chapter starts the book", () => {
    expect([...buildChapterSeparatorStarts({
      paragraphs: [{ id: 1, text: "Chapter I" }],
      chapters: [{ index: 0, title: "Chapter I", startParagraphId: 1 }],
    })]).toEqual([]);
  });

  it("recognizes the body heading already represented by the reader chapter treatment", () => {
    expect(isDuplicateVisibleChapterHeading({
      chapters: [{ index: 0, title: "CHAPTER I. Down the Rabbit-Hole", startParagraphId: 4 }],
    }, 4, "Chapter I — Down the Rabbit-Hole")).toBe(true);
  });

  it("keeps named scenes distinct and visible while selecting the deepest navigation entry", () => {
    const book = {
      chapters: [
        { index: 0, title: "Chapter Two", startParagraphId: 8, kind: "chapter" as const },
        { index: 1, title: "SCENE I", startParagraphId: 8, kind: "scene" as const },
      ],
    };
    expect(navigationEntryAtParagraph(book, 8)?.kind).toBe("scene");
    expect(isDuplicateVisibleChapterHeading(book, 8, "SCENE I")).toBe(false);
  });
});
