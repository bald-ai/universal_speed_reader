import { describe, expect, test } from "bun:test";
import {
  collectSelectedBookIds,
  formatLibrarySelectionCount,
  getFolderSubtreeSelectionKeys,
  getMovableSelection,
  getRootSelectedFolderIds,
  librarySelectionKey,
  setFolderSubtreeSelected,
  syncCascadeFolderSelection,
  toggleLibrarySelection,
} from "@/lib/library/bulkSelection";
import type { LibraryLayout } from "@/types/libraryLayout";

const layout: LibraryLayout = {
  folders: [
    { id: "classics", label: "Classics", parentId: null, order: 0 },
    { id: "russian", label: "Russian", parentId: "classics", order: 0 },
    { id: "tolstoy", label: "Tolstoy", parentId: "russian", order: 0 },
    { id: "empty", label: "Empty", parentId: null, order: 1 },
  ],
  placements: [
    { bookId: "anna", parentId: "tolstoy", order: 0 },
    { bookId: "war", parentId: "tolstoy", order: 1 },
    { bookId: "crime", parentId: "russian", order: 1 },
    { bookId: "dune", parentId: null, order: 0 },
  ],
};

describe("bulkSelection cascade", () => {
  test("folder subtree keys include nested folders and books", () => {
    const keys = getFolderSubtreeSelectionKeys(layout, "russian");
    expect(keys).toContain("folder:russian");
    expect(keys).toContain("folder:tolstoy");
    expect(keys).toContain("book:anna");
    expect(keys).toContain("book:war");
    expect(keys).toContain("book:crime");
    expect(keys).not.toContain("book:dune");
  });

  test("selecting a folder selects the whole subtree", () => {
    const selected = setFolderSubtreeSelected(new Set(), layout, "russian", true);
    expect(selected.has("folder:russian")).toBe(true);
    expect(selected.has("folder:tolstoy")).toBe(true);
    expect(selected.has("book:anna")).toBe(true);
    expect(selected.has("book:crime")).toBe(true);
  });

  test("partial child selection marks parent indeterminate", () => {
    const selected = new Set([librarySelectionKey({ kind: "book", id: "anna" })]);
    const synced = syncCascadeFolderSelection(selected, layout);
    expect(synced.selected.has("folder:tolstoy")).toBe(false);
    expect(synced.partialFolderIds.has("tolstoy")).toBe(true);
    expect(synced.partialFolderIds.has("russian")).toBe(true);
    expect(synced.partialFolderIds.has("classics")).toBe(true);
  });

  test("all children selected checks parent folders", () => {
    let selected = setFolderSubtreeSelected(new Set(), layout, "tolstoy", true);
    selected.add(librarySelectionKey({ kind: "book", id: "crime" }));
    const synced = syncCascadeFolderSelection(selected, layout);
    expect(synced.selected.has("folder:tolstoy")).toBe(true);
    expect(synced.selected.has("folder:russian")).toBe(true);
    expect(synced.partialFolderIds.size).toBe(0);
  });

  test("toggle folder off clears subtree", () => {
    const on = setFolderSubtreeSelected(new Set(), layout, "russian", true);
    const off = toggleLibrarySelection(on, layout, { kind: "folder", id: "russian" });
    expect(off.has("folder:russian")).toBe(false);
    expect(off.has("book:anna")).toBe(false);
  });

  test("count label uses folders and books", () => {
    const selected = setFolderSubtreeSelected(new Set(["book:dune"]), layout, "tolstoy", true);
    expect(formatLibrarySelectionCount(selected)).toBe("1 folder · 3 books");
  });

  test("root selected folders skip nested selected folders", () => {
    const selected = setFolderSubtreeSelected(new Set(), layout, "classics", true);
    expect(getRootSelectedFolderIds(selected, layout)).toEqual(["classics"]);
  });

  test("movable selection skips books covered by selected folders", () => {
    const selected = setFolderSubtreeSelected(new Set(["book:dune"]), layout, "tolstoy", true);
    const movable = getMovableSelection(selected, layout);
    expect(movable.folderIds).toEqual(["tolstoy"]);
    expect(movable.bookIds).toEqual(["dune"]);
  });

  test("collectSelectedBookIds returns only books", () => {
    const selected = setFolderSubtreeSelected(new Set(), layout, "tolstoy", true);
    expect(collectSelectedBookIds(selected).sort()).toEqual(["anna", "war"]);
  });
});
