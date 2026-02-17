import { describe, expect, it } from "bun:test";
import {
  chunkParagraphs,
  computeTotalWords,
  hasSequentialParagraphIds,
  normalizeChapters,
  recomputeParagraphCountFromChunks,
} from "@/lib/import/normalization";

describe("normalization and chunking", () => {
  it("enforces 1-based sequential paragraph ids", () => {
    const valid = [
      { id: 1, text: "alpha beta" },
      { id: 2, text: "gamma" },
      { id: 3, text: "delta epsilon" },
    ];
    const invalid = [
      { id: 1, text: "alpha" },
      { id: 3, text: "beta" },
    ];

    expect(hasSequentialParagraphIds(valid)).toBe(true);
    expect(hasSequentialParagraphIds(invalid)).toBe(false);
  });

  it("normalizes chapter order and indexes with monotonic starts", () => {
    const chapters = normalizeChapters("book-1", [
      { title: "Third", start_paragraph_id: 30 },
      { title: "First", start_paragraph_id: 1 },
      { title: "Second", start_paragraph_id: 10 },
    ]);

    expect(chapters.map((chapter) => chapter.chapter_index)).toEqual([0, 1, 2]);
    expect(chapters.map((chapter) => chapter.start_paragraph_id)).toEqual([1, 10, 30]);
  });

  it("builds sequential chunks with 50-paragraph cap except final chunk", () => {
    const paragraphs = Array.from({ length: 121 }, (_, i) => ({
      id: i + 1,
      text: `Paragraph ${i + 1}`,
    }));

    const chunks = chunkParagraphs("book-1", paragraphs, 50);
    expect(chunks.map((chunk) => chunk.chunk_index)).toEqual([0, 1, 2]);
    expect(chunks[0]?.paragraphs_json.length).toBe(50);
    expect(chunks[1]?.paragraphs_json.length).toBe(50);
    expect(chunks[2]?.paragraphs_json.length).toBe(21);
    expect(recomputeParagraphCountFromChunks(chunks)).toBe(paragraphs.length);
  });

  it("computes total words that match recomputed paragraph token count", () => {
    const paragraphs = [
      { id: 1, text: "Alpha beta gamma" },
      { id: 2, text: "Delta" },
      { id: 3, text: "Epsilon zeta eta theta" },
    ];
    const computed = computeTotalWords(paragraphs);
    const recomputed = paragraphs
      .map((paragraph) => paragraph.text.trim().split(/\s+/).filter(Boolean).length)
      .reduce((sum, count) => sum + count, 0);

    expect(computed).toBe(recomputed);
  });
});
