import { describe, expect, it } from "bun:test";
import {
  createDefaultTtsRegexStore,
  TTS_REGEX_MAX_PATTERN_LENGTH,
  TTS_REGEX_MAX_RULES_PER_SCOPE,
} from "@/lib/ttsRegex/engine";
import { __ttsRegexContextInternals } from "@/contexts/TtsRegexContext";
import type { TtsRegexStoreV1 } from "@/types/ttsRegex";

describe("TtsRegexContext internals", () => {
  it("loads defaults when persisted value is missing", () => {
    const out = __ttsRegexContextInternals.sanitizeTtsRegexStore(null);
    expect(out).toEqual(createDefaultTtsRegexStore());
  });

  it("keeps persisted matchMode when valid", () => {
    const out = __ttsRegexContextInternals.sanitizeTtsRegexStore({
      version: 1,
      matchMode: "chunk",
      globalRules: [],
      bookRulesById: {},
    });
    expect(out.matchMode).toBe("chunk");
  });

  it("creates, updates, deletes, and reorders rules", () => {
    const initial = createDefaultTtsRegexStore();

    const [withFirst, firstRule] = __ttsRegexContextInternals.createRuleInStore(initial, {
      scope: "global",
      input: {
        pattern: "xarqon",
        replacement: "zar-kon",
        caseInsensitive: true,
      },
    });

    const [withSecond, secondRule] = __ttsRegexContextInternals.createRuleInStore(withFirst, {
      scope: "global",
      input: {
        pattern: "drak",
        replacement: "drake",
        caseInsensitive: false,
      },
    });

    expect(withSecond.globalRules.map((rule) => rule.id)).toEqual([firstRule.id, secondRule.id]);
    expect(firstRule.source).toBe("regex");

    const [updatedStore, updatedRule] = __ttsRegexContextInternals.updateRuleInStore(withSecond, {
      scope: "global",
      ruleId: secondRule.id,
      patch: {
        replacement: "dra-kay",
      },
    });
    expect(updatedRule.replacement).toBe("dra-kay");

    const movedUp = __ttsRegexContextInternals.moveRuleInStore(updatedStore, {
      scope: "global",
      ruleId: secondRule.id,
      direction: "up",
    });
    expect(movedUp.globalRules.map((rule) => rule.id)).toEqual([secondRule.id, firstRule.id]);

    const deleted = __ttsRegexContextInternals.deleteRuleFromStore(movedUp, {
      scope: "global",
      ruleId: secondRule.id,
    });
    expect(deleted.globalRules.map((rule) => rule.id)).toEqual([firstRule.id]);
  });

  it("throws on invalid regex while creating a rule", () => {
    const initial: TtsRegexStoreV1 = createDefaultTtsRegexStore();

    expect(() =>
      __ttsRegexContextInternals.createRuleInStore(initial, {
        scope: "global",
        input: {
          pattern: "([abc",
          replacement: "x",
          caseInsensitive: true,
        },
      })
    ).toThrow();
  });

  it("drops persisted rules with oversized patterns during sanitize", () => {
    const oversized = "a".repeat(TTS_REGEX_MAX_PATTERN_LENGTH + 1);
    const out = __ttsRegexContextInternals.sanitizeTtsRegexStore({
      version: 1,
      matchMode: "token",
      globalRules: [
        {
          id: "g-1",
          pattern: oversized,
          replacement: "x",
          enabled: true,
          caseInsensitive: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      bookRulesById: {},
    });

    expect(out.globalRules).toHaveLength(0);
  });

  it("enforces max rules per scope", () => {
    let store = createDefaultTtsRegexStore();

    for (let i = 0; i < TTS_REGEX_MAX_RULES_PER_SCOPE; i += 1) {
      const [next] = __ttsRegexContextInternals.createRuleInStore(store, {
        scope: "global",
        input: {
          pattern: `word-${i}`,
          replacement: `spoken-${i}`,
          caseInsensitive: true,
        },
      });
      store = next;
    }

    expect(() =>
      __ttsRegexContextInternals.createRuleInStore(store, {
        scope: "global",
        input: {
          pattern: "overflow",
          replacement: "overflow",
          caseInsensitive: true,
        },
      })
    ).toThrow();
  });

  it("defaults missing persisted source to regex during sanitize", () => {
    const now = Date.now();
    const out = __ttsRegexContextInternals.sanitizeTtsRegexStore({
      version: 1,
      matchMode: "token",
      globalRules: [
        {
          id: "g-1",
          pattern: "xarqon",
          replacement: "zar-kon",
          enabled: true,
          caseInsensitive: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      bookRulesById: {},
    });

    expect(out.globalRules[0]?.source).toBe("regex");
  });

  it("migrates legacy simple word-boundary pattern to boundary-safe pattern", () => {
    const now = Date.now();
    const out = __ttsRegexContextInternals.sanitizeTtsRegexStore({
      version: 1,
      matchMode: "token",
      globalRules: [
        {
          id: "g-legacy-simple",
          pattern: "\\bReserved\\b",
          replacement: "Reee",
          source: "simple",
          enabled: true,
          caseInsensitive: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      bookRulesById: {},
    });

    expect(out.globalRules[0]?.pattern).toBe("\\bReserved\\b");
    expect(out.globalRules[0]?.source).toBe("simple");
  });

  it("migrates punctuation-eating simple pattern to boundary-safe pattern", () => {
    const now = Date.now();
    const out = __ttsRegexContextInternals.sanitizeTtsRegexStore({
      version: 1,
      matchMode: "token",
      globalRules: [
        {
          id: "g-legacy-simple-v2",
          pattern: "[^\\w]*Reserved[^\\w]*",
          replacement: "Reee",
          source: "simple",
          enabled: true,
          caseInsensitive: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      bookRulesById: {},
    });

    expect(out.globalRules[0]?.pattern).toBe("\\bReserved\\b");
    expect(out.globalRules[0]?.source).toBe("simple");
  });
});
