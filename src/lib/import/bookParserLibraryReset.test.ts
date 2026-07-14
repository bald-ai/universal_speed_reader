import { afterEach, describe, expect, test } from "bun:test";
import { applyBookParserLibraryReset } from "./bookParserLibraryReset";
import { loadRawBook, storeRawBook } from "./rawEpubStore";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";
import { setBookRepositoryForTests } from "@/lib/storage/appRepository";
import { __resetMoodStoreForTests } from "@/lib/moodStore";
import { TTS_REGEX_SETTINGS_KEY } from "@/lib/ttsRegex/storePersistence";

afterEach(() => {
  setBookRepositoryForTests(null);
  __resetMoodStoreForTests();
});

describe("book parser library reset", () => {
  test("performs the approved fresh start once and preserves preferences", async () => {
    const repository = new InMemoryBookRepository();
    await repository.init();
    setBookRepositoryForTests(repository);
    await repository.upsertBook({
      id: "old-book",
      title: "Old book",
      author: null,
      cover_path: null,
      language: null,
      source_uri: "indexeddb://raw_books/old-book/old.epub",
      size_bytes: 1,
      processing_status: "completed",
      processing_error: null,
      processing_warnings: null,
      total_chunks: 0,
      total_paragraphs: 0,
      total_words: 0,
      created_at: 1,
      updated_at: 1,
    });
    await repository.putAppSetting("theme", "dark");
    const globalRule = {
      id: "global",
      pattern: "global",
      replacement: "global",
      source: "regex" as const,
      enabled: true,
      caseInsensitive: true,
      createdAt: 1,
      updatedAt: 1,
    };
    await repository.putAppSetting(TTS_REGEX_SETTINGS_KEY, {
      version: 1,
      matchMode: "token",
      globalRules: [globalRule],
      bookRulesById: { "old-book": [{ ...globalRule, id: "book-rule" }] },
    });
    await storeRawBook({
      bookId: "old-book",
      fileName: "old.epub",
      mimeType: "application/epub+zip",
      sizeBytes: 1,
      bytes: new Uint8Array([1]),
      storedAt: 1,
    });

    await applyBookParserLibraryReset();
    await applyBookParserLibraryReset();

    expect(await repository.listBooks()).toEqual([]);
    expect(await loadRawBook("old-book")).toBeNull();
    expect(await repository.getAppSetting<string>("theme")).toBe("dark");
    expect(await repository.getAppSetting<boolean>("book_parser_library_reset.v3_scene_hierarchy")).toBe(true);
    expect(await repository.getAppSetting<unknown>(TTS_REGEX_SETTINGS_KEY)).toEqual({
      version: 1,
      matchMode: "token",
      globalRules: [globalRule],
      bookRulesById: {},
    });
  });
});
