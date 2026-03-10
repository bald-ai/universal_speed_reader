/*
  EPUB CHAPTER EXTRACTION PACKAGE ENTRYPOINT

  App code should import chapter parsing from this package boundary.
  Keeping the public surface here makes it easier to swap the implementation
  without touching callers.
*/
export { __epubParserInternals, parseEpubBytes } from "./extractor";
export type { ParseEpubOptions, ParsedChapter, ParsedEpubResult, ParsePhase } from "./extractor";
