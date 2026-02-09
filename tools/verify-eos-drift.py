#!/usr/bin/env python3
"""
Verify EOS phoneme drift in prepare_book.py.

Uses the same Piper voice to synthesize a few short paragraphs and compares:
  1. group_timings[-1]["endMs"] (what prepare_book.py uses for para_end_ms)
  2. actual WAV duration (total frames / sample_rate)
  3. total_samples from alignment (BOS + all phonemes + EOS)

If (2) > (1), the EOS phoneme duration is being lost, causing accumulating drift.
"""

import sys
import wave
import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent / "tools" / "tts-server"
VOICE_DIR = BASE_DIR / "voices"
VENV_PY = BASE_DIR / ".venv" / "bin" / "python"

# We need to use the venv's Python to import piper
# But let's try to use it directly if available
sys.path.insert(0, str(BASE_DIR / ".venv" / "lib"))

# Try to find the piper module
import subprocess, json

VOICE_ID = "en_US-lessac-high"
MODEL_PATH = VOICE_DIR / f"{VOICE_ID}.onnx"

# We'll run this as a subprocess using the venv python since piper needs it
SCRIPT = '''
import sys, json, wave, tempfile
from pathlib import Path

model_path = sys.argv[1]

from piper import PiperVoice, SynthesisConfig
from piper.const import BOS, EOS

voice = PiperVoice.load(model_path)
sr = int(voice.config.sample_rate)
syn_config = SynthesisConfig(length_scale=1.0)

test_paragraphs = [
    "Hello world.",
    "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
    "However little known the feelings or views of such a man may be on his first entering a neighbourhood.",
    "My dear Mr. Bennet, said his lady to him one day, have you heard that Netherfield Park is let at last?",
    "The quick brown fox jumps over the lazy dog.",
    "To be or not to be, that is the question.",
    "Under the pale moons of Aerilon, the caravan crossed the ash dunes.",
]

results = []

for i, text in enumerate(test_paragraphs):
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    
    with wave.open(tmp.name, "wb") as wav_file:
        alignments = voice.synthesize_wav(
            text, wav_file, syn_config=syn_config, include_alignments=True
        )
    
    # Get actual WAV duration
    with wave.open(tmp.name, "rb") as r:
        wav_frames = r.getnframes()
        wav_duration_ms = round(wav_frames / sr * 1000)
    
    # Replicate alignments_to_words from prepare_book.py
    words = []
    in_word = False
    current_samples = 0
    total_samples = 0
    
    # Also track BOS/EOS specifically
    bos_samples = 0
    eos_samples = 0
    alignment_total = 0
    
    def flush():
        nonlocal in_word, current_samples
        if in_word:
            start_samples = total_samples - current_samples
            words.append({
                "startMs": round(start_samples / sr * 1000),
                "endMs": round(total_samples / sr * 1000),
            })
        in_word = False
        current_samples = 0
    
    for a in alignments:
        alignment_total += a.num_samples
        
        if a.phoneme == BOS:
            bos_samples += a.num_samples
        if a.phoneme == EOS:
            eos_samples += a.num_samples
        
        if a.phoneme in (BOS, EOS):
            flush()
            total_samples += a.num_samples
            continue
        if a.phoneme == " ":
            flush()
            total_samples += a.num_samples
            continue
        in_word = True
        current_samples += a.num_samples
        total_samples += a.num_samples
    
    flush()
    
    last_word_end_ms = words[-1]["endMs"] if words else 0
    total_alignment_ms = round(total_samples / sr * 1000)
    
    results.append({
        "paragraph": i,
        "text_preview": text[:60],
        "wav_duration_ms": wav_duration_ms,
        "last_word_end_ms": last_word_end_ms,
        "total_alignment_ms": total_alignment_ms,
        "bos_ms": round(bos_samples / sr * 1000),
        "eos_ms": round(eos_samples / sr * 1000),
        "drift_per_para_ms": wav_duration_ms - last_word_end_ms,
        "alignment_vs_wav_ms": wav_duration_ms - total_alignment_ms,
    })
    
    import os
    os.unlink(tmp.name)

print(json.dumps(results, indent=2))
'''

def main():
    if not MODEL_PATH.exists():
        print(f"Model not found at {MODEL_PATH}")
        print("Cannot verify without the Piper model.")
        return 1
    
    if not VENV_PY.exists():
        print(f"Venv python not found at {VENV_PY}")
        return 1
    
    script_path = str(Path(__file__).resolve().parent / "_eos_drift_inner.py")
    
    try:
        result = subprocess.run(
            [str(VENV_PY), script_path, str(MODEL_PATH)],
            capture_output=True, text=True, timeout=120
        )
        
        if result.returncode != 0:
            print("Script failed:")
            print(result.stderr)
            return 1
        
        data = json.loads(result.stdout)
        
        print("=" * 80)
        print("  EOS PHONEME DRIFT VERIFICATION")
        print("=" * 80)
        print()
        print(f"  {'Para':>4}  {'WAV ms':>8}  {'LastWord':>8}  {'AlignTot':>8}  {'BOS ms':>6}  {'EOS ms':>6}  {'Drift':>6}  Text")
        print(f"  {'----':>4}  {'------':>8}  {'--------':>8}  {'--------':>8}  {'------':>6}  {'------':>6}  {'-----':>6}  ----")
        
        total_drift = 0
        for r in data:
            drift = r["drift_per_para_ms"]
            total_drift += drift
            marker = " <<<" if abs(drift) > 50 else ""
            print(f"  {r['paragraph']:>4}  {r['wav_duration_ms']:>8}  {r['last_word_end_ms']:>8}  {r['total_alignment_ms']:>8}  {r['bos_ms']:>6}  {r['eos_ms']:>6}  {drift:>+6}{marker}  {r['text_preview']}")
        
        print()
        print(f"  Total accumulated drift over {len(data)} paragraphs: {total_drift:+d} ms")
        print()
        
        if total_drift > 50:
            print("  *** CONFIRMED: EOS phoneme duration is NOT included in para_end_ms ***")
            print(f"      prepare_book.py uses group_timings[-1]['endMs'] which excludes")
            print(f"      the EOS phoneme's {data[0]['eos_ms']}-{data[-1]['eos_ms']}ms of trailing silence per paragraph.")
            print(f"      Over 100 paragraphs this would accumulate to ~{total_drift * 100 // len(data)} ms ({total_drift * 100 // len(data) // 1000:.1f}s) of drift.")
            print()
            print("  FIX: Use actual WAV frame count instead of alignment endMs for para_end_ms:")
            print("       para_end_ms = round(wav_nframes / sample_rate * 1000)")
        elif total_drift < -50:
            print("  *** UNEXPECTED: timings are LONGER than WAV ***")
        else:
            print("  No significant drift detected.")
        
        return 0
    finally:
        pass

if __name__ == "__main__":
    raise SystemExit(main())
