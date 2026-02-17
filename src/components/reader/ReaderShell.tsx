"use client";

import { useBook } from "@/contexts/BookContext";
import { useReading } from "@/contexts/ReadingContext";
import NormalReadingMode from "@/components/reader/NormalReadingMode";
import SpeedReadingMode from "@/components/reader/SpeedReadingMode";

export default function ReaderShell() {
  const { book, isLoading, error } = useBook();
  const { mode } = useReading();

  if (isLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-50">
        <div className="text-sm text-slate-400">Loading book…</div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-50 px-4">
        <div className="max-w-md rounded-xl border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm">
          <p className="font-semibold text-red-100 mb-1">Could not load the book</p>
          <p className="text-red-200/80">{error}</p>
        </div>
      </main>
    );
  }

  if (!book) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-50">
        <div className="text-sm text-slate-400">Book unavailable</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      {mode === "normal" ? <NormalReadingMode /> : <SpeedReadingMode />}
    </main>
  );
}
