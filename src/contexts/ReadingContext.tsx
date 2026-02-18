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
import type { Mode, Position } from "@/types/reading";
import { useBook } from "./BookContext";
import { getBookRepository } from "@/lib/storage/appRepository";
import type { ReadingProgressRow } from "@/types/storage";

type ReadingContextValue = {
  mode: Mode;
  position: Position;
  highlightedWord: Position | null;
  progressLoaded: boolean;
  setMode: (mode: Mode) => void;
  setPosition: (position: Position) => void;
  setHighlightedWord: (position: Position | null) => void;
  saveProgress: (overrides?: { mode?: Mode; position?: Position }) => void;
};

const ReadingContext = createContext<ReadingContextValue | undefined>(undefined);

type ProviderProps = {
  bookId: string;
  children: ReactNode;
};

const DEFAULT_POSITION: Position = {
  paragraphId: 0,
  wordIndex: 0,
};

type SavedProgressLike = Pick<ReadingProgressRow, "paragraph_id" | "word_index" | "mode"> | null;

export function resolveReadingStateFromProgress(
  paragraphIds: number[],
  saved: SavedProgressLike
): { mode: Mode; position: Position } {
  if (paragraphIds.length === 0) {
    return {
      mode: "normal",
      position: DEFAULT_POSITION,
    };
  }

  const fallbackPosition: Position = {
    paragraphId: paragraphIds[0],
    wordIndex: 0,
  };

  if (!saved) {
    return {
      mode: "normal",
      position: fallbackPosition,
    };
  }

  if (!paragraphIds.includes(saved.paragraph_id)) {
    return {
      mode: saved.mode,
      position: fallbackPosition,
    };
  }

  return {
    mode: saved.mode,
    position: {
      paragraphId: saved.paragraph_id,
      wordIndex: Math.max(0, saved.word_index),
    },
  };
}

export function ReadingProvider(props: ProviderProps) {
  const { bookId, children } = props;
  const { book } = useBook();

  const [mode, setModeState] = useState<Mode>("normal");
  const [position, setPositionState] = useState<Position>(DEFAULT_POSITION);
  const [highlightedWord, setHighlightedWordState] = useState<Position | null>(null);
  const [progressLoaded, setProgressLoaded] = useState(false);

  const modeRef = useRef<Mode>(mode);
  const positionRef = useRef<Position>(position);
  const pendingProgressRef = useRef<ReadingProgressRow | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    let cancelled = false;
    setProgressLoaded(false);

    if (!book || book.paragraphs.length === 0) return;
    const paragraphIds = book.paragraphs.map((paragraph) => paragraph.id);

    (async () => {
      try {
        const repo = await getBookRepository();
        const saved = await repo.getReadingProgress(bookId);
        if (cancelled) return;
        const resolved = resolveReadingStateFromProgress(paragraphIds, saved);
        setModeState(resolved.mode);
        setPositionState(resolved.position);
        setHighlightedWordState(null);
      } catch (error) {
        console.warn("Failed to load reading progress:", error);
        if (!cancelled) {
          const resolved = resolveReadingStateFromProgress(paragraphIds, null);
          setModeState(resolved.mode);
          setPositionState(resolved.position);
          setHighlightedWordState(null);
        }
      } finally {
        if (!cancelled) {
          setProgressLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [book, bookId]);

  const flushProgress = useCallback(async () => {
    const pending = pendingProgressRef.current;
    if (!pending) return;
    pendingProgressRef.current = null;

    try {
      const repo = await getBookRepository();
      await repo.saveReadingProgress(pending);
    } catch (error) {
      console.warn("Failed to persist reading progress:", error);
    }
  }, []);

  const scheduleProgressSave = useCallback((progress: ReadingProgressRow) => {
    pendingProgressRef.current = progress;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushProgress();
    }, 220);
  }, [flushProgress]);

  const saveProgress = useCallback((overrides?: { mode?: Mode; position?: Position }) => {
    if (!progressLoaded) return;
    if (!book || book.paragraphs.length === 0) return;

    const nextMode = overrides?.mode ?? modeRef.current;
    const nextPosition = overrides?.position ?? positionRef.current;
    const paragraphExists = book.paragraphs.some((paragraph) => paragraph.id === nextPosition.paragraphId);

    const fallbackParagraphId = book.paragraphs[0].id;
    const paragraphId = paragraphExists ? nextPosition.paragraphId : fallbackParagraphId;

    scheduleProgressSave({
      book_id: bookId,
      paragraph_id: paragraphId,
      word_index: Math.max(0, nextPosition.wordIndex),
      mode: nextMode,
      updated_at: Date.now(),
    });
  }, [book, bookId, progressLoaded, scheduleProgressSave]);

  const queueCurrentProgressForFlush = useCallback(() => {
    if (!progressLoaded) return;
    if (!book || book.paragraphs.length === 0) return;

    const currentPosition = positionRef.current;
    const currentMode = modeRef.current;
    const paragraphExists = book.paragraphs.some((paragraph) => paragraph.id === currentPosition.paragraphId);
    const fallbackParagraphId = book.paragraphs[0].id;

    pendingProgressRef.current = {
      book_id: bookId,
      paragraph_id: paragraphExists ? currentPosition.paragraphId : fallbackParagraphId,
      word_index: Math.max(0, currentPosition.wordIndex),
      mode: currentMode,
      updated_at: Date.now(),
    };
  }, [book, bookId, progressLoaded]);

  useEffect(() => {
    return () => {
      queueCurrentProgressForFlush();
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void flushProgress();
    };
  }, [flushProgress, queueCurrentProgressForFlush]);

  // Keep position valid when paragraphs are replaced (for example after a manual retry import).
  useEffect(() => {
    if (!book || book.paragraphs.length === 0) return;

    const isValid = book.paragraphs.some((p) => p.id === position.paragraphId);
    if (!isValid) {
      setPositionState({
        paragraphId: book.paragraphs[0].id,
        wordIndex: 0,
      });
    }
  }, [book, position.paragraphId]);

  const setMode = useCallback((nextMode: Mode) => {
    setModeState(nextMode);
    if (nextMode === "speed") {
      setHighlightedWordState(null);
    }
  }, []);

  const setPosition = useCallback((next: Position) => {
    setPositionState(next);
  }, []);

  const setHighlightedWord = useCallback((next: Position | null) => {
    setHighlightedWordState(next);
  }, []);

  const contextValue = useMemo(
    () => ({
      mode,
      position,
      highlightedWord,
      progressLoaded,
      setMode,
      setPosition,
      setHighlightedWord,
      saveProgress,
    }),
    [mode, position, highlightedWord, progressLoaded, setMode, setPosition, setHighlightedWord, saveProgress]
  );

  return <ReadingContext.Provider value={contextValue}>{children}</ReadingContext.Provider>;
}

export function useReading(): ReadingContextValue {
  const ctx = useContext(ReadingContext);
  if (!ctx) {
    throw new Error("useReading must be used within a ReadingProvider");
  }
  return ctx;
}
