import { countWords, normalizeText } from "./text.ts";
import type { BookImage } from "./types.ts";

export type Matrix = [number, number, number, number, number, number];

export interface TextLine {
  text: string;
  xMin: number;
  xMax: number;
  baseline: number;
  fontSize: number;
  pageNumber: number;
  column: number;
  hasEol: boolean;
  vertical: boolean;
  order: number;
}

export interface PageImageCandidate {
  pageNumber: number;
  objectId: string;
  operatorIndex: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  rawWidth: number;
  rawHeight: number;
}

export interface PageData {
  pageNumber: number;
  width: number;
  height: number;
  viewportTransform: Matrix;
  lines: TextLine[];
  images: PageImageCandidate[];
  declaredImageCount: number;
  rawTextCharacters: number;
  verticalItemCount: number;
  textItemCount: number;
}

export interface DraftParagraph {
  text: string;
  lines: TextLine[];
  headingKind: "strong" | "typographic" | null;
}

const STRUCTURAL_ORDINAL_PATTERN = "(?:\\p{N}{1,3}|[ivxlcdm]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";
const BARE_STRUCTURAL_HEADING = new RegExp(
  `^(?:chapter|book|part|section)\\s+${STRUCTURAL_ORDINAL_PATTERN}[.)]?$`,
  "iu",
);
// These mirror validateText's strict rejection boundary. The retry only runs
// for a model that validation would otherwise reject; validation itself stays
// authoritative and unchanged.
const COLLAPSED_PARAGRAPH_MINIMUM_WORDS = 1_000;
const COLLAPSED_PARAGRAPH_MAXIMUM_WORDS = 5_000;
const COLLAPSED_PARAGRAPH_WORD_RATIO = 0.9;
const OVERSIZED_PROSE_PARAGRAPH_WORDS = 500;
const SYNTHETIC_PARAGRAPH_TARGET_WORDS = 280;
const SYNTHETIC_PARAGRAPH_MINIMUM_WORDS = 180;
const SYNTHETIC_PARAGRAPH_MAXIMUM_WORDS = 420;

interface GapProfile {
  typical: number;
  paragraphThreshold: number | null;
}

interface GapCluster {
  values: number[];
  center: number;
}

interface EmbeddedChapterMarker {
  start: number;
  end: number;
  order: number;
  paragraphIndex: number;
}

interface EmbeddedChapterRange {
  start: number;
  end: number;
  title: string;
  startParagraphIndex: number;
  endParagraphIndex: number;
}

export function filterRepeatedPageFurniture(pages: PageData[]): void {
  for (const page of pages) {
    const clearFooterStart = Math.min(...page.lines
      .filter((line) => pageEdge(line, page.height) === "footer" && /^(?:©|copyright\b|doi\b)/iu.test(line.text))
      .map((line) => line.baseline));
    page.lines = page.lines
      .filter((line) => !Number.isFinite(clearFooterStart) || line.baseline < clearFooterStart - 1)
      .filter((line) => !isClearPageFurniture(line, page.height))
      .map((line, order) => ({ ...line, order }));
  }
  if (pages.length < 3) return;
  const occurrences = new Map<string, Set<number>>();

  for (const page of pages) {
    const pageKeys = new Set<string>();
    for (const line of page.lines) {
      const edge = pageEdge(line, page.height);
      if (edge === null || line.text.length > 180) continue;
      pageKeys.add(`${edge}\u0000${furnitureSignature(line.text)}`);
    }
    for (const key of pageKeys) {
      const pageNumbers = occurrences.get(key) ?? new Set<number>();
      pageNumbers.add(page.pageNumber);
      occurrences.set(key, pageNumbers);
    }
  }

  const repeated = new Set<string>();
  for (const [key, pageNumbers] of occurrences) {
    if (pageNumbers.size < 3) continue;
    const allRatio = pageNumbers.size / pages.length;
    const oddPages = pages.filter((page) => page.pageNumber % 2 === 1).length;
    const evenPages = pages.length - oddPages;
    const oddOccurrences = [...pageNumbers].filter((page) => page % 2 === 1).length;
    const evenOccurrences = pageNumbers.size - oddOccurrences;
    const parityRepeated = (oddPages >= 3 && oddOccurrences / oddPages >= 0.6)
      || (evenPages >= 3 && evenOccurrences / evenPages >= 0.6);
    if (allRatio >= 0.35 || parityRepeated) repeated.add(key);
  }

  for (const page of pages) {
    page.lines = page.lines
      .filter((line) => {
        const edge = pageEdge(line, page.height);
        return edge === null || !repeated.has(`${edge}\u0000${furnitureSignature(line.text)}`);
      })
      .map((line, order) => ({ ...line, order }));
  }
}

function isClearPageFurniture(line: TextLine, pageHeight: number): boolean {
  const edge = pageEdge(line, pageHeight);
  if (edge === "footer" && /^(?:©|copyright\b|doi\b)/iu.test(line.text)) return true;
  return edge === "header" && /…+\s*\p{N}{1,4}$/u.test(line.text);
}

function pageEdge(line: TextLine, pageHeight: number): "header" | "footer" | null {
  if (line.baseline <= pageHeight * 0.15) return "header";
  if (line.baseline >= pageHeight * 0.85) return "footer";
  return null;
}

function furnitureSignature(value: string): string {
  const normalized = normalizeText(value).toLocaleLowerCase();
  if (/^(?:\p{N}+|[ivxlcdm]+)$/iu.test(normalized)) return "<page-number>";
  if (/^(?:chapter|part|book|section)\b/iu.test(normalized)) return normalized;
  const words = normalized.split(" ");
  return words.length >= 3 ? normalized.replace(/\p{N}+/gu, "#") : normalized;
}

export function buildParagraphs(pages: PageData[]): DraftParagraph[] {
  const primary = buildParagraphsWithMode(pages, false);
  const paragraphs = paragraphBoundariesCollapsed(primary)
    ? buildParagraphsWithMode(pages, true)
    : primary;
  return splitOversizedProseParagraphs(recoverEmbeddedChapterHeadings(paragraphs));
}

interface TextSlice {
  start: number;
  end: number;
  text: string;
}

function splitOversizedProseParagraphs(paragraphs: DraftParagraph[]): DraftParagraph[] {
  return paragraphs.flatMap((paragraph) => {
    if (paragraph.headingKind !== null || countWords(paragraph.text) <= OVERSIZED_PROSE_PARAGRAPH_WORDS) {
      return [paragraph];
    }
    const sentenceSlices = sentenceSlicesForSyntheticParagraphs(paragraph.text);
    if (sentenceSlices.length < 3
      || sentenceSlices.some((slice) => countWords(slice.text) > SYNTHETIC_PARAGRAPH_MAXIMUM_WORDS)) {
      return [paragraph];
    }

    const chunks: TextSlice[] = [];
    let current: TextSlice | null = null;
    for (const sentence of sentenceSlices) {
      if (current === null) {
        current = sentence;
        continue;
      }
      const currentWords = countWords(current.text);
      if (currentWords >= SYNTHETIC_PARAGRAPH_MINIMUM_WORDS
        && currentWords + countWords(sentence.text) > SYNTHETIC_PARAGRAPH_TARGET_WORDS) {
        chunks.push(current);
        current = sentence;
      } else {
        current = {
          start: current.start,
          end: sentence.end,
          text: normalizeText(`${current.text} ${sentence.text}`),
        };
      }
    }
    if (current !== null) chunks.push(current);

    const tail = chunks.at(-1);
    const beforeTail = chunks.at(-2);
    if (tail !== undefined && beforeTail !== undefined
      && countWords(tail.text) < SYNTHETIC_PARAGRAPH_MINIMUM_WORDS
      && countWords(beforeTail.text) + countWords(tail.text) <= SYNTHETIC_PARAGRAPH_MAXIMUM_WORDS) {
      chunks.splice(-2, 2, {
        start: beforeTail.start,
        end: tail.end,
        text: normalizeText(`${beforeTail.text} ${tail.text}`),
      });
    }
    if (chunks.length < 2
      || chunks.some((chunk) => countWords(chunk.text) > SYNTHETIC_PARAGRAPH_MAXIMUM_WORDS)) {
      return [paragraph];
    }
    return chunks.map((chunk) => ({
      ...paragraph,
      text: chunk.text,
      lines: proportionalLinesForTextSlice(paragraph, chunk),
    }));
  });
}

function sentenceSlicesForSyntheticParagraphs(text: string): TextSlice[] {
  const result: TextSlice[] = [];
  const boundaryPattern = /[.!?…][”’)]?(?=\s+[\p{Lu}“‘\[])/gu;
  let start = 0;
  for (const match of text.matchAll(boundaryPattern)) {
    if (match.index === undefined) continue;
    const end = match.index + match[0].length;
    const sentence = normalizeText(text.slice(start, end));
    if (sentence.length > 0) result.push({ start, end, text: sentence });
    start = end;
  }
  const tail = normalizeText(text.slice(start));
  if (tail.length > 0) result.push({ start, end: text.length, text: tail });
  return result;
}

function proportionalLinesForTextSlice(paragraph: DraftParagraph, slice: TextSlice): TextLine[] {
  if (paragraph.lines.length <= 1 || paragraph.text.length === 0) return paragraph.lines;
  const start = Math.min(
    paragraph.lines.length - 1,
    Math.floor((slice.start / paragraph.text.length) * paragraph.lines.length),
  );
  const end = Math.max(
    start + 1,
    Math.min(paragraph.lines.length, Math.ceil((slice.end / paragraph.text.length) * paragraph.lines.length)),
  );
  return paragraph.lines.slice(start, end);
}

function buildParagraphsWithMode(pages: PageData[], recoverImplicitBreaks: boolean): DraftParagraph[] {
  const result: DraftParagraph[] = [];

  for (const page of pages) {
    const pageParagraphs = pageParagraphsFromLines(page, recoverImplicitBreaks);
    if (pageParagraphs.length === 0) continue;
    const previous = result.at(-1);
    const first = pageParagraphs[0];
    if (previous !== undefined && first !== undefined && shouldMergeAcrossPages(previous, first)) {
      previous.text = joinWrappedText(previous.text, first.text);
      previous.lines.push(...first.lines);
      pageParagraphs.shift();
    }
    result.push(...pageParagraphs);
  }

  return result
    .filter((paragraph) => normalizeText(paragraph.text).length > 0)
    .map((paragraph) => paragraph.headingKind !== "strong" && isBareStructuralHeading(paragraph.text)
      ? { ...paragraph, headingKind: "strong" }
      : paragraph);
}

function paragraphBoundariesCollapsed(paragraphs: DraftParagraph[]): boolean {
  const wordCounts = paragraphs.map((paragraph) => countWords(paragraph.text));
  const totalWords = wordCounts.reduce((total, count) => total + count, 0);
  const largestParagraphWords = Math.max(0, ...wordCounts);
  return totalWords >= COLLAPSED_PARAGRAPH_MINIMUM_WORDS
    && (paragraphs.length === 1
      || largestParagraphWords > COLLAPSED_PARAGRAPH_MAXIMUM_WORDS
      || largestParagraphWords / totalWords > COLLAPSED_PARAGRAPH_WORD_RATIO);
}

/**
 * Some text PDFs put a chapter marker, title, and body prose in one physical
 * line. Recover those boundaries only when the document contains a consecutive
 * chapter-number sequence spread across the book. A compact duplicate sequence
 * is treated as a contents list and supplies exact titles, but is never split.
 */
function recoverEmbeddedChapterHeadings(paragraphs: DraftParagraph[]): DraftParagraph[] {
  if (paragraphs.length < 3) return paragraphs;
  const offsets: number[] = [];
  let documentText = "";
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index > 0) documentText += "\n";
    offsets.push(documentText.length);
    documentText += paragraph.text;
  }

  const markerPattern = /\bchapter\s+(\p{N}{1,3}|[ivxlcdm]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:[.)]|\b)/giu;
  const markers = [...documentText.matchAll(markerPattern)].flatMap((match): EmbeddedChapterMarker[] => {
    const start = match.index;
    const token = match[1];
    if (start === undefined || token === undefined) return [];
    const order = structuralOrdinal(token);
    if (order === null) return [];
    return [{
      start,
      end: start + match[0].length,
      order,
      paragraphIndex: paragraphIndexAtOffset(offsets, paragraphs, start),
    }];
  });
  const sequences = consecutiveChapterSequences(markers);
  const bodySequence = sequences
    .filter((sequence) => sequence.length >= 3)
    .filter((sequence) => new Set(sequence.map((marker) => marker.paragraphIndex)).size === sequence.length)
    .filter((sequence) => sequence.every((marker) => paragraphs[marker.paragraphIndex]?.headingKind === null))
    .filter((sequence) => {
      const span = (sequence.at(-1)?.start ?? 0) - (sequence[0]?.start ?? 0);
      return span >= Math.max(500, documentText.length * 0.2);
    })
    .sort((left, right) => right.length - left.length
      || chapterSequenceSpan(right) - chapterSequenceSpan(left))[0];
  if (bodySequence === undefined) return paragraphs;

  const contentsSequence = sequences
    .filter((sequence) => sequence !== bodySequence)
    .filter((sequence) => sequence.length >= bodySequence.length)
    .filter((sequence) => (sequence.at(-1)?.start ?? Infinity) < (bodySequence[0]?.start ?? 0))
    .filter((sequence) => chapterSequenceSpan(sequence) <= Math.max(1_500, documentText.length * 0.05))
    .sort((left, right) => chapterSequenceSpan(left) - chapterSequenceSpan(right))[0];
  const contentsTitles = contentsSequence === undefined
    ? new Map<number, string>()
    : chapterTitlesFromContents(documentText, markers, contentsSequence, bodySequence[0]?.start ?? documentText.length);

  const ranges = bodySequence.flatMap((marker): EmbeddedChapterRange[] => {
    const expectedTitle = contentsTitles.get(marker.order);
    const titleMatch = expectedTitle === undefined
      ? null
      : headingPattern(expectedTitle).exec(documentText.slice(marker.start));
    const end = titleMatch?.index === 0 ? marker.start + titleMatch[0].length : marker.end;
    return [{
      start: marker.start,
      end,
      title: normalizeText(documentText.slice(marker.start, end)),
      startParagraphIndex: marker.paragraphIndex,
      endParagraphIndex: paragraphIndexAtOffset(offsets, paragraphs, Math.max(marker.start, end - 1)),
    }];
  });

  const result = [...paragraphs];
  for (const range of [...ranges].reverse()) {
    const startParagraph = paragraphs[range.startParagraphIndex];
    const endParagraph = paragraphs[range.endParagraphIndex];
    if (startParagraph === undefined || endParagraph === undefined) continue;
    const localStart = range.start - (offsets[range.startParagraphIndex] ?? 0);
    const localEnd = range.end - (offsets[range.endParagraphIndex] ?? 0);
    const prefix = normalizeText(startParagraph.text.slice(0, localStart))
      .replace(/(?:\s*\*){3,}\s*$/u, "")
      .trim();
    const suffix = normalizeText(endParagraph.text.slice(localEnd));
    const replacement: DraftParagraph[] = [];
    if (prefix.length > 0) replacement.push({ ...startParagraph, text: prefix });
    replacement.push({
      text: range.title,
      lines: paragraphs
        .slice(range.startParagraphIndex, range.endParagraphIndex + 1)
        .flatMap((paragraph) => paragraph.lines),
      headingKind: "strong",
    });
    if (suffix.length > 0) replacement.push({ ...endParagraph, text: suffix });
    result.splice(
      range.startParagraphIndex,
      range.endParagraphIndex - range.startParagraphIndex + 1,
      ...replacement,
    );
  }
  return result;
}

function consecutiveChapterSequences(markers: EmbeddedChapterMarker[]): EmbeddedChapterMarker[][] {
  const sequences: EmbeddedChapterMarker[][] = [];
  for (const [startIndex, first] of markers.entries()) {
    if (first.order !== 1) continue;
    const sequence = [first];
    let expected = 2;
    for (const marker of markers.slice(startIndex + 1)) {
      if (marker.order === 1) break;
      if (marker.order !== expected) continue;
      sequence.push(marker);
      expected += 1;
    }
    sequences.push(sequence);
  }
  return sequences;
}

function chapterSequenceSpan(sequence: EmbeddedChapterMarker[]): number {
  return (sequence.at(-1)?.start ?? 0) - (sequence[0]?.start ?? 0);
}

function chapterTitlesFromContents(
  documentText: string,
  allMarkers: EmbeddedChapterMarker[],
  contents: EmbeddedChapterMarker[],
  bodyStart: number,
): Map<number, string> {
  const result = new Map<number, string>();
  for (const [index, marker] of contents.entries()) {
    const next = contents[index + 1];
    const end = next?.start
      ?? allMarkers.find((candidate) => candidate.start > marker.start)?.start
      ?? bodyStart;
    const suffix = normalizeText(documentText.slice(marker.end, Math.min(end, marker.end + 160)));
    if (suffix.length === 0 || countWords(suffix) > 16 || /[.!?]\s+\p{Lu}/u.test(suffix)) continue;
    result.set(marker.order, `${normalizeText(documentText.slice(marker.start, marker.end))} ${suffix}`.trim());
  }
  return result;
}

function headingPattern(title: string): RegExp {
  const source = title
    .split(/\s+/u)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s+");
  return new RegExp(`^${source}`, "iu");
}

function paragraphIndexAtOffset(offsets: number[], paragraphs: DraftParagraph[], offset: number): number {
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    const start = offsets[index];
    const paragraph = paragraphs[index];
    if (start !== undefined && paragraph !== undefined && offset >= start) return index;
  }
  return 0;
}

function structuralOrdinal(token: string): number | null {
  const normalized = token.toLocaleLowerCase();
  if (/^\p{N}+$/u.test(normalized)) return Number(normalized);
  const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  const wordIndex = words.indexOf(normalized);
  if (wordIndex >= 0) return wordIndex + 1;
  if (!/^[ivxlcdm]+$/u.test(normalized)) return null;
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1_000 };
  let total = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const current = values[normalized[index] ?? ""] ?? 0;
    const next = values[normalized[index + 1] ?? ""] ?? 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

function pageParagraphsFromLines(page: PageData, recoverImplicitBreaks: boolean): DraftParagraph[] {
  const lines = page.lines.filter((line) => line.text.length > 0);
  if (lines.length === 0) return [];
  const bodyFontSize = weightedMedian(lines.map((line) => [line.fontSize, Math.min(line.text.length, 80)]));
  const normalLineWidths = lines.filter((line) => line.text.length >= 20).map((line) => line.xMax - line.xMin);
  const typicalWidth = median(normalLineWidths.length > 0 ? normalLineWidths : lines.map((line) => line.xMax - line.xMin));
  const normalGaps = lines.slice(1).flatMap((line, index) => {
    const previous = lines[index];
    if (previous === undefined || previous.column !== line.column || line.baseline <= previous.baseline) return [];
    return [line.baseline - previous.baseline];
  });
  const gapProfile = pageGapProfile(normalGaps, bodyFontSize);
  const paragraphs: DraftParagraph[] = [];
  let current: DraftParagraph | null = null;

  for (const [index, line] of lines.entries()) {
    const previousLine = lines[index - 1];
    const headingKind = headingKindForLine(line, page.width, bodyFontSize);
    const startNew = current === null
      || previousLine === undefined
      || headingKind !== null
      || current.headingKind !== null
      || isParagraphBreak(previousLine, line, gapProfile, typicalWidth, recoverImplicitBreaks);

    if (startNew) {
      current = { text: line.text, lines: [line], headingKind };
      paragraphs.push(current);
    } else if (current !== null) {
      current.text = joinWrappedText(current.text, line.text);
      current.lines.push(line);
    }
  }

  return mergeAdjacentHeadingParagraphs(paragraphs, gapProfile.typical);
}

function pageGapProfile(gaps: number[], bodyFontSize: number): GapProfile {
  if (gaps.length === 0) return { typical: bodyFontSize * 1.2, paragraphThreshold: null };
  const tolerance = Math.max(0.75, bodyFontSize * 0.08);
  const clusters = clusterGaps(gaps, tolerance);
  const minimumSubstantialCount = Math.max(2, Math.ceil(gaps.length * 0.1));
  const typicalCluster = clusters.find((cluster) => cluster.values.length >= minimumSubstantialCount)
    ?? [...clusters].sort((left, right) => right.values.length - left.values.length || left.center - right.center)[0];
  if (typicalCluster === undefined) return { typical: median(gaps), paragraphThreshold: null };

  const typical = median(typicalCluster.values);
  const largerCluster = clusters.find((cluster) =>
    cluster.center > typicalCluster.center
    && cluster.values.length >= minimumSubstantialCount
    && cluster.center - typical >= Math.max(1, bodyFontSize * 0.08)
    && cluster.center >= typical * 1.12,
  );
  const paragraphThreshold = largerCluster === undefined
    ? null
    : ((Math.max(...typicalCluster.values) + Math.min(...largerCluster.values)) / 2);
  return { typical, paragraphThreshold };
}

function clusterGaps(gaps: number[], tolerance: number): GapCluster[] {
  const clusters: GapCluster[] = [];
  for (const gap of [...gaps].sort((left, right) => left - right)) {
    const current = clusters.at(-1);
    if (current === undefined || gap - current.center > tolerance) {
      clusters.push({ values: [gap], center: gap });
      continue;
    }
    current.values.push(gap);
    current.center = median(current.values);
  }
  return clusters;
}

function mergeAdjacentHeadingParagraphs(paragraphs: DraftParagraph[], typicalGap: number): DraftParagraph[] {
  const merged: DraftParagraph[] = [];
  for (const paragraph of paragraphs) {
    const previous = merged.at(-1);
    const previousLine = previous?.lines.at(-1);
    const currentLine = paragraph.lines[0];
    const beginsIndependentHeading = /^(?:chapter|book|part|section|prologue|epilogue|appendix)\b|^(?:\p{N}{1,3}(?:\.\p{N}{1,3})*|[ivxlcdm]+)[.)]?\s+/iu.test(paragraph.text);
    const nearby = previousLine !== undefined && currentLine !== undefined
      && previousLine.pageNumber === currentLine.pageNumber
      && previousLine.column === currentLine.column
      && currentLine.baseline - previousLine.baseline <= typicalGap * 2.2 + 2;
    if (previous !== undefined
      && previous.headingKind !== null
      && paragraph.headingKind !== null
      && nearby
      && !beginsIndependentHeading) {
      previous.text = joinWrappedText(previous.text, paragraph.text);
      previous.lines.push(...paragraph.lines);
      if (paragraph.headingKind === "strong") previous.headingKind = "strong";
    } else {
      merged.push(paragraph);
    }
  }
  return merged;
}

function isParagraphBreak(
  previous: TextLine,
  current: TextLine,
  gapProfile: GapProfile,
  typicalWidth: number,
  recoverImplicitBreaks: boolean,
): boolean {
  if (previous.vertical || current.vertical) return true;
  if (previous.column !== current.column) return true;
  const verticalGap = current.baseline - previous.baseline;
  if (verticalGap > gapProfile.typical * 1.5 + 1) return true;
  if (/^(?:[-•‣⁃]|\p{N}{1,3}[.)])\s+/u.test(current.text)) return true;
  const previousWidth = previous.xMax - previous.xMin;
  const currentIndented = current.xMin - previous.xMin > Math.max(10, current.fontSize * 0.9);
  const previousEndsSentence = /[.!?…:”’)]$/u.test(previous.text);
  const currentStartsSentence = /^[\p{Lu}“‘\[]/u.test(current.text);
  const sentenceBoundary = previousEndsSentence && currentStartsSentence;
  if (currentIndented && previousEndsSentence) return true;
  if (gapProfile.paragraphThreshold !== null
    && verticalGap >= gapProfile.paragraphThreshold
    && sentenceBoundary) return true;
  const previousLooksLikeLastLine = previousWidth < typicalWidth * 0.72;
  if (previousLooksLikeLastLine && sentenceBoundary) return true;

  // Some generators retain explicit line endings but flatten paragraph spacing
  // completely. Only retry this signal after the primary model is already
  // collapsed, and only for aligned prose with the same text style.
  const alignedProse = Math.abs(current.xMin - previous.xMin) <= Math.max(4, current.fontSize * 0.4)
    && Math.abs(current.fontSize - previous.fontSize) <= Math.max(1, current.fontSize * 0.12);
  return recoverImplicitBreaks && previous.hasEol && alignedProse && sentenceBoundary;
}

function shouldMergeAcrossPages(previous: DraftParagraph, current: DraftParagraph): boolean {
  if (previous.headingKind !== null || current.headingKind !== null) return false;
  if (/[-\u2010\u2011]$/u.test(previous.text)) return /^\p{Ll}/u.test(current.text);
  if (/[,;:]$/u.test(previous.text)) return true;
  return !/[.!?…:”’)]$/u.test(previous.text) && /^[\p{Ll}“‘]/u.test(current.text);
}

function joinWrappedText(previous: string, current: string): string {
  const left = normalizeText(previous);
  const right = normalizeText(current);
  if (/\p{L}[-\u2010]$/u.test(left) && /^\p{Ll}/u.test(right)) return `${left.slice(0, -1)}${right}`;
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return `${left} ${right}`;
}

function headingKindForLine(line: TextLine, pageWidth: number, bodyFontSize: number): "strong" | "typographic" | null {
  const text = line.text;
  const words = countWords(text);
  if (text.length > 180 || words === 0 || words > 20 || /\.{3,}/u.test(text)) return null;
  const center = (line.xMin + line.xMax) / 2;
  const centered = Math.abs(center - pageWidth / 2) <= pageWidth * 0.12;
  const larger = line.fontSize >= bodyFontSize * 1.17;
  if (isExplicitStructuralHeading(text, larger)) return "strong";

  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  const uppercase = letters.filter((character) => character === character.toLocaleUpperCase()).length;
  const allCaps = letters.length >= 3 && uppercase / letters.length >= 0.9 && words <= 12;
  return (allCaps || (larger && (centered || words <= 10))) ? "typographic" : null;
}

/**
 * Recognize headings that are structurally convincing even when the PDF has no
 * usable outline. Requiring a chapter/part number prevents ordinary prose such
 * as "part, employees ..." from becoming a chapter merely because it begins
 * with a structural-looking word. Numbered titles need typographic emphasis so
 * footnotes and numbered list items do not become chapters.
 */
export function isExplicitStructuralHeading(text: string, emphasized: boolean): boolean {
  const normalized = normalizeText(text);
  const numberedSection = new RegExp(
    `^(?:chapter|book|part|section)\\s+${STRUCTURAL_ORDINAL_PATTERN}(.*)$`,
    "iu",
  ).exec(normalized);
  if (numberedSection !== null) {
    const suffix = normalizeText(numberedSection[1] ?? "");
    if (/^[.)]?$/u.test(suffix)) return true;
    // A title delimiter is structural evidence even when the PDF exposes no
    // useful font-size distinction. Plain trailing prose still needs visual
    // emphasis so "chapter I summarize ..." is not promoted.
    if (/^[:\-\u2013\u2014]\s*\S/u.test(suffix)) return true;
    return emphasized;
  }

  const standaloneSection = /^(?:prologue|epilogue|contents|acknowledg(?:e)?ments?|preface(?:\s+and\s+acknowledg(?:e)?ments?)?|foreword|afterword|appendix(?:\s+(?:\p{N}{1,3}|[a-z]|[ivxlcdm]{1,8}))?)(?:\s*[:.\-\u2014]\s*.*)?$/iu;
  if (standaloneSection.test(normalized)) return true;

  const emphasizedSection = /^(?:introduction|prologue|epilogue|preface|foreword|afterword|appendix)\b/iu;
  if (emphasized && emphasizedSection.test(normalized)) return true;

  return emphasized && /^(?:\p{N}{1,3}|[ivxlcdm]{1,8})[.)]?\s+\p{Lu}/u.test(normalized);
}

export function isBareStructuralHeading(text: string): boolean {
  return BARE_STRUCTURAL_HEADING.test(normalizeText(text));
}

export function buildImages(pages: PageData[], paragraphs: DraftParagraph[]): BookImage[] {
  const repeatedEdgeObjects = repeatedEdgeImageObjects(pages);
  const result: Array<{
    image: BookImage;
    pageNumber: number;
    centerX: number;
    centerY: number;
    operatorIndex: number;
  }> = [];

  for (const page of pages) {
    const candidates = page.images
      .filter((candidate) => !repeatedEdgeObjects.has(candidate.objectId))
      .sort((left, right) => left.operatorIndex - right.operatorIndex);
    for (const [imageIndex, candidate] of candidates.entries()) {
      const pageParagraphs = paragraphs
        .map((paragraph, index) => ({ paragraph, id: index + 1 }))
        .filter(({ paragraph }) => paragraph.lines.some((line) => line.pageNumber === page.pageNumber));
      const centerX = (candidate.xMin + candidate.xMax) / 2;
      const centerY = (candidate.yMin + candidate.yMax) / 2;
      const above = pageParagraphs.filter(({ paragraph }) => paragraph.lines.some((line) =>
        line.pageNumber === page.pageNumber
        && line.baseline <= centerY
        && (line.column === 0 || (centerX >= line.xMin - page.width * 0.1 && centerX <= line.xMax + page.width * 0.1)),
      ));
      let previousPageParagraph = 0;
      for (const [index, paragraph] of paragraphs.entries()) {
        if (paragraph.lines.some((line) => line.pageNumber < page.pageNumber)) previousPageParagraph = index + 1;
      }
      const afterParagraphId = above.at(-1)?.id ?? previousPageParagraph;
      const caption = page.lines
        .filter((line) => line.baseline >= candidate.yMax && line.baseline - candidate.yMax <= page.height * 0.12)
        .filter((line) => line.text.length <= 180 && isLikelyImageCaption(line.text))
        .sort((left, right) => left.baseline - right.baseline)[0]?.text;

      result.push({
        image: {
          afterParagraphId,
          alt: caption ?? `Image on PDF page ${page.pageNumber}`,
          src: `pdf://page/${page.pageNumber}/image/${imageIndex + 1}?object=${encodeURIComponent(candidate.objectId)}`,
        },
        pageNumber: page.pageNumber,
        centerX,
        centerY,
        operatorIndex: candidate.operatorIndex,
      });
    }
  }

  return result
    .sort((left, right) =>
      left.image.afterParagraphId - right.image.afterParagraphId
      || left.pageNumber - right.pageNumber
      || left.centerY - right.centerY
      || left.centerX - right.centerX
      || left.operatorIndex - right.operatorIndex,
    )
    .map((entry) => entry.image);
}

function isLikelyImageCaption(value: string): boolean {
  return /^(?:fig(?:ure)?\.?|plate|table|illustration|photo(?:graph)?|map)\s*(?:\p{N}|[:.\-–—])/iu.test(value);
}

function repeatedEdgeImageObjects(pages: PageData[]): Set<string> {
  const occurrences = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const image of page.images) {
      const atEdge = image.yMax <= page.height * 0.15 || image.yMin >= page.height * 0.85;
      if (!atEdge) continue;
      const pageNumbers = occurrences.get(image.objectId) ?? new Set<number>();
      pageNumbers.add(page.pageNumber);
      occurrences.set(image.objectId, pageNumbers);
    }
  }
  return new Set([...occurrences].filter(([, pageNumbers]) => pageNumbers.size >= 3).map(([objectId]) => objectId));
}

export function transformPoint(matrix: Matrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return 0;
  if (sorted.length % 2 === 1) return value;
  return ((sorted[middle - 1] ?? value) + value) / 2;
}

function weightedMedian(values: Array<[number, number]>): number {
  const sorted = values.filter(([, weight]) => weight > 0).sort(([left], [right]) => left - right);
  const totalWeight = sorted.reduce((total, [, weight]) => total + weight, 0);
  let accumulated = 0;
  for (const [value, weight] of sorted) {
    accumulated += weight;
    if (accumulated >= totalWeight / 2) return value;
  }
  return sorted.at(-1)?.[0] ?? 12;
}
