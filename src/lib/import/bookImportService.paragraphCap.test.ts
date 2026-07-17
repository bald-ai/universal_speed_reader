import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";
import {
  __setParseBookBytesForTests,
  BookImportService,
} from "@/lib/import/bookImportService";
import { MAX_BOOK_PARAGRAPHS } from "@/lib/bookParser";
import { DiagnosticCode } from "@/lib/bookParser/diagnosticCodes";
import { buildBook } from "@/lib/bookParser/model";
import type { ParserOutput } from "@/lib/bookParser/types";
import { __resetMoodStoreForTests } from "@/lib/moodStore";
import type { RawBookRecord } from "@/lib/import/rawEpubStore";
import type { ProcessingStatus } from "@/types/storage";

const OVERSIZE_COUNT = MAX_BOOK_PARAGRAPHS + 1;
const OVERSIZE_ERROR =
  `Book too large: this book has ${OVERSIZE_COUNT} paragraphs; maximum supported is ${MAX_BOOK_PARAGRAPHS}.`;

function oversizedParsedBook(): ParserOutput {
  const paragraphs = Array.from({ length: OVERSIZE_COUNT }, (_, index) => ({
    id: index + 1,
    text: "word",
  }));
  const book = buildBook({
    format: "epub",
    metadata: { title: "Over Cap Import", authors: ["Tester"] },
    paragraphs,
    chapters: [{ title: "Chapter One", startParagraphId: 1 }],
    images: [],
    cover: { src: "OPS/images/cover.jpg", mediaType: "image/jpeg" },
    timings: { totalMs: 25 },
  });
  book.diagnostics = [{
    bucket: "Other",
    severity: "failure",
    code: DiagnosticCode.too_many_paragraphs,
    message: `This book has ${OVERSIZE_COUNT} paragraphs; maximum supported is ${MAX_BOOK_PARAGRAPHS}.`,
  }];
  return { book, internals: {} };
}

const encoder = new TextEncoder();

function createSmallEpubBytes(): Uint8Array {
  const writeUint16 = (view: DataView, offset: number, value: number) => view.setUint16(offset, value, true);
  const writeUint32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value, true);
  const toBytes = (value: string | Uint8Array) =>
    typeof value === "string" ? encoder.encode(value) : value;
  const concatBytes = (parts: Uint8Array[]) => {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  const entries: Array<{ name: string; data: string | Uint8Array }> = [
    { name: "mimetype", data: "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    },
    {
      name: "OEBPS/content.opf",
      data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Small Keep Fixture</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`,
    },
    {
      name: "OEBPS/Text/chapter.xhtml",
      data: `<html><body>
    <h1>Chapter One</h1>
    <p>Alpha beta gamma form a small but complete opening paragraph with enough ordinary readable words to exercise the import pipeline and its shared reading position model safely.</p>
    <p>Delta epsilon zeta continue the fixture with additional ordinary prose so strict validation recognizes this compact example as a usable book for normal reading speed reading and speech.</p>
  </body></html>`,
    },
  ];

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
    writeUint32(localView, 18, dataBytes.length);
    writeUint32(localView, 22, dataBytes.length);
    writeUint16(localView, 26, nameBytes.length);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint32(centralView, 20, dataBytes.length);
    writeUint32(centralView, 24, dataBytes.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint32(centralView, 42, localOffset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + dataBytes.length;
  }
  const localSection = concatBytes(localParts);
  const centralDirectory = concatBytes(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeUint32(eocdView, 0, 0x06054b50);
  writeUint16(eocdView, 8, entries.length);
  writeUint16(eocdView, 10, entries.length);
  writeUint32(eocdView, 12, centralDirectory.length);
  writeUint32(eocdView, 16, localSection.length);
  return concatBytes([localSection, centralDirectory, eocd]);
}

async function waitForImportSnapshotStatus(
  service: BookImportService,
  bookId: string,
  timeoutMs = 10_000
): Promise<{ status: ProcessingStatus | "canceled"; error: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = (await service.listImportSnapshot()).find((entry) => entry.bookId === bookId);
    if (row && (row.status === "completed" || row.status === "failed" || row.status === "canceled")) {
      return { status: row.status, error: row.error };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for import snapshot status for ${bookId}`);
}

async function waitForTerminalStatus(
  repo: InMemoryBookRepository,
  bookId: string,
  timeoutMs = 10_000
): Promise<ProcessingStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const book = await repo.getBook(bookId);
    const status = book?.processing_status;
    if (status === "completed" || status === "failed") return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for terminal status for ${bookId}`);
}

describe("book import paragraph cap", () => {
  let repo: InMemoryBookRepository;
  let rawStore: Map<string, RawBookRecord>;
  let service: BookImportService;

  beforeEach(async () => {
    __resetMoodStoreForTests();
    __setParseBookBytesForTests(null);
    repo = new InMemoryBookRepository();
    await repo.init();
    rawStore = new Map();
    service = new BookImportService(Promise.resolve(repo), {
      store: async (record) => {
        rawStore.set(record.bookId, {
          ...record,
          bytes: new Uint8Array(record.bytes),
        });
      },
      load: async (bookId) => {
        const record = rawStore.get(bookId);
        if (!record) return null;
        return {
          ...record,
          bytes: new Uint8Array(record.bytes),
        };
      },
      remove: async (bookId) => {
        rawStore.delete(bookId);
      },
    });
  });

  afterEach(() => {
    __setParseBookBytesForTests(null);
  });

  it("hard-fails oversized new imports with Book too large and purges the row", async () => {
    __setParseBookBytesForTests(async () => oversizedParsedBook());
    const bookId = await service.importFromBytes({
      fileName: "over-cap.epub",
      mimeType: "application/epub+zip",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]),
    });

    const snapshot = await waitForImportSnapshotStatus(service, bookId);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toBe(OVERSIZE_ERROR);
    expect(await repo.getBook(bookId)).toBeNull();
    expect(await repo.getReadableBook(bookId)).toBeNull();
  });

  it("restoreOriginalBook keeps prior content when restore hits the paragraph cap", async () => {
    const smallBytes = createSmallEpubBytes();
    const bookId = await service.importFromBytes({
      fileName: "restore-over-cap.epub",
      mimeType: "application/epub+zip",
      bytes: smallBytes,
    });
    expect(await waitForTerminalStatus(repo, bookId)).toBe("completed");

    const before = await repo.getReadableBook(bookId);
    expect(before?.book.paragraphs.length).toBeGreaterThan(0);
    const priorParagraphCount = before!.book.paragraphs.length;

    __setParseBookBytesForTests(async () => oversizedParsedBook());
    await expect(service.restoreOriginalBook(bookId)).rejects.toThrow(OVERSIZE_ERROR);

    const book = await repo.getBook(bookId);
    expect(book).not.toBeNull();
    expect(book?.processing_status).toBe("completed");
    const after = await repo.getReadableBook(bookId);
    expect(after?.book.paragraphs).toHaveLength(priorParagraphCount);

    const jobs = await repo.listImportJobs(bookId);
    const failedJob = jobs.find((job) => job.status === "failed");
    expect(failedJob?.error).toBe(OVERSIZE_ERROR);
  });
});
