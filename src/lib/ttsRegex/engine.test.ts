import { describe, expect, it } from "bun:test";
import type { Book } from "@/types/book";
import type { TtsRegexRule, TtsRegexStoreV1 } from "@/types/ttsRegex";
import {
  applyRulesChunkMode,
  applyRulesTokenMode,
  type CompiledTtsRegexRule,
  compileRule,
  createDefaultTtsRegexStore,
  getActiveRules,
  previewRuleImpact,
  TTS_REGEX_MAX_PATTERN_LENGTH,
  TTS_REGEX_MAX_REPLACEMENT_LENGTH,
} from "@/lib/ttsRegex/engine";

function makeRule(partial: Partial<TtsRegexRule> = {}): TtsRegexRule {
  const now = Date.now();
  return {
    id: partial.id ?? "rule-1",
    pattern: partial.pattern ?? "xarqon",
    replacement: partial.replacement ?? "zar-kon",
    enabled: partial.enabled ?? true,
    caseInsensitive: partial.caseInsensitive ?? true,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

function makeBook(paragraphTexts: string[], totalWords = paragraphTexts.join(" ").split(/\s+/).length): Book {
  return {
    id: "book-1",
    title: "Fixture",
    paragraphs: paragraphTexts.map((text, index) => ({
      id: index + 1,
      text,
    })),
    chapters: [{ index: 0, title: "Full book", startParagraphId: 1 }],
    totalWords,
  };
}

function compileAll(rules: TtsRegexRule[]): CompiledTtsRegexRule[] {
  const compiled: CompiledTtsRegexRule[] = [];

  for (const rule of rules) {
    const result = compileRule(rule);
    if (result.ok) {
      compiled.push(result.compiled);
    }
  }

  return compiled;
}

describe("tts regex engine", () => {
  it("applies active rules in Global-before-Book order", () => {
    const store: TtsRegexStoreV1 = {
      ...createDefaultTtsRegexStore(),
      globalRules: [makeRule({ id: "g1", pattern: "xarqon", replacement: "global" })],
      bookRulesById: {
        "book-1": [makeRule({ id: "b1", pattern: "xarqon", replacement: "book" })],
      },
    };

    const active = getActiveRules(store, "book-1");
    const compiled = compileAll(active);

    const out = applyRulesTokenMode(["xarqon"], compiled);
    expect(out.spokenTokens).toEqual(["global"]);
    expect(out.stats.totalMatches).toBe(1);
  });

  it("uses top-to-bottom first-match-wins in same scope", () => {
    const rules = [
      makeRule({ id: "r1", pattern: "xarqon", replacement: "first" }),
      makeRule({ id: "r2", pattern: "xarqon", replacement: "second" }),
    ];
    const compiled = compileAll(rules);

    const out = applyRulesTokenMode(["xarqon"], compiled);
    expect(out.spokenTokens).toEqual(["first"]);
  });

  it("matches whole token only in token mode", () => {
    const rules = [makeRule({ pattern: "xar" })];
    const compiled = compileAll(rules);

    const out = applyRulesTokenMode(["xarqon"], compiled);
    expect(out.spokenTokens).toEqual(["xarqon"]);
    expect(out.stats.totalMatches).toBe(0);
  });

  it("supports multi-word replacements in chunk mode", () => {
    const rules = [makeRule({ pattern: "new\\s+york", replacement: "Nyu York" })];
    const compiled = compileAll(rules);

    const out = applyRulesChunkMode("Welcome to New York, New York.", compiled);
    expect(out.spokenText).toBe("Welcome to Nyu York, Nyu York.");
    expect(out.stats.totalMatches).toBe(2);
  });

  it("applies all chunk rules in order on transformed text", () => {
    const rules = [
      makeRule({ pattern: "NYC", replacement: "New York City" }),
      makeRule({ pattern: "Dr\\.", replacement: "Doctor" }),
    ];
    const compiled = compileAll(rules);

    const out = applyRulesChunkMode("Dr. lives in NYC.", compiled);
    expect(out.spokenText).toBe("Doctor lives in New York City.");
    expect(out.stats.totalMatches).toBe(2);
  });

  it("ignores disabled rules in active list", () => {
    const store: TtsRegexStoreV1 = {
      ...createDefaultTtsRegexStore(),
      globalRules: [makeRule({ enabled: false })],
      bookRulesById: {},
    };

    const active = getActiveRules(store, "book-1");
    expect(active).toHaveLength(0);
  });

  it("rejects invalid regex patterns", () => {
    const result = compileRule(makeRule({ pattern: "([abc" }));
    expect(result.ok).toBe(false);
  });

  it("rejects potentially unsafe regex patterns", () => {
    const result = compileRule(makeRule({ pattern: "(a+)+$" }));
    expect(result.ok).toBe(false);
  });

  it("rejects too-long pattern and replacement", () => {
    const tooLongPattern = "a".repeat(TTS_REGEX_MAX_PATTERN_LENGTH + 1);
    const tooLongReplacement = "b".repeat(TTS_REGEX_MAX_REPLACEMENT_LENGTH + 1);

    expect(compileRule(makeRule({ pattern: tooLongPattern })).ok).toBe(false);
    expect(compileRule(makeRule({ replacement: tooLongReplacement })).ok).toBe(false);
  });

  it("supports empty replacement deletion in token mode", () => {
    const compiled = compileAll([makeRule({ pattern: "xarqon", replacement: "" })]);
    const out = applyRulesTokenMode(["xarqon", "hello"], compiled);

    expect(out.spokenTokens).toEqual(["", "hello"]);
    expect(out.stats.totalMatches).toBe(1);
  });

  it("respects case sensitivity toggle", () => {
    const insensitive = compileAll([makeRule({ pattern: "xarqon", caseInsensitive: true })]);
    const sensitive = compileAll([makeRule({ pattern: "xarqon", caseInsensitive: false })]);

    const upper = ["XARQON"];
    expect(applyRulesTokenMode(upper, insensitive).stats.totalMatches).toBe(1);
    expect(applyRulesTokenMode(upper, sensitive).stats.totalMatches).toBe(0);
  });

  it("supports wildcard patterns like .* in token mode", () => {
    const compiled = compileAll([makeRule({ pattern: ".*", replacement: "word" })]);
    const out = applyRulesTokenMode(["alpha", "beta"], compiled);

    expect(out.spokenTokens).toEqual(["word", "word"]);
    expect(out.stats.totalMatches).toBe(2);
  });

  it("handles zero-length chunk matches without hanging", () => {
    const compiled = compileAll([makeRule({ pattern: "a*", replacement: "X" })]);
    const out = applyRulesChunkMode("bbb", compiled);

    expect(out.stats.totalMatches).toBeGreaterThan(0);
    expect(out.spokenText.length).toBeGreaterThan(0);
  });

  it("isolates book-scope rules by book id", () => {
    const store: TtsRegexStoreV1 = {
      ...createDefaultTtsRegexStore(),
      globalRules: [],
      bookRulesById: {
        "book-1": [makeRule({ id: "b1", pattern: "xarqon", replacement: "book-one" })],
        "book-2": [makeRule({ id: "b2", pattern: "xarqon", replacement: "book-two" })],
      },
    };

    const outBook1 = applyRulesTokenMode(["xarqon"], compileAll(getActiveRules(store, "book-1")));
    const outBook2 = applyRulesTokenMode(["xarqon"], compileAll(getActiveRules(store, "book-2")));

    expect(outBook1.spokenTokens[0]).toBe("book-one");
    expect(outBook2.spokenTokens[0]).toBe("book-two");
  });

  it("marks high impact by count threshold in preview", () => {
    const paragraphs = Array.from({ length: 600 }, () => "xarqon");
    const book = makeBook(paragraphs, 600);
    const store = createDefaultTtsRegexStore();
    const candidate = makeRule({ id: "candidate", pattern: "xarqon", replacement: "zar-kon" });

    const preview = previewRuleImpact(book, store, "global", candidate);

    expect(preview.totalMatches).toBe(600);
    expect(preview.highImpact).toBe(true);
  });

  it("marks high impact by percentage threshold in preview", () => {
    const book = makeBook(["xarqon hello", "xarqon world"], 30);
    const store = createDefaultTtsRegexStore();
    const candidate = makeRule({ id: "candidate", pattern: "xarqon", replacement: "zar-kon" });

    const preview = previewRuleImpact(book, store, "global", candidate);

    expect(preview.totalMatches).toBe(2);
    expect(preview.matchPercentOfBookWords).toBeGreaterThan(5);
    expect(preview.highImpact).toBe(true);
  });
});
