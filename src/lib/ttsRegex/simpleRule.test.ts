import { describe, expect, it } from "bun:test";
import { applyRulesTokenMode, compileRule } from "@/lib/ttsRegex/engine";
import { createSimpleWordPattern, normalizeSimpleReplacementWord } from "@/lib/ttsRegex/simpleRule";

function compileTokenRule(word: string, replacement: string) {
  const result = compileRule({
    id: "simple-rule",
    pattern: createSimpleWordPattern(word),
    replacement,
    source: "simple",
    enabled: true,
    caseInsensitive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  if (!result.ok) {
    throw new Error(`Failed to compile simple rule in test: ${result.error}`);
  }

  return result.compiled;
}

describe("simple tts word replacement pattern", () => {
  it("strips surrounding punctuation from the typed word", () => {
    expect(normalizeSimpleReplacementWord(`"xarqon,"`)).toBe("xarqon");
    expect(normalizeSimpleReplacementWord("...xar-qon!!!")).toBe("xar-qon");
  });

  it("matches tokens with surrounding punctuation", () => {
    const compiled = [compileTokenRule("xarqon", "zar-kon")];
    const out = applyRulesTokenMode(["xarqon,", "\"xarqon\""], compiled);

    expect(out.spokenTokens).toEqual(["zar-kon,", "\"zar-kon\""]);
    expect(out.stats.totalMatches).toBe(2);
  });

  it("still matches plain words exactly", () => {
    const compiled = [compileTokenRule("xarqon", "zar-kon")];
    const out = applyRulesTokenMode(["xarqon", "hello"], compiled);

    expect(out.spokenTokens).toEqual(["zar-kon", "hello"]);
    expect(out.stats.totalMatches).toBe(1);
  });
});
