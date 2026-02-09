"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBook } from "@/contexts/BookContext";
import { useReading } from "@/contexts/ReadingContext";
import { useSettings } from "@/contexts/SettingsContext";
import type { Position } from "@/types/reading";
import { getTokensForParagraph } from "@/lib/utils/tokenCache";
import { getTtsBookStatus, getTtsTimingsUrl, ttsHealth, type TtsBookStatus } from "@/lib/ttsClient";

export type TtsPlayerStatus = "idle" | "playing" | "paused" | "error";

export type TtsPreparedState = TtsBookStatus["state"];

export type TtsProgress = { doneParas: number; totalParas: number } | null;

type Timing = { startMs: number; endMs: number };

type TtsContextValue = {
  serverAvailable: boolean;
  preparedState: TtsPreparedState;
  preparedProgress: TtsProgress;
  status: TtsPlayerStatus;
  error: string | null;
  isReady: boolean;

  playFrom: (pos: Position) => Promise<void>;
  pause: () => void;
  stop: () => void;
  jumpTo: (pos: Position) => Promise<void>;
};

const TtsContext = createContext<TtsContextValue | undefined>(undefined);

type Props = { bookId: string; children: ReactNode };

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.7, Math.min(1.4, value));
}

function isDebug(): boolean {
  try {
    const v = window.localStorage.getItem("debug:tts");
    return v !== "0";
  } catch {
    return false;
  }
}

function getEstimatedOutputCtxTimeSec(ctx: AudioContext): number {
  // Best-effort: map "now" to the contextTime currently coming out of the speakers.
  // This is the key difference vs. ctx.currentTime, which tends to run ahead due to output latency.
  const anyCtx = ctx as unknown as {
    getOutputTimestamp?: () => { contextTime?: number } | null;
    outputLatency?: number;
  };

  const hasGetOutputTimestamp = typeof anyCtx.getOutputTimestamp === "function";
  try {
    const ts = anyCtx.getOutputTimestamp?.();
    const ct = ts?.contextTime;
    if (typeof ct === "number" && Number.isFinite(ct)) return ct;
  } catch {
    // ignore
  }

  // Firefox commonly lacks output timestamp + outputLatency. In that case, using ctx.currentTime
  // (no fudge) is better than guessing, because the guess can shift the *start word*.
  if (Number.isFinite(anyCtx.outputLatency) && (anyCtx.outputLatency as number) > 0) {
    return ctx.currentTime - (anyCtx.outputLatency as number);
  }

  if (hasGetOutputTimestamp) {
    // Should not happen (we would have returned above), but keep sane fallback.
    return ctx.currentTime;
  }

  return ctx.currentTime;
}

function findTimingIndexForTimeMs(timings: Timing[], tMs: number): number {
  // Find the first timing with endMs > tMs. This usually feels more "in sync"
  // than using startMs, especially with output latency.
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

export function TtsProvider(props: Props) {
  const { bookId, children } = props;
  const { book } = useBook();
  const { setHighlightedWord, setPosition, saveProgress } = useReading();
  const { settings } = useSettings();

  const [serverAvailable, setServerAvailable] = useState(false);
  const [preparedState, setPreparedState] = useState<TtsPreparedState>("missing");
  const [preparedProgress, setPreparedProgress] = useState<TtsProgress>(null);
  const [status, setStatus] = useState<TtsPlayerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [timings, setTimings] = useState<Timing[] | null>(null);
  const [audioWavUrl, setAudioWavUrl] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startedAtCtxTimeRef = useRef<number>(0);
  const startedAtOffsetSecRef = useRef<number>(0);
  const playbackRateRef = useRef<number>(1);
  const stopRequestedRef = useRef<boolean>(false);

  const rafRef = useRef<number | null>(null);
  const lastSpokenIndexRef = useRef<number>(-1);

  const lastSaveAtRef = useRef<number>(0);
  const lastSetPositionAtRef = useRef<number>(0);

  const mapping = useMemo(() => {
    if (!book) return null;
    const ids: number[] = [];
    const starts: number[] = [];
    const lens: number[] = [];
    const idToIndex = new Map<number, number>();

    let offset = 0;
    for (let i = 0; i < book.paragraphs.length; i += 1) {
      const p = book.paragraphs[i];
      ids.push(p.id);
      starts.push(offset);
      idToIndex.set(p.id, i);
      const tokens = getTokensForParagraph(book, p);
      const len = tokens.length;
      lens.push(len);
      offset += len;
    }
    return { ids, starts, lens, idToIndex, total: offset };
  }, [book]);

  const isReady = serverAvailable && preparedState === "ready" && !!timings && !!audioWavUrl;

  const stopRaf = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const refreshPreparedStatus = useCallback(async () => {
    try {
      const st = await getTtsBookStatus(bookId);
      setPreparedState(st.state);
      if (st.state === "preparing") {
        setPreparedProgress(st.progress ?? null);
      } else {
        setPreparedProgress(null);
      }
      if (st.state === "error") {
        setError(st.error ?? "TTS prepare failed");
      }
      return st;
    } catch (e) {
      setServerAvailable(false);
      setPreparedState("missing");
      setPreparedProgress(null);
      return null;
    }
  }, [bookId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await ttsHealth();
      if (cancelled) return;
      setServerAvailable(ok);
      if (!ok) {
        setPreparedState("missing");
        setPreparedProgress(null);
        return;
      }
      await refreshPreparedStatus();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshPreparedStatus]);

  // Poll server status if it's preparing (in case user comes into reader mid-job).
  useEffect(() => {
    if (!serverAvailable) return;
    if (preparedState !== "preparing") return;
    const t = window.setInterval(() => {
      refreshPreparedStatus().catch(() => {});
    }, 1000);
    return () => window.clearInterval(t);
  }, [serverAvailable, preparedState, refreshPreparedStatus]);

  // Load timings + initialize audio when ready.
  useEffect(() => {
    if (!serverAvailable) return;
    if (preparedState !== "ready") return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(getTtsTimingsUrl(bookId));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Timing[];
        if (cancelled) return;
        setTimings(data);
        if (isDebug()) {
          const zeroLen = data.reduce((acc, t) => acc + (t.endMs === t.startMs ? 1 : 0), 0);
          // eslint-disable-next-line no-console
          console.log("[TTS][CTX] timings loaded", {
            bookId,
            timings: data.length,
            zeroLen,
            first: data[0],
            last: data[data.length - 1],
          });
        }
        // Use a cache-busting query so dev server doesn't serve stale audio.
        setAudioWavUrl(`http://127.0.0.1:7332/books/${encodeURIComponent(bookId)}/audio.wav?ts=${Date.now()}`);
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : "Failed to load timings");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [serverAvailable, preparedState, bookId]);

  // Pause when tab hidden.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (status === "playing") {
          // For now we do stop semantics (prototype). Pause requires tracking offset precisely.
          stopRequestedRef.current = true;
          try {
            sourceRef.current?.stop();
          } catch {}
          sourceRef.current = null;
          setStatus("idle");
          stopRaf();
          saveProgress();
        }
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [status, saveProgress, stopRaf]);

  useEffect(() => {
    return () => {
      stopRaf();
      try {
        sourceRef.current?.stop();
      } catch {}
    };
  }, [stopRaf]);

  const tick = useCallback(() => {
    const ctx = audioCtxRef.current;
    const src = sourceRef.current;
    const ts = timings;
    const map = mapping;
    if (!ctx || !src || !ts || !map) return;
    if (ts.length === 0) return;

    // Use estimated output time to avoid "highlight runs ahead of sound" drift.
    // Clamp to 0 so we don't highlight earlier words during the initial output delay.
    const outCtxTime = getEstimatedOutputCtxTimeSec(ctx);
    const dt = Math.max(0, outCtxTime - startedAtCtxTimeRef.current);
    const rate = playbackRateRef.current;
    const playedSec = dt * rate + startedAtOffsetSecRef.current;
    const tMs = Math.max(0, playedSec * 1000);
    const idx = findTimingIndexForTimeMs(ts, tMs);
    if (idx !== lastSpokenIndexRef.current) {
      lastSpokenIndexRef.current = idx;

      // global idx -> paragraph
      const starts = map.starts;
      let lo = 0;
      let hi = starts.length - 1;
      let paraIndex = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const start = starts[mid] ?? 0;
        if (start <= idx) {
          paraIndex = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      const wordIndex = idx - (starts[paraIndex] ?? 0);
      const paragraphId = map.ids[paraIndex] ?? map.ids[0] ?? 1;
      const pos: Position = { paragraphId, wordIndex: Math.max(0, wordIndex) };

      setHighlightedWord(pos);

      const now = Date.now();
      if (now - lastSetPositionAtRef.current > 250) {
        lastSetPositionAtRef.current = now;
        setPosition(pos);
      }
      if (now - lastSaveAtRef.current > 2000) {
        lastSaveAtRef.current = now;
        saveProgress({ position: pos });
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [mapping, saveProgress, setHighlightedWord, setPosition, timings]);

  const startRaf = useCallback(() => {
    stopRaf();
    rafRef.current = requestAnimationFrame(tick);
  }, [stopRaf, tick]);

  const seekToPosition = useCallback(
    async (pos: Position) => {
      const ts = timings;
      const map = mapping;
      if (!ts || !map) return;
      const paraIndex = map.idToIndex.get(pos.paragraphId);
      if (paraIndex == null) return;
      const base = map.starts[paraIndex] ?? 0;
      const idx = Math.max(0, Math.min(ts.length - 1, base + pos.wordIndex));
      const startMs = ts[idx]?.startMs ?? 0;
      startedAtOffsetSecRef.current = startMs / 1000;
      lastSpokenIndexRef.current = -1;

      if (isDebug()) {
        // eslint-disable-next-line no-console
        console.log("[TTS][CTX] seek", {
          paragraphId: pos.paragraphId,
          wordIndex: pos.wordIndex,
          globalIndex: idx,
          startMs,
          endMs: ts[idx]?.endMs,
        });
      }
    },
    [mapping, timings]
  );

  const ensureAudioLoaded = useCallback(async () => {
    if (audioBufferRef.current) return;
    if (!audioWavUrl) throw new Error("Audio URL missing");

    // Create context lazily to satisfy browser gesture policies.
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    if (!ctx) throw new Error("AudioContext missing");

    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {}
    }

    const res = await fetch(audioWavUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`Audio fetch HTTP ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    audioBufferRef.current = buf;
  }, [audioWavUrl]);

  const playFrom = useCallback(
    async (pos: Position) => {
      setError(null);
      if (!isReady) return;
      try {
        // Make the starting point unambiguous in UI.
        setHighlightedWord(pos);
        setPosition(pos);

        stopRequestedRef.current = false;
        await ensureAudioLoaded();
        await seekToPosition(pos);

        const ctx = audioCtxRef.current;
        const buf = audioBufferRef.current;
        if (!ctx || !buf) throw new Error("Audio not loaded");

        if (isDebug()) {
          const anyCtx = ctx as unknown as { outputLatency?: number; getOutputTimestamp?: () => unknown };
          // eslint-disable-next-line no-console
          console.log("[TTS][CTX] audio ctx", {
            sampleRate: ctx.sampleRate,
            baseLatency: ctx.baseLatency,
            outputLatency: anyCtx.outputLatency,
            hasGetOutputTimestamp: typeof anyCtx.getOutputTimestamp === "function",
            note:
              typeof anyCtx.getOutputTimestamp === "function" || typeof anyCtx.outputLatency === "number"
                ? "Using browser-provided output timing/latency"
                : "No output timing API (using ctx.currentTime)",
          });
        }

        // Stop any previous source.
        try {
          sourceRef.current?.stop();
        } catch {}
        sourceRef.current = null;

        const src = ctx.createBufferSource();
        src.buffer = buf;
        playbackRateRef.current = clampRate(settings.ttsPlaybackRate);
        src.playbackRate.value = playbackRateRef.current;
        src.connect(ctx.destination);
        src.onended = () => {
          if (stopRequestedRef.current) return;
          stopRaf();
          setStatus("idle");
          saveProgress();
          sourceRef.current = null;
        };

        // Schedule slightly in the future so we have a stable "start time" anchor.
        const when = ctx.currentTime + 0.02;
        startedAtCtxTimeRef.current = when;
        const offset = Math.max(0, Math.min(buf.duration, startedAtOffsetSecRef.current));
        startedAtOffsetSecRef.current = offset;
        sourceRef.current = src;
        src.start(when, offset);

        setStatus("playing");
        startRaf();
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Could not start audio");
      }
    },
    [ensureAudioLoaded, isReady, saveProgress, seekToPosition, settings.ttsPlaybackRate, startRaf, stopRaf]
  );

  // If user changes playback rate while playing, keep audio + highlight math in sync.
  useEffect(() => {
    if (status !== "playing") return;
    const ctx = audioCtxRef.current;
    const src = sourceRef.current;
    if (!ctx || !src) return;

    const nextRate = clampRate(settings.ttsPlaybackRate);
    if (nextRate === playbackRateRef.current) return;

    const outCtxTime = getEstimatedOutputCtxTimeSec(ctx);
    const dt = Math.max(0, outCtxTime - startedAtCtxTimeRef.current);
    const playedSecNow = dt * playbackRateRef.current + startedAtOffsetSecRef.current;

    startedAtOffsetSecRef.current = playedSecNow;
    startedAtCtxTimeRef.current = outCtxTime; // re-anchor at "now" in output-time space
    playbackRateRef.current = nextRate;

    try {
      src.playbackRate.value = nextRate;
    } catch {
      // ignore
    }
  }, [settings.ttsPlaybackRate, status]);

  const pause = useCallback(() => {
    // Pause is not used by the new UI. Keep it as stop semantics for now.
    stopRequestedRef.current = true;
    try {
      sourceRef.current?.stop();
    } catch {}
    sourceRef.current = null;
    setStatus("idle");
    stopRaf();
    saveProgress();
  }, [saveProgress, stopRaf]);

  const stop = useCallback(() => {
    try {
      stopRequestedRef.current = true;
      sourceRef.current?.stop();
    } catch {}
    sourceRef.current = null;
    setStatus("idle");
    stopRaf();
    saveProgress();
  }, [saveProgress, stopRaf]);

  const jumpTo = useCallback(
    async (pos: Position) => {
      if (!isReady) return;
      await seekToPosition(pos);
      if (status === "playing") {
        // Restart from new offset.
        await playFrom(pos);
      } else {
        setHighlightedWord(pos);
        setPosition(pos);
      }
    },
    [isReady, playFrom, seekToPosition, setHighlightedWord, setPosition, status]
  );

  const value = useMemo<TtsContextValue>(
    () => ({
      serverAvailable,
      preparedState,
      preparedProgress,
      status,
      error,
      isReady,
      playFrom,
      pause,
      stop,
      jumpTo,
    }),
    [
      serverAvailable,
      preparedState,
      preparedProgress,
      status,
      error,
      isReady,
      playFrom,
      pause,
      stop,
      jumpTo,
    ]
  );

  return <TtsContext.Provider value={value}>{children}</TtsContext.Provider>;
}

export function useTts(): TtsContextValue {
  const ctx = useContext(TtsContext);
  if (!ctx) throw new Error("useTts must be used within a TtsProvider");
  return ctx;
}
