import { getBookRepository } from "@/lib/storage/appRepository";
import type { BookRepository } from "@/lib/storage/bookRepository";
import type {
  BookPlacement,
  LibraryFolder,
  LibraryLayout,
  LibraryLayoutItemId,
} from "@/types/libraryLayout";

export const LIBRARY_LAYOUT_STORAGE_KEY = "universal_speed_reader.library_layout.v1";
const LIBRARY_LAYOUT_SETTING_KEY = "library_layout.v1";

type PersistedLibraryLayoutV1 = {
  version: 1;
  folders: LibraryFolder[];
  placements: BookPlacement[];
};

type LibraryLayoutRepository = Pick<BookRepository, "getAppSetting" | "putAppSetting">;
type LibraryLayoutStoreOptions = {
  repository?: LibraryLayoutRepository;
};

const EMPTY_LAYOUT: LibraryLayout = {
  folders: [],
  placements: [],
};

let layoutState: LibraryLayout | null = null;
let hasHydrated = false;
let hydratePromise: Promise<void> | null = null;

function cloneLayout(layout: LibraryLayout): LibraryLayout {
  return {
    folders: layout.folders.map((folder) => ({ ...folder })),
    placements: layout.placements.map((placement) => ({ ...placement })),
  };
}

function getLocalStorageSafe(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function isParentId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLibraryFolder(value: unknown): value is LibraryFolder {
  if (!value || typeof value !== "object") return false;
  const folder = value as Partial<LibraryFolder>;
  if (typeof folder.id !== "string" || !folder.id.trim()) return false;
  if (typeof folder.label !== "string") return false;
  if (!isParentId(folder.parentId)) return false;
  if (!isFiniteNumber(folder.order)) return false;
  if (folder.icon !== undefined && typeof folder.icon !== "string") return false;
  if (folder.color !== undefined && typeof folder.color !== "string") return false;
  return true;
}

function isBookPlacement(value: unknown): value is BookPlacement {
  if (!value || typeof value !== "object") return false;
  const placement = value as Partial<BookPlacement>;
  if (typeof placement.bookId !== "string" || !placement.bookId.trim()) return false;
  if (!isParentId(placement.parentId)) return false;
  if (!isFiniteNumber(placement.order)) return false;
  return true;
}

function parentExists(foldersById: Map<string, LibraryFolder>, parentId: string | null): boolean {
  return parentId === null || foldersById.has(parentId);
}

function wouldCreateCycle(
  foldersById: Map<string, LibraryFolder>,
  folderId: string,
  parentId: string | null
): boolean {
  let current = parentId;
  const visited = new Set<string>();
  while (current) {
    if (current === folderId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = foldersById.get(current)?.parentId ?? null;
  }
  return false;
}

function normalizeOrders(layout: LibraryLayout): LibraryLayout {
  const foldersByParent = new Map<string, LibraryFolder[]>();
  const placementsByParent = new Map<string, BookPlacement[]>();

  for (const folder of layout.folders) {
    const key = folder.parentId ?? "";
    foldersByParent.set(key, [...(foldersByParent.get(key) ?? []), folder]);
  }
  for (const placement of layout.placements) {
    const key = placement.parentId ?? "";
    placementsByParent.set(key, [...(placementsByParent.get(key) ?? []), placement]);
  }

  const folders: LibraryFolder[] = [];
  for (const group of foldersByParent.values()) {
    group
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
      .forEach((folder, index) => folders.push({ ...folder, order: index }));
  }

  const placements: BookPlacement[] = [];
  for (const group of placementsByParent.values()) {
    group
      .sort((a, b) => a.order - b.order || a.bookId.localeCompare(b.bookId))
      .forEach((placement, index) => placements.push({ ...placement, order: index }));
  }

  return { folders, placements };
}

export function normalizeLibraryLayout(layout: LibraryLayout): LibraryLayout {
  const foldersById = new Map<string, LibraryFolder>();
  for (const folder of layout.folders) {
    if (!folder.id.trim() || foldersById.has(folder.id)) continue;
    foldersById.set(folder.id, {
      ...folder,
      label: folder.label.trim() || "Untitled folder",
      parentId: folder.parentId,
      order: Math.max(0, Math.floor(folder.order)),
    });
  }

  const folders = Array.from(foldersById.values()).map((folder) => {
    const parentId =
      parentExists(foldersById, folder.parentId) &&
      !wouldCreateCycle(foldersById, folder.id, folder.parentId)
        ? folder.parentId
        : null;
    return { ...folder, parentId };
  });

  const normalizedFoldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const placementsByBookId = new Map<string, BookPlacement>();
  for (const placement of layout.placements) {
    if (!placement.bookId.trim() || placementsByBookId.has(placement.bookId)) continue;
    const parentId = parentExists(normalizedFoldersById, placement.parentId)
      ? placement.parentId
      : null;
    placementsByBookId.set(placement.bookId, {
      bookId: placement.bookId,
      parentId,
      order: Math.max(0, Math.floor(placement.order)),
    });
  }

  return normalizeOrders({
    folders,
    placements: Array.from(placementsByBookId.values()),
  });
}

function parsePersistedState(raw: unknown): PersistedLibraryLayoutV1 | null {
  try {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<PersistedLibraryLayoutV1>;
    if (record.version !== 1) return null;
    if (!Array.isArray(record.folders) || !record.folders.every(isLibraryFolder)) return null;
    if (!Array.isArray(record.placements) || !record.placements.every(isBookPlacement)) return null;
    const layout = normalizeLibraryLayout({
      folders: record.folders,
      placements: record.placements,
    });
    return {
      version: 1,
      folders: layout.folders,
      placements: layout.placements,
    };
  } catch {
    return null;
  }
}

function toPersistedState(): PersistedLibraryLayoutV1 {
  const layout = normalizeLibraryLayout(layoutState ?? EMPTY_LAYOUT);
  return {
    version: 1,
    folders: layout.folders,
    placements: layout.placements,
  };
}

async function resolveRepository(
  repository?: LibraryLayoutRepository
): Promise<LibraryLayoutRepository> {
  return repository ?? getBookRepository();
}

async function loadFromRepository(
  repository?: LibraryLayoutRepository
): Promise<PersistedLibraryLayoutV1 | null> {
  try {
    const activeRepository = await resolveRepository(repository);
    const value = await activeRepository.getAppSetting<unknown>(LIBRARY_LAYOUT_SETTING_KEY);
    return parsePersistedState(value);
  } catch (error) {
    console.warn("Failed to load library layout from repository:", error);
    return null;
  }
}

async function persistToRepository(
  state: PersistedLibraryLayoutV1,
  repository?: LibraryLayoutRepository
): Promise<void> {
  try {
    const activeRepository = await resolveRepository(repository);
    await activeRepository.putAppSetting(LIBRARY_LAYOUT_SETTING_KEY, state);
  } catch (error) {
    console.warn("Failed to persist library layout to repository:", error);
  }
}

function loadFromLocalStorage(): { state: PersistedLibraryLayoutV1 | null; hasRawValue: boolean } {
  const storage = getLocalStorageSafe();
  if (!storage) return { state: null, hasRawValue: false };
  const raw = storage.getItem(LIBRARY_LAYOUT_STORAGE_KEY);
  if (!raw) return { state: null, hasRawValue: false };
  return {
    state: parsePersistedState(raw),
    hasRawValue: true,
  };
}

function persistToLocalStorage(state: PersistedLibraryLayoutV1): void {
  const storage = getLocalStorageSafe();
  if (!storage) return;
  try {
    storage.setItem(LIBRARY_LAYOUT_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("Failed to persist library layout:", error);
  }
}

async function hydrateOnce(options?: LibraryLayoutStoreOptions): Promise<void> {
  if (hasHydrated) return;
  if (hydratePromise) {
    await hydratePromise;
    return;
  }

  hydratePromise = (async () => {
    const localStorageState = loadFromLocalStorage();
    if (localStorageState.state) {
      layoutState = {
        folders: localStorageState.state.folders,
        placements: localStorageState.state.placements,
      };
      await persistToRepository(localStorageState.state, options?.repository);
      hasHydrated = true;
      return;
    }
    if (localStorageState.hasRawValue) {
      console.warn("Failed to parse library layout from localStorage, falling back to repository");
    }

    const fromRepository = await loadFromRepository(options?.repository);
    if (fromRepository) {
      layoutState = {
        folders: fromRepository.folders,
        placements: fromRepository.placements,
      };
      persistToLocalStorage(fromRepository);
      hasHydrated = true;
      return;
    }

    layoutState = cloneLayout(EMPTY_LAYOUT);
    hasHydrated = true;
  })();

  try {
    await hydratePromise;
  } finally {
    hydratePromise = null;
  }
}

async function persistState(options?: LibraryLayoutStoreOptions): Promise<void> {
  const payload = toPersistedState();
  persistToLocalStorage(payload);
  await persistToRepository(payload, options?.repository);
}

export async function loadLibraryLayout(options?: LibraryLayoutStoreOptions): Promise<LibraryLayout> {
  await hydrateOnce(options);
  if (!layoutState) {
    layoutState = cloneLayout(EMPTY_LAYOUT);
  }
  return cloneLayout(layoutState);
}

export async function saveLibraryLayout(
  layout: LibraryLayout,
  options?: LibraryLayoutStoreOptions
): Promise<void> {
  await hydrateOnce(options);
  layoutState = normalizeLibraryLayout(layout);
  await persistState(options);
}

export async function updateLibraryLayout(
  mutate: (current: LibraryLayout) => LibraryLayout,
  options?: LibraryLayoutStoreOptions
): Promise<LibraryLayout> {
  const current = await loadLibraryLayout(options);
  const next = normalizeLibraryLayout(mutate(current));
  await saveLibraryLayout(next, options);
  return next;
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function nextOrderForParent(layout: LibraryLayout, parentId: string | null, kind: "folder" | "book"): number {
  const items = kind === "folder" ? layout.folders : layout.placements;
  return items.filter((item) => item.parentId === parentId).length;
}

export function addLibraryFolder(
  layout: LibraryLayout,
  input: {
    id?: string;
    label: string;
    parentId?: string | null;
    icon?: string;
    color?: string;
    insertAt?: "top" | "bottom";
  }
): { layout: LibraryLayout; folder: LibraryFolder } {
  const normalized = normalizeLibraryLayout(layout);
  const foldersById = new Map(normalized.folders.map((folder) => [folder.id, folder]));
  const id = input.id ?? createId("library-folder");
  const parentId = parentExists(foldersById, input.parentId ?? null) ? input.parentId ?? null : null;
  const insertAt = input.insertAt ?? "bottom";
  const folder: LibraryFolder = {
    id,
    label: input.label.trim() || "New folder",
    icon: input.icon,
    color: input.color,
    parentId,
    order: insertAt === "top" ? 0 : nextOrderForParent(normalized, parentId, "folder"),
  };
  const existingFolders = normalized.folders
    .filter((existing) => existing.id !== id)
    .map((existing) =>
      insertAt === "top" && existing.parentId === parentId
        ? { ...existing, order: existing.order + 1 }
        : existing
    );
  return {
    folder,
    layout: normalizeLibraryLayout({
      ...normalized,
      folders: [...existingFolders, folder],
    }),
  };
}

export function updateLibraryFolder(
  layout: LibraryLayout,
  folderId: string,
  patch: Pick<Partial<LibraryFolder>, "label" | "icon" | "color">
): LibraryLayout {
  return normalizeLibraryLayout({
    ...layout,
    folders: layout.folders.map((folder) => {
      if (folder.id !== folderId) return folder;
      return {
        ...folder,
        label: patch.label !== undefined ? patch.label.trim() || folder.label : folder.label,
        icon: patch.icon,
        color: patch.color ?? folder.color,
      };
    }),
  });
}

export function moveLibraryFolder(
  layout: LibraryLayout,
  folderId: string,
  parentId: string | null
): LibraryLayout {
  const normalized = normalizeLibraryLayout(layout);
  const foldersById = new Map(normalized.folders.map((folder) => [folder.id, folder]));
  const target = foldersById.get(folderId);
  if (!target) return normalized;
  if (!parentExists(foldersById, parentId) || wouldCreateCycle(foldersById, folderId, parentId)) {
    return normalized;
  }
  return normalizeLibraryLayout({
    ...normalized,
    folders: normalized.folders.map((folder) =>
      folder.id === folderId
        ? { ...folder, parentId, order: nextOrderForParent(normalized, parentId, "folder") }
        : folder
    ),
  });
}

export function moveBookToFolder(
  layout: LibraryLayout,
  bookId: string,
  parentId: string | null
): LibraryLayout {
  if (!bookId.trim()) return normalizeLibraryLayout(layout);
  const normalized = normalizeLibraryLayout(layout);
  const foldersById = new Map(normalized.folders.map((folder) => [folder.id, folder]));
  const nextParentId = parentExists(foldersById, parentId) ? parentId : null;
  const existingIndex = normalized.placements.findIndex((placement) => placement.bookId === bookId);
  const placement: BookPlacement = {
    bookId,
    parentId: nextParentId,
    order: nextOrderForParent(normalized, nextParentId, "book"),
  };
  const placements =
    existingIndex === -1
      ? [...normalized.placements, placement]
      : normalized.placements.map((existing, index) => (index === existingIndex ? placement : existing));
  return normalizeLibraryLayout({ ...normalized, placements });
}

export function removeBookFromLibraryLayout(layout: LibraryLayout, bookId: string): LibraryLayout {
  return normalizeLibraryLayout({
    ...layout,
    placements: layout.placements.filter((placement) => placement.bookId !== bookId),
  });
}

function collectDescendantFolderIds(layout: LibraryLayout, folderId: string): Set<string> {
  const ids = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of layout.folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function getFolderDescendantIds(layout: LibraryLayout, folderId: string): string[] {
  return Array.from(collectDescendantFolderIds(normalizeLibraryLayout(layout), folderId));
}

export function getBookIdsInFolderSubtree(layout: LibraryLayout, folderId: string): string[] {
  const normalized = normalizeLibraryLayout(layout);
  const folderIds = collectDescendantFolderIds(normalized, folderId);
  return normalized.placements
    .filter((placement) => placement.parentId !== null && folderIds.has(placement.parentId))
    .map((placement) => placement.bookId);
}

export function deleteLibraryFolderOnly(layout: LibraryLayout, folderId: string): LibraryLayout {
  const normalized = normalizeLibraryLayout(layout);
  const folder = normalized.folders.find((candidate) => candidate.id === folderId);
  if (!folder) return normalized;
  const parentId = folder.parentId;
  return normalizeLibraryLayout({
    folders: normalized.folders
      .filter((candidate) => candidate.id !== folderId)
      .map((candidate) =>
        candidate.parentId === folderId
          ? { ...candidate, parentId, order: nextOrderForParent(normalized, parentId, "folder") }
          : candidate
      ),
    placements: normalized.placements.map((placement) =>
      placement.parentId === folderId
        ? { ...placement, parentId, order: nextOrderForParent(normalized, parentId, "book") }
        : placement
    ),
  });
}

export function deleteLibraryFolderWithContents(
  layout: LibraryLayout,
  folderId: string
): { layout: LibraryLayout; removedBookIds: string[] } {
  const normalized = normalizeLibraryLayout(layout);
  const folderIds = collectDescendantFolderIds(normalized, folderId);
  const removedBookIds = normalized.placements
    .filter((placement) => placement.parentId !== null && folderIds.has(placement.parentId))
    .map((placement) => placement.bookId);
  return {
    removedBookIds,
    layout: normalizeLibraryLayout({
      folders: normalized.folders.filter((folder) => !folderIds.has(folder.id)),
      placements: normalized.placements.filter(
        (placement) => placement.parentId === null || !folderIds.has(placement.parentId)
      ),
    }),
  };
}

export function reorderLibraryLevel(
  layout: LibraryLayout,
  parentId: string | null,
  orderedItems: LibraryLayoutItemId[]
): LibraryLayout {
  const normalized = normalizeLibraryLayout(layout);
  const foldersById = new Map(normalized.folders.map((folder) => [folder.id, folder]));
  if (!parentExists(foldersById, parentId)) return normalized;

  const folderOrders = new Map<string, number>();
  const bookOrders = new Map<string, number>();
  for (const item of orderedItems) {
    if (item.kind === "folder") {
      folderOrders.set(item.id, folderOrders.size);
    } else {
      bookOrders.set(item.id, bookOrders.size);
    }
  }

  const folderSet = new Set(folderOrders.keys());
  const bookSet = new Set(bookOrders.keys());

  const folders = normalized.folders.map((folder) => {
    const nextOrder = folderOrders.get(folder.id);
    if (nextOrder === undefined) return folder;
    if (wouldCreateCycle(foldersById, folder.id, parentId)) return folder;
    return { ...folder, parentId, order: nextOrder };
  });

  const placements = normalized.placements
    .filter((placement) => !bookSet.has(placement.bookId))
    .concat(
      Array.from(bookOrders.entries()).map(([bookId, order]) => ({
        bookId,
        parentId,
        order,
      }))
    );

  const movedFolders = normalized.folders.filter((folder) => folderSet.has(folder.id));
  if (movedFolders.length !== folderSet.size) return normalized;

  return normalizeLibraryLayout({ folders, placements });
}

export function getParentIdForBook(layout: LibraryLayout, bookId: string): string | null {
  return normalizeLibraryLayout(layout).placements.find((placement) => placement.bookId === bookId)?.parentId ?? null;
}

export function getFolderPathLabels(layout: LibraryLayout, folderId: string | null): string[] {
  if (folderId === null) return [];
  const normalized = normalizeLibraryLayout(layout);
  const foldersById = new Map(normalized.folders.map((folder) => [folder.id, folder]));
  const labels: string[] = [];
  const visited = new Set<string>();
  let current: string | null = folderId;
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const folder = foldersById.get(current);
    if (!folder) break;
    labels.unshift(folder.label);
    current = folder.parentId;
  }
  return labels;
}

export function __resetLibraryLayoutStoreForTests(): void {
  layoutState = null;
  hasHydrated = false;
  hydratePromise = null;
}
