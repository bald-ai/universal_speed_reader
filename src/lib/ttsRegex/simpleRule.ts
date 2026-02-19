function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeSimpleReplacementWord(rawWord: string): string {
  const trimmed = rawWord.trim();
  if (!trimmed) return "";

  const stripped = trimmed.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return stripped.length > 0 ? stripped : trimmed;
}

export function createSimpleWordPattern(rawWord: string): string {
  const normalized = normalizeSimpleReplacementWord(rawWord);
  if (!normalized) return "";

  // Keep the pattern zero-width around punctuation so chunk-mode replacement
  // does not consume surrounding spaces/punctuation.
  return `\\b${escapeRegexLiteral(normalized)}\\b`;
}
