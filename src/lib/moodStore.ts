import type { LibraryBook, MoodFolder } from "@/types/book";
import { MOCK_MOOD_FOLDERS } from "@/lib/mockMoodFolders";

const FOLDERS_KEY = "speedreader:mood-folders";
const RECENT_KEY = "speedreader:mood-recent";

type RecentMap = Record<string, string>;

const safeParseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

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

export function loadFolders(): MoodFolder[] {
  if (typeof window === "undefined") return [...MOCK_MOOD_FOLDERS];
  const parsed = safeParseJson<unknown>(window.localStorage.getItem(FOLDERS_KEY));
  if (Array.isArray(parsed) && parsed.every(isMoodFolder)) return parsed;

  // First load, or malformed data: initialize with mock folders.
  saveFolders(MOCK_MOOD_FOLDERS);
  return [...MOCK_MOOD_FOLDERS];
}

export function saveFolders(folders: MoodFolder[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    // ignore quota / serialization
  }
}

export function getUnassignedBooks(folders: MoodFolder[], allBooks: LibraryBook[]): LibraryBook[] {
  const assigned = new Set<string>();
  for (const f of folders) for (const id of f.bookIds) assigned.add(id);
  return allBooks.filter((b) => !assigned.has(b.id));
}

export function loadRecent(): RecentMap {
  if (typeof window === "undefined") return {};
  const parsed = safeParseJson<unknown>(window.localStorage.getItem(RECENT_KEY));
  if (!parsed || typeof parsed !== "object") return {};
  const rec = parsed as Record<string, unknown>;
  const out: RecentMap = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function saveRecent(recent: RecentMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // ignore
  }
}

export function setRecent(folderId: string, bookId: string): void {
  const m = loadRecent();
  m[folderId] = bookId;
  saveRecent(m);
}

