import { describe, expect, it } from "bun:test";
import {
  buildFolderImportPreview,
  flattenFolderImportBooks,
  sumBytesInFolderImportTree,
} from "./folderImportTree";

describe("folderImportTree", () => {
  it("builds a nested folder tree from relative paths", () => {
    const preview = buildFolderImportPreview(
      [
        { name: "winds.epub", size: 10, relativePath: "Fantasy/Sanderson/winds.epub" },
        { name: "mistborn.epub", size: 20, relativePath: "Fantasy/Sanderson/mistborn.epub" },
        { name: "monte.epub", size: 30, relativePath: "Classics/monte.epub" },
      ],
      "Books"
    );

    expect(preview.bookCount).toBe(3);
    expect(preview.totalBytes).toBe(60);
    expect(preview.root.label).toBe("Books");
    expect(preview.root.children.map((node) => `${node.kind}:${node.kind === "folder" ? node.label : node.name}`)).toEqual([
      "folder:Classics",
      "folder:Fantasy",
    ]);

    const fantasy = preview.root.children.find((node) => node.kind === "folder" && node.label === "Fantasy");
    expect(fantasy?.kind).toBe("folder");
    if (fantasy?.kind !== "folder") return;

    const sanderson = fantasy.children[0];
    expect(sanderson?.kind).toBe("folder");
    if (sanderson?.kind !== "folder") return;

    expect(sanderson.children.map((node) => (node.kind === "book" ? node.name : node.label))).toEqual([
      "mistborn.epub",
      "winds.epub",
    ]);
  });

  it("puts files with no relative folder at the preview root", () => {
    const preview = buildFolderImportPreview(
      [
        { name: "loose.epub", size: 12 },
        { name: "nested.epub", size: 24, relativePath: "Nested/nested.epub" },
      ],
      ""
    );

    expect(preview.root.label).toBe("Imported folder");
    expect(flattenFolderImportBooks(preview.root).map((book) => book.relativePath)).toEqual([
      "Nested/nested.epub",
      "loose.epub",
    ]);
    expect(sumBytesInFolderImportTree(preview.root)).toBe(36);
  });
});
