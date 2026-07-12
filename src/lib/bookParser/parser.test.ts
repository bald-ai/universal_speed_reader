import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { parseBookBytes } from "./index.ts";

describe("portable book parser", () => {
  test("keeps the Pride and Prejudice reading model used by the app", async () => {
    const fixture = Bun.file("test-fixtures/epubs-with-covers/pride-and-prejudice.epub");
    const output = await parseBookBytes({
      sourceBytes: new Uint8Array(await fixture.arrayBuffer()),
      sourceName: "pride-and-prejudice.epub",
    });

    expect(output.book.totals).toMatchObject({
      words: 130_142,
      paragraphs: 2_515,
      chapters: 63,
      images: 163,
    });
    expect(output.book.cover?.src).toBe("OEBPS/8000208475274601819_cover.jpg");
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("reads a selectable-text PDF into the same logical model", async () => {
    const output = await parseBookBytes({
      sourceBytes: makePdf([
        "CHAPTER ONE",
        "This selectable text PDF contains a complete opening paragraph with enough ordinary words to support strict validation and dependable shared reading positions.",
        "A second sentence continues the page so normal reading speed reading and spoken reading all have a useful source model.",
        "The final fixture sentence adds enough clear language to meet the minimum usable text threshold without relying on fabricated chapter data or page layout tricks.",
      ]),
      sourceName: "selectable-text.pdf",
    });

    expect(output.book.format).toBe("pdf");
    expect(output.book.totals.words).toBeGreaterThanOrEqual(50);
    expect(output.book.chapters.length).toBeGreaterThan(0);
    expect(output.book.cover?.src).toBe("pdf://page/1");
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("reconstructs modest paragraph gaps below the old fixed cutoff", async () => {
    const pageHeight = 12_200;
    const lines: PdfFixtureLine[] = [{ text: "CHAPTER ONE", x: 72, y: pageHeight - 40, size: 20 }];
    let y = pageHeight - 80;
    for (let index = 1; index <= 360; index += 1) {
      lines.push({
        text: `Passage ${index} begins with calm ordinary language and continues across one wrapped physical line`,
        x: 72,
        y,
        size: 11,
      });
      y -= 14;
      lines.push({
        text: `Passage ${index} finishes with clear dependable prose for stable reading positions and pacing.`,
        x: 72,
        y,
        size: 11,
      });
      y -= 19;
    }

    const output = await parseBookBytes({
      sourceBytes: makePositionedPdf(lines, pageHeight),
      sourceName: "modest-paragraph-spacing.pdf",
    });
    const paragraphWordCounts = output.book.paragraphs.map((paragraph) => paragraph.text.split(/\s+/u).length);

    expect(output.book.totals.words).toBeGreaterThan(5_000);
    expect(output.book.paragraphs).toHaveLength(361);
    expect(output.book.paragraphs[1]?.text).toContain("begins with calm ordinary language");
    expect(output.book.paragraphs[1]?.text).toContain("finishes with clear dependable prose");
    expect(Math.max(...paragraphWordCounts)).toBeLessThan(100);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("still rejects long selectable text with no paragraph-boundary evidence", async () => {
    const pageHeight = 8_000;
    const lines: PdfFixtureLine[] = [{ text: "CHAPTER ONE", x: 72, y: pageHeight - 40, size: 20 }];
    let y = pageHeight - 80;
    for (let index = 0; index < 500; index += 1) {
      lines.push({
        text: "flat extracted prose keeps running without punctuation indentation or spacing evidence for reliable boundaries",
        x: 72,
        y,
        size: 11,
      });
      y -= 14;
    }

    const output = await parseBookBytes({
      sourceBytes: makePositionedPdf(lines, pageHeight),
      sourceName: "collapsed-selectable-text.pdf",
    });

    expect(output.book.totals.words).toBeGreaterThan(5_000);
    expect(output.book.diagnostics).toContainEqual(expect.objectContaining({
      severity: "failure",
      message: expect.stringContaining("Paragraph boundaries collapsed"),
    }));
  });

  test("segments oversized prose when a PDF flattens paragraph starts into physical lines", async () => {
    const pageHeight = 14_000;
    const lines: PdfFixtureLine[] = [{ text: "CHAPTER ONE", x: 72, y: pageHeight - 40, size: 20 }];
    let y = pageHeight - 80;
    for (let index = 0; index < 260; index += 1) {
      lines.push({
        text: `because the flattened line continues from earlier prose. A complete thought ends clearly here. Another useful sentence provides dependable reading context. The final sentence offers stable pacing while clause ${index} keeps running`,
        x: 72,
        y,
        size: 11,
      });
      y -= 14;
    }

    const output = await parseBookBytes({
      sourceBytes: makePositionedPdf(lines, pageHeight),
      sourceName: "flattened-mid-line-paragraphs.pdf",
    });
    const paragraphWordCounts = output.book.paragraphs.map((paragraph) => paragraph.text.split(/\s+/u).length);

    expect(output.book.totals.words).toBeGreaterThan(4_000);
    expect(output.book.paragraphs.length).toBeGreaterThan(15);
    expect(Math.max(...paragraphWordCounts)).toBeLessThanOrEqual(420);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("recovers embedded chapter headings and removes their raw star ornament", async () => {
    const bodyLine = "ordinary selectable prose keeps the chapter sequence spread through the book with dependable reading positions and natural pacing";
    const lines: PdfFixtureLine[] = [
      {
        text: "Contents CHAPTER I. First CHAPTER II. Second CHAPTER III. Third CHAPTER IV. Fourth",
        x: 72,
        y: 2_900,
        size: 11,
      },
    ];
    let y = 2_860;
    for (const [index, heading] of [
      "CHAPTER I. First",
      "CHAPTER II. Second",
      "CHAPTER III. Third",
      "CHAPTER IV. Fourth",
    ].entries()) {
      const ornament = index === 1 ? "* * * * * * * * " : "";
      lines.push({ text: `${ornament}${heading} ${bodyLine}`, x: 72, y, size: 11 });
      y -= 14;
      for (let line = 0; line < 7; line += 1) {
        lines.push({ text: `${bodyLine}${line === 6 ? "." : ""}`, x: 72, y, size: 11 });
        y -= 14;
      }
      y -= 28;
    }

    const output = await parseBookBytes({
      sourceBytes: makePositionedPdf(lines, 3_000),
      sourceName: "embedded-chapter-headings.pdf",
    });

    expect(output.book.chapters.map((chapter) => chapter.title)).toEqual([
      "CHAPTER I. First",
      "CHAPTER II. Second",
      "CHAPTER III. Third",
      "CHAPTER IV. Fourth",
    ]);
    expect(output.book.paragraphs.some((paragraph) => /\bContents\s+CHAPTER I\b/u.test(paragraph.text))).toBe(false);
    expect(output.book.paragraphs.some((paragraph) => /(?:\s*\*){3,}/u.test(paragraph.text))).toBe(false);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("normalizes EPUB text ornaments, CSS separators, and horizontal rules without consuming inline stars", async () => {
    const prose = "This ordinary paragraph contains enough readable words to establish reliable narrative context before and after a deliberate scene transition in the sample publication.";
    const output = await parseBookBytes({
      sourceBytes: makeEpub(`
        <style>.quiet-rule { border-top: 1px solid; width: 20%; }</style>
        <h1>Chapter One</h1>
        <hr/>
        <p>${prose} ${prose}</p>
        <div class="scene-break"></div>
        <p>${prose} ${prose}</p>
        <div class="quiet-rule"></div>
        <p>${prose} ${prose}</p>
        <div class="quiet-space"></div>
        <p>${prose} ${prose}</p>
        <div class="margin-gap"></div>
        <p>${prose} ${prose}</p>
        <div class="pseudo-break"></div>
        <p>${prose} ${prose}</p>
        <div class="external-rule"></div>
        <p>${prose} ${prose}</p>
        <hr/>
        <p>${prose} ${prose}</p>
        <p>Dictionary notation * * * remains inline because these stars are part of a readable sentence.</p>
      `),
      sourceName: "scene-breaks.epub",
    });

    expect(output.book.paragraphs.filter((paragraph) => paragraph.sceneBreakBefore).map((paragraph) =>
      paragraph.sceneBreakBefore
    )).toEqual([
      "css-separator",
      "css-separator",
      "css-separator",
      "css-separator",
      "css-separator",
      "css-separator",
      "horizontal-rule",
    ]);
    expect(output.book.paragraphs.some((paragraph) => paragraph.text.includes("notation * * * remains"))).toBe(true);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("does not promote Dracula title-page and back-matter rules to scenes", async () => {
    const fixture = Bun.file("test-fixtures/epubs-with-covers/dracula.epub");
    const output = await parseBookBytes({
      sourceBytes: new Uint8Array(await fixture.arrayBuffer()),
      sourceName: "dracula.epub",
    });

    expect(output.book.paragraphs.filter((paragraph) => paragraph.sceneBreakBefore)).toEqual([]);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("keeps real Moby-Dick inline omissions and footnote stars as readable text", async () => {
    const fixture = Bun.file("test-fixtures/epubs-with-covers/moby-dick.epub");
    const output = await parseBookBytes({
      sourceBytes: new Uint8Array(await fixture.arrayBuffer()),
      sourceName: "moby-dick.epub",
    });

    expect(output.book.paragraphs.some((paragraph) => paragraph.text.includes("WHALE. * * * Sw. and Dan. hval"))).toBe(true);
    expect(output.book.paragraphs.some((paragraph) => paragraph.text.startsWith("*See subsequent chapters"))).toBe(true);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("splits an embedded PDF ornament into one scene boundary", async () => {
    const pageHeight = 1_000;
    const lines: PdfFixtureLine[] = [
      { text: "CHAPTER ONE", x: 72, y: 950, size: 20 },
      { text: "The first scene closes with a complete sentence and dependable surrounding prose.", x: 72, y: 900, size: 11 },
      { text: "* * * * * * * * * * * *", x: 180, y: 886, size: 11 },
      { text: "The next scene opens with ordinary readable language and continues naturally.", x: 72, y: 872, size: 11 },
      { text: "Additional prose supplies enough useful words for reliable parser validation and reading positions throughout this small test document.", x: 72, y: 844, size: 11 },
      { text: "A final complete sentence keeps the fixture selectable and ensures that its content remains useful for every reader mode.", x: 72, y: 816, size: 11 },
    ];
    const output = await parseBookBytes({
      sourceBytes: makePositionedPdf(lines, pageHeight),
      sourceName: "embedded-scene-ornament.pdf",
    });

    const breakParagraphs = output.book.paragraphs.filter((paragraph) => paragraph.sceneBreakBefore);
    expect(breakParagraphs).toHaveLength(1);
    expect(breakParagraphs[0]?.sceneBreakBefore).toBe("text-ornament");
    expect(output.book.paragraphs.some((paragraph) => /(?:\s*\*){5,}/u.test(paragraph.text))).toBe(false);
  });

  test("marks only a distinct PDF whitespace gap as a scene break", async () => {
    const output = await parseBookBytes({
      sourceBytes: makePositionedPdf([
        { text: "CHAPTER ONE", x: 72, y: 950, size: 20 },
        { text: "The opening wraps across a normal physical line with ordinary selectable prose", x: 72, y: 900, size: 11 },
        { text: "and finishes as one paragraph with a clear complete sentence.", x: 72, y: 886, size: 11 },
        { text: "A normal new paragraph begins after modest spacing and provides more useful words.", x: 72, y: 867, size: 11 },
        { text: "This scene closes with enough surrounding prose to make the larger gap meaningful.", x: 72, y: 853, size: 11 },
        { text: "A new scene begins after a clearly distinct blank interval and continues in readable prose.", x: 72, y: 811, size: 11 },
        { text: "The final line adds stable words and a complete sentence for validation.", x: 72, y: 797, size: 11 },
      ], 1_000),
      sourceName: "whitespace-scene.pdf",
    });

    expect(output.book.paragraphs.filter((paragraph) => paragraph.sceneBreakBefore)).toHaveLength(1);
    expect(output.book.paragraphs.find((paragraph) => paragraph.sceneBreakBefore)?.sceneBreakBefore).toBe("whitespace");
  });

  test("keeps PDF redactions, footnotes, tables, math, and inline omissions as text", async () => {
    const output = await parseBookBytes({
      sourceBytes: makePositionedPdf([
        { text: "CHAPTER ONE", x: 72, y: 950, size: 20 },
        { text: "The report introduces several legitimate uses of stars in ordinary selectable prose.", x: 72, y: 900, size: 11 },
        { text: "A redacted name * * * * * * * * * * * * * * * * * * * * remains inside this sentence and must not create a scene.", x: 72, y: 886, size: 11 },
        { text: "A dictionary omission ends here. * * * * * The definition continues on the same physical line.", x: 72, y: 872, size: 11 },
        { text: "Table rating * * * * * Excellent is data rather than a narrative transition.", x: 72, y: 858, size: 11 },
        { text: "The equation a * b * c = d and footnote marker * both remain readable notation.", x: 72, y: 844, size: 11 },
        { text: "The final sentence supplies enough ordinary words for reliable parsing and validation of this negative fixture.", x: 72, y: 830, size: 11 },
      ], 1_000),
      sourceName: "legitimate-inline-stars.pdf",
    });

    expect(output.book.paragraphs.filter((paragraph) => paragraph.sceneBreakBefore)).toEqual([]);
    expect(output.book.paragraphs.some((paragraph) => paragraph.text.includes("name * * * * * * * * * * * * * * * * * * * * remains"))).toBe(true);
    expect(output.book.paragraphs.some((paragraph) => paragraph.text.includes("omission ends here. * * * * * The definition"))).toBe(true);
  });
});

interface PdfFixtureLine {
  text: string;
  x: number;
  y: number;
  size: number;
}

function makePdf(lines: string[]): Uint8Array {
  return makePositionedPdf(lines.map((line, index) => ({
    text: line,
    x: 72,
    y: 700 - index * 28,
    size: index === 0 ? 20 : 11,
  })), 792);
}

function makePositionedPdf(lines: PdfFixtureLine[], pageHeight: number): Uint8Array {
  const text = lines
    .map((line) => `BT /F1 ${line.size} Tf ${line.x} ${line.y} Td (${escapePdfText(line.text)}) Tj ET`)
    .join("\n");
  const objects = new Map<number, string>([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Count 1 /Kids [4 0 R] >>"],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    [4, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`],
    [5, `<< /Length ${new TextEncoder().encode(text).length} >>\nstream\n${text}\nendstream`],
    [6, "<< /Title (Selectable text fixture) >>"],
  ]);

  const encoder = new TextEncoder();
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

function escapePdfText(value: string): string {
  return value.replace(/([\\()])/gu, "\\$1");
}

function makeEpub(body: string): Uint8Array {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OPS/package.opf": strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">scene-test</dc:identifier><dc:title>Scene Test</dc:title><dc:creator>Fixture</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="content" href="content.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="content"/></spine></package>`),
    "OPS/content.xhtml": strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Scene Test</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`),
    "OPS/style.css": strToU8(`.quiet-space { text-align: center; margin-top: 2em; margin-bottom: 2em; } .margin-gap { margin-top: 2em; margin-bottom: 2em; } .pseudo-break::after { content: "⁂"; } .external-rule { border-top: 1px solid; width: 20%; }`),
  });
}
