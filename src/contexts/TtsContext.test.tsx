import { describe, expect, it } from "bun:test";
import { compileRule } from "@/lib/ttsRegex/engine";
import { transformSpokenChunk } from "@/contexts/TtsContext";

function makeCompiledRule(pattern: string, replacement: string) {
  const result = compileRule({
    id: "rule-1",
    pattern,
    replacement,
    source: "regex",
    enabled: true,
    caseInsensitive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  if (!result.ok) {
    throw new Error("Failed to compile test regex rule");
  }
  return result.compiled;
}

describe("transformSpokenChunk", () => {
  it("applies token-mode replacements before speak", () => {
    const chunk = {
      text: "xarqon arrives",
      ranges: [
        {
          start: 0,
          end: 6,
          position: { paragraphId: 1, wordIndex: 0 },
        },
        {
          start: 7,
          end: 14,
          position: { paragraphId: 1, wordIndex: 1 },
        },
      ],
      startPosition: { paragraphId: 1, wordIndex: 0 },
    };
    const compiled = [makeCompiledRule("xarqon", "zar-kon")];

    const out = transformSpokenChunk({
      chunk,
      mode: "token",
      compiledRules: compiled,
      maxChars: 5000,
    });

    expect(out.text).toBe("zar-kon arrives");
    expect(out.warning).toBeNull();
  });

  it("applies full-chunk replacements before speak", () => {
    const chunk = {
      text: "Welcome to New York, New York.",
      ranges: [
        {
          start: 0,
          end: 7,
          position: { paragraphId: 1, wordIndex: 0 },
        },
      ],
      startPosition: { paragraphId: 1, wordIndex: 0 },
    };
    const compiled = [makeCompiledRule("new\\s+york", "Nyu York")];

    const out = transformSpokenChunk({
      chunk,
      mode: "chunk",
      compiledRules: compiled,
      maxChars: 5000,
    });

    expect(out.text).toBe("Welcome to Nyu York, Nyu York.");
    expect(out.warning).toBeNull();
  });

  it("falls back to original text when transformed chunk is too long", () => {
    const chunk = {
      text: "x",
      ranges: [
        {
          start: 0,
          end: 1,
          position: { paragraphId: 1, wordIndex: 0 },
        },
      ],
      startPosition: { paragraphId: 1, wordIndex: 0 },
    };
    const compiled = [makeCompiledRule("x", "xxxxxxxxxxxx")];

    const out = transformSpokenChunk({
      chunk,
      mode: "chunk",
      compiledRules: compiled,
      maxChars: 5,
    });

    expect(out.text).toBe("x");
    expect(out.warning).toContain("too long");
  });

  it("keeps original ranges in chunk mode when there are no matches", () => {
    const chunk = {
      text: "plain words only",
      ranges: [
        {
          start: 0,
          end: 5,
          position: { paragraphId: 1, wordIndex: 0 },
        },
        {
          start: 6,
          end: 11,
          position: { paragraphId: 1, wordIndex: 1 },
        },
      ],
      startPosition: { paragraphId: 1, wordIndex: 0 },
    };
    const compiled = [makeCompiledRule("xarqon", "zar-kon")];

    const out = transformSpokenChunk({
      chunk,
      mode: "chunk",
      compiledRules: compiled,
      maxChars: 5000,
    });

    expect(out.text).toBe(chunk.text);
    expect(out.ranges).toEqual(chunk.ranges);
  });
});
