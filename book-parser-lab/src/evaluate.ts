import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  corpusBookPath,
  loadCorpusManifest,
  type CorpusManifestItem,
} from "./corpus.ts";
import {
  materializeEpubPreviewAssets,
  writeFailurePreview,
} from "./preview.ts";
import type {
  BookFormat,
  EvaluationRecord,
  EvaluationSummary,
  FailureBucket,
  ParsedBook,
  ParserDiagnostic,
  ParserOutput,
} from "./types.ts";
import { FAILURE_BUCKETS } from "./types.ts";
import { validateParserOutput } from "./validate.ts";

export const ABSOLUTE_BOOK_TIMEOUT_MS = 30_000;
export const GOOD_BOOKS_DIRECTORY = "/Users/michalkrsik/Desktop/good books";
export const BAD_BOOKS_DIRECTORY = "/Users/michalkrsik/Desktop/bad books";
export const DEFAULT_DESKTOP_STATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../results/desktop-placements.json",
);
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024 * 1024;

export interface ParseCommandSpec {
  /** Tokens; `{input}` and `{output}` are replaced without invoking a shell. */
  command: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  outputMode?: "auto" | "stdout" | "file";
}

export interface EvaluateCorpusOptions {
  corpusDirectory: string;
  resultDirectory: string;
  parseCommand: readonly string[] | ParseCommandSpec;
  manifestPath?: string;
  concurrency?: number;
  timeoutMs?: number;
  writeDesktopFolders?: boolean;
  desktopMode?: "symlink" | "copy";
  goodBooksDirectory?: string;
  badBooksDirectory?: string;
}

export interface PlainEnglishReport {
  headline: string;
  howItDid: string;
  wentWell: string[];
  wentPoorly: string[];
  next: string[];
}

export interface EvaluationReportData {
  summary: EvaluationSummary;
  plainEnglish: PlainEnglishReport;
  performance: {
    medianMs: number;
    p95Ms: number;
    epubOverTarget: number;
    pdfOverTarget: number;
  };
}

export interface EvaluationReportPaths {
  summaryJsonPath: string;
  reportDataJsonPath: string;
  markdownPath: string;
  htmlPath: string;
}

export interface PrepareDesktopFoldersOptions {
  mode?: "symlink" | "copy";
  goodDirectory?: string;
  badDirectory?: string;
  statePath?: string;
}

export interface DesktopPlacementSummary {
  goodDirectory: string;
  badDirectory: string;
  good: number;
  bad: number;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  timedOut: boolean;
  outputOverflow: boolean;
  spawnError?: string;
}

interface WorkerFailure {
  bucket: FailureBucket;
  message: string;
}

interface DesktopStateEntry {
  sourcePath: string;
  destinationPath: string;
  mode: "symlink" | "copy";
}

interface DesktopState {
  schemaVersion: 1;
  entries: DesktopStateEntry[];
}

/**
 * Evaluate every selected manifest item using one killable subprocess per book.
 * The command may write `{output}` or emit a worker envelope/ParserOutput to stdout.
 */
export async function evaluateCorpus(options: EvaluateCorpusOptions): Promise<EvaluationSummary> {
  const startedAt = new Date().toISOString();
  const corpusDirectory = resolve(options.corpusDirectory);
  const resultDirectory = resolve(options.resultDirectory);
  const manifestPath = resolve(options.manifestPath ?? join(corpusDirectory, "manifest.json"));
  const manifest = await loadCorpusManifest(manifestPath);
  const selectedItems = manifest.items.filter((item) => item.selected);
  const selectedEpubs = selectedItems.filter((item) => item.format === "epub").length;
  const selectedPdfs = selectedItems.filter((item) => item.format === "pdf").length;
  const selectedDownloaded = selectedItems.filter((item) => item.status === "downloaded").length;
  const uniqueSelectedIds = new Set(selectedItems.map((item) => item.id)).size;
  const targetIsConsistent = manifest.target.total === manifest.target.epub + manifest.target.pdf;
  const selectionMatchesTarget = targetIsConsistent &&
    selectedItems.length === manifest.target.total &&
    selectedEpubs === manifest.target.epub &&
    selectedPdfs === manifest.target.pdf &&
    selectedDownloaded === manifest.target.total &&
    uniqueSelectedIds === manifest.target.total;
  if (!selectionMatchesTarget) {
    throw new Error(
      `Corpus selection does not match manifest target in ${manifestPath}: ` +
      `expected ${manifest.target.total} books (${manifest.target.epub} EPUB / ${manifest.target.pdf} PDF), ` +
      `found ${selectedItems.length} selected (${selectedEpubs} EPUB / ${selectedPdfs} PDF), ` +
      `${selectedDownloaded} downloaded, and ${uniqueSelectedIds} unique IDs. ` +
      "Complete or resume corpus acquisition before evaluation.",
    );
  }
  const items = selectedItems;
  const parseCommand = normalizeCommandSpec(options.parseCommand);
  const timeoutMs = Math.min(ABSOLUTE_BOOK_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? ABSOLUTE_BOOK_TIMEOUT_MS));
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? recommendedEvaluationConcurrency())));
  await Promise.all([
    mkdir(join(resultDirectory, "parsed"), { recursive: true }),
    mkdir(join(resultDirectory, "previews", "assets"), { recursive: true }),
    mkdir(join(resultDirectory, "work"), { recursive: true }),
  ]);

  const records: EvaluationRecord[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    records.push(...await Promise.all(batch.map((item) => evaluateItem(
      item,
      corpusDirectory,
      resultDirectory,
      parseCommand,
      timeoutMs,
    ))));
    await atomicJson(join(resultDirectory, "evaluation.partial.json"), {
      schemaVersion: 1,
      startedAt,
      completed: records.length,
      total: items.length,
      records,
    });
  }

  records.sort((left, right) => left.id.localeCompare(right.id));
  const summary = buildEvaluationSummary(startedAt, new Date().toISOString(), corpusDirectory, resultDirectory, records);
  await writeEvaluationReports(summary);
  // Keep the exact licensed selection, source URLs, and integrity hashes beside
  // every completed report so a result remains auditable after the live corpus
  // manifest is extended or repaired.
  await copyFile(manifestPath, join(resultDirectory, "corpus-manifest.json"));
  if (options.writeDesktopFolders !== false) {
    await prepareDesktopFolders(summary, {
      ...(options.desktopMode ? { mode: options.desktopMode } : {}),
      ...(options.goodBooksDirectory ? { goodDirectory: options.goodBooksDirectory } : {}),
      ...(options.badBooksDirectory ? { badDirectory: options.badBooksDirectory } : {}),
    });
  }
  return summary;
}

async function evaluateItem(
  item: CorpusManifestItem,
  corpusDirectory: string,
  resultDirectory: string,
  commandSpec: ParseCommandSpec,
  timeoutMs: number,
): Promise<EvaluationRecord> {
  const sourcePath = corpusBookPath(corpusDirectory, item);
  const safeId = filenameSafe(item.id);
  const outputPath = join(resultDirectory, "parsed", `${safeId}.json`);
  const workerOutputPath = join(resultDirectory, "work", `${safeId}-${process.pid}-${Date.now()}.json`);
  const command = instantiateCommand(commandSpec.command, sourcePath, workerOutputPath);
  const expectsFile = commandSpec.outputMode === "file" ||
    (commandSpec.outputMode !== "stdout" && commandSpec.command.some(hasOutputPlaceholder));
  let processResult: ProcessResult | undefined;
  let output: ParserOutput | undefined;
  let diagnostics: ParserDiagnostic[] = [];

  try {
    processResult = await runKillableCommand(command, {
      ...(commandSpec.cwd ? { cwd: resolve(commandSpec.cwd) } : {}),
      ...(commandSpec.env ? { env: commandSpec.env } : {}),
      sourcePath,
      outputPath: workerOutputPath,
      timeoutMs,
    });
    if (processResult.timedOut) {
      diagnostics.push(failure("Timeout / extreme slowness", `Worker exceeded the absolute ${timeoutMs} ms per-book deadline.`));
    } else if (processResult.spawnError) {
      diagnostics.push(failure("Crash", `Unable to start parser worker: ${processResult.spawnError}`));
    } else if (processResult.outputOverflow) {
      diagnostics.push(failure("Crash", `Parser process output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes.`));
    } else {
      const payloadText = expectsFile
        ? await readWorkerOutput(workerOutputPath, processResult.stdout)
        : processResult.stdout;
      const decoded = decodeWorkerPayload(payloadText);
      if ("failure" in decoded) diagnostics.push(failure(decoded.failure.bucket, decoded.failure.message));
      else {
        output = decoded.output;
        if (processResult.exitCode !== 0) {
          diagnostics.push(failure("Crash", `Parser returned exit code ${processResult.exitCode ?? "null"} after emitting output.`));
        }
        if (output.book.format !== item.format) {
          diagnostics.push(failure("Other", `Parser emitted ${output.book.format} for a ${item.format} corpus item.`));
        }
        output.book.diagnostics = normalizeCoverDiagnostics(output.book.diagnostics);
        const validation = validateParserOutput(output);
        diagnostics.push(...normalizeCoverDiagnostics(validation.diagnostics));
      }
    }
  } catch (error) {
    const processCrashed = processResult !== undefined &&
      (processResult.exitCode !== 0 || processResult.signal !== null);
    const bucket = processCrashed || error instanceof MissingWorkerOutputError
      ? "Crash"
      : error instanceof ModelOutputError ? "Other" : "Crash";
    diagnostics.push(failure(bucket, errorMessage(error)));
  } finally {
    await unlink(workerOutputPath).catch(() => undefined);
  }

  diagnostics = deduplicateDiagnostics(diagnostics);
  const pass = diagnostics.every((diagnostic) => diagnostic.severity !== "failure");
  if (output) {
    output.book.diagnostics = diagnostics;
    await atomicJson(outputPath, output);
  }
  const elapsedMs = processResult?.elapsedMs ?? 0;
  let record: EvaluationRecord = {
    id: item.id,
    sourcePath,
    sourceUrl: item.sourceUrl,
    sourceName: item.sourceName,
    format: item.format,
    title: item.title,
    pass,
    elapsedMs,
    diagnostics,
    ...(output ? { outputPath } : {}),
  };

  if (!pass) {
    const previewPath = join(resultDirectory, "previews", `${safeId}.html`);
    let imageUrlBySource: Record<string, string> | undefined;
    let previewNote = "";
    if (output?.book.format === "epub") {
      try {
        imageUrlBySource = await materializeEpubPreviewAssets({
          sourcePath,
          book: output.book,
          assetDirectory: join(resultDirectory, "previews", "assets", safeId),
          htmlDirectory: dirname(previewPath),
        });
      } catch (error) {
        previewNote = `\nPreview asset materialization: ${errorMessage(error)}`;
      }
    }
    record = { ...record, previewPath };
    await writeFailurePreview({
      destinationPath: previewPath,
      record,
      ...(output ? { book: output.book } : {}),
      ...(imageUrlBySource ? { imageUrlBySource } : {}),
      ...(processResult?.stderr || previewNote ? { parserStderr: `${processResult?.stderr ?? ""}${previewNote}` } : {}),
      ...(!output && processResult?.stdout ? { parserStdout: processResult.stdout } : {}),
    });
  }
  return record;
}

export function validateParsedBookOutput(value: unknown): ParserOutput {
  const candidate = unwrapSuccessEnvelope(value);
  if (!isRecord(candidate)) throw new ModelOutputError("Parser output is not an object.");
  const maybeOutput = "book" in candidate ? candidate : { book: candidate, internals: {} };
  if (!isRecord(maybeOutput.book)) throw new ModelOutputError("Parser output has no book object.");
  const book = maybeOutput.book;
  if (book.schemaVersion !== 1 || (book.format !== "epub" && book.format !== "pdf")) {
    throw new ModelOutputError("Parser output has the wrong schemaVersion or format.");
  }
  if (!isRecord(book.metadata) || typeof book.metadata.title !== "string" || !isStringArray(book.metadata.authors)) {
    throw new ModelOutputError("Book metadata must contain a title and authors array.");
  }
  if (!Array.isArray(book.paragraphs) || !book.paragraphs.every((entry) =>
    isRecord(entry) && typeof entry.id === "number" && typeof entry.text === "string")) {
    throw new ModelOutputError("paragraphs does not match { id, text }[].");
  }
  if (!Array.isArray(book.chapters) || !book.chapters.every((entry) =>
    isRecord(entry) && typeof entry.title === "string" && typeof entry.startParagraphId === "number")) {
    throw new ModelOutputError("chapters does not match { title, startParagraphId }[].");
  }
  if (!Array.isArray(book.images) || !book.images.every((entry) =>
    isRecord(entry) && typeof entry.afterParagraphId === "number" && typeof entry.alt === "string" && typeof entry.src === "string")) {
    throw new ModelOutputError("images does not match the sidecar image model.");
  }
  if (book.cover !== null && (!isRecord(book.cover) || typeof book.cover.src !== "string")) {
    throw new ModelOutputError("cover must be null or a cover pointer.");
  }
  const totals = book.totals;
  if (!isRecord(totals) || !["words", "paragraphs", "chapters", "images"].every((key) => typeof totals[key] === "number")) {
    throw new ModelOutputError("totals is missing or malformed.");
  }
  if (!Array.isArray(book.diagnostics) || !book.diagnostics.every(isDiagnostic)) {
    throw new ModelOutputError("diagnostics is malformed.");
  }
  if (!isRecord(book.timings) || typeof book.timings.totalMs !== "number") {
    throw new ModelOutputError("timings.totalMs is missing.");
  }
  const internals = isRecord(maybeOutput.internals) ? maybeOutput.internals : {};
  return { book: book as unknown as ParsedBook, internals } as ParserOutput;
}

export async function writeEvaluationReports(summary: EvaluationSummary): Promise<EvaluationReportPaths> {
  const reportData = buildReportData(summary);
  const paths: EvaluationReportPaths = {
    summaryJsonPath: join(summary.resultPath, "summary.json"),
    reportDataJsonPath: join(summary.resultPath, "report-data.json"),
    markdownPath: join(summary.resultPath, "report.md"),
    htmlPath: join(summary.resultPath, "report.html"),
  };
  await Promise.all([
    atomicJson(paths.summaryJsonPath, summary),
    atomicJson(paths.reportDataJsonPath, reportData),
    atomicWrite(paths.markdownPath, renderMarkdownReport(reportData)),
    atomicWrite(paths.htmlPath, renderHtmlReport(reportData)),
  ]);
  return paths;
}

export async function prepareDesktopFolders(
  summary: EvaluationSummary,
  options: PrepareDesktopFoldersOptions = {},
): Promise<DesktopPlacementSummary> {
  const goodDirectory = resolve(options.goodDirectory ?? GOOD_BOOKS_DIRECTORY);
  const badDirectory = resolve(options.badDirectory ?? BAD_BOOKS_DIRECTORY);
  const statePath = resolve(options.statePath ?? DEFAULT_DESKTOP_STATE_PATH);
  const mode = options.mode ?? "symlink";
  await Promise.all([mkdir(goodDirectory, { recursive: true }), mkdir(badDirectory, { recursive: true })]);
  const previousState = await readDesktopState(statePath);
  const nextEntries: DesktopStateEntry[] = [];
  const currentSources = new Set(summary.records.map((record) => resolve(record.sourcePath)));
  for (const old of previousState.entries) {
    if (!currentSources.has(resolve(old.sourcePath)) && isDesktopResultPath(old.destinationPath, goodDirectory, badDirectory)) {
      await removeManagedPlacementIfUnchanged(old);
    }
  }

  for (const record of summary.records) {
    const desiredDirectory = record.pass ? goodDirectory : badDirectory;
    const oldEntries = previousState.entries.filter((entry) => resolve(entry.sourcePath) === resolve(record.sourcePath));
    for (const old of oldEntries) {
      if (isDesktopResultPath(old.destinationPath, goodDirectory, badDirectory) &&
        (dirname(resolve(old.destinationPath)) !== desiredDirectory || old.mode !== mode)) {
        await removeManagedPlacementIfUnchanged(old);
      }
    }
    const knownDestinations = new Set(oldEntries.map((entry) => resolve(entry.destinationPath)));
    const destinationPath = await chooseDesktopDestination(
      desiredDirectory,
      record.sourcePath,
      record.id,
      mode,
      knownDestinations,
    );
    if (!(await placementMatches(destinationPath, record.sourcePath, mode))) {
      if (mode === "symlink") await symlink(resolve(record.sourcePath), destinationPath);
      else await copyFile(record.sourcePath, destinationPath);
    }
    nextEntries.push({ sourcePath: resolve(record.sourcePath), destinationPath, mode });
  }
  await atomicJson(statePath, { schemaVersion: 1, entries: nextEntries } satisfies DesktopState);
  return {
    goodDirectory,
    badDirectory,
    good: summary.records.filter((record) => record.pass).length,
    bad: summary.records.filter((record) => !record.pass).length,
  };
}

function buildEvaluationSummary(
  startedAt: string,
  completedAt: string,
  corpusPath: string,
  resultPath: string,
  records: EvaluationRecord[],
): EvaluationSummary {
  const passed = records.filter((record) => record.pass).length;
  const formatStats = (format: BookFormat) => {
    const subset = records.filter((record) => record.format === format);
    const formatPassed = subset.filter((record) => record.pass).length;
    return { total: subset.length, passed: formatPassed, failed: subset.length - formatPassed };
  };
  const countBuckets = (severity?: ParserDiagnostic["severity"]): Record<FailureBucket, number> =>
    Object.fromEntries(FAILURE_BUCKETS.map((bucket) => [bucket, records.filter((record) =>
      record.diagnostics.some((diagnostic) => diagnostic.bucket === bucket && (severity === undefined || diagnostic.severity === severity))).length])) as Record<FailureBucket, number>;
  const bucketCounts = countBuckets();
  const failureBucketCounts = countBuckets("failure");
  const warningBucketCounts = countBuckets("warning");
  return {
    schemaVersion: 1,
    startedAt,
    completedAt,
    corpusPath,
    resultPath,
    total: records.length,
    passed,
    failed: records.length - passed,
    passRate: records.length === 0 ? 0 : passed / records.length * 100,
    byFormat: { epub: formatStats("epub"), pdf: formatStats("pdf") },
    bucketCounts,
    failureBucketCounts,
    warningBucketCounts,
    records,
  };
}

function buildReportData(summary: EvaluationSummary): EvaluationReportData {
  const elapsed = summary.records.map((record) => record.elapsedMs).sort((left, right) => left - right);
  const failedBuckets = FAILURE_BUCKETS.filter((bucket) => summary.failureBucketCounts[bucket] > 0)
    .sort((left, right) => summary.failureBucketCounts[right] - summary.failureBucketCounts[left]);
  const plainEnglish: PlainEnglishReport = {
    headline: `${summary.passed} of ${summary.total} books passed (${summary.passRate.toFixed(1)}%).`,
    howItDid: summary.failed === 0
      ? "Every evaluated book met the automatic phase-1 model checks. Manual spot-checking is still required before app integration."
      : `${summary.failed} books failed strict automatic checks. Every failure has a local HTML preview and remains in the bad-books set for review.`,
    wentWell: [
      `${summary.byFormat.epub.passed}/${summary.byFormat.epub.total} EPUBs passed.`,
      `${summary.byFormat.pdf.passed}/${summary.byFormat.pdf.total} text-PDF candidates passed.`,
      `Missing covers were isolated as ${summary.warningBucketCounts["Cover missing"]} warnings and did not fail books by themselves.`,
    ],
    wentPoorly: failedBuckets.length
      ? failedBuckets.slice(0, 3).map((bucket) => {
          const count = summary.failureBucketCounts[bucket];
          return `${bucket}: ${count} failed ${count === 1 ? "book" : "books"}.`;
        })
      : ["No automatic failure bucket was populated."],
    next: summary.failed > 0
      ? ["Review the failure previews and completed manual spot checks.", "Choose a phase-2 fallback policy for genuine damaged-asset and text-fidelity failures.", "Do not wire this parser into production until the review is accepted."]
      : ["Manually compare Pride and Prejudice plus illustrated and PDF samples against the supplied reference views.", "Record any visual false passes before considering production integration."],
  };
  return {
    summary,
    plainEnglish,
    performance: {
      medianMs: percentile(elapsed, 0.5),
      p95Ms: percentile(elapsed, 0.95),
      epubOverTarget: summary.records.filter((record) => record.format === "epub" && record.elapsedMs > 5_000).length,
      pdfOverTarget: summary.records.filter((record) => record.format === "pdf" && record.elapsedMs > 10_000).length,
    },
  };
}

function renderMarkdownReport(data: EvaluationReportData): string {
  const { summary, plainEnglish, performance } = data;
  const failures = summary.records.filter((record) => !record.pass);
  const lines = [
    "# Book Parser Lab — Evaluation Report", "",
    `Run: ${summary.startedAt} → ${summary.completedAt}`, "",
    "## Plain-English result", "", plainEnglish.headline, "", plainEnglish.howItDid, "",
    "### What went well", "", ...plainEnglish.wentWell.map((value) => `- ${value}`), "",
    "### What went poorly", "", ...plainEnglish.wentPoorly.map((value) => `- ${value}`), "",
    "### What to do next", "", ...plainEnglish.next.map((value) => `- ${value}`), "",
    "## Numbers", "",
    "| Scope | Total | Passed | Failed |", "|---|---:|---:|---:|",
    `| All | ${summary.total} | ${summary.passed} | ${summary.failed} |`,
    `| EPUB | ${summary.byFormat.epub.total} | ${summary.byFormat.epub.passed} | ${summary.byFormat.epub.failed} |`,
    `| PDF | ${summary.byFormat.pdf.total} | ${summary.byFormat.pdf.passed} | ${summary.byFormat.pdf.failed} |`, "",
    `Median wall time: ${formatMs(performance.medianMs)}; p95: ${formatMs(performance.p95Ms)}. EPUBs over 5 s: ${performance.epubOverTarget}; PDFs over 10 s: ${performance.pdfOverTarget}.`, "",
    "## Diagnostic-bucket tally", "", "Counts are distinct books. Failure and warning severities are shown separately; a book may appear in more than one bucket.", "",
    "| Bucket | Failures | Warnings | Any severity |", "|---|---:|---:|---:|", ...FAILURE_BUCKETS.map((bucket) => `| ${bucket} | ${summary.failureBucketCounts[bucket]} | ${summary.warningBucketCounts[bucket]} | ${summary.bucketCounts[bucket]} |`), "",
    "## Realistically broken / not-good-enough books", "",
    failures.length === 0 ? "No books failed automatic checks." : `Actual failure count: ${failures.length}. The phase-1 target is at least 20 genuine failures when they occur; do not manufacture failures if the 500-book cap yields fewer.`, "",
    ...failures.flatMap((record) => [
      `- **${record.title}** (${record.format.toUpperCase()}, ${formatMs(record.elapsedMs)}) — ${record.diagnostics.filter((diagnostic) => diagnostic.severity === "failure").map((diagnostic) => diagnostic.bucket).join(", ")}`,
      `  - ${record.previewPath ? `[failure preview](${relative(summary.resultPath, record.previewPath)})` : "No preview"} · [source file](${pathToFileURL(record.sourcePath).href})${record.sourceUrl ? ` · [source page](${record.sourceUrl})` : ""}`,
    ]), "",
    "## Method", "",
    "Each selected manifest book ran in its own killable process with a hard 30-second ceiling. All outputs were checked against sequential paragraph IDs, usable text, sane chapters, pointer-based image anchors, cover warning policy, totals, timing, and the app-compatible target model. Failure previews materialize only bounded referenced EPUB assets; parser output itself retains pointers.", "",
    "Pride and Prejudice remains the visual/reading baseline. Manual review should include front matter, chapter navigation, colophon/illustration order and captions, plus difficult text PDFs.", "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderHtmlReport(data: EvaluationReportData): string {
  const markdown = renderMarkdownReport(data);
  const failures = data.summary.records.filter((record) => !record.pass);
  const failureRows = failures.map((record) => `<tr><td>${escapeHtml(record.title)}</td><td>${record.format.toUpperCase()}</td><td>${record.diagnostics.filter((entry) => entry.severity === "failure").map((entry) => escapeHtml(entry.bucket)).join(", ")}</td><td>${record.previewPath ? `<a href="${encodeURI(relative(data.summary.resultPath, record.previewPath))}">preview</a>` : "—"}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Book Parser Lab report</title><style>body{max-width:1100px;margin:3rem auto;padding:0 1.25rem;color:#24211c;background:#f7f2e8;font:16px/1.55 system-ui,sans-serif}h1{font-size:2.5rem}.hero{padding:2rem;background:#29251f;color:white}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin:2rem 0}.card{padding:1rem;background:white;border:1px solid #d8cdbd}.card strong{display:block;font-size:2rem}table{width:100%;border-collapse:collapse;background:white}th,td{padding:.65rem;text-align:left;border:1px solid #d8cdbd}pre{white-space:pre-wrap;padding:1rem;background:white;border:1px solid #d8cdbd}@media(max-width:700px){.cards{grid-template-columns:1fr 1fr}}</style></head><body><section class="hero"><h1>Book Parser Lab</h1><p>${escapeHtml(data.plainEnglish.headline)}</p><p>${escapeHtml(data.plainEnglish.howItDid)}</p></section><section class="cards"><div class="card"><span>Pass rate</span><strong>${data.summary.passRate.toFixed(1)}%</strong></div><div class="card"><span>Failures</span><strong>${data.summary.failed}</strong></div><div class="card"><span>Median</span><strong>${formatMs(data.performance.medianMs)}</strong></div><div class="card"><span>p95</span><strong>${formatMs(data.performance.p95Ms)}</strong></div></section><h2>Failure previews</h2>${failures.length ? `<table><thead><tr><th>Book</th><th>Format</th><th>Buckets</th><th>Preview</th></tr></thead><tbody>${failureRows}</tbody></table>` : "<p>No automatic failures.</p>"}<details><summary>Full plain-text/Markdown report data</summary><pre>${escapeHtml(markdown)}</pre></details></body></html>`;
}

function normalizeCommandSpec(value: readonly string[] | ParseCommandSpec): ParseCommandSpec {
  const spec: ParseCommandSpec = Array.isArray(value)
    ? { command: [...value] }
    : value as ParseCommandSpec;
  if (!spec.command.length || spec.command.some((token) => token.length === 0)) throw new Error("parseCommand must contain non-empty argv tokens");
  return spec as ParseCommandSpec;
}

function instantiateCommand(template: readonly string[], input: string, output: string): string[] {
  const replace = (token: string) => token
    .replaceAll("{{input}}", input).replaceAll("{input}", input)
    .replaceAll("{{output}}", output).replaceAll("{output}", output);
  const command = template.map(replace);
  if (!template.some(hasInputPlaceholder)) command.push(input);
  return command;
}

async function runKillableCommand(
  command: string[],
  options: { cwd?: string; env?: Readonly<Record<string, string>>; sourcePath: string; outputPath: string; timeoutMs: number },
): Promise<ProcessResult> {
  const started = performance.now();
  return new Promise((resolvePromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command[0]!, command.slice(1), {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, BOOK_PARSER_INPUT: options.sourcePath, BOOK_PARSER_OUTPUT: options.outputPath },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (error) {
      resolvePromise({ stdout: "", stderr: "", exitCode: null, signal: null, elapsedMs: performance.now() - started, timedOut: false, outputOverflow: false, spawnError: errorMessage(error) });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputOverflow = false;
    let spawnError: string | undefined;
    let completed = false;
    const kill = (signal: NodeJS.Signals) => killProcessGroup(child, signal);
    const timeout = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 500).unref();
    }, options.timeoutMs);
    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_PROCESS_OUTPUT_BYTES) destination.push(chunk);
      else if (!outputOverflow) {
        outputOverflow = true;
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 500).unref();
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => { spawnError = errorMessage(error); });
    child.on("close", (exitCode, signal) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
        elapsedMs: performance.now() - started,
        timedOut,
        outputOverflow,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}

function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* It already exited. */ }
  }
}

async function readWorkerOutput(path: string, stdoutFallback: string): Promise<string> {
  try {
    const info = await stat(path);
    if (info.size > MAX_PROCESS_OUTPUT_BYTES) throw new Error(`Worker result file exceeds ${MAX_PROCESS_OUTPUT_BYTES} bytes`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (stdoutFallback.trim()) return stdoutFallback;
    throw new MissingWorkerOutputError(`Parser worker did not write its output file: ${errorMessage(error)}`);
  }
}

function decodeWorkerPayload(text: string): { output: ParserOutput } | { failure: WorkerFailure } {
  if (!text.trim()) throw new MissingWorkerOutputError("Parser worker returned no JSON output.");
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new ModelOutputError("Parser worker returned invalid JSON."); }
  if (isRecord(value) && value.ok === false && isRecord(value.error)) {
    const bucket = isFailureBucket(value.error.bucket) ? value.error.bucket : "Crash";
    return { failure: { bucket, message: typeof value.error.message === "string" ? value.error.message : "Parser worker failed without a message." } };
  }
  return { output: validateParsedBookOutput(value) };
}

function unwrapSuccessEnvelope(value: unknown): unknown {
  return isRecord(value) && value.ok === true && "output" in value ? value.output : value;
}

function normalizeCoverDiagnostics(diagnostics: ParserDiagnostic[]): ParserDiagnostic[] {
  return diagnostics.map((diagnostic) => diagnostic.bucket === "Cover missing" ? { ...diagnostic, severity: "warning" } : diagnostic);
}

function deduplicateDiagnostics(diagnostics: ParserDiagnostic[]): ParserDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.bucket}\u0000${diagnostic.severity}\u0000${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function failure(bucket: FailureBucket, message: string): ParserDiagnostic {
  return { bucket, severity: bucket === "Cover missing" ? "warning" : "failure", message };
}

function isDiagnostic(value: unknown): boolean {
  return isRecord(value) && isFailureBucket(value.bucket) && (value.severity === "warning" || value.severity === "failure") && typeof value.message === "string";
}

function isFailureBucket(value: unknown): value is FailureBucket {
  return typeof value === "string" && (FAILURE_BUCKETS as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recommendedEvaluationConcurrency(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

function hasInputPlaceholder(value: string): boolean {
  return value.includes("{input}") || value.includes("{{input}}");
}

function hasOutputPlaceholder(value: string): boolean {
  return value.includes("{output}") || value.includes("{{output}}");
}

async function chooseDesktopDestination(
  directory: string,
  sourcePath: string,
  id: string,
  mode: "symlink" | "copy",
  knownDestinations: ReadonlySet<string>,
): Promise<string> {
  const original = basename(sourcePath);
  const extension = extname(original);
  const stem = original.slice(0, original.length - extension.length);
  const candidates = [original, `${stem} [${filenameSafe(id)}]${extension}`];
  for (let index = 2; ; index += 1) {
    const candidate = candidates.shift() ?? `${stem} [${filenameSafe(id)}-${index}]${extension}`;
    const path = join(directory, candidate);
    if (!(await pathExists(path))) return path;
    if (knownDestinations.has(resolve(path)) && await placementMatches(path, sourcePath, mode)) return path;
  }
}

async function placementMatches(destination: string, source: string, mode: "symlink" | "copy"): Promise<boolean> {
  try {
    const info = await lstat(destination);
    if (mode === "symlink") return info.isSymbolicLink() && resolve(dirname(destination), await readlink(destination)) === resolve(source);
    if (!info.isFile()) return false;
    const [left, right] = await Promise.all([hashFile(destination), hashFile(source)]);
    return left === right;
  } catch { return false; }
}

async function removeManagedPlacementIfUnchanged(entry: DesktopStateEntry): Promise<void> {
  if (await placementMatches(entry.destinationPath, entry.sourcePath, entry.mode)) await unlink(entry.destinationPath);
}

async function readDesktopState(path: string): Promise<DesktopState> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.entries)) return value as unknown as DesktopState;
  } catch { /* A missing/corrupt ledger never authorizes deletion. */ }
  return { schemaVersion: 1, entries: [] };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))] ?? 0;
}

function formatMs(value: number): string {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function filenameSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120) || "book";
}

function isDesktopResultPath(path: string, goodDirectory: string, badDirectory: string): boolean {
  const parent = dirname(resolve(path));
  return parent === goodDirectory || parent === badDirectory;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

class MissingWorkerOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingWorkerOutputError";
  }
}
