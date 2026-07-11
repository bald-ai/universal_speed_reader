import { describe, expect, test } from "bun:test";
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
});

function makePdf(lines: string[]): Uint8Array {
  const text = lines
    .map((line, index) => `BT /F1 ${index === 0 ? 20 : 11} Tf 72 ${700 - index * 28} Td (${escapePdfText(line)}) Tj ET`)
    .join("\n");
  const objects = new Map<number, string>([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Count 1 /Kids [4 0 R] >>"],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    [4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"],
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
