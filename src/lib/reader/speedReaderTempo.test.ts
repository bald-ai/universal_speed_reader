import { describe, expect, it } from "bun:test";
import {
  advancePlaybackTempoState,
  calculateNextWordDelayMs,
  createPlaybackTempoState,
  DEFAULT_SPEED_READER_TEMPO,
  getLongWordPauseMs,
  getChapterIndexForPosition,
  getPriorityPauseMs,
  getRemainingPlaybackDelayMs,
  getStructuralPauseMs,
  sanitizeSpeedReaderTempo,
  shouldApplySentenceBreak,
  syncPlaybackTempoState,
} from "@/lib/reader/speedReaderTempo";
import type { Book } from "@/types/book";

function makeBook(): Book {
  return {
    id: "tempo-book",
    title: "Tempo Book",
    author: "Test Author",
    totalWords: 7,
    paragraphs: [
      { id: 1, text: "Alpha sentence." },
      { id: 2, text: "Bridge paragraph here" },
      { id: 3, text: "New chapter starts now" },
    ],
    chapters: [
      { index: 0, title: "One", startParagraphId: 1 },
      { index: 1, title: "Two", startParagraphId: 3 },
    ],
    images: [],
  };
}

describe("speedReaderTempo", () => {
  it("sanitizes partial nested tempo settings", () => {
    expect(
      sanitizeSpeedReaderTempo({
        commaBreakMs: 29,
        semicolonBreakMs: 31,
        sentenceBreakMs: 67,
        longWordDelayMsAtTenLetters: 17,
        chapterRampWords: 19,
      })
    ).toEqual({
      ...DEFAULT_SPEED_READER_TEMPO,
      commaBreakMs: 30,
      semicolonBreakMs: 30,
      sentenceBreakMs: 70,
      longWordDelayMsAtTenLetters: 15,
      chapterRampWords: 19,
    });
  });

  it("gives chapter and paragraph breaks precedence over punctuation breaks", () => {
    const book = makeBook();

    const chapterBreak = getStructuralPauseMs({
      book,
      currentPosition: { paragraphId: 2, wordIndex: 2 },
      currentWord: "here.",
      nextPosition: { paragraphId: 3, wordIndex: 0 },
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    const paragraphBreak = getStructuralPauseMs({
      book,
      currentPosition: { paragraphId: 1, wordIndex: 1 },
      currentWord: "sentence.",
      nextPosition: { paragraphId: 2, wordIndex: 0 },
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    const sentenceBreak = getStructuralPauseMs({
      book,
      currentPosition: { paragraphId: 2, wordIndex: 0 },
      currentWord: "Wait?",
      nextPosition: { paragraphId: 2, wordIndex: 1 },
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    const semicolonBreak = getStructuralPauseMs({
      book,
      currentPosition: { paragraphId: 2, wordIndex: 0 },
      currentWord: "Wait;",
      nextPosition: { paragraphId: 2, wordIndex: 1 },
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    const commaBreak = getStructuralPauseMs({
      book,
      currentPosition: { paragraphId: 2, wordIndex: 0 },
      currentWord: "Wait,",
      nextPosition: { paragraphId: 2, wordIndex: 1 },
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    expect(chapterBreak).toBe(DEFAULT_SPEED_READER_TEMPO.chapterBreakMs);
    expect(paragraphBreak).toBe(DEFAULT_SPEED_READER_TEMPO.paragraphBreakMs);
    expect(sentenceBreak).toBe(DEFAULT_SPEED_READER_TEMPO.sentenceBreakMs);
    expect(semicolonBreak).toBe(DEFAULT_SPEED_READER_TEMPO.semicolonBreakMs);
    expect(commaBreak).toBe(DEFAULT_SPEED_READER_TEMPO.commaBreakMs);
  });

  it("only applies period sentence breaks when the next token looks like a sentence start", () => {
    expect(shouldApplySentenceBreak("Hello.", "World")).toBe(true);
    expect(shouldApplySentenceBreak("Hello.", "(World")).toBe(true);
    expect(shouldApplySentenceBreak("Hello.", "world")).toBe(false);
  });

  it("skips period sentence breaks for abbreviations and acronyms", () => {
    expect(shouldApplySentenceBreak("Mr.", "Bennet")).toBe(false);
    expect(shouldApplySentenceBreak("Dr.", "Watson")).toBe(false);
    expect(shouldApplySentenceBreak("J.R.R.", "Tolkien")).toBe(false);
    expect(shouldApplySentenceBreak("U.S.", "Army")).toBe(false);
  });

  it("still applies sentence breaks for exclamation and question endings", () => {
    expect(shouldApplySentenceBreak("Run!", "Now")).toBe(true);
    expect(shouldApplySentenceBreak("Really?", "Yes")).toBe(true);
  });

  it("scales long-word assist from the fixed floor to longer words", () => {
    expect(getLongWordPauseMs("cat", DEFAULT_SPEED_READER_TEMPO)).toBe(8);
    expect(getLongWordPauseMs("complexity", DEFAULT_SPEED_READER_TEMPO)).toBe(20);
    expect(getLongWordPauseMs("extraordinary", DEFAULT_SPEED_READER_TEMPO)).toBe(26);
    expect(getLongWordPauseMs("12345", DEFAULT_SPEED_READER_TEMPO)).toBe(0);
  });

  it("uses long-word assist only when no higher-priority pause applies", () => {
    const book = makeBook();

    expect(
      getPriorityPauseMs({
        book,
        currentPosition: { paragraphId: 2, wordIndex: 0 },
        currentWord: "extraordinary",
        nextPosition: { paragraphId: 2, wordIndex: 1 },
        tempo: DEFAULT_SPEED_READER_TEMPO,
      })
    ).toBe(26);

    expect(
      getPriorityPauseMs({
        book,
        currentPosition: { paragraphId: 1, wordIndex: 1 },
        currentWord: "sentence.",
        nextPosition: { paragraphId: 2, wordIndex: 0 },
        tempo: DEFAULT_SPEED_READER_TEMPO,
      })
    ).toBe(DEFAULT_SPEED_READER_TEMPO.paragraphBreakMs);
  });

  it("makes chapter ramp gentler than the initial startup ramp", () => {
    const startupDelay = calculateNextWordDelayMs({
      targetWpm: 300,
      startupWordIndex: 0,
      chapterRampWordIndex: null,
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    const chapterDelay = calculateNextWordDelayMs({
      targetWpm: 300,
      startupWordIndex: 25,
      chapterRampWordIndex: 0,
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    const steadyDelay = calculateNextWordDelayMs({
      targetWpm: 300,
      startupWordIndex: 25,
      chapterRampWordIndex: DEFAULT_SPEED_READER_TEMPO.chapterRampWords,
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    expect(startupDelay).toBeGreaterThan(chapterDelay);
    expect(chapterDelay).toBeGreaterThan(steadyDelay);
  });

  it("computes the remaining playback delay from the last emitted word", () => {
    expect(
      getRemainingPlaybackDelayMs({
        lastWordTime: null,
        nextDelayMs: 420,
        now: 1000,
      })
    ).toBe(420);

    expect(
      getRemainingPlaybackDelayMs({
        lastWordTime: 700,
        nextDelayMs: 420,
        now: 900,
      })
    ).toBe(220);

    expect(
      getRemainingPlaybackDelayMs({
        lastWordTime: 700,
        nextDelayMs: 420,
        now: 1200,
      })
    ).toBe(0);
  });

  it("creates playback state from the current chapter and startup delay", () => {
    const book = makeBook();

    const state = createPlaybackTempoState({
      book,
      position: { paragraphId: 3, wordIndex: 0 },
      targetWpm: 300,
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    expect(state.activeChapterIndex).toBe(1);
    expect(state.chapterRampWordIndex).toBeNull();
    expect(state.startupWordIndex).toBe(0);
    expect(state.nextDelayMs).toBe(
      calculateNextWordDelayMs({
        targetWpm: 300,
        startupWordIndex: 0,
        chapterRampWordIndex: null,
        tempo: DEFAULT_SPEED_READER_TEMPO,
      })
    );
  });

  it("syncs playback state and starts a chapter ramp when position enters a new chapter", () => {
    const book = makeBook();
    const state = createPlaybackTempoState({
      book,
      position: { paragraphId: 1, wordIndex: 0 },
      targetWpm: 300,
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    state.startupWordIndex = 25;

    const synced = syncPlaybackTempoState({
      state,
      book,
      position: { paragraphId: 3, wordIndex: 0 },
      targetWpm: 300,
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    expect(synced.activeChapterIndex).toBe(1);
    expect(synced.chapterRampWordIndex).toBe(0);
    expect(synced.nextDelayMs).toBe(
      calculateNextWordDelayMs({
        targetWpm: 300,
        startupWordIndex: 25,
        chapterRampWordIndex: 0,
        tempo: DEFAULT_SPEED_READER_TEMPO,
      })
    );
  });

  it("advances playback state with structural pauses and chapter resets", () => {
    const book = makeBook();
    const state = createPlaybackTempoState({
      book,
      position: { paragraphId: 2, wordIndex: 2 },
      targetWpm: 300,
      tempo: DEFAULT_SPEED_READER_TEMPO,
    });

    state.startupWordIndex = 25;
    state.chapterRampWordIndex = 5;
    state.activeChapterIndex = 0;

    const advanced = advancePlaybackTempoState({
      state,
      book,
      currentPosition: { paragraphId: 2, wordIndex: 2 },
      currentWord: "here.",
      nextPosition: { paragraphId: 3, wordIndex: 0 },
      targetWpm: 300,
      tempo: DEFAULT_SPEED_READER_TEMPO,
      frameTime: 1234,
    });

    expect(advanced.startupWordIndex).toBe(26);
    expect(advanced.activeChapterIndex).toBe(1);
    expect(advanced.chapterRampWordIndex).toBe(0);
    expect(advanced.lastWordTime).toBe(1234);
    expect(advanced.nextDelayMs).toBe(
      calculateNextWordDelayMs({
        targetWpm: 300,
        startupWordIndex: 26,
        chapterRampWordIndex: 0,
        tempo: DEFAULT_SPEED_READER_TEMPO,
      }) + DEFAULT_SPEED_READER_TEMPO.chapterBreakMs
    );
  });

  it("resolves chapter indices from positions and handles null positions", () => {
    const book = makeBook();

    expect(getChapterIndexForPosition(book, { paragraphId: 1, wordIndex: 0 })).toBe(0);
    expect(getChapterIndexForPosition(book, { paragraphId: 3, wordIndex: 0 })).toBe(1);
    expect(getChapterIndexForPosition(book, null)).toBeNull();
  });
});
