import { describe, expect, it } from "bun:test";
import { tokenizeParagraph } from "@/lib/utils/wordExtraction";
import { applyRulesChunkMode, applyRulesTokenMode, compileRule } from "@/lib/ttsRegex/engine";
import { createSimpleWordPattern } from "@/lib/ttsRegex/simpleRule";
import { RESERVED_REALISTIC_CORPUS } from "@/lib/ttsRegex/__fixtures__/reservedRealisticCorpus";

const TARGET = "Reserved";
const REPLACEMENT = "Rereeere";
const SINGLE_RESERVED = /\bReserved\b/i;
const GLOBAL_RESERVED = /\bReserved\b/gi;
const NEAR_MISS_WORDS = ["preserved", "unreserved", "reserve", "reservation"] as const;

function compileSimpleReservedRule() {
  const result = compileRule({
    id: "simple-reserved",
    pattern: createSimpleWordPattern(TARGET),
    replacement: REPLACEMENT,
    source: "simple",
    enabled: true,
    caseInsensitive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  if (!result.ok) {
    throw new Error(`Failed to compile simple reserved rule: ${result.error}`);
  }
  return result.compiled;
}

function countWholeWord(text: string, word: string): number {
  const regex = new RegExp(`\\b${word}\\b`, "gi");
  let count = 0;
  for (const _ of text.matchAll(regex)) {
    count += 1;
  }
  return count;
}

describe("realistic simple-rule corpus regression", () => {
  const compiled = [compileSimpleReservedRule()];

  it("token mode replaces standalone Reserved in realistic text while preserving punctuation", () => {
    for (const sentence of RESERVED_REALISTIC_CORPUS) {
      const tokens = tokenizeParagraph(sentence);
      const expectedTokens = tokens.map((token) => token.replace(SINGLE_RESERVED, REPLACEMENT));
      const expectedMatchCount = tokens.filter((token) => SINGLE_RESERVED.test(token)).length;
      const out = applyRulesTokenMode(tokens, compiled);

      expect(out.spokenTokens).toEqual(expectedTokens);
      expect(out.stats.totalMatches).toBe(expectedMatchCount);
    }
  });

  it("chunk mode does not consume spaces/punctuation around Reserved in realistic text", () => {
    for (const sentence of RESERVED_REALISTIC_CORPUS) {
      const expected = sentence.replace(GLOBAL_RESERVED, REPLACEMENT);
      const out = applyRulesChunkMode(sentence, compiled);

      expect(out.spokenText).toBe(expected);
      expect(out.stats.totalMatches).toBe(countWholeWord(sentence, TARGET));
    }
  });

  it("does not over-match near-miss words in realistic text", () => {
    for (const sentence of RESERVED_REALISTIC_CORPUS) {
      const out = applyRulesChunkMode(sentence, compiled);
      for (const word of NEAR_MISS_WORDS) {
        expect(countWholeWord(out.spokenText, word)).toBe(countWholeWord(sentence, word));
      }
    }
  });
});
