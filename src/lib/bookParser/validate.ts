import { countWords, measureTextViability, normalizeText } from "./text.ts";
import { chaptersHaveCollapsedStarts } from "./model.ts";
import type {
  FailureBucket,
  ParsedBook,
  ParserDiagnostic,
  ParserOutput,
} from "./types.ts";

const MAX_BOOK_TIME_MS = 30_000;
const MAX_INLINE_MEDIA_LENGTH = 700_000;

export interface ValidationResult {
  pass: boolean;
  diagnostics: ParserDiagnostic[];
}

export function validateParserOutput(output: ParserOutput): ValidationResult {
  const generated: ParserDiagnostic[] = [];
  const { book, internals } = output;

  validateText(book, generated);
  validateParagraphIds(book, generated);
  validateSceneBreaks(book, generated);
  validateChapters(book, generated);
  validateCover(book, generated);
  validateImages(book, internals.declaredImageCount, generated);
  validateTotals(book, generated);
  validateTiming(book, generated);

  const diagnostics = deduplicateDiagnostics([...book.diagnostics, ...generated]);
  return {
    pass: diagnostics.every((diagnostic) => diagnostic.severity !== "failure"),
    diagnostics,
  };
}

function validateSceneBreaks(book: ParsedBook, diagnostics: ParserDiagnostic[]): void {
  const breaks = book.paragraphs.filter((paragraph) => paragraph.sceneBreakBefore !== undefined);
  const invalid = breaks.filter((paragraph) => paragraph.id <= 1).length;
  if (invalid > 0) {
    diagnostics.push(failure("Bad paragraph IDs", `${invalid} scene breaks are not anchored between real paragraphs.`));
  }

  const rawOrnaments = book.paragraphs.filter((paragraph) => {
    const text = normalizeText(paragraph.text);
    if (/[\p{L}\p{N}]/u.test(text)) return false;
    return (text.match(/[\*\u2042\u2022\u25C6\u25C7\u25CA\u2766\u2767\u00B7]/gu)?.length ?? 0) >= 3;
  }).length;
  if (rawOrnaments > 0) {
    const diagnostic = rawOrnaments >= 20 && rawOrnaments / Math.max(book.paragraphs.length, 1) > 0.02
      ? failure("No / unusable text", `${rawOrnaments} isolated scene ornaments leaked into readable paragraphs.`)
      : warning("No / unusable text", `${rawOrnaments} isolated ornament paragraph${rawOrnaments === 1 ? "" : "s"} should be manually reviewed.`);
    diagnostics.push(diagnostic);
  }

  const impossibleDensity = breaks.length > 20 && breaks.length / Math.max(book.paragraphs.length, 1) > 0.35;
  if (impossibleDensity) {
    diagnostics.push(failure(
      "No / unusable text",
      `Scene-boundary density is implausible: ${breaks.length} breaks across ${book.paragraphs.length} paragraphs.`,
    ));
  }
}

function validateText(book: ParsedBook, diagnostics: ParserDiagnostic[]): void {
  const joined = book.paragraphs.map((paragraph) => paragraph.text).join("\n");
  const { words, usable } = measureTextViability(joined);
  const replacementCharacters = joined.match(/\uFFFD/gu)?.length ?? 0;
  const controlCharacters = joined.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu)?.length ?? 0;

  if (!usable) {
    diagnostics.push(failure("No / unusable text", `Only ${words} words of usable text were extracted.`));
  }

  if (joined.length > 0 && (replacementCharacters + controlCharacters) / joined.length > 0.002) {
    diagnostics.push(failure("No / unusable text", "Extracted text contains too many decoding/control characters."));
  }

  const paragraphWordCounts = book.paragraphs.map((paragraph) => countWords(paragraph.text));
  const largestParagraphWords = Math.max(0, ...paragraphWordCounts);
  if (words >= 1_000 && (book.paragraphs.length === 1 || largestParagraphWords > 5_000 || largestParagraphWords / words > 0.9)) {
    diagnostics.push(
      failure(
        "No / unusable text",
        `Paragraph boundaries collapsed: largest paragraph has ${largestParagraphWords} of ${words} words.`,
      ),
    );
  }

  const emptyCount = book.paragraphs.filter((paragraph) => normalizeText(paragraph.text).length === 0).length;
  if (emptyCount > 0) {
    diagnostics.push(failure("No / unusable text", `${emptyCount} empty paragraphs were emitted.`));
  }
}

function validateParagraphIds(book: ParsedBook, diagnostics: ParserDiagnostic[]): void {
  const invalidIndex = book.paragraphs.findIndex((paragraph, index) => paragraph.id !== index + 1);
  if (invalidIndex >= 0) {
    const paragraph = book.paragraphs[invalidIndex];
    diagnostics.push(
      failure(
        "Bad paragraph IDs",
        `Paragraph index ${invalidIndex} has id ${paragraph?.id ?? "missing"}; expected ${invalidIndex + 1}.`,
      ),
    );
  }
}

function validateChapters(book: ParsedBook, diagnostics: ParserDiagnostic[]): void {
  if (book.chapters.length === 0) {
    diagnostics.push(failure("Weak / missing / nonsense chapters", "No chapter/navigation entry was extracted."));
    return;
  }

  let previousStart = 0;
  let nonsenseCount = 0;
  let invalidStartCount = 0;
  for (const chapter of book.chapters) {
    const title = normalizeText(chapter.title);
    if (title.length === 0 || title.length > 240 || !/[\p{L}\p{N}]/u.test(title)) nonsenseCount += 1;
    if (!Number.isInteger(chapter.startParagraphId)
      || chapter.startParagraphId < 1
      || chapter.startParagraphId > book.paragraphs.length
      || chapter.startParagraphId < previousStart) {
      invalidStartCount += 1;
    }
    previousStart = chapter.startParagraphId;
  }

  if (nonsenseCount > 0 || invalidStartCount > 0) {
    diagnostics.push(
      failure(
        "Weak / missing / nonsense chapters",
        `Chapter list contains ${nonsenseCount} nonsense titles and ${invalidStartCount} invalid starts.`,
      ),
    );
  }

  if (chaptersHaveCollapsedStarts(book.chapters)) {
    diagnostics.push(
      failure("Weak / missing / nonsense chapters", "Chapter entries collapse to too few distinct paragraph starts."),
    );
  }
}

function validateCover(book: ParsedBook, diagnostics: ParserDiagnostic[]): void {
  if (book.cover === null || normalizeText(book.cover.src).length === 0) {
    diagnostics.push(warning("Cover missing", "No reasonable library cover was found."));
    return;
  }

  if (book.cover.src.startsWith("data:") && book.cover.src.length > MAX_INLINE_MEDIA_LENGTH) {
    diagnostics.push(
      failure("Images missing / blank / badly placed", "The cover pointer contains an unexpectedly large inline payload."),
    );
  }
}

function validateImages(
  book: ParsedBook,
  declaredImageCount: number | undefined,
  diagnostics: ParserDiagnostic[],
): void {
  let previousAnchor = 0;
  let invalidCount = 0;
  let inlinePayloadCount = 0;
  for (const image of book.images) {
    const validAnchor = Number.isInteger(image.afterParagraphId)
      && image.afterParagraphId >= 0
      && image.afterParagraphId <= book.paragraphs.length
      && image.afterParagraphId >= previousAnchor;
    const src = image.src.trim();
    const validSource = src.length > 0
      && !src.startsWith("blob:")
      && !/^javascript:/iu.test(src)
      && (book.format !== "pdf" || /^pdf:\/\/page\/\d+(?:\/image\/\d+)?(?:[?#].*)?$/u.test(src));
    if (!validAnchor || !validSource) invalidCount += 1;
    if (src.startsWith("data:") && src.length > MAX_INLINE_MEDIA_LENGTH) inlinePayloadCount += 1;
    previousAnchor = image.afterParagraphId;
  }

  if (invalidCount > 0) {
    diagnostics.push(
      failure("Images missing / blank / badly placed", `${invalidCount} images have invalid pointers or reading-order anchors.`),
    );
  }
  if (inlinePayloadCount > 0) {
    diagnostics.push(
      failure(
        "Images missing / blank / badly placed",
        `${inlinePayloadCount} in-book images were eagerly materialized as large inline payloads.`,
      ),
    );
  }
  if ((declaredImageCount ?? 0) >= 3 && book.images.length === 0) {
    diagnostics.push(
      failure(
        "Images missing / blank / badly placed",
        `${declaredImageCount} image resources were declared but no in-book image was anchored.`,
      ),
    );
  }
}

function validateTotals(book: ParsedBook, diagnostics: ParserDiagnostic[]): void {
  const actualWords = book.paragraphs.reduce((sum, paragraph) => sum + countWords(paragraph.text), 0);
  const mismatch = book.totals.words !== actualWords
    || book.totals.paragraphs !== book.paragraphs.length
    || book.totals.chapters !== book.chapters.length
    || book.totals.images !== book.images.length
    || book.totals.sceneBreaks !== book.paragraphs.filter((paragraph) => paragraph.sceneBreakBefore !== undefined).length;
  if (mismatch) {
    diagnostics.push(failure("Other", "Output totals do not match the emitted model arrays."));
  }
}

function validateTiming(book: ParsedBook, diagnostics: ParserDiagnostic[]): void {
  if (!Number.isFinite(book.timings.totalMs) || book.timings.totalMs < 0) {
    diagnostics.push(failure("Other", "Parser timing is missing or invalid."));
  } else if (book.timings.totalMs > MAX_BOOK_TIME_MS) {
    diagnostics.push(
      failure(
        "Timeout / extreme slowness",
        `Parsing took ${Math.round(book.timings.totalMs)} ms, exceeding the 30-second ceiling.`,
      ),
    );
  }
}

function failure(bucket: FailureBucket, message: string): ParserDiagnostic {
  return { bucket, severity: "failure", message };
}

function warning(bucket: FailureBucket, message: string): ParserDiagnostic {
  return { bucket, severity: "warning", message };
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
