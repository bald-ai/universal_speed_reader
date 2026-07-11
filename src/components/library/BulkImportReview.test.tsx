import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import BulkImportReview from "./BulkImportReview";

describe("BulkImportReview", () => {
  it("summarizes a selected batch before import starts", () => {
    const html = renderToStaticMarkup(
      <BulkImportReview
        files={[
          { name: "first.epub", size: 1024 },
          { name: "second.epub", size: 2048 },
          { name: "third.epub", size: 4096 },
        ]}
        completedCount={0}
        failedCount={0}
        isImporting={false}
        onStart={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain("3 books selected");
    expect(html).toContain("first.epub");
    expect(html).toContain("second.epub");
    expect(html).toContain("Start import");
    expect(html).toContain("Cancel");
  });

  it("shows batch progress while importing", () => {
    const html = renderToStaticMarkup(
      <BulkImportReview
        files={[
          { name: "first.epub", size: 1024 },
          { name: "second.epub", size: 2048 },
          { name: "third.epub", size: 4096 },
          { name: "fourth.epub", size: 8192 },
        ]}
        completedCount={2}
        failedCount={1}
        isImporting={true}
        elapsedMs={6000}
        processedBytes={3 * 1024 * 1024}
        onStart={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain("Processing 3 of 4");
    expect(html).toContain("75%");
    expect(html).toContain("Per book");
    expect(html).toContain("Per MB");
    expect(html).toContain("Processing...");
  });
});
