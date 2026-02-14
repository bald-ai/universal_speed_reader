"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import type { Settings } from "@/contexts/SettingsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { getNativeTtsVoices, type NativeTtsVoice } from "@/lib/nativeTts";

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

const FONT_SIZE_OPTIONS: { value: Settings["fontSize"]; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "xl", label: "Extra large" }
];

const FONT_FAMILY_OPTIONS: { value: Settings["fontFamily"]; label: string }[] = [
  { value: "serif", label: "Serif" },
  { value: "sans-serif", label: "Sans-serif" },
  { value: "monospace", label: "Monospace" }
];

function labelForVoice(voice: NativeTtsVoice): string {
  const lang = voice.lang || "unknown";
  const name = voice.name || voice.voiceURI || "Voice";
  return `${name} (${lang})`;
}

type VoiceEntry = {
  index: number;
  voice: NativeTtsVoice;
};

function getLangBase(value: string | undefined): string {
  if (!value) return "";
  return value.trim().toLowerCase().split("-")[0] || "";
}

function guessVoiceGender(name: string): "female" | "male" | "unknown" {
  const lower = name.toLowerCase();

  const femaleHints = [
    "female",
    "woman",
    "girl",
    "samantha",
    "victoria",
    "allison",
    "ava",
    "emma",
    "jenny",
    "aria",
    "wavenet-f",
    "-f-",
  ];
  const maleHints = [
    "male",
    "man",
    "boy",
    "daniel",
    "alex",
    "david",
    "john",
    "liam",
    "matthew",
    "wavenet-m",
    "-m-",
  ];

  if (femaleHints.some((hint) => lower.includes(hint))) return "female";
  if (maleHints.some((hint) => lower.includes(hint))) return "male";
  return "unknown";
}

function scoreVoice(entry: VoiceEntry): number {
  let score = 0;
  if (entry.voice.default) score += 4;
  if (entry.voice.localService) score += 2;
  if ((entry.voice.name || "").trim().length > 0) score += 1;
  return score;
}

function pickUpToTwo(entries: VoiceEntry[]): VoiceEntry[] {
  if (entries.length <= 2) return entries;

  const sorted = [...entries].sort((a, b) => scoreVoice(b) - scoreVoice(a));
  const females = sorted.filter((entry) => guessVoiceGender(entry.voice.name || "") === "female");
  const males = sorted.filter((entry) => guessVoiceGender(entry.voice.name || "") === "male");
  const unknowns = sorted.filter((entry) => guessVoiceGender(entry.voice.name || "") === "unknown");

  const picked: VoiceEntry[] = [];
  if (females[0]) picked.push(females[0]);
  if (males[0]) picked.push(males[0]);

  for (const candidate of [...unknowns, ...females, ...males]) {
    if (picked.length >= 2) break;
    if (!picked.some((existing) => existing.index === candidate.index)) {
      picked.push(candidate);
    }
  }

  return picked;
}

export default function SettingsModal(props: SettingsModalProps) {
  const { isOpen, onClose } = props;
  const { settings, updateSettings } = useSettings();

  const [voices, setVoices] = useState<NativeTtsVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [phoneLanguage, setPhoneLanguage] = useState("en-US");

  const fontSizeIndex = FONT_SIZE_OPTIONS.findIndex((opt) => opt.value === settings.fontSize);

  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.language) {
      setPhoneLanguage(navigator.language);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setVoicesLoading(true);
    getNativeTtsVoices()
      .then((items) => {
        if (cancelled) return;
        setVoices(items);
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const selectedVoiceLabel = useMemo(() => {
    if (settings.ttsVoiceIndex < 0) return "System default";
    const v = voices[settings.ttsVoiceIndex];
    return v ? labelForVoice(v) : `Voice #${settings.ttsVoiceIndex}`;
  }, [settings.ttsVoiceIndex, voices]);

  const curatedVoices = useMemo(() => {
    const all: VoiceEntry[] = voices.map((voice, index) => ({ voice, index }));
    const english = all.filter((entry) => getLangBase(entry.voice.lang) === "en");

    const nativeBase = getLangBase(phoneLanguage);
    if (nativeBase === "en") {
      return pickUpToTwo(english);
    }

    const native = all.filter((entry) => getLangBase(entry.voice.lang) === nativeBase);
    return [...pickUpToTwo(native), ...pickUpToTwo(english)];
  }, [phoneLanguage, voices]);

  const voiceOptions = useMemo(() => {
    if (
      settings.ttsVoiceIndex < 0 ||
      curatedVoices.some((entry) => entry.index === settings.ttsVoiceIndex)
    ) {
      return curatedVoices;
    }

    const selected = voices[settings.ttsVoiceIndex];
    if (!selected) return curatedVoices;
    return [...curatedVoices, { index: settings.ttsVoiceIndex, voice: selected }];
  }, [curatedVoices, settings.ttsVoiceIndex, voices]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center"
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

          {/* Modal */}
          <motion.div
            className="relative w-full max-w-md sm:mx-4 rounded-t-3xl sm:rounded-3xl bg-neutral-950
              border border-neutral-800/80 shadow-2xl shadow-black/50 overflow-y-auto overscroll-contain"
            style={{
              maxHeight: "calc(100vh - env(safe-area-inset-top, 0px) - 4px)",
              paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)",
            }}
            initial={{ y: "100%", opacity: 0, scale: 0.95 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: "100%", opacity: 0, scale: 0.95 }}
            transition={{
              type: "spring",
              stiffness: 300,
              damping: 30
            }}
          >
            <div className="px-5 sm:px-7 pt-5 sm:pt-6 pb-2 border-b border-neutral-800/80">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold tracking-tight text-neutral-100">Reading settings</h2>
                <motion.button
                  type="button"
                  onClick={onClose}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="text-xs text-neutral-400 hover:text-neutral-200 px-2.5 py-1.5 rounded-lg
                    hover:bg-neutral-800/60 transition-colors duration-150"
                >
                  Close
                </motion.button>
              </div>
            </div>

            <div className="px-5 sm:px-7 pt-3 pb-5 space-y-6 text-[13px]">
              {/* Font Size */}
              <section>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="font-medium text-neutral-200">Font size</span>
                  <span className="text-xs text-violet-400 font-medium">
                    {FONT_SIZE_OPTIONS[fontSizeIndex]?.label ?? "Medium"}
                  </span>
                </div>
                <div className="relative">
                  <input
                    type="range"
                    min={0}
                    max={FONT_SIZE_OPTIONS.length - 1}
                    value={fontSizeIndex === -1 ? 1 : fontSizeIndex}
                    onChange={(event) => {
                      const index = Number(event.target.value);
                      const option = FONT_SIZE_OPTIONS[index] ?? FONT_SIZE_OPTIONS[1];
                      updateSettings({ fontSize: option.value });
                    }}
                    className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none
                      [&::-webkit-slider-thumb]:w-4
                      [&::-webkit-slider-thumb]:h-4
                      [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:bg-violet-500
                      [&::-webkit-slider-thumb]:shadow-lg
                      [&::-webkit-slider-thumb]:shadow-violet-500/30
                      [&::-webkit-slider-thumb]:transition-transform
                      [&::-webkit-slider-thumb]:hover:scale-110
                      [&::-moz-range-thumb]:w-4
                      [&::-moz-range-thumb]:h-4
                      [&::-moz-range-thumb]:rounded-full
                      [&::-moz-range-thumb]:bg-violet-500
                      [&::-moz-range-thumb]:border-0
                      [&::-moz-range-thumb]:shadow-lg
                      [&::-moz-range-thumb]:shadow-violet-500/30"
                  />
                  <div className="flex justify-between text-xs text-neutral-500 mt-2">
                    <span>A</span>
                    <span className="text-base">A</span>
                  </div>
                </div>
              </section>

              {/* Font Family */}
              <section>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="font-medium text-neutral-200">Font family</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {FONT_FAMILY_OPTIONS.map((option) => (
                    <motion.button
                      key={option.value}
                      type="button"
                      onClick={() => updateSettings({ fontFamily: option.value })}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className={`px-2.5 py-2 rounded-xl text-xs font-medium transition-all duration-200 ${
                        settings.fontFamily === option.value
                          ? "bg-violet-500/15 text-violet-300 border border-violet-500/40"
                          : "bg-neutral-900 text-neutral-400 border border-neutral-800 hover:border-neutral-700 hover:text-neutral-300"
                      }`}
                    >
                      {option.label}
                    </motion.button>
                  ))}
                </div>
              </section>

              {/* WPM */}
              <section>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="font-medium text-neutral-200">Speed reading WPM</span>
                  <motion.span
                    key={settings.wpm}
                    initial={{ scale: 1.2, color: "#a78bfa" }}
                    animate={{ scale: 1, color: "#a78bfa" }}
                    className="text-xs text-violet-400 font-medium"
                  >
                    {settings.wpm} WPM
                  </motion.span>
                </div>
                <div className="relative">
                  <input
                    type="range"
                    min={100}
                    max={600}
                    step={5}
                    value={settings.wpm}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      const clamped = Math.max(100, Math.min(600, value));
                      updateSettings({ wpm: clamped });
                    }}
                    className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none
                      [&::-webkit-slider-thumb]:w-4
                      [&::-webkit-slider-thumb]:h-4
                      [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:bg-violet-500
                      [&::-webkit-slider-thumb]:shadow-lg
                      [&::-webkit-slider-thumb]:shadow-violet-500/30
                      [&::-webkit-slider-thumb]:transition-transform
                      [&::-webkit-slider-thumb]:hover:scale-110
                      [&::-moz-range-thumb]:w-4
                      [&::-moz-range-thumb]:h-4
                      [&::-moz-range-thumb]:rounded-full
                      [&::-moz-range-thumb]:bg-violet-500
                      [&::-moz-range-thumb]:border-0
                      [&::-moz-range-thumb]:shadow-lg
                      [&::-moz-range-thumb]:shadow-violet-500/30"
                  />
                  <div className="flex justify-between text-xs text-neutral-500 mt-2">
                    <span>100</span>
                    <span>350</span>
                    <span>600</span>
                  </div>
                </div>
              </section>

              {/* ORP Highlight Toggle */}
              <section>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-neutral-200">Middle letter highlight</span>
                  <motion.button
                    type="button"
                    onClick={() => updateSettings({ orpHighlight: !settings.orpHighlight })}
                    whileTap={{ scale: 0.95 }}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                      settings.orpHighlight
                        ? "bg-violet-500"
                        : "bg-neutral-700"
                    }`}
                  >
                    <motion.div
                      className="absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-md"
                      animate={{ x: settings.orpHighlight ? 18 : 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    />
                  </motion.button>
                </div>
                <p className="text-xs text-neutral-500 mt-2">
                  Highlights the center letter of each word (ORP) for faster recognition.
                </p>
              </section>

              {/* Highlight Color */}
              {settings.orpHighlight && (
                <section>
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="font-medium text-neutral-200">Highlight color</span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    {[
                      { color: "#10b981", label: "Emerald" },
                      { color: "#f59e0b", label: "Amber" },
                      { color: "#ef4444", label: "Red" },
                      { color: "#3b82f6", label: "Blue" },
                      { color: "#a855f7", label: "Purple" },
                      { color: "#ec4899", label: "Pink" },
                    ].map((option) => (
                      <motion.button
                        key={option.color}
                        type="button"
                        onClick={() => updateSettings({ orpHighlightColor: option.color })}
                        whileHover={{ scale: 1.15 }}
                        whileTap={{ scale: 0.9 }}
                        title={option.label}
                        className={`w-7 h-7 rounded-full border-2 transition-all duration-200 ${
                          settings.orpHighlightColor === option.color
                            ? "border-white scale-110"
                            : "border-neutral-700 hover:border-neutral-500"
                        }`}
                        style={{ backgroundColor: option.color }}
                      />
                    ))}
                    <div className="ml-auto flex items-center gap-2">
                      <label className="text-xs text-neutral-500">Custom</label>
                      <input
                        type="color"
                        value={settings.orpHighlightColor}
                        onChange={(event) => updateSettings({ orpHighlightColor: event.target.value })}
                        className="w-7 h-7 rounded-full border border-neutral-700 bg-transparent cursor-pointer
                          [&::-webkit-color-swatch-wrapper]:p-0
                          [&::-webkit-color-swatch]:rounded-full
                          [&::-webkit-color-swatch]:border-0"
                      />
                    </div>
                  </div>
                </section>
              )}

              {/* TTS Speed */}
              <section>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="font-medium text-neutral-200">TTS speed</span>
                  <motion.span
                    key={settings.ttsPlaybackRate}
                    initial={{ scale: 1.2, color: "#fbbf24" }}
                    animate={{ scale: 1, color: "#fbbf24" }}
                    className="text-xs font-medium"
                  >
                    {settings.ttsPlaybackRate.toFixed(2)}x
                  </motion.span>
                </div>
                <div className="relative">
                  <input
                    type="range"
                    min={0.7}
                    max={1.4}
                    step={0.01}
                    value={settings.ttsPlaybackRate}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      const clamped = Math.max(0.7, Math.min(1.4, value));
                      updateSettings({ ttsPlaybackRate: clamped });
                    }}
                    className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none
                      [&::-webkit-slider-thumb]:w-4
                      [&::-webkit-slider-thumb]:h-4
                      [&::-webkit-slider-thumb]:rounded-full
                      [&::-webkit-slider-thumb]:bg-amber-400
                      [&::-webkit-slider-thumb]:shadow-lg
                      [&::-webkit-slider-thumb]:shadow-amber-400/20
                      [&::-webkit-slider-thumb]:transition-transform
                      [&::-webkit-slider-thumb]:hover:scale-110
                      [&::-moz-range-thumb]:w-4
                      [&::-moz-range-thumb]:h-4
                      [&::-moz-range-thumb]:rounded-full
                      [&::-moz-range-thumb]:bg-amber-400
                      [&::-moz-range-thumb]:border-0
                      [&::-moz-range-thumb]:shadow-lg
                      [&::-moz-range-thumb]:shadow-amber-400/20"
                  />
                  <div className="flex justify-between text-xs text-neutral-500 mt-2">
                    <span>0.70x</span>
                    <span>1.00x</span>
                    <span>1.40x</span>
                  </div>
                </div>
              </section>

              {/* TTS Voice */}
              <section>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="font-medium text-neutral-200">TTS voice</span>
                  <span className="text-xs text-neutral-400 truncate max-w-[180px] text-right">{selectedVoiceLabel}</span>
                </div>
                <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-2.5">
                  <label className="block text-xs text-neutral-500 mb-2">Voice profile</label>
                  <select
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200"
                    value={settings.ttsVoiceIndex}
                    onChange={(event) => {
                      const index = Number(event.target.value);
                      if (index < 0) {
                        updateSettings({ ttsVoiceIndex: -1, ttsLanguage: "en-US" });
                        return;
                      }
                      const selected = voices[index];
                      updateSettings({
                        ttsVoiceIndex: index,
                        ttsLanguage: selected?.lang || "en-US",
                      });
                    }}
                  >
                    <option value={-1}>System default (en-US)</option>
                    {voiceOptions.map(({ voice, index }) => (
                      <option key={`${voice.voiceURI}-${index}`} value={index}>
                        {labelForVoice(voice)}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-neutral-500 mt-2">
                    {voicesLoading
                      ? "Loading voices from Android…"
                      : voiceOptions.length > 0
                      ? `${voiceOptions.length} curated voices shown (${voices.length} installed on device).`
                      : "No custom voices found. Using system default."}
                  </p>
                </div>
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
