import { describe, expect, test } from "bun:test";
import { buildBook } from "./model.ts";
import type { ParserOutput } from "./types.ts";
import { validateParserOutput } from "./validate.ts";

function validOutput(): ParserOutput {
  const paragraphs = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    text: `Paragraph ${index + 1} contains enough ordinary prose words to make this compact test book readable and useful.`,
  }));
  return {
    book: buildBook({
      format: "epub",
      metadata: { title: "Fixture", authors: ["Tester"] },
      paragraphs,
      chapters: [{ title: "Chapter One", startParagraphId: 1 }],
      images: [{ afterParagraphId: 2, alt: "Illustration", src: "OPS/images/example.jpg" }],
      cover: { src: "OPS/images/cover.jpg", mediaType: "image/jpeg" },
      timings: { totalMs: 25 },
    }),
    internals: { declaredImageCount: 2, extractedImageCount: 1 },
  };
}

describe("validateParserOutput", () => {
  test("accepts a sane app-model book", () => {
    const result = validateParserOutput(validOutput());
    expect(result.pass).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test("tallies a missing cover without failing the book", () => {
    const output = validOutput();
    output.book.cover = null;
    const result = validateParserOutput(output);
    expect(result.pass).toBe(true);
    expect(result.diagnostics).toContainEqual({
      bucket: "Cover missing",
      severity: "warning",
      message: "No reasonable library cover was found.",
    });
  });

  test("rejects collapsed paragraph boundaries", () => {
    const output = validOutput();
    output.book.paragraphs = [{ id: 1, text: "word ".repeat(6_000) }];
    output.book.totals.words = 6_000;
    output.book.totals.paragraphs = 1;
    const result = validateParserOutput(output);
    expect(result.pass).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.bucket === "No / unusable text")).toBe(true);
  });

  test("rejects chapter lists collapsed onto too few paragraph starts", () => {
    const output = validOutput();
    output.book.chapters = Array.from({ length: 8 }, (_value, index) => ({
      title: `Chapter ${index + 1}`,
      startParagraphId: 1,
    }));
    output.book.totals.chapters = output.book.chapters.length;

    const result = validateParserOutput(output);

    expect(result.pass).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      bucket: "Weak / missing / nonsense chapters",
      severity: "failure",
      message: expect.stringContaining("distinct paragraph starts"),
    }));
  });

  test("allows repeated chapter numbers across parts when starts remain distinct", () => {
    const output = validOutput();
    output.book.chapters = Array.from({ length: 8 }, (_value, index) => ({
      title: `Chapter ${(index % 2) + 1}`,
      startParagraphId: index * 2 + 1,
    }));
    output.book.totals.chapters = output.book.chapters.length;

    const result = validateParserOutput(output);

    expect(result.pass).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});
