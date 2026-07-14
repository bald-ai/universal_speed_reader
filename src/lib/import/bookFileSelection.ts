const SUPPORTED_BOOK_MIME_TYPES = new Set([
  "application/epub+zip",
  "application/pdf",
]);

export type BookFileCandidate = {
  name: string;
  type?: string;
};

export function isSupportedBookFile(candidate: BookFileCandidate): boolean {
  const mimeType = candidate.type?.trim().toLowerCase() ?? "";
  if (SUPPORTED_BOOK_MIME_TYPES.has(mimeType)) return true;

  const lowerName = candidate.name.trim().toLowerCase();
  return lowerName.endsWith(".epub") || lowerName.endsWith(".pdf");
}

