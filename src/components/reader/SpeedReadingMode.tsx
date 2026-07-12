import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useBook } from "@/contexts/BookContext";
import { useReading } from "@/contexts/ReadingContext";
import { useSettings } from "@/contexts/SettingsContext";
import { stepReaderWpm } from "@/lib/constants";
import SpeedReaderWpmControls from "@/components/reader/SpeedReaderWpmControls";
import {
  advancePlaybackTempoState,
  createPlaybackTempoState,
  getRemainingPlaybackDelayMs,
  syncPlaybackTempoState,
  type PlaybackTempoState,
} from "@/lib/reader/speedReaderTempo";
import { startSpeedModeKeepAwake } from "@/lib/screenAwake";
import { findChapterForParagraph } from "@/lib/utils/bookHelpers";
import { getNextPosition, getWordAtPosition } from "@/lib/utils/bookHelpers";
import type { Position } from "@/types/reading";
import { classifyNavigationTitle, navigationKindLabel } from "@/lib/navigationHierarchy";

function splitWordMiddle(word: string): { before: string; middle: string; after: string } {
  if (!word) return { before: "", middle: "", after: "" };
  const idx = Math.max(0, Math.floor((word.length - 1) / 2));
  return {
    before: word.slice(0, idx),
    middle: word.slice(idx, idx + 1),
    after: word.slice(idx + 1),
  };
}

export default function SpeedReadingMode() {
  const { book } = useBook();
  const { position, setMode, setPosition, setHighlightedWord, saveProgress } = useReading();
  const { settings, updateSettings } = useSettings();

  const [displayedWord, setDisplayedWord] = useState<string>("");
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [showControls, setShowControls] = useState<boolean>(false);
  const [wordKey, setWordKey] = useState<number>(0);

  const positionRef = useRef<Position | null>(position);
  const playbackTempoRef = useRef<PlaybackTempoState | null>(null);
  const controlsTimeoutRef = useRef<number | null>(null);

  // Only sync positionRef from context when paused (user navigated externally)
  // During playback, positionRef is managed by the tick loop
  useEffect(() => {
    if (isPaused) {
      positionRef.current = position;
    }
  }, [position, isPaused]);

  useEffect(() => {
    const stopKeepingScreenAwake = startSpeedModeKeepAwake();
    return () => {
      stopKeepingScreenAwake();
    };
  }, []);

  useEffect(() => {
    if (!book || isPaused) return;

    const currentPosition = positionRef.current;

    if (!playbackTempoRef.current) {
      playbackTempoRef.current = createPlaybackTempoState({
        book,
        position: currentPosition,
        targetWpm: settings.wpm,
        tempo: settings.speedReaderTempo,
      });
    } else {
      syncPlaybackTempoState({
        state: playbackTempoRef.current,
        book,
        position: currentPosition,
        targetWpm: settings.wpm,
        tempo: settings.speedReaderTempo,
      });
    }

    let timeoutId: number | null = null;
    let cancelled = false;

    const clearScheduledTick = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const scheduleTick = () => {
      const playbackTempo = playbackTempoRef.current;
      if (!playbackTempo) {
        setMode("normal");
        return;
      }

      const now = performance.now();
      const remainingDelayMs = getRemainingPlaybackDelayMs({
        lastWordTime: playbackTempo.lastWordTime,
        nextDelayMs: playbackTempo.nextDelayMs,
        now,
      });

      clearScheduledTick();
      timeoutId = window.setTimeout(runTick, remainingDelayMs);
    };

    const runTick = () => {
      if (cancelled) return;

      const currentPosition = positionRef.current;
      const playbackTempo = playbackTempoRef.current;
      if (!currentPosition) {
        setMode("normal");
        return;
      }

      if (!playbackTempo) {
        setMode("normal");
        return;
      }

      const word = getWordAtPosition(book, currentPosition);
      if (!word) {
        setMode("normal");
        return;
      }

      const tickTime = performance.now();

      setDisplayedWord(word);
      setWordKey((prev) => prev + 1);
      setPosition(currentPosition);

      const nextPosition = getNextPosition(book, currentPosition);
      positionRef.current = nextPosition;

      if (!nextPosition) {
        setHighlightedWord(currentPosition);
        saveProgress({ mode: "normal", position: currentPosition });
        setMode("normal");
        return;
      }

      advancePlaybackTempoState({
        state: playbackTempo,
        book,
        currentPosition,
        currentWord: word,
        nextPosition,
        targetWpm: settings.wpm,
        tempo: settings.speedReaderTempo,
        frameTime: tickTime,
      });

      scheduleTick();
    };

    scheduleTick();

    return () => {
      cancelled = true;
      clearScheduledTick();
    };
  }, [
    book,
    isPaused,
    saveProgress,
    setHighlightedWord,
    setMode,
    setPosition,
    settings.speedReaderTempo,
    settings.wpm,
  ]);

  useEffect(() => {
    if (!showControls || isPaused) {
      if (controlsTimeoutRef.current != null) {
        window.clearTimeout(controlsTimeoutRef.current);
      }
      return;
    }

    controlsTimeoutRef.current = window.setTimeout(() => {
      setShowControls(false);
    }, 4000);

    return () => {
      if (controlsTimeoutRef.current != null) {
        window.clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [showControls, isPaused]);

  const currentChapter = useMemo(() => {
    if (!book) return null;
    return findChapterForParagraph(book, position.paragraphId);
  }, [book, position.paragraphId]);

  if (!book) return null;

  const handleToggleControls = () => {
    setShowControls((prev) => !prev);
  };

  const handleBackToNormal = () => {
    saveProgress({ mode: "normal", position });
    if (position) {
      setHighlightedWord(position);
    }
    setMode("normal");
  };

  const handlePause = () => {
    setIsPaused(true);
    setShowControls(true);
    saveProgress();
  };

  const handleResume = () => {
    setIsPaused(false);
  };



  const handleSpeedChange = (direction: "up" | "down") => {
    updateSettings({ wpm: stepReaderWpm(settings.wpm, direction) });
    setShowControls(true);
  };

  const fontFamilyClass =
    settings.fontFamily === "serif"
      ? "font-serif"
      : settings.fontFamily === "monospace"
      ? "font-mono"
      : "font-sans";

  return (
    <motion.div
      className="relative flex h-screen flex-col bg-neutral-950 text-neutral-100 overflow-hidden"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
      onClick={handleToggleControls}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-neutral-950 via-neutral-900/30 to-neutral-950 pointer-events-none" />
      
      {/* Word Display Area - always crisp and clear at base level */}
      <div className="flex-1 flex items-center justify-center relative z-10" style={{ paddingLeft: settings.horizontalPadding, paddingRight: settings.horizontalPadding }}>
        <div className={`text-4xl sm:text-6xl md:text-7xl font-semibold tracking-tight text-center ${fontFamilyClass}`}>
          <AnimatePresence mode="wait">
            {displayedWord ? (
              <motion.span
                key={wordKey}
                initial={{ opacity: 0, scale: 0.9, y: 5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 1.05, y: -5 }}
                transition={{ duration: 0.08, ease: "easeOut" }}
                className="inline-block"
              >
                {(() => {
                  if (!settings.orpHighlight) {
                    return <span>{displayedWord}</span>;
                  }
                  const { before, middle, after } = splitWordMiddle(displayedWord);
                  return (
                    <span>
                      {before}
                      <span style={{ color: settings.orpHighlightColor }}>
                        {middle}
                      </span>
                      {after}
                    </span>
                  );
                })()}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
        
        {/* Focus indicator line */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gradient-to-r from-transparent via-violet-500/20 to-transparent pointer-events-none" />
      </div>

      {/* Controls Header - positioned at top with backdrop blur */}
      <AnimatePresence>
        {showControls && (
          <motion.header 
            className="absolute top-0 left-0 right-0 z-30 px-6 pb-4"
            style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 16px)" }}
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -20, opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={(event) => event.stopPropagation()}
          >
            {/* Glassmorphism background for header only */}
            <div className="absolute inset-0 bg-gradient-to-b from-neutral-950/90 to-neutral-950/70 backdrop-blur-xl" />
            
            <div className="relative flex items-center justify-between">
              <motion.button
                type="button"
                onClick={handleBackToNormal}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900/80 
                  backdrop-blur px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 
                  transition-colors duration-150"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
                Back
              </motion.button>
              
              <div className="flex-1 mx-4 text-center truncate">
                {currentChapter ? (
                  <div className="flex flex-col items-center">
                    <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 mb-0.5">
                      {navigationKindLabel(currentChapter.kind ?? classifyNavigationTitle(currentChapter.title))}
                    </span>
                    <span className="text-sm text-neutral-200 font-medium truncate max-w-[200px]">
                      {currentChapter.title}
                    </span>
                  </div>
                ) : (
                  <span className="text-sm text-neutral-400">Speed Reading</span>
                )}
              </div>
              
              <motion.div 
                key={settings.wpm}
                initial={{ scale: 1.2 }}
                animate={{ scale: 1 }}
                className="text-sm font-medium text-violet-400 bg-violet-500/10 px-3 py-1.5 rounded-lg"
              >
                {settings.wpm} WPM
              </motion.div>
            </div>
          </motion.header>
        )}
      </AnimatePresence>

      {/* Controls Footer - minimal matching pill */}
      <AnimatePresence>
        {showControls && (
          <motion.footer
            className="absolute bottom-0 left-0 right-0 z-30 px-6 pt-4"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)" }}
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.2, delay: 0.05 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="absolute inset-0 bg-gradient-to-t from-neutral-950/95 to-neutral-950/70 backdrop-blur-xl" />

            <div className="relative flex justify-center">
              <AnimatePresence mode="wait">
                {!isPaused ? (
                  <motion.div
                    key="playing"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.15 }}
                  >
                    <SpeedReaderWpmControls
                      wpm={settings.wpm}
                      isPaused={false}
                      onDecrease={() => handleSpeedChange("down")}
                      onIncrease={() => handleSpeedChange("up")}
                      onPause={handlePause}
                      onResume={handleResume}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="paused"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.15 }}
                  >
                    <SpeedReaderWpmControls
                      wpm={settings.wpm}
                      isPaused
                      onDecrease={() => handleSpeedChange("down")}
                      onIncrease={() => handleSpeedChange("up")}
                      onPause={handlePause}
                      onResume={handleResume}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.footer>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
