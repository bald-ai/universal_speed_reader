import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseBook, ParserError } from "./parser.ts";
import { errorMessage } from "./text.ts";
import type { FailureBucket } from "./types.ts";

interface WorkerSuccess {
  ok: true;
  output: Awaited<ReturnType<typeof parseBook>>;
}

interface WorkerFailure {
  ok: false;
  error: {
    bucket: FailureBucket;
    message: string;
    stack?: string;
  };
}

const sourceArgument = process.argv[2];
const outputArgument = process.argv[3];

if (sourceArgument === undefined) {
  process.stderr.write("Usage: bun src/parse-worker.ts <book.epub|book.pdf> [result.json]\n");
  process.exit(2);
}

const sourcePath = resolve(sourceArgument);

try {
  const output = await parseBook({ sourcePath });
  await writeEnvelope({ ok: true, output });
} catch (error) {
  const failure: WorkerFailure = {
    ok: false,
    error: {
      bucket: error instanceof ParserError ? error.bucket : "Crash",
      message: errorMessage(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    },
  };
  await writeEnvelope(failure);
  process.exitCode = 1;
}

async function writeEnvelope(envelope: WorkerSuccess | WorkerFailure): Promise<void> {
  const json = `${JSON.stringify(envelope)}\n`;
  if (outputArgument === undefined) {
    process.stdout.write(json);
    return;
  }
  const outputPath = resolve(outputArgument);
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, json);
}
