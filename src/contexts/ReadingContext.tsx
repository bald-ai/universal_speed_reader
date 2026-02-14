"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode
} from "react";
import type { Mode, Position } from "@/types/reading";
import { useBook } from "./BookContext";
import { calculatePercentComplete, findChapterForParagraph } from "@/lib/utils/bookHelpers";
import { devStoreGet, devStoreSet } from "@/lib/devStore";

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
  wordIndex: 0
};

export function ReadingProvider(props: ProviderProps) {
  const { bookId, children } = props;
  const { book } = useBook();

  const [mode, setModeState] = useState<Mode>("normal");
  const [position, setPositionState] = useState<Position>(DEFAULT_POSITION);
  const [highlightedWord, setHighlightedWordState] = useState<Position | null>(null);

  const saveTimeoutRef = useRef<number | null>(null);
  const positionRef = useRef<Position>(position);
  const modeRef = useRef<Mode>(mode);
  const bookRef = useRef(book);
  const lastChapterIndexRef = useRef<number | null>(null);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    bookRef.current = book;
  }, [book]);

  // Ensure valid initial position when book loads
  useEffect(() => {
    if (!book || book.paragraphs.length === 0) return;

    // Check if current position points to a valid paragraph
    // If we're at default (0) and book starts at 1, this will be undefined
    const isValid = book.paragraphs.some(p => p.id === position.paragraphId);
    
    if (!isValid) {
      // Default to first paragraph if current ID is invalid
      setPositionState({
        paragraphId: book.paragraphs[0].id,
        wordIndex: 0
      });
    }
  }, [book, position.paragraphId]);

  // Load last progress on mount
  useEffect(() => {
    let cancelled = false;
    devStoreGet<{
      paragraphId?: number;
      wordIndex?: number;
      mode?: Mode;
    }>(`speedreader-progress-${bookId}`).then((parsed) => {
      if (cancelled || !parsed) return;

      if (typeof parsed.paragraphId === "number") {
        setPositionState({
          paragraphId: parsed.paragraphId,
          wordIndex: parsed.wordIndex ?? 0
        });
      }
      setModeState("normal");
    }).catch(() => {
      // ignore malformed progress
    });
    return () => { cancelled = true; };
  }, [bookId]);

  const saveProgress = useCallback((overrides?: { mode?: Mode; position?: Position }) => {
    const currentBook = bookRef.current;
    if (!currentBook) return;

    const currentPosition = overrides?.position ?? positionRef.current;
    const currentMode = overrides?.mode ?? modeRef.current;
    const payload = {
      bookId,
      paragraphId: currentPosition.paragraphId,
      wordIndex: currentPosition.wordIndex,
      mode: currentMode,
      lastReadAt: Date.now(),
      percentComplete: calculatePercentComplete(currentBook, currentPosition)
    };

    // fire-and-forget
    devStoreSet(`speedreader-progress-${bookId}`, payload);
  }, [bookId]);

  const saveProgressRef = useRef(saveProgress);
  saveProgressRef.current = saveProgress;

  // Autosave in normal mode (debounced)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!book) return;

    if (mode !== "normal") {
      if (saveTimeoutRef.current != null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      return;
    }

    if (saveTimeoutRef.current != null) {
      window.clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = window.setTimeout(() => {
      saveProgressRef.current?.();
    }, 1200);

    return () => {
      if (saveTimeoutRef.current != null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [book, mode, position]);

  // Save when crossing into a new chapter
  useEffect(() => {
    if (!book) return;
    const chapter = findChapterForParagraph(book, position.paragraphId);
    const nextIndex = chapter ? chapter.index : null;
    if (lastChapterIndexRef.current === null) {
      lastChapterIndexRef.current = nextIndex;
      return;
    }
    if (nextIndex !== lastChapterIndexRef.current) {
      lastChapterIndexRef.current = nextIndex;
      saveProgressRef.current?.();
    }
  }, [book, position.paragraphId]);

  useEffect(() => {
    lastChapterIndexRef.current = null;
  }, [book?.id]);

  // Save on tab close / hide
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePageHide = () => {
      saveProgressRef.current?.();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        saveProgressRef.current?.();
      }
    };

    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const setMode = useCallback((nextMode: Mode) => {
    modeRef.current = nextMode;
    setModeState(nextMode);
    if (nextMode === "speed") {
      // Clear any existing highlight when entering speed mode
      setHighlightedWordState(null);
    }
    saveProgress({ mode: nextMode });
  }, [saveProgress]);

  const setPosition = useCallback((next: Position) => {
    positionRef.current = next;
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
      saveProgress
    }),
    [mode, position, highlightedWord, setMode, setPosition, setHighlightedWord, saveProgress]
  );

  return (
    <ReadingContext.Provider value={contextValue}>
      {children}
    </ReadingContext.Provider>
  );
}

export function useReading(): ReadingContextValue {
  const ctx = useContext(ReadingContext);
  if (!ctx) {
    throw new Error("useReading must be used within a ReadingProvider");
  }
  return ctx;
}
