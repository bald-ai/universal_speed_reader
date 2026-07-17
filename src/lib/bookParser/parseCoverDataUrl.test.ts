import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseBookBytes } from "@/lib/bookParser";
import { parseEpub } from "@/lib/bookParser/epub";
import { epubCoverDataUrl } from "@/lib/import/epubCoverDataUrl";
import * as pdfImageRenderer from "@/lib/import/pdfImageRenderer";

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

function createCoverEpubBytes(): Uint8Array {
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Cover Compare</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml" />
    <item id="cover-image" href="images/cover.png" media-type="image/png" />
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`;
  const chapter = `<html><body>
    <h1>Chapter One</h1>
    <p>Alpha beta gamma form a small but complete opening paragraph with enough ordinary readable words to exercise the import pipeline and its shared reading position model safely.</p>
    <p>Delta epsilon zeta continue the fixture with additional ordinary prose so strict validation recognizes this compact example as a usable book for normal reading speed reading and speech.</p>
  </body></html>`;
  return createStoredZip([
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/Text/chapter.xhtml", data: chapter },
    {
      name: "OEBPS/images/cover.png",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]),
    },
  ]);
}

function makePdf(lines: string[]): Uint8Array {
  const positioned = lines.map((line, index) => ({
    text: line,
    x: 72,
    y: 700 - index * 28,
    size: index === 0 ? 20 : 11,
  }));
  const pageHeight = 792;
  const text = positioned
    .map((line) => `BT /F1 ${line.size} Tf ${line.x} ${line.y} Td (${line.text.replace(/([\\()])/gu, "\\$1")}) Tj ET`)
    .join("\n");
  const objects = new Map<number, string>([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Count 1 /Kids [4 0 R] >>"],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    [4, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`],
    [5, `<< /Length ${encoder.encode(text).length} >>\nstream\n${text}\nendstream`],
    [6, "<< /Title (Cover PDF fixture) >>"],
  ]);

  let source = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id <= 6; id += 1) {
    const object = objects.get(id);
    if (!object) throw new Error(`Missing PDF fixture object ${id}`);
    offsets[id] = encoder.encode(source).length;
    source += `${id} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(source).length;
  source += "xref\n0 7\n0000000000 65535 f \n";
  for (let id = 1; id <= 6; id += 1) {
    source += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(source);
}

describe("parse-time library covers", () => {
  afterEach(() => {
    // Spies restored per-test; keep a safety net if a test throws mid-way.
  });

  it("EPUB coverDataUrl matches the legacy epubCoverDataUrl helper", async () => {
    const bytes = createCoverEpubBytes();
    const parsed = await parseEpub({ sourceBytes: bytes, sourceName: "cover-compare.epub" });

    expect(parsed.book.cover?.src).toBeTruthy();
    const legacy = await epubCoverDataUrl(bytes, parsed.book.cover?.src);
    expect(parsed.coverDataUrl).toBe(legacy);
    expect(parsed.coverDataUrl?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("EPUB fixture cover matches legacy helper on a real cover EPUB", async () => {
    const fixture = Bun.file("test-fixtures/epubs-with-covers/pride-and-prejudice.epub");
    const bytes = new Uint8Array(await fixture.arrayBuffer());
    const parsed = await parseEpub({
      sourceBytes: bytes,
      sourceName: "pride-and-prejudice.epub",
    });
    const legacy = await epubCoverDataUrl(bytes, parsed.book.cover?.src);
    expect(parsed.coverDataUrl).toBe(legacy);
    expect(parsed.coverDataUrl?.startsWith("data:image/")).toBe(true);
  });

  it("PDF coverDataUrl is null when canvas is unavailable", async () => {
    const output = await parseBookBytes({
      sourceBytes: makePdf([
        "CHAPTER ONE",
        "This selectable text PDF contains a complete opening paragraph with enough ordinary words to support strict validation and dependable shared reading positions.",
        "A second sentence continues the page so normal reading speed reading and spoken reading all have a useful source model.",
        "The final fixture sentence adds enough clear language to meet the minimum usable text threshold without relying on fabricated chapter data or page layout tricks.",
      ]),
      sourceName: "cover-null.pdf",
    });

    expect(output.book.format).toBe("pdf");
    // Non-DOM / no canvasContext ⇒ soft-fail null (same class as a failed cover render).
    expect(output.coverDataUrl ?? null).toBeNull();
  });

  it("PDF parse attaches coverDataUrl from the live-document helper", async () => {
    const spy = spyOn(pdfImageRenderer, "pdfCoverDataUrlFromDocument").mockResolvedValue(
      "data:image/jpeg;base64,LIVECOVER"
    );
    try {
      const output = await parseBookBytes({
        sourceBytes: makePdf([
          "CHAPTER ONE",
          "This selectable text PDF contains a complete opening paragraph with enough ordinary words to support strict validation and dependable shared reading positions.",
          "A second sentence continues the page so normal reading speed reading and spoken reading all have a useful source model.",
          "The final fixture sentence adds enough clear language to meet the minimum usable text threshold without relying on fabricated chapter data or page layout tricks.",
        ]),
        sourceName: "cover-live.pdf",
      });
      expect(spy).toHaveBeenCalled();
      expect(output.coverDataUrl).toBe("data:image/jpeg;base64,LIVECOVER");
    } finally {
      spy.mockRestore();
    }
  });
});
