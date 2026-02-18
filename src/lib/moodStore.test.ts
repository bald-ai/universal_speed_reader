import { beforeEach, describe, expect, it } from "bun:test";
import type { LibraryBook, MoodFolder } from "../types/book";
import {
  __resetMoodStoreForTests,
  getUnassignedBooks,
  loadFolders,
  loadRecent,
  MOOD_STORE_STORAGE_KEY,
  removeBookReferences,
  saveFolders,
  saveRecent,
  setRecent,
} from "./moodStore";

const BASE_FOLDERS: MoodFolder[] = [
  { id: "f-1", label: "Focus", bookIds: ["b-1"] },
  { id: "f-2", label: "Chill", bookIds: [] },
];

const ALL_BOOKS: LibraryBook[] = [
  {
    id: "b-1",
    title: "Book 1",
    author: "A",
    genre: "Science",
    description: "D1",
    progressPercent: 0,
  },
  {
    id: "b-2",
    title: "Book 2",
    author: "B",
    genre: "Romance",
    description: "D2",
    progressPercent: 0,
  },
  {
    id: "b-3",
    title: "Book 3",
    author: "C",
    genre: "Fantasy",
    description: "D3",
    progressPercent: 0,
  },
];

type LocalStorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

function installLocalStorageMock(initial: Record<string, string> = {}): {
  restore: () => void;
  storage: LocalStorageMock;
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

  const restore = () => {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "localStorage", previousDescriptor);
      return;
    }
    delete (globalThis as { localStorage?: LocalStorageMock }).localStorage;
  };

  return { restore, storage, data };
}

describe("moodStore", () => {
  beforeEach(() => {
    __resetMoodStoreForTests();
  });

  beforeEach(async () => {
    await saveFolders(BASE_FOLDERS);
    await saveRecent({});
  });

  it("returns deep-cloned folders from loadFolders", async () => {
    const first = await loadFolders();
    first[0].label = "Mutated";
    first[0].bookIds.push("b-3");

    const second = await loadFolders();
    expect(second[0].label).toBe("Focus");
    expect(second[0].bookIds).toEqual(["b-1"]);
  });

  it("copies input on saveFolders so later caller mutation does not leak", async () => {
    const input: MoodFolder[] = [{ id: "x", label: "X", bookIds: ["b-2"] }];
    await saveFolders(input);

    input[0].label = "Changed";
    input[0].bookIds.push("b-3");

    const loaded = await loadFolders();
    expect(loaded).toEqual([{ id: "x", label: "X", bookIds: ["b-2"] }]);
  });

  it("finds unassigned books across all folders", () => {
    const folders: MoodFolder[] = [
      { id: "f1", label: "A", bookIds: ["b-1", "b-2"] },
      { id: "f2", label: "B", bookIds: ["b-2"] },
    ];

    const unassigned = getUnassignedBooks(folders, ALL_BOOKS);
    expect(unassigned.map((b) => b.id)).toEqual(["b-3"]);
  });

  it("loadRecent/saveRecent use copy semantics", async () => {
    await saveRecent({ "f-1": "b-1" });
    const loaded = await loadRecent();

    loaded["f-2"] = "b-2";

    const loadedAgain = await loadRecent();
    expect(loadedAgain).toEqual({ "f-1": "b-1" });
  });

  it("setRecent merges with existing keys instead of replacing them", async () => {
    await saveRecent({ "f-1": "b-1" });
    await setRecent("f-2", "b-2");

    expect(await loadRecent()).toEqual({
      "f-1": "b-1",
      "f-2": "b-2",
    });
  });

  it("removeBookReferences clears book ids from folders and recent map", async () => {
    await saveFolders([
      { id: "f-1", label: "Focus", bookIds: ["b-1", "b-2"] },
      { id: "f-2", label: "Chill", bookIds: ["b-1"] },
    ]);
    await saveRecent({
      "f-1": "b-1",
      "f-2": "b-3",
    });

    await removeBookReferences("b-1");

    expect(await loadFolders()).toEqual([
      { id: "f-1", label: "Focus", bookIds: ["b-2"] },
      { id: "f-2", label: "Chill", bookIds: [] },
    ]);
    expect(await loadRecent()).toEqual({
      "f-2": "b-3",
    });
  });

  it("hydrates folders and recents from localStorage once", async () => {
    const persisted = {
      version: 1,
      folders: [{ id: "persisted-folder", label: "Persisted", icon: "sparkles", color: "amber", bookIds: ["b-2"] }],
      recent: { "persisted-folder": "b-2" },
    };
    const { restore } = installLocalStorageMock({
      [MOOD_STORE_STORAGE_KEY]: JSON.stringify(persisted),
    });

    __resetMoodStoreForTests();
    expect(await loadFolders()).toEqual(persisted.folders);
    expect(await loadRecent()).toEqual(persisted.recent);
    restore();
  });

  it("falls back to empty state when persisted JSON is malformed", async () => {
    const { restore } = installLocalStorageMock({
      [MOOD_STORE_STORAGE_KEY]: "{invalid-json",
    });

    __resetMoodStoreForTests();
    expect(await loadFolders()).toEqual([]);
    expect(await loadRecent()).toEqual({});
    restore();
  });

  it("persists updates to localStorage on folder/recent changes", async () => {
    const { data, restore } = installLocalStorageMock();
    __resetMoodStoreForTests();

    await saveFolders([{ id: "f-persist", label: "Persist Me", bookIds: ["b-3"] }]);
    await setRecent("f-persist", "b-3");

    const raw = data[MOOD_STORE_STORAGE_KEY];
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw);
    expect(parsed.folders).toEqual([{ id: "f-persist", label: "Persist Me", bookIds: ["b-3"] }]);
    expect(parsed.recent).toEqual({ "f-persist": "b-3" });
    restore();
  });

  it("removeBookReferences also updates persisted localStorage state", async () => {
    const { data, restore } = installLocalStorageMock();
    __resetMoodStoreForTests();

    await saveFolders([
      { id: "f-1", label: "Focus", bookIds: ["b-1", "b-2"] },
      { id: "f-2", label: "Chill", bookIds: ["b-1"] },
    ]);
    await saveRecent({
      "f-1": "b-1",
      "f-2": "b-3",
    });

    await removeBookReferences("b-1");

    const raw = data[MOOD_STORE_STORAGE_KEY];
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw);
    expect(parsed.folders).toEqual([
      { id: "f-1", label: "Focus", bookIds: ["b-2"] },
      { id: "f-2", label: "Chill", bookIds: [] },
    ]);
    expect(parsed.recent).toEqual({ "f-2": "b-3" });
    restore();
  });
});
