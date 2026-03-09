import { getBookRepository } from "@/lib/storage/appRepository";
import type { LibraryBook, MoodFolder } from "@/types/book";

type RecentMap = Record<string, string>;

export const MOOD_STORE_STORAGE_KEY = "universal_speed_reader.mood.v1";
const MOOD_STORE_SETTING_KEY = "mood_store.v1";

type PersistedMoodStoreV1 = {
  version: 1;
  folders: MoodFolder[];
  recent: RecentMap;
};

let foldersState: MoodFolder[] | null = null;
let recentState: RecentMap = {};
let hasHydrated = false;
let hydratePromise: Promise<void> | null = null;

function cloneFolders(folders: MoodFolder[]): MoodFolder[] {
  return folders.map((f) => ({ ...f, bookIds: [...f.bookIds] }));
}

function getLocalStorageSafe(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isMoodFolder(value: unknown): value is MoodFolder {
  if (!value || typeof value !== "object") return false;
  const folder = value as Partial<MoodFolder>;
  if (typeof folder.id !== "string") return false;
  if (typeof folder.label !== "string") return false;
  if (!isStringArray(folder.bookIds)) return false;
  if (folder.icon !== undefined && typeof folder.icon !== "string") return false;
  if (folder.color !== undefined && typeof folder.color !== "string") return false;
  if (folder.imageUrl !== undefined && typeof folder.imageUrl !== "string") return false;
  if (folder.isMock !== undefined && typeof folder.isMock !== "boolean") return false;
  return true;
}

function isRecentMap(value: unknown): value is RecentMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function parsePersistedState(raw: unknown): PersistedMoodStoreV1 | null {
  try {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<PersistedMoodStoreV1>;
    if (record.version !== 1) return null;
    if (!Array.isArray(record.folders) || !record.folders.every(isMoodFolder)) return null;
    if (!isRecentMap(record.recent)) return null;
    return {
      version: 1,
      folders: cloneFolders(record.folders),
      recent: { ...record.recent },
    };
  } catch {
    return null;
  }
}

function toPersistedState(): PersistedMoodStoreV1 {
  return {
    version: 1,
    folders: cloneFolders(foldersState ?? []),
    recent: { ...recentState },
  };
}

async function loadFromRepository(): Promise<PersistedMoodStoreV1 | null> {
  try {
    const repository = await getBookRepository();
    const value = await repository.getAppSetting<unknown>(MOOD_STORE_SETTING_KEY);
    return parsePersistedState(value);
  } catch (error) {
    console.warn("Failed to load mood store from repository:", error);
    return null;
  }
}

async function persistToRepository(state: PersistedMoodStoreV1): Promise<void> {
  try {
    const repository = await getBookRepository();
    await repository.putAppSetting(MOOD_STORE_SETTING_KEY, state);
  } catch (error) {
    console.warn("Failed to persist mood store to repository:", error);
  }
}

function loadFromLocalStorage(): { state: PersistedMoodStoreV1 | null; hasRawValue: boolean } {
  const storage = getLocalStorageSafe();
  if (!storage) return { state: null, hasRawValue: false };
  const raw = storage.getItem(MOOD_STORE_STORAGE_KEY);
  if (!raw) return { state: null, hasRawValue: false };
  return {
    state: parsePersistedState(raw),
    hasRawValue: true,
  };
}

function persistToLocalStorage(state: PersistedMoodStoreV1): void {
  const storage = getLocalStorageSafe();
  if (!storage) return;
  try {
    storage.setItem(MOOD_STORE_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("Failed to persist mood store:", error);
  }
}

async function hydrateOnce(): Promise<void> {
  if (hasHydrated) return;
  if (hydratePromise) {
    await hydratePromise;
    return;
  }

  hydratePromise = (async () => {
    const localStorageState = loadFromLocalStorage();
    if (localStorageState.state) {
      foldersState = cloneFolders(localStorageState.state.folders);
      recentState = { ...localStorageState.state.recent };
      await persistToRepository(localStorageState.state);
      hasHydrated = true;
      return;
    }
    if (localStorageState.hasRawValue) {
      console.warn("Failed to parse mood store from localStorage, falling back to repository");
    }

    const fromRepository = await loadFromRepository();
    if (fromRepository) {
      foldersState = cloneFolders(fromRepository.folders);
      recentState = { ...fromRepository.recent };
      persistToLocalStorage(fromRepository);
      hasHydrated = true;
      return;
    }

    foldersState = [];
    recentState = {};
    hasHydrated = true;
  })();

  try {
    await hydratePromise;
  } finally {
    hydratePromise = null;
  }
}

async function persistState(): Promise<void> {
  const payload = toPersistedState();
  persistToLocalStorage(payload);
  await persistToRepository(payload);
}

export async function loadFolders(): Promise<MoodFolder[]> {
  await hydrateOnce();
  if (!foldersState) {
    foldersState = [];
  }
  return cloneFolders(foldersState);
}

export async function saveFolders(folders: MoodFolder[]): Promise<void> {
  await hydrateOnce();
  foldersState = cloneFolders(folders);
  await persistState();
}

export function getUnassignedBooks(folders: MoodFolder[], allBooks: LibraryBook[]): LibraryBook[] {
  const assigned = new Set<string>();
  for (const folder of folders) {
    for (const id of folder.bookIds) assigned.add(id);
  }
  return allBooks.filter((book) => !assigned.has(book.id));
}

export function getFolderColorForBook(folders: MoodFolder[], bookId: string): string | undefined {
  for (const folder of folders) {
    if (folder.bookIds.includes(bookId)) {
      return folder.color ?? "violet";
    }
  }
  return undefined;
}

export async function loadRecent(): Promise<RecentMap> {
  await hydrateOnce();
  return { ...recentState };
}

export async function saveRecent(recent: RecentMap): Promise<void> {
  await hydrateOnce();
  recentState = { ...recent };
  await persistState();
}

export async function setRecent(folderId: string, bookId: string): Promise<void> {
  await hydrateOnce();
  recentState = { ...recentState, [folderId]: bookId };
  await persistState();
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

export function __resetMoodStoreForTests(): void {
  foldersState = null;
  recentState = {};
  hasHydrated = false;
  hydratePromise = null;
}
