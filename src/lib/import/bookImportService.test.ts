import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";
import { BookImportService } from "@/lib/import/bookImportService";
import { loadRawEpub } from "@/lib/import/rawEpubStore";
import {
  __resetMoodStoreForTests,
  loadMoods,
  loadRecent,
  saveMoods,
  saveRecent,
} from "@/lib/moodStore";
import { TTS_REGEX_SETTINGS_KEY } from "@/lib/ttsRegex/storePersistence";
import type { ProcessingStatus } from "@/types/storage";

type ZipInputEntry = {
  name: string;
  data: string | Uint8Array;
};

const encoder = new TextEncoder();

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function createStoredZip(entries: ZipInputEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = toBytes(entry.data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, 0);
    writeUint16(localView, 12, 0);
    writeUint32(localView, 14, 0);
    writeUint32(localView, 18, dataBytes.length);
    writeUint32(localView, 22, dataBytes.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, 0);
    writeUint16(centralView, 14, 0);
    writeUint32(centralView, 16, 0);
    writeUint32(centralView, 20, dataBytes.length);
    writeUint32(centralView, 24, dataBytes.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, localOffset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + dataBytes.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const localSection = concatBytes(localParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeUint32(eocdView, 0, 0x06054b50);
  writeUint16(eocdView, 4, 0);
  writeUint16(eocdView, 6, 0);
  writeUint16(eocdView, 8, entries.length);
  writeUint16(eocdView, 10, entries.length);
  writeUint32(eocdView, 12, centralDirectory.length);
  writeUint32(eocdView, 16, localSection.length);
  writeUint16(eocdView, 20, 0);

  return concatBytes([localSection, centralDirectory, eocd]);
}

function createValidEpubBytes(
  title = "Import Fixture",
  options?: { withCover?: boolean; withInlineImage?: boolean }
): Uint8Array {
  const withCover = options?.withCover === true;
  const withInlineImage = options?.withInlineImage === true;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  const coverMeta = withCover ? `\n    <meta name="cover" content="cover-image"/>` : "";
  const coverManifest = withCover
    ? `\n    <item id="cover-image" href="images/cover.png" media-type="image/png" />`
    : "";
  const inlineManifest = withInlineImage
    ? `\n    <item id="inline-image" href="images/figure.png" media-type="image/png" />`
    : "";
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>${coverMeta}
  </metadata>
  <manifest>
    <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml" />${coverManifest}${inlineManifest}
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`;
  const inlineImageMarkup = withInlineImage
    ? `\n    <img src="../images/figure.png" alt="Inline figure" />\n    <p>After the figure.</p>`
    : "";
  const chapter = `<html><body>
    <h1>Chapter One</h1>
    <p>Alpha beta gamma form a small but complete opening paragraph with enough ordinary readable words to exercise the import pipeline and its shared reading position model safely.</p>
    <p>Delta epsilon zeta continue the fixture with additional ordinary prose so strict validation recognizes this compact example as a usable book for normal reading speed reading and speech.</p>${inlineImageMarkup}
  </body></html>`;

  const entries: ZipInputEntry[] = [
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/Text/chapter.xhtml", data: chapter },
  ];
  if (withCover) {
    entries.push({
      name: "OEBPS/images/cover.png",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]),
    });
  }
  if (withInlineImage) {
    entries.push({
      name: "OEBPS/images/figure.png",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x04, 0x05, 0x06]),
    });
  }

  return createStoredZip(entries);
}

class TrackingRepository extends InMemoryBookRepository {
  readonly transitions: Array<{ status: ProcessingStatus; updatedAt: number }> = [];
  clearContentCalls = 0;

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

  override async clearBookContent(bookId: string) {
    this.clearContentCalls += 1;
    await super.clearBookContent(bookId);
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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
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
    const bytes = createValidEpubBytes("Gatsby Import Fixture");
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
    expect(repo.clearContentCalls).toBe(0);
  });

  it("stores imported cover as a data URL instead of a zip-relative path", async () => {
    const bytes = createValidEpubBytes("Cover Fixture", { withCover: true });
    const bookId = await service.importFromBytes({
      fileName: "cover-fixture.epub",
      mimeType: "application/epub+zip",
      bytes,
    });

    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    const book = await repo.getBook(bookId);
    expect(book?.cover_path).toBeTruthy();
    expect(book?.cover_path?.startsWith("data:image/png;base64,")).toBe(true);
    expect(book?.cover_path?.includes("OEBPS/")).toBe(false);
  });

  it("stores in-book images as zip-relative paths on import", async () => {
    const bytes = createValidEpubBytes("Inline Image Fixture", { withInlineImage: true });
    const bookId = await service.importFromBytes({
      fileName: "inline-image-fixture.epub",
      mimeType: "application/epub+zip",
      bytes,
    });

    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    const readable = await repo.getReadableBook(bookId);
    expect(readable?.book.images.length).toBeGreaterThan(0);
    expect(readable?.book.images[0]?.src).toBe("OEBPS/images/figure.png");
    expect(readable?.book.images[0]?.src.startsWith("data:")).toBe(false);
    expect(readable?.book.images[0]?.alt).toBe("Inline figure");
    expect(readable?.book.images[0]?.afterParagraphId).toBeGreaterThan(0);
  });

  it("processes an idle import from already-read bytes without reloading raw source", async () => {
    const bytes = createValidEpubBytes("Gatsby Import Fixture");
    let storeCalls = 0;
    let loadCalls = 0;
    const inlineService = new BookImportService(Promise.resolve(repo), {
      store: async () => {
        storeCalls += 1;
      },
      load: async () => {
        loadCalls += 1;
        throw new Error("Raw source should not be loaded for an idle inline import");
      },
      remove: async () => undefined,
    });

    const bookId = await inlineService.importFromBytes({
      fileName: "fitzgerald-great-gatsby.epub",
      mimeType: "application/epub+zip",
      bytes,
    });

    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    expect(storeCalls).toBe(1);
    expect(loadCalls).toBe(0);
  });

  it("keeps bounded queued imports on the already-read bytes path", async () => {
    let storeCalls = 0;
    let loadCalls = 0;
    const releaseStoreCalls: Array<() => void> = [];
    const inlineService = new BookImportService(Promise.resolve(repo), {
      store: async () => {
        storeCalls += 1;
        await new Promise<void>((resolve) => {
          releaseStoreCalls.push(resolve);
        });
      },
      load: async () => {
        loadCalls += 1;
        throw new Error("Raw source should not be loaded for bounded inline imports");
      },
      remove: async () => undefined,
    });

    const firstBookId = await inlineService.importFromBytes(
      {
        fileName: "first.epub",
        mimeType: "application/epub+zip",
        bytes: createValidEpubBytes("First Inline Fixture"),
      },
      { inlineSourceMode: "bounded" }
    );
    const secondBookId = await inlineService.importFromBytes(
      {
        fileName: "second.epub",
        mimeType: "application/epub+zip",
        bytes: createValidEpubBytes("Second Inline Fixture"),
      },
      { inlineSourceMode: "bounded" }
    );

    await waitForCondition(() => releaseStoreCalls.length === 2);
    for (const releaseStoreCall of releaseStoreCalls) {
      releaseStoreCall();
    }

    expect(await waitForTerminalStatus(repo, firstBookId)).toBe("completed");
    expect(await waitForTerminalStatus(repo, secondBookId)).toBe("completed");
    expect(storeCalls).toBe(2);
    expect(loadCalls).toBe(0);
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
    expect(book?.processing_error).toContain("Corrupted/Unreadable book");
    expect(repo.transitions[repo.transitions.length - 1]?.status).toBe("failed");
  });

  it("increments import_jobs attempt on manual retry", async () => {
    const bytes = createValidEpubBytes("Shelley Import Fixture");
    const bookId = await service.importFromBytes({
      fileName: "shelley-frankenstein.epub",
      mimeType: "application/epub+zip",
      bytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    await service.retryImport(bookId);
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    expect(repo.clearContentCalls).toBe(1);

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
    const bytes = createValidEpubBytes("Gatsby Import Fixture");
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
    const bytes = createValidEpubBytes("Shelley Import Fixture");
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
    await saveMoods(
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
    expect(await loadMoods({ repository: repo })).toEqual([
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
    const bytes = createValidEpubBytes("Gatsby Import Fixture");
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
    const bytes = createValidEpubBytes("Shelley Import Fixture");
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
    const bytes = createValidEpubBytes("Shelley Import Fixture");
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

  it("allows deleting a book while it is still processing", async () => {
    const bytes = createValidEpubBytes("Delete While Processing Fixture");
    const bookId = await service.importFromBytes({
      fileName: "delete-while-processing.epub",
      mimeType: "application/epub+zip",
      bytes,
    });

    // Delete immediately without waiting for terminal status.
    await service.deleteBook(bookId);

    expect(await repo.getBook(bookId)).toBeNull();
    expect(await repo.getBookAggregate(bookId)).toBeNull();
    expect(await repo.listImportJobs(bookId)).toEqual([]);
    expect(await loadRawEpub(bookId)).toBeNull();

    // Give the cancelled worker a moment; it must not recreate the book.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await repo.getBook(bookId)).toBeNull();
  });

  it("blocks restoreOriginalBook while the same book is processing", async () => {
    const bytes = createValidEpubBytes("Shelley Import Fixture");
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
