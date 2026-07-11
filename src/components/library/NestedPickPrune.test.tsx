import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import NestedPickPrune, {
  collectPickPruneBookIds,
  removeNodeFromPickPruneSelection,
  restoreBooksToPickPruneSelection,
  type PickPruneFolderNode,
} from "./NestedPickPrune";

const TREE: PickPruneFolderNode = {
  kind: "folder",
  id: "root",
  label: "Benchmark",
  children: [
    {
      kind: "folder",
      id: "fantasy",
      label: "Fantasy",
      children: [
        { kind: "book", id: "book-1", name: "Winds.epub", size: 10 * 1024 * 1024 },
        { kind: "book", id: "book-2", name: "Mistborn.epub", size: 2 * 1024 * 1024 },
      ],
    },
    { kind: "book", id: "book-3", name: "Loose.epub", size: 1024 },
  ],
};

describe("NestedPickPrune", () => {
  it("renders live kept counts and removed section only after pruning", () => {
    const html = renderToStaticMarkup(
      <NestedPickPrune
        root={TREE}
        title="Review folder"
        description="Pick what should be imported."
        confirmLabel="Import selected"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(html).toContain("Review folder");
    expect(html).toContain("3/3");
    expect(html).toContain("Kept books");
    expect(html).toContain("Import selected");
    expect(html).not.toContain("Removed (");
  });

  it("removes a folder subtree and restores removed books", () => {
    const allIds = collectPickPruneBookIds(TREE);
    expect(allIds).toEqual(["book-1", "book-2", "book-3"]);

    const afterFolderRemove = removeNodeFromPickPruneSelection(TREE, "fantasy", allIds);
    expect(afterFolderRemove).toEqual(["book-3"]);

    const afterBookRemove = removeNodeFromPickPruneSelection(TREE, "book-3", afterFolderRemove);
    expect(afterBookRemove).toEqual([]);

    const restored = restoreBooksToPickPruneSelection(afterBookRemove, ["book-2", "book-3"]);
    expect(restored.sort()).toEqual(["book-2", "book-3"]);
  });
});
