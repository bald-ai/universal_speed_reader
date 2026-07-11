import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { downloadCorpus } from "./corpus.ts";
import { evaluateCorpus, prepareDesktopFolders } from "./evaluate.ts";
import { parseBook } from "./parser.ts";
import { materializeEpubPreviewAssets, writeFailurePreview } from "./preview.ts";
import type { EvaluationRecord } from "./types.ts";

const LAB_DIRECTORY = resolve(import.meta.dir, "..");
const DEFAULT_CORPUS_DIRECTORY = resolve(LAB_DIRECTORY, "corpus");
const DEFAULT_RESULT_DIRECTORY = resolve(LAB_DIRECTORY, "results", "latest");
const DEFAULT_TIMEOUT_MS = 30_000;
const MINIMUM_CORPUS_SIZE = 250;
const MAXIMUM_CORPUS_SIZE = 500;
const TARGET_FAILURE_COUNT = 20;
const EXTENSION_STEP = 50;

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

const [command = "help", ...arguments_] = process.argv.slice(2);

try {
  if (command === "parse") await runParse(arguments_);
  else if (command === "preview") await runPreview(arguments_);
  else if (command === "download-corpus") await runDownload(arguments_);
  else if (command === "evaluate") await runEvaluate(arguments_);
  else if (command === "overnight") await runOvernight(arguments_);
  else if (command === "help" || command === "--help" || command === "-h") printHelp();
  else throw new CliError(`Unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function runPreview(arguments_: string[]): Promise<void> {
  const positional = positionalArguments(arguments_);
  const source = positional[0] ?? option(arguments_, "input");
  if (!source) throw new CliError("preview requires a .epub or .pdf input path");
  const sourcePath = resolve(source);
  const startedAt = performance.now();
  const output = await parseBook({ sourcePath, timeoutMs: DEFAULT_TIMEOUT_MS });
  const elapsedMs = performance.now() - startedAt;
  const stem = basename(sourcePath, extname(sourcePath)).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  const destinationPath = resolve(
    option(arguments_, "output") ?? resolve(DEFAULT_RESULT_DIRECTORY, "spot-checks", `${stem}.html`),
  );
  const record: EvaluationRecord = {
    id: `spot-${stem}`,
    sourcePath,
    format: output.book.format,
    title: output.book.metadata.title,
    pass: output.book.diagnostics.every((diagnostic) => diagnostic.severity !== "failure"),
    elapsedMs,
    diagnostics: output.book.diagnostics,
  };
  const imageUrlBySource = output.book.format === "epub"
    ? await materializeEpubPreviewAssets({
        sourcePath,
        book: output.book,
        assetDirectory: resolve(dirname(destinationPath), "assets", stem),
        htmlDirectory: dirname(destinationPath),
      })
    : undefined;
  await writeFailurePreview({
    destinationPath,
    record,
    book: output.book,
    previewKind: "spot-check",
    ...(imageUrlBySource ? { imageUrlBySource } : {}),
  });
  process.stdout.write(`${destinationPath}\n`);
}

async function runParse(arguments_: string[]): Promise<void> {
  const positional = positionalArguments(arguments_);
  const source = positional[0] ?? option(arguments_, "input");
  if (!source) throw new CliError("parse requires a .epub or .pdf input path");
  const sourcePath = resolve(source);
  const output = await parseBook({ sourcePath, timeoutMs: numberOption(arguments_, "timeout-ms") ?? DEFAULT_TIMEOUT_MS });
  const destination = option(arguments_, "output");
  const json = `${JSON.stringify(output.book, null, 2)}\n`;
  if (destination) {
    const outputPath = resolve(destination);
    await mkdir(dirname(outputPath), { recursive: true });
    await Bun.write(outputPath, json);
    process.stdout.write(`${outputPath}\n`);
  } else {
    process.stdout.write(json);
  }
  if (output.book.diagnostics.some((diagnostic) => diagnostic.severity === "failure")) process.exitCode = 1;
}

async function runDownload(arguments_: string[]): Promise<void> {
  const corpusDirectory = resolve(option(arguments_, "corpus") ?? DEFAULT_CORPUS_DIRECTORY);
  const targetCount = numberOption(arguments_, "target") ?? MINIMUM_CORPUS_SIZE;
  const epubCount = numberOption(arguments_, "epubs");
  const pdfCount = numberOption(arguments_, "pdfs");
  const concurrency = numberOption(arguments_, "concurrency");
  const summary = await downloadCorpus({
    corpusDirectory,
    targetCount,
    ...(epubCount !== undefined ? { epubCount } : {}),
    ...(pdfCount !== undefined ? { pdfCount } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(hasFlag(arguments_, "refresh") ? { refreshDiscovery: true } : {}),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function runEvaluate(arguments_: string[]): Promise<void> {
  const corpusDirectory = resolve(option(arguments_, "corpus") ?? DEFAULT_CORPUS_DIRECTORY);
  const resultDirectory = resolve(option(arguments_, "results") ?? DEFAULT_RESULT_DIRECTORY);
  const concurrency = numberOption(arguments_, "concurrency");
  const summary = await evaluateCorpus({
    corpusDirectory,
    resultDirectory,
    parseCommand: parserCommand(),
    ...(concurrency !== undefined ? { concurrency } : {}),
    timeoutMs: numberOption(arguments_, "timeout-ms") ?? DEFAULT_TIMEOUT_MS,
    writeDesktopFolders: !hasFlag(arguments_, "no-desktop"),
  });
  printSummary(summary);
}

async function runOvernight(arguments_: string[]): Promise<void> {
  const corpusDirectory = resolve(option(arguments_, "corpus") ?? DEFAULT_CORPUS_DIRECTORY);
  const resultDirectory = resolve(option(arguments_, "results") ?? DEFAULT_RESULT_DIRECTORY);
  const initialTarget = numberOption(arguments_, "target") ?? MINIMUM_CORPUS_SIZE;
  const maximumTarget = numberOption(arguments_, "cap") ?? MAXIMUM_CORPUS_SIZE;
  const targetFailures = numberOption(arguments_, "target-failures") ?? TARGET_FAILURE_COUNT;
  const concurrency = numberOption(arguments_, "concurrency");

  if (initialTarget < MINIMUM_CORPUS_SIZE || initialTarget > maximumTarget || maximumTarget > MAXIMUM_CORPUS_SIZE) {
    throw new CliError("overnight target must be 250–500 and cannot exceed the cap");
  }

  let target = initialTarget;
  let finalSummary: Awaited<ReturnType<typeof evaluateCorpus>> | undefined;
  while (target <= maximumTarget) {
    process.stdout.write(`\nAcquiring ${target} books (${Math.round(target * 0.8)} EPUB / ${target - Math.round(target * 0.8)} PDF)…\n`);
    await downloadCorpus({
      corpusDirectory,
      targetCount: target,
      ...(concurrency !== undefined ? { concurrency } : {}),
    });
    process.stdout.write(`Evaluating ${target} books with a ${DEFAULT_TIMEOUT_MS / 1_000}s absolute per-book ceiling…\n`);
    finalSummary = await evaluateCorpus({
      corpusDirectory,
      resultDirectory,
      parseCommand: parserCommand(),
      ...(concurrency !== undefined ? { concurrency } : {}),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      writeDesktopFolders: false,
    });
    printSummary(finalSummary);
    if (finalSummary.failed >= targetFailures || target >= maximumTarget) break;
    target = Math.min(maximumTarget, target + EXTENSION_STEP);
  }

  if (!finalSummary) throw new CliError("overnight evaluation did not produce a summary");
  const desktop = await prepareDesktopFolders(finalSummary);
  process.stdout.write(
    `Desktop classification complete: ${desktop.good} good, ${desktop.bad} bad.\n` +
    `Report: ${resolve(resultDirectory, "report.md")}\n`,
  );
}

function parserCommand(): { command: string[]; cwd: string; outputMode: "file" } {
  return {
    command: [process.execPath, resolve(import.meta.dir, "parse-worker.ts"), "{input}", "{output}"],
    cwd: LAB_DIRECTORY,
    outputMode: "file",
  };
}

function printSummary(summary: Awaited<ReturnType<typeof evaluateCorpus>>): void {
  process.stdout.write(
    `${summary.passed}/${summary.total} passed (${summary.passRate.toFixed(1)}%); ` +
    `${summary.failed} failed. Report: ${resolve(summary.resultPath, "report.md")}\n`,
  );
}

function option(arguments_: string[], name: string): string | undefined {
  const equalsPrefix = `--${name}=`;
  const equalsValue = arguments_.find((argument) => argument.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = arguments_.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new CliError(`--${name} requires a value`);
  return value;
}

function numberOption(arguments_: string[], name: string): number | undefined {
  const raw = option(arguments_, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new CliError(`--${name} must be a positive integer`);
  }
  return value;
}

function hasFlag(arguments_: string[], name: string): boolean {
  return arguments_.includes(`--${name}`);
}

function positionalArguments(arguments_: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument.startsWith("--") && argument.includes("=")) continue;
    if (argument.startsWith("--")) {
      if (!["--refresh", "--no-desktop"].includes(argument)) index += 1;
      continue;
    }
    result.push(argument);
  }
  return result;
}

function printHelp(): void {
  const executable = `${basename(process.execPath)} ${basename(import.meta.path)}`;
  process.stdout.write(`Book Parser Lab (Mac-only standalone)\n\n` +
    `  ${executable} parse <book.epub|book.pdf> [--output book.json]\n` +
    `  ${executable} preview <book.epub|book.pdf> [--output preview.html]\n` +
    `  ${executable} download-corpus [--target 250] [--corpus path]\n` +
    `  ${executable} evaluate [--corpus path] [--results path] [--no-desktop]\n` +
    `  ${executable} overnight [--target 250] [--cap 500] [--target-failures 20]\n\n` +
    `The overnight command extends 250-book runs in 50-book increments when fewer than 20 genuine failures are found, stopping at 500.\n`);
}
