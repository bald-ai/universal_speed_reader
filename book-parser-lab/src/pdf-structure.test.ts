import { describe, expect, test } from "bun:test";

import { buildParagraphs, type DraftParagraph, type PageData, type TextLine } from "./pdf-content.ts";
import { buildChapters, type ResolvedOutlineItem } from "./pdf-structure.ts";
import type { ParserDiagnostic } from "./types.ts";

describe("PDF chapter confidence", () => {
  test("recovers a bare structural marker after line merging", () => {
    const page = makePage(1, [
      makeLine("CHAPTER", 1, 70, 20, 18),
      makeLine("1", 1, 92, 20, 18),
      makeLine("Ordinary body prose follows the merged heading marker.", 1, 120, 10, 120),
    ]);

    const paragraphs = buildParagraphs([page]);

    expect(paragraphs[0]?.text).toBe("CHAPTER 1");
    expect(paragraphs[0]?.headingKind).toBe("strong");
  });

  test("does not split a compact contents-only chapter sequence", () => {
    const page = makePage(1, [
      makeLine(
        "Contents CHAPTER I. First CHAPTER II. Second CHAPTER III. Third CHAPTER IV. Fourth",
        1,
        70,
        10,
        440,
      ),
      makeLine("Ordinary body prose follows without any distributed chapter openers in the document.", 1, 84, 10, 440),
    ]);

    const paragraphs = buildParagraphs([page]);

    expect(paragraphs.some((paragraph) => /^CHAPTER\s+[IVX]+/u.test(paragraph.text))).toBe(false);
  });

  test("prefers prominent real openers over body-sized TOC copies and a lone junk bookmark", () => {
    const pages = Array.from({ length: 30 }, (_value, index) => makePage(index + 1));
    const paragraphs = Array.from({ length: 30 }, (_value, index) => bodyParagraph(index + 1));
    const tocStarts = [1, 2, 3];
    const openerStarts = [10, 20, 30];
    for (const [index, start] of tocStarts.entries()) paragraphs[start - 1] = headingParagraph(`Chapter ${index + 1}`, start, 10);
    for (const [index, start] of openerStarts.entries()) paragraphs[start - 1] = headingParagraph(`CHAPTER ${index + 1}`, start, 22);
    attachParagraphLines(pages, paragraphs);
    const diagnostics: ParserDiagnostic[] = [];

    const chapters = buildChapters(
      pages,
      paragraphs,
      [{ title: "RH", pageIndex: 0, targetY: null }],
      { title: "Fixture", authors: [] },
      diagnostics,
      1,
    );

    expect(chapters.map((chapter) => chapter.startParagraphId)).toEqual(openerStarts);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["CHAPTER 1", "CHAPTER 2", "CHAPTER 3"]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("reliable visible-heading sequence"),
    }));
  });

  test("replaces a spread-out production-file outline with prominent visible headings", () => {
    const pages = Array.from({ length: 30 }, (_value, index) => makePage(index + 1));
    const paragraphs = Array.from({ length: 30 }, (_value, index) => bodyParagraph(index + 1));
    const visibleStarts = [4, 16, 28];
    for (const [index, start] of visibleStarts.entries()) {
      paragraphs[start - 1] = headingParagraph(["Opening", "Conflict", "Resolution"][index] ?? "Section", start, 20);
    }
    attachParagraphLines(pages, paragraphs);
    const outline: ResolvedOutlineItem[] = [
      { title: "Example - Cover Front", pageIndex: 0, targetY: null },
      { title: "Example - Bookblock screen.pdf", pageIndex: 14, targetY: null },
      { title: "Example - Cover Back", pageIndex: 29, targetY: null },
    ];
    const diagnostics: ParserDiagnostic[] = [];

    const chapters = buildChapters(
      pages,
      paragraphs,
      outline,
      { title: "Fixture", authors: [] },
      diagnostics,
      outline.length,
    );

    expect(chapters.map((chapter) => chapter.title)).toEqual(["Opening", "Conflict", "Resolution"]);
    expect(chapters.map((chapter) => chapter.startParagraphId)).toEqual(visibleStarts);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("reliable visible-heading sequence"),
    }));
  });

  test("preserves a substantial destination outline even without visible title matches", () => {
    const pages = Array.from({ length: 25 }, (_value, index) => makePage(index + 1));
    const paragraphs = Array.from({ length: 25 }, (_value, index) => bodyParagraph(index + 1));
    for (const [index, start] of [1, 13, 25].entries()) paragraphs[start - 1] = headingParagraph(`CHAPTER ${index + 1}`, start, 20);
    attachParagraphLines(pages, paragraphs);
    const outline: ResolvedOutlineItem[] = [
      { title: "Official alpha", pageIndex: 0, targetY: null },
      { title: "Official beta", pageIndex: 12, targetY: null },
      { title: "Official gamma", pageIndex: 24, targetY: null },
    ];

    const chapters = buildChapters(
      pages,
      paragraphs,
      outline,
      { title: "Fixture", authors: [] },
      [],
      outline.length,
    );

    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "Official alpha",
      "Official beta",
      "Official gamma",
    ]);
  });
});

function makePage(pageNumber: number, lines?: TextLine[]): PageData {
  return {
    pageNumber,
    width: 612,
    height: 792,
    viewportTransform: [1, 0, 0, 1, 0, 0],
    lines: lines ?? [makeLine("Ordinary body text remains readable here.", pageNumber, 120, 10, 220)],
    images: [],
    declaredImageCount: 0,
    rawTextCharacters: 40,
    verticalItemCount: 0,
    textItemCount: 1,
  };
}

function makeLine(text: string, pageNumber: number, baseline: number, fontSize: number, width: number): TextLine {
  return {
    text,
    xMin: 72,
    xMax: 72 + width,
    baseline,
    fontSize,
    pageNumber,
    column: 0,
    hasEol: true,
    vertical: false,
    order: 0,
  };
}

function bodyParagraph(id: number): DraftParagraph {
  return {
    text: `Ordinary paragraph ${id} contains enough body prose for the fixture.`,
    lines: [makeLine("Ordinary body text remains readable here.", id, 120, 10, 220)],
    headingKind: null,
  };
}

function headingParagraph(text: string, pageNumber: number, fontSize: number): DraftParagraph {
  return {
    text,
    lines: [makeLine(text, pageNumber, 70, fontSize, 120)],
    headingKind: "strong",
  };
}

function attachParagraphLines(pages: PageData[], paragraphs: DraftParagraph[]): void {
  for (const [index, paragraph] of paragraphs.entries()) {
    const page = pages[index];
    if (page === undefined) continue;
    page.lines = [
      ...paragraph.lines,
      makeLine("Ordinary body text remains readable here.", index + 1, 120, 10, 220),
    ];
  }
}
