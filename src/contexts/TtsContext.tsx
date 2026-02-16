"use client";

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
import type { Position } from "@/types/reading";
import { getTokensForParagraph } from "@/lib/utils/tokenCache";
import {
  isNativeTtsAvailable,
  speakNativeText,
  stopNativeTts,
  subscribeRangeStart,
} from "@/lib/nativeTts";

type TtsPlayerStatus = "idle" | "playing" | "error";

type TtsContextValue = {
  status: TtsPlayerStatus;
  error: string | null;
  isReady: boolean;

  playFrom: (pos: Position) => Promise<void>;
  stop: () => void;
  jumpTo: (pos: Position) => Promise<void>;
};

const TtsContext = createContext<TtsContextValue | undefined>(undefined);

type Props = { children: ReactNode };

const MAX_UTTERANCE_CHARS = 1800;

type SpokenRange = {
  start: number;
  end: number;
  position: Position;
};

type SpokenChunk = {
  text: string;
  ranges: SpokenRange[];
  startPosition: Position;
};

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

export function TtsProvider(props: Props) {
  const { children } = props;
  const { book } = useBook();
  const { setHighlightedWord, setPosition, saveProgress } = useReading();
  const { settings } = useSettings();

  const [isReady, setIsReady] = useState(false);
  const [status, setStatus] = useState<TtsPlayerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const speakSessionRef = useRef(0);
  const isPlayingRef = useRef(false);
  const spokenRangesRef = useRef<SpokenRange[]>([]);

  const buildChunkedSpeechFromPosition = useCallback(
    (start: Position): { chunks: SpokenChunk[]; startPosition: Position } | null => {
      if (!book || book.paragraphs.length === 0) return null;

      const paragraphIndexById = new Map<number, number>();
      for (let i = 0; i < book.paragraphs.length; i += 1) {
        paragraphIndexById.set(book.paragraphs[i].id, i);
      }

      const startParagraphIndex = paragraphIndexById.get(start.paragraphId) ?? 0;
      const chunks: SpokenChunk[] = [];

      let currentParts: string[] = [];
      let currentRanges: SpokenRange[] = [];
      let cursor = 0;
      let emittedWords = 0;
      let lastParagraphId: number | null = null;

      const finalizeChunk = () => {
        if (currentRanges.length === 0) return;
        const first = currentRanges[0];
        if (!first) return;

        chunks.push({
          text: currentParts.join(""),
          ranges: currentRanges,
          startPosition: first.position,
        });
        currentParts = [];
        currentRanges = [];
        cursor = 0;
      };

      for (let p = startParagraphIndex; p < book.paragraphs.length; p += 1) {
        const paragraph = book.paragraphs[p];
        const tokens = getTokensForParagraph(book, paragraph);
        const wordStart = p === startParagraphIndex ? Math.max(0, start.wordIndex) : 0;

        for (let w = wordStart; w < tokens.length; w += 1) {
          const word = tokens[w]?.trim();
          if (!word) continue;

          const position: Position = { paragraphId: paragraph.id, wordIndex: w };
          let separator = "";
          if (emittedWords > 0) {
            separator = lastParagraphId === paragraph.id ? " " : "\n";
          }

          const candidateLen = separator.length + word.length;
          if (cursor + candidateLen > MAX_UTTERANCE_CHARS && currentRanges.length > 0) {
            finalizeChunk();
            separator = "";
          }

          if (separator && currentParts.length > 0) {
            currentParts.push(separator);
            cursor += separator.length;
          }

          const startChar = cursor;
          currentParts.push(word);
          cursor += word.length;
          currentRanges.push({ start: startChar, end: cursor, position });

          emittedWords += 1;
          lastParagraphId = paragraph.id;
        }
      }

      finalizeChunk();

      if (chunks.length === 0) return null;
      const firstChunk = chunks[0];
      if (!firstChunk) return null;

      return { chunks, startPosition: firstChunk.startPosition };
    },
    [book]
  );

  const stop = useCallback(() => {
    speakSessionRef.current += 1;
    isPlayingRef.current = false;
    void stopNativeTts();
    setStatus("idle");
    saveProgress();
  }, [saveProgress]);

  const playFrom = useCallback(
    async (pos: Position) => {
      setError(null);

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

      stop();

      const sessionId = speakSessionRef.current;
      isPlayingRef.current = true;
      setHighlightedWord(payload.startPosition);
      setPosition(payload.startPosition);
      setStatus("playing");

      try {
        for (const chunk of payload.chunks) {
          if (speakSessionRef.current !== sessionId) return;

          spokenRangesRef.current = chunk.ranges;

          await speakNativeText({
            text: chunk.text,
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
      settings.ttsLanguage,
      settings.ttsPlaybackRate,
      settings.ttsVoiceIndex,
      stop,
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
      unsubscribe = await subscribeRangeStart((info) => {
        if (closed || !isPlayingRef.current) return;

        const position = findPositionByCharIndex(spokenRangesRef.current, info.start);
        if (!position) return;

        setHighlightedWord(position);
        setPosition(position);
      });
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
      isReady,
      playFrom,
      stop,
      jumpTo,
    }),
    [status, error, isReady, playFrom, stop, jumpTo]
  );

  return <TtsContext.Provider value={value}>{children}</TtsContext.Provider>;
}

export function useTts(): TtsContextValue {
  const ctx = useContext(TtsContext);
  if (!ctx) throw new Error("useTts must be used within a TtsProvider");
  return ctx;
}
