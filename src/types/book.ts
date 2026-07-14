import type { NavigationKind } from "@/types/navigation";

export type Paragraph = {
  id: number;
  text: string;
  chapterIndex?: number;
  /** Anonymous narrative transition immediately before this real paragraph. */
  sceneBreakBefore?: SceneBreakSource;
};

export type SceneBreakSource = "text-ornament" | "horizontal-rule" | "css-separator" | "whitespace";

export type BookSourceFormat = "EPUB" | "PDF";

export type Chapter = {
  index: number;
  title: string;
  startParagraphId: number;
  kind?: NavigationKind;
  level?: number;
};

/** Sidecar image block for normal reading; anchored after a paragraph (0 = before first). */
export type BookImage = {
  id: string;
  afterParagraphId: number;
  alt: string | null;
  src: string;
};

export type Book = {
  id: string;
  title: string;
  author?: string;
  coverUrl?: string;
  paragraphs: Paragraph[];
  chapters: Chapter[];
  images: BookImage[];
  totalWords: number;
};

// A lightweight "preview" shape for the library UI.
// Derived from Book so we don't invent a totally new shape.
export type LibraryBook = Pick<Book, "id" | "title" | "author" | "coverUrl"> & {
  genre: string;
  description: string;
  progressPercent: number;
  sourceFormat?: BookSourceFormat;
};

export type Mood = {
  id: string;
  label: string;
  icon?: string;
  color?: string;
  imageUrl?: string;
  bookIds: string[];
};
