import type { LibraryBook, MoodFolder } from "@/types/book";
import { MOCK_MOOD_FOLDERS } from "@/lib/mockMoodFolders";
import { devStoreGet, devStoreSet } from "@/lib/devStore";

const FOLDERS_KEY = "speedreader-mood-folders";
const RECENT_KEY = "speedreader-mood-recent";

type RecentMap = Record<string, string>;

const isMoodFolder = (v: unknown): v is MoodFolder => {
  if (!v || typeof v !== "object") return false;
  const o = v as MoodFolder;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    Array.isArray(o.bookIds) &&
    o.bookIds.every((x) => typeof x === "string")
  );
};

export async function loadFolders(): Promise<MoodFolder[]> {
  const parsed = await devStoreGet<unknown>(FOLDERS_KEY);
  if (Array.isArray(parsed) && parsed.every(isMoodFolder)) return parsed;

  // First load, or malformed data: initialize with mock folders.
  await saveFolders(MOCK_MOOD_FOLDERS);
  return [...MOCK_MOOD_FOLDERS];
}

export async function saveFolders(folders: MoodFolder[]): Promise<void> {
  await devStoreSet(FOLDERS_KEY, folders);
}

export function getUnassignedBooks(folders: MoodFolder[], allBooks: LibraryBook[]): LibraryBook[] {
  const assigned = new Set<string>();
  for (const f of folders) for (const id of f.bookIds) assigned.add(id);
  return allBooks.filter((b) => !assigned.has(b.id));
}

export async function loadRecent(): Promise<RecentMap> {
  const parsed = await devStoreGet<unknown>(RECENT_KEY);
  if (!parsed || typeof parsed !== "object") return {};
  const rec = parsed as Record<string, unknown>;
  const out: RecentMap = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function saveRecent(recent: RecentMap): Promise<void> {
  await devStoreSet(RECENT_KEY, recent);
}

export async function setRecent(folderId: string, bookId: string): Promise<void> {
  const m = await loadRecent();
  m[folderId] = bookId;
  await saveRecent(m);
}
