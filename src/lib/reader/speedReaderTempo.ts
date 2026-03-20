import { clampWpm } from "@/lib/constants";
import { findChapterForParagraph, getWordAtPosition } from "@/lib/utils/bookHelpers";
import type { Book } from "@/types/book";
import type { Position } from "@/types/reading";

export type SpeedReaderTempoSettings = {
  commaBreakMs: number;
  semicolonBreakMs: number;
  sentenceBreakMs: number;
  paragraphBreakMs: number;
  chapterBreakMs: number;
  longWordDelayMsAtTenLetters: number;
  chapterStartSlowdownPercent: number;
  chapterRampWords: number;
};

export type PlaybackTempoState = {
  startupWordIndex: number;
  chapterRampWordIndex: number | null;
  activeChapterIndex: number | null;
  lastWordTime: number | null;
  nextDelayMs: number;
};

export const SPEED_READER_TEMPO_LIMITS = {
  commaBreakMs: { min: 0, max: 200, step: 10 },
  semicolonBreakMs: { min: 0, max: 200, step: 10 },
  sentenceBreakMs: { min: 0, max: 300, step: 10 },
  paragraphBreakMs: { min: 0, max: 800, step: 20 },
  chapterBreakMs: { min: 0, max: 1600, step: 25 },
  longWordDelayMsAtTenLetters: { min: 0, max: 80, step: 5 },
  chapterStartSlowdownPercent: { min: 0, max: 35, step: 1 },
  chapterRampWords: { min: 1, max: 40, step: 1 },
} as const;

export const INITIAL_SPEED_READER_SLOWDOWN_PERCENT = 30;
export const INITIAL_SPEED_READER_RAMP_WORDS = 25;
export const LONG_WORD_ASSIST_REFERENCE_LENGTH = 10;
export const LONG_WORD_ASSIST_MIN_LENGTH = 4;

export const DEFAULT_SPEED_READER_TEMPO: SpeedReaderTempoSettings = {
  commaBreakMs: 30,
  semicolonBreakMs: 30,
  sentenceBreakMs: 60,
  paragraphBreakMs: 180,
  chapterBreakMs: 425,
  longWordDelayMsAtTenLetters: 20,
  chapterStartSlowdownPercent: 15,
  chapterRampWords: 18,
};

const COMMA_END_RE = /,(?:["')\]]+)?$/;
const SEMICOLON_END_RE = /;(?:["')\]]+)?$/;
const EXCLAMATION_OR_QUESTION_END_RE = /[!?](?:["')\]]+)?$/;
const PERIOD_END_RE = /\.(?:["')\]]+)?$/;
const TRAILING_CLOSERS_RE = /[)\]]+$/;
const LEADING_WRAPPERS_RE = /^[([{]+/;
const INITIALS_OR_ACRONYM_RE = /^(?:[A-Z]\.){1,}$/;
const DECIMAL_RE = /^\d+\.\d+$/;
const KNOWN_PERIOD_ABBREVIATIONS = new Set([
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "prof.",
  "sr.",
  "jr.",
  "st.",
  "etc.",
  "e.g.",
  "i.e.",
  "vs.",
  "no.",
  "vol.",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampToRange(value: number, min: number, max: number, step: number): number {
  const clamped = Math.max(min, Math.min(max, value));
  return Math.round(clamped / step) * step;
}

function stripTrailingClosers(word: string): string {
  return word.replace(TRAILING_CLOSERS_RE, "");
}

function unwrapLeadingSentenceStarters(word: string): string {
  return word.replace(LEADING_WRAPPERS_RE, "");
}

function startsWithUppercase(word: string): boolean {
  return /^[A-Z]/.test(unwrapLeadingSentenceStarters(word));
}

function getLetterCountForWordAssist(word: string): number {
  return word.match(/\p{L}/gu)?.length ?? 0;
}

export function shouldApplySentenceBreak(currentWord: string, nextWord: string | null): boolean {
  const normalizedCurrentWord = stripTrailingClosers(currentWord);

  if (EXCLAMATION_OR_QUESTION_END_RE.test(normalizedCurrentWord)) {
    return true;
  }

  if (!PERIOD_END_RE.test(normalizedCurrentWord)) {
    return false;
  }

  const lowerCurrentWord = normalizedCurrentWord.toLowerCase();
  if (KNOWN_PERIOD_ABBREVIATIONS.has(lowerCurrentWord)) {
    return false;
  }

  if (INITIALS_OR_ACRONYM_RE.test(normalizedCurrentWord)) {
    return false;
  }

  if (DECIMAL_RE.test(normalizedCurrentWord)) {
    return false;
  }

  if (!nextWord) {
    return false;
  }

  return startsWithUppercase(nextWord);
}

export function getLongWordPauseMs(
  word: string,
  tempo: Pick<SpeedReaderTempoSettings, "longWordDelayMsAtTenLetters">
): number {
  if (tempo.longWordDelayMsAtTenLetters <= 0) return 0;

  const letterCount = getLetterCountForWordAssist(word);
  if (letterCount <= 0) return 0;

  const scaledLength = Math.max(LONG_WORD_ASSIST_MIN_LENGTH, letterCount);
  return Math.round(
    (tempo.longWordDelayMsAtTenLetters * scaledLength) / LONG_WORD_ASSIST_REFERENCE_LENGTH
  );
}

export function normalizeSpeedReaderTempo(settings: SpeedReaderTempoSettings): SpeedReaderTempoSettings {
  return {
    commaBreakMs: clampToRange(
      settings.commaBreakMs,
      SPEED_READER_TEMPO_LIMITS.commaBreakMs.min,
      SPEED_READER_TEMPO_LIMITS.commaBreakMs.max,
      SPEED_READER_TEMPO_LIMITS.commaBreakMs.step
    ),
    semicolonBreakMs: clampToRange(
      settings.semicolonBreakMs,
      SPEED_READER_TEMPO_LIMITS.semicolonBreakMs.min,
      SPEED_READER_TEMPO_LIMITS.semicolonBreakMs.max,
      SPEED_READER_TEMPO_LIMITS.semicolonBreakMs.step
    ),
    sentenceBreakMs: clampToRange(
      settings.sentenceBreakMs,
      SPEED_READER_TEMPO_LIMITS.sentenceBreakMs.min,
      SPEED_READER_TEMPO_LIMITS.sentenceBreakMs.max,
      SPEED_READER_TEMPO_LIMITS.sentenceBreakMs.step
    ),
    paragraphBreakMs: clampToRange(
      settings.paragraphBreakMs,
      SPEED_READER_TEMPO_LIMITS.paragraphBreakMs.min,
      SPEED_READER_TEMPO_LIMITS.paragraphBreakMs.max,
      SPEED_READER_TEMPO_LIMITS.paragraphBreakMs.step
    ),
    chapterBreakMs: clampToRange(
      settings.chapterBreakMs,
      SPEED_READER_TEMPO_LIMITS.chapterBreakMs.min,
      SPEED_READER_TEMPO_LIMITS.chapterBreakMs.max,
      SPEED_READER_TEMPO_LIMITS.chapterBreakMs.step
    ),
    longWordDelayMsAtTenLetters: clampToRange(
      settings.longWordDelayMsAtTenLetters,
      SPEED_READER_TEMPO_LIMITS.longWordDelayMsAtTenLetters.min,
      SPEED_READER_TEMPO_LIMITS.longWordDelayMsAtTenLetters.max,
      SPEED_READER_TEMPO_LIMITS.longWordDelayMsAtTenLetters.step
    ),
    chapterStartSlowdownPercent: clampToRange(
      settings.chapterStartSlowdownPercent,
      SPEED_READER_TEMPO_LIMITS.chapterStartSlowdownPercent.min,
      SPEED_READER_TEMPO_LIMITS.chapterStartSlowdownPercent.max,
      SPEED_READER_TEMPO_LIMITS.chapterStartSlowdownPercent.step
    ),
    chapterRampWords: clampToRange(
      settings.chapterRampWords,
      SPEED_READER_TEMPO_LIMITS.chapterRampWords.min,
      SPEED_READER_TEMPO_LIMITS.chapterRampWords.max,
      SPEED_READER_TEMPO_LIMITS.chapterRampWords.step
    ),
  };
}

export function sanitizeSpeedReaderTempo(raw: unknown): SpeedReaderTempoSettings | null {
  if (!isObject(raw)) return null;

  const next: SpeedReaderTempoSettings = { ...DEFAULT_SPEED_READER_TEMPO };
  let hasAnyValue = false;

  if (typeof raw.commaBreakMs === "number" && Number.isFinite(raw.commaBreakMs)) {
    next.commaBreakMs = raw.commaBreakMs;
    hasAnyValue = true;
  }

  if (typeof raw.semicolonBreakMs === "number" && Number.isFinite(raw.semicolonBreakMs)) {
    next.semicolonBreakMs = raw.semicolonBreakMs;
    hasAnyValue = true;
  }

  if (typeof raw.sentenceBreakMs === "number" && Number.isFinite(raw.sentenceBreakMs)) {
    next.sentenceBreakMs = raw.sentenceBreakMs;
    hasAnyValue = true;
  }

  if (typeof raw.paragraphBreakMs === "number" && Number.isFinite(raw.paragraphBreakMs)) {
    next.paragraphBreakMs = raw.paragraphBreakMs;
    hasAnyValue = true;
  }

  if (typeof raw.chapterBreakMs === "number" && Number.isFinite(raw.chapterBreakMs)) {
    next.chapterBreakMs = raw.chapterBreakMs;
    hasAnyValue = true;
  }

  if (
    typeof raw.longWordDelayMsAtTenLetters === "number" &&
    Number.isFinite(raw.longWordDelayMsAtTenLetters)
  ) {
    next.longWordDelayMsAtTenLetters = raw.longWordDelayMsAtTenLetters;
    hasAnyValue = true;
  }

  if (
    typeof raw.chapterStartSlowdownPercent === "number" &&
    Number.isFinite(raw.chapterStartSlowdownPercent)
  ) {
    next.chapterStartSlowdownPercent = raw.chapterStartSlowdownPercent;
    hasAnyValue = true;
  }

  if (typeof raw.chapterRampWords === "number" && Number.isFinite(raw.chapterRampWords)) {
    next.chapterRampWords = raw.chapterRampWords;
    hasAnyValue = true;
  }

  return hasAnyValue ? normalizeSpeedReaderTempo(next) : null;
}

function calculateRampDelayMs(
  targetWpm: number,
  rampWordIndex: number,
  rampWords: number,
  slowdownPercent: number
): number {
  const clampedTargetWpm = clampWpm(targetWpm);
  const normalizedRampWords = Math.max(1, rampWords);
  const normalizedSlowdownPercent = Math.max(0, Math.min(100, slowdownPercent));
  const startWpm = Math.max(1, clampedTargetWpm * (1 - normalizedSlowdownPercent / 100));

  if (rampWordIndex >= normalizedRampWords) {
    return Math.round(60000 / clampedTargetWpm);
  }

  const progress =
    normalizedRampWords === 1 ? 1 : rampWordIndex / Math.max(1, normalizedRampWords - 1);
  const currentWpm = startWpm + (clampedTargetWpm - startWpm) * progress;
  return Math.round(60000 / currentWpm);
}

export function calculateNextWordDelayMs(input: {
  targetWpm: number;
  startupWordIndex: number;
  chapterRampWordIndex: number | null;
  tempo: SpeedReaderTempoSettings;
}): number {
  const startupDelay = calculateRampDelayMs(
    input.targetWpm,
    input.startupWordIndex,
    INITIAL_SPEED_READER_RAMP_WORDS,
    INITIAL_SPEED_READER_SLOWDOWN_PERCENT
  );

  if (input.chapterRampWordIndex === null) {
    return startupDelay;
  }

  const chapterDelay = calculateRampDelayMs(
    input.targetWpm,
    input.chapterRampWordIndex,
    input.tempo.chapterRampWords,
    input.tempo.chapterStartSlowdownPercent
  );

  return Math.max(startupDelay, chapterDelay);
}

export function getRemainingPlaybackDelayMs(input: {
  lastWordTime: number | null;
  nextDelayMs: number;
  now: number;
}): number {
  const lastWordTime = input.lastWordTime ?? input.now;
  return Math.max(0, input.nextDelayMs - (input.now - lastWordTime));
}

export function getStructuralPauseMs(input: {
  book: Book;
  currentPosition: Position;
  currentWord: string;
  nextPosition: Position | null;
  tempo: SpeedReaderTempoSettings;
}): number {
  const { book, currentPosition, currentWord, nextPosition, tempo } = input;
  if (!nextPosition) return 0;

  const currentChapter = findChapterForParagraph(book, currentPosition.paragraphId);
  const nextChapter = findChapterForParagraph(book, nextPosition.paragraphId);
  if (currentChapter?.index !== nextChapter?.index) {
    return tempo.chapterBreakMs;
  }

  if (currentPosition.paragraphId !== nextPosition.paragraphId) {
    return tempo.paragraphBreakMs;
  }

  const nextWord = getWordAtPosition(book, nextPosition);
  if (shouldApplySentenceBreak(currentWord, nextWord)) {
    return tempo.sentenceBreakMs;
  }

  if (SEMICOLON_END_RE.test(currentWord)) {
    return tempo.semicolonBreakMs;
  }

  if (COMMA_END_RE.test(currentWord)) {
    return tempo.commaBreakMs;
  }

  return 0;
}

export function getPriorityPauseMs(input: {
  book: Book;
  currentPosition: Position;
  currentWord: string;
  nextPosition: Position | null;
  tempo: SpeedReaderTempoSettings;
}): number {
  const structuralPause = getStructuralPauseMs(input);
  if (structuralPause > 0) {
    return structuralPause;
  }

  return getLongWordPauseMs(input.currentWord, input.tempo);
}

export function getChapterIndexForPosition(book: Book, position: Position | null): number | null {
  if (!position) return null;
  return findChapterForParagraph(book, position.paragraphId)?.index ?? null;
}

export function createPlaybackTempoState(input: {
  book: Book;
  position: Position | null;
  targetWpm: number;
  tempo: SpeedReaderTempoSettings;
}): PlaybackTempoState {
  return {
    startupWordIndex: 0,
    chapterRampWordIndex: null,
    activeChapterIndex: getChapterIndexForPosition(input.book, input.position),
    lastWordTime: null,
    nextDelayMs: calculateNextWordDelayMs({
      targetWpm: input.targetWpm,
      startupWordIndex: 0,
      chapterRampWordIndex: null,
      tempo: input.tempo,
    }),
  };
}

export function syncPlaybackTempoState(input: {
  state: PlaybackTempoState;
  book: Book;
  position: Position | null;
  targetWpm: number;
  tempo: SpeedReaderTempoSettings;
}): PlaybackTempoState {
  const activeChapterIndex = getChapterIndexForPosition(input.book, input.position);

  if (activeChapterIndex !== input.state.activeChapterIndex) {
    input.state.activeChapterIndex = activeChapterIndex;
    input.state.chapterRampWordIndex = 0;
  }

  input.state.nextDelayMs = calculateNextWordDelayMs({
    targetWpm: input.targetWpm,
    startupWordIndex: input.state.startupWordIndex,
    chapterRampWordIndex: input.state.chapterRampWordIndex,
    tempo: input.tempo,
  });

  return input.state;
}

export function advancePlaybackTempoState(input: {
  state: PlaybackTempoState;
  book: Book;
  currentPosition: Position;
  currentWord: string;
  nextPosition: Position | null;
  targetWpm: number;
  tempo: SpeedReaderTempoSettings;
  frameTime: number;
}): PlaybackTempoState {
  const priorityPauseMs = getPriorityPauseMs({
    book: input.book,
    currentPosition: input.currentPosition,
    currentWord: input.currentWord,
    nextPosition: input.nextPosition,
    tempo: input.tempo,
  });

  input.state.startupWordIndex += 1;
  if (input.state.chapterRampWordIndex !== null) {
    input.state.chapterRampWordIndex += 1;
  }

  const nextChapterIndex = getChapterIndexForPosition(input.book, input.nextPosition);
  if (nextChapterIndex !== input.state.activeChapterIndex) {
    input.state.activeChapterIndex = nextChapterIndex;
    input.state.chapterRampWordIndex = 0;
  }

  input.state.nextDelayMs =
    calculateNextWordDelayMs({
      targetWpm: input.targetWpm,
      startupWordIndex: input.state.startupWordIndex,
      chapterRampWordIndex: input.state.chapterRampWordIndex,
      tempo: input.tempo,
    }) + priorityPauseMs;
  input.state.lastWordTime = input.frameTime;

  return input.state;
}
