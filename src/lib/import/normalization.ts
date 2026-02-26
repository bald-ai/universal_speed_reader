import type { BookChapterRow, BookChunkRow, StoredParagraph } from "@/types/storage";

const DEFAULT_CHUNK_SIZE = 50;

function tokenizeWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^["']+|["']+$/g, ""))
    .filter((word) => word.length > 0);
}

export function computeTotalWords(paragraphs: StoredParagraph[]): number {
  return paragraphs.reduce((sum, paragraph) => sum + tokenizeWords(paragraph.text).length, 0);
}

export function hasSequentialParagraphIds(paragraphs: StoredParagraph[]): boolean {
  for (let i = 0; i < paragraphs.length; i += 1) {
    const expectedId = i + 1;
    if (paragraphs[i].id !== expectedId) return false;
  }
  return true;
}

export function chunkParagraphs(
  bookId: string,
  paragraphs: StoredParagraph[],
  chunkSize = DEFAULT_CHUNK_SIZE
): BookChunkRow[] {
  const chunks: BookChunkRow[] = [];
  for (let start = 0; start < paragraphs.length; start += chunkSize) {
    chunks.push({
      book_id: bookId,
      chunk_index: chunks.length,
      paragraphs_json: paragraphs.slice(start, start + chunkSize),
    });
  }
  return chunks;
}

export function normalizeChapters(
  bookId: string,
  chapters: Array<{ title: string; start_paragraph_id: number }>
): BookChapterRow[] {
  return [...chapters]
    .sort((a, b) => a.start_paragraph_id - b.start_paragraph_id)
    .map((chapter, index) => ({
      book_id: bookId,
      chapter_index: index,
      title: chapter.title,
      start_paragraph_id: chapter.start_paragraph_id,
    }));
}

export function recomputeParagraphCountFromChunks(chunks: BookChunkRow[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.paragraphs_json.length, 0);
}
