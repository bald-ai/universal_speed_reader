#!/usr/bin/env python3
"""
Prepare a whole book TTS WAV + word timings (Piper alignments).

This script is intended to run inside the tools/tts-server/.venv python.

It reads an input payload JSON:
  {
    "bookId": "test",
    "voiceId": "en_US-lessac-high",
    "pauseMsBetweenParagraphs": 200,
    "paragraphs": [
      {"paragraphId": 1, "tokens": ["Hello", "world"]},
      ...
    ]
  }

Outputs (in out_dir):
  book.wav
  timings.json    (list of {startMs,endMs} per token, in order)
  meta.json

Progress:
  Prints lines:
    STAGE <name>
    PROGRESS <doneParas> <totalParas>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import traceback
import wave
import time
from pathlib import Path


VOICE_DIR_NAME = "voices"


_PUNCT_RE = re.compile(r"^[\(\[\{\"']+|[\)\]\}\",;:\.\!\?\"']+$")


def clean_token_for_tts(token: str) -> str:
    t = token.strip()
    if not t:
        return token
    t2 = _PUNCT_RE.sub("", t)
    if not t2:
        return t
    return t2


def _json_dump(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _run(cmd: list[str], *, input_text: str | None = None) -> None:
    subprocess.run(
        cmd,
        input=input_text,
        text=True if input_text is not None else False,
        check=True,
    )


def ensure_voice_downloaded(python: str, voice_dir: Path, voice_id: str) -> Path:
    model_path = voice_dir / f"{voice_id}.onnx"
    if model_path.exists():
        return model_path
    voice_dir.mkdir(parents=True, exist_ok=True)
    print(f"STAGE download_voice {voice_id}", flush=True)
    _run(
        [
            python,
            "-m",
            "piper.download_voices",
            "--download-dir",
            str(voice_dir),
            voice_id,
        ]
    )
    return model_path


def ensure_alignment_patched(python: str, model_path: Path) -> None:
    print("STAGE patch_alignment", flush=True)
    # Safe to attempt even if already patched.
    _run([python, "-m", "piper.patch_voice_with_alignment", str(model_path)])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload-json", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--voice-dir", required=True)
    args = parser.parse_args()

    payload_path = Path(args.payload_json)
    out_dir = Path(args.out_dir)
    voice_dir = Path(args.voice_dir)

    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    book_id = str(payload.get("bookId") or "")
    voice_id = str(payload.get("voiceId") or "en_US-lessac-high")
    pause_ms = int(payload.get("pauseMsBetweenParagraphs") or 200)
    paragraphs = payload.get("paragraphs")
    if not isinstance(paragraphs, list):
        raise ValueError("payload.paragraphs must be a list")

    total_paras = len(paragraphs)

    # Use the current interpreter (should be venv python).
    python = sys.executable

    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir = out_dir / "tmp"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    print("STAGE load_voice", flush=True)
    model_path = ensure_voice_downloaded(python, voice_dir, voice_id)
    ensure_alignment_patched(python, model_path)

    from piper import PiperVoice, SynthesisConfig  # type: ignore
    from piper.const import BOS, EOS  # type: ignore

    voice = PiperVoice.load(str(model_path))
    sample_rate = int(voice.config.sample_rate)
    syn_config = SynthesisConfig(length_scale=1.0)

    book_wav_path = out_dir / "book.wav"
    timings_path = out_dir / "timings.json"
    meta_path = out_dir / "meta.json"

    for p in (book_wav_path, timings_path, meta_path):
        try:
            p.unlink()
        except FileNotFoundError:
            pass

    silence_samples = int(sample_rate * (pause_ms / 1000.0))
    silence_frames: bytes | None = None

    wav_out: wave.Wave_write | None = None
    wav_params = None

    def open_out_with_params(params) -> wave.Wave_write:
        w = wave.open(str(book_wav_path), "wb")
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(params.framerate)
        return w

    def alignments_to_words(alignments_list, sr: int) -> list[dict[str, int | str]]:
        """Group phoneme alignments into space-delimited phoneme-group timings.

        Important: Piper/eSpeak phonemization does NOT always preserve 1:1 word boundaries.
        Example: "of a" can become one phoneme group (no space in phoneme output).
        We keep the group's phoneme string so we can map timings back to our token list
        without drifting and producing lots of 0ms entries.
        """
        words: list[dict[str, int]] = []
        current_phonemes: list[str] = []
        current_samples = 0
        total_samples = 0

        def flush():
            nonlocal current_phonemes, current_samples
            if current_phonemes:
                start_samples = total_samples - current_samples
                words.append(
                    {
                        "grp": "".join(current_phonemes),
                        "startMs": round(start_samples / sr * 1000),
                        "endMs": round(total_samples / sr * 1000),
                    }
                )
            current_phonemes = []
            current_samples = 0

        for a in alignments_list:
            if a.phoneme in (BOS, EOS):
                flush()
                total_samples += a.num_samples
                continue

            if a.phoneme == " ":
                flush()
                total_samples += a.num_samples
                continue

            current_phonemes.append(a.phoneme)
            current_samples += a.num_samples
            total_samples += a.num_samples

        flush()
        return words

    def map_group_timings_to_tokens(
        group_timings: list[dict[str, int | str]], synth_tokens_list: list[str]
    ) -> list[dict[str, int]]:
        """Map Piper phoneme-group timings back to our whitespace tokens.

        Handles:
        - Merges: multiple tokens -> one phoneme group (e.g. "of a")
        - Splits: one token -> multiple phoneme groups (rare, but possible)

        Output length is always exactly len(synth_tokens_list).
        """

        def norm(s: str) -> str:
            # Best-effort normalization for small phonemizer differences.
            return (
                s.replace("ˈ", "")
                .replace("ˌ", "")
                .replace("ː", "")
                .replace("‖", "")
            )

        span_cache: dict[str, list[str]] = {}

        def phonemize_to_groups(text: str) -> list[str]:
            key = text.strip()
            if not key:
                return []
            cached = span_cache.get(key)
            if cached is not None:
                return cached
            groups: list[str] = []
            try:
                sentences = voice.phonemize(key)
                for sent_phonemes in sentences:
                    joined = "".join(sent_phonemes).strip()
                    if joined:
                        groups.extend([g for g in joined.split(" ") if g])
            except Exception:
                groups = []
            span_cache[key] = groups
            return groups

        out: list[dict[str, int]] = []
        ti = 0
        gi = 0
        last_end = 0
        mismatches = 0

        max_merge_span = 4

        while ti < len(synth_tokens_list):
            if gi >= len(group_timings):
                out.append({"startMs": last_end, "endMs": last_end})
                ti += 1
                mismatches += 1
                continue

            grp = str(group_timings[gi].get("grp") or "")
            grp_n = norm(grp)

            # --- Merge detection: tokens[i:i+k] -> 1 phoneme group ---
            matched_merge = 0
            for span_len in range(2, max_merge_span + 1):
                if ti + span_len > len(synth_tokens_list):
                    break
                span_text = " ".join(synth_tokens_list[ti : ti + span_len])
                span_groups = phonemize_to_groups(span_text)
                if len(span_groups) != 1:
                    continue
                if norm(span_groups[0]) == grp_n:
                    matched_merge = span_len
                    break

            if matched_merge:
                start = int(group_timings[gi]["startMs"])
                end = int(group_timings[gi]["endMs"])
                dur = max(0, end - start)
                for k in range(matched_merge):
                    s = start + (dur * k) // matched_merge
                    e = start + (dur * (k + 1)) // matched_merge
                    if k == matched_merge - 1:
                        e = end
                    out.append({"startMs": s, "endMs": e})
                last_end = max(last_end, end)
                ti += matched_merge
                gi += 1
                continue

            # --- Split detection: token[i] -> N phoneme groups ---
            tok = synth_tokens_list[ti]
            tok_groups = phonemize_to_groups(tok)
            if len(tok_groups) > 1 and (gi + len(tok_groups) - 1) < len(group_timings):
                ok = True
                for j, tg in enumerate(tok_groups):
                    g2 = str(group_timings[gi + j].get("grp") or "")
                    if norm(tg) != norm(g2):
                        ok = False
                        break
                if ok:
                    start = int(group_timings[gi]["startMs"])
                    end = int(group_timings[gi + len(tok_groups) - 1]["endMs"])
                    out.append({"startMs": start, "endMs": end})
                    last_end = max(last_end, end)
                    ti += 1
                    gi += len(tok_groups)
                    continue

            # --- Default 1:1 token -> group ---
            start = int(group_timings[gi]["startMs"])
            end = int(group_timings[gi]["endMs"])
            out.append({"startMs": start, "endMs": end})
            last_end = max(last_end, end)
            ti += 1
            gi += 1

        # If we still have remaining group timings, fold them into the last token to keep
        # paragraph duration consistent.
        if out and gi < len(group_timings):
            out[-1]["endMs"] = max(int(out[-1]["endMs"]), int(group_timings[-1]["endMs"]))

        if mismatches:
            print(f"WARNING token/group mapping had {mismatches} fallback(s).", flush=True)

        return out

    print("STAGE synthesize", flush=True)

    global_timings: list[dict[str, int]] = []
    total_offset_ms = 0

    try:
        for idx, para in enumerate(paragraphs):
            tokens = para.get("tokens")
            if not isinstance(tokens, list):
                tokens = []
            tokens = [str(t) for t in tokens]

            if not tokens:
                print(f"PROGRESS {idx+1} {total_paras}", flush=True)
                continue

            synth_tokens = [clean_token_for_tts(t) for t in tokens]
            text = " ".join(synth_tokens)

            tmp_wav_path = tmp_dir / f"p{idx:06d}.wav"
            with wave.open(str(tmp_wav_path), "wb") as wav_file:
                alignments = voice.synthesize_wav(
                    text,
                    wav_file,
                    syn_config=syn_config,
                    include_alignments=True,
                )

            if not alignments:
                raise RuntimeError("No alignments returned from Piper (model not patched?)")

            with wave.open(str(tmp_wav_path), "rb") as r:
                params = r.getparams()
                para_wav_frames = r.getnframes()
                frames = r.readframes(para_wav_frames)
                if wav_out is None:
                    wav_out = open_out_with_params(params)
                    wav_params = params
                else:
                    if (params.nchannels, params.sampwidth, params.framerate) != (
                        wav_params.nchannels,
                        wav_params.sampwidth,
                        wav_params.framerate,
                    ):
                        raise RuntimeError("Mismatched WAV params across paragraphs.")
                wav_out.writeframes(frames)

                if silence_frames is None:
                    silence_frames = b"\x00" * (silence_samples * params.sampwidth * params.nchannels)

                if pause_ms > 0:
                    wav_out.writeframes(silence_frames)

            group_timings = alignments_to_words(alignments, sample_rate)
            token_timings = map_group_timings_to_tokens(group_timings, synth_tokens)
            if len(token_timings) != len(tokens):
                raise RuntimeError("Internal error: token timing length mismatch")

            for wt in token_timings:
                global_timings.append(
                    {
                        "startMs": total_offset_ms + int(wt["startMs"]),
                        "endMs": total_offset_ms + int(wt["endMs"]),
                    }
                )

            para_end_ms = round(para_wav_frames / sample_rate * 1000)
            total_offset_ms += para_end_ms
            total_offset_ms += pause_ms

            print(f"PROGRESS {idx+1} {total_paras}", flush=True)

        if wav_out is not None:
            wav_out.close()
            wav_out = None

        _json_dump(timings_path, global_timings)
        _json_dump(
            meta_path,
            {
                "bookId": book_id,
                "voiceId": voice_id,
                "paragraphCount": total_paras,
                "totalTokens": len(global_timings),
                "pauseMsBetweenParagraphs": pause_ms,
                "createdAtMs": int(time.time() * 1000),
                "sampleRate": sample_rate,
            },
        )

        print("STAGE done", flush=True)
        return 0
    except Exception:
        print("STAGE error", flush=True)
        traceback.print_exc()
        return 1
    finally:
        try:
            if wav_out is not None:
                wav_out.close()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
