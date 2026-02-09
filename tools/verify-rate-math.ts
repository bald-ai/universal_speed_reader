let passed = 0;
let failed = 0;

function check(name: string, actual: number, expected: number, eps = 1e-9) {
  const ok = Math.abs(actual - expected) < eps;
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}: got ${actual}, expected ${expected}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}: got ${actual}, expected ${expected}`);
  }
}

function computePlayedSec(
  outCtxTime: number,
  startedAtCtxTime: number,
  rate: number,
  startedAtOffsetSec: number,
): number {
  const dt = Math.max(0, outCtxTime - startedAtCtxTime);
  const playedSec = dt * rate + startedAtOffsetSec;
  return Math.max(0, playedSec * 1000) / 1000; // tMs -> back to sec for comparison
}

function reanchor(
  outCtxTime: number,
  startedAtCtxTime: number,
  rate: number,
  startedAtOffsetSec: number,
) {
  const dt = Math.max(0, outCtxTime - startedAtCtxTime);
  const playedSecNow = dt * rate + startedAtOffsetSec;
  return {
    startedAtOffsetSec: playedSecNow,
    startedAtCtxTime: outCtxTime,
  };
}

// --- Test 1: rate=1.0, 10s wall-clock => 10s audio ---
console.log("\n1) rate=1.0, 10s wall-clock");
check("audio position", computePlayedSec(110, 100, 1.0, 0), 10);

// --- Test 2: rate=1.5, 10s wall-clock => 15s audio ---
console.log("\n2) rate=1.5, 10s wall-clock");
check("audio position", computePlayedSec(110, 100, 1.5, 0), 15);

// --- Test 3: rate=0.7, 10s wall-clock => 7s audio ---
console.log("\n3) rate=0.7, 10s wall-clock");
check("audio position", computePlayedSec(110, 100, 0.7, 0), 7);

// --- Test 4: mid-stream rate change ---
console.log("\n4) mid-stream rate change: 1.0 for 10s then 1.5 for 10s => 25s");
{
  const ctxTimeStart = 100;
  let startedAtCtxTime = ctxTimeStart;
  let startedAtOffsetSec = 0;
  let rate = 1.0;

  // After 10 wall-clock seconds at rate 1.0
  const ctxTimeAtChange = 110;
  const posBeforeChange = computePlayedSec(ctxTimeAtChange, startedAtCtxTime, rate, startedAtOffsetSec);
  check("position before rate change", posBeforeChange, 10);

  // Re-anchor (lines 474-480)
  const anchored = reanchor(ctxTimeAtChange, startedAtCtxTime, rate, startedAtOffsetSec);
  startedAtCtxTime = anchored.startedAtCtxTime;
  startedAtOffsetSec = anchored.startedAtOffsetSec;
  rate = 1.5;

  check("re-anchored offset", startedAtOffsetSec, 10);
  check("re-anchored ctxTime", startedAtCtxTime, 110);

  // After another 10 wall-clock seconds at rate 1.5
  const ctxTimeFinal = 120;
  const posFinal = computePlayedSec(ctxTimeFinal, startedAtCtxTime, rate, startedAtOffsetSec);
  check("final position (10 + 10*1.5 = 25)", posFinal, 25);
}

// --- Test 5: multiple rate changes ---
console.log("\n5) multiple rate changes: 1.0×5s, 2.0×5s, 0.5×10s => 5+10+5 = 20s");
{
  let startedAtCtxTime = 0;
  let startedAtOffsetSec = 0;
  let rate = 1.0;

  // 5s at rate 1.0
  let a = reanchor(5, startedAtCtxTime, rate, startedAtOffsetSec);
  check("after phase 1", a.startedAtOffsetSec, 5);
  startedAtCtxTime = a.startedAtCtxTime;
  startedAtOffsetSec = a.startedAtOffsetSec;
  rate = 2.0;

  // 5s at rate 2.0
  a = reanchor(10, startedAtCtxTime, rate, startedAtOffsetSec);
  check("after phase 2", a.startedAtOffsetSec, 15);
  startedAtCtxTime = a.startedAtCtxTime;
  startedAtOffsetSec = a.startedAtOffsetSec;
  rate = 0.5;

  // 10s at rate 0.5
  const pos = computePlayedSec(20, startedAtCtxTime, rate, startedAtOffsetSec);
  check("final position", pos, 20);
}

// --- Test 6: non-zero initial offset ---
console.log("\n6) start from offset=30s, rate=1.5, 10s wall-clock => 30+15 = 45s");
check("audio position", computePlayedSec(10, 0, 1.5, 30), 45);

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
