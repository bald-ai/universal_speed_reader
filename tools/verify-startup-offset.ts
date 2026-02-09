/**
 * Verify: why does the highlight jump BACKWARDS from the user's chosen word
 * at startup?
 *
 * Run: bun run tools/verify-startup-offset.ts
 */

type Timing = { startMs: number; endMs: number };

// Replica of findTimingIndexForTimeMs from TtsContext.tsx
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

// Simulated timings: 10 words in paragraph, each ~300ms
const timings: Timing[] = [
  { startMs: 0,    endMs: 280 },   // word 0
  { startMs: 280,  endMs: 560 },   // word 1
  { startMs: 560,  endMs: 840 },   // word 2
  { startMs: 840,  endMs: 1120 },  // word 3
  { startMs: 1120, endMs: 1400 },  // word 4
  { startMs: 1400, endMs: 1680 },  // word 5  <-- user clicks here
  { startMs: 1680, endMs: 1960 },  // word 6
  { startMs: 1960, endMs: 2240 },  // word 7
  { startMs: 2240, endMs: 2520 },  // word 8
  { startMs: 2520, endMs: 2800 },  // word 9
];

console.log("=".repeat(70));
console.log("  STARTUP HIGHLIGHT OFFSET INVESTIGATION");
console.log("=".repeat(70));
console.log();

// User clicks word 5. seekToPosition sets:
const userWordIndex = 5;
const startMs = timings[userWordIndex].startMs; // 1400
const startedAtOffsetSec = startMs / 1000;      // 1.4

console.log(`  User clicks word ${userWordIndex} (startMs=${startMs})`);
console.log(`  seekToPosition sets startedAtOffsetSec = ${startedAtOffsetSec}`);
console.log();

// playFrom schedules audio at ctx.currentTime + 0.02
// startedAtCtxTimeRef = when = ctx.currentTime + 0.02
// Audio starts playing from offset 1.4s at ctx.currentTime + 0.02

// But the first tick fires BEFORE the audio actually starts playing.
// requestAnimationFrame fires ~16ms later, but the audio was scheduled
// 20ms in the future. So on the first tick:

console.log("  === Scenario 1: First tick fires BEFORE audio starts ===");
console.log("  (rAF fires ~5-16ms after playFrom, audio scheduled +20ms)");
console.log();

// Simulate: ctx.currentTime at tick time is ctx.currentTime_at_playFrom + 0.01
// But startedAtCtxTimeRef = ctx.currentTime_at_playFrom + 0.02
// So outCtxTime < startedAtCtxTimeRef => dt is NEGATIVE, clamped to 0
{
  const ctxTimeAtPlayFrom = 100.0; // arbitrary
  const when = ctxTimeAtPlayFrom + 0.02;
  const startedAtCtxTime = when;

  // First tick: ~10ms later
  const outCtxTimeAtTick = ctxTimeAtPlayFrom + 0.01; // before "when"
  const dt = Math.max(0, outCtxTimeAtTick - startedAtCtxTime); // negative => 0
  const playedSec = dt * 1.0 + startedAtOffsetSec; // 0 + 1.4 = 1.4
  const tMs = playedSec * 1000; // 1400
  const idx = findTimingIndexForTimeMs(timings, tMs);
  console.log(`  dt = max(0, ${(outCtxTimeAtTick - startedAtCtxTime).toFixed(3)}) = ${dt}`);
  console.log(`  playedSec = ${dt} * 1.0 + ${startedAtOffsetSec} = ${playedSec}`);
  console.log(`  tMs = ${tMs}`);
  console.log(`  findTimingIndexForTimeMs(timings, ${tMs}) = word ${idx}`);
  console.log(`  Expected: word ${userWordIndex}, Got: word ${idx} => ${idx === userWordIndex ? "OK" : "WRONG by " + (idx - userWordIndex)}`);
}

console.log();
console.log("  === Scenario 2: getOutputTimestamp gives PAST time (output latency) ===");
console.log("  (Audio is playing but speaker output is behind by ~100-200ms)");
console.log();

{
  const ctxTimeAtPlayFrom = 100.0;
  const when = ctxTimeAtPlayFrom + 0.02;
  const startedAtCtxTime = when;

  // 200ms after playFrom, audio is playing. But getOutputTimestamp
  // returns contextTime that's 150ms behind currentTime (output latency)
  const currentTime = ctxTimeAtPlayFrom + 0.2;
  const outputLatency = 0.15;
  const outCtxTime = currentTime - outputLatency; // 100.05, which is only 0.03 past "when"

  const dt = Math.max(0, outCtxTime - startedAtCtxTime); // 100.05 - 100.02 = 0.03
  const playedSec = dt * 1.0 + startedAtOffsetSec; // 0.03 + 1.4 = 1.43
  const tMs = playedSec * 1000; // 1430
  const idx = findTimingIndexForTimeMs(timings, tMs);
  console.log(`  currentTime=${currentTime}, outputLatency=${outputLatency}`);
  console.log(`  outCtxTime = ${outCtxTime} (${(outCtxTime - startedAtCtxTime).toFixed(3)}s past start)`);
  console.log(`  dt = ${dt.toFixed(3)}, playedSec = ${playedSec.toFixed(3)}, tMs = ${tMs.toFixed(0)}`);
  console.log(`  findTimingIndexForTimeMs => word ${idx}`);
  console.log(`  Expected: word ${userWordIndex}, Got: word ${idx} => ${idx === userWordIndex ? "OK" : "WRONG by " + (idx - userWordIndex)}`);
  console.log();
  console.log("  This is fine - small positive offset, highlight stays on correct word.");
}

console.log();
console.log("  === Scenario 3: EOS DRIFT EFFECT on mid-book start ===");
console.log("  (The REAL culprit for -X word offset)");
console.log();

{
  // With EOS drift, the timings are WRONG. After N paragraphs,
  // timings think we're at time T but the actual audio is at T + drift.
  //
  // Example: user clicks word at paragraph 50.
  // Timings say word 5 of para 50 starts at 400000ms.
  // But due to EOS drift (~90ms/para * 50 = 4500ms), the ACTUAL audio
  // position of that word in the WAV is at 404500ms.
  //
  // seekToPosition: startedAtOffsetSec = 400000 / 1000 = 400.0
  // Audio starts playing from offset 400.0s in the WAV.
  // But at WAV position 400.0s, the actual speech is ~4.5 seconds
  // BEFORE where the timings think it is.
  //
  // So the audio plays words from ~4.5 seconds earlier than expected.
  // At 300ms/word, that's about 15 words earlier!
  
  const driftMs = 4500; // accumulated over 50 paragraphs
  const wordsPerSec = 1000 / 300; // ~3.3 words/sec
  const wordDrift = Math.round(driftMs / 1000 * wordsPerSec);
  
  console.log("  Timings say word starts at:     400000ms");
  console.log("  Actual audio position of word:  404500ms (due to EOS drift)");
  console.log("  Audio starts from WAV offset:   400000ms (based on timings)");
  console.log(`  What's at 400000ms in WAV:      ~${wordDrift} words BEFORE the target`);
  console.log();
  console.log(`  Result: user hears speech from ~${wordDrift} words before where they clicked.`);
  console.log("  The highlight CORRECTLY tracks what's being spoken (400000ms in timings),");
  console.log("  but the AUDIO is wrong — it's playing an earlier part of the book.");
  console.log();
  console.log("  This is why the highlight appears to jump BACK: the audio seeks to");
  console.log("  the wrong position (too early), and the highlight follows the audio.");
  console.log();
  console.log("  After the first tick, the highlight updates to match the actual audio");
  console.log("  position, which is X words behind where the user clicked.");
}

console.log();
console.log("  === Scenario 4: What the user actually sees ===");
console.log();

{
  // Simulate with realistic timings that have EOS drift baked in
  // 50 paragraphs, each with ~30 words, ~90ms EOS drift per para
  const parasBefore = 50;
  const wordsPerPara = 30;
  const avgWordMs = 300;
  const eosDriftPerPara = 90; // ms

  // Timings think para 50 word 0 starts at:
  const timingStartMs = parasBefore * wordsPerPara * avgWordMs; // 450000ms
  // Actual WAV position of para 50 word 0:
  const actualWavMs = timingStartMs + parasBefore * eosDriftPerPara; // 454500ms

  console.log(`  User clicks word 15 of paragraph 50`);
  console.log(`  Timings say that word starts at: ${timingStartMs + 15 * avgWordMs}ms`);
  console.log(`  seekToPosition offset: ${(timingStartMs + 15 * avgWordMs) / 1000}s`);
  console.log(`  Audio plays from WAV position: ${(timingStartMs + 15 * avgWordMs) / 1000}s`);
  console.log(`  But at that WAV position, we're actually at timing ${timingStartMs + 15 * avgWordMs - parasBefore * eosDriftPerPara}ms`);
  console.log(`  That's word ${Math.round((parasBefore * eosDriftPerPara) / avgWordMs)} words EARLIER`);
  console.log();
  console.log("  playFrom() initially sets highlight to word 15 (line 401)");
  console.log("  But on first tick (~16ms later), it recalculates from audio position");
  console.log(`  and jumps highlight back to word ${15 - Math.round((parasBefore * eosDriftPerPara) / avgWordMs)}`);
  console.log();
  
  const wordsBehind = Math.round((parasBefore * eosDriftPerPara) / avgWordMs);
  console.log(`  *** The highlight jumps back ${wordsBehind} words immediately ***`);
  console.log(`  This gets WORSE the further into the book you are.`);
  console.log(`  At paragraph 100: ~${Math.round((100 * eosDriftPerPara) / avgWordMs)} words behind`);
}
