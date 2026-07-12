import type { Book } from "@/types/book";
import type { Position } from "@/types/reading";
import { getTokensForParagraph, getWordCountForParagraph } from "./tokenCache";
import { classifyNavigationTitle, navigationPrecedence } from "@/lib/navigationHierarchy";

type ChapterProgressBounds = {
  startParagraphIndex: number;
  endParagraphExclusive: number;
  startWordOffset: number;
  totalWords: number;
};

type ChapterProgressCache = {
  paragraphIndexById: Map<number, number>;
  paragraphWordPrefix: number[];
  chapterBounds: ChapterProgressBounds[];
};

const chapterProgressCache = new WeakMap<Book, ChapterProgressCache | null>();

function getParagraphById(book: Book, id: number) {
  // Optimization for 1-based sequential IDs (standard for this app)
  if (id > 0 && id <= book.paragraphs.length) {
    const p = book.paragraphs[id - 1];
    if (p && p.id === id) return p;
  }
  return book.paragraphs.find((p) => p.id === id);
}

function getParagraphIndexById(book: Book, id: number) {
  // Optimization for 1-based sequential IDs
  if (id > 0 && id <= book.paragraphs.length) {
    const p = book.paragraphs[id - 1];
    if (p && p.id === id) return id - 1;
  }
  return book.paragraphs.findIndex((p) => p.id === id);
}

function buildChapterProgressCache(book: Book): ChapterProgressCache | null {
  if (!book.chapters || book.chapters.length === 0) return null;

  const paragraphIndexById = new Map<number, number>();
  for (let i = 0; i < book.paragraphs.length; i += 1) {
    paragraphIndexById.set(book.paragraphs[i].id, i);
  }

  const paragraphWordPrefix: number[] = new Array(book.paragraphs.length + 1);
  paragraphWordPrefix[0] = 0;
  for (let i = 0; i < book.paragraphs.length; i += 1) {
    const paragraphWordCount = getWordCountForParagraph(book, book.paragraphs[i]);
    paragraphWordPrefix[i + 1] = paragraphWordPrefix[i] + paragraphWordCount;
  }

  const sortedChapters = [...book.chapters]
    .sort((a, b) => a.startParagraphId - b.startParagraphId
      || navigationPrecedence(a.kind ?? classifyNavigationTitle(a.title))
        - navigationPrecedence(b.kind ?? classifyNavigationTitle(b.title)))
    .filter((chapter, index, entries) => entries[index + 1]?.startParagraphId !== chapter.startParagraphId);
  const chapterBounds: ChapterProgressBounds[] = [];

  for (let i = 0; i < sortedChapters.length; i += 1) {
    const chapter = sortedChapters[i];
    const nextChapter = sortedChapters[i + 1];
    const startParagraphIndex = paragraphIndexById.get(chapter.startParagraphId);
    const endParagraphExclusive = nextChapter
      ? paragraphIndexById.get(nextChapter.startParagraphId)
      : book.paragraphs.length;

    if (startParagraphIndex === undefined || endParagraphExclusive === undefined) {
      return null;
    }

    if (endParagraphExclusive <= startParagraphIndex) {
      return null;
    }

    chapterBounds.push({
      startParagraphIndex,
      endParagraphExclusive,
      startWordOffset: paragraphWordPrefix[startParagraphIndex],
      totalWords: paragraphWordPrefix[endParagraphExclusive] - paragraphWordPrefix[startParagraphIndex],
    });
  }

  return {
    paragraphIndexById,
    paragraphWordPrefix,
    chapterBounds,
  };
}

function getChapterProgressCache(book: Book): ChapterProgressCache | null {
  if (chapterProgressCache.has(book)) {
    return chapterProgressCache.get(book) ?? null;
  }
  const cache = buildChapterProgressCache(book);
  chapterProgressCache.set(book, cache);
  return cache;
}

export function findChapterForParagraph(book: Book, paragraphId: number) {
  if (!book.chapters || book.chapters.length === 0) return null;

  let current = book.chapters[0];

  for (const chapter of book.chapters) {
    if (chapter.startParagraphId <= paragraphId) {
      current = chapter;
    } else {
      break;
    }
  }

  return current;
}

export function calculatePercentComplete(book: Book, position: Position): number {
  if (!book.paragraphs.length || !book.totalWords) return 0;

  let wordsBefore = 0;
  // We need the index of the current paragraph
  const currentParaIndex = getParagraphIndexById(book, position.paragraphId);
  
  if (currentParaIndex === -1) return 0;

  for (let i = 0; i < book.paragraphs.length; i += 1) {
    const para = book.paragraphs[i];
    const wordsInParagraph = getWordCountForParagraph(book, para);

    if (i < currentParaIndex) {
      wordsBefore += wordsInParagraph;
      continue;
    }

    if (i === currentParaIndex) {
      const clampedIndex = Math.max(0, Math.min(wordsInParagraph, position.wordIndex));
      wordsBefore += clampedIndex;
      break;
    }
  }

  const percent = (wordsBefore / book.totalWords) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function calculateChapterPercentComplete(book: Book, position: Position): number {
  if (!book.paragraphs.length || !book.totalWords) return 0;
  const cache = getChapterProgressCache(book);
  if (!cache) {
    return calculatePercentComplete(book, position);
  }

  const currentParagraphIndex = cache.paragraphIndexById.get(position.paragraphId);
  if (currentParagraphIndex === undefined) {
    return calculatePercentComplete(book, position);
  }

  const currentBounds = cache.chapterBounds.find(
    (bounds) =>
      currentParagraphIndex >= bounds.startParagraphIndex &&
      currentParagraphIndex < bounds.endParagraphExclusive
  );

  if (!currentBounds) {
    return calculatePercentComplete(book, position);
  }

  if (currentBounds.totalWords <= 0) {
    return 0;
  }

  const currentParagraphWords = getWordCountForParagraph(book, book.paragraphs[currentParagraphIndex]);
  const clampedWordIndex = Math.max(0, Math.min(currentParagraphWords, position.wordIndex));
  const wordsBeforeInBook = cache.paragraphWordPrefix[currentParagraphIndex] + clampedWordIndex;
  const wordsBeforeInChapter = wordsBeforeInBook - currentBounds.startWordOffset;

  const percent = (wordsBeforeInChapter / currentBounds.totalWords) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function getWordAtPosition(book: Book, position: Position): string | null {
  const paragraph = getParagraphById(book, position.paragraphId);
  if (!paragraph) return null;

  const words = getTokensForParagraph(book, paragraph);
  if (position.wordIndex < 0 || position.wordIndex >= words.length) {
    return null;
  }

  return words[position.wordIndex];
}

export function getNextPosition(book: Book, position: Position): Position | null {
  const paragraph = getParagraphById(book, position.paragraphId);
  if (!paragraph) return null;

  const words = getTokensForParagraph(book, paragraph);
  if (position.wordIndex + 1 < words.length) {
    return {
      paragraphId: position.paragraphId,
      wordIndex: position.wordIndex + 1
    };
  }

  // Move to next paragraph
  const currentIndex = getParagraphIndexById(book, position.paragraphId);
  if (currentIndex === -1) return null;
  
  let nextIndex = currentIndex + 1;
  
  while (nextIndex < book.paragraphs.length) {
    const next = book.paragraphs[nextIndex];
    const nextWords = getTokensForParagraph(book, next);
    if (nextWords.length === 0) {
      nextIndex += 1;
      continue;
    }
    return {
      paragraphId: next.id,
      wordIndex: 0
    };
  }

  return null;
}
