import { getBookRepository } from "@/lib/storage/appRepository";
import type { BookSourceFormat, LibraryBook } from "@/types/book";
import type { BookRow, ProcessingStatus, ProcessingWarning } from "@/types/storage";

export type LibraryEntry = {
  id: string;
  title: string;
  author: string;
  coverUrl?: string;
  processingStatus: ProcessingStatus;
  processingStatusLabel: "Queued" | "Processing" | "Completed" | "Failed";
  processingError: string | null;
  processingWarnings: ProcessingWarning[];
  totalWords: number;
  totalParagraphs: number;
  progressPercent: number;
  sourceFormat: BookSourceFormat | null;
  libraryBook: LibraryBook;
};

export function getBookSourceFormat(sourceUri: string): BookSourceFormat | null {
  let normalized = sourceUri.trim().toLowerCase();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // A malformed legacy URI can still be checked in its stored form.
  }
  const path = normalized.split(/[?#]/u, 1)[0] ?? normalized;
  if (path.endsWith(".epub")) return "EPUB";
  if (path.endsWith(".pdf")) return "PDF";
  return null;
}

function statusLabel(status: ProcessingStatus): LibraryEntry["processingStatusLabel"] {
  if (status === "queued") return "Queued";
  if (status === "failed") return "Failed";
  if (status === "completed") return "Completed";
  return "Processing";
}

function buildDescription(book: BookRow): string {
  if (book.processing_status === "failed") {
    return book.processing_error ?? "Import failed";
  }
  if (book.processing_status !== "completed") {
    return "Import in progress";
  }
  return `${book.total_words.toLocaleString()} words · ${book.total_paragraphs.toLocaleString()} paragraphs`;
}

function estimateProgressPercent(totalParagraphs: number, paragraphId: number): number {
  if (totalParagraphs <= 0) return 0;
  const clamped = Math.max(1, Math.min(totalParagraphs, paragraphId));
  const percent = Math.round(((clamped - 1) / totalParagraphs) * 100);
  return Math.max(0, Math.min(100, percent));
}

export async function loadLibraryEntries(): Promise<LibraryEntry[]> {
  const repository = await getBookRepository();
  const [books, progressRows] = await Promise.all([
    repository.listBooks(),
    repository.listReadingProgress(),
  ]);
  const progressByBookId = new Map(progressRows.map((progress) => [progress.book_id, progress]));

  return books.map((book) => {
    const progress = progressByBookId.get(book.id) ?? null;
    const progressPercent = progress
      ? estimateProgressPercent(book.total_paragraphs, progress.paragraph_id)
      : 0;
    const sourceFormat = getBookSourceFormat(book.source_uri);

    return {
      id: book.id,
      title: book.title,
      author: book.author ?? "Unknown author",
      coverUrl: book.cover_path ?? undefined,
      processingStatus: book.processing_status,
      processingStatusLabel: statusLabel(book.processing_status),
      processingError: book.processing_error,
      processingWarnings: book.processing_warnings ?? [],
      totalWords: book.total_words,
      totalParagraphs: book.total_paragraphs,
      progressPercent,
      sourceFormat,
      libraryBook: {
        id: book.id,
        title: book.title,
        author: book.author ?? "Unknown author",
        coverUrl: book.cover_path ?? undefined,
        genre: "Book",
        description: buildDescription(book),
        progressPercent,
        ...(sourceFormat ? { sourceFormat } : {}),
      },
    };
  });
}
