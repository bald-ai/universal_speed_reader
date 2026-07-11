import { describe, expect, it } from "bun:test";
import { epubCoverDataUrl } from "@/lib/import/epubCoverDataUrl";

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

describe("epubCoverDataUrl", () => {
  it("returns a data URL for a jpeg cover path in the zip", async () => {
    const coverBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02, 0x03]);
    const epubBytes = createStoredZip([{ name: "OEBPS/images/cover.jpg", data: coverBytes }]);

    const dataUrl = await epubCoverDataUrl(epubBytes, "OEBPS/images/cover.jpg");

    expect(dataUrl).not.toBeNull();
    expect(dataUrl?.startsWith("data:image/jpeg;base64,")).toBe(true);
    const base64 = dataUrl!.slice("data:image/jpeg;base64,".length);
    expect(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))).toEqual(coverBytes);
  });

  it("returns null when cover path is missing", async () => {
    const epubBytes = createStoredZip([{ name: "OEBPS/Text/chapter.xhtml", data: "<p>hi</p>" }]);
    expect(await epubCoverDataUrl(epubBytes, "OEBPS/images/missing.png")).toBeNull();
  });

  it("returns a data URL for an svg cover path in the zip", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const epubBytes = createStoredZip([{ name: "OEBPS/images/cover.svg", data: svg }]);

    const dataUrl = await epubCoverDataUrl(epubBytes, "OEBPS/images/cover.svg");
    expect(dataUrl?.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("returns null for unsupported cover extensions", async () => {
    const epubBytes = createStoredZip([{ name: "OEBPS/images/cover.bmp", data: "BM" }]);
    expect(await epubCoverDataUrl(epubBytes, "OEBPS/images/cover.bmp")).toBeNull();
  });

  it("returns null when cover path is empty", async () => {
    const epubBytes = createStoredZip([{ name: "OEBPS/images/cover.png", data: new Uint8Array([1, 2, 3]) }]);
    expect(await epubCoverDataUrl(epubBytes, null)).toBeNull();
    expect(await epubCoverDataUrl(epubBytes, "   ")).toBeNull();
  });
});
