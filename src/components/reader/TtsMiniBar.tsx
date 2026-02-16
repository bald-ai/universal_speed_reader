"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useSettings } from "@/contexts/SettingsContext";
import type { Position } from "@/types/reading";
import { useTts } from "@/contexts/TtsContext";
import {
  normalizeTtsPlaybackRate,
  TTS_RATE_STEP,
} from "@/lib/constants";

type Props = {
  isOpen: boolean;
  startFrom: Position;
  onClose: () => void;
};

export default function TtsMiniBar(props: Props) {
  const { isOpen, startFrom, onClose } = props;
  const tts = useTts();
  const { settings, updateSettings } = useSettings();
  const isPlaying = tts.status === "playing";
  const isError = Boolean(tts.error);

  const handleSpeedChange = (direction: "up" | "down") => {
    const delta = direction === "up" ? TTS_RATE_STEP : -TTS_RATE_STEP;
    const nextRate = normalizeTtsPlaybackRate(settings.ttsPlaybackRate + delta);
    updateSettings({ ttsPlaybackRate: nextRate });
  };

  const handleStop = () => {
    tts.stop();
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-x-0 bottom-0 z-30 px-4"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)" }}
          initial={{ y: 12, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 12, opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="mx-auto w-fit max-w-full rounded-full border border-white/10 bg-neutral-950/85 px-2 py-1 shadow-[0_8px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
            <AnimatePresence mode="wait" initial={false}>
              {isError ? (
                <motion.div
                  key="error"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.16 }}
                  className="flex items-center gap-2 rounded-full border border-red-400/25 bg-red-950/45 px-3 py-1"
                >
                  <span className="max-w-[70vw] truncate text-xs text-red-200">{tts.error}</span>
                  <button
                    type="button"
                    onClick={tts.clearError}
                    className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] font-semibold text-red-100 transition-colors hover:bg-white/15"
                  >
                    Dismiss
                  </button>
                </motion.div>
              ) : isPlaying ? (
                <motion.div
                  key="playing"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.16 }}
                  className="flex items-center gap-1"
                >
                  <button
                    type="button"
                    aria-label="Pause TTS"
                    onClick={tts.pause}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-300 to-violet-400 text-neutral-950 shadow-[0_2px_12px_rgba(167,139,250,0.4)] transition-transform hover:scale-105 active:scale-95"
                  >
                    <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
                      <rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    aria-label="Stop TTS"
                    onClick={handleStop}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-white/6 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-300"
                  >
                    <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="paused"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.16 }}
                  className="flex items-center gap-1"
                >
                  <div className="flex items-center gap-1 px-1.5">
                    <button
                      type="button"
                      aria-label="Decrease TTS speed"
                      onClick={() => handleSpeedChange("down")}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/6 text-sm font-medium text-neutral-400 transition-colors hover:border-violet-300/30 hover:bg-violet-300/15 hover:text-violet-200"
                    >
                      -
                    </button>
                    <motion.span
                      key={settings.ttsPlaybackRate}
                      initial={{ scale: 1.2, color: "#c4b5fd" }}
                      animate={{ scale: 1, color: "#e5e7eb" }}
                      transition={{ duration: 0.24 }}
                      className="min-w-[40px] text-center text-xs font-semibold tabular-nums"
                    >
                      {settings.ttsPlaybackRate.toFixed(1)}x
                    </motion.span>
                    <button
                      type="button"
                      aria-label="Increase TTS speed"
                      onClick={() => handleSpeedChange("up")}
                      className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/6 text-sm font-medium text-neutral-400 transition-colors hover:border-violet-300/30 hover:bg-violet-300/15 hover:text-violet-200"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    aria-label="Play TTS"
                    onClick={() => void tts.playFrom(startFrom)}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-300 to-violet-400 text-neutral-950 shadow-[0_2px_12px_rgba(167,139,250,0.4)] transition-transform hover:scale-105 active:scale-95"
                  >
                    <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
                      <path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    aria-label="Stop TTS"
                    onClick={handleStop}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-white/6 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-300"
                  >
                    <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
