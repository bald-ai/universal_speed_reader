# Sync-mechanism comparison: `tts_demo.py` vs `TtsContext.tsx`

## 1. Time source

| | tts_demo.py | TtsContext.tsx |
|---|---|---|
| **Clock** | `samples_played / sample_rate * 1000` — integer counter incremented inside the `sounddevice` callback (runs on the audio I/O thread). | `getEstimatedOutputCtxTimeSec(ctx)` → wall-clock mapped via `getOutputTimestamp().contextTime`, falling back to `ctx.currentTime - outputLatency`, then raw `ctx.currentTime`. |
| **When it ticks** | Only advances when the audio thread pulls a new block (1024 frames @ 22 050 Hz ≈ 46.4 ms per block). The main thread reads `samples_played` at 20 ms intervals, so the value it sees is stale by 0–46 ms depending on when the last callback ran. | `ctx.currentTime` advances continuously on a high-res monotonic clock independent of block size. |
| **Race conditions** | `samples_played` is a bare `int` read from the main thread without a lock. In CPython this is safe due to the GIL, but the value can still be one callback behind. | No threading; all reads happen on the main JS thread. `AudioContext.currentTime` is spec-guaranteed to be coherent. |

**Desync risk:** tts_demo.py's clock can lag up to one block behind (~46 ms) → **highlight is behind audio by up to one block duration**. TtsContext.tsx's clock is continuous and (when `getOutputTimestamp` is available) accounts for output latency, so highlight tracking is tighter.

---

## 2. Timing lookup

| | tts_demo.py | TtsContext.tsx |
|---|---|---|
| **Algorithm** | Linear scan forward: `for i, t in enumerate(timings): if elapsed_ms >= t["start_ms"]: current_idx = i` | Binary search for first timing with `endMs > tMs`: `findTimingIndexForTimeMs()` |
| **Boundary used** | `start_ms` — activates a word the instant playback passes its start boundary. | `endMs` — a word stays active until its *end* boundary is passed, at which point the *next* word activates. |

### Effect of `endMs` vs `start_ms`

Using `start_ms` means a word highlights as soon as its first phoneme begins playing. Using `endMs > tMs` (first timing whose end is still in the future) means the current word stays highlighted for its entire spoken duration. In practice this shifts the highlight by roughly `(endMs - startMs) / 2` earlier relative to the "start_ms" approach — the highlight activates on the *previous* word's endMs boundary, which for adjacent words equals the current word's `startMs`, so **the two approaches are equivalent for words with no gap between them**. They diverge when there is a silence gap between words: `endMs` will jump to the next word at the end of the current word's phonemes (immediately), while `start_ms` will wait until the next word's audio actually starts. This means:

- **`endMs` approach (TtsContext.tsx):** highlight moves to the next word slightly *before* you hear it during inter-word silence → **highlight is ahead of audio by the silence duration**.
- **`start_ms` approach (tts_demo.py):** highlight sits on the current word during silence → **highlight is behind audio by zero** but appears to "hang" during gaps.

For continuous speech both behave identically.

### Complexity

Linear scan is O(n) per frame; binary search is O(log n). For a book with ~100k tokens, linear scan would be 100k comparisons per tick (50×/sec) — noticeable. Binary search is ~17 comparisons. tts_demo.py can get away with it because it handles a single short text.

---

## 3. Update frequency

| | tts_demo.py | TtsContext.tsx |
|---|---|---|
| **Mechanism** | `time.sleep(0.02)` → 50 Hz worst-case (actual ≈ 40–48 Hz due to OS scheduler jitter and `render_frame` cost). | `requestAnimationFrame` → 60 Hz on active tabs. |
| **Throttling** | Not throttled; runs at ~50 Hz even if the terminal window is not visible. | **Severely throttled** when the tab is backgrounded: Chrome drops rAF to 1 Hz (or suspends entirely). However, TtsContext.tsx stops playback on `visibilitychange === "hidden"`, so this is moot for highlight sync. |
| **Render gating** | Only writes to stdout when the rendered frame string differs from the previous one (`if frame != prev_frame`). | Only updates React state when the timing index changes (`if (idx !== lastSpokenIndexRef.current)`). Additionally, `setPosition` is throttled to 250 ms and `saveProgress` to 2 s. |

**Desync risk:** tts_demo.py's 20 ms sleep is a lower bound; actual loop period is `20 ms + render_time`. If `render_frame` takes long (large terminal, slow I/O), the loop slows and highlight lags. rAF is more tightly tied to the display refresh so it's more predictable, but worst-case is 16.7 ms (better than 20 ms).

---

## 4. Latency compensation

| | tts_demo.py | TtsContext.tsx |
|---|---|---|
| **Compensation** | **None.** Uses raw sample count, which represents samples *submitted* to the OS audio buffer, not samples *emitted by the speaker*. | Layered fallback: (1) `getOutputTimestamp().contextTime` (most accurate — the context-time coordinate of the sample currently leaving the DAC), (2) `ctx.currentTime - outputLatency`, (3) raw `ctx.currentTime`. |

### When APIs are unavailable in TtsContext.tsx

1. **`getOutputTimestamp()` throws or returns non-finite `contextTime`** (Safari < 16, some WebViews): falls through to check `outputLatency`.
2. **`outputLatency` is missing or 0** (Firefox, Safari): falls through to raw `ctx.currentTime`.
3. **Raw `ctx.currentTime`**: represents the time coordinate at the *input* of the audio graph, not the output. It runs ahead of the speaker by `baseLatency + outputLatency` (typically 20–100 ms depending on device/OS). This means **highlight runs ahead of audio by the total output pipeline latency** — usually 20–60 ms on desktop, up to 100+ ms on Bluetooth.

**tts_demo.py desync:** `samples_played` counts samples *given to the OS*, not samples *played by the speaker*. On `sounddevice`/PortAudio, default buffer sizes are 2–4× the blocksize (1024). At 22 050 Hz with a 4096-sample output buffer, the highlight leads the speaker by up to `4096/22050*1000 ≈ 186 ms`. This is **worse** than TtsContext.tsx's uncompensated fallback because PortAudio buffers tend to be larger than WebAudio's.

**Direction:** Both uncompensated paths cause **highlight ahead of audio**. tts_demo.py is worse (~100–200 ms ahead) than TtsContext.tsx's fallback (~20–60 ms ahead on desktop).

---

## 5. Rate handling

| | tts_demo.py | TtsContext.tsx |
|---|---|---|
| **Rate support** | None. Playback is always 1×. | `playbackRate` clamped to [0.7, 1.4]. On rate change mid-playback, the code re-anchors: `playedSec = dt * oldRate + offset`, then resets `startedAtCtxTime` and `startedAtOffset` with the new rate. `AudioBufferSourceNode.playbackRate` is set to match. |
| **Rate math correctness** | N/A | `playedSec = (outCtxTime - startedAtCtxTime) * rate + startedAtOffset` — this is correct because WebAudio's `currentTime` always advances at 1× wall-clock regardless of `playbackRate`. The `* rate` factor converts wall-clock elapsed into audio-time elapsed. Verified correct. |

**Desync risk:** None from rate math itself. However, `getOutputTimestamp().contextTime` also advances at 1× wall-clock, so the same `* rate` correction applies correctly. If the fallback is used (`ctx.currentTime` without latency subtraction), the latency error is not rate-dependent because latency is a fixed pipeline delay, not a function of playback speed. No additional desync from rate.

---

## 6. Multi-paragraph handling

| | tts_demo.py | TtsContext.tsx + prepare_book.py |
|---|---|---|
| **Scope** | Single text → single WAV + single JSON. No paragraph boundaries. | `prepare_book.py` synthesizes each paragraph independently, concatenates WAVs with `pauseMsBetweenParagraphs` ms of silence between them, and shifts all timings by a running `total_offset_ms`. Client receives one flat `Timing[]` and one WAV. |
| **Token mapping** | 1:1 — one timing entry per word from Piper alignment. | `map_group_timings_to_tokens()` merges multiple Piper phoneme groups back into one timing per original token. `_count_phoneme_groups_for_token()` re-phonemizes each token to determine how many Piper groups it consumes. |

### Additional failure modes from multi-paragraph

1. **Offset accumulation error.** `total_offset_ms` is computed as `para_end_ms + pause_ms` where `para_end_ms = group_timings[-1]["endMs"]` — the last Piper group's end, not the actual WAV frame count. If Piper's alignment doesn't account for trailing silence in the WAV (BOS/EOS padding), the offset drifts. Each paragraph adds a small error; over hundreds of paragraphs this can accumulate to **seconds of drift** (highlight ahead or behind depending on the sign of the per-paragraph error). **Direction:** if Piper's reported `endMs` is shorter than the actual audio, `total_offset_ms` underestimates → **highlight runs ahead** for later paragraphs. If longer, highlight falls behind.

2. **Phonemize mismatch.** `_count_phoneme_groups_for_token()` calls `voice.phonemize(token)` on each token in isolation. Piper's phonemizer may produce different groupings when a token is in context vs. in isolation (co-articulation, sentence-level prosody). If the group count is wrong, `map_group_timings_to_tokens` consumes the wrong number of group timings → subsequent tokens in that paragraph get shifted timings. The safety net (folding remaining groups into the last token) prevents a crash but can cause the last few words of a paragraph to have wildly wrong timing. **Direction:** unpredictable — depends on whether too many or too few groups are consumed.

3. **Empty paragraphs.** If `tokens` is empty, no timing entries are emitted but no silence is added either. This is correct (no audio = no time), but the paragraph is invisible to the highlight system. `mapping` in TtsContext.tsx assigns `starts[i]` equal to the previous paragraph's end, so `lens[i] = 0`. Binary search over `starts` will never land on it, which is correct. No desync.

4. **Silence gap and `endMs` lookup interaction.** During the silence gap between paragraphs, the playback clock advances but no timing entry covers that interval. `findTimingIndexForTimeMs` returns the *next* timing whose `endMs > tMs` — that's the first word of the next paragraph. So the **highlight jumps to the next paragraph's first word during the silence gap**, before you hear it. Gap duration is `pauseMsBetweenParagraphs` (default likely 200–500 ms), so highlight is **ahead by up to that gap duration**. This is the most perceptible desync in the app.

5. **Trailing silence after last paragraph.** `prepare_book.py` unconditionally writes silence after every paragraph including the last one (`if pause_ms > 0: wav_out.writeframes(silence_frames)`). The audio is longer than the last timing's `endMs`, so the `onended` callback fires later than expected but the highlight has already reached the last word. No visible desync — just a brief pause after the last word before the status goes to "idle".

---

## Summary table

| Aspect | tts_demo.py risk | TtsContext.tsx risk | Worse? |
|---|---|---|---|
| Time source latency | ~100–200 ms ahead (uncompensated PortAudio buffer) | 0–60 ms ahead (fallback) or ~0 ms (with `getOutputTimestamp`) | demo |
| Timing lookup boundary | Correct during silence (waits for `start_ms`) | Jumps early during silence gaps (uses `endMs`) | app |
| Update frequency | ~50 Hz, can slow with render cost | ~60 Hz, stable | demo |
| Rate change | Not supported | Correct | demo |
| Multi-paragraph offset drift | N/A | Accumulates over paragraphs | app |
| Phonemize mismatch | N/A | Can misalign last words in a paragraph | app |
| Cross-paragraph silence gap | N/A | Highlight jumps early by gap duration | app |
