import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";

import { parseEpub } from "./epub.ts";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "book-parser-epub-"));

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("standalone EPUB parser", () => {
  test("extracts EPUB 3 navigation and common image embedding variants as pointers", async () => {
    const sourcePath = await writeEpub("media-variants.epub", {
      "EPUB/package.opf": `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
          <metadata>
            <dc:title>Media Variants</dc:title><dc:creator>Example Author</dc:creator><dc:language>en</dc:language>
          </metadata>
          <manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
            <item id="cover" href="Images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
            <item id="ordinary" href="Images/ordinary.png" media-type="image/png"/>
            <item id="wrapped" href="Images/wrapped.jpg" media-type="image/jpeg"/>
            <item id="background" href="Images/background.png" media-type="image/png"/>
            <item id="picture" href="Images/picture.jpg" media-type="image/jpeg"/>
            <item id="diagram" href="Images/diagram.svg" media-type="image/svg+xml"/>
            <item id="object-raster" href="Images/object.webp" media-type="image/webp"/>
          </manifest>
          <spine><itemref idref="chapter"/></spine>
        </package>`,
      "EPUB/nav.xhtml": `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"
        xmlns:epub="http://www.idpf.org/2007/ops"><body>
        <nav epub:type="toc"><ol><li><a href="Text/chapter.xhtml#nested-opening">
        <span>Illustrated opening.</span> Chapter One</a></li></ol></nav></body></html>`,
      "EPUB/Text/chapter.xhtml": `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"
        xmlns:xlink="http://www.w3.org/1999/xlink"><body>
          <h1>Chapter <span id="nested-opening">One</span></h1>
          <p>Several readable words establish the opening paragraph.</p>
          <img src="../Images/ordinary.png" alt="Ordinary image"/>
          <svg viewBox="0 0 20 20"><image xlink:href="../Images/wrapped.jpg" width="20" height="20"/></svg>
          <div style="background: center / contain no-repeat url('../Images/background.png')">Background plate</div>
          <picture><source srcset="../Images/picture.jpg 2x"/><img src="../Images/low.jpg"
            srcset="../Images/picture.jpg 2x" alt="Picture image"/></picture>
          <object data="../Images/diagram.svg" type="image/svg+xml"><img src="../Images/fallback.png"/></object>
          <svg viewBox="0 0 10 10"><title>Inline vector</title><rect width="10" height="10"/></svg>
          <img src="data:image/png;base64,AA==" alt="Tiny inline image"/>
          <img src="../Images/missing.png" alt="Broken reference"/>
          <p>Closing words keep the chapter useful for reading and speech.</p>
        </body></html>`,
      "EPUB/Images/diagram.svg": `<svg xmlns="http://www.w3.org/2000/svg"><image href="object.webp"/></svg>`,
      "EPUB/Images/cover.jpg": "cover",
      "EPUB/Images/ordinary.png": "ordinary",
      "EPUB/Images/wrapped.jpg": "wrapped",
      "EPUB/Images/background.png": "background",
      "EPUB/Images/picture.jpg": "picture",
      "EPUB/Images/object.webp": "object",
    });

    const output = await parseEpub({ sourcePath });
    const { book } = output;
    expect(book.metadata).toMatchObject({
      title: "Media Variants",
      authors: ["Example Author"],
      language: "en",
    });
    expect(book.cover?.src).toBe("EPUB/Images/cover.jpg");
    expect(book.chapters[0]).toEqual({
      title: "Illustrated opening. Chapter One",
      startParagraphId: 1,
    });
    expect(book.images.map((image) => image.src)).toEqual([
      "EPUB/Images/ordinary.png",
      "EPUB/Images/wrapped.jpg",
      "EPUB/Images/background.png",
      "EPUB/Images/picture.jpg",
      "EPUB/Images/object.webp",
      expect.stringMatching(/^data:image\/svg\+xml/),
      "data:image/png;base64,AA==",
    ]);
    expect(book.images.every((image, index) =>
      index === 0 || image.afterParagraphId >= (book.images[index - 1]?.afterParagraphId ?? 0),
    )).toBe(true);
    expect(output.internals.declaredImageCount).toBe(8);
    expect(output.internals.extractedImageCount).toBe(7);
    expect(book.diagnostics.some((diagnostic) =>
      diagnostic.bucket === "Images missing / blank / badly placed" &&
      diagnostic.severity === "failure" &&
      diagnostic.details?.reference === "EPUB/Images/missing.png",
    )).toBe(true);
  });

  test("uses EPUB 2 NCX anchors, div-soup paragraphs, and an unwrapped SVG cover", async () => {
    const sourcePath = await writeEpub("epub2-ncx.epub", {
      "OPS/content.opf": `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
          <metadata><dc:title>EPUB Two</dc:title><dc:creator>Legacy Author</dc:creator>
            <meta name="cover" content="cover-svg"/></metadata>
          <manifest>
            <item id="chapter" href="chapter.html" media-type="text/html"/>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="cover-svg" href="cover.svg" media-type="image/svg+xml"/>
            <item id="cover-raster" href="cover.jpg" media-type="image/jpeg"/>
          </manifest>
          <spine toc="ncx"><itemref idref="chapter"/></spine>
        </package>`,
      "OPS/toc.ncx": `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
        <navMap><navPoint id="point"><navLabel><text>Second loose block</text></navLabel>
        <content src="chapter.html#second"/></navPoint></navMap></ncx>`,
      "OPS/chapter.html": `<html><body><div>
        <div>First loose block has enough words to become one paragraph.</div>
        <div id="second">Second loose block also becomes its own sequential paragraph.</div>
      </div></body></html>`,
      "OPS/cover.svg": `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <image xlink:href="cover.jpg" width="600" height="900"/></svg>`,
      "OPS/cover.jpg": "cover raster",
    });

    const output = await parseEpub({ sourcePath });
    expect(output.book.paragraphs).toEqual([
      { id: 1, text: "First loose block has enough words to become one paragraph." },
      { id: 2, text: "Second loose block also becomes its own sequential paragraph." },
    ]);
    expect(output.book.chapters).toEqual([
      { title: "Second loose block", startParagraphId: 2 },
    ]);
    expect(output.book.cover).toEqual({ src: "OPS/cover.jpg", mediaType: "image/jpeg" });
    expect(output.book.images).toEqual([]);
    expect(output.internals.declaredImageCount).toBe(0);
    expect(output.internals.sourceDocumentCount).toBe(1);
  });

  test("preserves mixed container prose and DOM-order media from HTML and stylesheets", async () => {
    const sourcePath = await writeEpub("ordered-content.epub", {
      "OPS/content.opf": simplePackage(
        `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
         <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
         <item id="css" href="Styles/book.css" media-type="text/css"/>
         <item id="lead" href="Images/lead.png" media-type="image/png"/>
         <item id="middle" href="Images/middle.png" media-type="image/png"/>
         <item id="embedded" href="Images/embedded.png" media-type="image/png"/>
         <item id="external" href="Images/external.png" media-type="image/png"/>
         <item id="complex" href="Images/complex.svg" media-type="image/svg+xml"/>
         <item id="dependency" href="Images/dependency.jpg" media-type="image/jpeg"/>`,
        `<itemref idref="chapter"/>`,
      ),
      "OPS/Text/chapter.xhtml": `<html><head>
        <link rel="stylesheet" href="../Styles/book.css"/>
        <style>.embedded { background-image: url('../Images/embedded.png'); }</style>
        </head><body>
        <div>Opening prose <div id="nested">Nested prose</div> Closing prose</div>
        <p><img src="../Images/lead.png" alt="Leading image"/>Text after leading image.</p>
        <p>Text before middle image.<img src="../Images/middle.png" alt="Middle image"/>Text after middle image.</p>
        <div class="embedded">Embedded stylesheet caption.</div>
        <div class="external">External stylesheet caption.</div>
        <object data="../Images/complex.svg" type="image/svg+xml"></object>
        </body></html>`,
      "OPS/nav.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"
        xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc">
        <a href="Text/chapter.xhtml#nested">Nested section</a>
        </nav></body></html>`,
      "OPS/Styles/book.css": `.external { background: center / contain no-repeat url('../Images/external.png'); }`,
      "OPS/Images/complex.svg": `<svg xmlns="http://www.w3.org/2000/svg">
        <image href="dependency.jpg"/><rect width="10" height="10"/>
        </svg>`,
      "OPS/Images/lead.png": "lead",
      "OPS/Images/middle.png": "middle",
      "OPS/Images/embedded.png": "embedded",
      "OPS/Images/external.png": "external",
      "OPS/Images/dependency.jpg": "dependency",
    });

    const output = await parseEpub({ sourcePath });

    expect(output.book.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "Opening prose",
      "Nested prose",
      "Closing prose",
      "Text after leading image.",
      "Text before middle image.",
      "Text after middle image.",
      "Embedded stylesheet caption.",
      "External stylesheet caption.",
    ]);
    expect(output.book.images.map(({ src, afterParagraphId }) => ({ src, afterParagraphId }))).toEqual([
      { src: "OPS/Images/lead.png", afterParagraphId: 3 },
      { src: "OPS/Images/middle.png", afterParagraphId: 5 },
      { src: "OPS/Images/embedded.png", afterParagraphId: 6 },
      { src: "OPS/Images/external.png", afterParagraphId: 7 },
    ]);
    expect(output.book.chapters).toEqual([{ title: "Nested section", startParagraphId: 2 }]);
    expect(output.book.diagnostics).toContainEqual(expect.objectContaining({
      bucket: "Images missing / blank / badly placed",
      severity: "failure",
      message: expect.stringContaining("external dependencies"),
      details: { reference: "OPS/Images/complex.svg" },
    }));
  });

  test("uses heading positions when navigation fragments collapse to the file start", async () => {
    const sourcePath = await writeEpub("collapsed-navigation.epub", {
      "OPS/content.opf": simplePackage(
        `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
         <item id="book" href="book.xhtml" media-type="application/xhtml+xml"/>`,
        `<itemref idref="book"/>`,
      ),
      "OPS/nav.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"
        xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc">
        ${Array.from(
          { length: 8 },
          (_value, index) => `<a href="book.xhtml#absent-${index + 1}">Chapter ${index + 1}</a>`,
        ).join("")}</nav></body></html>`,
      "OPS/book.xhtml": `<html><body>${Array.from(
        { length: 8 },
        (_value, index) => `<h1>Chapter ${index + 1}</h1><p>Readable chapter prose preserves distinct logical positions for navigation.</p>`,
      ).join("")}</body></html>`,
    });

    const output = await parseEpub({ sourcePath });

    expect(output.book.chapters.map((chapter) => chapter.startParagraphId)).toEqual([
      1, 3, 5, 7, 9, 11, 13, 15,
    ]);
    expect(output.book.diagnostics).toContainEqual(expect.objectContaining({
      bucket: "Weak / missing / nonsense chapters",
      severity: "warning",
      message: expect.stringContaining("collapsed"),
    }));
  });

  test("excludes non-linear auxiliary spine content unless no linear content exists", async () => {
    const mixedPath = await writeEpub("linear-reading-order.epub", {
      "OPS/content.opf": simplePackage(
        `<item id="main" href="main.xhtml" media-type="application/xhtml+xml"/>
         <item id="aux" href="aux.xhtml" media-type="application/xhtml+xml"/>`,
        `<itemref idref="main"/><itemref idref="aux" linear="no"/>`,
      ),
      "OPS/main.xhtml": `<html><body><p>Main reading-order words belong in the normalized book.</p></body></html>`,
      "OPS/aux.xhtml": `<html><body><p>NONLINEAR AUXILIARY TEXT MUST STAY OUT.</p></body></html>`,
    });
    const mixed = await parseEpub({ sourcePath: mixedPath });
    expect(mixed.book.paragraphs.map((paragraph) => paragraph.text).join(" ")).toContain(
      "Main reading-order words",
    );
    expect(mixed.book.paragraphs.map((paragraph) => paragraph.text).join(" ")).not.toContain(
      "NONLINEAR AUXILIARY",
    );
    expect(mixed.internals.sourceDocumentCount).toBe(1);

    const onlyNonlinearPath = await writeEpub("only-nonlinear.epub", {
      "OPS/content.opf": simplePackage(
        `<item id="only" href="only.xhtml" media-type="application/xhtml+xml"/>`,
        `<itemref idref="only" linear="no"/>`,
      ),
      "OPS/only.xhtml": `<html><body><p>The only available non-linear document remains readable.</p></body></html>`,
    });
    const onlyNonlinear = await parseEpub({ sourcePath: onlyNonlinearPath });
    expect(onlyNonlinear.book.paragraphs[0]?.text).toBe(
      "The only available non-linear document remains readable.",
    );

    const nonLinearOnlyTextPath = await writeEpub("linear-title-only.epub", {
      "OPS/content.opf": simplePackage(
        `<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
         <item id="body" href="body.xhtml" media-type="application/xhtml+xml"/>`,
        `<itemref idref="title"/><itemref idref="body" linear="no"/>`,
      ),
      "OPS/title.xhtml": `<html><body><p>A Fine Book By Writer</p></body></html>`,
      "OPS/body.xhtml": `<html><body><p>${Array.from(
        { length: 60 },
        (_value, index) => `useful-body-word-${index + 1}`,
      ).join(" ")}</p></body></html>`,
    });
    const nonLinearOnlyText = await parseEpub({ sourcePath: nonLinearOnlyTextPath });
    expect(nonLinearOnlyText.book.paragraphs[0]?.text).toBe("A Fine Book By Writer");
    expect(nonLinearOnlyText.book.paragraphs[1]?.text).toContain("useful-body-word-60");
    expect(nonLinearOnlyText.book.totals.words).toBe(65);
    expect(nonLinearOnlyText.internals.sourceDocumentCount).toBe(2);
  });

  test("strictly fails long single-file books with only a filename chapter fallback", async () => {
    const hundredWords = Array.from({ length: 100 }, (_value, index) => `word${index}`).join(" ");
    const longBody = Array.from({ length: 120 }, () => `<p>${hundredWords}</p>`).join("");
    const longPath = await writeEpub("long-no-structure.epub", {
      "OPS/content.opf": simplePackage(
        `<item id="book" href="book.xhtml" media-type="application/xhtml+xml"/>`,
        `<itemref idref="book"/>`,
      ),
      "OPS/book.xhtml": `<html><body>${longBody}</body></html>`,
    });
    const longBook = await parseEpub({ sourcePath: longPath });
    expect(longBook.book.totals.words).toBe(12_000);
    expect(longBook.book.diagnostics).toContainEqual(
      expect.objectContaining({
        bucket: "Weak / missing / nonsense chapters",
        severity: "failure",
      }),
    );

    const shortPath = await writeEpub("short-no-structure.epub", {
      "OPS/content.opf": simplePackage(
        `<item id="story" href="story.xhtml" media-type="application/xhtml+xml"/>`,
        `<itemref idref="story"/>`,
      ),
      "OPS/story.xhtml": `<html><body><p>A genuinely short story may rely on its single file boundary.</p></body></html>`,
    });
    const shortStory = await parseEpub({ sourcePath: shortPath });
    expect(shortStory.book.diagnostics).not.toContainEqual(
      expect.objectContaining({
        bucket: "Weak / missing / nonsense chapters",
        severity: "failure",
      }),
    );
  });
});

function simplePackage(manifest: string, spine: string): string {
  return `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
      <metadata><dc:title>Synthetic Story</dc:title></metadata>
      <manifest>${manifest}</manifest><spine>${spine}</spine>
    </package>`;
}

async function writeEpub(
  filename: string,
  entries: Record<string, string>,
): Promise<string> {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
      <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="${Object.keys(entries).find((path) => path.endsWith(".opf"))}"
      media-type="application/oebps-package+xml"/></rootfiles></container>`),
  };
  for (const [path, value] of Object.entries(entries)) files[path] = strToU8(value);
  const sourcePath = join(temporaryDirectory, filename);
  await Bun.write(sourcePath, zipSync(files));
  return sourcePath;
}
