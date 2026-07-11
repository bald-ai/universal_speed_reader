import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AddLibraryFolderToMoodSheet from "./AddLibraryFolderToMoodSheet";
import type { LibraryBook, Mood } from "@/types/book";
import type { LibraryLayout } from "@/types/libraryLayout";

const MOOD: Mood = {
  id: "mood-1",
  label: "Focus",
  bookIds: [],
};

const BOOKS: LibraryBook[] = [
  {
    id: "book-1",
    title: "Heart of Darkness",
    author: "Joseph Conrad",
    genre: "EPUB",
    description: "Imported",
    progressPercent: 0,
  },
  {
    id: "book-2",
    title: "Second Book",
    author: "Author",
    genre: "EPUB",
    description: "Imported",
    progressPercent: 0,
  },
];

const LAYOUT: LibraryLayout = {
  folders: [
    { id: "root", label: "Imported", parentId: null, order: 0 },
    { id: "child", label: "Nested", parentId: "root", order: 0 },
  ],
  placements: [
    { bookId: "book-1", parentId: "root", order: 0 },
    { bookId: "book-2", parentId: "child", order: 0 },
  ],
};

describe("AddLibraryFolderToMoodSheet", () => {
  it("lists library folders with full paths and book counts", () => {
    const html = renderToStaticMarkup(
      <AddLibraryFolderToMoodSheet
        mood={MOOD}
        books={BOOKS}
        layout={LAYOUT}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(html).toContain("Add folder to Focus");
    expect(html).toContain("Imported");
    expect(html).toContain("Imported / Nested");
    expect(html).toContain("2 books");
    expect(html).toContain("1 books");
  });
});
