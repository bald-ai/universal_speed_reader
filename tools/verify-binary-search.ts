/**
 * Verify: does findTimingIndexForTimeMs using endMs cause premature jumps
 * during paragraph silence gaps?
 *
 * Run: bun run tools/verify-binary-search.ts
 */

type Timing = { startMs: number; endMs: number };

// Exact replica from TtsContext.tsx
function findTimingIndexForTimeMs(timings: Timing[], tMs: number): number {
  let lo = 0;
  let hi = timings.length - 1;
  let ans = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const end = timings[mid]?.endMs ?? 0;
    if (end > tMs) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

// Alternative: use startMs (like tts_demo.py does)
function findTimingIndexByStartMs(timings: Timing[], tMs: number): number {
  let result = 0;
  for (let i = 0; i < timings.length; i++) {
    if (tMs >= timings[i].startMs) {
      result = i;
    } else {
      break;
    }
  }
  return result;
}

// Simulate two paragraphs with a 200ms silence gap between them.
// Paragraph 1: 3 words ending at 1000ms
// Paragraph 2: 3 words starting at 1200ms (after 200ms gap)
const timings: Timing[] = [
  // Para 1
  { startMs: 0, endMs: 300 },     // word 0: "Hello"
  { startMs: 300, endMs: 600 },   // word 1: "beautiful"
  { startMs: 600, endMs: 1000 },  // word 2: "world"
  // Para 2 (starts at 1200ms due to 200ms silence gap)
  { startMs: 1200, endMs: 1500 }, // word 3: "This"
  { startMs: 1500, endMs: 1800 }, // word 4: "is"
  { startMs: 1800, endMs: 2200 }, // word 5: "great"
];

console.log("=".repeat(70));
console.log("  BINARY SEARCH BEHAVIOR DURING SILENCE GAPS");
console.log("=".repeat(70));
console.log();
console.log("  Timings:");
timings.forEach((t, i) => console.log(`    word ${i}: ${t.startMs}-${t.endMs}ms`));
console.log(`    Gap: 1000-1200ms (silence between paragraphs)`);
console.log();

const testTimes = [
  { ms: 500, desc: "mid-word 1 (normal)" },
  { ms: 999, desc: "just before word 2 ends" },
  { ms: 1000, desc: "exactly at word 2 end (gap starts)" },
  { ms: 1001, desc: "1ms into the gap" },
  { ms: 1050, desc: "50ms into the gap" },
  { ms: 1100, desc: "100ms into the gap" },
  { ms: 1150, desc: "150ms into the gap" },
  { ms: 1199, desc: "1ms before gap ends" },
  { ms: 1200, desc: "gap ends, word 3 starts" },
  { ms: 1300, desc: "mid-word 3 (normal)" },
];

console.log("    Time  endMs idx  startMs idx  Match?  Description");
console.log("  ------  ---------  ----------  ------  -----------");

let issues = 0;
for (const t of testTimes) {
  const byEnd = findTimingIndexForTimeMs(timings, t.ms);
  const byStart = findTimingIndexByStartMs(timings, t.ms);
  const match = byEnd === byStart ? "  OK" : " DIFF";
  if (byEnd !== byStart) issues++;
  console.log(`  ${t.ms.toString().padStart(6)}  ${("word " + byEnd).padStart(9)}  ${("word " + byStart).padStart(10)}  ${match.padStart(6)}  ${t.desc}`);
}

console.log();
if (issues > 0) {
  console.log(`  *** ${issues} DIFFERENCES FOUND ***`);
  console.log();
  console.log("  The endMs-based search jumps to the NEXT paragraph's first word");
  console.log("  as soon as the current paragraph's last word ends. During the");
  console.log("  200ms silence gap, the highlight is already on the next paragraph.");
  console.log();
  console.log("  The startMs-based search (like tts_demo.py) stays on the LAST word");
  console.log("  of the current paragraph until the next word actually starts speaking.");
  console.log();
  console.log("  Impact: highlight jumps ~200ms early to the next paragraph.");
  console.log("  This is PERCEPTIBLE but minor compared to the EOS drift issue.");
} else {
  console.log("  No differences found.");
}
