import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryBookRepository } from "@/lib/storage/inMemoryBookRepository";
import type { BookRepository } from "@/lib/storage/bookRepository";
import type { BookRow, ProcessingStatus } from "@/types/storage";

function makeBook(id: string, status: ProcessingStatus = "queued"): BookRow {
  const now = Date.now();
  return {
    id,
    title: "Integration Fixture",
    author: null,
    cover_path: null,
    language: null,
    source_uri: `memory://${id}.epub`,
    size_bytes: 1024,
    processing_status: status,
    processing_error: null,
    total_chunks: 0,
    total_paragraphs: 0,
    total_words: 0,
    created_at: now,
    updated_at: now,
  };
}

describe("book repository integration", () => {
  let repository: BookRepository;

  beforeEach(async () => {
    repository = new InMemoryBookRepository();
    await repository.init();
  });

  it("initializes all required tables in snapshot state", async () => {
    const snapshot = await repository.exportSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "app_settings",
        "book_chapters",
        "book_chunks",
        "book_images",
        "books",
        "import_jobs",
        "reading_progress",
      ].sort()
    );
  });

  it("persists status transitions in expected order and updates timestamps", async () => {
    const bookId = "book-status";
    await repository.upsertBook(makeBook(bookId, "queued"));
    await repository.insertImportJob({
      book_id: bookId,
      attempt: 1,
      status: "queued",
      error: null,
      started_at: 100,
      finished_at: null,
    });

    const transitions: ProcessingStatus[] = [
      "validating",
      "extracting_metadata",
      "extracting_text",
      "building_chapters",
      "completed",
    ];

    let timestamp = 1000;
    for (const status of transitions) {
      timestamp += 1;
      await repository.setBookStatus(bookId, status, {
        processing_error: null,
        updated_at: timestamp,
      });
      await repository.patchImportJob(bookId, 1, {
        status,
      });
    }
    await repository.patchImportJob(bookId, 1, { finished_at: timestamp + 1 });

    const book = await repository.getBook(bookId);
    const jobs = await repository.listImportJobs(bookId);

    expect(book?.processing_status).toBe("completed");
    expect(book?.updated_at).toBe(timestamp);
    expect(jobs.map((job) => job.status)).toEqual(["completed"]);
    expect(jobs[0]?.finished_at).toBe(timestamp + 1);
  });

  it("replaces chunks and chapters atomically for manual retry on same book_id", async () => {
    const bookId = "book-retry";
    await repository.upsertBook(makeBook(bookId, "building_chapters"));

    await repository.replaceBookContent(bookId, {
      chunks: [
        {
          book_id: bookId,
          chunk_index: 0,
          paragraphs_json: [
            { id: 1, text: "old one" },
            { id: 2, text: "old two" },
          ],
        },
      ],
      chapters: [
        {
          book_id: bookId,
          chapter_index: 0,
          title: "Old chapter",
          start_paragraph_id: 1,
        },
      ],
      images: [],
      total_chunks: 1,
      total_paragraphs: 2,
      total_words: 4,
    });

    await repository.replaceBookContent(bookId, {
      chunks: [
        {
          book_id: bookId,
          chunk_index: 0,
          paragraphs_json: [{ id: 1, text: "new one" }],
        },
        {
          book_id: bookId,
          chunk_index: 1,
          paragraphs_json: [{ id: 2, text: "new two", sceneBreakBefore: "text-ornament" }],
        },
      ],
      chapters: [
        {
          book_id: bookId,
          chapter_index: 0,
          title: "New chapter",
          start_paragraph_id: 1,
          kind: "scene",
          level: 4,
        },
      ],
      images: [
        {
          book_id: bookId,
          image_index: 0,
          after_paragraph_id: 1,
          alt: "Illustration",
          src: "data:image/png;base64,abc",
        },
      ],
      total_chunks: 2,
      total_paragraphs: 2,
      total_words: 4,
    });

    const aggregate = await repository.getBookAggregate(bookId);
    expect(aggregate?.chunks.length).toBe(2);
    expect(aggregate?.chunks[0]?.paragraphs_json[0]?.text).toBe("new one");
    expect(aggregate?.chapters.length).toBe(1);
    expect(aggregate?.chapters[0]?.title).toBe("New chapter");
    expect(aggregate?.chapters[0]?.kind).toBe("scene");
    expect(aggregate?.chapters[0]?.level).toBe(4);
    expect(aggregate?.images.length).toBe(1);
    expect(aggregate?.images[0]?.src).toBe("data:image/png;base64,abc");

    const readable = await repository.getReadableBook(bookId);
    expect(readable).toBeNull();

    await repository.setBookStatus(bookId, "completed");
    const completed = await repository.getReadableBook(bookId);
    expect(completed?.book.images).toEqual([
      {
        id: `${bookId}-img-0`,
        afterParagraphId: 1,
        alt: "Illustration",
        src: "data:image/png;base64,abc",
      },
    ]);
    expect(completed?.book.paragraphs[1]?.sceneBreakBefore).toBe("text-ornament");
    expect(completed?.book.chapters[0]).toMatchObject({ kind: "scene", level: 4 });
  });

  it("keeps failed import errors and attempt history across retries", async () => {
    const bookId = "book-failed";
    await repository.upsertBook(makeBook(bookId, "queued"));

    await repository.insertImportJob({
      book_id: bookId,
      attempt: 1,
      status: "failed",
      error: "Corrupted/Unreadable EPUB: invalid OPF",
      started_at: 10,
      finished_at: 11,
    });
    await repository.setBookStatus(bookId, "failed", {
      processing_error: "Corrupted/Unreadable EPUB: invalid OPF",
      updated_at: 11,
    });

    const next = await repository.nextImportAttempt(bookId);
    expect(next).toBe(2);

    await repository.insertImportJob({
      book_id: bookId,
      attempt: 2,
      status: "queued",
      error: null,
      started_at: 12,
      finished_at: null,
    });
    await repository.patchImportJob(bookId, 2, {
      status: "failed",
      error: "Processing timeout: import exceeded 180 seconds",
      finished_at: 15,
    });
    await repository.setBookStatus(bookId, "failed", {
      processing_error: "Processing timeout: import exceeded 180 seconds",
      updated_at: 15,
    });

    const jobs = await repository.listImportJobs(bookId);
    expect(jobs.map((job) => job.attempt)).toEqual([1, 2]);
    expect(jobs[0]?.error).toContain("Corrupted/Unreadable EPUB");
    expect(jobs[1]?.error).toContain("Processing timeout");
    expect((await repository.getBook(bookId))?.processing_status).toBe("failed");
  });

  it("deletes reading progress for a specific book", async () => {
    const firstBook = "book-progress-one";
    const secondBook = "book-progress-two";
    await repository.upsertBook(makeBook(firstBook, "completed"));
    await repository.upsertBook(makeBook(secondBook, "completed"));

    await repository.saveReadingProgress({
      book_id: firstBook,
      paragraph_id: 5,
      word_index: 2,
      mode: "normal",
      updated_at: 10,
    });
    await repository.saveReadingProgress({
      book_id: secondBook,
      paragraph_id: 7,
      word_index: 1,
      mode: "speed",
      updated_at: 11,
    });

    await repository.deleteReadingProgress(firstBook);

    expect(await repository.getReadingProgress(firstBook)).toBeNull();
    const second = await repository.getReadingProgress(secondBook);
    expect(second?.paragraph_id).toBe(7);
  });

  it("clears every book-owned record while keeping app preferences", async () => {
    const bookId = "book-fresh-start";
    await repository.upsertBook(makeBook(bookId, "completed"));
    await repository.insertImportJob({
      book_id: bookId,
      attempt: 1,
      status: "completed",
      error: null,
      started_at: 10,
      finished_at: 11,
    });
    await repository.saveReadingProgress({
      book_id: bookId,
      paragraph_id: 4,
      word_index: 1,
      mode: "normal",
      updated_at: 12,
    });
    await repository.putAppSetting("theme", { value: "dark" });

    await repository.clearAllBooks();

    const snapshot = await repository.exportSnapshot();
    expect(snapshot.books).toEqual([]);
    expect(snapshot.book_chunks).toEqual([]);
    expect(snapshot.book_chapters).toEqual([]);
    expect(snapshot.book_images).toEqual([]);
    expect(snapshot.reading_progress).toEqual([]);
    expect(snapshot.import_jobs).toEqual([]);
    expect(await repository.getAppSetting<{ value: string }>("theme")).toEqual({ value: "dark" });
  });
});
