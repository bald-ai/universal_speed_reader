import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import BookFormatBadge from "./BookFormatBadge";

describe("BookFormatBadge", () => {
  test("renders the stored source format", () => {
    expect(renderToStaticMarkup(<BookFormatBadge format="EPUB" />)).toContain("EPUB");
    expect(renderToStaticMarkup(<BookFormatBadge format="PDF" />)).toContain("PDF");
  });

  test("renders nothing when the legacy source format is unknown", () => {
    expect(renderToStaticMarkup(<BookFormatBadge format={null} />)).toBe("");
  });
});
