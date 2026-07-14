import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useBook } from "@/contexts/BookContext";
import { useReading } from "@/contexts/ReadingContext";
import { PROGRESS_BAR_THEMES, useSettings } from "@/contexts/SettingsContext";
import { useTts } from "@/contexts/TtsContext";
import { useTtsRegex } from "@/contexts/TtsRegexContext";
import SettingsModal from "@/components/reader/SettingsModal";
import ChapterMenu from "@/components/reader/ChapterMenu";
import TtsMiniBar from "@/components/reader/TtsMiniBar";
import TtsRegexRulesModal from "@/components/reader/TtsRegexRulesModal";
import ReaderToolsMenu, { PRONUNCIATION_ICON } from "@/components/reader/ReaderToolsMenu";
import WordReplacementSheet from "@/components/reader/WordReplacementSheet";
import NormalReaderToolbar, { type NormalReaderToolbarState } from "@/components/reader/NormalReaderToolbar";

import { speakNativeText, isNativeTtsAvailable } from "@/lib/nativeTts";
import { createSimpleWordPattern } from "@/lib/ttsRegex/simpleRule";
import { getTokensForParagraph } from "@/lib/utils/tokenCache";
import { calculateChapterPercentComplete, findChapterForParagraph } from "@/lib/utils/bookHelpers";
import {
  buildNormalReadingDisplayRows,
  type NormalReadingDisplayRow,
} from "@/lib/reader/buildNormalReadingDisplayRows";
import { resolveBookImageSrc } from "@/lib/reader/resolveBookImageSrc";
import type { BookImage, Chapter, Paragraph } from "@/types/book";
import { buildChapterSeparatorStarts, isDuplicateVisibleChapterHeading, navigationEntryAtParagraph } from "@/lib/reader/chapterSeparators";
import { classifyNavigationTitle } from "@/lib/navigationHierarchy";
import {
  createReaderToolbarScrollState,
  resetReaderToolbarScrollState,
  updateReaderToolbarScrollState,
} from "@/lib/reader/readerToolbarVisibility";
import NavigationSeparator from "@/components/reader/NavigationSeparator";
import SceneSeparator from "@/components/reader/SceneSeparator";
import type { Position, TtsHighlightStyle } from "@/types/reading";

// ── sentence boundary helper ──
function getSentenceBounds(words: string[]): [number, number][] {
  const bounds: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    if (/[.!?][""\u201D\u2019)]*$/.test(words[i]) || i === words.length - 1) {
      bounds.push([start, i]);
      start = i + 1;
    }
  }
  return bounds;
}

function findSentenceFor(bounds: [number, number][], idx: number): [number, number] | null {
  for (const b of bounds) {
    if (idx >= b[0] && idx <= b[1]) return b;
  }
  return null;
}

const PHRASE_SIZE = 4;
const INITIAL_SCROLL_DELAY_MS = 120;
const POSITION_SYNC_SUPPRESS_MS = 850;
const INITIAL_PROGRESS_REVEAL_DELAY_MS = 260;

type ParagraphRowProps = {
  paragraph: Paragraph;
  words: string[];
  highlightedWordIndex: number | null;
  highlightStyle: TtsHighlightStyle;
  onWordClick: (paragraphId: number, wordIndex: number) => void;
  wordClicksDisabled: boolean;
  fontSizeClass: string;
  fontFamilyClass: string;
};

const ImageRow = memo(function ImageRow({ bookId, image }: { bookId: string; image: BookImage }) {
  const [displaySrc, setDisplaySrc] = useState<string | null>(() =>
    image.src.trim().toLowerCase().startsWith("data:image/") ? image.src : null
  );

  useEffect(() => {
    let cancelled = false;
    const src = image.src.trim();
    if (src.toLowerCase().startsWith("data:image/")) {
      setDisplaySrc(src);
      return;
    }

    setDisplaySrc(null);
    void resolveBookImageSrc(bookId, src).then((url) => {
      if (!cancelled) setDisplaySrc(url);
    });

    return () => {
      cancelled = true;
    };
  }, [bookId, image.src]);

  if (!displaySrc) {
    return (
      <figure
        className="w-full"
        data-testid="book-image-row"
        data-image-id={image.id}
        data-image-loading="true"
        aria-busy="true"
      >
        <div className="mx-auto h-40 w-full max-w-2xl animate-pulse rounded-md bg-neutral-200/70" />
        {image.alt ? (
          <figcaption className="mt-2 text-center text-xs text-neutral-500">{image.alt}</figcaption>
        ) : null}
      </figure>
    );
  }

  return (
    <figure className="w-full" data-testid="book-image-row" data-image-id={image.id}>
      <img
        src={displaySrc}
        alt={image.alt ?? ""}
        loading="lazy"
        decoding="async"
        className="mx-auto h-auto w-full max-w-2xl rounded-md object-contain"
      />
      {image.alt ? (
        <figcaption className="mt-2 text-center text-xs text-neutral-500">{image.alt}</figcaption>
      ) : null}
    </figure>
  );
});

const ParagraphRow = memo(function ParagraphRow({
  paragraph,
  words,
  highlightedWordIndex,
  highlightStyle,
  onWordClick,
  wordClicksDisabled,
  fontSizeClass,
  fontFamilyClass,
}: ParagraphRowProps) {
  const sentenceBounds = useMemo(() => getSentenceBounds(words), [words]);
  const activeSentence = highlightedWordIndex !== null
    ? findSentenceFor(sentenceBounds, highlightedWordIndex)
    : null;

  const phraseStart = highlightedWordIndex !== null
    ? Math.floor(highlightedWordIndex / PHRASE_SIZE) * PHRASE_SIZE
    : -1;
  const phraseEnd = phraseStart >= 0 ? Math.min(phraseStart + PHRASE_SIZE - 1, words.length - 1) : -1;

  return (
    <div className={`${fontFamilyClass} ${fontSizeClass} leading-relaxed text-neutral-300 text-left`}>
      {words.map((word, index) => {
        const isActiveWord = highlightedWordIndex === index;
        const inActiveSentence = activeSentence !== null && index >= activeSentence[0] && index <= activeSentence[1];
        const inActivePhrase = index >= phraseStart && index <= phraseEnd;
        const beforeActiveWord = highlightedWordIndex !== null && index < highlightedWordIndex && inActiveSentence;

        let cls = "rounded-sm transition-colors duration-150 ";

        if (highlightedWordIndex === null) {
          // no TTS active
          cls += wordClicksDisabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-neutral-800/70";
        } else {
          switch (highlightStyle) {
            case "word":
              cls += isActiveWord
                ? "bg-white/18 text-neutral-100 shadow-[0_0_0_1px_rgba(255,255,255,0.22)] z-10 relative"
                : wordClicksDisabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-neutral-800/70";
              break;

            case "sentence":
              cls += inActiveSentence
                ? "bg-white/10 text-neutral-100"
                : "text-neutral-500";
              break;

            case "dim-rest":
              cls += inActiveSentence
                ? "text-neutral-100"
                : "text-neutral-600 transition-colors duration-300";
              break;

            case "underline":
              cls += isActiveWord
                ? "text-neutral-100 border-b-2 border-amber-400/80 pb-[1px]"
                : wordClicksDisabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-neutral-800/70";
              break;

            case "karaoke":
              if (inActiveSentence) {
                cls += beforeActiveWord
                  ? "text-amber-300"
                  : isActiveWord
                    ? "text-amber-300"
                    : "text-neutral-400";
              } else {
                cls += "text-neutral-500";
              }
              break;

            case "phrase":
              cls += inActivePhrase
                ? "bg-white/12 text-neutral-100 rounded-sm"
                : "text-neutral-500";
              break;

            default:
              cls += isActiveWord
                ? "bg-white/18 text-neutral-100"
                : "";
          }
        }

        return (
          <span
            key={index}
            data-word-index={index}
            data-paragraph-id={paragraph.id}
            onClick={wordClicksDisabled ? undefined : () => onWordClick(paragraph.id, index)}
            className={cls}
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
  const { position, highlightedWord, setMode, setPosition, setHighlightedWord, saveProgress, progressLoaded } = useReading();
  const { settings } = useSettings();
  const tts = useTts();
  const { createRule, store: ttsRegexStore } = useTtsRegex();

  const [showSettings, setShowSettings] = useState(false);
  const [showChapterMenu, setShowChapterMenu] = useState(false);
  const [showRegexRules, setShowRegexRules] = useState(false);
  const [regexInitialPattern, setRegexInitialPattern] = useState("");
  const [regexInitialReplacement, setRegexInitialReplacement] = useState("");
  const [showWordReplacement, setShowWordReplacement] = useState(false);
  const [toolbarMode, setToolbarMode] = useState<"edge" | "expanded">("edge");
  const [isTtsBarOpen, setIsTtsBarOpen] = useState(false);
  const [displayedProgress, setDisplayedProgress] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToInitialPosition = useRef(false);
  const hasRevealedInitialProgress = useRef(false);
  const lastScrollUpdateRef = useRef<number>(0);
  const toolbarScrollStateRef = useRef(createReaderToolbarScrollState());
  const toolbarIntentSuppressedUntilRef = useRef(0);
  const initialScrollTimeoutRef = useRef<number | null>(null);
  const chapterSelectTimeoutRef = useRef<number | null>(null);
  const findWordRetryTimeoutRef = useRef<number | null>(null);
  const findWordRetryTokenRef = useRef(0);
  const suppressPositionSyncUntilRef = useRef<number>(0);
  const resumeTtsAfterWordSheetRef = useRef(false);
  const wordSheetResumePositionRef = useRef<Position | null>(null);
  const skipWordSheetResumeRef = useRef(false);
  const pendingResumeNeedsRuleCommitRef = useRef(false);
  const regexStoreSnapshotBeforeSaveRef = useRef(ttsRegexStore);
  const [pendingTtsResume, setPendingTtsResume] = useState<Position | null>(null);

  useEffect(() => {
    if (!highlightedWord) {
      setIsTtsBarOpen(false);
    }
  }, [highlightedWord]);

  const isTtsSessionActive = tts.status === "playing" || tts.status === "paused";
  const toolbarState: NormalReaderToolbarState = isTtsSessionActive ? "hidden" : toolbarMode;

  useEffect(() => {
    const now = Date.now();
    const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
    toolbarScrollStateRef.current = resetReaderToolbarScrollState(scrollTop, now);
    toolbarIntentSuppressedUntilRef.current = now + POSITION_SYNC_SUPPRESS_MS;
    setToolbarMode("edge");
  }, [isTtsSessionActive]);

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

  const progressTheme = useMemo(
    () => PROGRESS_BAR_THEMES.find((theme) => theme.name === settings.progressBarTheme) ?? PROGRESS_BAR_THEMES[0],
    [settings.progressBarTheme]
  );

  const paragraphIndexById = useMemo(() => {
    if (!book) return new Map<number, number>();
    const map = new Map<number, number>();
    book.paragraphs.forEach((p, i) => map.set(p.id, i));
    return map;
  }, [book]);

  const displayRows = useMemo((): NormalReadingDisplayRow[] => {
    if (!book) return [];
    return buildNormalReadingDisplayRows(book);
  }, [book]);

  const displayRowIndexByParagraphId = useMemo(() => {
    const map = new Map<number, number>();
    displayRows.forEach((row, index) => {
      if (row.kind === "paragraph") {
        map.set(row.paragraph.id, index);
      }
    });
    return map;
  }, [displayRows]);

  const highlightedWordText = useMemo(() => {
    if (!book || !highlightedWord) return "";
    const paragraphIndex = paragraphIndexById.get(highlightedWord.paragraphId);
    if (paragraphIndex === undefined) return "";

    const paragraph = book.paragraphs[paragraphIndex];
    if (!paragraph) return "";

    const tokens = getTokensForParagraph(book, paragraph);
    return tokens[highlightedWord.wordIndex] ?? "";
  }, [book, highlightedWord, paragraphIndexById]);

  const currentChapter: Chapter | null = useMemo(() => {
    if (!book) return null;
    return findChapterForParagraph(book, position.paragraphId);
  }, [book, position.paragraphId]);

  const chapterSeparatorStarts = useMemo(() => {
    return book ? buildChapterSeparatorStarts(book) : new Set<number>();
  }, [book]);

  const progressPercent = useMemo(() => {
    if (!book) {
      return 0;
    }
    return calculateChapterPercentComplete(book, position);
  }, [book, position]);

  const rowVirtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const kind = displayRows[index]?.kind;
      return kind === "image" ? 220 : kind === "scene-break" ? 72 : 80;
    },
    overscan: 10,
  });

  const suppressPositionSync = useCallback((durationMs: number) => {
    suppressPositionSyncUntilRef.current = Date.now() + durationMs;
  }, []);

  const findAndScrollToWord = useCallback((target: Position, attempt = 0) => {
    if (attempt === 0) {
      findWordRetryTokenRef.current += 1;
      if (findWordRetryTimeoutRef.current !== null) {
        window.clearTimeout(findWordRetryTimeoutRef.current);
        findWordRetryTimeoutRef.current = null;
      }
    }

    const retryToken = findWordRetryTokenRef.current;
    if (attempt > 20) return; // Max retries

    const wordEl = scrollContainerRef.current?.querySelector(
      `[data-paragraph-id="${target.paragraphId}"][data-word-index="${target.wordIndex}"]`
    );

    if (wordEl) {
      wordEl.scrollIntoView({ block: "center", behavior: "auto" });
    } else {
      // If not found, ensure paragraph is in view first
      const index = displayRowIndexByParagraphId.get(target.paragraphId);
      if (index !== undefined && attempt === 0) {
        // Only scroll virtualizer on first attempt to avoid fighting
        // Use auto behavior to ensure immediate rendering
        rowVirtualizer.scrollToIndex(index, { align: "center", behavior: "auto" });
      }

      // Retry with backoff
      findWordRetryTimeoutRef.current = window.setTimeout(() => {
        if (retryToken !== findWordRetryTokenRef.current) return;
        findAndScrollToWord(target, attempt + 1);
      }, 50 + (attempt * 20));
    }
  }, [displayRowIndexByParagraphId, rowVirtualizer]);

  const scrollToPosition = useCallback((pos: Position, smooth = false) => {
    if (!book) return;
    const index = displayRowIndexByParagraphId.get(pos.paragraphId);
    if (index === undefined) return;
    
    rowVirtualizer.scrollToIndex(index, { align: "start", behavior: smooth ? "smooth" : "auto" });
    
    if (pos.wordIndex > 0) {
      // Use the robust finder for the word
      findAndScrollToWord(pos);
    }
  }, [book, displayRowIndexByParagraphId, rowVirtualizer, findAndScrollToWord]);

  useEffect(() => {
    hasScrolledToInitialPosition.current = false;
    hasRevealedInitialProgress.current = false;
    suppressPositionSyncUntilRef.current = 0;
  }, [book?.id]);

  useEffect(() => {
    if (!progressLoaded) {
      setDisplayedProgress(0);
      return;
    }

    const delay = hasRevealedInitialProgress.current ? 0 : INITIAL_PROGRESS_REVEAL_DELAY_MS;
    hasRevealedInitialProgress.current = true;

    const timeoutId = window.setTimeout(() => {
      setDisplayedProgress(progressPercent);
    }, delay);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [progressLoaded, progressPercent]);

  useEffect(() => {
    return () => {
      if (chapterSelectTimeoutRef.current !== null) {
        window.clearTimeout(chapterSelectTimeoutRef.current);
        chapterSelectTimeoutRef.current = null;
      }
      if (findWordRetryTimeoutRef.current !== null) {
        window.clearTimeout(findWordRetryTimeoutRef.current);
        findWordRetryTimeoutRef.current = null;
      }
      findWordRetryTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!book || !progressLoaded || hasScrolledToInitialPosition.current) return;

    // Small delay to allow layout
    initialScrollTimeoutRef.current = window.setTimeout(() => {
      suppressPositionSync(POSITION_SYNC_SUPPRESS_MS);

      // If we have a highlighted word, prioritize centering it
      if (highlightedWord) {
        findAndScrollToWord(highlightedWord);
      } else {
        scrollToPosition(position, false);
      }
      hasScrolledToInitialPosition.current = true;
    }, INITIAL_SCROLL_DELAY_MS);

    return () => {
      if (initialScrollTimeoutRef.current !== null) {
        window.clearTimeout(initialScrollTimeoutRef.current);
      }
    };
  }, [book, position, highlightedWord, progressLoaded, scrollToPosition, findAndScrollToWord, suppressPositionSync]);

  // Scroll to highlighted word when it changes (e.g., switching from speed mode)
  useEffect(() => {
    if (!book || !highlightedWord) return;
    
    // Avoid double-scrolling on initial mount if possible, 
    // but ensures we catch updates or missed initial scrolls.
    const t = setTimeout(() => {
      const isTtsActive = tts.status === "playing";
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
      const relMid = (relTop + relBottom) / 2;
      const h = cRect.height || 1;
      const bandTop = h * 0.12;
      const bandBottom = h * 0.5;
      const targetMid = h * 0.32;

      if (relMid < bandTop || relMid > bandBottom) {
        const delta = relMid - targetMid;
        container.scrollTo({
          top: container.scrollTop + delta,
          behavior: "smooth",
        });
      }
    }, 50);
    
    return () => clearTimeout(t);
  }, [book, highlightedWord, findAndScrollToWord, tts.status]);

  const handleScroll = useCallback(() => {
    if (!book || !scrollContainerRef.current) return;
    
    const scrollTop = scrollContainerRef.current.scrollTop;
    const now = Date.now();
    const canReactToToolbarScroll = progressLoaded
      && hasScrolledToInitialPosition.current
      && now >= suppressPositionSyncUntilRef.current
      && now >= toolbarIntentSuppressedUntilRef.current
      && !isTtsSessionActive;

    if (canReactToToolbarScroll) {
      const toolbarUpdate = updateReaderToolbarScrollState(
        toolbarScrollStateRef.current,
        scrollTop,
        now,
      );
      toolbarScrollStateRef.current = toolbarUpdate.state;
      if (toolbarUpdate.intent === "backward") setToolbarMode("expanded");
      if (toolbarUpdate.intent === "forward") setToolbarMode("edge");
    } else {
      toolbarScrollStateRef.current = resetReaderToolbarScrollState(scrollTop, now);
    }

    if (!progressLoaded || !hasScrolledToInitialPosition.current) return;
    if (Date.now() < suppressPositionSyncUntilRef.current) return;
    
    if (now - lastScrollUpdateRef.current < 150) return;
    lastScrollUpdateRef.current = now;

    const virtualItems = rowVirtualizer.getVirtualItems();
    if (virtualItems.length === 0) return;

    const probeOffset = scrollTop + 24;
    const closestItem = virtualItems.find((item) => probeOffset >= item.start && probeOffset < item.end)
      ?? virtualItems[virtualItems.length - 1];

    // Map image rows back to the nearest preceding paragraph for progress.
    let nearestParagraph: Paragraph | null = null;
    for (let i = closestItem.index; i >= 0; i -= 1) {
      const row = displayRows[i];
      if (row?.kind === "paragraph") {
        nearestParagraph = row.paragraph;
        break;
      }
    }
    if (!nearestParagraph) {
      for (let i = closestItem.index + 1; i < displayRows.length; i += 1) {
        const row = displayRows[i];
        if (row?.kind === "paragraph") {
          nearestParagraph = row.paragraph;
          break;
        }
      }
    }

    if (nearestParagraph && nearestParagraph.id !== position.paragraphId) {
      setPosition({
        paragraphId: nearestParagraph.id,
        wordIndex: 0
      });
    }
  }, [book, displayRows, isTtsSessionActive, position.paragraphId, progressLoaded, rowVirtualizer, setPosition]);

  const handleWordClick = useCallback((paragraphId: number, wordIndex: number) => {
    // When TTS is playing, don't allow changing the current word via clicks.
    // User must pause/stop first, then pick a word, then play again.
    if (tts.status === "playing") {
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

  const openWordReplacementSheet = useCallback(() => {
    const wasPlaying = tts.status === "playing";
    resumeTtsAfterWordSheetRef.current = wasPlaying;
    wordSheetResumePositionRef.current = highlightedWord ?? position;
    skipWordSheetResumeRef.current = false;
    pendingResumeNeedsRuleCommitRef.current = false;
    regexStoreSnapshotBeforeSaveRef.current = ttsRegexStore;

    if (wasPlaying) {
      tts.pause();
    }
    setShowWordReplacement(true);
  }, [highlightedWord, position, tts, ttsRegexStore]);

  const closeWordReplacementSheet = useCallback(() => {
    setShowWordReplacement(false);

    const shouldResume = resumeTtsAfterWordSheetRef.current && !skipWordSheetResumeRef.current;
    const resumePos = wordSheetResumePositionRef.current;

    resumeTtsAfterWordSheetRef.current = false;
    wordSheetResumePositionRef.current = null;
    skipWordSheetResumeRef.current = false;

    if (shouldResume && resumePos) {
      setPendingTtsResume(resumePos);
      return;
    }
    pendingResumeNeedsRuleCommitRef.current = false;
    regexStoreSnapshotBeforeSaveRef.current = ttsRegexStore;
  }, [ttsRegexStore]);

  useEffect(() => {
    if (!pendingTtsResume) return;

    if (
      pendingResumeNeedsRuleCommitRef.current &&
      regexStoreSnapshotBeforeSaveRef.current === ttsRegexStore
    ) {
      return;
    }

    pendingResumeNeedsRuleCommitRef.current = false;
    regexStoreSnapshotBeforeSaveRef.current = ttsRegexStore;

    setPendingTtsResume(null);
    void tts.playFrom(pendingTtsResume);
  }, [pendingTtsResume, tts, ttsRegexStore]);

  const handleSaveWordReplacement = useCallback(
    (word: string, replacement: string, scope: "global" | "book") => {
      if (scope === "book" && !book?.id) {
        throw new Error("Cannot create a book-scoped rule without a book id.");
      }

      const pattern = createSimpleWordPattern(word);
      if (!pattern) {
        throw new Error("Cannot create pronunciation rule for an empty word.");
      }

      pendingResumeNeedsRuleCommitRef.current = resumeTtsAfterWordSheetRef.current;
      regexStoreSnapshotBeforeSaveRef.current = ttsRegexStore;

      createRule({
        scope,
        bookId: scope === "book" ? book?.id : undefined,
        input: {
          pattern,
          replacement,
          source: "simple",
          caseInsensitive: true,
          enabled: true,
        },
      });
    },
    [book?.id, createRule, ttsRegexStore]
  );

  const handlePlayWordReplacementPreview = useCallback(
    async (text: string) => {
      let ready = tts.isReady;
      if (!ready) {
        ready = await isNativeTtsAvailable();
      }
      if (!ready) {
        console.warn("[WordReplacement] TTS not available for preview");
        return;
      }
      await speakNativeText({
        text,
        rate: settings.ttsPlaybackRate,
        lang: settings.ttsLanguage || "en-US",
        voice: settings.ttsVoiceIndex,
        queueStrategy: "flush",
      });
    },
    [settings.ttsLanguage, settings.ttsPlaybackRate, settings.ttsVoiceIndex, tts.isReady]
  );

  const handleOpenRegexFromWordReplacement = useCallback((word: string, replacement: string) => {
    skipWordSheetResumeRef.current = true;
    setRegexInitialPattern(word);
    setRegexInitialReplacement(replacement);
    setShowRegexRules(true);
  }, []);

  const readerTools = useMemo(
    () => [
      {
        id: "pronunciation",
        label: "Fix pronunciation",
        icon: PRONUNCIATION_ICON,
        onTap: openWordReplacementSheet,
      },
    ],
    [openWordReplacementSheet]
  );

  const handleChapterSelect = useCallback((chapter: Chapter) => {
    if (!book) return;
    
    const index = displayRowIndexByParagraphId.get(chapter.startParagraphId);
    if (index !== undefined) {
      suppressPositionSync(POSITION_SYNC_SUPPRESS_MS);
      rowVirtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
      if (chapterSelectTimeoutRef.current !== null) {
        window.clearTimeout(chapterSelectTimeoutRef.current);
      }
      // Second pass after items near target are rendered and measured
      chapterSelectTimeoutRef.current = window.setTimeout(() => {
        rowVirtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
        chapterSelectTimeoutRef.current = null;
      }, 120);
      setPosition({
        paragraphId: chapter.startParagraphId,
        wordIndex: 0
      });
    }
    setToolbarMode("edge");
    setShowChapterMenu(false);
  }, [book, displayRowIndexByParagraphId, rowVirtualizer, setPosition, suppressPositionSync]);

  const handleToolbarChapterAction = useCallback(() => {
    if (toolbarMode === "edge") {
      setToolbarMode("expanded");
      return;
    }
    setShowChapterMenu(true);
  }, [toolbarMode]);

  const handleOpenSettings = useCallback(() => {
    tts.stop();
    setShowSettings(true);
  }, [tts]);

  const handleBack = useCallback(() => {
    tts.stop();
    saveProgress();
    setLocation("/");
  }, [setLocation, saveProgress, tts]);

  if (!book) return null;

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div
      className="flex h-screen flex-col bg-neutral-950"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <NormalReaderToolbar
        state={toolbarState}
        chapterTitle={currentChapter?.title ?? "Full book"}
        progressPercent={progressLoaded ? displayedProgress : null}
        progressGradient={progressTheme}
        onBack={handleBack}
        onChapterAction={handleToolbarChapterAction}
        onSettings={handleOpenSettings}
      />

      {/* Reading Content */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto pb-20 pt-4"
        style={{ paddingLeft: settings.horizontalPadding, paddingRight: settings.horizontalPadding }}
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualItems.map((virtualItem) => {
            const row = displayRows[virtualItem.index];
            if (!row) return null;

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
                className="pb-4"
              >
                <div className="w-full max-w-2xl mx-auto">
                  {row.kind === "image" ? (
                    <ImageRow bookId={book.id} image={row.image} />
                  ) : row.kind === "scene-break" ? (
                    <SceneSeparator />
                  ) : (
                    (() => {
                      const paragraph = row.paragraph;
                      const words = getTokensForParagraph(book, paragraph);
                      const showChapterSeparator = chapterSeparatorStarts.has(paragraph.id);
                      const navigationEntry = navigationEntryAtParagraph(book, paragraph.id);
                      const hideDuplicateChapterHeading = showChapterSeparator
                        && isDuplicateVisibleChapterHeading(book, paragraph.id, paragraph.text);
                      const highlightedWordIndex =
                        highlightedWord?.paragraphId === paragraph.id
                          ? highlightedWord.wordIndex
                          : null;

                      return (
                        <>
                          {showChapterSeparator ? (
                            <NavigationSeparator
                              kind={navigationEntry?.kind ?? classifyNavigationTitle(navigationEntry?.title ?? "Chapter")}
                            />
                          ) : null}
                          {hideDuplicateChapterHeading ? null : (
                            <ParagraphRow
                              paragraph={paragraph}
                              words={words}
                              highlightedWordIndex={highlightedWordIndex}
                              highlightStyle={settings.ttsHighlightStyle}
                              onWordClick={handleWordClick}
                              wordClicksDisabled={tts.status === "playing"}
                              fontSizeClass={fontSizeClass}
                              fontFamilyClass={fontFamilyClass}
                            />
                          )}
                        </>
                      );
                    })()
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Speed Read FAB */}
      {highlightedWord && !isTtsBarOpen ? (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center px-4 z-10"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)" }}
        >
          <div className="pointer-events-auto flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <motion.button
                type="button"
                onClick={handleResumeSpeedReading}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 0.9, y: 0 }}
                transition={{ delay: 0.3, duration: 0.25 }}
                className="flex items-center gap-2 rounded-xl bg-neutral-800/80
                  text-sm font-medium backdrop-blur-md
                  px-4 py-2 border border-neutral-600/50 hover:border-neutral-500
                  transition-all duration-200 hover:bg-neutral-800 shadow-lg shadow-black/20"
                style={{ color: settings.speedButtonColor }}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
                </svg>
                Speed Read
              </motion.button>

              {tts.isReady ? (
                <motion.button
                  type="button"
                  onClick={() => setIsTtsBarOpen((v) => !v)}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 0.9, y: 0 }}
                  transition={{ delay: 0.35, duration: 0.25 }}
                  className={`flex items-center gap-2 rounded-xl bg-neutral-800/80
                    text-sm font-medium backdrop-blur-md
                    px-4 py-2 border border-neutral-600/50 hover:border-neutral-500
                    transition-all duration-200 hover:bg-neutral-800 shadow-lg shadow-black/20 ${
                      tts.isReady ? "" : "opacity-70"
                    }`}
                  style={{ color: settings.ttsButtonColor }}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6.75 6.75 0 006.75-6.75v-1.5a6.75 6.75 0 10-13.5 0v1.5A6.75 6.75 0 0012 18.75z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 18.75v.75a3 3 0 006 0v-.75" />
                  </svg>
                  TTS
                </motion.button>
              ) : null}
            </div>
            <ReaderToolsMenu tools={readerTools} />
          </div>
        </div>
      ) : null}

      {highlightedWord && tts.isReady ? (
        <TtsMiniBar
          isOpen={isTtsBarOpen}
          startFrom={highlightedWord}
          onClose={() => setIsTtsBarOpen(false)}
        />
      ) : null}

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        book={book}
      />
      <ChapterMenu
        isOpen={showChapterMenu}
        chapters={book.chapters}
        currentChapterIndex={currentChapter ? currentChapter.index : null}
        onSelect={handleChapterSelect}
        onClose={() => setShowChapterMenu(false)}
      />
      <WordReplacementSheet
        isOpen={showWordReplacement}
        onClose={closeWordReplacementSheet}
        onSave={handleSaveWordReplacement}
        onOpenRegex={handleOpenRegexFromWordReplacement}
        onPlayPreview={handlePlayWordReplacementPreview}
        initialWord={highlightedWordText}
      />
      <TtsRegexRulesModal
        isOpen={showRegexRules}
        onClose={() => {
          setShowRegexRules(false);
          setRegexInitialPattern("");
          setRegexInitialReplacement("");
        }}
        book={book}
        initialPattern={regexInitialPattern}
        initialReplacement={regexInitialReplacement}
      />
    </div>
  );
}
