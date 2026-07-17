import { getBookIdsInFolderSubtree, getFolderDescendantIds } from "@/lib/libraryLayoutStore";
import type { LibraryLayout, LibraryLayoutItemId } from "@/types/libraryLayout";

export type LibrarySelectionKey = `${"folder" | "book"}:${string}`;

export function librarySelectionKey(item: LibraryLayoutItemId): LibrarySelectionKey {
  return `${item.kind}:${item.id}`;
}

export function parseLibrarySelectionKey(key: string): LibraryLayoutItemId | null {
  const [kind, id] = key.split(":");
  if ((kind !== "folder" && kind !== "book") || !id) return null;
  return { kind, id };
}

/** Folder id plus every descendant folder and book under it. */
export function getFolderSubtreeSelectionKeys(
  layout: LibraryLayout,
  folderId: string
): LibrarySelectionKey[] {
  const folderIds = getFolderDescendantIds(layout, folderId);
  const bookIds = getBookIdsInFolderSubtree(layout, folderId);
  return [
    ...folderIds.map((id) => librarySelectionKey({ kind: "folder", id })),
    ...bookIds.map((id) => librarySelectionKey({ kind: "book", id })),
  ];
}

export function setFolderSubtreeSelected(
  selected: ReadonlySet<string>,
  layout: LibraryLayout,
  folderId: string,
  on: boolean
): Set<string> {
  const next = new Set(selected);
  for (const key of getFolderSubtreeSelectionKeys(layout, folderId)) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/**
 * Derive parent folder checked / partial from descendants (cascade model).
 * Returns the synced selection set and folder ids that are partially selected.
 */
export function syncCascadeFolderSelection(
  selected: ReadonlySet<string>,
  layout: LibraryLayout
): { selected: Set<string>; partialFolderIds: Set<string> } {
  const next = new Set(selected);
  const partialFolderIds = new Set<string>();
  const foldersDeepestFirst = [...layout.folders].sort((a, b) => {
    const depth = (folderId: string): number => {
      let depthCount = 0;
      let parentId: string | null | undefined = layout.folders.find((folder) => folder.id === folderId)?.parentId;
      while (parentId) {
        depthCount += 1;
        parentId = layout.folders.find((folder) => folder.id === parentId)?.parentId;
      }
      return depthCount;
    };
    return depth(b.id) - depth(a.id);
  });

  for (const folder of foldersDeepestFirst) {
    const childFolderIds = layout.folders
      .filter((candidate) => candidate.parentId === folder.id)
      .map((candidate) => candidate.id);
    const childBookIds = layout.placements
      .filter((placement) => placement.parentId === folder.id)
      .map((placement) => placement.bookId);
    const childKeys = [
      ...childFolderIds.map((id) => librarySelectionKey({ kind: "folder", id })),
      ...childBookIds.map((id) => librarySelectionKey({ kind: "book", id })),
    ];
    const folderKey = librarySelectionKey({ kind: "folder", id: folder.id });

    if (childKeys.length === 0) {
      partialFolderIds.delete(folder.id);
      continue;
    }

    const selectedChildCount = childKeys.filter((key) => next.has(key)).length;
    const childHasPartial = childFolderIds.some((id) => partialFolderIds.has(id));
    if (
      selectedChildCount === childKeys.length &&
      childKeys.length > 0 &&
      !childHasPartial
    ) {
      next.add(folderKey);
      partialFolderIds.delete(folder.id);
    } else if (selectedChildCount > 0 || childHasPartial) {
      next.delete(folderKey);
      partialFolderIds.add(folder.id);
    } else {
      next.delete(folderKey);
      partialFolderIds.delete(folder.id);
    }
  }

  return { selected: next, partialFolderIds };
}

export function toggleLibrarySelection(
  selected: ReadonlySet<string>,
  layout: LibraryLayout,
  item: LibraryLayoutItemId
): Set<string> {
  const key = librarySelectionKey(item);
  if (item.kind === "folder") {
    const turningOn = !selected.has(key);
    return setFolderSubtreeSelected(selected, layout, item.id, turningOn);
  }
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function formatLibrarySelectionCount(selected: ReadonlySet<string>): string {
  let folders = 0;
  let books = 0;
  for (const key of selected) {
    const item = parseLibrarySelectionKey(key);
    if (!item) continue;
    if (item.kind === "folder") folders += 1;
    else books += 1;
  }
  const parts: string[] = [];
  if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  if (books) parts.push(`${books} book${books === 1 ? "" : "s"}`);
  if (parts.length === 0) return "0 selected";
  return parts.join(" · ");
}

/** Selected folders that are not under another selected folder. */
export function getRootSelectedFolderIds(
  selected: ReadonlySet<string>,
  layout: LibraryLayout
): string[] {
  const selectedFolderIds = [...selected]
    .map(parseLibrarySelectionKey)
    .filter((item): item is { kind: "folder"; id: string } => item?.kind === "folder")
    .map((item) => item.id);

  const selectedSet = new Set(selectedFolderIds);
  return selectedFolderIds.filter((folderId) => {
    let parentId = layout.folders.find((folder) => folder.id === folderId)?.parentId ?? null;
    while (parentId) {
      if (selectedSet.has(parentId)) return false;
      parentId = layout.folders.find((folder) => folder.id === parentId)?.parentId ?? null;
    }
    return true;
  });
}

/**
 * Books/folders to move: skip items already covered by a selected ancestor folder.
 */
export function getMovableSelection(
  selected: ReadonlySet<string>,
  layout: LibraryLayout
): { folderIds: string[]; bookIds: string[] } {
  const rootFolderIds = getRootSelectedFolderIds(selected, layout);
  const coveredBookIds = new Set<string>();
  for (const folderId of rootFolderIds) {
    for (const bookId of getBookIdsInFolderSubtree(layout, folderId)) {
      coveredBookIds.add(bookId);
    }
  }

  const bookIds = [...selected]
    .map(parseLibrarySelectionKey)
    .filter((item): item is { kind: "book"; id: string } => item?.kind === "book")
    .map((item) => item.id)
    .filter((bookId) => !coveredBookIds.has(bookId));

  return { folderIds: rootFolderIds, bookIds };
}

export function collectSelectedBookIds(selected: ReadonlySet<string>): string[] {
  return [...selected]
    .map(parseLibrarySelectionKey)
    .filter((item): item is { kind: "book"; id: string } => item?.kind === "book")
    .map((item) => item.id);
}

export function listAllLibrarySelectionKeys(layout: LibraryLayout): LibrarySelectionKey[] {
  return [
    ...layout.folders.map((folder) => librarySelectionKey({ kind: "folder", id: folder.id })),
    ...layout.placements.map((placement) =>
      librarySelectionKey({ kind: "book", id: placement.bookId })
    ),
  ];
}

export function countBooksInFolderIds(layout: LibraryLayout, folderIds: string[]): number {
  const bookIds = new Set<string>();
  for (const folderId of folderIds) {
    for (const bookId of getBookIdsInFolderSubtree(layout, folderId)) {
      bookIds.add(bookId);
    }
  }
  return bookIds.size;
}
