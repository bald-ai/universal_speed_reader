"use client";

import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useBook } from "@/contexts/BookContext";
import { useReading } from "@/contexts/ReadingContext";
import { useSettings } from "@/contexts/SettingsContext";
import SettingsModal from "@/components/reader/SettingsModal";
import ChapterMenu from "@/components/reader/ChapterMenu";

import { getTokensForParagraph, getWordCountForParagraph } from "@/lib/utils/tokenCache";
import type { Chapter, Paragraph } from "@/types/book";
import type { Position } from "@/types/reading";

type ParagraphRowProps = {
  paragraph: Paragraph;
  words: string[];
  highlightedWordIndex: number | null;
  onWordClick: (paragraphId: number, wordIndex: number) => void;
  fontSizeClass: string;
};

const ParagraphRow = memo(function ParagraphRow({
  paragraph,
  words,
  highlightedWordIndex,
  onWordClick,
  fontSizeClass,
}: ParagraphRowProps) {
  return (
    <div className={`font-editorial reading-text text-neutral-300 ${fontSizeClass}`}>
      {words.map((word, index) => {
        const isHighlighted = highlightedWordIndex === index;
        return (
          <span
            key={index}
            data-word-index={index}
            data-paragraph-id={paragraph.id}
            onClick={() => onWordClick(paragraph.id, index)}
            className={`reading-word ${
              isHighlighted
                ? "reading-word-highlighted"
                : ""
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
  const router = useRouter();
  const { book } = useBook();
  const { position, highlightedWord, setMode, setPosition, setHighlightedWord, saveProgress } = useReading();
  const { settings } = useSettings();

  const [showSettings, setShowSettings] = useState(false);
  const [showChapterMenu, setShowChapterMenu] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToInitialPosition = useRef(false);
  const lastScrollUpdateRef = useRef<number>(0);
  const initialScrollTimeoutRef = useRef<number | null>(null);

  const fontSizeClass = useMemo(() => {
    switch (settings.fontSize) {
      case "small":
        return "text-reading-sm";
      case "large":
        return "text-reading-lg";
      case "xl":
        return "text-reading-xl";
      case "medium":
      default:
        return "text-reading-base";
    }
  }, [settings.fontSize]);

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

  const scrollToPosition = useCallback((pos: Position, smooth = false) => {
    if (!book) return;
    const index = paragraphIndexById.get(pos.paragraphId);
    if (index === undefined) return;
    
    rowVirtualizer.scrollToIndex(index, { align: "start", behavior: smooth ? "smooth" : "auto" });
    
    if (pos.wordIndex > 0) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const wordEl = scrollContainerRef.current?.querySelector(
            `[data-paragraph-id="${pos.paragraphId}"][data-word-index="${pos.wordIndex}"]`
          );
          if (wordEl) {
            wordEl.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        });
      });
    }
  }, [book, paragraphIndexById, rowVirtualizer]);

  useEffect(() => {
    if (!book || hasScrolledToInitialPosition.current) return;
    hasScrolledToInitialPosition.current = true;

    const targetPos = highlightedWord ?? position;
    initialScrollTimeoutRef.current = window.setTimeout(() => {
      scrollToPosition(targetPos, false);
    }, 50);

    return () => {
      if (initialScrollTimeoutRef.current !== null) {
        window.clearTimeout(initialScrollTimeoutRef.current);
      }
    };
  }, [book, position, highlightedWord, scrollToPosition]);

  // Scroll to highlighted word when it changes (e.g., switching from speed mode)
  useEffect(() => {
    if (!book || !highlightedWord) return;

    // Use requestAnimationFrame to ensure DOM is updated
    requestAnimationFrame(() => {
      const wordEl = scrollContainerRef.current?.querySelector(
        `[data-paragraph-id="${highlightedWord.paragraphId}"][data-word-index="${highlightedWord.wordIndex}"]`
      );
      if (wordEl) {
        wordEl.scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        // If element not in DOM yet (virtualization), scroll to paragraph first
        const index = paragraphIndexById.get(highlightedWord.paragraphId);
        if (index !== undefined) {
          rowVirtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
          // Try again after scrolling
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const wordElRetry = scrollContainerRef.current?.querySelector(
                `[data-paragraph-id="${highlightedWord.paragraphId}"][data-word-index="${highlightedWord.wordIndex}"]`
              );
              wordElRetry?.scrollIntoView({ block: "center", behavior: "smooth" });
            });
          });
        }
      }
    });
  }, [book, highlightedWord, paragraphIndexById, rowVirtualizer]);

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
    if (highlightedWord && highlightedWord.paragraphId === paragraphId && highlightedWord.wordIndex === wordIndex) {
      setHighlightedWord(null);
    } else {
      setHighlightedWord({ paragraphId, wordIndex });
      setPosition({ paragraphId, wordIndex });
    }
  }, [highlightedWord, setHighlightedWord, setPosition]);

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
    saveProgress();
    router.push("/");
  }, [router, saveProgress]);

  if (!book) return null;

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="flex h-screen flex-col bg-[#0a0a0a]">
      {/* Header - minimal, floating */}
      <header 
        className={`flex items-center gap-4 px-6 py-4 transition-all duration-500 z-20 ${
          isScrolled 
            ? "glass border-b border-neutral-800/50" 
            : "bg-transparent"
        }`}
      >
        <button
          type="button"
          onClick={handleBack}
          className="group flex items-center gap-2 rounded-full px-3 py-2 text-neutral-500 hover:text-neutral-300 transition-colors duration-200"
        >
          <svg className="w-4 h-4 transition-transform duration-200 group-hover:-translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          <span className="text-xs tracking-wide hidden sm:inline">Back</span>
        </button>

        <button
          type="button"
          onClick={() => setShowChapterMenu(true)}
          className="flex-1 truncate text-center py-1"
        >
          {currentChapter ? (
            <div className="flex flex-col items-center">
              <span className="text-[9px] uppercase tracking-[0.25em] text-neutral-600 font-medium">
                Chapter {currentChapter.index + 1}
              </span>
              <span className="text-sm text-neutral-400 font-medium truncate max-w-[200px] mt-0.5">
                {currentChapter.title}
              </span>
            </div>
          ) : (
            <span className="text-sm text-neutral-500">Reading</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="group flex items-center gap-2 rounded-full px-3 py-2 text-neutral-500 hover:text-neutral-300 transition-colors duration-200"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.212 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </header>

      {/* Progress Bar - subtle line */}
      <div className="px-6 pt-2 pb-4">
        <div className="flex items-center justify-between text-[10px] tracking-wide text-neutral-600 mb-2">
          <span>
            {currentChapter ? `Ch. ${currentChapter.index + 1}` : "Progress"}
          </span>
          <span className="font-medium text-neutral-500">
            {progressPercent}%
          </span>
        </div>
        <div className="h-[2px] bg-neutral-800 rounded-full overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-amber-500/80 to-amber-400/80 transition-all duration-300 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Reading Content */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto reading-container pb-32 pt-6"
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
                className="reading-paragraph"
              >
                <ParagraphRow
                  paragraph={paragraph}
                  words={words}
                  highlightedWordIndex={highlightedWordIndex}
                  onWordClick={handleWordClick}
                  fontSizeClass={fontSizeClass}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Speed Read FAB - minimal pill */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center px-4 pb-8 z-10">
        <motion.button
          type="button"
          onClick={handleResumeSpeedReading}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
          className="pointer-events-auto flex items-center gap-2.5 rounded-full glass-subtle
            text-neutral-400 text-xs font-medium tracking-wide
            px-5 py-2.5 border border-neutral-800/50 hover:border-neutral-700/50 hover:text-neutral-300
            transition-all duration-300 group"
        >
          <svg className="w-3.5 h-3.5 text-amber-500/70 group-hover:text-amber-500 transition-colors" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z"/>
          </svg>
          Speed Read
        </motion.button>
      </div>

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
