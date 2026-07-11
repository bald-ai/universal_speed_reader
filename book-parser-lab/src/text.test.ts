import { describe, expect, test } from "bun:test";
import { countWords, measureTextViability, tokenizeParagraph } from "./text.ts";

describe("app-model tokenization", () => {
  test("matches production whitespace positions instead of lexical word splitting", () => {
    const text = `"hello" can't end-to-end em—dash slash/term ... ''`;
    expect(tokenizeParagraph(text)).toEqual([
      "hello",
      "can't",
      "end-to-end",
      "em—dash",
      "slash/term",
      "...",
    ]);
    expect(countWords(text)).toBe(6);
  });

  test("shares the strict usable-text floor with parser recovery", () => {
    expect(measureTextViability("readable ".repeat(49)).usable).toBe(false);
    expect(measureTextViability("readable ".repeat(50))).toMatchObject({
      words: 50,
      usable: true,
    });
    expect(measureTextViability("123 ".repeat(60)).usable).toBe(false);
  });
});
