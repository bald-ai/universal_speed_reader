"use client";

import { motion, AnimatePresence } from "framer-motion";
import type { Position } from "@/types/reading";
import { useTts } from "@/contexts/TtsContext";

type Props = {
  isOpen: boolean;
  startFrom: Position;
  onClose: () => void;
};

export default function TtsMiniBar(props: Props) {
  const { isOpen, startFrom, onClose } = props;
  const tts = useTts();
  const isPlaying = tts.status === "playing";

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
          <div className="mx-auto w-full max-w-2xl rounded-2xl border border-neutral-800 bg-neutral-950/95 backdrop-blur-xl shadow-2xl shadow-black/40">
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="text-xs uppercase tracking-[0.18em] text-neutral-500">TTS</div>

              {!tts.isReady ? (
                <div className="text-sm text-neutral-400">TTS unavailable on this device</div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (isPlaying) tts.stop();
                    else tts.playFrom(startFrom);
                  }}
                  className="ml-2 rounded-xl bg-neutral-100 text-neutral-900 text-sm font-semibold px-5 py-2 hover:bg-white transition-colors duration-150"
                >
                  {isPlaying ? "Stop" : "Play"}
                </button>
              )}

              <div className="ml-auto flex items-center gap-2">
                {tts.error ? (
                  <div className="text-xs text-red-300 bg-red-950/40 border border-red-500/30 rounded-xl px-3 py-1.5">
                    {tts.error}
                  </div>
                ) : (
                  <div className="text-xs text-neutral-500">
                    {tts.status === "playing" ? "Playing" : tts.status === "paused" ? "Paused" : "Idle"}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    tts.stop();
                    onClose();
                  }}
                  className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 rounded-lg hover:bg-neutral-800/60"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
