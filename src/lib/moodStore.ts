import type { LibraryBook, MoodFolder } from "@/types/book";

type RecentMap = Record<string, string>;

let foldersState: MoodFolder[] | null = null;
let recentState: RecentMap = {};

function cloneFolders(folders: MoodFolder[]): MoodFolder[] {
  return folders.map((f) => ({ ...f, bookIds: [...f.bookIds] }));
}

export async function loadFolders(): Promise<MoodFolder[]> {
  if (!foldersState) {
    foldersState = [];
  }
  return cloneFolders(foldersState);
}

export async function saveFolders(folders: MoodFolder[]): Promise<void> {
  foldersState = cloneFolders(folders);
}

export function getUnassignedBooks(folders: MoodFolder[], allBooks: LibraryBook[]): LibraryBook[] {
  const assigned = new Set<string>();
  for (const folder of folders) {
    for (const id of folder.bookIds) assigned.add(id);
  }
  return allBooks.filter((book) => !assigned.has(book.id));
}

export async function loadRecent(): Promise<RecentMap> {
  return { ...recentState };
}

export async function saveRecent(recent: RecentMap): Promise<void> {
  recentState = { ...recent };
}

export async function setRecent(folderId: string, bookId: string): Promise<void> {
  recentState = { ...recentState, [folderId]: bookId };
}

export async function removeBookReferences(bookId: string): Promise<void> {
  const folders = await loadFolders();
  const cleanedFolders = folders.map((folder) => ({
    ...folder,
    bookIds: folder.bookIds.filter((id) => id !== bookId),
  }));
  await saveFolders(cleanedFolders);

  const recent = await loadRecent();
  let changed = false;
  for (const folderId of Object.keys(recent)) {
    if (recent[folderId] === bookId) {
      delete recent[folderId];
      changed = true;
    }
  }

  if (changed) {
    await saveRecent(recent);
  }
}
