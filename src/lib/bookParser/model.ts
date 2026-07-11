import { countWords, normalizeText } from "./text.ts";
import type {
  BookFormat,
  BookImage,
  BookMetadata,
  Chapter,
  Cover,
  ParsedBook,
  Paragraph,
  ParserDiagnostic,
  ParserTimings,
} from "./types.ts";

interface BuildBookInput {
  format: BookFormat;
  metadata: BookMetadata;
  paragraphs: Paragraph[];
  chapters: Chapter[];
  images: BookImage[];
  cover: Cover | null;
  diagnostics?: ParserDiagnostic[];
  timings: ParserTimings;
}

const MIN_CHAPTERS_FOR_START_SPREAD = 4;
const MIN_DISTINCT_CHAPTER_START_RATIO = 0.4;

export function chaptersHaveCollapsedStarts(chapters: readonly Chapter[]): boolean {
  if (chapters.length < MIN_CHAPTERS_FOR_START_SPREAD) return false;
  const distinctStarts = new Set(chapters.map((chapter) => chapter.startParagraphId)).size;
  return distinctStarts / chapters.length < MIN_DISTINCT_CHAPTER_START_RATIO;
}

export function buildBook(input: BuildBookInput): ParsedBook {
  const paragraphs = input.paragraphs.map((paragraph, index) => ({
    id: index + 1,
    text: normalizeText(paragraph.text),
  }));
  const paragraphCount = paragraphs.length;
  const chapters = deduplicateChapters(input.chapters, paragraphCount);
  const images = input.images.map((image) => ({
    ...image,
    afterParagraphId: Math.max(0, Math.min(paragraphCount, image.afterParagraphId)),
    alt: normalizeText(image.alt),
  }));

  return {
    schemaVersion: 1,
    format: input.format,
    metadata: input.metadata,
    paragraphs,
    chapters,
    images,
    cover: input.cover,
    totals: {
      words: paragraphs.reduce((total, paragraph) => total + countWords(paragraph.text), 0),
      paragraphs: paragraphCount,
      chapters: chapters.length,
      images: images.length,
    },
    diagnostics: input.diagnostics ?? [],
    timings: input.timings,
  };
}

function deduplicateChapters(chapters: Chapter[], paragraphCount: number): Chapter[] {
  const seen = new Set<string>();
  const result: Chapter[] = [];

  for (const chapter of chapters) {
    const title = normalizeText(chapter.title);
    const startParagraphId = Math.max(1, Math.min(Math.max(paragraphCount, 1), chapter.startParagraphId));
    const key = `${title.toLocaleLowerCase()}\u0000${startParagraphId}`;
    if (title.length === 0 || title.length > 240 || seen.has(key)) continue;
    seen.add(key);
    result.push({ title, startParagraphId });
  }

  result.sort((left, right) => left.startParagraphId - right.startParagraphId);
  return result;
}
