"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSave: (word: string, replacement: string, scope: "global" | "book") => void;
  onOpenRegex: (word: string, replacement: string) => void;
  onPlayPreview: (text: string) => void;
  initialWord?: string;
};

export default function WordReplacementSheet({
  isOpen,
  onClose,
  onSave,
  onOpenRegex,
  onPlayPreview,
  initialWord = "",
}: Props) {
  const [word, setWord] = useState(initialWord);
  const [replacement, setReplacement] = useState("");
  const [scope, setScope] = useState<"global" | "book">("global");
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setWord(initialWord);
    setReplacement("");
    setScope("global");
  }, [initialWord, isOpen]);

  const canSave = word.trim().length > 0 && replacement.trim().length > 0;

  const handlePlay = async () => {
    if (!replacement.trim()) return;
    setIsPlaying(true);
    try {
      await onPlayPreview(replacement.trim());
    } finally {
      setIsPlaying(false);
    }
  };

  const handleSave = () => {
    if (!canSave) return;
    onSave(word.trim(), replacement.trim(), scope);
    setWord("");
    setReplacement("");
    onClose();
  };

  const handleOpenRegex = () => {
    onOpenRegex(word.trim(), replacement.trim());
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-40 flex items-end justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/70 backdrop-blur-xl"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Sheet */}
          <motion.div
            className="relative w-full max-w-md rounded-t-3xl bg-neutral-950
              border border-neutral-800/80 shadow-2xl shadow-black/50"
            style={{
              paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
            }}
            initial={{ y: "100%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "100%", opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-neutral-700" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-5 pb-3">
              <h3 className="text-base font-semibold text-neutral-100">
                Fix pronunciation
              </h3>
              <motion.button
                type="button"
                onClick={onClose}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="text-xs text-neutral-400 hover:text-neutral-200 px-2.5 py-1.5 
                  rounded-lg hover:bg-neutral-800/60 transition-colors duration-150"
              >
                Cancel
              </motion.button>
            </div>

            <div className="px-5 space-y-4 pb-4">
              {/* Word field */}
              <div>
                <label className="block text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-1.5">
                  Word
                </label>
                <input
                  type="text"
                  value={word}
                  onChange={(e) => setWord(e.target.value)}
                  placeholder="e.g. Xarqon"
                  autoFocus
                  className="w-full rounded-xl border border-neutral-700/80 bg-neutral-900/80 
                    px-3.5 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600
                    focus:outline-none focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30
                    transition-colors duration-150"
                />
              </div>

              {/* Replacement field with play button */}
              <div>
                <label className="block text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-1.5">
                  Sounds like...
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                    placeholder="e.g. zar-kon"
                    className="flex-1 rounded-xl border border-neutral-700/80 bg-neutral-900/80 
                      px-3.5 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-600
                      focus:outline-none focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30
                      transition-colors duration-150"
                  />
                  <motion.button
                    type="button"
                    onClick={() => void handlePlay()}
                    disabled={!replacement.trim() || isPlaying}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl
                      bg-gradient-to-br from-violet-400 to-violet-500 text-neutral-950
                      shadow-[0_2px_12px_rgba(167,139,250,0.35)]
                      disabled:opacity-40 disabled:shadow-none
                      transition-all duration-150"
                  >
                    {isPlaying ? (
                      <svg className="h-4 w-4 animate-pulse fill-current" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                        <path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z" />
                      </svg>
                    )}
                  </motion.button>
                </div>
              </div>

              {/* Scope toggle */}
              <div>
                <label className="block text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-1.5">
                  Apply to
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setScope("global")}
                    className={`rounded-xl border px-3 py-2 text-xs font-medium transition-all duration-150
                      ${scope === "global"
                        ? "border-violet-500/60 bg-violet-500/15 text-violet-300"
                        : "border-neutral-700/60 bg-neutral-900/50 text-neutral-400 hover:text-neutral-300 hover:border-neutral-600"
                      }`}
                  >
                    All books
                  </button>
                  <button
                    type="button"
                    onClick={() => setScope("book")}
                    className={`rounded-xl border px-3 py-2 text-xs font-medium transition-all duration-150
                      ${scope === "book"
                        ? "border-violet-500/60 bg-violet-500/15 text-violet-300"
                        : "border-neutral-700/60 bg-neutral-900/50 text-neutral-400 hover:text-neutral-300 hover:border-neutral-600"
                      }`}
                  >
                    This book only
                  </button>
                </div>
              </div>

              {/* Save button */}
              <motion.button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                whileHover={{ scale: canSave ? 1.01 : 1 }}
                whileTap={{ scale: canSave ? 0.98 : 1 }}
                className="w-full rounded-xl py-2.5 text-sm font-semibold transition-all duration-150
                  bg-gradient-to-r from-violet-500 to-violet-600 text-white
                  shadow-[0_4px_20px_rgba(139,92,246,0.3)]
                  disabled:opacity-40 disabled:shadow-none disabled:from-neutral-700 disabled:to-neutral-700 
                  disabled:text-neutral-500"
              >
                Save
              </motion.button>

              {/* Regex escalation link */}
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  onClick={handleOpenRegex}
                  className="text-[11px] text-neutral-600 hover:text-neutral-400 
                    transition-colors duration-150 underline underline-offset-2 decoration-neutral-700"
                >
                  Regex...
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
