import { getBookRepository } from "@/lib/storage/appRepository";
import type { BookRepository } from "@/lib/storage/bookRepository";
import type { LibraryBook, Mood } from "@/types/book";

type RecentMap = Record<string, string>;

export const MOOD_STORE_STORAGE_KEY = "universal_speed_reader.mood.v1";
const MOOD_STORE_SETTING_KEY = "mood_store.v1";

type PersistedMoodStoreV1 = {
  version: 1;
  folders: Mood[];
  recent: RecentMap;
};

type MoodStoreRepository = Pick<BookRepository, "getAppSetting" | "putAppSetting">;
type MoodStoreOptions = {
  repository?: MoodStoreRepository;
};

let foldersState: Mood[] | null = null;
let recentState: RecentMap = {};
let hasHydrated = false;
let hydratePromise: Promise<void> | null = null;

function cloneFolders(folders: Mood[]): Mood[] {
  return folders.map((folder) => ({
    id: folder.id,
    label: folder.label,
    icon: folder.icon,
    color: folder.color,
    imageUrl: folder.imageUrl,
    bookIds: [...folder.bookIds],
  }));
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

function isMood(value: unknown): value is Mood {
  if (!value || typeof value !== "object") return false;
  const folder = value as Partial<Mood>;
  if (typeof folder.id !== "string") return false;
  if (typeof folder.label !== "string") return false;
  if (!isStringArray(folder.bookIds)) return false;
  if (folder.icon !== undefined && typeof folder.icon !== "string") return false;
  if (folder.color !== undefined && typeof folder.color !== "string") return false;
  if (folder.imageUrl !== undefined && typeof folder.imageUrl !== "string") return false;
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
    if (!Array.isArray(record.folders) || !record.folders.every(isMood)) return null;
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

async function resolveRepository(
  repository?: MoodStoreRepository
): Promise<MoodStoreRepository> {
  return repository ?? getBookRepository();
}

async function loadFromRepository(repository?: MoodStoreRepository): Promise<PersistedMoodStoreV1 | null> {
  try {
    const activeRepository = await resolveRepository(repository);
    const value = await activeRepository.getAppSetting<unknown>(MOOD_STORE_SETTING_KEY);
    return parsePersistedState(value);
  } catch (error) {
    console.warn("Failed to load mood store from repository:", error);
    return null;
  }
}

async function persistToRepository(
  state: PersistedMoodStoreV1,
  repository?: MoodStoreRepository
): Promise<void> {
  try {
    const activeRepository = await resolveRepository(repository);
    await activeRepository.putAppSetting(MOOD_STORE_SETTING_KEY, state);
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

async function hydrateOnce(options?: MoodStoreOptions): Promise<void> {
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
      await persistToRepository(localStorageState.state, options?.repository);
      hasHydrated = true;
      return;
    }
    if (localStorageState.hasRawValue) {
      console.warn("Failed to parse mood store from localStorage, falling back to repository");
    }

    const fromRepository = await loadFromRepository(options?.repository);
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

async function persistState(options?: MoodStoreOptions): Promise<void> {
  const payload = toPersistedState();
  persistToLocalStorage(payload);
  await persistToRepository(payload, options?.repository);
}

export async function loadMoods(options?: MoodStoreOptions): Promise<Mood[]> {
  await hydrateOnce(options);
  if (!foldersState) {
    foldersState = [];
  }
  return cloneFolders(foldersState);
}

export async function saveMoods(folders: Mood[], options?: MoodStoreOptions): Promise<void> {
  await hydrateOnce(options);
  foldersState = cloneFolders(folders);
  await persistState(options);
}

export function getUnassignedBooks(folders: Mood[], allBooks: LibraryBook[]): LibraryBook[] {
  const assigned = new Set<string>();
  for (const folder of folders) {
    for (const id of folder.bookIds) assigned.add(id);
  }
  return allBooks.filter((book) => !assigned.has(book.id));
}

export function getMoodColorForBook(folders: Mood[], bookId: string): string | undefined {
  for (const folder of folders) {
    if (folder.bookIds.includes(bookId)) {
      return folder.color ?? "violet";
    }
  }
  return undefined;
}

export function addBookIdsToMood(folders: Mood[], folderId: string, bookIds: string[]): Mood[] {
  const uniqueBookIds = Array.from(new Set(bookIds.filter((bookId) => bookId.trim())));
  if (uniqueBookIds.length === 0) return folders;

  let changed = false;
  const next = folders.map((folder) => {
    if (folder.id !== folderId) return folder;
    const merged = Array.from(new Set([...folder.bookIds, ...uniqueBookIds]));
    if (merged.length === folder.bookIds.length) return folder;
    changed = true;
    return { ...folder, bookIds: merged };
  });

  return changed ? next : folders;
}

export async function loadRecent(options?: MoodStoreOptions): Promise<RecentMap> {
  await hydrateOnce(options);
  return { ...recentState };
}

export async function saveRecent(recent: RecentMap, options?: MoodStoreOptions): Promise<void> {
  await hydrateOnce(options);
  recentState = { ...recent };
  await persistState(options);
}

export async function setRecent(
  folderId: string,
  bookId: string,
  options?: MoodStoreOptions
): Promise<void> {
  await hydrateOnce(options);
  recentState = { ...recentState, [folderId]: bookId };
  await persistState(options);
}

export async function removeBookReferences(bookId: string, options?: MoodStoreOptions): Promise<void> {
  const folders = await loadMoods(options);
  const cleanedFolders = folders.map((folder) => ({
    ...folder,
    bookIds: folder.bookIds.filter((id) => id !== bookId),
  }));
  await saveMoods(cleanedFolders, options);

  const recent = await loadRecent(options);
  let changed = false;
  for (const folderId of Object.keys(recent)) {
    if (recent[folderId] === bookId) {
      delete recent[folderId];
      changed = true;
    }
  }

  if (changed) {
    await saveRecent(recent, options);
  }
}

export function __resetMoodStoreForTests(): void {
  foldersState = null;
  recentState = {};
  hasHydrated = false;
  hydratePromise = null;
}
