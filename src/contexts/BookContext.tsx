"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import type { Book } from "@/types/book";
import { primeBookTokenCache } from "@/lib/utils/tokenCache";
import { getBookRepository } from "@/lib/storage/appRepository";
import type { ProcessingStatus } from "@/types/storage";

type BookContextValue = {
  book: Book | null;
  isLoading: boolean;
  error: string | null;
};

const BookContext = createContext<BookContextValue | undefined>(undefined);

type ProviderProps = {
  bookId: string;
  children: ReactNode;
};

export function BookProvider(props: ProviderProps) {
  const { bookId, children } = props;
  const [book, setBook] = useState<Book | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimeoutId: number | null = null;

    const isProcessingStatus = (status: ProcessingStatus) =>
      status === "queued" ||
      status === "validating" ||
      status === "extracting_metadata" ||
      status === "extracting_text" ||
      status === "building_chapters";

    async function loadBook() {
      setIsLoading(true);
      setError(null);
      let shouldSetLoaded = true;

      try {
        const repo = await getBookRepository();
        const readable = await repo.getReadableBook(bookId);

        if (!readable) {
          const metadata = await repo.getBook(bookId);
          if (!metadata) {
            throw new Error("Book not found");
          }
          if (isProcessingStatus(metadata.processing_status)) {
            if (!cancelled) {
              setBook(null);
              setIsLoading(true);
              shouldSetLoaded = false;
              retryTimeoutId = window.setTimeout(() => {
                void loadBook();
              }, 450);
            }
            return;
          }
          if (metadata.processing_status === "failed") {
            throw new Error(metadata.processing_error ?? "Import failed");
          }
          throw new Error("Book content is unavailable");
        }

        const parsed: Book = readable.book;

        if (!cancelled) {
          setBook(parsed);
          if (typeof window !== "undefined") {
            window.setTimeout(() => {
              if (!cancelled) {
                primeBookTokenCache(parsed);
              }
            }, 0);
          }
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setError(message);
          setBook(null);
        }
      } finally {
        if (!cancelled && shouldSetLoaded) {
          setIsLoading(false);
        }
      }
    }

    loadBook();

    return () => {
      cancelled = true;
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [bookId]);

  const value = useMemo(
    () => ({
      book,
      isLoading,
      error,
    }),
    [book, isLoading, error]
  );

  return (
    <BookContext.Provider value={value}>
      {children}
    </BookContext.Provider>
  );
}

export function useBook(): BookContextValue {
  const ctx = useContext(BookContext);
  if (!ctx) {
    throw new Error("useBook must be used within a BookProvider");
  }
  return ctx;
}
