import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";
import { BookImportService } from "@/lib/import/bookImportService";
import { loadRawEpub } from "@/lib/import/rawEpubStore";
import {
  __resetMoodStoreForTests,
  loadFolders,
  loadRecent,
  saveFolders,
  saveRecent,
} from "@/lib/moodStore";
import { TTS_REGEX_SETTINGS_KEY } from "@/lib/ttsRegex/storePersistence";
import type { ProcessingStatus } from "@/types/storage";

class TrackingRepository extends InMemoryBookRepository {
  readonly transitions: Array<{ status: ProcessingStatus; updatedAt: number }> = [];

  override async setBookAndImportStatus(
    bookId: string,
    attempt: number,
    status: ProcessingStatus,
    patch?: {
      processing_error?: string | null;
      updated_at?: number;
      finished_at?: number | null;
    }
  ) {
    await super.setBookAndImportStatus(bookId, attempt, status, patch);
    const book = await this.getBook(bookId);
    this.transitions.push({ status, updatedAt: book?.updated_at ?? Date.now() });
  }
}

async function waitForTerminalStatus(
  repo: TrackingRepository,
  bookId: string,
  timeoutMs = 220_000
): Promise<ProcessingStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const book = await repo.getBook(bookId);
    const status = book?.processing_status;
    if (status === "completed" || status === "failed") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for terminal status for ${bookId}`);
}

describe("book import service state machine", () => {
  let repo: TrackingRepository;
  let service: BookImportService;

  beforeEach(async () => {
    __resetMoodStoreForTests();
    repo = new TrackingRepository();
    await repo.init();
    service = new BookImportService(Promise.resolve(repo));
  });

  it("runs happy-path transitions and reaches completed", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/fitzgerald-great-gatsby.epub"));
    const bookId = await service.importFromBytes({
      fileName: "fitzgerald-great-gatsby.epub",
      mimeType: "application/epub+zip",
      bytes,
    });

    const terminal = await waitForTerminalStatus(repo, bookId);
    expect(terminal).toBe("completed");

    const transitionStatuses = repo.transitions.map((entry) => entry.status);
    expect(transitionStatuses).toContain("validating");
    expect(transitionStatuses).toContain("extracting_metadata");
    expect(transitionStatuses).toContain("extracting_text");
    expect(transitionStatuses).toContain("building_chapters");
    expect(transitionStatuses[transitionStatuses.length - 1]).toBe("completed");

    for (let i = 1; i < repo.transitions.length; i += 1) {
      expect(repo.transitions[i].updatedAt).toBeGreaterThanOrEqual(repo.transitions[i - 1].updatedAt);
    }
  });

  it("runs failure path to failed and stores error", async () => {
    const corrupted = new Uint8Array([1, 2, 3, 4, 5]);
    const bookId = await service.importFromBytes({
      fileName: "broken.epub",
      mimeType: "application/epub+zip",
      bytes: corrupted,
    });

    const terminal = await waitForTerminalStatus(repo, bookId);
    expect(terminal).toBe("failed");

    const book = await repo.getBook(bookId);
    expect(book?.processing_error).toContain("Corrupted/Unreadable EPUB");
    expect(repo.transitions[repo.transitions.length - 1]?.status).toBe("failed");
  });

  it("increments import_jobs attempt on manual retry", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/shelley-frankenstein.epub"));
    const bookId = await service.importFromBytes({
      fileName: "shelley-frankenstein.epub",
      mimeType: "application/epub+zip",
      bytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    await service.retryImport(bookId);
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    const jobs = await repo.listImportJobs(bookId);
    expect(jobs.map((job) => job.attempt)).toEqual([1, 2]);
    expect(jobs.every((job) => job.status === "completed")).toBe(true);
  });

  it("fails import cleanly when raw source persistence fails", async () => {
    const failingService = new BookImportService(Promise.resolve(repo), {
      store: async () => {
        throw new Error("QuotaExceeded");
      },
      load: async () => null,
      remove: async () => undefined,
    });

    const bookId = await failingService.importFromBytes({
      fileName: "storage-failure.epub",
      mimeType: "application/epub+zip",
      bytes: new Uint8Array([1, 2, 3]),
    });

    const terminal = await waitForTerminalStatus(repo, bookId);
    expect(terminal).toBe("failed");

    const book = await repo.getBook(bookId);
    expect(book?.processing_error).toContain("failed to persist source file");
    const jobs = await repo.listImportJobs(bookId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("failed");
  });

  it("deduplicates concurrent retry requests for the same book", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/fitzgerald-great-gatsby.epub"));
    const bookId = await service.importFromBytes({
      fileName: "fitzgerald-great-gatsby.epub",
      mimeType: "application/epub+zip",
      bytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    await Promise.all([service.retryImport(bookId), service.retryImport(bookId), service.retryImport(bookId)]);
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    const jobs = await repo.listImportJobs(bookId);
    expect(jobs.map((job) => job.attempt)).toEqual([1, 2]);
  });

  it("deletes completed books and removes all book-linked state", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/shelley-frankenstein.epub"));
    const bookId = await service.importFromBytes({
      fileName: "shelley-frankenstein.epub",
      mimeType: "application/epub+zip",
      bytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    expect(await loadRawEpub(bookId)).not.toBeNull();
    await repo.saveReadingProgress({
      book_id: bookId,
      paragraph_id: 5,
      word_index: 1,
      mode: "normal",
      updated_at: Date.now(),
    });
    await saveFolders(
      [
        { id: "focus", label: "Focus", bookIds: [bookId, "other-book"] },
        { id: "calm", label: "Calm", bookIds: [bookId] },
      ],
      { repository: repo }
    );
    await saveRecent(
      {
        focus: bookId,
        calm: "other-book",
      },
      { repository: repo }
    );
    await repo.putAppSetting(TTS_REGEX_SETTINGS_KEY, {
      version: 1,
      matchMode: "token",
      globalRules: [],
      bookRulesById: {
        [bookId]: [
          {
            id: "deleted-book-rule",
            pattern: "alpha",
            replacement: "bravo",
            enabled: true,
            caseInsensitive: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        "other-book": [
          {
            id: "other-book-rule",
            pattern: "charlie",
            replacement: "delta",
            enabled: true,
            caseInsensitive: true,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
    });

    await service.deleteBook(bookId);

    expect(await repo.getBook(bookId)).toBeNull();
    expect(await repo.getBookAggregate(bookId)).toBeNull();
    expect(await repo.getReadingProgress(bookId)).toBeNull();
    expect(await repo.listImportJobs(bookId)).toEqual([]);
    expect(await loadRawEpub(bookId)).toBeNull();
    expect(await loadFolders({ repository: repo })).toEqual([
      { id: "focus", label: "Focus", bookIds: ["other-book"] },
      { id: "calm", label: "Calm", bookIds: [] },
    ]);
    expect(await loadRecent({ repository: repo })).toEqual({
      calm: "other-book",
    });
    expect(await repo.getAppSetting<unknown>(TTS_REGEX_SETTINGS_KEY)).toEqual({
      version: 1,
      matchMode: "token",
      globalRules: [],
      bookRulesById: {
        "other-book": [
          {
            id: "other-book-rule",
            pattern: "charlie",
            replacement: "delta",
            enabled: true,
            caseInsensitive: true,
            createdAt: 2,
            updatedAt: 2,
            source: "regex",
          },
        ],
      },
    });
  });

  it("updates title, author, and replacement cover metadata", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/fitzgerald-great-gatsby.epub"));
    const bookId = await service.importFromBytes({
      fileName: "fitzgerald-great-gatsby.epub",
      mimeType: "application/epub+zip",
      bytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    await service.updateBookMetadata({
      bookId,
      title: "  Updated Title  ",
      author: "  Updated Author  ",
      coverDataUrl: "data:image/png;base64,AAAA",
    });

    const updated = await repo.getBook(bookId);
    expect(updated?.title).toBe("Updated Title");
    expect(updated?.author).toBe("Updated Author");
    expect(updated?.cover_path).toBe("data:image/png;base64,AAAA");
  });

  it("restoreOriginalBook resets reading progress after successful restore", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/shelley-frankenstein.epub"));
    const bookId = await service.importFromBytes({
      fileName: "shelley-frankenstein.epub",
      mimeType: "application/epub+zip",
      bytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    await repo.saveReadingProgress({
      book_id: bookId,
      paragraph_id: 5,
      word_index: 1,
      mode: "normal",
      updated_at: Date.now(),
    });
    expect(await repo.getReadingProgress(bookId)).not.toBeNull();

    await service.restoreOriginalBook(bookId);

    const book = await repo.getBook(bookId);
    expect(book?.processing_status).toBe("completed");
    expect(await repo.getReadingProgress(bookId)).toBeNull();
  });

  it("retryImport does not clear reading progress", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/shelley-frankenstein.epub"));
    const bookId = await service.importFromBytes({
      fileName: "shelley-frankenstein.epub",
      mimeType: "application/epub+zip",
      bytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    await repo.saveReadingProgress({
      book_id: bookId,
      paragraph_id: 5,
      word_index: 1,
      mode: "normal",
      updated_at: Date.now(),
    });

    await service.retryImport(bookId);
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    const progress = await repo.getReadingProgress(bookId);
    expect(progress?.paragraph_id).toBe(5);
    expect(progress?.word_index).toBe(1);
  });

  it("blocks restoreOriginalBook while the same book is processing", async () => {
    const bytes = new Uint8Array(readFileSync("fixtures/shelley-frankenstein.epub"));
    const bookId = await service.importFromBytes({
      fileName: "shelley-frankenstein.epub",
      mimeType: "application/epub+zip",
      bytes,
    });

    await expect(service.restoreOriginalBook(bookId)).rejects.toThrow(
      "Book is currently processing and cannot be restored"
    );
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
  });
});
