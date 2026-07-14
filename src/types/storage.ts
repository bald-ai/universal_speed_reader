import type { Book } from "@/types/book";
import type { Mode } from "@/types/reading";
import type { NavigationKind } from "@/types/navigation";

export type ProcessingStatus =
  | "queued"
  | "validating"
  | "extracting_metadata"
  | "extracting_text"
  | "building_chapters"
  | "completed"
  | "failed";

export type ImportErrorBucket =
  | "Unsupported format"
  | "File too large"
  | "Corrupted/Unreadable book"
  | "Book content not reliable"
  | "Processing timeout";

/** Soft import issues kept on completed, openable books. */
export type ProcessingWarning = {
  code: string;
  message: string;
};

export type StoredParagraph = {
  id: number;
  text: string;
  sceneBreakBefore?: "text-ornament" | "horizontal-rule" | "css-separator" | "whitespace";
};

export type StoredChapter = {
  index: number;
  title: string;
  start_paragraph_id: number;
  kind?: NavigationKind;
  level?: number;
};

export type BookRow = {
  id: string;
  title: string;
  author: string | null;
  cover_path: string | null;
  language: string | null;
  source_uri: string;
  size_bytes: number;
  processing_status: ProcessingStatus;
  processing_error: string | null;
  /** Soft issues from import; null/empty when the book completed cleanly. */
  processing_warnings: ProcessingWarning[] | null;
  total_chunks: number;
  total_paragraphs: number;
  total_words: number;
  created_at: number;
  updated_at: number;
};

export type BookPatch = Partial<Omit<BookRow, "id" | "created_at">>;

export type BookChunkRow = {
  book_id: string;
  chunk_index: number;
  paragraphs_json: StoredParagraph[];
};

export type BookChapterRow = {
  book_id: string;
  chapter_index: number;
  title: string;
  start_paragraph_id: number;
  kind?: NavigationKind;
  level?: number;
};

export type BookImageRow = {
  book_id: string;
  image_index: number;
  after_paragraph_id: number;
  alt: string | null;
  src: string;
};

export type ReadingProgressRow = {
  book_id: string;
  paragraph_id: number;
  word_index: number;
  mode: Mode;
  updated_at: number;
};

export type AppSettingRow = {
  key: string;
  value_json: unknown;
};

export type ImportJobRow = {
  book_id: string;
  attempt: number;
  status: ProcessingStatus;
  error: string | null;
  started_at: number;
  finished_at: number | null;
};

export type ImportJobPatch = Partial<Pick<ImportJobRow, "status" | "error" | "finished_at">>;

export type StorageSnapshot = {
  books: BookRow[];
  book_chunks: BookChunkRow[];
  book_chapters: BookChapterRow[];
  book_images: BookImageRow[];
  reading_progress: ReadingProgressRow[];
  app_settings: AppSettingRow[];
  import_jobs: ImportJobRow[];
};

export type BookContentReplacement = {
  chunks: BookChunkRow[];
  chapters: BookChapterRow[];
  images: BookImageRow[];
  total_paragraphs: number;
  total_words: number;
  total_chunks: number;
};

export type StoredBookAggregate = {
  book: BookRow;
  chapters: BookChapterRow[];
  chunks: BookChunkRow[];
  images: BookImageRow[];
};

export type ReadableBookBundle = {
  metadata: BookRow;
  book: Book;
};
