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
        onStart={() => {}}
        onCancel={() => {}}
      />
    );

    expect(html).toContain("3 books selected");
    expect(html).toContain("first.epub");
    expect(html).toContain("second.epub");
    expect(html).toContain("Start import");
    expect(html).toContain("Cancel");
    expect(html).toContain('data-testid="bulk-import-cancel"');
  });
});
