import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useBook } from "@/contexts/BookContext";
import { useReading } from "@/contexts/ReadingContext";
import { useSettings } from "@/contexts/SettingsContext";
import { findChapterForParagraph } from "@/lib/utils/bookHelpers";
import { getNextPosition, getWordAtPosition } from "@/lib/utils/bookHelpers";
import type { Position } from "@/types/reading";

function calculateDelayForWord(targetWpm: number, rampIndex: number, rampUpWords = 25): number {
  const clampedWpm = Math.max(100, Math.min(600, targetWpm));
  const startWpm = clampedWpm * 0.7;

  let currentWpm: number;
  if (rampIndex < rampUpWords) {
    const increment = (clampedWpm - startWpm) / Math.max(1, rampUpWords - 1);
    currentWpm = startWpm + increment * rampIndex;
  } else {
    currentWpm = clampedWpm;
  }

  const delay = Math.round(60000 / currentWpm);
  return delay;
}

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
  const controlsTimeoutRef = useRef<number | null>(null);

  // Only sync positionRef from context when paused (user navigated externally)
  // During playback, positionRef is managed by the tick loop
  useEffect(() => {
    if (isPaused) {
      positionRef.current = position;
    }
  }, [position, isPaused]);

  useEffect(() => {
    if (!book || isPaused) return;

    let frameId: number;
    let lastWordTime = performance.now();
    let rampIndex = 0;

    const tick = (time: number) => {
      const currentPosition = positionRef.current;
      if (!currentPosition) {
        setMode("normal");
        return;
      }

      const delay = calculateDelayForWord(settings.wpm, rampIndex);

      if (time - lastWordTime >= delay) {
        lastWordTime = time;
        rampIndex++;

        const word = getWordAtPosition(book, currentPosition);
        if (!word) {
          setMode("normal");
          return;
        }

        setDisplayedWord(word);
        setWordKey((prev) => prev + 1);
        setPosition(currentPosition);

        const nextPosition = getNextPosition(book, currentPosition);
        positionRef.current = nextPosition;

        if (!nextPosition) {
          setHighlightedWord(currentPosition);
          setMode("normal");
          return;
        }
      }

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [book, isPaused, settings.wpm, setMode, setPosition, setHighlightedWord]);

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

  const handleSwitchToNormalMode = () => {
    // Use position state (current displayed word) instead of positionRef (next position)
    if (position) {
      setHighlightedWord(position);
    }
    setMode("normal");
  };

  const handleSpeedChange = (direction: "up" | "down") => {
    const current = settings.wpm;
    const factor = direction === "up" ? 1.1 : 0.9;
    const raw = current * factor;
    const rounded = Math.round(raw / 5) * 5;
    const clamped = Math.max(100, Math.min(600, rounded));
    updateSettings({ wpm: clamped });
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
      onClick={handleToggleControls}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-neutral-950 via-neutral-900/30 to-neutral-950 pointer-events-none" />
      
      {/* Word Display Area - always crisp and clear at base level */}
      <div className="flex-1 flex items-center justify-center px-6 relative z-10">
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
            className="absolute top-0 left-0 right-0 z-30 px-6 pt-6 pb-4"
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
                      Chapter {currentChapter.index + 1}
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

      {/* Controls Footer - positioned at bottom with backdrop blur */}
      <AnimatePresence>
        {showControls && (
          <motion.footer 
            className="absolute bottom-0 left-0 right-0 z-30 px-6 pb-8 pt-4"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.2, delay: 0.05 }}
            onClick={(event) => event.stopPropagation()}
          >
            {/* Glassmorphism background for footer only */}
            <div className="absolute inset-0 bg-gradient-to-t from-neutral-950/95 to-neutral-950/70 backdrop-blur-xl" />
            
            <div className="relative">
              <AnimatePresence mode="wait">
                {!isPaused ? (
                  <motion.div
                    key="playing"
                    className="flex items-center justify-center gap-4"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.15 }}
                  >
                    {/* Speed Down */}
                    <motion.button
                      type="button"
                      onClick={() => handleSpeedChange("down")}
                      whileHover={{ scale: 1.05, y: -2 }}
                      whileTap={{ scale: 0.95 }}
                      className="w-14 h-14 flex items-center justify-center rounded-2xl 
                        border border-neutral-700/80 bg-neutral-900/80 backdrop-blur text-neutral-300 
                        hover:bg-neutral-800 hover:border-neutral-600 hover:text-neutral-100 
                        transition-colors duration-150 shadow-lg shadow-black/20"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
                      </svg>
                    </motion.button>

                    {/* Pause Button */}
                    <motion.button
                      type="button"
                      onClick={handlePause}
                      whileHover={{ scale: 1.05, y: -2 }}
                      whileTap={{ scale: 0.95 }}
                      className="relative w-16 h-16 flex items-center justify-center rounded-2xl 
                        bg-gradient-to-br from-amber-400 to-orange-500 text-neutral-900 
                        shadow-xl shadow-orange-500/30 hover:shadow-orange-500/50 
                        transition-all duration-200"
                    >
                      {/* Pulse ring when active */}
                      <motion.div
                        className="absolute inset-0 rounded-2xl bg-amber-400/30"
                        animate={{
                          scale: [1, 1.2, 1],
                          opacity: [0.5, 0, 0.5],
                        }}
                        transition={{
                          duration: 2,
                          repeat: Infinity,
                          ease: "easeInOut",
                        }}
                      />
                      <svg className="w-7 h-7 relative z-10" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                      </svg>
                    </motion.button>

                    {/* Speed Up */}
                    <motion.button
                      type="button"
                      onClick={() => handleSpeedChange("up")}
                      whileHover={{ scale: 1.05, y: -2 }}
                      whileTap={{ scale: 0.95 }}
                      className="w-14 h-14 flex items-center justify-center rounded-2xl 
                        border border-neutral-700/80 bg-neutral-900/80 backdrop-blur text-neutral-300 
                        hover:bg-neutral-800 hover:border-neutral-600 hover:text-neutral-100 
                        transition-colors duration-150 shadow-lg shadow-black/20"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                    </motion.button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="paused"
                    className="flex items-center justify-center gap-4"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.15 }}
                  >
                    {/* Switch to Read Mode */}
                    <motion.button
                      type="button"
                      onClick={handleSwitchToNormalMode}
                      whileHover={{ scale: 1.03, y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      className="flex items-center gap-2 rounded-xl border border-neutral-700/80 
                        bg-neutral-900/80 backdrop-blur px-5 py-3.5 text-sm text-neutral-300 
                        hover:bg-neutral-800 hover:text-neutral-100 transition-colors duration-150 
                        shadow-lg shadow-black/20"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
                      </svg>
                      Read
                    </motion.button>

                    {/* Resume Button */}
                    <motion.button
                      type="button"
                      onClick={handleResume}
                      whileHover={{ scale: 1.03, y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 
                        px-6 py-3.5 text-sm font-semibold text-neutral-900 
                        shadow-xl shadow-emerald-500/30 hover:shadow-emerald-500/50 
                        transition-all duration-200"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
                      </svg>
                      Resume
                    </motion.button>
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
