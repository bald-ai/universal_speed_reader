#!/usr/bin/env python3
"""
Verify that paragraph pause offsets accumulate correctly in TTS timing data.

Checks for drift between timing data and actual WAV duration, and validates
that inter-paragraph gaps match the expected pause duration.
"""

import json
import os
import sys
import wave
import struct
import math

TTS_DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".tts_data"
)


def wav_duration_ms(wav_path: str) -> float:
    with wave.open(wav_path, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
        return (frames / rate) * 1000.0


def load_json(path: str):
    with open(path) as f:
        return json.load(f)


def analyze_book(book_dir: str):
    meta_path = os.path.join(book_dir, "meta.json")
    timings_path = os.path.join(book_dir, "timings.json")
    payload_path = os.path.join(book_dir, "payload.json")
    wav_path = os.path.join(book_dir, "book.wav")

    for p, label in [
        (meta_path, "meta.json"),
        (timings_path, "timings.json"),
        (wav_path, "book.wav"),
    ]:
        if not os.path.exists(p):
            print(f"  MISSING: {label}")
            return

    meta = load_json(meta_path)
    timings = load_json(timings_path)
    payload = load_json(payload_path) if os.path.exists(payload_path) else None

    pause_ms = meta.get("pauseMsBetweenParagraphs", 0)
    paragraph_count = meta.get("paragraphCount", 0)
    sample_rate = meta.get("sampleRate", 22050)

    actual_duration_ms = wav_duration_ms(wav_path)
    timings_last_end_ms = timings[-1]["endMs"] if timings else 0
    timings_first_start_ms = timings[0]["startMs"] if timings else 0

    print(f"  Book ID:            {meta.get('bookId', '?')}")
    print(f"  Paragraphs:         {paragraph_count}")
    print(f"  Total tokens:       {meta.get('totalTokens', '?')}")
    print(f"  Pause between para: {pause_ms} ms")
    print(f"  Sample rate:        {sample_rate}")
    print()

    # --- 1. WAV duration vs last timing ---
    print("  === WAV Duration vs Timings ===")
    print(f"  Actual WAV duration:    {actual_duration_ms:.1f} ms")
    print(f"  Last timing endMs:      {timings_last_end_ms} ms")
    diff = actual_duration_ms - timings_last_end_ms
    print(f"  Difference (WAV - timing): {diff:+.1f} ms")
    if abs(diff) > 500:
        print(f"  *** WARNING: large mismatch ({diff:+.1f} ms) ***")
        if diff > 0:
            print(
                "      WAV is longer than timings suggest — highlights will finish early."
            )
        else:
            print(
                "      Timings extend past WAV — highlights will run past audio end."
            )
    elif abs(diff) > 50:
        print(f"  ~ Moderate mismatch ({diff:+.1f} ms)")
    else:
        print(f"  OK (within 50 ms)")
    print()

    # --- 2. Build paragraph boundaries from payload ---
    paragraphs = []
    if payload and "paragraphs" in payload:
        token_idx = 0
        for para in payload["paragraphs"]:
            n_tokens = len(para["tokens"])
            if token_idx + n_tokens > len(timings):
                print(
                    f"  WARNING: token count mismatch at paragraph {para['paragraphId']}"
                )
                print(
                    f"           expected token_idx {token_idx} + {n_tokens} tokens, but only {len(timings)} timings total"
                )
                break
            para_timings = timings[token_idx : token_idx + n_tokens]
            paragraphs.append(
                {
                    "id": para["paragraphId"],
                    "token_count": n_tokens,
                    "first_token_idx": token_idx,
                    "startMs": para_timings[0]["startMs"],
                    "endMs": para_timings[-1]["endMs"],
                    "tokens_preview": " ".join(para["tokens"][:6])
                    + ("..." if n_tokens > 6 else ""),
                }
            )
            token_idx += n_tokens

    if not paragraphs:
        print("  No payload.json or no paragraph data — skipping gap analysis.")
        return

    print(f"  === Paragraph Gap Analysis (expected gap ≈ {pause_ms} ms) ===")
    print(f"  {'Para':>5} {'EndMs':>8} {'NextStart':>10} {'Gap':>7} {'Drift':>7}  Tokens")
    print(f"  {'-'*5} {'-'*8} {'-'*10} {'-'*7} {'-'*7}  {'-'*20}")

    gaps = []
    drifts = []
    cumulative_expected = 0

    for i, para in enumerate(paragraphs):
        if i < len(paragraphs) - 1:
            next_para = paragraphs[i + 1]
            gap = next_para["startMs"] - para["endMs"]
            gaps.append(gap)

            gap_deviation = gap - pause_ms
            drifts.append(gap_deviation)

            flag = ""
            if abs(gap_deviation) > pause_ms * 0.5 and abs(gap_deviation) > 50:
                flag = " <<<" 

            print(
                f"  {para['id']:>5} {para['endMs']:>8} {next_para['startMs']:>10} {gap:>7} {gap_deviation:>+7}  {para['tokens_preview']}{flag}"
            )
        else:
            print(
                f"  {para['id']:>5} {para['endMs']:>8} {'(last)':>10} {'':>7} {'':>7}  {para['tokens_preview']}"
            )

    print()

    # --- 3. Gap statistics ---
    if gaps:
        avg_gap = sum(gaps) / len(gaps)
        min_gap = min(gaps)
        max_gap = max(gaps)
        std_gap = math.sqrt(sum((g - avg_gap) ** 2 for g in gaps) / len(gaps))

        print(f"  === Gap Statistics ===")
        print(f"  Expected pause:  {pause_ms} ms")
        print(f"  Avg gap:         {avg_gap:.1f} ms")
        print(f"  Min gap:         {min_gap} ms")
        print(f"  Max gap:         {max_gap} ms")
        print(f"  Std dev:         {std_gap:.1f} ms")
        print()

        # --- 4. Check for accumulating drift ---
        print(f"  === Accumulating Drift Check ===")
        cumulative_drift = 0
        drift_values = []
        for i, gap_dev in enumerate(drifts):
            cumulative_drift += gap_dev
            drift_values.append(cumulative_drift)

        print(
            f"  Cumulative drift after all paragraphs: {cumulative_drift:+.0f} ms"
        )

        if len(drift_values) >= 10:
            first_quarter = drift_values[len(drift_values) // 4]
            mid_point = drift_values[len(drift_values) // 2]
            third_quarter = drift_values[3 * len(drift_values) // 4]
            final = drift_values[-1]

            print(f"  Drift at 25%:  {first_quarter:+.0f} ms")
            print(f"  Drift at 50%:  {mid_point:+.0f} ms")
            print(f"  Drift at 75%:  {third_quarter:+.0f} ms")
            print(f"  Drift at 100%: {final:+.0f} ms")

            if abs(final) > abs(first_quarter) * 3 and abs(final) > 100:
                print()
                print(
                    "  *** ACCUMULATING DRIFT DETECTED ***"
                )
                print(
                    "      Drift grows over time — pause offsets are likely wrong."
                )
                print(
                    "      Probable cause: para_end_ms doesn't match actual paragraph"
                )
                print(
                    "      WAV duration (trailing silence from EOS phoneme not captured)."
                )
            elif abs(final) > 200:
                print()
                print(
                    f"  ~ Significant total drift ({final:+.0f} ms) but not clearly accumulating."
                )
            else:
                print()
                print(f"  OK — no significant accumulating drift detected.")
        else:
            print(f"  (Too few paragraphs for trend analysis)")

        print()

        # --- 5. Per-paragraph duration vs gap contribution ---
        print(f"  === Paragraph Duration Sanity ===")
        anomalies = 0
        for i, para in enumerate(paragraphs):
            duration = para["endMs"] - para["startMs"]
            if duration <= 0 and para["token_count"] > 1:
                print(
                    f"  Para {para['id']}: duration={duration} ms with {para['token_count']} tokens — zero-length! {para['tokens_preview']}"
                )
                anomalies += 1
            elif duration < 100 and para["token_count"] > 3:
                print(
                    f"  Para {para['id']}: duration={duration} ms with {para['token_count']} tokens — suspiciously short. {para['tokens_preview']}"
                )
                anomalies += 1

        if anomalies == 0:
            print(f"  OK — no anomalous paragraph durations.")
        print()

    # --- 6. Negative gaps (overlapping timings) ---
    negative_gaps = [(i, g) for i, g in enumerate(gaps) if g < 0]
    if negative_gaps:
        print(f"  === OVERLAPPING TIMINGS ===")
        for idx, gap in negative_gaps:
            p = paragraphs[idx]
            n = paragraphs[idx + 1]
            print(
                f"  Para {p['id']} ends at {p['endMs']} but para {n['id']} starts at {n['startMs']} (overlap: {-gap} ms)"
            )
        print()

    # --- 7. Summary ---
    print(f"  === Summary ===")
    print(f"  WAV duration:          {actual_duration_ms:.1f} ms ({actual_duration_ms/1000:.1f} s)")
    print(f"  Timings span:          {timings_first_start_ms} — {timings_last_end_ms} ms")
    print(f"  WAV vs timing delta:   {diff:+.1f} ms")
    if gaps:
        print(f"  Cumulative gap drift:  {cumulative_drift:+.0f} ms")
        print(f"  Negative gaps:         {len(negative_gaps)}")
    print()


def main():
    if not os.path.isdir(TTS_DATA_DIR):
        print(f"No .tts_data directory found at {TTS_DATA_DIR}")
        print("Run prepare_book.py first to generate TTS data.")
        sys.exit(1)

    books = [
        d
        for d in os.listdir(TTS_DATA_DIR)
        if os.path.isdir(os.path.join(TTS_DATA_DIR, d))
    ]

    if not books:
        print(f".tts_data exists but contains no book directories.")
        sys.exit(1)

    print(f"Found {len(books)} book(s) in .tts_data/\n")

    for book_name in sorted(books):
        book_dir = os.path.join(TTS_DATA_DIR, book_name)
        print(f"{'='*60}")
        print(f"  Analyzing: {book_name}")
        print(f"{'='*60}")
        analyze_book(book_dir)
        print()


if __name__ == "__main__":
    main()
