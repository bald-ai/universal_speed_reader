import { describe, expect, it } from "bun:test";
import { compileRule } from "@/lib/ttsRegex/engine";
import {
  TTS_CHAPTER_BREAK_PAUSE_MS,
  TTS_PARAGRAPH_BREAK_PAUSE_MS,
  TTS_SCENE_BREAK_PAUSE_MS,
  buildTtsSpeechChunks,
  transformSpokenChunk,
  ttsPauseBeforeParagraph,
  waitForTtsPause,
} from "@/contexts/TtsContext";
import type { Book } from "@/types/book";

function makeCompiledRule(pattern: string, replacement: string) {
  const result = compileRule({
    id: "rule-1",
    pattern,
    replacement,
    source: "regex",
    enabled: true,
    caseInsensitive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  if (!result.ok) {
    throw new Error("Failed to compile test regex rule");
  }
  return result.compiled;
}

describe("transformSpokenChunk", () => {
  it("adds a deliberate pause before a scene but not when playback starts there", () => {
    const book = { chapters: [] };
    const paragraph = { id: 2, sceneBreakBefore: "text-ornament" as const };
    expect(ttsPauseBeforeParagraph(book, paragraph, false)).toBe(TTS_SCENE_BREAK_PAUSE_MS);
    expect(ttsPauseBeforeParagraph(book, paragraph, true)).toBe(0);
    expect(ttsPauseBeforeParagraph(book, { id: 2 }, false)).toBe(TTS_PARAGRAPH_BREAK_PAUSE_MS);
  });

  it("chunks at structural boundaries with paragraph < scene < chapter pause ordering", () => {
    const book: Book = {
      id: "tts-structure",
      title: "TTS Structure",
      paragraphs: [
        { id: 1, text: "First paragraph words" },
        { id: 2, text: "Second paragraph words" },
        { id: 3, text: "Scene paragraph words", sceneBreakBefore: "text-ornament" },
        { id: 4, text: "Chapter paragraph words" },
      ],
      chapters: [
        { index: 0, title: "One", startParagraphId: 1 },
        { index: 1, title: "Two", startParagraphId: 4 },
      ],
      images: [],
      totalWords: 12,
    };

    const result = buildTtsSpeechChunks(book, { paragraphId: 1, wordIndex: 0 });
    expect(result?.chunks.map((chunk) => chunk.pauseBeforeMs)).toEqual([
      0,
      TTS_PARAGRAPH_BREAK_PAUSE_MS,
      TTS_SCENE_BREAK_PAUSE_MS,
      TTS_CHAPTER_BREAK_PAUSE_MS,
    ]);
    expect(TTS_PARAGRAPH_BREAK_PAUSE_MS).toBeLessThan(TTS_SCENE_BREAK_PAUSE_MS);
    expect(TTS_SCENE_BREAK_PAUSE_MS).toBeLessThan(TTS_CHAPTER_BREAK_PAUSE_MS);
  });

  it("uses scene timing for a named theatrical scene instead of chapter timing", () => {
    const book = {
      chapters: [{ index: 0, title: "SCENE II", startParagraphId: 2, kind: "scene" as const }],
    };
    expect(ttsPauseBeforeParagraph(book, { id: 2 }, false)).toBe(TTS_SCENE_BREAK_PAUSE_MS);
  });

  it("schedules the exact structural pause used by playback", async () => {
    let scheduledMs = -1;
    await waitForTtsPause(TTS_SCENE_BREAK_PAUSE_MS, (resolve, delayMs) => {
      scheduledMs = delayMs;
      resolve();
    });
    expect(scheduledMs).toBe(TTS_SCENE_BREAK_PAUSE_MS);
  });
  it("applies token-mode replacements before speak", () => {
    const chunk = {
      text: "xarqon arrives",
      ranges: [
        {
          start: 0,
          end: 6,
          position: { paragraphId: 1, wordIndex: 0 },
        },
        {
          start: 7,
          end: 14,
          position: { paragraphId: 1, wordIndex: 1 },
        },
      ],
      startPosition: { paragraphId: 1, wordIndex: 0 },
      pauseBeforeMs: 0,
    };
    const compiled = [makeCompiledRule("xarqon", "zar-kon")];

    const out = transformSpokenChunk({
      chunk,
      mode: "token",
      compiledRules: compiled,
      maxChars: 5000,
    });

    expect(out.text).toBe("zar-kon arrives");
    expect(out.warning).toBeNull();
  });

  it("applies full-chunk replacements before speak", () => {
    const chunk = {
      text: "Welcome to New York, New York.",
      ranges: [
        {
          start: 0,
          end: 7,
          position: { paragraphId: 1, wordIndex: 0 },
        },
      ],
      startPosition: { paragraphId: 1, wordIndex: 0 },
      pauseBeforeMs: 0,
    };
    const compiled = [makeCompiledRule("new\\s+york", "Nyu York")];

    const out = transformSpokenChunk({
      chunk,
      mode: "chunk",
      compiledRules: compiled,
      maxChars: 5000,
    });

    expect(out.text).toBe("Welcome to Nyu York, Nyu York.");
    expect(out.warning).toBeNull();
  });

  it("falls back to original text when transformed chunk is too long", () => {
    const chunk = {
      text: "x",
      ranges: [
        {
          start: 0,
          end: 1,
          position: { paragraphId: 1, wordIndex: 0 },
        },
      ],
      startPosition: { paragraphId: 1, wordIndex: 0 },
      pauseBeforeMs: 0,
    };
    const compiled = [makeCompiledRule("x", "xxxxxxxxxxxx")];

    const out = transformSpokenChunk({
      chunk,
      mode: "chunk",
      compiledRules: compiled,
      maxChars: 5,
    });

    expect(out.text).toBe("x");
    expect(out.warning).toContain("too long");
  });

  it("keeps original ranges in chunk mode when there are no matches", () => {
    const chunk = {
      text: "plain words only",
      ranges: [
        {
          start: 0,
          end: 5,
          position: { paragraphId: 1, wordIndex: 0 },
        },
        {
          start: 6,
          end: 11,
          position: { paragraphId: 1, wordIndex: 1 },
        },
      ],
      startPosition: { paragraphId: 1, wordIndex: 0 },
      pauseBeforeMs: 0,
    };
    const compiled = [makeCompiledRule("xarqon", "zar-kon")];

    const out = transformSpokenChunk({
      chunk,
      mode: "chunk",
      compiledRules: compiled,
      maxChars: 5000,
    });

    expect(out.text).toBe(chunk.text);
    expect(out.ranges).toEqual(chunk.ranges);
  });
});
