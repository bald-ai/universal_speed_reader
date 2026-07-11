import { epubAssetObjectUrl } from "@/lib/import/epubAssetDataUrl";
import { loadRawEpub } from "@/lib/import/rawEpubStore";
import { ZipArchive } from "@/lib/epub/zipArchive";

type BookImageSession = {
  zip: ZipArchive;
  bytes: Uint8Array;
  objectUrls: Map<string, string>;
  inflight: Map<string, Promise<string | null>>;
};

const sessions = new Map<string, Promise<BookImageSession | null>>();

function isDataImageSrc(src: string): boolean {
  return src.trim().toLowerCase().startsWith("data:image/");
}

async function loadSession(bookId: string): Promise<BookImageSession | null> {
  const record = await loadRawEpub(bookId);
  if (!record) return null;
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
  if (!pending) return;
  const session = await pending;
  if (!session) return;
  for (const url of session.objectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  session.objectUrls.clear();
  session.inflight.clear();
}
