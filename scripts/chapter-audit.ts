/*
  STANDALONE CHAPTER AUDIT RUNNER

  This file is a sidecar calibration script.
  It is not part of the app runtime import flow.

  Purpose:
  - run the copied standalone EPUB chapter parser against a whole folder of EPUBs
  - score the extraction output
  - write per-book reports plus a markdown/json summary
  - let us tune chapter extraction safely before moving changes back into app code

  Keep this file separate from production logic on purpose.
*/
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEpubBytes, type StandaloneChapter, type StandaloneEpubResult } from "./chapter-audit/standaloneEpubParser";

type AuditIssueSeverity = "error" | "warn" | "info";

type AuditIssue = {
  severity: AuditIssueSeverity;
  code: string;
  message: string;
};

type ExtractedChapterSample = {
  index: number;
  title: string;
  start_paragraph_id: number;
  preview: string;
};

type BookAuditResult = {
  file: string;
  title: string | null;
  author: string | null;
  paragraphs: number;
  chapters: number;
  tocEntries: number;
  totalWords: number;
  durationMs: number;
  status: "ok" | "flagged" | "excluded" | "failed";
  excludeReason: string | null;
  issues: AuditIssue[];
  chapterSamples: ExtractedChapterSample[];
  error: string | null;
};

const PROJECT_ROOT = process.cwd();
const DEFAULT_INPUT_DIR = "/Users/michalkrsik/Desktop/gutenberg_epubs";
const OUTPUT_ROOT = path.join(PROJECT_ROOT, "reports", "chapter-audit");
const OUTPUT_BOOKS_DIR = path.join(OUTPUT_ROOT, "books");
const SUMMARY_PATH = path.join(OUTPUT_ROOT, "summary.json");
const MARKDOWN_PATH = path.join(OUTPUT_ROOT, "summary.md");
const MANUAL_EXCLUSIONS: Record<string, string> = {
  "100.epub": "Omnibus source with mixed play titles, sonnets, prologues, epilogues, and internal sections. There is no single stable chapter granularity to score.",
  "25525.epub": "Five-volume omnibus TOC mixes whole works with internal novel chapters and volume markers. There is no single stable chapter granularity to score.",
};

function normalizeTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getChapterPreview(book: StandaloneEpubResult, chapter: StandaloneChapter): string {
  const paragraph = book.paragraphs[chapter.start_paragraph_id - 1];
  return paragraph?.text.slice(0, 220) ?? "";
}

function isLikelyFrontMatter(title: string): boolean {
  const normalized = normalizeTitle(title);
  return [
    "contents",
    "table of contents",
    "copyright",
    "copyright page",
    "title page",
    "cover",
    "preface",
    "foreword",
    "introduction",
    "dedication",
  ].some((value) => normalized === value || normalized.startsWith(`${value} `));
}

function isLikelyBackMatter(title: string): boolean {
  const normalized = normalizeTitle(title);
  return [
    "appendix",
    "appendices",
    "bibliography",
    "index",
    "notes",
    "endnotes",
    "footnotes",
    "glossary",
    "colophon",
  ].some((value) => normalized === value || normalized.startsWith(`${value} `));
}

function auditExtraction(book: StandaloneEpubResult): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const singleChapterTitle = book.chapters[0]?.title ? normalizeTitle(book.chapters[0].title) : null;
  const normalizedBookTitle = normalizeTitle(book.title);

  if (book.paragraphs.length === 0) {
    issues.push({ severity: "error", code: "empty-paragraphs", message: "No readable paragraphs were extracted." });
  }
  if (book.chapters.length === 0) {
    issues.push({ severity: "error", code: "empty-chapters", message: "No chapters were extracted." });
  }
  if (
    book.tocEntries > 4 &&
    book.chapters.length === 1 &&
    singleChapterTitle !== normalizedBookTitle &&
    singleChapterTitle !== "full book"
  ) {
    issues.push({ severity: "warn", code: "single-chapter-with-toc", message: "TOC exists but extraction collapsed to one chapter." });
  }

  let previousStart = 0;
  for (let index = 0; index < book.chapters.length; index += 1) {
    const chapter = book.chapters[index]!;
    if (chapter.start_paragraph_id <= previousStart) {
      issues.push({ severity: "error", code: "non-monotonic-starts", message: "Chapter starts are not strictly increasing." });
      break;
    }
    previousStart = chapter.start_paragraph_id;

    if (chapter.start_paragraph_id < 1 || chapter.start_paragraph_id > book.paragraphs.length) {
      issues.push({ severity: "error", code: "invalid-start-id", message: `Chapter start paragraph ${chapter.start_paragraph_id} is outside the paragraph range.` });
    }

    if (isLikelyFrontMatter(chapter.title) && book.chapters.length > 1) {
      issues.push({ severity: "warn", code: "front-matter-chapter", message: `Front matter leaked into the chapter list: "${chapter.title}".` });
    }
    if (isLikelyBackMatter(chapter.title) && book.chapters.length > 2) {
      issues.push({ severity: "warn", code: "back-matter-chapter", message: `Back matter leaked into the chapter list: "${chapter.title}".` });
    }

    const preview = getChapterPreview(book, chapter);
    const normalizedPreview = normalizeTitle(preview);
    const nextChapterStart = book.chapters[index + 1]?.start_paragraph_id ?? Number.MAX_SAFE_INTEGER;
    const nextParagraph = book.paragraphs[chapter.start_paragraph_id];
    if (preview.length === 0) {
      issues.push({ severity: "error", code: "missing-preview", message: `Chapter "${chapter.title}" does not point to readable text.` });
    } else if (
      normalizeTitle(chapter.title) &&
      normalizedPreview &&
      normalizedPreview.length < 40 &&
      normalizedPreview === normalizeTitle(chapter.title) &&
      nextParagraph &&
      chapter.start_paragraph_id + 1 < nextChapterStart &&
      nextParagraph.text.length >= 40
    ) {
      issues.push({ severity: "warn", code: "heading-only-start", message: `Chapter "${chapter.title}" points to a heading instead of body text.` });
    }
  }
  return issues;
}

function getStatus(issues: AuditIssue[], excludeReason: string | null): BookAuditResult["status"] {
  if (excludeReason) return "excluded";
  if (issues.some((issue) => issue.severity === "error")) return "flagged";
  if (issues.some((issue) => issue.severity === "warn")) return "flagged";
  return "ok";
}

function maybeExcludeBook(book: StandaloneEpubResult, error: Error | null): string | null {
  if (error) {
    if (error.message.includes("Unsupported format")) {
      return "File is not a valid EPUB archive.";
    }
    if (error.message.includes("Corrupted/Unreadable EPUB")) {
      return "Source EPUB is structurally broken or unreadable.";
    }
    return null;
  }

  if (book.paragraphs.length === 0) {
    return "Source EPUB contains no readable text.";
  }

  return null;
}

function buildMarkdown(results: BookAuditResult[], inputDir: string): string {
  const lines = [
    "# Chapter Audit",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Input: \`${inputDir}\``,
    "",
    `Books: ${results.length}`,
    `OK: ${results.filter((result) => result.status === "ok").length}`,
    `Flagged: ${results.filter((result) => result.status === "flagged").length}`,
    `Excluded: ${results.filter((result) => result.status === "excluded").length}`,
    `Failed: ${results.filter((result) => result.status === "failed").length}`,
    "",
    "| file | status | title | chapters | tocEntries | paragraphs | issues | excludeReason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.file} | ${result.status} | ${result.title ?? "null"} | ${result.chapters} | ${result.tocEntries} | ${result.paragraphs} | ${result.issues.length} | ${result.excludeReason ?? ""} |`
    );
  }

  return lines.join("\n");
}

async function writeBookReport(fileName: string, payload: unknown): Promise<void> {
  const outputPath = path.join(OUTPUT_BOOKS_DIR, `${fileName}.json`);
  await writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
}

async function run(): Promise<void> {
  const inputDir = process.argv[2] ?? DEFAULT_INPUT_DIR;
  await mkdir(OUTPUT_BOOKS_DIR, { recursive: true });

  const files = (await readdir(inputDir))
    .filter((file) => file.toLowerCase().endsWith(".epub"))
    .sort((a, b) => a.localeCompare(b, "en"));

  const results: BookAuditResult[] = [];

  for (const file of files) {
    const fullPath = path.join(inputDir, file);
    const startedAt = Date.now();
    let parsed: StandaloneEpubResult | null = null;
    let caughtError: Error | null = null;

    try {
      parsed = await parseEpubBytes(new Uint8Array(await readFile(fullPath)));
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
    }

    const excludeReason = parsed ? maybeExcludeBook(parsed, null) : maybeExcludeBook({
      title: "",
      author: null,
      language: null,
      coverPath: null,
      paragraphs: [],
      chapters: [],
      totalWords: 0,
      tocEntries: 0,
    }, caughtError);
    const manualExcludeReason = MANUAL_EXCLUSIONS[file] ?? null;
    const finalExcludeReason = manualExcludeReason ?? excludeReason;

    const issues = parsed ? auditExtraction(parsed) : [];
    const result: BookAuditResult = {
      file,
      title: parsed?.title ?? null,
      author: parsed?.author ?? null,
      paragraphs: parsed?.paragraphs.length ?? 0,
      chapters: parsed?.chapters.length ?? 0,
      tocEntries: parsed?.tocEntries ?? 0,
      totalWords: parsed?.totalWords ?? 0,
      durationMs: Date.now() - startedAt,
      status: caughtError && !finalExcludeReason ? "failed" : getStatus(issues, finalExcludeReason),
      excludeReason: finalExcludeReason,
      issues,
      chapterSamples: (parsed?.chapters ?? []).slice(0, 12).map((chapter, index) => ({
        index,
        title: chapter.title,
        start_paragraph_id: chapter.start_paragraph_id,
        preview: getChapterPreview(parsed!, chapter),
      })),
      error: caughtError?.message ?? null,
    };

    await writeBookReport(path.parse(file).name, {
      file,
      sourcePath: fullPath,
      parsed,
      issues,
      excludeReason: finalExcludeReason,
      error: caughtError?.message ?? null,
    });

    results.push(result);
    console.log(`${result.status.padEnd(8)} ${file} chapters=${result.chapters} issues=${result.issues.length}`);
  }

  await writeFile(SUMMARY_PATH, JSON.stringify(results, null, 2), "utf8");
  await writeFile(MARKDOWN_PATH, buildMarkdown(results, inputDir), "utf8");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
