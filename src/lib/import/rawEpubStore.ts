/**
 * Original source file retained for retries and on-demand media. Supports EPUB and PDF.
 * Ownership: bytes handed to `store()` / `storeRawBook()` are owned by the store and must
 * not be mutated or detached by callers afterward.
 */
export type RawBookRecord = {
  bookId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Uint8Array;
  storedAt: number;
};

/** Backward-compatible alias while the old EPUB-only call sites migrate. */
export type RawEpubRecord = RawBookRecord;

const DB_NAME = "universal_speed_reader_raw_epubs";
const STORE_NAME = "raw_epubs";
const MEMORY_CACHE_LIMIT = 2;

function cloneRecord(record: RawBookRecord): RawBookRecord {
  return {
    ...record,
    bytes: new Uint8Array(record.bytes),
  };
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return null;
}

function toRecord(value: unknown): RawBookRecord | null {
  if (!isObject(value)) return null;
  const {
    bookId,
    fileName,
    mimeType,
    sizeBytes,
    bytes,
    storedAt,
  } = value;

  if (
    typeof bookId !== "string" ||
    typeof fileName !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    typeof storedAt !== "number"
  ) {
    return null;
  }

  const normalizedBytes = toUint8Array(bytes);
  if (!normalizedBytes) return null;

  return {
    bookId,
    fileName,
    mimeType,
    sizeBytes,
    storedAt,
    bytes: normalizedBytes,
  };
}

class IndexedDbRawStore {
  private readonly memory = new Map<string, RawEpubRecord>();
  private dbPromise: Promise<IDBDatabase> | null = null;

  async put(record: RawBookRecord): Promise<void> {
    // Callers transfer ownership of `record.bytes`; keep the same view in the
    // memory cache (no clone). IndexedDB structured-clone still copies once.
    this.memory.set(record.bookId, record);
    this.pruneMemoryCache();

    if (!hasIndexedDb()) return;
    const db = await this.getDb();
    const { bytes } = record;
    const isExactView =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    // Exact views: pass the buffer and let structured clone copy once.
    // Subarray views: slice so we do not persist the entire underlying buffer.
    const idbBytes = isExactView
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.put({
        ...record,
        bytes: idbBytes,
      });
      request.onerror = () => reject(request.error ?? new Error("Failed to write raw EPUB"));
      request.onsuccess = () => resolve();
    });
  }

  async get(bookId: string): Promise<RawBookRecord | null> {
    const inMemory = this.memory.get(bookId);
    if (inMemory) return cloneRecord(inMemory);

    if (!hasIndexedDb()) return null;
    const db = await this.getDb();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(bookId);
      request.onerror = () => reject(request.error ?? new Error("Failed to read raw EPUB"));
      request.onsuccess = () => resolve(request.result);
    });

    if (!isObject(raw)) return null;
    const bytesValue = toUint8Array(raw.bytes);
    if (!bytesValue) return null;

    const record = toRecord({
      ...raw,
      bytes: bytesValue,
    });
    if (!record) return null;

    this.memory.set(record.bookId, record);
    this.pruneMemoryCache();
    return cloneRecord(record);
  }

  async delete(bookId: string): Promise<void> {
    this.memory.delete(bookId);

    if (!hasIndexedDb()) return;
    const db = await this.getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(bookId);
      request.onerror = () => reject(request.error ?? new Error("Failed to delete raw EPUB"));
      request.onsuccess = () => resolve();
    });
  }

  async clear(): Promise<void> {
    this.memory.clear();
    if (!hasIndexedDb()) return;
    const db = await this.getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onerror = () => reject(request.error ?? new Error("Failed to clear stored source books"));
      request.onsuccess = () => resolve();
    });
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "bookId" });
          }
        };
        request.onerror = () => reject(request.error ?? new Error("Failed to open raw EPUB store"));
        request.onsuccess = () => resolve(request.result);
      });
    }
    return this.dbPromise;
  }

  private pruneMemoryCache(): void {
    // When IndexedDB is unavailable, in-memory data is the only retry source.
    // Keep all records for the current runtime session in that environment.
    if (!hasIndexedDb()) return;
    if (this.memory.size <= MEMORY_CACHE_LIMIT) return;
    const sorted = [...this.memory.values()].sort((a, b) => b.storedAt - a.storedAt);
    this.memory.clear();
    for (const record of sorted.slice(0, MEMORY_CACHE_LIMIT)) {
      this.memory.set(record.bookId, record);
    }
  }
}

const singleton = new IndexedDbRawStore();

export async function storeRawEpub(record: RawEpubRecord): Promise<void> {
  await singleton.put(record);
}

export async function loadRawEpub(bookId: string): Promise<RawEpubRecord | null> {
  return singleton.get(bookId);
}

export async function deleteRawEpub(bookId: string): Promise<void> {
  await singleton.delete(bookId);
}

export async function storeRawBook(record: RawBookRecord): Promise<void> {
  await singleton.put(record);
}

export async function loadRawBook(bookId: string): Promise<RawBookRecord | null> {
  return singleton.get(bookId);
}

export async function deleteRawBook(bookId: string): Promise<void> {
  await singleton.delete(bookId);
}

export async function clearRawBooks(): Promise<void> {
  await singleton.clear();
}
