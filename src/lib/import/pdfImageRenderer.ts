import { loadRawBook } from "@/lib/import/rawEpubStore";

type PdfDocument = {
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
};

type PdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
};

type PdfRuntime = {
  getDocument(options: { data: Uint8Array; isImageDecoderSupported: boolean; isOffscreenCanvasSupported: boolean; useWorkerFetch: boolean }): { promise: Promise<PdfDocument> };
  GlobalWorkerOptions: { workerSrc: string };
};

type PdfPointer = {
  pageNumber: number;
  crop: { x: number; y: number; width: number; height: number; pageWidth: number } | null;
};

const documentPromises = new Map<string, Promise<PdfDocument>>();
let runtimePromise: Promise<PdfRuntime> | null = null;
const PDF_WORKER_URL = typeof window === "undefined"
  ? new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString()
  : new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();

async function getRuntime(): Promise<PdfRuntime> {
  if (!runtimePromise) {
    runtimePromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((runtime) => {
      runtime.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return runtime as unknown as PdfRuntime;
    });
  }
  return runtimePromise;
}

function parsePointer(source: string): PdfPointer | null {
  const match = /^pdf:\/\/page\/(\d+)(?:\/image\/\d+)?(?:\?(.*))?$/u.exec(source.trim());
  if (!match) return null;
  const pageNumber = Number(match[1]);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
  const query = new URLSearchParams(match[2] ?? "");
  const values = ["x", "y", "width", "height", "pageWidth"].map((key) => Number(query.get(key)));
  const [x, y, width, height, pageWidth] = values;
  const crop = values.every((value) => Number.isFinite(value))
    && width !== undefined && width > 0
    && height !== undefined && height > 0
    && pageWidth !== undefined && pageWidth > 0
    ? { x: x!, y: y!, width, height, pageWidth }
    : null;
  return { pageNumber, crop };
}

async function openDocument(bytes: Uint8Array): Promise<PdfDocument> {
  const runtime = await getRuntime();
  return runtime.getDocument({
    data: new Uint8Array(bytes),
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    useWorkerFetch: false,
  }).promise;
}

async function getBookDocument(bookId: string, bytes: Uint8Array): Promise<PdfDocument> {
  let pending = documentPromises.get(bookId);
  if (!pending) {
    pending = openDocument(bytes);
    documentPromises.set(bookId, pending);
  }
  return pending;
}

function canvasContext(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const context = canvas.getContext("2d");
  return context ? { canvas, context } : null;
}

function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), "image/jpeg", 0.86);
  });
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string | null {
  try {
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}

async function renderPointer(
  document: PdfDocument,
  pointer: PdfPointer,
  maximumEdge: number,
): Promise<HTMLCanvasElement | null> {
  const page = await document.getPage(pointer.pageNumber);
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    const cropWidth = pointer.crop?.width ?? baseViewport.width;
    const cropHeight = pointer.crop?.height ?? baseViewport.height;
    const scale = Math.min(2, Math.max(0.55, maximumEdge / Math.max(cropWidth, cropHeight, 1)));
    const viewport = page.getViewport({ scale });
    const rendered = canvasContext(viewport.width, viewport.height);
    if (!rendered) return null;
    await page.render({ canvasContext: rendered.context, viewport }).promise;

    if (pointer.crop === null) return rendered.canvas;
    const scaleFromParser = viewport.width / pointer.crop.pageWidth;
    const sourceX = Math.max(0, pointer.crop.x * scaleFromParser);
    const sourceY = Math.max(0, pointer.crop.y * scaleFromParser);
    const sourceWidth = Math.min(viewport.width - sourceX, pointer.crop.width * scaleFromParser);
    const sourceHeight = Math.min(viewport.height - sourceY, pointer.crop.height * scaleFromParser);
    if (sourceWidth <= 1 || sourceHeight <= 1) return null;

    const cropped = canvasContext(sourceWidth, sourceHeight);
    if (!cropped) return null;
    cropped.context.drawImage(
      rendered.canvas,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      cropped.canvas.width,
      cropped.canvas.height,
    );
    return cropped.canvas;
  } finally {
    page.cleanup();
  }
}

export async function resolvePdfBookImage(bookId: string, source: string): Promise<string | null> {
  const pointer = parsePointer(source);
  if (!pointer) return null;
  const record = await loadRawBook(bookId);
  if (!record || !record.fileName.toLowerCase().endsWith(".pdf")) return null;
  const document = await getBookDocument(bookId, record.bytes);
  const canvas = await renderPointer(document, pointer, 1_400);
  return canvas ? canvasToObjectUrl(canvas) : null;
}

/** A single materialized cover is cheap and lets normal library <img> rendering work. */
export async function createPdfCoverDataUrl(bytes: Uint8Array): Promise<string | null> {
  const document = await openDocument(bytes);
  try {
    const canvas = await renderPointer(document, { pageNumber: 1, crop: null }, 700);
    return canvas ? canvasToDataUrl(canvas) : null;
  } finally {
    await document.destroy().catch(() => undefined);
  }
}

export async function clearPdfBookImageCache(bookId: string): Promise<void> {
  const pending = documentPromises.get(bookId);
  documentPromises.delete(bookId);
  if (!pending) return;
  const document = await pending.catch(() => null);
  if (document) await document.destroy().catch(() => undefined);
}
