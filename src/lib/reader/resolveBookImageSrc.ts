import { epubAssetObjectUrl } from "@/lib/import/epubAssetDataUrl";
import { loadRawBook } from "@/lib/import/rawEpubStore";
import { clearPdfBookImageCache, resolvePdfBookImage } from "@/lib/import/pdfImageRenderer";
import { ZipArchive } from "@/lib/epub/zipArchive";

type BookImageSession = {
  zip: ZipArchive;
  bytes: Uint8Array;
  objectUrls: Map<string, string>;
  inflight: Map<string, Promise<string | null>>;
};

const sessions = new Map<string, Promise<BookImageSession | null>>();
const pdfObjectUrls = new Map<string, Map<string, string>>();
const pdfInflight = new Map<string, Map<string, Promise<string | null>>>();

function isDataImageSrc(src: string): boolean {
  return src.trim().toLowerCase().startsWith("data:image/");
}

function isPdfPointer(src: string): boolean {
  return src.trim().toLowerCase().startsWith("pdf://page/");
}

async function loadSession(bookId: string): Promise<BookImageSession | null> {
  const record = await loadRawBook(bookId);
  if (!record) return null;
  if (!record.fileName.toLowerCase().endsWith(".epub")) return null;
  return {
    zip: ZipArchive.fromBytes(record.bytes),
    bytes: record.bytes,
    objectUrls: new Map(),
    inflight: new Map(),
  };
}

function getSession(bookId: string): Promise<BookImageSession | null> {
  let pending = sessions.get(bookId);
  if (!pending) {
    pending = loadSession(bookId).catch(() => null);
    sessions.set(bookId, pending);
  }
  return pending;
}

/**
 * Resolves a stored book image `src` to a displayable URL.
 * - `data:image/...` values (inline SVG) are returned as-is.
 * - Zip-relative EPUB paths are loaded from the raw EPUB and cached as blob URLs.
 */
export async function resolveBookImageSrc(bookId: string, src: string): Promise<string | null> {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (isDataImageSrc(trimmed)) return trimmed;
  if (isPdfPointer(trimmed)) {
    const cached = pdfObjectUrls.get(bookId)?.get(trimmed);
    if (cached) return cached;
    const active = pdfInflight.get(bookId)?.get(trimmed);
    if (active) return active;
    const pending = resolvePdfBookImage(bookId, trimmed).then((url) => {
      pdfInflight.get(bookId)?.delete(trimmed);
      if (url) {
        const urls = pdfObjectUrls.get(bookId) ?? new Map<string, string>();
        urls.set(trimmed, url);
        pdfObjectUrls.set(bookId, urls);
      }
      return url;
    });
    const inflight = pdfInflight.get(bookId) ?? new Map<string, Promise<string | null>>();
    inflight.set(trimmed, pending);
    pdfInflight.set(bookId, inflight);
    return pending;
  }

  const session = await getSession(bookId);
  if (!session) return null;

  const cached = session.objectUrls.get(trimmed);
  if (cached) return cached;

  const existing = session.inflight.get(trimmed);
  if (existing) return existing;

  const pending = epubAssetObjectUrl(session.bytes, trimmed, session.zip).then((url) => {
    session.inflight.delete(trimmed);
    if (url) {
      session.objectUrls.set(trimmed, url);
    }
    return url;
  });
  session.inflight.set(trimmed, pending);
  return pending;
}

/** Revoke cached blob URLs for a book (call on delete / leave reader). */
export async function clearBookImageSrcCache(bookId: string): Promise<void> {
  const pending = sessions.get(bookId);
  sessions.delete(bookId);
  if (pending) {
    const session = await pending;
    if (session) {
      for (const url of session.objectUrls.values()) {
        URL.revokeObjectURL(url);
      }
      session.objectUrls.clear();
      session.inflight.clear();
    }
  }
  for (const url of pdfObjectUrls.get(bookId)?.values() ?? []) {
    URL.revokeObjectURL(url);
  }
  pdfObjectUrls.delete(bookId);
  pdfInflight.delete(bookId);
  await clearPdfBookImageCache(bookId);
}
