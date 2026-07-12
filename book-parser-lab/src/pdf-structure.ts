import { basename, extname } from "node:path";

import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

import { median, transformPoint, type DraftParagraph, type PageData } from "./pdf-content.ts";
import { countWords, decodeSafeUriComponent, normalizeText } from "./text.ts";
import type { BookMetadata, Chapter, ParserDiagnostic } from "./types.ts";

const MIN_USEFUL_WORDS = 20;
const MIN_USEFUL_CHARACTERS = 80;

export interface ResolvedOutlineItem {
  title: string;
  pageIndex: number;
  targetY: number | null;
}

interface OutlineChapterCandidate extends Chapter {
  titleMatched: boolean;
}

interface HeadingChapterCandidate extends Chapter {
  paragraph: DraftParagraph;
  structuralMarker: StructuralMarker | null;
  prominence: number;
}

interface StructuralMarker {
  family: "book" | "chapter" | "part" | "section";
  key: string;
  order: number | null;
}

export function buildChapters(
  pages: PageData[],
  paragraphs: DraftParagraph[],
  outlineItems: ResolvedOutlineItem[],
  metadata: BookMetadata,
  diagnostics: ParserDiagnostic[],
  outlineItemCount: number,
): Chapter[] {
  const outlineCandidates = outlineItems.flatMap((item): OutlineChapterCandidate[] => {
    const page = pages[item.pageIndex];
    if (page === undefined) return [];
    const candidates = paragraphs
      .map((paragraph, index) => ({ paragraph, id: index + 1 }))
      .filter(({ paragraph }) => paragraph.lines.some((line) => line.pageNumber === page.pageNumber));
    if (candidates.length === 0) return [];
    const titleMatch = matchOutlineHeading(item.title, candidates);
    if (titleMatch !== null) return [{ title: item.title, startParagraphId: titleMatch.id, titleMatched: true }];
    if (item.targetY === null) return [{ title: item.title, startParagraphId: candidates[0]?.id ?? 1, titleMatched: false }];
    const targetPoint = transformPoint(page.viewportTransform, 0, item.targetY);
    const nearest = [...candidates].sort((left, right) => {
      const leftDistance = paragraphDistanceFromY(left.paragraph, page.pageNumber, targetPoint[1]);
      const rightDistance = paragraphDistanceFromY(right.paragraph, page.pageNumber, targetPoint[1]);
      return leftDistance - rightDistance;
    })[0];
    return nearest === undefined ? [] : [{ title: item.title, startParagraphId: nearest.id, titleMatched: false }];
  });
  const outlineChapters: Chapter[] = outlineCandidates.map(({ title, startParagraphId }) => ({ title, startParagraphId }));

  const headingParagraphs = paragraphs
    .map((paragraph, index) => ({ paragraph, id: index + 1 }))
    .filter(({ paragraph }) => paragraph.headingKind !== null);
  const documentBodyFontSize = median(pages.flatMap((page) => page.lines
    .filter((line) => countWords(line.text) >= 3)
    .map((line) => line.fontSize)));
  const allHeadingCandidates = deduplicateHeadingCandidates(headingParagraphs.map(({ paragraph, id }): HeadingChapterCandidate => ({
    title: paragraph.text,
    startParagraphId: id,
    paragraph,
    structuralMarker: structuralMarker(paragraph.text),
    prominence: paragraphProminence(paragraph, documentBodyFontSize),
  })));
  const strongHeadingCandidates = allHeadingCandidates.filter((candidate) => candidate.paragraph.headingKind === "strong");
  const numberedHeadingEvidence = strongHeadingCandidates.length >= 2
    ? strongHeadingCandidates
    : allHeadingCandidates;
  const numberedHeadingSequenceReliable = hasReliableNumberedHeadingSequence(numberedHeadingEvidence, paragraphs.length);
  const headingCandidates = numberedHeadingSequenceReliable
    ? allHeadingCandidates.filter((candidate) =>
        candidate.structuralMarker !== null || isFrontmatterHeading(candidate.title),
      )
    : allHeadingCandidates.filter((candidate) =>
        candidate.prominence >= 1.15
        || candidate.structuralMarker !== null
        || isFrontmatterHeading(candidate.title),
      );
  const headingFallbackReliable = numberedHeadingSequenceReliable
    || hasReliableHeadingFallback(headingCandidates, paragraphs.length);
  const headingChapters: Chapter[] = headingCandidates.map(({ title, startParagraphId }) => ({ title, startParagraphId }));
  const outlineReliable = hasReliableOutline(outlineCandidates, paragraphs.length);
  const productionArtifactOutline = hasProductionArtifactOutline(outlineCandidates);

  let chapters = outlineChapters.length > 0 ? outlineChapters : headingChapters;
  if (outlineChapters.length > 0
    && !outlineReliable
    && (numberedHeadingSequenceReliable || (productionArtifactOutline && headingFallbackReliable))) {
    chapters = headingChapters;
    diagnostics.push({
      bucket: "Weak / missing / nonsense chapters",
      severity: "warning",
      message: "Weak PDF outline was replaced by a reliable visible-heading sequence",
      details: {
        outlineChapters: outlineChapters.length,
        titleMatchedOutlineChapters: outlineCandidates.filter((candidate) => candidate.titleMatched).length,
        headingChapters: headingChapters.length,
      },
    });
  }
  if (outlineItemCount > 0 && outlineChapters.length / outlineItemCount < 0.4) {
    diagnostics.push({
      bucket: "Weak / missing / nonsense chapters",
      severity: headingChapters.length > 0 ? "warning" : "failure",
      message: `Only ${outlineChapters.length} of ${outlineItemCount} PDF outline destinations could be mapped to text`,
      details: { outlineItems: outlineItemCount, mappedOutlineItems: outlineChapters.length },
    });
    if (outlineChapters.length === 0) chapters = headingChapters;
  }

  if (chapters.length === 0 && paragraphs.length > 0) chapters = [{ title: metadata.title, startParagraphId: 1 }];
  if (paragraphs.length > 0 && pages.length >= 12 && chapters.length < 2) {
    diagnostics.push({
      bucket: "Weak / missing / nonsense chapters",
      severity: "failure",
      message: "Long PDF has no usable outline and too few reliable heading fallbacks",
      details: { pages: pages.length, chapters: chapters.length },
    });
  }

  return chapters;
}

function deduplicateHeadingCandidates(candidates: HeadingChapterCandidate[]): HeadingChapterCandidate[] {
  const structuralGroups = new Map<string, HeadingChapterCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.structuralMarker?.key ?? `title:${chapterTitleKey(candidate.title)}`;
    structuralGroups.set(key, [...(structuralGroups.get(key) ?? []), candidate]);
  }

  const selected: HeadingChapterCandidate[] = [];
  for (const group of structuralGroups.values()) {
    const ranked = [...group].sort((left, right) =>
      right.prominence - left.prominence || right.startParagraphId - left.startParagraphId,
    );
    const best = ranked[0];
    const runnerUp = ranked[1];
    if (best === undefined) continue;
    // TOC copies are usually body-sized while the real opener is visibly
    // larger. Only collapse duplicates when that evidence is material; equal
    // prominence can represent legitimate chapter-number restarts by part.
    if (runnerUp === undefined || best.prominence >= runnerUp.prominence + 0.12) selected.push(best);
    else selected.push(...group);
  }
  return selected.sort((left, right) => left.startParagraphId - right.startParagraphId);
}

function paragraphProminence(paragraph: DraftParagraph, bodySize: number): number {
  const headingSize = Math.max(0, ...paragraph.lines.map((line) => line.fontSize));
  return bodySize > 0 ? headingSize / bodySize : 1;
}

function hasReliableOutline(candidates: OutlineChapterCandidate[], paragraphCount: number): boolean {
  if (candidates.filter((candidate) => candidate.titleMatched).length >= 2) return true;
  if (candidates.length < 3) return false;
  if (hasProductionArtifactOutline(candidates)) return false;
  const starts = [...new Set(candidates.map((candidate) => candidate.startParagraphId))].sort((left, right) => left - right);
  if (starts.length / candidates.length < 0.6) return false;
  return (starts.at(-1) ?? 0) - (starts[0] ?? 0) >= Math.max(20, paragraphCount * 0.2);
}

function hasProductionArtifactOutline(candidates: OutlineChapterCandidate[]): boolean {
  return candidates.length > 0
    && candidates.filter((candidate) => isProductionArtifactTitle(candidate.title)).length >= candidates.length / 2;
}

function hasReliableHeadingFallback(candidates: HeadingChapterCandidate[], paragraphCount: number): boolean {
  if (candidates.length < 3) return false;
  const distinctTitles = new Set(candidates.map((candidate) => chapterTitleKey(candidate.title)).filter(Boolean));
  const distinctStarts = new Set(candidates.map((candidate) => candidate.startParagraphId));
  if (distinctTitles.size < 3 || distinctStarts.size / candidates.length < 0.75) return false;
  const starts = [...distinctStarts].sort((left, right) => left - right);
  return (starts.at(-1) ?? 0) - (starts[0] ?? 0) >= Math.max(20, paragraphCount * 0.2);
}

function isProductionArtifactTitle(value: string): boolean {
  const normalized = normalizeText(value).toLocaleLowerCase();
  return /(?:\.pdf$|\b(?:cover\s+(?:front|back)|bookblock|book\s*block|interior|blank[-\s]|txt$)|^(?:front|back)(?:\.pdf)?$)/u.test(
    normalized,
  );
}

function hasReliableNumberedHeadingSequence(candidates: HeadingChapterCandidate[], paragraphCount: number): boolean {
  const numberedChapters = candidates
    .filter((candidate) => candidate.structuralMarker?.family === "chapter")
    .filter((candidate): candidate is HeadingChapterCandidate & { structuralMarker: StructuralMarker & { order: number } } =>
      candidate.structuralMarker?.order !== null,
    );
  const distinctOrders = new Set(numberedChapters.map((candidate) => candidate.structuralMarker.order));
  if (distinctOrders.size < 3) return false;
  const monotonic = numberedChapters.every((candidate, index) =>
    index === 0 || candidate.structuralMarker.order >= numberedChapters[index - 1]!.structuralMarker.order,
  );
  if (!monotonic) return false;
  return (numberedChapters.at(-1)?.startParagraphId ?? 0) - (numberedChapters[0]?.startParagraphId ?? 0)
    >= Math.max(20, paragraphCount * 0.2);
}

function structuralMarker(value: string): StructuralMarker | null {
  const match = /^(book|chapter|part|section)\s+(\p{N}{1,3}|[ivxlcdm]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:\b|[.):\-\u2013\u2014])/iu.exec(normalizeText(value));
  if (match === null) return null;
  const family = match[1]?.toLocaleLowerCase() as StructuralMarker["family"] | undefined;
  const token = match[2]?.toLocaleLowerCase();
  if (family === undefined || token === undefined) return null;
  const order = structuralOrder(token);
  return { family, key: `${family}:${order ?? token}`, order };
}

function isFrontmatterHeading(value: string): boolean {
  return /^(?:contents|preface|foreword|acknowledg(?:e)?ments?|prologue|epilogue|afterword|appendix)\b/iu.test(
    normalizeText(value),
  );
}

function structuralOrder(token: string): number | null {
  if (/^\p{N}+$/u.test(token)) return Number(token);
  const wordOrder = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"].indexOf(token);
  if (wordOrder >= 0) return wordOrder + 1;
  if (!/^[ivxlcdm]+$/u.test(token)) return null;
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1_000 };
  let total = 0;
  for (let index = 0; index < token.length; index += 1) {
    const current = values[token[index] ?? ""] ?? 0;
    const next = values[token[index + 1] ?? ""] ?? 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

function matchOutlineHeading(
  outlineTitle: string,
  candidates: Array<{ paragraph: DraftParagraph; id: number }>,
): { paragraph: DraftParagraph; id: number } | null {
  const outlineKey = chapterTitleKey(outlineTitle);
  const headings = candidates.filter(({ paragraph }) => paragraph.headingKind !== null);
  const exact = headings.find(({ paragraph }) => chapterTitleKey(paragraph.text) === outlineKey);
  if (exact !== undefined) return exact;

  const outlineTokens = new Set(outlineKey.split(" ").filter(Boolean));
  let best: { candidate: { paragraph: DraftParagraph; id: number }; score: number } | null = null;
  for (const candidate of headings) {
    const candidateKey = chapterTitleKey(candidate.paragraph.text);
    const candidateTokens = new Set(candidateKey.split(" ").filter(Boolean));
    const intersection = [...candidateTokens].filter((token) => outlineTokens.has(token)).length;
    const union = new Set([...outlineTokens, ...candidateTokens]).size;
    const score = union === 0 ? 0 : intersection / union;
    if (score >= 0.8 && (best === null || score > best.score)) best = { candidate, score };
  }
  return best?.candidate ?? null;
}

function chapterTitleKey(value: string): string {
  return normalizeText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/^(?:chapter|section)\s+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function paragraphDistanceFromY(paragraph: DraftParagraph, pageNumber: number, targetY: number): number {
  const baselines = paragraph.lines.filter((line) => line.pageNumber === pageNumber).map((line) => line.baseline);
  return Math.min(...baselines.map((baseline) => Math.abs(baseline - targetY)));
}

export function addTextQualityDiagnostics(
  pages: PageData[],
  paragraphs: DraftParagraph[],
  diagnostics: ParserDiagnostic[],
  totalPageCount: number,
): void {
  const text = paragraphs.map((paragraph) => paragraph.text).join("\n");
  const words = countWords(text);
  const characters = normalizeText(text).length;
  const textPageCount = pages.filter((page) => page.lines.some((line) => countWords(line.text) > 0)).length;
  const imagePageCount = pages.filter((page) => page.declaredImageCount > 0).length;

  if (words < MIN_USEFUL_WORDS || characters < MIN_USEFUL_CHARACTERS) {
    const appearsScanned = totalPageCount > 0 && imagePageCount / totalPageCount >= 0.5;
    diagnostics.push({
      bucket: "No / unusable text",
      severity: "failure",
      message: appearsScanned
        ? "PDF appears to be scanned or image-only; OCR is out of scope for this phase"
        : "PDF does not contain enough usable selectable text for a book import",
      details: { words, characters, textPages: textPageCount, totalPages: totalPageCount, imagePages: imagePageCount },
    });
  } else if (totalPageCount >= 4 && textPageCount / totalPageCount < 0.25 && words / totalPageCount < 20) {
    diagnostics.push({
      bucket: "No / unusable text",
      severity: "failure",
      message: "Most PDF pages lack usable selectable text; the document likely requires OCR",
      details: { words, textPages: textPageCount, totalPages: totalPageCount },
    });
  }

  const totalItems = pages.reduce((total, page) => total + page.textItemCount, 0);
  const verticalItems = pages.reduce((total, page) => total + page.verticalItemCount, 0);
  if (totalItems >= 20 && verticalItems / totalItems >= 0.25) {
    diagnostics.push({
      bucket: "Other",
      severity: "failure",
      message: "Vertical or heavily rotated text cannot yet be reconstructed reliably",
      details: { verticalTextItems: verticalItems, textItems: totalItems },
    });
  }

  const suspiciousCharacters = [...text].filter((character) =>
    character === "\uFFFD" || /[\uE000-\uF8FF]/u.test(character),
  ).length;
  if (suspiciousCharacters >= 10 && suspiciousCharacters / Math.max(characters, 1) > 0.02) {
    diagnostics.push({
      bucket: "No / unusable text",
      severity: "failure",
      message: "Extracted PDF text contains too many replacement or private-use characters",
      details: { suspiciousCharacters, characters },
    });
  }
}

export function metadataFromPdf(
  result: Awaited<ReturnType<PDFDocumentProxy["getMetadata"]>>,
  document: PDFDocumentProxy,
  sourcePath: string,
): BookMetadata {
  const info = isRecord(result.info) ? result.info : {};
  const xmp = result.metadata;
  const title = firstMetadataString(xmp?.get("dc:title"), info.Title) ?? fallbackMetadata(sourcePath).title;
  const authorValues = metadataStrings(xmp?.get("dc:creator"));
  const infoAuthors = metadataStrings(info.Author);
  const authors = deduplicateStrings((authorValues.length > 0 ? authorValues : infoAuthors).flatMap(splitAuthors));
  const language = firstMetadataString(xmp?.get("dc:language"), info.Language, info.Lang);
  const identifier = firstMetadataString(xmp?.get("dc:identifier"), document.fingerprints[0]);
  const metadata: BookMetadata = { title, authors };
  if (language !== null) metadata.language = language;
  if (identifier !== null) metadata.identifier = identifier;
  return metadata;
}

export function fallbackMetadata(sourcePath: string): BookMetadata {
  const filename = decodeSafeUriComponent(basename(sourcePath, extname(sourcePath)));
  const title = normalizeText(filename.replace(/[_]+/gu, " ")) || "Untitled PDF";
  return { title, authors: [] };
}

function metadataStrings(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized.length > 0 ? [normalized] : [];
  }
  if (Array.isArray(value)) return value.flatMap(metadataStrings);
  if (!isRecord(value)) return [];
  const preferredKeys = ["x-default", "en", "value", "name", "#text"];
  for (const key of preferredKeys) {
    const strings = metadataStrings(value[key]);
    if (strings.length > 0) return strings;
  }
  return Object.values(value).flatMap(metadataStrings);
}

function firstMetadataString(...values: unknown[]): string | null {
  for (const value of values) {
    const first = metadataStrings(value)[0];
    if (first !== undefined) return first;
  }
  return null;
}

function splitAuthors(value: string): string[] {
  return value.split(/\s*(?:;|\n|\band\b)\s*/iu).map(normalizeText).filter(Boolean);
}

function deduplicateStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
