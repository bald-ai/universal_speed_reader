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

  it("collects nested anchors from blank sibling wrappers", () => {
    const html = `
      <div id="blank-wrapper">
        <a name="wrapped-anchor"></a>
      </div>
      <p>Body paragraph</p>
    `;
    const extracted = __epubParserInternals.extractParagraphsFromChapter(html);
    expect(extracted).toEqual([
      {
        text: "Body paragraph",
        anchors: ["blank-wrapper", "wrapped-anchor"],
      },
    ]);
  });

  it("text-title fallback matcher handles exact and chapter-numbered variants", () => {
    expect(__epubParserInternals.textMatchesTitle("Chapter 1", "1. Chapter 1")).toBe(true);
    expect(__epubParserInternals.textMatchesTitle("The Beginning", "The Beginning")).toBe(true);
    expect(__epubParserInternals.textMatchesTitle("Unrelated text", "The Beginning")).toBe(false);
  });

  it("parses nav toc hierarchy and landmarks from the navigation document", () => {
    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li>
          <a href="Text/part1.xhtml#part1">Part One</a>
          <ol>
            <li><a href="Text/ch1.xhtml#ch1">Chapter One</a></li>
          </ol>
        </li>
      </ol>
    </nav>
    <nav epub:type="landmarks">
      <ol>
        <li><a epub:type="bodymatter" href="Text/ch1.xhtml#ch1">Start Reading</a></li>
      </ol>
    </nav>
  </body>
</html>`;

    const parsed = __epubParserInternals.parseNavigationDocument(nav, "OEBPS/nav.xhtml");
    expect(parsed.tocEntries).toHaveLength(2);
    expect(parsed.tocEntries[0]).toMatchObject({
      title: "Part One",
      depth: 1,
      parentId: null,
    });
    expect(parsed.tocEntries[1]).toMatchObject({
      title: "Chapter One",
      depth: 2,
      parentId: parsed.tocEntries[0]?.id ?? null,
    });
    expect(parsed.landmarks).toEqual([
      {
        file: "text/ch1.xhtml",
        anchor: "ch1",
        types: ["bodymatter"],
      },
    ]);
  });
});

describe("parseEpubBytes TOC handling", () => {
  it("prefers EPUB3 nav when both nav and ncx are present", async () => {
    const bytes = createTestEpub({ includeNav: true, includeNcx: true });
    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters.length).toBeGreaterThan(0);
    expect(parsed.chapters[0]?.title).toBe("Nav Two");
  });

  it("merges nav and ncx entries when they contribute different chapter targets", async () => {
    const opfPath = "OEBPS/content.opf";
    const navPath = "OEBPS/nav.xhtml";
    const ncxPath = "OEBPS/toc.ncx";
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
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
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
  </navMap>
</ncx>`;

    const ch1 = `<html><body><p id="p1">Alpha body.</p></body></html>`;
    const ch2 = `<html><body><p id="p2">Beta body.</p></body></html>`;
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
      { name: ncxPath, data: ncx },
      { name: ch1Path, data: ch1 },
      { name: ch2Path, data: ch2 },
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters).toEqual([
      { title: "Nav One", start_paragraph_id: 1 },
      { title: "NCX Two", start_paragraph_id: 2 },
    ]);
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

  it("uses the next readable paragraph when a TOC title heading is the first node in a chapter file", async () => {
    const opfPath = "OEBPS/content.opf";
    const ncxPath = "OEBPS/toc.ncx";
    const ch1Path = "OEBPS/Text/ch1.xhtml";
    const ch2Path = "OEBPS/Text/ch2.xhtml";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Parser Fixture</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml" />
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml" />
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>Chapter 1. Alpha</text></navLabel>
      <content src="Text/ch1.xhtml#ch1" />
    </navPoint>
    <navPoint id="n2" playOrder="2">
      <navLabel><text>Chapter 2. Beta</text></navLabel>
      <content src="Text/ch2.xhtml#ch2" />
    </navPoint>
  </navMap>
</ncx>`;

    const ch1 = `<html><body><div class="chapter" id="ch1"><h2>Chapter 1. Alpha</h2><p id="p1">First real paragraph.</p></div></body></html>`;
    const ch2 = `<html><body><div class="chapter" id="ch2"><h2>Chapter 2. Beta</h2><p id="p2">Second real paragraph.</p></div></body></html>`;
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
      { name: ncxPath, data: ncx },
      { name: ch1Path, data: ch1 },
      { name: ch2Path, data: ch2 },
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters).toEqual([
      { title: "Chapter 1. Alpha", start_paragraph_id: 1 },
      { title: "Chapter 2. Beta", start_paragraph_id: 2 },
    ]);
    expect(parsed.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "First real paragraph.",
      "Second real paragraph.",
    ]);
  });

  it("matches chapter anchors hidden inside blank wrapper nodes before the real paragraph", async () => {
    const opfPath = "OEBPS/content.opf";
    const navPath = "OEBPS/nav.xhtml";
    const ch1Path = "OEBPS/Text/ch1.xhtml";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Parser Fixture</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/ch1.xhtml#wrapped-anchor">Only Chapter</a></li>
      </ol>
    </nav>
  </body>
</html>`;

    const ch1 = `<html><body><div id="blank-wrapper"><a name="wrapped-anchor"></a></div><p>First real paragraph.</p></body></html>`;
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
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.paragraphs.map((paragraph) => paragraph.text)).toEqual(["First real paragraph."]);
    expect(parsed.chapters).toEqual([{ title: "Only Chapter", start_paragraph_id: 1 }]);
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

  it("selects nested chapter depth instead of top-level parts and contents", async () => {
    const opfPath = "OEBPS/content.opf";
    const navPath = "OEBPS/nav.xhtml";
    const introPath = "OEBPS/Text/intro.xhtml";
    const partPath = "OEBPS/Text/part1.xhtml";
    const ch1Path = "OEBPS/Text/ch1.xhtml";
    const ch2Path = "OEBPS/Text/ch2.xhtml";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Parser Fixture</dc:title>
  </metadata>
  <manifest>
    <item id="intro" href="Text/intro.xhtml" media-type="application/xhtml+xml" />
    <item id="part" href="Text/part1.xhtml" media-type="application/xhtml+xml" />
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml" />
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
  </manifest>
  <spine>
    <itemref idref="intro"/>
    <itemref idref="part"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/intro.xhtml#contents">Contents</a></li>
        <li>
          <a href="Text/part1.xhtml#part1">Part One</a>
          <ol>
            <li><a href="Text/ch1.xhtml#ch1">Chapter One</a></li>
            <li><a href="Text/ch2.xhtml#ch2">Chapter Two</a></li>
          </ol>
        </li>
      </ol>
    </nav>
  </body>
</html>`;

    const intro = `<html><body><h1 id="contents">Contents</h1><p>Front matter.</p></body></html>`;
    const part = `<html><body><h1 id="part1">Part One</h1><p>Part opener.</p></body></html>`;
    const ch1 = `<html><body><h2 id="ch1">Chapter One</h2><p id="p1">Alpha chapter text.</p></body></html>`;
    const ch2 = `<html><body><h2 id="ch2">Chapter Two</h2><p id="p2">Beta chapter text.</p></body></html>`;
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
      { name: introPath, data: intro },
      { name: partPath, data: part },
      { name: ch1Path, data: ch1 },
      { name: ch2Path, data: ch2 },
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters).toEqual([
      { title: "Chapter One", start_paragraph_id: 3 },
      { title: "Chapter Two", start_paragraph_id: 4 },
    ]);
  });

  it("uses landmarks and guide hints to keep front matter out of the primary chapter list", async () => {
    const opfPath = "OEBPS/content.opf";
    const navPath = "OEBPS/nav.xhtml";
    const titlePath = "OEBPS/Text/title.xhtml";
    const ch1Path = "OEBPS/Text/ch1.xhtml";
    const ch2Path = "OEBPS/Text/ch2.xhtml";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Parser Fixture</dc:title>
  </metadata>
  <manifest>
    <item id="title" href="Text/title.xhtml" media-type="application/xhtml+xml" />
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml" />
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
  </manifest>
  <spine>
    <itemref idref="title"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
  <guide>
    <reference type="title-page" title="Title Page" href="Text/title.xhtml#titlepage" />
    <reference type="text" title="Start" href="Text/ch1.xhtml#ch1" />
  </guide>
</package>`;

    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/title.xhtml#titlepage">Title Page</a></li>
        <li><a href="Text/ch1.xhtml#ch1">Chapter One</a></li>
        <li><a href="Text/ch2.xhtml#ch2">Chapter Two</a></li>
      </ol>
    </nav>
    <nav epub:type="landmarks">
      <ol>
        <li><a epub:type="bodymatter" href="Text/ch1.xhtml#ch1">Start Reading</a></li>
      </ol>
    </nav>
  </body>
</html>`;

    const title = `<html><body><h1 id="titlepage">Title Page</h1><p>Front matter.</p></body></html>`;
    const ch1 = `<html><body><h2 id="ch1">Chapter One</h2><p id="p1">Alpha chapter text.</p></body></html>`;
    const ch2 = `<html><body><h2 id="ch2">Chapter Two</h2><p id="p2">Beta chapter text.</p></body></html>`;
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
      { name: titlePath, data: title },
      { name: ch1Path, data: ch1 },
      { name: ch2Path, data: ch2 },
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters).toEqual([
      { title: "Chapter One", start_paragraph_id: 2 },
      { title: "Chapter Two", start_paragraph_id: 3 },
    ]);
  });

  it("keeps dense same-file poem toc entries and drops the wrapper entry", async () => {
    const opfPath = "OEBPS/content.opf";
    const navPath = "OEBPS/nav.xhtml";
    const poemsPath = "OEBPS/Text/poems.xhtml";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Renascence and Other Poems</dc:title>
  </metadata>
  <manifest>
    <item id="poems" href="Text/poems.xhtml" media-type="application/xhtml+xml" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
  </manifest>
  <spine>
    <itemref idref="poems"/>
  </spine>
</package>`;

    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/poems.xhtml#wrapper">Poems</a></li>
        <li><a href="Text/poems.xhtml#renascence">Renascence</a></li>
        <li><a href="Text/poems.xhtml#interim">Interim</a></li>
        <li><a href="Text/poems.xhtml#suicide">The Suicide</a></li>
      </ol>
    </nav>
  </body>
</html>`;

    const poems = `<html><body>
      <h1 id="wrapper">Poems</h1>
      <h2 id="renascence">Renascence</h2>
      <p>First poem body.</p>
      <h2 id="interim">Interim</h2>
      <p>Second poem body.</p>
      <h2 id="suicide">The Suicide</h2>
      <p>Third poem body.</p>
    </body></html>`;
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
      { name: poemsPath, data: poems },
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters).toEqual([
      { title: "Renascence", start_paragraph_id: 1 },
      { title: "Interim", start_paragraph_id: 2 },
      { title: "The Suicide", start_paragraph_id: 3 },
    ]);
  });

  it("drops umbrella work titles when real play entries follow", async () => {
    const opfPath = "OEBPS/content.opf";
    const navPath = "OEBPS/nav.xhtml";
    const wrapperPath = "OEBPS/Text/trilogy.xhtml";
    const play1Path = "OEBPS/Text/play1.xhtml";
    const play2Path = "OEBPS/Text/play2.xhtml";
    const play3Path = "OEBPS/Text/play3.xhtml";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Three Greek Plays</dc:title>
  </metadata>
  <manifest>
    <item id="wrapper" href="Text/trilogy.xhtml" media-type="application/xhtml+xml" />
    <item id="play1" href="Text/play1.xhtml" media-type="application/xhtml+xml" />
    <item id="play2" href="Text/play2.xhtml" media-type="application/xhtml+xml" />
    <item id="play3" href="Text/play3.xhtml" media-type="application/xhtml+xml" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
  </manifest>
  <spine>
    <itemref idref="wrapper"/>
    <itemref idref="play1"/>
    <itemref idref="play2"/>
    <itemref idref="play3"/>
  </spine>
</package>`;

    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/trilogy.xhtml#trilogy">The Oedipus Trilogy</a></li>
        <li><a href="Text/play1.xhtml#play1">OEDIPUS THE KING</a></li>
        <li><a href="Text/play2.xhtml#play2">OEDIPUS AT COLONUS</a></li>
        <li><a href="Text/play3.xhtml#play3">ANTIGONE</a></li>
      </ol>
    </nav>
  </body>
</html>`;

    const wrapper = `<html><body><h1 id="trilogy">The Oedipus Trilogy</h1><p>Umbrella matter.</p></body></html>`;
    const play1 = `<html><body><h1 id="play1">OEDIPUS THE KING</h1><p>Play one body.</p></body></html>`;
    const play2 = `<html><body><h1 id="play2">OEDIPUS AT COLONUS</h1><p>Play two body.</p></body></html>`;
    const play3 = `<html><body><h1 id="play3">ANTIGONE</h1><p>Play three body.</p></body></html>`;
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
      { name: wrapperPath, data: wrapper },
      { name: play1Path, data: play1 },
      { name: play2Path, data: play2 },
      { name: play3Path, data: play3 },
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters).toEqual([
      { title: "OEDIPUS THE KING", start_paragraph_id: 2 },
      { title: "OEDIPUS AT COLONUS", start_paragraph_id: 3 },
      { title: "ANTIGONE", start_paragraph_id: 4 },
    ]);
  });

  it("recovers implicit numbered chapters when the toc only covers front matter", async () => {
    const opfPath = "OEBPS/content.opf";
    const navPath = "OEBPS/nav.xhtml";
    const frontPath = "OEBPS/Text/front.xhtml";
    const mainPath = "OEBPS/Text/main.xhtml";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>A Long Novel</dc:title>
  </metadata>
  <manifest>
    <item id="front" href="Text/front.xhtml" media-type="application/xhtml+xml" />
    <item id="main" href="Text/main.xhtml" media-type="application/xhtml+xml" />
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
  </manifest>
  <spine>
    <itemref idref="front"/>
    <itemref idref="main"/>
  </spine>
</package>`;

    const nav = `<!doctype html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="Text/front.xhtml#book">A Long Novel</a></li>
        <li><a href="Text/front.xhtml#ad">Advertisement</a></li>
      </ol>
    </nav>
  </body>
</html>`;

    const front = `<html><body><h1 id="book">A Long Novel</h1><h2 id="ad">Advertisement</h2><p>Front matter text.</p></body></html>`;
    const main = `<html><body>
      <h2>Chapter 1. Dawn</h2><p>Body one.</p>
      <h2>Chapter 2. Noon</h2><p>Body two.</p>
      <h2>Chapter 3. Dusk</h2><p>Body three.</p>
      <h2>Chapter 4. Night</h2><p>Body four.</p>
      <h2>Chapter 5. Storm</h2><p>Body five.</p>
    </body></html>`;
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
      { name: frontPath, data: front },
      { name: mainPath, data: main },
    ]);

    const parsed = await parseEpubBytes(bytes);
    expect(parsed.chapters).toEqual([
      { title: "Chapter 1. Dawn", start_paragraph_id: 3 },
      { title: "Chapter 2. Noon", start_paragraph_id: 5 },
      { title: "Chapter 3. Dusk", start_paragraph_id: 7 },
      { title: "Chapter 4. Night", start_paragraph_id: 9 },
      { title: "Chapter 5. Storm", start_paragraph_id: 11 },
    ]);
  });
});
