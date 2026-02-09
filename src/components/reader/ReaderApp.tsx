"use client";

import { BookProvider } from "@/contexts/BookContext";
import { ReadingProvider } from "@/contexts/ReadingContext";
import { TtsProvider } from "@/contexts/TtsContext";
import ReaderShell from "@/components/reader/ReaderShell";

type ReaderAppProps = {
  bookId: string;
};

export default function ReaderApp(props: ReaderAppProps) {
  const { bookId } = props;

  return (
    <BookProvider bookId={bookId}>
      <ReadingProvider bookId={bookId}>
        <TtsProvider bookId={bookId}>
          <ReaderShell />
        </TtsProvider>
      </ReadingProvider>
    </BookProvider>
  );
}
