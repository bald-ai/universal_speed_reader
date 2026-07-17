import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import LastImportReport, { type LastImportSummary } from "./LastImportReport";

const sampleSummary: LastImportSummary = {
  bookCount: 5,
  completedCount: 3,
  withIssuesCount: 1,
  failedCount: 1,
  canceledCount: 1,
  totalBytes: 12 * 1024 * 1024,
  elapsedMs: 45_000,
  books: [
    {
      id: "ok-1",
      fileName: "pride.epub",
      status: "ok",
      reason: null,
      sizeBytes: 1024,
    },
    {
      id: "ok-2",
      fileName: "war.epub",
      status: "ok",
      reason: null,
      sizeBytes: 2048,
    },
    {
      id: "issue-1",
      fileName: "face.pdf",
      status: "with_issues",
      reason: "Chapter list may be incomplete or unclear.",
      sizeBytes: 4096,
    },
    {
      id: "fail-1",
      fileName: "drive.pdf",
      status: "failed",
      reason: "PDF parsing exceeded the 30s limit",
      sizeBytes: 8192,
    },
    {
      id: "cancel-1",
      fileName: "skipped.epub",
      status: "canceled",
      reason: null,
      sizeBytes: 512,
    },
  ],
};

describe("LastImportReport", () => {
  it("renders outcome-first summary with collapsible buckets and support email", () => {
    const html = renderToStaticMarkup(
      <LastImportReport summary={sampleSummary} onDismiss={() => {}} />
    );

    expect(html).toContain('data-testid="last-import-report"');
    expect(html).toContain("Last import");
    expect(html).toContain("1 failed");
    expect(html).toContain("1 with issues");
    expect(html).toContain("1 canceled");
    expect(html).toContain("2 ok");
    expect(html).toContain("Not in library — import the file again");
    expect(html).toContain("drive.pdf");
    expect(html).toContain("PDF parsing exceeded the 30s limit");
    expect(html).toContain('data-testid="last-import-report-email"');
    expect(html).toContain("Email about this import");
    expect(html).toContain('data-testid="last-import-report-dismiss"');
    expect(html).toContain('data-testid="last-import-bucket-failed"');
    expect(html).toContain('data-testid="last-import-bucket-issues"');
    expect(html).toContain('data-testid="last-import-bucket-canceled"');
    expect(html).toContain('data-testid="last-import-bucket-ok"');
  });

  it("hides email footer when every book imported cleanly", () => {
    const html = renderToStaticMarkup(
      <LastImportReport
        summary={{
          ...sampleSummary,
          withIssuesCount: 0,
          failedCount: 0,
          canceledCount: 0,
          completedCount: 2,
          books: sampleSummary.books.filter((book) => book.status === "ok"),
        }}
        onDismiss={() => {}}
      />
    );

    expect(html).not.toContain('data-testid="last-import-report-email"');
    expect(html).toContain("2 ok");
  });
});
