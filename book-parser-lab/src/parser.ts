import { extname } from "node:path";
import { errorMessage } from "./text.ts";
import { FAILURE_BUCKETS, type BookFormat, type FailureBucket, type ParseOptions, type ParserOutput } from "./types.ts";
import { validateParserOutput } from "./validate.ts";

const EPUB_MAGIC = [0x50, 0x4b];
const PDF_MAGIC = new TextEncoder().encode("%PDF-");

export class ParserError extends Error {
  readonly bucket: FailureBucket;

  constructor(message: string, bucket: FailureBucket = "Crash", options?: ErrorOptions) {
    super(message, options);
    this.name = "ParserError";
    this.bucket = bucket;
  }
}

export async function parseBook(options: ParseOptions): Promise<ParserOutput> {
  const format = await detectFormat(options.sourcePath);

  try {
    // PDF.js has a substantial module/memory footprint. Loading it in every
    // EPUB worker materially slowed very large reflowable books, so dispatch
    // only the parser needed for the detected format.
    const output = format === "epub"
      ? await (await import("./epub.ts")).parseEpub(options)
      : await (await import("./pdf.ts")).parsePdf(options);
    const validation = validateParserOutput(output);
    output.book.diagnostics = validation.diagnostics;
    return output;
  } catch (error) {
    if (error instanceof ParserError) throw error;
    throw new ParserError(
      `Unable to parse ${format.toUpperCase()}: ${errorMessage(error)}`,
      categorizedBucket(error) ?? "Crash",
      { cause: error },
    );
  }
}

function categorizedBucket(error: unknown): FailureBucket | null {
  if (typeof error !== "object" || error === null || !("bucket" in error)) return null;
  const bucket = (error as { bucket?: unknown }).bucket;
  return typeof bucket === "string" && (FAILURE_BUCKETS as readonly string[]).includes(bucket)
    ? bucket as FailureBucket
    : null;
}

export async function detectFormat(sourcePath: string): Promise<BookFormat> {
  const file = Bun.file(sourcePath);
  if (!(await file.exists())) throw new ParserError(`Input file does not exist: ${sourcePath}`, "Other");

  const size = file.size;
  if (size < PDF_MAGIC.length) throw new ParserError(`Input file is empty or truncated: ${sourcePath}`, "Other");
  const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const extension = extname(sourcePath).toLocaleLowerCase();

  if (startsWith(prefix, PDF_MAGIC)) return "pdf";
  if (prefix[0] === EPUB_MAGIC[0] && prefix[1] === EPUB_MAGIC[1]) return "epub";

  if (extension === ".pdf" || extension === ".epub") {
    throw new ParserError(`The .${extension.slice(1)} file has the wrong file signature.`, "Other");
  }
  throw new ParserError("Unsupported input. The lab accepts reflowable EPUB and text PDF files.", "Other");
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, index) => value[index] === byte);
}
