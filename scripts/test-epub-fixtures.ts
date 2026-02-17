import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryBookRepository } from "../src/lib/storage/inMemoryBookRepository";
import { BookImportService } from "../src/lib/import/bookImportService";
import { computeTotalWords } from "../src/lib/import/normalization";
import type { BookRow, ProcessingStatus } from "../src/types/storage";

type FixtureExpectation = {
  file: string;
  expectedTitle: string;
  expectedParagraphs: number;
  expectedChapters: number;
  expectedTotalWords: number;
  chapterSamples: string[];
  paragraphSnippets: Array<{ paragraph_id: number; includes: string }>;
};

type MetricsRow = {
  file: string;
  final_status: ProcessingStatus;
  paragraphs: number;
  chapters: number;
  total_words: number;
  duration_ms: number;
  attempts: number;
  error: string | null;
};

type TransitionRow = {
  status: ProcessingStatus;
  updated_at: number;
};

type ExpectedMetricsSnapshot = {
  fixtures: FixtureExpectation[];
};

const PROJECT_ROOT = process.cwd();
const EXPECTED_METRICS_PATH = path.join(PROJECT_ROOT, "Devnotes/fixtures/expected_metrics.json");
const REPORT_PATH = path.join(PROJECT_ROOT, "Devnotes/reports/android_import_validation.md");

class TrackingRepository extends InMemoryBookRepository {
  readonly transitionLog = new Map<string, TransitionRow[]>();

  override async setBookStatus(
    bookId: string,
    status: ProcessingStatus,
    patch?: Pick<BookRow, "processing_error" | "updated_at">
  ) {
    const updated = await super.setBookStatus(bookId, status, patch);
    const rows = this.transitionLog.get(bookId) ?? [];
    const last = rows[rows.length - 1];
    if (!last || last.status !== status) {
      rows.push({
        status,
        updated_at: updated.updated_at,
      });
      this.transitionLog.set(bookId, rows);
    }
    return updated;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containsOrderedSequence(values: ProcessingStatus[], expected: ProcessingStatus[]): boolean {
  let cursor = 0;
  for (const value of values) {
    if (value === expected[cursor]) {
      cursor += 1;
      if (cursor === expected.length) {
        return true;
      }
    }
  }
  return false;
}

function ensureSequentialIds(ids: number[]): boolean {
  for (let i = 0; i < ids.length; i += 1) {
    if (ids[i] !== i + 1) return false;
  }
  return true;
}

async function loadExpectedMetrics(): Promise<ExpectedMetricsSnapshot> {
  const raw = await readFile(EXPECTED_METRICS_PATH, "utf8");
  const parsed = JSON.parse(raw) as ExpectedMetricsSnapshot;
  assert(Array.isArray(parsed.fixtures), "expected_metrics.json is invalid");
  return parsed;
}

async function runFixture(expectation: FixtureExpectation): Promise<{
  metrics: MetricsRow;
  transitions: TransitionRow[];
}> {
  const fixturePath = path.join(PROJECT_ROOT, expectation.file);
  const bytes = new Uint8Array(await readFile(fixturePath));

  const repository = new TrackingRepository();
  await repository.init();
  const service = new BookImportService(Promise.resolve(repository));

  const startAt = Date.now();
  const bookId = await service.importFromBytes({
    fileName: path.basename(expectation.file),
    mimeType: "application/epub+zip",
    bytes,
  });

  const transitions: TransitionRow[] = [];
  const timeoutAt = Date.now() + 240_000;

  const queuedBook = await repository.getBook(bookId);
  assert(queuedBook, `Queued book row not found for ${expectation.file}`);
  transitions.push({
    status: "queued",
    updated_at: queuedBook.created_at,
  });
  if (queuedBook.processing_status !== "queued") {
    transitions.push({
      status: queuedBook.processing_status,
      updated_at: queuedBook.updated_at,
    });
  }

  while (Date.now() < timeoutAt) {
    const book = await repository.getBook(bookId);
    assert(book, `Book row not found for ${expectation.file}`);

    if (book.processing_status === "completed" || book.processing_status === "failed") {
      break;
    }

    await sleep(30);
  }

  const finishedAt = Date.now();
  const book = await repository.getBook(bookId);
  assert(book, `Book row missing after import for ${expectation.file}`);
  transitions.push(...(repository.transitionLog.get(bookId) ?? []));

  const dedupedTransitions: TransitionRow[] = [];
  for (const transition of transitions) {
    const last = dedupedTransitions[dedupedTransitions.length - 1];
    if (!last || last.status !== transition.status) {
      dedupedTransitions.push(transition);
    }
  }

  const jobs = await repository.listImportJobs(bookId);
  const aggregate = await repository.getBookAggregate(bookId);
  assert(aggregate, `Aggregate missing for ${expectation.file}`);
  const readable = await repository.getReadableBook(bookId);
  assert(readable, `Readable book must exist for completed import: ${expectation.file}`);
  assert(readable.book.paragraphs.length > 0, `Readable book paragraphs missing for ${expectation.file}`);
  assert(readable.book.chapters.length > 0, `Readable book chapters missing for ${expectation.file}`);

  // 9.4 Processing state-machine assertions.
  const transitionStatuses = dedupedTransitions.map((entry) => entry.status);
  assert(
    containsOrderedSequence(transitionStatuses, [
      "queued",
      "validating",
      "extracting_metadata",
      "extracting_text",
      "building_chapters",
      "completed",
    ]),
    `Missing happy-path transitions for ${expectation.file}: ${transitionStatuses.join(" -> ")}`
  );
  for (let i = 1; i < dedupedTransitions.length; i += 1) {
    assert(
      dedupedTransitions[i].updated_at >= dedupedTransitions[i - 1].updated_at,
      `updated_at did not advance for ${expectation.file}`
    );
  }

  assert(book.processing_status === "completed", `Import failed for ${expectation.file}: ${book.processing_error ?? "unknown error"}`);
  assert(book.processing_error === null, `processing_error must be null for completed book ${expectation.file}`);
  assert(book.total_paragraphs > 0, `total_paragraphs must be > 0 for ${expectation.file}`);
  assert(book.total_words > 0, `total_words must be > 0 for ${expectation.file}`);

  const chapters = aggregate.chapters;
  const chunks = aggregate.chunks;
  const paragraphs = chunks.flatMap((chunk) => chunk.paragraphs_json);

  // 9.2 Invariants for completed books.
  const paragraphIds = paragraphs.map((paragraph) => paragraph.id);
  assert(ensureSequentialIds(paragraphIds), `Paragraph ids must be sequential for ${expectation.file}`);

  assert(chapters.length > 0, `chapter count must be > 0 for ${expectation.file}`);
  if (chapters.length === 0) {
    assert(false, `Expected at least one chapter for ${expectation.file}`);
  }
  const paragraphIdSet = new Set(paragraphIds);
  for (const chapter of chapters) {
    assert(
      paragraphIdSet.has(chapter.start_paragraph_id),
      `Chapter start paragraph ${chapter.start_paragraph_id} missing for ${expectation.file}`
    );
  }

  const chunkIndexes = chunks.map((chunk) => chunk.chunk_index);
  assert(chunkIndexes[0] === 0, `chunk_index must start at 0 for ${expectation.file}`);
  for (let i = 0; i < chunkIndexes.length; i += 1) {
    assert(chunkIndexes[i] === i, `chunk_index must be gap-free for ${expectation.file}`);
  }

  const uniqueParagraphIdCount = new Set(paragraphIds).size;
  assert(uniqueParagraphIdCount === paragraphs.length, `Paragraph ids duplicated across chunks for ${expectation.file}`);

  const recomputedWords = computeTotalWords(paragraphs);
  assert(recomputedWords === book.total_words, `total_words mismatch for ${expectation.file}`);
  assert(paragraphs.length === book.total_paragraphs, `total_paragraphs mismatch for ${expectation.file}`);
  assert(chunks.length === book.total_chunks, `total_chunks mismatch for ${expectation.file}`);

  // 9.3 Content-truth assertions.
  assert(book.title === expectation.expectedTitle, `Unexpected title for ${expectation.file}`);
  assert(book.total_paragraphs === expectation.expectedParagraphs, `Unexpected paragraph count for ${expectation.file}`);
  assert(chapters.length === expectation.expectedChapters, `Unexpected chapter count for ${expectation.file}`);
  assert(book.total_words === expectation.expectedTotalWords, `Unexpected total words for ${expectation.file}`);

  const chapterTitles = chapters.map((chapter) => chapter.title);
  for (const chapterSample of expectation.chapterSamples) {
    assert(
      chapterTitles.includes(chapterSample),
      `Missing expected chapter "${chapterSample}" for ${expectation.file}`
    );
  }

  for (const snippet of expectation.paragraphSnippets) {
    const paragraph = paragraphs[snippet.paragraph_id - 1];
    assert(paragraph, `Missing paragraph ${snippet.paragraph_id} for ${expectation.file}`);
    assert(
      paragraph.text.includes(snippet.includes),
      `Paragraph ${snippet.paragraph_id} mismatch for ${expectation.file}`
    );
  }

  // Reader resume persistence simulation.
  const resumeParagraph = Math.min(120, book.total_paragraphs);
  await repository.saveReadingProgress({
    book_id: bookId,
    paragraph_id: resumeParagraph,
    word_index: 2,
    mode: "normal",
    updated_at: Date.now(),
  });
  const beforeReopen = await repository.getReadingProgress(bookId);
  assert(beforeReopen?.paragraph_id === resumeParagraph, `Progress save failed for ${expectation.file}`);

  const snapshot = await repository.exportSnapshot();
  const reopened = new InMemoryBookRepository();
  await reopened.init();
  await reopened.importSnapshot(snapshot);
  const reopenedBook = await reopened.getReadableBook(bookId);
  assert(reopenedBook, `Reader reopen contract failed for ${expectation.file}`);
  const afterReopen = await reopened.getReadingProgress(bookId);
  assert(afterReopen?.paragraph_id === resumeParagraph, `Progress restore after reopen failed for ${expectation.file}`);

  return {
    metrics: {
      file: path.basename(expectation.file),
      final_status: book.processing_status,
      paragraphs: book.total_paragraphs,
      chapters: chapters.length,
      total_words: book.total_words,
      duration_ms: finishedAt - startAt,
      attempts: jobs.length,
      error: book.processing_error,
    },
    transitions: dedupedTransitions,
  };
}

function buildReportTable(rows: MetricsRow[]): string {
  const lines = [
    "| file | final_status | paragraphs | chapters | total_words | duration_ms | attempts | error |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.file} | ${row.final_status} | ${row.paragraphs} | ${row.chapters} | ${row.total_words} | ${row.duration_ms} | ${row.attempts} | ${row.error ?? "null"} |`
    );
  }
  return lines.join("\n");
}

async function writeReport(
  rows: MetricsRow[],
  transitionsByFile: Record<string, TransitionRow[]>
): Promise<void> {
  const content = [
    "# Android Import Validation",
    "",
    `Date: ${new Date().toISOString()}`,
    "",
    "## Command Summary",
    "",
    "- Command: `bun run test:epub-fixtures`",
    `- Total fixtures: ${rows.length}`,
    `- Passed fixtures: ${rows.filter((row) => row.final_status === "completed").length}`,
    "",
    "## Extraction Report",
    "",
    buildReportTable(rows),
    "",
    "## State Transition Logs",
    "",
    ...rows.flatMap((row) => {
      const transitions = transitionsByFile[row.file] ?? [];
      const transitionText = transitions
        .map((entry) => `${entry.status} @ ${entry.updated_at}`)
        .join(" -> ");
      return [`- ${row.file}: ${transitionText}`];
    }),
    "",
    "## Known Limitations",
    "",
    "- Decompression relies on `DecompressionStream`; very old browsers without this API are not supported.",
  ].join("\n");

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, content, "utf8");
}

async function main(): Promise<void> {
  const expected = await loadExpectedMetrics();
  const results: MetricsRow[] = [];
  const transitionsByFile: Record<string, TransitionRow[]> = {};

  for (const fixture of expected.fixtures) {
    const { metrics, transitions } = await runFixture(fixture);
    results.push(metrics);
    transitionsByFile[metrics.file] = transitions;
  }

  await writeReport(results, transitionsByFile);
  console.table(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
