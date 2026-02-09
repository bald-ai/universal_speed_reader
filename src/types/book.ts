export type Paragraph = {
  id: number;
  text: string;
  chapterIndex?: number;
};

export type Chapter = {
  index: number;
  title: string;
  startParagraphId: number;
};

export type Book = {
  id: string;
  title: string;
  author?: string;
  coverUrl?: string;
  paragraphs: Paragraph[];
  chapters: Chapter[];
  totalWords: number;
};

// A lightweight "preview" shape for the library UI.
// Derived from Book so we don't invent a totally new shape.
export type LibraryBook = Pick<Book, "id" | "title" | "author" | "coverUrl"> & {
  genre: string;
  description: string;
  isMock?: boolean;
};

export type MoodFolder = {
  id: string;
  label: string;
  imageUrl?: string; // folder cover image
  bookIds: string[]; // references LibraryBook.id
  isMock?: boolean;
};
