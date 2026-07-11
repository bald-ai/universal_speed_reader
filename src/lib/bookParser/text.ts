const WHITESPACE = /\s+/gu;
export const MIN_USABLE_TEXT_WORDS = 50;
export const MIN_USABLE_TEXT_LETTERS = 150;

export interface TextViability {
  words: number;
  letters: number;
  usable: boolean;
}

export function normalizeText(value: string): string {
  return value.replace(/\u00ad/gu, "").replace(WHITESPACE, " ").trim();
}

export function countWords(value: string): number {
  return tokenizeParagraph(value).length;
}

export function measureTextViability(value: string): TextViability {
  const words = countWords(value);
  const letters = value.match(/\p{L}/gu)?.length ?? 0;
  return {
    words,
    letters,
    usable: words >= MIN_USABLE_TEXT_WORDS && letters >= MIN_USABLE_TEXT_LETTERS,
  };
}

// This intentionally mirrors the production app tokenizer. Word indexes are a
// persisted app-model coordinate, so a linguistically richer lab tokenizer
// would make totals and `{ paragraphId, wordIndex }` disagree after integration.
export function tokenizeParagraph(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((word) => word.replace(/^["']+|["']+$/gu, ""))
    .filter((word) => word.length > 0);
}

export function decodeSafeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
