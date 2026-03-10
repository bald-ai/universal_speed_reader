/*
  APP EPUB PARSER SHIM

  This file stays as the app-facing import path.
  The implementation now lives inside the dedicated chapter extraction package
  so the extractor can be moved or swapped without changing callers.
*/
export { __epubParserInternals, parseEpubBytes } from "@/lib/epub/chapterExtraction";
export type { ParseEpubOptions, ParsedChapter, ParsedEpubResult, ParsePhase } from "@/lib/epub/chapterExtraction";
