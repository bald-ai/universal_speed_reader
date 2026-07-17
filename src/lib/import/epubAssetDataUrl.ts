import { ZipArchive } from "@/lib/epub/zipArchive";

const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

export function mimeFromAssetPath(assetPath: string): string | null {
  const normalized = assetPath.replace(/\\/g, "/").trim().toLowerCase();
  const fileName = normalized.split("/").pop() ?? normalized;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const extension = fileName.slice(dotIndex + 1);
  return EXTENSION_TO_MIME[extension] ?? null;
}

/**
 * Reads an image from an EPUB zip and returns raw bytes + mime type.
 * Soft-fails to null when the path is missing, unreadable, or unsupported.
 */
export async function epubAssetBytes(
  epubBytes: Uint8Array,
  assetPath: string | null | undefined,
  zip?: ZipArchive
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const trimmedPath = assetPath?.trim();
  if (!trimmedPath) return null;

  const mimeType = mimeFromAssetPath(trimmedPath);
  if (!mimeType) return null;

  try {
    const archive = zip ?? ZipArchive.fromBytes(epubBytes);
    const assetBytes = await archive.readEntryBytes(trimmedPath);
    if (assetBytes.byteLength === 0) return null;
    return { bytes: assetBytes, mimeType };
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoder is unavailable");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Builds a data URL from already-extracted asset bytes. Soft-fails to null. */
export function assetDataUrlFromBytes(bytes: Uint8Array, mimeType: string): string | null {
  try {
    if (bytes.byteLength === 0) return null;
    return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  } catch {
    return null;
  }
}

/**
 * Reads an image from an EPUB zip and returns a displayable data URL.
 * Soft-fails to null when the path is missing, unreadable, or unsupported.
 */
export async function epubAssetDataUrl(
  epubBytes: Uint8Array,
  assetPath: string | null | undefined,
  zip?: ZipArchive
): Promise<string | null> {
  const asset = await epubAssetBytes(epubBytes, assetPath, zip);
  if (!asset) return null;
  return assetDataUrlFromBytes(asset.bytes, asset.mimeType);
}

/**
 * Reads an image from an EPUB zip and returns a blob: object URL.
 * Caller owns revocation. Soft-fails to null when unreadable/unsupported.
 */
export async function epubAssetObjectUrl(
  epubBytes: Uint8Array,
  assetPath: string | null | undefined,
  zip?: ZipArchive
): Promise<string | null> {
  const asset = await epubAssetBytes(epubBytes, assetPath, zip);
  if (!asset) return null;
  try {
    // Copy into a plain ArrayBuffer — Uint8Array may be a view into the full EPUB.
    const copy = new Uint8Array(asset.bytes);
    const blob = new Blob([copy], { type: asset.mimeType });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
