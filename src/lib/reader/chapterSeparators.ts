import type { Book } from "@/types/book";
import type { Chapter } from "@/types/book";
import { classifyNavigationTitle, navigationPrecedence } from "@/lib/navigationHierarchy";

function comparableHeading(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function buildChapterSeparatorStarts(book: Pick<Book, "chapters" | "paragraphs">): Set<number> {
  const firstParagraphId = book.paragraphs[0]?.id ?? 1;
  return new Set(book.chapters
    .map((chapter) => chapter.startParagraphId)
    .filter((start) => start > firstParagraphId));
}

export function isDuplicateVisibleChapterHeading(
  book: Pick<Book, "chapters">,
  paragraphId: number,
  paragraphText: string,
): boolean {
  const chapter = book.chapters.find((entry) => entry.startParagraphId === paragraphId);
  if (chapter === undefined) return false;
  const kind = chapter.kind ?? classifyNavigationTitle(chapter.title);
  return (kind === "chapter" || kind === "part")
    && comparableHeading(chapter.title) === comparableHeading(paragraphText);
}

export function navigationEntryAtParagraph(
  book: Pick<Book, "chapters">,
  paragraphId: number,
): Chapter | null {
  return book.chapters
    .filter((entry) => entry.startParagraphId === paragraphId)
    .sort((left, right) => navigationPrecedence(
      left.kind ?? classifyNavigationTitle(left.title),
    ) - navigationPrecedence(
      right.kind ?? classifyNavigationTitle(right.title),
    ))
    .at(-1) ?? null;
}
