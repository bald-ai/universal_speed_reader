import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBook } from "@/contexts/BookContext";
import { useReading } from "@/contexts/ReadingContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useTtsRegex } from "@/contexts/TtsRegexContext";
import type { Position } from "@/types/reading";
import type { Book, Paragraph } from "@/types/book";
import { navigationEntryAtParagraph } from "@/lib/reader/chapterSeparators";
import { classifyNavigationTitle } from "@/lib/navigationHierarchy";
import { getTokensForParagraph } from "@/lib/utils/tokenCache";
import type { TtsRegexMatchMode } from "@/types/ttsRegex";
import {
  applyRulesChunkMode,
  applyRulesTokenMode,
  compileRule,
  getActiveRules,
  type CompiledTtsRegexRule,
} from "@/lib/ttsRegex/engine";
import {
  isNativeTtsAvailable,
  speakNativeText,
  stopNativeTts,
  subscribeRangeStart,
} from "@/lib/nativeTts";

type TtsPlayerStatus = "idle" | "playing" | "paused" | "error";

type TtsContextValue = {
  status: TtsPlayerStatus;
  error: string | null;
  warning: string | null;
  isReady: boolean;

  playFrom: (pos: Position) => Promise<void>;
  pause: () => void;
  stop: () => void;
  clearError: () => void;
  clearWarning: () => void;
  jumpTo: (pos: Position) => Promise<void>;
};

const TtsContext = createContext<TtsContextValue | undefined>(undefined);

type Props = { children: ReactNode };

const MAX_UTTERANCE_CHARS = 1800;
const MAX_TRANSFORMED_CHUNK_CHARS = 5000;
export const TTS_PARAGRAPH_BREAK_PAUSE_MS = 280;
export const TTS_SCENE_BREAK_PAUSE_MS = 650;
export const TTS_CHAPTER_BREAK_PAUSE_MS = 1_000;

export function ttsPauseBeforeParagraph(
  book: Pick<Book, "chapters">,
  paragraph: Pick<Paragraph, "id" | "sceneBreakBefore">,
  isStartingParagraph: boolean,
): number {
  if (isStartingParagraph) return 0;
  const navigationEntry = navigationEntryAtParagraph(book, paragraph.id);
  if (navigationEntry) {
    const kind = navigationEntry.kind ?? classifyNavigationTitle(navigationEntry.title);
    return kind === "scene" || kind === "section"
      ? TTS_SCENE_BREAK_PAUSE_MS
      : TTS_CHAPTER_BREAK_PAUSE_MS;
  }
  if (paragraph.sceneBreakBefore) return TTS_SCENE_BREAK_PAUSE_MS;
  return TTS_PARAGRAPH_BREAK_PAUSE_MS;
}

export function waitForTtsPause(
  pauseMs: number,
  schedule: (callback: () => void, delayMs: number) => unknown = (callback, delayMs) =>
    window.setTimeout(callback, delayMs),
): Promise<void> {
  if (pauseMs <= 0) return Promise.resolve();
  return new Promise((resolve) => { schedule(resolve, pauseMs); });
}
const TTS_DEBUG_PREFIX = "[TTS DEBUG]";
const TTS_DEBUG_ENABLED = import.meta.env.DEV;

function formatTtsDebugPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "{\"error\":\"Failed to stringify TTS debug payload\"}";
  }
}

function logTtsDebug(label: string, payload: Record<string, unknown>): void {
  if (!TTS_DEBUG_ENABLED) return;
  console.warn(`${TTS_DEBUG_PREFIX} ${label} ${formatTtsDebugPayload(payload)}`);
}

export type SpokenRange = {
  start: number;
  end: number;
  position: Position;
};

export type SpokenChunk = {
  text: string;
  ranges: SpokenRange[];
  startPosition: Position;
  pauseBeforeMs: number;
};

export type ChunkedSpeech = { chunks: SpokenChunk[]; startPosition: Position };

type TransformSpokenChunkResult = {
  text: string;
  ranges: SpokenRange[];
  warning: string | null;
};

type TransformSpokenChunkInput = {
  chunk: SpokenChunk;
  mode: TtsRegexMatchMode;
  compiledRules: CompiledTtsRegexRule[];
  maxChars: number;
};

function isSamePosition(a: Position, b: Position): boolean {
  return a.paragraphId === b.paragraphId && a.wordIndex === b.wordIndex;
}

function getTokenByPosition(ranges: SpokenRange[], text: string, position: Position): string | null {
  const range = ranges.find((item) => isSamePosition(item.position, position));
  if (!range) return null;
  return text.slice(range.start, range.end);
}

function getFirstToken(text: string): string {
  const [first = ""] = text.split(/\s+/);
  return first;
}

function getMatchingCompiledRuleForToken(
  token: string | null,
  rules: CompiledTtsRegexRule[]
): CompiledTtsRegexRule | null {
  if (!token) return null;
  for (const rule of rules) {
    rule.tokenRegex.lastIndex = 0;
    if (rule.tokenRegex.test(token)) {
      return rule;
    }
  }
  return null;
}

function findPositionByCharIndex(ranges: SpokenRange[], index: number): Position | null {
  if (ranges.length === 0) return null;

  let lo = 0;
  let hi = ranges.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (!r) return null;

    if (index < r.start) {
      hi = mid - 1;
      continue;
    }
    if (index >= r.end) {
      lo = mid + 1;
      continue;
    }
    return r.position;
  }

  const nearest = ranges[Math.max(0, Math.min(ranges.length - 1, lo - 1))];
  return nearest?.position ?? null;
}

function mapSpeakError(message: string): string {
  const m = message.trim();
  const lower = m.toLowerCase();

  if (lower.includes("failed to read text")) {
    return "Failed to read text. Usually this means Android TTS voice data is missing or broken.";
  }
  if (lower.includes("language") && lower.includes("supported")) {
    return "Selected language is not supported by this device TTS engine.";
  }
  if (m.length > 0) return m;
  return "Could not start speech";
}

function rebuildChunkFromTokens(chunk: SpokenChunk, tokens: string[]): { text: string; ranges: SpokenRange[] } {
  if (tokens.length === 0 || chunk.ranges.length === 0) {
    return {
      text: chunk.text,
      ranges: chunk.ranges,
    };
  }

  const parts: string[] = [];
  const ranges: SpokenRange[] = [];
  let cursor = 0;

  for (let i = 0; i < chunk.ranges.length; i += 1) {
    const token = tokens[i] ?? "";
    const current = chunk.ranges[i];
    if (!current) continue;
    const prev = chunk.ranges[i - 1];

    let separator = "";
    if (prev) {
      separator = prev.position.paragraphId === current.position.paragraphId ? " " : "\n";
    }

    if (separator) {
      parts.push(separator);
      cursor += separator.length;
    }

    const start = cursor;
    parts.push(token);
    cursor += token.length;
    ranges.push({
      start,
      end: cursor,
      position: current.position,
    });
  }

  return {
    text: parts.join(""),
    ranges,
  };
}

export function transformSpokenChunk(input: TransformSpokenChunkInput): TransformSpokenChunkResult {
  const { chunk, mode, compiledRules, maxChars } = input;

  if (compiledRules.length === 0) {
    return {
      text: chunk.text,
      ranges: chunk.ranges,
      warning: null,
    };
  }

  if (mode === "token") {
    const tokens = chunk.ranges.map((range) => chunk.text.slice(range.start, range.end));
    const { spokenTokens, stats } = applyRulesTokenMode(tokens, compiledRules);

    if (stats.totalMatches <= 0) {
      return {
        text: chunk.text,
        ranges: chunk.ranges,
        warning: null,
      };
    }

    const rebuilt = rebuildChunkFromTokens(chunk, spokenTokens);
    if (rebuilt.text.length > maxChars) {
      return {
        text: chunk.text,
        ranges: chunk.ranges,
        warning: `Spoken text was too long after replacements (${rebuilt.text.length} chars). Original text was used for this chunk.`,
      };
    }

    return {
      text: rebuilt.text,
      ranges: rebuilt.ranges,
      warning: null,
    };
  }

  const { spokenText, stats } = applyRulesChunkMode(chunk.text, compiledRules);
  if (stats.totalMatches <= 0) {
    return {
      text: chunk.text,
      ranges: chunk.ranges,
      warning: null,
    };
  }

  if (spokenText.length > maxChars) {
    return {
      text: chunk.text,
      ranges: [],
      warning: `Spoken text was too long after replacements (${spokenText.length} chars). Original text was used for this chunk.`,
    };
  }

  return {
    text: spokenText,
    ranges: [],
    warning: null,
  };
}

export function buildTtsSpeechChunks(book: Book, start: Position): ChunkedSpeech | null {
  if (book.paragraphs.length === 0) return null;

  const paragraphIndexById = new Map<number, number>();
  for (let index = 0; index < book.paragraphs.length; index += 1) {
    paragraphIndexById.set(book.paragraphs[index].id, index);
  }

  const startParagraphIndex = paragraphIndexById.get(start.paragraphId) ?? 0;
  const chunks: SpokenChunk[] = [];
  let currentParts: string[] = [];
  let currentRanges: SpokenRange[] = [];
  let cursor = 0;
  let currentPauseBeforeMs = 0;

  const finalizeChunk = () => {
    const first = currentRanges[0];
    if (!first) return;
    chunks.push({
      text: currentParts.join(""),
      ranges: currentRanges,
      startPosition: first.position,
      pauseBeforeMs: currentPauseBeforeMs,
    });
    currentParts = [];
    currentRanges = [];
    cursor = 0;
    currentPauseBeforeMs = 0;
  };

  for (let paragraphIndex = startParagraphIndex; paragraphIndex < book.paragraphs.length; paragraphIndex += 1) {
    const paragraph = book.paragraphs[paragraphIndex];
    const tokens = getTokensForParagraph(book, paragraph);
    const wordStart = paragraphIndex === startParagraphIndex ? Math.max(0, start.wordIndex) : 0;
    if (wordStart >= tokens.length) continue;

    if (paragraphIndex > startParagraphIndex) {
      finalizeChunk();
      currentPauseBeforeMs = ttsPauseBeforeParagraph(book, paragraph, false);
    }

    for (let wordIndex = wordStart; wordIndex < tokens.length; wordIndex += 1) {
      const word = tokens[wordIndex]?.trim();
      if (!word) continue;
      const separator = currentParts.length > 0 ? " " : "";
      if (cursor + separator.length + word.length > MAX_UTTERANCE_CHARS && currentRanges.length > 0) {
        finalizeChunk();
      }
      if (currentParts.length > 0) {
        currentParts.push(" ");
        cursor += 1;
      }
      const startChar = cursor;
      currentParts.push(word);
      cursor += word.length;
      currentRanges.push({
        start: startChar,
        end: cursor,
        position: { paragraphId: paragraph.id, wordIndex },
      });
    }
  }

  finalizeChunk();
  const firstChunk = chunks[0];
  return firstChunk ? { chunks, startPosition: firstChunk.startPosition } : null;
}

export function TtsProvider(props: Props) {
  const { children } = props;
  const { book } = useBook();
  const { setHighlightedWord, setPosition, saveProgress } = useReading();
  const { settings } = useSettings();
  const { store: ttsRegexStore } = useTtsRegex();

  const [isReady, setIsReady] = useState(false);
  const [status, setStatus] = useState<TtsPlayerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const speakSessionRef = useRef(0);
  const isPlayingRef = useRef(false);
  const spokenRangesRef = useRef<SpokenRange[]>([]);
  const matchModeRef = useRef<TtsRegexMatchMode>("token");

  const activeRules = useMemo(() => {
    if (!book) return [];
    return getActiveRules(ttsRegexStore, book.id);
  }, [book, ttsRegexStore]);

  const activeRuleById = useMemo(() => {
    const byId = new Map<string, (typeof activeRules)[number]>();
    for (const rule of activeRules) {
      byId.set(rule.id, rule);
    }
    return byId;
  }, [activeRules]);

  const compiledRules = useMemo<CompiledTtsRegexRule[]>(() => {
    if (!book) return [];
    const compiled: CompiledTtsRegexRule[] = [];

    for (const rule of activeRules) {
      const result = compileRule(rule);
      if (result.ok) {
        compiled.push(result.compiled);
      }
    }

    return compiled;
  }, [activeRules, book]);

  useEffect(() => {
    matchModeRef.current = ttsRegexStore.matchMode;
  }, [ttsRegexStore.matchMode]);

  const cancelPlayback = useCallback(() => {
    speakSessionRef.current += 1;
    isPlayingRef.current = false;
    void stopNativeTts();
  }, []);

  const buildChunkedSpeechFromPosition = useCallback(
    (start: Position): ChunkedSpeech | null => book ? buildTtsSpeechChunks(book, start) : null,
    [book]
  );

  const stop = useCallback(() => {
    cancelPlayback();
    setStatus("idle");
    saveProgress();
  }, [cancelPlayback, saveProgress]);

  const pause = useCallback(() => {
    cancelPlayback();
    setStatus("paused");
  }, [cancelPlayback]);

  const clearError = useCallback(() => {
    setError(null);
    setStatus("idle");
  }, []);

  const clearWarning = useCallback(() => {
    setWarning(null);
  }, []);

  const playFrom = useCallback(
    async (pos: Position) => {
      setError(null);
      setWarning(null);

      let ready = isReady;
      if (!ready) {
        ready = await isNativeTtsAvailable();
        setIsReady(ready);
      }
      if (!ready) {
        setStatus("error");
        setError("TTS engine is unavailable on this device");
        return;
      }

      const payload = buildChunkedSpeechFromPosition(pos);
      if (!payload) {
        setStatus("error");
        setError("No readable text from this position");
        return;
      }

      cancelPlayback();

      const sessionId = speakSessionRef.current;
      isPlayingRef.current = true;
      setHighlightedWord(payload.startPosition);
      setPosition(payload.startPosition);
      setStatus("playing");

      try {
        let hasShownReplacementWarning = false;
        for (const chunk of payload.chunks) {
          if (speakSessionRef.current !== sessionId) return;

          if (chunk.pauseBeforeMs > 0) {
            await waitForTtsPause(chunk.pauseBeforeMs);
            if (speakSessionRef.current !== sessionId) return;
          }

          const transformed = transformSpokenChunk({
            chunk,
            mode: ttsRegexStore.matchMode,
            compiledRules,
            maxChars: MAX_TRANSFORMED_CHUNK_CHARS,
          });

          if (!hasShownReplacementWarning && transformed.warning) {
            hasShownReplacementWarning = true;
            setWarning(transformed.warning);
          }

          spokenRangesRef.current = transformed.ranges;
          if (ttsRegexStore.matchMode === "chunk") {
            setHighlightedWord(chunk.startPosition);
            setPosition(chunk.startPosition);
          }

          const originalStartToken = getTokenByPosition(chunk.ranges, chunk.text, chunk.startPosition);
          const spokenStartToken =
            getTokenByPosition(transformed.ranges, transformed.text, chunk.startPosition) ||
            getFirstToken(transformed.text);
          const matchingCompiledRule =
            ttsRegexStore.matchMode === "token"
              ? getMatchingCompiledRuleForToken(originalStartToken, compiledRules)
              : null;
          const matchingRule = matchingCompiledRule
            ? activeRuleById.get(matchingCompiledRule.id) ?? null
            : null;

          const aboutToSpeakPayload = {
            mode: ttsRegexStore.matchMode,
            sessionId,
            startPosition: chunk.startPosition,
            sourceWordAtStart: originalStartToken,
            spokenWordAtStart: spokenStartToken,
            matchingRule: matchingRule
              ? {
                  id: matchingRule.id,
                  source: matchingRule.source,
                  pattern: matchingRule.pattern,
                  replacement: matchingRule.replacement,
                  caseInsensitive: matchingRule.caseInsensitive,
                }
              : null,
            exactTextSentToNative: transformed.text,
          };
          logTtsDebug("about to speak", aboutToSpeakPayload);

          await speakNativeText({
            text: transformed.text,
            rate: settings.ttsPlaybackRate,
            lang: settings.ttsLanguage || "en-US",
            voice: settings.ttsVoiceIndex,
            queueStrategy: "flush",
          });
        }

        if (speakSessionRef.current !== sessionId) return;
        isPlayingRef.current = false;
        setStatus("idle");
        saveProgress();
      } catch (e) {
        if (speakSessionRef.current !== sessionId) return;
        isPlayingRef.current = false;
        setStatus("error");
        const raw = e instanceof Error ? e.message : String(e);
        setError(mapSpeakError(raw));
      }
    },
    [
      buildChunkedSpeechFromPosition,
      isReady,
      saveProgress,
      setHighlightedWord,
      setPosition,
      compiledRules,
      settings.ttsLanguage,
      settings.ttsPlaybackRate,
      settings.ttsVoiceIndex,
      cancelPlayback,
      ttsRegexStore.matchMode,
      activeRuleById,
    ]
  );

  const jumpTo = useCallback(
    async (pos: Position) => {
      if (!isReady) return;
      if (status === "playing") {
        await playFrom(pos);
        return;
      }
      setHighlightedWord(pos);
      setPosition(pos);
    },
    [isReady, playFrom, setHighlightedWord, setPosition, status]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const available = await isNativeTtsAvailable();
      if (!cancelled) {
        setIsReady(available);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let unsubscribe: (() => void) | null = null;

    (async () => {
      const unsubscribeNow = await subscribeRangeStart((info) => {
        if (closed || !isPlayingRef.current) return;
        if (matchModeRef.current === "chunk") return;

        const position = findPositionByCharIndex(spokenRangesRef.current, info.start);
        if (!position) return;

        const nativeRangePayload = {
          start: info.start,
          end: info.end,
          spokenWord: info.spokenWord,
          mappedPosition: position,
        };
        logTtsDebug("native range start", nativeRangePayload);

        setHighlightedWord(position);
        setPosition(position);
      });
      if (closed) {
        unsubscribeNow();
        return;
      }
      unsubscribe = unsubscribeNow;
    })();

    return () => {
      closed = true;
      unsubscribe?.();
    };
  }, [setHighlightedWord, setPosition]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && status === "playing") {
        stop();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [status, stop]);

  useEffect(() => {
    return () => {
      speakSessionRef.current += 1;
      isPlayingRef.current = false;
      void stopNativeTts();
    };
  }, []);

  const value = useMemo<TtsContextValue>(
    () => ({
      status,
      error,
      warning,
      isReady,
      playFrom,
      pause,
      stop,
      clearError,
      clearWarning,
      jumpTo,
    }),
    [status, error, warning, isReady, playFrom, pause, stop, clearError, clearWarning, jumpTo]
  );

  return <TtsContext.Provider value={value}>{children}</TtsContext.Provider>;
}

export function useTts(): TtsContextValue {
  const ctx = useContext(TtsContext);
  if (!ctx) throw new Error("useTts must be used within a TtsProvider");
  return ctx;
}
