import { epubAssetDataUrl } from "@/lib/import/epubAssetDataUrl";

/**
 * Reads a cover image from an EPUB zip and returns a displayable data URL.
 * Soft-fails to null when the path is missing, unreadable, or unsupported.
 */
export async function epubCoverDataUrl(
  epubBytes: Uint8Array,
  coverPath: string | null | undefined
): Promise<string | null> {
  return epubAssetDataUrl(epubBytes, coverPath);
}
