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
  const result: DraftParagraph[] = [];

  for (const page of pages) {
    const pageParagraphs = pageParagraphsFromLines(page);
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

function pageParagraphsFromLines(page: PageData): DraftParagraph[] {
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
  const typicalGap = median(normalGaps.length > 0 ? normalGaps : [bodyFontSize * 1.2]);
  const paragraphs: DraftParagraph[] = [];
  let current: DraftParagraph | null = null;

  for (const [index, line] of lines.entries()) {
    const previousLine = lines[index - 1];
    const headingKind = headingKindForLine(line, page.width, bodyFontSize);
    const startNew = current === null
      || previousLine === undefined
      || headingKind !== null
      || current.headingKind !== null
      || isParagraphBreak(previousLine, line, typicalGap, typicalWidth);

    if (startNew) {
      current = { text: line.text, lines: [line], headingKind };
      paragraphs.push(current);
    } else if (current !== null) {
      current.text = joinWrappedText(current.text, line.text);
      current.lines.push(line);
    }
  }

  return mergeAdjacentHeadingParagraphs(paragraphs, typicalGap);
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

function isParagraphBreak(previous: TextLine, current: TextLine, typicalGap: number, typicalWidth: number): boolean {
  if (previous.vertical || current.vertical) return true;
  if (previous.column !== current.column) return true;
  const verticalGap = current.baseline - previous.baseline;
  if (verticalGap > typicalGap * 1.5 + 1) return true;
  if (/^(?:[-•‣⁃]|\p{N}{1,3}[.)])\s+/u.test(current.text)) return true;
  const previousWidth = previous.xMax - previous.xMin;
  const currentIndented = current.xMin - previous.xMin > Math.max(10, current.fontSize * 0.9);
  if (currentIndented && /[.!?…:;”’)]$/u.test(previous.text)) return true;
  const previousLooksLikeLastLine = previousWidth < typicalWidth * 0.72;
  const currentStartsSentence = /^[\p{Lu}“‘\[]/u.test(current.text);
  return previousLooksLikeLastLine && currentStartsSentence && /[.!?…:”’)]$/u.test(previous.text);
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
          // Keep media pointer-based. Crop geometry lets the reader render only
          // the detected illustration from the original PDF on demand.
          src: `pdf://page/${page.pageNumber}/image/${imageIndex + 1}?object=${encodeURIComponent(candidate.objectId)}&x=${candidate.xMin.toFixed(3)}&y=${candidate.yMin.toFixed(3)}&width=${(candidate.xMax - candidate.xMin).toFixed(3)}&height=${(candidate.yMax - candidate.yMin).toFixed(3)}&pageWidth=${page.width.toFixed(3)}`,
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
