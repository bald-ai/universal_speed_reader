import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CORPUS_TESTABLES,
  type CorpusManifest,
  type CorpusManifestItem,
} from "./corpus.ts";
import {
  classifyPdfTextScope,
  screenPdfTextScope,
  type PdfTextScopeScreening,
} from "./pdf-scope.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("PDF corpus scope", () => {
  test("classifies the observed 1-of-384-page scan as out of scope", () => {
    expect(classifyPdfTextScope({
      totalPageCount: 384,
      pagesScreened: 384,
      textPageCount: 1,
      words: 275,
      characters: 1_832,
    })).toEqual({
      status: "out-of-scope",
      reason: "Sparse selectable text (1/384 text pages, 0.7 words per page)",
    });
  });

  test("screens selectable text with PDF.js and stops once inclusion is provable", async () => {
    const root = await temporaryDirectory();
    const sourcePath = join(root, "selectable.pdf");
    await writeFile(sourcePath, makeTextPdf(4,
      "This selectable book page contains more than twenty ordinary words and enough normalized characters to prove that its text remains useful for reading. Additional prose keeps the fixture comfortably above every strict minimum while preserving a simple one-page text layer for the scope integration test."));

    const result = await screenPdfTextScope(sourcePath, 5_000);

    expect(result.status).toBe("in-scope");
    expect(result.totalPageCount).toBe(4);
    expect(result.pagesScreened).toBe(1);
    expect(result.textPageCount).toBe(1);
  });

  test("persists exclusions and does not re-screen persisted successes", async () => {
    const root = await temporaryDirectory();
    const corpusDirectory = join(root, "corpus");
    const first = corpusItem("scan");
    const second = corpusItem("known-good");
    second.pdfTextScope = screening("in-scope");
    const manifest = corpusManifest([first, second], 2);
    await Promise.all([first, second].map(async (item) => {
      const path = join(corpusDirectory, item.relativePath);
      await mkdir(join(corpusDirectory, "books", "pdf"), { recursive: true });
      const bytes = Buffer.alloc(1_024);
      bytes.write("%PDF-1.4");
      await writeFile(path, bytes);
    }));
    const screened: string[] = [];

    await CORPUS_TESTABLES.refreshExistingDownloads(
      manifest,
      corpusDirectory,
      50 * 1024 * 1024,
      1_000,
      async (path) => {
        screened.push(path);
        return screening("out-of-scope", {
          totalPageCount: 384,
          pagesScreened: 384,
          textPageCount: 1,
          words: 275,
          characters: 1_832,
          reason: "Sparse selectable text",
        });
      },
    );

    expect(screened).toHaveLength(1);
    expect(first.status).toBe("excluded");
    expect(first.selected).toBe(false);
    expect(first.pdfTextScope?.textPageCount).toBe(1);
    expect(second.status).toBe("downloaded");
    await expect(access(join(corpusDirectory, first.relativePath))).rejects.toThrow();

    await CORPUS_TESTABLES.refreshExistingDownloads(
      manifest,
      corpusDirectory,
      50 * 1024 * 1024,
      1_000,
      async () => { throw new Error("persisted screening should not run again"); },
    );
    expect(first.status).toBe("excluded");
    expect(second.status).toBe("downloaded");
  });

  test("skips persisted exclusions and continues through replacements", async () => {
    const root = await temporaryDirectory();
    const manifestPath = join(root, "manifest.json");
    const persistedExcluded = corpusItem("persisted-excluded", "excluded");
    persistedExcluded.pdfTextScope = screening("out-of-scope");
    const newlyExcluded = corpusItem("newly-excluded", "planned");
    const replacementOne = corpusItem("replacement-one", "planned");
    const replacementTwo = corpusItem("replacement-two", "planned");
    const manifest = corpusManifest([persistedExcluded, newlyExcluded, replacementOne, replacementTwo], 2);
    const processed: string[] = [];

    await CORPUS_TESTABLES.downloadFormatUntil(
      manifest,
      root,
      "pdf",
      2,
      1,
      {
        retries: 1,
        requestTimeoutMs: 5_000,
        maxPdfBytes: 50 * 1024 * 1024,
        pdfScreenTimeoutMs: 1_000,
        beforeGutenbergRequest: async () => undefined,
      },
      manifestPath,
      async (item) => {
        processed.push(item.id);
        if (item.id === newlyExcluded.id) {
          CORPUS_TESTABLES.applyPdfTextScopeScreening(item, screening("out-of-scope"));
        } else {
          item.status = "downloaded";
        }
      },
    );

    expect(processed).toEqual([newlyExcluded.id, replacementOne.id, replacementTwo.id]);
    expect(persistedExcluded.status).toBe("excluded");
    expect(newlyExcluded.status).toBe("excluded");
    expect([replacementOne.status, replacementTwo.status]).toEqual(["downloaded", "downloaded"]);
    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as CorpusManifest;
    expect(persisted.items.find((item) => item.id === newlyExcluded.id)?.status).toBe("excluded");
  });

  test("keeps indeterminate screening candidates eligible for parser evaluation", () => {
    const item = corpusItem("screen-error", "planned");
    CORPUS_TESTABLES.applyPdfTextScopeScreening(item, {
      ...screening("indeterminate"),
      error: "PDF scope screening exceeded 1000 ms",
    });

    expect(item.status).toBe("downloaded");
    expect(item.pdfTextScope?.status).toBe("indeterminate");
    expect(CORPUS_TESTABLES.countAvailableFormat([item], "pdf")).toBe(1);
  });
});

function screening(
  status: PdfTextScopeScreening["status"],
  overrides: Partial<PdfTextScopeScreening> = {},
): PdfTextScopeScreening {
  return {
    schemaVersion: 1,
    status,
    screenedAt: "2026-07-11T00:00:00.000Z",
    elapsedMs: 10,
    totalPageCount: 10,
    pagesScreened: 10,
    textPageCount: status === "out-of-scope" ? 0 : 10,
    words: status === "out-of-scope" ? 0 : 1_000,
    characters: status === "out-of-scope" ? 0 : 6_000,
    ...overrides,
  };
}

function corpusItem(id: string, status: CorpusManifestItem["status"] = "downloaded"): CorpusManifestItem {
  return {
    id,
    remoteId: id,
    format: "pdf",
    title: id,
    authors: [],
    filename: `${id}.pdf`,
    relativePath: join("books", "pdf", `${id}.pdf`),
    sourceName: "Test",
    sourceUrl: `https://example.invalid/${id}`,
    downloadUrl: `https://example.invalid/${id}.pdf`,
    license: "Test license",
    licenseUrl: "https://example.invalid/license",
    selectionReason: "doab-open-access",
    status,
    selected: status === "downloaded",
    attempts: status === "planned" ? 0 : 1,
  };
}

function corpusManifest(items: CorpusManifestItem[], pdfTarget: number): CorpusManifest {
  return {
    schemaVersion: 1,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    target: { total: pdfTarget, epub: 0, pdf: pdfTarget },
    sources: [],
    items,
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "book-parser-lab-corpus-"));
  temporaryDirectories.push(path);
  return path;
}

function makeTextPdf(pageCount: number, firstPageText: string): Uint8Array {
  const encoder = new TextEncoder();
  const objects = new Map<number, string>();
  const pages = Array.from({ length: pageCount }, (_value, index) => 4 + index * 2);
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Count ${pageCount} /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = pages[index] ?? 0;
    const contentId = pageId + 1;
    const text = index === 0 ? firstPageText.replace(/([\\()])/gu, "\\$1") : "";
    const content = text.length === 0 ? "" : `BT /F1 8 Tf 72 700 Td (${text}) Tj ET`;
    objects.set(pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
  }
  let source = "%PDF-1.4\n";
  const offsets = [0];
  const count = Math.max(...objects.keys());
  for (let id = 1; id <= count; id += 1) {
    offsets[id] = encoder.encode(source).length;
    source += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = encoder.encode(source).length;
  source += `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= count; id += 1) source += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(source);
}
