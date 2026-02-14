import { useEffect, useMemo, useState, memo } from "react";
import { useLocation } from "wouter";
import BookCard from "@/components/library/BookCard";
import MoodView from "@/components/library/MoodView";
import { motion } from "framer-motion";
import { isNativeTtsAvailable } from "@/lib/nativeTts";
import type { LibraryBook } from "@/types/book";
import { MOCK_LIBRARY_BOOKS } from "@/lib/mockLibraryBooks"; // MOCK DATA — remove when real upload is implemented.

const BackgroundDecoration = memo(function BackgroundDecoration() {
  return (
    <>
      <div className="absolute inset-0 bg-gradient-to-b from-neutral-950 via-neutral-900/20 to-neutral-950 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-violet-500/5 rounded-full blur-3xl pointer-events-none" />
    </>
  );
});

const BOOK_ID = "test";

export default function Home() {
  const [, setLocation] = useLocation();
  const [view, setView] = useState<"mood" | "library">("mood");
  const [ttsAvailable, setTtsAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const available = await isNativeTtsAvailable();
      if (!cancelled) setTtsAvailable(available);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const realLibraryBook: LibraryBook = useMemo(
    () => ({
      id: BOOK_ID,
      title: "Pride and Prejudice (Ch 1-2)",
      author: "Jane Austen",
      genre: "Romance",
      description: "Real bundled sample book. Native Android TTS is used directly from reading position.",
    }),
    []
  );

  const libraryBooks: LibraryBook[] = useMemo(
    () => [realLibraryBook, ...MOCK_LIBRARY_BOOKS],
    [realLibraryBook]
  );

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-8 bg-neutral-950 text-neutral-100 relative overflow-hidden">
      <BackgroundDecoration />

      <div className="w-full max-w-md space-y-8 relative z-10">
        {/* Header */}
        <motion.header
          className="text-center mb-2"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 border border-violet-500/20 mb-6"
          >
            <svg
              className="w-8 h-8 text-violet-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          </motion.div>

          <motion.h1
            className="text-4xl font-bold tracking-tight bg-gradient-to-r from-neutral-100 to-neutral-400 bg-clip-text text-transparent"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            Speed Reading
          </motion.h1>

          <motion.p
            className="text-sm text-neutral-400 mt-3 max-w-xs mx-auto leading-relaxed"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            Practice rapid serial visual presentation (RSVP) and switch to normal reading whenever you need more context.
          </motion.p>
        </motion.header>

        {/* View Toggle */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.38, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="flex justify-center"
        >
          <div className="w-full rounded-xl bg-neutral-900 border border-neutral-800 p-1 h-9 flex items-center">
            <div className="relative w-full grid grid-cols-2">
              <button
                type="button"
                onClick={() => setView("mood")}
                className="relative h-7 rounded-lg"
              >
                {view === "mood" ? (
                  <motion.div
                    layoutId="home-view-pill"
                    className="absolute inset-0 rounded-lg bg-neutral-100"
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  />
                ) : null}
                <span
                  className={`relative z-10 text-xs font-semibold transition-colors ${
                    view === "mood" ? "text-neutral-900" : "text-neutral-400"
                  }`}
                >
                  Mood
                </span>
              </button>
              <button
                type="button"
                onClick={() => setView("library")}
                className="relative h-7 rounded-lg"
              >
                {view === "library" ? (
                  <motion.div
                    layoutId="home-view-pill"
                    className="absolute inset-0 rounded-lg bg-neutral-100"
                    transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  />
                ) : null}
                <span
                  className={`relative z-10 text-xs font-semibold transition-colors ${
                    view === "library" ? "text-neutral-900" : "text-neutral-400"
                  }`}
                >
                  Library
                </span>
              </button>
            </div>
          </div>
        </motion.div>

        {/* Book Section */}
        {view === "library" ? (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.4 }}
          >
            <motion.h2
              className="text-xs uppercase tracking-[0.2em] text-neutral-500 mb-4 px-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.5 }}
            >
              Your Library
            </motion.h2>

            <div className="space-y-4">
              {libraryBooks.map((book, index) => {
                const isReal = book.id === BOOK_ID;
                const isMock = !!book.isMock;
                return (
                  <BookCard
                    key={book.id}
                    title={book.title}
                    author={book.author ?? "Unknown author"}
                    genre={book.genre}
                    description={book.description}
                    coverUrl={book.coverUrl}
                    isMock={isMock}
                    readLabel={isReal ? "Read" : "Coming soon"}
                    readDisabled={!isReal}
                    progress={0}
                    onRead={isReal ? () => setLocation(`/reader/${BOOK_ID}`) : () => {}}
                    tts={{ available: isReal && ttsAvailable }}
                    index={index}
                  />
                );
              })}
            </div>
          </motion.section>
        ) : (
          <MoodView
            books={libraryBooks}
            onOpenBook={(bookId) => {
              if (bookId === BOOK_ID) setLocation(`/reader/${BOOK_ID}`);
            }}
          />
        )}

        {/* Footer */}
        <motion.footer
          className="text-center pt-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.6 }}
        >
          <p className="text-xs text-neutral-600">
            Prototype mode: progress resets when app restarts
          </p>
        </motion.footer>
      </div>
    </main>
  );
}
