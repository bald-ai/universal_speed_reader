
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
import type { BookRepository } from "@/lib/storage/bookRepository";
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

type BookLoadResult =
  | { kind: "ready"; book: Book }
  | { kind: "processing" }
  | { kind: "error"; message: string };

function isProcessingStatus(status: ProcessingStatus): boolean {
  return (
    status === "queued" ||
    status === "validating" ||
    status === "extracting_metadata" ||
    status === "extracting_text" ||
    status === "building_chapters"
  );
}

async function resolveBookLoadResult(
  repository: Pick<BookRepository, "getReadableBook" | "getBook">,
  bookId: string
): Promise<BookLoadResult> {
  const readable = await repository.getReadableBook(bookId);
  if (readable) {
    return {
      kind: "ready",
      book: readable.book,
    };
  }

  const metadata = await repository.getBook(bookId);
  if (!metadata) {
    return {
      kind: "error",
      message: "Book not found",
    };
  }

  if (isProcessingStatus(metadata.processing_status)) {
    return {
      kind: "processing",
    };
  }

  if (metadata.processing_status === "failed") {
    return {
      kind: "error",
      message: metadata.processing_error ?? "Import failed",
    };
  }

  return {
    kind: "error",
    message: "Book content is unavailable",
  };
}

export function BookProvider(props: ProviderProps) {
  const { bookId, children } = props;
  const [book, setBook] = useState<Book | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimeoutId: number | null = null;

    async function loadBook() {
      setIsLoading(true);
      setError(null);
      let shouldSetLoaded = true;

      try {
        const repo = await getBookRepository();
        const result = await resolveBookLoadResult(repo, bookId);

        if (!cancelled) {
          if (result.kind === "processing") {
            setBook(null);
            setIsLoading(true);
            shouldSetLoaded = false;
            retryTimeoutId = window.setTimeout(() => {
              void loadBook();
            }, 450);
            return;
          }

          if (result.kind === "ready") {
            setBook(result.book);
            if (typeof window !== "undefined") {
              window.setTimeout(() => {
                if (!cancelled) {
                  primeBookTokenCache(result.book);
                }
              }, 0);
            }
          } else {
            setError(result.message);
            setBook(null);
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

export const __bookContextInternals = {
  isProcessingStatus,
  resolveBookLoadResult,
};
