import { useEffect, useState, memo } from "react";
import { useLocation } from "wouter";
import BookCard from "@/components/library/BookCard";
import MoodView from "@/components/library/MoodView";
import { motion } from "framer-motion";
import { tokenizeParagraph } from "@/lib/utils/wordExtraction";
import { getTtsBookStatus, prepareTtsBook, ttsHealth } from "@/lib/ttsClient";
import { devStoreGet } from "@/lib/devStore";
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

type ProgressState = {
  percentComplete: number;
};

export default function Home() {
  const [, setLocation] = useLocation();
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [view, setView] = useState<"mood" | "library">("mood");
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [ttsState, setTtsState] = useState<{
    state: "missing" | "preparing" | "ready" | "error";
    progressPercent?: number;
    progressLabel?: string;
  }>({ state: "missing" });

  useEffect(() => {
    devStoreGet<{ percentComplete?: number }>(`speedreader-progress-${BOOK_ID}`).then((parsed) => {
      if (parsed && typeof parsed.percentComplete === "number") {
        setProgress({ percentComplete: parsed.percentComplete });
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await ttsHealth();
      if (cancelled) return;
      setTtsAvailable(ok);
      if (!ok) {
        setTtsState({ state: "missing" });
        return;
      }
      try {
        const st = await getTtsBookStatus(BOOK_ID);
        if (cancelled) return;
        if (st.state === "preparing") {
          const done = st.progress?.doneParas ?? 0;
          const total = st.progress?.totalParas ?? 0;
          const percent = total > 0 ? (done / total) * 100 : 0;
          setTtsState({
            state: "preparing",
            progressPercent: percent,
            progressLabel: `${done}/${total}`,
          });
        } else if (st.state === "ready") {
          setTtsState({ state: "ready" });
        } else if (st.state === "error") {
          setTtsState({ state: "error", progressLabel: st.error });
        } else {
          setTtsState({ state: "missing" });
        }
      } catch {
        setTtsAvailable(false);
        setTtsState({ state: "missing" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ttsAvailable) return;
    if (ttsState.state !== "preparing") return;

    const t = window.setInterval(async () => {
      try {
        const st = await getTtsBookStatus(BOOK_ID);
        // eslint-disable-next-line no-console
        console.log("[TTS][UI] status poll", st);
        if (st.state === "preparing") {
          const done = st.progress?.doneParas ?? 0;
          const total = st.progress?.totalParas ?? 0;
          const percent = total > 0 ? (done / total) * 100 : 0;
          setTtsState({
            state: "preparing",
            progressPercent: percent,
            progressLabel: `${done}/${total}`,
          });
        } else if (st.state === "ready") {
          setTtsState({ state: "ready" });
        } else if (st.state === "error") {
          setTtsState({ state: "error", progressLabel: st.error });
        } else {
          setTtsState({ state: "missing" });
        }
      } catch {
        setTtsAvailable(false);
        setTtsState({ state: "missing" });
      }
    }, 1000);

    return () => window.clearInterval(t);
  }, [ttsAvailable, ttsState.state]);

  const handlePrepareTts = async () => {
    if (!ttsAvailable) return;
    if (ttsState.state === "preparing") return;

    try {
      // eslint-disable-next-line no-console
      console.log("[TTS][UI] Prepare clicked", { bookId: BOOK_ID, ttsAvailable, ttsState });
      setTtsState({ state: "preparing", progressPercent: 0, progressLabel: "0/0" });
      // Avoid 304 responses from dev server cache; Response.ok is false for 304.
      const bookUrl = `/books/${BOOK_ID}.json`;
      const res = await fetch(bookUrl, {
        cache: "reload",
        headers: {
          "cache-control": "no-cache",
        },
      });
      // eslint-disable-next-line no-console
      console.log("[TTS][UI] book fetch", {
        url: res.url,
        status: res.status,
        ok: res.ok,
        etag: res.headers.get("etag"),
        cacheControl: res.headers.get("cache-control"),
      });
      if (!res.ok) {
        let body = "";
        try {
          body = await res.text();
        } catch {}
        // eslint-disable-next-line no-console
        console.log("[TTS][UI] book fetch body", body.slice(0, 800));
        throw new Error(`Could not load book (${res.status})`);
      }
      const book = (await res.json()) as {
        id: string;
        paragraphs: Array<{ id: number; text: string }>;
      };
      // eslint-disable-next-line no-console
      console.log("[TTS][UI] book parsed", {
        id: book?.id,
        paragraphs: book?.paragraphs?.length ?? 0,
        first: book?.paragraphs?.[0]?.id,
      });

      const paragraphs = (book.paragraphs ?? []).map((p) => ({
        paragraphId: p.id,
        tokens: tokenizeParagraph(p.text),
      }));

      const totalTokens = paragraphs.reduce((sum, p) => sum + p.tokens.length, 0);
      // eslint-disable-next-line no-console
      console.log("[TTS][UI] tokenized", {
        paragraphCount: paragraphs.length,
        totalTokens,
        sampleTokens: paragraphs[0]?.tokens?.slice(0, 12),
      });

      await prepareTtsBook(BOOK_ID, {
        paragraphs,
        pauseMsBetweenParagraphs: 200,
        force: ttsState.state === "ready",
      });
      // eslint-disable-next-line no-console
      console.log("[TTS][UI] prepare POST done");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log("[TTS][UI] Prepare failed", e);
      setTtsState({ state: "error", progressLabel: e instanceof Error ? e.message : "Prepare failed" });
    }
  };

  const realLibraryBook: LibraryBook = {
    id: BOOK_ID,
    title: "Pride and Prejudice (Ch 1-2)",
    author: "Jane Austen",
    genre: "Romance",
    description: "Real bundled sample book. This one is readable and supports TTS prep.",
  };

  const libraryBooks: LibraryBook[] = [realLibraryBook, ...MOCK_LIBRARY_BOOKS];

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
                    progress={isReal ? progress?.percentComplete ?? 0 : 0}
                    onRead={isReal ? () => setLocation(`/reader/${BOOK_ID}`) : () => {}}
                    onPrepareTts={isReal ? handlePrepareTts : () => {}}
                    tts={
                      isReal
                        ? {
                            available: ttsAvailable,
                            state: ttsState.state,
                            progressPercent: ttsState.progressPercent,
                            progressLabel: ttsState.progressLabel,
                          }
                        : { available: false, state: "missing" }
                    }
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
            Continue reading where you left off
          </p>
        </motion.footer>
      </div>
    </main>
  );
}
