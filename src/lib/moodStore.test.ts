import { beforeEach, describe, expect, it } from "bun:test";
import type { LibraryBook, MoodFolder } from "../types/book";
import {
  getUnassignedBooks,
  loadFolders,
  loadRecent,
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
  },
  {
    id: "b-2",
    title: "Book 2",
    author: "B",
    genre: "Romance",
    description: "D2",
  },
  {
    id: "b-3",
    title: "Book 3",
    author: "C",
    genre: "Fantasy",
    description: "D3",
  },
];

describe("moodStore", () => {
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
});
