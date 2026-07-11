import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deleteRawEpub, storeRawEpub } from "@/lib/import/rawEpubStore";
import {
  clearBookImageSrcCache,
  resolveBookImageSrc,
} from "@/lib/reader/resolveBookImageSrc";

const encoder = new TextEncoder();

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

function createStoredZip(entries: Array<{ name: string; data: string | Uint8Array }>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;

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

describe("resolveBookImageSrc", () => {
  const bookId = "book-image-resolve-test";

  beforeEach(async () => {
    await deleteRawEpub(bookId);
    await clearBookImageSrcCache(bookId);
  });

  afterEach(async () => {
    await clearBookImageSrcCache(bookId);
    await deleteRawEpub(bookId);
  });

  it("returns data:image sources unchanged", async () => {
    const dataUrl = "data:image/png;base64,AAAA";
    expect(await resolveBookImageSrc(bookId, dataUrl)).toBe(dataUrl);
  });

  it("loads zip-relative paths from the raw EPUB as blob URLs", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const epubBytes = createStoredZip([{ name: "OEBPS/images/figure.png", data: pngBytes }]);
    await storeRawEpub({
      bookId,
      fileName: "fixture.epub",
      mimeType: "application/epub+zip",
      sizeBytes: epubBytes.byteLength,
      bytes: epubBytes,
      storedAt: Date.now(),
    });

    const url = await resolveBookImageSrc(bookId, "OEBPS/images/figure.png");
    expect(url).not.toBeNull();
    expect(url?.startsWith("blob:")).toBe(true);

    const again = await resolveBookImageSrc(bookId, "OEBPS/images/figure.png");
    expect(again).toBe(url);
  });

  it("soft-fails missing assets to null", async () => {
    const epubBytes = createStoredZip([{ name: "OEBPS/text/chapter.xhtml", data: "<p>hi</p>" }]);
    await storeRawEpub({
      bookId,
      fileName: "fixture.epub",
      mimeType: "application/epub+zip",
      sizeBytes: epubBytes.byteLength,
      bytes: epubBytes,
      storedAt: Date.now(),
    });

    expect(await resolveBookImageSrc(bookId, "OEBPS/images/missing.png")).toBeNull();
  });
});
