import type { Book } from "@/types/book";
import type { Position } from "@/types/reading";
import { getTokensForParagraph, getWordCountForParagraph } from "./tokenCache";

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
