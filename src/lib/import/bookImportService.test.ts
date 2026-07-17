import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";
import {
  __setParseBookBytesForTests,
  BookImportService,
  toBookImageRows,
} from "@/lib/import/bookImportService";
import type { ParserOutput } from "@/lib/bookParser";
import * as pdfImageRenderer from "@/lib/import/pdfImageRenderer";
import { ZipArchive } from "@/lib/epub/zipArchive";
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
  options?: { withCover?: boolean; withInlineImage?: boolean; withBrokenImages?: boolean }
): Uint8Array {
  const withCover = options?.withCover === true;
  const withInlineImage = options?.withInlineImage === true;
  const withBrokenImages = options?.withBrokenImages === true;
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
  const brokenManifest = withBrokenImages
    ? `
    <item id="broken-a" href="images/missing-a.png" media-type="image/png" />
    <item id="broken-b" href="images/missing-b.png" media-type="image/png" />
    <item id="broken-c" href="images/missing-c.png" media-type="image/png" />`
    : "";
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>${coverMeta}
  </metadata>
  <manifest>
    <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml" />${coverManifest}${inlineManifest}${brokenManifest}
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`;
  const inlineImageMarkup = withInlineImage
    ? `\n    <img src="../images/figure.png" alt="Inline figure" />\n    <p>After the figure.</p>`
    : "";
  const brokenImageMarkup = withBrokenImages
    ? `
    <img src="../images/missing-a.png" alt="Missing A" />
    <img src="../images/missing-b.png" alt="Missing B" />
    <img src="../images/missing-c.png" alt="Missing C" />`
    : "";
  const chapter = `<html><body>
    <h1>Chapter One</h1>
    <p>Alpha beta gamma form a small but complete opening paragraph with enough ordinary readable words to exercise the import pipeline and its shared reading position model safely.</p>
    <p>Delta epsilon zeta continue the fixture with additional ordinary prose so strict validation recognizes this compact example as a usable book for normal reading speed reading and speech.</p>${inlineImageMarkup}${brokenImageMarkup}
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

async function waitForImportSnapshotStatus(
  service: BookImportService,
  bookId: string,
  timeoutMs = 220_000
): Promise<{ status: ProcessingStatus | "canceled"; error: string | null; warnings: unknown }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = (await service.listImportSnapshot()).find((entry) => entry.bookId === bookId);
    if (row && (row.status === "completed" || row.status === "failed" || row.status === "canceled")) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for import snapshot status for ${bookId}`);
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
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
    // Coarse persistence only: validating at parse start, completed at terminal.
    expect(transitionStatuses).toEqual(["validating", "completed"]);

    for (let i = 1; i < repo.transitions.length; i += 1) {
      expect(repo.transitions[i].updatedAt).toBeGreaterThanOrEqual(repo.transitions[i - 1].updatedAt);
    }
    expect(repo.clearContentCalls).toBe(0);
  });

  it("persists status only at validating and completed for a successful import", async () => {
    const bytes = createValidEpubBytes("Status Write Budget");
    let statusWriteCount = 0;
    const original = repo.setBookAndImportStatus.bind(repo);
    repo.setBookAndImportStatus = async (...args) => {
      statusWriteCount += 1;
      return original(...args);
    };

    const bookId = await service.importFromBytes({
      fileName: "status-write-budget.epub",
      mimeType: "application/epub+zip",
      bytes,
    });

    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    expect(statusWriteCount).toBe(2);
    expect(repo.transitions.map((entry) => entry.status)).toEqual(["validating", "completed"]);
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

  it("does not reopen PDF or EPUB archives for library covers during import", async () => {
    const pdfCoverSpy = spyOn(pdfImageRenderer, "createPdfCoverDataUrl").mockResolvedValue(
      "data:image/jpeg;base64,SHOULD_NOT_USE"
    );
    const zipSpy = spyOn(ZipArchive, "fromBytes");

    try {
      const epubBytes = createValidEpubBytes("No Second Open", { withCover: true });
      const epubId = await service.importFromBytes({
        fileName: "no-second-open.epub",
        mimeType: "application/epub+zip",
        bytes: epubBytes,
      });
      expect(await waitForTerminalStatus(repo, epubId)).toBe("completed");
      expect(zipSpy).not.toHaveBeenCalled();
      expect(pdfCoverSpy).not.toHaveBeenCalled();

      const book = await repo.getBook(epubId);
      expect(book?.cover_path?.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      pdfCoverSpy.mockRestore();
      zipSpy.mockRestore();
    }
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

  it("drops images anchored beyond the final paragraph", () => {
    const result = toBookImageRows(
      "book-with-bad-anchor",
      [{ afterParagraphId: 3, alt: "Unreachable", src: "images/unreachable.png" }],
      "epub",
      2
    );

    expect(result.rows).toEqual([]);
    expect(result.droppedCount).toBe(1);
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

  it("hard-fails unreadable books by purging them from the library", async () => {
    const corrupted = new Uint8Array([1, 2, 3, 4, 5]);
    const bookId = await service.importFromBytes({
      fileName: "broken.epub",
      mimeType: "application/epub+zip",
      bytes: corrupted,
    });

    const snapshot = await waitForImportSnapshotStatus(service, bookId);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toContain("Corrupted/Unreadable book");
    expect(await repo.getBook(bookId)).toBeNull();
    expect(repo.transitions[repo.transitions.length - 1]?.status).toBe("failed");
  });

  it("continues queued imports when failed-book cleanup throws", async () => {
    const cleanupFailingService = new BookImportService(Promise.resolve(repo), {
      store: async () => undefined,
      load: async () => null,
      remove: async () => {
        throw new Error("cleanup unavailable");
      },
    });
    const originalWarn = console.warn;
    console.warn = () => undefined;

    try {
      const brokenBookId = await cleanupFailingService.importFromBytes(
        {
          fileName: "broken-cleanup.epub",
          mimeType: "application/epub+zip",
          bytes: new Uint8Array([1, 2, 3]),
        },
        { inlineSourceMode: "bounded" }
      );
      const validBookId = await cleanupFailingService.importFromBytes(
        {
          fileName: "after-broken-cleanup.epub",
          mimeType: "application/epub+zip",
          bytes: createValidEpubBytes("After Broken Cleanup Fixture"),
        },
        { inlineSourceMode: "bounded" }
      );

      expect((await waitForImportSnapshotStatus(cleanupFailingService, brokenBookId)).status).toBe("failed");
      expect(await waitForTerminalStatus(repo, validBookId)).toBe("completed");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("soft-completes books with missing images and stores warnings", async () => {
    const bookId = await service.importFromBytes({
      fileName: "missing-images.epub",
      mimeType: "application/epub+zip",
      bytes: createValidEpubBytes("Missing Images Fixture", { withBrokenImages: true }),
    });

    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    const book = await repo.getBook(bookId);
    const imageWarning = book?.processing_warnings?.find((warning) => warning.code === "images_missing");
    expect(imageWarning?.message).toBe("Some pictures are missing.");
    expect(await repo.getReadableBook(bookId)).not.toBeNull();
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
    expect(repo.clearContentCalls).toBe(0);

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

    const snapshot = await waitForImportSnapshotStatus(failingService, bookId);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toContain("failed to persist source file");
    expect(await repo.getBook(bookId)).toBeNull();
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

  it("restoreOriginalBook hard-fail keeps the existing book, content, and warnings", async () => {
    const bookId = await service.importFromBytes({
      fileName: "restore-keep.epub",
      mimeType: "application/epub+zip",
      bytes: createValidEpubBytes("Restore Keep Fixture", { withBrokenImages: true }),
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    const before = await repo.getBook(bookId);
    expect(before?.processing_warnings?.some((warning) => warning.code === "images_missing")).toBe(true);
    expect(await repo.getReadableBook(bookId)).not.toBeNull();

    // Simulate missing raw source so restore hard-fails after the book already exists.
    const rawStore = {
      store: async () => undefined,
      load: async () => null,
      remove: async () => undefined,
    };
    const restoreService = new BookImportService(Promise.resolve(repo), rawStore);
    await expect(restoreService.restoreOriginalBook(bookId)).rejects.toThrow(/no stored source file/);

    const book = await repo.getBook(bookId);
    expect(book).not.toBeNull();
    expect(book?.processing_status).toBe("completed");
    expect(book?.processing_warnings?.some((warning) => warning.code === "images_missing")).toBe(true);
    expect(await repo.getReadableBook(bookId)).not.toBeNull();
  });

  it("restoreOriginalBook does not write metadata before content replace succeeds", async () => {
    const bytes = createValidEpubBytes("Restore Metadata Order Fixture");
    const bookId = await service.importFromBytes({
      fileName: "restore-metadata-order.epub",
      mimeType: "application/epub+zip",
      bytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    await repo.patchBook(bookId, {
      title: "Kept Title",
      author: "Kept Author",
      cover_path: "data:image/png;base64,kept",
      updated_at: Date.now(),
    });

    let replaceCalls = 0;
    const originalReplace = repo.replaceBookContent.bind(repo);
    repo.replaceBookContent = async () => {
      replaceCalls += 1;
      throw new Error("replace failed on purpose");
    };

    await expect(service.restoreOriginalBook(bookId)).rejects.toThrow(/replace failed on purpose/);

    const book = await repo.getBook(bookId);
    expect(replaceCalls).toBe(1);
    expect(book?.processing_status).toBe("completed");
    expect(book?.title).toBe("Kept Title");
    expect(book?.author).toBe("Kept Author");
    expect(book?.cover_path).toBe("data:image/png;base64,kept");
    expect(await repo.getReadableBook(bookId)).not.toBeNull();

    repo.replaceBookContent = originalReplace;
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

  it("cancelBooks purges an in-flight book and records a canceled outcome", async () => {
    const bookId = await service.importFromBytes({
      fileName: "cancel-active.epub",
      mimeType: "application/epub+zip",
      bytes: createValidEpubBytes("Cancel Active Fixture"),
    });

    await service.cancelBooks([bookId]);

    expect(await repo.getBook(bookId)).toBeNull();
    expect(await repo.getBookAggregate(bookId)).toBeNull();
    expect(await loadRawEpub(bookId)).toBeNull();
    expect((await service.listImportSnapshot()).find((row) => row.bookId === bookId)?.status).toBe(
      "canceled"
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await repo.getBook(bookId)).toBeNull();
  });

  it("cancelBooks stops all queued targets before awaiting slow cleanup", async () => {
    const rawById = new Map<
      string,
      {
        bookId: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        bytes: Uint8Array;
        storedAt: number;
      }
    >();
    let firstRemoveStarted!: () => void;
    const firstRemoveStartedPromise = new Promise<void>((resolve) => {
      firstRemoveStarted = resolve;
    });
    let releaseFirstRemove!: () => void;
    const firstRemoveHold = new Promise<void>((resolve) => {
      releaseFirstRemove = resolve;
    });
    let removeCalls = 0;

    const slowService = new BookImportService(Promise.resolve(repo), {
      store: async (record) => {
        rawById.set(record.bookId, record);
      },
      load: async (bookId) => rawById.get(bookId) ?? null,
      remove: async (bookId) => {
        removeCalls += 1;
        if (removeCalls === 1) {
          firstRemoveStarted();
          await firstRemoveHold;
        }
        rawById.delete(bookId);
      },
    });

    const firstId = await slowService.importFromBytes(
      {
        fileName: "cancel-first.epub",
        mimeType: "application/epub+zip",
        bytes: createValidEpubBytes("Cancel First Fixture"),
      },
      { inlineSourceMode: "bounded" }
    );
    const secondId = await slowService.importFromBytes(
      {
        fileName: "cancel-second.epub",
        mimeType: "application/epub+zip",
        bytes: createValidEpubBytes("Cancel Second Fixture"),
      },
      { inlineSourceMode: "bounded" }
    );

    // Ensure both rows exist and the second is at least queued before cancel.
    await waitForCondition(async () => {
      const first = await repo.getBook(firstId);
      const second = await repo.getBook(secondId);
      return Boolean(first && second);
    });

    const cancelPromise = slowService.cancelBooks([firstId, secondId]);
    await firstRemoveStartedPromise;
    // While the first book's raw delete is held, the old bug let the queue
    // finish the second book. Give it time to race, then release cleanup.
    await new Promise((resolve) => setTimeout(resolve, 500));
    releaseFirstRemove();
    await cancelPromise;

    expect(await repo.getBook(firstId)).toBeNull();
    expect(await repo.getBook(secondId)).toBeNull();
    const snapshot = await slowService.listImportSnapshot();
    expect(snapshot.find((row) => row.bookId === firstId)?.status).toBe("canceled");
    expect(snapshot.find((row) => row.bookId === secondId)?.status).toBe("canceled");
  });

  it("cancelBooks leaves completed books alone", async () => {
    const bookId = await service.importFromBytes({
      fileName: "keep-completed.epub",
      mimeType: "application/epub+zip",
      bytes: createValidEpubBytes("Keep Completed Fixture"),
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    await service.cancelBooks([bookId]);

    expect(await repo.getBook(bookId)).not.toBeNull();
    expect((await repo.getBook(bookId))?.processing_status).toBe("completed");
  });

  it("importFromBytes aborts cleanly when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.importFromBytes(
        {
          fileName: "aborted-upfront.epub",
          mimeType: "application/epub+zip",
          bytes: createValidEpubBytes("Aborted Upfront Fixture"),
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "ImportCancelledError" });

    expect(await repo.listBooks()).toEqual([]);
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

  describe("waitForIdle", () => {
    afterEach(() => {
      __setParseBookBytesForTests(null);
    });

    const gatedParsedBook = (title: string): ParserOutput => ({
      book: {
        schemaVersion: 2,
        format: "epub",
        metadata: { title, authors: [] },
        cover: null,
        chapters: [{ title: "One", startParagraphId: 1, kind: "chapter", level: 1 }],
        paragraphs: [
          {
            id: 1,
            text: "Alpha beta gamma delta epsilon zeta eta theta iota kappa.",
          },
        ],
        images: [],
        totals: { words: 10, paragraphs: 1, chapters: 1, images: 0, sceneBreaks: 0 },
        diagnostics: [],
        timings: { totalMs: 1 },
      },
      internals: {},
    });

    it("resolves immediately when the queue is idle", async () => {
      await expect(service.waitForIdle()).resolves.toBeUndefined();
    });

    it("resolves after a queued task finishes", async () => {
      let releaseParse!: () => void;
      const parseGate = new Promise<void>((resolve) => {
        releaseParse = resolve;
      });
      __setParseBookBytesForTests(async () => {
        await parseGate;
        return gatedParsedBook("Idle Gate");
      });

      const bookId = await service.importFromBytes({
        fileName: "idle-gate.epub",
        mimeType: "application/epub+zip",
        bytes: createValidEpubBytes("Idle Gate"),
      });

      let idleResolved = false;
      const idlePromise = service.waitForIdle().then(() => {
        idleResolved = true;
      });
      await waitForCondition(() => (repo.transitions.some((t) => t.status === "validating")));
      expect(idleResolved).toBe(false);

      releaseParse();
      await idlePromise;
      expect(idleResolved).toBe(true);
      expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    });

    it("resolves on abort without rejecting", async () => {
      let releaseParse!: () => void;
      const parseGate = new Promise<void>((resolve) => {
        releaseParse = resolve;
      });
      __setParseBookBytesForTests(async () => {
        await parseGate;
        return gatedParsedBook("Abort Idle");
      });

      const bookId = await service.importFromBytes({
        fileName: "abort-idle.epub",
        mimeType: "application/epub+zip",
        bytes: createValidEpubBytes("Abort Idle"),
      });
      await waitForCondition(() => repo.transitions.some((t) => t.status === "validating"));

      const controller = new AbortController();
      const idlePromise = service.waitForIdle(controller.signal);
      controller.abort();
      await expect(idlePromise).resolves.toBeUndefined();

      releaseParse();
      expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");
    });
  });
});
