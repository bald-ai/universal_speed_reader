import { describe, expect, test } from "bun:test";
import { isSupportedBookFile } from "./bookFileSelection";

describe("book file selection", () => {
  test("accepts EPUB and PDF MIME types", () => {
    expect(isSupportedBookFile({ name: "book", type: "application/epub+zip" })).toBe(true);
    expect(isSupportedBookFile({ name: "book", type: "application/pdf" })).toBe(true);
  });

  test("accepts EPUB and PDF extensions when Android reports a generic MIME type", () => {
    expect(isSupportedBookFile({ name: "BOOK.EPUB", type: "application/octet-stream" })).toBe(true);
    expect(isSupportedBookFile({ name: "notes.pdf", type: "" })).toBe(true);
  });

  test("rejects unsupported selections", () => {
    expect(isSupportedBookFile({ name: "cover.jpg", type: "image/jpeg" })).toBe(false);
    expect(isSupportedBookFile({ name: "archive.zip", type: "application/zip" })).toBe(false);
  });
});
