#!/usr/bin/env python3
"""
Verify: if you seek to word N at paragraph P using timings[globalIdx].startMs,
how many words off are you in the actual WAV?

Uses the real timings.json and book.wav to measure.
"""

import json
import wave
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / ".tts_data"

books = [d.name for d in DATA_DIR.iterdir() if d.is_dir()] if DATA_DIR.exists() else []
if not books:
    print("No prepared books in .tts_data/")
    raise SystemExit(1)

book_id = books[0]
out_dir = DATA_DIR / book_id

timings = json.loads((out_dir / "timings.json").read_text())
meta = json.loads((out_dir / "meta.json").read_text())

wav_path = out_dir / "book.wav"
with wave.open(str(wav_path), "rb") as r:
    wav_frames = r.getnframes()
    sr = r.getframerate()
    wav_duration_ms = round(wav_frames / sr * 1000)

total_tokens = len(timings)
last_timing_ms = timings[-1]["endMs"]

print("=" * 70)
print("  SEEK POSITION DRIFT ANALYSIS")
print("=" * 70)
print()
print(f"  Book: {book_id}")
print(f"  Total tokens: {total_tokens}")
print(f"  WAV duration: {wav_duration_ms}ms ({wav_duration_ms/1000:.1f}s)")
print(f"  Last timing endMs: {last_timing_ms}ms")
print(f"  WAV overshoot: {wav_duration_ms - last_timing_ms}ms")
print()

# The key question: if seekToPosition uses timings[idx].startMs as the WAV offset,
# but the timings are drifted (each paragraph's offset is too small due to missing
# EOS samples), then the seek position is too early in the WAV.
#
# We can compute the actual drift at any point by comparing:
# - timings[idx].startMs (what we seek to)
# - where that word ACTUALLY is in the WAV

# To compute where each word actually is, we need to know the actual paragraph
# boundaries in the WAV. We can approximate this from the payload.
payload_path = out_dir / "payload.json"
if not payload_path.exists():
    print("  No payload.json found — can't compute per-paragraph durations.")
    print("  But we can still check proportional drift.")
    print()
    
# Simple check: the total timing span vs WAV span tells us the total drift.
# If timings span 929475ms but WAV is 942970ms, then at any proportional point
# in the book, the seek offset is wrong by (proportion * total_drift).

total_drift_ms = wav_duration_ms - last_timing_ms

print("  Estimated seek error at different book positions:")
print()
print(f"  {'Position':>10}  {'Token#':>8}  {'TimingMs':>10}  {'~ActualMs':>10}  {'DriftMs':>8}  {'~Words':>6}")
print(f"  {'--------':>10}  {'------':>8}  {'--------':>10}  {'--------':>10}  {'-------':>8}  {'------':>6}")

check_points = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
for pct in check_points:
    idx = min(total_tokens - 1, int(pct * total_tokens))
    timing_ms = timings[idx]["startMs"]
    
    # The drift at this point is approximately proportional
    # (each paragraph contributes ~equal EOS drift)
    proportion = timing_ms / last_timing_ms if last_timing_ms > 0 else 0
    drift_at_point = round(proportion * total_drift_ms)
    actual_ms = timing_ms + drift_at_point
    
    # Estimate words of drift (avg word ~270ms based on data)
    avg_word_ms = last_timing_ms / total_tokens
    words_drift = round(drift_at_point / avg_word_ms) if avg_word_ms > 0 else 0
    
    pct_label = f"{int(pct*100)}%"
    print(f"  {pct_label:>10}  {idx:>8}  {timing_ms:>10}  {actual_ms:>10}  {drift_at_point:>+8}  {words_drift:>+6}")

print()
print("  Interpretation:")
print("  'DriftMs' = how many ms too early the seek lands in the WAV")
print("  '~Words' = how many words behind the user will hear")
print()

# Also check: what's the average word duration for a more accurate estimate?
word_durations = [timings[i]["endMs"] - timings[i]["startMs"] for i in range(total_tokens)]
nonzero_durations = [d for d in word_durations if d > 0]
avg_dur = sum(nonzero_durations) / len(nonzero_durations) if nonzero_durations else 0
print(f"  Average word duration: {avg_dur:.0f}ms")
print(f"  Words with 0ms duration: {len(word_durations) - len(nonzero_durations)}")
print()

# Final: compute drift using actual gap analysis (more accurate than proportional)
# Find paragraph boundaries by looking for gaps > 100ms in timings
gaps = []
for i in range(1, total_tokens):
    gap = timings[i]["startMs"] - timings[i-1]["endMs"]
    if gap > 100:  # likely a paragraph boundary
        gaps.append({"afterToken": i-1, "gap": gap, "excess": gap - 200})  # 200ms is expected pause

cumulative_excess = 0
para_boundaries = []
for g in gaps:
    cumulative_excess += max(0, g["excess"])  # only count excess over expected 200ms
    para_boundaries.append({
        "token": g["afterToken"],
        "timingMs": timings[g["afterToken"]]["endMs"],
        "cumulativeExcessMs": cumulative_excess,
    })

# But wait — the excess gap in timings doesn't directly tell us the WAV drift.
# The gap in timings = (EOS duration + inter-para silence + BOS duration of next)
# The expected gap = pause_ms (200ms)
# But the drift comes from EOS samples being in WAV but not in para_end_ms.
# So the timings gaps already INCLUDE the EOS duration (it bleeds into the gap).
# The real drift is: total_wav_duration - total_timing_span.

print(f"  Total seek drift at end of book: {total_drift_ms}ms ({total_drift_ms/1000:.1f}s)")
words_at_end = round(total_drift_ms / avg_dur) if avg_dur > 0 else 0
print(f"  That's approximately {words_at_end} words of offset at the end.")
print()
print("  This is why clicking a word late in the book makes the highlight")
print("  jump back — the audio seeks to the wrong WAV position.")
