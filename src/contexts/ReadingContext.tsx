"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type { Mode, Position } from "@/types/reading";
import { useBook } from "./BookContext";

type ReadingContextValue = {
  mode: Mode;
  position: Position;
  highlightedWord: Position | null;
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

export function ReadingProvider(props: ProviderProps) {
  const { children } = props;
  const { book } = useBook();

  const [mode, setModeState] = useState<Mode>("normal");
  const [position, setPositionState] = useState<Position>(DEFAULT_POSITION);
  const [highlightedWord, setHighlightedWordState] = useState<Position | null>(null);

  // Ensure a valid position whenever a new book is loaded.
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

  const saveProgress = useCallback(() => {
    // Intentionally no-op in prototype mode.
  }, []);

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
      setMode,
      setPosition,
      setHighlightedWord,
      saveProgress,
    }),
    [mode, position, highlightedWord, setMode, setPosition, setHighlightedWord, saveProgress]
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
