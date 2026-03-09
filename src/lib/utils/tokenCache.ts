import type { Book, Paragraph } from "@/types/book";
import { tokenizeParagraph } from "./wordExtraction";

type TokenCacheEntry = {
  paragraphCount: number;
  tokensByParagraphId: Map<number, string[]>;
};

const bookTokenCaches = new Map<string, TokenCacheEntry>();

function getBookTokenCache(book: Book): Map<number, string[]> {
  const existing = bookTokenCaches.get(book.id);
  if (existing && existing.paragraphCount === book.paragraphs.length) {
    return existing.tokensByParagraphId;
  }

  const tokensByParagraphId = new Map<number, string[]>();
  bookTokenCaches.set(book.id, {
    paragraphCount: book.paragraphs.length,
    tokensByParagraphId,
  });
  return tokensByParagraphId;
}

export function getTokensForParagraph(book: Book, paragraph: Paragraph): string[] {
  const cache = getBookTokenCache(book);
  const existing = cache.get(paragraph.id);
  if (existing) return existing;

  const tokens = tokenizeParagraph(paragraph.text);
  cache.set(paragraph.id, tokens);
  return tokens;
}

export function getWordCountForParagraph(book: Book, paragraph: Paragraph): number {
  return getTokensForParagraph(book, paragraph).length;
}

export function primeBookTokenCache(book: Book): void {
  const cache = getBookTokenCache(book);
  for (const paragraph of book.paragraphs) {
    if (!cache.has(paragraph.id)) {
      cache.set(paragraph.id, tokenizeParagraph(paragraph.text));
    }
  }
}

export function clearBookTokenCache(bookId: string): void {
  bookTokenCaches.delete(bookId);
}
