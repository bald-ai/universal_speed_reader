import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getBookRepository } from "@/lib/storage/appRepository";
import {
  compileRule,
  createDefaultTtsRegexStore,
  previewRuleImpact,
  TTS_REGEX_MAX_PATTERN_LENGTH,
  TTS_REGEX_MAX_REPLACEMENT_LENGTH,
  TTS_REGEX_MAX_RULES_PER_SCOPE,
} from "@/lib/ttsRegex/engine";
import { createSimpleWordPattern } from "@/lib/ttsRegex/simpleRule";
import type {
  TtsRegexMatchMode,
  TtsRegexPreviewStats,
  TtsRegexRule,
  TtsRegexRuleSource,
  TtsRegexScope,
  TtsRegexStoreV1,
} from "@/types/ttsRegex";
import type { Book } from "@/types/book";

const TTS_REGEX_SETTINGS_KEY = "tts.regex.v1";

type RuleInput = {
  pattern: string;
  replacement: string;
  source?: TtsRegexRuleSource;
  caseInsensitive: boolean;
  enabled?: boolean;
};

type CreateRuleArgs = {
  scope: TtsRegexScope;
  bookId?: string;
  input: RuleInput;
};

type UpdateRuleArgs = {
  scope: TtsRegexScope;
  bookId?: string;
  ruleId: string;
  patch: Partial<RuleInput>;
};

type DeleteRuleArgs = {
  scope: TtsRegexScope;
  bookId?: string;
  ruleId: string;
};

type MoveRuleArgs = {
  scope: TtsRegexScope;
  bookId?: string;
  ruleId: string;
  direction: "up" | "down";
};

type PreviewCandidateArgs = {
  book: Book;
  scope: TtsRegexScope;
  bookId?: string;
  candidate: TtsRegexRule;
};

type TtsRegexContextValue = {
  store: TtsRegexStoreV1;
  isHydrated: boolean;
  matchMode: TtsRegexMatchMode;
  setMatchMode: (mode: TtsRegexMatchMode) => void;
  getRules: (scope: TtsRegexScope, bookId?: string) => TtsRegexRule[];
  createRule: (args: CreateRuleArgs) => TtsRegexRule;
  updateRule: (args: UpdateRuleArgs) => TtsRegexRule;
  deleteRule: (args: DeleteRuleArgs) => void;
  moveRule: (args: MoveRuleArgs) => void;
  previewCandidate: (args: PreviewCandidateArgs) => TtsRegexPreviewStats;
};

const TtsRegexContext = createContext<TtsRegexContextValue | undefined>(undefined);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMatchMode(value: unknown): value is TtsRegexMatchMode {
  return value === "token" || value === "chunk";
}

function isRuleSource(value: unknown): value is TtsRegexRuleSource {
  return value === "simple" || value === "regex";
}

function migrateSimplePattern(pattern: string): string {
  const trimmed = pattern.trim();
  const legacyBoundaryMatch = trimmed.match(/^\\b(.+)\\b$/);
  if (legacyBoundaryMatch?.[1]) {
    const legacyWord = legacyBoundaryMatch[1].replace(/\\(.)/g, "$1");
    const migrated = createSimpleWordPattern(legacyWord);
    return migrated || trimmed;
  }

  // Previously we stored simple rules as [^\w]*word[^\w]*.
  // Migrate those to boundary-safe form to avoid chunk-mode text mangling.
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

function ensureBookScope(scope: TtsRegexScope, bookId?: string): string {
  if (scope !== "book") return "";
  const normalized = (bookId ?? "").trim();
  if (!normalized) {
    throw new Error("Book scope requires a valid bookId");
  }
  return normalized;
}

function getRulesForScope(store: TtsRegexStoreV1, scope: TtsRegexScope, bookId?: string): TtsRegexRule[] {
  if (scope === "global") return store.globalRules;
  const key = ensureBookScope(scope, bookId);
  return store.bookRulesById[key] ?? [];
}

function replaceRulesForScope(
  store: TtsRegexStoreV1,
  scope: TtsRegexScope,
  bookId: string | undefined,
  rules: TtsRegexRule[]
): TtsRegexStoreV1 {
  if (scope === "global") {
    return {
      ...store,
      globalRules: rules,
    };
  }

  const key = ensureBookScope(scope, bookId);
  return {
    ...store,
    bookRulesById: {
      ...store.bookRulesById,
      [key]: rules,
    },
  };
}

function createRuleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function assertRuleValid(rule: TtsRegexRule): void {
  const result = compileRule(rule);
  if (!result.ok) {
    throw new Error(result.error);
  }
}

export function createRuleInStore(store: TtsRegexStoreV1, args: CreateRuleArgs): [TtsRegexStoreV1, TtsRegexRule] {
  const now = Date.now();
  const source = args.input.source ?? "regex";
  const normalizedPattern =
    source === "simple"
      ? migrateSimplePattern(args.input.pattern)
      : args.input.pattern.trim();
  const nextRule: TtsRegexRule = {
    id: createRuleId(),
    pattern: normalizedPattern,
    replacement: args.input.replacement,
    source,
    caseInsensitive: args.input.caseInsensitive,
    enabled: args.input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };

  assertRuleValid(nextRule);
  const rules = [...getRulesForScope(store, args.scope, args.bookId)];
  if (rules.length >= TTS_REGEX_MAX_RULES_PER_SCOPE) {
    throw new Error(`Rule limit reached (max ${TTS_REGEX_MAX_RULES_PER_SCOPE} per scope)`);
  }

  rules.push(nextRule);
  return [replaceRulesForScope(store, args.scope, args.bookId, rules), nextRule];
}

export function updateRuleInStore(store: TtsRegexStoreV1, args: UpdateRuleArgs): [TtsRegexStoreV1, TtsRegexRule] {
  const rules = [...getRulesForScope(store, args.scope, args.bookId)];
  const index = rules.findIndex((rule) => rule.id === args.ruleId);
  if (index < 0) {
    throw new Error("Rule not found");
  }

  const current = rules[index];
  if (!current) {
    throw new Error("Rule not found");
  }
  const nextSource = args.patch.source ?? current.source;
  const patchedPatternRaw =
    args.patch.pattern !== undefined ? args.patch.pattern.trim() : current.pattern;
  const nextPattern =
    nextSource === "simple"
      ? migrateSimplePattern(patchedPatternRaw)
      : patchedPatternRaw;
  const nextRule: TtsRegexRule = {
    ...current,
    pattern: nextPattern,
    replacement: args.patch.replacement ?? current.replacement,
    source: nextSource,
    caseInsensitive: args.patch.caseInsensitive ?? current.caseInsensitive,
    enabled: args.patch.enabled ?? current.enabled,
    updatedAt: Date.now(),
  };

  assertRuleValid(nextRule);
  rules[index] = nextRule;

  return [replaceRulesForScope(store, args.scope, args.bookId, rules), nextRule];
}

export function deleteRuleFromStore(store: TtsRegexStoreV1, args: DeleteRuleArgs): TtsRegexStoreV1 {
  const rules = getRulesForScope(store, args.scope, args.bookId).filter((rule) => rule.id !== args.ruleId);
  return replaceRulesForScope(store, args.scope, args.bookId, rules);
}

export function moveRuleInStore(store: TtsRegexStoreV1, args: MoveRuleArgs): TtsRegexStoreV1 {
  const rules = [...getRulesForScope(store, args.scope, args.bookId)];
  const index = rules.findIndex((rule) => rule.id === args.ruleId);
  if (index < 0) return store;

  const target = args.direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= rules.length) return store;

  const current = rules[index];
  const next = rules[target];
  if (!current || !next) return store;
  rules[index] = next;
  rules[target] = current;

  return replaceRulesForScope(store, args.scope, args.bookId, rules);
}

export function TtsRegexProvider(props: { children: ReactNode }) {
  const [store, setStore] = useState<TtsRegexStoreV1>(createDefaultTtsRegexStore);
  const [isHydrated, setIsHydrated] = useState(false);

  const persistTimerRef = useRef<number | null>(null);
  const latestStoreRef = useRef<TtsRegexStoreV1>(store);

  useEffect(() => {
    latestStoreRef.current = store;
  }, [store]);

  const persistStore = useCallback(async (value: TtsRegexStoreV1) => {
    const repository = await getBookRepository();
    await repository.putAppSetting(TTS_REGEX_SETTINGS_KEY, value);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const repository = await getBookRepository();
        const saved = await repository.getAppSetting<unknown>(TTS_REGEX_SETTINGS_KEY);
        if (cancelled) return;
        const hydrated = sanitizeTtsRegexStore(saved);
        latestStoreRef.current = hydrated;
        setStore(hydrated);
      } catch (error) {
        console.warn("Failed to load TTS regex rules:", error);
      } finally {
        if (!cancelled) {
          setIsHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = window.setTimeout(() => {
      void persistStore(store).catch((error) => {
        console.warn("Failed to persist TTS regex rules:", error);
      });
    }, 120);

    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [isHydrated, persistStore, store]);

  useEffect(() => {
    return () => {
      if (!isHydrated) return;
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      void persistStore(latestStoreRef.current).catch((error) => {
        console.warn("Failed to persist TTS regex rules:", error);
      });
    };
  }, [isHydrated, persistStore]);

  const setMatchMode = useCallback((mode: TtsRegexMatchMode) => {
    const nextStore: TtsRegexStoreV1 = {
      ...latestStoreRef.current,
      matchMode: mode,
    };
    latestStoreRef.current = nextStore;
    setStore(nextStore);
  }, []);

  const getRules = useCallback((scope: TtsRegexScope, bookId?: string): TtsRegexRule[] => {
    return getRulesForScope(store, scope, bookId);
  }, [store]);

  const createRule = useCallback((args: CreateRuleArgs): TtsRegexRule => {
    const [nextStore, created] = createRuleInStore(latestStoreRef.current, args);
    latestStoreRef.current = nextStore;
    setStore(nextStore);
    return created;
  }, []);

  const updateRule = useCallback((args: UpdateRuleArgs): TtsRegexRule => {
    const [nextStore, updated] = updateRuleInStore(latestStoreRef.current, args);
    latestStoreRef.current = nextStore;
    setStore(nextStore);
    return updated;
  }, []);

  const deleteRule = useCallback((args: DeleteRuleArgs): void => {
    const nextStore = deleteRuleFromStore(latestStoreRef.current, args);
    latestStoreRef.current = nextStore;
    setStore(nextStore);
  }, []);

  const moveRule = useCallback((args: MoveRuleArgs): void => {
    const nextStore = moveRuleInStore(latestStoreRef.current, args);
    latestStoreRef.current = nextStore;
    setStore(nextStore);
  }, []);

  const previewCandidate = useCallback((args: PreviewCandidateArgs): TtsRegexPreviewStats => {
    return previewRuleImpact(args.book, store, args.scope, args.candidate);
  }, [store]);

  const value = useMemo<TtsRegexContextValue>(
    () => ({
      store,
      isHydrated,
      matchMode: store.matchMode,
      setMatchMode,
      getRules,
      createRule,
      updateRule,
      deleteRule,
      moveRule,
      previewCandidate,
    }),
    [
      store,
      isHydrated,
      setMatchMode,
      getRules,
      createRule,
      updateRule,
      deleteRule,
      moveRule,
      previewCandidate,
    ]
  );

  return <TtsRegexContext.Provider value={value}>{props.children}</TtsRegexContext.Provider>;
}

export function useTtsRegex(): TtsRegexContextValue {
  const context = useContext(TtsRegexContext);
  if (!context) {
    throw new Error("useTtsRegex must be used within a TtsRegexProvider");
  }
  return context;
}

export const __ttsRegexContextInternals = {
  sanitizeTtsRegexStore,
  createRuleInStore,
  updateRuleInStore,
  deleteRuleFromStore,
  moveRuleInStore,
};
