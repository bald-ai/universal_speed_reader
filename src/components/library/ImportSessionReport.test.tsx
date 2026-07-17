import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ImportSessionReport from "./ImportSessionReport";

describe("ImportSessionReport", () => {
  it("shows progress, stay-open copy, and Cancel while importing", () => {
    const html = renderToStaticMarkup(
      <ImportSessionReport
        totalCount={4}
        completedCount={2}
        withIssuesCount={1}
        failedCount={0}
        canceledCount={0}
        isCanceling={false}
        elapsedMs={6000}
        estimatedRemainingMs={12000}
        current={{ fileName: "war-and-peace.epub", phaseLabel: "Building chapters" }}
        books={[
          {
            id: "1",
            fileName: "issues.pdf",
            status: "with_issues",
            reason: "Some pictures are missing",
            sizeBytes: 1024,
          },
          {
            id: "2",
            fileName: "ok.epub",
            status: "ok",
            reason: null,
            sizeBytes: 2048,
          },
        ]}
        onCancel={() => {}}
      />
    );

    expect(html).toContain("Importing");
    expect(html).toContain("2 of 4");
    expect(html).toContain("1 with issues");
    expect(html).toContain("1 ok");
    expect(html).toContain("Screen stays on");
    expect(html).toContain("war-and-peace.epub");
    expect(html).toContain("Building chapters");
    expect(html).toContain("Don’t switch apps or lock the phone");
    expect(html).toContain("Cancel");
    expect(html).toContain('data-testid="import-session-cancel"');
    expect(html).not.toMatch(/data-testid="import-session-cancel"[^>]*\sdisabled=/);
  });

  it("shows Canceling copy and disables Cancel while cancel is in progress", () => {
    const html = renderToStaticMarkup(
      <ImportSessionReport
        totalCount={4}
        completedCount={2}
        withIssuesCount={0}
        failedCount={0}
        canceledCount={0}
        isCanceling={true}
        elapsedMs={6000}
        estimatedRemainingMs={null}
        current={{ fileName: "war-and-peace.epub", phaseLabel: "Building chapters" }}
        books={[]}
        onCancel={() => {}}
      />
    );

    expect(html).toContain("Canceling");
    expect(html).toContain("stopping current book");
    expect(html).not.toContain("finishing current book");
    expect(html).toContain("Stopping safely");
    expect(html).toContain("Canceling…");
    expect(html).toContain("Don’t leave until this closes");
    expect(html).toContain('data-testid="import-session-cancel"');
    expect(html).toMatch(/disabled=""/);
  });
});
