import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBook } from "./parser.ts";
import { isExplicitStructuralHeading } from "./pdf-content.ts";
import { parsePdf, PDF_TESTABLES } from "./pdf.ts";

let fixtureDirectory = "";

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "book-parser-lab-pdf-"));
});

afterAll(async () => {
  if (fixtureDirectory.length > 0) await rm(fixtureDirectory, { force: true, recursive: true });
});

describe("parsePdf", () => {
  test("rejects Office internal bookmark names as chapter titles", () => {
    expect(PDF_TESTABLES.isUsefulOutlineTitle("Chapter 4 — Humans and Space")).toBe(true);
    expect(PDF_TESTABLES.isUsefulOutlineTitle("_Hlk493171735")).toBe(false);
    expect(PDF_TESTABLES.isUsefulOutlineTitle("OLE_LINK169")).toBe(false);
    expect(PDF_TESTABLES.isUsefulOutlineTitle("_Toc123456")).toBe(false);
  });

  test("requires strong LTR or RTL evidence before normalizing a quarter-turn page", () => {
    const dominant = Array.from({ length: 20 }, () => ({
      angleRadians: -Math.PI / 2,
      direction: "ltr",
      readableCharacters: 20,
    }));

    expect(PDF_TESTABLES.dominantQuarterTurnRotation([
      ...dominant,
      ...Array.from({ length: 4 }, () => ({ angleRadians: 0, direction: "ltr", readableCharacters: 20 })),
    ])).toBe(90);
    expect(PDF_TESTABLES.dominantQuarterTurnRotation([
      ...dominant,
      ...Array.from({ length: 6 }, () => ({ angleRadians: 0, direction: "ltr", readableCharacters: 20 })),
    ])).toBeNull();
    expect(PDF_TESTABLES.dominantQuarterTurnRotation(
      dominant.map((sample) => ({ ...sample, direction: "ttb" })),
    )).toBeNull();
    expect(PDF_TESTABLES.dominantQuarterTurnRotation(dominant.slice(0, 19))).toBeNull();
    expect(PDF_TESTABLES.dominantQuarterTurnRotation(
      dominant.map((sample) => ({ ...sample, readableCharacters: 5 })),
    )).toBeNull();
    expect(PDF_TESTABLES.dominantQuarterTurnRotation(
      dominant.map((sample) => ({ ...sample, angleRadians: -Math.PI / 2 + 9 * Math.PI / 180 })),
    )).toBeNull();
  });

  test("requires structural evidence before prose and footnotes become headings", () => {
    expect(isExplicitStructuralHeading("CHAPTER IV", false)).toBe(true);
    expect(isExplicitStructuralHeading("Part Two \u2014 People", false)).toBe(true);
    expect(isExplicitStructuralHeading("Preface and Acknowledgements", false)).toBe(true);
    expect(isExplicitStructuralHeading("3. Methods", true)).toBe(true);
    expect(isExplicitStructuralHeading("book like this.", false)).toBe(false);
    expect(isExplicitStructuralHeading("part, employees and visitors", false)).toBe(false);
    expect(isExplicitStructuralHeading("chapter 11, we leave the prison building", false)).toBe(false);
    expect(isExplicitStructuralHeading("chapter I summarize the results", false)).toBe(false);
    expect(isExplicitStructuralHeading("chapter I summarize the results", true)).toBe(true);
    expect(isExplicitStructuralHeading("3. a footnote in body type", false)).toBe(false);
  });

  test("reconstructs text, filters repeated furniture, and emits app-model pointers", async () => {
    const sourcePath = join(fixtureDirectory, "text-fixture.pdf");
    await writeFile(sourcePath, makePdf({
      title: "Fixture Book",
      author: "Ada Writer; Ben Editor",
      pages: [
        [
          { text: "Fixture Header", x: 72, y: 760, size: 9 },
          { text: "CHAPTER ONE", x: 72, y: 700, size: 20 },
          { text: "This is the opening paragraph of a deliberately small selectable-text PDF fixture.", x: 72, y: 660, size: 11 },
          { text: "It has enough words for strict book-quality checks and it continues naturally.", x: 72, y: 642, size: 11 },
          { text: "1", x: 300, y: 22, size: 9 },
        ],
        [
          { text: "Fixture Header", x: 72, y: 760, size: 9 },
          { text: "A second page adds another complete paragraph for stable logical positions.", x: 72, y: 700, size: 11 },
          { text: "The parser should not mistake the running title or page number for book content.", x: 72, y: 682, size: 11 },
          { text: "2", x: 300, y: 22, size: 9 },
        ],
        [
          { text: "Fixture Header", x: 72, y: 760, size: 9 },
          { text: "The final page supplies additional readable prose and a clean sentence ending.", x: 72, y: 700, size: 11 },
          { text: "Shared progress can therefore address every resulting paragraph sequentially.", x: 72, y: 682, size: 11 },
          { text: "3", x: 300, y: 22, size: 9 },
        ],
      ],
    }));

    const output = await parsePdf({ sourcePath });
    const allText = output.book.paragraphs.map((paragraph) => paragraph.text).join("\n");

    expect(output.book.metadata).toMatchObject({
      title: "Fixture Book",
      authors: ["Ada Writer", "Ben Editor"],
    });
    expect(output.book.cover).toEqual({ src: "pdf://page/1", mediaType: "application/pdf" });
    expect(output.book.paragraphs.map((paragraph) => paragraph.id)).toEqual(
      output.book.paragraphs.map((_paragraph, index) => index + 1),
    );
    expect(allText).toContain("opening paragraph");
    expect(allText).not.toContain("Fixture Header");
    expect(output.book.chapters.some((chapter) => chapter.title === "CHAPTER ONE")).toBe(true);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
    expect(output.internals).toMatchObject({ totalPageCount: 3, textPageCount: 3 });
  });

  test("strictly diagnoses image-only PDFs as requiring out-of-scope OCR", async () => {
    const sourcePath = join(fixtureDirectory, "image-only.pdf");
    await writeFile(sourcePath, makePdf({
      title: "Scanned Fixture",
      pages: [[], [], []],
      pageImage: true,
    }));

    const output = await parsePdf({ sourcePath });

    expect(output.book.paragraphs).toEqual([]);
    expect(output.book.images).toHaveLength(3);
    expect(output.book.images[0]?.src).toMatch(/^pdf:\/\/page\/1\/image\/1\?object=/u);
    expect(output.book.diagnostics).toContainEqual(expect.objectContaining({
      bucket: "No / unusable text",
      severity: "failure",
      message: expect.stringContaining("OCR"),
    }));
  });

  test("reads same-baseline two-column text as complete columns", async () => {
    const sourcePath = join(fixtureDirectory, "two-column.pdf");
    const lines: PdfLine[] = [
      { text: "CHAPTER ONE", x: 230, y: 670, size: 18 },
      ...Array.from({ length: 12 }, (_value, index): PdfLine[] => {
        const lineNumber = index + 1;
        const y = 640 - index * 18;
        return [
          { text: `Left story line ${lineNumber} continues.`, x: 55, y, size: 10 },
          { text: `Right story line ${lineNumber} follows.`, x: 325, y, size: 10 },
        ];
      }).flat(),
    ];
    await writeFile(sourcePath, makePdf({ title: "Two Column Fixture", pages: [lines] }));

    const output = await parsePdf({ sourcePath });
    const allText = output.book.paragraphs.map((paragraph) => paragraph.text).join("\n");
    const lastLeft = allText.indexOf("Left story line 12 continues.");
    const firstRight = allText.indexOf("Right story line 1 follows.");

    expect(lastLeft).toBeGreaterThan(allText.indexOf("Left story line 1 continues."));
    expect(firstRight).toBeGreaterThan(lastLeft);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("normalizes dominant sideways LTR tables in row order without column reordering", async () => {
    const sourcePath = join(fixtureDirectory, "sideways-table.pdf");
    const tableLines = Array.from({ length: 12 }, (_value, index): PdfLine[] => {
      const row = String(index + 1).padStart(2, "0");
      const rowBaseline = 90 + index * 20;
      return [
        {
          text: `Left table row ${row} readable value`,
          x: 0,
          y: 0,
          size: 10,
          matrix: [0, 1, -1, 0, rowBaseline, 70],
        },
        {
          text: `Right table row ${row} readable value`,
          x: 0,
          y: 0,
          size: 10,
          matrix: [0, 1, -1, 0, rowBaseline, 430],
        },
      ];
    }).flat();
    await writeFile(sourcePath, makePdf({
      title: "Sideways Table Fixture",
      pages: [[
        { text: "TABLE HEADER", x: 36, y: 750, size: 10 },
        { text: "Page note", x: 36, y: 730, size: 10 },
        ...tableLines,
      ]],
    }));

    const output = await parsePdf({ sourcePath });
    const allText = output.book.paragraphs.map((paragraph) => paragraph.text).join("\n");

    for (let index = 1; index <= 12; index += 1) {
      const row = String(index).padStart(2, "0");
      const leftPosition = allText.indexOf(`Left table row ${row} readable value`);
      const rightPosition = allText.indexOf(`Right table row ${row} readable value`);
      expect(leftPosition).toBeGreaterThanOrEqual(0);
      expect(rightPosition).toBeGreaterThan(leftPosition);
      if (index < 12) {
        const nextRow = String(index + 1).padStart(2, "0");
        expect(allText.indexOf(`Left table row ${nextRow} readable value`)).toBeGreaterThan(rightPosition);
      }
    }
    expect(output.book.paragraphs.length).toBeLessThan(12);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("leaves a below-threshold mixed-orientation page strict", async () => {
    const sourcePath = join(fixtureDirectory, "mixed-orientation.pdf");
    const rotated = Array.from({ length: 20 }, (_value, index): PdfLine => ({
      text: `Rotated sample entry ${String(index + 1).padStart(2, "0")} words`,
      x: 0,
      y: 0,
      size: 10,
      matrix: [0, 1, -1, 0, 70 + index * 18, 90],
    }));
    const horizontal = Array.from({ length: 6 }, (_value, index): PdfLine => ({
      text: `Horizontal sample ${String(index + 1).padStart(2, "0")} ordinary words`,
      x: 340,
      y: 700 - index * 22,
      size: 10,
    }));
    await writeFile(sourcePath, makePdf({
      title: "Mixed Orientation Fixture",
      pages: [[...rotated, ...horizontal]],
    }));

    const output = await parsePdf({ sourcePath });

    expect(output.book.diagnostics).toContainEqual(expect.objectContaining({
      severity: "failure",
      message: expect.stringContaining("Vertical or heavily rotated text"),
    }));
  });

  test("orders image sidecars geometrically without changing pointer identity", async () => {
    const sourcePath = join(fixtureDirectory, "reverse-painted-images.pdf");
    await writeFile(sourcePath, makePdf({
      title: "Reverse Painted Images",
      pages: [[
        { text: "CHAPTER TOP", x: 72, y: 650, size: 18 },
        { text: "First section has ordinary readable prose words for speed reading.", x: 72, y: 630, size: 11 },
        { text: "Its narrative remains entirely above the first illustration anchor.", x: 72, y: 612, size: 11 },
        { text: "CHAPTER MIDDLE", x: 72, y: 500, size: 18 },
        { text: "Second section adds enough selectable words for a useful model.", x: 72, y: 480, size: 11 },
        { text: "Logical positions should remain stable around all image sidecars.", x: 72, y: 462, size: 11 },
        { text: "CHAPTER BOTTOM", x: 72, y: 350, size: 18 },
        { text: "Third section closes the sample with another readable paragraph.", x: 72, y: 330, size: 11 },
        { text: "This sentence appears before the lower illustration in visual order.", x: 72, y: 312, size: 11 },
      ]],
      // Paint the lower image first to ensure PDF drawing order cannot leak into
      // the app's monotonic reading-order sidecars.
      pageImageTransforms: [[
        [100, 0, 0, 100, 250, 260],
        [100, 0, 0, 100, 250, 560],
      ]],
    }));

    const output = await parseBook({ sourcePath });

    expect(output.book.images.map((image) => image.afterParagraphId)).toEqual([2, 6]);
    expect(output.book.images[0]?.src).toMatch(/\/page\/1\/image\/2\?/u);
    expect(output.book.images[1]?.src).toMatch(/\/page\/1\/image\/1\?/u);
    expect(output.book.diagnostics.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([]);
  });

  test("turns the configured deadline into a timeout diagnostic", async () => {
    const sourcePath = join(fixtureDirectory, "timeout.pdf");
    await writeFile(sourcePath, makePdf({ title: "Timeout Fixture", pages: [[], [], []], pageImage: true }));

    const output = await parsePdf({ sourcePath, timeoutMs: 1 });

    expect(output.book.diagnostics).toContainEqual(expect.objectContaining({
      bucket: "Timeout / extreme slowness",
      severity: "failure",
    }));
  });
});

interface PdfLine {
  text: string;
  x: number;
  y: number;
  size: number;
  matrix?: PdfMatrix;
}

interface PdfFixtureOptions {
  title: string;
  author?: string;
  pages: PdfLine[][];
  pageImage?: boolean;
  pageImageTransforms?: PdfMatrix[][];
}

type PdfMatrix = [number, number, number, number, number, number];

function makePdf(options: PdfFixtureOptions): Uint8Array {
  const pageCount = options.pages.length;
  const hasPageImages = options.pageImage === true || options.pageImageTransforms?.some((transforms) => transforms.length > 0) === true;
  const imageObjectId = hasPageImages ? 4 + pageCount * 2 : null;
  const infoObjectId = 4 + pageCount * 2 + (imageObjectId === null ? 0 : 1);
  const objects = new Map<number, string>();
  const pageObjectIds = options.pages.map((_page, index) => 4 + index * 2);
  const contentObjectIds = options.pages.map((_page, index) => 5 + index * 2);

  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  for (const [index, lines] of options.pages.entries()) {
    const imageResources = imageObjectId === null ? "" : ` /XObject << /Im1 ${imageObjectId} 0 R >>`;
    objects.set(pageObjectIds[index] ?? 0,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${imageResources} >> /Contents ${contentObjectIds[index]} 0 R >>`);
    const textOperations = lines.map((line) => {
      const matrix = line.matrix ?? [1, 0, 0, 1, line.x, line.y];
      return `BT /F1 ${line.size} Tf ${matrix.join(" ")} Tm (${escapePdfString(line.text)}) Tj ET`;
    }).join("\n");
    const defaultImageTransforms: PdfMatrix[] = options.pageImage === true ? [[500, 0, 0, 700, 56, 46]] : [];
    const imageTransforms = options.pageImageTransforms?.[index] ?? defaultImageTransforms;
    const imageOperation = imageObjectId === null
      ? ""
      : imageTransforms.map((transform) => `q ${transform.join(" ")} cm /Im1 Do Q`).join("\n");
    const content = `${textOperations}\n${imageOperation}`;
    objects.set(contentObjectIds[index] ?? 0, streamObject(content));
  }

  if (imageObjectId !== null) {
    const pixels = "\u007f".repeat(64 * 64);
    objects.set(imageObjectId,
      `<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`);
  }
  const author = options.author === undefined ? "" : ` /Author (${escapePdfString(options.author)})`;
  objects.set(infoObjectId, `<< /Title (${escapePdfString(options.title)})${author} >>`);

  return serializePdf(objects, infoObjectId);
}

function streamObject(content: string): string {
  return `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`;
}

function serializePdf(objects: Map<number, string>, infoObjectId: number): Uint8Array {
  const encoder = new TextEncoder();
  let source = "%PDF-1.4\n";
  const offsets: number[] = [0];
  const objectCount = Math.max(...objects.keys());
  for (let id = 1; id <= objectCount; id += 1) {
    const object = objects.get(id);
    if (object === undefined) throw new Error(`Missing generated PDF object ${id}`);
    offsets[id] = encoder.encode(source).length;
    source += `${id} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(source).length;
  source += `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objectCount; id += 1) {
    source += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info ${infoObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(source);
}

function escapePdfString(value: string): string {
  return value.replace(/([\\()])/gu, "\\$1");
}
