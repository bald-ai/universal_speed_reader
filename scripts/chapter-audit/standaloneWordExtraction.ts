/*
  STANDALONE WORD TOKEN HELPER

  This is the smallest possible token helper for the standalone audit parser.
  It is here so the audit flow can compute word counts without importing app
  code while we are still calibrating extraction behavior on the side.

  Purpose:
  - split paragraph text into rough word tokens
  - support standalone audit totals and sanity checks
*/
export function tokenizeParagraph(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^[\"']+|[\"']+$/g, ""))
    .filter((word) => word.length > 0);
}
