import { useParams } from "wouter";
import ReaderApp from "@/components/reader/ReaderApp";

export default function Reader() {
  const params = useParams();
  const bookId = params.bookId;

  if (!bookId) {
    return <div>Book ID not found</div>;
  }

  return <ReaderApp bookId={bookId} />;
}
