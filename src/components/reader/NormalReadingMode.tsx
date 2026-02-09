import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useBook } from "@/contexts/BookContext";
import { useReading } from "@/contexts/ReadingContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useTts } from "@/contexts/TtsContext";
import SettingsModal from "@/components/reader/SettingsModal";
import ChapterMenu from "@/components/reader/ChapterMenu";
import ProgressBar from "@/components/shared/ProgressBar";
import TtsMiniBar from "@/components/reader/TtsMiniBar";

import { getTokensForParagraph, getWordCountForParagraph } from "@/lib/utils/tokenCache";
import type { Chapter, Paragraph } from "@/types/book";
import type { Position } from "@/types/reading";

type ParagraphRowProps = {
  paragraph: Paragraph;
  words: string[];
  highlightedWordIndex: number | null;
  onWordClick: (paragraphId: number, wordIndex: number) => void;
  wordClicksDisabled: boolean;
  fontSizeClass: string;
  fontFamilyClass: string;
};

const ParagraphRow = memo(function ParagraphRow({
  paragraph,
  words,
  highlightedWordIndex,
  onWordClick,
  wordClicksDisabled,
  fontSizeClass,
  fontFamilyClass,
}: ParagraphRowProps) {
  return (
    <div className={`${fontFamilyClass} ${fontSizeClass} leading-relaxed text-neutral-300 text-left`}>
      {words.map((word, index) => {
        const isHighlighted = highlightedWordIndex === index;
        return (
          <span
            key={index}
            data-word-index={index}
            data-paragraph-id={paragraph.id}
            onClick={wordClicksDisabled ? undefined : () => onWordClick(paragraph.id, index)}
            className={`rounded-sm transition-colors duration-150 ${
              isHighlighted
                ? "bg-amber-300/90 text-neutral-900 shadow-[0_0_0_2px_rgba(253,224,71,0.9)] z-10 relative"
                : wordClicksDisabled
                  ? "cursor-not-allowed"
                  : "cursor-pointer hover:bg-neutral-800/70"
            }`}
          >
            {word}
            {index < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </div>
  );
});

export default function NormalReadingMode() {
  const [, setLocation] = useLocation();
  const { book } = useBook();
  const { position, highlightedWord, setMode, setPosition, setHighlightedWord, saveProgress } = useReading();
  const { settings } = useSettings();
  const tts = useTts();

  const [showSettings, setShowSettings] = useState(false);
  const [showChapterMenu, setShowChapterMenu] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isTtsBarOpen, setIsTtsBarOpen] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToInitialPosition = useRef(false);
  const lastScrollUpdateRef = useRef<number>(0);
  const initialScrollTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!highlightedWord) {
      setIsTtsBarOpen(false);
    }
  }, [highlightedWord]);

  const fontSizeClass = useMemo(() => {
    switch (settings.fontSize) {
      case "small":
        return "text-sm";
      case "large":
        return "text-xl";
      case "xl":
        return "text-2xl";
      case "medium":
      default:
        return "text-base";
    }
  }, [settings.fontSize]);

  const fontFamilyClass = useMemo(() => {
    switch (settings.fontFamily) {
      case "serif":
        return "font-serif";
      case "monospace":
        return "font-mono";
      case "sans-serif":
      default:
        return "font-sans";
    }
  }, [settings.fontFamily]);

  const paragraphIndexById = useMemo(() => {
    if (!book) return new Map<number, number>();
    const map = new Map<number, number>();
    book.paragraphs.forEach((p, i) => map.set(p.id, i));
    return map;
  }, [book]);

  const chapterIndexByParagraphId = useMemo(() => {
    if (!book) return [];
    const mapping = new Array<number>(book.paragraphs.length).fill(0);
    for (let i = 0; i < book.chapters.length; i += 1) {
      const chapter = book.chapters[i];
      const nextStart =
        i + 1 < book.chapters.length
          ? book.chapters[i + 1].startParagraphId
          : book.paragraphs.length;
      const start = Math.max(0, chapter.startParagraphId);
      const end = Math.min(nextStart, book.paragraphs.length);
      for (let p = start; p < end; p += 1) {
        mapping[p] = chapter.index;
      }
    }
    return mapping;
  }, [book]);

  const currentChapterIndex = useMemo(() => {
    if (!book || chapterIndexByParagraphId.length === 0) {
      return null;
    }
    return chapterIndexByParagraphId[position.paragraphId] ?? null;
  }, [book, chapterIndexByParagraphId, position.paragraphId]);

  const currentChapter: Chapter | null = useMemo(() => {
    if (!book || currentChapterIndex === null) return null;
    return book.chapters[currentChapterIndex] ?? null;
  }, [book, currentChapterIndex]);

  const cumulativeWordCounts = useMemo(() => {
    if (!book) return [];
    const totals: number[] = new Array(book.paragraphs.length);
    let runningTotal = 0;
    for (let i = 0; i < book.paragraphs.length; i += 1) {
      const paragraph = book.paragraphs[i];
      runningTotal += getWordCountForParagraph(book, paragraph);
      totals[i] = runningTotal;
    }
    return totals;
  }, [book]);

  const progressPercent = useMemo(() => {
    if (!book || cumulativeWordCounts.length === 0 || !book.totalWords) {
      return 0;
    }

    const paragraphIndex = position.paragraphId;
    if (paragraphIndex < 0 || paragraphIndex >= cumulativeWordCounts.length) {
      return 0;
    }

    const wordsBefore = paragraphIndex > 0 ? cumulativeWordCounts[paragraphIndex - 1] : 0;
    const wordsInParagraph = cumulativeWordCounts[paragraphIndex] - wordsBefore;
    const clampedIndex = Math.max(0, Math.min(wordsInParagraph, position.wordIndex));
    const percent = Math.max(
      0,
      Math.min(100, Math.round(((wordsBefore + clampedIndex) / book.totalWords) * 100))
    );

    return percent;
  }, [book, cumulativeWordCounts, position.paragraphId, position.wordIndex]);

  const rowVirtualizer = useVirtualizer({
    count: book?.paragraphs.length ?? 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 80,
    overscan: 10,
  });

  const findAndScrollToWord = useCallback((target: Position, attempt = 0) => {
    if (attempt > 20) return; // Max retries

    const wordEl = scrollContainerRef.current?.querySelector(
      `[data-paragraph-id="${target.paragraphId}"][data-word-index="${target.wordIndex}"]`
    );

    if (wordEl) {
      wordEl.scrollIntoView({ block: "center", behavior: "auto" });
    } else {
      // If not found, ensure paragraph is in view first
      const index = paragraphIndexById.get(target.paragraphId);
      if (index !== undefined && attempt === 0) {
        // Only scroll virtualizer on first attempt to avoid fighting
        // Use auto behavior to ensure immediate rendering
        rowVirtualizer.scrollToIndex(index, { align: "center", behavior: "auto" });
      }

      // Retry with backoff
      setTimeout(() => {
        findAndScrollToWord(target, attempt + 1);
      }, 50 + (attempt * 20));
    }
  }, [paragraphIndexById, rowVirtualizer]);

  const scrollToPosition = useCallback((pos: Position, smooth = false) => {
    if (!book) return;
    const index = paragraphIndexById.get(pos.paragraphId);
    if (index === undefined) return;
    
    rowVirtualizer.scrollToIndex(index, { align: "start", behavior: smooth ? "smooth" : "auto" });
    
    if (pos.wordIndex > 0) {
      // Use the robust finder for the word
      findAndScrollToWord(pos);
    }
  }, [book, paragraphIndexById, rowVirtualizer, findAndScrollToWord]);

  useEffect(() => {
    if (!book || hasScrolledToInitialPosition.current) return;
    hasScrolledToInitialPosition.current = true;

    // Small delay to allow layout
    initialScrollTimeoutRef.current = window.setTimeout(() => {
      // If we have a highlighted word, prioritize centering it
      if (highlightedWord) {
        findAndScrollToWord(highlightedWord);
      } else {
        scrollToPosition(position, false);
      }
    }, 100);

    return () => {
      if (initialScrollTimeoutRef.current !== null) {
        window.clearTimeout(initialScrollTimeoutRef.current);
      }
    };
  }, [book, position, highlightedWord, scrollToPosition, findAndScrollToWord]);

  // Scroll to highlighted word when it changes (e.g., switching from speed mode)
  useEffect(() => {
    if (!book || !highlightedWord) return;
    
    // Avoid double-scrolling on initial mount if possible, 
    // but ensures we catch updates or missed initial scrolls.
    const t = setTimeout(() => {
      const isTtsActive = tts.status === "playing" || tts.status === "paused";
      if (!isTtsActive) {
        findAndScrollToWord(highlightedWord);
        return;
      }

      const container = scrollContainerRef.current;
      if (!container) {
        findAndScrollToWord(highlightedWord);
        return;
      }

      const wordEl = container.querySelector(
        `[data-paragraph-id="${highlightedWord.paragraphId}"][data-word-index="${highlightedWord.wordIndex}"]`
      ) as HTMLElement | null;

      if (!wordEl) {
        findAndScrollToWord(highlightedWord);
        return;
      }

      const cRect = container.getBoundingClientRect();
      const wRect = wordEl.getBoundingClientRect();
      const relTop = wRect.top - cRect.top;
      const relBottom = wRect.bottom - cRect.top;
      const h = cRect.height || 1;
      const bandTop = h * 0.25;
      const bandBottom = h * 0.75;

      if (relTop < bandTop || relBottom > bandBottom) {
        wordEl.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 50);
    
    return () => clearTimeout(t);
  }, [book, highlightedWord, findAndScrollToWord, tts.status]);

  const handleScroll = useCallback(() => {
    if (!book || !scrollContainerRef.current) return;
    
    const scrollTop = scrollContainerRef.current.scrollTop;
    setIsScrolled(scrollTop > 10);
    
    const now = Date.now();
    if (now - lastScrollUpdateRef.current < 150) return;
    lastScrollUpdateRef.current = now;

    const virtualItems = rowVirtualizer.getVirtualItems();
    if (virtualItems.length === 0) return;

    let closestItem = virtualItems[0];
    let closestDelta = Math.abs(virtualItems[0].start - scrollTop);

    for (const item of virtualItems) {
      const delta = Math.abs(item.start - scrollTop);
      if (delta < closestDelta) {
        closestDelta = delta;
        closestItem = item;
      }
    }

    const paragraph = book.paragraphs[closestItem.index];
    if (paragraph && paragraph.id !== position.paragraphId) {
      setPosition({
        paragraphId: paragraph.id,
        wordIndex: 0
      });
    }
  }, [book, position.paragraphId, rowVirtualizer, setPosition]);

  const handleWordClick = useCallback((paragraphId: number, wordIndex: number) => {
    // When TTS is playing, don't allow changing the current word via clicks.
    // User must pause/stop first, then pick a word, then play again.
    if (tts.status === "playing") {
      return;
    }

    // When TTS is paused, clicks mean "jump" (set new resume point).
    if (tts.status === "paused") {
      const next = { paragraphId, wordIndex };
      setHighlightedWord(next);
      setPosition(next);
      tts.jumpTo(next);
      return;
    }
    if (highlightedWord && highlightedWord.paragraphId === paragraphId && highlightedWord.wordIndex === wordIndex) {
      setHighlightedWord(null);
    } else {
      setHighlightedWord({ paragraphId, wordIndex });
      setPosition({ paragraphId, wordIndex });
    }
  }, [highlightedWord, setHighlightedWord, setPosition, tts]);

  const handleResumeSpeedReading = useCallback(() => {
    if (!book) return;
    const startFrom = highlightedWord ?? position;
    setPosition(startFrom);
    setMode("speed");
  }, [book, highlightedWord, position, setPosition, setMode]);

  const handleChapterSelect = useCallback((chapter: Chapter) => {
    if (!book) return;
    
    const index = paragraphIndexById.get(chapter.startParagraphId);
    if (index !== undefined) {
      rowVirtualizer.scrollToIndex(index, { align: "start", behavior: "smooth" });
      setPosition({
        paragraphId: chapter.startParagraphId,
        wordIndex: 0
      });
    }
    setShowChapterMenu(false);
  }, [book, paragraphIndexById, rowVirtualizer, setPosition]);

  const handleBack = useCallback(() => {
    tts.stop();
    saveProgress();
    setLocation("/");
  }, [setLocation, saveProgress, tts]);

  if (!book) return null;

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="flex h-screen flex-col bg-neutral-950">
      {/* Header with glassmorphism on scroll */}
      <header 
        className={`flex items-center gap-3 px-4 py-3 transition-all duration-300 z-20 ${
          isScrolled 
            ? "bg-neutral-950/90 backdrop-blur-xl border-b border-neutral-800/80 shadow-lg shadow-black/20" 
            : "bg-neutral-950 border-b border-transparent"
        }`}
      >
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900/80 
            px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 
            transition-all duration-150 hover:scale-105 active:scale-95"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          <span className="hidden sm:inline">Back</span>
        </button>

        <button
          type="button"
          onClick={() => setShowChapterMenu(true)}
          className="flex-1 truncate text-center hover:scale-[1.02] transition-transform duration-150"
        >
          {currentChapter ? (
            <div className="flex flex-col items-center">
              <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                Chapter {currentChapter.index + 1}
              </span>
              <span className="text-sm text-neutral-200 font-medium truncate max-w-[200px]">
                {currentChapter.title}
              </span>
            </div>
          ) : (
            <span className="text-sm text-neutral-400">Full book</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => {
            tts.stop();
            setShowSettings(true);
          }}
          className="flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900/80 
            px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 
            transition-all duration-150 hover:scale-105 active:scale-95"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.212 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="hidden sm:inline">Settings</span>
        </button>
      </header>

      {/* Progress Bar Section */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between text-[11px] text-neutral-500 mb-2">
          <span>
            {currentChapter ? `Chapter ${currentChapter.index + 1}` : "Progress"}
          </span>
          <span className="font-medium text-neutral-400">
            {progressPercent}%
          </span>
        </div>
        <ProgressBar value={progressPercent} />
      </div>

      {/* Reading Content */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 sm:px-6 pb-20 pt-4"
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualItems.map((virtualItem) => {
            const paragraph = book.paragraphs[virtualItem.index];
            if (!paragraph) return null;

            const words = getTokensForParagraph(book, paragraph);
            const highlightedWordIndex =
              highlightedWord?.paragraphId === paragraph.id
                ? highlightedWord.wordIndex
                : null;

            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                className="pb-4 max-w-2xl mx-auto px-6"
              >
                <ParagraphRow
                  paragraph={paragraph}
                  words={words}
                  highlightedWordIndex={highlightedWordIndex}
                  onWordClick={handleWordClick}
                  wordClicksDisabled={tts.status === "playing"}
                  fontSizeClass={fontSizeClass}
                  fontFamilyClass={fontFamilyClass}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Speed Read FAB */}
      {highlightedWord && !isTtsBarOpen ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center px-4 pb-6 z-10">
          <div className="pointer-events-auto flex items-center gap-2">
            <motion.button
              type="button"
              onClick={handleResumeSpeedReading}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 0.9, y: 0 }}
              transition={{ delay: 0.3, duration: 0.25 }}
              className={`flex items-center gap-2 rounded-xl bg-neutral-800/80
                text-neutral-300 text-sm font-medium backdrop-blur-md
                px-4 py-2 border border-neutral-600/50 hover:border-neutral-500 hover:text-neutral-200
                transition-all duration-200 hover:bg-neutral-800 shadow-lg shadow-black/20`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
              </svg>
              Speed Read
            </motion.button>

            {tts.preparedState === "ready" && tts.serverAvailable ? (
              <motion.button
                type="button"
                onClick={() => setIsTtsBarOpen((v) => !v)}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 0.9, y: 0 }}
                transition={{ delay: 0.35, duration: 0.25 }}
                className={`flex items-center gap-2 rounded-xl bg-neutral-800/80
                  text-neutral-300 text-sm font-medium backdrop-blur-md
                  px-4 py-2 border border-neutral-600/50 hover:border-neutral-500 hover:text-neutral-200
                  transition-all duration-200 hover:bg-neutral-800 shadow-lg shadow-black/20 ${
                    tts.isReady ? "" : "opacity-70"
                  }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6.75 6.75 0 006.75-6.75v-1.5a6.75 6.75 0 10-13.5 0v1.5A6.75 6.75 0 0012 18.75z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 18.75v.75a3 3 0 006 0v-.75" />
                </svg>
                TTS
              </motion.button>
            ) : null}
          </div>
        </div>
      ) : null}

      {highlightedWord && tts.preparedState === "ready" && tts.serverAvailable ? (
        <TtsMiniBar
          isOpen={isTtsBarOpen}
          startFrom={highlightedWord}
          onClose={() => setIsTtsBarOpen(false)}
        />
      ) : null}

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
      <ChapterMenu
        isOpen={showChapterMenu}
        chapters={book.chapters}
        currentChapterIndex={currentChapter ? currentChapter.index : null}
        onSelect={handleChapterSelect}
        onClose={() => setShowChapterMenu(false)}
      />
    </div>
  );
}
