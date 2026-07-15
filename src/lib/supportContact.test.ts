import { describe, expect, test } from "bun:test";
import {
  SUPPORT_CONTACT_EMAIL,
  buildImportIssueMailto,
  buildSupportMailto,
} from "@/lib/supportContact";

describe("supportContact", () => {
  test("builds a plain mailto when no subject or body is provided", () => {
    expect(buildSupportMailto()).toBe(`mailto:${SUPPORT_CONTACT_EMAIL}`);
  });

  test("encodes subject and body query params", () => {
    const href = buildSupportMailto({
      subject: "Import issue: My Book.epub",
      body: "What went wrong:\n\nPlease attach the file.",
    });
    expect(href.startsWith(`mailto:${SUPPORT_CONTACT_EMAIL}?`)).toBe(true);
    expect(href).toContain(`subject=${encodeURIComponent("Import issue: My Book.epub")}`);
    expect(href).toContain(
      `body=${encodeURIComponent("What went wrong:\n\nPlease attach the file.")}`
    );
  });

  test("prefills import-issue details and asks for the file", () => {
    const href = buildImportIssueMailto([
      {
        fileName: "Broken.epub",
        status: "failed",
        reason: "Almost no usable text",
      },
      {
        fileName: "Soft.pdf",
        status: "with_issues",
        reason: "Some pictures are missing.",
      },
    ]);

    expect(href).toContain(`subject=${encodeURIComponent("Import issues (2 books)")}`);
    const body = decodeURIComponent(href.split("body=")[1] ?? "");
    expect(body).toContain("Attach the EPUB/PDF if you can.");
    expect(body).toContain("- Broken.epub (Failed)");
    expect(body).toContain("Almost no usable text");
    expect(body).toContain("- Soft.pdf (With issues)");
  });

  test("uses a single-file subject when only one book has issues", () => {
    const href = buildImportIssueMailto([
      { fileName: "Only.epub", status: "failed", reason: null },
    ]);
    expect(href).toContain(`subject=${encodeURIComponent("Import issue: Only.epub")}`);
  });
});
