import type { Book, Paragraph } from "@/types/book";
import { tokenizeParagraph } from "./wordExtraction";

const bookTokenCaches = new Map<string, Map<number, string[]>>();

function getTokenCacheKey(bookId: string, paragraphCount: number): string {
  return `${bookId}:${paragraphCount}`;
}

function getBookTokenCache(book: Book): Map<number, string[]> {
  const key = getTokenCacheKey(book.id, book.paragraphs.length);
  const existing = bookTokenCaches.get(key);
  if (existing) return existing;

  const fresh = new Map<number, string[]>();
  bookTokenCaches.set(key, fresh);
  return fresh;
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
  const prefix = `${bookId}:`;
  for (const key of bookTokenCaches.keys()) {
    if (key.startsWith(prefix)) {
      bookTokenCaches.delete(key);
    }
  }
}
