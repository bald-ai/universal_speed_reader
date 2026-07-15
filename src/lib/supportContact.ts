/** Public support inbox for contact and import-issue reports. */
export const SUPPORT_CONTACT_EMAIL = "baldai@hey.com";

export type SupportMailtoOptions = {
  subject?: string;
  body?: string;
};

export type ImportIssueBook = {
  fileName: string;
  status: "with_issues" | "failed";
  reason: string | null;
};

/** Builds a mailto URL. Subject/body are omitted when empty. */
export function buildSupportMailto(options: SupportMailtoOptions = {}): string {
  const parts: string[] = [];
  const subject = options.subject?.trim();
  const body = options.body?.trim();
  if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
  if (body) parts.push(`body=${encodeURIComponent(body)}`);
  if (parts.length === 0) return `mailto:${SUPPORT_CONTACT_EMAIL}`;
  return `mailto:${SUPPORT_CONTACT_EMAIL}?${parts.join("&")}`;
}

export function buildImportIssueMailto(books: ImportIssueBook[]): string {
  const lines = [
    "What went wrong:",
    "",
    "(short description)",
    "",
    "Attach the EPUB/PDF if you can.",
    "",
    "Import details from the app:",
  ];

  for (const book of books) {
    const statusLabel = book.status === "failed" ? "Failed" : "With issues";
    lines.push(`- ${book.fileName} (${statusLabel})`);
    if (book.reason?.trim()) {
      lines.push(`  ${book.reason.trim()}`);
    }
  }

  const subject =
    books.length === 1
      ? `Import issue: ${books[0].fileName}`
      : `Import issues (${books.length} books)`;

  return buildSupportMailto({
    subject,
    body: lines.join("\n"),
  });
}
