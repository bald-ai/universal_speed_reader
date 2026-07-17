import { beforeEach, describe, expect, it } from "bun:test";
import type { LibraryLayout } from "@/types/libraryLayout";
import {
  __resetLibraryLayoutStoreForTests,
  addLibraryFolder,
  deleteLibraryFolderOnly,
  deleteLibraryFolderWithContents,
  getBookIdsInFolderSubtree,
  getFolderPathLabels,
  LIBRARY_LAYOUT_STORAGE_KEY,
  loadLibraryLayout,
  moveBookToFolder,
  moveLibraryFolder,
  pruneEmptyFolders,
  reorderLibraryLevel,
  saveLibraryLayout,
  updateLibraryFolder,
} from "./libraryLayoutStore";

type LocalStorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

const EMPTY_LAYOUT: LibraryLayout = { folders: [], placements: [] };

function installLocalStorageMock(initial: Record<string, string> = {}): {
  restore: () => void;
  data: Record<string, string>;
} {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data: Record<string, string> = { ...initial };
  const storage: LocalStorageMock = {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
    clear: () => {
      for (const key of Object.keys(data)) {
        delete data[key];
      }
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });

  return {
    data,
    restore: () => {
      if (previousDescriptor) {
        Object.defineProperty(globalThis, "localStorage", previousDescriptor);
        return;
      }
      delete (globalThis as { localStorage?: LocalStorageMock }).localStorage;
    },
  };
}

describe("libraryLayoutStore helpers", () => {
  beforeEach(() => {
    __resetLibraryLayoutStoreForTests();
  });

  it("adds nested folders and moves books into them", () => {
    const fantasy = addLibraryFolder(EMPTY_LAYOUT, {
      id: "f-fantasy",
      label: "Fantasy",
    });
    const sanderson = addLibraryFolder(fantasy.layout, {
      id: "f-sanderson",
      label: "Sanderson",
      parentId: fantasy.folder.id,
    });

    const withBook = moveBookToFolder(sanderson.layout, "book-1", sanderson.folder.id);

    expect(withBook.folders).toEqual([
      { id: "f-fantasy", label: "Fantasy", parentId: null, order: 0 },
      { id: "f-sanderson", label: "Sanderson", parentId: "f-fantasy", order: 0 },
    ]);
    expect(withBook.placements).toEqual([
      { bookId: "book-1", parentId: "f-sanderson", order: 0 },
    ]);
    expect(getFolderPathLabels(withBook, "f-sanderson")).toEqual(["Fantasy", "Sanderson"]);
  });

  it("can insert a new folder at the top of its level", () => {
    let layout = addLibraryFolder(EMPTY_LAYOUT, { id: "first", label: "First" }).layout;
    layout = addLibraryFolder(layout, { id: "second", label: "Second", insertAt: "top" }).layout;

    expect(layout.folders.map((folder) => `${folder.id}:${folder.order}`)).toEqual(["second:0", "first:1"]);
  });

  it("prevents moving a folder into its own subtree", () => {
    const parent = addLibraryFolder(EMPTY_LAYOUT, { id: "parent", label: "Parent" });
    const child = addLibraryFolder(parent.layout, {
      id: "child",
      label: "Child",
      parentId: "parent",
    });

    const moved = moveLibraryFolder(child.layout, "parent", "child");

    expect(moved.folders.find((folder) => folder.id === "parent")?.parentId).toBe(null);
  });

  it("reorders folders and books inside one level", () => {
    let layout = addLibraryFolder(EMPTY_LAYOUT, { id: "a", label: "A" }).layout;
    layout = addLibraryFolder(layout, { id: "b", label: "B" }).layout;
    layout = moveBookToFolder(layout, "book-a", null);
    layout = moveBookToFolder(layout, "book-b", null);

    const reordered = reorderLibraryLevel(layout, null, [
      { kind: "folder", id: "b" },
      { kind: "folder", id: "a" },
      { kind: "book", id: "book-b" },
      { kind: "book", id: "book-a" },
    ]);

    expect(reordered.folders.map((folder) => `${folder.id}:${folder.order}`)).toEqual(["b:0", "a:1"]);
    expect(reordered.placements.map((placement) => `${placement.bookId}:${placement.order}`)).toEqual([
      "book-b:0",
      "book-a:1",
    ]);
  });

  it("delete folder only moves direct contents up one level", () => {
    let layout = addLibraryFolder(EMPTY_LAYOUT, { id: "parent", label: "Parent" }).layout;
    layout = addLibraryFolder(layout, { id: "child", label: "Child", parentId: "parent" }).layout;
    layout = moveBookToFolder(layout, "book-direct", "parent");
    layout = moveBookToFolder(layout, "book-nested", "child");

    const deleted = deleteLibraryFolderOnly(layout, "parent");

    expect(deleted.folders).toEqual([{ id: "child", label: "Child", parentId: null, order: 0 }]);
    expect(deleted.placements).toEqual([
      { bookId: "book-direct", parentId: null, order: 0 },
      { bookId: "book-nested", parentId: "child", order: 0 },
    ]);
  });

  it("delete folder with contents removes the whole subtree and reports deleted books", () => {
    let layout = addLibraryFolder(EMPTY_LAYOUT, { id: "parent", label: "Parent" }).layout;
    layout = addLibraryFolder(layout, { id: "child", label: "Child", parentId: "parent" }).layout;
    layout = moveBookToFolder(layout, "book-direct", "parent");
    layout = moveBookToFolder(layout, "book-nested", "child");
    layout = moveBookToFolder(layout, "book-root", null);

    const result = deleteLibraryFolderWithContents(layout, "parent");

    expect(result.removedBookIds.sort()).toEqual(["book-direct", "book-nested"]);
    expect(result.layout.folders).toEqual([]);
    expect(result.layout.placements).toEqual([{ bookId: "book-root", parentId: null, order: 0 }]);
    expect(getBookIdsInFolderSubtree(layout, "parent").sort()).toEqual(["book-direct", "book-nested"]);
  });

  it("pruneEmptyFolders removes only empty folders from the provided set", () => {
    let layout = addLibraryFolder(EMPTY_LAYOUT, { id: "keep-root", label: "Keep" }).layout;
    layout = addLibraryFolder(layout, { id: "import-root", label: "Import" }).layout;
    layout = addLibraryFolder(layout, {
      id: "import-empty",
      label: "Empty",
      parentId: "import-root",
    }).layout;
    layout = addLibraryFolder(layout, {
      id: "import-kept",
      label: "Kept",
      parentId: "import-root",
    }).layout;
    layout = moveBookToFolder(layout, "book-a", "import-kept");
    layout = moveBookToFolder(layout, "book-unrelated", "keep-root");

    const pruned = pruneEmptyFolders(layout, ["import-root", "import-empty", "import-kept"]);

    expect(pruned.folders.map((folder) => folder.id).sort()).toEqual([
      "import-kept",
      "import-root",
      "keep-root",
    ]);
    expect(pruned.placements.map((placement) => placement.bookId).sort()).toEqual([
      "book-a",
      "book-unrelated",
    ]);
  });

  it("renames folder label/icon/color", () => {
    const added = addLibraryFolder(EMPTY_LAYOUT, { id: "folder", label: "Draft" });
    const updated = updateLibraryFolder(added.layout, "folder", {
      label: "Library",
      icon: "sparkles",
      color: "cyan",
    });

    expect(updated.folders[0]).toEqual({
      id: "folder",
      label: "Library",
      icon: "sparkles",
      color: "cyan",
      parentId: null,
      order: 0,
    });
  });
});

describe("libraryLayoutStore persistence", () => {
  beforeEach(() => {
    __resetLibraryLayoutStoreForTests();
  });

  it("hydrates from localStorage and returns clones", async () => {
    const persisted = {
      version: 1,
      folders: [{ id: "f-1", label: "Stored", parentId: null, order: 0 }],
      placements: [{ bookId: "b-1", parentId: "f-1", order: 0 }],
    };
    const { restore } = installLocalStorageMock({
      [LIBRARY_LAYOUT_STORAGE_KEY]: JSON.stringify(persisted),
    });

    const loaded = await loadLibraryLayout();
    loaded.folders[0].label = "Mutated";

    expect(await loadLibraryLayout()).toEqual({
      folders: persisted.folders,
      placements: persisted.placements,
    });

    restore();
  });

  it("persists updates to localStorage", async () => {
    const { data, restore } = installLocalStorageMock();

    await saveLibraryLayout({
      folders: [{ id: "f-1", label: "Stored", parentId: null, order: 0 }],
      placements: [{ bookId: "b-1", parentId: "f-1", order: 0 }],
    });

    const parsed = JSON.parse(data[LIBRARY_LAYOUT_STORAGE_KEY]);
    expect(parsed).toEqual({
      version: 1,
      folders: [{ id: "f-1", label: "Stored", parentId: null, order: 0 }],
      placements: [{ bookId: "b-1", parentId: "f-1", order: 0 }],
    });

    restore();
  });
});
