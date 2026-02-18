import { describe, expect, it } from "bun:test";
import { __epubParserInternals, parseEpubBytes } from "@/lib/epub/epubParser";

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

function concat(parts: Uint8Array[]): Uint8Array {
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

  const centralDirectory = concat(centralParts);
  const localSection = concat(localParts);
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

  return concat([localSection, centralDirectory, eocd]);
}

function createTestEpub(options: {
  includeNav: boolean;
  includeNcx: boolean;
  opfPath?: string;
  includeHeadings?: boolean;
}): Uint8Array {
  const opfPath = options.opfPath ?? "OEBPS/content.opf";
  const opfDir = opfPath.split("/").slice(0, -1).join("/");
  const navPath = `${opfDir}/nav.xhtml`;
  const ncxPath = `${opfDir}/toc.ncx`;
  const ch1Path = `${opfDir}/Text/ch1.xhtml`;
  const ch2Path = `${opfDir}/Text/ch2.xhtml`;

  const manifestItems = [
    `<item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml" />`,
    `<item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml" />`,
  ];

  if (options.includeNav) {
    manifestItems.push(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />`);
  }
  if (options.includeNcx) {
    manifestItems.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />`);
  }

  const tocAttr = options.includeNcx ? ` toc="ncx"` : "";
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Parser Fixture</dc:title>
    <dc:creator>Tester</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${manifestItems.join("\n")}
  </manifest>
  <spine${tocAttr}>
    <itemref idref="ch2"/>
    <itemref idref="ch1"/>
  </spine>
</package>`;

  const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/ch2.xhtml#p2">Nav Two</a></li>
        <li><a href="Text/ch1.xhtml#p1">Nav One</a></li>
      </ol>
    </nav>
  </body>
</html>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>NCX Two</text></navLabel>
      <content src="Text/ch2.xhtml#p2" />
    </navPoint>
    <navPoint id="n2" playOrder="2">
      <navLabel><text>NCX One</text></navLabel>
      <content src="Text/ch1.xhtml#p1" />
    </navPoint>
  </navMap>
</ncx>`;

  const includeHeadings = options.includeHeadings ?? true;
  const ch1 = includeHeadings
    ? `<html><body><h1 id="h1">Chapter One</h1><p id="p1">Alpha beta gamma.</p></body></html>`
    : `<html><body><p id="p1">Alpha beta gamma.</p></body></html>`;
  const ch2 = includeHeadings
    ? `<html><body><h1 id="h2">Chapter Two</h1><p id="p2">Delta epsilon zeta.</p></body></html>`
    : `<html><body><p id="p2">Delta epsilon zeta.</p></body></html>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const entries: ZipInputEntry[] = [
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: container },
    { name: opfPath, data: opf },
    { name: ch1Path, data: ch1 },
    { name: ch2Path, data: ch2 },
  ];

  if (options.includeNav) entries.push({ name: navPath, data: nav });
  if (options.includeNcx) entries.push({ name: ncxPath, data: ncx });

  return createStoredZip(entries);
}

describe("epub parser internals", () => {
  it("parses container path for normal and nested OPF paths", () => {
    const normal = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`;
    const nested = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/sub/content.opf"/></rootfiles></container>`;
    expect(__epubParserInternals.parseContainerPath(normal)).toBe("content.opf");
    expect(__epubParserInternals.parseContainerPath(nested)).toBe("OPS/sub/content.opf");
  });

  it("preserves spine order from OPF exactly", () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Spine Test</dc:title>
  </metadata>
  <manifest>
    <item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml" />
    <item id="b" href="Text/b.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine>
    <itemref idref="b"/>
    <itemref idref="a"/>
  </spine>
</package>`;
    const parsed = __epubParserInternals.parseOpf(opf, "OEBPS/content.opf");
    expect(parsed.spinePaths).toEqual(["OEBPS/Text/b.xhtml", "OEBPS/Text/a.xhtml"]);
  });

  it("handles path normalization variants", () => {
    expect(__epubParserInternals.normalizePath("./OPS/Text/Chapter.xhtml")).toBe("text/chapter.xhtml");
    expect(__epubParserInternals.normalizePath("../OEBPS/Text/Chapter.xhtml")).toBe("text/chapter.xhtml");
    expect(__epubParserInternals.normalizePath("OEBPS\\Text\\CH1.XHTML")).toBe("text/ch1.xhtml");
  });

  it("collects anchors from id/name/wrapper/sibling patterns", () => {
    const html = `
      <div id="wrapper">
        <p id="direct-id">First paragraph</p>
      </div>
      <a name="before-anchor"></a>
      <p>Second paragraph</p>
      <p><span id="nested-anchor"></span>Third paragraph</p>
    `;
    const extracted = __epubParserInternals.extractParagraphsFromChapter(html);
    const anchorSets = extracted.map((entry) => entry.anchors);
    expect(anchorSets.some((anchors) => anchors.includes("direct-id"))).toBe(true);
    expect(anchorSets.some((anchors) => anchors.includes("wrapper"))).toBe(true);
    expect(anchorSets.some((anchors) => anchors.includes("before-anchor"))).toBe(true);
    expect(anchorSets.some((anchors) => anchors.includes("nested-anchor"))).toBe(true);
  });

  it("text-title fallback matcher handles exact and chapter-numbered variants", () => {
    expect(__epubParserInternals.textMatchesTitle("Chapter 1", "1. Chapter 1")).toBe(true);
    expect(__epubParserInternals.textMatchesTitle("The Beginning", "The Beginning")).toBe(true);
    expect(__epubParserInternals.textMatchesTitle("Unrelated text", "The Beginning")).toBe(false);
  });
});

describe("parseEpubBytes TOC preference", () => {
  it("prefers EPUB3 nav when both nav and ncx are present", async () => {
    const bytes = createTestEpub({ includeNav: true, includeNcx: true });
    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters.length).toBeGreaterThan(0);
    expect(parsed.chapters[0]?.title).toBe("Nav Two");
  });

  it("falls back to ncx when nav is missing", async () => {
    const bytes = createTestEpub({ includeNav: false, includeNcx: true });
    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters.length).toBeGreaterThan(0);
    expect(parsed.chapters[0]?.title).toBe("NCX Two");
  });

  it("supports nested OPF paths while parsing full EPUB", async () => {
    const bytes = createTestEpub({ includeNav: true, includeNcx: false, opfPath: "OPS/books/content.opf" });
    const parsed = await parseEpubBytes(bytes);
    expect(parsed.paragraphs.length).toBeGreaterThan(0);
    expect(parsed.title).toBe("Parser Fixture");
  });

  it("does not use heading fallback when TOC exists", async () => {
    const opfPath = "OEBPS/content.opf";
    const navPath = "OEBPS/nav.xhtml";
    const ch1Path = "OEBPS/Text/ch1.xhtml";
    const ch2Path = "OEBPS/Text/ch2.xhtml";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Parser Fixture</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml" />
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/ch2.xhtml#p2">Only TOC Chapter</a></li>
      </ol>
    </nav>
  </body>
</html>`;

    const ch1 = `<html><body><h1>Book Title Page</h1><p id="p1">Front matter text.</p></body></html>`;
    const ch2 = `<html><body><p id="p2">Main chapter text.</p></body></html>`;
    const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    const bytes = createStoredZip([
      { name: "mimetype", data: "application/epub+zip" },
      { name: "META-INF/container.xml", data: container },
      { name: opfPath, data: opf },
      { name: navPath, data: nav },
      { name: ch1Path, data: ch1 },
      { name: ch2Path, data: ch2 },
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters).toEqual([{ title: "Only TOC Chapter", start_paragraph_id: 3 }]);
  });

  it("uses heading fallback when TOC metadata is missing", async () => {
    const bytes = createTestEpub({ includeNav: false, includeNcx: false, includeHeadings: true });
    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters.length).toBe(2);
    expect(parsed.chapters[0]?.title).toBe("Chapter Two");
    expect(parsed.chapters[1]?.title).toBe("Chapter One");
  });

  it('uses final "Full book" fallback when TOC and headings are unavailable', async () => {
    const bytes = createTestEpub({ includeNav: false, includeNcx: false, includeHeadings: false });
    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters.length).toBe(1);
    expect(parsed.chapters[0]?.title).toBe("Full book");
    expect(parsed.chapters[0]?.start_paragraph_id).toBe(1);
  });
});
