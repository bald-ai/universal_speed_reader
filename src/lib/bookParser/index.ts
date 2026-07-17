import { parseEpub } from "./epub.ts";
import type { ParseOptions, ParserOutput } from "./types.ts";
import { MAX_BOOK_PARAGRAPHS, validateParserOutput } from "./validate.ts";

export { MAX_BOOK_PARAGRAPHS };

export type BookSourceFormat = "epub" | "pdf";

export class BookParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookParserError";
  }
}

export function detectBookSourceFormat(fileName: string, bytes: Uint8Array): BookSourceFormat {
  const extension = fileName.trim().toLowerCase();
  const pdfHeader = new TextEncoder().encode("%PDF-");
  const isPdf = pdfHeader.every((value, index) => bytes[index] === value);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (isPdf) return "pdf";
  if (isZip) return "epub";
  if (extension.endsWith(".epub") || extension.endsWith(".pdf")) {
    throw new BookParserError("The file contents do not match its .epub or .pdf filename.");
  }
  throw new BookParserError("Only EPUB books and selectable-text PDF books are supported.");
}

/**
 * App-facing portable parser. The Mac-only corpus scripts deliberately stay in
 * book-parser-lab; this entry accepts uploaded bytes and runs in the app.
 */
export async function parseBookBytes(options: ParseOptions): Promise<ParserOutput> {
  const format = detectBookSourceFormat(options.sourceName, options.sourceBytes);
  const output = format === "epub"
    ? await parseEpub(options)
    : await (await import("./pdf.ts")).parsePdf(options);
  // Always resolves: validation failures become diagnostics, not thrown errors.
  output.book.diagnostics = validateParserOutput(output).diagnostics;
  return output;
}

export type {
  BookFormat,
  BookImage,
  BookMetadata,
  Chapter,
  ParseOptions,
  ParserDiagnostic,
  ParserOutput,
} from "./types.ts";
