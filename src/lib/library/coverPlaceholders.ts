const OPEN_BOOK_PLACEHOLDER = "/placeholders/open-book.png";
const CLOSED_BOOK_PLACEHOLDER = "/placeholders/closed-book.png";

export function getBookCoverPlaceholder(progressPercent: number): string {
  return progressPercent > 0 ? OPEN_BOOK_PLACEHOLDER : CLOSED_BOOK_PLACEHOLDER;
}
