import { describe, expect, test } from "bun:test";
import { getBookSourceFormat } from "./libraryBooks";

describe("library book source format", () => {
  test("derives EPUB and PDF from stored source URIs", () => {
    expect(getBookSourceFormat("indexeddb://raw_books/id/title.epub")).toBe("EPUB");
    expect(getBookSourceFormat("indexeddb://raw_books/id/title.PDF")).toBe("PDF");
    expect(getBookSourceFormat("indexeddb://raw_books/id/My%20Book.pdf")).toBe("PDF");
  });

  test("does not invent a format for an unknown legacy source", () => {
    expect(getBookSourceFormat("memory://book-without-extension")).toBeNull();
  });
});
