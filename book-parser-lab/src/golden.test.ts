import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseBook } from "./parser.ts";
import { validateParserOutput } from "./validate.ts";

const GOLDEN_PATH = resolve(import.meta.dir, "../../test-fixtures/epubs-with-covers/pride-and-prejudice.epub");

describe("Pride and Prejudice golden reference", () => {
  test("retains readable text, navigation, illustrations, captions, and a pointer cover", async () => {
    const output = await parseBook({ sourcePath: GOLDEN_PATH });
    const { book } = output;
    const allText = book.paragraphs.map((paragraph) => paragraph.text).join("\n");

    expect(book.metadata.title).toContain("Pride and Prejudice");
    expect(book.paragraphs.length).toBeGreaterThan(1_000);
    expect(book.totals.words).toBe(130_142);
    expect(book.chapters.length).toBeGreaterThanOrEqual(60);
    expect(book.images.length).toBeGreaterThan(60);
    expect(book.cover?.src).toMatch(/cover\.jpg$/u);
    expect(book.cover?.src.startsWith("data:")).toBe(false);
    expect(allText).toContain("The Project Gutenberg eBook of Pride and Prejudice");
    expect(allText.toLocaleLowerCase()).toContain("it is a truth universally acknowledged");

    const colophon = book.images.find((image) => /colophon/iu.test(`${image.alt} ${image.src}`));
    const janeLetters = book.images.find((image) => /Reading Jane/iu.test(`${image.alt} ${image.src}`));
    expect(colophon).toBeDefined();
    expect(janeLetters).toBeDefined();
    expect((colophon?.afterParagraphId ?? 0) <= (janeLetters?.afterParagraphId ?? 0)).toBe(true);
    expect(book.images.every((image) => !image.src.startsWith("data:") && image.afterParagraphId >= 0)).toBe(true);
    expect(book.timings.totalMs).toBeLessThan(5_000);
    expect(validateParserOutput(output).pass).toBe(true);
  }, 30_000);
});
