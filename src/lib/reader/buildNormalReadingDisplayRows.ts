import type { Book, BookImage, Paragraph } from "@/types/book";

export type NormalReadingDisplayRow =
  | { kind: "paragraph"; paragraph: Paragraph }
  | { kind: "image"; image: BookImage };

/**
 * Builds the normal-reading display list: paragraphs in order, with images
 * inserted after their anchor paragraph (afterParagraphId 0 = before first).
 */
export function buildNormalReadingDisplayRows(book: Pick<Book, "paragraphs" | "images">): NormalReadingDisplayRow[] {
  const images = book.images ?? [];
  const imagesByAfterId = new Map<number, BookImage[]>();

  for (const image of images) {
    const existing = imagesByAfterId.get(image.afterParagraphId);
    if (existing) {
      existing.push(image);
    } else {
      imagesByAfterId.set(image.afterParagraphId, [image]);
    }
  }

  const rows: NormalReadingDisplayRow[] = [];

  for (const image of imagesByAfterId.get(0) ?? []) {
    rows.push({ kind: "image", image });
  }

  for (const paragraph of book.paragraphs) {
    rows.push({ kind: "paragraph", paragraph });
    for (const image of imagesByAfterId.get(paragraph.id) ?? []) {
      rows.push({ kind: "image", image });
    }
  }

  return rows;
}
