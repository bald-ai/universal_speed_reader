import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBook } from "./model.ts";
import { evaluateCorpus, prepareDesktopFolders } from "./evaluate.ts";
import { downloadCorpus, loadCorpusManifest, type CorpusManifest } from "./corpus.ts";
import type { EvaluationSummary, ParserOutput } from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("corpus evaluation", () => {
  test("keeps a missing cover warning-only", async () => {
    const fixture = await corpusFixture();
    const output = validOutputWithMissingCover();
    const workerCode = `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, output }))})`;
    const summary = await evaluateCorpus({
      corpusDirectory: fixture.corpusDirectory,
      resultDirectory: join(fixture.root, "results"),
      parseCommand: ["bun", "-e", workerCode, "{input}"],
      writeDesktopFolders: false,
      concurrency: 1,
    });

    expect(summary.passed).toBe(1);
    expect(summary.failureBucketCounts["Cover missing"]).toBe(0);
    expect(summary.warningBucketCounts["Cover missing"]).toBe(1);
    expect(await Bun.file(join(fixture.root, "results", "corpus-manifest.json")).exists()).toBe(true);
    expect(summary.records[0]?.diagnostics).toContainEqual({
      bucket: "Cover missing",
      severity: "warning",
      message: "No reasonable library cover was found.",
    });
  });

  test("classifies a killed empty worker as Crash", async () => {
    const fixture = await corpusFixture();
    const summary = await evaluateCorpus({
      corpusDirectory: fixture.corpusDirectory,
      resultDirectory: join(fixture.root, "crash-results"),
      parseCommand: ["bun", "-e", "process.kill(process.pid, 9)", "{input}"],
      timeoutMs: 2_000,
      writeDesktopFolders: false,
      concurrency: 1,
    });

    expect(summary.failed).toBe(1);
    expect(summary.records[0]?.diagnostics[0]?.bucket).toBe("Crash");
    expect(summary.records[0]?.previewPath).toBeString();
  });

  test("refuses to evaluate an incomplete selected set", async () => {
    const fixture = await corpusFixture();
    const manifestPath = join(fixture.corpusDirectory, "manifest.json");
    const manifest = await loadCorpusManifest(manifestPath);
    manifest.target = { total: 2, epub: 2, pdf: 0 };
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(evaluateCorpus({
      corpusDirectory: fixture.corpusDirectory,
      resultDirectory: join(fixture.root, "incomplete-results"),
      parseCommand: ["bun", "-e", "process.exit(99)", "{input}"],
      writeDesktopFolders: false,
      concurrency: 1,
    })).rejects.toThrow("Corpus selection does not match manifest target");
  });

  test("backfills integrity metadata for an existing valid corpus file", async () => {
    const fixture = await corpusFixture();
    const manifestPath = join(fixture.corpusDirectory, "manifest.json");
    const manifest = await loadCorpusManifest(manifestPath);
    manifest.items[0]!.status = "planned";
    manifest.items[0]!.selected = false;
    manifest.items[0]!.attempts = 0;
    delete manifest.items[0]!.byteLength;
    delete manifest.items[0]!.sha256;
    manifest.items.push({
      ...manifest.items[0]!,
      id: "unused-buffer",
      remoteId: "unused-buffer",
      filename: "unused-buffer.epub",
      relativePath: join("books", "epub", "unused-buffer.epub"),
    });
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const summary = await downloadCorpus({
      corpusDirectory: fixture.corpusDirectory,
      targetCount: 1,
      epubCount: 1,
      pdfCount: 0,
    });
    const refreshed = await loadCorpusManifest(manifestPath);
    const selected = refreshed.items.find((item) => item.selected);

    expect(summary.complete).toBe(true);
    expect(selected?.status).toBe("downloaded");
    expect(selected?.byteLength).toBe(1_024);
    expect(selected?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("removes only unchanged tracked Desktop placements when a record drops", async () => {
    const fixture = await corpusFixture();
    const goodDirectory = join(fixture.root, "good books");
    const badDirectory = join(fixture.root, "bad books");
    const statePath = join(fixture.root, "desktop-state.json");
    await mkdir(goodDirectory, { recursive: true });
    await writeFile(join(goodDirectory, "book.epub"), "unknown user file", "utf8");
    const summary = evaluationSummary(fixture.sourcePath);

    await prepareDesktopFolders(summary, { goodDirectory, badDirectory, statePath });
    expect(await readdir(goodDirectory)).toContain("book [fixture].epub");

    await prepareDesktopFolders({
      ...summary,
      total: 0,
      passed: 0,
      passRate: 0,
      byFormat: {
        epub: { total: 0, passed: 0, failed: 0 },
        pdf: { total: 0, passed: 0, failed: 0 },
      },
      records: [],
    }, { goodDirectory, badDirectory, statePath });

    expect(await readdir(goodDirectory)).toEqual(["book.epub"]);
    expect(await readFile(join(goodDirectory, "book.epub"), "utf8")).toBe("unknown user file");
  });
});

async function corpusFixture(): Promise<{ root: string; corpusDirectory: string; sourcePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "parser-lab-evaluate-"));
  temporaryDirectories.push(root);
  const corpusDirectory = join(root, "corpus");
  const sourcePath = join(corpusDirectory, "books", "epub", "book.epub");
  await mkdir(join(corpusDirectory, "books", "epub"), { recursive: true });
  const bytes = Buffer.alloc(1_024);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  await writeFile(sourcePath, bytes);
  const now = new Date().toISOString();
  const manifest: CorpusManifest = {
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    target: { total: 1, epub: 1, pdf: 0 },
    sources: [],
    items: [{
      id: "fixture",
      remoteId: "fixture",
      format: "epub",
      title: "Fixture Book",
      authors: ["Tester"],
      filename: "book.epub",
      relativePath: join("books", "epub", "book.epub"),
      sourceName: "Test",
      sourceUrl: "https://example.invalid/book",
      downloadUrl: "https://example.invalid/book.epub",
      license: "Test license",
      licenseUrl: "https://example.invalid/license",
      selectionReason: "harvest-variety",
      status: "downloaded",
      selected: true,
      attempts: 1,
    }],
  };
  await writeFile(join(corpusDirectory, "manifest.json"), JSON.stringify(manifest), "utf8");
  return { root, corpusDirectory, sourcePath };
}

function validOutputWithMissingCover(): ParserOutput {
  const paragraphs = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    text: `Paragraph ${index + 1} contains enough ordinary prose words for this compact evaluation fixture to remain useful and readable.`,
  }));
  return {
    book: buildBook({
      format: "epub",
      metadata: { title: "Fixture Book", authors: ["Tester"] },
      paragraphs,
      chapters: [{ title: "Chapter One", startParagraphId: 1 }],
      images: [],
      cover: null,
      timings: { totalMs: 5 },
    }),
    internals: {},
  };
}

function evaluationSummary(sourcePath: string): EvaluationSummary {
  return {
    schemaVersion: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    corpusPath: dirnameOf(sourcePath, 3),
    resultPath: dirnameOf(sourcePath, 4),
    total: 1,
    passed: 1,
    failed: 0,
    passRate: 100,
    byFormat: {
      epub: { total: 1, passed: 1, failed: 0 },
      pdf: { total: 0, passed: 0, failed: 0 },
    },
    bucketCounts: {
      "Crash": 0,
      "No / unusable text": 0,
      "Bad paragraph IDs": 0,
      "Weak / missing / nonsense chapters": 0,
      "Cover missing": 0,
      "Images missing / blank / badly placed": 0,
      "Timeout / extreme slowness": 0,
      "Other": 0,
    },
    failureBucketCounts: emptyBucketCounts(),
    warningBucketCounts: emptyBucketCounts(),
    records: [{
      id: "fixture",
      sourcePath,
      format: "epub",
      title: "Fixture Book",
      pass: true,
      elapsedMs: 10,
      diagnostics: [],
    }],
  };
}

function emptyBucketCounts(): EvaluationSummary["bucketCounts"] {
  return {
    "Crash": 0,
    "No / unusable text": 0,
    "Bad paragraph IDs": 0,
    "Weak / missing / nonsense chapters": 0,
    "Cover missing": 0,
    "Images missing / blank / badly placed": 0,
    "Timeout / extreme slowness": 0,
    "Other": 0,
  };
}

function dirnameOf(path: string, levels: number): string {
  let result = path;
  for (let index = 0; index < levels; index += 1) result = join(result, "..");
  return result;
}
