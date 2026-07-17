import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DiagnosticCode } from "./diagnosticCodes.ts";
import * as epubModule from "./epub.ts";
import { parseBookBytes } from "./index.ts";
import { buildBook } from "./model.ts";
import type { ParserOutput } from "./types.ts";
import { MAX_BOOK_PARAGRAPHS } from "./validate.ts";

function oversizedOutput(): ParserOutput {
  const paragraphs = Array.from({ length: MAX_BOOK_PARAGRAPHS + 1 }, (_, index) => ({
    id: index + 1,
    text: "word",
  }));
  return {
    book: buildBook({
      format: "epub",
      metadata: { title: "Over Cap Parse", authors: ["Tester"] },
      paragraphs,
      chapters: [{ title: "Chapter One", startParagraphId: 1 }],
      images: [],
      cover: { src: "OPS/images/cover.jpg", mediaType: "image/jpeg" },
      timings: { totalMs: 25 },
    }),
    internals: {},
  };
}

describe("parseBookBytes paragraph cap", () => {
  afterEach(() => {
    mock.restore();
  });

  test("parseBookBytes resolves with too_many_paragraphs instead of throwing", async () => {
    spyOn(epubModule, "parseEpub").mockImplementation(async () => oversizedOutput());

    const result = await parseBookBytes({
      sourceBytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      sourceName: "over-cap.epub",
    });

    expect(result.book.diagnostics).toContainEqual(expect.objectContaining({
      code: DiagnosticCode.too_many_paragraphs,
      severity: "failure",
      bucket: "Other",
    }));
  });
});
