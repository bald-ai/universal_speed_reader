#!/usr/bin/env python3
"""Inner script run by venv python to measure EOS drift."""

import sys
import json
import wave
import tempfile
import os
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

    with wave.open(tmp.name, "rb") as r:
        wav_frames = r.getnframes()
        wav_duration_ms = round(wav_frames / sr * 1000)

    # Replicate alignments_to_words logic
    words = []
    in_word = False
    current_samples = 0
    total_samples = 0
    bos_samples = 0
    eos_samples = 0

    for a in alignments:
        if a.phoneme == BOS:
            bos_samples += a.num_samples
        if a.phoneme == EOS:
            eos_samples += a.num_samples

        if a.phoneme in (BOS, EOS):
            if in_word:
                start_samples = total_samples - current_samples
                words.append({
                    "startMs": round(start_samples / sr * 1000),
                    "endMs": round(total_samples / sr * 1000),
                })
                in_word = False
                current_samples = 0
            total_samples += a.num_samples
            continue

        if a.phoneme == " ":
            if in_word:
                start_samples = total_samples - current_samples
                words.append({
                    "startMs": round(start_samples / sr * 1000),
                    "endMs": round(total_samples / sr * 1000),
                })
                in_word = False
                current_samples = 0
            total_samples += a.num_samples
            continue

        in_word = True
        current_samples += a.num_samples
        total_samples += a.num_samples

    if in_word:
        start_samples = total_samples - current_samples
        words.append({
            "startMs": round(start_samples / sr * 1000),
            "endMs": round(total_samples / sr * 1000),
        })

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

    os.unlink(tmp.name)

print(json.dumps(results, indent=2))
