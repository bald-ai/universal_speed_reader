import {
  getDocument,
  GlobalWorkerOptions,
  OPS,
  VerbosityLevel,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { buildBook } from "./model.ts";
import {
  buildImages,
  buildParagraphs,
  filterRepeatedPageFurniture,
  median,
  transformPoint,
  type Matrix,
  type PageData,
  type PageImageCandidate,
  type TextLine,
} from "./pdf-content.ts";
import {
  addTextQualityDiagnostics,
  buildChapters,
  fallbackMetadata,
  metadataFromPdf,
  type ResolvedOutlineItem,
} from "./pdf-structure.ts";
import { countWords, errorMessage, normalizeText } from "./text.ts";
import type {
  ParseOptions,
  ParserDiagnostic,
  ParserOutput,
  ParserTimings,
} from "./types.ts";

const ABSOLUTE_TIMEOUT_MS = 30_000;
const MAX_OUTLINE_ITEMS = 500;
const MIN_IMAGE_PIXELS = 4_096;
const MIN_IMAGE_DIMENSION = 24;
const QUARTER_TURN_TOLERANCE_RADIANS = 8 * Math.PI / 180;
const MIN_QUARTER_TURN_ITEMS = 20;
const MIN_QUARTER_TURN_CHARACTERS = 120;
const MIN_QUARTER_TURN_CHARACTER_RATIO = 0.8;
const PDF_WORKER_URL = typeof window === "undefined"
  ? new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString()
  : new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();

interface PositionedText {
  text: string;
  xMin: number;
  xMax: number;
  baseline: number;
  fontSize: number;
  direction: string;
  hasEol: boolean;
  sourceIndex: number;
  vertical: boolean;
  angleRadians: number;
}

interface PageOrientationSample {
  angleRadians: number;
  direction: string;
  readableCharacters: number;
}

type QuarterTurnRotation = 90 | 270;

interface FlatOutlineItem {
  title: string;
  destination: string | unknown[];
}


interface ExtractedPage {
  data: PageData;
  textError: string | null;
  imageError: string | null;
}

class PdfDeadlineError extends Error {
  constructor(readonly timeoutMs: number, readonly pendingOperation: Promise<unknown>) {
    super(`PDF parsing exceeded ${timeoutMs} ms`);
    this.name = "PdfDeadlineError";
  }
}

/** Parse a selectable-text PDF into the app-owned logical reading model. */
export async function parsePdf(options: ParseOptions): Promise<ParserOutput> {
  const sourceName = options.sourceName.trim();
  if (sourceName.length === 0) throw new Error("A PDF filename is required");
  if (options.signal?.aborted) throw new Error("PDF import was cancelled");
  await options.onPhaseChange?.("extracting_metadata");

  const startedAt = performance.now();
  const timeoutMs = normalizedTimeout(options.timeoutMs);
  const deadline = startedAt + timeoutMs;
  const timings: ParserTimings = { totalMs: 0 };
  const diagnostics: ParserDiagnostic[] = [];
  const pages: PageData[] = [];
  let metadata = fallbackMetadata(sourceName);
  let outlineItems: ResolvedOutlineItem[] = [];
  let outlineItemCount = 0;
  let totalPageCount = 0;
  let loadingTask: PDFDocumentLoadingTask | null = null;
  let timedOut = false;
  let timedOutOperation: Promise<unknown> | null = null;
  let textFailureCount = 0;
  let imageFailureCount = 0;
  const textFailurePages: number[] = [];
  const imageFailurePages: number[] = [];

  try {
    const data = new Uint8Array(options.sourceBytes);
    GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    loadingTask = getDocument({
      data,
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      maxImageSize: 20_000_000,
      stopAtErrors: false,
      useWorkerFetch: false,
      verbosity: VerbosityLevel.ERRORS,
    });
    const document = await beforeDeadline(loadingTask.promise, deadline, timeoutMs);
    totalPageCount = document.numPages;
    timings.openMs = roundedMs(performance.now() - startedAt);

    const structureStartedAt = performance.now();
    const [metadataResult, outlineResult] = await beforeDeadline(
      Promise.allSettled([document.getMetadata(), document.getOutline()]),
      deadline,
      timeoutMs,
    );

    if (metadataResult.status === "fulfilled") {
      metadata = metadataFromPdf(metadataResult.value, document, sourceName);
    } else {
      diagnostics.push({
        bucket: "Other",
        severity: "warning",
        message: `PDF metadata could not be read: ${errorMessage(metadataResult.reason)}`,
      });
    }

    if (outlineResult.status === "fulfilled") {
      const flatOutline = flattenOutline(outlineResult.value);
      outlineItemCount = flatOutline.length;
      outlineItems = await resolveOutlineItems(document, flatOutline, deadline, timeoutMs);
      if (flatOutline.length > MAX_OUTLINE_ITEMS) {
        diagnostics.push({
          bucket: "Weak / missing / nonsense chapters",
          severity: "warning",
          message: `PDF outline has ${flatOutline.length} entries; only the first ${MAX_OUTLINE_ITEMS} were evaluated`,
          details: { outlineItems: flatOutline.length, evaluatedItems: MAX_OUTLINE_ITEMS },
        });
      }
    } else {
      diagnostics.push({
        bucket: "Weak / missing / nonsense chapters",
        severity: "warning",
        message: `PDF outline could not be read: ${errorMessage(outlineResult.reason)}`,
      });
    }
    timings.structureMs = roundedMs(performance.now() - structureStartedAt);

    await options.onPhaseChange?.("extracting_text");
    const contentStartedAt = performance.now();
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const extracted = await extractPage(document, pageNumber, deadline, timeoutMs);
      pages.push(extracted.data);
      if (extracted.textError !== null) {
        textFailureCount += 1;
        textFailurePages.push(pageNumber);
      }
      if (extracted.imageError !== null) {
        imageFailureCount += 1;
        imageFailurePages.push(pageNumber);
      }
    }
    timings.contentMs = roundedMs(performance.now() - contentStartedAt);
  } catch (error) {
    if (!(error instanceof PdfDeadlineError)) throw error;
    timedOut = true;
    timedOutOperation = error.pendingOperation;
    diagnostics.push({
      bucket: "Timeout / extreme slowness",
      severity: "failure",
      message: `PDF parsing exceeded the ${timeoutMs} ms limit`,
      details: { timeoutMs, completedPages: pages.length, totalPages: totalPageCount },
    });
  } finally {
    if (loadingTask !== null) {
      if (timedOut && timedOutOperation !== null) {
        const task = loadingTask;
        void timedOutOperation
          .catch(() => undefined)
          .then(() => task.destroy())
          .catch(() => undefined);
      } else {
        await loadingTask.destroy().catch(() => undefined);
      }
    }
  }

  if (textFailureCount > 0) {
    diagnostics.push({
      bucket: "No / unusable text",
      severity: "failure",
      message: `Text extraction failed on ${textFailureCount} PDF page${textFailureCount === 1 ? "" : "s"}`,
      details: { failedPages: compactPageList(textFailurePages), failedPageCount: textFailureCount },
    });
  }
  if (imageFailureCount > 0) {
    diagnostics.push({
      bucket: "Images missing / blank / badly placed",
      severity: "failure",
      message: `Image operators could not be inspected on ${imageFailureCount} PDF page${imageFailureCount === 1 ? "" : "s"}`,
      details: { failedPages: compactPageList(imageFailurePages), failedPageCount: imageFailureCount },
    });
  }

  await options.onPhaseChange?.("building_chapters");
  filterRepeatedPageFurniture(pages);
  const paragraphs = buildParagraphs(pages);
  const images = buildImages(pages, paragraphs);
  const chapters = buildChapters(pages, paragraphs, outlineItems, metadata, diagnostics, outlineItemCount);
  addTextQualityDiagnostics(pages, paragraphs, diagnostics, totalPageCount);

  const declaredImageCount = pages.reduce((total, page) => total + page.declaredImageCount, 0);
  const positionableImageCount = pages.reduce((total, page) => total + page.images.length, 0);
  if (declaredImageCount > 0 && positionableImageCount === 0) {
    diagnostics.push({
      bucket: "Images missing / blank / badly placed",
      severity: "failure",
      message: "PDF contains meaningful image operators, but none could be placed in reading order",
      details: { declaredImageCount },
    });
  }

  const book = buildBook({
    format: "pdf",
    metadata,
    paragraphs: paragraphs.map((paragraph, index) => ({
      id: index + 1,
      text: paragraph.text,
      ...(paragraph.sceneBreakBefore ? { sceneBreakBefore: paragraph.sceneBreakBefore } : {}),
    })),
    chapters,
    images,
    cover: totalPageCount > 0 ? { src: pdfPagePointer(1), mediaType: "application/pdf" } : null,
    diagnostics,
    timings,
  });
  timings.totalMs = roundedMs(performance.now() - startedAt);

  return {
    book,
    internals: {
      sourceDocumentCount: 1,
      textPageCount: pages.filter((page) => page.lines.some((line) => countWords(line.text) > 0)).length,
      totalPageCount,
      declaredImageCount,
      extractedImageCount: images.length,
    },
  };
}

async function extractPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  deadline: number,
  timeoutMs: number,
): Promise<ExtractedPage> {
  const page = await beforeDeadline(document.getPage(pageNumber), deadline, timeoutMs);
  const defaultViewport = page.getViewport({ scale: 1 });
  const defaultViewportTransform = asMatrix(defaultViewport.transform)
    ?? [1, 0, 0, -1, 0, defaultViewport.height];

  try {
    const [textResult, operatorResult] = await beforeDeadline(
      Promise.allSettled([
        page.getTextContent({ disableNormalization: false, includeMarkedContent: false }),
        page.getOperatorList(),
      ]),
      deadline,
      timeoutMs,
    );

    const defaultPositioned = textResult.status === "fulfilled"
      ? positionedTextItems(textResult.value.items, defaultViewportTransform)
      : [];
    const quarterTurn = dominantQuarterTurnRotation(defaultPositioned.map(orientationSample));
    const viewport = quarterTurn === null
      ? defaultViewport
      : page.getViewport({ scale: 1, rotation: normalizedPdfRotation(page.rotate + quarterTurn) });
    const viewportTransform = quarterTurn === null
      ? defaultViewportTransform
      : asMatrix(viewport.transform) ?? defaultViewportTransform;
    const positioned = quarterTurn === null || textResult.status !== "fulfilled"
      ? defaultPositioned
      : positionedTextItems(textResult.value.items, viewportTransform);
    const lines = orderPageLines(
      clusterTextLines(positioned, pageNumber),
      viewport.width,
      quarterTurn === null,
    );
    const imageExtraction = operatorResult.status === "fulfilled"
      ? extractImageCandidates(pageNumber, viewport.width, viewport.height, viewportTransform, operatorResult.value)
      : { candidates: [], declaredImageCount: 0 };

    return {
      data: {
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        viewportTransform,
        lines,
        images: imageExtraction.candidates,
        declaredImageCount: imageExtraction.declaredImageCount,
        rawTextCharacters: positioned.reduce((total, item) => total + item.text.length, 0),
        verticalItemCount: positioned.filter((item) => item.vertical).length,
        textItemCount: positioned.length,
      },
      textError: textResult.status === "rejected" ? errorMessage(textResult.reason) : null,
      imageError: operatorResult.status === "rejected" ? errorMessage(operatorResult.reason) : null,
    };
  } finally {
    page.cleanup();
  }
}

function positionedTextItems(items: readonly unknown[], viewportTransform: Matrix): PositionedText[] {
  const result: PositionedText[] = [];

  for (const [sourceIndex, item] of items.entries()) {
    if (!isRecord(item) || typeof item.str !== "string") continue;
    const text = item.str.replace(/\u0000/gu, "");
    if (normalizeText(text).length === 0) continue;
    const itemTransform = asMatrix(item.transform);
    if (itemTransform === null) continue;
    const transformed = multiplyMatrices(viewportTransform, itemTransform);
    const angle = Math.atan2(transformed[1], transformed[0]);
    const width = finiteNumber(item.width) ?? Math.max(text.length, 1) * 4;
    const fontSize = Math.max(1, Math.hypot(transformed[2], transformed[3]));
    const endX = transformed[4] + Math.cos(angle) * width;
    const vertical = Math.abs(Math.sin(angle)) > 0.65 || item.dir === "ttb";

    result.push({
      text,
      xMin: Math.min(transformed[4], endX),
      xMax: Math.max(transformed[4], endX),
      baseline: transformed[5],
      fontSize,
      direction: typeof item.dir === "string" ? item.dir : "ltr",
      hasEol: item.hasEOL === true,
      sourceIndex,
      vertical,
      angleRadians: angle,
    });
  }

  return result;
}

function orientationSample(item: PositionedText): PageOrientationSample {
  return {
    angleRadians: item.angleRadians,
    direction: item.direction,
    readableCharacters: readableCharacterCount(item.text),
  };
}

function dominantQuarterTurnRotation(samples: readonly PageOrientationSample[]): QuarterTurnRotation | null {
  let totalCharacters = 0;
  const rotations = new Map<QuarterTurnRotation, { characters: number; items: number }>([
    [90, { characters: 0, items: 0 }],
    [270, { characters: 0, items: 0 }],
  ]);

  for (const sample of samples) {
    const readableCharacters = Math.max(0, Math.floor(sample.readableCharacters));
    totalCharacters += readableCharacters;
    if (sample.direction !== "ltr" && sample.direction !== "rtl") continue;

    const rotation = angularDistance(sample.angleRadians, -Math.PI / 2) <= QUARTER_TURN_TOLERANCE_RADIANS
      ? 90
      : angularDistance(sample.angleRadians, Math.PI / 2) <= QUARTER_TURN_TOLERANCE_RADIANS
        ? 270
        : null;
    if (rotation === null) continue;
    const totals = rotations.get(rotation)!;
    totals.characters += readableCharacters;
    totals.items += 1;
  }

  const dominant = [...rotations.entries()].sort((left, right) =>
    right[1].characters - left[1].characters || right[1].items - left[1].items,
  )[0];
  if (dominant === undefined) return null;
  const [rotation, totals] = dominant;
  if (totals.items < MIN_QUARTER_TURN_ITEMS
    || totals.characters < MIN_QUARTER_TURN_CHARACTERS
    || totals.characters / Math.max(totalCharacters, 1) < MIN_QUARTER_TURN_CHARACTER_RATIO) {
    return null;
  }
  return rotation;
}

function readableCharacterCount(value: string): number {
  return [...normalizeText(value)].filter((character) => !/\s/u.test(character)).length;
}

function angularDistance(left: number, right: number): number {
  return Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
}

function clusterTextLines(items: PositionedText[], pageNumber: number): TextLine[] {
  const horizontal = items.filter((item) => !item.vertical).sort((left, right) =>
    left.baseline - right.baseline || left.xMin - right.xMin || left.sourceIndex - right.sourceIndex,
  );
  const groups: PositionedText[][] = [];

  for (const item of horizontal) {
    const previous = groups.at(-1);
    const previousBaseline = previous === undefined ? Number.NaN : median(previous.map((entry) => entry.baseline));
    const previousSize = previous === undefined ? item.fontSize : median(previous.map((entry) => entry.fontSize));
    if (previous === undefined || Math.abs(item.baseline - previousBaseline) > Math.max(2, Math.min(item.fontSize, previousSize) * 0.38)) {
      groups.push([item]);
    } else {
      previous.push(item);
    }
  }

  const lines = groups.flatMap((group): TextLine[] => {
    const rtl = group.filter((item) => item.direction === "rtl").length > group.length / 2;
    group.sort((left, right) => rtl ? right.xMin - left.xMin : left.xMin - right.xMin);
    const runs: PositionedText[][] = [];
    for (const item of group) {
      const previous = runs.at(-1)?.at(-1);
      const gap = previous === undefined ? 0 : rtl ? previous.xMin - item.xMax : item.xMin - previous.xMax;
      const columnGap = previous !== undefined && gap > Math.max(24, Math.min(previous.fontSize, item.fontSize) * 4);
      if (previous === undefined || columnGap) runs.push([item]);
      else runs.at(-1)!.push(item);
    }
    return runs.flatMap((run): TextLine[] => {
      const text = joinTextItems(run, rtl);
      if (text.length === 0) return [];
      return [{
        text,
        xMin: Math.min(...run.map((item) => item.xMin)),
        xMax: Math.max(...run.map((item) => item.xMax)),
        baseline: median(run.map((item) => item.baseline)),
        fontSize: median(run.map((item) => item.fontSize)),
        pageNumber,
        column: 0,
        hasEol: run.some((item) => item.hasEol),
        vertical: false,
        order: 0,
      }];
    });
  });

  // Preserve selectable vertical text instead of silently dropping it. It is
  // diagnosed later because reliable vertical-book reconstruction is not yet supported.
  for (const item of items.filter((entry) => entry.vertical).sort((left, right) => left.sourceIndex - right.sourceIndex)) {
    lines.push({
      text: normalizeText(item.text),
      xMin: item.xMin,
      xMax: item.xMax,
      baseline: item.baseline,
      fontSize: item.fontSize,
      pageNumber,
      column: 0,
      hasEol: item.hasEol,
      vertical: true,
      order: 0,
    });
  }

  return lines;
}

function joinTextItems(items: PositionedText[], rtl: boolean): string {
  let result = "";
  let previous: PositionedText | null = null;

  for (const item of items) {
    const current = normalizeText(item.text);
    if (current.length === 0) continue;
    if (previous !== null) {
      const previousText = normalizeText(previous.text);
      const gap = rtl ? previous.xMin - item.xMax : item.xMin - previous.xMax;
      const explicitWhitespace = /\s$/u.test(previous.text) || /^\s/u.test(item.text);
      const punctuationJoin = /^[,.;:!?%)\]}’”]/u.test(current) || /[(\[{‘“]$/u.test(previousText);
      if (!punctuationJoin && (explicitWhitespace || gap > Math.max(0.8, Math.min(previous.fontSize, item.fontSize) * 0.12))) {
        result += " ";
      }
    }
    result += current;
    previous = item;
  }

  return normalizeText(result);
}

function orderPageLines(lines: TextLine[], pageWidth: number, allowTwoColumn = true): TextLine[] {
  if (!allowTwoColumn) {
    return lines
      .sort((left, right) => Number(left.vertical) - Number(right.vertical)
        || (left.vertical && right.vertical
          ? left.order - right.order
          : left.baseline - right.baseline || left.xMin - right.xMin))
      .map((line, order) => ({ ...line, column: 0, order }));
  }

  if (lines.length < 6 || lines.some((line) => line.vertical)) {
    return lines
      .sort((left, right) => left.vertical || right.vertical
        ? left.order - right.order
        : left.baseline - right.baseline || left.xMin - right.xMin)
      .map((line, order) => ({ ...line, order }));
  }

  const midpoint = pageWidth / 2;
  const gutter = pageWidth * 0.025;
  const left = lines.filter((line) => line.xMax < midpoint + gutter);
  const right = lines.filter((line) => line.xMin > midpoint - gutter);
  const spanning = lines.filter((line) => !left.includes(line) && !right.includes(line));
  const isTwoColumn = left.length >= 3 && right.length >= 3 && spanning.length <= lines.length * 0.3;

  if (!isTwoColumn) {
    return lines
      .sort((first, second) => first.baseline - second.baseline || first.xMin - second.xMin)
      .map((line, order) => ({ ...line, column: 0, order }));
  }

  const ordered: TextLine[] = [];
  const sortedSpanning = spanning.sort((first, second) => first.baseline - second.baseline);
  let previousBoundary = Number.NEGATIVE_INFINITY;
  for (const boundary of [...sortedSpanning, null]) {
    const nextBoundary = boundary?.baseline ?? Number.POSITIVE_INFINITY;
    ordered.push(...left
      .filter((line) => line.baseline > previousBoundary && line.baseline < nextBoundary)
      .sort((first, second) => first.baseline - second.baseline)
      .map((line) => ({ ...line, column: 1 })));
    ordered.push(...right
      .filter((line) => line.baseline > previousBoundary && line.baseline < nextBoundary)
      .sort((first, second) => first.baseline - second.baseline)
      .map((line) => ({ ...line, column: 2 })));
    if (boundary !== null) ordered.push({ ...boundary, column: 0 });
    previousBoundary = nextBoundary;
  }

  return ordered.map((line, order) => ({ ...line, order }));
}

function extractImageCandidates(
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  viewportTransform: Matrix,
  operatorList: { fnArray: readonly number[]; argsArray: readonly unknown[] },
): { candidates: PageImageCandidate[]; declaredImageCount: number } {
  const candidates: PageImageCandidate[] = [];
  const stack: Matrix[] = [];
  let current: Matrix = [1, 0, 0, 1, 0, 0];
  let declaredImageCount = 0;

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (operation === OPS.save) {
      stack.push([...current]);
      continue;
    }
    if (operation === OPS.restore) {
      current = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (operation === OPS.transform) {
      const transform = asMatrix(args);
      if (transform !== null) current = multiplyMatrices(current, transform);
      continue;
    }
    if (operation === OPS.paintFormXObjectBegin) {
      stack.push([...current]);
      const formMatrix = Array.isArray(args) ? asMatrix(args[0]) : null;
      if (formMatrix !== null) current = multiplyMatrices(current, formMatrix);
      continue;
    }
    if (operation === OPS.paintFormXObjectEnd) {
      current = stack.pop() ?? current;
      continue;
    }
    if (operation === OPS.beginGroup) {
      stack.push([...current]);
      const group = Array.isArray(args) && isRecord(args[0]) ? args[0] : null;
      const groupMatrix = group === null ? null : asMatrix(group.matrix);
      if (groupMatrix !== null) current = multiplyMatrices(current, groupMatrix);
      continue;
    }
    if (operation === OPS.endGroup) {
      current = stack.pop() ?? current;
      continue;
    }
    if (operation !== OPS.paintImageXObject && operation !== OPS.paintInlineImageXObject) continue;

    const imageArgs = Array.isArray(args) ? args : [];
    const inlineData = operation === OPS.paintInlineImageXObject && isRecord(imageArgs[0]) ? imageArgs[0] : null;
    const objectId = operation === OPS.paintImageXObject && typeof imageArgs[0] === "string"
      ? imageArgs[0]
      : `inline-${index}`;
    const rawWidth = finiteNumber(operation === OPS.paintImageXObject ? imageArgs[1] : inlineData?.width) ?? 0;
    const rawHeight = finiteNumber(operation === OPS.paintImageXObject ? imageArgs[2] : inlineData?.height) ?? 0;
    if (rawWidth < MIN_IMAGE_DIMENSION || rawHeight < MIN_IMAGE_DIMENSION || rawWidth * rawHeight < MIN_IMAGE_PIXELS) continue;

    declaredImageCount += 1;
    const displayMatrix = multiplyMatrices(viewportTransform, current);
    const corners = [
      transformPoint(displayMatrix, 0, 0),
      transformPoint(displayMatrix, 1, 0),
      transformPoint(displayMatrix, 0, 1),
      transformPoint(displayMatrix, 1, 1),
    ];
    const xValues = corners.map(([x]) => x);
    const yValues = corners.map(([, y]) => y);
    const xMin = Math.min(...xValues);
    const xMax = Math.max(...xValues);
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);
    const displayWidth = xMax - xMin;
    const displayHeight = yMax - yMin;
    const pageArea = Math.max(pageWidth * pageHeight, 1);
    const visibleAreaRatio = Math.max(displayWidth, 0) * Math.max(displayHeight, 0) / pageArea;
    if (visibleAreaRatio < 0.001 || displayWidth < 8 || displayHeight < 8) continue;
    if (xMax < 0 || yMax < 0 || xMin > pageWidth || yMin > pageHeight) continue;

    candidates.push({
      pageNumber,
      objectId,
      operatorIndex: index,
      xMin,
      xMax,
      yMin,
      yMax,
      rawWidth,
      rawHeight,
    });
  }

  return { candidates, declaredImageCount };
}

function flattenOutline(value: unknown): FlatOutlineItem[] {
  if (!Array.isArray(value)) return [];
  const result: FlatOutlineItem[] = [];
  const visit = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (!isRecord(item)) continue;
      const title = typeof item.title === "string" ? normalizeText(item.title) : "";
      const destination = typeof item.dest === "string" || Array.isArray(item.dest) ? item.dest : null;
      if (isUsefulOutlineTitle(title) && title.length <= 240 && destination !== null) result.push({ title, destination });
      if (Array.isArray(item.items)) visit(item.items);
    }
  };
  visit(value);
  return result;
}

function isUsefulOutlineTitle(title: string): boolean {
  if (title.length === 0) return false;
  // Word/Office exports sometimes expose internal named-link bookmarks as the
  // entire outline. They are navigation implementation details, not chapters.
  return !/^_?(?:hlk|toc)\d+$/iu.test(title) && !/^ole_link\d+$/iu.test(title);
}

export const PDF_TESTABLES = { dominantQuarterTurnRotation, isUsefulOutlineTitle };

async function resolveOutlineItems(
  document: PDFDocumentProxy,
  items: FlatOutlineItem[],
  deadline: number,
  timeoutMs: number,
): Promise<ResolvedOutlineItem[]> {
  const result: ResolvedOutlineItem[] = [];
  const destinationCache = new Map<string, unknown[] | null>();
  const pageCache = new Map<string, number | null>();

  for (const item of items.slice(0, MAX_OUTLINE_ITEMS)) {
    let destination: unknown[] | null;
    if (typeof item.destination === "string") {
      if (!destinationCache.has(item.destination)) {
        try {
          destinationCache.set(
            item.destination,
            await beforeDeadline(document.getDestination(item.destination), deadline, timeoutMs),
          );
        } catch (error) {
          if (error instanceof PdfDeadlineError) throw error;
          destinationCache.set(item.destination, null);
        }
      }
      destination = destinationCache.get(item.destination) ?? null;
    } else {
      destination = item.destination;
    }
    if (destination === null || destination.length === 0) continue;
    const pageTarget = destination[0];
    let pageIndex: number | null = null;
    if (Number.isInteger(pageTarget)) {
      pageIndex = pageTarget as number;
    } else if (isPdfReference(pageTarget)) {
      const key = `${pageTarget.num}:${pageTarget.gen}`;
      if (!pageCache.has(key)) {
        try {
          pageCache.set(key, await beforeDeadline(document.getPageIndex(pageTarget), deadline, timeoutMs));
        } catch (error) {
          if (error instanceof PdfDeadlineError) throw error;
          pageCache.set(key, null);
        }
      }
      pageIndex = pageCache.get(key) ?? null;
    }
    if (pageIndex === null || pageIndex < 0 || pageIndex >= document.numPages) continue;
    result.push({ title: item.title, pageIndex, targetY: outlineTargetY(destination) });
  }

  return result;
}

function outlineTargetY(destination: unknown[]): number | null {
  const mode = isRecord(destination[1]) && typeof destination[1].name === "string" ? destination[1].name : "";
  const index = mode === "XYZ" ? 3 : mode === "FitH" || mode === "FitBH" ? 2 : mode === "FitR" ? 5 : -1;
  return index < 0 ? null : finiteNumber(destination[index]);
}

function isPdfReference(value: unknown): value is { num: number; gen: number } {
  return isRecord(value) && Number.isInteger(value.num) && Number.isInteger(value.gen);
}

function pdfPagePointer(pageNumber: number): string {
  return `pdf://page/${pageNumber}`;
}


function normalizedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return ABSOLUTE_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(value), ABSOLUTE_TIMEOUT_MS));
}

function normalizedPdfRotation(value: number): number {
  return (value % 360 + 360) % 360;
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, timeoutMs: number): Promise<T> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) throw new PdfDeadlineError(timeoutMs, promise);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PdfDeadlineError(timeoutMs, promise)), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function asMatrix(value: unknown): Matrix | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const entries = Array.from(value as ArrayLike<unknown>).slice(0, 6).map(finiteNumber);
  if (entries.length !== 6 || entries.some((entry) => entry === null)) return null;
  return entries as Matrix;
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function roundedMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function compactPageList(pages: number[]): string {
  const shown = pages.slice(0, 20).join(", ");
  return pages.length > 20 ? `${shown}, …` : shown;
}
