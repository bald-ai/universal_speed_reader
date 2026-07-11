import { readFile } from "node:fs/promises";

import {
  getDocument,
  VerbosityLevel,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { countWords, errorMessage, normalizeText } from "./text.ts";

const MIN_WORDS = 20;
const MIN_CHARACTERS = 80;
const LONG_DOCUMENT_PAGE_THRESHOLD = 4;
const MIN_TEXT_PAGE_RATIO = 0.25;
const MIN_WORDS_PER_DOCUMENT_PAGE = 20;
export const DEFAULT_PDF_SCOPE_TIMEOUT_MS = 10_000;

export interface PdfTextScopeMetrics {
  totalPageCount: number;
  pagesScreened: number;
  textPageCount: number;
  words: number;
  characters: number;
}

export type PdfTextScopeStatus = "in-scope" | "out-of-scope" | "indeterminate";

export interface PdfTextScopeScreening extends PdfTextScopeMetrics {
  schemaVersion: 1;
  status: PdfTextScopeStatus;
  screenedAt: string;
  elapsedMs: number;
  reason?: string;
  error?: string;
}

export interface PdfTextScopeClassification {
  status: "in-scope" | "out-of-scope";
  reason?: string;
}

/** Keep this deliberately identical to the parser's strict text-viability rule. */
export function classifyPdfTextScope(metrics: PdfTextScopeMetrics): PdfTextScopeClassification {
  if (metrics.words < MIN_WORDS || metrics.characters < MIN_CHARACTERS) {
    return {
      status: "out-of-scope",
      reason: `Below the selectable-text minimum (${metrics.words}/${MIN_WORDS} words, ${metrics.characters}/${MIN_CHARACTERS} characters)`,
    };
  }
  if (metrics.totalPageCount >= LONG_DOCUMENT_PAGE_THRESHOLD
    && metrics.textPageCount / metrics.totalPageCount < MIN_TEXT_PAGE_RATIO
    && metrics.words / metrics.totalPageCount < MIN_WORDS_PER_DOCUMENT_PAGE) {
    return {
      status: "out-of-scope",
      reason: `Sparse selectable text (${metrics.textPageCount}/${metrics.totalPageCount} text pages, ${rounded(metrics.words / metrics.totalPageCount)} words per page)`,
    };
  }
  return { status: "in-scope" };
}

/**
 * Lightweight scope gate: text content only, with no image decoding or model
 * reconstruction. Errors and timeouts are indeterminate so they remain in the
 * corpus for the real parser to classify rather than being selection-biased out.
 */
export async function screenPdfTextScope(
  sourcePath: string,
  timeoutMs = DEFAULT_PDF_SCOPE_TIMEOUT_MS,
): Promise<PdfTextScopeScreening> {
  const startedAt = performance.now();
  const deadline = startedAt + Math.max(1, Math.floor(timeoutMs));
  const metrics: PdfTextScopeMetrics = {
    totalPageCount: 0,
    pagesScreened: 0,
    textPageCount: 0,
    words: 0,
    characters: 0,
  };
  let loadingTask: PDFDocumentLoadingTask | null = null;
  let timedOutOperation: Promise<unknown> | null = null;

  try {
    const bytes = Uint8Array.from(await beforeDeadline(readFile(sourcePath), deadline, timeoutMs));
    loadingTask = getDocument({
      data: bytes,
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
      stopAtErrors: false,
      useWorkerFetch: false,
      verbosity: VerbosityLevel.ERRORS,
    });
    const document = await beforeDeadline(loadingTask.promise, deadline, timeoutMs);
    metrics.totalPageCount = document.numPages;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await beforeDeadline(document.getPage(pageNumber), deadline, timeoutMs);
      try {
        const content = await beforeDeadline(
          page.getTextContent({ disableNormalization: false, includeMarkedContent: false }),
          deadline,
          timeoutMs,
        );
        const text = normalizeText(content.items.flatMap((item) =>
          "str" in item && typeof item.str === "string" ? [item.str] : [],
        ).join(" "));
        const pageWords = countWords(text);
        metrics.pagesScreened = pageNumber;
        metrics.words += pageWords;
        metrics.characters += text.length;
        if (pageWords > 0) metrics.textPageCount += 1;
        if (isProvablyInScope(metrics)) return screeningResult("in-scope", metrics, startedAt);
      } finally {
        page.cleanup();
      }
    }

    const classification = classifyPdfTextScope(metrics);
    return screeningResult(classification.status, metrics, startedAt, classification.reason);
  } catch (error) {
    if (error instanceof PdfScopeDeadlineError) timedOutOperation = error.pendingOperation;
    return {
      ...screeningResult("indeterminate", metrics, startedAt),
      error: errorMessage(error),
    };
  } finally {
    if (loadingTask !== null) {
      if (timedOutOperation !== null) {
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
}

function isProvablyInScope(metrics: PdfTextScopeMetrics): boolean {
  if (metrics.words < MIN_WORDS || metrics.characters < MIN_CHARACTERS) return false;
  if (metrics.totalPageCount < LONG_DOCUMENT_PAGE_THRESHOLD) return true;
  return metrics.textPageCount / metrics.totalPageCount >= MIN_TEXT_PAGE_RATIO
    || metrics.words / metrics.totalPageCount >= MIN_WORDS_PER_DOCUMENT_PAGE;
}

function screeningResult(
  status: PdfTextScopeStatus,
  metrics: PdfTextScopeMetrics,
  startedAt: number,
  reason?: string,
): PdfTextScopeScreening {
  return {
    schemaVersion: 1,
    status,
    screenedAt: new Date().toISOString(),
    elapsedMs: rounded(performance.now() - startedAt),
    ...metrics,
    ...(reason === undefined ? {} : { reason }),
  };
}

class PdfScopeDeadlineError extends Error {
  constructor(readonly timeoutMs: number, readonly pendingOperation: Promise<unknown>) {
    super(`PDF scope screening exceeded ${timeoutMs} ms`);
    this.name = "PdfScopeDeadlineError";
  }
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, timeoutMs: number): Promise<T> {
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) throw new PdfScopeDeadlineError(timeoutMs, promise);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PdfScopeDeadlineError(timeoutMs, promise)), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}
