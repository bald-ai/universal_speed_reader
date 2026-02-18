import type { Book } from "@/types/book";
import type {
  TtsRegexPreviewStats,
  TtsRegexRule,
  TtsRegexScope,
  TtsRegexStoreV1,
} from "@/types/ttsRegex";
import { tokenizeParagraph } from "@/lib/utils/wordExtraction";

export const TTS_REGEX_STORE_VERSION = 1;
export const TTS_REGEX_MAX_PATTERN_LENGTH = 200;
export const TTS_REGEX_MAX_REPLACEMENT_LENGTH = 120;
export const TTS_REGEX_MAX_RULES_PER_SCOPE = 300;
export const TTS_REGEX_PREVIEW_MAX_EXAMPLES = 20;
export const TTS_REGEX_HIGH_IMPACT_MATCH_COUNT = 500;
export const TTS_REGEX_HIGH_IMPACT_PERCENT = 5;

export type CompiledTtsRegexRule = {
  id: string;
  replacement: string;
  tokenRegex: RegExp;
  chunkRegex: RegExp;
  chunkRegexSingle: RegExp;
};

export type CompiledRuleResult =
  | {
      ok: true;
      compiled: CompiledTtsRegexRule;
    }
  | {
      ok: false;
      error: string;
    };

export type ApplyRulesStats = {
  totalMatches: number;
};

export type ApplyRulesTokenModeResult = {
  spokenTokens: string[];
  stats: ApplyRulesStats;
};

export type ApplyRulesChunkModeResult = {
  spokenText: string;
  stats: ApplyRulesStats;
};

function createFlags(rule: TtsRegexRule): string {
  return rule.caseInsensitive ? "i" : "";
}

function hasPotentiallyUnsafeRegex(pattern: string): boolean {
  // Heuristic guard for common catastrophic backtracking shapes like:
  // - (a+)+
  // - (.+)*
  // - (a|aa)+
  // This is intentionally conservative for V1 safety.
  const nestedQuantifier = /\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)\s*[+*{]/;
  if (nestedQuantifier.test(pattern)) return true;

  const quantifiedAlternation = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*{]/;
  if (quantifiedAlternation.test(pattern)) return true;

  const backReference = /\\[1-9]/;
  if (backReference.test(pattern)) return true;

  return false;
}

function cloneRegex(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags);
}

function countMatches(text: string, regex: RegExp): number {
  const matcher = cloneRegex(regex);
  let count = 0;

  while (true) {
    const match = matcher.exec(text);
    if (!match) break;
    count += 1;

    const matchedText = match[0] ?? "";
    if (matchedText.length === 0) {
      matcher.lastIndex += 1;
      if (matcher.lastIndex > text.length) break;
    }

    if (!matcher.global) break;
  }

  return count;
}

function collectMatches(text: string, regex: RegExp): string[] {
  const matcher = cloneRegex(regex);
  const values: string[] = [];

  while (true) {
    const match = matcher.exec(text);
    if (!match) break;
    const matchedText = match[0] ?? "";
    values.push(matchedText);

    if (matchedText.length === 0) {
      matcher.lastIndex += 1;
      if (matcher.lastIndex > text.length) break;
    }

    if (!matcher.global) break;
  }

  return values;
}

export function createDefaultTtsRegexStore(): TtsRegexStoreV1 {
  return {
    version: TTS_REGEX_STORE_VERSION,
    matchMode: "token",
    globalRules: [],
    bookRulesById: {},
  };
}

export function compileRule(rule: TtsRegexRule): CompiledRuleResult {
  const pattern = rule.pattern.trim();
  if (!pattern) {
    return { ok: false, error: "Pattern is required" };
  }

  if (pattern.length > TTS_REGEX_MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      error: `Pattern is too long (max ${TTS_REGEX_MAX_PATTERN_LENGTH} chars)`,
    };
  }

  if (rule.replacement.length > TTS_REGEX_MAX_REPLACEMENT_LENGTH) {
    return {
      ok: false,
      error: `Replacement is too long (max ${TTS_REGEX_MAX_REPLACEMENT_LENGTH} chars)`,
    };
  }

  if (hasPotentiallyUnsafeRegex(pattern)) {
    return {
      ok: false,
      error: "Regex looks potentially unsafe for live playback. Try a simpler pattern.",
    };
  }

  const flags = createFlags(rule);

  try {
    const tokenRegex = new RegExp(`^(?:${pattern})$`, flags);
    const chunkRegexSingle = new RegExp(pattern, flags);
    const chunkRegex = new RegExp(pattern, `${flags}g`);

    return {
      ok: true,
      compiled: {
        id: rule.id,
        replacement: rule.replacement,
        tokenRegex,
        chunkRegex,
        chunkRegexSingle,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid regex pattern";
    return { ok: false, error: `Invalid regex: ${message}` };
  }
}

export function getActiveRules(store: TtsRegexStoreV1, bookId: string): TtsRegexRule[] {
  const globalRules = store.globalRules.filter((rule) => rule.enabled);
  const bookRules = (store.bookRulesById[bookId] ?? []).filter((rule) => rule.enabled);
  return [...globalRules, ...bookRules];
}

export function applyRulesTokenMode(
  tokens: string[],
  activeRules: CompiledTtsRegexRule[]
): ApplyRulesTokenModeResult {
  if (activeRules.length === 0 || tokens.length === 0) {
    return {
      spokenTokens: tokens,
      stats: { totalMatches: 0 },
    };
  }

  const spokenTokens: string[] = new Array(tokens.length);
  let totalMatches = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    let spoken = token;

    for (const rule of activeRules) {
      rule.tokenRegex.lastIndex = 0;
      if (!rule.tokenRegex.test(token)) continue;

      rule.tokenRegex.lastIndex = 0;
      spoken = token.replace(rule.tokenRegex, rule.replacement);
      totalMatches += 1;
      break;
    }

    spokenTokens[i] = spoken;
  }

  return {
    spokenTokens,
    stats: { totalMatches },
  };
}

export function applyRulesChunkMode(
  chunkText: string,
  activeRules: CompiledTtsRegexRule[]
): ApplyRulesChunkModeResult {
  if (activeRules.length === 0 || chunkText.length === 0) {
    return {
      spokenText: chunkText,
      stats: { totalMatches: 0 },
    };
  }

  let spokenText = chunkText;
  let totalMatches = 0;

  for (const rule of activeRules) {
    let matchedByRule = 0;
    spokenText = spokenText.replace(rule.chunkRegex, () => {
      matchedByRule += 1;
      return rule.replacement;
    });
    totalMatches += matchedByRule;
  }

  return {
    spokenText,
    stats: { totalMatches },
  };
}

function compileEnabledRules(rules: TtsRegexRule[]): CompiledTtsRegexRule[] {
  const compiled: CompiledTtsRegexRule[] = [];

  for (const rule of rules) {
    const result = compileRule(rule);
    if (result.ok) {
      compiled.push(result.compiled);
    }
  }

  return compiled;
}

function withCandidateRule(
  store: TtsRegexStoreV1,
  scope: TtsRegexScope,
  bookId: string,
  candidateRule: TtsRegexRule
): TtsRegexStoreV1 {
  const nextStore: TtsRegexStoreV1 = {
    version: TTS_REGEX_STORE_VERSION,
    matchMode: store.matchMode,
    globalRules: [...store.globalRules],
    bookRulesById: { ...store.bookRulesById },
  };

  const targetRules =
    scope === "global"
      ? [...nextStore.globalRules]
      : [...(nextStore.bookRulesById[bookId] ?? [])];

  const index = targetRules.findIndex((rule) => rule.id === candidateRule.id);
  if (index >= 0) {
    targetRules[index] = candidateRule;
  } else {
    targetRules.push(candidateRule);
  }

  if (scope === "global") {
    nextStore.globalRules = targetRules;
  } else {
    nextStore.bookRulesById[bookId] = targetRules;
  }

  return nextStore;
}

export function previewRuleImpact(
  book: Book,
  store: TtsRegexStoreV1,
  scope: TtsRegexScope,
  candidateRule: TtsRegexRule
): TtsRegexPreviewStats {
  const storeWithCandidate = withCandidateRule(store, scope, book.id, candidateRule);
  const activeRules = getActiveRules(storeWithCandidate, book.id);
  const compiledRules = compileEnabledRules(activeRules);

  let totalMatches = 0;
  let affectedParagraphs = 0;
  const uniqueMatchedWords = new Set<string>();
  const examples: { before: string; after: string }[] = [];

  for (const paragraph of book.paragraphs) {
    if (compiledRules.length === 0) break;

    let paragraphMatched = false;

    if (store.matchMode === "token") {
      const tokens = tokenizeParagraph(paragraph.text);

      for (const token of tokens) {
        for (const rule of compiledRules) {
          rule.tokenRegex.lastIndex = 0;
          if (!rule.tokenRegex.test(token)) continue;

          rule.tokenRegex.lastIndex = 0;
          const next = token.replace(rule.tokenRegex, rule.replacement);

          totalMatches += 1;
          paragraphMatched = true;
          uniqueMatchedWords.add(token.toLowerCase());

          if (examples.length < TTS_REGEX_PREVIEW_MAX_EXAMPLES) {
            examples.push({ before: token, after: next });
          }
          break;
        }
      }
    } else {
      let chunkText = paragraph.text;
      for (const rule of compiledRules) {
        const matchCount = countMatches(chunkText, rule.chunkRegex);
        if (matchCount <= 0) continue;

        totalMatches += matchCount;
        paragraphMatched = true;

        const matchedValues = collectMatches(chunkText, rule.chunkRegex);
        for (const value of matchedValues) {
          if (value.trim().length > 0) {
            uniqueMatchedWords.add(value.toLowerCase());
          }
        }

        if (examples.length < TTS_REGEX_PREVIEW_MAX_EXAMPLES && matchedValues.length > 0) {
          for (const value of matchedValues) {
            if (examples.length >= TTS_REGEX_PREVIEW_MAX_EXAMPLES) break;
            const after = value.replace(rule.chunkRegexSingle, rule.replacement);
            examples.push({ before: value, after });
          }
        }

        chunkText = chunkText.replace(rule.chunkRegex, rule.replacement);
      }
    }

    if (paragraphMatched) {
      affectedParagraphs += 1;
    }
  }

  const totalWords = Math.max(1, book.totalWords);
  const matchPercentOfBookWords = (totalMatches / totalWords) * 100;
  const highImpact =
    totalMatches > TTS_REGEX_HIGH_IMPACT_MATCH_COUNT ||
    matchPercentOfBookWords > TTS_REGEX_HIGH_IMPACT_PERCENT;

  return {
    totalMatches,
    affectedParagraphs,
    uniqueMatchedWords: uniqueMatchedWords.size,
    examples,
    totalWords,
    matchPercentOfBookWords,
    highImpact,
  };
}
