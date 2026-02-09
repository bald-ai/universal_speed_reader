/**
 * Standalone test: can token counts diverge between TTS prep and playback highlighting?
 *
 * Run: bun run tools/verify-token-mismatch.ts
 */

// ── JS tokenizer (exact copy from src/lib/utils/wordExtraction.ts) ──────────
function tokenizeParagraph(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^[\"']+|[\"']+$/g, ""))
    .filter((word) => word.length > 0);
}

// ── Python clean_token_for_tts equivalent (from prepare_book.py:47-57) ──────
const PUNCT_RE = /^[\(\[\{\"']+|[\)\]\}\",;:\.\!\?\"']+$/g;

function cleanTokenForTts(token: string): string {
  const t = token.trim();
  if (!t) return token;
  const t2 = t.replace(PUNCT_RE, "");
  if (!t2) return t;
  return t2;
}

// ── Test infrastructure ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ──`);
}

// ── 1. tokenizeParagraph edge cases ─────────────────────────────────────────
section("1. tokenizeParagraph determinism & edge cases");

const edgeCases: [string, string[]][] = [
  // basic
  ["hello world", ["hello", "world"]],
  // multiple spaces
  ["hello   world", ["hello", "world"]],
  // leading/trailing whitespace
  ["  hello world  ", ["hello", "world"]],
  // tabs and newlines
  ["hello\tworld\nfoo", ["hello", "world", "foo"]],
  // empty string
  ["", []],
  // only whitespace
  ["   ", []],
  // quoted words — quotes stripped
  ['"Hello" \'world\'', ["Hello", "world"]],
  // token that is ONLY a quote → stripped to empty → filtered out
  ['" hello', ["hello"]],
  // token that is two double quotes → stripped → empty → filtered
  ['"" hello', ["hello"]],
  // mixed quotes around word
  ["\"'word'\"", ["word"]],
  // single apostrophe mid-word (should NOT be stripped — regex only strips leading/trailing)
  ["don't", ["don't"]],
  // unicode curly quotes — NOT matched by the regex (only straight quotes)
  ["\u201Chello\u201D", ["\u201Chello\u201D"]],
  // unicode single curly quotes
  ["\u2018world\u2019", ["\u2018world\u2019"]],
  // punctuation-only token (not quotes) stays
  ["!!! hello", ["!!!", "hello"]],
  // parenthesized word
  ["(hello)", ["(hello)"]],
  // deeply nested quotes
  ["'''word'''", ["word"]],
  // token with only trailing quote
  ["word'", ["word"]],
  // token with only leading quote
  ["'word", ["word"]],
];

for (const [input, expected] of edgeCases) {
  const result = tokenizeParagraph(input);
  const eq = JSON.stringify(result) === JSON.stringify(expected);
  assert(eq, `tokenizeParagraph(${JSON.stringify(input)}) = ${JSON.stringify(result)}, expected ${JSON.stringify(expected)}`);
  if (!eq) {
    console.error(`    got:      ${JSON.stringify(result)}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
  }
}

// Determinism: same input always yields same output (pure function)
const sampleText = '  "Hello,"   said the \'fox.\'  ';
const r1 = tokenizeParagraph(sampleText);
const r2 = tokenizeParagraph(sampleText);
assert(JSON.stringify(r1) === JSON.stringify(r2), "tokenizeParagraph is deterministic (same input → same output)");

// ── 2. JS quote-strip vs Python PUNCT_RE divergence ─────────────────────────
section("2. JS quote-strip vs Python _PUNCT_RE divergence");

// JS regex:  /^[\"']+|[\"']+$/g   — only strips straight " and '
// Python RE: /^[\(\[\{\"']+|[\)\]\}\",;:\.\!\?\"']+$/  — strips much more

const divergenceCases: [string, string, string][] = [
  // [token, JS-stripped, Python-cleaned]
  ["(hello)", "(hello)", "hello"],       // JS keeps parens, Python strips them
  ["[hello]", "[hello]", "hello"],       // JS keeps brackets, Python strips them
  ["{hello}", "{hello}", "hello"],       // JS keeps braces, Python strips them
  ["hello.", "hello.", "hello"],         // JS keeps trailing dot, Python strips it
  ["hello!", "hello!", "hello"],         // JS keeps trailing !, Python strips it
  ["hello?", "hello?", "hello"],         // JS keeps trailing ?, Python strips it
  ["hello,", "hello,", "hello"],         // JS keeps trailing comma, Python strips it
  ["hello;", "hello;", "hello"],         // JS keeps trailing semicolon, Python strips it
  ["hello:", "hello:", "hello"],         // JS keeps trailing colon, Python strips it
  ['"hello"', "hello", "hello"],         // both strip straight double quotes
  ["'hello'", "hello", "hello"],         // both strip straight single quotes
  ["...hello...", "...hello...", "...hello"], // JS keeps all dots; Python strips trailing dots only (. is in trailing set, not leading)
];

console.log("  Token            | JS strip           | Py clean           | Match?");
console.log("  -----------------+--------------------+--------------------+-------");

for (const [token, expectedJs, expectedPy] of divergenceCases) {
  const jsResult = token.replace(/^[\"']+|[\"']+$/g, "");
  // Use a fresh regex each time (Python re.sub is not stateful like JS /g)
  const pyResult = cleanTokenForTts(token);
  const jsOk = jsResult === expectedJs;
  const pyOk = pyResult === expectedPy;
  const match = jsResult === pyResult;
  const status = match ? "  same" : "  DIFF";
  console.log(`  ${token.padEnd(17)}| ${jsResult.padEnd(19)}| ${pyResult.padEnd(19)}| ${status}`);
  assert(jsOk, `JS strip of ${JSON.stringify(token)} = ${JSON.stringify(jsResult)}, expected ${JSON.stringify(expectedJs)}`);
  assert(pyOk, `Py clean of ${JSON.stringify(token)} = ${JSON.stringify(pyResult)}, expected ${JSON.stringify(expectedPy)}`);
}

// ── 3. Token COUNT divergence analysis ──────────────────────────────────────
section("3. Token count divergence analysis");

// The key insight: both Home.tsx (prep) and TtsContext (playback) call
// tokenizeParagraph(p.text) on the SAME paragraph.text.
// tokenizeParagraph is a pure function, so counts are always identical
// IF the input text is the same.

// The Python server receives the JS-tokenized token LIST (not raw text).
// clean_token_for_tts NEVER removes tokens — if cleaning empties a token,
// it returns the original. So len(synth_tokens) == len(tokens) always.
// map_group_timings_to_tokens produces one timing entry per synth_token.
// Line 316 of prepare_book.py even asserts: len(token_timings) == len(tokens).

// Therefore the only way counts can diverge is if paragraph.text differs
// between the Home.tsx prep call and the TtsContext playback call.

// Simulate: prep path tokenizes, sends token list to server.
// Playback path tokenizes same text again.
const simulatedParagraphs = [
  { id: 0, text: 'The "quick" brown fox.' },
  { id: 1, text: "   Jumped   over   the   lazy   dog.   " },
  { id: 2, text: '"' },            // edge: only a quote
  { id: 3, text: '""' },           // edge: two quotes
  { id: 4, text: "" },             // edge: empty
  { id: 5, text: "It's a 'beautiful' day, isn't it?" },
  { id: 6, text: '\t\n  "Hello,"  she  said.  \t' },
];

let countMismatch = false;
for (const p of simulatedParagraphs) {
  const prepTokens = tokenizeParagraph(p.text);     // Home.tsx prep
  const playTokens = tokenizeParagraph(p.text);     // TtsContext playback

  // Server receives prepTokens, cleans them, but keeps same length
  const serverTokens = prepTokens.map(cleanTokenForTts);

  const prepCount = prepTokens.length;
  const playCount = playTokens.length;
  const serverCount = serverTokens.length;

  if (prepCount !== playCount || prepCount !== serverCount) {
    console.error(`  MISMATCH p${p.id}: prep=${prepCount}, play=${playCount}, server=${serverCount}`);
    console.error(`    text:   ${JSON.stringify(p.text)}`);
    console.error(`    prep:   ${JSON.stringify(prepTokens)}`);
    console.error(`    play:   ${JSON.stringify(playTokens)}`);
    console.error(`    server: ${JSON.stringify(serverTokens)}`);
    countMismatch = true;
  }
}
assert(!countMismatch, "No token count mismatch between prep, playback, and server paths");

if (!countMismatch) {
  console.log("  All paragraph simulations: prep == playback == server token count ✓");
}

// ── 4. The regex /g flag gotcha ─────────────────────────────────────────────
section("4. JS regex /g flag stateful lastIndex check");

// The quote-strip regex in tokenizeParagraph uses /g flag.
// String.prototype.replace with /g is safe — it always replaces all matches
// and doesn't carry state between calls. But the PUNCT_RE const we defined
// above IS stateful. Let's verify tokenizeParagraph doesn't suffer from this.

const stateTest = '"hello"';
const r3 = tokenizeParagraph(stateTest);
const r4 = tokenizeParagraph(stateTest);
const r5 = tokenizeParagraph(stateTest);
assert(
  JSON.stringify(r3) === JSON.stringify(r4) && JSON.stringify(r4) === JSON.stringify(r5),
  "tokenizeParagraph is not affected by regex /g lastIndex state"
);

// But our cleanTokenForTts IS affected because PUNCT_RE is a module-level /g regex.
// The Python re.sub doesn't have this problem. Let's demonstrate:
const g1 = cleanTokenForTts("(hello)");
const g2 = cleanTokenForTts("(hello)");
if (g1 !== g2) {
  console.log(`  WARNING: cleanTokenForTts is stateful! Call 1: ${JSON.stringify(g1)}, Call 2: ${JSON.stringify(g2)}`);
  console.log("  This is a JS /g regex bug in our test helper, not in the actual Python code.");
}

// ── 5. Unicode & special character edge cases ───────────────────────────────
section("5. Unicode & special character edge cases");

const unicodeCases: [string, string[]][] = [
  // em-dash (not whitespace, stays as one token)
  ["hello—world", ["hello—world"]],
  // zero-width space (U+200B) — \s+ does NOT match it
  ["hello\u200Bworld", ["hello\u200Bworld"]],
  // non-breaking space (U+00A0) — \s+ DOES match it
  ["hello\u00A0world", ["hello", "world"]],
  // ideographic space (U+3000) — \s+ DOES match it
  ["hello\u3000world", ["hello", "world"]],
  // mixed: curly quotes are NOT stripped by JS regex
  ["\u201CHello,\u201D he said.", ["\u201CHello,\u201D", "he", "said."]],
];

for (const [input, expected] of unicodeCases) {
  const result = tokenizeParagraph(input);
  const eq = JSON.stringify(result) === JSON.stringify(expected);
  assert(eq, `unicode: tokenizeParagraph(${JSON.stringify(input)}) = ${JSON.stringify(result)}`);
  if (!eq) {
    console.error(`    got:      ${JSON.stringify(result)}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
section("Summary");
console.log(`  ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n  KEY FINDINGS:");
  console.log("  - JS regex only strips straight quotes (' and \")");
  console.log("  - Python _PUNCT_RE strips parens, brackets, braces, and trailing punctuation");
  console.log("  - This means tokens sent to TTS still contain punctuation that Python cleans");
  console.log("  - BUT this does NOT affect token COUNT — Python never drops tokens");
  console.log("  - Token counts between prep and playback are safe (same pure function, same input)");
}

console.log("\n  CONCLUSION:");
console.log("  Token count mismatch between prep and playback is NOT possible when:");
console.log("    1. Both paths use the same tokenizeParagraph function");
console.log("    2. Both paths read from the same book.paragraphs[].text");
console.log("    3. Python clean_token_for_tts never changes token count");
console.log("  The only risk would be if book data is mutated between prep and playback.");

process.exit(failed > 0 ? 1 : 0);
