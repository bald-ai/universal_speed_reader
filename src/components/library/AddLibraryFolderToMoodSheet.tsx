import { useMemo, useState } from "react";
import NestedPickPrune, { type PickPruneFolderNode, type PickPruneTreeNode } from "./NestedPickPrune";
import { getFolderPathLabels } from "@/lib/libraryLayoutStore";
import type { LibraryBook, Mood } from "@/types/book";
import type { LibraryFolder, LibraryLayout } from "@/types/libraryLayout";

type AddLibraryFolderToMoodSheetProps = {
  mood: Mood;
  books: LibraryBook[];
  layout: LibraryLayout;
  onClose: () => void;
  onConfirm: (moodId: string, bookIds: string[]) => void;
};

function sortFolders(folders: LibraryFolder[]): LibraryFolder[] {
  return [...folders].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

function buildFolderTree(
  folder: LibraryFolder,
  layout: LibraryLayout,
  bookById: Map<string, LibraryBook>
): PickPruneFolderNode {
  const childFolders = sortFolders(layout.folders.filter((candidate) => candidate.parentId === folder.id));
  const childBooks = layout.placements
    .filter((placement) => placement.parentId === folder.id)
    .sort((a, b) => a.order - b.order || a.bookId.localeCompare(b.bookId))
    .map((placement) => bookById.get(placement.bookId))
    .filter((book): book is LibraryBook => !!book);

  const children: PickPruneTreeNode[] = [
    ...childFolders.map((child) => buildFolderTree(child, layout, bookById)),
    ...childBooks.map((book) => ({
      kind: "book" as const,
      id: book.id,
      name: book.title,
      subtitle: book.author ?? "Unknown author",
    })),
  ];

  return {
    kind: "folder",
    id: `library-folder:${folder.id}`,
    label: folder.label,
    children,
  };
}

function countBooks(node: PickPruneTreeNode): number {
  if (node.kind === "book") return 1;
  return node.children.reduce((sum, child) => sum + countBooks(child), 0);
}

export default function AddLibraryFolderToMoodSheet(props: AddLibraryFolderToMoodSheetProps) {
  const { mood, books, layout, onClose, onConfirm } = props;
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const bookById = useMemo(() => new Map(books.map((book) => [book.id, book])), [books]);
  const folders = useMemo(() => sortFolders(layout.folders), [layout.folders]);
  const selectedFolder = selectedFolderId
    ? layout.folders.find((folder) => folder.id === selectedFolderId) ?? null
    : null;
  const selectedTree = selectedFolder ? buildFolderTree(selectedFolder, layout, bookById) : null;

  if (selectedTree) {
    return (
      <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
        <div className="max-h-[92dvh] w-full overflow-auto pb-[env(safe-area-inset-bottom,0px)]">
          <NestedPickPrune
            root={selectedTree}
            title={`Add to ${mood.label}`}
            description="Remove anything you do not want tagged with this mood. Your Library folders stay unchanged."
            confirmLabel="Add selected"
            onCancel={() => setSelectedFolderId(null)}
            onConfirm={(bookIds) => {
              onConfirm(mood.id, bookIds);
              onClose();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
      <div className="max-h-[78dvh] w-full overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60">
        <div className="border-b border-neutral-800 p-4">
          <div className="text-sm font-semibold text-neutral-100">Add folder to {mood.label}</div>
          <div className="mt-1 text-xs text-neutral-500">Choose a Library folder, then prune the books.</div>
        </div>
        <div className="max-h-[58dvh] overflow-auto p-2">
          {folders.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-3 text-sm text-neutral-500">
              No Library folders yet.
            </div>
          ) : (
            folders.map((folder) => {
              const tree = buildFolderTree(folder, layout, bookById);
              const bookCount = countBooks(tree);
              const path = [...getFolderPathLabels(layout, folder.parentId), folder.label].join(" / ");
              return (
                <button
                  key={folder.id}
                  type="button"
                  disabled={bookCount === 0}
                  onClick={() => setSelectedFolderId(folder.id)}
                  className="mb-1 w-full rounded-xl px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="block truncate">{path}</span>
                  <span className="text-xs text-neutral-500">{bookCount} books</span>
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-neutral-800 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          <button type="button" onClick={onClose} className="w-full rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
