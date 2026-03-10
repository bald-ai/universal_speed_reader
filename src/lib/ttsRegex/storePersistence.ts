import {
  createDefaultTtsRegexStore,
  TTS_REGEX_MAX_PATTERN_LENGTH,
  TTS_REGEX_MAX_REPLACEMENT_LENGTH,
  TTS_REGEX_MAX_RULES_PER_SCOPE,
} from "@/lib/ttsRegex/engine";
import { createSimpleWordPattern } from "@/lib/ttsRegex/simpleRule";
import type {
  TtsRegexMatchMode,
  TtsRegexRule,
  TtsRegexRuleSource,
  TtsRegexStoreV1,
} from "@/types/ttsRegex";

export const TTS_REGEX_SETTINGS_KEY = "tts.regex.v1";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMatchMode(value: unknown): value is TtsRegexMatchMode {
  return value === "token" || value === "chunk";
}

function isRuleSource(value: unknown): value is TtsRegexRuleSource {
  return value === "simple" || value === "regex";
}

export function migrateSimplePattern(pattern: string): string {
  const trimmed = pattern.trim();
  const legacyBoundaryMatch = trimmed.match(/^\\b(.+)\\b$/);
  if (legacyBoundaryMatch?.[1]) {
    const legacyWord = legacyBoundaryMatch[1].replace(/\\(.)/g, "$1");
    const migrated = createSimpleWordPattern(legacyWord);
    return migrated || trimmed;
  }

  const punctuationSafeMatch = trimmed.match(/^\[\^\\w\]\*(.+)\[\^\\w\]\*$/);
  if (punctuationSafeMatch?.[1]) {
    const legacyWord = punctuationSafeMatch[1].replace(/\\(.)/g, "$1");
    const migrated = createSimpleWordPattern(legacyWord);
    return migrated || trimmed;
  }

  return trimmed;
}

function sanitizeRule(raw: unknown): TtsRegexRule | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
  if (typeof raw.replacement !== "string") return null;
  if (raw.replacement.length > TTS_REGEX_MAX_REPLACEMENT_LENGTH) return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (typeof raw.caseInsensitive !== "boolean") return null;
  const source: TtsRegexRuleSource = isRuleSource(raw.source) ? raw.source : "regex";
  if (typeof raw.pattern !== "string") return null;
  const pattern = source === "simple" ? migrateSimplePattern(raw.pattern) : raw.pattern;
  if (pattern.length > TTS_REGEX_MAX_PATTERN_LENGTH) return null;

  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;

  return {
    id: raw.id,
    pattern,
    replacement: raw.replacement,
    source,
    enabled: raw.enabled,
    caseInsensitive: raw.caseInsensitive,
    createdAt,
    updatedAt,
  };
}

function sanitizeRuleList(raw: unknown): TtsRegexRule[] {
  if (!Array.isArray(raw)) return [];

  const rules: TtsRegexRule[] = [];
  for (const item of raw) {
    const rule = sanitizeRule(item);
    if (!rule) continue;
    rules.push(rule);
    if (rules.length >= TTS_REGEX_MAX_RULES_PER_SCOPE) break;
  }
  return rules;
}

export function sanitizeTtsRegexStore(raw: unknown): TtsRegexStoreV1 {
  const defaults = createDefaultTtsRegexStore();
  if (!isObject(raw)) return defaults;

  const globalRules = sanitizeRuleList(raw.globalRules);
  const bookRulesById: Record<string, TtsRegexRule[]> = {};

  if (isObject(raw.bookRulesById)) {
    for (const [key, value] of Object.entries(raw.bookRulesById)) {
      if (typeof key !== "string" || key.trim().length === 0) continue;
      bookRulesById[key] = sanitizeRuleList(value);
    }
  }

  return {
    version: 1,
    matchMode: isMatchMode(raw.matchMode) ? raw.matchMode : defaults.matchMode,
    globalRules,
    bookRulesById,
  };
}

export function removeBookRulesFromStore(
  raw: unknown,
  bookId: string
): { store: TtsRegexStoreV1; changed: boolean } {
  const store = sanitizeTtsRegexStore(raw);
  if (!Object.prototype.hasOwnProperty.call(store.bookRulesById, bookId)) {
    return { store, changed: false };
  }

  const { [bookId]: _removed, ...remainingBookRules } = store.bookRulesById;
  return {
    store: {
      ...store,
      bookRulesById: remainingBookRules,
    },
    changed: true,
  };
}
