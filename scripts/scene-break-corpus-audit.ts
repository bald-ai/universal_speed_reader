import { readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseBookBytes } from "../src/lib/bookParser/index.ts";

const GOOD_DIRECTORY = "/Users/michalkrsik/Desktop/good books";
const BAD_DIRECTORY = "/Users/michalkrsik/Desktop/bad books";
const OUTPUT_JSON = "tmp/scene-break-corpus-audit.json";
const OUTPUT_MARKDOWN = "tmp/scene-break-corpus-audit.md";

type AuditRecord = {
  expected: "good" | "bad";
  file: string;
  format: string;
  pass: boolean;
  words: number;
  paragraphs: number;
  chapters: number;
  sceneBreaks: number;
  breakSources: Record<string, number>;
  navigationKinds: Record<string, number>;
  suspiciousRawOrnaments: number;
  samples: Array<{ source: string; before: string; after: string }>;
  failures: string[];
  elapsedMs: number;
  error?: string;
};

async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => join(directory, entry.name))
    .filter((path) => [".epub", ".pdf"].includes(extname(path).toLocaleLowerCase()))
    .sort();
}

function excerpt(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 180);
}

async function auditFile(path: string, expected: "good" | "bad"): Promise<AuditRecord> {
  const startedAt = performance.now();
  try {
    const file = Bun.file(path);
    const output = await parseBookBytes({
      sourceBytes: new Uint8Array(await file.arrayBuffer()),
      sourceName: basename(path),
    });
    const breaks = output.book.paragraphs.filter((paragraph) => paragraph.sceneBreakBefore);
    const breakSources: Record<string, number> = {};
    for (const paragraph of breaks) {
      const source = paragraph.sceneBreakBefore ?? "unknown";
      breakSources[source] = (breakSources[source] ?? 0) + 1;
    }
    const suspiciousRawOrnaments = output.book.paragraphs.filter((paragraph) =>
      /(?:\s*[\*\u2042\u2022\u25C6\u25C7\u25CA\u2766\u2767\u00B7]){10,}\s*/u.test(paragraph.text)
    ).length;
    const navigationKinds: Record<string, number> = {};
    for (const chapter of output.book.chapters) {
      const kind = chapter.kind ?? "chapter";
      navigationKinds[kind] = (navigationKinds[kind] ?? 0) + 1;
    }
    const failures = output.book.diagnostics
      .filter((diagnostic) => diagnostic.severity === "failure")
      .map((diagnostic) => diagnostic.message);
    return {
      expected,
      file: basename(path),
      format: output.book.format,
      pass: failures.length === 0,
      words: output.book.totals.words,
      paragraphs: output.book.totals.paragraphs,
      chapters: output.book.totals.chapters,
      sceneBreaks: output.book.totals.sceneBreaks,
      breakSources,
      navigationKinds,
      suspiciousRawOrnaments,
      samples: breaks.slice(0, 5).map((paragraph) => ({
        source: paragraph.sceneBreakBefore ?? "unknown",
        before: excerpt(output.book.paragraphs[paragraph.id - 2]?.text ?? ""),
        after: excerpt(paragraph.text),
      })),
      failures,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      expected,
      file: basename(path),
      format: extname(path).slice(1),
      pass: false,
      words: 0,
      paragraphs: 0,
      chapters: 0,
      sceneBreaks: 0,
      breakSources: {},
      navigationKinds: {},
      suspiciousRawOrnaments: 0,
      samples: [],
      failures: [],
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function auditBatch(paths: string[], expected: "good" | "bad"): Promise<AuditRecord[]> {
  const records: AuditRecord[] = [];
  const concurrency = 3;
  for (let start = 0; start < paths.length; start += concurrency) {
    records.push(...await Promise.all(paths.slice(start, start + concurrency).map((path) => auditFile(path, expected))));
    process.stdout.write(`\r${expected}: ${Math.min(start + concurrency, paths.length)}/${paths.length}`);
  }
  process.stdout.write("\n");
  return records;
}

const goodPaths = await filesIn(GOOD_DIRECTORY);
const badPaths = await filesIn(BAD_DIRECTORY);
const repairExistingReport = process.argv.includes("--retry-transient");
let goodRecords: AuditRecord[];
let badRecords: AuditRecord[];
if (repairExistingReport && await Bun.file(OUTPUT_JSON).exists()) {
  const existing = await Bun.file(OUTPUT_JSON).json() as { records?: AuditRecord[] };
  const recordsByFile = new Map((existing.records ?? []).map((record) => [record.file, record]));
  goodRecords = goodPaths.map((path) => recordsByFile.get(basename(path))).filter((record): record is AuditRecord => record !== undefined);
  badRecords = badPaths.map((path) => recordsByFile.get(basename(path))).filter((record): record is AuditRecord => record !== undefined);
  if (goodRecords.length !== goodPaths.length || badRecords.length !== badPaths.length) {
    throw new Error("Existing audit report does not match the current Desktop corpus");
  }
} else {
  goodRecords = await auditBatch(goodPaths, "good");
  badRecords = await auditBatch(badPaths, "bad");
}
for (const [index, record] of goodRecords.entries()) {
  const transientTimeout = !record.pass && (
    /timeout|exceeded\s+\d+\s*ms/iu.test(record.error ?? "")
    || record.failures.some((failure) => /exceeded the 30000 ms limit|parsing took .* ceiling/iu.test(failure))
  );
  if (!transientTimeout) continue;
  const path = goodPaths[index];
  if (!path) continue;
  for (let attempt = 0; attempt < 2 && !goodRecords[index]?.pass; attempt += 1) {
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    goodRecords[index] = await auditFile(path, "good");
  }
}
const records = [
  ...goodRecords,
  ...badRecords,
];
const summary = {
  generatedAt: new Date().toISOString(),
  total: records.length,
  good: records.filter((record) => record.expected === "good").length,
  goodPassed: records.filter((record) => record.expected === "good" && record.pass).length,
  bad: records.filter((record) => record.expected === "bad").length,
  badRejected: records.filter((record) => record.expected === "bad" && !record.pass).length,
  booksWithSceneBreaks: records.filter((record) => record.sceneBreaks > 0).length,
  totalSceneBreaks: records.reduce((sum, record) => sum + record.sceneBreaks, 0),
  booksWithSuspiciousRawOrnaments: records.filter((record) => record.suspiciousRawOrnaments > 0).length,
};
await writeFile(OUTPUT_JSON, `${JSON.stringify({ summary, records }, null, 2)}\n`, "utf8");

const markdown = [
  "# Scene-break corpus audit",
  "",
  `Generated: ${summary.generatedAt}`,
  "",
  `- Good books passed: ${summary.goodPassed}/${summary.good}`,
  `- Bad books rejected: ${summary.badRejected}/${summary.bad}`,
  `- Books with scene breaks: ${summary.booksWithSceneBreaks}`,
  `- Total scene breaks: ${summary.totalSceneBreaks}`,
  `- Books with suspicious raw ornaments: ${summary.booksWithSuspiciousRawOrnaments}`,
  "",
  "| expected | result | file | format | words | paragraphs | chapters | breaks | raw ornaments |",
  "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ...records.map((record) =>
    `| ${record.expected} | ${record.pass ? "pass" : "reject"} | ${record.file.replace(/\|/gu, "\\|")} | ${record.format} | ${record.words} | ${record.paragraphs} | ${record.chapters} | ${record.sceneBreaks} | ${record.suspiciousRawOrnaments} |`
  ),
  "",
].join("\n");
await writeFile(OUTPUT_MARKDOWN, markdown, "utf8");
console.log(JSON.stringify(summary, null, 2));
