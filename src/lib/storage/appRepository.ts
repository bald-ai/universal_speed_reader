import { Capacitor } from "@capacitor/core";
import type { BookRepository } from "@/lib/storage/bookRepository";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";

const WEB_PERSIST_KEY = "universal_speed_reader.db.v1";

let repositoryPromise: Promise<BookRepository> | null = null;
let testOverride: BookRepository | null = null;

async function createRepository(): Promise<BookRepository> {
  if (typeof window !== "undefined" && Capacitor.isNativePlatform()) {
    try {
      const { createSqliteBookRepository } = await import("@/lib/storage/sqliteBookRepository");
      return await createSqliteBookRepository();
    } catch (error) {
      // Native SQLite initialization can fail on unsupported environments.
      // Fall back to local persistent store so the app remains usable.
      console.warn("Falling back to in-memory repository:", error);
    }
  }

  const repo = new InMemoryBookRepository({
    persistKey: typeof window !== "undefined" ? WEB_PERSIST_KEY : undefined,
  });
  await repo.init();
  return repo;
}

export async function getBookRepository(): Promise<BookRepository> {
  if (testOverride) return testOverride;
  if (!repositoryPromise) {
    repositoryPromise = createRepository().catch((error) => {
      repositoryPromise = null;
      throw error;
    });
  }
  return repositoryPromise;
}
